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
const { WebcastPushConnection } = require('tiktok-live-connector');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'site', 'firsat', 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const LIVE_FILE = path.join(DATA_DIR, 'live.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- ayarlar ----------

function readArg(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith('--' + name));
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
  concurrency: Number(readArg('concurrency', 4)),
  minCoins: Number(readArg('min-coins', 1)),
  commitSec: Number(readArg('commit', 0))
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
  lastFlush: 0,
  lastCommit: 0,
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
        country: (typeof item === 'object' && item && item.country) || ''
      });
    });
    return out;
  } catch (error) {
    log('havuz okunamadı:', error.message);
    return [];
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
    if (!room) return { live: false, reason: 'oda yok' };
    const live = Number(room.status) === 2;
    return {
      live,
      startTime: Number(room.startTime) || 0,
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

async function startWatching(username) {
  if (state.rooms.has(username)) return;
  if (state.rooms.size >= CONFIG.maxRooms) return;

  const connection = new WebcastPushConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: true,
    requestOptions: { timeout: 15000 }
  });
  state.rooms.set(username, connection);

  const stop = () => {
    state.rooms.delete(username);
    try { connection.disconnect(); } catch (error) { /* zaten kapalı */ }
  };

  connection.on('gift', (message) => {
    const gift = message && message.gift;
    const count = Number(message && message.repeatCount) || 1;
    const diamonds = Number(gift && (gift.diamond_count || gift.diamondCount)) || 0;
    const name = (gift && (gift.name || gift.describe)) || (message && message.giftName) || 'Hediye';
    recordEvent(username, {
      kind: 'chest',
      coins: diamonds * count,
      giftName: name,
      sender: (message && message.user && message.user.uniqueId) || ''
    });
  });

  connection.on('envelope', (message) => {
    const info = (message && message.envelopeInfo) || {};
    recordEvent(username, {
      kind: 'letter',
      coins: Number(info.diamondCount || info.diamonds || info.coinCount) || 0,
      giftName: info.envelopeScene || 'Zarf',
      sender: ''
    });
  });

  connection.on('streamEnd', () => {
    log('yayın bitti', username);
    markOffline(username);
    stop();
  });

  connection.on('disconnected', () => {
    state.rooms.delete(username);
  });

  connection.on('error', (error) => {
    state.lastError = username + ': ' + (error && error.message);
  });

  try {
    const roomInfo = await connection.connect();
    const record = state.streamers.get(username) || { username };
    record.live = true;
    record.startTime = Number(roomInfo && (roomInfo.startTime || roomInfo.createTime)) || record.startTime || 0;
    record.title = (roomInfo && roomInfo.title) || record.title || '';
    record.viewers = Number(roomInfo && roomInfo.stats && roomInfo.stats.totalUser) || record.viewers || 0;
    record.lastSeenLiveAt = Date.now();
    state.streamers.set(username, record);
    log('dinleniyor', username, '(' + (record.title || '').slice(0, 40) + ')');
  } catch (error) {
    log('bağlanamadı', username, error.message);
    markOffline(username);
    stop();
  }
}

function markOffline(username) {
  const record = state.streamers.get(username);
  if (!record) return;
  if (record.live) record.endedAt = Date.now();
  record.live = false;
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
    if (status.live) {
      liveCount += 1;
      record.live = true;
      record.lastSeenLiveAt = Date.now();
      if (status.startTime) record.startTime = status.startTime;
      if (status.title) record.title = status.title;
      if (status.viewers) record.viewers = status.viewers;
      state.streamers.set(username, record);
      if (!state.rooms.has(username)) startWatching(username);
    } else {
      if (record.live) {
        record.endedAt = Date.now();
        record.live = false;
      }
      state.streamers.set(username, record);
      const connection = state.rooms.get(username);
      if (connection) {
        state.rooms.delete(username);
        try { connection.disconnect(); } catch (error) { /* boş */ }
      }
    }
  });

  log('tur', state.polls, '· havuz', targets.length, '· canlı', liveCount, '· dinlenen', state.rooms.size);
}

// ---------- çıktı ----------

function snapshot() {
  const streamers = Array.from(state.streamers.values())
    .filter((record) => record.live || record.startTime || record.coins)
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
      checkedAt: record.checkedAt || 0
    }));

  return {
    scannedAt: new Date().toISOString(),
    scanner: {
      targetCount: state.targets.length,
      liveCount: streamers.filter((item) => item.live).length,
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

function commitData() {
  if (!CONFIG.commitSec) return;
  const now = Date.now();
  if (now - state.lastCommit < CONFIG.commitSec * 1000) return;
  state.lastCommit = now;
  try {
    git(['add', 'site/firsat/data/live.json']);
    const diff = git(['status', '--porcelain', 'site/firsat/data/live.json']);
    if (!diff.trim()) return;
    const summary = snapshot().scanner;
    git(['commit', '-m',
      'Canlı tarama: ' + summary.liveCount + '/' + summary.targetCount +
      ' yayında · ' + summary.watching + ' oda dinleniyor']);
    try { git(['pull', '--rebase', '--autostash', 'origin', 'HEAD']); } catch (error) { /* çevrimdışı */ }
    git(['push']);
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

  state.rooms.forEach((connection) => {
    try { connection.disconnect(); } catch (error) { /* boş */ }
  });
  state.rooms.clear();
  flush(true);
  commitData();
  log('bitti');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
