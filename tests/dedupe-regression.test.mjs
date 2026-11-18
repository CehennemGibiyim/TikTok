/*
 * Dedupe regresyon testi: gerçek yakalama biçimlerinden derlenmiş küçük bir
 * fikstürü normalize + upsert hattından geçirir.
 *
 * Fikstür satırları tools/ingest/sample-capture.ndjson ve scanner/collector
 * çıktısındaki gerçek alan adlarını taşır. Her kayıt kendi beklenen sonucunu
 * (`accepted`/`duplicates`) yanında getirir; test sonunda satır, split ve
 * çakışma sayıları da doğrulanır. Böylece tolerans veya kimlik kurallarındaki
 * değişiklikler sessizce geçemez.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApi } from '../local/api/src/api.js';
import { createMemoryStore } from './helpers/memory-store.mjs';

const TOKEN = 'test-token-' + 'b'.repeat(24);
const FIXTURE = new URL('./fixtures/captured-dedupe.ndjson', import.meta.url);

const OPEN = 1_800_000_060_000; // ilk yakalamanın açılış anı

function loadFixture() {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startApi(t) {
  const store = createMemoryStore();
  const api = createApi({
    store,
    config: { ingestToken: TOKEN, ntfy: null },
    publish: async () => {},
    log: { log() {}, error() {} }
  });
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  t.after(async () => {
    await api.close();
    if (api.server.listening) await new Promise((resolve) => api.server.close(resolve));
  });
  return { api, store, base };
}

function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test('gerçek yakalama fikstürü beklenen satır/split/çakışma sayılarını verir', { timeout: 15000 }, async (t) => {
  const records = loadFixture();
  assert.ok(records.length >= 5, 'fikstür yeterli kayıt içermeli');
  const { base } = await startApi(t);

  for (const [index, record] of records.entries()) {
    if (record.route === 'ingest') {
      const response = await post(base, '/ingest', record.body, { 'x-ingest-key': TOKEN });
      assert.ok([200, 201].includes(response.status), `kayıt ${index + 1}: /ingest başarılı dönmeli`);
      const data = await response.json();
      assert.deepEqual(data.errors, [], `kayıt ${index + 1}: doğrulama hatası olmamalı`);
      assert.equal(data.accepted, record.expect.accepted, `kayıt ${index + 1}: accepted`);
      assert.equal(data.duplicates, record.expect.duplicates, `kayıt ${index + 1}: duplicates`);
    } else {
      const response = await post(base, '/api/events', [record.event]);
      assert.ok([200, 201].includes(response.status), `kayıt ${index + 1}: /api/events başarılı dönmeli`);
      const data = await response.json();
      assert.equal(data.saved.length, 1, `kayıt ${index + 1}: tek satır işlenmeli`);
      assert.equal(data.duplicates, record.expect.duplicates, `kayıt ${index + 1}: duplicates`);
    }
  }

  // Aynı sandık üç taşıma yolundan (ham mitm, collector, ntfy) ve kimliksiz
  // yazmayla geldi; zarf ise iki yoldan geldi. İki kutu, iki satır.
  const snapshot = await (await fetch(`${base}/api/events`)).json();
  assert.equal(snapshot.events.length, 2);

  const chest = snapshot.events.find((event) => event.creator === 'ornek_yayinci');
  const bag = snapshot.events.find((event) => event.creator === 'zarf_ornegi');
  assert.ok(chest && bag, 'iki yayıncının kutusu da görünmeli');

  assert.equal(chest.kind, 'chest');
  assert.equal(chest.room_id, 'room-1');
  assert.equal(chest.total_coins, 51);
  assert.equal(chest.winner_count, 36);
  assert.equal(chest.opens_at_ms, OPEN, 'açılış ilk yakalanan değerde sabitlenmeli');
  assert.match(chest.id, /^box:[0-9a-f]{24}$/);

  assert.equal(bag.kind, 'bag');
  assert.equal(bag.total_coins, 30);
  assert.equal(bag.winner_count, 10);
  assert.equal(bag.opens_at_ms, OPEN + 30_000);
  assert.match(bag.id, /^box:[0-9a-f]{24}$/);

  // 7 yazma, 2 satır: hiçbir yazma ikinci satır açmamış olmalı. Kimliksiz
  // yazma farklı bir kimlik üretip aynı satıra birleştiği için tek split
  // kanıtı bırakır; düzeltilmiş açılış ise tek çakışmadır.
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(stats.identity.rows, records.length);
  assert.equal(stats.identity.splitRows, 1);
  assert.equal(stats.identity.keyCollisions, 1);
  assert.deepEqual(
    stats.identity.samples.map((sample) => sample.type),
    ['split_rows', 'key_collision']
  );

  const split = stats.identity.samples[0];
  assert.equal(split.ids.length, 2);
  assert.deepEqual(split.sources, ['ingest', 'boxes']);
  assert.equal(split.timeDeltaMs, 5000);
  assert.equal(split.toleranceMs, 5000);

  const collision = stats.identity.samples[1];
  assert.match(collision.id, /^box:[0-9a-f]{24}$/);
  assert.equal(collision.before.creator, 'ornek_yayinci');
  assert.deepEqual(collision.changed, ['opens_at_ms']);
  assert.equal(collision.before.source, 'ingest');
  assert.equal(collision.after.source, 'ingest');

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health.identity, { rows: records.length, keyCollisions: 1, splitRows: 1 });
});
