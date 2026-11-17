import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalBoxId,
  canonicalBoxKey,
  normalizeIncoming,
  tokenMatches
} from '../local/api/src/ingest.js';
import { parseSseBlock } from '../local/api/src/ntfy.js';

const OPEN = 1_700_000_000_000;

test('ham TikTok yakalaması chest olayına normalize edilir', () => {
  const event = normalizeIncoming({
    username: '@Ornek',
    event: 'envelope',
    envelopeInfo: {
      businessType: 20,
      diamondCount: 51,
      envelopeId: 'abc123',
      secondsUntilOpen: 60,
      peopleCount: 36
    }
  }, 'ingest');

  assert.equal(event.error, undefined);
  assert.equal(event.kind, 'chest');
  assert.equal(event.creator, 'ornek');
  assert.equal(event.total_coins, 51);
  assert.equal(event.winner_count, 36);
  assert.equal(event.event_label, 'Sandık');
  assert.ok(event.opens_at_ms > Date.now());
  assert.equal(event.source_event_id, 'ornek-env-abc123');
  assert.equal(event.source, 'ingest');
});

test('collector ve ntfy aynı kutu için aynı kanonik kimliği üretir', () => {
  const collector = normalizeIncoming({
    id: 'scanner:ornek-env-abc123',
    kind: 'bag',
    room_id: 'room-1',
    creator: 'ornek',
    total_coins: 500,
    winner_count: 25,
    participant_count: 418,
    opens_at_ms: OPEN
  }, 'boxes');

  const ntfy = normalizeIncoming({
    id: 'ornek-env-abc123',
    kind: 'letter',
    roomId: 'room-1',
    username: 'ornek',
    coins: 500,
    shared: 25,
    participants: 418,
    unpackAt: OPEN
  }, 'ntfy');

  assert.equal(canonicalBoxKey(collector), canonicalBoxKey(ntfy));
  assert.equal(canonicalBoxId(collector), canonicalBoxId(ntfy));
  assert.equal(collector.kind, 'bag');
  assert.equal(ntfy.kind, 'bag');
});

test('aynı kaynak kimliği değer güncellemesinde de tek kayıt kalır', () => {
  const a = normalizeIncoming({
    id: 'scanner:u-env-1',
    kind: 'chest',
    room_id: 'r',
    creator: 'u',
    total_coins: 100,
    winner_count: 10,
    opens_at_ms: OPEN
  }, 'boxes');
  const b = normalizeIncoming({
    id: 'u-env-1',
    kind: 'chest',
    room_id: 'r',
    creator: 'u',
    total_coins: 101,
    winner_count: 10,
    opens_at_ms: OPEN
  }, 'ntfy');
  const c = normalizeIncoming({
    id: 'u-env-2',
    kind: 'chest',
    room_id: 'r',
    creator: 'u',
    total_coins: 101,
    winner_count: 10,
    opens_at_ms: OPEN
  }, 'ntfy');

  assert.equal(canonicalBoxId(a), canonicalBoxId(b));
  assert.notEqual(canonicalBoxId(a), canonicalBoxId(c));
});

test('portal ve kimliksiz kayıt reddedilir', () => {
  const portal = normalizeIncoming({ username: 'u', businessType: 9, coins: 100 }, 'ingest');
  const anonymous = normalizeIncoming({ kind: 'chest', coins: 100 }, 'ingest');

  assert.match(portal.error, /desteklenmeyen/);
  assert.match(anonymous.error, /creator/);
});

test('token karşılaştırması yalnızca tam eşleşmeyi kabul eder', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('', 'abd'), false);
  assert.equal(tokenMatches('abc', ''), false);
});

test('SSE data bloğu JSON olarak ayrıştırılır', () => {
  const parsed = parseSseBlock([
    'event: message',
    'data: {"id":"ntfy-1","message":"{\\"id\\":\\"box-1\\"}"}'
  ].join('\n'));

  assert.deepEqual(parsed, {
    id: 'ntfy-1',
    message: '{"id":"box-1"}'
  });
  assert.equal(parseSseBlock('event: keepalive'), null);
});
