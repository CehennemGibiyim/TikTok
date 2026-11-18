'use strict';

(function () {
  var Engine = window.RewardEngine;
  var Policy = window.NotifyPolicy || null;
  var BoxMath = window.BoxMath || null;
  var OutcomeReport = window.OutcomeReport || null;
  var BOXES_URL = '../firsat/data/boxes.json';
  var LIVE_URL = '../firsat/data/live.json';
  var BOX_STREAM_TOPIC = 'cehennem-tiktok-firsat-7f3a91';
  var BOX_STREAM_KEY = 'XQMPSwldDoS26gnVIV1ClCyb';
  var FILTER_KEY = 'tiktok-live-radar-filters-v1';
  var SOUND_KEY = 'tiktok-live-radar-sound';
  var TAB_KEY = 'tiktok-live-radar-tab';
  var NOTIFY_KEY = 'tiktok-live-radar-notify-v1';
  var OUTCOME_KEY = 'tiktok-live-radar-outcomes-v1';
  // Bildirilecek kutu "yeni" sayılmalı: sayfa açılışındaki eski kayıtlar atlanır.
  var NOTIFY_FRESH_MS = 5 * 60 * 1000;

  var state = {
    raw: new Map(),
    live: null,
    tab: 'chest',
    preset: 'all',
    sort: 'time',
    view: 'list',
    fixedIds: [],
    creatorCounts: new Map(),
    filters: loadFilters(),
    roomQuery: '',
    boxesScannedAt: 0,
    sound: false,
    notify: loadNotify(),
    notified: new Set(),
    notifyReady: false,
    notifiedCount: 0,
    quietActive: false,
    outcomes: loadOutcomes(),
    outcomeSig: '',
    lastBoxAt: 0,
    lastFetchOk: false,
    current: [],
    lastIds: '',
    beeped: new Set(),
    stream: null,
    streamOpen: false,
    streamError: false,
    lastError: ''
  };

  var el = {
    cards: document.getElementById('cards'),
    empty: document.getElementById('empty'),
    emptyTitle: document.getElementById('emptyTitle'),
    emptyNote: document.getElementById('emptyNote'),
    fileStatus: document.getElementById('fileStatus'),
    streamStatus: document.getElementById('streamStatus'),
    updatedAt: document.getElementById('updatedAt'),
    resultCount: document.getElementById('resultCount'),
    filterCount: document.getElementById('filterCount'),
    soundBtn: document.getElementById('soundBtn'),
    notifyBtn: document.getElementById('notifyBtn'),
    notifyScore: document.getElementById('notifyScore'),
    quietStart: document.getElementById('quietStart'),
    quietEnd: document.getElementById('quietEnd'),
    notifyState: document.getElementById('notifyState'),
    notifyHint: document.getElementById('notifyHint'),
    outcomePick: document.getElementById('outcomePick'),
    outcomePerWinner: document.getElementById('outcomePerWinner'),
    outcomeWon: document.getElementById('outcomeWon'),
    outcomeSave: document.getElementById('outcomeSave'),
    outcomeClear: document.getElementById('outcomeClear'),
    outcomeHint: document.getElementById('outcomeHint'),
    outcomeReport: document.getElementById('outcomeReport'),
    outcomeCount: document.getElementById('outcomeCount'),
    sortMode: document.getElementById('sortMode'),
    presetMode: document.getElementById('presetMode'),
    viewMode: document.getElementById('viewMode'),
    minCoins: document.getElementById('minCoins'),
    maxCoins: document.getElementById('maxCoins'),
    minRatio: document.getElementById('minRatio'),
    maxRatio: document.getElementById('maxRatio'),
    minViewers: document.getElementById('minViewers'),
    maxViewers: document.getElementById('maxViewers'),
    minSeconds: document.getElementById('minSeconds'),
    bagLevel: document.getElementById('bagLevel'),
    sourceNote: document.getElementById('sourceNote'),
    sourceLive: document.getElementById('sourceLive'),
    sourceRooms: document.getElementById('sourceRooms'),
    sourceBoxes: document.getElementById('sourceBoxes'),
    roomCount: document.getElementById('roomCount'),
    roomList: document.getElementById('roomList'),
    roomSearch: document.getElementById('roomSearch'),
    lowView: document.getElementById('lowView'),
    typeNormal: document.getElementById('typeNormal'),
    typeGold: document.getElementById('typeGold'),
    stateActive: document.getElementById('stateActive'),
    stateHung: document.getElementById('stateHung'),
    filterBox: document.getElementById('filterBox')
  };

  function loadFilters() {
    try {
      return Engine.normalizeFilters(JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'));
    } catch (error) {
      return Engine.normalizeFilters(null);
    }
  }

  function saveFilters() {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters)); } catch (error) { /* yoksay */ }
  }

  function savedBoolean(key) {
    try { return localStorage.getItem(key) === '1'; } catch (error) { return false; }
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function fmt(value) {
    return new Intl.NumberFormat('tr-TR').format(Number(value) || 0);
  }

  function flag(code) {
    var cc = String(code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '';
    return String.fromCodePoint(cc.charCodeAt(0) + 127397, cc.charCodeAt(1) + 127397);
  }

  function liveUrl(creator) {
    return 'https://www.tiktok.com/@' + encodeURIComponent(creator) + '/live';
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function appUrl(creator, roomId) {
    if (isMobile() && roomId && /^\d{1,24}$/.test(String(roomId))) {
      return 'snssdk1128://live?room_id=' + encodeURIComponent(roomId) + '&from=webview&refer=web';
    }
    return liveUrl(creator);
  }

  function timeText(ts) {
    var value = Number(ts) || 0;
    if (!value) return '';
    return new Date(value).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  function ingestBox(box) {
    if (!box || !box.id || !box.username) return;
    var old = state.raw.get(box.id);
    if (old) {
      var merged = Object.assign({}, old, box);
      // Ayrıntılı alanlar sonradan gelirse fakir kaydı ezmesin.
      ['coins', 'durationSec', 'unpackAt', 'availableAt', 'shared', 'winners', 'winnerCount',
        'winnerSlots', 'participants', 'participantCount', 'viewers', 'viewerCount',
        'boxType', 'boxName', 'businessType', 'bagLevel', 'bagMethod', 'bagComment',
        'participantStatus'].forEach(function (key) {
        var next = box[key];
        if ((next === undefined || next === null || next === '' || Number(next) === 0) && old[key] !== undefined) {
          merged[key] = old[key];
        }
      });
      if (!box.hasWindow && old.hasWindow) merged.hasWindow = true;
      state.raw.set(box.id, merged);
    } else {
      state.raw.set(box.id, box);
    }
    state.lastBoxAt = Date.now();
  }

  function rewards(now) {
    var out = [];
    var counts = new Map();
    var liveByUser = new Map();
    var streamers = state.live && Array.isArray(state.live.streamers) ? state.live.streamers : [];
    streamers.forEach(function (streamer) {
      if (streamer && streamer.username) liveByUser.set(streamer.username, streamer);
    });
    state.raw.forEach(function (box) {
      var reward = Engine.normalizeBox(box, now);
      if (!reward) return;
      // İzleyici sayısı kutunun düştüğü an değil, odanın şu anki değeri olsun.
      var live = liveByUser.get(reward.creator);
      if (live && Number(live.viewers) > 0) reward.viewerCount = Number(live.viewers);
      out.push(reward);
      counts.set(reward.creator, (counts.get(reward.creator) || 0) + 1);
    });
    state.creatorCounts = counts;
    return out;
  }

  function applySort(list) {
    var copy = list.slice();
    if (state.sort === 'coins') {
      copy.sort(function (a, b) { return b.totalCoins - a.totalCoins || a.id.localeCompare(b.id); });
    } else if (state.sort === 'ratio') {
      copy.sort(function (a, b) {
        var ar = Engine.ratio(a);
        var br = Engine.ratio(b);
        return (br === null ? -1 : br) - (ar === null ? -1 : ar) || a.id.localeCompare(b.id);
      });
    } else if (state.sort === 'viewers') {
      copy.sort(function (a, b) { return a.viewerCount - b.viewerCount || a.id.localeCompare(b.id); });
    }
    return copy;
  }

  function fixedOrder(list) {
    var byId = new Map();
    list.forEach(function (reward) { byId.set(reward.id, reward); });
    var ids = state.fixedIds.filter(function (id) { return byId.has(id); });
    list.forEach(function (reward) {
      if (ids.indexOf(reward.id) === -1) ids.push(reward.id);
    });
    state.fixedIds = ids;
    return ids.map(function (id) { return byId.get(id); });
  }

  function chooseVisible(now) {
    var all = rewards(now);
    var preset = all.filter(function (reward) {
      return Engine.matchesPreset(reward, state.preset);
    });
    var list = applySort(Engine.visible(preset, state.tab, state.filters, now));
    if (state.view === 'fixed') list = fixedOrder(list);
    return { all: all, list: list };
  }

  function activeFilterCount() {
    var f = state.filters;
    var count = 0;
    if (f.minCoins > 0) count += 1;
    if (f.maxCoins !== null) count += 1;
    if (f.minRatio !== null) count += 1;
    if (f.maxRatio !== null) count += 1;
    if (f.minViewers > 0) count += 1;
    if (f.maxViewers !== null) count += 1;
    if (f.minSeconds > 0) count += 1;
    if (f.lowView) count += 1;
    if (f.chestTypes.length !== 2) count += 1;
    if (f.chestStates.length !== 2) count += 1;
    if (Array.isArray(f.levels)) count += 1;
    return count;
  }

  function cardHtml(reward, now) {
    var hung = reward.chestStatus === 'hung';
    var opening = !hung && reward.opensAt > now;
    var urgent = !hung && reward.opensAt > 0 && reward.opensAt - now <= 15000;
    var lowView = reward.eventKind === 'chest' && reward.viewerCount > 0 &&
      reward.winnerCount > 0 && reward.viewerCount < reward.winnerCount;
    var gold = reward.chestType === 'gold';
    var denominator = Engine.denominator(reward);
    var ratio = Engine.ratio(reward);
    var tags = [];
    if (reward.eventKind === 'chest') {
      tags.push('<span class="hud-tag tag-box">' + esc(reward.eventLabel || 'SANDIK') + '</span>');
      if (gold) tags.push('<span class="hud-tag tag-gold">ALTIN KUTU</span>');
      if (hung) tags.push('<span class="hud-tag tag-hung">BEKLEYEN SANDIK</span>');
      if (lowView) tags.push('<span class="hud-tag tag-easy">İZLEYİCİ &lt; KONTENJAN</span>');
    } else if (reward.eventKind === 'bag') {
      tags.push('<span class="hud-tag tag-bag">ZARF / ÇANTA' + (reward.bagLevel ? ' · LV' + reward.bagLevel : '') + '</span>');
      var method = Engine.bagMethodLabel(reward.bagMethod);
      if (method) tags.push('<span class="hud-tag tag-req">' + esc(method) + '</span>');
    } else {
      tags.push('<span class="hud-tag tag-box">PORTAL</span>');
    }

    var comment = reward.eventKind === 'bag' && reward.bagComment
      ? '<div class="bag-comment"><span class="bc-text" title="' + esc(reward.bagComment) + '">“' + esc(reward.bagComment) + '”</span>' +
        '<button class="bc-copy" type="button" data-copy-comment="' + esc(reward.id) + '">kopyala</button></div>'
      : '';

    return '<article class="loot-card' + (gold ? ' gold-tier' : '') + (hung ? ' hung' : '') + (urgent ? ' urgent' : '') +
      '" data-id="' + esc(reward.id) + '" data-status="' + esc(reward.chestStatus) + '">' +
      '<div class="loot-clock"><strong>' + esc(Engine.remainingText(reward, now)) + '</strong>' +
        '<small>' + esc(Engine.remainingLabel(reward, now)) + '</small></div>' +
      '<div class="loot-body">' +
        '<div class="loot-name"><a href="' + esc(liveUrl(reward.creator)) + '" target="_blank" rel="noopener">@' + esc(reward.creator) + '</a>' +
          (reward.countryCode ? '<span title="' + esc(reward.countryCode) + '">' + flag(reward.countryCode) + '</span>' : '') +
        '</div>' +
        '<div class="tag-strip">' + tags.join('') + '</div>' +
        '<div class="loot-metrics">' +
          '<span class="metric coins">🪙 <b>' + (reward.totalCoins > 0 ? fmt(reward.totalCoins) : 'bilinmiyor') + '</b> jeton</span>' +
          '<span class="metric ratio">📊 <b>' + (ratio === null ? '…' : ratio.toFixed(2)) + '</b> oran</span>' +
          '<span class="metric viewers">👥 <b>' + (reward.viewerCount > 0 ? fmt(reward.viewerCount) : '—') + '</b> izleyici</span>' +
          '<span class="metric">🎯 <b>' + (denominator > 0 ? fmt(denominator) : '—') + '</b> kontenjan</span>' +
          (reward.participantCount > 0 ? '<span class="metric">🙋 <b>' + fmt(reward.participantCount) + '</b> katılımcı</span>' : '') +
          '<span class="metric">⏱ <b>' + (reward.durationSec > 0 ? reward.durationSec + ' sn' : '—') + '</b></span>' +
          '<span class="metric">📦 <b>' + (state.creatorCounts && state.creatorCounts.get(reward.creator) || 1) + '</b> kutu</span>' +
          (reward.hasWindow && reward.opensAt ? '<span class="metric">🕒 <b>' + timeText(reward.opensAt) + '</b> açılış</span>' : '') +
          (reward.senderName && reward.senderName !== reward.creator ? '<span class="metric">📤 paylaşan <b>@' + esc(reward.senderName) + '</b></span>' : '') +
        '</div>' +
        comment +
      '</div>' +
      '<div class="loot-actions">' +
        '<a class="btn-open" href="' + esc(liveUrl(reward.creator)) + '" target="_blank" rel="noopener">CANLIYA GİT</a>' +
        '<a class="btn-app" href="' + esc(appUrl(reward.creator, reward.roomId)) + '">' + (isMobile() ? '📱 Uygulamada' : '🌐 Web\'de aç') + '</a>' +
      '</div>' +
    '</article>';
  }

  function renderTabs(all, now) {
    var chest = all.filter(function (r) { return r.eventKind === 'chest' && r.chestStatus !== 'hung' && Engine.eligible(r, now); }).length;
    var bag = all.filter(function (r) { return r.eventKind === 'bag' && Engine.eligible(r, now); }).length;
    var hung = all.filter(function (r) { return r.eventKind === 'chest' && r.chestStatus === 'hung' && Engine.eligible(r, now); }).length;
    document.getElementById('countChest').textContent = chest;
    document.getElementById('countBag').textContent = bag;
    document.getElementById('countHung').textContent = hung;
    document.getElementById('countAll').textContent = chest + bag + hung;
  }

  function renderStats(all, now) {
    var scanner = state.live && state.live.scanner ? state.live.scanner : {};
    var streamers = state.live && Array.isArray(state.live.streamers) ? state.live.streamers : [];
    var liveCount = Number(scanner.liveCount);
    if (!Number.isFinite(liveCount) || liveCount <= 0) {
      liveCount = streamers.filter(function (s) { return s && s.live === true; }).length;
    }
    var watching = Number(scanner.watching) || 0;
    var budget = Number(scanner.budget) || watching;
    var active = all.filter(function (r) { return r.eventKind === 'chest' && r.chestStatus === 'active' && Engine.eligible(r, now); }).length;
    var hung = all.filter(function (r) { return r.eventKind === 'chest' && r.chestStatus === 'hung' && Engine.eligible(r, now); }).length;
    var bags = all.filter(function (r) { return r.eventKind === 'bag' && Engine.eligible(r, now); }).length;
    document.getElementById('statLive').textContent = liveCount || '—';
    document.getElementById('statWatching').textContent = watching ? watching + '/' + (budget || watching) : '—';
    document.getElementById('statActive').textContent = active;
    document.getElementById('statHung').textContent = hung;
    document.getElementById('statBag').textContent = bags;
    var note = document.getElementById('statLiveNote');
    if (note) note.textContent = scanner.scannedAt ? 'son tarama ' + timeText(new Date(scanner.scannedAt).getTime()) : 'tarama';
    var wnote = document.getElementById('statWatchingNote');
    if (wnote) wnote.textContent = scanner.connectStats && Number(scanner.connectStats.ok)
      ? Number(scanner.connectStats.ok) + ' başarılı bağlantı' : 'bağlantı';
  }

  function render() {
    var now = Date.now();
    var result = chooseVisible(now);
    var list = result.list;
    state.current = list;
    state.lastIds = list.map(function (item) { return item.id; }).join('|');
    renderTabs(result.all, now);
    renderStats(result.all, now);

    el.cards.innerHTML = list.map(function (reward) { return cardHtml(reward, now); }).join('');
    el.empty.hidden = list.length > 0;
    if (!list.length) {
      var hasAny = result.all.some(function (item) { return Engine.eligible(item, now); });
      el.emptyTitle.textContent = hasAny ? 'Bu filtreye uyan kutu yok' : 'Eşleşen canlı oda bekleniyor';
      el.emptyNote.textContent = hasAny
        ? 'Filtreleri gevşetip diğer sekmelere bakabilirsin.'
        : 'Tarayıcı yeni sandık/zarf yakaladığında burada belirir. Veri dosyası 10 saniyede bir yenilenir.';
    }
    el.resultCount.textContent = list.length + ' kutu';
    el.filterCount.textContent = String(activeFilterCount());

    updateSourceStatus();
    el.updatedAt.textContent = state.lastBoxAt ? 'kutu ' + timeText(state.lastBoxAt) : '—';
    maybeBeep(list, now);
    syncQuiet(now);
    maybeNotifyBoxes(result.all, now);
    syncOutcomeOptions();
  }

  function tick() {
    var now = Date.now();
    var result = chooseVisible(now);
    var ids = result.list.map(function (item) { return item.id; }).join('|');
    if (ids !== state.lastIds) {
      render();
      return;
    }
    state.current = result.list;
    result.list.forEach(function (reward) {
      var card = el.cards.querySelector('[data-id="' + cssEscape(reward.id) + '"]');
      if (!card) return;
      if (card.getAttribute('data-status') !== reward.chestStatus) {
        render();
        return;
      }
      var clock = card.querySelector('.loot-clock strong');
      var label = card.querySelector('.loot-clock small');
      if (clock) clock.textContent = Engine.remainingText(reward, now);
      if (label) label.textContent = Engine.remainingLabel(reward, now);
      var urgent = reward.chestStatus === 'active' && reward.opensAt > 0 && reward.opensAt - now <= 15000;
      card.classList.toggle('urgent', urgent);
    });
    maybeBeep(result.list, now);
    syncQuiet(now);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var context = new Ctx();
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.15);
      oscillator.onended = function () { try { context.close(); } catch (error) { /* yoksay */ } };
    } catch (error) { /* ses desteklenmiyorsa sessiz */ }
  }

  function maybeBeep(list, now) {
    if (!state.sound) return;
    list.forEach(function (reward) {
      if (reward.chestStatus === 'hung') return;
      var alerts = [];
      // Sandıkta hem açılış hem yerel kapanış; zarfta kapanış uyarısı.
      if (reward.eventKind === 'chest' && reward.opensAt) alerts.push({ at: reward.opensAt, key: ':open' });
      if (reward.expiresAt) alerts.push({ at: reward.expiresAt, key: ':expire' });
      alerts.forEach(function (alert) {
        var left = alert.at - now;
        var key = reward.id + alert.key;
        if (left > 0 && left <= 10000 && !state.beeped.has(key)) {
          state.beeped.add(key);
          beep();
        }
      });
    });
    if (state.beeped.size > 1000) state.beeped.clear();
  }

  function setSound(on) {
    state.sound = Boolean(on);
    el.soundBtn.setAttribute('aria-pressed', String(state.sound));
    el.soundBtn.textContent = state.sound ? '🔔 Ses açık' : '🔕 Ses kapalı';
    try { localStorage.setItem(SOUND_KEY, state.sound ? '1' : '0'); } catch (error) { /* yoksay */ }
    if (state.sound) beep();
  }

  function loadNotify() {
    var defaults = { enabled: false, minScore: 0, quietStart: '', quietEnd: '' };
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(NOTIFY_KEY) || 'null');
    } catch (error) {
      return defaults;
    }
    if (!raw || typeof raw !== 'object') return defaults;
    var clock = function (value) {
      return Policy ? Policy.formatClock(Policy.parseClock(value)) : '';
    };
    return {
      enabled: raw.enabled === true,
      minScore: Math.max(0, Math.min(100, Math.round(Number(raw.minScore) || 0))),
      quietStart: clock(raw.quietStart),
      quietEnd: clock(raw.quietEnd)
    };
  }

  function saveNotify() {
    try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(state.notify)); } catch (error) { /* yoksay */ }
  }

  function notifyAvailable() {
    return Boolean(Policy) && typeof window.Notification !== 'undefined';
  }

  // Sessiz saat kararı her zaman güncel saate göre verilir; önbellek yalnızca
  // başlıktaki etiketi tazelemek için tutulur.
  function quietNow(now) {
    if (!Policy) return false;
    return Policy.inQuietHours(new Date(now || Date.now()), state.notify.quietStart, state.notify.quietEnd);
  }

  function boxScore(reward, now) {
    return Policy.opportunityScore({
      ratio: Engine.ratio(reward),
      totalCoins: reward.totalCoins,
      winnerCount: reward.winnerCount,
      viewerCount: reward.viewerCount,
      opensAt: reward.opensAt,
      now: now
    });
  }

  function presetLabel() {
    if (!el.presetMode || el.presetMode.selectedIndex < 0) return 'tümü';
    if (el.presetMode.value === 'all') return 'tümü';
    return el.presetMode.options[el.presetMode.selectedIndex].textContent;
  }

  function updateNotifyUi(note) {
    var cfg = state.notify;
    var available = notifyAvailable();
    var permission = typeof window.Notification === 'undefined' ? 'unsupported' : window.Notification.permission;
    el.notifyBtn.setAttribute('aria-pressed', String(cfg.enabled));
    el.notifyBtn.textContent = cfg.enabled ? '🔔 Bildirim açık' : '🔕 Bildirim kapalı';
    var stateText;
    if (!available) stateText = 'desteklenmiyor';
    else if (cfg.enabled) stateText = state.quietActive ? 'sessiz saat' : 'açık';
    else if (permission === 'denied') stateText = 'izin engelli';
    else stateText = 'kapalı';
    el.notifyState.textContent = stateText;
    var parts = [
      'skor ≥ ' + cfg.minScore,
      cfg.quietStart && cfg.quietEnd ? 'sessiz ' + cfg.quietStart + '–' + cfg.quietEnd : 'sessiz saat yok',
      'hazır filtre: ' + presetLabel(),
      'bu oturumda ' + state.notifiedCount + ' bildirim'
    ];
    if (!available) parts.push('tarayıcı bildirim API’si yok');
    else if (permission === 'denied') parts.push('adres çubuğundan izin ver');
    if (note) parts.push(note);
    el.notifyHint.textContent = parts.join(' · ');
  }

  function syncQuiet(now) {
    if (!Policy || !el.notifyHint) return;
    var quiet = quietNow(now);
    if (quiet === state.quietActive) return;
    state.quietActive = quiet;
    updateNotifyUi();
  }

  // Mevcut kutuları "görüldü" say ve hattı hazır işaretle. Seed, ready'den
  // önce çalışır: yarıda hata olsa bile hat seed'siz açılmaz.
  function seedNotifyBaseline() {
    var now = Date.now();
    rewards(now).forEach(function (reward) {
      if (reward.id) state.notified.add(reward.id);
    });
    state.notifyReady = true;
  }

  /*
   * Bildirim hattını ilk başarılı veri yolunda (boxes.json veya ntfy) açar.
   * ntfy yolunda gelen yeni kutudan önce çağrılır; böylece yalnızca o kutu
   * bildirim adayı olur ve açılışta bildirim yağmaz. Seed yalnızca bir kez
   * yapılır; sonraki çağrılar hazır hattı olduğu gibi bırakır.
   */
  function activateNotifyPipeline() {
    if (!state.notifyReady) seedNotifyBaseline();
  }

  function sendNotification(reward, score, now) {
    var parts = [];
    if (reward.totalCoins > 0) parts.push('🪙 ' + fmt(reward.totalCoins) + ' jeton');
    var ratio = Engine.ratio(reward);
    if (ratio !== null) parts.push('oran ' + ratio.toFixed(2));
    if (reward.opensAt > now) parts.push(Engine.countdown(reward.opensAt - now) + ' kaldı');
    parts.push('skor ' + score);
    var title = (reward.eventKind === 'chest' ? 'Sandık' : 'Zarf') + ' · @' + reward.creator +
      (reward.chestType === 'gold' ? ' · ALTIN' : '');
    try {
      var notification = new window.Notification(title, {
        body: parts.join(' · '),
        // Aynı kutu için işletim sistemi tarafında da tek bildirim kalsın.
        tag: 'box-' + reward.id
      });
      notification.onclick = function () {
        window.focus();
        notification.close();
      };
    } catch (error) {
      return;
    }
    state.notifiedCount += 1;
    updateNotifyUi();
  }

  function maybeNotifyBoxes(list, now) {
    var cfg = state.notify;
    if (!cfg.enabled || !state.notifyReady || !notifyAvailable()) return;
    if (window.Notification.permission !== 'granted') return;
    var quiet = quietNow(now);
    list.forEach(function (reward) {
      if (!reward || !reward.id) return;
      // Açılmış/bekleyen ve eski kutular bildirilmez.
      if (reward.chestStatus === 'hung') return;
      if (now - Number(reward.observedAt) > NOTIFY_FRESH_MS) return;
      if (!Engine.eligible(reward, now) || !Engine.matchesPreset(reward, state.preset)) return;
      var score = boxScore(reward, now);
      if (!Policy.shouldNotify({
        match: true,
        score: score,
        minScore: cfg.minScore,
        quiet: quiet,
        seen: state.notified.has(reward.id)
      })) return;
      // Aynı kutu ikinci kez bildirilmesin (iki kanal + dosya yenilemesi).
      state.notified.add(reward.id);
      sendNotification(reward, score, now);
    });
  }

  function applyNotifyInputs() {
    var cfg = state.notify;
    cfg.minScore = Math.max(0, Math.min(100, Math.round(Number(el.notifyScore.value) || 0)));
    if (Policy) {
      cfg.quietStart = Policy.formatClock(Policy.parseClock(el.quietStart.value));
      cfg.quietEnd = Policy.formatClock(Policy.parseClock(el.quietEnd.value));
      state.quietActive = quietNow();
    }
    el.notifyScore.value = cfg.minScore > 0 ? String(cfg.minScore) : '';
    el.quietStart.value = cfg.quietStart;
    el.quietEnd.value = cfg.quietEnd;
    saveNotify();
    updateNotifyUi();
  }

  function toggleNotify() {
    if (state.notify.enabled) {
      state.notify.enabled = false;
      saveNotify();
      updateNotifyUi();
      return;
    }
    if (!notifyAvailable()) {
      updateNotifyUi(Policy ? 'bu tarayıcı bildirim desteklemiyor' : 'bildirim modülü yüklenmedi');
      return;
    }
    if (window.Notification.permission === 'denied') {
      updateNotifyUi('bildirim izni engellenmiş');
      return;
    }
    var enable = function () {
      if (window.Notification.permission !== 'granted') {
        updateNotifyUi('izin verilmedi');
        return;
      }
      state.notify.enabled = true;
      // Açma anında listede duran kutular bildirilmesin; sonrakiler bildirilir.
      seedNotifyBaseline();
      saveNotify();
      updateNotifyUi();
      beep();
    };
    if (window.Notification.permission === 'default') {
      window.Notification.requestPermission().then(enable, function () { updateNotifyUi('izin istenemedi'); });
    } else {
      enable();
    }
  }

  function loadOutcomes() {
    try {
      var raw = JSON.parse(localStorage.getItem(OUTCOME_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (item) {
        return item && item.id && item.predicted && item.actual;
      }).slice(0, 500);
    } catch (error) {
      return [];
    }
  }

  function saveOutcomes() {
    try {
      localStorage.setItem(OUTCOME_KEY, JSON.stringify(state.outcomes.slice(0, 500)));
    } catch (error) { /* yoksay */ }
  }

  // Tahmini olan kutular (oran veya olasılık üretilebilenler), en yeniden eskiye.
  function analyzableBoxes() {
    if (!BoxMath) return [];
    var list = [];
    state.raw.forEach(function (box) {
      var analyzed = BoxMath.analyzeBox(box);
      if (analyzed.expectedPerWinner === null && analyzed.winProbability === null) return;
      list.push({
        analyzed: analyzed,
        creator: String(box.username || ''),
        at: Number(box.t) || Number(analyzed.startAt) || 0
      });
    });
    list.sort(function (a, b) {
      return b.at - a.at || a.analyzed.id.localeCompare(b.analyzed.id);
    });
    return list.slice(0, 50);
  }

  function two(value) {
    return Number(value).toFixed(2);
  }

  function signed(value) {
    var number = Number(value) || 0;
    if (!number) return '0.00';
    return (number > 0 ? '+' : '−') + two(Math.abs(number));
  }

  function updateOutcomeHint() {
    if (!el.outcomeHint) return;
    if (el.outcomeCount) el.outcomeCount.textContent = state.outcomes.length + ' sonuç';
    var id = el.outcomePick ? el.outcomePick.value : '';
    var box = id ? state.raw.get(id) : null;
    var analyzed = box && BoxMath ? BoxMath.analyzeBox(box) : null;
    var parts = [];
    if (analyzed) {
      parts.push('tahmin: kazanan başına ' +
        (analyzed.expectedPerWinner === null ? '—' : two(analyzed.expectedPerWinner)) +
        (analyzed.winProbability === null ? '' : ' · olasılık %' + Math.round(analyzed.winProbability * 100)));
      if (analyzed.expectedCoins !== null) parts.push('katılım başına ' + two(analyzed.expectedCoins));
    } else {
      parts.push('kayıt için tahmin üreten bir kutu seç');
    }
    el.outcomeHint.textContent = parts.join(' · ');
  }

  // Seçenek listesi yalnızca kutu kümesi/tahmin girdileri değişince yeniden kurulur.
  function syncOutcomeOptions() {
    if (!el.outcomePick || !BoxMath) return;
    var boxes = analyzableBoxes();
    var signature = boxes.map(function (item) {
      return item.analyzed.id + ':' + item.analyzed.totalCoins + ':' +
        item.analyzed.winnerCount + ':' + item.analyzed.winProbability;
    }).join('|');
    if (signature === state.outcomeSig) return;
    state.outcomeSig = signature;
    var previous = el.outcomePick.value;
    el.outcomePick.innerHTML = boxes.length ? boxes.map(function (item) {
      var analyzed = item.analyzed;
      return '<option value="' + esc(analyzed.id) + '">@' + esc(item.creator) +
        ' · ' + (analyzed.kind === 'bag' ? 'Zarf' : analyzed.kind === 'chest' ? 'Sandık' : 'Portal') +
        ' · ' + (analyzed.totalCoins === null ? '?' : fmt(analyzed.totalCoins)) + '/' +
        (analyzed.winnerCount === null ? '?' : fmt(analyzed.winnerCount)) +
        ' · tahmin ' + (analyzed.expectedPerWinner === null ? '—' : two(analyzed.expectedPerWinner)) +
        (analyzed.winProbability === null ? '' : ' · p %' + Math.round(analyzed.winProbability * 100)) +
        '</option>';
    }).join('') : '<option value="">Tahmin üreten kutu yok</option>';
    if (previous) el.outcomePick.value = previous;
    if (!el.outcomePick.value && el.outcomePick.options.length) el.outcomePick.selectedIndex = 0;
    updateOutcomeHint();
  }

  function saveOutcome() {
    if (!el.outcomeHint) return;
    if (!BoxMath || !OutcomeReport) {
      el.outcomeHint.textContent = 'kalibrasyon modülü yüklenmedi';
      return;
    }
    var id = el.outcomePick ? el.outcomePick.value : '';
    var box = id ? state.raw.get(id) : null;
    if (!box) {
      el.outcomeHint.textContent = 'önce listeden bir kutu seç';
      return;
    }
    var actual = {
      perWinner: el.outcomePerWinner.value === '' ? null : Number(el.outcomePerWinner.value),
      won: el.outcomeWon.value === 'won' ? true : el.outcomeWon.value === 'lost' ? false : null
    };
    var record = OutcomeReport.buildRecord(BoxMath.analyzeBox(box), actual, {
      creator: String(box.username || ''),
      recordedAt: Date.now()
    });
    if (record.error) {
      el.outcomeHint.textContent = record.error;
      return;
    }
    // Aynı kutu için tek kayıt: yeniden girmek düzeltme sayılır.
    state.outcomes = state.outcomes.filter(function (item) { return item.id !== record.id; });
    state.outcomes.unshift(record);
    if (state.outcomes.length > 500) state.outcomes.length = 500;
    saveOutcomes();
    el.outcomePerWinner.value = '';
    el.outcomeWon.value = '';
    renderOutcomeReport();
    updateOutcomeHint();
    el.outcomeHint.textContent = 'kaydedildi: @' + record.creator + ' · ' +
      (record.kind === 'bag' ? 'zarf' : 'sandık') + ' · ' + state.outcomes.length + ' kayıt';
  }

  function clearOutcomes() {
    if (!state.outcomes.length) {
      if (el.outcomeHint) el.outcomeHint.textContent = 'silinecek kayıt yok';
      return;
    }
    state.outcomes = [];
    saveOutcomes();
    renderOutcomeReport();
    updateOutcomeHint();
    if (el.outcomeHint) el.outcomeHint.textContent = 'kayıtlar temizlendi';
  }

  function renderOutcomeReport() {
    if (!el.outcomeReport) return;
    if (el.outcomeCount) el.outcomeCount.textContent = state.outcomes.length + ' sonuç';
    if (!OutcomeReport) {
      el.outcomeReport.innerHTML = '<p class="hint">Kalibrasyon modülü yüklenmedi.</p>';
      return;
    }
    var summary = OutcomeReport.summarize(state.outcomes);
    if (!summary.count) {
      el.outcomeReport.innerHTML = '<p class="hint">Henüz sonuç kaydı yok. Kutuyu açtıktan sonra gerçek sonucu gir; tahminlerle karşılaştırılıp burada özetlenir.</p>';
      return;
    }
    var rows = [];
    if (summary.perWinner) {
      rows.push('Kazanan başına jeton: n=' + summary.perWinner.n +
        ' · tahmin ' + two(summary.perWinner.predictedMean) +
        ' · gerçek ' + two(summary.perWinner.actualMean) +
        ' · sapma ' + signed(summary.perWinner.bias) +
        ' · MAE ' + two(summary.perWinner.mae) +
        (summary.perWinner.mape === null ? '' : ' · MAPE %' + Math.round(summary.perWinner.mape * 100)));
    }
    if (summary.probability) {
      rows.push('Zarf olasılığı: n=' + summary.probability.n +
        ' · tahmin %' + Math.round(summary.probability.predictedMean * 100) +
        ' · gözlenen %' + Math.round(summary.probability.observedRate * 100) +
        ' · Brier ' + two(summary.probability.brier));
    }
    var html = '<ul class="report-list">' + rows.map(function (row) {
      return '<li>' + esc(row) + '</li>';
    }).join('') + '</ul>';
    var buckets = summary.buckets.filter(function (bucket) { return bucket.n > 0; });
    if (buckets.length) {
      html += '<ul class="report-list report-buckets">' + buckets.map(function (bucket) {
        return '<li>' + esc(bucket.label + ': n=' + bucket.n +
          ' · tahmin %' + Math.round(bucket.predictedMean * 100) +
          ' · gözlenen %' + Math.round(bucket.observedRate * 100)) + '</li>';
      }).join('') + '</ul>';
    }
    if (summary.count < 5) {
      html += '<p class="hint">n &lt; 5: sayılar yön göstergesi, istatistik değil.</p>';
    }
    el.outcomeReport.innerHTML = html;
  }

  function syncFilterUi() {
    var f = state.filters;
    el.minCoins.value = f.minCoins || '';
    el.maxCoins.value = f.maxCoins === null ? '' : f.maxCoins;
    el.minRatio.value = f.minRatio === null ? '' : f.minRatio;
    el.maxRatio.value = f.maxRatio === null ? '' : f.maxRatio;
    el.minViewers.value = f.minViewers || '';
    el.maxViewers.value = f.maxViewers === null ? '' : f.maxViewers;
    el.minSeconds.value = f.minSeconds || '';
    el.bagLevel.value = Array.isArray(f.levels) && f.levels.length ? String(f.levels[0]) : '';
    el.lowView.checked = f.lowView;
    el.typeNormal.checked = f.chestTypes.indexOf('normal') !== -1;
    el.typeGold.checked = f.chestTypes.indexOf('gold') !== -1;
    el.stateActive.checked = f.chestStates.indexOf('active') !== -1;
    el.stateHung.checked = f.chestStates.indexOf('hung') !== -1;
    el.filterCount.textContent = String(activeFilterCount());
  }

  function readFilterUi() {
    var types = [];
    if (el.typeNormal.checked) types.push('normal');
    if (el.typeGold.checked) types.push('gold');
    var states = [];
    if (el.stateActive.checked) states.push('active');
    if (el.stateHung.checked) states.push('hung');
    var level = el.bagLevel.value === '' ? null : [Number(el.bagLevel.value)];
    state.filters = Engine.normalizeFilters({
      minCoins: el.minCoins.value,
      maxCoins: el.maxCoins.value,
      minRatio: el.minRatio.value,
      maxRatio: el.maxRatio.value,
      minViewers: el.minViewers.value,
      maxViewers: el.maxViewers.value,
      minSeconds: el.minSeconds.value,
      lowView: el.lowView.checked,
      levels: level,
      chestTypes: types,
      chestStates: states
    });
    saveFilters();
    render();
  }

  async function fetchJson(url) {
    var response = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function refreshBoxes() {
    try {
      var data = await fetchJson(BOXES_URL);
      state.boxesScannedAt = data && data.scannedAt ? new Date(data.scannedAt).getTime() : 0;
      (data && Array.isArray(data.boxes) ? data.boxes : []).forEach(ingestBox);
      state.lastFetchOk = true;
      state.lastError = '';
      render();
      renderLiveSource();
      activateNotifyPipeline();
    } catch (error) {
      state.lastFetchOk = false;
      state.lastError = error.message;
      updateSourceStatus();
    }
  }

  function liveRooms() {
    var streamers = state.live && Array.isArray(state.live.streamers) ? state.live.streamers : [];
    return streamers.filter(function (streamer) {
      return streamer && streamer.live === true && streamer.username;
    }).sort(function (a, b) {
      return (Number(b.viewers) || 0) - (Number(a.viewers) || 0) ||
        String(a.username).localeCompare(String(b.username), 'tr');
    });
  }

  function roomRowHtml(streamer) {
    var username = String(streamer.username || '');
    var title = String(streamer.title || 'Başlık yok');
    var viewers = Number(streamer.viewers) || 0;
    var boxes = Number(streamer.boxCount || streamer.boxes) || 0;
    var seenRaw = Number(streamer.lastSeenLiveAt) || 0;
    var seen = seenRaw > 0 && seenRaw < 1e12 ? seenRaw * 1000 : seenRaw;
    return '<div class="room-row">' +
      '<div class="room-main"><a href="' + esc(liveUrl(username)) + '" target="_blank" rel="noopener">@' + esc(username) + '</a>' +
        '<span class="room-title" title="' + esc(title) + '">' + esc(title) + '</span></div>' +
      '<div class="room-meta">' +
        '<span>👥 ' + (viewers > 0 ? fmt(viewers) : '—') + '</span>' +
        '<span>📦 ' + (boxes > 0 ? fmt(boxes) : '—') + '</span>' +
        (streamer.roomId ? '<span class="room-id" title="TikTok oda kimliği">#' + esc(streamer.roomId) + '</span>' : '') +
        (seen > 0 ? '<span>' + esc(timeText(seen)) + '</span>' : '') +
      '</div>' +
      '<a class="room-open" href="' + esc(liveUrl(username)) + '" target="_blank" rel="noopener">Aç</a>' +
    '</div>';
  }

  function renderRoomList() {
    if (!el.roomList) return;
    var query = String(state.roomQuery || '').trim().toLowerCase();
    var list = liveRooms();
    if (query) {
      list = list.filter(function (streamer) {
        return String(streamer.username || '').toLowerCase().indexOf(query) !== -1 ||
          String(streamer.title || '').toLowerCase().indexOf(query) !== -1;
      });
    }
    if (el.roomCount) el.roomCount.textContent = String(list.length);
    el.roomList.innerHTML = list.length
      ? list.map(roomRowHtml).join('')
      : '<p class="hint room-empty">Canlı oda bulunamadı. Scanner yeni bir tur tamamladığında liste tazelenir.</p>';
  }

  // Dosya ve ntfy akışı ayrı yollardır: biri kapalıyken diğeri veri
  // getirebilir, bu yüzden durumları ayrı rozetlerde gösterilir.
  function updateSourceStatus() {
    var fileText, fileClass;
    if (state.lastFetchOk) {
      fileText = 'dosya ok';
      fileClass = '';
    } else if (state.lastError) {
      fileText = 'dosya okunamadı';
      fileClass = 'bad';
    } else {
      fileText = 'dosya bekleniyor';
      fileClass = 'warn';
    }
    el.fileStatus.textContent = fileText;
    el.fileStatus.className = 'status-pill' + (fileClass ? ' ' + fileClass : '');

    var streamText, streamClass;
    if (typeof EventSource !== 'function') {
      streamText = 'akış yok';
      streamClass = 'warn';
    } else if (state.streamOpen) {
      streamText = 'akış bağlı';
      streamClass = '';
    } else if (state.streamError) {
      streamText = 'akış kopuk';
      streamClass = 'warn';
    } else {
      streamText = 'akış bekleniyor';
      streamClass = 'warn';
    }
    el.streamStatus.textContent = streamText;
    el.streamStatus.className = 'status-pill' + (streamClass ? ' ' + streamClass : '');
  }

  function renderLiveSource() {
    var rooms = liveRooms();
    var withRoom = rooms.filter(function (streamer) { return Boolean(streamer.roomId); }).length;
    var scannedAt = state.live && state.live.scannedAt ? new Date(state.live.scannedAt).getTime() : 0;
    if (el.sourceLive) el.sourceLive.textContent = rooms.length ? fmt(rooms.length) : '—';
    if (el.sourceRooms) el.sourceRooms.textContent = withRoom ? fmt(withRoom) : '—';
    if (el.sourceBoxes) el.sourceBoxes.textContent = state.raw.size ? fmt(state.raw.size) : '—';
    if (el.sourceNote) {
      var parts = ['Kendi scanner verimiz · ücretli API kullanılmaz'];
      if (scannedAt) parts.push('live.json ' + timeText(scannedAt));
      if (state.boxesScannedAt) parts.push('kutular ' + timeText(state.boxesScannedAt));
      el.sourceNote.textContent = parts.join(' · ');
    }
    renderRoomList();
  }

  async function refreshLive() {
    try {
      state.live = await fetchJson(LIVE_URL);
      render();
      renderLiveSource();
    } catch (error) {
      // Kutu listesi çalışmaya devam eder.
      renderLiveSource();
    }
  }

  function connectStream() {
    if (state.stream || typeof EventSource !== 'function') return;
    try {
      state.stream = new EventSource('https://ntfy.sh/' + encodeURIComponent(BOX_STREAM_TOPIC) + '/sse');
      state.stream.addEventListener('message', function (message) {
        try {
          var outer = JSON.parse(message.data || '{}');
          if (outer.event && outer.event !== 'message') return;
          var box = outer.message ? JSON.parse(outer.message) : outer;
          if (!box || box.key !== BOX_STREAM_KEY) return;
          state.streamOpen = true;
          state.streamError = false;
          // Dosya yolu hiç çalışmadıysa hat burada açılır; önceden biriken
          // kutular görüldü sayılır, yalnızca bu yeni kutu bildirim adayı olur.
          activateNotifyPipeline();
          ingestBox(box);
          render();
        } catch (error) { /* bozuk mesaj */ }
      });
      state.stream.onopen = function () {
        state.streamOpen = true;
        state.streamError = false;
        updateSourceStatus();
      };
      state.stream.onerror = function () {
        // Kalıcı hata değil: 10 sn'lik dosya yenilemesi devrede kalır.
        state.streamOpen = false;
        state.streamError = true;
        updateSourceStatus();
      };
    } catch (error) {
      state.stream = null;
    }
  }

  function prune() {
    var now = Date.now();
    state.raw.forEach(function (box, id) {
      var reward = Engine.normalizeBox(box, now);
      if (!reward) state.raw.delete(id);
    });
  }

  function bind() {
    document.querySelectorAll('[data-tab]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.tab = button.getAttribute('data-tab') || 'chest';
        // Hazır filtre bir sekmeye kilitliyse elle sekme değiştirmek onu açar.
        state.preset = 'all';
        if (el.presetMode) el.presetMode.value = 'all';
        document.querySelectorAll('[data-tab]').forEach(function (item) {
          item.classList.toggle('active', item === button);
        });
        try { localStorage.setItem(TAB_KEY, state.tab); } catch (error) { /* yoksay */ }
        render();
        updateNotifyUi();
      });
    });

    el.sortMode.addEventListener('change', function () {
      state.sort = el.sortMode.value;
      render();
    });

    el.presetMode.addEventListener('change', function () {
      state.preset = el.presetMode.value || 'all';
      var bag = state.preset === 'b0' || state.preset === 'b1' || state.preset === 'b2';
      var hung = state.preset === 'chung';
      state.tab = bag ? 'bag' : (hung ? 'hung' : 'chest');
      document.querySelectorAll('[data-tab]').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-tab') === state.tab);
      });
      render();
      updateNotifyUi();
    });

    el.soundBtn.addEventListener('click', function () {
      setSound(!state.sound);
    });

    el.notifyBtn.addEventListener('click', toggleNotify);
    [el.notifyScore, el.quietStart, el.quietEnd].forEach(function (input) {
      input.addEventListener('change', applyNotifyInputs);
    });

    if (el.outcomeSave) el.outcomeSave.addEventListener('click', saveOutcome);
    if (el.outcomeClear) el.outcomeClear.addEventListener('click', clearOutcomes);
    if (el.outcomePick) el.outcomePick.addEventListener('change', updateOutcomeHint);

    el.viewMode.addEventListener('click', function () {
      state.view = state.view === 'fixed' ? 'list' : 'fixed';
      state.fixedIds = [];
      var fixed = state.view === 'fixed';
      el.viewMode.textContent = fixed ? '☰ Liste' : '▦ Sabit';
      el.viewMode.setAttribute('aria-pressed', String(fixed));
      render();
    });

    [el.minCoins, el.maxCoins, el.minRatio, el.maxRatio, el.minViewers, el.maxViewers,
      el.minSeconds, el.bagLevel, el.lowView,
      el.typeNormal, el.typeGold, el.stateActive, el.stateHung].forEach(function (input) {
      input.addEventListener('input', readFilterUi);
      input.addEventListener('change', readFilterUi);
    });

    document.getElementById('resetFilters').addEventListener('click', function () {
      state.filters = Engine.normalizeFilters(null);
      saveFilters();
      syncFilterUi();
      render();
    });

    document.getElementById('refreshBtn').addEventListener('click', function () {
      refreshBoxes();
      refreshLive();
    });

    if (el.roomSearch) {
      el.roomSearch.addEventListener('input', function () {
        state.roomQuery = el.roomSearch.value;
        renderRoomList();
      });
    }

    el.cards.addEventListener('click', async function (event) {
      var copy = event.target.closest('[data-copy-comment]');
      if (!copy) return;
      var id = copy.getAttribute('data-copy-comment');
      var raw = state.raw.get(id);
      var comment = raw && (raw.bagComment || raw.bag_comment);
      if (!comment) return;
      var ok = false;
      try {
        await navigator.clipboard.writeText(comment);
        ok = true;
      } catch (error) {
        var area = document.createElement('textarea');
        area.value = comment;
        area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(area);
        area.select();
        try { ok = document.execCommand('copy'); } catch (copyError) { ok = false; }
        area.remove();
      }
      copy.textContent = ok ? 'kopyalandı' : 'kopyalanamadı';
      copy.classList.toggle('ok', ok);
      setTimeout(function () { copy.textContent = 'kopyala'; copy.classList.remove('ok'); }, 1500);
    });
  }

  function init() {
    var savedTab = 'chest';
    try { savedTab = localStorage.getItem(TAB_KEY) || 'chest'; } catch (error) { /* yoksay */ }
    if (['chest', 'bag', 'hung', 'all'].indexOf(savedTab) === -1) savedTab = 'chest';
    state.tab = savedTab;
    document.querySelectorAll('[data-tab]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tab') === state.tab);
    });
    state.sound = savedBoolean(SOUND_KEY);
    state.preset = el.presetMode ? (el.presetMode.value || 'all') : 'all';
    setSound(state.sound);
    // İzin geri alınmışsa kaydedilmiş "açık" durumu sessizce çalışmasın.
    if (state.notify.enabled && (!notifyAvailable() || window.Notification.permission !== 'granted')) {
      state.notify.enabled = false;
    }
    el.notifyScore.value = state.notify.minScore > 0 ? String(state.notify.minScore) : '';
    el.quietStart.value = state.notify.quietStart;
    el.quietEnd.value = state.notify.quietEnd;
    state.quietActive = quietNow();
    updateNotifyUi();
    renderOutcomeReport();
    syncFilterUi();
    bind();
    connectStream();
    refreshBoxes();
    refreshLive();
    renderLiveSource();
    setInterval(function () {
      prune();
      tick();
    }, 1000);
    setInterval(refreshBoxes, 10000);
    setInterval(refreshLive, 30000);
    setInterval(prune, 60000);
  }

  init();
})();
