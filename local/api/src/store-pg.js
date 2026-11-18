/*
 * Postgres depoları. API yalnızca bu nesnenin dört metodunu bilir
 * (listEvents, stats, upsertEvent, removeEvent); testler aynı sözleşmeyi
 * bellek içi bir depoyla karşılar.
 */
import {
  EVENT_COLUMNS,
  HUNG_WINDOW_MS,
  clampLimit,
  deriveRow,
  normalizeEvent,
  text
} from './events.js';
import { CONTENT_TOLERANCE_MS } from './box-identity.js';

async function listEvents(pool, filters = {}) {
  const now = Date.now();
  const where = [];
  const values = [];
  const add = (value) => {
    values.push(value);
    return '$' + values.length;
  };

  // Süresi 15 dakikadan fazla geçmiş olaylar snapshot'a girmez.
  where.push('(expires_at_ms = 0 OR expires_at_ms > ' + add(now - HUNG_WINDOW_MS) + ')');
  if (filters.kind === 'chest' || filters.kind === 'bag') where.push('kind = ' + add(filters.kind));
  if (filters.status === 'active') {
    where.push("kind = 'chest' AND chest_status = 'active' AND (opens_at_ms = 0 OR opens_at_ms > " + add(now) + ')');
  } else if (filters.status === 'hung') {
    where.push("kind = 'chest' AND (chest_status = 'hung' OR (chest_status = 'active' AND opens_at_ms > 0 AND opens_at_ms <= " + add(now) + '))');
  }
  const minCoins = Number(filters.minCoins);
  if (Number.isFinite(minCoins) && minCoins > 0) where.push('total_coins >= ' + add(Math.round(minCoins)));
  const minRatio = Number(filters.minRatio);
  if (filters.minRatio !== undefined && filters.minRatio !== '' && Number.isFinite(minRatio)) {
    where.push('ratio IS NOT NULL AND ratio >= ' + add(minRatio));
  }
  const minRemaining = Number(filters.minRemaining);
  if (Number.isFinite(minRemaining) && minRemaining > 0) {
    where.push('expires_at_ms - ' + add(now) + ' >= ' + add(Math.round(minRemaining) * 1000));
  }
  const query = text(filters.q, 80).trim();
  if (query) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    where.push('creator ILIKE ' + add('%' + escaped + '%') + " ESCAPE '\\'");
  }

  const limit = add(clampLimit(filters.limit || 500));
  const sql = `SELECT ${EVENT_COLUMNS} FROM events
    WHERE ${where.join(' AND ')}
    ORDER BY opens_at_ms ASC, id ASC LIMIT ${limit}`;
  const result = await pool.query(sql, values);
  return result.rows.map((row) => deriveRow(row));
}

async function stats(pool) {
  const now = Date.now();
  const result = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE kind = 'chest' AND chest_status = 'active' AND (opens_at_ms = 0 OR opens_at_ms > $1))::int AS active_chests,
      count(*) FILTER (WHERE kind = 'chest' AND (chest_status = 'hung' OR (chest_status = 'active' AND opens_at_ms > 0 AND opens_at_ms <= $1)))::int AS hung_chests,
      count(*) FILTER (WHERE kind = 'bag')::int AS bags,
      count(DISTINCT creator)::int AS creators,
      COALESCE(sum(total_coins), 0)::bigint AS coins
    FROM events
    WHERE expires_at_ms = 0 OR expires_at_ms > $2
  `, [now, now - HUNG_WINDOW_MS]);
  return result.rows[0];
}

/*
 * Aynı kutunun var olan satırını bulur: önce birebir parmak izi, sonra
 * taban + tolerans içindeki açılış zamanı. Böylece kaynak kimliği farklı
 * olsa da ikinci satır açılmaz; bulunan id kanonik satır olarak kullanılır.
 */
async function findCanonicalId(pool, event) {
  if (event.content_fingerprint) {
    const exact = await pool.query(
      'SELECT id FROM events WHERE content_fingerprint = $1 LIMIT 1',
      [event.content_fingerprint]
    );
    if (exact.rowCount) return exact.rows[0].id;
  }
  if (!event.creator || event.opens_at_ms <= 0) return null;
  const near = await pool.query(`
    SELECT id FROM events
    WHERE kind = $1 AND creator = $2 AND room_id = $3
      AND opens_at_ms > 0 AND ABS(opens_at_ms - $4) <= $5
    ORDER BY updated_at DESC LIMIT 1
  `, [event.kind, event.creator, event.room_id, event.opens_at_ms, CONTENT_TOLERANCE_MS]);
  return near.rowCount ? near.rows[0].id : null;
}

function insertEvent(pool, event, id) {
  return pool.query(`
    INSERT INTO events (
      id, kind, room_id, creator, total_coins, winner_count, participant_count,
      viewer_count, ratio, opens_at_ms, expires_at_ms, chest_type, chest_status,
      bag_level, bag_method, bag_comment, country_code, rank_label, event_label,
      content_fingerprint
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20
    )
    ON CONFLICT (id) DO UPDATE SET
      kind = EXCLUDED.kind,
      room_id = COALESCE(NULLIF(EXCLUDED.room_id, ''), events.room_id),
      creator = EXCLUDED.creator,
      total_coins = CASE WHEN EXCLUDED.total_coins > 0 THEN EXCLUDED.total_coins ELSE events.total_coins END,
      winner_count = CASE WHEN EXCLUDED.winner_count > 0 THEN EXCLUDED.winner_count ELSE events.winner_count END,
      participant_count = COALESCE(EXCLUDED.participant_count, events.participant_count),
      viewer_count = COALESCE(EXCLUDED.viewer_count, events.viewer_count),
      ratio = CASE
        WHEN (CASE WHEN EXCLUDED.winner_count > 0 THEN EXCLUDED.winner_count ELSE events.winner_count END) > 0
        THEN (CASE WHEN EXCLUDED.total_coins > 0 THEN EXCLUDED.total_coins ELSE events.total_coins END)::double precision /
          (CASE WHEN EXCLUDED.winner_count > 0 THEN EXCLUDED.winner_count ELSE events.winner_count END)
        ELSE NULL
      END,
      -- Açılış zamanı kimliğin parçası: ilk bilinen değerde sabitlenir.
      opens_at_ms = CASE WHEN events.opens_at_ms > 0 THEN events.opens_at_ms ELSE EXCLUDED.opens_at_ms END,
      expires_at_ms = CASE WHEN EXCLUDED.expires_at_ms > 0 THEN EXCLUDED.expires_at_ms ELSE events.expires_at_ms END,
      chest_type = EXCLUDED.chest_type,
      chest_status = EXCLUDED.chest_status,
      bag_level = COALESCE(EXCLUDED.bag_level, events.bag_level),
      bag_method = COALESCE(EXCLUDED.bag_method, events.bag_method),
      bag_comment = COALESCE(EXCLUDED.bag_comment, events.bag_comment),
      country_code = COALESCE(EXCLUDED.country_code, events.country_code),
      rank_label = COALESCE(EXCLUDED.rank_label, events.rank_label),
      event_label = COALESCE(EXCLUDED.event_label, events.event_label),
      -- Parmak izi de kimlik gibi ilk değerde sabitlenir; birleşen yazma
      -- onu başka pencereye taşımaz.
      content_fingerprint = COALESCE(events.content_fingerprint, EXCLUDED.content_fingerprint),
      updated_at = now()
    RETURNING ${EVENT_COLUMNS}
  `, [
    id, event.kind, event.room_id, event.creator, event.total_coins,
    event.winner_count, event.participant_count, event.viewer_count, event.ratio,
    event.opens_at_ms, event.expires_at_ms, event.chest_type, event.chest_status,
    event.bag_level, event.bag_method, event.bag_comment, event.country_code,
    event.rank_label, event.event_label, event.content_fingerprint
  ]);
}

async function upsertEvent(pool, raw) {
  const event = normalizeEvent(raw);
  const canonicalId = await findCanonicalId(pool, event);
  const id = canonicalId || event.id;
  const existing = await pool.query('SELECT 1 FROM events WHERE id = $1', [id]);

  try {
    const result = await insertEvent(pool, event, id);
    return { row: deriveRow(result.rows[0]), duplicate: existing.rowCount > 0 };
  } catch (error) {
    // Eşzamanlı iki yazma aynı parmak izini ürettiyse kazanan satıra birleş.
    if (error && error.code === '23505' &&
        error.constraint === 'events_content_fingerprint_key' && event.content_fingerprint) {
      const winner = await pool.query(
        'SELECT id FROM events WHERE content_fingerprint = $1 LIMIT 1',
        [event.content_fingerprint]
      );
      if (winner.rowCount) {
        const retry = await insertEvent(pool, event, winner.rows[0].id);
        return { row: deriveRow(retry.rows[0]), duplicate: true };
      }
    }
    throw error;
  }
}

async function removeEvent(pool, id) {
  const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [String(id)]);
  return result.rowCount > 0;
}

export function createPgStore({ pool }) {
  if (!pool) throw new Error('pool zorunlu');
  return {
    listEvents: (filters) => listEvents(pool, filters),
    stats: () => stats(pool),
    upsertEvent: (raw) => upsertEvent(pool, raw),
    removeEvent: (id) => removeEvent(pool, id)
  };
}
