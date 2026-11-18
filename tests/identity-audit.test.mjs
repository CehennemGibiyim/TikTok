import test from 'node:test';
import assert from 'node:assert/strict';

import { createIdentityAudit } from '../local/api/src/identity-audit.js';

const OPEN = 1_700_000_000_000;
const base = {
  id: 'box:aaa',
  kind: 'chest',
  creator: 'ornek',
  room_id: 'r1',
  opens_at_ms: OPEN,
  total_coins: 100,
  winner_count: 10,
  source: 'boxes'
};

test('değer güncellemesi çakışma veya bölünme saymaz', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  audit.observe({ ...base, total_coins: 210, winner_count: 12, source: 'ntfy' });

  const snapshot = audit.snapshot();
  assert.equal(snapshot.rows, 2);
  assert.equal(snapshot.keyCollisions, 0);
  assert.equal(snapshot.splitRows, 0);
  assert.deepEqual(snapshot.samples, []);
});

test('aynı kanonik kimlik + farklı açılış zamanı çakışma olarak örneklenir', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  const finding = audit.observe({ ...base, opens_at_ms: OPEN + 60_000, source: 'ingest' });

  assert.equal(finding.type, 'key_collision');
  const snapshot = audit.snapshot();
  assert.equal(snapshot.keyCollisions, 1);
  assert.equal(snapshot.splitRows, 0);
  assert.equal(snapshot.samples.length, 1);

  const [sample] = snapshot.samples;
  assert.equal(sample.type, 'key_collision');
  assert.equal(sample.id, base.id);
  assert.equal(sample.creator, 'ornek');
  assert.deepEqual(sample.changed, ['opens_at_ms']);
  assert.equal(sample.before.opens_at_ms, OPEN);
  assert.equal(sample.after.opens_at_ms, OPEN + 60_000);
  assert.deepEqual([sample.before.source, sample.after.source], ['boxes', 'ingest']);
});

test('yayıncı farkı da çakışmadır; jeton farkı değildir', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  audit.observe({ ...base, creator: 'Baska' });
  audit.observe({ ...base, total_coins: 999 });

  const snapshot = audit.snapshot();
  assert.equal(snapshot.keyCollisions, 1);
  assert.deepEqual(snapshot.samples[0].changed, ['creator']);
});

test('aynı kutu iki kimlikle gelirse bölünmüş satır sayılır', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  const finding = audit.observe({ ...base, id: 'box:bbb', total_coins: 120, source: 'ntfy' });

  assert.equal(finding.type, 'split_rows');
  const snapshot = audit.snapshot();
  assert.equal(snapshot.splitRows, 1);
  assert.equal(snapshot.keyCollisions, 0);

  const [sample] = snapshot.samples;
  assert.equal(sample.type, 'split_rows');
  assert.deepEqual(sample.ids, ['box:aaa', 'box:bbb']);
  assert.deepEqual(sample.sources, ['boxes', 'ntfy']);
  assert.equal(sample.creator, 'ornek');
  assert.equal(sample.opens_at_ms, OPEN);
});

test('aynı kimlik tekrarı ve kimliksiz olay bölünme üretmez', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  audit.observe({ ...base, source: 'ntfy' });
  // Açılış zamanı yok: içerik kimliği üretilemez, bölünme sayılmaz.
  audit.observe({ id: 'x', kind: 'chest', creator: 'ornek', room_id: 'r1', opens_at_ms: 0, source: 'boxes' });
  audit.observe({ id: 'y', kind: 'chest', creator: 'ornek', room_id: 'r1', opens_at_ms: 0, source: 'boxes' });

  const snapshot = audit.snapshot();
  assert.equal(snapshot.splitRows, 0);
  assert.equal(snapshot.samples.length, 0);
  assert.equal(snapshot.trackedKeys, 3);
});

test('örnek listesi sınırlı kalır ve en yenisini tutar', () => {
  const audit = createIdentityAudit({ sampleLimit: 2 });
  for (let index = 0; index < 4; index += 1) {
    // Toleransın (5 sn) dışında: her çift ayrı kutu sayılır.
    const opensAt = OPEN + index * 10_000;
    audit.observe({ ...base, id: 'box:a-' + index, opens_at_ms: opensAt });
    audit.observe({ ...base, id: 'box:b-' + index, opens_at_ms: opensAt });
  }

  const snapshot = audit.snapshot();
  assert.equal(snapshot.splitRows, 4);
  assert.equal(snapshot.samples.length, 2);
  assert.ok(snapshot.samples.every((sample) => sample.type === 'split_rows'));
  assert.deepEqual(snapshot.samples[1].ids, ['box:a-3', 'box:b-3']);
});

test('aynı satırın güncellemeleri tolerans penceresini kaydırmaz', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  audit.observe({ ...base, opens_at_ms: OPEN + 5000, source: 'ntfy' });
  audit.observe({ ...base, opens_at_ms: OPEN + 10_000, source: 'ntfy' });

  // İlk görülen zaman sabit: 10 sn sonraki farklı satır bölünme sayılmaz.
  const finding = audit.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 10_000 });
  assert.equal(finding, null);
  assert.equal(audit.snapshot().splitRows, 0);
});

test('küçük açılış farkı tolerans içinde bölünmüş satır sayılır', () => {
  const audit = createIdentityAudit();
  audit.observe(base);
  const finding = audit.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 3000, source: 'ntfy' });

  assert.equal(finding.type, 'split_rows');
  assert.equal(finding.timeDeltaMs, 3000);
  assert.equal(finding.toleranceMs, 5000);

  const [sample] = audit.snapshot().samples;
  assert.equal(sample.timeDeltaMs, 3000);
  assert.equal(sample.toleranceMs, 5000);
});

test('tolerans sınırı dahil, dışı ayrı kutu', () => {
  const boundary = createIdentityAudit();
  boundary.observe(base);
  boundary.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 5000 });
  assert.equal(boundary.snapshot().splitRows, 1);

  const outside = createIdentityAudit();
  outside.observe(base);
  outside.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 5001 });
  const snapshot = outside.snapshot();
  assert.equal(snapshot.splitRows, 0);
  assert.equal(snapshot.samples.length, 0);
});

test('tolerans yapılandırılabilir; 0 tam eşleşme, geçersiz değer varsayılan', () => {
  const strict = createIdentityAudit({ toleranceMs: 1000 });
  strict.observe(base);
  strict.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 3000 });
  assert.equal(strict.snapshot().splitRows, 0);

  const loose = createIdentityAudit({ toleranceMs: 10_000 });
  loose.observe(base);
  loose.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 9000 });
  assert.equal(loose.snapshot().splitRows, 1);

  const exact = createIdentityAudit({ toleranceMs: 0 });
  exact.observe(base);
  exact.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 1 });
  assert.equal(exact.snapshot().splitRows, 0);

  // Negatif tolerans bölme hatasına yol açmamalı; varsayılan (5 sn) uygulanır.
  const invalid = createIdentityAudit({ toleranceMs: -100 });
  invalid.observe(base);
  const finding = invalid.observe({ ...base, id: 'box:bbb', opens_at_ms: OPEN + 3000 });
  assert.equal(finding.type, 'split_rows');
  assert.equal(finding.toleranceMs, 5000);
});
