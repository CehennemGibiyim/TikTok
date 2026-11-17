const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeBox, rankBoxes } = require('../site/firsat/box-math.js');

function close(actual, expected, epsilon) {
  const tolerance = epsilon === undefined ? 1e-9 : epsilon;
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    'expected ' + expected + ', got ' + actual
  );
}

test('Goody Bag: W/N olasılığı ve T/max(N,W) beklenen jeton', () => {
  const result = analyzeBox({
    id: 'bag-1',
    kind: 'letter',
    coins: 500,
    shared: 25,
    participants: 418,
    unpackAt: 1000,
    expiresAt: 2000
  });

  assert.equal(result.kind, 'bag');
  assert.equal(result.totalCoins, 500);
  assert.equal(result.winnerCount, 25);
  assert.equal(result.participantCount, 418);
  assert.equal(result.expectedPerWinner, 20);
  close(result.winProbability, 25 / 418);
  close(result.expectedCoins, 500 / 418);
  close(result.bagDensity, 500 / 418);
  assert.equal(result.windowKnown, true);
  assert.equal(result.confidence, 'low');
});

test('Goody Bag: W >= N ise olasılık 1, beklenen T/W', () => {
  const result = analyzeBox({
    id: 'bag-2',
    kind: 'bag',
    coins: 100,
    shared: 10,
    participants: 4
  });

  assert.equal(result.winProbability, 1);
  assert.equal(result.expectedPerWinner, 10);
  assert.equal(result.expectedCoins, 10);
  assert.equal(result.bagDensity, 25);
  assert.ok(result.warnings.includes('winner_slots_ge_participants'));
});

test('Goody Bag: katılımcı yoksa olasılık ve beklenen jeton null', () => {
  const result = analyzeBox({
    id: 'bag-3',
    kind: 'letter',
    coins: 500,
    shared: 25,
    participants: 0
  });

  assert.equal(result.winProbability, null);
  assert.equal(result.probabilityReason, 'missing_participants');
  assert.equal(result.expectedCoins, null);
  assert.equal(result.expectedPerWinner, 20);
  assert.equal(result.bagDensity, null);
});

test('Goody Bag: kazanan slotu yoksa oran üretilmez', () => {
  const result = analyzeBox({
    id: 'bag-4',
    kind: 'letter',
    coins: 500,
    shared: 0,
    participants: 10
  });

  assert.equal(result.winProbability, null);
  assert.equal(result.probabilityReason, 'missing_winner_count');
  assert.equal(result.expectedCoins, null);
  assert.equal(result.expectedPerWinner, null);
  assert.equal(result.bagDensity, 50);
});

test('Chest: katılımcı alanı gelse bile olasılık/katılım başına beklenti üretilmez', () => {
  const result = analyzeBox({
    id: 'chest-1',
    kind: 'chest',
    coins: 210,
    shared: 120,
    participants: 50
  });

  assert.equal(result.kind, 'chest');
  assert.equal(result.winProbability, null);
  assert.equal(result.probabilityReason, 'chest_participant_count_not_canonical');
  assert.equal(result.expectedCoins, null);
  assert.equal(result.expectedPerWinner, 1.75);
  assert.ok(result.warnings.includes('chest_participants_ignored'));
});

test('Portal ve bilinmeyen tür için değer formülü üretilmez', () => {
  const portal = analyzeBox({
    id: 'portal-1',
    kind: 'portal',
    coins: 100,
    shared: 10,
    participants: 5
  });
  const unknown = analyzeBox({ id: 'unknown-1', kind: 'other' });

  assert.equal(portal.winProbability, null);
  assert.equal(portal.expectedCoins, null);
  assert.equal(portal.expectedPerWinner, null);
  assert.equal(portal.probabilityReason, 'unsupported_kind');
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.expectedCoins, null);
  assert.equal(unknown.startAt, null);
});

test('Eksik alanlar NaN veya Infinity üretmez, girdiyi değiştirmez', () => {
  const input = { id: 'empty', kind: 'letter' };
  const before = JSON.stringify(input);
  const result = analyzeBox(input);

  assert.equal(result.totalCoins, null);
  assert.equal(result.winnerCount, null);
  assert.equal(result.participantCount, null);
  assert.equal(result.winProbability, null);
  assert.equal(result.expectedCoins, null);
  assert.equal(result.expectedPerWinner, null);
  assert.equal(result.bagDensity, null);
  assert.equal(JSON.stringify(input), before);
});

test('Çakışma sırası: açılış, kapanış, değer ve grup', () => {
  const boxes = [
    { id: 'a', kind: 'letter', coins: 100, shared: 10, participants: 20, unpackAt: 1000, expiresAt: 5000 },
    { id: 'b', kind: 'letter', coins: 200, shared: 10, participants: 20, unpackAt: 4000, expiresAt: 8000 },
    { id: 'c', kind: 'letter', coins: 50, shared: 5, participants: 10, unpackAt: 5000, expiresAt: 9000 },
    { id: 'd', kind: 'chest', coins: 10, shared: 1, unpackAt: 9000, expiresAt: 10000 }
  ];

  const ranked = rankBoxes(boxes);
  assert.deepEqual(ranked.map((item) => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2, 3, 4]);
  assert.equal(ranked[0].conflictGroup, 1);
  assert.equal(ranked[1].conflictGroup, 1);
  assert.equal(ranked[2].conflictGroup, 1);
  assert.equal(ranked[3].conflictGroup, 2);
  assert.equal(ranked[0].overlapWithPrevious, null);
  assert.equal(ranked[1].overlapWithPrevious, true);
  assert.equal(ranked[2].overlapWithPrevious, true);
  assert.equal(ranked[3].overlapWithPrevious, false);
  assert.ok(ranked[2].overlapsGroup);
  assert.equal(ranked[3].overlapsGroup, false);
});

test('Çakışma sırası: bilinmeyen pencere sahte çakışma üretmez', () => {
  const boxes = [
    { id: 'unknown', kind: 'letter', coins: 100, shared: 10, participants: 20 },
    { id: 'known', kind: 'letter', coins: 50, shared: 10, participants: 20, unpackAt: 1000, expiresAt: 2000 },
    { id: 'same-start-no-end', kind: 'letter', coins: 70, shared: 10, participants: 20, unpackAt: 1000 }
  ];

  const ranked = rankBoxes(boxes);
  assert.deepEqual(ranked.map((item) => item.id), ['known', 'same-start-no-end', 'unknown']);
  assert.equal(ranked[0].overlapWithPrevious, null);
  assert.equal(ranked[1].sameStartAsPrevious, true);
  // Kendi bitişi bilinmese de bilinen pencerenin içinde açılıyor: kesişim gerçek.
  assert.equal(ranked[1].overlapWithPrevious, true);
  assert.equal(ranked[0].conflictGroup, ranked[1].conflictGroup);
  // Hiç açılış zamanı olmayan kayıt sahte çakışmaya sokulmaz.
  assert.equal(ranked[2].startAt, null);
  assert.equal(ranked[2].overlapWithPrevious, null);
});

test('Gerçek boxes.json: kayıtlar sonlu değerler üretir', () => {
  const data = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../site/firsat/data/boxes.json'),
    'utf8'
  ));
  assert.equal(Array.isArray(data.boxes), true);
  assert.ok(data.boxes.length > 0);

  const analyzed = data.boxes.map((box, index) => analyzeBox(box, index));
  for (const item of analyzed) {
    for (const field of [
      'totalCoins', 'winnerCount', 'participantCount', 'winProbability',
      'expectedCoins', 'expectedPerWinner', 'bagDensity', 'startAt', 'endAt'
    ]) {
      const value = item[field];
      if (value !== null) {
        assert.equal(Number.isFinite(value), true, item.id + ' ' + field + ' = ' + value);
      }
    }
  }

  const chest = analyzed.find((item) => item.kind === 'chest' && item.expectedPerWinner !== null);
  if (chest) {
    assert.equal(chest.winProbability, null);
    assert.equal(chest.expectedCoins, null);
  }

  const ranked = rankBoxes(data.boxes);
  assert.equal(ranked.length, data.boxes.length);
  assert.deepEqual(
    ranked.map((item) => item.rank),
    Array.from({ length: data.boxes.length }, (_, i) => i + 1)
  );
});
