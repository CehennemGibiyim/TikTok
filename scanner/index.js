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
// Masaüstü uygulaması veriyi kendi klasörüne yazar (kurulum dizini salt okunur).
const DATA_DIR = process.env.SCANNER_DATA_DIR
  ? path.resolve(process.env.SCANNER_DATA_DIR)
  : path.join(ROOT, 'site', 'firsat', 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const LIVE_FILE = path.join(DATA_DIR, 'live.json');
// Küçük ve hızlı dosya: yalnızca son kutular. Panel bunu 15 saniyede bir
// okur, böylece sandık/zarf panelde dakikalar değil saniyeler içinde görünür.
const BOX_FILE = path.join(DATA_DIR, 'boxes.json');

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
  // Kutular ayrı ve sık commit edilir: yakalama penceresi kısa, panel hızlı görsün.
  // Anlık kutu yayını: commit/CDN beklemeden panel saniyeler içinde görsün.
  // Panel aynı konuya abone olur (site/firsat/app.js → BOX_TOPIC).
  ntfy: readArg('ntfy', 1) ? true : false,
  ntfyTopic: String(readArg('ntfy-topic', 'cehennem-tiktok-firsat-7f3a91')),
  // Konu herkese açık: sahte kutu yayınlanamasın diye paylaşılan anahtar.
  // Paneldeki BOX_KEY ile aynı olmalı (değiştirirsen iki tarafı birlikte değiştir).
  ntfyKey: String(readArg('ntfy-key', process.env.NTFY_KEY || 'XQMPSwldDoS26gnVIV1ClCyb')),
  // Havuzun her turda kaç adresi yoklanacağı (0 = hepsi). Ağır tarama
  // dinleme döngüsünü yavaşlatıyordu; havuz sırayla dilim dilim yoklanır.
  pollBatch: Number(readArg('poll-batch', 0)),
  discover: readArg('discover', 1) ? true : false,
  discoverSec: Number(readArg('discover-sec', 300)),

  // Havuz sınırı büyük tutulur: bulunan yayıncı listede kalır, her taramada
  // 10 kişi eklenip 10 kişi düşmez.
  maxPool: Number(readArg('max-pool', 6000)),
  watch: readArg('watch', readArg('once', 0) ? 0 : 1) ? true : false,
  // tiktok-live-connector ile dinle (anahtarsız).
  connector: readArg('connector', 1) ? true : false,
  // TikTools demo anahtarı neredeyse her zaman 429 veriyor; varsayılan kapalı.
  // Açıkken bağlayıcı hatası bu 429'un arkasında kayboluyordu.
  tiktools: readArg('tiktools', 0) ? true : false,
  watchSec: Number(readArg('watch-sec', 300)),
  watchRooms: Number(readArg('watch-rooms', 8)),
  // Bağlantılar arası en az boşluk: hız sınırına çarpmadan sırayla açılır.
  connectGapMs: Number(readArg('connect-gap', 4000)),
  // Dakikada en fazla kaç yeni bağlantı başlatılır (Euler: "too many connections
  // started" hatası dakikalık sayaca bakıyor).
  startsPerMin: Math.max(1, Number(readArg('starts-per-min', 8))),
  // Saatlik bağlantı bütçesi: son 60 dakikada en fazla bu kadar bağlantı denenir.
  // Sınıra yaklaşınca aralık kendiliğinden uzar, yani TikTok'un hourly kotasına
  // çarpmadan yavaşlanır; bütçe boşalınca en eski deneme saati doldurunca devam eder.
  // Varsayılan 25: üretimde ölçülen pratik sınır ~23, üstüne çıkmak 429 yiyor.
  hourBudget: Math.max(1, Number(readArg('hour-budget', 25)) || 25),
  // Sınır yediğimizde inilebilecek en düşük eşzamanlı oda sayısı.
  minRooms: Number(readArg('min-rooms', 8)),
  // Oda kimliği bu süreden eskiyse güvenilmez: bağlanmadan önce tazelenir (30 dk).
  roomIdFreshMs: Number(readArg('room-id-fresh-sec', 900)) * 1000,
  // api-live bu sunucularda boş döndüğü için "canlı" bilgisi doğrulanamıyor.
  // Bu süreden eski "canlı" kaydı yayında sayılmaz (yanlış CANLI etiketi olmasın).
  liveStaleSec: Math.max(120, Number(readArg('live-stale-sec', 900))),
  // Aday seçimi: doğrulanamayan odaya yalnızca taze oda kimliği varsa bağlanılır.
  // Keşif ucu yalnızca gerçekten yayında olan kanalları döndürdüğü için bu,
  // boşa bağlantı (ve günlük kota) harcamayı büyük ölçüde keser.
  roomIdOnly: readArg('room-id-only', 1) ? true : false,
  // Bağlanamayan odaya tekrar denemeden önce beklenir; her hatada ikiye katlanır (üst 60 dk).
  failBackoffSec: Math.max(30, Number(readArg('fail-backoff-sec', 600))),
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
  // Ülke tablolarının taranma aralığı (saat): günde bir.
  sweepHours: Math.max(1, Number(readArg('sweep-hours', 24))),
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
  envelopeStats: { seen: 0, withCoins: 0, recorded: 0, skipped: 0, duplicate: 0, actions: {}, boxTypes: {} },
  envelopeSamples: [],
  // Aynı kutu iki olayla geliyor (envelope + superFanBox): kimlikle tekilleştirilir.
  envelopeSeen: new Set(),
  connectorCooldownUntil: 0,
  // Bağlanılamayan odalara tekrar deneme zamanı (username -> ms) ve hata sayısı.
  // Bu olmadan aynı ölü oda dakikada birkaç kez deneniyor ve TikTok'un günlük
  // bağlantı kotası (rate_limit_account_day) boşa yanıyordu.
  failUntil: new Map(),
  failCounts: new Map(),
  // Eşzamanlı oda bütçesi: sınır yedikçe düşer, başarılı bağlantıda toparlanır.
  roomBudget: 0,
  connectFailures: 0,
  // Kota koruması devreye girdiyse burada tutulur (panelde gösterilir).
  tuningGuard: null,
  // Bağlantı teşhisi: panel "neden 0 oda" sorusunu buradan yanıtlar.
  connectStats: { attempts: 0, ok: 0, failed: 0, rateLimited: 0, offline: 0, dayLimited: false, errors: [] },
  connectStarts: [],
  // Saatlik bütçe: son 60 dakikadaki deneme zamanları ve hız sınırından öğrenilen üst sınır.
  hourStarts: [],
  hourBudgetLearned: 0,
  lastConnectorError: null,
  closeReasons: {},
  lastConnectAt: 0,
  targetsDirty: false,
  // Keşif oranı: deneme oturumlarının kutu başarısına göre kendini ayarlar.
  probe: {
    ratio: 0, sessions: 0, withBox: 0,
    winSessions: 0, winBoxSessions: 0, winHot: 0, winHotBox: 0
  },
  savedRatio: 0,
  // Oran uyarlamasının son kararları (panelde gösterilir, en fazla 5).
  probeHistory: [],
  // Saatlik kutu sayacı {saat: sayı}: panel kutu serisini bundan çizer.
  // Koşular arasında targets.json'da kalır, 48 saatten eskisi atılır.
  boxHourly: {},
  lastFlush: 0,
  lastCommit: 0,
  // Kutu dosyası: commit bekleyen yeni kutu var mı, son yazılan listenin imzası.
  boxesDirty: false,
  boxesSig: '',
  lastDiscover: 0,
  // Keşif uçlarını sırayla kullan (her çağrı ayrı 10 kanal).
  discoverVariant: 0,
  // Günlük ülke taraması raporu (panelde gösterilir, koşular arası korunur).
  regionSweep: { at: 0, added: 0, regions: {}, failed: [] },
  regionSweepRunning: false,
  discoveredTotal: 0,
  lastError: null,
  polls: 0
};

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

// "Yayın bitmiş" hatası hız sınırı değildir: ayrı sayılır, ceza verilmez.
function isOfflineError(error) {
  return /isn'?t online|is not online|not live|offline|room (is )?not found|\b404\b/i
    .test(String((error && error.message) || ''));
}

// Bağlantı hatasını kaynağıyla birlikte saklar (panelde gösterilir).
function noteConnect(username, source, error) {
  if (error && typeof error === 'object') error.noted = true;
  const message = String((error && error.message) || error || 'bilinmeyen hata').slice(0, 140);
  state.connectStats.errors.push({ at: Date.now(), username, source, message });
  if (state.connectStats.errors.length > 5) state.connectStats.errors.shift();
  if (source === 'connector') state.lastConnectorError = message;
  state.lastError = 'dinleme: ' + username + ' (' + source + ') ' + message;
}

// Oturum kapanışını planlar. Hız sınırı soğumasında yeni bağlantı kurulamadığı
// için çalışan oda kapatılmaz: birer dakika uzatılır (en fazla 10 dk).
function armWatcherTimer(watcher) {
  if (watcher.timer) clearTimeout(watcher.timer);
  const base = (watcher.sessionSec || CONFIG.watchSec) * 1000 + (watcher.extendedMs || 0);
  const left = Math.max(0, watcher.startedAt + base - Date.now());
  watcher.timer = setTimeout(() => {
    if (state.connectorCooldownUntil > Date.now() && (watcher.extendedMs || 0) < 10 * 60000) {
      watcher.extendedMs = (watcher.extendedMs || 0) + 60000;
      log('soğuma sürüyor, oturum 1 dk uzatıldı:', watcher.username);
      armWatcherTimer(watcher);
      return;
    }
    closeWatcher(watcher.username, 'süre doldu');
  }, Math.max(1000, left));
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

    // Önceki koşuların saatlik kutu sayıları: kutu serisi koşu bitince sıfırlanmasın.
    const savedHourly = parsed && parsed.boxHourly;
    if (savedHourly && typeof savedHourly === 'object') {
      const keepFrom = Math.floor(Date.now() / 3600000) - 48;
      Object.keys(savedHourly).forEach((key) => {
        const hour = Number(key);
        const count = Number(savedHourly[key]);
        if (!Number.isFinite(hour) || !count || hour < keepFrom) return;
        state.boxHourly[hour] = count;
      });
    }

    // Son ülke taraması raporu: günde bir çalışsın diye zamanı korunur.
    const savedSweep = parsed && parsed.regionSweep;
    if (savedSweep && Number(savedSweep.at)) {
      state.regionSweep = {
        at: Number(savedSweep.at) || 0,
        added: Number(savedSweep.added) || 0,
        regions: (savedSweep.regions && typeof savedSweep.regions === 'object') ? savedSweep.regions : {},
        failed: Array.isArray(savedSweep.failed) ? savedSweep.failed : []
      };
    }

    // Önceki koşuların oran kararları: panel son 24 saati bunlardan çizer.
    const savedHistory = Array.isArray(parsed && parsed.probeHistory) ? parsed.probeHistory : [];
    const keepAfter = Date.now() - 7 * 86400000;
    state.probeHistory = savedHistory
      .filter((item) => item && Number(item.at) >= keepAfter)
      .slice(-40)
      .map((item) => ({
        at: Number(item.at) || 0,
        from: Math.round(Number(item.from) || 0),
        to: Math.round(Number(item.to) || 0),
        probeRate: Math.round(Number(item.probeRate) || 0),
        hotRate: item.hotRate === null || item.hotRate === undefined
          ? null : Math.round(Number(item.hotRate) || 0),
        sessions: Number(item.sessions) || 0,
        boxSessions: Number(item.boxSessions) || 0
      }));
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
        // Eski kayıtlarda tarih yok: kimlik zaten canlı durumdan/keşiften gelmiş,
        // "şimdi doğrulanmış" sayılır. İki boş oturumda yine silinir.
        roomIdAt: (typeof item === 'object' && item && Number(item.roomIdAt)) ||
          ((typeof item === 'object' && item && item.roomId)
            ? (Number(item.lastSeenLiveAt) || Date.now())
            : 0),
        roomIdMiss: (typeof item === 'object' && item && Number(item.roomIdMiss)) || 0,
        // Kutu geçmişi dosyada kalır: yeni koşu yayıncıyı yine öncelikli izler.
        // boxCoinSum/boxCoinsSeen: jetonu bilinen kutuların toplamı ve sayısı
        // (ortalama jeton buradan çıkar; bilinmeyen jeton ortalamaya girmez).
        boxEvents: (typeof item === 'object' && item && Number(item.boxEvents)) || 0,
        boxCoinSum: (typeof item === 'object' && item && Number(item.boxCoinSum)) || 0,
        boxCoinsSeen: (typeof item === 'object' && item && Number(item.boxCoinsSeen)) || 0,
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
  // Dışarıdan eklenenler korunur: dosyada olup bellekte olmayan adresler
  // (masaüstü uygulamasında panelin bölge keşfi) havuza alınır.
  try {
    const parsed = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.targets || [];
    const known = new Set(state.targets.map((target) => target.username.toLowerCase()));
    list.forEach((item) => {
      const username = cleanUsername(typeof item === 'string' ? item : item && item.username);
      if (!username || known.has(username.toLowerCase())) return;
      known.add(username.toLowerCase());
      state.targets.push({
        username,
        country: (item && item.country) || '',
        source: (item && item.source) || 'manual',
        roomId: '',
        roomIdAt: 0,
        roomIdMiss: 0,
        boxEvents: 0,
        boxCoinSum: 0,
        boxCoinsSeen: 0,
        lastBoxAt: 0,
        lastWatchedAt: 0,
        addedAt: Number(item && item.addedAt) || Date.now(),
        lastSeenLiveAt: Number(item && item.lastSeenLiveAt) || 0
      });
    });
    trimPool();
  } catch (error) {
    // Dosya henüz yoksa sorun değil.
  }

  // Keşifle bulunanlar eklenir, kullanıcının kendi ekledikleri korunur.
  const body = {
    note: 'Taranacak adresler. Keşif kendi bulduklarını buraya ekler; elle eklenenler korunur.',
    // Öğrenilen keşif oranı: sonraki koşu buradan devam eder.
    probeRatio: Math.round(state.probe.ratio * 100) / 100,
    probeStats: {
      sessions: state.probe.sessions,
      withBox: state.probe.withBox
    },
    // Kararlar koşular arasında da korunur (panel 24 saatlik geçmişi gösterir).
    probeHistory: state.probeHistory,
    // Saatlik kutu sayıları: panel 24 saatlik kutu serisini bundan çizer.
    boxHourly: state.boxHourly,
    // Günlük ülke taraması: zamanı ve sonucu koşular arasında korunur.
    regionSweep: state.regionSweep,
    updatedAt: new Date().toISOString(),
    targets: state.targets.map((target) => ({
      username: target.username,
      country: target.country || '',
      source: target.source || 'manual',
      roomId: target.roomId || '',
      roomIdAt: target.roomIdAt || 0,
      roomIdMiss: target.roomIdMiss || 0,
      boxEvents: target.boxEvents || 0,
      boxCoinSum: target.boxCoinSum || 0,
      boxCoinsSeen: target.boxCoinsSeen || 0,
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

// Ticker listesi tek çağrıda 10 kanal veriyor ve bölge parametresi ayrı bir
// liste döndürüyor; iki listeyi sırayla çağırmak aday sayısını ikiye katlıyor.
const DISCOVERY_VARIANTS = [
  'https://api.tik.tools/api/live/top-channels',
  'https://api.tik.tools/api/live/top-channels?region=US'
];

async function fetchDiscoveryPage() {
  const url = DISCOVERY_VARIANTS[state.discoverVariant % DISCOVERY_VARIANTS.length];
  state.discoverVariant += 1;
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('http ' + response.status);
  const payload = await response.json();
  return (payload && payload.channels) || [];
}

// Havuz sınırı aşılırsa en eski, hiç canlı görülmemiş keşif kayıtları düşer;
// elle eklenenler ve kutu vermiş odalar kalır.
function trimPool() {
  if (state.targets.length <= CONFIG.maxPool) return 0;
  const overflow = state.targets.length - CONFIG.maxPool;
  let dropped = 0;
  state.targets = state.targets.filter((target) => {
    if (dropped >= overflow) return true;
    if (target.lastSeenLiveAt || target.boxEvents) return true;
    if (target.source !== 'discovery' && target.source !== 'board') return true;
    dropped += 1;
    return false;
  });
  return dropped;
}

// Bölge liderlik tabloları (tik.tools /webcast/leaderboard): her bölge ~100
// yayıncı döndürüyor. Anahtar yoksa atlanır — o zaman keşif 10'luk listede kalır.
// Anahtar: TIKTOOLS_KEY ortam değişkeni (veya panelden girilen anahtar).
const REGION_BOARDS = [
  'TR', 'US+', 'DE+', 'BR', 'JP', 'KR', 'TW', 'ID', 'MY', 'PH', 'AZ', 'KZ',
  'BY', 'UA', 'TH', 'VN', 'ES+', 'HU+', 'PT+', 'FR+', 'BK', 'PL', 'UK+', 'IT+',
  'SE+', 'NL', 'RO', 'MENA', 'LATAM', 'CCA', 'AU+', 'CA'
];
function boardCountry(region) {
  return String(region || '').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
}

async function fetchBoardEntries(region, key) {
  const response = await fetch(
    'https://api.tik.tools/webcast/leaderboard?region=' + encodeURIComponent(region),
    {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!response.ok) throw new Error('http ' + response.status);
  const payload = await response.json();
  return Array.isArray(payload && payload.entries) ? payload.entries : [];
}

// Tablodan gelen yayıncıları havuza ekler (yayında olmasalar da listede kalır).
function addBoardTargets(region, entries) {
  const known = new Set(state.targets.map((target) => target.username));
  const fresh = [];
  entries.forEach((entry) => {
    const username = cleanUsername(entry && entry.uniqueId);
    if (!username || known.has(username)) return;
    known.add(username);
    fresh.push({
      username,
      country: boardCountry(region),
      source: 'board',
      roomId: '',
      roomIdAt: 0,
      addedAt: Date.now(),
      lastSeenLiveAt: 0
    });
  });
  if (!fresh.length) return 0;
  state.targets = fresh.concat(state.targets);
  state.discoveredTotal += fresh.length;
  trimPool();
  return fresh.length;
}

// Günde bir kez bütün bölge tabloları okunur (32 istek). Sonuç panele raporlanır:
// hangi bölgeden kaç yeni yayıncı geldi, hangileri hata verdi.
async function sweepRegionBoards(options) {
  const key = String(process.env.TIKTOOLS_KEY || '').trim();
  if (!key) return 0;
  if (state.regionSweepRunning) return 0;
  const lastAt = Number(state.regionSweep && state.regionSweep.at) || 0;
  if (lastAt && Date.now() - lastAt < CONFIG.sweepHours * 3600000) return 0;

  state.regionSweepRunning = true;
  const summary = { at: Date.now(), added: 0, regions: {}, failed: [] };
  try {
    for (let i = 0; i < REGION_BOARDS.length; i += 1) {
      const region = REGION_BOARDS[i];
      try {
        const entries = await fetchBoardEntries(region, key);
        const added = addBoardTargets(region, entries);
        summary.regions[region] = added;
        summary.added += added;
      } catch (error) {
        summary.failed.push(region);
        log('bölge tablosu hatası', region, error.message);
      }
      await sleep(400);
    }
  } finally {
    state.regionSweepRunning = false;
    state.regionSweep = summary;
  }

  if (!(options && options.dryRun)) {
    state.targetsDirty = true;
    saveTargets();
  }
  log('ülke taraması:', summary.added, 'yeni ·',
    REGION_BOARDS.length - summary.failed.length + '/' + REGION_BOARDS.length, 'bölge · havuz', state.targets.length);
  return summary.added;
}

async function discoverLive() {
  if (!CONFIG.discover) return 0;
  if (Date.now() - state.lastDiscover < CONFIG.discoverSec * 1000) return 0;
  state.lastDiscover = Date.now();

  try {
    // Uç 10 kanallık bir anlık görüntü veriyor: aynı saniyede atılan istekler
    // aynı listeyi döndürür, liste dakikalar içinde komple değişir. Bu yüzden
    // yeni yayıncı için isteği sık atmak gerekir, tek seferde çok atmayı değil.
    const channels = await fetchDiscoveryPage();
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
        roomIdAt: channel && channel.roomId ? Date.now() : 0,
        addedAt: Date.now(),
        lastSeenLiveAt: 0
      });
    });

    if (fresh.length) {
      state.targets = fresh.concat(state.targets);
      state.discoveredTotal += fresh.length;
      trimPool();
      saveTargets();
    }

    // Bölge tabloları: anahtar varsa günde bir kez tüm ülkelerden ~100 yayıncı.
    await sweepRegionBoards();

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
      if (channel && channel.roomId) {
        record.roomId = String(channel.roomId);
        record.roomIdAt = Date.now();
      }
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
    // Ağ hatası "yayında değil" demek değildir: durum bilinmiyor sayılır.
    return { unknown: true, reason: error.message };
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
  // Sandık/zarf/portal jeton alanı boş gelebiliyor (özellikle süper fan kutusu).
  // Kutu yine de gerçektir: allowZero olan olaylar 0 jetonla yazılır.
  if (!data.allowZero && coins < CONFIG.minCoins) return;
  const flatten = Math.floor(Date.now() / 1000);
  // Kutu kimliği varsa olay kimliği de sabittir: aynı kutu iki kez yazılmaz.
  const id = data.envelopeId
    ? username + '-env-' + data.envelopeId
    : username + '-' + flatten + '-' + Math.random().toString(36).slice(2, 7);
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
    // TikTok'un bildirdiği açılış anı (ms). Yoksa hesaplanmaz.
    unpackAt: Math.max(0, Math.round(Number(data.unpackAt) || 0)),
    // Gerçek bir pencere bildirildi mi? Panel buna göre otomatik düşürür.
    hasWindow: Math.max(0, Math.round(Number(data.availableAt) || 0)) > 0,
    availableAt: Math.max(0, Math.round(Number(data.availableAt) || 0)) ||
      Date.now() + Math.max(0, Math.round(Number(data.durationSec) || 0)) * 1000,
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
  // Kutu anında hızlı dosyaya yazılır: commit beklemeden panel görebilsin.
  writeBoxes();
  publishBox(event);
}

// Anlık yayın (ntfy.sh): panel SSE ile dinler, kutu saniyeler içinde düşer.
// Git commit/CDN gecikmesi (dakikalar) böylece aşılır. Hata olursa sessiz geçilir.
function publishBox(event) {
  if (!CONFIG.ntfy || typeof fetch !== 'function') return;
  const payload = {
    key: CONFIG.ntfyKey,
    id: event.id,
    t: event.t,
    username: event.username,
    kind: event.kind,
    coins: event.coins,
    boxName: event.boxName || event.giftName || '',
    businessType: event.businessType || 0,
    boxType: event.boxType || '',
    shared: event.shared || 0,
    durationSec: event.durationSec || 0,
    unpackAt: event.unpackAt || 0,
    availableAt: event.availableAt || 0,
    hasWindow: Boolean(event.hasWindow)
  };
  fetch('https://ntfy.sh/' + encodeURIComponent(CONFIG.ntfyTopic), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000)
  }).catch(() => { /* yayın başarısız: dosya yolu yine var */ });
}

// Panelin hızlı okuduğu kutu listesi (son 120 kutu, en yeni önce).
function writeBoxes() {
  const boxes = state.events.slice(0, 120).map((event) => ({
    id: event.id,
    t: event.t,
    username: event.username,
    kind: event.kind,
    coins: event.coins,
    boxName: event.boxName || event.giftName || '',
    businessType: event.businessType || 0,
    boxType: event.boxType || '',
    shared: event.shared || 0,
    durationSec: event.durationSec || 0,
    unpackAt: event.unpackAt || 0,
    availableAt: event.availableAt || 0,
    hasWindow: Boolean(event.hasWindow)
  }));
  const body = {
    scannedAt: new Date().toISOString(),
    runId: startedAtMs,
    boxes
  };
  // scannedAt her yazımda değişiyor; commit'i ona değil kutu listesine bağlıyoruz,
  // yoksa dosya hiç değişmese de "kirli" görünüp boş commit attırıyordu.
  const sig = boxes.map((box) => box.id + ':' + Number(box.coins || 0)).join('|');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOX_FILE, JSON.stringify(body, null, 1) + '\n');
    if (sig !== state.boxesSig) {
      state.boxesSig = sig;
      if (boxes.length) state.boxesDirty = true;
    }
  } catch (error) {
    log('kutu dosyası yazılamadı:', error.message);
  }
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
  if (/envelope|zarf|letter|portal|superfanbox/i.test(event)) {
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
  if (!record) return;
  record.liveUnknown = false;
  if (!record.live) return;
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

  state.probe.ratio = Math.min(0.6, Math.max(0.2, state.probe.ratio));

  // Karar geçmişi: panel "neden değişti" sorusunu buradan yanıtlar.
  state.probeHistory.push({
    at: Date.now(),
    from: Math.round(before * 100),
    to: Math.round(state.probe.ratio * 100),
    probeRate: Math.round(pRate * 100),
    hotRate: hRate === null ? null : Math.round(hRate * 100),
    sessions: pSessions,
    boxSessions: pBox
  });
  // 7 günden eski kararlar düşer, en fazla 40 kayıt tutulur (24 saat için fazlasıyla yeter).
  const keepAfter = Date.now() - 7 * 86400000;
  state.probeHistory = state.probeHistory
    .filter((item) => Number(item && item.at) >= keepAfter)
    .slice(-40);

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
  const reasonKey = reason || 'bilinmiyor';
  state.closeReasons[reasonKey] = (Number(state.closeReasons[reasonKey]) || 0) + 1;

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

  // Hiç mesaj gelmeyen oturum: oda kimliği bayat olabilir (yanlış/bitmiş oda).
  // İki boş oturumdan sonra kimlik silinir, keşifte yenisi yazılır.
  if (watcher.kind === 'connector') {
    const watchedTarget = targetFor(username);
    if (watchedTarget && watchedTarget.roomId) {
      if (Number(watcher.messages) === 0) {
        watchedTarget.roomIdMiss = (Number(watchedTarget.roomIdMiss) || 0) + 1;
        if (watchedTarget.roomIdMiss >= 2) {
          const record = state.streamers.get(username);
          watchedTarget.roomId = '';
          watchedTarget.roomIdAt = 0;
          watchedTarget.roomIdMiss = 0;
          if (record) { record.roomId = ''; record.roomIdAt = 0; }
          log('oda kimliği bayat:', username, '— keşifte yenisi yazılacak');
        }
      } else if (watchedTarget.roomIdMiss) {
        watchedTarget.roomIdMiss = 0;
      }
      state.targetsDirty = true;
    }
  }

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

// Kutunun gerçek zamanı: TikTok mesajı açılış anını (unpackAt) ve paylaşım
// anını (createAt) saniye olarak taşır. Bunlar yoksa secondsUntilOpen gibi
// alanlara bakılır; hiçbiri yoksa süre uydurulmaz (0 kalır).
function boxTiming(info, box, now) {
  const seconds = (value) => {
    const num = Number(value) || 0;
    if (num > 1e12) return Math.round(num / 1000);
    return num > 1e9 ? Math.round(num) : 0;
  };
  const unpackAt = seconds(info.unpackAt || box.unpackAt);
  const createAt = seconds(info.createAt || box.createAt);
  const openIn = Number(info.secondsUntilOpen) || 0;
  let endMs = 0;
  if (unpackAt) endMs = unpackAt * 1000;
  else if (openIn > 0) endMs = now + openIn * 1000;

  let durationSec = 0;
  if (endMs) {
    const startMs = createAt ? createAt * 1000 : Math.min(now, endMs);
    durationSec = Math.max(0, Math.round((endMs - startMs) / 1000));
  }
  return { endMs, durationSec, unpackAt: endMs || 0 };
}

// Kutu jetonu yalnızca kutu nesnelerinin bilinen alanlarından okunur. Kök mesaja
// (data) bakılmaz: oradaki bir "coins" alanı kutuya ait olmayabilir. Hiçbiri
// yoksa 0 döner, panel "bilinmiyor" yazar — değer uydurulmaz.
const BOX_COIN_FIELDS = ['diamondCount', 'coinCount', 'coins'];
const MAX_BOX_COINS = 50000000;
function boxCoins(info, box) {
  for (const source of [info, box]) {
    if (!source || typeof source !== 'object') continue;
    for (const field of BOX_COIN_FIELDS) {
      const value = Number(source[field]);
      if (Number.isInteger(value) && value > 0 && value <= MAX_BOX_COINS) return { coins: value, field };
    }
  }
  return { coins: 0, field: '' };
}

function handleEnvelope(username, eventName, data) {
  const info = (data && (data.envelopeInfo || data)) || {};
  const box = (data && data.treasureBoxData) || info.treasureBoxData || {};

  state.envelopeStats.seen += 1;

  // Bağlayıcı aynı kutuyu hem `envelope` hem `superFanBox` olayıyla bildiriyor.
  // Kimlik yoksa tekilleştirme yapılmaz (uydurma kimlik üretilmez).
  const envelopeId = String(info.envelopeId || '').trim();
  if (envelopeId) {
    const key = envelopeId + '|' + (Number(info.businessType) || 0);
    if (state.envelopeSeen.has(key)) {
      state.envelopeStats.duplicate += 1;
      return;
    }
    state.envelopeSeen.add(key);
    if (state.envelopeSeen.size > 3000) state.envelopeSeen.clear();
  }

  const act = String(info.action || 'yok');
  const boxType = String(info.boxType || info.displayKey || 'yok');
  state.envelopeStats.actions[act] = (state.envelopeStats.actions[act] || 0) + 1;
  state.envelopeStats.boxTypes[boxType] = (state.envelopeStats.boxTypes[boxType] || 0) + 1;

  const picked = boxCoins(info, box);
  const coins = picked.coins;
  const people = Number(info.peopleCount || info.recipientCount || box.canOpen) || 0;
  const nowMs = Date.now();
  const timing = boxTiming(info, box, nowMs);
  const openIn = timing.durationSec;
  if (coins > 0 || people > 0) state.envelopeStats.withCoins += 1;

  state.envelopeSamples.push({
    t: nowMs, user: username, event: eventName, action: act, boxType,
    businessType: info.businessType || 0, coins, people, coinsField: picked.field,
    secondsUntilOpen: openIn, unpackAt: timing.unpackAt,
    // Teşhis: gelen kutuda hangi alanlar var? Süre alanı adı değişirse buradan görülür.
    keys: Object.keys(info).slice(0, 14)
  });
  if (state.envelopeSamples.length > 5) state.envelopeSamples.shift();

  // TikTok'un bildirdiği kutu türleri. Jeton alanı boş gelse bile kutu gerçektir
  // (süper fan kutusu 0 jeton / 0 kişi bildiriyor): bunlar yazılır.
  const bt = Number(info.businessType) || 0;
  const knownBox = bt === 1 || bt === 4 || bt === 9 || bt === 19 || bt === 20 || bt === 21;
  // İçi boş bildirim (tür de yok, jeton da yok) fırsat değildir.
  if (coins <= 0 && people <= 0 && !knownBox) {
    state.envelopeStats.skipped += 1;
    return;
  }

  const kind = envelopeKind(eventName, info);
  const name = envelopeName(kind, info);
  countBoxHour(Date.now());
  const boxRecord = state.streamers.get(username);
  if (boxRecord) boxRecord.boxes = (Number(boxRecord.boxes) || 0) + 1;
  // Kutu veren yayıncı havuzda işaretlenir: sonraki koşularda da önce o dinlenir.
  // Oturum bazında kutu sayısı: keşif oranı bu sonuçlara göre ayarlanır.
  const sessionWatcher = state.rooms.get(username);
  if (sessionWatcher) sessionWatcher.boxes = (Number(sessionWatcher.boxes) || 0) + 1;

  const boxTarget = targetFor(username);
  if (boxTarget) {
    boxTarget.boxEvents = (Number(boxTarget.boxEvents) || 0) + 1;
    // Ortalama jeton: yalnızca jetonu TikTok'un bildirdiği kutular sayılır,
    // "bilinmiyor" (0) ortalamayı aşağı çekmesin.
    if (coins > 0) {
      boxTarget.boxCoinSum = (Number(boxTarget.boxCoinSum) || 0) + coins;
      boxTarget.boxCoinsSeen = (Number(boxTarget.boxCoinsSeen) || 0) + 1;
    }
    boxTarget.lastBoxAt = Date.now();
    state.targetsDirty = true;
  }
  state.envelopeStats.recorded += 1;
  recordEvent(username, {
    kind,
    coins,
    // Kutu: jeton bildirilmemişse 0 ile yazılır, panel "bilinmiyor" der.
    allowZero: true,
    envelopeId,
    shared: people,
    // Açılış anı ve pencere süresi TikTok'un kendi mesajından gelir.
    durationSec: timing.durationSec,
    availableAt: timing.endMs,
    unpackAt: timing.unpackAt,
    giftName: name,
    boxName: name,
    businessType: Number(info.businessType) || 0,
    boxType: boxType === 'yok' ? '' : boxType,
    sender: info.sendUserName || '',
    senderName: info.sendUserName || info.senderName || ''
  });
}

// Kutu yakalamayı saatlik sayaca yazar; 48 saatten eski kovalar silinir.
function countBoxHour(now) {
  const hour = Math.floor(now / 3600000);
  state.boxHourly[hour] = (Number(state.boxHourly[hour]) || 0) + 1;
  const keepFrom = hour - 48;
  Object.keys(state.boxHourly).forEach((key) => {
    if ((Number(key) || 0) < keepFrom) delete state.boxHourly[key];
  });
  state.targetsDirty = true;
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

// TikTok canlı sayfasından oda kimliğini kendimiz kazırız. Bağlayıcı (connector)
// da aynı şeyi yapar, ama bu IP'lerde sık sık boş dönüyor; bizim kazıma daha
// güvenilir (UA + SIGI_STATE). Kimlik 6 saat geçerli kabul edilir.
async function scrapeRoomId(username) {
  const url = 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live';
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return '';
    html = await res.text();
  } catch (error) {
    return '';
  }
  // 1) SIGI_STATE JSON içinden.
  const sigi = html.match(/<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/s);
  if (sigi && sigi[1]) {
    try {
      const parsed = JSON.parse(sigi[1]);
      const roomId = parsed && parsed.LiveRoom && parsed.LiveRoom.liveRoomUserInfo && parsed.LiveRoom.liveRoomUserInfo.roomId;
      if (roomId) return String(roomId);
    } catch (error) { /* fall through */ }
  }
  // 2) Yedek: universal data.
  const uni = html.match(/"roomId"\s*:\s*"(\d+)"/);
  if (uni && uni[1]) return uni[1];
  // Canlı değilse oda kimliği yok.
  if (!/"status"\s*:\s*4/.test(html) && !html.includes('LIVE')) return '';
  return '';
}

// Canlı sayfayı bir kez okuyup "yayında mı + taze oda kimliği" çıkarır.
// TikTok'un api-live ucu bu IP'lerde 200 + boş gövde döndürdüğü için tek
// güvenilir kaynak sayfa; bağlanmadan önce buradan doğrulanır.
// known=false → sayfa okunamadı (karar verilmez, bilinmiyor sayılır).
async function scrapeLiveInfo(username) {
  const url = 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live';
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return { known: false, live: false, roomId: '', status: res.status };
    html = await res.text();
  } catch (error) {
    return { known: false, live: false, roomId: '', status: 0 };
  }

  // 1) SIGI_STATE: yayındaysa LiveRoom.liveRoomUserInfo dolu gelir.
  const sigi = html.match(/<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/s);
  if (sigi && sigi[1]) {
    try {
      const parsed = JSON.parse(sigi[1]);
      const info = parsed && parsed.LiveRoom && parsed.LiveRoom.liveRoomUserInfo;
      if (info && info.roomId) {
        return {
          known: true,
          live: true,
          roomId: String(info.roomId),
          title: String(info.title || ''),
          viewers: Number(info.stats && info.stats.totalUser) || 0
        };
      }
      // Sayfa okundu, canlı oda bilgisi yok: yayın kapalı.
      return { known: true, live: false, roomId: '' };
    } catch (error) { /* JSON bozuksa aşağıdaki yedeklere geç */ }
  }

  // 2) Yedek: sayfada roomId geçiyorsa yayın vardır.
  const embed = (html.match(/"roomId"\s*:\s*"(\d{6,})"/) || [])[1];
  if (embed) return { known: true, live: true, roomId: embed };

  // SIGI_STATE var ama oda yok → yayın kapalı. Hiçbiri yoksa doğrulanamadı
  // (captcha/boş sayfa): yayın durumu değiştirilmez.
  if (/id="SIGI_STATE"/.test(html) || /__UNIVERSAL_DATA_FOR_REHYDRATION__/.test(html)) {
    return { known: true, live: false, roomId: '' };
  }
  return { known: false, live: false, roomId: '' };
}

// Taze oda kimliğini hem hedefe hem kayda yazar; sonraki bağlantılar doğrudan
// bu kimlikle açılır (oda kimliği aramanın kendisi sınır yiyor).
function storeRoomId(username, roomId) {
  const now = Date.now();
  const target = targetFor(username);
  if (target) {
    target.roomId = String(roomId);
    target.roomIdAt = now;
    target.roomIdMiss = 0;
    state.targetsDirty = true;
  }
  const record = state.streamers.get(username);
  if (record) {
    record.roomId = String(roomId);
    record.roomIdAt = now;
  }
}

async function openConnectorWatcher(username, sessionSec) {
  const lib = loadConnector();
  if (!lib || !lib.TikTokLiveConnection) throw new Error('tiktok-live-connector yok');

  // Keşiften gelen oda kimliği: TikTok'un "oda kimliği" ucu bu IP'lerde boş
  // dönüyor, bu yüzden bağlantı "Room ID from all sources" hatasıyla düşüyordu.
  // Taze kimlikle doğrudan bağlanılır. Eski kimlik yanlış odaya bağlanabildiği
  // için yalnızca son 45 dakikada doğrulanmış kimlik kullanılır.
  const targetInfo = targetFor(username) || {};
  const recordInfo = state.streamers.get(username) || {};
  const rawRoomId = String(targetInfo.roomId || recordInfo.roomId || '').trim();
  const roomIdAt = Number(targetInfo.roomIdAt || recordInfo.roomIdAt || 0);

  // 1) Keşiften gelen TAZE oda kimliği varsa doğrudan bağlanılır. Keşif ucu
  //    (tik.tools top-channels) yalnızca yayındaki odaları taze kimlikleriyle
  //    veriyor; bu yüzden sayfa/API doğrulamasına gerek yok — o yollar bulut
  //    IP'lerinde zaten kapalı dönüyor.
  const freshRoomId = rawRoomId && roomIdAt && (Date.now() - roomIdAt < CONFIG.roomIdFreshMs)
    ? rawRoomId
    : '';
  let knownRoomId = freshRoomId;

  // 2) Kimlik yoksa/eskimişse sayfadan doğrula: yayın kapalıysa hiç bağlanmayız,
  //    böylece günlük bağlantı kotası ölü odalara yanmaz.
  if (!knownRoomId) {
    const page = await scrapeLiveInfo(username);
    if (!page.known) {
      // Sayfa okunamadı (captcha/boş yanıt): oda kimliği yok, bağlayıcının kendi
      // kazıması da bu IP'lerde hep boş dönüyor — denemek kotayı boşa yakıyordu.
      throw new Error('sayfa doğrulanamadı' + (page.status ? ' (HTTP ' + page.status + ')' : ''));
    }
    if (!page.live) {
      const offlineError = new Error('sayfada canlı oda yok');
      offlineError.offline = true;
      throw offlineError;
    }
    knownRoomId = page.roomId || '';
    if (knownRoomId) storeRoomId(username, knownRoomId);
  }

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
  // Sohbet/üye/beğeni yalnızca "oda gerçekten akıyor mu" sayacını besler.
  connection.on('chat', bump);
  connection.on('member', bump);
  connection.on('like', bump);
  connection.on('envelope', (data) => { bump(); handleEnvelope(username, 'envelope', data); });
  connection.on('superFanBox', (data) => { bump(); handleEnvelope(username, 'superFanBox', data); });
  connection.on('roomUser', (data) => {
    const record = state.streamers.get(username);
    if (record && data && data.viewerCount) record.viewers = Number(data.viewerCount) || record.viewers;
  });
  connection.on('streamEnd', () => { markOffline(username); closeWatcher(username, 'yayın bitti'); });
  connection.on('disconnected', () => {
    state.rooms.delete(username);
    state.closeReasons['bağlantı düştü'] = (Number(state.closeReasons['bağlantı düştü']) || 0) + 1;
  });
  connection.on('error', (error) => { state.lastError = username + ': ' + ((error && error.message) || 'bağlantı hatası'); });

  await connection.connect(knownRoomId || undefined);

  const liveRecord = state.streamers.get(username);
  if (liveRecord && connection.roomId) liveRecord.roomId = String(connection.roomId);

  armWatcherTimer(watcher);
  log('dinleniyor', username);
}

async function openWatcher(username, sessionSec) {
  if (CONFIG.connector) {
    try {
      await openConnectorWatcher(username, sessionSec);
      return;
    } catch (error) {
      if (isOfflineError(error)) {
        // Oda listesi bayat: yayın bitmiş. Havuzda "yayında değil" işaretlenir,
        // böylece aynı oda tekrar tekrar seçilmez ve ceza sayılmaz.
        error.offline = true;
        markOffline(username);
        closeWatcher(username, 'yayın bitti');
        throw error;
      }
      noteConnect(username, 'connector', error);
      log('bağlayıcı hatası', username, error.message);
      closeWatcher(username, 'bağlanamadı');
      // Hız sınırı / cihaz engeli: yedek yol da 429 yer; bekle.
      if (/rate|too many|device_blocked|429|\b503\b/i.test(error.message || '')) {
        throw error;
      }
      // Yedek yol kapalıysa gerçek hata yukarı çıkar; TikTools'un 429'u
      // bağlayıcının gerçek hatasını gizlemesin.
      if (!CONFIG.tiktools) throw error;
    }
  }

  let token;
  try {
    token = await mintToken(username, Math.min(900, (sessionSec || CONFIG.watchSec) + 60));
  } catch (error) {
    noteConnect(username, 'tiktools', error);
    throw error;
  }
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

  armWatcherTimer(watcher);
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

// Yayıncının kutu geçmişinden güvenilirlik skoru (0-100).
// Üç ölçüt ve ağırlıkları:
//   • kutu sayısı  (40): 1 kutu %28, 3 kutu %63, 6 kutu %86 — doygun artış,
//   • ortalama jeton (30): 100 jeton tam puan; jeton hiç bildirilmediyse
//     nötr %50 ("bilinmiyor" kötü sayılmaz),
//   • tazelik      (30): son kutudan geçen günle üstel düşer (3 günde ~%37).
// Hiç kutu görülmemişse skor 0'dır; çağıran taraf `boxes === 0` ise bunu
// "bilinmiyor" olarak gösterir.
function publisherScore(target, now = Date.now()) {
  const boxes = Number(target && target.boxEvents) || 0;
  const seen = Number(target && target.boxCoinsSeen) || 0;
  const sum = Number(target && target.boxCoinSum) || 0;
  const avgCoins = seen > 0 ? Math.round(sum / seen) : null;
  const lastBoxAt = Number(target && target.lastBoxAt) || 0;
  if (!boxes) return { score: 0, boxes: 0, avgCoins: null, lastBoxAt: 0 };
  const volume = 1 - Math.exp(-boxes / 3);
  const coins = avgCoins === null ? 0.5 : Math.min(1, avgCoins / 100);
  const days = lastBoxAt ? Math.max(0, (now - lastBoxAt) / 86400000) : Infinity;
  const fresh = Number.isFinite(days) ? Math.exp(-days / 3) : 0;
  const score = Math.round(volume * 40 + coins * 30 + fresh * 30);
  return {
    score: Math.max(0, Math.min(100, score)),
    boxes,
    avgCoins,
    lastBoxAt
  };
}

function scoreFor(username, now = Date.now()) {
  return publisherScore(targetFor(username), now);
}

// Skor yükseldikçe odaya dönüş aralığı kısalır: 100 puan aralığı yarıya indirir.
// Alt sınır 5 dakika (aynı odaya sürekli bağlanıp kotayı yakmamak için).
function returnGap(baseMs, score) {
  const factor = 1 - Math.max(0, Math.min(100, Number(score) || 0)) / 200;
  return Math.max(5 * 60000, Math.round(baseMs * factor));
}

function boxPriority(record, now) {
  const info = scoreFor(record.username, now);
  const recentBox = info.lastBoxAt && (now - info.lastBoxAt < CONFIG.hotWindowMs);
  return info.score + (recentBox ? 10 : 0);
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

// Bağlanılamayan odaya tekrar deneme zamanı üstel artar (10 dk → 20 → 40 → 60).
// Aynı ölü odaya arka arkaya bağlanmak TikTok'un günlük kotasını yakıyordu.
function penalizeRoom(username) {
  const count = Math.min(6, (state.failCounts.get(username) || 0) + 1);
  state.failCounts.set(username, count);
  const waitMs = Math.min(60 * 60000, CONFIG.failBackoffSec * 1000 * Math.pow(2, count - 1));
  state.failUntil.set(username, Date.now() + waitMs);
  return waitMs;
}

function clearPenalty(username) {
  state.failCounts.delete(username);
  state.failUntil.delete(username);
}

// Sıradaki odayı seçer (ağa çıkmaz, saf fonksiyon → test edilebilir).
function pickRoom(options) {
  const {
    live, rooms, probing, probeBudget, recent, now,
    hotRevisitMs, revisitMs, isHot, watchedAt
  } = options;
  // Aralık sayı ya da odaya göre hesaplayan fonksiyon olabilir: güvenilirlik
  // skoru yüksek odaya daha erken dönülür.
  const gap = (value, record) => (typeof value === 'function' ? value(record) : value);

  const free = live.filter((record) =>
    !rooms.has(record.username) && now - watchedAt(record) >= 60000);
  if (!free.length) return null;

  // Hiç dinlenmemiş adaylar: keşifte yeni bulunan, sıcak listede olmayanlar.
  const untouched = free.filter((record) => !watchedAt(record));
  const probeRoom = probing < probeBudget ? untouched[0] : null;

  const hotRoom = free.find((record) =>
    isHot(record, now) && now - watchedAt(record) >= gap(hotRevisitMs, record));
  const coldRoom = free.find((record) =>
    now - watchedAt(record) >= gap(revisitMs, record));
  const fallback = free.find((record) => !recent.includes(record.username)) || free[0];

  const record = probeRoom || hotRoom || coldRoom || fallback;
  if (!record) return null;
  return { record, probe: record === probeRoom, hot: isHot(record, now) };
}

const HOUR_MS = 3600000;

// Saatlik bağlantı bütçesi: son 60 dakikadaki denemeler ve kalan hak.
// Yürürlükteki sınır, yapılandırılan ile hız sınırından öğrenilenin küçüğüdür;
// öğrenilen daha büyükse (ya da hiç yoksa) yapılandırılan geçerlidir.
// Aralık "kalan hak / pencere sonuna kalan süre"dir: bütçe saat boyunca yayılır
// ve TikTok'un hourly kotasına çarpılmadan yavaşlanır. Hak 0 ise `nextAttemptAt`
// en eski denemenin pencereden çıkacağı an, tek hak kaldıysa `gapMs` pencerenin
// sonudur; ikisi de kendiliğinden devam eder.
function connectBudget(now = Date.now()) {
  state.hourStarts = state.hourStarts.filter((at) => at > now - HOUR_MS);
  const used = state.hourStarts.length;
  const configured = CONFIG.hourBudget;
  const learned = state.hourBudgetLearned || 0;
  const limit = Math.min(configured, learned || configured);
  const remaining = Math.max(0, limit - used);
  const oldest = state.hourStarts[0] || now;
  const windowLeft = Math.max(0, oldest + HOUR_MS - now);
  return {
    used,
    limit,
    remaining,
    learned,
    configured,
    // Kalan haklar pencere sonuna kadar yayılır; taban aralık korunur.
    gapMs: remaining > 0 ? Math.max(CONFIG.connectGapMs, Math.ceil(windowLeft / remaining)) : 0,
    // Hak yoksa en eski deneme saatten çıkınca yeni hak doğar; varsa bekleme yok.
    nextAttemptAt: remaining > 0 ? 0 : oldest + HOUR_MS
  };
}

// Hız sınırına çarptığımız nokta gerçek üst sınırdır: bütçeyi oraya çek.
// Yalnızca daha düşük bir sınır öğrenilirse güncellenir; daha yükseği yok sayılır.
function learnHourBudget() {
  const used = connectBudget().used;
  if (state.hourBudgetLearned && used >= state.hourBudgetLearned) return;
  state.hourBudgetLearned = Math.max(1, used);
  log('saatlik bağlantı bütçesi öğrenildi:', state.hourBudgetLearned,
    '— bundan sonra bu sınırın altında kalınacak');
}

async function maintainWatchers() {
  if (!CONFIG.watch) return;

  const now = Date.now();
  if (state.connectorCooldownUntil > now) return;
  const plan = connectBudget(now);
  if (plan.remaining === 0) return;
  if (now - state.lastConnectAt < plan.gapMs) return;

  for (const [username, watcher] of Array.from(state.rooms.entries())) {
    const limit = (watcher.sessionSec || CONFIG.watchSec) * 1000;
    if (now - watcher.startedAt >= limit) await closeWatcher(username, 'süre doldu');
  }

  // Önce kutu vermiş odalar, sonra izleyici sayısı, sonra toplanan jeton.
  // "Canlı" (api-live doğruladı) ya da "olabilir" (api-live boş döndü) odalar adaydır.
  // Olabilir odada taze oda kimliği yoksa bağlanmak boşa kota harcar: kimliği
  // keşif ucundan gelen (yani gerçekten yayında olan) odalar önceliklidir.
  const hasFreshRoomId = (record) => Boolean(record.roomId) && Number(record.roomIdAt) &&
    now - Number(record.roomIdAt) < CONFIG.roomIdFreshMs;
  const candidateFilter = (strict) => (record) => {
    if (!record.live && !record.liveUnknown) return false;
    // Kimlik yoksa bağlanmak boşa: sayfa/API doğrulaması bu IP'lerde
    // "sayfada canlı oda yok" diyor ve her deneme kota harcıyor.
    if (!record.roomId) return false;
    if (!strict) return true;
    return hasFreshRoomId(record);
  };
  // Bağlanılamayan oda bir süre listeye alınmaz (boşa kota harcanmasın).
  const allowed = (record) => (state.failUntil.get(record.username) || 0) <= now;
  let live = Array.from(state.streamers.values())
    .filter(candidateFilter(CONFIG.roomIdOnly))
    .filter(allowed);
  // Keşif ucu susarsa (429/ağ) hiç aday kalmıyordu: o durumda süzgeç gevşetilir.
  // Boşa bağlantı riski, hiç dinlememekten iyidir.
  if (live.length < CONFIG.minRooms) {
    const relaxed = Array.from(state.streamers.values())
      .filter(candidateFilter(false))
      .filter(allowed);
    if (relaxed.length > live.length) {
      log('taze oda kimliği azaldı (' + live.length + ') → doğrulanamayan odalar da aday');
      live = relaxed;
    }
  }
  live = live
    .sort((a, b) =>
      // Kesin canlı olanlar önce denenir.
      (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
      boxPriority(b, now) - boxPriority(a, now) ||
      // Oda kimliği bilinen oda bağlanabiliyor: onu öne al.
      (b.roomId ? 1 : 0) - (a.roomId ? 1 : 0) ||
      (Number(b.viewers) || 0) - (Number(a.viewers) || 0) ||
      (Number(b.coins) || 0) - (Number(a.coins) || 0));

  if (!state.roomBudget) state.roomBudget = CONFIG.watchRooms;
  const target = Math.min(Math.max(CONFIG.minRooms, Math.round(state.roomBudget)),
    CONFIG.watchRooms, live.length);

  // Oran artık sabit değil: kutu başarısına göre uyarlanır (probe-ratio başlangıç).
  const probeBudget = Math.max(1, Math.round(target * state.probe.ratio));

  let tries = 0;
  // Dolum için bu çağrıya ayrılan süre: 4 sn arayı beklemek yerine turu bitirmek,
  // 32 odaya çıkmayı 48 dakikaya yayıyordu (oturum 10 dk olduğu için kapasite
  // hep düşük kalıyordu). Artık arada beklenir, ısrarla doldurulur.
  const fillDeadline = Date.now() + 110000;
  while (state.rooms.size < target && Date.now() < fillDeadline) {
    const step = connectBudget();
    if (step.remaining === 0) break;
    const gapLeft = step.gapMs - (Date.now() - state.lastConnectAt);
    if (gapLeft > 0) {
      await sleep(Math.min(gapLeft, 2000));
      continue;
    }
    if (state.connectorCooldownUntil > Date.now()) break;

    // Dakikalık bağlantı sayacı: sınırı aşarsak (Euler "too many connections
    // started") yeni bağlantı açmadan bekle, sınırı kendi kendimize aşmayalım.
    const minuteAgo = Date.now() - 60000;
    state.connectStarts = state.connectStarts.filter((at) => at > minuteAgo);
    if (state.connectStarts.length >= CONFIG.startsPerMin) {
      await sleep(2000);
      continue;
    }

    const probing = Array.from(state.rooms.values()).filter((watcher) => watcher.probe).length;
    const pick = pickRoom({
      live, rooms: state.rooms, probing, probeBudget, recent: state.recent, now,
      // Dönüş aralığı güvenilirlik skoruna bağlı: skor 100 ise yarısı.
      hotRevisitMs: (record) =>
        returnGap(CONFIG.hotRevisitMs, scoreFor(record.username, now).score),
      revisitMs: (record) =>
        returnGap(CONFIG.revisitMs, scoreFor(record.username, now).score),
      isHot: isHotRoom, watchedAt: lastWatchedAt
    });
    if (!pick) break;

    const sessionSec = pick.probe
      ? CONFIG.probeSec
      : (pick.hot ? Math.round(CONFIG.watchSec * 1.5) : CONFIG.watchSec);

    state.recent.push(pick.record.username);
    if (state.recent.length > 200) state.recent.shift();

    state.connectStats.attempts += 1;
    state.connectStarts.push(Date.now());
    state.hourStarts.push(Date.now());
    try {
      await openWatcher(pick.record.username, sessionSec);
      state.lastConnectAt = Date.now();
      state.connectFailures = 0;
      state.connectStats.ok += 1;
      // Bağlantı kuruldu: oda gerçekten yayında. "Canlı" bilgisi tazelenir,
      // api-live doğrulayamasa da etiket doğru kalır.
      const liveRecord = state.streamers.get(pick.record.username);
      if (liveRecord) {
        liveRecord.live = true;
        liveRecord.liveUnknown = false;
        liveRecord.lastSeenLiveAt = Date.now();
        state.streamers.set(pick.record.username, liveRecord);
      }
      clearPenalty(pick.record.username);
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
      // Yayın bitmişse hata değil, bayat kayıt: sıradaki odaya geçilir.
      if (error.offline) {
        state.connectStats.offline += 1;
        penalizeRoom(pick.record.username);
        const index = live.indexOf(pick.record);
        if (index >= 0) live.splice(index, 1);
        tries += 1;
        if (tries >= 5) break;
        continue;
      }
      state.connectStats.failed += 1;
      if (!error.noted) noteConnect(pick.record.username, 'watcher', error);
      // Aynı tur içinde tekrar seçilmesin: listeden düşür, ceza bir sonraki turda geçerli.
      const failedIndex = live.indexOf(pick.record);
      if (failedIndex >= 0) live.splice(failedIndex, 1);
      const retryWaitMs = penalizeRoom(pick.record.username);
      log('dinleme hatası', pick.record.username, error.message,
        '→ ' + Math.round(retryWaitMs / 60000) + ' dk ara');
      // Bağlantı aralığı hatadan sonra da korunur: istek yağmuru olmasın.
      state.lastConnectAt = Date.now();
      tries += 1;
      // 429 / "token yok (429)" da hız sınırıdır: bütçeyi düşür, bekle.
      if (/rate|too many|device_blocked|429|\b503\b/i.test(error.message || '')) {
        state.connectFailures = Math.min(6, state.connectFailures + 1);
        state.connectStats.rateLimited += 1;
        learnHourBudget();
        // Koruma: kotayı yakmaya devam etmesin. Üçüncü hız sınırından sonra
        // dakikalık başlatma yarıya iner, bağlantı aralığı iki katına çıkar.
        if (state.connectStats.rateLimited > 2 && !state.tuningGuard) {
          state.tuningGuard = {
            at: Date.now(),
            fromStarts: CONFIG.startsPerMin,
            fromGap: CONFIG.connectGapMs
          };
          CONFIG.startsPerMin = Math.max(2, Math.floor(CONFIG.startsPerMin / 2));
          CONFIG.connectGapMs = Math.min(20000, CONFIG.connectGapMs * 2);
          log('koruma devrede: dakikalık başlatma', state.tuningGuard.fromStarts, '→',
            CONFIG.startsPerMin, '· bağlantı aralığı', state.tuningGuard.fromGap, '→',
            CONFIG.connectGapMs, 'ms (günlük kota koruması)');
        }
        // Günlük kota bittiyse kısa beklemelerle denemek boşuna: uzun ara verilir.
        const dailyLimit = /rate_limit_account_day|account_day/i.test(error.message || '');
        if (dailyLimit) state.connectStats.dayLimited = true;
        const waitMs = dailyLimit
          ? 3 * 3600000
          : Math.min(8 * 60000, 60000 * Math.pow(2, state.connectFailures - 1));
        state.connectorCooldownUntil = Date.now() + waitMs;
        state.roomBudget = Math.max(CONFIG.minRooms, Math.round(state.roomBudget * 0.75));
        log(dailyLimit ? 'günlük bağlantı sınırı doldu (TikTok): 3 saat yeni bağlantı yok'
          : 'hız sınırı: bütçe ' + Math.round(state.roomBudget) + ' oda · ' +
            Math.round(waitMs / 1000) + ' sn yeni bağlantı yok');
        break;
      }
      // Hız sınırı değilse sıradaki oda denenir: tek bozuk oda turu kilitlemesin.
      if (tries >= 3) break;
    }
  }
}

// ---------- 3) tarama turu ----------

async function pollTargets() {
  // Havuz büyükse hepsi her turda yoklanmaz: sırayla dilim dilim yoklanır.
  // 2400 adresi her 2 dakikada sorgulamak taramayı ağırlaştırıp dinlemeyi yavaşlatıyordu.
  const all = state.targets;
  let targets = all;
  if (CONFIG.pollBatch > 0 && all.length > CONFIG.pollBatch) {
    const start = (state.polls * CONFIG.pollBatch) % all.length;
    targets = [];
    for (let i = 0; i < CONFIG.pollBatch; i += 1) targets.push(all[(start + i) % all.length]);
  }
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
      // Doğrulanamadı: canlı/offline bilgisi değiştirilmez, ama "olabilir"
      // olarak işaretlenir. TikTok'un api-live ucu bulut IP'lerinde sürekli boş
      // dönüyor; bu işaret olmadan hiçbir oda dinlenmeye aday olmuyordu.
      record.reason = status.reason || 'doğrulanamadı';
      record.liveUnknown = true;
      state.streamers.set(username, record);
      return;
    }
    if (status.live) {
      liveCount += 1;
      // Daha önce taranmış ama yayında değilken yeniden canlıya geçen oda.
      if (seenBefore && !record.live) log('yeniden canlı:', username);
      record.live = true;
      record.liveUnknown = false;
      record.lastSeenLiveAt = Date.now();
      if (!target.lastSeenLiveAt) target.lastSeenLiveAt = Date.now();
      if (status.roomId) {
        record.roomId = String(status.roomId);
        record.roomIdAt = Date.now();
      }
      if (status.startTime) record.startTime = status.startTime;
      if (status.title) record.title = status.title;
      if (status.viewers) record.viewers = status.viewers;
      state.streamers.set(username, record);
    } else {
      record.liveUnknown = false;
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
  const nowMs = Date.now();
  const staleLiveMs = CONFIG.liveStaleSec * 1000;
  const streamers = Array.from(state.streamers.values())
    // Havuzdaki her adres yazılır: panel "taranmış ama yayında değil" ile
    // "hiç taranmamış" durumunu ayırabilsin, eski Canlı durumu takılı kalmasın.
    .filter((record) => record.checkedAt || record.live || record.startTime || record.coins)
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.coins || 0) - (a.coins || 0);
    })
    .map((record) => {
      // Yayıncının kutu geçmişinden güvenilirlik skoru (panelde ve seçimde).
      const info = scoreFor(record.username, nowMs);
      return {
        username: record.username,
        country: record.country || '',
        // "Canlı" etiketi yalnızca tazeyse ya da oda gerçekten dinleniyorsa verilir.
        // api-live bulut IP'lerinde boş döndüğü için eski kayıtlar yayında sanılıyordu.
        live: Boolean(record.live) && (state.rooms.has(record.username) ||
          nowMs - (Number(record.lastSeenLiveAt) || 0) < staleLiveMs),
        liveUnknown: Boolean(record.liveUnknown),
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
        lastBoxAt: info.lastBoxAt,
        // Kutu geçmişi: kaç kutu, ortalama jeton, güvenilirlik skoru (0-100).
        // Hiç kutu yoksa skor null yazılır: panel "0" ile "bilinmiyor"u ayırır.
        boxCount: info.boxes,
        avgCoins: info.avgCoins,
        score: info.boxes ? info.score : null
      };
    });

  return {
    scannedAt: new Date().toISOString(),
    scanner: {
      // Koşu kimliği: panel yeni koşuda Fırsatlar'ı sıfırdan başlatır.
      runId: startedAtMs,
      targetCount: state.targets.length,
      liveCount: streamers.filter((item) => item.live).length,
      // api-live doğrulayamadığı için "canlı mı?" bilinmeyen oda sayısı.
      liveUnknownCount: streamers.filter((item) => item.liveUnknown && !item.live).length,
      discovered: state.discoveredTotal,
      poolSize: state.targets.length,
      watching: state.rooms.size,
      // Kaç canlı odanın kimliği biliniyor: bağlantı başarısının anahtarı.
      liveWithRoomId: streamers.filter((item) => item.live && item.roomId).length,
      budget: Math.round(state.roomBudget) || CONFIG.watchRooms,
      freshLive: state.targets.filter((target) => !target.lastWatchedAt &&
        state.streamers.has(target.username) && state.streamers.get(target.username).live).length,
      probes: Array.from(state.rooms.values()).filter((watcher) => watcher.probe).length,
      probeRatio: Math.round(state.probe.ratio * 100) / 100,
      probeStats: {
        sessions: state.probe.sessions,
        withBox: state.probe.withBox
      },
      probeHistory: state.probeHistory,
      boxHourly: state.boxHourly,
      connectFailures: state.connectFailures,
      // Bağlantı teşhisi: kaç deneme, kaçı başarılı, son hatalar, soğuma.
      connectStats: {
        attempts: state.connectStats.attempts,
        ok: state.connectStats.ok,
        failed: state.connectStats.failed,
        rateLimited: state.connectStats.rateLimited,
        offline: state.connectStats.offline,
        // TikTok günlük bağlantı kotası bitti mi (panelde sebep olarak yazılır).
        dayLimited: Boolean(state.connectStats.dayLimited),
        errors: state.connectStats.errors.slice(-3)
      },
      lastConnectorError: state.lastConnectorError,
      // Saatlik bütçe: kaç bağlantı yapıldı, limit ne, sonraki ne zaman.
      connectBudget: connectBudget(),
      // Bağlanılamadığı için bir süre denenmeyecek oda sayısı (teşhis).
      backoffRooms: state.failUntil.size,
      // Hız sınırı koruması: devreye girdiyse yeni değerler.
      tuningGuard: state.tuningGuard
        ? {
          at: state.tuningGuard.at,
          fromStarts: state.tuningGuard.fromStarts,
          fromGap: state.tuningGuard.fromGap,
          startsPerMin: CONFIG.startsPerMin,
          connectGapMs: CONFIG.connectGapMs
        }
        : null,
      closeReasons: state.closeReasons,
      cooldownLeftSec: Math.max(0, Math.round((state.connectorCooldownUntil - Date.now()) / 1000)),
      polls: state.polls,
      minutesLeft: CONFIG.minutes > 0 ? Math.max(0, Math.round((deadline - Date.now()) / 60000)) : null,
      lastError: state.lastError,
      envelopes: state.envelopeStats,
      envelopeSamples: state.envelopeSamples,
      // Günlük ülke taraması raporu (panel Ayarlar kartında gösterir).
      regionSweep: {
        at: Number(state.regionSweep && state.regionSweep.at) || 0,
        added: Number(state.regionSweep && state.regionSweep.added) || 0,
        regions: (state.regionSweep && state.regionSweep.regions) || {},
        failed: (state.regionSweep && state.regionSweep.failed) || [],
        running: Boolean(state.regionSweepRunning)
      },
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

// Anlık bildirim ntfy üzerinden gidiyor; boxes.json sadece yedek yol. Bu yüzden
// kutular ayrı ve sık commit edilmez: yeni kutu varsa sıradaki veri commit'ine
// eklenir (varsayılan 5 dakika), yoksa dosya hiç commit edilmez.
function commitData() {
  if (!CONFIG.commitSec) return;
  const now = Date.now();
  if (now - state.lastCommit < CONFIG.commitSec * 1000) return;
  state.lastCommit = now;
  try {
    syncWithRemote();
    // targets.json de commit edilir: kutu geçmişi ve son izleme zamanı
    // koşu bitince kaybolmasın, sonraki koşu aynı odaları öncelikli dinlesin.
    const files = ['site/firsat/data/live.json', 'site/firsat/data/targets.json'];
    if (state.boxesDirty) files.push('site/firsat/data/boxes.json');
    git(['add'].concat(files));
    if (!git(['status', '--porcelain'].concat(files)).trim()) return;
    const summary = snapshot().scanner;
    git(['commit', '-m',
      'Canlı tarama: ' + summary.liveCount + '/' + summary.targetCount +
      ' yayında · ' + summary.watching + ' oda dinleniyor' +
      (state.boxesDirty ? ' · yeni kutular' : '')]);
    try {
      git(['push', '--quiet']);
    } catch (pushError) {
      syncWithRemote();
      git(['push', '--quiet']);
    }
    state.boxesDirty = false;
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
  writeBoxes();
  // Kayıtlı oran varsa ondan devam et; yoksa ayardaki başlangıç oranı.
  state.probe.ratio = state.savedRatio || CONFIG.probeRatio;
  log('havuz', state.targets.length, 'adres · süre',
    CONFIG.minutes > 0 ? CONFIG.minutes + ' dk' : 'tek tur');

  flush(true);

  // Dinleme dolumu ayrı döngüde çalışır: tarama turu uzun sürse bile odalar
  // kendiliğinden dolar, oturum bitince yerine hemen yenisi açılır.
  let watchLoop = true;
  const watchTask = CONFIG.watch ? (async () => {
    while (watchLoop && Date.now() < deadline) {
      try {
        // Keşif burada da çalışır: tarama turu 4 dakikada bir döndüğü için
        // keşif de 4 dakikaya sıkışıyordu, oysa yeni yayınlar her 30 saniyede
        // bulunabiliyor. Taze oda kimliği = gerçekten yayında olan aday.
        await discoverLive();
        await maintainWatchers();
      } catch (error) {
        state.lastError = error.message;
        log('dinleme turu hatası:', error.message);
      }
      // Veri commit'i burada da denenir: commit zamanı dolduğu an 3 saniyelik
      // turda yakalanır (240 saniyelik tarama turunu beklemez).
      commitData();
      await sleep(3000);
    }
  })() : null;

  do {
    try {
      await discoverLive();
      await pollTargets();
    } catch (error) {
      state.lastError = error.message;
      log('tur hatası:', error.message);
    }
    flush(true);
    commitData();
    if (CONFIG.once) break;
    await sleep(CONFIG.pollSec * 1000);
  } while (Date.now() < deadline);

  watchLoop = false;
  if (watchTask) await watchTask;

  await stopAllWatchers('kapanış');
  state.rooms.clear();
  flush(true);
  commitData();
  // Koşu sonu bilanço: "neden az oda dinlendi" sorusunun cevabı burada.
  log('bağlantı özeti',
    'deneme', state.connectStats.attempts,
    '· başarılı', state.connectStats.ok,
    '· hata', state.connectStats.failed,
    '· hız sınırı', state.connectStats.rateLimited,
    '· biten yayın', state.connectStats.offline);
  log('bitti');
}

// Kendi kendini sınama: ayrıştırıcının hangi paketleri yazıp hangilerini
// atladığını gerçek alan adlarıyla gösterir. Ağa çıkmaz.
if (process.env.SCANNER_SELFTEST === '1') {
  // Saatlik bütçe sınaması (ağa çıkmaz): boş, dolu, eşiğe yakın ve öğrenilen limit.
  (() => {
    const now = Date.now();
    const saved = {
      starts: state.hourStarts,
      learned: state.hourBudgetLearned,
      budget: CONFIG.hourBudget
    };
    CONFIG.hourBudget = 10;
    state.hourBudgetLearned = 0;
    state.hourStarts = [];
    const empty = connectBudget(now);
    state.hourStarts = Array.from({ length: 10 }, (_, index) => now - (10 - index) * 60000);
    const full = connectBudget(now);
    state.hourStarts = Array.from({ length: 8 }, () => now - 60000);
    const near = connectBudget(now);
    // Tek hak: aralık pencerenin sonuna (en eski deneme + 1 saat) kadar uzar.
    state.hourStarts = Array.from({ length: 9 }, () => now - 60000);
    const single = connectBudget(now);
    // Öğrenilen limit varsayılandan büyükse varsayılan geçerli kalır.
    state.hourStarts = Array.from({ length: 2 }, () => now - 60000);
    state.hourBudgetLearned = 50;
    const highLearned = connectBudget(now);
    state.hourStarts = Array.from({ length: 8 }, () => now - 60000);
    state.hourBudgetLearned = 5;
    const learned = connectBudget(now);
    const nextInMin = Math.round((full.nextAttemptAt - now) / 60000);
    console.log('BÜTÇE →', 'boş', empty.used + '/' + empty.limit,
      '· dolu', full.used + '/' + full.limit, 'sonraki', nextInMin, 'dk',
      '· eşik aralığı', Math.round(near.gapMs / 1000) + ' sn',
      '· öğrenilen limit', learned.limit,
      '· tek hak aralığı', Math.round(single.gapMs / 1000) + ' sn',
      '· öğrenilen>varsayılan', highLearned.limit);
    if (empty.used !== 0 || empty.remaining !== 10) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: boş bütçe');
      process.exitCode = 1;
    }
    if (full.used !== 10 || full.remaining !== 0 || nextInMin <= 0) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: dolu bütçe');
      process.exitCode = 1;
    }
    // Boş bütçede aralık = pencere / limit (burada 3600/10 = 360 sn):
    // yani haklar saat boyunca yayılır, başta hepsi harcanmaz.
    if (empty.gapMs !== 360000) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: boş bütçede aralık', empty.gapMs);
      process.exitCode = 1;
    }
    if (near.gapMs <= CONFIG.connectGapMs) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: eşikte aralık uzamadı');
      process.exitCode = 1;
    }
    if (learned.limit !== 5) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: öğrenilen limit uygulanmadı');
      process.exitCode = 1;
    }
    if (single.remaining !== 1 || single.nextAttemptAt !== 0 || single.gapMs !== 3540000) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: tek hakta aralık');
      process.exitCode = 1;
    }
    if (highLearned.limit !== 10 || highLearned.remaining !== 8) {
      console.log('BÜTÇE SINAMASI BAŞARISIZ: öğrenilen limit varsayılanı aştı');
      process.exitCode = 1;
    }
    state.hourStarts = saved.starts;
    state.hourBudgetLearned = saved.learned;
    CONFIG.hourBudget = saved.budget;
  })();

  // Güvenilirlik skoru sınaması: kutu sayısı + ortalama jeton + tazelik.
  (() => {
    const now = Date.now();
    const none = publisherScore(null, now);
    const fresh = publisherScore({
      boxEvents: 3, boxCoinSum: 300, boxCoinsSeen: 3, lastBoxAt: now - 60000
    }, now);
    const old = publisherScore({
      boxEvents: 3, boxCoinSum: 15, boxCoinsSeen: 3, lastBoxAt: now - 10 * 86400000
    }, now);
    const unknownCoins = publisherScore({
      boxEvents: 3, boxCoinSum: 0, boxCoinsSeen: 0, lastBoxAt: now - 60000
    }, now);
    const gap100 = returnGap(1800000, 100);
    const gapNone = returnGap(1800000, 0);
    console.log('GÜVEN →', 'kutusuz', none.score,
      '· taze/100 jeton', fresh.score, '(ort', fresh.avgCoins + ')',
      '· eski/5 jeton', old.score, '· jeton bilinmiyor', unknownCoins.score,
      '· dönüş aralığı', Math.round(gap100 / 60000) + '/' + Math.round(gapNone / 60000), 'dk');
    const checks = [
      ['kutusuz skor 0 değil', none.score === 0 && none.avgCoins === null],
      ['taze 3 kutu 80 altında (beklenen ~%85)', fresh.score >= 80 && fresh.score <= 90],
      ['eski/düşük jeton cezalı (45 altı)', old.score < 45],
      ['jeton bilinmiyorken nötr', unknownCoins.avgCoins === null &&
        unknownCoins.score > old.score && unknownCoins.score < fresh.score],
      ['yüksek skor dönüş aralığını kısaltıyor', gap100 === 900000 && gapNone === 1800000]
    ];
    checks.forEach(([label, ok]) => {
      if (!ok) {
        console.log('GÜVEN SINAMASI BAŞARISIZ:', label);
        process.exitCode = 1;
      }
    });
  })();

  const frames = [
    ['sıradan hediye (Rose)', { event: 'gift', data: { giftName: 'Rose', giftId: 5655, diamondCount: 1, repeatCount: 1, repeatEnd: true, msgId: 'a1' } }],
    ['sandık hediyesi', { event: 'gift', data: { giftName: 'Sandık', giftId: 9001, diamondCount: 500, repeatCount: 1, repeatEnd: true, msgId: 'a2' } }],
    ['sandık kutusu (businessType 20)', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e1', businessType: 20, diamondCount: 100, peopleCount: 25, secondsUntilOpen: 30 } } }],
    ['zarf kutusu (businessType 21)', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e4', businessType: 21, diamondCount: 50, peopleCount: 10 } } }],
    ['portal zinciri (businessType 9)', { event: 'envelope', data: { envelopeInfo: { envelopeId: 'e2', businessType: 9, diamondCount: 200, peopleCount: 50, secondsUntilOpen: 15 } } }],
    ['portal (gerçek açılış anı)', { event: 'envelope', data: { envelopeInfo: {
      envelopeId: 'e5', businessType: 9, diamondCount: 300, peopleCount: 40,
      createAt: String(Math.floor(Date.now() / 1000) - 20),
      unpackAt: Math.floor(Date.now() / 1000) + 70
    } } }],
    ['süper fan kutusu (businessType 19, jeton bildirilmemiş)', { event: 'superFanBox', data: { envelopeInfo: {
      envelopeId: 'e6', businessType: 19, diamondCount: 0, peopleCount: 0,
      createAt: String(Math.floor(Date.now() / 1000)), unpackAt: Math.floor(Date.now() / 1000) + 60
    } } }],
    ['aynı süper fan kutusu (envelope olayı, mükerrer)', { event: 'envelope', data: { envelopeInfo: {
      envelopeId: 'e6', businessType: 19, diamondCount: 0, peopleCount: 0,
      createAt: String(Math.floor(Date.now() / 1000)), unpackAt: Math.floor(Date.now() / 1000) + 60
    } } }],
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

  console.log('KARAR geçmişi →', state.probeHistory.map((item) =>
    item.from + '->' + item.to).join(' '));

  // Saatlik kutu sayacı: her kutu sayılır, 48 saatten eski kova atılır.
  state.boxHourly = {};
  state.boxHourly[Math.floor(Date.now() / 3600000) - 60] = 7;
  countBoxHour(Date.now());
  countBoxHour(Date.now());
  const nowHour = Math.floor(Date.now() / 3600000);
  console.log('KUTU saatlik →', Object.keys(state.boxHourly).length, 'kova ·',
    Number(state.boxHourly[nowHour]) || 0, '(beklenen 1 kova · 2)');

  // Panelin teşhis satırı bu alanlardan beslenir: eksikse "0 oda" sessiz kalır.
  const diag = snapshot().scanner;
  console.log('TEŞHİS →', ['connectStats', 'closeReasons', 'cooldownLeftSec', 'lastConnectorError']
    .map((key) => key + ':' + (key in diag ? 'var' : 'YOK')).join(' '),
    '· bağlantı alanları:',
    ['attempts', 'ok', 'failed', 'rateLimited', 'offline', 'errors']
      .map((key) => key + ':' + (key in (diag.connectStats || {}) ? 'var' : 'YOK')).join(' '));

  frames.forEach(([label, frame]) => {
    const before = state.events.length;
    handleStreamMessage('test_user', JSON.stringify(frame));
    const added = state.events.length > before ? state.events[0] : null;
    const opensIn = added && added.unpackAt ? Math.round((added.unpackAt - Date.now()) / 1000) : null;
    console.log(added
      ? `YAZDI  ${label} → ${added.kind} ${added.coins} jeton · ${added.shared} kişi · ${added.durationSec} sn` +
        (opensIn === null ? ' · açılış anı yok' : ` · ${opensIn} sn sonra açılır`) +
        ` · kutu: ${added.boxName || '-'} (tür ${added.businessType || 0})`
      : `ATLADI ${label}`);
  });

  // Günlük ülke taraması: sahte yanıtla, ağa ve diske dokunmadan denenir.
  (async () => {
    const realFetch = global.fetch;
    const realKey = process.env.TIKTOOLS_KEY;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          entries: [{ uniqueId: 'sweep_' + calls + '_a' }, { uniqueId: 'sweep_' + calls + '_b' }]
        })
      };
    };
    process.env.TIKTOOLS_KEY = 'test-key';
    state.targets = [];
    state.regionSweep = { at: 0, added: 0, regions: {}, failed: [] };
    const added = await sweepRegionBoards({ dryRun: true });
    // İkinci çağrı 24 saat dolmadığı için hemen dönmeli.
    const again = await sweepRegionBoards({ dryRun: true });
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.TIKTOOLS_KEY;
    else process.env.TIKTOOLS_KEY = realKey;
    console.log('ÜLKE TARAMASI →', added, 'yeni ·', Object.keys(state.regionSweep.regions).length,
      'bölge ·', calls, 'istek · ikinci çağrı', again, '(beklenen 24 saat içinde 0)');
    process.exit(0);
  })();
}

// Sınama modunda ağa çıkılmaz: ana döngü hiç başlamaz.
if (process.env.SCANNER_SELFTEST !== '1') {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
