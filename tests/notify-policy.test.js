const test = require('node:test');
const assert = require('node:assert/strict');

const Policy = require('../site/shared/notify-policy.js');

test('sessiz saat penceresi gece yarısını aşar', () => {
  const at = (hour, minute) => new Date(2026, 10, 17, hour, minute, 0, 0);
  assert.equal(Policy.inQuietHours(at(2, 30), '23:00', '08:00'), true);
  assert.equal(Policy.inQuietHours(at(23, 0), '23:00', '08:00'), true);
  assert.equal(Policy.inQuietHours(at(7, 59), '23:00', '08:00'), true);
  assert.equal(Policy.inQuietHours(at(8, 0), '23:00', '08:00'), false);
  assert.equal(Policy.inQuietHours(at(12, 0), '23:00', '08:00'), false);
});

test('gündüz penceresi ve geçersiz değerler', () => {
  const at = (hour) => new Date(2026, 10, 17, hour, 15, 0, 0);
  assert.equal(Policy.inQuietHours(at(10), '09:00', '17:00'), true);
  assert.equal(Policy.inQuietHours(at(18), '09:00', '17:00'), false);
  // Başlangıç = bitiş → pencere kapalı.
  assert.equal(Policy.inQuietHours(at(10), '09:00', '09:00'), false);
  // Eksik/bozuk saat → pencere kapalı.
  assert.equal(Policy.inQuietHours(at(10), '', ''), false);
  assert.equal(Policy.inQuietHours(at(10), '25:00', '08:00'), false);
  assert.equal(Policy.inQuietHours(at(10), '9:00', '17:00'), false);
});

test('saat ayrıştırma ve biçimlendirme', () => {
  assert.equal(Policy.parseClock('07:30'), 450);
  assert.equal(Policy.parseClock(' 23:05 '), 1385);
  assert.equal(Policy.parseClock('24:00'), null);
  assert.equal(Policy.parseClock('7:30'), null);
  assert.equal(Policy.parseClock(null), null);
  assert.equal(Policy.formatClock(450), '07:30');
  assert.equal(Policy.formatClock(0), '00:00');
  assert.equal(Policy.formatClock(1440), '00:00');
  assert.equal(Policy.formatClock(Number.NaN), '');
  // Boş giriş 00:00'a dönüşmemeli; sessiz saat "kapalı" kalmalı.
  assert.equal(Policy.formatClock(null), '');
  assert.equal(Policy.formatClock(''), '');
  assert.equal(Policy.formatClock(undefined), '');
});

test('fırsat skoru 0–100 arasında ve alanlarla artar', () => {
  const now = 1_800_000_000_000;
  const base = { ratio: 1, totalCoins: 100, winnerCount: 50, viewerCount: 80, opensAt: now + 60_000, now };
  const low = Policy.opportunityScore({ ...base, ratio: 1, totalCoins: 20, opensAt: now + 5_000 });
  const high = Policy.opportunityScore({ ...base, ratio: 4, totalCoins: 1000, opensAt: now + 300_000 });
  assert.ok(low > 0 && low < high, `beklenen artış: ${low} < ${high}`);
  assert.ok(high <= 100);

  // Boş kutu 0 değil ama düşük kalır; üst sınırı aşmaz.
  assert.ok(Policy.opportunityScore({}) <= 30);
  const maxed = Policy.opportunityScore({
    ratio: 5000, totalCoins: 50_000_000, winnerCount: 1, viewerCount: 0, opensAt: now + 3_600_000, now
  });
  assert.ok(maxed <= 100);

  // Açılmış sandıkta süre puanı yok; pencere bilinmiyorsa nötr.
  const opened = Policy.opportunityScore({ ...base, opensAt: now - 1000 });
  const unknownWindow = Policy.opportunityScore({ ...base, opensAt: 0 });
  assert.ok(opened < unknownWindow);
});

test('bildirim kararı preset, eşik, sessiz saat ve tekrarı birlikte uygular', () => {
  const ok = { match: true, score: 70, minScore: 50, quiet: false, seen: false };
  assert.equal(Policy.shouldNotify(ok), true);
  assert.equal(Policy.shouldNotify({ ...ok, score: 50 }), true);
  assert.equal(Policy.shouldNotify({ ...ok, score: 49 }), false);
  assert.equal(Policy.shouldNotify({ ...ok, quiet: true }), false);
  assert.equal(Policy.shouldNotify({ ...ok, seen: true }), false);
  assert.equal(Policy.shouldNotify({ ...ok, match: false }), false);
  // Eşik 0, skor 0 → yine de bildirim (yalnızca preset belirler).
  assert.equal(Policy.shouldNotify({ ...ok, score: 0, minScore: 0 }), true);
});
