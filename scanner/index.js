#!/usr/bin/env node
/*
 * TikTok canlı tarayıcı.
 *
 * Ne yapar:
 *   1) KEŞİF  — havuzdaki (data/targets.json) her adresi TikTok'a sorar: canlı mı,
 *               yayın ne zaman başladı, kaç kişi var. Canlı olanı listeye alır.
 *   2) DİNLEME — canlı odalara bağlanır, jeton olaylarını (hediye, zarf) toplar.
 *   3) YAYIN   — sonucu data/live.json'a yazar; panel bu dosyayı okuyup
 *               gerçek süreleri ve fırsatları kendiliğinden gösterir.
 *
 * Kullanım:
 *   node scanner/index.js --minutes=160          # 160 dk boyunca tara
 *   node scanner/index.js --once                 # tek tur (test)
 *   node scanner/index.js --once --commit=0      # veri yaz, commit etme
 *   node scanner/index.js --minutes=160 --commit=600   # 10 dk'da bir commit
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'site', 'firsat', 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const LIVE_FILE = path.join(DATA_DIR, 'live.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- ayarlar ----------

function readArg(name, fallback) {
  const hit = process.argv.find((arg) => arg === '--' + name || arg.startsWith('--' + name + '='));
  if (!hit) return fallback;
  const value = hit.split('=')[1];
  if (value === undefined) return true;
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

const CONFIG = {
  minutes: Number(readArg('minutes', 0)),
  once: Boolean(readArg('once', false)),
  pollSec: Number(readArg('poll', 60)),
  maxRooms: Number(readArg('max-rooms', 15)),
  concurrency: Number(readArg('concurrency', 6)),
  minCoins: Number(readArg('min-coins', 1)),
  commitSec: Number(readArg('commit', 0)),
  discover: readArg('discover', 1) ? true : false,
  discoverSec: Number(readArg('discover-sec', 300)),
  maxPool: Number(readArg('max-pool', 250)),
  watch: readArg('watch', readArg('once', 0) ? 0 : 1) ? true : false,
  // tiktok-live-connector ile dinle (anahtarsız); 0 verilirse TikTools'a düşer.
  connector: readArg('connector', 1) ? true : false,
  watchSec: Number(readArg('watch-sec', 300)),
  watchRooms: Number(readArg('watch-rooms', 8)),
  // Bağlantılar arası en az boşluk: hız sınırına çarpmadan sırayla açılır.
  connectGapMs: Number(readArg('connect-gap', 4000)),
  // Sınır yediğimizde inilebilecek en düşük eşzamanlı oda sayısı.
  minRooms: Number(readArg('min-rooms', 8)),
  // Kutu vermiş oda bu süre boyunca "sıcak" sayılır (6 saat).
  hotWindowMs: Number(readArg('hot-window-sec', 21600)) * 1000,
  // Sıcak odaya en erken bu kadar sonra geri dönülür (12 dk).
  hotRevisitMs: Number(readArg('hot-revisit-sec', 720)) * 1000,
  // Sıradan odaya geri dönüş aralığı (30 dk).
  revisitMs: Number(readArg('revisit-sec', 1800)) * 1000,
  // Hiç dinlenmemiş yeni adaylara ayrılan oda oranı (sıcak odayı boğmaz).
  probeRatio: Math.min(0.6, Math.max(0, Number(readArg('probe-ratio', 0.4)))),
  // Yeni adayı kaç saniye dinleyip karar veririz (kutu düşerse sıcağa geçer).
  probeSec: Number(readArg('probe-sec', 180)),
  // Oran uyarlaması: kaç deneme sonrası karar verilir ve eşikler.
  probeWindow: Math.max(4, Number(readArg('probe-window', 8))),
  probeUpRate: Number(readArg('probe-up-rate', 0.25)),
  probeDownRate: Number(readArg('probe-down-rate', 0.05))
};

const startedAtMs = Date.now();
const deadline = CONFIG.minutes > 0 ? startedAtMs + CONFIG.minutes * 60000 : Infinity;

// ---------- durum ----------

const state = {
  /** @type {Map<string, object>} kullanıcı adı -> yayıncı kaydı */
  streamers: new Map(),
  /** @type {Map<string, object>} kullanıcı adı -> açık bağlantı */
  rooms: new Map(),
  /** @type {Array<object>} son jeton olayları */
  events: [],
  seenEvents: new Set(),
  targets: [],
  recent: [],
  combos: new Map(),
  seenMessages: new Set(),
  envelopeStats: { seen: 0, withCoins: 0, actions: {}, boxTypes: {} },
  envelopeSamples: [],
  connectorCooldownUntil: 0,
  // Eşzamanlı oda bütçesi: sınır yedikçe düşer, başarılı bağlantıda toparlanır.
  roomBudget: 0,
  connectFailures: 0,
  lastConnectAt: 0,
  targetsDirty: false,
  // Keşif oranı: deneme oturumlarının kutu başarısına göre kendini ayarlar.
  probe: {
    ratio: 0, sessions: 0, withBox: 0,
    winSessions: 0, winBoxSessions: 0, winHot: 0, winHotBox: 0
  },
  savedRatio: 0,
  lastFlush: 0,
  lastCommit: 0,
  lastDiscover: 0,
  discoveredTotal: 0,
  lastError: null,
  polls: 0
};

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
    .replace(/^@/, '')
    .split(/[?#/]/)[0]
    .replace(/[^a-zA-Z0-9._]/g, '')
    .toLowerCase();
}

// ---------- hedef havuzu ----------

function loadTargets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.targets || [];
    // Önceki koşuda öğrenilen keşif oranı korunur.
    const savedRatio = Number(parsed && parsed.probeRatio);
    if (Number.isFinite(savedRatio) && savedRatio > 0) {
      state.savedRatio = Math.min(0.6, Math.max(0.1, savedRatio));
    }
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
      const raw = typeof item === 'string' ? item : item && item.username;
      const username = cleanUsername(raw);
      if (!username || seen.has(username)) return;
      seen.add(username);
      out.push({
        username,
        country: (typeof item === 'object' && item && item.country) || '',
        source: (typeof item === 'object' && item && item.source) || 'manual',
        roomId: (typeof item === 'object' && item && String(item.roomId || '')) || '',
        // Kutu geçmişi dosyada kalır: yeni koşu yayıncıyı yine öncelikli izler.
        boxEvents: (typeof item === 'object' && item && Number(item.boxEvents)) || 0,
        lastBoxAt: (typeof item === 'object' && item && Number(item.lastBoxAt)) || 0,
        lastWatchedAt: (typeof item === 'object' && item && Number(item.lastWatchedAt)) || 0,
        addedAt: (typeof item === 'object' && item && Number(item.addedAt)) || 0,
        lastSeenLiveAt: (typeof item === 'object' && item && Number(item.lastSeenLiveAt)) || 0
      });
    });
    return out;
  } catch (error) {
    log('havuz okunamadı:', error.message);
    return [];
  }
}

function targetFor(username) {
  return state.targets.find((target) => target.username === username) || null;
}

function saveTargets() {
  // Keşifle bulunanlar eklenir, kullanıcının kendi ekledikleri korunur.
  const body = {
    note: 'Taranacak adresler. Keşif kendi bulduklarını buraya ekler; elle eklenenler korunur.',
    // Öğrenilen keşif oranı: sonraki koşu buradan devam eder.
    probeRatio: Math.round(state.probe.ratio * 100) / 100,
    probeStats: {
      sessions: state.probe.sessions,
      withBox: state.probe.withBox
    },
    updatedAt: new Date().toISOString(),
    targets: state.targets.map((target) => ({
      username: target.username,
      country: target.country || '',
      source: target.source || 'manual',
      roomId: target.roomId || '',
      boxEvents: target.boxEvents || 0,
      lastBoxAt: target.lastBoxAt || 0,
      lastWatchedAt: target.lastWatchedAt || 0,
      addedAt: target.addedAt || 0,
      lastSeenLiveAt: target.lastSeenLiveAt || 0
    }))
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TARGETS_FILE, JSON.stringify(body, null, 1) + '\n');
}

// ---------- 0) KEŞİF: canlı yayınları kendiliğinden bul ----------
// Halka açık canlı kanal listesi; giriş/çerez istemez (5 dakikada 1 istek / IP).

const DISCOVERY_URL = 'https://api.tik.tools/api/live/top-channels';

async function discoverLive() {
  if (!CONFIG.discover) return 0;
  if (Date.now() - state.lastDiscover < CONFIG.discoverSec * 1000) return 0;
  state.lastDiscover = Date.now();

  try {
    const response = await fetch(DISCOVERY_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('http ' + response.status);
    const payload = await response.json();
    const channels = (payload && payload.channels) || [];
    const known = new Set(state.targets.map((target) => target.username));
    const fresh = [];

    channels.forEach((channel) => {
      const username = cleanUsername(channel && channel.uniqueId);
      if (!username || known.has(username)) return;
      known.add(username);
      fresh.push({
        username,
        country: String((channel && channel.region) || '').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase(),
        source: 'discovery',
        roomId: String((channel && channel.roomId) || ''),
        addedAt: Date.now(),
        lastSeenLiveAt: 0
      });
    });

    if (fresh.length) {
      state.targets = fresh.concat(state.targets);
      state.discoveredTotal += fresh.length;
      // Havuz sınırı: en eski, canlı görülmemiş keşif kayıtları düşer; elle eklenenler kalır.
      if (state.targets.length > CONFIG.maxPool) {
        const overflow = state.targets.length - CONFIG.maxPool;
        let dropped = 0;
        state.targets = state.targets.filter((target) => {
          if (dropped >= overflow) return true;
          if (target.source !== 'discovery' || target.lastSeenLiveAt) return true;
          dropped += 1;
          return false;
        });
      }
      saveTargets();
    }

    // Bu uç yalnızca yayında olan kanalları döndürür: bulunanlar canlıdır.
    // Başlangıç saati verilmezse uydurulmaz; panel süreyi "—" gösterir.
    channels.forEach((channel) => {
      const username = cleanUsername(channel && channel.uniqueId);
      if (!username) return;
      const record = state.streamers.get(username) || { username, coins: 0, gifts: 0, live: false };
      if (!record.country) {
        record.country = String((channel && channel.region) || '').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
      }
      record.live = true;
      record.lastSeenLiveAt = Date.now();
      record.checkedAt = Date.now();
      record.viewers = Number((channel && channel.viewerCount) || 0) || record.viewers || 0;
      // Oda kimliği uygulamada doğrudan yayına gitmek için gerekli.
      if (channel && channel.roomId) record.roomId = String(channel.roomId);
      state.streamers.set(username, record);
    });

    log('keşif: +' + fresh.length, 'yayıncı · havuz', state.targets.length);
    return fresh.length;
  } catch (error) {
    state.lastError = 'keşif: ' + error.message;
    log('keşif hatası:', error.message);
    return 0;
  }
}

// ---------- 1) canlı durum (gerçek başlangıç saati) ----------

async function fetchLiveStatus(uniqueId) {
  const url = 'https://www.tiktok.com/api-live/user/room/?aid=1988&app_language=tr-TR' +
    '&uniqueId=' + encodeURIComponent(uniqueId) + '&sourceType=54';
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', Accept: 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
    const text = await response.text();
    // TikTok bazı IP'lerde 200 + boş gövde döndürüyor: bu "yayında değil"
    // demek DEĞİLDİR, bilinmeyen durumdur. Bilinmeyende eski durum korunur.
    if (!text.trim()) return { unknown: true, reason: 'boş yanıt (doğrulanamadı)' };
    let payload;
    try { payload = JSON.parse(text); } catch (error) { return { unknown: true, reason: 'okunamayan yanıt' }; }
    if (payload && payload.statusCode && payload.statusCode !== 0) {
      return { unknown: true, reason: payload.message || ('kod ' + payload.statusCode) };
    }
    const room = payload && payload.data && payload.data.liveRoom;
    if (!room) return { live: false, reason: (payload && payload.message) || 'oda yok' };
    const live = Number(room.status) === 2;
    // TikTok başlangıç saatini saniye olarak veriyor; ms'e çeviriyoruz.
    const rawStart = Number(room.startTime) || 0;
    const startTime = rawStart > 0 && rawStart < 1e12 ? rawStart * 1000 : rawStart;
    return {
      live,
      // Uygulama içi yayın bağlantısı (snssdk…) bu kimlikle açılır.
      roomId: String(room.id || room.roomId || room.roomID || ''),
      startTime,
      title: room.title || '',
      viewers: (room.liveRoomStats && Number(room.liveRoomStats.enterCount)) || 0
    };
  } catch (error) {
    return { live: false, reason: error.message };
  }
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
      await sleep(120);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------- 2) dinleme ----------

function recordEvent(username, data) {
  const coins = Math.max(0, Math.round(Number(data.coins) || 0));
  if (coins < CONFIG.minCoins) return;
  const flatten = Math.floor(Date.now() / 1000);
  const id = username + '-' + flatten + '-' + Math.random().toString(36).slice(2, 7);
  if (state.seenEvents.has(id)) return;
  state.seenEvents.add(id);
  if (state.seenEvents.size > 5000) state.seenEvents.clear();

  const event = {
    id,
    t: Date.now(),
    username,
    kind: data.kind,
    coins,
    diamonds: Math.max(0, Math.round(Number(data.diamonds) || 0)),
    giftName: data.giftName || '',
    // Kutunun gerçek adı ve TikTok'un tür kodu: panel türü buna göre yazar.
    boxName: data.boxName || data.giftName || '',
    businessType: Math.max(0, Math.round(Number(data.businessType) || 0)),
    boxType: data.boxType || '',
    sender: data.sender || '',
    senderName: data.senderName || data.sender || '',
    // Zarf/sandıkta gerçek kişi sayısı ve açılışa kalan süre varsa yazılır.
    shared: Math.max(0, Math.round(Number(data.shared) || 0)),
    durationSec: Math.max(0, Math.round(Number(data.durationSec) || 0)),
    availableAt: Date.now() + Math.max(0, Math.round(Number(data.durationSec) || 0)) * 1000,
    source: 'scan'
  };
  state.events.unshift(event);
  if (state.events.length > 400) state.events.length = 400;

  const record = state.streamers.get(username);
  if (record) {
    record.coins = (Number(record.coins) || 0) + coins;
    record.gifts = (Number(record.gifts) || 0) + 1;
    record.lastGiftAt = event.t;
    record.lastGiftName = event.giftName || record.lastGiftName || '';
  }
  log('olay', username, data.kind, coins, 'jeton', data.giftName || '');
}

// ---------- 2) dinleme ----------
// TikTok'un kendi olay akışı imza istiyor (403). Halka açık olay ağ geçidi
// girişsiz çalışıyor ama tek soket + 10 dk oturum veriyor, bu yüzden odalar sırayla dinlenir.

const TIKTOOLS_KEY = process.env.TIKTOOLS_KEY || 'your_api_key';

function wsFactory() {
  if (typeof WebSocket === 'function') return WebSocket;
  try {
    return require('ws');
  } catch (error) {
    throw new Error('WebSocket yok: Node 22+ gerekli');
  }
}

async function mintToken(username, seconds) {
  // 1) birleşik uç: soket anahtarı + yayın adresleri (10 istek/dk).
  try {
    const response = await fetch('https://tik.tools/api/live/connect?uniqueId=' + encodeURIComponent(username), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      const payload = await response.json();
      if (payload && payload.token) return payload.token;
    }
  } catch (error) { /* ikinci yolu dene */ }

  // 2) yedek: anahtarla token üret.
  const response = await fetch('https://api.tik.tools/authentication/jwt?apiKey=' + encodeURIComponent(TIKTOOLS_KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_creators: [username], expire_after: seconds, max_websockets: 1 }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  const token = payload && payload.data && payload.data.token;
  if (!token) throw new Error('token yok (' + response.status + ')');
  return token;
}

// Toplanabilir kazanç olayları ülkeye göre farklı adlarla geliyor; aynı
// hediyenin adı dil değiştiriyor. Bu yüzden yalnızca adı bu listeye uyan
// olaylar yazılır, sıradan hediyeler hiç kaydedilmez.
const KIND_WORDS = [
  ['portal', /portal|port[áa]l|портал|بوابة|पोर्टल|c[ổo]ng\s*tr[ờo]i|portail/i],
  ['letter', /zarf|envelope|mektup|letter|red\s*packet|hongbao|红包|sobre|sobre\s*rojo|\u7ea2\u5305/i],
  ['chest', /sand[ıi]k|chest|cofre|ba[uú]l?|caixa|coffre|forziere|truhe|сундук|скриня|сандык|صندوق|h[ộo]p\s*qu[àa]|rương|宝箱|상자|kotak\s*harta|peti\s*harta|kahon|baul|संदूक|সিন্দুক|หีบ|පෙට්ටිය|သေတ္တာ/i]
];

function kindFor(name) {
  const text = String(name || '');
  for (const [kind, pattern] of KIND_WORDS) {
    if (pattern.test(text)) return kind;
  }
  return null; // sıradan hediye: Fırsatlar'a yazılmaz
}

function handleStreamMessage(username, raw) {
  let payload;
  try { payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (error) { return; }
  const event = payload.event || (payload.data && payload.data.type) || '';
  const data = payload.data || {};

  if (event === 'gift') {
    const msgId = data.msgId || (data.transactionId ? String(data.transactionId) : '');
    if (msgId) {
      if (state.seenMessages.has(msgId)) return;
      state.seenMessages.add(msgId);
      if (state.seenMessages.size > 4000) state.seenMessages.clear();
    }

    const repeat = Number(data.repeatCount || data.repeat_count) || 1;
    const diamonds = Number(data.diamondCount || data.diamond_count) || 0;
    const name = data.giftName || (data.gift && data.gift.name) || 'Hediye';
    const sender = (data.user && (data.user.uniqueId || data.user.nickname)) || '';
    const groupId = String(data.groupId || data.group_id || (name + '|' + sender));

    // TikTok aynı komboyu parça parça gönderiyor: son parça (repeatEnd) gelene
    // kadar beklenir, jeton bir kez ve gerçek toplamla yazılır.
    const combo = state.combos.get(groupId) || { diamonds, repeat: 0 };
    combo.diamonds = diamonds || combo.diamonds;
    combo.repeat = Math.max(combo.repeat, repeat);
    state.combos.set(groupId, combo);

    const isEnd = data.repeatEnd === true || data.repeatEnd === undefined || repeat <= 1;
    if (!isEnd) return;
    state.combos.delete(groupId);

    // Yalnızca sandık/portal/zarf yazılır; yayıncıya atılan sıradan hediyeler atlanır.
    const kind = kindFor(name);
    if (!kind) return;

    recordEvent(username, {
      kind: kind,
      coins: diamonds > 0 ? diamonds * combo.repeat : 0,
      diamonds: diamonds > 0 ? diamonds * combo.repeat : 0,
      giftName: name,
      boxName: name,
      businessType: 0,
      boxType: '',
      sender
    });
    return;
  }

  // Zarf / sandık / portal: ortak ayrıştırıcı (handleEnvelope) kullanılır.
  if (/envelope|zarf|letter|portal/i.test(event)) {
    handleEnvelope(username, event, data);
    return;
  }

  if (event === 'roomInfo') {
    const record = state.streamers.get(username);
    if (record) {
      if (data.title) record.title = data.title;
      if (data.viewerCount) record.viewers = Number(data.viewerCount) || record.viewers;
    }
    return;
  }

  if (event === 'streamEnd') {
    log('yayın bitti', username);
    markOffline(username);
    closeWatcher(username, 'yayın bitti');
  }
}

// Yayın bitti sinyali: kayıt havuzda kalır, yayıncı tekrar canlıya geçtiğinde
// bir sonraki turda kendiliğinden yeniden dinlenir.
function markOffline(username) {
  const record = state.streamers.get(username);
  if (!record || !record.live) return;
  record.live = false;
  record.endedAt = Date.now();
}

// Keşif oranını ölçülen kutu başarısına göre ayarlar:
//   • deneme odaları, sıcak odalardan 1,5 kat fazla kutu çıkarıyorsa oran artar,
//   • yarısından az çıkarıyorsa oran düşer (sıcak odalara dönülür).
// Sıcak oda verisi yoksa mutlak eşikler kullanılır. Oran %10-%60 arasında kalır.
function adaptProbeRatio() {
  const pSessions = state.probe.winSessions;
  const pBox = state.probe.winBoxSessions;
  const hSessions = state.probe.winHot;
  const hBox = state.probe.winHotBox;
  if (pSessions < CONFIG.probeWindow) return;

  const pRate = pSessions ? pBox / pSessions : 0;
  const hRate = hSessions >= 3 ? hBox / hSessions : null;
  const before = state.probe.ratio;

  if (hRate === null) {
    if (pRate >= CONFIG.probeUpRate) state.probe.ratio += 0.05;
    else if (pRate <= CONFIG.probeDownRate) state.probe.ratio -= 0.05;
  } else if (pRate > 0 && pRate >= hRate * 1.5) {
    state.probe.ratio += 0.05;
  } else if (pRate < hRate * 0.5) {
    state.probe.ratio -= 0.05;
  }

  state.probe.ratio = Math.min(0.6, Math.max(0.1, state.probe.ratio));
  state.probe.winSessions = 0;
  state.probe.winBoxSessions = 0;
  state.probe.winHot = 0;
  state.probe.winHotBox = 0;
  state.targetsDirty = true;

  log('keşif oranı %' + Math.round(state.probe.ratio * 100) +
    ' (deneme ' + pSessions + ' oturum · %' + Math.round(pRate * 100) + ' kutulu' +
    (hRate === null ? '' : ' · sıcak %' + Math.round(hRate * 100)) +
    ' · önceki %' + Math.round(before * 100) + ')');
}

async function closeWatcher(username, reason) {
  const watcher = state.rooms.get(username);
  if (!watcher) return;
  state.rooms.delete(username);

  // Oturum sonucu: kutu çıktı mı? (oran uyarlamasının girdisi)
  const gotBox = Number(watcher.boxes) > 0;
  if (watcher.probe) {
    state.probe.sessions += 1;
    state.probe.winSessions += 1;
    if (gotBox) {
      state.probe.withBox += 1;
      state.probe.winBoxSessions += 1;
    }
  } else if (Number(watcher.boxes) >= 0) {
    state.probe.winHot += 1;
    if (gotBox) state.probe.winHotBox += 1;
  }
  adaptProbeRatio();
  if (watcher.timer) clearTimeout(watcher.timer);
  try {
    if (watcher.connection) watcher.connection.disconnect();
    else if (watcher.socket) watcher.socket.close();
  } catch (error) { /* zaten kapalı */ }
  log('dinleme bitti', username, reason || '');
}

async function stopAllWatchers(reason) {
  await Promise.all(Array.from(state.rooms.keys()).map((username) => closeWatcher(username, reason)));
}

// tiktok-live-connector: anahtarsız, açık kaynak; TikTok olaylarını doğrudan
// çözer. TikTools demo anahtarındaki 429 sınırı olmadığı için aynı anda çok
// daha fazla oda dinlenebiliyor. Kurulu değilse null döner.
let connectorLib;
function loadConnector() {
  if (connectorLib !== undefined) return connectorLib;
  try {
    connectorLib = require('tiktok-live-connector');
  } catch (error) {
    connectorLib = null;
  }
  return connectorLib;
}

// TikTok 
// EnvelopeBusinessType: 9 = PLATFORM_PORTAL, 19 = SUPER_FAN_BOX.
// Gözlemlenen gerçek kutu: businessType 20, 875 jeton / 500 kişi → sandık dağıtımı.
// 21 ise jeton/kişi taşımayan zarf bildirimi.
// TikTok'un businessType kodları: 9 portal, 19 süper fan kutusu, 20 sandık,
// 21 zarf/mektup. Kodu bilinmeyen kutuda uydurma ad yazılmaz: "Kutu" denir.
const BOX_NAMES = { 9: 'Portal', 19: 'Süper Fan Kutusu', 20: 'Sandık', 21: 'Zarf' };

function envelopeName(kind, info) {
  const bt = Number(info && info.businessType) || 0;
  const raw = String((info && (info.boxType || info.displayKey || info.textKey)) || '').trim();
  if (BOX_NAMES[bt]) return BOX_NAMES[bt];
  if (raw && raw !== 'yok') return raw;
  return ({ chest: 'Sandık', portal: 'Portal', letter: 'Zarf' }[kind] || 'Kutu');
}

function envelopeKind(eventName, info) {
  const bt = Number(info && info.businessType) || 0;
  const text = String(eventName || '') + ' ' + String(
    (info && (info.boxType || info.envelopeScene || info.textKey || info.displayKey)) || ''
  );
  if (/portal/i.test(text) || bt === 9) return 'portal';
  if (/treasure|sand[ıi]k|chest/i.test(text) || bt === 19 || bt === 20) return 'chest';
  if (bt === 21) return 'letter';
  return 'letter';
}

function handleEnvelope(username, eventName, data) {
  const info = (data && (data.envelopeInfo || data)) || {};
  const box = (data && data.treasureBoxData) || info.treasureBoxData || {};

  state.envelopeStats.seen += 1;
  const act = String(info.action || 'yok');
  const boxType = String(info.boxType || info.displayKey || 'yok');
  state.envelopeStats.actions[act] = (state.envelopeStats.actions[act] || 0) + 1;
  state.envelopeStats.boxTypes[boxType] = (state.envelopeStats.boxTypes[boxType] || 0) + 1;

  const coins = Number(info.diamondCount || info.coins || box.coins) || 0;
  const people = Number(info.peopleCount || info.recipientCount || box.canOpen) || 0;
  const openIn = Number(info.secondsUntilOpen) || 0;
  if (coins > 0 || people > 0) state.envelopeStats.withCoins += 1;

  state.envelopeSamples.push({
    t: Date.now(), user: username, event: eventName, action: act, boxType,
    businessType: info.businessType || 0, coins, people, secondsUntilOpen: openIn
  });
  if (state.envelopeSamples.length > 5) state.envelopeSamples.shift();

  // İçi boş bildirim fırsat değildir.
  if (coins <= 0 && people <= 0) return;

  const kind = envelopeKind(eventName, info);
  const name = envelopeName(kind, info);
  const boxRecord = state.streamers.get(username);
  if (boxRecord) boxRecord.boxes = (Number(boxRecord.boxes) || 0) + 1;
  // Kutu veren yayıncı havuzda işaretlenir: sonraki koşularda da önce o dinlenir.
  // Oturum bazında kutu sayısı: keşif oranı bu sonuçlara göre ayarlanır.
  const sessionWatcher = state.rooms.get(username);
  if (sessionWatcher) sessionWatcher.boxes = (Number(sessionWatcher.boxes) || 0) + 1;

  const boxTarget = targetFor(username);
  if (boxTarget) {
    boxTarget.boxEvents = (Number(boxTarget.boxEvents) || 0) + 1;
    boxTarget.lastBoxAt = Date.now();
    state.targetsDirty = true;
  }
  recordEvent(username, {
    kind,
    coins,
    shared: people,
    durationSec: openIn,
    giftName: name,
    boxName: name,
    businessType: Number(info.businessType) || 0,
    boxType: boxType === 'yok' ? '' : boxType,
    sender: info.sendUserName || '',
    senderName: info.sendUserName || info.senderName || ''
  });
}

function handleConnectorGift(username, data) {
  const repeat = Number(data.repeatCount) || 1;
  const diamonds = Number(data.diamondCount) || 0;
  const name = data.giftName || 'Hediye';
  const sender = (data.user && data.user.uniqueId) || '';
  const groupId = String(data.groupId || (data.giftId + '|' + sender + '|' + name));

  const combo = state.combos.get(groupId) || { diamonds, repeat: 0 };
  combo.diamonds = diamonds || combo.diamonds;
  combo.repeat = Math.max(combo.repeat, repeat);
  state.combos.set(groupId, combo);

  const isEnd = data.repeatEnd === true || repeat <= 1;
  if (!isEnd) return;
  state.combos.delete(groupId);

  const kind = kindFor(name);
  if (!kind) return;

  recordEvent(username, {
    kind,
    coins: diamonds > 0 ? diamonds * combo.repeat : 0,
    diamonds: diamonds > 0 ? diamonds * combo.repeat : 0,
    giftName: name,
    boxName: name,
    businessType: 0,
    boxType: '',
    sender
  });
}

async function openConnectorWatcher(username, sessionSec) {
  const lib = loadConnector();
  if (!lib || !lib.TikTokLiveConnection) throw new Error('tiktok-live-connector yok');

  const connection = new lib.TikTokLiveConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true
  });

  const watcher = {
    username, connection, startedAt: Date.now(), messages: 0, timer: null, kind: 'connector',
    sessionSec: sessionSec || CONFIG.watchSec
  };
  state.rooms.set(username, watcher);

  const bump = () => { watcher.messages += 1; };
  connection.on('gift', (data) => { bump(); handleConnectorGift(username, data); });
  connection.on('envelope', (data) => { bump(); handleEnvelope(username, 'envelope', data); });
  connection.on('superFanBox', (data) => { bump(); handleEnvelope(username, 'superFanBox', data); });
  connection.on('roomUser', (data) => {
    const record = state.streamers.get(username);
    if (record && data && data.viewerCount) record.viewers = Number(data.viewerCount) || record.viewers;
  });
  connection.on('streamEnd', () => { markOffline(username); closeWatcher(username, 'yayın bitti'); });
  connection.on('disconnected', () => { state.rooms.delete(username); });
  connection.on('error', (error) => { state.lastError = username + ': ' + ((error && error.message) || 'bağlantı hatası'); });

  await connection.connect();

  const liveRecord = state.streamers.get(username);
  if (liveRecord && connection.roomId) liveRecord.roomId = String(connection.roomId);

  watcher.timer = setTimeout(() => { closeWatcher(username, 'süre doldu'); },
    (watcher.sessionSec || CONFIG.watchSec) * 1000);
  log('dinleniyor', username);
}

async function openWatcher(username, sessionSec) {
  if (CONFIG.connector) {
    try {
      await openConnectorWatcher(username, sessionSec);
      return;
    } catch (error) {
      state.lastError = 'dinleme: ' + username + ' ' + error.message;
      log('bağlayıcı hatası', username, error.message);
      closeWatcher(username, 'bağlanamadı');
      // Hız sınırı / cihaz engeli: yedek yola düşmek de 429 yer; bekle.
      // 429 / "token yok (429)" da hız sınırıdır: bütçeyi düşür, bekle.
      if (/rate|too many|device_blocked|429|\b503\b/i.test(error.message || '')) {
        throw error;
      }
      // Diğer hatalarda aşağıdaki TikTools yolu yedek olarak denenir.
    }
  }

  const token = await mintToken(username, Math.min(900, (sessionSec || CONFIG.watchSec) + 60));
  const WS = wsFactory();
  const socket = new WS('wss://api.tik.tools?uniqueId=' + encodeURIComponent(username) +
    '&jwtKey=' + encodeURIComponent(token));

  const watcher = {
    username, socket, startedAt: Date.now(), messages: 0, timer: null, kind: 'tiktools',
    sessionSec: sessionSec || CONFIG.watchSec
  };
  state.rooms.set(username, watcher);

  const onMessage = (raw) => {
    watcher.messages += 1;
    const text = typeof raw === 'string' ? raw : (raw && raw.data) || raw;
    handleStreamMessage(username, text);
  };

  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('message', (event) => onMessage(event.data));
    socket.addEventListener('close', () => { state.rooms.delete(username); });
    socket.addEventListener('error', () => {
      state.lastError = username + ': soket hatası';
    });
  } else {
    socket.on('message', onMessage);
    socket.on('close', () => { state.rooms.delete(username); });
    socket.on('error', (error) => {
      state.lastError = username + ': ' + ((error && error.message) || 'soket hatası');
    });
  }

  watcher.timer = setTimeout(() => { closeWatcher(username, 'süre doldu'); },
    (watcher.sessionSec || CONFIG.watchSec) * 1000);
  log('dinleniyor', username);
}

// Canlı odalar sırayla değil, aynı anda birden çok soketle dinlenir.
// Dinleme kapasitesi kendini ayarlar:
//   • odalar arası en az CONFIG.connectGapMs boşluk (ani bağlantı dalgası yok),
//   • hız sınırı yiyince bütçe %25 düşer ve bekleme üstel artar (1→2→4→8 dk),
//   • başarılı her bağlantıda bütçe yarım oda toparlanır (üst sınır watchRooms).
// Üç tür oda vardır:
//   • SICAK  : kutu geçmişi olan oda (12 dk sonra geri dönülür, 1,5× oturum),
//   • ADAY   : keşifte bulunup hiç dinlenmemiş yayıncı (kısa deneme oturumu),
//   • NORMAL : geri kalanlar (30 dk aralık).
// Adaylara bütçenin bir kısmı ayrılır: sıcak listede olmayan ama kutu paylaşan
// yeni yayıncılar böylece kendiliğinden bulunur, kutu düşerse sıcağa geçer.

function boxPriority(record, now) {
  const target = targetFor(record.username);
  const history = Number(target && target.boxEvents) || 0;
  const recentBox = target && Number(target.lastBoxAt) &&
    (now - Number(target.lastBoxAt) < CONFIG.hotWindowMs);
  return history + (recentBox ? 3 : 0) + (Number(record.boxes) || 0);
}

function isHotRoom(record, now) {
  const target = targetFor(record.username);
  if (!target || !Number(target.boxEvents)) return false;
  return now - (Number(target.lastBoxAt) || 0) < CONFIG.hotWindowMs;
}

function lastWatchedAt(record) {
  const target = targetFor(record.username);
  return Number(target && target.lastWatchedAt) || 0;
}

// Sıradaki odayı seçer (ağa çıkmaz, saf fonksiyon → test edilebilir).
function pickRoom(options) {
  const {
    live, rooms, probing, probeBudget, recent, now,
    hotRevisitMs, revisitMs, isHot, watchedAt
  } = options;

  const free = live.filter((record) =>
    !rooms.has(record.username) && now - watchedAt(record) >= 60000);
  if (!free.length) return null;

  // Hiç dinlenmemiş adaylar: keşifte yeni bulunan, sıcak listede olmayanlar.
  const untouched = free.filter((record) => !watchedAt(record));
  const probeRoom = probing < probeBudget ? untouched[0] : null;

  const hotRoom = free.find((record) =>
    isHot(record, now) && now - watchedAt(record) >= hotRevisitMs);
  const coldRoom = free.find((record) => now - watchedAt(record) >= revisitMs);
  const fallback = free.find((record) => !recent.includes(record.username)) || free[0];

  const record = probeRoom || hotRoom || coldRoom || fallback;
  if (!record) return null;
  return { record, probe: record === probeRoom, hot: isHot(record, now) };
}

async function maintainWatchers() {
  if (!CONFIG.watch) return;

  const now = Date.now();
  if (state.connectorCooldownUntil > now) return;
  if (now - state.lastConnectAt < CONFIG.connectGapMs) return;

  for (const [username, watcher] of Array.from(state.rooms.entries())) {
    const limit = (watcher.sessionSec || CONFIG.watchSec) * 1000;
    if (now - watcher.startedAt >= limit) await closeWatcher(username, 'süre doldu');
  }

  // Önce kutu vermiş odalar, sonra izleyici sayısı, sonra toplanan jeton.
  const live = Array.from(state.streamers.values())
    .filter((record) => record.live)
    .sort((a, b) =>
      boxPriority(b, now) - boxPriority(a, now) ||
      (Number(b.viewers) || 0) - (Number(a.viewers) || 0) ||
      (Number(b.coins) || 0) - (Number(a.coins) || 0));

  if (!state.roomBudget) state.roomBudget = CONFIG.watchRooms;
  const target = Math.min(Math.max(CONFIG.minRooms, Math.round(state.roomBudget)),
    CONFIG.watchRooms, live.length);

  // Oran artık sabit değil: kutu başarısına göre uyarlanır (probe-ratio başlangıç).
  const probeBudget = Math.max(1, Math.round(target * state.probe.ratio));

  while (state.rooms.size < target) {
    if (Date.now() - state.lastConnectAt < CONFIG.connectGapMs) break;

    const probing = Array.from(state.rooms.values()).filter((watcher) => watcher.probe).length;
    const pick = pickRoom({
      live, rooms: state.rooms, probing, probeBudget, recent: state.recent, now,
      hotRevisitMs: CONFIG.hotRevisitMs, revisitMs: CONFIG.revisitMs,
      isHot: isHotRoom, watchedAt: lastWatchedAt
    });
    if (!pick) break;

    const sessionSec = pick.probe
      ? CONFIG.probeSec
      : (pick.hot ? Math.round(CONFIG.watchSec * 1.5) : CONFIG.watchSec);

    state.recent.push(pick.record.username);
    if (state.recent.length > 200) state.recent.shift();

    try {
      await openWatcher(pick.record.username, sessionSec);
      state.lastConnectAt = Date.now();
      state.connectFailures = 0;
      state.roomBudget = Math.min(CONFIG.watchRooms, state.roomBudget + 0.5);

      const watcher = state.rooms.get(pick.record.username);
      if (watcher) watcher.probe = pick.probe;

      const watched = targetFor(pick.record.username);
      if (watched) {
        watched.lastWatchedAt = Date.now();
        state.targetsDirty = true;
      }
      if (pick.probe) log('yeni aday deneniyor:', pick.record.username, sessionSec + ' sn');
      else if (pick.hot) log('sıcak oda (kutu geçmişi):', pick.record.username, sessionSec + ' sn');
    } catch (error) {
      state.lastError = 'dinleme: ' + pick.record.username + ' ' + error.message;
      log('dinleme hatası', pick.record.username, error.message);
      // 429 / "token yok (429)" da hız sınırıdır: bütçeyi düşür, bekle.
      if (/rate|too many|device_blocked|429|\b503\b/i.test(error.message || '')) {
        state.connectFailures = Math.min(6, state.connectFailures + 1);
        const waitMs = Math.min(8 * 60000, 60000 * Math.pow(2, state.connectFailures - 1));
        state.connectorCooldownUntil = Date.now() + waitMs;
        state.roomBudget = Math.max(CONFIG.minRooms, Math.round(state.roomBudget * 0.75));
        log('hız sınırı: bütçe ' + Math.round(state.roomBudget) + ' oda · ' +
          Math.round(waitMs / 1000) + ' sn yeni bağlantı yok');
      }
      break;
    }
  }
}

// ---------- 3) tarama turu ----------

async function pollTargets() {
  const targets = state.targets;
  state.polls += 1;
  let liveCount = 0;

  const results = await mapLimit(targets, CONFIG.concurrency, async (target) => {
    const status = await fetchLiveStatus(target.username);
    return { target, status };
  });

  results.forEach(({ target, status }) => {
    const username = target.username;
    const record = state.streamers.get(username) || {
      username,
      country: target.country || '',
      coins: 0,
      gifts: 0,
      live: false
    };

    const seenBefore = Boolean(record.checkedAt);
    record.checkedAt = Date.now();
    record.reason = status.live ? '' : (status.reason || '');
    if (status.unknown) {
      // Doğrulanamadı: canlı/offline bilgisi değiştirilmez.
      record.reason = status.reason || 'doğrulanamadı';
      state.streamers.set(username, record);
      return;
    }
    if (status.live) {
      liveCount += 1;
      // Daha önce taranmış ama yayında değilken yeniden canlıya geçen oda.
      if (seenBefore && !record.live) log('yeniden canlı:', username);
      record.live = true;
      record.lastSeenLiveAt = Date.now();
      if (!target.lastSeenLiveAt) target.lastSeenLiveAt = Date.now();
      if (status.roomId) record.roomId = String(status.roomId);
      if (status.startTime) record.startTime = status.startTime;
      if (status.title) record.title = status.title;
      if (status.viewers) record.viewers = status.viewers;
      state.streamers.set(username, record);
    } else {
      if (record.live) {
        record.endedAt = Date.now();
        record.live = false;
      }
      state.streamers.set(username, record);
      if (state.rooms.has(username)) closeWatcher(username, 'yayın bitti');
    }
  });

  log('tur', state.polls, '· havuz', targets.length, '· canlı', liveCount, '· dinlenen', state.rooms.size);
}

// ---------- çıktı ----------

function snapshot() {
  const streamers = Array.from(state.streamers.values())
    // Havuzdaki her adres yazılır: panel "taranmış ama yayında değil" ile
    // "hiç taranmamış" durumunu ayırabilsin, eski Canlı durumu takılı kalmasın.
    .filter((record) => record.checkedAt || record.live || record.startTime || record.coins)
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.coins || 0) - (a.coins || 0);
    })
    .map((record) => ({
      username: record.username,
      country: record.country || '',
      live: Boolean(record.live),
      startTime: Number(record.startTime) || 0,
      title: record.title || '',
      viewers: Number(record.viewers) || 0,
      coins: Number(record.coins) || 0,
      gifts: Number(record.gifts) || 0,
      lastGiftAt: record.lastGiftAt || 0,
      lastGiftName: record.lastGiftName || '',
      lastSeenLiveAt: record.lastSeenLiveAt || 0,
      reason: record.reason || '',
      checkedAt: record.checkedAt || 0,
      roomId: record.roomId || '',
      boxes: Number(record.boxes) || 0,
      lastBoxAt: Number((targetFor(record.username) || {}).lastBoxAt) || 0
    }));

  return {
    scannedAt: new Date().toISOString(),
    scanner: {
      targetCount: state.targets.length,
      liveCount: streamers.filter((item) => item.live).length,
      discovered: state.discoveredTotal,
      poolSize: state.targets.length,
      watching: state.rooms.size,
      budget: Math.round(state.roomBudget) || CONFIG.watchRooms,
      freshLive: state.targets.filter((target) => !target.lastWatchedAt &&
        state.streamers.has(target.username) && state.streamers.get(target.username).live).length,
      probes: Array.from(state.rooms.values()).filter((watcher) => watcher.probe).length,
      probeRatio: Math.round(state.probe.ratio * 100) / 100,
      probeStats: {
        sessions: state.probe.sessions,
        withBox: state.probe.withBox
      },
      connectFailures: state.connectFailures,
      polls: state.polls,
      minutesLeft: CONFIG.minutes > 0 ? Math.max(0, Math.round((deadline - Date.now()) / 60000)) : null,
      lastError: state.lastError,
      envelopes: state.envelopeStats,
      envelopeSamples: state.envelopeSamples,
      version: 1
    },
    streamers,
    events: state.events
  };
}

function flush(force) {
  const now = Date.now();
  // Kutu geçmişi ve son izleme zamanı da diske yazılır (koşular arası kalıcı).
  if (state.targetsDirty) {
    state.targetsDirty = false;
    saveTargets();
  }
  if (!force && now - state.lastFlush < 20000) return;
  state.lastFlush = now;
  const data = snapshot();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIVE_FILE, JSON.stringify(data, null, 1) + '\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
}

function abortRebase() {
  try { git(['rebase', '--abort']); } catch (error) { /* rebase yoktu */ }
}

function syncWithRemote() {
  try {
    git(['pull', '--rebase', '--autostash', '--quiet']);
  } catch (error) {
    // Veri dosyası her turda yeniden üretiliyor; kavga edip depoyu kilitlemeyelim.
    abortRebase();
    throw error;
  }
}

function commitData() {
  if (!CONFIG.commitSec) return;
  const now = Date.now();
  if (now - state.lastCommit < CONFIG.commitSec * 1000) return;
  state.lastCommit = now;
  try {
    syncWithRemote();
    // targets.json de commit edilir: kutu geçmişi ve son izleme zamanı
    // koşu bitince kaybolmasın, sonraki koşu aynı odaları öncelikli dinlesin.
    git(['add', 'site/firsat/data/live.json', 'site/firsat/data/targets.json']);
    if (!git(['status', '--porcelain', 'site/firsat/data/live.json', 'site/firsat/data/targets.json']).trim()) return;
    const summary = snapshot().scanner;
    git(['commit', '-m',
      'Canlı tarama: ' + summary.liveCount + '/' + summary.targetCount +
      ' yayında · ' + summary.watching + ' oda dinleniyor']);
    try {
      git(['push', '--quiet']);
    } catch (pushError) {
      syncWithRemote();
      git(['push', '--quiet']);
    }
    log('veri commit edildi');
  } catch (error) {
    log('commit atlandı:', (error.stdout || error.message || '').toString().slice(0, 160));
  }
}

// ---------- ana döngü ----------

async function main() {
  state.targets = loadTargets();
  if (state.targets.length === 0) {
    log('uyarı: site/firsat/data/targets.json boş — taranacak adres yok.');
  }
  state.roomBudget = CONFIG.watchRooms;
  // Kayıtlı oran varsa ondan devam et; yoksa ayardaki başlangıç oranı.
  state.probe.ratio = state.savedRatio || CONFIG.probeRatio;
  log('havuz', state.targets.length, 'adres · süre',
    CONFIG.minutes > 0 ? CONFIG.minutes + ' dk' : 'tek tur');

  flush(true);

  do {
    try {
      await discoverLive();
      await pollTargets();
      await maintainWatchers();
    } catch (error) {
      state.lastError = error.message;
      log('tur hatası:', error.message);
    }
    flush(true);
    commitData();
    if (CONFIG.once) break;
    await sleep(CONFIG.pollSec * 1000);
  } while (Date.now() < deadline);

  await stopAllWatchers('kapanış');
  state.rooms.clear();
  flush(true);
  commitData();
  log('bitti');
}

// Kendi kendini sınama: ayrıştırıcının hangi paketleri yazıp hangilerini
// atladığını gerçek alan adlarıyla gösterir. Ağa çıkmaz.
if (process.env.SCANNER_SELFTEST === '1') {
  const frames = [
    ['sıradan hediye (Rose)', { event: 'gift', data: { giftName: 'Rose', giftId: 5655, diamondCount: 1, repeatCount: 1, repeatEnd: true, msgId: 'a1' } }],
    ['sandık hediyesi', { event: 'gift', data: { giftName: 'Sandık', giftId: 9001, diamondCount: 500, repeatCount: 1, repeatEnd: true, msgId: 'a2' } }],
    ['sandık kutusu (businessType 20)', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e1', businessType: 20, diamondCount: 100, peopleCount: 25, secondsUntilOpen: 30 } } }],
    ['zarf kutusu (businessType 21)', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e4', businessType: 21, diamondCount: 50, peopleCount: 10 } } }],
    ['portal zinciri (businessType 9)', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e2', businessType: 9, diamondCount: 200, peopleCount: 50, secondsUntilOpen: 15 } } }],
    ['boş zarf bildirimi', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e3', action: 'hide', boxType: 'spark_box', coins: null, recipientCount: null } } }]
  ];
  // Oda seçimi: aday / sıcak / normal önceliği.
  const nowMs = Date.now();
  const fake = (username) => ({ username, live: true, viewers: 0, coins: 0 });
  const probeCase = pickRoom({
    live: [fake('aday'), fake('sicak'), fake('normal')],
    rooms: new Map(), probing: 0, probeBudget: 2, recent: [], now: nowMs,
    hotRevisitMs: 720000, revisitMs: 1800000,
    isHot: (record) => record.username === 'sicak',
    watchedAt: (record) => (record.username === 'aday' ? 0 : nowMs - 3600000)
  });
  console.log('SEÇİM aday varken →', probeCase.record.username,
    '(aday:', probeCase.probe, '· sıcak:', probeCase.hot, ')');

  const hotCase = pickRoom({
    live: [fake('sicak'), fake('normal')],
    rooms: new Map(), probing: 2, probeBudget: 2, recent: [], now: nowMs,
    hotRevisitMs: 720000, revisitMs: 1800000,
    isHot: (record) => record.username === 'sicak',
    watchedAt: () => nowMs - 3600000
  });
  console.log('SEÇİM aday bütçesi dolunca →', hotCase.record.username,
    '(sıcak:', hotCase.hot, ')');

  // Keşif oranı uyarlaması: ölçülen kutu başarısına göre artar/azalır.
  state.probe.ratio = 0.4;
  state.probe.winSessions = 8;
  state.probe.winBoxSessions = 4;
  state.probe.winHot = 8;
  state.probe.winHotBox = 1;
  adaptProbeRatio();
  console.log('ORAN deneme kutu çok →', state.probe.ratio, '(beklenen 0.45)');

  state.probe.winSessions = 8;
  state.probe.winBoxSessions = 0;
  state.probe.winHot = 8;
  state.probe.winHotBox = 4;
  adaptProbeRatio();
  console.log('ORAN deneme kutu yok →', state.probe.ratio, '(beklenen 0.4)');

  state.probe.ratio = 0.58;
  state.probe.winSessions = 8;
  state.probe.winBoxSessions = 8;
  state.probe.winHot = 3;
  state.probe.winHotBox = 0;
  adaptProbeRatio();
  console.log('ORAN üst sınır →', state.probe.ratio, '(beklenen 0.6)');

  frames.forEach(([label, frame]) => {
    const before = state.events.length;
    handleStreamMessage('test_user', JSON.stringify(frame));
    const added = state.events.length > before ? state.events[0] : null;
    console.log(added
      ? `YAZDI  ${label} → ${added.kind} ${added.coins} jeton · ${added.shared} kişi · ${added.durationSec} sn · kutu: ${added.boxName || '-'} (tür ${added.businessType || 0})`
      : `ATLADI ${label}`);
  });
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
