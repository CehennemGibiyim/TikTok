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
  watchSec: Number(readArg('watch-sec', 300)),
  watchRooms: Number(readArg('watch-rooms', 8))
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

function saveTargets() {
  // Keşifle bulunanlar eklenir, kullanıcının kendi ekledikleri korunur.
  const body = {
    note: 'Taranacak adresler. Keşif kendi bulduklarını buraya ekler; elle eklenenler korunur.',
    updatedAt: new Date().toISOString(),
    targets: state.targets.map((target) => ({
      username: target.username,
      country: target.country || '',
      source: target.source || 'manual',
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
    if (!response.ok) return { live: false, reason: 'http ' + response.status };
    const payload = await response.json();
    const room = payload && payload.data && payload.data.liveRoom;
    if (!room) return { live: false, reason: (payload && payload.message) || 'oda yok' };
    const live = Number(room.status) === 2;
    // TikTok başlangıç saatini saniye olarak veriyor; ms'e çeviriyoruz.
    const rawStart = Number(room.startTime) || 0;
    const startTime = rawStart > 0 && rawStart < 1e12 ? rawStart * 1000 : rawStart;
    return {
      live,
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
    giftName: data.giftName || '',
    sender: data.sender || '',
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

function kindFor(name, data) {
  const text = String(name || '') + ' ' + String((data && data.giftType) || '');
  if (/portal/i.test(text)) return 'portal';
  if (/envelope|zarf|mektup|letter|red\s*packet/i.test(text)) return 'letter';
  return 'chest';
}

function handleStreamMessage(username, raw) {
  let payload;
  try { payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (error) { return; }
  const event = payload.event || (payload.data && payload.data.type) || '';
  const data = payload.data || {};

  if (event === 'gift') {
    const count = Number(data.repeatCount || data.repeat_count) || 1;
    const diamonds = Number(data.diamondCount || data.diamond_count) || 0;
    const name = data.giftName || (data.gift && data.gift.name) || 'Hediye';
    recordEvent(username, {
      kind: kindFor(name, data),
      coins: diamonds * count,
      giftName: name,
      sender: (data.user && (data.user.uniqueId || data.user.nickname)) || ''
    });
    return;
  }

  if (/envelope|zarf|letter/i.test(event)) {
    const info = data.envelopeInfo || data;
    recordEvent(username, {
      kind: 'letter',
      coins: Number(info.diamondCount || info.diamonds || info.coinCount) || 0,
      giftName: info.envelopeScene || 'Zarf',
      sender: ''
    });
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

async function closeWatcher(username, reason) {
  const watcher = state.rooms.get(username);
  if (!watcher) return;
  state.rooms.delete(username);
  if (watcher.timer) clearTimeout(watcher.timer);
  try { watcher.socket.close(); } catch (error) { /* zaten kapalı */ }
  log('dinleme bitti', username, reason || '');
}

async function stopAllWatchers(reason) {
  await Promise.all(Array.from(state.rooms.keys()).map((username) => closeWatcher(username, reason)));
}

async function openWatcher(username) {
  const token = await mintToken(username, Math.min(600, CONFIG.watchSec + 60));
  const WS = wsFactory();
  const socket = new WS('wss://api.tik.tools?uniqueId=' + encodeURIComponent(username) +
    '&jwtKey=' + encodeURIComponent(token));

  const watcher = { username, socket, startedAt: Date.now(), messages: 0, timer: null };
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

  watcher.timer = setTimeout(() => { closeWatcher(username, 'süre doldu'); }, CONFIG.watchSec * 1000);
  log('dinleniyor', username);
}

// Canlı odalar sırayla değil, aynı anda birden çok soketle dinlenir.
async function maintainWatchers() {
  if (!CONFIG.watch) return;

  const now = Date.now();
  for (const [username, watcher] of Array.from(state.rooms.entries())) {
    if (now - watcher.startedAt >= CONFIG.watchSec * 1000) await closeWatcher(username, 'süre doldu');
  }

  const live = Array.from(state.streamers.values())
    .filter((record) => record.live)
    .sort((a, b) => (Number(b.viewers) || 0) - (Number(a.viewers) || 0) ||
      (Number(b.coins) || 0) - (Number(a.coins) || 0));

  const target = Math.min(CONFIG.watchRooms, live.length);
  let opened = 0;

  while (state.rooms.size < target && opened < CONFIG.watchRooms) {
    const fresh = live.find((record) => !state.rooms.has(record.username) && !state.recent.includes(record.username));
    const pick = fresh || live.find((record) => !state.rooms.has(record.username));
    if (!pick) break;
    state.recent.push(pick.username);
    if (state.recent.length > 120) state.recent.shift();
    try {
      await openWatcher(pick.username);
      opened += 1;
    } catch (error) {
      state.lastError = 'dinleme: ' + pick.username + ' ' + error.message;
      log('dinleme hatası', pick.username, error.message);
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

    record.checkedAt = Date.now();
    record.reason = status.live ? '' : (status.reason || '');
    if (status.live) {
      liveCount += 1;
      record.live = true;
      record.lastSeenLiveAt = Date.now();
      if (!target.lastSeenLiveAt) target.lastSeenLiveAt = Date.now();
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
      checkedAt: record.checkedAt || 0
    }));

  return {
    scannedAt: new Date().toISOString(),
    scanner: {
      targetCount: state.targets.length,
      liveCount: streamers.filter((item) => item.live).length,
      discovered: state.discoveredTotal,
      poolSize: state.targets.length,
      watching: state.rooms.size,
      polls: state.polls,
      minutesLeft: CONFIG.minutes > 0 ? Math.max(0, Math.round((deadline - Date.now()) / 60000)) : null,
      lastError: state.lastError,
      version: 1
    },
    streamers,
    events: state.events
  };
}

function flush(force) {
  const now = Date.now();
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
    git(['add', 'site/firsat/data/live.json']);
    if (!git(['status', '--porcelain', 'site/firsat/data/live.json']).trim()) return;
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
