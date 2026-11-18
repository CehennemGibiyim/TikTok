import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_COINS = 50_000_000;
const MAX_INT = 2_147_483_647;
const BOX_NAMES = { 9: 'Portal', 19: 'Süper Fan Kutusu', 20: 'Sandık', 21: 'Zarf' };

function text(value, max = 240) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function integer(value, min = 0, max = MAX_INT) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
}

// Milisaniye/saniye karışık gelebilen TikTok zamanlarını ms'ye çevirir.
function toMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number > 1e12) return Math.round(number);
  if (number > 1e9) return Math.round(number * 1000);
  return 0;
}

function firstInteger(sources, fields, min = 0, max = MAX_INT) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      const value = integer(source[field], min, max);
      if (value !== null) return value;
    }
  }
  return null;
}

function firstMs(sources, fields) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      const value = toMs(source[field]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

function boxKind(input, info, businessType) {
  const explicit = text(input.kind || input.type, 20).trim().toLowerCase();
  if (explicit === 'letter' || explicit === 'bag') return 'bag';
  if (explicit === 'chest') return 'chest';
  if (explicit === 'portal') return null;

  const eventText = text(input.event, 40) + ' ' +
    text(info.boxType || info.envelopeScene || info.textKey || info.displayKey, 80);
  if (/portal/i.test(eventText) || businessType === 9) return null;
  if (/treasure|sand[ıi]k|chest/i.test(eventText) || businessType === 19 || businessType === 20) {
    return 'chest';
  }
  if (businessType === 1 || businessType === 21) return 'bag';
  return null;
}

/*
 * Gelen ham TikTok yakalamasını veya tarayıcının/collector'ın normalize
 * ettiği kutuyu API olayına çevirir. Portal bu API'de desteklenmez.
 */
export function normalizeIncoming(input, source = 'ingest') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'gövde bir JSON nesnesi olmalı' };
  }

  const info = input.envelopeInfo || input.info || {};
  const box = input.treasureBoxData || info.treasureBoxData || {};
  const sources = [input, info, box];
  const creator = cleanUsername(input.creator || input.username || input.uniqueId || info.username);
  if (!creator) return { error: 'creator/username zorunlu' };

  const businessType = firstInteger(sources, ['businessType', 'business_type'], 0, 1000) || 0;
  const kind = boxKind(input, info, businessType);
  if (!kind) return { error: 'desteklenmeyen kutu türü (portal veya bilinmeyen)' };

  const totalCoins = firstInteger(
    sources,
    ['total_coins', 'totalCoins', 'coins', 'diamondCount', 'coinCount'],
    0,
    MAX_COINS
  ) || 0;
  const winnerCount = firstInteger(
    sources,
    ['winner_count', 'winnerCount', 'shared', 'winnerSlots', 'peopleCount', 'recipientCount'],
    0,
    MAX_INT
  ) || 0;
  const participantCount = firstInteger(
    sources,
    ['participant_count', 'participantCount', 'participants', 'voteCount', 'joinedCount', 'viewerJoinCount'],
    0,
    MAX_INT
  );
  const viewerCount = firstInteger(
    sources,
    ['viewer_count', 'viewerCount', 'viewers'],
    0,
    MAX_INT
  );

  const capturedAt = toMs(input.t || input.capturedAt) || Date.now();
  let opensAt = firstMs(
    sources,
    ['opens_at_ms', 'opensAt', 'unpackAt', 'availableAt', 'canOpen']
  );
  const secondsUntilOpen = Number(
    info.secondsUntilOpen || input.secondsUntilOpen || input.openIn
  ) || 0;
  if (!opensAt && secondsUntilOpen > 0) opensAt = capturedAt + Math.round(secondsUntilOpen * 1000);

  const expiresAt = firstMs(sources, ['expires_at_ms', 'expiresAt']);
  const roomId = text(input.room_id || input.roomId || info.roomId, 80).trim();
  const envelopeId = text(info.envelopeId || input.envelopeId || box.envelopeId, 120).trim();
  // Scanner'ın ürettiği kimlik `kullanıcı-env-envelopeId` biçimindedir.
  // Ham yakalamada yalnızca envelopeId varsa aynı biçime getir; böylece
  // ntfy ve boxes.json collector'ı aynı kaynak kimliğini paylaşır.
  const sourceEventId = text(
    input.id || (envelopeId ? creator + '-env-' + envelopeId : ''),
    200
  ).trim();
  const label = text(
    input.event_label || input.eventLabel || input.boxName || input.boxTitle ||
    info.boxName || info.boxTitle,
    80
  ).trim() || (kind === 'chest' ? 'Sandık' : 'Zarf');

  return {
    id: sourceEventId || undefined,
    source_event_id: sourceEventId,
    source,
    kind,
    room_id: roomId,
    creator,
    total_coins: totalCoins,
    winner_count: winnerCount,
    participant_count: participantCount,
    viewer_count: viewerCount,
    opens_at_ms: opensAt,
    expires_at_ms: expiresAt,
    chest_type: kind === 'chest' ? text(input.chest_type || input.chestType || input.boxType, 24) || 'normal' : undefined,
    chest_status: undefined,
    bag_level: kind === 'bag' ? firstInteger(sources, ['bag_level', 'bagLevel'], 0, MAX_INT) : null,
    bag_method: kind === 'bag' ? firstInteger(sources, ['bag_method', 'bagMethod', 'methodCode'], 0, MAX_INT) : null,
    bag_comment: kind === 'bag' ? text(input.bag_comment || input.bagComment || input.keyword, 300) : null,
    country_code: text(input.country_code || input.countryCode, 2).toUpperCase() || undefined,
    rank_label: text(input.rank_label || input.rankLabel, 80) || undefined,
    event_label: label,
    boxName: label,
    businessType
  };
}

/*
 * İki kaynağın aynı kutuyu üretip üretmediğini belirleyen içerik anahtarı.
 * Kaynak ID'si kaynaklar arasında değişebildiği için önce normalize alanlar
 * kullanılır; alanlar yoksa kaynak ID'sine düşülür.
 */
export function canonicalBoxKey(event) {
  if (!event || typeof event !== 'object') return null;

  // Kaynak kimliği iki taşıma yolunda da aynı kutuya işaret eder; collector
  // yalnızca `scanner:` öneki ekler. Önce onu normalize et.
  const sourceId = String(event.source_event_id || event.id || '').trim().replace(/^scanner:/i, '');
  if (sourceId) return 'id|' + sourceId;

  // Kimlik yoksa içerik alanlarına düş. Bu, elle üretilen/eski kayıtlar için
  // yedek yoldur; kaynak kimliği varsa değer farkı aynı kutuyu bölmez.
  const creator = cleanUsername(event.creator || event.username);
  const opensAt = Number(event.opens_at_ms || event.opensAt || 0);
  if (!creator || opensAt <= 0) return null;
  return [
    String(event.room_id || event.roomId || '').trim(),
    creator,
    event.kind === 'bag' ? 'bag' : 'chest',
    Math.round(opensAt / 1000),
    Number(event.total_coins || event.coins || 0) || 0,
    Number(event.winner_count || event.shared || 0) || 0
  ].join('|');
}

export function canonicalBoxId(event) {
  const key = canonicalBoxKey(event);
  if (!key) return null;
  return 'box:' + createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// Anahtar karşılaştırmasını uzunluk/zamanlama sızıntısına karşı sabitler.
export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

export { BOX_NAMES };
