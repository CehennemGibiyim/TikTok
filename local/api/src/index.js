import crypto from 'node:crypto';
import fs from 'node:fs';

import pg from 'pg';
import { createClient } from 'redis';

import { createApi } from './api.js';
import { HUNG_WINDOW_MS } from './events.js';
import { createPgStore } from './store-pg.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://radar:radar@127.0.0.1:5432/radar';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CHANNEL = 'radar:events';
const INSTANCE_ID = crypto.randomUUID();

const INGEST_TOKEN = String(process.env.INGEST_TOKEN || '');
const NTFY_TOPIC = String(process.env.NTFY_TOPIC || '').trim();
const NTFY_KEY = String(process.env.NTFY_KEY || '').trim();
const NTFY_BASE_URL = String(process.env.NTFY_BASE_URL || 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_RECONNECT_MS = Math.max(1000, Number(process.env.NTFY_RECONNECT_MS) || 5000);
// tiktok-live-api (TikTool) yönetilen WebSocket kaynağı. Anahtar yoksa kapalı.
const TIKTOOL_API_KEY = String(process.env.TIKTOOL_API_KEY || '').trim();
const TIKTOOL_ROOMS = String(process.env.TIKTOOL_ROOMS || '')
  .split(',').map((name) => name.trim()).filter(Boolean);
const TIKTOOL_MAX_ROOMS = Math.max(1, Number(process.env.TIKTOOL_MAX_ROOMS) || 3);

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

const store = createPgStore({ pool });

const api = createApi({
  store,
  config: {
    ingestToken: INGEST_TOKEN,
    ntfy: {
      baseUrl: NTFY_BASE_URL,
      topic: NTFY_TOPIC,
      key: NTFY_KEY,
      reconnectMs: NTFY_RECONNECT_MS
    },
    tiktool: {
      apiKey: TIKTOOL_API_KEY,
      usernames: TIKTOOL_ROOMS,
      maxRooms: TIKTOOL_MAX_ROOMS
    },
    // Sağlık yanıtı gerçek bağlantıları raporlar; testler kendi depolarını verir.
    healthCheck: async () => {
      const checks = { db: false, redis: false, fanout: false };
      try { await pool.query('SELECT 1'); checks.db = true; } catch (error) { console.error('[health db]', error.message); }
      try { await redis.ping(); checks.redis = true; } catch (error) { console.error('[health redis]', error.message); }
      checks.fanout = Boolean(subscriberReady && subscriber.isReady);
      return checks;
    }
  },
  // Redis abonesi kendi kaynağını atladığı için aynı örnekte çift mesaj olmaz.
  // Hata yönetimi API'de: yerel istemciler yayından önce zaten güncellenmiş olur.
  publish: (message) => redis.publish(CHANNEL, JSON.stringify({ ...message, source: INSTANCE_ID }))
});

const { server } = api;

// Redis koptuktan sonra geri geldiğinde, kaçırılan deltaları telafi etmek
// için bağlı istemcilere güncel snapshot gönder.
subscriber.on('ready', async () => {
  if (!subscriberReady) return;
  try {
    const events = await store.listEvents({ limit: 2000 });
    api.broadcast({ type: 'snapshot', events, server_ms: Date.now() });
  } catch (error) {
    console.error('[redis resync]', error.message);
  }
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
      api.broadcast(message);
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
      await api.publishUpdate({ type: 'removed', ids });
      console.log('[cleanup]', ids.length, 'olay silindi');
    }
  } catch (error) {
    console.error('[cleanup]', error.message);
  }
}

await waitForDependencies();
setInterval(cleanupLoop, 60000);
cleanupLoop();
api.startNtfy();
api.startTiktool();

server.listen(PORT, HOST, () => {
      console.log(`[api] http://${HOST}:${PORT} · ws://${HOST}:${PORT}/ws`);
    if (api.tiktoolRuntime.enabled) {
      console.log(`[tiktool] ${api.tiktoolRuntime.rooms} oda dinleniyor`);
    }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  await api.close();
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
