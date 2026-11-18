/*
 * notify-policy.js — bildirim kararının saf yardımcıları.
 *
 * Tarayıcıdan bağımsızdır: sessiz saat penceresi, fırsat skoru ve "bildirim
 * atılmalı mı" kararı burada hesaplanır. Böylece hem sayfa hem testler aynı
 * mantığı kullanır (tarayıcıda window.NotifyPolicy, Node'da require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NotifyPolicy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

  // 'HH:MM' → gün içi dakika; geçersizse null.
  function parseClock(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    var match = CLOCK.exec(text);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  // Gün içi dakika → 'HH:MM'; boş/geçersiz değerde ''.
  function formatClock(minutes) {
    if (minutes === null || minutes === undefined || minutes === '') return '';
    var value = Number(minutes);
    if (!Number.isFinite(value)) return '';
    var clamped = ((Math.round(value) % 1440) + 1440) % 1440;
    return String(Math.floor(clamped / 60)).padStart(2, '0') + ':' + String(clamped % 60).padStart(2, '0');
  }

  function minutesOfDay(date) {
    var value = date instanceof Date ? date : new Date(date);
    return value.getHours() * 60 + value.getMinutes();
  }

  // Sessiz saat penceresi gece yarısını aşabilir (23:00–08:00).
  // Başlangıç = bitiş ise pencere kapalıdır.
  function inQuietHours(date, start, end) {
    var from = parseClock(start);
    var to = parseClock(end);
    if (from === null || to === null || from === to) return false;
    var now = minutesOfDay(date);
    return from < to ? (now >= from && now < to) : (now >= from || now < to);
  }

  /*
   * 0–100 fırsat skoru. Yalnızca kutunun kendi alanları kullanılır:
   *   oran (45) + jeton (20) + açılışa kalan süre (20) + izleyici/kontenjan (15).
   * Amaç sıralama değil, bildirim eşiği için tek bir sayı vermek.
   */
  function opportunityScore(input) {
    var box = input || {};
    var now = Number(box.now) || Date.now();
    var ratio = Number(box.ratio);
    var coins = Math.max(0, Number(box.totalCoins) || 0);
    var winners = Math.max(0, Number(box.winnerCount) || 0);
    var viewers = Math.max(0, Number(box.viewerCount) || 0);
    var opensAt = Number(box.opensAt) || 0;

    // Oran 1 → ~13, 2 → ~21, 4 → ~30, 10+ → 45 puan.
    var ratioPart = Number.isFinite(ratio) && ratio > 0
      ? 45 * Math.min(1, Math.log(1 + ratio) / Math.log(11))
      : 0;

    // Jeton 50 → ~11, 200 → ~15, 1000+ → 20 puan.
    var coinsPart = coins > 0 ? 20 * Math.min(1, Math.log(1 + coins) / Math.log(1001)) : 0;

    // Açılışa 5 dakika ve üzeri tam puan; açılmışsa 0; pencere bilinmiyorsa nötr.
    var timePart;
    if (opensAt > now) timePart = 20 * Math.min(1, (opensAt - now) / 300000);
    else if (opensAt > 0) timePart = 0;
    else timePart = 10;

    // İzleyici kontenjandan azsa 15, eşitse ~13, 4 katıysa 0 puan.
    var viewPart;
    if (winners > 0 && viewers > 0) {
      viewPart = 15 * Math.max(0, Math.min(1, (4 - viewers / winners) / 3.5));
    } else {
      viewPart = 7;
    }

    return Math.max(0, Math.min(100, Math.round(ratioPart + coinsPart + timePart + viewPart)));
  }

  // Bildirim kararı: seçili preset eşleşmeli, skor eşiği geçilmeli, sessiz
  // saatte olunmamalı ve bu kutu daha önce bildirilmemiş olmalı.
  function shouldNotify(options) {
    var opts = options || {};
    if (!opts.match || opts.seen || opts.quiet) return false;
    var minScore = Math.max(0, Number(opts.minScore) || 0);
    return (Number(opts.score) || 0) >= minScore;
  }

  return {
    parseClock: parseClock,
    formatClock: formatClock,
    inQuietHours: inQuietHours,
    opportunityScore: opportunityScore,
    shouldNotify: shouldNotify
  };
});
