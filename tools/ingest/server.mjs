#!/usr/bin/env node
// Telefondaki gerçek TikTok uygulamasından yakalanan kutu mesajlarını alan
// anahtarlı uç. Gelen kayıt tarayıcının beklediği biçime çevrilir, ntfy'ye
// yayınlanır (panel anında görür) ve site/firsat/data/boxes.json'a yazılır.
//
//   INGEST_TOKEN=uzun-bir-anahtar node tools/ingest/server.mjs --port=8788
//
// Uçlar:
//   POST /ingest  (<- x-ingest-key: <token> ya da Authorization: Bearer <token>)
//   GET  /health  (anahtar gerekmez, yalnızca sayaç döner)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

// ---------- ayarlar ----------

const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : '1'];
}));
const arg = (name, fallback) => (args.has(name) ? args.get(name) : fallback);

const TOKEN = process.env.INGEST_TOKEN || arg('token', '');
const PORT = Number(arg('port', 8788));
const HOST = arg('host', '0.0.0.0');
const DATA_DIR = path.resolve(arg('data-dir', 'site/firsat/data'));
const BOX_FILE = path.join(DATA_DIR, 'boxes.json');
const NTFY = arg('ntfy', '1') !== '0';
const TOPIC = process.env.NTFY_TOPIC || arg('ntfy-topic', 'cehennem-tiktok-firsat-7f3a91');
const NTFY_KEY = process.env.NTFY_KEY || arg('ntfy-key', 'XQMPSwldDoS26gnVIV1ClCyb');
const MAX_BOXES = 120;
const BODY_LIMIT = 64 * 1024;

if (!TOKEN || TOKEN.length < 16) {
  console.error('INGEST_TOKEN gerekli (en az 16 karakter). Örnek:');
  console.error('  INGEST_TOKEN="$(openssl rand -hex 24)" node tools/ingest/server.mjs --port=8788');
  process.exit(1);
}

const tokenHash = createHash('sha256').update(TOKEN).digest();
const stats = { received: 0, accepted: 0, duplicate: 0, rejected: 0 };

// ---------- kutu biçimi ----------
// Tarayıcının writeBoxes() ile yazdığı alanların aynısı: panel iki kaynağı da
// (ntfy ve boxes.json) aynı mergeBoxItems() yolundan işler.

const BOX_NAMES = { 9: 'Portal', 19: 'Süper Fan Kutusu', 20: 'Sandık', 21: 'Zarf' };
// Kutu jetonu yalnızca kutu nesnelerinin bilinen alanlarından okunur.
const BOX_COIN_FIELDS = ['diamondCount', 'coinCount', 'coins'];
const MAX_BOX_COINS = 50000000;

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

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

function boxKind(eventName, info) {
  const bt = Number(info && info.businessType) || 0;
  const text = String(eventName || '') + ' ' + String(
    (info && (info.boxType || info.envelopeScene || info.textKey || info.displayKey)) || ''
  );
  if (/portal/i.test(text) || bt === 9) return 'portal';
  if (/treasure|sand[ıi]k|chest/i.test(text) || bt === 19 || bt === 20) return 'chest';
  return 'letter';
}

// Saniye ve milisaniye karışık geliyor; 1e12 üstü milisaniye, 1e9 üstü saniye.
function toMs(value) {
  const num = Number(value) || 0;
  if (num > 1e12) return Math.round(num);
  if (num > 1e9) return Math.round(num * 1000);
  return 0;
}

// Uygulamadan gelen ham mesaj da, elle hazırlanmış sade JSON da kabul edilir.
function normalize(input) {
  const info = (input && (input.envelopeInfo || input.info)) || input || {};
  const box = (input && input.treasureBoxData) || info.treasureBoxData || {};
  const username = cleanUsername(input && (input.username || input.uniqueId) || info.username);
  if (!username) return { error: 'username yok' };

  const businessType = Number(info.businessType || input.businessType) || 0;
  const kind = boxKind(input && input.event, info);
  const picked = boxCoins(info, box);
  const capturedAt = Number(input && (input.t || input.capturedAt)) || Date.now();

  const unpackAt = toMs(info.unpackAt || box.unpackAt || (input && input.unpackAt));
  const openInSec = Number(info.secondsUntilOpen || (input && input.secondsUntilOpen)) || 0;
  const endMs = unpackAt || (openInSec > 0 ? capturedAt + openInSec * 1000 : 0);
  const createAt = toMs(info.createAt || box.createAt || (input && input.createAt));
  const explicitDuration = Number(info.durationSec || (input && input.durationSec)) || 0;
  const durationSec = explicitDuration > 0
    ? Math.round(explicitDuration)
    : (endMs && createAt ? Math.max(0, Math.round((endMs - createAt) / 1000)) : 0);

  const envelopeId = String(info.envelopeId || box.envelopeId || '').trim();
  const name = BOX_NAMES[businessType] ||
    String(info.boxTitle || info.boxName || '').trim() ||
    { chest: 'Sandık', portal: 'Portal', letter: 'Zarf' }[kind];

  return {
    box: {
      // Aynı yakalama iki kez gönderilirse aynı kimlik üretilsin (tekilleştirme).
      id: envelopeId || ['app', username, businessType, capturedAt].join(':'),
      t: capturedAt,
      username,
      kind,
      coins: picked.coins,
      boxName: name,
      businessType,
      boxType: String(info.boxType || input.boxType || ''),
      shared: Number(info.peopleCount || info.recipientCount || 0) || 0,
      durationSec,
      unpackAt: endMs,
      availableAt: endMs,
      hasWindow: endMs > 0
    },
    coinsField: picked.field
  };
}

// ---------- depolama ----------

function readBoxes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BOX_FILE, 'utf8'));
    return Array.isArray(parsed.boxes) ? parsed : { boxes: [] };
  } catch {
    return { boxes: [] };
  }
}

// Yeni kutu en başa; aynı kimlik ikinci kez yazılmaz; dosya 120 kutuda tutulur.
function saveBox(box) {
  const current = readBoxes();
  if (current.boxes.some((item) => item && item.id === box.id)) return false;
  const boxes = [box].concat(current.boxes).slice(0, MAX_BOXES);
  const body = {
    scannedAt: new Date().toISOString(),
    runId: current.runId || 'ingest',
    boxes
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = BOX_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(body, null, 1) + '\n');
  fs.renameSync(temp, BOX_FILE);
  return true;
}

// ---------- yayın ----------
// Tarayıcının publishBox() yükünün aynısı; panel anahtar eşleşmezse yok sayar.
function publish(box) {
  if (!NTFY) return;
  fetch('https://ntfy.sh/' + encodeURIComponent(TOPIC), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: NTFY_KEY,
      id: box.id,
      t: box.t,
      username: box.username,
      kind: box.kind,
      coins: box.coins,
      boxName: box.boxName,
      businessType: box.businessType,
      boxType: box.boxType,
      shared: box.shared,
      durationSec: box.durationSec,
      unpackAt: box.unpackAt,
      availableAt: box.availableAt,
      hasWindow: box.hasWindow
    }),
    signal: AbortSignal.timeout(4000)
  }).catch(() => { /* yayın başarısız: dosya yolu yine var */ });
}

// ---------- HTTP ----------

function authorized(req) {
  const header = req.headers['x-ingest-key'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!header) return false;
  const given = createHash('sha256').update(String(header)).digest();
  return given.length === tokenHash.length && timingSafeEqual(given, tokenHash);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('gövde çok büyük'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health' && req.method === 'GET') {
    const current = readBoxes();
    return send(res, 200, {
      ok: true,
      boxes: current.boxes.length,
      updatedAt: current.scannedAt || null,
      stats
    });
  }

  if (url.pathname !== '/ingest') return send(res, 404, { error: 'bilinmeyen uç' });
  if (req.method !== 'POST') return send(res, 405, { error: 'yalnızca POST' });
  if (!authorized(req)) {
    stats.rejected += 1;
    return send(res, 401, { error: 'anahtar geçersiz' });
  }

  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (error) {
    stats.rejected += 1;
    return send(res, 400, { error: 'gövde JSON değil ya da çok büyük' });
  }

  stats.received += 1;
  const parsed = normalize(input);
  if (parsed.error) {
    stats.rejected += 1;
    return send(res, 400, { error: parsed.error });
  }

  const { box, coinsField } = parsed;
  if (!saveBox(box)) {
    stats.duplicate += 1;
    return send(res, 200, { duplicate: true, id: box.id });
  }

  stats.accepted += 1;
  publish(box);
  console.log(new Date().toISOString(), 'kutu', box.kind, '@' + box.username,
    box.coins > 0 ? box.coins + ' jeton' : 'jeton bilinmiyor',
    coinsField ? '(' + coinsField + ')' : '');
  return send(res, 200, { accepted: true, id: box.id, kind: box.kind, coins: box.coins });
});

server.listen(PORT, HOST, () => {
  console.log('ingest ucu hazır: http://' + HOST + ':' + PORT + '/ingest');
  console.log('kutu dosyası:', BOX_FILE, '| ntfy:', NTFY ? TOPIC : 'kapalı');
});
