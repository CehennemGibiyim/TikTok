import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';

import { canonicalBoxId, normalizeIncoming, tokenMatches } from './ingest.js';
import { consumeNtfy } from './ntfy.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://radar:radar@127.0.0.1:5432/radar';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const HUNG_WINDOW_MS = 15 * 60 * 1000;
const MAX_COINS = 50_000_000;
const MAX_INT = 2_147_483_647;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const CHANNEL = 'radar:events';
const INSTANCE_ID = crypto.randomUUID();
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const INGEST_TOKEN = String(process.env.INGEST_TOKEN || '');
const INGEST_ENABLED = INGEST_TOKEN.length >= 16;
const NTFY_TOPIC = String(process.env.NTFY_TOPIC || '').trim();
const NTFY_KEY = String(process.env.NTFY_KEY || '').trim();
const NTFY_BASE_URL = String(process.env.NTFY_BASE_URL || 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_RECONNECT_MS = Math.max(1000, Number(process.env.NTFY_RECONNECT_MS) || 5000);
const ntfyAbort = new AbortController();
const ntfyRuntime = {
  enabled: Boolean(NTFY_TOPIC),
  connected: false,
  messages: 0,
  accepted: 0,
  duplicates: 0,
  rejected: 0,
  lastMessageAt: 0,
  lastConnectedAt: 0,
  lastError: null
};

class ValidationError extends Error {}

// BIGINT alanları (jeton, ms zaman damgaları) JSON'da sayı olarak kalsın.
pg.types.setTypeParser(20, (value) => Number(value));
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000
});
// Boşta duran bir bağlantı Postgres yeniden başlarken kapanırsa süreç
// düşmesin; Pool sonraki sorguda yeni bağlantı açar.
pool.on('error', (error) => console.error('[postgres]', error.message));

// Redis yalnızca fan-out içindir. Bağlantı yokken komutları kuyruğa almak
// yerine hemen hata ver; HTTP yazımı yerel WebSocket'lere yine de gider.
const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true });
redis.on('error', (error) => console.error('[redis]', error.message));
const subscriber = createClient({ url: REDIS_URL, disableOfflineQueue: true });
subscriber.on('error', (error) => console.error('[redis-sub]', error.message));
let subscriberReady = false;

const app = express();
app.disable('x-powered-by');

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim().toLowerCase();
  if (requestHost && parsed.host.toLowerCase() === requestHost) return true;
  return LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
}

// Tarayıcıdan gelen çapraz kaynak istekleri reddet. Origin göndermeyen
// curl/collector gibi istemciler bu kontrolün dışındadır.
app.use((req, res, next) => {
  if (!originAllowed(req)) return res.status(403).json({ error: 'origin_not_allowed' });
  next();
});
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Anahtar kontrolü gövde ayrıştırmasından önce: yetkisiz büyük/bozuk gövde
// ayrıştırılmaya çalışılmaz.
app.use('/ingest', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!INGEST_ENABLED) return res.status(503).json({ error: 'ingest_disabled' });
  const header = req.headers['x-ingest-key'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokenMatches(header, INGEST_TOKEN)) return res.status(401).json({ error: 'anahtar geçersiz' });
  next();
});

app.use(express.json({ limit: '1mb' }));

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
    event_label: text(input.event_label ?? input.eventLabel ?? input.boxName, 80) || null
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

async function listEvents(filters = {}) {
  const now = Date.now();
  const where = [];
  const values = [];
  const add = (value) => {
    values.push(value);
    return '$' + values.length;
  };

  // Süresi 15 dakikadan fazla geçmiş olaylar snapshot'a girmez.
  where.push('(expires_at_ms = 0 OR expires_at_ms > ' + add(now - HUNG_WINDOW_MS) + ')');
  if (filters.kind === 'chest' || filters.kind === 'bag') where.push('kind = ' + add(filters.kind));
  if (filters.status === 'active') {
    where.push("kind = 'chest' AND chest_status = 'active' AND (opens_at_ms = 0 OR opens_at_ms > " + add(now) + ')');
  } else if (filters.status === 'hung') {
    where.push("kind = 'chest' AND (chest_status = 'hung' OR (chest_status = 'active' AND opens_at_ms > 0 AND opens_at_ms <= " + add(now) + '))');
  }
  const minCoins = Number(filters.minCoins);
  if (Number.isFinite(minCoins) && minCoins > 0) where.push('total_coins >= ' + add(Math.round(minCoins)));
  const minRatio = Number(filters.minRatio);
  if (filters.minRatio !== undefined && filters.minRatio !== '' && Number.isFinite(minRatio)) {
    where.push('ratio IS NOT NULL AND ratio >= ' + add(minRatio));
  }
  const minRemaining = Number(filters.minRemaining);
  if (Number.isFinite(minRemaining) && minRemaining > 0) {
    where.push('expires_at_ms - ' + add(now) + ' >= ' + add(Math.round(minRemaining) * 1000));
  }
  const query = text(filters.q, 80).trim();
  if (query) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    where.push('creator ILIKE ' + add('%' + escaped + '%') + " ESCAPE '\\'");
  }

  const limit = add(clampLimit(filters.limit || 500));
  const sql = `SELECT ${EVENT_COLUMNS} FROM events
    WHERE ${where.join(' AND ')}
    ORDER BY opens_at_ms ASC, id ASC LIMIT ${limit}`;
  const result = await pool.query(sql, values);
  return result.rows.map((row) => deriveRow(row));
}

async function stats() {
  const now = Date.now();
  const result = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE kind = 'chest' AND chest_status = 'active' AND (opens_at_ms = 0 OR opens_at_ms > $1))::int AS active_chests,
      count(*) FILTER (WHERE kind = 'chest' AND (chest_status = 'hung' OR (chest_status = 'active' AND opens_at_ms > 0 AND opens_at_ms <= $1)))::int AS hung_chests,
      count(*) FILTER (WHERE kind = 'bag')::int AS bags,
      count(DISTINCT creator)::int AS creators,
      COALESCE(sum(total_coins), 0)::bigint AS coins
    FROM events
    WHERE expires_at_ms = 0 OR expires_at_ms > $2
  `, [now, now - HUNG_WINDOW_MS]);
  return result.rows[0];
}

async function upsertEvent(raw) {
  const event = normalizeEvent(raw);
  const existing = await pool.query('SELECT 1 FROM events WHERE id = $1', [event.id]);
  const result = await pool.query(`
    INSERT INTO events (
      id, kind, room_id, creator, total_coins, winner_count, participant_count,
      viewer_count, ratio, opens_at_ms, expires_at_ms, chest_type, chest_status,
      bag_level, bag_method, bag_comment, country_code, rank_label, event_label
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19
    )
    ON CONFLICT (id) DO UPDATE SET
      kind = EXCLUDED.kind,
      room_id = COALESCE(NULLIF(EXCLUDED.room_id, ''), events.room_id),
      creator = EXCLUDED.creator,
      total_coins = CASE WHEN EXCLUDED.total_coins > 0 THEN EXCLUDED.total_coins ELSE events.total_coins END,
      winner_count = CASE WHEN EXCLUDED.winner_count > 0 THEN EXCLUDED.winner_count ELSE events.winner_count END,
      participant_count = COALESCE(EXCLUDED.participant_count, events.participant_count),
      viewer_count = COALESCE(EXCLUDED.viewer_count, events.viewer_count),
      ratio = CASE
        WHEN (CASE WHEN EXCLUDED.winner_count > 0 THEN EXCLUDED.winner_count ELSE events.winner_count END) > 0
        THEN (CASE WHEN EXCLUDED.total_coins > 0 THEN EXCLUDED.total_coins ELSE events.total_coins END)::double precision /
          (CASE WHEN EXCLUDED.winner_count > 0 THEN EXCLUDED.winner_count ELSE events.winner_count END)
        ELSE NULL
      END,
      opens_at_ms = CASE WHEN EXCLUDED.opens_at_ms > 0 THEN EXCLUDED.opens_at_ms ELSE events.opens_at_ms END,
      expires_at_ms = CASE WHEN EXCLUDED.expires_at_ms > 0 THEN EXCLUDED.expires_at_ms ELSE events.expires_at_ms END,
      chest_type = EXCLUDED.chest_type,
      chest_status = EXCLUDED.chest_status,
      bag_level = COALESCE(EXCLUDED.bag_level, events.bag_level),
      bag_method = COALESCE(EXCLUDED.bag_method, events.bag_method),
      bag_comment = COALESCE(EXCLUDED.bag_comment, events.bag_comment),
      country_code = COALESCE(EXCLUDED.country_code, events.country_code),
      rank_label = COALESCE(EXCLUDED.rank_label, events.rank_label),
      event_label = COALESCE(EXCLUDED.event_label, events.event_label),
      updated_at = now()
    RETURNING ${EVENT_COLUMNS}
  `, [
    event.id, event.kind, event.room_id, event.creator, event.total_coins,
    event.winner_count, event.participant_count, event.viewer_count, event.ratio,
    event.opens_at_ms, event.expires_at_ms, event.chest_type, event.chest_status,
    event.bag_level, event.bag_method, event.bag_comment, event.country_code,
    event.rank_label, event.event_label
  ]);
  const row = deriveRow(result.rows[0]);
  await publishUpdate({ type: 'event', event: row });
  return { row, duplicate: existing.rowCount > 0 };
}

async function removeEvent(id) {
  const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [String(id)]);
  if (!result.rowCount) return false;
  await publishUpdate({ type: 'removed', ids: [String(id)] });
  return true;
}

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => originAllowed(info.req)
});

const sseClients = new Set();

function broadcastSse(message) {
  const data = `event: ${message.type || 'message'}\ndata: ${JSON.stringify(message)}\n\n`;
  sseClients.forEach((res) => {
    try {
      res.write(data);
    } catch (error) {
      sseClients.delete(res);
      console.error('[sse send]', error.message);
    }
  });
}

function broadcastLocal(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(data);
    } catch (error) {
      console.error('[ws send]', error.message);
    }
  });
  broadcastSse(message);
}

// Yerel istemcilere her zaman doğrudan gönder; Redis'e ayrıca yayınla.
// Redis abonesi kendi kaynağını atladığı için aynı örnekte çift mesaj olmaz.
async function publishUpdate(message) {
  broadcastLocal(message);
  try {
    await redis.publish(CHANNEL, JSON.stringify({ ...message, source: INSTANCE_ID }));
  } catch (error) {
    console.error('[redis publish]', error.message);
  }
}

wss.on('connection', async (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  try {
    const events = await listEvents({ limit: 2000 });
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'snapshot', events, server_ms: Date.now() }));
    }
  } catch (error) {
    console.error('[ws snapshot]', error.message);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'error', message: 'snapshot_unavailable' }));
    }
  }
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

// Redis koptuktan sonra geri geldiğinde, kaçırılan deltaları telafi etmek
// için bağlı istemcilere güncel snapshot gönder.
subscriber.on('ready', async () => {
  if (!subscriberReady) return;
  try {
    const events = await listEvents({ limit: 2000 });
    broadcastLocal({ type: 'snapshot', events, server_ms: Date.now() });
  } catch (error) {
    console.error('[redis resync]', error.message);
  }
});

// ---------- HTTP ----------
app.get('/api/health', async (_req, res) => {
  const checks = { db: false, redis: false, fanout: false };
  try { await pool.query('SELECT 1'); checks.db = true; } catch (error) { console.error('[health db]', error.message); }
  try { await redis.ping(); checks.redis = true; } catch (error) { console.error('[health redis]', error.message); }
  checks.fanout = Boolean(subscriberReady && subscriber.isReady);
  const ok = checks.db && checks.redis && checks.fanout;
  res.status(ok ? 200 : 503).json({
    ok,
    checks,
    ingest: { enabled: INGEST_ENABLED },
    ntfy: ntfyRuntime,
    server_ms: Date.now()
  });
});

app.get('/api/events', async (req, res) => {
  try {
    const events = await listEvents(req.query);
    res.json({ type: 'snapshot', events, server_ms: Date.now() });
  } catch (error) {
    console.error('[events list]', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/events/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 5000\n\n');
  sseClients.add(res);

  const send = (type, payload) => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      sseClients.delete(res);
      console.error('[sse snapshot]', error.message);
    }
  };

  try {
    send('snapshot', { type: 'snapshot', events: await listEvents({ limit: 2000 }), server_ms: Date.now() });
  } catch (error) {
    send('error', { type: 'error', message: 'snapshot_unavailable' });
    console.error('[sse snapshot]', error.message);
  }

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
      sseClients.delete(res);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.get('/api/stats', async (_req, res) => {
  try {
    res.json({ stats: await stats(), server_ms: Date.now() });
  } catch (error) {
    console.error('[stats]', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

async function createEvents(req, res) {
  const body = req.body;
  const items = Array.isArray(body) ? body : (body && Array.isArray(body.events) ? body.events : [body]);
  if (!items.length || items.length > 200) {
    return res.status(400).json({ error: '1–200 olay gönderin' });
  }
  const saved = [];
  const errors = [];
  let duplicates = 0;
  for (const item of items) {
    try {
      const result = await upsertEvent(item);
      saved.push(result.row);
      if (result.duplicate) duplicates += 1;
    } catch (error) {
      // Yalnızca doğrulama mesajları istemciye döner; DB hataları sızmaz.
      if (!(error instanceof ValidationError)) console.error('[event rejected]', error.message);
      errors.push({ id: item && item.id, error: error instanceof ValidationError ? error.message : 'event_rejected' });
    }
  }
  res.status(saved.length ? 201 : 400).json({ saved, errors, duplicates, server_ms: Date.now() });
}

app.post('/api/events', createEvents);

// Anahtarlı hızlı giriş: collector'ın boxes.json yedeğine ek olarak scanner,
// uygulama yakalaması veya başka bir üretici doğrudan buraya yazabilir.
app.post('/ingest', async (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : (body && Array.isArray(body.events) ? body.events : [body]);
  if (!items.length || items.length > 50) {
    return res.status(400).json({ error: '1–50 olay gönderin' });
  }

  const events = [];
  const errors = [];
  let accepted = 0;
  let duplicates = 0;

  for (const item of items) {
    const normalized = normalizeIncoming(item, 'ingest');
    if (normalized.error) {
      errors.push({ id: item && item.id, error: normalized.error });
      continue;
    }
    try {
      const result = await upsertEvent(normalized);
      events.push(result.row);
      if (result.duplicate) duplicates += 1;
      else accepted += 1;
    } catch (error) {
      if (!(error instanceof ValidationError)) console.error('[ingest rejected]', error.message);
      errors.push({ id: item && item.id, error: error instanceof ValidationError ? error.message : 'event_rejected' });
    }
  }

  const status = events.length ? (accepted > 0 ? 201 : 200) : (errors.length ? 400 : 200);
  res.status(status).json({ accepted, duplicates, errors, events, server_ms: Date.now() });
});

app.delete('/api/events/:id', async (req, res) => {
  const id = req.params.id;
  if (!id || id.length > 200) return res.status(400).json({ error: 'geçersiz id' });
  try {
    const removed = await removeEvent(id);
    res.status(removed ? 200 : 404).json({ removed, server_ms: Date.now() });
  } catch (error) {
    console.error('[event delete]', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'geçersiz JSON' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'gövde çok büyük' });
  }
  console.error('[http]', error.message);
  res.status(500).json({ error: 'internal_error' });
});

// ---------- açılış ----------
async function initDb() {
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
}

async function startSubscriber() {
  if (!subscriber.isOpen) await subscriber.connect();
  if (subscriberReady) return;
  await subscriber.subscribe(CHANNEL, (raw) => {
    try {
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;
      if (payload.source === INSTANCE_ID) return;
      const { source, ...message } = payload;
      broadcastLocal(message);
    } catch (error) {
      console.error('[redis-sub]', error.message);
    }
  });
  subscriberReady = true;
}

async function waitForDependencies() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      await initDb();
      await redis.connect();
      await redis.ping();
      await startSubscriber();
      console.log('[ready] postgres + redis + fanout');
      return;
    } catch (error) {
      console.log(`[wait] ${attempt}/30 ${error.message}`);
      if (redis.isOpen) await redis.disconnect();
      if (subscriber.isOpen) await subscriber.disconnect();
      subscriberReady = false;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error('Postgres/Redis bağlantısı kurulamadı');
}

async function cleanupLoop() {
  try {
    const cutoff = Date.now() - HUNG_WINDOW_MS;
    const result = await pool.query(
      'DELETE FROM events WHERE expires_at_ms > 0 AND expires_at_ms < $1 RETURNING id',
      [cutoff]
    );
    if (result.rowCount) {
      const ids = result.rows.map((row) => row.id);
      await publishUpdate({ type: 'removed', ids });
      console.log('[cleanup]', ids.length, 'olay silindi');
    }
  } catch (error) {
    console.error('[cleanup]', error.message);
  }
}

function startNtfySource() {
  if (!ntfyRuntime.enabled) {
    console.log('[ntfy] kapalı (NTFY_TOPIC boş)');
    return;
  }
  console.log('[ntfy] SSE kaynağı:', NTFY_BASE_URL, 'konu:', NTFY_TOPIC);
  void consumeNtfy({
    baseUrl: NTFY_BASE_URL,
    topic: NTFY_TOPIC,
    key: NTFY_KEY,
    signal: ntfyAbort.signal,
    reconnectMs: NTFY_RECONNECT_MS,
    onEvent: async (box) => {
      ntfyRuntime.messages += 1;
      const normalized = normalizeIncoming(box, 'ntfy');
      if (normalized.error) {
        ntfyRuntime.rejected += 1;
        ntfyRuntime.lastError = normalized.error;
        return;
      }
      try {
        const result = await upsertEvent(normalized);
        ntfyRuntime.lastMessageAt = Date.now();
        if (result.duplicate) ntfyRuntime.duplicates += 1;
        else ntfyRuntime.accepted += 1;
      } catch (error) {
        if (!(error instanceof ValidationError)) console.error('[ntfy event]', error.message);
        ntfyRuntime.rejected += 1;
        ntfyRuntime.lastError = error instanceof ValidationError ? error.message : 'event_rejected';
      }
    },
    onStatus: (status) => {
      if (status.connected !== undefined) ntfyRuntime.connected = status.connected;
      if (status.lastConnectedAt) ntfyRuntime.lastConnectedAt = status.lastConnectedAt;
      if (status.lastError !== undefined) ntfyRuntime.lastError = status.lastError;
      if (status.rejected) ntfyRuntime.rejected += 1;
    }
  }).catch((error) => {
    if (!ntfyAbort.signal.aborted) {
      ntfyRuntime.lastError = error.message;
      console.error('[ntfy]', error.message);
    }
  });
}

await waitForDependencies();
setInterval(cleanupLoop, 60000);
cleanupLoop();
startNtfySource();

server.listen(PORT, HOST, () => {
  console.log(`[api] http://${HOST}:${PORT} · ws://${HOST}:${PORT}/ws`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  clearInterval(heartbeat);
  ntfyAbort.abort();
  sseClients.forEach((client) => {
    try { client.end(); } catch { /* bağlantı zaten kapanmış */ }
  });
  sseClients.clear();
  wss.clients.forEach((client) => client.close(1001, 'server_shutdown'));
  wss.close();
  server.close();
  try {
    await pool.end();
    if (subscriber.isOpen) await subscriber.quit();
    if (redis.isOpen) await redis.quit();
  } catch (error) {
    console.error('[shutdown]', error.message);
  }
  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
