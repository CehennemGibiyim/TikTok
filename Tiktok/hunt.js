/*
 * hunt.js — Jeton Avı sekmesi.
 *
 * Aynı anda dinlenen yayınları, paylaşılan zarf/sandık jetonlarını,
 * açılma sürelerini ve ülke dağılımını gösterir. Veriler sunucudaki
 * radar motorundan gelir; sayfa yenilense de kaybolmaz.
 */
(function () {
  'use strict';

  var COUNTRY_NAMES = {
    TR: 'Türkiye', DE: 'Almanya', US: 'ABD', GB: 'İngiltere', FR: 'Fransa', NL: 'Hollanda',
    IT: 'İtalya', ES: 'İspanya', PL: 'Polonya', RO: 'Romanya', RU: 'Rusya', UA: 'Ukrayna',
    AZ: 'Azerbaycan', KZ: 'Kazakistan', SA: 'Suudi Arabistan', AE: 'BAE', EG: 'Mısır',
    MA: 'Fas', DZ: 'Cezayir', TN: 'Tunus', IQ: 'Irak', JO: 'Ürdün', LB: 'Lübnan',
    VN: 'Vietnam', TH: 'Tayland', ID: 'Endonezya', MY: 'Malezya', PH: 'Filipinler',
    BR: 'Brezilya', MX: 'Meksika', AR: 'Arjantin', CO: 'Kolombiya', PE: 'Peru', CL: 'Şili',
    IN: 'Hindistan', PK: 'Pakistan', BD: 'Bangladeş', JP: 'Japonya', KR: 'Güney Kore',
    TW: 'Tayvan', HK: 'Hong Kong', SG: 'Singapur', AU: 'Avustralya', NZ: 'Yeni Zelanda',
    ZA: 'Güney Afrika', NG: 'Nijerya', KE: 'Kenya', GH: 'Gana', SE: 'İsveç', NO: 'Norveç',
    DK: 'Danimarka', FI: 'Finlandiya', BE: 'Belçika', AT: 'Avusturya', CH: 'İsviçre',
    PT: 'Portekiz', GR: 'Yunanistan', BG: 'Bulgaristan', RS: 'Sırbistan', CZ: 'Çekya',
    HU: 'Macaristan', QA: 'Katar', KW: 'Kuveyt', BH: 'Bahreyn', OM: 'Umman', IL: 'İsrail',
    SY: 'Suriye', LY: 'Libya', SD: 'Sudan', ET: 'Etiyopya', TZ: 'Tanzanya', UG: 'Uganda',
    KH: 'Kamboçya', MM: 'Myanmar', LK: 'Sri Lanka', NP: 'Nepal', MN: 'Moğolistan',
    GE: 'Gürcistan', AM: 'Ermenistan', BY: 'Belarus', LT: 'Litvanya', LV: 'Letonya',
    EE: 'Estonya', SK: 'Slovakya', SI: 'Slovenya', HR: 'Hırvatistan', BA: 'Bosna-Hersek',
    AL: 'Arnavutluk', MK: 'Kuzey Makedonya', MD: 'Moldova', CY: 'Kıbrıs', MT: 'Malta'
  };

  var state = { targets: [], sessions: {}, limits: { maxTargets: 40 }, serverTime: 0 };
  var events = [];
  var eventIds = {};
  var sortMode = 'alpha';
  var countryFilter = 'ALL';
  var logLines = [];
  var pollTimer = null;
  var shellReady = false;

  function countryName(code) {
    if (!code) return 'Bilinmiyor';
    return COUNTRY_NAMES[code] || code;
  }

  function flagOf(code) {
    if (!code || code.length !== 2) return '🏳️';
    return String.fromCodePoint.apply(String, code.toUpperCase().split('').map(function (c) {
      return 127397 + c.charCodeAt(0);
    }));
  }

  function formatCoins(value) {
    var n = Number(value) || 0;
    return n.toLocaleString('tr-TR');
  }

  function formatClock(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function pad(v) { return String(v).padStart(2, '0'); }
    return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sessionOf(username) {
    return state.sessions[username] || {};
  }

  function liveSeconds(session) {
    if (!session || !session.startedAt) return 0;
    var started = new Date(session.startedAt).getTime();
    if (!Number.isFinite(started)) return 0;
    return (Date.now() - started) / 1000;
  }

  function statusMeta(session) {
    var status = (session && session.status) || 'idle';
    var map = {
      live: { label: 'CANLI', cls: 'bg-green-500/15 text-green-400 border-green-500/30', dot: 'bg-green-400' },
      connecting: { label: 'BAĞLANIYOR', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30', dot: 'bg-yellow-400' },
      queued: { label: 'KUYRUKTA', cls: 'bg-yellow-500/10 text-yellow-200/70 border-yellow-500/20', dot: 'bg-yellow-300' },
      offline: { label: 'YAYIN YOK', cls: 'bg-white/5 text-yellow-50/50 border-white/10', dot: 'bg-gray-500' },
      error: { label: 'HATA', cls: 'bg-red-500/15 text-red-400 border-red-500/30', dot: 'bg-red-400' },
      stopped: { label: 'DURDURULDU', cls: 'bg-white/5 text-yellow-50/40 border-white/10', dot: 'bg-gray-600' },
      idle: { label: 'BEKLİYOR', cls: 'bg-white/5 text-yellow-50/40 border-white/10', dot: 'bg-gray-600' }
    };
    return map[status] || map.idle;
  }

  // ---------- Kabuk (markup) ----------

  function buildShell() {
    if (document.getElementById('view-hunt')) return;
    var main = document.querySelector('main');
    if (!main) return;

    var section = document.createElement('div');
    section.id = 'view-hunt';
    section.className = 'view-section hidden';
    section.innerHTML = [
      '<div class="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 border-b border-white/5 pb-4">',
      '  <div>',
      '    <h2 class="text-2xl font-bold text-white flex items-center"><i data-lucide="crosshair" class="w-6 h-6 mr-3 text-yellow-400"></i> Jeton Avı Radarı</h2>',
      '    <p class="text-xs text-yellow-50/50 mt-1 ml-9">Aynı anda birden fazla yayın · zarf / sandık jetonu · açılma süresi · ülke dağılımı</p>',
      '  </div>',
      '  <div class="flex items-center gap-2 mt-4 sm:mt-0">',
      '    <span id="huntServerBadge" class="text-[11px] px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-yellow-50/60">Sunucu kontrol ediliyor…</span>',
      '    <button id="huntRefreshBtn" class="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-yellow-100 transition-all"><i data-lucide="refresh-cw" class="w-3.5 h-3.5 inline mr-1"></i>Yenile</button>',
      '  </div>',
      '</div>',

      '<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">',
      '  <div class="glass rounded-2xl p-4"><div class="text-[11px] text-yellow-50/50 uppercase tracking-wide">Dinlenen yayın</div><div id="huntStatStreams" class="text-2xl font-black text-yellow-300 mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[11px] text-yellow-50/50 uppercase tracking-wide">Şu an canlı</div><div id="huntStatLive" class="text-2xl font-black text-green-400 mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[11px] text-yellow-50/50 uppercase tracking-wide">Toplam zarf / sandık</div><div id="huntStatEnvelopes" class="text-2xl font-black text-white mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[11px] text-yellow-50/50 uppercase tracking-wide">Toplam jeton</div><div id="huntStatCoins" class="text-2xl font-black text-amber-400 mt-1">0</div></div>',
      '</div>',

      '<div class="glass rounded-2xl p-5 mb-6">',
      '  <div class="flex flex-col lg:flex-row gap-3">',
      '    <div class="relative flex-1">',
      '      <i data-lucide="at-sign" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-yellow-500/50"></i>',
      '      <input id="huntInput" type="text" placeholder="@yayinci, @yayinci2 veya tiktok.com/@yayinci" class="w-full bg-black/50 border border-yellow-500/30 rounded-xl pl-9 pr-3 py-2.5 text-yellow-100 text-sm outline-none focus:border-yellow-400">',
      '    </div>',
      '    <select id="huntCountryInput" class="bg-black/50 border border-yellow-500/30 rounded-xl px-3 py-2.5 text-yellow-100 text-sm outline-none focus:border-yellow-400 min-w-[160px]">',
      '      <option value="">Ülke (oto)</option>',
      '    </select>',
      '    <button id="huntAddBtn" class="bg-yellow-500/20 hover:bg-yellow-500/40 border border-yellow-500/50 text-yellow-400 px-5 rounded-xl font-bold transition-all">Ekle</button>',
      '    <button id="huntStopAllBtn" class="bg-red-500/10 hover:bg-red-500/25 border border-red-500/30 text-red-400 px-4 rounded-xl text-sm font-semibold transition-all">Tümünü Durdur</button>',
      '  </div>',
      '  <p id="huntHint" class="text-[11px] text-yellow-50/40 mt-2">Virgül veya satırla ayırarak toplu ekleyebilirsiniz. Aynı anda en fazla 40 yayın dinlenir.</p>',
      '</div>',

      '<div class="glass rounded-2xl p-5 mb-6">',
      '  <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">',
      '    <h3 class="text-lg font-semibold text-yellow-100 flex items-center"><i data-lucide="list-ordered" class="w-5 h-5 mr-2 text-yellow-400"></i>Dinlenen Yayınlar</h3>',
      '    <div class="flex flex-wrap items-center gap-2">',
      '      <select id="huntCountryFilter" class="bg-black/60 border border-yellow-500/30 rounded-lg px-3 py-1.5 text-yellow-100 text-xs outline-none"><option value="ALL">Tüm ülkeler</option></select>',
      '      <select id="huntSort" class="bg-black/60 border border-yellow-500/30 rounded-lg px-3 py-1.5 text-yellow-100 text-xs outline-none">',
      '        <option value="alpha">🔤 Alfabetik (A-Z)</option>',
      '        <option value="coins">💰 En çok jeton</option>',
      '        <option value="duration">⏱️ En uzun süre</option>',
      '        <option value="country">🌍 Ülkeye göre</option>',
      '        <option value="recent">🕒 Son olay</option>',
      '      </select>',
      '      <button id="huntCsvBtn" class="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-yellow-100 transition-all"><i data-lucide="download" class="w-3.5 h-3.5 inline mr-1"></i>CSV</button>',
      '    </div>',
      '  </div>',
      '  <div id="huntTargetsList" class="overflow-x-auto"></div>',
      '</div>',

      '<div class="grid grid-cols-1 lg:grid-cols-12 gap-6">',
      '  <div class="lg:col-span-5 glass rounded-2xl p-5">',
      '    <h3 class="text-lg font-semibold text-yellow-100 flex items-center mb-3"><i data-lucide="globe-2" class="w-5 h-5 mr-2 text-yellow-400"></i>Ülke Özeti</h3>',
      '    <div id="huntCountryTable" class="overflow-x-auto max-h-[460px] overflow-y-auto scrollbar-custom"></div>',
      '  </div>',
      '  <div class="lg:col-span-7 glass rounded-2xl p-5">',
      '    <div class="flex items-center justify-between mb-3">',
      '      <h3 class="text-lg font-semibold text-yellow-100 flex items-center"><i data-lucide="flame" class="w-5 h-5 mr-2 text-yellow-400"></i>Canlı Zarf Akışı</h3>',
      '      <button id="huntClearEventsBtn" class="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-yellow-50/60">Temizle</button>',
      '    </div>',
      '    <div id="huntEventList" class="max-h-[460px] overflow-y-auto scrollbar-custom space-y-2"></div>',
      '  </div>',
      '</div>'
    ].join('\n');

    main.appendChild(section);
    wire();
    shellReady = true;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  function fillCountrySelects() {
    var select = document.getElementById('huntCountryInput');
    if (!select || select.dataset.filled === '1') return;
    var codes = Object.keys(COUNTRY_NAMES).sort(function (a, b) {
      return COUNTRY_NAMES[a].localeCompare(COUNTRY_NAMES[b], 'tr');
    });
    var html = '<option value="">Ülke (oto)</option>';
    codes.forEach(function (code) {
      html += '<option value="' + code + '">' + flagOf(code) + ' ' + COUNTRY_NAMES[code] + '</option>';
    });
    select.innerHTML = html;
    select.dataset.filled = '1';
  }

  function wire() {
    fillCountrySelects();

    var addBtn = document.getElementById('huntAddBtn');
    if (addBtn) addBtn.addEventListener('click', addFromInput);

    var input = document.getElementById('huntInput');
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') addFromInput();
      });
    }

    var refreshBtn = document.getElementById('huntRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { refresh(true); });

    var stopAll = document.getElementById('huntStopAllBtn');
    if (stopAll) stopAll.addEventListener('click', function () {
      if (!confirm('Tüm yayınlar dinlenmeyi bıraksın mı? Kayıtlar ve toplamlar silinmez.')) return;
      send({ action: 'hunt_stop_all' }, function () {
        window.RADAR_STORE.api('/api/hunt/targets', { method: 'PUT', body: '[]' }).then(function () { refresh(true); });
      });
    });

    var clearBtn = document.getElementById('huntClearEventsBtn');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      events = [];
      eventIds = {};
      send({ action: 'hunt_clear_events' }, function () {
        window.RADAR_STORE.api('/api/hunt/events', { method: 'DELETE' }).then(function () { render(); });
      });
      render();
    });

    var sortSelect = document.getElementById('huntSort');
    if (sortSelect) sortSelect.addEventListener('change', function () {
      sortMode = sortSelect.value;
      renderTargets();
    });

    var countrySelect = document.getElementById('huntCountryFilter');
    if (countrySelect) countrySelect.addEventListener('change', function () {
      countryFilter = countrySelect.value;
      renderTargets();
    });

    var csvBtn = document.getElementById('huntCsvBtn');
    if (csvBtn) csvBtn.addEventListener('click', exportCsv);

    var list = document.getElementById('huntTargetsList');
    if (list) list.addEventListener('click', function (event) {
      var button = event.target.closest('[data-hunt-remove]');
      if (!button) return;
      var username = button.getAttribute('data-hunt-remove');
      send({ action: 'hunt_remove', username: username }, function () {
        window.RADAR_STORE.api('/api/hunt/targets?username=' + encodeURIComponent(username), { method: 'DELETE' })
          .then(function () { refresh(true); })
          .catch(function () { refresh(true); });
      });
    });
  }

  // ---------- Veri yollari ----------

  function wsOpen() {
    try {
      return typeof ws !== 'undefined' && ws && ws.readyState === 1;
    } catch (e) {
      return false;
    }
  }

  function send(payload, fallback) {
    if (wsOpen()) {
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (e) { /* yedege dus */ }
    }
    if (typeof fallback === 'function') fallback();
    return false;
  }

  function parseUsernames(text) {
    return String(text || '')
      .split(/[\s,;]+/)
      .map(function (token) {
        return token
          .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
          .replace(/^@/, '')
          .replace(/\/.*$/, '')
          .replace(/[?#].*$/, '')
          .trim()
          .toLowerCase();
      })
      .filter(function (token) { return /^[a-z0-9._]{2,32}$/.test(token); });
  }

  function addFromInput() {
    var input = document.getElementById('huntInput');
    var countrySelect = document.getElementById('huntCountryInput');
    if (!input) return;

    var usernames = parseUsernames(input.value);
    if (usernames.length === 0) {
      input.focus();
      addLog('Geçerli bir kullanıcı adı bulunamadı.');
      return;
    }

    var country = countrySelect ? countrySelect.value : '';
    var unique = [];
    usernames.forEach(function (username) {
      if (unique.indexOf(username) < 0) unique.push(username);
    });

    var entries = unique.map(function (username) { return { username: username, country: country }; });

    if (!send({ action: 'hunt_add', usernames: entries }, function () {
      if (!window.RADAR_STORE || !window.RADAR_STORE.available()) {
        addLog('Arka uç adresi yok. "Sistem Bağlantısı" alanına sunucu adresini girin.');
        return;
      }
      entries.forEach(function (entry) {
        window.RADAR_STORE.api('/api/hunt/targets', { method: 'POST', body: JSON.stringify(entry) })
          .then(function () { refresh(true); })
          .catch(function (error) { addLog(error.message); });
      });
    })) {
      input.value = '';
      setTimeout(function () { refresh(true); }, 800);
    } else {
      input.value = '';
      setTimeout(function () { refresh(true); }, 1200);
    }
  }

  function refresh(withEvents) {
    if (!window.RADAR_STORE || !window.RADAR_STORE.available()) {
      updateServerBadge();
      return;
    }
    var tasks = [window.RADAR_STORE.pull()];
    if (withEvents) {
      tasks.push(window.RADAR_STORE.api('/api/hunt/events?limit=300').catch(function () { return null; }));
    }

    Promise.all(tasks).then(function (results) {
      var payload = results[0];
      if (payload && payload.radar) {
        applyState(payload.radar, (results[1] && results[1].events) || payload.radar.events || null);
      }
      updateServerBadge();
    }).catch(function () {
      updateServerBadge();
    });
  }

  function updateServerBadge() {
    var badge = document.getElementById('huntServerBadge');
    if (!badge) return;
    var info = window.RADAR_STORE ? window.RADAR_STORE.status() : { available: false };
    if (info.available) {
      badge.className = 'text-[11px] px-3 py-1.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-400';
      var host = info.base.replace(/^https?:\/\//, '').split('/')[0];
      if (host.length > 34) host = host.slice(0, 31) + '…';
      badge.innerHTML = '<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1"></span>Sunucu bağlı · ' + escapeHtml(host);
    } else {
      badge.className = 'text-[11px] px-3 py-1.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
      badge.textContent = 'Çevrimdışı mod · arka uç adresi gerekli';
    }
  }

  function addLog(message) {
    logLines.unshift({ at: new Date(), message: message });
    logLines = logLines.slice(0, 50);
    var hint = document.getElementById('huntHint');
    if (hint) hint.textContent = message;
  }

  function applyState(nextState, nextEvents) {
    if (nextState) {
      state.targets = Array.isArray(nextState.targets) ? nextState.targets : [];
      state.sessions = nextState.sessions || {};
      state.limits = nextState.limits || state.limits;
      state.serverTime = nextState.serverTime || Date.now();
    }

    if (Array.isArray(nextEvents)) {
      events = [];
      eventIds = {};
      nextEvents.forEach(function (event) { pushEvent(event, true); });
    }

    render();
  }

  function pushEvent(event, silent) {
    if (!event || !event.username) return;
    var id = event.id || (event.username + '-' + event.at);
    if (eventIds[id]) return;
    eventIds[id] = true;
    events.unshift(Object.assign({}, event, { id: id }));
    if (events.length > 400) {
      var removed = events.pop();
      if (removed) delete eventIds[removed.id];
    }
    if (!silent) renderEvents();
  }

  // ---------- Cizim ----------

  function totals() {
    var result = { streams: state.targets.length, live: 0, envelopes: 0, portals: 0, coins: 0 };
    Object.keys(state.sessions).forEach(function (username) {
      var session = state.sessions[username];
      if (!session) return;
      if (session.status === 'live') result.live += 1;
      var t = session.totals || {};
      result.envelopes += Number(t.envelopes) || 0;
      result.portals += Number(t.portals) || 0;
      result.coins += Number(t.coins) || 0;
    });
    return result;
  }

  function render() {
    if (!shellReady || !document.getElementById('view-hunt')) return;

    var summary = totals();
    setText('huntStatStreams', summary.streams);
    setText('huntStatLive', summary.live);
    setText('huntStatEnvelopes', formatCoins(summary.envelopes + summary.portals));
    setText('huntStatCoins', formatCoins(summary.coins));

    renderTargets();
    renderCountries();
    renderEvents();
    updateServerBadge();
  }

  function setText(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = String(value);
  }

  function visibleTargets() {
    var list = state.targets.slice();
    if (countryFilter !== 'ALL') {
      list = list.filter(function (target) {
        var session = sessionOf(target.username);
        return (session.region || target.country || '') === countryFilter;
      });
    }

    list.sort(function (a, b) {
      var sa = sessionOf(a.username);
      var sb = sessionOf(b.username);
      if (sortMode === 'coins') {
        return ((sb.totals || {}).coins || 0) - ((sa.totals || {}).coins || 0);
      }
      if (sortMode === 'duration') {
        return liveSeconds(sb) - liveSeconds(sa);
      }
      if (sortMode === 'country') {
        var ca = (sa.region || a.country || 'ZZ');
        var cb = (sb.region || b.country || 'ZZ');
        if (ca !== cb) return ca.localeCompare(cb);
        return a.username.localeCompare(b.username);
      }
      if (sortMode === 'recent') {
        var ra = sa.lastEventAt ? new Date(sa.lastEventAt).getTime() : 0;
        var rb = sb.lastEventAt ? new Date(sb.lastEventAt).getTime() : 0;
        return rb - ra;
      }
      return a.username.localeCompare(b.username, 'tr');
    });

    return list;
  }

  function renderTargets() {
    var container = document.getElementById('huntTargetsList');
    if (!container) return;

    renderCountryFilter();

    var list = visibleTargets();
    if (list.length === 0) {
      container.innerHTML = '<div class="text-center text-yellow-50/30 text-sm py-10 border border-dashed border-white/10 rounded-xl">' +
        '<i data-lucide="crosshair" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>' +
        'Henüz yayın eklenmedi. Yukarıdaki alana kullanıcı adı yazıp "Ekle"ye basın.' +
        '</div>';
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    var rows = list.map(function (target) {
      var session = sessionOf(target.username);
      var region = session.region || target.country || '';
      var meta = statusMeta(session);
      var totalsData = session.totals || {};
      var currentTitle = session.title ? escapeHtml(session.title).slice(0, 48) : '';

      return [
        '<tr class="border-b border-white/5 hover:bg-white/[0.03] transition-colors">',
        '  <td class="py-2.5 pr-3">',
        '    <a href="https://www.tiktok.com/@' + encodeURIComponent(target.username) + '" target="_blank" rel="noopener" class="text-yellow-100 font-semibold hover:text-yellow-300">@' + escapeHtml(target.username) + '</a>',
        currentTitle ? '    <div class="text-[10px] text-yellow-50/40 truncate max-w-[180px]">' + currentTitle + '</div>' : '',
        '  </td>',
        '  <td class="py-2.5 pr-3 text-xs text-yellow-50/70 whitespace-nowrap">' + flagOf(region) + ' ' + escapeHtml(countryName(region)) + '</td>',
        '  <td class="py-2.5 pr-3"><span class="text-[10px] px-2 py-0.5 rounded-full border ' + meta.cls + ' whitespace-nowrap"><span class="inline-block w-1.5 h-1.5 rounded-full ' + meta.dot + ' mr-1"></span>' + meta.label + '</span></td>',
        '  <td class="py-2.5 pr-3 text-xs font-mono text-yellow-100/80" data-hunt-duration="' + escapeHtml(target.username) + '">' + formatClock(liveSeconds(session)) + '</td>',
        '  <td class="py-2.5 pr-3 text-xs text-yellow-100/80">' + formatCoins(totalsData.envelopes || 0) + '</td>',
        '  <td class="py-2.5 pr-3 text-xs font-bold text-amber-400">' + formatCoins(totalsData.coins || 0) + '</td>',
        '  <td class="py-2.5 pr-3 text-[11px] text-yellow-50/50 whitespace-nowrap">' + (session.lastEventAt ? new Date(session.lastEventAt).toLocaleTimeString('tr-TR') : '—') + '</td>',
        '  <td class="py-2.5 text-right"><button data-hunt-remove="' + escapeHtml(target.username) + '" class="text-[11px] px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/25 border border-red-500/20 text-red-400">Kaldır</button></td>',
        '</tr>'
      ].join('');
    }).join('');

    container.innerHTML = [
      '<table class="w-full text-left text-sm">',
      '<thead><tr class="text-[10px] uppercase tracking-wide text-yellow-50/40 border-b border-white/10">',
      '<th class="py-2 pr-3">Yayıncı</th><th class="py-2 pr-3">Ülke</th><th class="py-2 pr-3">Durum</th><th class="py-2 pr-3">Süre</th><th class="py-2 pr-3">Zarf</th><th class="py-2 pr-3">Jeton</th><th class="py-2 pr-3">Son olay</th><th class="py-2 text-right">İşlem</th>',
      '</tr></thead><tbody>' + rows + '</tbody></table>'
    ].join('');
  }

  function renderCountryFilter() {
    var select = document.getElementById('huntCountryFilter');
    if (!select) return;

    var codes = {};
    Object.keys(state.sessions).forEach(function (username) {
      var session = state.sessions[username];
      var code = session && session.region;
      if (code) codes[code] = true;
    });
    state.targets.forEach(function (target) {
      if (target.country) codes[target.country] = true;
    });

    var sorted = Object.keys(codes).sort(function (a, b) {
      return countryName(a).localeCompare(countryName(b), 'tr');
    });

    var html = '<option value="ALL">Tüm ülkeler</option>';
    sorted.forEach(function (code) {
      html += '<option value="' + code + '">' + flagOf(code) + ' ' + countryName(code) + '</option>';
    });
    select.innerHTML = html;
    select.value = countryFilter;
  }

  function renderCountries() {
    var container = document.getElementById('huntCountryTable');
    if (!container) return;

    var groups = {};
    Object.keys(state.sessions).forEach(function (username) {
      var session = state.sessions[username];
      if (!session) return;
      if (session.status === 'stopped') return;

      var code = session.region || 'UNKNOWN';
      if (!groups[code]) groups[code] = { code: code, streamers: 0, live: 0, envelopes: 0, coins: 0 };
      var group = groups[code];
      group.streamers += 1;
      if (session.status === 'live') group.live += 1;
      var totalsData = session.totals || {};
      group.envelopes += Number(totalsData.envelopes || 0) + Number(totalsData.portals || 0);
      group.coins += Number(totalsData.coins || 0);
    });

    var list = Object.keys(groups).map(function (key) { return groups[key]; });
    list.sort(function (a, b) {
      return countryName(a.code === 'UNKNOWN' ? '' : a.code).localeCompare(countryName(b.code === 'UNKNOWN' ? '' : b.code), 'tr');
    });

    if (list.length === 0) {
      container.innerHTML = '<div class="text-xs text-yellow-50/30 text-center py-6">Zarf verisi geldikçe ülkeler burada listelenir.</div>';
      return;
    }

    var rows = list.map(function (group) {
      var label = group.code === 'UNKNOWN' ? '🏳️ Bilinmiyor' : flagOf(group.code) + ' ' + escapeHtml(countryName(group.code));
      return [
        '<tr class="border-b border-white/5">',
        '<td class="py-2 pr-2 text-xs text-yellow-100 whitespace-nowrap">' + label + '</td>',
        '<td class="py-2 pr-2 text-xs text-yellow-50/60 text-center">' + group.streamers + '</td>',
        '<td class="py-2 pr-2 text-xs text-green-400 text-center">' + group.live + '</td>',
        '<td class="py-2 pr-2 text-xs text-yellow-50/60 text-center">' + formatCoins(group.envelopes) + '</td>',
        '<td class="py-2 text-xs font-bold text-amber-400 text-right">' + formatCoins(group.coins) + '</td>',
        '</tr>'
      ].join('');
    }).join('');

    container.innerHTML = [
      '<table class="w-full">',
      '<thead><tr class="text-[10px] uppercase text-yellow-50/40 border-b border-white/10">',
      '<th class="py-1.5 pr-2 text-left">Ülke</th><th class="py-1.5 pr-2 text-center">Yayıncı</th><th class="py-1.5 pr-2 text-center">Canlı</th><th class="py-1.5 pr-2 text-center">Zarf</th><th class="py-1.5 text-right">Jeton</th>',
      '</tr></thead><tbody>' + rows + '</tbody></table>'
    ].join('');
  }

  function renderEvents() {
    var container = document.getElementById('huntEventList');
    if (!container) return;

    if (events.length === 0) {
      container.innerHTML = '<div class="text-center text-yellow-50/30 text-sm py-10 border border-dashed border-white/10 rounded-xl">' +
        'Zarf düştüğü anda burada jeton miktarı ve açılma süresi ile görünecek.</div>';
      return;
    }

    var rows = events.slice(0, 120).map(function (event) {
      var isPortal = event.kind === 'portal';
      var badge = isPortal
        ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">PORTAL</span>'
        : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">ZARF</span>';

      var openAt = (event.receivedAt || Date.now()) + (Number(event.canOpenSec) || 0) * 1000;
      var remaining = Math.max(0, Math.round((openAt - Date.now()) / 1000));

      return [
        '<div class="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-black/30 px-3 py-2">',
        '  <div class="min-w-0">',
        '    <div class="flex items-center gap-2">' + badge,
        '      <a href="https://www.tiktok.com/@' + encodeURIComponent(event.username) + '" target="_blank" rel="noopener" class="text-xs font-semibold text-yellow-100 truncate hover:text-yellow-300">@' + escapeHtml(event.username) + '</a>',
        '    </div>',
        '    <div class="text-[10px] text-yellow-50/40 mt-0.5">' + flagOf(event.region) + ' ' + escapeHtml(countryName(event.region)) + ' · ' + new Date(event.at).toLocaleTimeString('tr-TR') + '</div>',
        '  </div>',
        '  <div class="text-right whitespace-nowrap">',
        '    <div class="text-sm font-black text-amber-400">' + formatCoins(event.coins) + ' <span class="text-[10px] font-normal text-yellow-50/40">jeton</span></div>',
        '    <div class="text-[10px] text-yellow-50/50" data-hunt-countdown="' + openAt + '">' + (remaining > 0 ? 'açılışa ' + formatClock(remaining) : 'açıldı') + '</div>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');

    container.innerHTML = rows;
  }

  // ---------- Canli sayaclar ----------

  function tick() {
    Object.keys(state.sessions).forEach(function (username) {
      var element = document.querySelector('[data-hunt-duration="' + username.replace(/"/g, '\\"') + '"]');
      if (element) element.textContent = formatClock(liveSeconds(state.sessions[username]));
    });

    document.querySelectorAll('[data-hunt-countdown]').forEach(function (element) {
      var openAt = Number(element.getAttribute('data-hunt-countdown'));
      var remaining = Math.max(0, Math.round((openAt - Date.now()) / 1000));
      element.textContent = remaining > 0 ? 'açılışa ' + formatClock(remaining) : 'açıldı';
    });
  }

  // ---------- CSV ----------

  function exportCsv() {
    var lines = [];
    lines.push('tur,yayinci,ulke,jeton,acilma_suresi,zaman');

    visibleTargets().forEach(function (target) {
      var session = sessionOf(target.username) || {};
      var totalsData = session.totals || {};
      lines.push([
        'ozet',
        target.username,
        session.region || target.country || '',
        totalsData.coins || 0,
        '',
        session.lastEventAt || ''
      ].join(','));
    });

    events.forEach(function (event) {
      lines.push([
        event.kind === 'portal' ? 'portal' : 'zarf',
        event.username,
        event.region || '',
        event.coins || 0,
        event.canOpenSec || 0,
        event.at || ''
      ].join(','));
    });

    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'jeton-avi-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // ---------- WebSocket mesajlari ----------

  window.onHuntMessage = function (data) {
    if (!data || !data.type) return false;

    if (data.type === 'hunt_state') {
      applyState(data.state, null);
      return true;
    }
    if (data.type === 'hunt_events') {
      applyState(null, data.events || []);
      return true;
    }
    if (data.type === 'hunt_event') {
      pushEvent(data.event, false);
      var session = sessionOf(data.event.username);
      if (session) render();
      return true;
    }
    if (data.type === 'hunt_result') {
      if (data.state) applyState(data.state, null);
      (data.results || []).forEach(function (result) {
        if (result && result.error) addLog(result.error);
      });
      return true;
    }
    if (data.type === 'hunt_log') {
      addLog(data.message);
      return true;
    }
    return false;
  };

  window.Hunt = {
    applyState: applyState,
    refresh: refresh,
    state: state
  };

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      var view = document.getElementById('view-hunt');
      if (view && !view.classList.contains('hidden')) refresh(false);
    }, 20000);
  }

  function boot() {
    buildShell();
    fillCountrySelects();
    startPolling();
    updateServerBadge();
    refresh(true);
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
