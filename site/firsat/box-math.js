/*
 * box-math.js — kutuların saf fırsat matematiği.
 *
 * UI'dan bağımsızdır; tarayıcıda `BoxMath`, Node'da `require` ile kullanılır.
 *
 * Önemli sınırlar:
 * - `coins`, `shared` ve `participants` alanlarında 0 "bilinmiyor" olabilir.
 *   Bu modül 0'ı sayı olarak korur; bölme sıfırsa sonucu null bırakır.
 * - Kazanma olasılığı yalnızca Goody Bag için üretilir. Treasure Box'ta
 *   katılımcı sayısı güvenilir bir alan değildir.
 * - Beklenen jeton, eşit dağıtım ve tek giriş varsayımıyla "naif" bir
 *   tahmindir; garanti veya gerçek TikTok olasılığı değildir.
 * - `durationSec` açılışa kalan süredir, açılış sonrası pencere değildir.
 *   Bu yüzden çakışma için yalnızca `unpackAt`/`opensAt`/`availableAt` ve
 *   `expiresAt` kullanılır.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoxMath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KIND_BY_NAME = {
    chest: 'chest',
    bag: 'bag',
    letter: 'bag',
    portal: 'portal'
  };

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return Math.round(number);
  }

  function firstNumber(source, fields) {
    if (!source || typeof source !== 'object') return null;
    for (var i = 0; i < fields.length; i += 1) {
      var value = finiteNumber(source[fields[i]]);
      if (value !== null) return value;
    }
    return null;
  }

  function firstPositive(source, fields) {
    if (!source || typeof source !== 'object') return null;
    for (var i = 0; i < fields.length; i += 1) {
      var value = finiteNumber(source[fields[i]]);
      if (value !== null && value > 0) return value;
    }
    return null;
  }

  function normalizeKind(box) {
    var raw = box && (box.kind || box.type);
    var kind = KIND_BY_NAME[String(raw || '').toLowerCase()] || null;
    if (kind) return kind;

    // Scanner türü bilinmiyorsa yalnızca bilinen TikTok businessType
    // kodlarından yararlan; bilinmeyen kodu tahmin etme.
    var businessType = finiteNumber(box && (box.businessType || box.business_type));
    if (businessType === 20) return 'chest';
    if (businessType === 21) return 'bag';
    if (businessType === 9) return 'portal';
    return 'unknown';
  }

  function boxId(box, index) {
    if (box && box.id !== null && box.id !== undefined && String(box.id) !== '') {
      return String(box.id);
    }
    return 'box-' + index;
  }

  /*
   * Tek kutunun türetilmiş değerleri.
   *
   * Dönen başlıca alanlar:
   * - winProbability: [0, 1] arası naif olasılık; yalnızca bag için.
   * - expectedCoins: katılım başına naif beklenen jeton; yalnızca bag için.
   * - expectedPerWinner: kazanan başına nominal jeton (T/W).
   * - bagDensity: T/N; yalnızca bag ve N > 0 için.
   * - startAt/endAt: çakışma için kullanılan gerçek açılış/kapanış.
   */
  function analyzeBox(box, index) {
    var source = box && typeof box === 'object' ? box : {};
    var kind = normalizeKind(source);
    var totalCoins = firstNumber(source, ['coins', 'totalCoins', 'total_coins']);
    var winnerCount = firstNumber(source, [
      'shared', 'winnerSlots', 'winnerCount', 'winner_count'
    ]);
    var participants = firstNumber(source, [
      'participants', 'participantCount', 'participant_count', 'joinedCount'
    ]);

    var startAt = firstPositive(source, ['unpackAt', 'opensAt', 'availableAt', 't']);
    var rawEndAt = firstPositive(source, ['expiresAt', 'expires_at_ms', 'actionEndAt']);
    // Goody Bag'de expiresAt açılış anına eşit olabiliyor. Bu, açılış sonrası
    // bir pencere olduğu anlamına gelmez; yalnızca start < end ise pencere var.
    var endAt = startAt !== null && rawEndAt !== null && rawEndAt > startAt
      ? rawEndAt : null;

    var winProbability = null;
    var probabilityReason = null;
    if (kind === 'bag') {
      if (winnerCount === null || winnerCount <= 0) {
        probabilityReason = 'missing_winner_count';
      } else if (participants === null || participants <= 0) {
        probabilityReason = 'missing_participants';
      } else {
        winProbability = Math.min(1, winnerCount / participants);
      }
    } else if (kind === 'chest') {
      probabilityReason = 'chest_participant_count_not_canonical';
    } else {
      probabilityReason = 'unsupported_kind';
    }

    var expectedPerWinner = null;
    if ((kind === 'bag' || kind === 'chest') &&
        totalCoins !== null && winnerCount !== null && winnerCount > 0) {
      expectedPerWinner = totalCoins / winnerCount;
    }

    var expectedCoins = null;
    if (kind === 'bag' && winProbability !== null &&
        totalCoins !== null && winnerCount !== null && participants !== null &&
        winnerCount > 0 && participants > 0) {
      // W <= N ise p * (T/W) = T/N.
      // W > N ise tüm katılımcılar kazanabilir; eşit pay varsayımıyla T/W.
      expectedCoins = totalCoins / Math.max(participants, winnerCount);
    }

    var bagDensity = null;
    if (kind === 'bag' && totalCoins !== null && participants !== null && participants > 0) {
      bagDensity = totalCoins / participants;
    }

    var missing = [];
    if (totalCoins === null) missing.push('total_coins');
    if (winnerCount === null) missing.push('winner_count');
    if (participants === null) missing.push('participant_count');

    var warnings = [];
    if (kind === 'bag' && winnerCount !== null && participants !== null &&
        winnerCount >= participants && participants > 0) {
      warnings.push('winner_slots_ge_participants');
    }
    if (kind === 'chest' && participants !== null) {
      warnings.push('chest_participants_ignored');
    }
    if (totalCoins === 0) warnings.push('total_coins_zero');

    var formulas = [];
    if (kind === 'bag') {
      formulas.push('p = min(1, W/N)');
      formulas.push('E = T/max(N,W)');
      formulas.push('P = T/W');
      formulas.push('D = T/N');
    } else if (kind === 'chest') {
      formulas.push('P = T/W');
    }

    return {
      id: boxId(source, index || 0),
      kind: kind,
      sourceKind: source.kind || source.type || null,
      totalCoins: totalCoins,
      winnerCount: winnerCount,
      participantCount: participants,
      winProbability: winProbability,
      probabilityReason: probabilityReason,
      expectedCoins: expectedCoins,
      expectedPerWinner: expectedPerWinner,
      bagDensity: bagDensity,
      startAt: startAt,
      endAt: endAt,
      windowKnown: startAt !== null && endAt !== null,
      confidence: winProbability !== null || expectedCoins !== null ? 'low' : 'none',
      formulas: formulas,
      assumptions: kind === 'bag'
        ? ['one_entry_per_participant', 'uniform_random_winners', 'equal_prize_split']
        : kind === 'chest'
          ? ['equal_prize_split']
          : [],
      missing: missing,
      warnings: warnings
    };
  }

  function compareBoxes(a, b) {
    var aStart = a.startAt === null ? Infinity : a.startAt;
    var bStart = b.startAt === null ? Infinity : b.startAt;
    if (aStart !== bStart) return aStart - bStart;

    var aEnd = a.endAt === null ? Infinity : a.endAt;
    var bEnd = b.endAt === null ? Infinity : b.endAt;
    if (aEnd !== bEnd) return aEnd - bEnd;

    var aExpected = a.expectedCoins === null ? -Infinity : a.expectedCoins;
    var bExpected = b.expectedCoins === null ? -Infinity : b.expectedCoins;
    if (aExpected !== bExpected) return bExpected - aExpected;

    var aPrize = a.expectedPerWinner === null ? -Infinity : a.expectedPerWinner;
    var bPrize = b.expectedPerWinner === null ? -Infinity : b.expectedPerWinner;
    if (aPrize !== bPrize) return bPrize - aPrize;

    return a.id.localeCompare(b.id);
  }

  /*
   * Kutuları çakışma için sıralar.
   *
   * Sıra: açılış zamanı → kapanış zamanı → katılım başına beklenen jeton →
   * kazanan başına jeton → id. Zamanı bilinmeyen kutular sona düşer.
   *
   * `overlapWithPrevious` yalnızca iki kutunun da bilinen penceresi varsa
   * true/false olur; aksi halde null kalır. `conflictGroup` yalnızca gerçek
   * pencere kesişmesinde aynı gruba girer. Aynı açılış anı ayrıca
   * `sameStartAsPrevious` ile işaretlenir.
   */
  function rankBoxes(boxes) {
    if (!Array.isArray(boxes)) return [];

    var items = boxes.map(function (box, index) {
      var analyzed = analyzeBox(box, index);
      analyzed._index = index;
      return analyzed;
    }).sort(function (a, b) {
      var compared = compareBoxes(a, b);
      return compared || a._index - b._index;
    });

    var group = 0;
    var groupEnd = null;

    items.forEach(function (item, index) {
      var previous = index > 0 ? items[index - 1] : null;
      var sameStart = Boolean(previous && previous.startAt !== null &&
        item.startAt !== null && previous.startAt === item.startAt);

      var overlapsGroup = groupEnd !== null && item.startAt !== null &&
        item.startAt < groupEnd;
      if (index === 0 || !overlapsGroup) {
        group += 1;
        groupEnd = item.endAt;
      } else if (item.endAt !== null && (groupEnd === null || item.endAt > groupEnd)) {
        groupEnd = item.endAt;
      }

      var overlapWithPrevious = null;
      if (previous && previous.endAt !== null && item.startAt !== null) {
        overlapWithPrevious = item.startAt < previous.endAt;
      }

      item.rank = index + 1;
      item.conflictGroup = group;
      item.overlapWithPrevious = overlapWithPrevious;
      item.sameStartAsPrevious = sameStart;
      item.overlapsGroup = overlapsGroup;
      delete item._index;
    });

    return items;
  }

  return {
    analyzeBox: analyzeBox,
    rankBoxes: rankBoxes
  };
});
