import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../local/api/src/api.js';
import { envelopeToBox, createTiktoolSource } from '../local/api/src/tiktool.js';
import { canonicalBoxId } from '../local/api/src/ingest.js';
import { createMemoryStore } from './helpers/memory-store.mjs';

const OPEN = 1_800_000_000_000;

function fakeFactory() {
  const clients = [];
  return {
    clients,
    create(uniqueId) {
      const handlers = new Map();
      const client = {
        uniqueId,
        disconnected: false,
        on(name, handler) {
          if (!handlers.has(name)) handlers.set(name, []);
          handlers.get(name).push(handler);
          return client;
        },
        emit(name, payload) {
          (handlers.get(name) || []).forEach((handler) => handler(payload));
        },
        async connect() {
          client.emit('connected', { uniqueId });
        },
        disconnect() {
          client.disconnected = true;
        }
      };
      clients.push(client);
      return client;
    }
  };
}

async function waitFor(check, message, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test('envelope gövdesi normalize edilebilir kutuya çevrilir', () => {
  const box = envelopeToBox({
    envelopeInfo: {
      envelopeId: 'env-42',
      businessType: 21,
      diamondCount: 500,
      peopleCount: 25,
      participantCount: 418,
      availableAt: OPEN
    }
  }, '@Ornek', 'room-9');

  assert.equal(box.source, 'tiktool');
  assert.equal(box.creator, 'ornek');
  assert.equal(box.kind, 'bag');
  assert.equal(box.roomId, 'room-9');
  assert.equal(box.envelopeInfo.envelopeId, 'env-42');
  assert.equal(box.envelopeInfo.diamondCount, 500);
  assert.equal(box.envelopeInfo.peopleCount, 25);
  assert.equal(box.envelopeInfo.availableAt, OPEN);

  // businessType 20 sandık; alan adları farklı gövdede de okunur.
  const chest = envelopeToBox({
    envelope_id: 'env-7', business_type: 20, diamond_count: 90, people_count: 3
  }, 'yayinci');
  assert.equal(chest.kind, 'chest');
  assert.equal(chest.envelopeInfo.envelopeId, 'env-7');

  // envelopeId yoksa tahmin edilmez.
  assert.equal(envelopeToBox({ envelopeInfo: { diamondCount: 100 } }, 'u'), null);
  assert.equal(envelopeToBox(null, 'u'), null);
});

test('anahtar veya oda yoksa kaynak kapalıdır', () => {
  const off = createTiktoolSource({ apiKey: '', usernames: ['u'], onBox: async () => {} });
  assert.equal(off.runtime.enabled, false);

  const noRooms = createTiktoolSource({ apiKey: 'key', usernames: [], onBox: async () => {} });
  assert.equal(noRooms.runtime.enabled, false);

  const on = createTiktoolSource({ apiKey: 'key', usernames: ['@U', 'u', ' v '], onBox: async () => {} });
  assert.equal(on.runtime.enabled, true);
  assert.equal(on.runtime.rooms, 2);
});

test('envelope olayı API deposuna tek satır olarak yazılır ve sayılır', { timeout: 10000 }, async (t) => {
  const store = createMemoryStore();
  const factory = fakeFactory();
  const api = createApi({
    store,
    publish: async () => {},
    config: {
      tiktool: { apiKey: 'test-key', usernames: ['ornek'], createClient: factory.create }
    },
    log: { log() {}, error() {} }
  });
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  let closed = false;
  t.after(async () => {
    if (!closed) await api.close();
    if (api.server.listening) await new Promise((resolve) => api.server.close(resolve));
  });

  assert.equal(api.tiktoolRuntime.enabled, true);
  api.startTiktool();

  await waitFor(() => factory.clients.length === 1, 'istemci oluşturulmadı');
  await waitFor(() => api.tiktoolRuntime.connected === 1, 'bağlantı sayılmadı');

  const payload = {
    envelopeInfo: {
      envelopeId: 'abc123',
      businessType: 21,
      diamondCount: 500,
      peopleCount: 25,
      participantCount: 418,
      availableAt: OPEN
    }
  };
  factory.clients[0].emit('envelope', payload);
  await waitFor(() => api.tiktoolRuntime.boxes === 1, 'kutu yazılmadı');

  const snapshot = await (await fetch(`${base}/api/events`)).json();
  assert.equal(snapshot.events.length, 1);
  const [event] = snapshot.events;
  assert.equal(event.kind, 'bag');
  assert.equal(event.creator, 'ornek');
  assert.equal(event.total_coins, 500);
  assert.equal(event.winner_count, 25);
  assert.equal(event.participant_count, 418);
  assert.equal(event.opens_at_ms, OPEN);
  assert.equal(event.id, canonicalBoxId({
    kind: 'bag', room_id: 'room-9', creator: 'ornek',
    total_coins: 500, winner_count: 25, opens_at_ms: OPEN,
    source_event_id: 'ornek-env-abc123'
  }));

  // Aynı kutu ikinci kez: satır bölünmez, kaynak sayacı artar.
  factory.clients[0].emit('envelope', payload);
  await waitFor(() => api.tiktoolRuntime.boxes === 2, 'yinelenen olay sayılmadı');
  const again = await (await fetch(`${base}/api/events`)).json();
  assert.equal(again.events.length, 1);

  // Tanınmayan gövde reddedilir.
  factory.clients[0].emit('envelope', { foo: 'bar' });
  await waitFor(() => api.tiktoolRuntime.rejected === 1, 'reddedilen olay sayılmadı');

  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(stats.tiktool.events, 3);
  assert.equal(stats.tiktool.boxes, 2);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.tiktool.enabled, true);
  assert.equal(health.tiktool.rooms, 1);
  assert.equal(health.tiktool.connected, 1);
  assert.equal(health.tiktool.events, 3);
  assert.equal(health.tiktool.boxes, 2);
  assert.equal(health.tiktool.rejected, 1);

  await api.close();
  closed = true;
  assert.equal(factory.clients[0].disconnected, true);
});
