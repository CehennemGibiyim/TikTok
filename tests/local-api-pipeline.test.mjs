/*
 * Gerçek API seviyesinde akış testi: collector (POST /api/events), /ingest ve
 * ntfy SSE kaynağı aynı kutuyu ürettiğinde tek kayıt kalmalı.
 *
 * Postgres/Redis gerekmez: API'ye bellek içi depo enjekte edilir, ntfy yerine
 * aynı SSE sözleşmesini konuşan yerel bir sunucu çalışır.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApi } from '../local/api/src/api.js';
import { canonicalBoxId, canonicalBoxKey } from '../local/api/src/ingest.js';
import { createMemoryStore } from './helpers/memory-store.mjs';

const TOKEN = 'test-token-' + 'a'.repeat(24);

function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

async function waitFor(check, message, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function startApi(t, { ingestToken = TOKEN, ntfy = null, log } = {}) {
  const store = createMemoryStore();
  const api = createApi({
    store,
    config: { ingestToken, ntfy },
    publish: async () => {},
    log: log || { log() {}, error() {} }
  });
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  t.after(async () => {
    await api.close();
    if (api.server.listening) await new Promise((resolve) => api.server.close(resolve));
  });
  return { api, store, base };
}

// ntfy.sh'in SSE sözleşmesini taklit eder: {event:"message", message:"{...}"}
async function startFakeNtfy(t, boxes) {
  const server = http.createServer((req, res) => {
    if (!String(req.url).endsWith('/sse')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n');
    for (const box of boxes) {
      res.write('event: message\ndata: ' + JSON.stringify({
        event: 'message',
        message: JSON.stringify(box)
      }) + '\n\n');
    }
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(ping));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('collector, /ingest ve ntfy aynı kutuyu tek kayıtta birleştirir', { timeout: 15000 }, async (t) => {
  const OPEN = Math.floor(Date.now() / 1000) * 1000 + 120_000;
  const ntfyBaseUrl = await startFakeNtfy(t, [{
    key: 'test-key',
    id: 'ornek-env-abc123',
    kind: 'letter',
    roomId: 'room-1',
    username: 'Ornek',
    coins: 500,
    shared: 25,
    participants: 418,
    unpackAt: OPEN
  }]);
  const { api, base } = await startApi(t, {
    ntfy: { baseUrl: ntfyBaseUrl, topic: 'radar-test', key: 'test-key', reconnectMs: 10000 }
  });

  // 1) Collector yolu: scanner kimliği `scanner:` önekiyle POST /api/events'e gelir.
  const collector = await (await post(base, '/api/events', [{
    id: 'scanner:ornek-env-abc123',
    source: 'boxes',
    kind: 'bag',
    room_id: 'room-1',
    creator: 'ornek',
    total_coins: 500,
    winner_count: 25,
    participant_count: 418,
    opens_at_ms: OPEN
  }])).json();
  assert.equal(collector.saved.length, 1);
  assert.equal(collector.duplicates, 0);

  // 2) /ingest yolu: ham TikTok yakalamasında yalnızca envelopeId vardır.
  const ingestResponse = await post(base, '/ingest', {
    username: '@Ornek',
    event: 'envelope',
    envelopeInfo: {
      businessType: 21,
      diamondCount: 500,
      peopleCount: 25,
      envelopeId: 'abc123',
      availableAt: OPEN
    }
  }, { 'x-ingest-key': TOKEN });
  assert.equal(ingestResponse.status, 200);
  const ingest = await ingestResponse.json();
  assert.deepEqual(ingest.errors, []);
  assert.equal(ingest.duplicates, 1);
  assert.equal(ingest.accepted, 0);

  // 3) ntfy yolu: kaynak kendi SSE akışından, doğru anahtarla.
  api.startNtfy();
  await waitFor(
    () => api.ntfyRuntime.duplicates === 1,
    'ntfy kaydı aynı kutu olarak eşleşmedi'
  );

  const snapshot = await (await fetch(`${base}/api/events`)).json();
  assert.equal(snapshot.events.length, 1);
  const [event] = snapshot.events;
  assert.match(event.id, /^box:[0-9a-f]{24}$/);
  assert.equal(event.creator, 'ornek');
  assert.equal(event.kind, 'bag');
  assert.equal(event.total_coins, 500);
  assert.equal(event.winner_count, 25);
  assert.equal(event.participant_count, 418);
  assert.equal(event.opens_at_ms, OPEN);

  // Üç kaynak da aynı kanonik kimliği hesaplamış olmalı.
  assert.equal(event.id, canonicalBoxId({
    kind: 'bag',
    room_id: 'room-1',
    creator: 'ornek',
    total_coins: 500,
    winner_count: 25,
    opens_at_ms: OPEN,
    source_event_id: 'ornek-env-abc123'
  }));

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ntfy.accepted, 0);
  assert.equal(health.ntfy.duplicates, 1);
  assert.equal(health.ntfy.rejected, 0);
});

test('aynı kaynak kimliği değer güncellemesinde tek satırda birleşir', { timeout: 10000 }, async (t) => {
  const OPEN = Math.floor(Date.now() / 1000) * 1000 + 120_000;
  const { base } = await startApi(t);
  const baseEvent = {
    id: 'scanner:u-env-1',
    source: 'boxes',
    kind: 'chest',
    room_id: 'r',
    creator: 'u',
    opens_at_ms: OPEN
  };

  // ntfy/collector önce 0 jetonla gelebilir; sonraki değer eskisini ezmeli.
  const first = await (await post(base, '/api/events', [{ ...baseEvent, total_coins: 0, winner_count: 0 }])).json();
  assert.equal(first.duplicates, 0);
  const second = await (await post(base, '/api/events', [{ ...baseEvent, total_coins: 210, winner_count: 10 }])).json();
  assert.equal(second.duplicates, 1);

  const snapshot = await (await fetch(`${base}/api/events`)).json();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].total_coins, 210);
  assert.equal(snapshot.events[0].winner_count, 10);
  assert.equal(snapshot.events[0].ratio, 21);
});

test('kaynak kimliği kenar durumları ve içerik parmak izi aynı satırı korur', { timeout: 10000 }, async (t) => {
  const OPEN = Math.floor(Date.now() / 1000) * 1000 + 120_000;
  const { base } = await startApi(t);
  const postBox = (id) => post(base, '/api/events', [{
    id,
    source: 'boxes',
    kind: 'chest',
    room_id: 'r',
    creator: 'u',
    total_coins: 100,
    winner_count: 10,
    opens_at_ms: OPEN
  }]);

  const ids = [];
  for (const id of ['scanner:u-env-1', '  scanner:u-env-1  ', 'SCANNER:u-env-1', 'u-env-1']) {
    const data = await (await postBox(id)).json();
    assert.equal(data.saved.length, 1);
    ids.push(data.saved[0].id);
  }
  assert.equal(new Set(ids).size, 1, 'önek/büyük harf/boşluk farkı aynı kutuya düşmeli');

  // Farklı kaynak kimliği aynı içerikle gelirse parmak izi ikinci satırı engeller.
  const other = await (await postBox('u-env-2')).json();
  assert.equal(other.duplicates, 1);
  assert.equal(other.saved[0].id, ids[0]);

  // Küçük zaman farkı (≤5 sn) da aynı kutuya düşer.
  const close = await (await postBox('u-env-4')).json();
  assert.equal(close.duplicates, 1);
  assert.equal(close.saved[0].id, ids[0]);

  // Tolerans dışındaki açılış gerçekten ayrı kutudur.
  const far = await (await post(base, '/api/events', [{
    id: 'scanner:u-env-3', source: 'boxes', kind: 'chest', room_id: 'r', creator: 'u',
    total_coins: 100, winner_count: 10, opens_at_ms: OPEN + 60_000
  }])).json();
  assert.equal(far.duplicates, 0);
  assert.notEqual(far.saved[0].id, ids[0]);

  // Yalnızca boşluktan oluşan kimlik içerik anahtarına düşer; aynı kutu tek satır kalır.
  const blank1 = await (await postBox('   ')).json();
  const blank2 = await (await postBox('   ')).json();
  assert.equal(blank2.duplicates, 1);
  assert.equal(blank1.saved[0].id, ids[0]);
  assert.equal(blank2.saved[0].id, ids[0]);

  // source yoksa (manuel ekleme) verilen kimlik korunur.
  const manual = await (await post(base, '/api/events', [{
    id: 'manual-1', kind: 'bag', creator: 'u', total_coins: 10, winner_count: 5, opens_at_ms: OPEN
  }])).json();
  assert.equal(manual.saved[0].id, 'manual-1');
});

test('içerik parmak izi zaman toleransını ve kutu sınırlarını uygular', { timeout: 10000 }, async (t) => {
  const OPEN = Math.floor(Date.now() / 1000) * 1000 + 120_000 + 100;
  const { base } = await startApi(t);
  const postBox = (extra = {}) => post(base, '/api/events', [{
    source: 'boxes',
    kind: 'chest',
    room_id: 'r1',
    creator: 'U',
    total_coins: 100,
    winner_count: 10,
    opens_at_ms: OPEN,
    ...extra
  }]);

  const first = await (await postBox()).json();
  assert.equal(first.duplicates, 0);

  // Aynı saniyedeki milisaniye farkı aynı kutu sayılır.
  const sameSecond = await (await postBox({ opens_at_ms: OPEN + 250 })).json();
  assert.equal(sameSecond.duplicates, 1);
  assert.equal(sameSecond.saved[0].id, first.saved[0].id);

  // Tolerans içindeki (≤5 sn) farklar da tek satırda birleşir.
  const near = await (await postBox({ opens_at_ms: OPEN + 1000 })).json();
  const boundary = await (await postBox({ opens_at_ms: OPEN + 5000 })).json();
  for (const data of [near, boundary]) {
    assert.equal(data.duplicates, 1);
    assert.equal(data.saved[0].id, first.saved[0].id);
  }

  // Tolerans dışı, farklı tür ve farklı oda ayrı satırdır.
  const beyond = await (await postBox({ opens_at_ms: OPEN + 6000 })).json();
  const otherKind = await (await postBox({ kind: 'bag' })).json();
  const otherRoom = await (await postBox({ room_id: 'r2' })).json();
  for (const data of [beyond, otherKind, otherRoom]) {
    assert.equal(data.duplicates, 0);
    assert.notEqual(data.saved[0].id, first.saved[0].id);
  }

  // Jeton/kontenjan farkı ve yayıncı büyük/küçük harf farkı kimliği bölmez.
  const otherCoins = await (await postBox({ total_coins: 101 })).json();
  const caseVariant = await (await postBox({ creator: 'u' })).json();
  for (const data of [otherCoins, caseVariant]) {
    assert.equal(data.duplicates, 1);
    assert.equal(data.saved[0].id, first.saved[0].id);
  }

  const snapshot = await (await fetch(`${base}/api/events`)).json();
  assert.equal(snapshot.events.length, 4);
});

test('/ingest yetkisi, kapalı giriş ve desteklenmeyen kutu API seviyesinde reddedilir', { timeout: 10000 }, async (t) => {
  const { base } = await startApi(t);
  const payload = { username: 'u', businessType: 20, coins: 100 };

  const noKey = await post(base, '/ingest', payload);
  assert.equal(noKey.status, 401);

  const badJson = await post(base, '/ingest', 'bu json değil', { 'x-ingest-key': TOKEN });
  assert.equal(badJson.status, 400);

  const portal = await post(base, '/ingest', { username: 'u', businessType: 9, coins: 100 }, { 'x-ingest-key': TOKEN });
  assert.equal(portal.status, 400);
  const portalBody = await portal.json();
  assert.match(portalBody.errors[0].error, /desteklenmeyen/);
  assert.deepEqual(portalBody.events, []);

  const anonymous = await post(base, '/ingest', { kind: 'chest', coins: 100 }, { 'x-ingest-key': TOKEN });
  assert.equal(anonymous.status, 400);
  assert.match((await anonymous.json()).errors[0].error, /creator/);

  const disabled = await startApi(t, { ingestToken: '' });
  const disabledResponse = await post(disabled.base, '/ingest', payload, { 'x-ingest-key': TOKEN });
  assert.equal(disabledResponse.status, 503);
  assert.equal((await disabledResponse.json()).error, 'ingest_disabled');
});

test('kanonik anahtar yardımcıları kimlik/içerik sınırlarını ayırır', () => {
  const OPEN = 1_800_000_000_000;

  // Önek, boşluk ve büyük harf farkı aynı anahtara iner.
  const variants = [
    'scanner:u-env-1',
    ' u-env-1 ',
    'SCANNER:u-env-1'
  ].map((id) => canonicalBoxKey({ source_event_id: id }));
  assert.deepEqual(new Set(variants), new Set(['id|u-env-1']));

  // Yalnızca önekten oluşan kimlik boş sayılır; içerik anahtarına düşer.
  assert.equal(
    canonicalBoxKey({ source_event_id: 'scanner:', creator: 'U', opens_at_ms: OPEN, room_id: 'r1' }),
    canonicalBoxKey({ creator: 'u', opens_at_ms: OPEN, room_id: 'r1' })
  );

  // İçerik anahtarı için yayıncı ve açılış zorunlu.
  assert.equal(canonicalBoxKey({ room_id: 'r1' }), null);
  assert.equal(canonicalBoxKey({ creator: 'u', opens_at_ms: 0 }), null);
  assert.equal(canonicalBoxId({ creator: 'u' }), null);

  // Aynı içerik aynı hash'i, farklı saniye farklı hash'i üretir.
  const base = { creator: 'u', opens_at_ms: OPEN + 100, room_id: 'r1', kind: 'chest', total_coins: 100, winner_count: 10 };
  assert.equal(canonicalBoxId(base), canonicalBoxId({ ...base, opens_at_ms: OPEN + 250, creator: '@U' }));
  assert.notEqual(canonicalBoxId(base), canonicalBoxId({ ...base, opens_at_ms: OPEN + 1100 }));
});

test('farklı kimlikli aynı kutu tek satır açar; çakışma sayaçlanır', { timeout: 10000 }, async (t) => {
  const OPEN = Math.floor(Date.now() / 1000) * 1000 + 300_000;
  const { base, store } = await startApi(t);

  // Aynı kutu, iki farklı kaynak kimliği ve 3 sn farklı açılış: ikinci yazma
  // yeni satır açmaz, parmak iziyle mevcut satıra birleşir.
  const pair = await (await post(base, '/api/events', [
    {
      id: 'scanner:ikiz-env-1', source: 'boxes', kind: 'chest', room_id: 'r9',
      creator: 'ikiz', total_coins: 100, winner_count: 10, opens_at_ms: OPEN
    },
    {
      id: 'ikiz-env-2', source: 'ntfy', kind: 'chest', room_id: 'r9',
      creator: 'ikiz', total_coins: 120, winner_count: 10, opens_at_ms: OPEN + 3000
    }
  ])).json();
  assert.equal(pair.saved.length, 2);
  assert.equal(pair.duplicates, 1);
  assert.equal(pair.saved[0].id, pair.saved[1].id);
  assert.equal(store.rows.size, 1);

  // Aynı kaynak kimliği, farklı açılış: iki kutu tek satıra düşer (çakışma).
  await post(base, '/api/events', [{
    id: 'scanner:cat-env-1', source: 'boxes', kind: 'chest', room_id: 'r9',
    creator: 'cat', total_coins: 50, winner_count: 5, opens_at_ms: OPEN
  }]);
  await post(base, '/api/events', [{
    id: 'cat-env-1', source: 'ntfy', kind: 'chest', room_id: 'r9',
    creator: 'cat', total_coins: 50, winner_count: 5, opens_at_ms: OPEN + 60_000
  }]);

  const payload = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(payload.identity.rows, 4);
  assert.equal(payload.identity.splitRows, 1);
  assert.equal(payload.identity.keyCollisions, 1);
  assert.deepEqual(
    payload.identity.samples.map((sample) => sample.type),
    ['split_rows', 'key_collision']
  );

  const split = payload.identity.samples[0];
  assert.equal(split.ids.length, 2);
  assert.deepEqual(split.sources, ['boxes', 'ntfy']);
  assert.equal(split.timeDeltaMs, 3000);
  assert.equal(split.toleranceMs, 5000);

  const collision = payload.identity.samples[1];
  assert.deepEqual(collision.changed, ['opens_at_ms']);
  assert.equal(collision.before.source, 'boxes');
  assert.equal(collision.after.source, 'ntfy');

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health.identity, { rows: 4, keyCollisions: 1, splitRows: 1 });
});

test('bulgular süreç günlüğüne tek satır kanıt olarak yazılır', { timeout: 10000 }, async (t) => {
  const OPEN = Math.floor(Date.now() / 1000) * 1000 + 600_000;
  const lines = [];
  const { base } = await startApi(t, {
    log: { log() {}, error() {}, warn: (...args) => lines.push(args.join(' ')) }
  });

  // 1) Aynı kutu iki kimlikle: ikinci satır açılmaz ama split kanıtı yazılır.
  await post(base, '/api/events', [
    {
      id: 'ikiz-env-1', source: 'boxes', kind: 'chest', room_id: 'r7',
      creator: 'ikiz', total_coins: 100, winner_count: 10, opens_at_ms: OPEN
    },
    {
      id: 'ikiz-env-2', source: 'ntfy', kind: 'chest', room_id: 'r7',
      creator: 'ikiz', total_coins: 110, winner_count: 10, opens_at_ms: OPEN + 3000
    }
  ]);
  assert.equal(lines.length, 1, 'birleşen iki kimlik split kanıtı üretmeli');

  // 2) Aynı kimlik, farklı açılış → key_collision kanıtı.
  await post(base, '/api/events', [{
    id: 'cat-env-1', source: 'boxes', kind: 'chest', room_id: 'r7',
    creator: 'cat', total_coins: 50, winner_count: 5, opens_at_ms: OPEN
  }]);
  await post(base, '/api/events', [{
    id: 'cat-env-1', source: 'ntfy', kind: 'chest', room_id: 'r7',
    creator: 'cat', total_coins: 50, winner_count: 5, opens_at_ms: OPEN + 60_000
  }]);

  // 3) Sıradan değer güncellemesi günlüğe yeni satır eklemez.
  await post(base, '/api/events', [{
    id: 'ikiz-env-1', source: 'boxes', kind: 'chest', room_id: 'r7',
    creator: 'ikiz', total_coins: 300, winner_count: 10, opens_at_ms: OPEN
  }]);

  assert.equal(lines.length, 2, 'split ve çakışma ayrı ayrı günlüğe yazılmalı');
  assert.ok(lines.every((line) => line.startsWith('[identity] {')), 'satırlar [identity] JSON biçiminde');

  const split = JSON.parse(lines[0].replace(/^\[identity\] /, ''));
  assert.equal(split.type, 'split_rows');
  assert.equal(split.ids.length, 2);
  assert.equal(split.timeDeltaMs, 3000);
  assert.equal(split.toleranceMs, 5000);

  const collision = JSON.parse(lines[1].replace(/^\[identity\] /, ''));
  assert.equal(collision.type, 'key_collision');
  assert.deepEqual(collision.changed, ['opens_at_ms']);
  assert.equal(collision.before.source, 'boxes');
  assert.equal(collision.after.source, 'ntfy');
});


test('bellek deposu içerik parmak izi tekilliğini uygular', async () => {
  const store = createMemoryStore();
  const OPEN = 1_800_000_000_000;
  const base = {
    kind: 'chest', room_id: 'rf', creator: 'U', total_coins: 100,
    winner_count: 10, opens_at_ms: OPEN
  };

  const first = await store.upsertEvent({ ...base, id: 'manual-1' });
  assert.equal(first.duplicate, false);

  // Farklı kimlik, aynı içerik ve 3 sn fark: aynı satıra birleşir.
  const merged = await store.upsertEvent({ ...base, id: 'manual-2', opens_at_ms: OPEN + 3000 });
  assert.equal(merged.duplicate, true);
  assert.equal(merged.row.id, first.row.id);
  assert.equal(store.rows.size, 1);

  // Tolerans dışı açılış ayrı satır açar.
  const far = await store.upsertEvent({ ...base, id: 'manual-3', opens_at_ms: OPEN + 60_000 });
  assert.equal(far.duplicate, false);
  assert.notEqual(far.row.id, first.row.id);
  assert.equal(store.rows.size, 2);

  // Silme parmak izini de temizler; kutu yeniden eklendiğinde yeni satır olur.
  await store.removeEvent(first.row.id);
  const again = await store.upsertEvent({ ...base, id: 'manual-4' });
  assert.equal(again.duplicate, false);
  assert.equal(again.row.id, 'manual-4');
  assert.equal(store.rows.size, 2);
});
