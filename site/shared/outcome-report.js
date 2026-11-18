/*
 * outcome-report.js — açılan kutuların gerçek sonucu ile box-math tahminini
 * karşılaştıran saf yardımcılar.
 *
 * Girdi: BoxMath.analyzeBox çıktısı + kullanıcının girdiği gerçek sonuç.
 * Çıktı: saklanabilir kayıt ve özet kalibrasyon raporu.
 *
 * Önemli sınırlar:
 * - Gerçek sonuç tarayıcıdan/panelden gelir; TikTok'tan otomatik okunmaz.
 * - Kazanma olasılığı yalnızca Goody Bag için üretildiğinden Brier skoru
 *   yalnızca olasılığı olan kayıtlarda hesaplanır.
 * - Az örnekte (n < 5) sayılar yön göstergesidir; istatistik değildir.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OutcomeReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BUCKETS = [
    { label: '≤%25', limit: 0.25 },
    { label: '%25–50', limit: 0.5 },
    { label: '%50–75', limit: 0.75 },
    { label: '>%75', limit: 1.01 }
  ];

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function average(list) {
    if (!list.length) return null;
    var total = 0;
    for (var i = 0; i < list.length; i += 1) total += list[i];
    return total / list.length;
  }

  function bucketFor(probability) {
    for (var i = 0; i < BUCKETS.length; i += 1) {
      if (probability < BUCKETS[i].limit) return i;
    }
    return BUCKETS.length - 1;
  }

  /*
   * Tek kutu için kayıt üretir. Tahmin yoksa veya gerçek sonuç girilmemişse
   * kayıt üretilmez; `error` döner.
   */
  function buildRecord(analyzed, actual, meta) {
    if (!analyzed || !analyzed.id) return { error: 'kutu bulunamadı' };
    var given = actual || {};
    var perWinner = num(given.perWinner);
    var won = given.won === true ? true : given.won === false ? false : null;
    if (perWinner === null && won === null) return { error: 'gerçek sonuç girilmedi' };

    var predicted = {
      totalCoins: num(analyzed.totalCoins),
      winnerCount: num(analyzed.winnerCount),
      participantCount: num(analyzed.participantCount),
      expectedPerWinner: num(analyzed.expectedPerWinner),
      expectedCoins: num(analyzed.expectedCoins),
      winProbability: num(analyzed.winProbability)
    };
    if (predicted.expectedPerWinner === null && predicted.winProbability === null) {
      return { error: 'bu kutu için tahmin üretilemiyor' };
    }

    var info = meta || {};
    return {
      id: String(analyzed.id),
      kind: analyzed.kind,
      creator: String(info.creator || ''),
      recordedAt: Number(info.recordedAt) || Date.now(),
      predicted: predicted,
      actual: { perWinner: perWinner, won: won }
    };
  }

  /*
   * Kayıt listesinden basit kalibrasyon özeti:
   * - perWinner: tahmin ortalaması, gerçek ortalama, sapma (gerçek−tahmin),
   *   MAE ve MAPE.
   * - probability: tahmin ortalaması, gözlenen kazanma oranı, Brier skoru.
   * - buckets: olasılık kovalarında tahmin ve gözlem.
   */
  function summarize(records) {
    var list = Array.isArray(records) ? records : [];
    var diffs = [];
    var predictedPerWinner = [];
    var actualPerWinner = [];
    var relative = [];
    var probabilities = [];
    var outcomes = [];
    var buckets = BUCKETS.map(function (bucket) {
      return { label: bucket.label, n: 0, predictedSum: 0, wins: 0 };
    });

    list.forEach(function (record) {
      var predicted = (record && record.predicted) || {};
      var actual = (record && record.actual) || {};

      var estimated = num(predicted.expectedPerWinner);
      var real = num(actual.perWinner);
      if (estimated !== null && real !== null) {
        diffs.push(real - estimated);
        predictedPerWinner.push(estimated);
        actualPerWinner.push(real);
        if (estimated > 0) relative.push(Math.abs(real - estimated) / estimated);
      }

      var probability = num(predicted.winProbability);
      if (probability !== null && (actual.won === true || actual.won === false)) {
        probabilities.push(probability);
        outcomes.push(actual.won ? 1 : 0);
        var bucket = buckets[bucketFor(probability)];
        bucket.n += 1;
        bucket.predictedSum += probability;
        bucket.wins += actual.won ? 1 : 0;
      }
    });

    return {
      count: list.length,
      perWinner: diffs.length ? {
        n: diffs.length,
        predictedMean: average(predictedPerWinner),
        actualMean: average(actualPerWinner),
        bias: average(diffs),
        mae: average(diffs.map(function (value) { return Math.abs(value); })),
        mape: relative.length ? average(relative) : null
      } : null,
      probability: probabilities.length ? {
        n: probabilities.length,
        predictedMean: average(probabilities),
        observedRate: average(outcomes),
        brier: average(probabilities.map(function (value, index) {
          var delta = value - outcomes[index];
          return delta * delta;
        }))
      } : null,
      buckets: buckets.map(function (bucket) {
        return {
          label: bucket.label,
          n: bucket.n,
          predictedMean: bucket.n ? bucket.predictedSum / bucket.n : null,
          observedRate: bucket.n ? bucket.wins / bucket.n : null
        };
      })
    };
  }

  return {
    buildRecord: buildRecord,
    summarize: summarize
  };
});
