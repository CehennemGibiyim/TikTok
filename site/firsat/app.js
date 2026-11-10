/*
 * app.js — Sunucusuz TikTok jeton paneli.
 *
 * Ağ isteği yoktur (yalnızca kullanıcı adı doğrulamak için TikTok oEmbed).
 * Veri Store (IndexedDB) üzerinde tutulur.
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
  var sortKey = 'name';
  var sortDir = 1;
  var oppSort = 'score';
  var searchTerm = '';
  var eventTarget = { streamerId: null, kind: 'chest' };
  var notified = {};
  var audioCtx = null;
  var verified = {};
  var scanInfo = null;
  var scanUrl = 'data/live.json';
  var poolUrl = 'data/targets.json';

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

  function ago(ms) {
    if (!ms) return '—';
    var diff = Date.now() - Number(ms);
    if (diff < 60000) return 'şimdi';
    var minutes = Math.floor(diff / 60000);
    if (minutes < 60) return minutes + ' dk önce';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' sa önce';
    var days = Math.floor(hours / 24);
    return days + ' gün önce';
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
      .split(/[/?#\s]/)[0]
      .toLowerCase();
  }

  function daysMs(days) { return Math.max(1, Number(days) || 7) * 86400000; }

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

  // ---------- Av verileri ----------

  function streamerDuration(streamer) {
    var total = Number(streamer.accumulatedMs) || 0;
    if (streamer.startedAt) total += Date.now() - new Date(streamer.startedAt).getTime();
    return total / 1000;
  }

  function eventsOf(streamerId) {
    return state.events.filter(function (event) { return event.streamerId === streamerId; });
  }

  function streamerMetrics(streamer) {
    var events = eventsOf(streamer.id);
    var metrics = {
      chest: 0, letter: 0, portal: 0, coins: 0, collected: 0, collectedCount: 0,
      shared: 0, lastSeen: Number(streamer.lastLiveAt) || 0, live: Boolean(streamer.startedAt)
    };
    events.forEach(function (event) {
      if (metrics[event.kind] !== undefined) metrics[event.kind] += 1;
      metrics.coins += Number(event.coins) || 0;
      if (event.status === 'collected') {
        metrics.collected += Number(event.coins) || 0;
        metrics.collectedCount += 1;
      }
      metrics.shared += Number(event.shared) || 0;
    });
    return metrics;
  }

  // ---------- Canlı tarayıcı köprüsü ----------
  // Tarayıcı (scanner/index.js) gerçek TikTok verisini data/live.json'a yazar.
  // Panel bu dosyayı okuyup canlı yayınları, gerçek sürelerini ve jeton
  // olaylarını kendiliğinden gösterir.

  function applyScan(data) {
    if (!data || !Array.isArray(data.streamers)) return false;

    var byName = {};
    state.streamers.forEach(function (streamer) { byName[streamer.username] = streamer; });

    var streamers = state.streamers.slice();
    var changed = false;

    data.streamers.forEach(function (item) {
      var username = cleanUsername(item.username);
      if (!username) return;
      // Tarayıcı başlangıç saatini ms yazar; eski saniye kayıtları da doğru okunsun.
      var rawStart = Number(item.startTime) || 0;
      var startMs = rawStart > 0 && rawStart < 1e12 ? rawStart * 1000 : rawStart;
      var startIso = startMs > 0 ? new Date(startMs).toISOString() : null;
      var existing = byName[username];

      if (existing) {
        var copy = Object.assign({}, existing, {
          scanLive: Boolean(item.live),
          scanReason: item.reason || '',
          scanCheckedAt: Number(item.checkedAt) || Date.now()
        });
        if (item.title) copy.liveTitle = item.title;
        if (item.viewers) copy.viewers = item.viewers;

        if (item.live && startIso && existing.startedAt !== startIso) {
          // TikTok'un gerçek başlangıç saati: süre sıfırdan ve doğru sayılır.
          copy.startedAt = startIso;
          copy.accumulatedMs = 0;
          copy.lastLiveAt = Number(item.lastSeenLiveAt) || Date.now();
        } else if (!item.live && existing.startedAt) {
          copy.accumulatedMs = (Number(existing.accumulatedMs) || 0) +
            Math.max(0, Date.now() - new Date(existing.startedAt).getTime());
          copy.startedAt = null;
          copy.lastLiveAt = Number(item.lastSeenLiveAt) || Date.now();
        }

        byName[username] = copy;
        streamers = streamers.map(function (streamer) {
          return streamer.id === existing.id ? copy : streamer;
        });
        changed = true;
        return;
      }

      if (!item.live) return;

      var created = {
        id: uid('st'),
        username: username,
        country: item.country || '',
        startedAt: item.live && startIso ? startIso : null,
        accumulatedMs: 0,
        createdAt: Date.now(),
        lastLiveAt: Number(item.lastSeenLiveAt) || (item.live ? Date.now() : 0),
        scanLive: Boolean(item.live),
        liveTitle: item.title || '',
        viewers: Number(item.viewers) || 0,
        source: 'scan'
      };
      byName[username] = created;
      streamers.push(created);
      changed = true;
    });

    // Tarama tek doğru kaynaktır: havuzdaki bir yayıncı taramada canlı değilse
    // panelde de canlı değildir. Böylece eski/elle işaretlenmiş "Canlı" durumu
    // ve ondan sayılan yanlış süre kendiliğinden kapanır.
    var scanned = {};
    (data.streamers || []).forEach(function (item) {
      if (item && item.username) scanned[cleanUsername(item.username)] = Boolean(item.live);
    });

    var scannedAt = data.scannedAt ? new Date(data.scannedAt).getTime() : 0;
    var fresh = scannedAt > 0 && (Date.now() - scannedAt) < 60 * 60 * 1000;

    if (fresh) {
      streamers = streamers.map(function (streamer) {
        var name = cleanUsername(streamer.username);
        var inPool = name in scanned;
        if (inPool && scanned[name]) return streamer;
        if (!streamer.startedAt && !streamer.scanLive) return streamer;
        changed = true;
        return Object.assign({}, streamer, {
          accumulatedMs: (Number(streamer.accumulatedMs) || 0) +
            Math.max(0, Date.now() - new Date(streamer.startedAt || Date.now()).getTime()),
          startedAt: null,
          scanLive: false,
          scanCheckedAt: inPool ? Date.now() : (streamer.scanCheckedAt || 0)
        });
      });
    }

    var events = state.events.slice();
    var known = {};
    events.forEach(function (event) { if (event.scanId) known[event.scanId] = true; });

    (data.events || []).forEach(function (item) {
      if (!item || !item.id || known[item.id]) return;
      var owner = byName[cleanUsername(item.username)];
      if (!owner) return;
      known[item.id] = true;
      events.unshift({
        id: uid('ev'),
        streamerId: owner.id,
        username: owner.username,
        country: owner.country || '',
        kind: item.kind === 'letter' ? 'letter' : (item.kind === 'portal' ? 'portal' : 'chest'),
        coins: Number(item.coins) || 0,
        durationSec: 0,
        availableAt: Number(item.t) || Date.now(),
        expiresAt: 0,
        shared: 0,
        status: 'pending',
        createdAt: Number(item.t) || Date.now(),
        scanId: item.id,
        auto: true,
        giftName: item.giftName || '',
        sender: item.sender || ''
      });
      changed = true;
    });

    if (changed) {
      Store.set({ streamers: streamers, events: events });
      state = Store.get();
    }
    return changed;
  }

  function renderScanStatus(error) {
    var el = $('scanStatus');
    if (!el) return;
    if (!scanInfo) {
      el.innerHTML = error
        ? 'Tarama verisi okunamadı (' + esc(error) + ').'
        : 'Tarama verisi yok — arka plan tarayıcısı henüz çalışmadı.';
      return;
    }
    var live = Number(scanInfo.liveCount) || 0;
    var parts = [
      'Tarama: ' + ago(new Date(scanInfo.scannedAt || Date.now()).getTime()),
      live + ' canlı',
      (Number(scanInfo.targetCount) || 0) + ' adres',
      (Number(scanInfo.watching) || 0) + ' oda dinleniyor'
    ];
    el.innerHTML = '<span class="chip chip-green">● ' + esc(parts.join(' · ')) + '</span>';
  }

  async function refreshScan() {
    try {
      var response = await fetch(scanUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      scanInfo = Object.assign({ scannedAt: data.scannedAt }, data.scanner || {});
      if (applyScan(data)) renderAll();
      renderScanStatus();
    } catch (error) {
      renderScanStatus(error.message);
    }
  }

  function downloadTargets() {
    var payload = {
      note: 'Taranacak adresler. GitHub\'ta site/firsat/data/targets.json olarak yükle.',
      updatedAt: new Date().toISOString(),
      targets: state.streamers.map(function (streamer) { return streamer.username; })
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'targets.json';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  async function importPool() {
    try {
      var response = await fetch(poolUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      var list = Array.isArray(data) ? data : data.targets || [];
      var raw = list.map(function (item) {
        return typeof item === 'string' ? item : (item && item.username) || '';
      }).join('\n');
      var result = bulkAddUsers(raw, '');
      $('addStatus').textContent = result.added
        ? 'Taranan havuzdan ' + result.added + ' yayıncı eklendi.'
        : 'Havuzdaki herkes zaten listede (' + result.skipped + ').';
    } catch (error) {
      $('addStatus').textContent = 'Havuz okunamadı: ' + error.message;
    }
  }

  function isExpired(event) {
    return event.kind === 'letter' && event.expiresAt && event.expiresAt <= Date.now();
  }

  function pendingEvents() {
    return state.events.filter(function (event) {
      return event.status === 'pending' && !isExpired(event) && Number(event.coins) >= 1;
    });
  }

  // ---------- Akıllı puanlama ----------
  // Fırsatı aciliyet, jeton, jeton/kişi ve tazelik bileşenleriyle 0-100 arasında puanlar.
  // Bilinmeyen alan uydurulmaz; o bileşen 0 sayılır.

  function remainingSeconds(event) {
    var now = Date.now();
    if (event.kind === 'letter') {
      return Number(event.expiresAt) > 0 ? Math.max(0, (Number(event.expiresAt) - now) / 1000) : null;
    }
    if (Number(event.durationSec) > 0 && Number(event.availableAt) > 0) {
      return Math.max(0, (Number(event.availableAt) - now) / 1000);
    }
    return null;
  }

  function opportunityScore(event) {
    var coins = Number(event.coins) || 0;
    var shared = Number(event.shared) || 0;
    var total = Number(event.durationSec) || 0;
    var left = remainingSeconds(event);
    var parts = { urgency: 0, coins: 0, yield: 0, freshness: 0 };

    if (left !== null) {
      var ratio = total > 0 ? Math.min(1, left / total) : Math.min(1, left / 600);
      parts.urgency = 40 * (1 - ratio);
    }
    parts.coins = 30 * Math.min(1, coins / 1000);
    parts.yield = 20 * Math.min(1, (coins / Math.max(1, shared)) / 100);
    var ageSec = Math.max(0, (Date.now() - (Number(event.createdAt) || Date.now())) / 1000);
    parts.freshness = 10 * (1 - Math.min(1, ageSec / 3600));

    var score = Math.max(0, Math.min(100, Math.round(
      parts.urgency + parts.coins + parts.yield + parts.freshness
    )));

    var best = Math.max(parts.urgency, parts.coins, parts.yield, parts.freshness);
    var reason = 'dengeli';
    if (best === parts.urgency && parts.urgency > 0) reason = 'süre kritik';
    else if (best === parts.yield && parts.yield > 0) reason = 'jeton/kişi yüksek';
    else if (best === parts.coins) reason = 'yüksek jeton';
    else if (best === parts.freshness) reason = 'yeni fırsat';

    return { score: score, reason: reason, left: left };
  }

  function sortEvents(list) {
    return list.slice().sort(function (a, b) {
      if (oppSort === 'new') return b.createdAt - a.createdAt;
      if (oppSort === 'streamer') return a.username.localeCompare(b.username, 'tr');
      if (oppSort === 'score') {
        var sa = opportunityScore(a);
        var sb = opportunityScore(b);
        if (sb.score !== sa.score) return sb.score - sa.score;
        var la = sa.left === null ? Number.MAX_SAFE_INTEGER : sa.left;
        var lb = sb.left === null ? Number.MAX_SAFE_INTEGER : sb.left;
        if (la !== lb) return la - lb;
        var ca = Number(a.coins) || 0;
        var cb = Number(b.coins) || 0;
        if (cb !== ca) return cb - ca;
        return b.createdAt - a.createdAt;
      }
      if (oppSort === 'expiry') {
        var now = Date.now();
        var deadline = function (event) {
          if (event.kind === 'letter') return event.expiresAt || now;
          return event.availableAt > now ? event.availableAt : Number.MAX_SAFE_INTEGER;
        };
        return deadline(a) - deadline(b);
      }
      var aLetter = a.kind === 'letter';
      var bLetter = b.kind === 'letter';
      if (aLetter !== bLetter) return aLetter ? -1 : 1;
      return (Number(b.coins) || 0) - (Number(a.coins) || 0);
    });
  }

  // ---------- İstatistikler ----------

  function renderStats() {
    var pending = pendingEvents();
    var collected = state.events.filter(function (event) { return event.status === 'collected'; });
    var recentLive = state.streamers.filter(function (streamer) {
      return Date.now() - (Number(streamer.lastLiveAt) || 0) < daysMs(state.settings.inactiveDays);
    });

    $('statStreams').textContent = state.streamers.length;
    $('statLive').textContent = recentLive.length;
    $('statPendingCoins').textContent = fmt(pending.reduce(function (sum, event) { return sum + Number(event.coins); }, 0));
    $('statCollected').textContent = fmt(collected.reduce(function (sum, event) { return sum + Number(event.coins); }, 0));
    $('navOppCount').textContent = pending.length;
    $('opportunityCount').textContent = pending.length;
    $('pendingCoinsBig').textContent = fmt(pending.reduce(function (sum, event) { return sum + Number(event.coins); }, 0)) + ' jeton';
    $('streamerCount').textContent = state.streamers.length;
  }

  // ---------- Yayın tablosu ----------

  function sortValue(streamer) {
    var metrics = streamerMetrics(streamer);
    switch (sortKey) {
      case 'live': return metrics.live ? 1 : 0;
      case 'duration': return streamerDuration(streamer);
      case 'chest': return metrics.chest;
      case 'letter': return metrics.letter;
      case 'portal': return metrics.portal;
      case 'coins': return metrics.coins;
      case 'collected': return metrics.collected;
      case 'lastSeen': return metrics.lastSeen;
      default: return streamer.username;
    }
  }

  function renderStreamers() {
    var rows = $('streamerRows');
    $('streamerEmpty').classList.toggle('hidden', state.streamers.length > 0);

    var list = state.streamers.slice().sort(function (a, b) {
      var va = sortValue(a);
      var vb = sortValue(b);
      if (typeof va === 'string') return va.localeCompare(vb, 'tr') * sortDir;
      return (va - vb) * sortDir;
    });

    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      var active = th.getAttribute('data-sort') === sortKey;
      th.classList.toggle('sorted', active);
      th.setAttribute('data-dir', active ? (sortDir > 0 ? 'asc' : 'desc') : '');
    });

    rows.innerHTML = list.map(function (streamer) {
      var metrics = streamerMetrics(streamer);
      var scannedOff = streamer.scanCheckedAt && !streamer.scanLive && !metrics.live;
      var missing = scannedOff && /not_found/i.test(streamer.scanReason || '');
      var liveChip = metrics.live
        ? '<button class="chip chip-green" data-toggle-live="' + streamer.id + '" title="' + esc(streamer.liveTitle || '') + '">● Canlı' + (streamer.scanLive ? ' · tarama' : '') + '</button>'
        : missing
          ? '<span class="chip chip-danger" title="TikTok bu kullanıcı adını bulamadı; adresi düzelt">⚠ Hesap yok</span>'
          : scannedOff
            ? '<span class="chip" title="Tarama bu hesabı canlı bulmadı">○ Yayında değil</span>'
            : '<button class="chip" data-toggle-live="' + streamer.id + '">Canlı yap</button>';
      var liveNote = streamer.scanLive
        ? '<div class="text-[10px] text-yellow-50/40 truncate max-w-[180px]">' + esc(streamer.liveTitle || 'yayında') + (streamer.viewers ? ' · ' + fmt(streamer.viewers) + ' kişi' : '') + '</div>'
        : '';

      return [
        '<tr>',
        '  <td class="min-w-[170px]">',
        '    <a href="' + liveUrl(streamer.username) + '" target="_blank" rel="noopener" class="font-bold text-yellow-100 hover:text-yellow-300">@' + esc(streamer.username) + '</a>',
        '    <div class="text-[10px] text-yellow-50/40">' + (streamer.country ? flag(streamer.country) + ' ' + esc(countryName(streamer.country)) : '') + '</div>',
        '    ' + liveNote,
        '  </td>',
        '  <td>' + liveChip + '</td>',
        '  <td class="font-mono text-xs" data-streamer-timer="' + streamer.id + '">' + clock(streamerDuration(streamer)) + '</td>',
        '  <td class="text-amber-300">' + metrics.chest + '</td>',
        '  <td class="text-pink-300">' + metrics.letter + '</td>',
        '  <td class="text-purple-300">' + metrics.portal + '</td>',
        '  <td class="font-bold text-amber-400">' + fmt(metrics.coins) + '</td>',
        '  <td><span class="text-green-300 font-bold">' + fmt(metrics.collected) + '</span> <span class="text-[10px] text-yellow-50/40">(' + metrics.collectedCount + ')</span></td>',
        '  <td class="text-[11px] text-yellow-50/50 whitespace-nowrap">' + ago(metrics.lastSeen) + '</td>',
        '  <td><div class="flex flex-wrap gap-1 justify-end">',
        '    <button class="chip chip-amber" data-add-event="' + streamer.id + '" data-kind="chest">+ Sandık</button>',
        '    <button class="chip chip-pink" data-add-event="' + streamer.id + '" data-kind="letter">+ Zarf</button>',
        '    <button class="chip chip-purple" data-add-event="' + streamer.id + '" data-kind="portal">+ Portal</button>',
        '    <button class="chip" data-qr="' + esc(streamer.username) + '">QR</button>',
        '    <button class="chip chip-danger" data-remove-streamer="' + streamer.id + '">×</button>',
        '  </div></td>',
        '</tr>'
      ].join('');
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  // ---------- Fırsatlar ----------

  function renderOpportunities() {
    var container = $('opportunityList');
    var pending = sortEvents(pendingEvents());

    if (pending.length === 0) {
      container.innerHTML = '<div class="empty-state md:col-span-2 xl:col-span-3">Bekleyen jeton yok. Yayında sandık veya zarf düştüğünde burada belirir.</div>';
      return;
    }

    container.innerHTML = pending.map(function (event) {
      var meta = KINDS[event.kind] || KINDS.chest;
      var scored = opportunityScore(event);
      var urgent = false;
      var timeText = '';

      if (event.kind === 'letter' && Number(event.expiresAt) > 0) {
        var remaining = Math.max(0, Math.round((Number(event.expiresAt) - Date.now()) / 1000));
        urgent = remaining <= 60;
        timeText = 'jeton geri dönüyor: ' + clock(remaining);
      } else if (event.kind === 'letter') {
        timeText = event.auto ? 'tarayıcı yakaladı · jeton dağıtıldı' : 'hemen açıldı · kaybolmaz';
      } else if (Number(event.durationSec) > 0) {
        var toOpen = Math.max(0, Math.round(((event.availableAt || Date.now()) - Date.now()) / 1000));
        timeText = toOpen > 0 ? 'açılışa ' + clock(toOpen) : 'açıldı · süre doldu, kaybolmaz';
      } else {
        timeText = 'hemen açıldı · kaybolmaz';
      }

      var shared = Number(event.shared) || 0;

      return [
        '<div class="opp-card ' + (urgent ? 'opp-urgent' : '') + '">',
        '  <div class="flex items-center justify-between mb-2">',
        '    <span class="flex items-center gap-1"><span class="kind-badge ' + meta.cls + '">' + meta.icon + ' ' + meta.label + '</span>' + (event.auto ? '<span class="kind-badge kind-live">CANLI</span>' : '') + '</span>',
        '    <span class="font-black text-amber-400">' + fmt(event.coins) + ' <span class="text-[10px] font-normal text-yellow-50/40">jeton</span></span>',
        '  </div>',
        '  <div class="text-[10px] mb-1"><span class="chip !py-0 !text-[10px]" title="aciliyet + jeton + jeton/kişi + tazelik">Puan ' + scored.score + ' · ' + esc(scored.reason) + '</span></div>',
        '  <a href="' + liveUrl(event.username) + '" target="_blank" rel="noopener" class="font-semibold text-yellow-100 hover:text-yellow-300 truncate block">@' + esc(event.username) + '</a>',
        '  <div class="text-[10px] text-yellow-50/40">' + (event.country ? flag(event.country) + ' ' + esc(countryName(event.country)) + ' · ' : '') + new Date(event.createdAt).toLocaleTimeString('tr-TR') + (shared > 1 ? ' · ' + shared + ' kişiye' : '') + (event.giftName ? ' · ' + esc(event.giftName) : '') + '</div>',
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

  // ---------- Yayıncı işlemleri ----------

  function bulkAddUsers(raw, countryCode) {
    var seen = {};
    state.streamers.forEach(function (streamer) { seen[streamer.username] = true; });

    var lines = String(raw || '').split(/\r?\n/);
    var added = [];
    var skipped = 0;

    lines.forEach(function (line) {
      var username = cleanUsername(line);
      if (!username || username.length > 40) return;
      if (seen[username]) { skipped += 1; return; }
      seen[username] = true;
      added.push({
        id: uid('st'),
        username: username,
        country: countryCode || '',
        startedAt: null,
        accumulatedMs: 0,
        createdAt: Date.now(),
        lastLiveAt: null
      });
    });

    if (added.length === 0) return { added: 0, skipped: skipped };
    Store.set({ streamers: added.concat(state.streamers) });
    state = Store.get();
    renderAll();
    return { added: added.length, skipped: skipped };
  }

  async function verifyAccount(username) {
    if (verified[username]) return verified[username];
    try {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 6000);
      var response = await fetch('https://www.tiktok.com/oembed?url=' +
        encodeURIComponent('https://www.tiktok.com/@' + username), { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        verified[username] = { ok: false, note: 'TikTok bu adı doğrulamadı (yine de eklendi).' };
      } else {
        var data = await response.json();
        verified[username] = { ok: true, note: '✓ ' + (data.author_name || '@' + username) + ' doğrulandı.' };
      }
    } catch (error) {
      verified[username] = { ok: false, note: 'Doğrulama yapılamadı (çevrimdışı olabilir); kayıt eklendi.' };
    }
    return verified[username];
  }

  async function addStreamer() {
    var username = cleanUsername($('streamerName').value);
    if (!username) { $('streamerName').focus(); return; }
    if (state.streamers.some(function (s) { return s.username === username; })) {
      $('addStatus').textContent = '@' + username + ' zaten listede.';
      $('streamerName').value = '';
      return;
    }

    var result = bulkAddUsers(username, $('streamerCountry').value);
    $('streamerName').value = '';
    $('addStatus').textContent = result.added ? 'Eklendi: @' + username + ' · doğrulanıyor…' : '@' + username + ' eklenemedi.';

    if (result.added) {
      var check = await verifyAccount(username);
      $('addStatus').textContent = check.note;
    }
  }

  function toggleLive(id) {
    var streamers = state.streamers.map(function (streamer) {
      if (streamer.id !== id) return streamer;
      var copy = Object.assign({}, streamer);
      if (copy.startedAt) {
        copy.accumulatedMs = (Number(copy.accumulatedMs) || 0) + (Date.now() - new Date(copy.startedAt).getTime());
        copy.startedAt = null;
        copy.lastLiveAt = Date.now();
      } else {
        copy.startedAt = new Date().toISOString();
        copy.lastLiveAt = Date.now();
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
    if (!confirm('@' + streamer.username + ' ve olayları listeden kaldırılsın mı?')) return;

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
    $('eventDuration').value = eventTarget.kind === 'letter' ? (state.settings.letterTtlSec || 180) : 0;
    $('eventShared').value = '';
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
    $('eventSharedWrap').classList.toggle('hidden', eventTarget.kind === 'letter');
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
      shared: Math.max(1, Number($('eventShared').value) || 1),
      durationSec: seconds,
      createdAt: now,
      availableAt: now + seconds * 1000,
      expiresAt: kind === 'letter' ? now + seconds * 1000 : null,
      status: 'pending',
      collectedAt: null
    };

    Store.set({
      events: [event].concat(state.events).slice(0, 3000),
      streamers: state.streamers.map(function (item) {
        return item.id === streamer.id ? Object.assign({}, item, { lastLiveAt: now }) : item;
      })
    });
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
      return (account.username + ' ' + (account.label || '')).toLowerCase().indexOf(searchTerm) >= 0;
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

    container.innerHTML = accounts.map(function (account) {
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
      return Object.assign({}, account, { status: order[(order.indexOf(account.status) + 1) % order.length] });
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
    $('agCountry').innerHTML = optionsHtml(true);

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
    $('inactiveDays').value = state.settings.inactiveDays;
    $('notifyToggle').checked = Boolean(state.settings.notify);

    var info = Store.storageInfo();
    $('storageInfo').textContent = info.engine + ' · ' + (info.bytes / 1024).toFixed(1) + ' KB · ' +
      info.streamers + ' yayıncı, ' + info.events + ' olay, ' + info.accounts + ' hesap, ' + info.agencies + ' ajans' +
      (info.updatedAt ? ' · son kayıt ' + new Date(info.updatedAt).toLocaleString('tr-TR') : '');
  }

  function saveSettings() {
    Store.set({
      settings: Object.assign({}, state.settings, {
        letterTtlSec: Math.max(10, Number($('letterTtl').value) || 180),
        inactiveDays: Math.max(1, Number($('inactiveDays').value) || 7),
        notify: $('notifyToggle').checked
      })
    });
    state = Store.get();
    renderSettings();
    renderAll();
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

  // ---------- 7 gün kuralı ----------

  function pruneInactive() {
    var limit = daysMs(state.settings.inactiveDays);
    var now = Date.now();
    var removed = state.streamers.filter(function (streamer) {
      if (streamer.startedAt) return false;
      var last = Number(streamer.lastLiveAt) || Number(streamer.createdAt);
      return last && now - last > limit;
    });

    if (removed.length === 0) return;

    var ids = {};
    removed.forEach(function (streamer) { ids[streamer.id] = true; });

    Store.set({
      streamers: state.streamers.filter(function (streamer) { return !ids[streamer.id]; }),
      events: state.events.filter(function (event) { return !ids[event.streamerId]; })
    });
    state = Store.get();

    $('addStatus').textContent = removed.length + ' yayıncı ' + state.settings.inactiveDays +
      ' gündür canlı görülmediği için listeden düşürüldü.';
    renderAll();
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
      var duration = Number(element.getAttribute('data-duration')) || 0;
      var remaining = Math.max(0, Math.round((target - Date.now()) / 1000));
      if (kind === 'letter') {
        element.textContent = remaining > 0 ? 'jeton geri dönüyor: ' + clock(remaining) : 'süre doldu · jeton yayıncıya döndü';
      } else if (remaining > 0) {
        element.textContent = 'açılışa ' + clock(remaining);
      } else {
        element.textContent = duration > 0 ? 'açıldı · süre doldu, kaybolmaz' : 'hemen açıldı · kaybolmaz';
      }
    });

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

  // ---------- Yardımcılar ----------

  function optionsHtml(includeEmpty) {
    var keys = Object.keys(COUNTRIES).sort(function (a, b) {
      return countryName(a).localeCompare(countryName(b), 'tr');
    });
    return (includeEmpty ? '<option value="">Ülke (opsiyonel)</option>' : '') + keys.map(function (code) {
      return '<option value="' + code + '">' + flag(code) + ' ' + countryName(code) + '</option>';
    }).join('');
  }

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

  // ---------- Bağlama ----------

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

    if ($('poolDownload')) $('poolDownload').addEventListener('click', downloadTargets);
    if ($('poolImport')) $('poolImport').addEventListener('click', importPool);

    $('bulkBtn').addEventListener('click', function () {
      $('bulkResult').textContent = '';
      $('bulkCountry').innerHTML = optionsHtml(true);
      openModal('bulkModal');
      setTimeout(function () { $('bulkText').focus(); }, 50);
    });
    $('bulkSubmit').addEventListener('click', function () {
      var result = bulkAddUsers($('bulkText').value, $('bulkCountry').value);
      $('bulkResult').textContent = result.added + ' yayıncı eklendi' + (result.skipped ? ' · ' + result.skipped + ' zaten listedeydi' : '') + '.';
      $('bulkText').value = '';
      $('addStatus').textContent = result.added ? result.added + ' yayıncı toplu eklendi.' : 'Yeni yayıncı bulunamadı.';
    });

    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
        renderStreamers();
      });
    });

    $('streamerRows').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;

      if (target.dataset.toggleLive) return toggleLive(target.dataset.toggleLive);
      if (target.dataset.addEvent) return openEventModal(target.dataset.addEvent, target.dataset.kind);
      if (target.dataset.qr) return openQr(target.dataset.qr);
      if (target.dataset.removeStreamer) return removeStreamer(target.dataset.removeStreamer);
    });

    $('oppSort').addEventListener('change', function () {
      oppSort = $('oppSort').value;
      renderOpportunities();
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
      $('eventDuration').value = eventTarget.kind === 'letter' ? (state.settings.letterTtlSec || 180) : Number($('eventDuration').value) || 0;
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

  async function boot() {
    await Store.ready();
    state = Store.get();

    Store.subscribe(function (next) { state = next; });

    $('streamerCountry').innerHTML = optionsHtml(true);
    bind();
    renderAll();
    switchTab('hunt');
    pruneInactive();
    refreshScan();
    setInterval(tick, 1000);
    setInterval(refreshScan, 30000);
    setInterval(pruneInactive, 600000);
    // Sıralama zamanla değişir (kalan süre azalır): liste kendiliğinden tazelenir.
    setInterval(function () {
      var opp = $('view-opportunities');
      var streams = $('view-hunt');
      if (opp && !opp.classList.contains('hidden')) renderOpportunities();
      if (streams && !streams.classList.contains('hidden')) renderStreamers();
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
