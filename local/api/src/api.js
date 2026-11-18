/*
 * HTTP + WebSocket + SSE + ntfy kaynağı.
 *
 * Depolama `store` üzerinden enjekte edilir ve dışa yayın (`publish`) Redis
 * gibi altyapıya bırakılır. Böylece gerçek uçlar Postgres/Redis olmadan da
 * (testlerde) çalıştırılabilir.
 */
import http from 'node:http';

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import { normalizeIncoming, tokenMatches } from './ingest.js';
import { createIdentityAudit } from './identity-audit.js';
import { createTiktoolSource } from './tiktool.js';
import { consumeNtfy } from './ntfy.js';
import { ValidationError, normalizeEvent } from './events.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function createApi({ store, publish, config = {}, log = console } = {}) {
  if (!store) throw new Error('store zorunlu');

  // Kanonik anahtar çakışmaları ve iki kimlikli satırlar süreç içi sayılır;
  // üretimde `/api/stats` altından okunur.
  const identityAudit = createIdentityAudit();

  const ingestToken = String(config.ingestToken || '');
  const ingestEnabled = ingestToken.length >= 16;
  const healthCheck = typeof config.healthCheck === 'function' ? config.healthCheck : null;

  const ntfy = config.ntfy || {};
  const ntfyTopic = String(ntfy.topic || '').trim();
  const ntfyKey = String(ntfy.key || '').trim();
  const ntfyBaseUrl = String(ntfy.baseUrl || 'https://ntfy.sh').replace(/\/+$/, '');
  const ntfyReconnectMs = Math.max(1000, Number(ntfy.reconnectMs) || 5000);
  const ntfyAbort = new AbortController();
  const ntfyRuntime = {
    enabled: Boolean(ntfyTopic),
    connected: false,
    messages: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    lastMessageAt: 0,
    lastConnectedAt: 0,
    lastError: null
  };

  // Yönetilen TikTok LIVE kaynağı (tiktok-live-api). Anahtar/oda yoksa kapalı.
  const tiktool = config.tiktool || {};
  const tiktoolSource = createTiktoolSource({
    apiKey: tiktool.apiKey,
    usernames: tiktool.usernames,
    maxRooms: tiktool.maxRooms,
    createClient: tiktool.createClient,
    log,
    onBox: async (box) => {
      const normalized = normalizeIncoming(box, 'tiktool');
      if (normalized.error) throw new Error(normalized.error);
      await upsertAndPublish(normalized);
    }
  });
  const tiktoolRuntime = tiktoolSource.runtime;

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
    if (!ingestEnabled) return res.status(503).json({ error: 'ingest_disabled' });
    const header = req.headers['x-ingest-key'] ||
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenMatches(header, ingestToken)) return res.status(401).json({ error: 'anahtar geçersiz' });
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // ---------- WebSocket + SSE yayını ----------
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
        log.error('[sse send]', error.message);
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
        log.error('[ws send]', error.message);
      }
    });
    broadcastSse(message);
  }

  // Yerel istemcilere her zaman doğrudan gönder; dış yayın (Redis) ayrıca.
  async function publishUpdate(message) {
    broadcastLocal(message);
    try {
      await publish(message);
    } catch (error) {
      log.error('[publish]', error.message);
    }
  }

  async function upsertAndPublish(raw) {
    const result = await store.upsertEvent(raw);
    // Depo, birleştirmede açılış zamanını ilk değerde tutar; çakışmayı ve
    // iki kimlikli kutu denemesini görebilmek için denetime gelen olayın kendi
    // alanları ve kimliği verilir. Aynı kutu farklı kimlikle geldiyse depo tek
    // satırda birleştirir; denetim bunu `split_rows` kanıtı olarak sayar.
    const incoming = normalizeEvent(raw);
    const finding = identityAudit.observe({
      ...incoming,
      source: raw && raw.source
    });
    // Sayaç ve örnekler yalnızca bellekte; süreç yeniden başlarsa kaybolur.
    // Her yeni bulguyu tek satır JSON olarak günlüğe yaz ki kanıt kalsın.
    if (finding) {
      const write = typeof log.warn === 'function' ? log.warn : log.log;
      write.call(log, '[identity]', JSON.stringify(finding));
    }
    await publishUpdate({ type: 'event', event: result.row });
    return result;
  }

  wss.on('connection', async (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    try {
      const events = await store.listEvents({ limit: 2000 });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'snapshot', events, server_ms: Date.now() }));
      }
    } catch (error) {
      log.error('[ws snapshot]', error.message);
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

  // ---------- HTTP ----------
  app.get('/api/health', async (_req, res) => {
    let checks = { db: true, redis: true, fanout: true };
    if (healthCheck) {
      try {
        checks = await healthCheck();
      } catch (error) {
        log.error('[health]', error.message);
        checks = { db: false, redis: false, fanout: false };
      }
    }
    const ok = checks.db === true && checks.redis === true && checks.fanout === true;
    const { rows, keyCollisions, splitRows } = identityAudit.snapshot();
    res.status(ok ? 200 : 503).json({
      ok,
      checks,
      ingest: { enabled: ingestEnabled },
      ntfy: ntfyRuntime,
      tiktool: tiktoolRuntime,
      identity: { rows, keyCollisions, splitRows },
      server_ms: Date.now()
    });
  });

  app.get('/api/events', async (req, res) => {
    try {
      const events = await store.listEvents(req.query);
      res.json({ type: 'snapshot', events, server_ms: Date.now() });
    } catch (error) {
      log.error('[events list]', error.message);
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
        log.error('[sse snapshot]', error.message);
      }
    };

    try {
      send('snapshot', { type: 'snapshot', events: await store.listEvents({ limit: 2000 }), server_ms: Date.now() });
    } catch (error) {
      send('error', { type: 'error', message: 'snapshot_unavailable' });
      log.error('[sse snapshot]', error.message);
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
      res.json({
        stats: await store.stats(),
        identity: identityAudit.snapshot(),
        tiktool: tiktoolRuntime,
        server_ms: Date.now()
      });
    } catch (error) {
      log.error('[stats]', error.message);
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
        const result = await upsertAndPublish(item);
        saved.push(result.row);
        if (result.duplicate) duplicates += 1;
      } catch (error) {
        // Yalnızca doğrulama mesajları istemciye döner; DB hataları sızmaz.
        if (!(error instanceof ValidationError)) log.error('[event rejected]', error.message);
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
        const result = await upsertAndPublish(normalized);
        events.push(result.row);
        if (result.duplicate) duplicates += 1;
        else accepted += 1;
      } catch (error) {
        if (!(error instanceof ValidationError)) log.error('[ingest rejected]', error.message);
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
      const removed = await store.removeEvent(id);
      if (removed) await publishUpdate({ type: 'removed', ids: [String(id)] });
      res.status(removed ? 200 : 404).json({ removed, server_ms: Date.now() });
    } catch (error) {
      log.error('[event delete]', error.message);
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
    log.error('[http]', error.message);
    res.status(500).json({ error: 'internal_error' });
  });

  // ---------- ntfy kaynağı ----------
  function startNtfy() {
    if (!ntfyRuntime.enabled) {
      log.log('[ntfy] kapalı (NTFY_TOPIC boş)');
      return;
    }
    log.log('[ntfy] SSE kaynağı:', ntfyBaseUrl, 'konu:', ntfyTopic);
    void consumeNtfy({
      baseUrl: ntfyBaseUrl,
      topic: ntfyTopic,
      key: ntfyKey,
      signal: ntfyAbort.signal,
      reconnectMs: ntfyReconnectMs,
      onEvent: async (box) => {
        ntfyRuntime.messages += 1;
        const normalized = normalizeIncoming(box, 'ntfy');
        if (normalized.error) {
          ntfyRuntime.rejected += 1;
          ntfyRuntime.lastError = normalized.error;
          return;
        }
        try {
          const result = await upsertAndPublish(normalized);
          ntfyRuntime.lastMessageAt = Date.now();
          if (result.duplicate) ntfyRuntime.duplicates += 1;
          else ntfyRuntime.accepted += 1;
        } catch (error) {
          if (!(error instanceof ValidationError)) log.error('[ntfy event]', error.message);
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
        log.error('[ntfy]', error.message);
      }
    });
  }

  function stopNtfy() {
    ntfyAbort.abort();
    ntfyRuntime.connected = false;
  }

  async function close() {
    clearInterval(heartbeat);
    stopNtfy();
    tiktoolSource.stop();
    sseClients.forEach((client) => {
      try { client.end(); } catch { /* bağlantı zaten kapanmış */ }
    });
    sseClients.clear();
    wss.clients.forEach((client) => client.close(1001, 'server_shutdown'));
    wss.close();
  }

  return {
    server,
    ntfyRuntime,
    broadcast: broadcastLocal,
    publishUpdate,
    startNtfy,
    startTiktool: () => tiktoolSource.start(),
    tiktoolRuntime,
    close
  };
}
