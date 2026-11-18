'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../site/shared/reward-engine.js');

const NOW = 1_800_000_000_000;

function chest(overrides) {
  return Object.assign({
    id: 'chest-1',
    username: 'creator',
    kind: 'chest',
    coins: 100,
    shared: 25,
    viewers: 10,
    opensAt: NOW + 60_000,
    hasWindow: true
  }, overrides || {});
}

function bag(overrides) {
  return Object.assign({
    id: 'bag-1',
    username: 'creator',
    kind: 'letter',
    coins: 100,
    shared: 25,
    participants: 400,
    viewers: 10,
    opensAt: NOW + 60_000,
    hasWindow: true,
    bagLevel: 3
  }, overrides || {});
}

test('oran jeton / kazanan kontenjanıdır', () => {
  const reward = Engine.normalizeBox(chest({ coins: 100, shared: 25 }), NOW);
  assert.equal(reward.winnerCount, 25);
  assert.equal(Engine.ratio(reward), 4);
});

test('Oran 1 yalnızca jeton = kontenjan eşitliğini ister; 300 jeton sınırı yok', () => {
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 300, shared: 300 }), NOW), 'cr1'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 1000, shared: 1000 }), NOW), 'cr1'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 1000, shared: 999 }), NOW), 'cr1'), false);
});

test('20/16 preseti oran 1.2–1.25 ve en az 20 jeton ister', () => {
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 20, shared: 16 }), NOW), 'c2016'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 24, shared: 20 }), NOW), 'c2016'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 19, shared: 16 }), NOW), 'c2016'), false);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 100, shared: 79 }), NOW), 'c2016'), false);
});

test('şanslı seçimler oran 7 ve üzerini alır', () => {
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 700, shared: 100 }), NOW), 'cluck'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(chest({ coins: 699, shared: 100 }), NOW), 'cluck'), false);
});

test('bekleyen sandık açılış sonrası 15 dakika kalır', () => {
  const reward = Engine.normalizeBox(chest({ opensAt: NOW - 60_000 }), NOW);
  assert.equal(reward.chestStatus, 'hung');
  assert.equal(Engine.matchesPreset(reward, 'chung'), true);
  assert.equal(Engine.matchesPreset(reward, 'cr2'), false);
});

test('zarf seviyeleri 0, 1 ve 2–10 olarak ayrılır', () => {
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(bag({ bagLevel: 0 }), NOW), 'b0'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(bag({ bagLevel: 1 }), NOW), 'b1'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(bag({ bagLevel: 10 }), NOW), 'b2'), true);
  assert.equal(Engine.matchesPreset(Engine.normalizeBox(bag({ bagLevel: 1 }), NOW), 'b2'), false);
});

test('özel filtreler jeton, oran ve izleyici aralığını birlikte uygular', () => {
  const filters = Engine.normalizeFilters({
    minCoins: 50,
    maxCoins: 500,
    minRatio: 2,
    maxRatio: 6,
    minViewers: 5,
    maxViewers: 20
  });
  const good = Engine.normalizeBox(chest({ coins: 100, shared: 25, viewers: 10 }), NOW);
  const tooManyViewers = Engine.normalizeBox(chest({ coins: 100, shared: 25, viewers: 21 }), NOW);
  const tooHighRatio = Engine.normalizeBox(chest({ coins: 700, shared: 100, viewers: 10 }), NOW);
  assert.equal(Engine.passesFilters(good, filters, NOW), true);
  assert.equal(Engine.passesFilters(tooManyViewers, filters, NOW), false);
  assert.equal(Engine.passesFilters(tooHighRatio, filters, NOW), false);
});
