/*
 * Bellek içi depo: Postgres olmadan API'nin gerçek uçlarını çalıştırmak için.
 * Sözleşme store-pg.js ile aynıdır (listEvents/stats/upsertEvent/removeEvent);
 * birleştirme kuralları SQL'deki COALESCE/CASE ifadelerini yansıtır.
 */
import {
  HUNG_WINDOW_MS,
  clampLimit,
  deriveRow,
  normalizeEvent,
  text
} from '../../local/api/src/events.js';
import { CONTENT_TOLERANCE_MS } from '../../local/api/src/box-identity.js';

function mergeRow(prev, next) {
  const totalCoins = next.total_coins > 0 ? next.total_coins : prev.total_coins;
  const winnerCount = next.winner_count > 0 ? next.winner_count : prev.winner_count;
  return {
    ...prev,
    kind: next.kind,
    room_id: next.room_id || prev.room_id,
    creator: next.creator,
    total_coins: totalCoins,
    winner_count: winnerCount,
    participant_count: next.participant_count ?? prev.participant_count,
    viewer_count: next.viewer_count ?? prev.viewer_count,
    ratio: winnerCount > 0 ? totalCoins / winnerCount : null,
    // Açılış zamanı kimliğin parçası: ilk bilinen değerde sabitlenir.
    opens_at_ms: prev.opens_at_ms > 0 ? prev.opens_at_ms : next.opens_at_ms,
    expires_at_ms: next.expires_at_ms > 0 ? next.expires_at_ms : prev.expires_at_ms,
    chest_type: next.chest_type,
    chest_status: next.chest_status,
    bag_level: next.bag_level ?? prev.bag_level,
    bag_method: next.bag_method ?? prev.bag_method,
    bag_comment: next.bag_comment ?? prev.bag_comment,
    country_code: next.country_code ?? prev.country_code,
    rank_label: next.rank_label ?? prev.rank_label,
    event_label: next.event_label ?? prev.event_label
  };
}

export function createMemoryStore() {
  const rows = new Map();
  // İçerik parmak izi → kanonik satır kimliği; Postgres'teki tekillik
  // kuralının bellek içi karşılığı. `rowFingerprints` parmak izini kimlik
  // gibi ilk değerde sabitler (birleşen yazma pencereyi kaydırmaz).
  const fingerprints = new Map();
  const rowFingerprints = new Map();

  // Aynı kutunun var olan satırı: önce birebir parmak izi, sonra taban +
  // tolerans içindeki açılış zamanı. Kaynak kimliği farklı olsa da ikinci
  // satır açılmaz; bulunan id kanonik satır olur.
  function findCanonicalId(event) {
    const exact = event.content_fingerprint ? fingerprints.get(event.content_fingerprint) : null;
    if (exact && rows.has(exact)) return exact;
    if (!event.creator || event.opens_at_ms <= 0) return null;
    for (const row of rows.values()) {
      if (row.kind !== event.kind || row.creator !== event.creator || row.room_id !== event.room_id) continue;
      if (row.opens_at_ms > 0 && Math.abs(row.opens_at_ms - event.opens_at_ms) <= CONTENT_TOLERANCE_MS) {
        return row.id;
      }
    }
    return null;
  }

  return {
    rows,

    async listEvents(filters = {}) {
      const now = Date.now();
      const query = text(filters.q, 80).trim().toLowerCase();
      const minCoins = Number(filters.minCoins);
      const minRatio = Number(filters.minRatio);
      const minRemaining = Number(filters.minRemaining);

      return [...rows.values()]
        .map((row) => deriveRow(row, now))
        .filter((row) => row.expires_at_ms === 0 || row.expires_at_ms > now - HUNG_WINDOW_MS)
        .filter((row) => filters.kind !== 'chest' && filters.kind !== 'bag' ? true : row.kind === filters.kind)
        .filter((row) => {
          if (filters.status === 'active') {
            return row.kind === 'chest' && row.chest_status === 'active' &&
              (row.opens_at_ms === 0 || row.opens_at_ms > now);
          }
          if (filters.status === 'hung') {
            return row.kind === 'chest' && (row.chest_status === 'hung' ||
              (row.chest_status === 'active' && row.opens_at_ms > 0 && row.opens_at_ms <= now));
          }
          return true;
        })
        .filter((row) => !(Number.isFinite(minCoins) && minCoins > 0) || row.total_coins >= minCoins)
        .filter((row) => filters.minRatio === undefined || filters.minRatio === '' || !Number.isFinite(minRatio) ||
          (row.ratio != null && row.ratio >= minRatio))
        .filter((row) => !(Number.isFinite(minRemaining) && minRemaining > 0) ||
          row.expires_at_ms - now >= minRemaining * 1000)
        .filter((row) => !query || String(row.creator).toLowerCase().includes(query))
        .sort((a, b) => a.opens_at_ms - b.opens_at_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, clampLimit(filters.limit || 500));
    },

    async upsertEvent(raw) {
      const event = normalizeEvent(raw);
      const id = findCanonicalId(event) || event.id;
      const existing = rows.get(id);
      const row = existing ? mergeRow(existing, event) : { ...event };
      // Parmak izi satırda taşınmaz (Postgres çıktısıyla aynı sözleşme).
      delete row.content_fingerprint;
      rows.set(id, row);
      if (event.content_fingerprint && !rowFingerprints.has(id)) {
        fingerprints.set(event.content_fingerprint, id);
        rowFingerprints.set(id, event.content_fingerprint);
      }
      return { row: deriveRow(row), duplicate: Boolean(existing) };
    },

    async removeEvent(id) {
      const key = String(id);
      const removed = rows.delete(key);
      if (removed) {
        const fingerprint = rowFingerprints.get(key);
        if (fingerprint) fingerprints.delete(fingerprint);
        rowFingerprints.delete(key);
      }
      return removed;
    },

    async stats() {
      const now = Date.now();
      const live = [...rows.values()].filter((row) => row.expires_at_ms === 0 || row.expires_at_ms > now - HUNG_WINDOW_MS);
      return {
        total: live.length,
        active_chests: live.filter((row) => row.kind === 'chest' && row.chest_status === 'active' &&
          (row.opens_at_ms === 0 || row.opens_at_ms > now)).length,
        hung_chests: live.filter((row) => row.kind === 'chest' && (row.chest_status === 'hung' ||
          (row.chest_status === 'active' && row.opens_at_ms > 0 && row.opens_at_ms <= now))).length,
        bags: live.filter((row) => row.kind === 'bag').length,
        creators: new Set(live.map((row) => row.creator)).size,
        coins: live.reduce((sum, row) => sum + Number(row.total_coins || 0), 0)
      };
    }
  };
}
