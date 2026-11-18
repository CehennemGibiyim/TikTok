/*
 * Saf olay yardımcıları: doğrulama, normalizasyon ve türetilmiş alanlar.
 * HTTP katmanından ve depolama sürücüsünden bağımsızdır; bu yüzden
 * Postgres olmadan da test edilebilir.
 */
import { canonicalBoxId } from './ingest.js';
import { contentFingerprint } from './box-identity.js';

const HUNG_WINDOW_MS = 15 * 60 * 1000;
const MAX_COINS = 50_000_000;
const MAX_INT = 2_147_483_647;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

class ValidationError extends Error {}

function int(value, min = 0, max = MAX_INT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function nullableInt(value) {
  if (value === undefined || value === null || value === '') return null;
  return int(value);
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(MAX_TIMESTAMP, Math.round(number));
}

function text(value, max = 240) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Olay bir JSON nesnesi olmalı');
  }

  const kindInput = text(input.kind, 10).trim().toLowerCase();
  if (kindInput && kindInput !== 'chest' && kindInput !== 'bag') {
    throw new ValidationError("kind 'chest' veya 'bag' olmalı");
  }
  const kind = kindInput === 'bag' ? 'bag' : 'chest';
  const source = text(input.source, 20).trim().toLowerCase();

  const creator = text(input.creator || input.username || input.uniqueId, 80).trim();
  if (!creator) throw new ValidationError('creator zorunlu');

  const now = Date.now();
  const opensAt = timestamp(input.opens_at_ms ?? input.opensAt ?? input.availableAt);
  const rawExpires = timestamp(input.expires_at_ms ?? input.expiresAt);
  const statusInput = text(input.chest_status || input.chestStatus, 20).trim().toLowerCase();
  if (kind === 'chest' && statusInput && statusInput !== 'active' && statusInput !== 'hung') {
    throw new ValidationError("chest_status 'active' veya 'hung' olmalı");
  }

  let chestStatus = null;
  if (kind === 'chest') {
    chestStatus = statusInput === 'hung' ? 'hung' : 'active';
    // Açılış anı geçmişse durumu veritabanında da tutarlı tut.
    if (opensAt > 0 && now >= opensAt) chestStatus = 'hung';
  }

  const totalCoins = int(input.total_coins ?? input.totalCoins ?? input.coins, 0, MAX_COINS) ?? 0;
  const winnerCount = int(input.winner_count ?? input.winnerCount ?? input.shared, 0, MAX_INT) ?? 0;
  const participantCount = nullableInt(input.participant_count ?? input.participantCount ?? input.participants);
  const viewerCount = nullableInt(input.viewer_count ?? input.viewerCount ?? input.viewers);

  // Güncel API kuralı: oran her iki türde de jeton / kazanan kontenjanı.
  // participant_count ayrı bir alandır ve oranın paydası değildir.
  const ratio = winnerCount > 0 ? totalCoins / winnerCount : null;

  const defaultExpires = kind === 'chest' && chestStatus === 'hung'
    ? (opensAt || now) + HUNG_WINDOW_MS
    : (opensAt || now + HUNG_WINDOW_MS);
  let expiresAt = rawExpires > 0 ? rawExpires : defaultExpires;
  // Açılıştan önce biten bir sandık hemen temizlenmesin.
  if (kind === 'chest' && opensAt > 0 && expiresAt <= opensAt) expiresAt = defaultExpires;

  const roomId = text(input.room_id ?? input.roomId, 80).trim();
  // Kutu kaynakları (collector, ntfy, /ingest) aynı içerik anahtarını
  // kullanır. Böylece kaynak ID'leri farklı olsa da tek satırda birleşirler.
  const canonicalId = source ? canonicalBoxId({
    kind,
    room_id: roomId,
    creator,
    total_coins: totalCoins,
    winner_count: winnerCount,
    opens_at_ms: opensAt,
    source_event_id: input.source_event_id || input.id
  }) : null;
  const id = canonicalId || text(input.source_event_id || input.id, 200).trim() ||
    `${kind}:${creator}:${opensAt || now}`;

  return {
    id,
    kind,
    room_id: roomId,
    creator,
    total_coins: totalCoins,
    winner_count: winnerCount,
    participant_count: participantCount,
    viewer_count: viewerCount,
    ratio,
    opens_at_ms: opensAt,
    expires_at_ms: expiresAt,
    chest_type: kind === 'chest' ? text(input.chest_type || input.chestType || 'normal', 24) || 'normal' : null,
    chest_status: chestStatus,
    bag_level: kind === 'bag' ? nullableInt(input.bag_level ?? input.bagLevel) : null,
    bag_method: kind === 'bag' ? nullableInt(input.bag_method ?? input.bagMethod) : null,
    bag_comment: kind === 'bag' ? text(input.bag_comment ?? input.bagComment, 300) : null,
    country_code: text(input.country_code ?? input.countryCode, 2).toUpperCase() || null,
    rank_label: text(input.rank_label ?? input.rankLabel, 80) || null,
    event_label: text(input.event_label ?? input.eventLabel ?? input.boxName, 80) || null,
    // Kalıcı içerik parmak izi: depolar aynı kutuyu ikinci satır açmadan bulur.
    content_fingerprint: contentFingerprint({ kind, creator, room_id: roomId, opens_at_ms: opensAt })
  };
}

function clampLimit(value) {
  return Math.max(1, Math.min(2000, Math.round(Number(value) || 500)));
}

function deriveRow(row, now = Date.now()) {
  if (!row) return row;
  const out = { ...row };
  if (out.kind === 'chest' && out.chest_status !== 'hung' &&
      Number(out.opens_at_ms) > 0 && now >= Number(out.opens_at_ms)) {
    out.chest_status = 'hung';
    if (!Number(out.expires_at_ms) || Number(out.expires_at_ms) <= Number(out.opens_at_ms)) {
      out.expires_at_ms = Number(out.opens_at_ms) + HUNG_WINDOW_MS;
    }
  }
  return out;
}

const EVENT_COLUMNS = `
  id, kind, room_id, creator, total_coins, winner_count, participant_count,
  viewer_count, ratio, opens_at_ms, expires_at_ms, chest_type, chest_status,
  bag_level, bag_method, bag_comment, country_code, rank_label, event_label
`;

export {
  HUNG_WINDOW_MS,
  EVENT_COLUMNS,
  ValidationError,
  clampLimit,
  deriveRow,
  normalizeEvent,
  text
};
