const test = require('node:test');
const assert = require('node:assert/strict');

const Report = require('../site/shared/outcome-report.js');

function close(actual, expected, epsilon) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= (epsilon === undefined ? 1e-9 : epsilon),
    'expected ' + expected + ', got ' + actual
  );
}

const analyzed = {
  id: 'box-1',
  kind: 'chest',
  totalCoins: 500,
  winnerCount: 100,
  participantCount: null,
  expectedPerWinner: 5,
  expectedCoins: null,
  winProbability: null
};

test('kayıt: gerçek sonuç yoksa veya tahmin üretilemiyorsa reddedilir', () => {
  assert.match(Report.buildRecord(analyzed, {}).error, /sonuç/);
  assert.match(Report.buildRecord(null, { perWinner: 5 }).error, /kutu/);
  assert.match(
    Report.buildRecord({ id: 'x', kind: 'portal', expectedPerWinner: null, winProbability: null }, { perWinner: 5 }).error,
    /tahmin/
  );
});

test('kayıt: tahmin alanları kopyalanır, gerçek değerler normalize edilir', () => {
  const record = Report.buildRecord(analyzed, { perWinner: '4.5', won: null }, {
    creator: 'ornek', recordedAt: 1234
  });
  assert.equal(record.error, undefined);
  assert.equal(record.id, 'box-1');
  assert.equal(record.kind, 'chest');
  assert.equal(record.creator, 'ornek');
  assert.equal(record.recordedAt, 1234);
  assert.equal(record.predicted.expectedPerWinner, 5);
  assert.equal(record.predicted.winnerCount, 100);
  assert.equal(record.actual.perWinner, 4.5);
  assert.equal(record.actual.won, null);

  // Yalnızca "kazandım/kazanmadım" girilse de kayıt üretilir.
  const wonOnly = Report.buildRecord(
    { id: 'bag-1', kind: 'bag', expectedPerWinner: null, winProbability: 0.25 },
    { won: true }
  );
  assert.equal(wonOnly.error, undefined);
  assert.equal(wonOnly.actual.won, true);
});

test('özet: sapma, MAE, MAPE ve örnek sayısı', () => {
  const summary = Report.summarize([
    { predicted: { expectedPerWinner: 10 }, actual: { perWinner: 8 } },
    { predicted: { expectedPerWinner: 5 }, actual: { perWinner: 5 } },
    { predicted: { expectedPerWinner: 4 }, actual: { perWinner: 6 } },
    // Gerçek değer yok → kazanan başına özete girmez.
    { predicted: { expectedPerWinner: 3 }, actual: { won: false } }
  ]);

  assert.equal(summary.count, 4);
  assert.equal(summary.perWinner.n, 3);
  close(summary.perWinner.predictedMean, 19 / 3);
  close(summary.perWinner.actualMean, 19 / 3);
  close(summary.perWinner.bias, 0);           // (8-10)+(5-5)+(6-4) = 0
  close(summary.perWinner.mae, (2 + 0 + 2) / 3);
  close(summary.perWinner.mape, (0.2 + 0 + 0.5) / 3);
  assert.equal(summary.probability, null);
});

test('özet: Brier skoru, gözlenen oran ve olasılık kovaları', () => {
  const summary = Report.summarize([
    { predicted: { winProbability: 0.2 }, actual: { won: false } },
    { predicted: { winProbability: 0.2 }, actual: { won: true } },
    { predicted: { winProbability: 0.8 }, actual: { won: true } },
    { predicted: { winProbability: 0.6 }, actual: { won: false } },
    // Olasılık yok → Brier'a girmez.
    { predicted: {}, actual: { perWinner: 3 } }
  ]);

  assert.equal(summary.probability.n, 4);
  close(summary.probability.predictedMean, 0.45);
  close(summary.probability.observedRate, 0.5);
  // ((.2-0)^2 + (.2-1)^2 + (.8-1)^2 + (.6-0)^2) / 4
  close(summary.probability.brier, (0.04 + 0.64 + 0.04 + 0.36) / 4);

  const buckets = summary.buckets;
  assert.equal(buckets.length, 4);
  assert.deepEqual(buckets.map((bucket) => bucket.n), [2, 0, 1, 1]);
  close(buckets[0].predictedMean, 0.2);
  close(buckets[0].observedRate, 0.5);
  assert.equal(buckets[1].predictedMean, null);
  close(buckets[2].predictedMean, 0.6);
  close(buckets[2].observedRate, 0);
  close(buckets[3].predictedMean, 0.8);
  close(buckets[3].observedRate, 1);
});

test('özet: boş liste ve sıfır tahmin güvenli', () => {
  const empty = Report.summarize([]);
  assert.deepEqual(empty.perWinner, null);
  assert.deepEqual(empty.probability, null);
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.buckets.map((bucket) => bucket.n), [0, 0, 0, 0]);

  // Tahmin 0 ise MAPE hesaplanmaz, MAE hesaplanır.
  const zero = Report.summarize([{ predicted: { expectedPerWinner: 0 }, actual: { perWinner: 2 } }]);
  assert.equal(zero.perWinner.mape, null);
  assert.equal(zero.perWinner.bias, 2);
  assert.equal(zero.perWinner.mae, 2);
});
