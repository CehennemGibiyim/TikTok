#!/usr/bin/env node
'use strict';

/*
 * Scanner köprüsü.
 *
 * scanner/index.js'in ürettiği boxes.json dosyasını izler ve yeni kutuları
 * yerel radar API'sine aktarır. TikTok'a doğrudan bağlanmaz; böylece scanner
 * çalışırken panelin gerçek veri görmesi için ayrı bir ağ katmanı gerekmez.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const API_URL = String(process.env.RADAR_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const DATA_DIR = process.env.SCANNER_DATA_DIR
  ? path.resolve(process.env.SCANNER_DATA_DIR)
  : path.join(ROOT, 'site', 'firsat', 'data');
const BOX_FILE = process.env.BOX_FILE
  ? path.resolve(process.env.BOX_FILE)
  : path.join(DATA_DIR, 'boxes.json');
const STATE_FILE = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(__dirname, 'state.json');
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const POLL_MS = Math.max(1000, Math.round(envNumber('POLL_MS', 5000)));
const MAX_AGE_MS = Math.max(60_000, Math.round(envNumber('MAX_AGE_MS', 15 * 60 * 1000)));
const BATCH_SIZE = Math.max(1, Math.min(200, Math.round(envNumber('BATCH_SIZE', 50))));
// Watermark eski kutuları eler; bu harita yalnızca aynı zaman damgasındaki tekrarları engeller.
const MAX_SEEN = 2000;
const ONCE = process.argv.includes('--once');

let stopped = false;
let state = loadState();
if (pruneSeen(Date.now())) {
  try {
    saveState();
  } catch (error) {
    console.error('[collector] state yazılamadı:', error.message);
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const watermark = Number(parsed.watermark);
    const now = Date.now();
    return {
      // İleri tarihli bozuk bir watermark, son 15 dakikayı kalıcı olarak atlamasın.
      watermark: Number.isFinite(watermark) && watermark > 0 && watermark <= now ? watermark : 0,
      seen: parsed.seen && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen)
        ? parsed.seen
        : {}
    };
  } catch {
    return { watermark: 0, seen: {} };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temp = STATE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, STATE_FILE);
}

function pruneSeen(now) {
  let removed = 0;
  const keepAfter = now - 2 * 60 * 60 * 1000;
  for (const [id, seenAt] of Object.entries(state.seen)) {
    if (Number(seenAt) < keepAfter) {
      delete state.seen[id];
      removed += 1;
    }
  }
  const entries = Object.entries(state.seen);
  if (entries.length > MAX_SEEN) {
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));
    state.seen = Object.fromEntries(entries.slice(0, MAX_SEEN));
    removed += entries.length - MAX_SEEN;
  }
  return removed;
}

function boxKey(box) {
  return String(box.id || `${box.runId || 'run'}:${box.seq || box.t || 'event'}`);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function toEvent(box) {
  const key = boxKey(box);
  const kind = box.kind === 'chest' ? 'chest' : 'bag';
  const opensAt = number(box.unpackAt) || number(box.availableAt) || number(box.t);
  return {
    id: `scanner:${key}`,
    source: 'boxes',
    kind,
    room_id: String(box.roomId || ''),
    creator: String(box.username || '').trim(),
    total_coins: number(box.coins),
    winner_count: number(box.shared),
    participant_count: number(box.participants) || null,
    viewer_count: number(box.viewers) || null,
    opens_at_ms: opensAt,
    chest_type: kind === 'chest' ? String(box.boxType || 'normal') : undefined,
    event_label: String(box.boxName || (kind === 'chest' ? 'Sandık' : 'Zarf'))
  };
}

function readBoxes() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BOX_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const boxes = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.boxes) ? parsed.boxes : [];
  const since = Math.max(Number(state.watermark) || 0, Date.now() - MAX_AGE_MS);
  return boxes
    .filter((box) => box && typeof box === 'object' && !Array.isArray(box) &&
      Number(box.t) >= since && !state.seen[boxKey(box)])
    .sort((a, b) => Number(a.t) - Number(b.t))
    .slice(0, BATCH_SIZE);
}

async function send(batch) {
  const response = await fetch(`${API_URL}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch.map(toEvent)),
    signal: AbortSignal.timeout(10000)
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Boş veya JSON olmayan hata yanıtı aşağıda durum koduyla ele alınır.
  }
  if (!response.ok && response.status !== 400) {
    throw new Error(`API ${response.status}`);
  }
  if (response.status === 400 && (!Array.isArray(data.errors) || data.errors.length === 0)) {
    throw new Error('API 400 (ayrıntı yok)');
  }
  if (response.ok && !Array.isArray(data.saved)) {
    throw new Error('API yanıtı geçersiz');
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    const ids = data.errors.slice(0, 5).map((item) => item && item.id).filter(Boolean);
    console.error(`[collector] reddedilen kutular: ${data.errors.length}${ids.length ? ` (${ids.join(', ')})` : ''}`);
    if (data.errors.some((item) => item && item.error === 'event_rejected')) {
      throw new Error('API event_rejected (yeniden denenecek)');
    }
  }
  return Array.isArray(data.saved) ? data.saved.length : 0;
}

async function poll() {
  const batch = readBoxes();
  if (!batch.length) return;

  const saved = await send(batch);
  const now = Date.now();
  for (const box of batch) {
    state.seen[boxKey(box)] = Number(box.t) || now;
    // Scanner saati ileri olabileceği için watermark geleceğe taşınmasın.
    state.watermark = Math.min(now, Math.max(Number(state.watermark) || 0, Number(box.t) || 0));
  }
  pruneSeen(now);
  saveState();
  console.log(`[collector] ${batch.length} kutu gönderildi (${saved} kaydedildi)`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`[collector] ${BOX_FILE} -> ${API_URL}`);
  let failed = false;
  while (!stopped) {
    try {
      await poll();
      failed = false;
    } catch (error) {
      failed = true;
      console.error('[collector]', error.message);
    }
    if (ONCE) break;
    await sleep(POLL_MS);
  }
  if (ONCE && failed) process.exitCode = 1;
}

process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

main().catch((error) => {
  console.error('[collector] ölümcül:', error.message);
  process.exitCode = 1;
});
