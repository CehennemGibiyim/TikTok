/*
 * tiktool.js — tiktok-live-api (TikTool yönetilen WebSocket) kaynağı.
 *
 * Ne yapar: bir veya daha fazla canlı odadan gelen `envelope` /
 * `envelopePortal` olaylarını API'nin `/ingest` normalizasyonuna uygun ham
 * kutuya çevirir; böylece self-hosted scanner'ın ürettiği kayıtlarla aynı
 * kanonik kimlikte birleşir.
 *
 * Neden opsiyonel: paket yönetilen bir servise bağlanır ve API anahtarı
 * gerektirir. Anahtar yoksa veya oda listesi boşsa kaynak sessizce kapalıdır;
 * API'nin geri kalanı (collector + /ingest + ntfy) çalışmaya devam eder.
 *
 * Önemli sınırlar:
 * - Paket `envelope` olayını `Record<string, unknown>` olarak tipler; alan
 *   adları TikTok'un native WebcastEnvelopeMessage'ına göre savunmacı
 *   okunur. Tanınmayan gövde reddedilir, tahmin edilmez.
 * - Yayıncı adı odanın `uniqueId`'sidir; gövdedeki kullanıcı yalnızca yedek.
 * - businessType yoksa zarf (bag) varsayılır; olay adı zaten `envelope`.
 */

const DEFAULT_MAX_ROOMS = 3;
const ENVELOPE_EVENTS = ['envelope', 'envelopePortal'];

function text(value, max = 120) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function toMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number > 1e12) return Math.round(number);
  if (number > 1e9) return Math.round(number * 1000);
  return 0;
}

function first(source, fields) {
  if (!source || typeof source !== 'object') return undefined;
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null && source[field] !== '') {
      return source[field];
    }
  }
  return undefined;
}

/*
 * SDK'nın envelope gövdesini `normalizeIncoming`'in beklediği biçime çevirir.
 * `null` dönmesi, kutunun tanınamadığı (ör. envelopeId yok) anlamına gelir.
 */
export function envelopeToBox(event, username, roomId) {
  if (!event || typeof event !== 'object') return null;
  const info = first(event, ['envelopeInfo', 'envelope_info', 'info', 'envelope', 'treasureBoxData', 'data']) || {};
  const source = info && typeof info === 'object' ? info : {};
  const creator = text(
    username ||
    first(event, ['uniqueId', 'username']) ||
    first(source, ['username', 'uniqueId']) ||
    first(event.user || {}, ['uniqueId', 'username']),
    80
  ).replace(/^@+/, '').toLowerCase();
  if (!creator) return null;

  const envelopeId = text(first(source, ['envelopeId', 'envelope_id']) ||
    first(event, ['envelopeId', 'envelope_id']), 120);
  if (!envelopeId) return null;

  const businessType = Number(first(source, ['businessType', 'business_type']) ??
    first(event, ['businessType', 'business_type']));
  const unpackAt = toMs(first(source, ['unpackAt', 'availableAt', 'opens_at_ms', 'opensAt']) ??
    first(event, ['unpackAt', 'availableAt', 'opens_at_ms', 'opensAt']));
  const diamondCount = Number(first(source, ['diamondCount', 'diamond_count', 'coins', 'totalCoins']) ??
    first(event, ['diamondCount', 'diamond_count', 'coins', 'totalCoins']));
  const peopleCount = Number(first(source, ['peopleCount', 'people_count', 'shared', 'winnerCount']) ??
    first(event, ['peopleCount', 'people_count', 'shared', 'winnerCount']));
  const participantCount = Number(first(source, ['participantCount', 'participant_count', 'participants']) ??
    first(event, ['participantCount', 'participant_count', 'participants']));

  const kind = businessType === 20 || businessType === 19 ? 'chest' : 'bag';
  return {
    source: 'tiktool',
    username: creator,
    creator,
    roomId: text(roomId || first(event, ['roomId', 'room_id']) || '', 80),
    kind,
    businessType: Number.isFinite(businessType) ? businessType : undefined,
    envelopeInfo: {
      envelopeId,
      businessType: Number.isFinite(businessType) ? businessType : undefined,
      diamondCount: Number.isFinite(diamondCount) ? diamondCount : 0,
      peopleCount: Number.isFinite(peopleCount) ? peopleCount : 0,
      participantCount: Number.isFinite(participantCount) ? participantCount : undefined,
      availableAt: unpackAt || undefined
    },
    event_label: kind === 'chest' ? 'Sandık' : 'Zarf'
  };
}

/*
 * Kaynağı kurar. `createClient(username, { apiKey })` testlerde sahte bir
 * istemci döndürebilir; verilmezse `tiktok-live-api` dinamik yüklenir.
 */
export function createTiktoolSource({
  apiKey,
  usernames = [],
  maxRooms = DEFAULT_MAX_ROOMS,
  createClient,
  onBox,
  log = console
} = {}) {
  const rooms = [...new Set((Array.isArray(usernames) ? usernames : [])
    .map((name) => text(name, 80).replace(/^@+/, '').toLowerCase())
    .filter(Boolean))].slice(0, Math.max(1, Number(maxRooms) || DEFAULT_MAX_ROOMS));

  const runtime = {
    enabled: Boolean(String(apiKey || '').trim() && rooms.length && typeof onBox === 'function'),
    rooms: rooms.length,
    connected: 0,
    events: 0,
    boxes: 0,
    rejected: 0,
    lastError: null,
    lastEventAt: 0,
    lastConnectedAt: 0
  };

  const clients = [];
  let stopped = false;

  async function resolveFactory() {
    if (createClient) return createClient;
    const module = await import('tiktok-live-api');
    return (uniqueId, options) => new module.TikTokLive(uniqueId, options);
  }

  async function handleEnvelope(room, event) {
    runtime.events += 1;
    runtime.lastEventAt = Date.now();
    const box = envelopeToBox(event, room);
    if (!box) {
      runtime.rejected += 1;
      return;
    }
    try {
      await onBox(box);
      runtime.boxes += 1;
    } catch (error) {
      runtime.rejected += 1;
      runtime.lastError = error && error.message ? error.message : 'box_rejected';
      log.error('[tiktool]', runtime.lastError);
    }
  }

  function start() {
    if (!runtime.enabled || stopped) return;
    void (async () => {
      let factory;
      try {
        factory = await resolveFactory();
      } catch (error) {
        runtime.lastError = 'sdk_unavailable: ' + (error && error.message ? error.message : 'import_failed');
        log.error('[tiktool]', runtime.lastError);
        return;
      }

      for (const room of rooms) {
        if (stopped) break;
        let client;
        try {
          client = factory(room, { apiKey });
        } catch (error) {
          runtime.lastError = error && error.message ? error.message : 'client_failed';
          continue;
        }
        clients.push(client);
        ENVELOPE_EVENTS.forEach((name) => {
          client.on(name, (event) => handleEnvelope(room, event));
        });
        client.on('connected', () => {
          runtime.connected += 1;
          runtime.lastConnectedAt = Date.now();
        });
        client.on('error', (error) => {
          runtime.lastError = error && error.message ? error.message : String(error || 'error');
        });
        try {
          await client.connect();
        } catch (error) {
          runtime.lastError = error && error.message ? error.message : 'connect_failed';
          log.error('[tiktool]', room, runtime.lastError);
        }
      }
    })();
  }

  function stop() {
    stopped = true;
    clients.forEach((client) => {
      try { client.disconnect(); } catch { /* zaten kapalı */ }
    });
    runtime.connected = 0;
  }

  return { runtime, start, stop };
}
