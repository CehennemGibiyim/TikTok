/*
 * hunt.js — Jeton Avı sekmesi.
 *
 * - Aynı anda dinlenen tüm yayınlar (ülke fark etmeksizin)
 * - Sandık / zarf-mektup / portal ayrımı
 * - Gerçek süreler: dinleme süresi, açılma geri sayımı, zarfın son geçerlilik anı
 * - Fırsatlar: içeride 1 jeton bile beklemede olsa listelenir
 * - QR kod: telefonla okutup doğrudan yayına gitme
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

  var KIND = {
    chest: { label: 'SANDIK', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30', icon: '📦' },
    letter: { label: 'ZARF / MEKTUP', cls: 'bg-pink-500/20 text-pink-300 border-pink-500/30', icon: '✉️' },
    portal: { label: 'PORTAL', cls: 'bg-purple-500/20 text-purple-300 border-purple-500/30', icon: '🌀' }
  };

  var state = { targets: [], sessions: {}, limits: { maxTargets: 40, letterTtlSec: 180 }, serverTime: 0, pendingCount: 0, pendingCoins: 0 };
  var events = [];
  var eventIndex = {};
  var pending = [];
  var activeTab = 'streams';
  var sortMode = 'alpha';
  var countryFilter = 'ALL';
  var pollTimer = null;
  var shellReady = false;
  var qrModal = null;

  function kindMeta(kind) {
    return KIND[kind] || KIND.chest;
  }

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
    return (Number(value) || 0).toLocaleString('tr-TR');
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

  function liveUrl(username) {
    return 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live';
  }

  function sessionOf(username) {
    return state.sessions[username] || {};
  }

  // Telefonda TikTok uygulamasında açmak için oda kimliğiyle derin bağlantı.
  // Kimlik yoksa uydurulmaz; QR her zaman web yayınına düşer.
  function roomIdOf(value) {
    return String(value || '').replace(/[^0-9]/g, '');
  }

  function appSchemeUrl(roomId, platform) {
    var id = roomIdOf(roomId);
    if (!id) return '';
    var scheme = platform === 'ios' ? 'snssdk1233' : 'snssdk1128';
    return scheme + '://live?room_id=' + id + '&from=webview&refer=web';
  }

  function androidIntentUrl(roomId, fallbackUrl) {
    var id = roomIdOf(roomId);
    if (!id) return '';
    return 'intent://live?room_id=' + id + '&from=webview&refer=web#Intent;' +
      'package=com.zhiliaoapp.musically;scheme=snssdk1128;' +
      'S.browser_fallback_url=' + encodeURIComponent(fallbackUrl) + ';end';
  }

  function roomIdFor(username) {
    var session = sessionOf(username);
    if (session && session.roomId) return String(session.roomId);
    var target = state.targets.find(function (item) { return item.username === username; });
    return target && target.roomId ? String(target.roomId) : '';
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

  function isLetterExpired(event) {
    return event.kind === 'letter' && event.expiresAt && event.expiresAt <= Date.now();
  }

  // ---------- Kabuk ----------

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
      '    <p class="text-xs text-yellow-50/50 mt-1 ml-9">Tüm ülkelerdeki yayınlar · sandık / zarf ayrımı · gerçek süreler · QR ile yayına git</p>',
      '  </div>',
      '  <div class="flex items-center gap-2 mt-4 sm:mt-0">',
      '    <span id="huntServerBadge" class="text-[11px] px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-yellow-50/60">Sunucu kontrol ediliyor…</span>',
      '    <button id="huntRefreshBtn" class="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-yellow-100 transition-all"><i data-lucide="refresh-cw" class="w-3.5 h-3.5 inline mr-1"></i>Yenile</button>',
      '  </div>',
      '</div>',

      '<div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">',
      '  <div class="glass rounded-2xl p-4"><div class="text-[10px] text-yellow-50/50 uppercase tracking-wide">Dinlenen</div><div id="huntStatStreams" class="text-2xl font-black text-yellow-300 mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[10px] text-yellow-50/50 uppercase tracking-wide">Canlı</div><div id="huntStatLive" class="text-2xl font-black text-green-400 mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[10px] text-yellow-50/50 uppercase tracking-wide">Sandık</div><div id="huntStatChests" class="text-2xl font-black text-amber-400 mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[10px] text-yellow-50/50 uppercase tracking-wide">Zarf</div><div id="huntStatLetters" class="text-2xl font-black text-pink-400 mt-1">0</div></div>',
      '  <div class="glass rounded-2xl p-4"><div class="text-[10px] text-yellow-50/50 uppercase tracking-wide">Bekleyen jeton</div><div id="huntStatPending" class="text-2xl font-black text-white mt-1">0</div></div>',
      '</div>',

      '<div class="flex items-center gap-2 mb-4">',
      '  <button data-hunt-tab="streams" class="hunt-tab px-4 py-2 rounded-xl text-sm font-bold border border-yellow-500/40 bg-yellow-500/20 text-yellow-300 transition-all">Yayınlar</button>',
      '  <button data-hunt-tab="opportunities" class="hunt-tab px-4 py-2 rounded-xl text-sm font-bold border border-white/10 bg-white/5 text-yellow-50/60 transition-all">Fırsatlar <span id="huntPendingBadge" class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">0</span></button>',
      '  <button data-hunt-tab="countries" class="hunt-tab px-4 py-2 rounded-xl text-sm font-bold border border-white/10 bg-white/5 text-yellow-50/60 transition-all">Ülkeler</button>',
      '</div>',

      '<div id="huntPaneStreams">',
      '  <div class="glass rounded-2xl p-5 mb-5">',
      '    <div class="flex flex-col lg:flex-row gap-3">',
      '      <div class="relative flex-1">',
      '        <i data-lucide="at-sign" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-yellow-500/50"></i>',
      '        <input id="huntInput" type="text" placeholder="@yayinci, @yayinci2 veya tiktok.com/@yayinci" class="w-full bg-black/50 border border-yellow-500/30 rounded-xl pl-9 pr-3 py-2.5 text-yellow-100 text-sm outline-none focus:border-yellow-400">',
      '      </div>',
      '      <select id="huntCountryInput" class="bg-black/50 border border-yellow-500/30 rounded-xl px-3 py-2.5 text-yellow-100 text-sm outline-none focus:border-yellow-400 min-w-[160px]">',
      '        <option value="">Ülke (oto)</option>',
      '      </select>',
      '      <button id="huntAddBtn" class="bg-yellow-500/20 hover:bg-yellow-500/40 border border-yellow-500/50 text-yellow-400 px-5 rounded-xl font-bold transition-all">Ekle</button>',
      '      <button id="huntStopAllBtn" class="bg-red-500/10 hover:bg-red-500/25 border border-red-500/30 text-red-400 px-4 rounded-xl text-sm font-semibold transition-all">Tümünü Durdur</button>',
      '    </div>',
      '    <p id="huntHint" class="text-[11px] text-yellow-50/40 mt-2">Virgül veya satırla ayırarak toplu ekleyin. Aynı anda en fazla 40 yayın dinlenir; yayında olmayanlar 60 saniyede bir yeniden denenir.</p>',
      '  </div>',
      '  <div class="glass rounded-2xl p-5">',
      '    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">',
      '      <h3 class="text-lg font-semibold text-yellow-100 flex items-center"><i data-lucide="list-ordered" class="w-5 h-5 mr-2 text-yellow-400"></i>Dinlenen Yayınlar</h3>',
      '      <div class="flex flex-wrap items-center gap-2">',
      '        <select id="huntCountryFilter" class="bg-black/60 border border-yellow-500/30 rounded-lg px-3 py-1.5 text-yellow-100 text-xs outline-none"><option value="ALL">Tüm ülkeler</option></select>',
      '        <select id="huntSort" class="bg-black/60 border border-yellow-500/30 rounded-lg px-3 py-1.5 text-yellow-100 text-xs outline-none">',
      '          <option value="alpha">🔤 Alfabetik (A-Z)</option>',
      '          <option value="coins">💰 En çok jeton</option>',
      '          <option value="duration">⏱️ En uzun süre</option>',
      '          <option value="country">🌍 Ülkeye göre</option>',
      '          <option value="recent">🕒 Son olay</option>',
      '        </select>',
      '        <button id="huntCsvBtn" class="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-yellow-100 transition-all"><i data-lucide="download" class="w-3.5 h-3.5 inline mr-1"></i>CSV</button>',
      '      </div>',
      '    </div>',
      '    <div id="huntTargetsList" class="overflow-x-auto"></div>',
      '  </div>',
      '</div>',

      '<div id="huntPaneOpportunities" class="hidden">',
      '  <div class="glass rounded-2xl p-5 mb-5 border border-amber-500/20">',
      '    <div class="flex items-start justify-between gap-3">',
      '      <div>',
      '        <h3 class="text-lg font-semibold text-yellow-100 flex items-center"><i data-lucide="gift" class="w-5 h-5 mr-2 text-amber-400"></i>Bekleyen Jetonlar</h3>',
      '        <p class="text-[11px] text-yellow-50/50 mt-1">Sandık süresi dolsa da bekler; zarf/mektup süresi dolunca jeton yayıncıya döner. 1 jeton bile listelenir.</p>',
      '      </div>',
      '      <div class="text-right whitespace-nowrap">',
      '        <div id="huntPendingCoins" class="text-xl font-black text-amber-400">0 jeton</div>',
      '        <div id="huntPendingCount" class="text-[11px] text-yellow-50/50">0 fırsat</div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div id="huntOpportunityList" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"></div>',
      '</div>',

      '<div id="huntPaneCountries" class="hidden">',
      '  <div class="glass rounded-2xl p-5">',
      '    <h3 class="text-lg font-semibold text-yellow-100 flex items-center mb-3"><i data-lucide="globe-2" class="w-5 h-5 mr-2 text-yellow-400"></i>Tüm Ülkeler</h3>',
      '    <div id="huntCountryTable" class="overflow-x-auto"></div>',
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

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.hunt-tab').forEach(function (button) {
      var isActive = button.getAttribute('data-hunt-tab') === tab;
      button.className = 'hunt-tab px-4 py-2 rounded-xl text-sm font-bold border transition-all ' +
        (isActive
          ? 'border-yellow-500/40 bg-yellow-500/20 text-yellow-300'
          : 'border-white/10 bg-white/5 text-yellow-50/60');
    });
    setHidden('huntPaneStreams', tab !== 'streams');
    setHidden('huntPaneOpportunities', tab !== 'opportunities');
    setHidden('huntPaneCountries', tab !== 'countries');
    refresh(true);
  }

  function setHidden(id, hidden) {
    var element = document.getElementById(id);
    if (!element) return;
    element.classList.toggle('hidden', hidden);
  }

  function wire() {
    fillCountrySelects();

    document.querySelectorAll('.hunt-tab').forEach(function (button) {
      button.addEventListener('click', function () {
        switchTab(button.getAttribute('data-hunt-tab'));
      });
    });

    var addBtn = document.getElementById('huntAddBtn');
    if (addBtn) addBtn.addEventListener('click', addFromInput);

    var input = document.getElementById('huntInput');
    if (input) input.addEventListener('keydown', function (event) { if (event.key === 'Enter') addFromInput(); });

    var refreshBtn = document.getElementById('huntRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { refresh(true); });

    var stopAll = document.getElementById('huntStopAllBtn');
    if (stopAll) stopAll.addEventListener('click', function () {
      if (!confirm('Tüm yayınlar dinlenmeyi bıraksın mı? Geçmiş ve toplamlar silinmez.')) return;
      send({ action: 'hunt_stop_all' }, function () {
        window.RADAR_STORE.api('/api/hunt/targets', { method: 'PUT', body: '[]' }).then(function () { refresh(true); });
      });
    });

    var sortSelect = document.getElementById('huntSort');
    if (sortSelect) sortSelect.addEventListener('change', function () { sortMode = sortSelect.value; renderTargets(); });

    var countrySelect = document.getElementById('huntCountryFilter');
    if (countrySelect) countrySelect.addEventListener('change', function () {
      countryFilter = countrySelect.value;
      renderTargets();
    });

    var csvBtn = document.getElementById('huntCsvBtn');
    if (csvBtn) csvBtn.addEventListener('click', exportCsv);

    var targets = document.getElementById('huntTargetsList');
    if (targets) targets.addEventListener('click', function (event) {
      var removeButton = event.target.closest('[data-hunt-remove]');
      if (removeButton) {
        var username = removeButton.getAttribute('data-hunt-remove');
        send({ action: 'hunt_remove', username: username }, function () {
          window.RADAR_STORE.api('/api/hunt/targets?username=' + encodeURIComponent(username), { method: 'DELETE' })
            .then(function () { refresh(true); })
            .catch(function () { refresh(true); });
        });
        return;
      }
      var qrButton = event.target.closest('[data-hunt-qr]');
      if (qrButton) openQr(qrButton.getAttribute('data-hunt-qr'), qrButton.getAttribute('data-hunt-room'));
    });

    var opportunities = document.getElementById('huntOpportunityList');
    if (opportunities) opportunities.addEventListener('click', function (event) {
      var collectButton = event.target.closest('[data-hunt-collect]');
      if (collectButton) {
        collect(collectButton.getAttribute('data-hunt-collect'), 'collected');
        return;
      }
      var dismissButton = event.target.closest('[data-hunt-dismiss]');
      if (dismissButton) {
        collect(dismissButton.getAttribute('data-hunt-dismiss'), 'dismissed');
        return;
      }
      var qrButton = event.target.closest('[data-hunt-qr]');
      if (qrButton) openQr(qrButton.getAttribute('data-hunt-qr'), qrButton.getAttribute('data-hunt-room'));
    });
  }

  // ---------- Veri ----------

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
      } catch (e) { /* yedeğe düş */ }
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
    var seen = {};
    var entries = [];
    usernames.forEach(function (username) {
      if (seen[username]) return;
      seen[username] = true;
      entries.push({ username: username, country: country });
    });

    send({ action: 'hunt_add', usernames: entries }, function () {
      if (!window.RADAR_STORE || !window.RADAR_STORE.available()) {
        addLog('Arka uç adresi yok. Ayarlardan sunucu adresini ve anahtarı girin.');
        return;
      }
      entries.forEach(function (entry) {
        window.RADAR_STORE.api('/api/hunt/targets', { method: 'POST', body: JSON.stringify(entry) })
          .then(function () { refresh(true); })
          .catch(function (error) { addLog(error.message); });
      });
    });

    input.value = '';
    setTimeout(function () { refresh(true); }, 1200);
  }

  function refresh(withEvents) {
    if (!window.RADAR_STORE || !window.RADAR_STORE.available()) {
      updateServerBadge();
      return;
    }

    window.RADAR_STORE.pull().then(function (payload) {
      if (payload && payload.radar) {
        applyState(payload.radar, payload.radar.events || null, payload.pending || (payload.radar && payload.radar.pending) || null);
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
      var host = info.base.replace(/^https?:\/\//, '').split('/')[0];
      if (host.length > 34) host = host.slice(0, 31) + '…';
      badge.className = 'text-[11px] px-3 py-1.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-400';
      badge.innerHTML = '<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1"></span>Sunucu bağlı · ' + escapeHtml(host);
    } else {
      badge.className = 'text-[11px] px-3 py-1.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
      badge.textContent = info.error ? 'Çevrimdışı · ' + info.error : 'Çevrimdışı mod · sunucu adresi gerekli';
    }
  }

  function addLog(message) {
    var hint = document.getElementById('huntHint');
    if (hint) hint.textContent = message;
  }

  function applyState(nextState, nextEvents, nextPending) {
    if (nextState) {
      state.targets = Array.isArray(nextState.targets) ? nextState.targets : [];
      state.sessions = nextState.sessions || {};
      state.limits = nextState.limits || state.limits;
      state.serverTime = nextState.serverTime || Date.now();
      state.pendingCount = Number(nextState.pendingCount) || 0;
      state.pendingCoins = Number(nextState.pendingCoins) || 0;
    }

    if (Array.isArray(nextEvents)) {
      events = [];
      eventIndex = {};
      nextEvents.forEach(function (event) { pushEvent(event, true); });
    }

    if (Array.isArray(nextPending)) {
      pending = nextPending.filter(function (event) { return !event.collectedAt && !isLetterExpired(event); });
    } else {
      pending = computePending();
    }

    render();
  }

  function computePending() {
    return events.filter(function (event) {
      if (event.collectedAt) return false;
      if ((Number(event.coins) || 0) < 1) return false;
      if (isLetterExpired(event)) return false;
      return true;
    }).sort(function (a, b) {
      var aLetter = a.kind === 'letter';
      var bLetter = b.kind === 'letter';
      if (aLetter !== bLetter) return aLetter ? -1 : 1;
      if (aLetter) return (a.expiresAt || 0) - (b.expiresAt || 0);
      return (Number(b.coins) || 0) - (Number(a.coins) || 0);
    });
  }

  function pushEvent(event, silent) {
    if (!event || !event.username) return;
    var id = event.id || (event.username + '-' + event.at);
    if (eventIndex[id]) {
      events[eventIndex[id].index] = Object.assign({}, event, { id: id });
    } else {
      events.unshift(Object.assign({}, event, { id: id }));
      eventIndex[id] = { index: 0 };
    }
    rebuildIndex();
    events = events.slice(0, 500);
    rebuildIndex();
    if (!silent) render();
  }

  function updateEvent(event) {
    if (!event || !event.id) return;
    var entry = eventIndex[event.id];
    if (entry) events[entry.index] = Object.assign({}, events[entry.index], event);
    if (event.collectedAt) {
      pending = pending.filter(function (item) { return item.id !== event.id; });
    }
    render();
  }

  function rebuildIndex() {
    eventIndex = {};
    events.forEach(function (item, index) { eventIndex[item.id] = { index: index }; });
  }

  function collect(id, mode) {
    send({ action: 'hunt_collect', id: id, mode: mode }, function () {
      if (!window.RADAR_STORE || !window.RADAR_STORE.available()) return;
      window.RADAR_STORE.api('/api/hunt/collect', {
        method: 'POST',
        body: JSON.stringify({ id: id, mode: mode })
      }).then(function (result) {
        if (result && result.state) applyState(result.state, null, result.pending || null);
      }).catch(function (error) { addLog(error.message); });
    });
  }

  // ---------- QR ----------

  function openQr(username, roomId) {
    if (!username) return;
    var url = liveUrl(username);
    var id = roomIdOf(roomId || roomIdFor(username));

    if (!qrModal) {
      qrModal = document.createElement('div');
      qrModal.id = 'huntQrModal';
      qrModal.className = 'hidden fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm px-4';
      qrModal.innerHTML = [
        '<div class="glass rounded-2xl p-6 w-full max-w-sm relative border-t-4 border-t-yellow-500">',
        '  <button id="huntQrClose" class="absolute top-3 right-3 text-yellow-50/60 hover:text-yellow-300 p-1"><i data-lucide="x" class="w-5 h-5"></i></button>',
        '  <h3 id="huntQrTitle" class="text-lg font-bold text-yellow-100 mb-1">Yayına git</h3>',
        '  <p class="text-[11px] text-yellow-50/50 mb-4">Telefonunla okut, TikTok yayını doğrudan açılır.</p>',
        '  <div id="huntQrBox" class="bg-white rounded-xl p-3 flex items-center justify-center min-h-[220px]"></div>',
        '  <div id="huntQrApps" class="mt-3 flex flex-wrap gap-2"></div>',
        '  <a id="huntQrLink" href="#" target="_blank" rel="noopener" class="block mt-4 text-center text-xs text-yellow-300 underline break-all"></a>',
        '</div>'
      ].join('');
      document.body.appendChild(qrModal);

      qrModal.addEventListener('click', function (event) {
        if (event.target === qrModal) closeQr();
      });
      qrModal.querySelector('#huntQrClose').addEventListener('click', closeQr);
      if (window.lucide) window.lucide.createIcons();
    }

    var box = qrModal.querySelector('#huntQrBox');
    box.innerHTML = '';
    qrModal.querySelector('#huntQrTitle').textContent = '@' + username + ' · canlı yayın';
    var link = qrModal.querySelector('#huntQrLink');
    link.href = url;
    link.textContent = url;

    var apps = qrModal.querySelector('#huntQrApps');
    if (apps) {
      apps.innerHTML = '';
      if (id) {
        apps.innerHTML =
          '<a href="' + escapeHtml(androidIntentUrl(id, url)) + '" class="text-[11px] px-2.5 py-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/30 text-green-300">📱 Android uygulamada aç</a>' +
          '<a href="' + escapeHtml(appSchemeUrl(id, 'ios')) + '" class="text-[11px] px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-yellow-100">🍏 iPhone/iPad uygulamada aç</a>';
      } else {
        apps.innerHTML = '<p class="text-[11px] text-yellow-50/50">Oda kimliği henüz yok; QR web yayınını açar.</p>';
      }
    }

    if (window.QRCode) {
      new window.QRCode(box, {
        text: url,
        width: 220,
        height: 220,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    } else {
      box.innerHTML = '<p class="text-black text-xs text-center">QR kitaplığı yüklenemedi. Bağlantıyı kullanın.</p>';
    }

    qrModal.classList.remove('hidden');
  }

  function closeQr() {
    if (qrModal) qrModal.classList.add('hidden');
  }

  // ---------- Çizim ----------

  function totals() {
    var result = { streams: state.targets.length, live: 0, chests: 0, letters: 0, portals: 0, coins: 0 };
    var targetNames = {};
    state.targets.forEach(function (target) { targetNames[target.username] = true; });
    Object.keys(state.sessions).forEach(function (username) {
      if (!targetNames[username]) return;
      var session = state.sessions[username];
      if (!session) return;
      if (session.status === 'live') result.live += 1;
      var t = session.totals || {};
      result.chests += Number(t.chests) || 0;
      result.letters += Number(t.letters) || 0;
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
    setText('huntStatChests', formatCoins(summary.chests));
    setText('huntStatLetters', formatCoins(summary.letters));
    setText('huntStatPending', formatCoins(state.pendingCoins || 0));
    setText('huntPendingBadge', String(pending.length));
    setText('huntPendingCoins', formatCoins(pending.reduce(function (sum, event) { return sum + (Number(event.coins) || 0); }, 0)) + ' jeton');
    setText('huntPendingCount', pending.length + ' fırsat');

    renderTargets();
    renderOpportunities();
    renderCountries();
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
      if (sortMode === 'coins') return ((sb.totals || {}).coins || 0) - ((sa.totals || {}).coins || 0);
      if (sortMode === 'duration') return liveSeconds(sb) - liveSeconds(sa);
      if (sortMode === 'country') {
        var ca = sa.region || a.country || 'ZZ';
        var cb = sb.region || b.country || 'ZZ';
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

      return [
        '<tr class="border-b border-white/5 hover:bg-white/[0.03] transition-colors">',
        '  <td class="py-2.5 pr-3">',
        '    <a href="' + liveUrl(target.username) + '" target="_blank" rel="noopener" class="text-yellow-100 font-semibold hover:text-yellow-300">@' + escapeHtml(target.username) + '</a>',
        session.title ? '    <div class="text-[10px] text-yellow-50/40 truncate max-w-[180px]">' + escapeHtml(session.title).slice(0, 60) + '</div>' : '',
        '  </td>',
        '  <td class="py-2.5 pr-3 text-xs text-yellow-50/70 whitespace-nowrap">' + flagOf(region) + ' ' + escapeHtml(countryName(region)) + '</td>',
        '  <td class="py-2.5 pr-3"><span class="text-[10px] px-2 py-0.5 rounded-full border ' + meta.cls + ' whitespace-nowrap"><span class="inline-block w-1.5 h-1.5 rounded-full ' + meta.dot + ' mr-1"></span>' + meta.label + '</span></td>',
        '  <td class="py-2.5 pr-3 text-xs font-mono text-yellow-100/80" data-hunt-duration="' + escapeHtml(target.username) + '">' + formatClock(liveSeconds(session)) + '</td>',
        '  <td class="py-2.5 pr-3 text-xs text-amber-300">' + formatCoins(totalsData.chests || 0) + '</td>',
        '  <td class="py-2.5 pr-3 text-xs text-pink-300">' + formatCoins(totalsData.letters || 0) + '</td>',
        '  <td class="py-2.5 pr-3 text-xs font-bold text-amber-400">' + formatCoins(totalsData.coins || 0) + '</td>',
        '  <td class="py-2.5 pr-2 text-right whitespace-nowrap">',
        '    <button data-hunt-qr="' + escapeHtml(target.username) + '" data-hunt-room="' + escapeHtml(session.roomId || target.roomId || '') + '" title="QR ile yayına git" class="text-[11px] px-2 py-1 rounded bg-yellow-500/10 hover:bg-yellow-500/25 border border-yellow-500/25 text-yellow-300 mr-1"><i data-lucide="qr-code" class="w-3.5 h-3.5 inline"></i></button>',
        '    <button data-hunt-remove="' + escapeHtml(target.username) + '" class="text-[11px] px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/25 border border-red-500/20 text-red-400">Kaldır</button>',
        '  </td>',
        '</tr>'
      ].join('');
    }).join('');

    container.innerHTML = [
      '<table class="w-full text-left text-sm">',
      '<thead><tr class="text-[10px] uppercase tracking-wide text-yellow-50/40 border-b border-white/10">',
      '<th class="py-2 pr-3">Yayıncı</th><th class="py-2 pr-3">Ülke</th><th class="py-2 pr-3">Durum</th><th class="py-2 pr-3">Süre</th><th class="py-2 pr-3">Sandık</th><th class="py-2 pr-3">Zarf</th><th class="py-2 pr-3">Jeton</th><th class="py-2 text-right">İşlem</th>',
      '</tr></thead><tbody>' + rows + '</tbody></table>'
    ].join('');

    if (window.lucide) window.lucide.createIcons();
  }

  function renderCountryFilter() {
    var select = document.getElementById('huntCountryFilter');
    if (!select) return;

    var codes = {};
    Object.keys(state.sessions).forEach(function (username) {
      var session = state.sessions[username];
      if (session && session.region) codes[session.region] = true;
    });
    state.targets.forEach(function (target) { if (target.country) codes[target.country] = true; });

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

  function renderOpportunities() {
    var container = document.getElementById('huntOpportunityList');
    if (!container) return;

    if (pending.length === 0) {
      container.innerHTML = '<div class="md:col-span-2 xl:col-span-3 text-center text-yellow-50/30 text-sm py-12 border border-dashed border-white/10 rounded-2xl">' +
        'Bekleyen jeton yok. Yayında sandık veya zarf düştüğü anda burada belirir; süresi geçen sandıklar da listede kalır.' +
        '</div>';
      return;
    }

    container.innerHTML = pending.map(function (event) {
      var meta = kindMeta(event.kind);
      var now = Date.now();
      var remaining = 0;
      var timeLabel = '';
      var urgent = false;

      if (event.kind === 'letter') {
        remaining = Math.max(0, Math.round(((event.expiresAt || now) - now) / 1000));
        timeLabel = 'jeton geri dönüyor: ' + formatClock(remaining);
        urgent = remaining <= 60;
      } else {
        remaining = Math.max(0, Math.round(((event.availableAt || now) - now) / 1000));
        timeLabel = remaining > 0 ? 'açılışa ' + formatClock(remaining) : 'bekliyor · süre doldu, kaybolmaz';
      }

      return [
        '<div class="rounded-2xl border ' + (urgent ? 'border-red-500/40 bg-red-500/5' : 'border-white/10 bg-black/40') + ' p-4">',
        '  <div class="flex items-center justify-between mb-2">',
        '    <span class="text-[10px] px-2 py-0.5 rounded border ' + meta.cls + '">' + meta.icon + ' ' + meta.label + '</span>',
        '    <span class="text-lg font-black text-amber-400">' + formatCoins(event.coins) + ' <span class="text-[10px] font-normal text-yellow-50/40">jeton</span></span>',
        '  </div>',
        '  <a href="' + liveUrl(event.username) + '" target="_blank" rel="noopener" class="text-sm font-semibold text-yellow-100 hover:text-yellow-300 truncate block">@' + escapeHtml(event.username) + '</a>',
        '  <div class="text-[10px] text-yellow-50/40 mb-1">' + flagOf(event.region) + ' ' + escapeHtml(countryName(event.region)) + ' · ' + new Date(event.at).toLocaleTimeString('tr-TR') + '</div>',
        '  <div class="text-[11px] ' + (urgent ? 'text-red-300 font-bold' : 'text-yellow-50/60') + '" data-hunt-remaining="' + (event.kind === 'letter' ? event.expiresAt : event.availableAt) + '" data-hunt-kind="' + event.kind + '">' + timeLabel + '</div>',
        '  <div class="flex items-center gap-2 mt-3">',
        '    <button data-hunt-qr="' + escapeHtml(event.username) + '" data-hunt-room="' + escapeHtml(event.roomId || roomIdFor(event.username)) + '" class="text-[11px] px-2.5 py-1.5 rounded-lg bg-yellow-500/15 hover:bg-yellow-500/30 border border-yellow-500/30 text-yellow-300">QR / Yayına git</button>',
        '    <button data-hunt-collect="' + escapeHtml(event.id) + '" class="text-[11px] px-2.5 py-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/30 text-green-300">Topladım</button>',
        '    <button data-hunt-dismiss="' + escapeHtml(event.id) + '" class="text-[11px] px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-yellow-50/40">Kaçtı</button>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');
  }

  function renderCountries() {
    var container = document.getElementById('huntCountryTable');
    if (!container) return;

    var groups = {};
    var targetNames = {};
    state.targets.forEach(function (target) { targetNames[target.username] = true; });
    Object.keys(state.sessions).forEach(function (username) {
      if (!targetNames[username]) return;
      var session = state.sessions[username];
      if (!session) return;
      if (session.status === 'stopped') return;

      var code = session.region || 'UNKNOWN';
      if (!groups[code]) groups[code] = { code: code, streamers: 0, live: 0, chests: 0, letters: 0, coins: 0 };
      var group = groups[code];
      group.streamers += 1;
      if (session.status === 'live') group.live += 1;
      var totalsData = session.totals || {};
      group.chests += Number(totalsData.chests || 0);
      group.letters += Number(totalsData.letters || 0);
      group.coins += Number(totalsData.coins || 0);
    });

    var list = Object.keys(groups).map(function (key) { return groups[key]; });
    list.sort(function (a, b) {
      return countryName(a.code === 'UNKNOWN' ? '' : a.code).localeCompare(countryName(b.code === 'UNKNOWN' ? '' : b.code), 'tr');
    });

    if (list.length === 0) {
      container.innerHTML = '<div class="text-xs text-yellow-50/30 text-center py-6">Jeton olayı geldikçe ülkeler burada listelenir.</div>';
      return;
    }

    var total = { streamers: 0, live: 0, chests: 0, letters: 0, coins: 0 };
    list.forEach(function (group) {
      total.streamers += group.streamers;
      total.live += group.live;
      total.chests += group.chests;
      total.letters += group.letters;
      total.coins += group.coins;
    });

    var rows = list.map(function (group) {
      var label = group.code === 'UNKNOWN' ? '🏳️ Bilinmiyor' : flagOf(group.code) + ' ' + escapeHtml(countryName(group.code));
      return [
        '<tr class="border-b border-white/5">',
        '<td class="py-2 pr-2 text-xs text-yellow-100 whitespace-nowrap">' + label + '</td>',
        '<td class="py-2 pr-2 text-xs text-yellow-50/60 text-center">' + group.streamers + '</td>',
        '<td class="py-2 pr-2 text-xs text-green-400 text-center">' + group.live + '</td>',
        '<td class="py-2 pr-2 text-xs text-amber-300 text-center">' + formatCoins(group.chests) + '</td>',
        '<td class="py-2 pr-2 text-xs text-pink-300 text-center">' + formatCoins(group.letters) + '</td>',
        '<td class="py-2 text-xs font-bold text-amber-400 text-right">' + formatCoins(group.coins) + '</td>',
        '</tr>'
      ].join('');
    }).join('');

    container.innerHTML = [
      '<table class="w-full">',
      '<thead><tr class="text-[10px] uppercase text-yellow-50/40 border-b border-white/10">',
      '<th class="py-1.5 pr-2 text-left">Ülke</th><th class="py-1.5 pr-2 text-center">Yayıncı</th><th class="py-1.5 pr-2 text-center">Canlı</th><th class="py-1.5 pr-2 text-center">Sandık</th><th class="py-1.5 pr-2 text-center">Zarf</th><th class="py-1.5 text-right">Jeton</th>',
      '</tr></thead><tbody>' + rows + '</tbody>',
      '<tfoot><tr class="border-t border-white/10 text-yellow-100">',
      '<td class="py-2 text-[11px] font-bold">TOPLAM</td>',
      '<td class="py-2 text-[11px] text-center">' + total.streamers + '</td>',
      '<td class="py-2 text-[11px] text-center text-green-400">' + total.live + '</td>',
      '<td class="py-2 text-[11px] text-center text-amber-300">' + formatCoins(total.chests) + '</td>',
      '<td class="py-2 text-[11px] text-center text-pink-300">' + formatCoins(total.letters) + '</td>',
      '<td class="py-2 text-[11px] text-right text-amber-400">' + formatCoins(total.coins) + '</td>',
      '</tr></tfoot></table>'
    ].join('');
  }

  // ---------- Canlı sayaçlar ----------

  function tick() {
    Object.keys(state.sessions).forEach(function (username) {
      var element = document.querySelector('[data-hunt-duration="' + username.replace(/"/g, '\\"') + '"]');
      if (element) element.textContent = formatClock(liveSeconds(state.sessions[username]));
    });

    document.querySelectorAll('[data-hunt-remaining]').forEach(function (element) {
      var target = Number(element.getAttribute('data-hunt-remaining'));
      var kind = element.getAttribute('data-hunt-kind');
      var remaining = Math.max(0, Math.round((target - Date.now()) / 1000));

      if (kind === 'letter') {
        element.textContent = remaining > 0
          ? 'jeton geri dönüyor: ' + formatClock(remaining)
          : 'süre doldu · jeton yayıncıya döndü';
      } else {
        element.textContent = remaining > 0
          ? 'açılışa ' + formatClock(remaining)
          : 'bekliyor · süre doldu, kaybolmaz';
      }
    });

    // Süresi dolan zarfları listeden düşür (sandıklar kalır).
    var hasExpiredLetter = pending.some(function (event) { return isLetterExpired(event); });
    if (hasExpiredLetter) {
      pending = pending.filter(function (event) { return !isLetterExpired(event); });
      renderOpportunities();
      setText('huntPendingBadge', String(pending.length));
      setText('huntPendingCoins', formatCoins(pending.reduce(function (sum, event) { return sum + (Number(event.coins) || 0); }, 0)) + ' jeton');
      setText('huntPendingCount', pending.length + ' fırsat');
    }
  }

  // ---------- CSV ----------

  function exportCsv() {
    var lines = ['tur,yayinci,ulke,jeton,acilma_suresi,zaman,durum'];

    events.forEach(function (event) {
      lines.push([
        event.kind || 'chest',
        event.username,
        event.region || '',
        event.coins || 0,
        event.canOpenSec || 0,
        event.at || '',
        event.collectedAt ? 'toplandi' : (isLetterExpired(event) ? 'suresi_doldu' : 'bekliyor')
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

  // ---------- WebSocket mesajları ----------

  window.onHuntMessage = function (data) {
    if (!data || !data.type) return false;

    if (data.type === 'hunt_state') {
      applyState(data.state, null, null);
      return true;
    }
    if (data.type === 'hunt_events') {
      applyState(null, data.events || [], null);
      return true;
    }
    if (data.type === 'hunt_pending') {
      pending = data.pending || [];
      render();
      return true;
    }
    if (data.type === 'hunt_event') {
      pushEvent(data.event, false);
      return true;
    }
    if (data.type === 'hunt_event_update') {
      updateEvent(data.event);
      return true;
    }
    if (data.type === 'hunt_collect_result') {
      if (data.state) applyState(data.state, null, data.pending || null);
      if (!data.ok && data.error) addLog(data.error);
      return true;
    }
    if (data.type === 'hunt_result') {
      if (data.state) applyState(data.state, null, null);
      (data.results || []).forEach(function (result) {
        if (result && result.error) addLog(result.error);
      });
      return true;
    }
    if (data.type === 'hunt_log') {
      addLog(data.message);
      return true;
    }
    if (data.type === 'auth_required') {
      if (window.RADAR_STORE && window.RADAR_STORE.promptLogin) window.RADAR_STORE.promptLogin();
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
      if (view && !view.classList.contains('hidden')) refresh(true);
    }, 8000);
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
