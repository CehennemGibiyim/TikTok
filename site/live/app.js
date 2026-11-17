'use strict';

(function () {
  var Engine = window.RewardEngine;
  var BOXES_URL = '../firsat/data/boxes.json';
  var LIVE_URL = '../firsat/data/live.json';
  var BOX_STREAM_TOPIC = 'cehennem-tiktok-firsat-7f3a91';
  var BOX_STREAM_KEY = 'XQMPSwldDoS26gnVIV1ClCyb';
  var FILTER_KEY = 'tiktok-live-radar-filters-v1';
  var SOUND_KEY = 'tiktok-live-radar-sound';
  var TAB_KEY = 'tiktok-live-radar-tab';

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
    sound: false,
    lastBoxAt: 0,
    lastFetchOk: false,
    current: [],
    lastIds: '',
    beeped: new Set(),
    stream: null,
    lastError: ''
  };

  var el = {
    cards: document.getElementById('cards'),
    empty: document.getElementById('empty'),
    emptyTitle: document.getElementById('emptyTitle'),
    emptyNote: document.getElementById('emptyNote'),
    dataStatus: document.getElementById('dataStatus'),
    updatedAt: document.getElementById('updatedAt'),
    resultCount: document.getElementById('resultCount'),
    filterCount: document.getElementById('filterCount'),
    soundBtn: document.getElementById('soundBtn'),
    sortMode: document.getElementById('sortMode'),
    presetMode: document.getElementById('presetMode'),
    viewMode: document.getElementById('viewMode'),
    minCoins: document.getElementById('minCoins'),
    minRatio: document.getElementById('minRatio'),
    minSeconds: document.getElementById('minSeconds'),
    bagLevel: document.getElementById('bagLevel'),
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
    if (f.minRatio !== null) count += 1;
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

    var statusText = state.lastFetchOk ? 'yerel veri' : 'veri okunamadı';
    el.dataStatus.textContent = statusText;
    el.dataStatus.className = 'status-pill' + (state.lastFetchOk ? '' : ' bad');
    el.updatedAt.textContent = state.lastBoxAt ? 'kutu ' + timeText(state.lastBoxAt) : '—';
    maybeBeep(list, now);
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

  function syncFilterUi() {
    var f = state.filters;
    el.minCoins.value = f.minCoins || '';
    el.minRatio.value = f.minRatio === null ? '' : f.minRatio;
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
      minRatio: el.minRatio.value,
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
      (data && Array.isArray(data.boxes) ? data.boxes : []).forEach(ingestBox);
      state.lastFetchOk = true;
      render();
    } catch (error) {
      state.lastFetchOk = false;
      state.lastError = error.message;
      el.dataStatus.textContent = 'veri okunamadı';
      el.dataStatus.className = 'status-pill bad';
    }
  }

  async function refreshLive() {
    try {
      state.live = await fetchJson(LIVE_URL);
      render();
    } catch (error) {
      // Kutu listesi çalışmaya devam eder.
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
          ingestBox(box);
          render();
        } catch (error) { /* bozuk mesaj */ }
      });
      state.stream.onerror = function () {
        // Kalıcı hata değil: 10 sn'lik dosya yenilemesi devrede kalır.
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
    });

    el.soundBtn.addEventListener('click', function () {
      setSound(!state.sound);
    });

    el.viewMode.addEventListener('click', function () {
      state.view = state.view === 'fixed' ? 'list' : 'fixed';
      state.fixedIds = [];
      var fixed = state.view === 'fixed';
      el.viewMode.textContent = fixed ? '☰ Liste' : '▦ Sabit';
      el.viewMode.setAttribute('aria-pressed', String(fixed));
      render();
    });

    [el.minCoins, el.minRatio, el.minSeconds, el.bagLevel, el.lowView,
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
    syncFilterUi();
    bind();
    connectStream();
    refreshBoxes();
    refreshLive();
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
