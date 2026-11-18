/*
 * reward-engine.js — TikTok sandık / zarf (bag) olaylarını yerel radarın
 * kullandığı ortak modele çevirir.
 *
 * Kaynak yalnızca kendi tarayıcımızın ürettiği ham kutu kayıtlarıdır. Referans
 * sitedeki özel API çağrılmaz; alanlar TikTok olayından gelmiyorsa uydurulmaz.
 *
 * Hem tarayıcıda (window.RewardEngine) hem Node'da (require) çalışır.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RewardEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HUNG_MAX_AGE_MS = 15 * 60 * 1000;
  var COLLECT_WINDOW_MS = 15 * 60 * 1000;
  var MAX_COINS = 50000000;

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function first(source, names) {
    if (!source || typeof source !== 'object') return undefined;
    for (var i = 0; i < names.length; i += 1) {
      var value = source[names[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function isGold(box) {
    var raw = [box && box.boxType, box && box.boxName, box && box.giftName].filter(Boolean).join(' ');
    return /(^|[^a-z])(gold|golden|alt[ıi]n)([^a-z]|$)/i.test(raw);
  }

  function eventKind(box) {
    var raw = text(box && box.kind).toLowerCase();
    if (raw === 'chest') return 'chest';
    if (raw === 'portal') return 'portal';
    if (raw === 'letter' || raw === 'bag') return 'bag';
    return 'chest';
  }

  function normalizeBox(box, now) {
    if (!box || typeof box !== 'object') return null;
    now = Number(now) || Date.now();
    var id = text(box.id) || (text(box.username) + ':' + num(box.t));
    var creator = text(box.username).replace(/^@/, '');
    if (!id || !creator) return null;

    var kind = eventKind(box);
    var observedAt = num(box.t) || now;
    var explicitOpens = num(box.opensAt);
    var unpackAt = num(box.unpackAt);
    var availableAt = num(box.availableAt);
    var durationSec = num(first(box, ['durationSec', 'duration']));
    // availableAt tarayıcıda pencere yoksa "şimdi"ye düşebilir; gerçek bir
    // açılış zamanı yoksa uydurma sayaç başlatmayız.
    var hasWindow = Boolean(box.hasWindow) || explicitOpens > 0 || unpackAt > 0 ||
      (availableAt > 0 && durationSec > 0);
    var opensAt = hasWindow ? (explicitOpens || unpackAt || availableAt) : 0;
    if (!durationSec && opensAt && observedAt && opensAt > observedAt) {
      durationSec = Math.max(0, Math.round((opensAt - observedAt) / 1000));
    }
    var explicitExpiry = num(first(box, ['expiresAt', 'expireAt']));
    // Referans kuralı: sayan sandık/zarf için expires_at = opens_at. Sandık
    // açıldıktan sonra 15 dk "hung" olarak kalır. TikTok açıkça kapanış
    // göndermediyse 15 dk yalnızca yerel takip penceresidir.
    var expiresAt;
    if (explicitExpiry) expiresAt = explicitExpiry;
    else if (opensAt) {
      expiresAt = kind === 'chest'
        ? (now < opensAt ? opensAt : opensAt + HUNG_MAX_AGE_MS)
        : opensAt;
    } else expiresAt = observedAt + COLLECT_WINDOW_MS;
    var totalCoins = Math.max(0, Math.min(MAX_COINS, num(first(box, ['coins', 'totalCoins', 'total_coins', 'diamondCount']))));
    var winnerCount = Math.max(0, Math.round(num(first(box, ['shared', 'winners', 'winnerCount', 'winner_count', 'winnerSlots', 'peopleCount']))));
    var viewerCount = Math.max(0, Math.round(num(first(box, ['viewers', 'viewerCount', 'viewer_count']))));
    var participantCount = Math.max(0, Math.round(num(first(box, ['participants', 'participantCount', 'participant_count', 'joined', 'voteCount']))));
    var rawBagLevel = first(box, ['bagLevel', 'bag_level']);
    var rawBagLevelKnown = first(box, ['bagLevelKnown', 'bag_level_known']);
    var bagLevel = Math.max(0, Math.round(num(rawBagLevel)));
    var bagLevelKnown = rawBagLevelKnown !== undefined
      ? Boolean(rawBagLevelKnown)
      : (rawBagLevel !== undefined && rawBagLevel !== null && rawBagLevel !== '');
    var bagMethod = Math.max(0, Math.round(num(first(box, ['bagMethod', 'bag_method']))));
    var bagComment = text(first(box, ['bagComment', 'bag_comment']));
    var status = 'active';
    if (kind === 'chest' && opensAt > 0 && now >= opensAt) status = 'hung';
    if (expiresAt > 0 && now >= expiresAt + HUNG_MAX_AGE_MS) return null;

    return {
      id: id,
      rewardEventId: id,
      creator: creator,
      roomId: text(box.roomId),
      eventKind: kind,
      eventLabel: text(first(box, ['eventLabel', 'boxName', 'giftName'])),
      chestType: kind === 'chest' ? (isGold(box) ? 'gold' : 'normal') : 'normal',
      chestStatus: status,
      opensAt: opensAt,
      expiresAt: expiresAt,
      expiresEstimated: !explicitExpiry && !opensAt,
      observedAt: observedAt,
      durationSec: durationSec,
      hasWindow: hasWindow,
      totalCoins: totalCoins,
      winnerCount: winnerCount,
      viewerCount: viewerCount,
      participantCount: participantCount,
      // Güncel API: oran her iki olay türünde de jeton / kazanan kontenjanı.
      // participant_count ayrı bir alandır; oranın paydası değildir.
      ratioBasis: winnerCount > 0 ? 'winner_slots' : '',
      bagLevel: bagLevel,
      bagLevelKnown: bagLevelKnown,
      bagMethod: bagMethod,
      bagComment: bagComment,
      participantStatus: text(first(box, ['participantStatus', 'participant_status'])),
      businessType: Math.max(0, Math.round(num(box.businessType))),
      boxType: text(box.boxType),
      boxName: text(first(box, ['boxName', 'giftName'])),
      senderName: text(first(box, ['senderName', 'sender'])),
      countryCode: text(box.country || box.countryCode).toUpperCase().slice(0, 2),
      sessionSec: box.sessionSec === null || box.sessionSec === undefined ? null : num(box.sessionSec),
      raw: box
    };
  }

  function denominator(reward) {
    if (!reward) return 0;
    if (reward.ratioBasis === 'winner_slots') return reward.winnerCount;
    return 0;
  }

  function ratio(reward) {
    var d = denominator(reward);
    if (!d || !reward || !reward.totalCoins) return null;
    return reward.totalCoins / d;
  }

  function isExpired(reward, now) {
    if (!reward) return true;
    now = Number(now) || Date.now();
    if (reward.chestStatus === 'hung') {
      if (!reward.opensAt || now - reward.opensAt >= HUNG_MAX_AGE_MS) return true;
    }
    return reward.expiresAt > 0 && now >= reward.expiresAt;
  }

  function eligible(reward, now) {
    if (!reward || !reward.creator || !reward.id) return false;
    if (reward.totalCoins < 0) return false;
    if (reward.viewerCount < 0 || reward.winnerCount < 0) return false;
    if (reward.chestStatus === 'hung') {
      if (reward.eventKind !== 'chest' || !reward.opensAt || reward.opensAt > now) return false;
      if (now - reward.opensAt >= HUNG_MAX_AGE_MS) return false;
    }
    return !isExpired(reward, now);
  }

  function passesChestFilters(reward, filters) {
    if (!reward || reward.eventKind !== 'chest') return true;
    filters = filters || {};
    var types = filters.chestTypes || ['normal', 'gold'];
    var states = filters.chestStates || ['active', 'hung'];
    var type = reward.chestType === 'gold' ? 'gold' : 'normal';
    var state = reward.chestStatus === 'hung' ? 'hung' : 'active';
    return types.indexOf(type) !== -1 && states.indexOf(state) !== -1;
  }

  function passesFilters(reward, filters, now) {
    filters = filters || {};
    now = Number(now) || Date.now();
    if (!eligible(reward, now)) return false;
    if (!passesChestFilters(reward, filters)) return false;
    if (filters.minCoins > 0 && reward.totalCoins < filters.minCoins) return false;
    var r = ratio(reward);
    if (filters.minRatio !== null && filters.minRatio !== undefined && (r === null || r < filters.minRatio)) return false;
    if (filters.maxRatio !== null && filters.maxRatio !== undefined && (r === null || r > filters.maxRatio)) return false;
    if (filters.maxCoins !== null && filters.maxCoins !== undefined && reward.totalCoins > filters.maxCoins) return false;
    if (filters.minViewers > 0 && reward.viewerCount < filters.minViewers) return false;
    if (filters.maxViewers !== null && filters.maxViewers !== undefined && reward.viewerCount > filters.maxViewers) return false;
    if (filters.lowView && reward.eventKind === 'chest') {
      if (reward.viewerCount <= 0 || reward.winnerCount <= 0 || reward.viewerCount >= reward.winnerCount) return false;
    }
    if (filters.minSeconds > 0 && reward.expiresAt > 0 && reward.expiresAt - now < filters.minSeconds * 1000) return false;
    if (reward.eventKind === 'bag' && Array.isArray(filters.levels) && filters.levels.length) {
      if (filters.levels.indexOf(reward.bagLevel) === -1) return false;
    }
    return true;
  }

  function visible(rewards, tab, filters, now) {
    now = Number(now) || Date.now();
    filters = filters || {};
    tab = tab || 'chest';
    return (rewards || []).filter(function (reward) {
      if (!passesFilters(reward, filters, now)) return false;
      if (tab === 'all') return true;
      if (tab === 'hung') return reward.eventKind === 'chest' && reward.chestStatus === 'hung';
      if (tab === 'bag') return reward.eventKind === 'bag' && reward.chestStatus !== 'hung';
      return reward.eventKind === 'chest' && reward.chestStatus !== 'hung';
    }).sort(function (a, b) {
      var ao = a.opensAt || a.expiresAt || 0;
      var bo = b.opensAt || b.expiresAt || 0;
      if (tab === 'hung') return bo - ao || a.id.localeCompare(b.id);
      return ao - bo || a.id.localeCompare(b.id);
    });
  }

  function countdown(ms) {
    var total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function remainingText(reward, now) {
    now = Number(now) || Date.now();
    if (!reward) return '--:--';
    if (reward.chestStatus === 'hung') {
      return '+' + countdown(Math.max(0, now - reward.opensAt));
    }
    if (reward.opensAt > now) return countdown(reward.opensAt - now);
    if (reward.expiresAt > now) return countdown(reward.expiresAt - now);
    return '00:00';
  }

  function remainingLabel(reward, now) {
    now = Number(now) || Date.now();
    if (!reward) return '';
    if (reward.chestStatus === 'hung') return 'açılıştan beri';
    if (reward.opensAt > now) return 'kalan';
    return reward.expiresEstimated ? 'yerel takip' : 'kapanışa';
  }

  function bagMethodLabel(method) {
    return ({ 1: 'yorum', 2: 'paylaşım', 3: 'katılım' })[method] || '';
  }

  var PRESET_EPS = 1e-9;

  function matchesPreset(reward, preset) {
    if (!reward || !preset || preset === 'all') return true;
    var chest = reward.eventKind === 'chest';
    var active = chest && reward.chestStatus !== 'hung';
    var r = ratio(reward);
    if (preset === 'c2016') {
      return active && r !== null && r >= 1.2 - PRESET_EPS && r <= 1.25 + PRESET_EPS && reward.totalCoins >= 20;
    }
    if (preset === 'cgold') return active && reward.chestType === 'gold';
    if (preset === 'cr1') return active && reward.totalCoins === reward.winnerCount;
    if (preset === 'cr2') return active && r !== null && r >= 2 - PRESET_EPS;
    if (preset === 'cr4') return active && r !== null && r >= 4 - PRESET_EPS;
    if (preset === 'cluck') return active && r !== null && r >= 7 - PRESET_EPS;
    if (preset === 'chung') return chest && reward.chestStatus === 'hung';
    if (preset === 'b2') return reward.eventKind === 'bag' && reward.bagLevelKnown && reward.bagLevel >= 2 && reward.bagLevel <= 10;
    if (preset === 'b1') return reward.eventKind === 'bag' && reward.bagLevelKnown && reward.bagLevel === 1;
    if (preset === 'b0') return reward.eventKind === 'bag' && reward.bagLevelKnown && reward.bagLevel === 0;
    return true;
  }

  function normalizeFilters(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var numOrNull = function (value) {
      if (value === null || value === undefined || value === '') return null;
      var n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    var types = Array.isArray(raw.chestTypes)
      ? ['normal', 'gold'].filter(function (v) { return raw.chestTypes.indexOf(v) !== -1; })
      : ['normal', 'gold'];
    var states = Array.isArray(raw.chestStates)
      ? ['active', 'hung'].filter(function (v) { return raw.chestStates.indexOf(v) !== -1; })
      : ['active', 'hung'];
    var levels = Array.isArray(raw.levels)
      ? raw.levels.map(Number).filter(function (v) { return Number.isInteger(v) && v >= 0 && v <= 10; })
      : null;
    return {
      minCoins: Math.max(0, Math.min(1e9, Number(raw.minCoins) || 0)),
      maxCoins: numOrNull(raw.maxCoins),
      minRatio: numOrNull(raw.minRatio),
      maxRatio: numOrNull(raw.maxRatio),
      minViewers: Math.max(0, Math.min(1e9, Math.floor(Number(raw.minViewers) || 0))),
      maxViewers: numOrNull(raw.maxViewers),
      minSeconds: Math.max(0, Math.min(86400, Math.floor(Number(raw.minSeconds) || 0))),
      lowView: raw.lowView === true,
      levels: levels,
      chestTypes: types.length ? types : ['normal', 'gold'],
      chestStates: states.length ? states : ['active', 'hung']
    };
  }

  return {
    HUNG_MAX_AGE_MS: HUNG_MAX_AGE_MS,
    COLLECT_WINDOW_MS: COLLECT_WINDOW_MS,
    normalizeBox: normalizeBox,
    denominator: denominator,
    ratio: ratio,
    eligible: eligible,
    passesChestFilters: passesChestFilters,
    passesFilters: passesFilters,
    visible: visible,
    isExpired: isExpired,
    countdown: countdown,
    remainingText: remainingText,
    remainingLabel: remainingLabel,
    bagMethodLabel: bagMethodLabel,
    matchesPreset: matchesPreset,
    normalizeFilters: normalizeFilters
  };
});
