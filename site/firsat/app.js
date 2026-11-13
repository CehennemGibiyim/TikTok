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
  // Sıralama seçimi de sayfa yenilenince korunur.
  var sortKey = String(localStorage.getItem('tiktok-streamer-sort') || 'name');
  var sortDir = Number(localStorage.getItem('tiktok-streamer-sort-dir')) === -1 ? -1 : 1;
  var oppSort = 'score';
  var searchTerm = '';
  // Arama metni de sayfa yenilenince korunur.
  var streamerSearch = String(localStorage.getItem('tiktok-streamer-search') || '');
  // Ülke rozetinden gelen filtre (boş = tüm ülkeler). Sayfa yenilenince
  // son seçili ülke hatırlanır.
  var countryFilter = String(localStorage.getItem('tiktok-country-filter') || '').toUpperCase();
  // Liste binlerce yayıncıya çıkabiliyor: tabloda bu kadar satır çizilir,
  // kalanı aramayla bulunur (hepsi kayıtlı ve taranıyor).
  var STREAMER_ROW_LIMIT = 400;
  var eventTarget = { streamerId: null, kind: 'chest' };
  var notified = {};
  var audioCtx = null;
  var verified = {};
  var scanInfo = null;
  var metricsInfo = null;
  // GitHub Pages, veri commit'lerini saatlerce geciktiriyor (build kotası).
  // Ham dosya her zaman güncel ve CORS açık: önce oradan okunur, olmazsa
  // Pages kopyasına düşülür.
  var RAW_DATA = 'https://raw.githubusercontent.com/CehennemGibiyim/TikTok/main/site/firsat/data/';
  var scanUrl = RAW_DATA + 'live.json';
  var scanFallback = 'data/live.json';
  var poolUrl = RAW_DATA + 'targets.json';
  var poolFallback = 'data/targets.json';
  var boxesUrl = RAW_DATA + 'boxes.json';
  // Ölçüm dosyası: scripts/quota-report.mjs --json=... çıktısı (panel yalnız sunar).
  var metricsUrl = RAW_DATA + 'metrics.json';
  var boxesFallback = 'data/boxes.json';
  // Anlık kutu yayını: tarayıcı bu konuya yazar, panel SSE ile dinler.
  // Git commit/CDN gecikmesi (dakikalar) sandık penceresini kaçırıyordu.
  var BOX_TOPIC = 'cehennem-tiktok-firsat-7f3a91';
  // Yayın anahtarı: konu herkese açık olduğu için yalnızca bu anahtarı taşıyan
  // mesajlar kabul edilir (tarayıcıdaki --ntfy-key / NTFY_KEY ile aynı).
  var BOX_KEY = 'XQMPSwldDoS26gnVIV1ClCyb';
  // Halka açık canlı kanal listesi (girişsiz, tarayıcıdan okunabilir).
  var discoveryUrl = 'https://api.tik.tools/api/live/top-channels';
  // Bulunan yayın, tarama doğrulayana kadar bu süre boyunca "canlı" sayılır.
  var discoverLiveMs = 30 * 60 * 1000;

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

  // ---------- Telefonda uygulamayı açma ----------
  // Web adresi her cihazda açılır ama tarayıcıda açılır. Uygulamada açmak için
  // TikTok'un kendi bağlantı şemaları kullanılır:
  //   Android: snssdk1128://live?room_id=…   (paket: com.zhiliaoapp.musically)
  //   iOS    : snssdk1233://live?room_id=…
  // Oda kimliği (room_id) taramadan gelir; yoksa uydurulmaz, web açılır.

  function deviceKind() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'ios';
    return 'desktop';
  }

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

  // Telefonda: uygulama kuruluysa doğrudan yayın açılır, değilse web'e düşer.
  // Masaüstünde: normal web yayını açılır.
  function openInApp(username, roomId) {
    var web = liveUrl(username);
    var id = roomIdOf(roomId);
    var platform = deviceKind();
    if (!id) {
      window.open(web, '_blank', 'noopener');
      return 'no-room-id';
    }
    if (platform === 'android') {
      location.href = androidIntentUrl(id, web);
      return 'android';
    }
    if (platform === 'ios') {
      var startedAt = Date.now();
      location.href = appSchemeUrl(id, 'ios');
      // Uygulama açılmadıysa (sayfa hâlâ görünür) web'e düş.
      setTimeout(function () {
        if (document.visibilityState === 'visible' && Date.now() - startedAt < 2500) {
          window.open(web, '_blank', 'noopener');
        }
      }, 1500);
      return 'ios';
    }
    window.open(web, '_blank', 'noopener');
    return 'desktop';
  }

  function roomIdForStreamer(streamerId) {
    var streamer = state.streamers.find(function (item) { return item.id === streamerId; });
    return streamer ? String(streamer.roomId || '') : '';
  }

  // Tarayıcı testinde bağlantı şemasını görebilmek için küçük bir pencere.
  window.JetonPanelLinks = {
    deviceKind: deviceKind,
    appSchemeUrl: appSchemeUrl,
    androidIntentUrl: androidIntentUrl
  };

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
    if (tab === 'metrics') refreshMetrics();
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

  // "Canlı" etiketi tazelik ister: tarama yayında olduğunu 15 dakikadan uzun
  // süredir doğrulayamadıysa CANLI yazılmaz (api-live bulut IP'lerinde boş
  // döndüğü için eski kayıtlar yayında sanılıyordu).
  var LIVE_STALE_MS = 15 * 60 * 1000;

  function isLiveNow(streamer) {
    if (!streamer) return false;
    if (streamer.startedAt) return true;
    if (!streamer.scanLive) return false;
    return Date.now() - (Number(streamer.lastLiveAt) || 0) < LIVE_STALE_MS;
  }

  function streamerMetrics(streamer) {
    var events = eventsOf(streamer.id);
    var metrics = {
      chest: 0, letter: 0, portal: 0, coins: 0, collected: 0, collectedCount: 0,
      shared: 0,      lastSeen: Number(streamer.lastLiveAt) || 0,
      live: Boolean(streamer.startedAt) || isLiveNow(streamer)
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

  // Kutu kayıtlarını tek yerde birleştirir: tarama dosyası, hızlı kutu dosyası
  // ve anlık yayın aynı kuralları kullanır. Yayıncı panelde yoksa oluşturulur,
  // aynı kutu (scanId) iki kez yazılmaz, sandık/portal/zarf dışındaki tür atılır.
  function mergeBoxItems(items, streamers, events) {
    var byName = {};
    streamers.forEach(function (streamer) { byName[cleanUsername(streamer.username)] = streamer; });
    var known = {};
    events.forEach(function (event) { if (event.scanId) known[event.scanId] = true; });
    var fresh = [];

    (items || []).forEach(function (item) {
      if (!item || !item.id || known[item.id]) return;
      if (item.kind && ['chest', 'portal', 'letter'].indexOf(item.kind) === -1) return;
      var username = cleanUsername(item.username);
      if (!username) return;
      var owner = byName[username];
      if (!owner) {
        owner = {
          id: uid('st'),
          username: username,
          country: String(item.country || '').toUpperCase().slice(0, 2),
          createdAt: Date.now(),
          scanLive: true,
          scanCheckedAt: Date.now()
        };
        streamers.push(owner);
        byName[username] = owner;
      }
      // Kutu gönderen yayıncı listede kalır: "son kutu" zamanı da canlılık
      // sayılır, 7 gün kuralı bunu kutu yollayan yayıncıyı düşürmez.
      owner.lastBoxAt = Date.now();
      known[item.id] = true;
      events.unshift({
        id: uid('ev'),
        streamerId: owner.id,
        username: owner.username,
        country: owner.country || '',
        kind: item.kind === 'letter' ? 'letter' : (item.kind === 'portal' ? 'portal' : 'chest'),
        coins: Number(item.coins) || 0,
        durationSec: Number(item.durationSec) || 0,
        availableAt: Number(item.availableAt) || Number(item.t) || Date.now(),
        // TikTok'un bildirdiği gerçek açılış anı: süre bundan sayılır.
        unpackAt: Number(item.unpackAt) || 0,
        hasWindow: Boolean(item.hasWindow) || Number(item.unpackAt) > 0,
        expiresAt: 0,
        shared: Number(item.shared) || 0,
        status: 'pending',
        createdAt: Number(item.t) || Date.now(),
        scanId: item.id,
        auto: true,
        giftName: item.boxName || item.giftName || '',
        boxName: item.boxName || item.giftName || '',
        businessType: Number(item.businessType) || 0,
        boxType: item.boxType || '',
        senderName: item.senderName || item.sender || ''
      });
      fresh.push(username);
    });

    return { changed: fresh.length > 0, fresh: fresh };
  }

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
        // Canlı bilgisi tazelendikçe etiketin süresi de yenilenir.
        if (item.live) copy.lastLiveAt = Number(item.lastSeenLiveAt) || Date.now();
        if (item.title) copy.liveTitle = item.title;
        if (item.viewers) copy.viewers = item.viewers;
        if (item.roomId) copy.roomId = String(item.roomId);
        copy.boxes = Number(item.boxes) || 0;
        if (item.lastBoxAt) copy.lastBoxAt = Number(item.lastBoxAt) || 0;
        // Kutu geçmişinden çıkan güvenilirlik skoru (tarayıcı hesaplar).
        // Skor yoksa alan silinir: panel "0" ile "bilinmiyor"u ayırır.
        if (item.score === null || item.score === undefined) delete copy.score;
        else copy.score = Number(item.score) || 0;
        if (item.avgCoins === null || item.avgCoins === undefined) delete copy.avgCoins;
        else copy.avgCoins = Number(item.avgCoins) || 0;
        copy.boxCount = Number(item.boxCount) || 0;

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

      // Yayında olmasa da taranan adres listeye eklenir: havuz büyüdükçe
      // liste de büyür, yayın açtığında tarama onu kendiliğinden yakalar.
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
        roomId: item.roomId ? String(item.roomId) : '',
        boxes: Number(item.boxes) || 0,
        lastBoxAt: Number(item.lastBoxAt) || 0,
        boxCount: Number(item.boxCount) || 0,
        score: item.score === null || item.score === undefined ? undefined : (Number(item.score) || 0),
        avgCoins: item.avgCoins === null || item.avgCoins === undefined ? undefined : (Number(item.avgCoins) || 0),
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
        // Panelden "Canlı yayınları bul" ile eklenenler tarama havuzunda yok;
        // bulundukları andan itibaren sınırlı süre canlı kalırlar.
        if (!inPool && streamer.source === 'discover' && Number(streamer.foundLiveAt) > 0 &&
            (Date.now() - Number(streamer.foundLiveAt)) < discoverLiveMs) return streamer;
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

    // Yeni tarama koşusu: bekleyen kutular SİLİNMEZ (her koşuda Fırsatlar
    // sıfırlanıyordu). Yalnızca 12 saatten eski otomatik kayıtlar düşer;
    // süresi dolanlar zaten "KONTROL ET"/bitti olarak ayrı işaretleniyor.
    var runId = Number((data.scanner && data.scanner.runId) || 0);
    var settings = Object.assign({}, state.settings || {});
    if (runId && Number(settings.scanRunId) !== runId) {
      var staleBefore = Date.now() - 12 * 3600000;
      var beforeClean = events.length;
      events = events.filter(function (event) {
        return !(event.auto && event.status === 'pending' &&
          Number(event.createdAt || 0) > 0 && Number(event.createdAt) < staleBefore);
      });
      settings.scanRunId = runId;
      if (events.length !== beforeClean) changed = true;
    }

    if (mergeBoxItems(data.events, streamers, events).changed) changed = true;

    if (changed) {
      Store.set({ streamers: streamers, events: events, settings: settings });
      state = Store.get();
    }
    return changed;
  }

  // Hızlı kutu kanalı: tarayıcı kutuları ayrı ve küçük bir dosyaya yazıp sık
  // commit ediyor; panel bunu 15 saniyede bir okur. Böylece sandık, 5 dakikalık
  // tarama commit'ini beklemeden Fırsatlar'a düşer (yakalama penceresi kısa).
  function applyBoxes(boxes) {
    if (!Array.isArray(boxes) || !boxes.length) return false;
    var streamers = state.streamers.slice();
    var events = state.events.slice();
    var merged = mergeBoxItems(boxes, streamers, events);
    if (!merged.changed) return false;
    Store.set({ streamers: streamers, events: events });
    state = Store.get();
    renderAll();
    notifyBoxes(merged.fresh);
    return true;
  }

  // Bildirim izni yoksa da kullanıcı fark etsin: kısa ses + ekranda vurgu.
  function notifyBoxes(usernames) {
    var unique = usernames.filter(function (name, index) {
      return usernames.indexOf(name) === index;
    });
    var text = 'Yeni kutu: ' + unique.slice(0, 3).map(function (name) { return '@' + name; }).join(', ');
    var granted = window.Notification && Notification.permission === 'granted';
    if (granted) {
      try { new Notification('Fırsatlar', { body: text }); } catch (error) { /* yok sayılır */ }
      return;
    }
    beep();
    flashBox(text);
  }

  // Ekranda kısa vurgu (banner + Fırsatlar sekmesinin sayacı).
  function flashBox(text) {
    var old = document.querySelector('.box-flash');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'box-flash';
    el.textContent = '📦 ' + text;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  // Bildirim izni: tarayıcı ancak kullanıcı hareketinden sonra izin verir.
  var notifyAsked = false;
  function ensureNotifyPermission() {
    if (notifyAsked) return;
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    notifyAsked = true;
    try {
      var result = Notification.requestPermission(function () { renderNotifyState(); });
      if (result && typeof result.then === 'function') result.then(renderNotifyState, function () {});
    } catch (error) { /* izin istenemedi */ }
  }

  // Panelin bir yerinde izin durumu görünsün (red edilmişse kullanıcı bilsin).
  function renderNotifyState() {
    var el = $('notifyState');
    if (!el || !('Notification' in window)) return;
    var stateText = { granted: 'açık', denied: 'kapalı (tarayıcıdan izin ver)', default: 'izin bekliyor' }[Notification.permission] || Notification.permission;
    el.textContent = 'Bildirim: ' + stateText;
  }

  // Saniyeler içinde gelen kutular (ntfy.sh SSE). Koparsa dosya yolu devrede.
  function startBoxStream() {
    if (typeof EventSource !== 'function') return;
    try {
      var source = new EventSource('https://ntfy.sh/' + BOX_TOPIC + '/sse');
      source.addEventListener('message', function (message) {
        try {
          var parsed = JSON.parse(message.data || '{}');
          if (parsed.event && parsed.event !== 'message') return;
          var box = parsed.message ? JSON.parse(parsed.message) : parsed;
          // Anahtarsız/yanlış anahtarlı mesaj sahte olabilir: yok sayılır.
          if (!box || box.key !== BOX_KEY) return;
          if (box.username && box.id) applyBoxes([box]);
        } catch (error) { /* bozuk mesaj yok sayılır */ }
      });
    } catch (error) { /* akış yoksa 15 sn'lik dosya okuması devrede */ }
  }

  async function refreshBoxes() {
    if (scanPaused) return;
    try {
      var data = await fetchScanData(boxesUrl);
      if (data && Array.isArray(data.boxes)) applyBoxes(data.boxes);
    } catch (error) {
      try {
        var backup = await fetchScanData(boxesFallback);
        if (backup && Array.isArray(backup.boxes)) applyBoxes(backup.boxes);
      } catch (backupError) { /* kutu dosyası yoksa sorun değil */ }
    }
  }

  function renderScanStatus(error) {
    renderSweepReport();
    renderSweepSummary();
    renderBoxDiag();
    renderProbeSummary();
    var el = $('scanStatus');
    if (!el) return;
    if (scanPaused) {
      el.innerHTML = '<span class="chip">⏸ Tarama durduruldu — başlatınca tazelenir</span>';
      return;
    }
    if (!scanInfo) {
      el.innerHTML = error
        ? 'Tarama verisi okunamadı (' + esc(error) + ').'
        : 'Tarama verisi yok — arka plan tarayıcısı henüz çalışmadı.';
      return;
    }
    var live = Number(scanInfo.liveCount) || 0;
    var countries = {};
    state.streamers.forEach(function (streamer) {
      if (streamer.scanLive && streamer.country) countries[streamer.country] = true;
    });
    var parts = [
      'Tarama: ' + ago(new Date(scanInfo.scannedAt || Date.now()).getTime()),
      live + ' canlı',
      (Number(scanInfo.targetCount) || 0) + ' adres',
      Object.keys(countries).length + ' ülke',
      (Number(scanInfo.watching) || 0) + '/' +
        (Number(scanInfo.budget) || Number(scanInfo.watching) || 0) + ' oda dinleniyor',
      (Number(scanInfo.freshLive) || 0) + ' yeni aday',
      'keşif %' + Math.round((Number(scanInfo.probeRatio) || 0) * 100)
    ];
    // Bağlantı teşhisi: "0 oda dinleniyor" görünüyorsa sebebi burada yazsın.
    var stats = scanInfo.connectStats || {};
    var attempts = Number(stats.attempts) || 0;
    var okCount = Number(stats.ok) || 0;
    var failedCount = Number(stats.failed) || 0;
    var cooldown = Number(scanInfo.cooldownLeftSec) || 0;
    var watching = Number(scanInfo.watching) || 0;
    var errors = Array.isArray(stats.errors) ? stats.errors : [];
    var hints = [];
    if (stats.dayLimited) {
      hints.push('⛔ TikTok günlük bağlantı sınırı doldu — masaüstü uygulamasında kendi IP\'nde taranır');
    }
    if (watching === 0 && live > 0) {
      hints.push(cooldown > 0
        ? '⏳ hız sınırı soğuması ' + clock(cooldown) + ' — yeni bağlantı kurulmuyor'
        : '⚠ canlı var ama dinlenen oda yok');
    }
    if (attempts > 0) {
      hints.push('bağlantı ' + okCount + '/' + attempts + ' başarılı' +
        (failedCount ? ' · ' + failedCount + ' hata' : ''));
    }
    var budget = scanInfo.connectBudget;
    if (budget && Number(budget.limit) > 0) {
      var usedHour = Number(budget.used) || 0;
      var limitHour = Number(budget.limit) || 0;
      var nextAt = Number(budget.nextAttemptAt) || 0;
      var budgetNow = Date.now();
      var budgetText = '📊 bu saat ' + usedHour + '/' + limitHour + ' bağlantı';
      // Öğrenilen limit devredeyse sebebi görünsün: "limit 25 → öğrenilen 23".
      var learnedHour = Number(budget.learned) || 0;
      var configuredHour = Number(budget.configured) || limitHour;
      if (learnedHour > 0 && learnedHour < configuredHour) {
        budgetText += ' · limit ' + configuredHour + ' → öğrenilen ' + learnedHour;
      }
      if (usedHour >= limitHour && nextAt > budgetNow) {
        budgetText += ' · bütçe dolu, sonraki deneme ' + clock((nextAt - budgetNow) / 1000);
      } else if (Number(budget.gapMs) > 5000) {
        budgetText += ' · aralık ' + Math.round(Number(budget.gapMs) / 1000) + ' sn';
      }
      hints.push(budgetText);
    }
    var guard = scanInfo.tuningGuard;
    if (guard) {
      hints.push('🛡 kota koruması: dakikada ' + guard.startsPerMin + ' bağlantı · ' +
        Math.round(guard.connectGapMs / 1000) + ' sn ara');
    }
    var unknownCount = Number(scanInfo.liveUnknownCount) || 0;
    if (unknownCount > 0) hints.push(unknownCount + ' oda doğrulanamadı');
    var offlineCount = Number(stats.offline) || 0;
    if (offlineCount > 0) hints.push(offlineCount + ' biten yayın atlandı');
    var withRoomId = Number(scanInfo.liveWithRoomId) || 0;
    if (live > 0) hints.push('oda kimliği ' + withRoomId + '/' + live);
    var lastError = scanInfo.lastConnectorError ||
      (errors.length ? errors[errors.length - 1].message : scanInfo.lastError);
    if (lastError) hints.push('son hata: ' + lastError);

    var detail = errors.map(function (item) {
      var when = new Date(Number(item.at) || Date.now()).toLocaleTimeString('tr-TR',
        { hour: '2-digit', minute: '2-digit' });
      return when + ' · @' + (item.username || '?') + ' (' + (item.source || '?') + ') ' + (item.message || '');
    }).join('\n');

    var connLine = hints.length
      ? '<div class="w-full mt-1 text-[10px] ' +
        (watching === 0 && live > 0 ? 'text-amber-300' : 'text-yellow-50/40') + '"' +
        (detail ? ' title="' + esc(detail) + '"' : '') + '>' + esc(hints.join(' · ')) + '</div>'
      : '';

    el.innerHTML = '<span class="chip chip-green chip-status">● ' + esc(parts.join(' · ')) + '</span>' + connLine;
  }

  async function refreshScan() {
    if (scanPaused) { renderScanStatus(); return; }
    try {
      var data = await fetchScanData(scanUrl);
      scanInfo = Object.assign({ scannedAt: data.scannedAt }, data.scanner || {});
      if (applyScan(data)) renderAll();
      renderScanStatus();
    } catch (error) {
      // Ham dosya okunamazsa (ağ/CORS) Pages kopyası denenir.
      try {
        var backup = await fetchScanData(scanFallback);
        scanInfo = Object.assign({ scannedAt: backup.scannedAt }, backup.scanner || {});
        if (applyScan(backup)) renderAll();
        renderScanStatus();
      } catch (backupError) {
        renderScanStatus(error.message);
      }
    }
  }

  async function fetchScanData(url) {
    var response = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
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
      var data;
      try {
        data = await fetchScanData(poolUrl);
      } catch (rawError) {
        data = await fetchScanData(poolFallback);
      }
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

  // ---------- Canlı yayınları bul (sürekli keşif) ----------
  // "Canlı yayınları bul" başlatıldığında durdurulana kadar 60 saniyede bir
  // yayında olanları arar ve yalnızca yeni olanları listenin üstüne ekler.
  // Hiçbir kaydı silmez.

  var discoveryTimer = null;
  var discoveryAdded = 0;
  var discoveryRooms = 0;
  var discoveryRuns = 0;

  function discoveryIcon(active) {
    return active
      ? '<i data-lucide="square" class="w-4 h-4"></i> Bulmayı durdur'
      : '<i data-lucide="radar" class="w-4 h-4"></i> Canlı yayınları bul';
  }

  async function findLiveStreams() {
    var status = $('findStatus');
    try {
      // Yanıt gelmezse sonsuza kadar beklemesin.
      var controller = new AbortController();
      var guard = setTimeout(function () { controller.abort(); }, 8000);
      var response;
      try {
        response = await fetch(discoveryUrl + '?t=' + Date.now(), { cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(guard);
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      var channels = Array.isArray(data.channels) ? data.channels : [];

      // Aynı turda gelen oda kimlikleri: mevcut kayıtlara da yazılır ki
      // uygulamada açma bağlantısı taramayı beklemeden çalışsın.
      var channelRoom = {};
      channels.forEach(function (channel) {
        var name = cleanUsername(channel && channel.uniqueId);
        if (name && channel && channel.roomId && !channelRoom[name]) {
          channelRoom[name] = String(channel.roomId);
        }
      });

      var known = {};
      var streamers = state.streamers.map(function (streamer) {
        var name = cleanUsername(streamer.username);
        known[name] = true;
        if (channelRoom[name] && !streamer.roomId) {
          discoveryRooms += 1;
          return Object.assign({}, streamer, { roomId: channelRoom[name] });
        }
        return streamer;
      });

      var now = Date.now();
      var fresh = [];
      channels.forEach(function (channel) {
        var username = cleanUsername(channel && channel.uniqueId);
        if (!username || known[username]) return;
        known[username] = true;
        fresh.push({
          id: uid('st'),
          username: username,
          country: String((channel && channel.region) || '').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase(),
          startedAt: null,
          accumulatedMs: 0,
          createdAt: now,
          lastLiveAt: now,
          scanLive: true,
          source: 'discover',
          foundLiveAt: now,
          roomId: String((channel && channel.roomId) || ''),
          viewers: Number((channel && channel.viewerCount) || 0) || 0,
          liveTitle: String((channel && channel.displayName) || '')
        });
      });

      if (fresh.length || streamers.some(function (streamer, index) {
        return streamer !== state.streamers[index];
      })) {
        Store.set({ streamers: fresh.concat(streamers) });
        state = Store.get();
        renderAll();
      }

      discoveryAdded += fresh.length;
      discoveryRuns += 1;
      status.textContent = 'Aranıyor… +' + discoveryAdded + ' yeni · ' + discoveryRooms +
        ' oda kimliği · ' + discoveryRuns + ' tur · son ' +
        new Date().toLocaleTimeString('tr-TR') + ' · ' + channels.length + ' kanal';
    } catch (error) {
      status.textContent = 'Canlı yayınlar alınamadı: ' + error.message;
    }
  }

  function stopDiscovery(label) {
    if (discoveryTimer) clearInterval(discoveryTimer);
    discoveryTimer = null;
    var button = $('findLive');
    button.classList.remove('btn-danger');
    button.classList.add('btn-primary');
    button.innerHTML = discoveryIcon(false);
    if (label !== false) $('findStatus').textContent = label || ('Durduruldu · toplam +' + discoveryAdded + ' yeni');
    if (window.lucide) lucide.createIcons();
  }

  function startDiscovery() {
    stopDiscovery(false);
    discoveryAdded = 0;
    discoveryRuns = 0;
    var button = $('findLive');
    button.classList.remove('btn-primary');
    button.classList.add('btn-danger');
    button.innerHTML = discoveryIcon(true);
    $('findStatus').textContent = 'Canlı yayınlar aranıyor…';
    if (window.lucide) lucide.createIcons();
    findLiveStreams();
    discoveryTimer = setInterval(findLiveStreams, 60000);
  }

  function toggleDiscovery() {
    if (discoveryTimer) stopDiscovery();
    else startDiscovery();
  }

  // ---------- Taramayı başlat / durdur ----------
  // Durdurulduğunda panel yeni tarama verisi çekmez; başlatınca hemen tazeler.

  var scanPaused = localStorage.getItem('tiktok-scan-paused') === '1';

  function renderScanToggle() {
    var button = $('scanToggle');
    if (!button) return;
    button.innerHTML = scanPaused
      ? '<i data-lucide="play" class="w-4 h-4"></i> Taramayı başlat'
      : '<i data-lucide="pause" class="w-4 h-4"></i> Taramayı durdur';
    button.classList.toggle('btn-primary', scanPaused);
    button.classList.toggle('btn-ghost', !scanPaused);
    if (window.lucide) lucide.createIcons();
  }

  function toggleScan() {
    scanPaused = !scanPaused;
    localStorage.setItem('tiktok-scan-paused', scanPaused ? '1' : '0');
    // "Canlı yayınları bul" taramadan bağımsızdır: duraklatma onu durdurmaz.
    renderScanToggle();
    renderScanStatus();
    if (!scanPaused) refreshScan();
  }

  // Fırsatın kapanış anı: önce TikTok'un bildirdiği açılış anı (unpackAt),
  // yoksa zarfın bitişi. Süre hiç bildirilmemiş sandıkta kök paneldeki gibi
  // 3 dk (180 sn) tahmini pencere kullanılır (uydurma değil, "tahmini" etiketiyle).
  function eventEndAt(event) {
    var end = Number(event.unpackAt) || Number(event.expiresAt) || 0;
    if (end > 0) return end;
    if (Number(event.availableAt) > 0 && (event.hasWindow || Number(event.durationSec) > 0)) {
      return Number(event.availableAt);
    }
    if (event.kind === 'chest') {
      var created = Number(event.createdAt) || Number(event.t) || 0;
      if (created > 0) return created + 3 * 60 * 1000;
    }
    return 0;
  }

  // Süresi dolan fırsat kendiliğinden düşer; "Kaçtı"ya basmak gerekmez.
  // Sandık pencere bitince hemen silinmez, kısa süre "beklemede" kalır.
  // Kök paneldeki davranış: sandık süresi dolunca 3 dk "KONTROL ET!" olarak kalır.
  var CHEST_GRACE_MS = 3 * 60 * 1000;
  var UNKNOWN_WINDOW_MS = 30 * 60 * 1000;
  // Sandık pencere bittikten sonra da sonsuza kadar kalmaz: kullanıcı toplayabilsin
  // diye bir süre "KONTROL ET!" olarak durur, sonra düşer. Süre Ayarlar'daki
  // "chestKeepMin" değerinden gelir (varsayılan 15 dakika).
  function chestKeepMs() {
    var minutes = Number(state.settings && state.settings.chestKeepMin);
    if (!isFinite(minutes) || minutes < 0) minutes = 15;
    return minutes * 60 * 1000;
  }

  // Zarf ve portalda da pencere bitince kutu hemen düşmez: kullanıcı
  // toplayabilsin diye pay bırakılır, sonra listeden çıkar.
  var COLLECT_GRACE_MS = 15 * 60 * 1000;

  function isExpired(event) {
    var now = Date.now();
    var end = eventEndAt(event);
    if (!end) {
      var created = Number(event.createdAt) || Number(event.t) || 0;
      return created > 0 && now - created > UNKNOWN_WINDOW_MS;
    }
    // Sandık Ayarlar'daki süre kadar durur; portal/zarf sabit payla düşer.
    return now >= end + (event.kind === 'chest' ? chestKeepMs() : COLLECT_GRACE_MS);
  }

  // Fırsatlar yalnızca toplanabilir kazanç olaylarını gösterir:
  // sandık, portal, zarf. Yayıncıya atılan sıradan hediyeler buraya girmez.
  function isOpportunity(event) {
    return event.kind === 'chest' || event.kind === 'portal' || event.kind === 'letter';
  }

  function pendingEvents() {
    return state.events.filter(function (event) {
      // Jeton alanı boş gelen kutu (süper fan kutusu) da listede görünür:
      // "jeton bilinmiyor" yazılır, uydurma değer gösterilmez.
      return isOpportunity(event) && event.status === 'pending' && !isExpired(event);
    });
  }

  // Eski sürümlerde Fırsatlar'a yayıncıya atılan hediyeler de yazılıyordu.
  // Bir kez temizlenir; elle eklenen kayıtlara dokunulmaz.
  function migrateEvents() {
    var settings = Object.assign({}, state.settings || {});
    if (Number(settings.eventsSchema) >= 4) {
      // Sandık asla kaçmaz: eski sürümlerde süresi dolunca "expired" işaretlenen
      // sandıklar beklemedeye alınır (KONTROL ET!).
      if (Number(settings.eventsSchema) < 5) {
        var recovered = state.events.map(function (event) {
          if (event.kind === 'chest' && (event.status === 'expired' || event.status === 'missed')) {
            return Object.assign({}, event, { status: 'pending' });
          }
          return event;
        });
        settings.eventsSchema = 5;
        Store.set({ events: recovered, settings: settings });
        state = Store.get();
      }
      return;
    }
    // Eski sürüm kutunun gerçek türünü/adını yazmıyordu; o otomatik kayıtlar bir
    // kez düşürülür, yerine doğru türde yenileri gelir. Elle eklenenler ve
    // kutu bilgisi taşıyan kayıtlar korunur.
    var kept = state.events.filter(function (event) {
      if (!event.auto) return true;
      if (event.kind === 'gift') return false;
      return event.boxName !== undefined;
    });
    settings.eventsSchema = 5;
    Store.set({ events: kept, settings: settings });
    state = Store.get();
  }

  // ---------- Akıllı puanlama ----------
  // Fırsatı aciliyet, jeton, paylaşım (kaç kişiye ulaştı), tür ve tazelik
  // bileşenleriyle 0-100 arasında puanlar. Tür ağırlığı: sandık > portal > zarf > hediye.
  // Bilinmeyen alan uydurulmaz; o bileşen 0 sayılır.

  var KIND_WEIGHT = { chest: 15, portal: 12, letter: 10 };
  var KIND_ORDER = { chest: 0, portal: 1, letter: 2 };

  function remainingSeconds(event) {
    var now = Date.now();
    if (event.kind === 'letter' && Number(event.expiresAt) > 0) {
      return Math.max(0, (Number(event.expiresAt) - now) / 1000);
    }
    if (Number(event.availableAt) > 0) {
      return Math.max(0, (Number(event.availableAt) - now) / 1000);
    }
    var end = eventEndAt(event);
    if (end > 0) return Math.max(0, (end - now) / 1000);
    return null;
  }

  function opportunityScore(event) {
    var coins = Number(event.coins) || 0;
    var shared = Number(event.shared) || 0;
    var total = Number(event.durationSec) || 0;
    var left = remainingSeconds(event);
    var parts = { urgency: 0, coins: 0, shared: 0, kind: 0, freshness: 0 };

    if (left !== null) {
      var ratio = total > 0 ? Math.min(1, left / total) : Math.min(1, left / 600);
      parts.urgency = 30 * (1 - ratio);
    }
    parts.coins = 25 * Math.min(1, coins / 1000);
    // "En çok paylaşılan": jetonun kaç kişiye ulaştığı. Bilinmiyorsa puan verilmez.
    parts.shared = 20 * Math.min(1, shared / 50);
    parts.kind = KIND_WEIGHT[event.kind] || 0;
    var ageSec = Math.max(0, (Date.now() - (Number(event.createdAt) || Date.now())) / 1000);
    parts.freshness = 10 * (1 - Math.min(1, ageSec / 3600));

    var score = Math.max(0, Math.min(100, Math.round(
      parts.urgency + parts.coins + parts.shared + parts.kind + parts.freshness
    )));

    var best = Math.max(parts.urgency, parts.coins, parts.shared, parts.kind, parts.freshness);
    var reason = 'dengeli';
    if (best === parts.urgency && parts.urgency > 0) reason = 'süre kritik';
    else if (best === parts.coins) reason = 'yüksek jeton';
    else if (best === parts.shared) reason = 'çok kişiye paylaşıldı';
    else if (best === parts.kind) {
      reason = { chest: 'sandık öncelikli', portal: 'portal öncelikli', letter: 'zarf öncelikli' }[event.kind] || 'dengeli';
    }
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
      if (oppSort === 'kind') {
        var ka = KIND_ORDER[a.kind] === undefined ? 4 : KIND_ORDER[a.kind];
        var kb = KIND_ORDER[b.kind] === undefined ? 4 : KIND_ORDER[b.kind];
        if (ka !== kb) return ka - kb;
        return (Number(b.coins) || 0) - (Number(a.coins) || 0);
      }
      // Sandık / portal / zarf sıralaması: seçilen tür önce, kendi içinde jetonca.
      if (oppSort === 'chest' || oppSort === 'portal' || oppSort === 'letter') {
        var fa = a.kind === oppSort ? 0 : 1;
        var fb = b.kind === oppSort ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return (Number(b.coins) || 0) - (Number(a.coins) || 0);
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
    $('streamerCount').textContent = countryFilter
      ? state.streamers.filter(function (streamer) {
        return String(streamer.country || '').toUpperCase() === countryFilter;
      }).length
      : state.streamers.length;
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
      case 'score': return Number(streamer.score) || 0;
      case 'lastSeen': return metrics.lastSeen;
      default: return streamer.username;
    }
  }

  // Kutu geçmişinden güvenilirlik rozeti: skor + ipucunda kutu sayısı,
  // ortalama jeton ve son kutu zamanı. Hiç kutu yoksa "—" (bilinmiyor).
  function scoreChip(streamer) {
    if (streamer.score === undefined || streamer.score === null) {
      return '<span class="text-[10px] text-yellow-50/30" title="Bu yayıncıdan henüz kutu görülmedi; skor yok">—</span>';
    }
    var score = Number(streamer.score) || 0;
    var parts = [(Number(streamer.boxCount) || 0) + ' kutu'];
    if (Number(streamer.avgCoins) > 0) parts.push('ort ' + fmt(Number(streamer.avgCoins)) + ' jeton');
    else parts.push('jeton bilinmiyor');
    if (Number(streamer.lastBoxAt) > 0) parts.push('son kutu ' + ago(Number(streamer.lastBoxAt)));
    var cls = score >= 70 ? 'chip-green' : (score >= 40 ? 'chip-amber' : '');
    return '<span class="chip ' + cls + ' !py-0 !text-[10px]" title="Kutu geçmişi: ' +
      esc(parts.join(' · ')) + ' → güven ' + score + '/100. Yüksek skorlu odaya daha erken dönülür.">' +
      score + '</span>';
  }

  function renderStreamers() {
    renderSweepSummary();
    var rows = $('streamerRows');
    $('streamerEmpty').classList.toggle('hidden', state.streamers.length > 0);

    var filter = streamerSearch.trim().toLowerCase().replace(/^@/, '');
    var list = state.streamers.filter(function (streamer) {
      if (countryFilter && String(streamer.country || '').toUpperCase() !== countryFilter) return false;
      if (!filter) return true;
      return streamer.username.toLowerCase().indexOf(filter) >= 0 ||
        countryName(streamer.country).toLowerCase().indexOf(filter) >= 0 ||
        String(streamer.country || '').toLowerCase() === filter;
    }).sort(function (a, b) {
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

    var total = list.length;
    // Rozet, süzülmüş listenin sayısını yazar; ipucunda toplam durur.
    $('streamerCount').textContent = total;
    $('streamerCount').title = countryFilter
      ? countryFilter + ' · toplam ' + state.streamers.length + ' yayıncı'
      : 'Toplam ' + state.streamers.length + ' yayıncı';
    if (total > STREAMER_ROW_LIMIT) list = list.slice(0, STREAMER_ROW_LIMIT);

    if (!total) {
      rows.innerHTML = '<tr><td colspan="11" class="text-[11px] text-yellow-50/40 pt-3">' +
        (countryFilter
          ? esc(countryFilter + ' (' + countryName(countryFilter) + ') için listede yayıncı yok. Rozete tekrar basınca filtre kalkar.')
          : 'Aramayla eşleşen yayıncı yok.') + '</td></tr>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    rows.innerHTML = list.map(function (streamer) {
      var metrics = streamerMetrics(streamer);
      var scannedOff = streamer.scanCheckedAt && !streamer.scanLive && !metrics.live;
      var missing = scannedOff && /not_found/i.test(streamer.scanReason || '');
      var liveChip = metrics.live
        ? '<button class="chip chip-green" data-toggle-live="' + streamer.id + '" title="' + esc(streamer.liveTitle || '') + '">● Canlı' +
          (streamer.source === 'discover' ? ' · bulundu' : (streamer.scanLive ? ' · tarama' : '')) + '</button>'
        : missing
          ? '<span class="chip chip-danger" title="TikTok bu kullanıcı adını bulamadı; adresi düzelt">⚠ Hesap yok</span>'
          : scannedOff
            ? '<span class="chip" title="Tarama bu hesabı canlı bulmadı">○ Yayında değil</span>'
            : '<button class="chip" data-toggle-live="' + streamer.id + '">Canlı yap</button>';
      var boxNote = Number(streamer.boxes) > 0
        ? ' <span class="chip chip-amber !py-0 !text-[10px]" title="Bu odada yakalanan kutu sayısı · öncelikli izlenir">🔥 ' + Number(streamer.boxes) + ' kutu</span>'
        : '';
      var liveNote = streamer.scanLive
        ? '<div class="text-[10px] text-yellow-50/40 truncate max-w-[180px]">' + esc(streamer.liveTitle || 'yayında') + (streamer.viewers ? ' · ' + fmt(streamer.viewers) + ' kişi' : '') + '</div>'
        : '';

      return [
        '<tr>',
        '  <td class="min-w-[170px]">',
        '    <a href="' + liveUrl(streamer.username) + '" target="_blank" rel="noopener" class="font-bold text-yellow-100 hover:text-yellow-300">@' + esc(streamer.username) + '</a>' + boxNote,
        '    <div class="text-[10px] text-yellow-50/40">' + (streamer.country ? flag(streamer.country) + ' ' + esc(countryName(streamer.country)) : '') + '</div>',
        '    ' + liveNote,
        '  </td>',
        '  <td>' + liveChip + '</td>',
        '  <td class="font-mono text-xs" data-streamer-timer="' + streamer.id + '">' + (streamer.scanLive && !streamer.startedAt ? '—' : clock(streamerDuration(streamer))) + '</td>',
        '  <td class="text-amber-300">' + metrics.chest + '</td>',
        '  <td class="text-pink-300">' + metrics.letter + '</td>',
        '  <td class="text-purple-300">' + metrics.portal + '</td>',
        '  <td class="font-bold text-amber-400">' + fmt(metrics.coins) + '</td>',
        '  <td><span class="text-green-300 font-bold">' + fmt(metrics.collected) + '</span> <span class="text-[10px] text-yellow-50/40">(' + metrics.collectedCount + ')</span></td>',
        '  <td class="whitespace-nowrap">' + scoreChip(streamer) + '</td>',
        '  <td class="text-[11px] text-yellow-50/50 whitespace-nowrap">' + ago(metrics.lastSeen) + '</td>',
        '  <td><div class="flex flex-wrap gap-1 justify-end">',
        '    <button class="chip chip-amber" data-add-event="' + streamer.id + '" data-kind="chest">+ Sandık</button>',
        '    <button class="chip chip-pink" data-add-event="' + streamer.id + '" data-kind="letter">+ Zarf</button>',
        '    <button class="chip chip-purple" data-add-event="' + streamer.id + '" data-kind="portal">+ Portal</button>',
        '    <button class="chip chip-green" data-open-app="' + esc(streamer.username) + '" data-room-id="' + esc(streamer.roomId || '') + '">📱 Uygulamada</button>',
        '    <button class="chip" data-qr="' + esc(streamer.username) + '" data-room-id="' + esc(streamer.roomId || '') + '">QR</button>',
        '    <button class="chip chip-danger" data-remove-streamer="' + streamer.id + '">×</button>',
        '  </div></td>',
        '</tr>'
      ].join('');
    }).join('');

    if (total > STREAMER_ROW_LIMIT) {
      rows.innerHTML += '<tr><td colspan="11" class="text-[11px] text-yellow-50/40 pt-3">' +
        (total - STREAMER_ROW_LIMIT) + ' yayıncı daha listede (hepsi kayıtlı ve taranıyor). ' +
        'İlk ' + STREAMER_ROW_LIMIT + ' satır gösteriliyor; yukarıdaki aramayla diğerlerini bul.</td></tr>';
    }

    if (window.lucide) lucide.createIcons();
  }

  // ---------- Fırsatlar ----------

  var oppFilter = 'all';

  // Tür sayaçları: kaç sandık, kaç zarf, kaç portal var — tek bakışta görünsün.
  function renderOppFilters(list) {
    var box = $('oppFilters');
    if (!box) return;
    var counts = { all: list.length, chest: 0, letter: 0, portal: 0 };
    list.forEach(function (event) { counts[event.kind] = (counts[event.kind] || 0) + 1; });
    var tabs = [
      ['all', 'Tümü', '🗂️'],
      ['chest', 'Sandık', '📦'],
      ['letter', 'Zarf', '✉️'],
      ['portal', 'Portal', '🌀']
    ];
    box.innerHTML = tabs.map(function (tab) {
      var active = oppFilter === tab[0];
      return '<button class="chip ' + (active ? 'chip-amber' : '') + '" data-opp-filter="' + tab[0] + '">' +
        tab[2] + ' ' + tab[1] + ' <b>' + (counts[tab[0]] || 0) + '</b></button>';
    }).join('');
  }

  // Son 24 saatin saatlik kutu sayıları. Tarayıcı saatlik sayacı (boxHourly)
  // koşular arasında kalıcıdır; eski veride sayaç yoksa yalnızca o an eldeki
  // kutu olaylarının zaman damgaları sayılır.
  function boxHourBuckets(info, now) {
    var hour = 3600 * 1000;
    var start = Math.floor((now - 24 * hour) / hour) * hour;
    var buckets = [];
    var hourCount = 25;
    for (var i = 0; i < hourCount; i += 1) buckets.push({ at: start + i * hour, count: 0 });

    var hourly = info && info.boxHourly;
    if (hourly && typeof hourly === 'object') {
      Object.keys(hourly).forEach(function (key) {
        var count = Number(hourly[key]) || 0;
        var at = Number(key) * hour;
        if (!count || !at || at < start) return;
        var index = Math.floor((at - start) / hour);
        if (index >= 0 && index < buckets.length) buckets[index].count += count;
      });
      return buckets;
    }

    var events = info && Array.isArray(info.events) ? info.events : [];
    events.forEach(function (event) {
      if (!event) return;
      if (event.kind !== 'chest' && event.kind !== 'letter' && event.kind !== 'portal') return;
      var at = Number(event.t) || 0;
      if (!at || at < start) return;
      var index = Math.floor((at - start) / hour);
      if (index >= 0 && index < buckets.length) buckets[index].count += 1;
    });
    return buckets;
  }

  // Son 24 saatteki oran kararlarını ve saatlik kutu sayısını tek grafikte çizer.
  // Oran çizgisi sabit %10-%60 ölçeğinde (uyarlamanın alt/üst sınırı); kutu
  // sütunları kendi en yüksek saatine göre ölçeklenir, bu yüzden sağ üstte
  // "en çok N" etiketi durur.
  function probeChart(history, now, buckets) {
    var width = 240, height = 74, padX = 6, padTop = 10, padBottom = 13;
    var lo = 10, hi = 60;
    var points = history.map(function (item) {
      var value = Number(item.to);
      return {
        at: Number(item.at) || 0,
        value: Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : lo))
      };
    }).sort(function (a, b) { return a.at - b.at; });

    var bars = Array.isArray(buckets) ? buckets : [];
    var maxBox = 0;
    bars.forEach(function (bar) {
      maxBox = Math.max(maxBox, Number(bar && bar.count) || 0);
    });
    if (!points.length && !maxBox) return '';

    var from = now - 24 * 3600 * 1000;
    var span = Math.max(1, now - from);
    var innerW = width - padX * 2;
    var innerH = height - padTop - padBottom;
    var floorY = height - padBottom;
    function x(time) { return padX + ((time - from) / span) * innerW; }
    function y(value) { return padTop + innerH - ((value - lo) / (hi - lo)) * innerH; }

    var step = innerW / Math.max(1, bars.length || 24);
    var barW = Math.max(2, step * 0.55);
    // Sütunlar grafiğin alt yarısında kalır: sarı oran çizgisi üstte okunur.
    var barMaxH = innerH * 0.55;
    var columns = bars.map(function (bar) {
      var count = Number(bar && bar.count) || 0;
      if (!count || !maxBox) return '';
      var at = Number(bar && bar.at) || from;
      var h = Math.max(1.5, (count / maxBox) * barMaxH);
      var time = new Date(at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      return '<rect x="' + (x(at) - barW / 2).toFixed(1) + '" y="' + (floorY - h).toFixed(1) +
        '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1" ' +
        'fill="rgba(52,211,153,0.55)"><title>' +
        esc(time + ' · ' + count + ' kutu') + '</title></rect>';
    }).join('');

    var line = points.length > 1 ? '<polyline points="' + points.map(function (item) {
      return x(item.at).toFixed(1) + ',' + y(item.value).toFixed(1);
    }).join(' ') + '" fill="none" stroke="#facc15" stroke-width="1.5" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' : '';

    var dots = points.map(function (item) {
      var time = new Date(item.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      return '<circle cx="' + x(item.at).toFixed(1) + '" cy="' + y(item.value).toFixed(1) +
        '" r="2.5" fill="#facc15"><title>' + esc(time + ' · %' + item.value) + '</title></circle>';
    }).join('');

    return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="w-full" height="74" role="img" ' +
      'aria-label="Keşif oranının ve saatlik kutu sayısının son 24 saatteki değişimi">' +
      '<line x1="' + padX + '" y1="' + y(hi).toFixed(1) + '" x2="' + (width - padX) +
        '" y2="' + y(hi).toFixed(1) + '" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>' +
      '<line x1="' + padX + '" y1="' + floorY + '" x2="' + (width - padX) +
        '" y2="' + floorY + '" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>' +
      columns +
      line + dots +
      (maxBox ? '<text x="' + (width - padX) + '" y="' + (floorY - barMaxH - 2).toFixed(1) +
        '" font-size="7" text-anchor="end" fill="rgba(52,211,153,0.7)">en çok ' + maxBox + '/sa</text>' : '') +
      '<text x="' + padX + '" y="' + (height - 1) + '" font-size="7" fill="rgba(255,255,255,0.4)">24 sa önce</text>' +
      '<text x="' + (width - padX) + '" y="' + (height - 1) + '" font-size="7" text-anchor="end" ' +
        'fill="rgba(255,255,255,0.4)">şimdi</text>' +
      '<text x="' + padX + '" y="' + (y(hi) + 7).toFixed(1) + '" font-size="7" ' +
        'fill="rgba(255,255,255,0.3)">%' + hi + '</text>' +
      '<text x="' + padX + '" y="' + (y(lo) - 2).toFixed(1) + '" font-size="7" ' +
        'fill="rgba(255,255,255,0.3)">%' + lo + '</text>' +
      '</svg>';
  }

  // Keşif oranı özeti: mevcut oran, kutu başarısı ve son kararlar.
  // Av sekmesindeki ülke raporu: son ülke taraması + listede ülke başına kaç yayıncı.
  function renderSweepSummary() {
    var el = $('sweepSummary');
    if (!el) return;

    var sweep = (scanInfo && scanInfo.regionSweep) || null;
    var regionAdded = (sweep && sweep.regions) || {};
    // Bölge kodları havuz kodu olabilir (US+): ülke koduna indirgenir.
    var addedByCountry = {};
    Object.keys(regionAdded).forEach(function (region) {
      var code = boardCountry(region);
      if (!code) return;
      addedByCountry[code] = (addedByCountry[code] || 0) + (Number(regionAdded[region]) || 0);
    });

    var totals = {};
    state.streamers.forEach(function (streamer) {
      var code = String(streamer.country || '').toUpperCase();
      if (!code) return;
      totals[code] = (totals[code] || 0) + 1;
    });
    var codes = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });

    var clearChip = countryFilter
      ? '<button class="chip chip-amber" data-country="" title="Ülke filtresini kaldır">✕ Tüm ülkeler</button>'
      : '';

    var head = (!sweep || !Number(sweep.at))
      ? '<span class="chip" title="Tarayıcı anahtarla günde bir tüm bölgeleri okur">🌍 Ülke taraması henüz yapılmadı</span>'
      : '<span class="chip chip-green" title="Günde bir tüm bölgeler okunur">🌍 Son ülke taraması ' +
        esc(ago(Number(sweep.at))) + ' · ' + Object.keys(regionAdded).length + ' bölge · +' +
        fmt(Number(sweep.added) || 0) + ' yeni</span>';

    var failed = (sweep && Array.isArray(sweep.failed)) ? sweep.failed : [];
    var failChip = failed.length
      ? '<span class="chip chip-danger" title="Bu bölgeler okunamadı">hata: ' + esc(failed.join(', ')) + '</span>'
      : '';

    var shown = codes.slice(0, 30).map(function (code) {
      var added = Number(addedByCountry[code]) || 0;
      var active = countryFilter === code;
      return '<button class="chip ' + (active ? 'chip-green' : '') + '" data-country="' + esc(code) + '" title="' +
        esc(active
          ? 'Filtreyi kaldır'
          : countryName(code) + ' · listede ' + totals[code] + ' yayıncı' + (added ? ' · son taramada +' + added : '')) + '">' +
        flag(code) + ' ' + esc(code) + ' <b>' + fmt(totals[code]) + '</b></button>';
    }).join('');

    var rest = codes.length > 30
      ? '<span class="chip">+' + (codes.length - 30) + ' ülke daha</span>'
      : '';

    var empty = codes.length
      ? ''
      : '<span class="text-[10px] text-yellow-50/40">Listede henüz ülke bilgisi yok — tarama ülke kodlarını doldurunca burada görünür.</span>';

    el.innerHTML = clearChip + head + failChip + shown + rest + empty;
  }

  function renderProbeSummary() {
    var el = $('probeSummary');
    if (!el) return;
    if (!scanInfo) { el.innerHTML = ''; return; }

    var ratio = Math.round((Number(scanInfo.probeRatio) || 0) * 100);
    var stats = scanInfo.probeStats || {};
    var sessions = Number(stats.sessions) || 0;
    var withBox = Number(stats.withBox) || 0;
    var rate = sessions ? Math.round((withBox / sessions) * 100) : 0;
    var dayAgo = Date.now() - 24 * 3600 * 1000;
    var allHistory = Array.isArray(scanInfo.probeHistory) ? scanInfo.probeHistory : [];
    var history = allHistory.filter(function (item) {
      return Number(item && item.at) >= dayAgo;
    });

    var chips = '<span class="chip chip-amber" title="Deneme odalarına ayrılan pay">🔎 Keşif oranı %' + ratio + '</span>' +
      '<span class="chip" title="Deneme oturumlarında kutu yakalama">Kutulu deneme ' +
        (sessions ? withBox + '/' + sessions + ' · %' + rate : 'henüz yok') + '</span>' +
      '<span class="chip" title="O an dinlenen yeni aday sayısı">Aday odada ' +
        (Number(scanInfo.probes) || 0) + '</span>';

    var buckets = boxHourBuckets(scanInfo, Date.now());
    var boxTotal = buckets.reduce(function (sum, bucket) {
      return sum + (Number(bucket.count) || 0);
    }, 0);
    var chart = probeChart(history, Date.now(), buckets);
    if (!chart) {
      el.innerHTML = chips + '<div class="w-full mt-1 text-[10px] text-yellow-50/40">' +
        'Son 24 saatte oran kararı ve kutu kaydı yok — 8 deneme oturumu dolunca ilk karar, ' +
        'ilk kutu yakalanınca da kutu sütunu buraya yazılır.</div>';
      return;
    }

    // Grafiğin ne olduğunu renklerle söyle: sarı çizgi oran, yeşil sütun kutu.
    var legend = '<div class="w-full mt-1 flex items-center gap-2 text-[10px] text-yellow-50/45">' +
      '<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:10px;height:2px;background:#facc15"></span>oran</span>' +
      '<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:6px;height:6px;background:rgba(52,211,153,0.7)"></span>kutu/saat</span>' +
      '<span class="ml-auto">Son 24 sa · ' + history.length + ' karar · ' + boxTotal + ' kutu</span>' +
      '</div>';

    var rows = history.slice(-5).reverse().map(function (item) {
      var time = new Date(Number(item.at) || Date.now()).toLocaleTimeString('tr-TR',
        { hour: '2-digit', minute: '2-digit' });
      var text = time + ' · %' + item.from + ' → %' + item.to;
      if (item.sessions) text += ' · deneme %' + item.probeRate + ' kutulu (' + item.boxSessions + '/' + item.sessions + ')';
      if (item.hotRate !== null && item.hotRate !== undefined) text += ' · sıcak %' + item.hotRate;
      return '<div class="text-[10px] text-yellow-50/50">' + esc(text) + '</div>';
    }).join('');

    el.innerHTML = chips + legend +
      '<div class="w-full mt-1">' + chart + '</div>' +
      (history.length ? '' : '<div class="w-full text-[10px] text-yellow-50/40">' +
        'Son 24 saatte oran kararı yok — 8 deneme oturumu dolunca ilk karar buraya yazılır.</div>') +
      '<div class="w-full space-y-0.5">' + rows + '</div>';
  }

  // Tarayıcının yakaladığı son kutu bildirimleri: hangi tür kod geldiyse görünür.
  function renderBoxDiag() {
    var el = $('boxDiag');
    if (!el) return;
    if (scanPaused) { el.textContent = 'Kutu tanılama: tarama durduruldu.'; return; }
    var samples = (scanInfo && scanInfo.envelopeSamples) || [];
    if (!samples.length) {
      el.textContent = 'Kutu tanılama: tarayıcı henüz kutu bildirimi yakalamadı (sandık/zarf/portal ancak dinlenen odada paylaşılınca düşer).';
      return;
    }
    el.innerHTML = '<b>Tarayıcının son yakaladığı kutular:</b> ' + samples.slice(-4).map(function (sample) {
      return '@' + esc(sample.user || '') + ' · tür ' + (Number(sample.businessType) || '?') +
        ' · ' + (Number(sample.coins) || 0) + ' jeton · ' + (Number(sample.people) || 0) + ' kişi';
    }).join(' · ');
  }

  function renderOpportunities() {
    var container = $('opportunityList');
    var pendingAll = pendingEvents();
    renderOppFilters(pendingAll);
    var pending = sortEvents(oppFilter === 'all' ? pendingAll : pendingAll.filter(function (event) {
      return event.kind === oppFilter;
    }));

    if (pending.length === 0) {
      container.innerHTML = '<div class="empty-state md:col-span-2 xl:col-span-3">' +
        (pendingAll.length === 0
          ? 'Şu an toplanabilir sandık/portal/zarf yok. Tarama sürüyor; yayında sandık, portal veya zarf düştüğünde burada belirir.'
          : 'Bu türde bekleyen fırsat yok. “Tümü”ne basıp diğer türleri gör.') + '</div>';
      return;
    }

    container.innerHTML = pending.map(function (event) {
      var meta = KINDS[event.kind] || KINDS.chest;
      var scored = opportunityScore(event);
      // Kutu geçmişinden güvenilirlik: bu yayıncıdan daha önce kaç kutu,
      // ortalama kaç jeton çıktı. Skor yoksa rozet yazılmaz.
      var publisher = state.streamers.find(function (streamer) {
        return streamer.id === event.streamerId;
      });
      var publisherScore = publisher && publisher.score !== undefined && publisher.score !== null
        ? Number(publisher.score) : null;
      var publisherNote = publisherScore === null ? '' :
        '<span class="chip !py-0 !text-[10px]" title="Yayıncı güveni ' + publisherScore + '/100 · ' +
        (Number(publisher.boxCount) || 0) + ' kutu' +
        (Number(publisher.avgCoins) > 0 ? ' · ort ' + fmt(Number(publisher.avgCoins)) + ' jeton' : ' · jeton bilinmiyor') +
        '">🛡️ güven ' + publisherScore + '</span> ';
      var urgent = false;
      var timeText = '';
      var endAt = eventEndAt(event);
      var opensIn = endAt ? Math.round((endAt - Date.now()) / 1000) : null;
      // Kök panelde süre gelmezse 3 dk tahmini pencere kullanılıyor;
      // kullanıcıya "tahmini" olarak işaretlenir (uydurma değil).
      var estimated = event.kind === 'chest' && !(Number(event.unpackAt) || Number(event.availableAt));

      if (opensIn !== null && opensIn > 0) {
        urgent = opensIn <= 60;
        timeText = event.kind === 'letter'
          ? 'jeton geri dönüyor: ' + clock(opensIn)
          : 'açılışa ' + clock(opensIn) + (estimated ? ' (tahmini)' : '');
      } else if (opensIn !== null) {
        if (event.kind === 'chest') {
          // Kök paneldeki gibi: süre bitti ama hemen silinmez, kısa süre
          // "KONTROL ET!" olarak kalır, sonra düşer.
          var graceLeft = Math.max(0, Math.round((endAt + CHEST_GRACE_MS - Date.now()) / 1000));
          timeText = graceLeft > 0
            ? 'açıldı · süre doldu, beklemede · ' + clock(graceLeft) + ' sonra düşer'
            : 'açıldı · süre doldu, beklemede · ' + (Number(event.shared) > 0 ? (event.shared + ' kişiye paylaşıldı · ') : '') + 'toplanmayı dene';
        } else {
          timeText = 'açıldı · süre doldu, toplamayı dene';
        }
      } else {
        timeText = event.auto ? 'tarayıcı yakaladı · süre bildirilmedi' : 'hemen açıldı · kaybolmaz';
      }

      var shared = Number(event.shared) || 0;

      return [
        '<div class="opp-card ' + (urgent ? 'opp-urgent' : '') + '">',
        '  <div class="flex items-center justify-between mb-2">',
        '    <span class="flex items-center gap-1"><span class="kind-badge ' + meta.cls + '">' + meta.icon + ' ' + meta.label + '</span>' +
          (event.auto ? '<span class="kind-badge kind-live">CANLI</span>' : '') +
          (opensIn !== null && opensIn <= 0
            ? '<span class="chip chip-danger !py-0 !text-[10px]">KONTROL ET</span>' : '') +
          '</span>',
        '    <span class="font-black text-amber-400" title="Kutunun toplam jeton değeri (TikTok bildirimi). Açan kişi başına düşen pay daha azdır.">' +
          (Number(event.coins) > 0
            ? fmt(event.coins) + ' <span class="text-[10px] font-normal text-yellow-50/40">jeton · kutu değeri</span>'
            : '<span class="text-[11px] font-normal text-yellow-50/40">jeton bilinmiyor</span>') + '</span>',
        '  </div>',
        '  <div class="text-[10px] mb-1">' + publisherNote + '<span class="chip !py-0 !text-[10px]" title="aciliyet + jeton + paylaşım + tür + tazelik">Puan ' + scored.score + ' · ' + esc(scored.reason) + '</span></div>',
        '  <a href="' + liveUrl(event.username) + '" target="_blank" rel="noopener" class="font-semibold text-yellow-100 hover:text-yellow-300 truncate block">@' + esc(event.username) + '</a>',
        '  <div class="text-[10px] text-yellow-50/40">' + (event.country ? flag(event.country) + ' ' + esc(countryName(event.country)) + ' · ' : '') + new Date(event.createdAt).toLocaleTimeString('tr-TR') +
          (endAt ? ' → ' + new Date(endAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) + ' açılır' : '') +
          (shared > 1 ? ' · ' + shared + ' kişiye' : '') + '</div>',
        '  <div class="text-[10px] text-yellow-50/50 mt-0.5">Kutu: <b>' + esc(event.boxName || event.giftName || 'Kutu') + '</b>' + (Number(event.businessType) ? ' · tür kodu ' + Number(event.businessType) : '') + (event.senderName && event.senderName !== event.username ? ' · paylaşan @' + esc(event.senderName) : '') + (event.boxType ? ' · ' + esc(event.boxType) : '') + '</div>',
        '  <div class="text-[11px] mt-1 ' + (urgent ? 'text-red-300 font-bold' : 'text-yellow-50/60') + '" data-countdown="' + (endAt || 0) + '" data-kind="' + event.kind + '" data-duration="' + (Number(event.durationSec) || 0) + '">' + timeText + '</div>',
        '  <div class="flex gap-2 mt-3">',
        '    <button class="chip chip-green" data-open-app="' + esc(event.username) + '" data-room-id="' + esc(roomIdForStreamer(event.streamerId)) + '">📱 Uygulamada</button>',
        '    <button class="chip chip-amber" data-qr="' + esc(event.username) + '" data-room-id="' + esc(roomIdForStreamer(event.streamerId)) + '">QR / Yayına git</button>',
        '    <button class="chip chip-green" data-collect="' + event.id + '">Topladım</button>',
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
    $('chestKeepMin').value = chestKeepMs() / 60000;
    $('notifyToggle').checked = Boolean(state.settings.notify);

    var info = Store.storageInfo();
    $('storageInfo').textContent = info.engine + ' · ' + (info.bytes / 1024).toFixed(1) + ' KB · ' +
      info.streamers + ' yayıncı, ' + info.events + ' olay, ' + info.accounts + ' hesap, ' + info.agencies + ' ajans' +
      (info.updatedAt ? ' · son kayıt ' + new Date(info.updatedAt).toLocaleString('tr-TR') : '') +
      ' · yedek biçimi v' + (window.Store.backupFormat || 1);
    renderAppSettings();
    renderKeyState();
    renderVersionHistory();
  }

  // Panel sürümü + sürüm geçmişi (store.js'teki CHANGE_LOG).
  function renderVersionHistory() {
    var el = $('versionHistory');
    if (!el) return;
    var version = window.Store.appVersion || '1.0.0';
    $('panelVersion').innerHTML = '<span class="chip chip-green">● Panel sürüm ' + esc(version) + '</span>' +
      (desktopApi ? ' <span class="chip">Masaüstü uygulaması ayrıca güncellenir</span>' : '') +
      ' <span class="chip">Yedek biçimi v' + esc(window.Store.backupFormat || 1) + '</span>';

    el.innerHTML = (window.Store.changeLog || []).map(function (entry) {
      var items = Array.isArray(entry.items) ? entry.items : [];
      return '<div class="border-l-2 border-yellow-500/40 pl-3">' +
        '<div class="text-xs"><b class="text-yellow-200">v' + esc(entry.version) + '</b>' +
        (entry.date ? ' <span class="text-yellow-50/40">· ' + esc(entry.date) + '</span>' : '') + '</div>' +
        (items.length
          ? '<ul class="list-disc list-inside text-[11px] text-yellow-50/55 mt-1 space-y-0.5">' +
            items.map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>'
          : '') +
        '</div>';
    }).join('');
  }

  // ---------- Masaüstü uygulaması ve güncellemeler ----------
  // Kurulum paketinde (desktop/) preload bu köprüyü açar. Tarayıcıda yoktur:
  // o zaman kart yol gösterir, sahte "güncel" bilgisi yazmaz.
  var desktopApi = window.desktop || null;

  function setUpdateStatus(text, danger) {
    var el = $('updateStatus');
    if (!el) return;
    el.innerHTML = text;
    el.className = 'hint mt-3 ' + (danger ? 'text-red-300' : 'text-yellow-50/60');
  }

  // ---------- Ölçüm ----------
  // Sayılar scripts/quota-report.mjs tarafından metrics.json'a yazılır: panel
  // hesabı tekrarlamaz, yalnızca gösterir (aynı sayı iki yerde tutulmaz).

  async function refreshMetrics() {
    try {
      metricsInfo = await fetchScanData(metricsUrl);
    } catch (error) {
      // Dosya henüz üretilmediyse mevcut değer korunur.
      if (!metricsInfo) metricsInfo = null;
    }
    renderMetrics();
  }

  function metricsNumber(value, suffix) {
    if (value === null || value === undefined) return '—';
    return fmt(value) + (suffix || '');
  }

  function renderMetrics() {
    var summary = $('metricsSummary');
    if (!summary) return;
    var m = metricsInfo;
    var stamp = $('metricsUpdated');
    if (!m) {
      stamp.textContent = 'metrics.json okunamadı';
      summary.innerHTML = '<div class="empty-state col-span-2 lg:col-span-4">Ölçüm dosyası yok. ' +
        'Tarayıcı geçmişinden üretmek için: <code>node scripts/quota-report.mjs --json=site/firsat/data/metrics.json</code></div>';
      $('metricsHourly').innerHTML = '';
      $('metricsGroupsTable').innerHTML = '';
      $('metricsRunsTable').innerHTML = '';
      return;
    }

    var hourly = m.hourly || {};
    var runs = Array.isArray(m.runs) ? m.runs : [];
    var groups = Array.isArray(m.groups) ? m.groups : [];
    var source = m.source || {};
    var lastRun = runs.length ? runs[runs.length - 1] : null;

    stamp.textContent = m.generatedAt
      ? 'ölçüm: ' + new Date(m.generatedAt).toLocaleString('tr-TR') + ' (' + ago(new Date(m.generatedAt).getTime()) + ')'
      : '';

    var cards = [
      ['Kutu / saat (ort.)', metricsNumber(hourly.avgPerHour), 'text-amber-400',
        (hourly.boxes || 0) + ' tekil kutu · ' + (hourly.hours || 0) + ' saat'],
      ['Kutu / 5 dk oturum', lastRun ? metricsNumber(lastRun.boxesPerSession) : '—', 'text-green-300',
        lastRun ? 'son koşu · ' + (lastRun.ok || 0) + ' başarılı bağlantı' : 'koşu yok'],
      ['Karşılaştırılabilir koşu', metricsNumber(source.comparedRuns), 'text-purple-300',
        (source.commits || 0) + ' commit tarandı' + (source.failed ? ' · ' + source.failed + ' okunamadı' : '')],
      ['Ayar grubu', metricsNumber(groups.length), 'text-yellow-300',
        groups.length ? 'en iyi: ' + fmt(groups[0].boxesPer100) + ' kutu/100 deneme' : 'grup yok']
    ];
    summary.innerHTML = cards.map(function (card) {
      return '<div class="card p-4"><div class="stat-label">' + esc(card[0]) + '</div>' +
        '<div class="stat-value ' + card[2] + '">' + card[1] + '</div>' +
        '<div class="text-[10px] text-yellow-50/40 mt-1">' + esc(card[3]) + '</div></div>';
    }).join('');

    var buckets = Array.isArray(hourly.buckets) ? hourly.buckets.slice(-48) : [];
    var maxCount = 1;
    buckets.forEach(function (bucket) { maxCount = Math.max(maxCount, Number(bucket.count) || 0); });
    $('metricsHourly').innerHTML = buckets.length
      ? buckets.map(function (bucket) {
        var count = Number(bucket.count) || 0;
        var width = Math.max(2, Math.round((count / maxCount) * 100));
        var label = String(bucket.hour || '').replace('T', ' ');
        var lastTwo = label.slice(-2);
        return '<div class="flex items-center gap-2 text-[11px]">' +
          '<span class="w-24 shrink-0 text-yellow-50/50 font-mono">' + esc(label.slice(0, 10)) + ' ' + esc(lastTwo) + ':00</span>' +
          '<span class="w-8 shrink-0 text-right font-mono text-amber-300">' + count + '</span>' +
          '<span class="flex-1 h-2 rounded bg-white/5 overflow-hidden"><span class="block h-full rounded bg-amber-500/70" style="width:' + width + '%"></span></span>' +
          '</div>';
      }).join('')
      : '<div class="hint">Saatlik kutu geçmişi yok.</div>';

    $('metricsGroupsTable').innerHTML = groups.length
      ? '<thead><tr><th>Grup</th><th>Koşu</th><th>Deneme</th><th>Ok %</th>' +
        '<th>Kutu</th><th>Kutu/100 deneme</th><th>Kutu/bağlantı</th><th>Kutu/saat</th><th>Ort. dinlenen</th></tr></thead><tbody>' +
        groups.map(function (group) {
          return '<tr>' +
            '<td class="text-[11px]">' + esc(group.name) + '</td>' +
            '<td>' + metricsNumber(group.runs) + '</td>' +
            '<td>' + metricsNumber(group.attempts) + '</td>' +
            '<td>' + metricsNumber(group.okRate, '%') + '</td>' +
            '<td class="text-amber-300 font-bold">' + metricsNumber(group.boxes) + '</td>' +
            '<td>' + metricsNumber(group.boxesPer100) + '</td>' +
            '<td>' + metricsNumber(group.boxesPerOk) + '</td>' +
            '<td>' + metricsNumber(group.boxesPerHour) + '</td>' +
            '<td>' + metricsNumber(group.avgWatching) + '</td>' +
            '</tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td class="text-[11px] text-yellow-50/40">Karşılaştırılabilir koşu yok.</td></tr></tbody>';

    var recent = runs.slice(-25).reverse();
    $('metricsRunsTable').innerHTML = recent.length
      ? '<thead><tr><th>Zaman</th><th>Ayarlar</th><th>Deneme</th><th>Ok</th><th>Dinlenen</th>' +
        '<th>Kutu</th><th>Kutu/saat</th><th>Kutu/5 dk oturum</th></tr></thead><tbody>' +
        recent.map(function (run) {
          var cfg = run.cfg || {};
          var when = run.at ? new Date(run.at) : null;
          return '<tr>' +
            '<td class="text-[11px] whitespace-nowrap">' + (when ? when.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—') + '</td>' +
            '<td class="text-[10px] text-yellow-50/50">' + esc(run.profile || '') + ' · oda ' + (cfg.rooms || '?') +
              ' · ara ' + (cfg.gap || '?') + 'ms · dk ' + (cfg.starts || '?') + ' · oran ' + (cfg.probe === undefined ? '?' : cfg.probe) + '</td>' +
            '<td>' + metricsNumber(run.attempts) + '</td>' +
            '<td>' + metricsNumber(run.ok) + '</td>' +
            '<td>' + metricsNumber(run.watching) + '</td>' +
            '<td class="text-amber-300 font-bold">' + metricsNumber(run.boxes) + '</td>' +
            '<td>' + metricsNumber(run.boxesPerHour) + (run.short ? '*' : '') + '</td>' +
            '<td>' + metricsNumber(run.boxesPerSession) + '</td>' +
            '</tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td class="text-[11px] text-yellow-50/40">Ölçülmüş koşu yok.</td></tr></tbody>';

    if (window.lucide) lucide.createIcons();
  }

  function renderScanState(info) {
    var el = $('scanState');
    if (!el || !desktopApi) return;
    var running = info && info.running;
    el.innerHTML = running
      ? '<span class="chip chip-green">● Yerel tarayıcı çalışıyor</span>' +
        (info.since ? ' <span class="text-[10px]">' + clock((Date.now() - info.since) / 1000) + '</span>' : '')
      : '<span class="chip">⏸ Yerel tarayıcı kapalı</span>' +
        (info && info.lastError ? ' <span class="text-[10px] text-red-300">' + esc(info.lastError) + '</span>' : '');
    var btn = $('scanBtn');
    if (btn) btn.textContent = running ? 'Yerel tarayıcıyı durdur' : 'Yerel tarayıcıyı başlat';
  }

  function refreshScanState() {
    if (!desktopApi) return;
    desktopApi.scanStatus().then(renderScanState).catch(function () { /* yoksay */ });
  }

  function toggleLocalScan() {
    if (!desktopApi) return;
    var page = $('scanBtn').textContent.indexOf('durdur') >= 0
      ? desktopApi.scanStop()
      : desktopApi.scanStart();
    page.then(renderScanState).catch(function (error) {
      setUpdateStatus('Tarayıcı değiştirilemedi: ' + esc(error.message), true);
    });
  }

  function renderAppSettings() {
    var versionEl = $('appVersion');
    if (!versionEl) return;
    var hintEl = $('appHint');
    if (!desktopApi) {
      versionEl.innerHTML = '<span class="chip">🌐 Tarayıcı sürümü · otomatik güncelleme yok</span>';
      hintEl.innerHTML = 'Kurulum paketiyle güncelleme kendiliğinden gelir. ' +
        '<a class="underline text-yellow-300" href="https://github.com/CehennemGibiyim/TikTok/releases/latest" target="_blank" rel="noopener">En son Windows kurulum paketini indir</a>.';
      ['checkUpdates', 'scanBtn', 'autoUpdateToggle'].forEach(function (id) {
        if ($(id)) $(id).disabled = true;
      });
      return;
    }
    desktopApi.versions().then(function (info) {
      versionEl.innerHTML = '<span class="chip chip-green">● Masaüstü sürüm ' + esc(info.version) + '</span>';
    });
    desktopApi.getSettings().then(function (settings) {
      $('autoUpdateToggle').checked = Boolean(settings.autoUpdate);
    });
    hintEl.textContent = 'Güncelleme GitHub sürümlerinden gelir; uygulama kapanırken kurulur. ' +
      'Yerel tarayıcı bu bilgisayarda çalışır: GitHub sırası beklemez, veriyi kendi klasörüne yazar.';
    refreshScanState();
  }

  // ---------- Keşif kaynağı: tik.tools bölge tabloları ----------
  // Her bölge tablosu ~100 yayıncı döndürür (yaşayan sıralama). Anahtar
  // girilmezse kullanılmaz; o zaman keşif 10'luk canlı listesinde kalır.
  var BOARDS = [
    ['TR', 'Türkiye'], ['US+', 'ABD'], ['DE+', 'Almanya'], ['BR', 'Brezilya'],
    ['JP', 'Japonya'], ['KR', 'Güney Kore'], ['TW', 'Tayvan'], ['ID', 'Endonezya'],
    ['MY', 'Malezya'], ['PH', 'Filipinler'], ['AZ', 'Azerbaycan'], ['KZ', 'Kazakistan'],
    ['BY', 'Belarus'], ['UA', 'Ukrayna'], ['TH', 'Tayland'], ['VN', 'Vietnam'],
    ['ES+', 'İspanya'], ['HU+', 'Macaristan'], ['PT+', 'Portekiz'], ['FR+', 'Fransa'],
    ['BK', 'Balkanlar'], ['PL', 'Polonya'], ['UK+', 'İngiltere'], ['IT+', 'İtalya'],
    ['SE+', 'İsveç'], ['NL', 'Hollanda'], ['RO', 'Romanya'], ['MENA', 'MENA'],
    ['LATAM', 'LATAM'], ['CCA', 'Orta Asya'], ['AU+', 'Avustralya'], ['CA', 'Kanada']
  ];

  function boardCountry(region) {
    return String(region || '').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  }

  function savedKey() {
    return String((state.settings || {}).tikToolsKey || '').trim();
  }

  function setBoardStatus(text, danger) {
    var el = $('boardStatus');
    if (!el) return;
    el.innerHTML = esc(text);
    el.className = 'text-[11px] mb-2 ' + (danger ? 'text-red-300' : 'text-yellow-300');
  }

  function renderKeyState() {
    var input = $('tikToolsKey');
    if (!input) return;
    var key = savedKey();
    input.value = key;
    $('keyState').textContent = key
      ? 'Anahtar kayıtlı (' + key.slice(0, 3) + '…' + key.slice(-4) + ') · yalnızca bu cihazda saklanır.' +
        (desktopApi ? ' Yerel tarayıcı bu anahtarı kullanır.'
          : ' Tarayıcı sürümünde bulunanlar yalnızca listeye eklenir; GitHub taraması için depoya TIKTOOLS_KEY ekle ve “Tarama listesi indir” ile havuzu yükle.')
      : 'Anahtar yok: bölge tabloları kullanılmıyor, keşif 10\'luk canlı listesinde kalır.';
    renderSweepReport();
  }

  // Tarayıcının günlük ülke taraması raporu (scanInfo.scanner.regionSweep).
  function renderSweepReport() {
    var el = $('sweepReport');
    if (!el) return;
    var sweep = (scanInfo && scanInfo.regionSweep) || null;
    if (!sweep || !Number(sweep.at)) {
      el.textContent = 'Otomatik ülke taraması henüz yapılmadı (günde bir çalışır).';
      return;
    }
    var regions = sweep.regions || {};
    var failed = Array.isArray(sweep.failed) ? sweep.failed : [];
    var detail = Object.keys(regions)
      .filter(function (key) { return Number(regions[key]) > 0; })
      .map(function (key) { return key + ' +' + regions[key]; })
      .join(' · ');
    el.innerHTML = '<b>Son ülke taraması:</b> ' + esc(ago(Number(sweep.at))) + ' · ' +
      Object.keys(regions).length + ' bölge okundu · <b>+' + fmt(Number(sweep.added) || 0) + ' yeni yayıncı</b>' +
      (sweep.running ? ' · şu an çalışıyor…' : '') +
      (failed.length ? ' · hata: ' + esc(failed.join(', ')) : '') +
      (detail ? '<div class="text-[10px] text-yellow-50/40 mt-1">' + esc(detail) + '</div>' : '');
  }

  async function fetchBoard(region, key) {
    var response = await fetch(
      'https://api.tik.tools/webcast/leaderboard?region=' + encodeURIComponent(region),
      { headers: { 'x-api-key': key, Accept: 'application/json' } }
    );
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var payload = await response.json();
    return (payload && (payload.entries || payload.ranks)) || [];
  }

  // Gelen yayıncıları Av listesine ekler; yayında olmayanlar da listede kalır.
  function addBoardCreators(entries, region) {
    var country = boardCountry(region);
    var known = {};
    state.streamers.forEach(function (streamer) { known[streamer.username.toLowerCase()] = true; });
    var added = [];
    (entries || []).forEach(function (entry) {
      var name = cleanUsername(entry && (entry.uniqueId || entry.unique_id));
      if (!name || known[name.toLowerCase()]) return;
      known[name.toLowerCase()] = true;
      added.push({
        id: uid('st'),
        username: name,
        country: country,
        startedAt: null,
        accumulatedMs: 0,
        createdAt: Date.now(),
        lastLiveAt: 0,
        scanLive: Boolean(entry && entry.isLive),
        viewers: 0,
        roomId: '',
        boxes: 0,
        lastBoxAt: 0,
        source: 'board'
      });
    });
    if (added.length) {
      Store.set({ streamers: state.streamers.concat(added) });
      state = Store.get();
    }
    return added.map(function (item) { return { username: item.username, country: item.country }; });
  }

  async function pullBoard(region) {
    var key = savedKey();
    if (!key) throw new Error('önce API anahtarını kaydet');
    var entries = await fetchBoard(region, key);
    var added = addBoardCreators(entries, region);
    // Masaüstünde aynı adresler yerel tarayıcının havuzuna da yazılır:
    // yayın açtıklarında sessizce izlenirler.
    if (added.length && desktopApi && desktopApi.addTargets) {
      desktopApi.addTargets(added).catch(function () { /* köprü yoksa yoksay */ });
    }
    return { entries: entries.length, added: added.length };
  }

  async function saveKeyAndPull() {
    var key = String($('tikToolsKey').value || '').trim();
    Store.set({ settings: Object.assign({}, state.settings, { tikToolsKey: key }) });
    state = Store.get();
    renderKeyState();
    if (desktopApi && desktopApi.setSettings) {
      // Yerel tarayıcı bu anahtarla yeniden başlar.
      desktopApi.setSettings({ tikToolsKey: key }).catch(function () { /* yoksay */ });
    }
    if (!key) {
      setBoardStatus('Anahtar silindi; bölge keşfi kapalı.', false);
      return;
    }
    var region = $('boardRegion').value || 'TR';
    setBoardStatus(region + ' tablosu çekiliyor…');
    try {
      var result = await pullBoard(region);
      renderAll();
      setBoardStatus(region + ': ' + result.entries + ' yayıncı geldi, ' + result.added + ' yenisi listeye eklendi.');
    } catch (error) {
      setBoardStatus('Tablo alınamadı: ' + error.message, true);
    }
  }

  async function pullAllBoards() {
    if (!savedKey()) {
      setBoardStatus('Önce API anahtarını kaydet.', true);
      return;
    }
    var totalAdded = 0;
    var failed = [];
    for (var i = 0; i < BOARDS.length; i += 1) {
      var region = BOARDS[i][0];
      setBoardStatus('Tüm ülkeler: ' + (i + 1) + '/' + BOARDS.length + ' · ' + region + '…');
      try {
        var result = await pullBoard(region);
        totalAdded += result.added;
      } catch (error) {
        failed.push(region);
      }
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
    }
    renderAll();
    setBoardStatus(totalAdded + ' yeni yayıncı eklendi · ' + (BOARDS.length - failed.length) + '/' + BOARDS.length +
      ' bölge okundu' + (failed.length ? ' · hata: ' + failed.join(', ') : '') + '.');
  }

  function bindKeySettings() {
    var select = $('boardRegion');
    if (select && !select.options.length) {
      select.innerHTML = BOARDS.map(function (board) {
        return '<option value="' + board[0] + '">' + esc(board[1]) + ' (' + board[0] + ')</option>';
      }).join('');
    }
    $('saveKey').addEventListener('click', saveKeyAndPull);
    $('fetchAllRegions').addEventListener('click', pullAllBoards);
  }

  function bindAppSettings() {
    if (!desktopApi) return;
    $('checkUpdates').addEventListener('click', function () {
      setUpdateStatus('Güncelleme denetleniyor…');
      desktopApi.checkUpdates().catch(function (error) {
        setUpdateStatus('Denetlenemedi: ' + esc(error.message), true);
      });
    });
    $('installUpdate').addEventListener('click', function () {
      setUpdateStatus('Güncelleme kuruluyor, uygulama yeniden başlayacak…');
      desktopApi.installUpdate();
    });
    $('autoUpdateToggle').addEventListener('change', function () {
      desktopApi.setSettings({ autoUpdate: $('autoUpdateToggle').checked });
    });
    $('scanBtn').addEventListener('click', toggleLocalScan);
    desktopApi.onUpdate(function (data) {
      var info = data || {};
      var version = info.version ? ' (v' + esc(info.version) + ')' : '';
      if (info.state === 'checking') setUpdateStatus('Güncelleme denetleniyor…');
      else if (info.state === 'available') {
        setUpdateStatus('Yeni sürüm bulundu' + version + ' — indiriliyor…');
      } else if (info.state === 'downloading') {
        setUpdateStatus('İndiriliyor' + version + ' · %' + (Number(info.percent) || 0));
      } else if (info.state === 'downloaded') {
        setUpdateStatus('Sürüm' + version + ' indirildi. Kapatınca kurulacak ya da hemen kurabilirsin.');
        $('installUpdate').classList.remove('hidden');
      } else if (info.state === 'not-available') {
        setUpdateStatus('Uygulama güncel (v' + esc(info.version || '') + ').');
      } else if (info.state === 'error') {
        setUpdateStatus('Güncelleme hatası: ' + esc(info.message || 'bilinmeyen'), true);
      }
    });
    desktopApi.onScan(function (info) { renderScanState(info); });
  }

  // Görünüm tercihleri (ülke filtresi, arama, sıralama) hem Store'a hem
  // localStorage'a yazılır: yedek dosyasına da dahil olur.
  function saveViewPrefs() {
    try {
      localStorage.setItem('tiktok-country-filter', countryFilter || '');
      if (streamerSearch) localStorage.setItem('tiktok-streamer-search', streamerSearch);
      else localStorage.removeItem('tiktok-streamer-search');
      localStorage.setItem('tiktok-streamer-sort', sortKey);
      localStorage.setItem('tiktok-streamer-sort-dir', String(sortDir));
    } catch (error) { /* depo kapalı */ }
    Store.set({
      view: { country: countryFilter || '', search: streamerSearch || '', sortKey: sortKey, sortDir: sortDir }
    });
  }

  // Yedekten gelen görünüm tercihlerini uygular. force verilmezse eski
  // sürümün localStorage kayıtları varsa onlar geçerli olur.
  function applyViewPrefs(force) {
    var view = (state && state.view) || null;
    if (!view) return false;
    var emptyView = !view.country && !view.search &&
      (!view.sortKey || view.sortKey === 'name') && Number(view.sortDir || 1) === 1;
    if (!force && emptyView) {
      var hasLegacy = localStorage.getItem('tiktok-country-filter') ||
        localStorage.getItem('tiktok-streamer-search') ||
        localStorage.getItem('tiktok-streamer-sort');
      if (hasLegacy) return false;
    }
    countryFilter = String(view.country || '').toUpperCase();
    streamerSearch = String(view.search || '');
    sortKey = String(view.sortKey || 'name');
    sortDir = Number(view.sortDir) === -1 ? -1 : 1;
    if ($('streamerSearch')) $('streamerSearch').value = streamerSearch;
    return true;
  }

  function saveSettings() {
    Store.set({
      settings: Object.assign({}, state.settings, {
        letterTtlSec: Math.max(10, Number($('letterTtl').value) || 180),
        inactiveDays: Math.max(1, Number($('inactiveDays').value) || 7),
        chestKeepMin: Math.max(0, $('chestKeepMin').value === '' ? 15 : (Number($('chestKeepMin').value) || 0)),
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

  function openQr(username, roomId) {
    var url = liveUrl(username);
    var id = roomIdOf(roomId);
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
    var apps = $('qrApps');
    if (apps) {
      apps.innerHTML = id
        ? '<div class="flex flex-col gap-1">' +
            '<a class="chip" href="' + esc(appSchemeUrl(id, 'android')) + '">🤖 Android uygulamada aç</a>' +
            '<a class="chip" href="' + esc(appSchemeUrl(id, 'ios')) + '">🍏 iPhone/iPad uygulamada aç</a>' +
            '<a class="chip" href="' + esc(androidIntentUrl(id, url)) + '">🤖 Android (uygulama yoksa web&#39;e düşer)</a>' +
            '<p class="hint">Oda kimliği: ' + esc(id) + ' · bağlantılar uygulamayı doğrudan açar.</p>' +
          '</div>'
        : '<p class="hint">Bu kayıt için oda kimliği (room_id) henüz yok. Tarama onu bulunca uygulama bağlantıları burada görünür; şimdilik web açılır.</p>';
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
      // Tarayıcı sesi ilk harekete kadar askıya alır: uyarı sessiz kalmasın.
      if (audioCtx.state === 'suspended') audioCtx.resume();
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
      var last = Math.max(
        Number(streamer.lastLiveAt) || 0,
        Number(streamer.lastBoxAt) || 0,
        Number(streamer.createdAt) || 0
      );
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
      if (!element) return;
      // Başlangıç saati TikTok'tan gelmediyse süre uydurulmaz.
      if (streamer.scanLive && !streamer.startedAt) { element.textContent = '—'; return; }
      element.textContent = clock(streamerDuration(streamer));
    });

    document.querySelectorAll('[data-countdown]').forEach(function (element) {
      var target = Number(element.getAttribute('data-countdown'));
      // Süre hiç bildirilmediyse metin olduğu gibi kalır: sayı uydurulmaz.
      if (!target) return;
      var kind = element.getAttribute('data-kind');
      var remaining = Math.max(0, Math.round((target - Date.now()) / 1000));
      if (kind === 'letter') {
        element.textContent = remaining > 0 ? 'jeton geri dönüyor: ' + clock(remaining) : 'süre doldu · jeton yayıncıya döndü';
      } else if (remaining > 0) {
        element.textContent = 'açılışa ' + clock(remaining);
      } else {
        element.textContent = kind === 'chest' ? 'açıldı · süre doldu, beklemede' : 'süre doldu';
      }
    });

    if (state.events.some(function (event) { return event.status === 'pending' && event.kind !== 'chest' && isExpired(event); })) {
      var events = state.events.map(function (event) {
        if (event.status === 'pending' && event.kind !== 'chest' && isExpired(event)) {
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
    renderMetrics();
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
    $('findLive').addEventListener('click', toggleDiscovery);
    $('scanToggle').addEventListener('click', toggleScan);
    renderScanToggle();
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
        saveViewPrefs();
        renderStreamers();
      });
    });

    $('streamerRows').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;

      if (target.dataset.toggleLive) return toggleLive(target.dataset.toggleLive);
      if (target.dataset.addEvent) return openEventModal(target.dataset.addEvent, target.dataset.kind);
      if (target.dataset.openApp) return openInApp(target.dataset.openApp, target.dataset.roomId);
      if (target.dataset.qr) return openQr(target.dataset.qr, target.dataset.roomId);
      if (target.dataset.removeStreamer) return removeStreamer(target.dataset.removeStreamer);
    });

    if ($('oppFilters')) {
      $('oppFilters').addEventListener('click', function (event) {
        var button = event.target.closest('button');
        if (!button) return;
        oppFilter = button.getAttribute('data-opp-filter') || 'all';
        renderOpportunities();
      });
    }

    $('oppSort').addEventListener('change', function () {
      oppSort = $('oppSort').value;
      renderOpportunities();
    });

    $('opportunityList').addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.collect) return collectEvent(target.dataset.collect, 'collected');
      if (target.dataset.miss) return collectEvent(target.dataset.miss, 'missed');
      if (target.dataset.openApp) return openInApp(target.dataset.openApp, target.dataset.roomId);
      if (target.dataset.qr) return openQr(target.dataset.qr, target.dataset.roomId);
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

    // Son arama kutuda ve tarayıcı deposunda durur.
    $('streamerSearch').value = streamerSearch;
    $('streamerSearch').addEventListener('input', function () {
      streamerSearch = $('streamerSearch').value;
      saveViewPrefs();
      renderStreamers();
    });

    // Ülke rozetine tıkla → listeyi o ülkeye süz; tekrar tıkla → filtre kalksın.
    $('sweepSummary').addEventListener('click', function (event) {
      var chip = event.target.closest('[data-country]');
      if (!chip) return;
      var code = chip.getAttribute('data-country') || '';
      countryFilter = (countryFilter && countryFilter === code) ? '' : code;
      saveViewPrefs();
      renderStreamers();
      renderSweepSummary();
    });

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
    bindAppSettings();
    bindKeySettings();

    // Kayıtlı görünüm tercihleri (ülke filtresi, arama, sıralama) tek tuşla silinir.
    $('resetView').addEventListener('click', function () {
      countryFilter = '';
      streamerSearch = '';
      sortKey = 'name';
      sortDir = 1;
      saveViewPrefs();
      $('streamerSearch').value = '';
      renderStreamers();
      renderSweepSummary();
      $('viewResetStatus').textContent = 'Görünüm sıfırlandı: ülke filtresi, arama ve sıralama temizlendi.';
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
          var result = Store.importJson(String(reader.result || ''));
          state = Store.get();
          // Yedekteki görünüm tercihleri de geri gelir (filtre, arama, sıralama).
          if (applyViewPrefs(true)) saveViewPrefs();
          renderAll();
          var when = '';
          if (result && result.exportedAt) {
            var stamp = new Date(result.exportedAt);
            if (!isNaN(stamp.getTime())) when = ' · ' + stamp.toLocaleString('tr-TR') + ' tarihli';
          }
          var format = (result && result.formatVersion)
            ? 'biçim v' + result.formatVersion
            : 'eski biçim (sürüm bilgisi yok)';
          alert('Yedek yüklendi · ' + format +
            (result && result.appVersion ? ' · panel v' + result.appVersion : '') + when + '.');
        } catch (error) {
          alert('Yedek yüklenmedi: ' + error.message);
        }
      };
      reader.readAsText(file);
    });
    $('clearAll').addEventListener('click', function () {
      if (!confirm('Tüm yayınlar, olaylar, hesaplar ve ajanslar silinecek. Bu işlem geri alınamaz.')) return;
      Store.clearAll();
      state = Store.get();
      // Sıfırlanan depoda görünüm de varsayılana döner.
      if (applyViewPrefs(true)) saveViewPrefs();
      $('streamerSearch').value = streamerSearch;
      renderAll();
    });
  }

  async function boot() {
    await Store.ready();
    state = Store.get();

    migrateEvents();

    // Görünüm tercihleri Store'dan (yedeğe dahil) gelir; eski sürümlerde
    // yalnızca localStorage'da tutuluyordu, o değerler bir kez Store'a taşınır.
    if (!applyViewPrefs()) saveViewPrefs();

    Store.subscribe(function (next) { state = next; });

    $('streamerCountry').innerHTML = optionsHtml(true);
    bind();
    renderAll();
    switchTab('hunt');
    pruneInactive();
    refreshScan();
    setInterval(tick, 1000);
    setInterval(function () { if (!scanPaused) refreshScan(); }, 30000);
    // Kutular ayrı ve sık okunur: sandık penceresi kaçmasın.
    refreshBoxes();
    setInterval(refreshBoxes, 15000);
    // Ölçüm dosyası saatlik güncellenir: 5 dakikada bir okumak yeter.
    refreshMetrics();
    setInterval(refreshMetrics, 300000);
    startBoxStream();

    // Bildirim izni: açılışta denenir, tarayıcı isterse ilk tıklamada tekrar sorulur.
    ensureNotifyPermission();
    renderNotifyState();
    document.addEventListener('pointerdown', function () {
      ensureNotifyPermission();
      renderNotifyState();
    }, { once: true });
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
