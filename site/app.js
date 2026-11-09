/*
 * app.js — Sunucusuz TikTok jeton paneli.
 *
 * Ağ isteği yoktur. Veri Store (IndexedDB) üzerinde tutulur.
 * Akış:
 *   - Yayıncı ekle, süreyi başlat/durdur
 *   - Sandık / zarf / portal olayını jeton ve süresiyle kaydet
 *   - Fırsatlar: sandık süresi dolsa da bekler; zarf süresi dolunca düşer
 *   - QR ile telefonundan yayına git
 */
(function () {
  'use strict';

  var COUNTRIES = {
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
    LY: 'Libya', GE: 'Gürcistan', AM: 'Ermenistan', BY: 'Belarus', LT: 'Litvanya',
    LV: 'Letonya', EE: 'Estonya', SK: 'Slovakya', SI: 'Slovenya', HR: 'Hırvatistan',
    AL: 'Arnavutluk', MD: 'Moldova', CY: 'Kıbrıs'
  };

  var KINDS = {
    chest: { label: 'SANDIK', icon: '📦', cls: 'kind-chest' },
    letter: { label: 'ZARF / MEKTUP', icon: '✉️', cls: 'kind-letter' },
    portal: { label: 'PORTAL', icon: '🌀', cls: 'kind-portal' }
  };

  var state = null;
  var sortMode = 'alpha';
  var searchTerm = '';
  var eventTarget = { streamerId: null, kind: 'chest' };
  var notified = {};
  var audioCtx = null;

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function flag(code) {
    if (!code || code.length !== 2) return '🏳️';
    return String.fromCodePoint.apply(String, code.toUpperCase().split('').map(function (c) {
      return 127397 + c.charCodeAt(0);
    }));
  }

  function countryName(code) {
    if (!code) return 'Bilinmiyor';
    return COUNTRIES[code] || code;
  }

  function fmt(value) {
    return (Number(value) || 0).toLocaleString('tr-TR');
  }

  function clock(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function pad(v) { return String(v).padStart(2, '0'); }
    return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }

  function liveUrl(username) {
    return 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live';
  }

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  function cleanUsername(value) {
    return String(value || '')
      .trim()
      .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
      .replace(/^@/, '')
      .split(/[/?#]/)[0]
      .toLowerCase();
  }

  // ---------- Sekmeler ----------

  function switchTab(tab) {
    document.querySelectorAll('.view').forEach(function (view) {
      view.classList.toggle('hidden', view.id !== 'view-' + tab);
    });
    document.querySelectorAll('.tab-btn').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tab') === tab);
    });
    if (window.lucide) lucide.createIcons();
  }

  // ---------- Av ----------

  function streamerDuration(streamer) {
    var total = Number(streamer.accumulatedMs) || 0;
    if (streamer.startedAt) total += Date.now() - new Date(streamer.startedAt).getTime();
    return total / 1000;
  }

  function eventsOf(streamerId) {
    return state.events.filter(function (event) { return event.streamerId === streamerId; });
  }

  function isExpired(event) {
    return event.kind === 'letter' && event.expiresAt && event.expiresAt <= Date.now();
  }

  function pendingEvents() {
    return state.events.filter(function (event) {
      return event.status === 'pending' && !isExpired(event) && Number(event.coins) >= 1;
    });
  }

  function sortEvents(list) {
    return list.slice().sort(function (a, b) {
      var aLetter = a.kind === 'letter';
      var bLetter = b.kind === 'letter';
      if (aLetter !== bLetter) return aLetter ? -1 : 1;
      if (aLetter) return (a.expiresAt || 0) - (b.expiresAt || 0);
      return (Number(b.coins) || 0) - (Number(a.coins) || 0);
    });
  }

  function renderStats() {
    var pending = pendingEvents();
    var collected = state.events.filter(function (event) { return event.status === 'collected'; });
    $('statStreams').textContent = state.streamers.length;
    $('statPending').textContent = pending.length;
    $('statPendingCoins').textContent = fmt(pending.reduce(function (sum, event) { return sum + Number(event.coins); }, 0));
    $('statCollected').textContent = fmt(collected.reduce(function (sum, event) { return sum + Number(event.coins); }, 0));
    $('opportunityCount').textContent = pending.length;
    $('pendingCoinsBig').textContent = fmt(pending.reduce(function (sum, event) { return sum + Number(event.coins); }, 0)) + ' jeton';
  }

  function renderStreamers() {
    var container = $('streamerList');
    if (!container) return;

    if (state.streamers.length === 0) {
      container.innerHTML = '<div class="empty-state">Henüz yayın eklenmedi. Yukarıdan bir kullanıcı adı ekle; yayına girince süreyi başlat.</div>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    var list = state.streamers.slice();
    list.sort(function (a, b) {
      if (sortMode === 'coins') {
        var ca = eventsOf(a.id).reduce(function (s, e) { return s + Number(e.coins || 0); }, 0);
        var cb = eventsOf(b.id).reduce(function (s, e) { return s + Number(e.coins || 0); }, 0);
        return cb - ca;
      }
      if (sortMode === 'duration') return streamerDuration(b) - streamerDuration(a);
      if (sortMode === 'country') {
        var x = a.country || 'ZZ', y = b.country || 'ZZ';
        if (x !== y) return x.localeCompare(y);
      }
      return a.username.localeCompare(b.username, 'tr');
    });

    var rows = list.map(function (streamer) {
      var events = eventsOf(streamer.id);
      var chests = events.filter(function (e) { return e.kind === 'chest'; }).length;
      var letters = events.filter(function (e) { return e.kind === 'letter'; }).length;
      var coins = events.reduce(function (s, e) { return s + Number(e.coins || 0); }, 0);
      var running = Boolean(streamer.startedAt);

      return [
        '<div class="row">',
        '  <div class="min-w-0 flex-1">',
        '    <a href="' + liveUrl(streamer.username) + '" target="_blank" rel="noopener" class="font-bold text-yellow-100 hover:text-yellow-300">@' + esc(streamer.username) + '</a>',
        '    <div class="text-[11px] text-yellow-50/40">' + flag(streamer.country) + ' ' + esc(countryName(streamer.country)) + '</div>',
        '  </div>',
        '  <div class="text-center"><div class="text-[10px] text-yellow-50/40">SÜRE</div><div class="font-mono text-xs" data-streamer-timer="' + streamer.id + '">' + clock(streamerDuration(streamer)) + '</div></div>',
        '  <div class="text-center"><div class="text-[10px] text-yellow-50/40">SANDIK</div><div class="text-xs text-amber-300">' + chests + '</div></div>',
        '  <div class="text-center"><div class="text-[10px] text-yellow-50/40">ZARF</div><div class="text-xs text-pink-300">' + letters + '</div></div>',
        '  <div class="text-center"><div class="text-[10px] text-yellow-50/40">JETON</div><div class="text-xs font-bold text-amber-400">' + fmt(coins) + '</div></div>',
        '  <div class="flex flex-wrap items-center gap-1 justify-end">',
        '    <button class="chip ' + (running ? 'chip-danger' : 'chip-green') + '" data-toggle-timer="' + streamer.id + '">' + (running ? 'Durdur' : 'Başlat') + '</button>',
        '    <button class="chip chip-amber" data-add-event="' + streamer.id + '" data-kind="chest">+ Sandık</button>',
        '    <button class="chip chip-pink" data-add-event="' + streamer.id + '" data-kind="letter">+ Zarf</button>',
        '    <button class="chip chip-purple" data-add-event="' + streamer.id + '" data-kind="portal">+ Portal</button>',
        '    <button class="chip" data-qr="' + esc(streamer.username) + '">QR</button>',
        '    <button class="chip chip-danger" data-remove-streamer="' + streamer.id + '">×</button>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');

    container.innerHTML = rows;
    if (window.lucide) lucide.createIcons();
  }

  function renderOpportunities() {
    var container = $('opportunityList');
    if (!container) return;

    var pending = sortEvents(pendingEvents());
    if (pending.length === 0) {
      container.innerHTML = '<div class="empty-state md:col-span-2 xl:col-span-3">Bekleyen jeton yok. Yayında sandık veya zarf düştüğünde burada belirir.</div>';
      return;
    }

    container.innerHTML = pending.map(function (event) {
      var meta = KINDS[event.kind] || KINDS.chest;
      var urgent = false;
      var timeText = '';

      if (event.kind === 'letter') {
        var remaining = Math.max(0, Math.round(((event.expiresAt || Date.now()) - Date.now()) / 1000));
        urgent = remaining <= 60;
        timeText = 'jeton geri dönüyor: ' + clock(remaining);
      } else {
        var toOpen = Math.max(0, Math.round(((event.availableAt || Date.now()) - Date.now()) / 1000));
        if (toOpen > 0) {
          timeText = 'açılışa ' + clock(toOpen);
        } else if (Number(event.durationSec) > 0) {
          timeText = 'açıldı · süre doldu, kaybolmaz';
        } else {
          timeText = 'hemen açıldı · kaybolmaz';
        }
      }

      return [
        '<div class="opp-card ' + (urgent ? 'opp-urgent' : '') + '">',
        '  <div class="flex items-center justify-between mb-2">',
        '    <span class="kind-badge ' + meta.cls + '">' + meta.icon + ' ' + meta.label + '</span>',
        '    <span class="font-black text-amber-400">' + fmt(event.coins) + ' <span class="text-[10px] font-normal text-yellow-50/40">jeton</span></span>',
        '  </div>',
        '  <a href="' + liveUrl(event.username) + '" target="_blank" rel="noopener" class="font-semibold text-yellow-100 hover:text-yellow-300 truncate block">@' + esc(event.username) + '</a>',
        '  <div class="text-[10px] text-yellow-50/40">' + flag(event.country) + ' ' + esc(countryName(event.country)) + ' · ' + new Date(event.createdAt).toLocaleTimeString('tr-TR') + '</div>',
        '  <div class="text-[11px] mt-1 ' + (urgent ? 'text-red-300 font-bold' : 'text-yellow-50/60') + '" data-countdown="' + (event.kind === 'letter' ? event.expiresAt : event.availableAt) + '" data-kind="' + event.kind + '" data-duration="' + (Number(event.durationSec) || 0) + '">' + timeText + '</div>',
        '  <div class="flex gap-2 mt-3">',
        '    <button class="chip chip-amber" data-qr="' + esc(event.username) + '">QR / Yayına git</button>',
        '    <button class="chip chip-green" data-collect="' + event.id + '">Topladım</button>',
        '    <button class="chip chip-danger" data-miss="' + event.id + '">Kaçtı</button>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');
  }

  function addStreamer() {
    var raw = $('streamerName').value;
    var username = cleanUsername(raw);
    if (!username) {
      $('streamerName').focus();
      return;
    }
    if (state.streamers.some(function (s) { return s.username === username; })) {
      $('streamerName').value = '';
      return;
    }

    var streamers = state.streamers.concat([{
      id: uid('st'),
      username: username,
      country: $('streamerCountry').value || '',
      startedAt: null,
      accumulatedMs: 0,
      createdAt: Date.now()
    }]);

    Store.set({ streamers: streamers });
    state = Store.get();
    $('streamerName').value = '';
    renderAll();
  }

  function toggleTimer(id) {
    var streamers = state.streamers.map(function (streamer) {
      if (streamer.id !== id) return streamer;
      var copy = Object.assign({}, streamer);
      if (copy.startedAt) {
        copy.accumulatedMs = (Number(copy.accumulatedMs) || 0) + (Date.now() - new Date(copy.startedAt).getTime());
        copy.startedAt = null;
      } else {
        copy.startedAt = new Date().toISOString();
      }
      return copy;
    });
    Store.set({ streamers: streamers });
    state = Store.get();
    renderAll();
  }

  function removeStreamer(id) {
    var streamer = state.streamers.find(function (s) { return s.id === id; });
    if (!streamer) return;
    if (!confirm('@' + streamer.username + ' listeden ve olaylarından kaldırılsın mı?')) return;

    Store.set({
      streamers: state.streamers.filter(function (s) { return s.id !== id; }),
      events: state.events.filter(function (event) { return event.streamerId !== id; })
    });
    state = Store.get();
    renderAll();
  }

  function openEventModal(streamerId, kind) {
    eventTarget = { streamerId: streamerId, kind: kind || 'chest' };
    var streamer = state.streamers.find(function (s) { return s.id === streamerId; });
    $('eventTitle').textContent = '@' + (streamer ? streamer.username : '') + ' · ' + (KINDS[eventTarget.kind] || KINDS.chest).label;
    $('eventCoins').value = '';
    $('eventDuration').value = eventTarget.kind === 'letter' ? (state.settings.letterTtlSec || 180) : 60;
    renderEventTypes();
    openModal('eventModal');
    setTimeout(function () { $('eventCoins').focus(); }, 50);
  }

  function renderEventTypes() {
    $('eventTypes').innerHTML = Object.keys(KINDS).map(function (kind) {
      var meta = KINDS[kind];
      var active = eventTarget.kind === kind;
      return '<button class="chip ' + (active ? 'chip-amber' : '') + '" data-event-kind="' + kind + '">' + meta.icon + ' ' + meta.label + '</button>';
    }).join('');
  }

  function saveEvent() {
    var coins = Number($('eventCoins').value);
    var duration = Number($('eventDuration').value);
    if (!coins || coins < 1) { $('eventCoins').focus(); return; }

    var streamer = state.streamers.find(function (s) { return s.id === eventTarget.streamerId; });
    if (!streamer) return;

    var now = Date.now();
    var kind = eventTarget.kind;
    var seconds = Math.max(0, duration || 0);
    if (kind === 'letter' && seconds === 0) seconds = state.settings.letterTtlSec || 180;

    var event = {
      id: uid('ev'),
      streamerId: streamer.id,
      username: streamer.username,
      country: streamer.country || '',
      kind: kind,
      coins: coins,
      durationSec: seconds,
      createdAt: now,
      availableAt: now + seconds * 1000,
      expiresAt: kind === 'letter' ? now + seconds * 1000 : null,
      status: 'pending',
      collectedAt: null
    };

    Store.set({ events: [event].concat(state.events).slice(0, 2000) });
    state = Store.get();
    closeModal('eventModal');
    renderAll();
  }

  function collectEvent(id, mode) {
    var events = state.events.map(function (event) {
      if (event.id !== id) return event;
      return Object.assign({}, event, {
        status: mode === 'missed' ? 'missed' : 'collected',
        collectedAt: Date.now()
      });
    });
    Store.set({ events: events });
    state = Store.get();
    renderAll();
  }

  // ---------- Envanter ----------

  function renderInventory() {
    var container = $('accountList');
    var accounts = state.accounts.filter(function (account) {
      if (!searchTerm) return true;
      var haystack = (account.username + ' ' + (account.label || '')).toLowerCase();
      return haystack.indexOf(searchTerm) >= 0;
    });

    $('accCount').textContent = state.accounts.length;
    $('accAgency').innerHTML = '<option value="">Ajans yok</option>' + state.agencies.map(function (agency) {
      return '<option value="' + agency.id + '">' + esc(agency.name) + '</option>';
    }).join('');

    if (state.accounts.length === 0) {
      container.innerHTML = '<div class="empty-state">Envanter boş. Yukarıdan ilk hesabı ekle; veriler yalnızca bu cihazda tutulur.</div>';
      return;
    }
    if (accounts.length === 0) {
      container.innerHTML = '<div class="empty-state">Aramaya uyan hesap yok.</div>';
      return;
    }

    var rows = accounts.map(function (account) {
      var agency = state.agencies.find(function (a) { return a.id === account.agencyId; });
      var statusMeta = {
        active: ['Aktif', 'chip-green'],
        paused: ['Duraklatıldı', 'chip-amber'],
        banned: ['Banlı', 'chip-danger']
      }[account.status] || ['Aktif', 'chip-green'];

      return [
        '<div class="row">',
        '  <div class="min-w-0 flex-1">',
        '    <div class="font-bold text-yellow-100 truncate">@' + esc(account.username) + '</div>',
        '    <div class="text-[11px] text-yellow-50/40 truncate">' + esc(account.label || '—') + '</div>',
        '  </div>',
        '  <div class="text-xs text-yellow-50/60 w-32 truncate">' + (agency ? esc(agency.name) : '—') + '</div>',
        '  <div><span class="chip ' + statusMeta[1] + '">' + statusMeta[0] + '</span></div>',
        '  <div class="text-xs font-bold text-amber-400 w-20 text-right">' + fmt(account.coins) + '</div>',
        '  <div class="flex gap-1">',
        '    <button class="chip" data-toggle-status="' + account.id + '">Durum</button>',
        '    <button class="chip chip-danger" data-remove-account="' + account.id + '">×</button>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');

    container.innerHTML = rows;
  }

  function addAccount() {
    var username = cleanUsername($('accUser').value);
    if (!username) { $('accUser').focus(); return; }
    if (state.accounts.some(function (a) { return a.username.toLowerCase() === username; })) {
      alert('@' + username + ' zaten envanterde.');
      return;
    }

    var account = {
      id: uid('acc'),
      username: username,
      label: $('accUser').value.trim(),
      agencyId: $('accAgency').value || '',
      status: $('accStatus').value,
      coins: Number($('accCoins').value) || 0,
      createdAt: Date.now()
    };

    Store.set({ accounts: [account].concat(state.accounts) });
    state = Store.get();
    $('accUser').value = '';
    $('accCoins').value = '';
    renderAll();
  }

  function toggleAccountStatus(id) {
    var order = ['active', 'paused', 'banned'];
    var accounts = state.accounts.map(function (account) {
      if (account.id !== id) return account;
      var next = order[(order.indexOf(account.status) + 1) % order.length];
      return Object.assign({}, account, { status: next });
    });
    Store.set({ accounts: accounts });
    state = Store.get();
    renderAll();
  }

  function removeAccount(id) {
    Store.set({ accounts: state.accounts.filter(function (a) { return a.id !== id; }) });
    state = Store.get();
    renderAll();
  }

  function exportAccountsCsv() {
    var lines = ['username,label,status,coins,agency'];
    state.accounts.forEach(function (account) {
      var agency = state.agencies.find(function (a) { return a.id === account.agencyId; });
      lines.push([account.username, (account.label || '').replace(/,/g, ' '), account.status, account.coins || 0, (agency ? agency.name : '')].join(','));
    });
    download('envanter-' + new Date().toISOString().slice(0, 10) + '.csv', '\ufeff' + lines.join('\n'), 'text/csv');
  }

  function importAccountsFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var text = String(reader.result || '');
        if (file.name.toLowerCase().endsWith('.json')) {
          Store.importJson(text);
          state = Store.get();
          renderAll();
          return;
        }

        var rows = text.split(/\r?\n/).filter(Boolean);
        var header = rows.shift().toLowerCase();
        if (header.indexOf('username') < 0) throw new Error('CSV başlığında "username" olmalı.');

        var added = [];
        rows.forEach(function (line) {
          var cells = line.split(',');
          var username = cleanUsername(cells[0]);
          if (!username) return;
          if (state.accounts.some(function (a) { return a.username.toLowerCase() === username; })) return;
          added.push({
            id: uid('acc'),
            username: username,
            label: (cells[1] || '').trim(),
            status: ['active', 'paused', 'banned'].indexOf((cells[2] || '').trim()) >= 0 ? cells[2].trim() : 'active',
            coins: Number(cells[3]) || 0,
            agencyId: '',
            createdAt: Date.now()
          });
        });

        Store.set({ accounts: added.concat(state.accounts) });
        state = Store.get();
        renderAll();
        alert(added.length + ' hesap içe aktarıldı.');
      } catch (error) {
        alert('İçe aktarma hatası: ' + error.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- Ajanslar ----------

  function renderAgencies() {
    var container = $('agencyList');
    $('agCountry').innerHTML = '<option value="">Ülke seç</option>' + Object.keys(COUNTRIES).sort(function (a, b) {
      return countryName(a).localeCompare(countryName(b), 'tr');
    }).map(function (code) {
      return '<option value="' + code + '">' + flag(code) + ' ' + countryName(code) + '</option>';
    }).join('');

    if (state.agencies.length === 0) {
      container.innerHTML = '<div class="empty-state">Henüz ajans yok. Ajans ekleyince hesapları bu ajansa bağlayabilirsin.</div>';
      return;
    }

    container.innerHTML = state.agencies.map(function (agency) {
      var accounts = state.accounts.filter(function (a) { return a.agencyId === agency.id; });
      var coins = accounts.reduce(function (sum, a) { return sum + Number(a.coins || 0); }, 0);
      return [
        '<div class="row">',
        '  <div class="flex-1 min-w-0">',
        '    <div class="font-bold text-yellow-100 truncate">' + esc(agency.name) + '</div>',
        '    <div class="text-[11px] text-yellow-50/40">' + flag(agency.country) + ' ' + esc(countryName(agency.country)) + '</div>',
        '  </div>',
        '  <div class="text-xs text-yellow-50/60">' + accounts.length + ' hesap</div>',
        '  <div class="text-xs font-bold text-amber-400">' + fmt(coins) + ' jeton</div>',
        '  <div class="text-xs text-yellow-50/60">%' + (Number(agency.commission) || 0) + '</div>',
        '  <button class="chip chip-danger" data-remove-agency="' + agency.id + '">×</button>',
        '</div>'
      ].join('');
    }).join('');
  }

  function addAgency() {
    var name = $('agName').value.trim();
    if (!name) { $('agName').focus(); return; }
    if (state.agencies.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) {
      alert('Bu isimde ajans var.');
      return;
    }

    var agency = {
      id: uid('ag'),
      name: name,
      country: $('agCountry').value || '',
      commission: Number($('agCommission').value) || 0,
      createdAt: Date.now()
    };

    Store.set({ agencies: [agency].concat(state.agencies) });
    state = Store.get();
    $('agName').value = '';
    $('agCommission').value = '';
    renderAll();
  }

  function removeAgency(id) {
    if (!confirm('Ajans silinsin mi? Hesaplar silinmez, ajans bağlantısı kaldırılır.')) return;
    var accounts = state.accounts.map(function (account) {
      return account.agencyId === id ? Object.assign({}, account, { agencyId: '' }) : account;
    });
    Store.set({
      agencies: state.agencies.filter(function (a) { return a.id !== id; }),
      accounts: accounts
    });
    state = Store.get();
    renderAll();
  }

  // ---------- Gelir ----------

  function renderCalc() {
    var settings = state.settings;
    if (document.activeElement !== $('calcCoins') && !$('calcCoins').value) {
      $('calcCoins').value = state.events.filter(function (e) { return e.status === 'collected'; })
        .reduce(function (sum, e) { return sum + Number(e.coins || 0); }, 0) || '';
    }
    $('calcTiktok').value = settings.tiktokCutPct;
    $('calcAgency').value = settings.agencyCutPct;
    $('calcCoinUsd').value = settings.coinUsd;
    $('calcRate').value = settings.usdTry;
    updateCalc();
  }

  function updateCalc() {
    var coins = Number($('calcCoins').value) || 0;
    var tiktok = Number($('calcTiktok').value) || 0;
    var agency = Number($('calcAgency').value) || 0;
    var coinUsd = Number($('calcCoinUsd').value) || 0;
    var rate = Number($('calcRate').value) || 0;

    var gross = coins * coinUsd;
    var afterTiktok = gross * (1 - tiktok / 100);
    var net = afterTiktok * (1 - agency / 100);

    $('calcGross').textContent = '$' + gross.toFixed(2);
    $('calcAfterTiktok').textContent = '$' + afterTiktok.toFixed(2);
    $('calcAfterAgency').textContent = '$' + net.toFixed(2);
    $('calcTry').textContent = '₺' + (net * rate).toFixed(2);
  }

  function saveCalcSettings() {
    Store.set({
      settings: Object.assign({}, state.settings, {
        tiktokCutPct: Number($('calcTiktok').value) || 0,
        agencyCutPct: Number($('calcAgency').value) || 0,
        coinUsd: Number($('calcCoinUsd').value) || 0,
        usdTry: Number($('calcRate').value) || 0
      })
    });
    state = Store.get();
    alert('Hesaplama varsayılanları kaydedildi.');
  }

  // ---------- Ayarlar ----------

  function renderSettings() {
    $('letterTtl').value = state.settings.letterTtlSec;
    $('notifyToggle').checked = Boolean(state.settings.notify);

    var info = Store.storageInfo();
    $('storageInfo').textContent = info.engine + ' · ' + (info.bytes / 1024).toFixed(1) + ' KB · ' +
      info.streamers + ' yayın, ' + info.events + ' olay, ' + info.accounts + ' hesap, ' + info.agencies + ' ajans' +
      (info.updatedAt ? ' · son kayıt ' + new Date(info.updatedAt).toLocaleString('tr-TR') : '');
  }

  function saveSettings() {
    Store.set({
      settings: Object.assign({}, state.settings, {
        letterTtlSec: Math.max(10, Number($('letterTtl').value) || 180),
        notify: $('notifyToggle').checked
      })
    });
    state = Store.get();
    renderSettings();
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function exportBackup() {
    download('jeton-paneli-yedek-' + new Date().toISOString().slice(0, 10) + '.json', Store.exportJson());
  }

  // ---------- QR ----------

  function openQr(username) {
    var url = liveUrl(username);
    $('qrTitle').textContent = '@' + username + ' · canlı yayın';
    $('qrBox').innerHTML = '';
    $('qrLink').href = url;
    $('qrLink').textContent = url;

    if (window.QRCode) {
      new QRCode($('qrBox'), {
        text: url, width: 200, height: 200,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      $('qrBox').innerHTML = '<p class="text-black text-xs">QR kitaplığı yüklenemedi.</p>';
    }
    openModal('qrModal');
  }

  // ---------- Modal ----------

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  // ---------- Bildirim ----------

  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      setTimeout(function () { osc.stop(); }, 180);
    } catch (e) { /* ses desteklenmiyor */ }
  }

  function checkNotifications() {
    if (!state.settings.notify) return;
    var now = Date.now();
    state.events.forEach(function (event) {
      if (event.kind !== 'letter' || event.status !== 'pending' || notified[event.id]) return;
      if (!event.expiresAt) return;
      var remaining = event.expiresAt - now;
      if (remaining <= 60000 && remaining > 0) {
        notified[event.id] = true;
        beep();
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('Zarf süresi doluyor', {
            body: '@' + event.username + ' · ' + fmt(event.coins) + ' jeton · ' + Math.round(remaining / 1000) + ' sn',
            silent: true
          });
        }
      }
    });
  }

  // ---------- Döngü ----------

  function tick() {
    state.streamers.forEach(function (streamer) {
      var element = document.querySelector('[data-streamer-timer="' + streamer.id + '"]');
      if (element) element.textContent = clock(streamerDuration(streamer));
    });

    document.querySelectorAll('[data-countdown]').forEach(function (element) {
      var target = Number(element.getAttribute('data-countdown'));
      var kind = element.getAttribute('data-kind');
      var remaining = Math.max(0, Math.round((target - Date.now()) / 1000));
      var duration = Number(element.getAttribute('data-duration')) || 0;
      if (kind === 'letter') {
        element.textContent = remaining > 0 ? 'jeton geri dönüyor: ' + clock(remaining) : 'süre doldu · jeton yayıncıya döndü';
      } else if (remaining > 0) {
        element.textContent = 'açılışa ' + clock(remaining);
      } else {
        element.textContent = duration > 0 ? 'açıldı · süre doldu, kaybolmaz' : 'hemen açıldı · kaybolmaz';
      }
    });

    // Süresi dolan zarfları listeden düşür.
    if (state.events.some(function (event) { return event.status === 'pending' && isExpired(event); })) {
      var events = state.events.map(function (event) {
        if (event.status === 'pending' && isExpired(event)) {
          return Object.assign({}, event, { status: 'expired' });
        }
        return event;
      });
      Store.set({ events: events });
      state = Store.get();
      renderStats();
      renderOpportunities();
    }

    checkNotifications();
  }

  // ---------- Bağlama ----------

  function renderAll() {
    renderStats();
    renderStreamers();
    renderOpportunities();
    renderInventory();
    renderAgencies();
    renderCalc();
    renderSettings();
    if (window.lucide) lucide.createIcons();
  }

  function bind() {
    document.querySelectorAll('.tab-btn').forEach(function (button) {
      button.addEventListener('click', function () { switchTab(button.getAttribute('data-tab')); });
    });

    document.querySelectorAll('[data-close-modal]').forEach(function (button) {
      button.addEventListener('click', function () { closeModal(button.getAttribute('data-close-modal')); });
    });

    document.querySelectorAll('.modal').forEach(function (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target === modal) modal.classList.add('hidden');
      });
    });

    $('addStreamer').addEventListener('click', addStreamer);
    $('streamerName').addEventListener('keydown', function (event) { if (event.key === 'Enter') addStreamer(); });
    $('sortStreamers').addEventListener('change', function () { sortMode = $('sortStreamers').value; renderStreamers(); });

    $('streamerList').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;

      if (target.dataset.toggleTimer) return toggleTimer(target.dataset.toggleTimer);
      if (target.dataset.addEvent) return openEventModal(target.dataset.addEvent, target.dataset.kind);
      if (target.dataset.qr) return openQr(target.dataset.qr);
      if (target.dataset.removeStreamer) return removeStreamer(target.dataset.removeStreamer);
    });

    $('opportunityList').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.collect) return collectEvent(target.dataset.collect, 'collected');
      if (target.dataset.miss) return collectEvent(target.dataset.miss, 'missed');
      if (target.dataset.qr) return openQr(target.dataset.qr);
    });

    $('clearOpportunities').addEventListener('click', function () {
      var events = state.events.filter(function (event) {
        return event.status !== 'missed' && !(event.status === 'pending' && isExpired(event));
      });
      Store.set({ events: events });
      state = Store.get();
      renderAll();
    });

    $('eventTypes').addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      eventTarget.kind = button.getAttribute('data-event-kind');
      $('eventDuration').value = eventTarget.kind === 'letter' ? (state.settings.letterTtlSec || 180) : Number($('eventDuration').value) || 60;
      renderEventTypes();
    });
    $('eventSave').addEventListener('click', saveEvent);
    $('eventCoins').addEventListener('keydown', function (event) { if (event.key === 'Enter') saveEvent(); });

    $('addAccount').addEventListener('click', addAccount);
    $('accSearch').addEventListener('input', function () { searchTerm = $('accSearch').value.trim().toLowerCase(); renderInventory(); });
    $('accExport').addEventListener('click', exportAccountsCsv);
    $('accImportBtn').addEventListener('click', function () { $('accImport').click(); });
    $('accImport').addEventListener('change', function (event) {
      if (event.target.files[0]) importAccountsFile(event.target.files[0]);
      event.target.value = '';
    });

    $('accountList').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.toggleStatus) return toggleAccountStatus(target.dataset.toggleStatus);
      if (target.dataset.removeAccount) return removeAccount(target.dataset.removeAccount);
    });

    $('addAgency').addEventListener('click', addAgency);
    $('agencyList').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (target && target.dataset.removeAgency) removeAgency(target.dataset.removeAgency);
    });

    ['calcCoins', 'calcTiktok', 'calcAgency', 'calcCoinUsd', 'calcRate'].forEach(function (id) {
      $(id).addEventListener('input', updateCalc);
    });
    $('saveCalc').addEventListener('click', saveCalcSettings);

    $('saveSettings').addEventListener('click', function () {
      if ($('notifyToggle').checked && window.Notification && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      saveSettings();
    });
    $('exportBackup').addEventListener('click', exportBackup);
    $('importBackupBtn').addEventListener('click', function () { $('importBackup').click(); });
    $('importBackup').addEventListener('change', function (event) {
      var file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          Store.importJson(String(reader.result || ''));
          state = Store.get();
          renderAll();
          alert('Yedek yüklendi.');
        } catch (error) {
          alert('Yedek okunamadı: ' + error.message);
        }
      };
      reader.readAsText(file);
    });
    $('clearAll').addEventListener('click', function () {
      if (!confirm('Tüm yayınlar, olaylar, hesaplar ve ajanslar silinecek. Bu işlem geri alınamaz.')) return;
      Store.clearAll();
      state = Store.get();
      renderAll();
    });

  }

  function fillCountries() {
    var options = '<option value="">Ülke (opsiyonel)</option>' + Object.keys(COUNTRIES).sort(function (a, b) {
      return countryName(a).localeCompare(countryName(b), 'tr');
    }).map(function (code) {
      return '<option value="' + code + '">' + flag(code) + ' ' + countryName(code) + '</option>';
    }).join('');
    $('streamerCountry').innerHTML = options;
  }

  async function boot() {
    await Store.ready();
    state = Store.get();

    Store.subscribe(function (next) {
      state = next;
    });

    fillCountries();
    bind();
    renderAll();
    switchTab('hunt');
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
