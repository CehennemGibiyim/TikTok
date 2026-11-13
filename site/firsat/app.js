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
  // SSE bağlantısının anlık durumu; sayaçlar settings.boxStream'de kalıcı.
  var streamConnected = false;
  // Panelin bu sayfa oturumunun başlangıcı: teslim tabanı hesaplanırken yalnızca
  // bu andan sonra üretilmiş kutular "ilk görülen" sayılır. Böylece panel
  // kapalıyken üretilmiş eski kutular oranı yanlışlıkla düşürmez.
  var PANEL_SESSION_AT = Date.now();
  // Görünürlük aralıkları: sekme görünürken geçen süreyi ve kutunun geldiği
  // anda panelin görünür olup olmadığını aynı gerçek zaman çizgisinde tutar.
  var VISIBILITY_PRUNE_MS = 7 * 24 * 3600 * 1000;
  var visibilitySavedAt = 0;
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

  // sessionSec'i tam saniyeye çevirir; yok/bozuksa null döner. Number(null) 0
  // olduğu için bilinmeyen değer burada açıkça ayıklanır.
  function sessionSeconds(value) {
    if (value === null || value === undefined || value === '') return null;
    var sec = Math.round(Number(value));
    return Number.isFinite(sec) && sec >= 0 ? sec : null;
  }

  // Kutunun düştüğü oturum dakikası: 0–59 sn "1. dk", 60–119 sn "2. dk" …
  // 5. dakikadan sonrası ölçümdeki gibi tek "5+ dk" kovasında toplanır.
  function sessionMinuteLabel(seconds) {
    var sec = sessionSeconds(seconds);
    if (sec === null) return null;
    var minute = Math.floor(sec / 60) + 1;
    return minute >= 6 ? '5+ dk' : minute + '. dk';
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
    if (tab === 'metrics') { refreshMetrics(); renderFunnel(); renderDelivery(); }
    if (tab === 'opportunities') renderOpportunities();
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
  function mergeBoxItems(items, streamers, events, source, runId) {
    var byName = {};
    streamers.forEach(function (streamer) { byName[cleanUsername(streamer.username)] = streamer; });
    var known = {};
    events.forEach(function (event) { if (event.scanId) known[event.scanId] = event; });
    var fresh = [];
    var changed = false;

    (items || []).forEach(function (item) {
      if (!item || !item.id) return;
      if (item.kind && ['chest', 'portal', 'letter'].indexOf(item.kind) === -1) return;
      var existing = known[item.id];
      if (existing) {
        // Aynı kutu ikinci kanaldan da geldiyse tekil kayıt korunur; yalnızca
        // hangi kanallardan geldiği işaretlenir. Aynı kanalın tekrar okunması
        // (15 sn'lik dosya yoklaması) dedupe sayılmaz.
        var via = Array.isArray(existing.via) ? existing.via.slice() : [];
        if (source && via.indexOf(source) === -1) {
          via.push(source);
          existing.via = via;
          changed = true;
        }
        if (!Number(existing.seq) && Number(item.seq)) {
          existing.seq = Number(item.seq);
          changed = true;
        }
        if (!Number(existing.scanRunId) && (Number(item.runId) || Number(runId))) {
          existing.scanRunId = Number(item.runId || runId) || 0;
          changed = true;
        }
        if (existing.arrivedVisible === undefined || existing.arrivedVisible === null) {
          var arrived = wasPanelVisibleAt(Number(existing.createdAt) || 0);
          if (arrived !== null) {
            existing.arrivedVisible = arrived;
            changed = true;
          }
        }
        return;
      }
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
      var eventCreatedAt = Number(item.t) || Date.now();
      var event = {
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
        // Görülme (huni) alanı: kutu Fırsatlar listesinde çizilince doldurulur.
        seenAt: 0,
        createdAt: eventCreatedAt,
        scanId: item.id,
        auto: true,
        giftName: item.boxName || item.giftName || '',
        boxName: item.boxName || item.giftName || '',
        businessType: Number(item.businessType) || 0,
        boxType: item.boxType || '',
        senderName: item.senderName || item.sender || '',
        // Kutunun düştüğü oturum saniyesi (tarayıcı bilmiyorsa null).
        sessionSec: item.sessionSec === null || item.sessionSec === undefined
          ? null : Math.max(0, Number(item.sessionSec) || 0),
        // Teslim ölçümü: aynı kutunun sırası, koşusu ve bu cihazda hangi
        // kanallardan geldiği. Bunlar yalnızca gerçek kayıtlardan gelir.
        seq: Number(item.seq) || 0,
        scanRunId: Number(item.runId || runId) || 0,
        receivedAt: Date.now(),
        via: source ? [source] : [],
        // Kutu gerçekten geldiği anda panel görünür müydü? Görünürlük kaydı
        // başlamadan önceki kutularda null kalır; bu değer uydurulmaz.
        arrivedVisible: wasPanelVisibleAt(eventCreatedAt)
      };
      known[item.id] = event;
      events.unshift(event);
      changed = true;
      fresh.push(username);
    });

    return { changed: changed, fresh: fresh };
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

    if (mergeBoxItems(data.events, streamers, events, 'live', runId).changed) changed = true;

    if (changed) {
      Store.set({ streamers: streamers, events: events, settings: settings });
      state = Store.get();
    }
    return changed;
  }

  // Hızlı kutu kanalı: tarayıcı kutuları ayrı ve küçük bir dosyaya yazıp sık
  // commit ediyor; panel bunu 15 saniyede bir okur. Böylece sandık, 5 dakikalık
  // tarama commit'ini beklemeden Fırsatlar'a düşer (yakalama penceresi kısa).
  function applyBoxes(boxes, source, runId) {
    if (!Array.isArray(boxes) || !boxes.length) return false;
    var streamers = state.streamers.slice();
    var events = state.events.slice();
    var merged = mergeBoxItems(boxes, streamers, events, source || 'file', runId);
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

  // SSE açılma/kopma sayaçları yalnızca EventSource'un gerçek olaylarıyla
  // artar; yeniden bağlanma sayısı ilk açılmadan sonraki açılmalardır.
  function noteBoxStream(kind) {
    var settings = Object.assign({}, state.settings || {});
    var stream = Object.assign({
      opens: 0, errors: 0, reconnects: 0, lastOpenAt: 0, lastErrorAt: 0
    }, settings.boxStream || {});
    var now = Date.now();
    if (kind === 'open') {
      if (Number(stream.opens) > 0) stream.reconnects = (Number(stream.reconnects) || 0) + 1;
      stream.opens = (Number(stream.opens) || 0) + 1;
      stream.lastOpenAt = now;
      streamConnected = true;
    } else {
      stream.errors = (Number(stream.errors) || 0) + 1;
      stream.lastErrorAt = now;
      streamConnected = false;
    }
    settings.boxStream = stream;
    Store.set({ settings: settings });
    state = Store.get();
    renderDelivery();
  }

  // Saniyeler içinde gelen kutular (ntfy.sh SSE). Koparsa dosya yolu devrede.
  function startBoxStream() {
    if (typeof EventSource !== 'function') return;
    try {
      var source = new EventSource('https://ntfy.sh/' + BOX_TOPIC + '/sse');
      source.onopen = function () { noteBoxStream('open'); };
      source.onerror = function () { noteBoxStream('error'); };
      source.addEventListener('message', function (message) {
        try {
          var parsed = JSON.parse(message.data || '{}');
          if (parsed.event && parsed.event !== 'message') return;
          var box = parsed.message ? JSON.parse(parsed.message) : parsed;
          // Anahtarsız/yanlış anahtarlı mesaj sahte olabilir: yok sayılır.
          if (!box || box.key !== BOX_KEY) return;
          if (box.username && box.id) applyBoxes([box], 'ntfy', box.runId || (scanInfo && scanInfo.runId));
        } catch (error) { /* bozuk mesaj yok sayılır */ }
      });
    } catch (error) { /* akış yoksa 15 sn'lik dosya okuması devrede */ }
  }

  async function refreshBoxes() {
    if (scanPaused) return;
    try {
      var data = await fetchScanData(boxesUrl);
      if (data && Array.isArray(data.boxes)) applyBoxes(data.boxes, 'file', data.runId);
    } catch (error) {
      try {
        var backup = await fetchScanData(boxesFallback);
        if (backup && Array.isArray(backup.boxes)) applyBoxes(backup.boxes, 'file', backup.runId);
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
      // connectBudget devrede olmayanı 0 bildirir; panel karşılaştırma yapmaz.
      var learnedHour = Number(budget.learnedLimit) || 0;
      if (learnedHour > 0) {
        var configuredHour = Number(budget.configured) || limitHour;
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
    renderBoxMinutes();
    renderDelivery();
    renderHealth();
  }

  async function refreshScan() {
    if (scanPaused) { renderScanStatus(); return; }
    try {
      var data = await fetchScanData(scanUrl);
      scanInfo = Object.assign({ scannedAt: data.scannedAt }, data.scanner || {});
      ensureDeliveryRun();
      if (applyScan(data)) renderAll();
      renderScanStatus();
    } catch (error) {
      // Ham dosya okunamazsa (ağ/CORS) Pages kopyası denenir.
      try {
        var backup = await fetchScanData(scanFallback);
        scanInfo = Object.assign({ scannedAt: backup.scannedAt }, backup.scanner || {});
        ensureDeliveryRun();
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
    // Duraklatınca renderScanStatus erken döner; satırı yine de temizle.
    if (scanPaused) renderHealth();
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
    markFunnelSeen();
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
      // Ölçümün ham verisi günlük kullanımda görünsün: kutunun düştüğü oturum
      // dakikası. Eski/oturum dışı kutularda sessionSec yoktur; uydurma değer
      // yerine bunu açıkça "dk —" olarak yazar.
      var sessionSec = sessionSeconds(event.sessionSec);
      var sessionMinute = sessionMinuteLabel(sessionSec);
      var sessionBadge = sessionMinute
        ? '<span class="chip !py-0 !text-[10px]" title="Kutu, dinleme oturumunun ' +
          Math.round(sessionSec) + '. saniyesinde düştü · ölçüm kovası ' +
          (Math.floor(sessionSec / 60) >= 5 ? '5+ dk' : Math.floor(sessionSec / 60) + '–' +
            (Math.floor(sessionSec / 60) + 1) + ' dk') +
          '">⏱ ' + sessionMinute + '</span> '
        : '<span class="chip !py-0 !text-[10px] opacity-60" title="Oturum dakikası bilinmiyor (eski kayıt veya oturum dışı kutu)">⏱ dk —</span> ';
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
        '  <div class="text-[10px] mb-1">' + publisherNote + sessionBadge + '<span class="chip !py-0 !text-[10px]" title="aciliyet + jeton + paylaşım + tür + tazelik">Puan ' + scored.score + ' · ' + esc(scored.reason) + '</span></div>',
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
    renderHealth();
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
      renderDelivery();
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

    renderDelivery();
    if (window.lucide) lucide.createIcons();
  }

  // ---------- Kutu teslimi ----------
  // Tarayıcı her gerçek kutuya koşu içinde artan bir sıra numarası verir
  // (seq). Panel aynı sıraları kendi yerel olaylarında görür; böylece
  // "üretilen" ile "panele ulaşan tekil" aynı kümede karşılaştırılır.
  // Panel ilk kez hangi sırada görürse o sıra taban olur: panel kapalıyken
  // üretilen eski kutular teslim oranını yanlışlıkla düşürmez.

  function ensureDeliveryRun() {
    if (!scanInfo) return;
    var d = scanInfo.delivery;
    var runId = Number(scanInfo.runId || (d && d.runId) || 0);
    if (!runId || !d) return;
    var settings = Object.assign({}, state.settings || {});
    var box = settings.boxDelivery || {};
    if (Number(box.runId) !== runId) {
      var lastSeq = Number(d.lastSeq) || 0;
      var firstSeen = 0;
      state.events.forEach(function (event) {
        if (!event.auto || Number(event.scanRunId) !== runId) return;
        if (Number(event.createdAt) < PANEL_SESSION_AT) return;
        var seq = Number(event.seq) || 0;
        if (seq > 0 && (!firstSeen || seq < firstSeen)) firstSeen = seq;
      });
      // Koşu başladığında panel zaten açıksa bütün koşu sayılır (taban 0).
      // Panel koşudan sonra açıldıysa o anki son sıra tabandır; yalnızca ilk
      // okumadan önce bu oturumda görülen bir kutu varsa taban onun bir eksiğine
      // çekilir, böylece ilk kutu sessizce dışlanmaz.
      var baseSeq = PANEL_SESSION_AT <= runId
        ? 0
        : (firstSeen ? Math.min(lastSeq, firstSeen - 1) : lastSeq);
      settings.boxDelivery = {
        runId: runId,
        baseSeq: baseSeq,
        since: Date.now()
      };
      Store.set({ settings: settings });
      state = Store.get();
    }
  }

  function deliveryStats() {
    if (!scanInfo) return { error: 'Canlı tarayıcı verisi okunamadı.' };
    var d = scanInfo.delivery;
    var runId = Number(scanInfo.runId || (d && d.runId) || 0);
    if (!d || !runId) {
      return { error: 'Tarayıcı teslim sayaçlarını yayınlamıyor; bu sürümde ölçüm yok.' };
    }
    var box = (state.settings && state.settings.boxDelivery) || {};
    if (Number(box.runId) !== runId) {
      return { error: 'Bu koşu için panel izleme başlangıcı yok; bir sonraki tarama okumasında kurulur.' };
    }
    var baseSeq = Math.max(0, Number(box.baseSeq) || 0);
    var lastSeq = Math.max(0, Number(d.lastSeq) || 0);
    if (baseSeq > lastSeq) {
      return { error: 'Kutu sırası sıfırlandı; teslim ölçümü bu koşu için hesaplanamıyor.' };
    }

    var produced = Math.max(0, lastSeq - baseSeq);
    var received = {};
    var ntfyOnly = 0;
    var pollOnly = 0;
    var both = 0;
    var channelUnknown = 0;
    state.events.forEach(function (event) {
      if (!event.auto) return;
      var seq = Number(event.seq) || 0;
      if (!seq || seq <= baseSeq || seq > lastSeq) return;
      if (Number(event.scanRunId) !== runId) return;
      if (received[seq]) return;
      received[seq] = true;
      var via = Array.isArray(event.via) ? event.via : [];
      var hasNtfy = via.indexOf('ntfy') !== -1;
      var hasPoll = via.indexOf('file') !== -1 || via.indexOf('live') !== -1;
      if (hasNtfy && hasPoll) both += 1;
      else if (hasNtfy) ntfyOnly += 1;
      else if (hasPoll) pollOnly += 1;
      else channelUnknown += 1;
    });

    var reachedIds = Object.keys(received).length;
    var reached = Math.min(produced, reachedIds);
    var gap = Math.max(0, produced - reached);
    var failed = {};
    (d.ntfyFailSeqs || []).forEach(function (seq) { failed[Number(seq)] = true; });
    var fileFrom = Number(d.fileFromSeq) || 0;
    var boxTimes = Array.isArray(d.boxTimes) ? d.boxTimes : [];
    var ntfyGap = 0;
    var fileGap = 0;
    var panelGap = 0;
    var panelClosedGap = 0;
    for (var seq = baseSeq + 1; seq <= lastSeq; seq += 1) {
      if (received[seq]) continue;
      // Öncelik gerçek yayın hatasında: başarısız ntfy denemesi kayıtlıysa
      // kutu dosyada olsa bile "ntfy hatası" olarak ayrılır. Dosya penceresi
      // yalnızca ntfy hatası olmayan eski sıralar için ayrı sayılır.
      if (failed[seq]) ntfyGap += 1;
      else if (fileFrom > 0 && seq < fileFrom) fileGap += 1;
      else if (wasPanelVisibleAt(Number(boxTimes[seq - 1]) || 0) === false) panelClosedGap += 1;
      else panelGap += 1;
    }

    var stream = (state.settings && state.settings.boxStream) || {};
    return {
      runId: runId,
      baseSeq: baseSeq,
      lastSeq: lastSeq,
      produced: produced,
      reached: reached,
      rate: produced ? reached / produced : null,
      gap: gap,
      ntfyGap: ntfyGap,
      fileGap: fileGap,
      panelGap: panelGap,
      panelClosedGap: panelClosedGap,
      ntfyOnly: ntfyOnly,
      pollOnly: pollOnly,
      both: both,
      channelUnknown: channelUnknown,
      dedupe: both,
      scannerDuplicate: Number(d.duplicate) || 0,
      ntfyAttempts: Number(d.ntfyAttempts) || 0,
      ntfyOk: Number(d.ntfyOk) || 0,
      ntfyFail: Number(d.ntfyFail) || 0,
      fileFrom: fileFrom,
      fileSeqCount: Number(d.fileSeqCount) || 0,
      fileCap: Number(d.fileCap) || 120,
      sseOpens: Number(stream.opens) || 0,
      sseErrors: Number(stream.errors) || 0,
      sseReconnects: Number(stream.reconnects) || 0,
      sseLastErrorAt: Number(stream.lastErrorAt) || 0,
      sseConnected: streamConnected,
      since: Number(box.since) || 0
    };
  }

  function renderDelivery() {
    var summary = $('deliverySummary');
    if (!summary) return;
    var breakdown = $('deliveryBreakdown');
    var note = $('deliveryNote');
    var stamp = $('deliveryUpdated');
    var s = deliveryStats();
    if (s.error) {
      summary.innerHTML = '<div class="empty-state col-span-2 lg:col-span-4">' + esc(s.error) + '</div>';
      breakdown.innerHTML = '';
      note.textContent = '';
      if (stamp) stamp.textContent = 'son koşu';
      return;
    }

    var rateText = s.rate === null ? '—' : '%' + Math.round(s.rate * 100);
    var rateColor = s.rate === null ? 'text-yellow-50/40' : (s.rate < 0.9 ? 'text-red-300' : 'text-green-300');
    if (stamp) {
      stamp.textContent = (scanInfo && scanInfo.scannedAt
        ? 'son koşu · ' + new Date(scanInfo.scannedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        : 'son koşu') + ' · panel ' + (s.since ? new Date(s.since).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—') + '’den beri';
    }

    var cards = [
      ['Üretilen', fmt(s.produced), 'text-amber-300',
        'tarayıcının bu koşuda yazdığı tekil kutu'],
      ['Panele ulaşan', fmt(s.reached), 'text-sky-300',
        s.channelUnknown ? s.channelUnknown + ' kutunun kanalı bilinmiyor' : 'tekil kutu (dedupe sonrası)'],
      ['Teslim oranı', rateText, rateColor,
        s.produced ? 'ulaşan ÷ üretilen' : 'bu aralıkta üretim yok'],
      ['SSE yeniden bağlanma', fmt(s.sseReconnects), 'text-purple-300',
        fmt(s.sseErrors) + ' kopma · ' + (s.sseConnected ? 'şu an açık' : 'şu an kapalı')]
    ];
    summary.innerHTML = cards.map(function (card) {
      return '<div class="card p-4"><div class="stat-label">' + esc(card[0]) + '</div>' +
        '<div class="stat-value ' + card[2] + '">' + card[1] + '</div>' +
        '<div class="text-[10px] text-yellow-50/40 mt-1">' + esc(card[3]) + '</div></div>';
    }).join('');

    var rows = [
      ['ntfy hatası', s.ntfyGap, 'yayın başarısız; kutu panelde yok', 'text-red-300'],
      ['Panel kapalı', s.panelClosedGap, 'panel görünmezken üretilen kutu', 'text-sky-300'],
      ['SSE / diğer', s.panelGap, 'ntfy başarılı ama kutu bu panelde yok', 'text-amber-300'],
      ['boxes.json 120', s.fileGap, 'kutu dosya penceresinin dışında', 'text-orange-300'],
      ['Dedupe', s.dedupe, 'aynı kutu iki kanaldan; tekil sayıldı', 'text-sky-300']
    ];
    breakdown.innerHTML = '<div class="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-yellow-50/40">' +
      '<span class="flex-1">farkın ayrımı</span><span class="w-12 text-right">kutu</span></div>' +
      '<div class="space-y-1 mt-1">' + rows.map(function (row) {
        return '<div class="flex items-center gap-2 rounded px-1 py-1 text-[11px] hover:bg-white/5">' +
          '<span class="flex-1 text-yellow-100">' + esc(row[0]) +
          '<span class="block text-[10px] text-yellow-50/40">' + esc(row[2]) + '</span></span>' +
          '<span class="w-12 text-right font-mono ' + row[3] + '">' + fmt(row[1]) + '</span></div>';
      }).join('') + '</div>';

    var lines = [];
    if (!s.produced) {
      lines.push('Panel bu koşuda izlemeye başladıktan sonra henüz kutu üretilmedi.');
    } else if (!s.gap) {
      lines.push('Bu aralıkta üretilen her tekil kutu panele ulaştı.');
    } else {
      lines.push('Fark ' + fmt(s.gap) + ' kutu: ntfy hatası ' + fmt(s.ntfyGap) +
        ' · panel kapalı ' + fmt(s.panelClosedGap) + ' · SSE/diğer ' + fmt(s.panelGap) +
        ' · boxes.json 120 ' + fmt(s.fileGap) + '.');
    }
    if (s.produced) {
      lines.push('Sıra aralığı: ' + fmt(s.baseSeq + 1) + '–' + fmt(s.lastSeq) + ' (taban ' + fmt(s.baseSeq) + ').');
    }
    lines.push('Kanallar: ntfy ' + fmt(s.ntfyOnly) + ' tekil · dosya ' + fmt(s.pollOnly) +
      ' tekil · ikisi ' + fmt(s.both) + '.');
    if (s.ntfyAttempts) {
      lines.push('ntfy: ' + fmt(s.ntfyOk) + '/' + fmt(s.ntfyAttempts) + ' başarılı' +
        (s.ntfyFail ? ' · ' + fmt(s.ntfyFail) + ' hata' : '') + '.');
    } else {
      lines.push('ntfy bu koşuda kapalıydı; kutu yalnız dosya yolundan geldi.');
    }
    lines.push('Dosya penceresi: son ' + fmt(s.fileSeqCount) + '/' + fmt(s.fileCap) +
      ' kutu' + (s.fileFrom ? ' (en eski sıra ' + fmt(s.fileFrom) + ')' : '') + '.');
    if (s.scannerDuplicate) {
      lines.push('Tarayıcı aynı kutu bildirimini ' + fmt(s.scannerDuplicate) + ' kez tekilleştirdi; bunlar üretilen sayısına girmez.');
    }
    if (s.ntfyFail > 400) {
      lines.push('ntfy hata sıralarının yalnız son 400’ü taşınıyor; daha eski hatalar “SSE / panel” ya da “boxes.json 120” satırına düşebilir.');
    }
    if (!s.sseConnected) {
      lines.push('SSE şu an kapalı; panel 15 saniyelik dosya okumasına düşüyor. Bu sırada gelen kutular dosya penceresine sığmazsa fark büyür.');
    }
    if (s.sseLastErrorAt) {
      lines.push('Son SSE kopması: ' + new Date(s.sseLastErrorAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) + '.');
    }
    lines.push('SSE sayaçları bu cihazda birikir. Panel kapalıyken gelen kutu dosya penceresinde hâlâ varsa “SSE / panel”, pencereden çıkmışsa “boxes.json 120” satırına yazılır; kayıp nedeni uydurulmaz.');
    note.textContent = lines.join(' ');
    if (window.lucide) lucide.createIcons();
  }

  // ---------- Kutu hunisi (cihazda) ----------
  // Tarayıcıdan gelen kutuların cihazdaki yolculuğu: kutu → görüldü →
  // toplandı / kaçtı. Kullanıcı işaretlemeleri yalnızca bu cihazda olduğu için
  // hesap burada yapılır (metrics.json'a yazılmaz). Kapsam: son 7 gün.

  var FUNNEL_WINDOW_MS = 7 * 24 * 3600 * 1000;

  // Huniye giren kutu: tarayıcıdan gelen sandık/portal/zarf. Elle eklenen
  // kayıtlar ve yayıncıya atılan sıradan hediyeler hunide yok.
  function isFunnelBox(event) {
    return Boolean(event.auto) && isOpportunity(event);
  }

  // “Görüldü” = panel görünürken kutu Fırsatlar sekmesinde bekliyordu. Sayfa arka
  // plandayken gelen kutu, sekme açılana kadar görülmüş sayılmaz; böylece “panel kutu
  // kaçırdı mı” sorusu ölçülebilir olur.
  function isFunnelPending(event) {
    return isFunnelBox(event) && event.status === 'pending' && !isExpired(event);
  }

  function markFunnelSeen() {
    if (document.visibilityState !== 'visible') return;
    var view = $('view-opportunities');
    if (!view || view.classList.contains('hidden')) return;
    var now = Date.now();
    var changed = false;
    var events = state.events.map(function (event) {
      if (!isFunnelPending(event) || Number(event.seenAt) > 0) return event;
      changed = true;
      return Object.assign({}, event, { seenAt: now });
    });
    if (!changed) return;
    Store.set({ events: events });
    state = Store.get();
  }

  // Görülme kaydı bu sürümle başladı: ondan önceki kutular “görülmedi” sayılmasın.
  function funnelSince() {
    return Math.max(Date.now() - FUNNEL_WINDOW_MS, Number(state.settings && state.settings.funnelSeenSince) || 0);
  }

  // Görülen kutunun sonucu: toplandı, kaçtı ya da hâlâ açık. Tek sınıflandırma, kartlarla
  // saat dağılımının aynı tanımı kullanmasını sağlar.
  function funnelOutcome(event) {
    if (event.status === 'collected') return Number(event.collectedAt) > 0 ? 'collected' : null;
    if (event.status === 'pending') return isExpired(event) ? 'missed' : 'open';
    if (event.status === 'missed' || event.status === 'expired') return 'missed';
    return null;
  }

  // ---------- Panel görünürlüğü ----------
  // Sekme görünürken geçen aralıklar cihazda tutulur. Bir kutunun geliş anı
  // bu aralıklardan birine düşüyorsa panel o anda görünürdü; düşmüyorsa
  // kapalıydı. Kayıt başlamadan önceki kutularda değer null (bilinmiyor) kalır.

  function visibilityData() {
    if (!state || !state.settings) return null;
    var vis = state.settings.visibility;
    return vis && typeof vis === 'object' ? vis : null;
  }

  function closeOpenVisibility(vis, at) {
    if (!vis || !Array.isArray(vis.intervals)) return;
    for (var i = vis.intervals.length - 1; i >= 0; i -= 1) {
      var interval = vis.intervals[i];
      if (Number(interval.to) > 0) continue;
      interval.to = Math.max(Number(interval.from) || 0, at);
      return;
    }
  }

  function visibilityEnd(interval, now) {
    var to = Number(interval.to) || 0;
    if (to > 0) return to;
    var vis = visibilityData();
    if (vis && vis.visible) return now;
    return Math.min(now, Number(vis && vis.lastTickAt) || Number(interval.from) || 0);
  }

  function wasPanelVisibleAt(timestamp) {
    var at = Number(timestamp) || 0;
    var vis = visibilityData();
    if (!vis || !Array.isArray(vis.intervals) || !at) return null;
    var now = Date.now();
    // Gelecekten gelen damga (saat kayması) kapalı sanılmasın: şimdiki anı sor.
    if (at > now) at = now;
    // since=0 yedeği eski bir sürümden gelmiş olabilir; o durumda hangi
    // kutunun görünürlükle çakıştığını bilmiyoruz, "kapalıydı" demeyiz.
    if (!Number(vis.since) || at < Number(vis.since)) return null;
    for (var i = 0; i < vis.intervals.length; i += 1) {
      var interval = vis.intervals[i];
      var from = Number(interval.from) || 0;
      if (!from || at < from) continue;
      if (at <= visibilityEnd(interval, now)) return true;
    }
    return false;
  }

  function normalizeVisibility(raw, now) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var since = Number(source.since) || now;
    var lastTick = Number(source.lastTickAt) || 0;
    var intervals = [];
    (Array.isArray(source.intervals) ? source.intervals : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var from = Number(item.from) || 0;
      var to = Number(item.to) || 0;
      if (!from || from > now + 60000) return;
      if (to && to <= from) return;
      intervals.push({ from: from, to: to });
    });
    intervals.sort(function (a, b) { return a.from - b.from; });
    // Önceki oturum kapanırken yazılamadıysa açık aralığı son örnek anında kapat:
    // panelin kapalı olduğu saatleri görünür süreye eklemeyiz.
    intervals.forEach(function (item) {
      if (Number(item.to) > 0) return;
      item.to = Math.max(item.from, Math.min(now, lastTick || item.from));
    });
    var cut = now - VISIBILITY_PRUNE_MS;
    intervals = intervals.filter(function (item) { return item.to > item.from && item.to > cut; })
      .map(function (item) { return { from: Math.max(item.from, cut), to: item.to }; });
    // Çakışan aralıkları birleştir; aynı süre iki kez sayılmasın.
    var merged = [];
    intervals.forEach(function (item) {
      var last = merged[merged.length - 1];
      if (!last || item.from > last.to) merged.push(item);
      else last.to = Math.max(last.to, item.to);
    });
    if (merged.length > 2000) merged = merged.slice(-2000);
    return { since: since, intervals: merged, lastTickAt: lastTick, visible: false };
  }

  function persistVisibility(force) {
    var vis = visibilityData();
    if (!vis) return;
    var now = Date.now();
    vis.lastTickAt = now;
    var settings = Object.assign({}, state.settings || {});
    settings.visibility = vis;
    Store.set({ settings: settings });
    state = Store.get();
    visibilitySavedAt = now;
    if (force && Store.flush) Store.flush();
  }

  function sampleVisibility() {
    var vis = visibilityData();
    if (!vis) return;
    var now = Date.now();
    var visible = document.visibilityState === 'visible';
    var wasVisible = vis.visible;
    if (!Number(vis.since)) vis.since = now;
    if (visible) {
      if (!vis.visible) {
        closeOpenVisibility(vis, now);
        vis.intervals.push({ from: now, to: 0 });
        vis.visible = true;
      } else {
        var last = vis.intervals[vis.intervals.length - 1];
        var lastTick = Number(vis.lastTickAt) || now;
        if (!last || Number(last.to) > 0) {
          vis.intervals.push({ from: now, to: 0 });
        } else if (now - lastTick > 5000) {
          // Uyku/askıya alma boşluğu görünür süreye yazılmasın.
          last.to = Math.max(Number(last.from) || lastTick, lastTick);
          vis.intervals.push({ from: now, to: 0 });
        }
      }
      vis.lastTickAt = now;
    } else if (vis.visible) {
      closeOpenVisibility(vis, now);
      vis.visible = false;
      vis.lastTickAt = now;
    }
    // Sekme kapanıp açılırken aralık sınırını hemen yaz; 10 saniyelik
    // gecikme, sayfa bu arada kapanırsa görünür süreyi kaybettirebilir.
    if (visible !== wasVisible) persistVisibility(true);
    else if (visible && now - visibilitySavedAt >= 10000) persistVisibility(false);
  }

  function endVisibilitySession() {
    var vis = visibilityData();
    if (!vis) return;
    var now = Date.now();
    closeOpenVisibility(vis, now);
    vis.visible = false;
    vis.lastTickAt = now;
    persistVisibility(true);
  }

  function startVisibilityTracking() {
    var now = Date.now();
    var settings = Object.assign({}, state.settings || {});
    settings.visibility = normalizeVisibility(settings.visibility, now);
    Store.set({ settings: settings });
    state = Store.get();
    visibilitySavedAt = now;
    sampleVisibility();
    document.addEventListener('visibilitychange', sampleVisibility);
    window.addEventListener('pagehide', endVisibilitySession);
    window.addEventListener('pageshow', sampleVisibility);
    setInterval(sampleVisibility, 1000);
  }

  function visibleMsBetween(from, to) {
    var vis = visibilityData();
    if (!vis || !Array.isArray(vis.intervals)) return 0;
    var now = Date.now();
    var total = 0;
    vis.intervals.forEach(function (interval) {
      var start = Number(interval.from) || 0;
      var end = visibilityEnd(interval, now);
      if (!start || !end || end <= start) return;
      var a = Math.max(start, from);
      var b = Math.min(end, to);
      if (b > a) total += b - a;
    });
    return total;
  }

  function funnelStats() {
    var since = funnelSince();
    var now = Date.now();
    var visibleMinutes = visibleMsBetween(since, now) / 60000;
    var boxes = 0;
    var seen = 0;
    var collected = 0;
    var missed = 0;
    var open = 0;
    var visibleBoxes = 0;
    var closedBoxes = 0;
    var unknownBoxes = 0;
    var unseenClosed = 0;
    var unseenVisible = 0;
    var unseenUnknown = 0;
    var visibleSeen = 0;
    var visibleCollected = 0;
    var reactions = [];
    var hours = [];
    var kinds = {};
    var days = [];
    var dayMap = {};
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    for (var hour = 0; hour < 24; hour += 1) hours.push(0);
    Object.keys(KINDS).forEach(function (kind) {
      kinds[kind] = { boxes: 0, seen: 0, missed: 0, reactions: [] };
    });
    // Üstteki toplamla aynı 7 günlük pencereyi kapsayan takvim günleri. Pencere
    // bir günün ortasında başlayabildiği için en eski gün de kısmi (*) olabilir;
    // bu satır, toplam kutu sayısının gün satırlarıyla toplanabilmesini sağlar.
    // Kayıt başlangıcından tamamen önceki günler boş satır olarak görünmesin diye
    // düşürülür. Gün, kutunun geldiği yerel tarihtir.
    for (var back = 7; back >= 0; back -= 1) {
      var start = new Date(today);
      start.setDate(today.getDate() - back);
      var next = new Date(start);
      next.setDate(start.getDate() + 1);
      if (next.getTime() <= since) continue;
      var day = { start: start.getTime(), boxes: 0, seen: 0, collected: 0 };
      days.push(day);
      dayMap[day.start] = day;
    }

    state.events.forEach(function (event) {
      if (!isFunnelBox(event) || Number(event.createdAt) < since) return;
      boxes += 1;
      // Kutu gerçekten geldiğinde panel görünür müydü? Üç durum ayrı tutulur:
      // görünür, kapalı, bu görünürlük kaydından önce (bilinmiyor).
      var arrival = event.arrivedVisible;
      if (arrival === true) visibleBoxes += 1;
      else if (arrival === false) closedBoxes += 1;
      else unknownBoxes += 1;
      var kind = kinds[event.kind];
      if (kind) kind.boxes += 1;
      var eventDay = new Date(Number(event.createdAt));
      eventDay.setHours(0, 0, 0, 0);
      var day = dayMap[eventDay.getTime()];
      if (day) day.boxes += 1;
      if (Number(event.seenAt) <= 0) {
        if (arrival === true) unseenVisible += 1;
        else if (arrival === false) unseenClosed += 1;
        else unseenUnknown += 1;
        return;
      }
      seen += 1;
      if (arrival === true) visibleSeen += 1;
      if (kind) kind.seen += 1;
      if (day) day.seen += 1;
      var outcome = funnelOutcome(event);
      if (outcome === 'open') {
        open += 1;
      } else if (outcome === 'missed') {
        missed += 1;
        if (kind) kind.missed += 1;
        hours[new Date(Number(event.createdAt)).getHours()] += 1;
      } else if (outcome === 'collected') {
        collected += 1;
        if (arrival === true) visibleCollected += 1;
        if (day) day.collected += 1;
        var diff = Number(event.collectedAt) - Number(event.seenAt);
        if (diff >= 0 && diff <= FUNNEL_WINDOW_MS) {
          reactions.push(diff);
          if (kind) kind.reactions.push(diff);
        }
      }
    });

    Object.keys(kinds).forEach(function (kind) {
      var kindReactions = kinds[kind].reactions;
      kindReactions.sort(function (a, b) { return a - b; });
      kinds[kind].median = kindReactions.length
        ? kindReactions[Math.floor(kindReactions.length / 2)]
        : null;
      delete kinds[kind].reactions;
    });
    reactions.sort(function (a, b) { return a - b; });
    return {
      since: since,
      boxes: boxes,
      seen: seen,
      collected: collected,
      missed: missed,
      open: open,
      // Görülenler içinde toplanma oranı; görülen yoksa bilinmiyor.
      conversion: seen ? collected / seen : null,
      median: reactions.length ? reactions[Math.floor(reactions.length / 2)] : null,
      // Maruz kalma: yalnızca panel görünürken gelen kutular.
      visibleBoxes: visibleBoxes,
      closedBoxes: closedBoxes,
      unknownBoxes: unknownBoxes,
      visibleCollected: visibleCollected,
      visibleDetection: visibleBoxes ? visibleSeen / visibleBoxes : null,
      exposureConversion: visibleBoxes ? visibleCollected / visibleBoxes : null,
      unseenClosed: unseenClosed,
      unseenVisible: unseenVisible,
      unseenUnknown: unseenUnknown,
      visibleMinutes: visibleMinutes,
      // Tüm huni kutuları / görünür dakika ve yalnız görünürken gelenler / dakika.
      boxesPerVisibleMinute: visibleMinutes > 0 ? boxes / visibleMinutes : null,
      visibleBoxesPerVisibleMinute: visibleMinutes > 0 ? visibleBoxes / visibleMinutes : null,
      hours: hours,
      kinds: kinds,
      days: days
    };
  }

  function visibilityMinutesText(minutes) {
    var value = Number(minutes) || 0;
    if (value <= 0) return '0';
    return value >= 100 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toFixed(1).replace('.', ',');
  }

  function perMinuteText(value) {
    if (value === null || value === undefined) return '—';
    return (Math.round(Number(value) * 100) / 100).toFixed(2).replace('.', ',');
  }

  // Huni kartlarının HTML'i tek yerde: iki farklı bölümde aynı kart işaretlemesi
  // tekrarlanmasın. Kart dizisi [etiket, değer, renk sınıfı, alt açıklama] taşır.
  function funnelCardsHtml(cards) {
    return cards.map(function (card) {
      return '<div class="card p-4"><div class="stat-label">' + esc(card[0]) + '</div>' +
        '<div class="stat-value ' + card[2] + '">' + card[1] + '</div>' +
        '<div class="text-[10px] text-yellow-50/40 mt-1">' + esc(card[3]) + '</div></div>';
    }).join('');
  }

  // Maruz kalma kartı: görünür süre ve kutunun geldiği andaki görünürlük.
  // "Hiç görülmedi" üçe ayrılır: panel kapalıydı / panel görünürdü ama kutu
  // görülmedi / bilinmiyor. Oranlar yalnızca gerçek gözlemlerden hesaplanır.
  function renderFunnelExposure(f) {
    var el = $('funnelExposure');
    if (!el) return;
    var minutes = Number(f.visibleMinutes) || 0;
    var rate = f.boxesPerVisibleMinute;
    var visibleRate = f.visibleBoxesPerVisibleMinute;
    var exposure = f.exposureConversion === null || f.exposureConversion === undefined
      ? '—' : '%' + Math.round(f.exposureConversion * 100);
    var detection = f.visibleDetection === null || f.visibleDetection === undefined
      ? '—' : '%' + Math.round(f.visibleDetection * 100);
    var cards = [
      ['Görünür süre', visibilityMinutesText(minutes) + ' dk', 'text-cyan-300',
        'sekme görünürken · son 7 gün'],
      ['Kutu / görünür dk', perMinuteText(rate), 'text-amber-300',
        'tüm kutu ÷ görünür dakika'],
      ['Görünürken gelen', fmt(f.visibleBoxes), 'text-sky-300',
        'görünürken ' + perMinuteText(visibleRate) + ' kutu/dk'],
      ['Kapalıyken gelen', fmt(f.closedBoxes), 'text-yellow-300',
        f.unknownBoxes ? f.unknownBoxes + ' kutu bilinmiyor' : 'kutunun geldiği an kapalıydı']
    ];
    var cells = [
      ['Hiç görülmedi · panel kapalıydı', f.unseenClosed, 'text-amber-300'],
      ['Hiç görülmedi · panel görünürdü', f.unseenVisible, 'text-red-300'],
      ['Hiç görülmedi · bilinmiyor', f.unseenUnknown, 'text-yellow-50/50']
    ];
    el.innerHTML = '<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">' +
      funnelCardsHtml(cards) + '</div>' +
      '<div class="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">' +
      cells.map(function (cell) {
        return '<div class="rounded border border-white/10 px-2 py-2">' +
          '<span class="block text-[10px] text-yellow-50/45">' + esc(cell[0]) + '</span>' +
          '<span class="font-mono font-bold ' + cell[2] + '">' + fmt(cell[1]) + '</span></div>';
      }).join('') + '</div>' +
      '<p class="hint mt-3">Maruz kalma dönüşümü: <b>' + exposure + '</b> (' +
        fmt(f.visibleCollected) + ' toplanan / ' + fmt(f.visibleBoxes) + ' görünürken gelen) · ' +
        'görünürken gelenlerin görülme oranı: <b>' + detection + '</b>. ' +
        'Panel kapalıyken gelen kutular bu oranın paydasına girmez; panel görünürken Fırsatlar sekmesi kapalıysa da kutu görülmemiş sayılır.</p>' +
      (minutes <= 0
        ? '<p class="hint mt-2">Görünürlük kaydı bu sürümle başladı; ilk ölçüm için sekmeyi açık tut. ' +
          'Eski kutularda görünürlük bilinmiyor olarak kalır.</p>'
        : '');
  }

  // Gün gün bakış: son 7 günün kutu / görülen / toplanan sayıları ve dönüşümü.
  // Dönüşümün paydası görülen kutudur; bir gün hiç görülmediyse oran bilinmiyor (—).
  function renderFunnelDays(f) {
    var el = $('funnelDays');
    if (!el) return;
    if (!f.days || !f.days.length || !f.boxes) { el.innerHTML = ''; return; }

    var header = '<div class="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-yellow-50/40">' +
      '<span class="min-w-0 flex-1 truncate">gün</span>' +
      '<span class="w-8 shrink-0 text-right truncate">kutu</span>' +
      '<span class="w-10 shrink-0 text-right truncate">görüldü</span>' +
      '<span class="w-12 shrink-0 text-right truncate">toplanan</span>' +
      '<span class="w-11 shrink-0 text-right truncate">dönüşüm</span>' +
      '</div>';
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    var body = f.days.map(function (day) {
      var rate = day.seen ? day.collected / day.seen : null;
      var color = rate === null ? 'text-yellow-50/30' : (rate < 0.5 ? 'text-red-300' : 'text-green-300');
      var partial = day.start < f.since || day.start === todayStart.getTime();
      var label = new Date(day.start).toLocaleDateString('tr-TR', {
        weekday: 'short', day: '2-digit', month: '2-digit'
      }) + (partial ? '*' : '');
      return '<div class="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-white/5">' +
        '<span class="min-w-0 flex-1 truncate text-yellow-100">' + esc(label) + '</span>' +
        '<span class="w-8 shrink-0 text-right font-mono">' + fmt(day.boxes) + '</span>' +
        '<span class="w-10 shrink-0 text-right font-mono text-sky-300">' + fmt(day.seen) + '</span>' +
        '<span class="w-12 shrink-0 text-right font-mono text-green-300">' + fmt(day.collected) + '</span>' +
        '<span class="w-11 shrink-0 text-right font-mono ' + color + '">' +
          (rate === null ? '—' : '%' + Math.round(rate * 100)) + '</span>' +
        '</div>';
    }).join('');
    el.innerHTML = header + '<div class="space-y-0.5 mt-1">' + body + '</div>' +
      '<p class="hint mt-2">Gün, kutunun geldiği yerel tarih; günlük dönüşüm = toplanan / görülen. ' +
      'Maruz kalma dönüşümü (toplanan / panel görünürken gelen) üstteki karttadır. ' +
      '* kısmi gün (bugün ya da kayıt başlangıcı).</p>';
  }

  // Tür kırılımı: hangi türün daha çok kaçtığı aynı huni tanımlarıyla görünsün.
  // Kaçma oranının paydası görülen kutudur; hiç görülmeyen kutu bu orana girmez.
  function renderFunnelKinds(f) {
    var el = $('funnelKinds');
    if (!el) return;
    var order = ['chest', 'portal', 'letter'];
    var rows = order.filter(function (kind) { return f.kinds[kind] && f.kinds[kind].boxes > 0; });
    if (!rows.length) { el.innerHTML = ''; return; }

    var header = '<div class="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-yellow-50/40">' +
      '<span class="min-w-0 flex-1 truncate">tür</span>' +
      '<span class="w-8 shrink-0 text-right truncate">kutu</span>' +
      '<span class="w-10 shrink-0 text-right truncate">görüldü</span>' +
      '<span class="w-8 shrink-0 text-right truncate">kaçtı</span>' +
      '<span class="w-10 shrink-0 text-right truncate">kaçma</span>' +
      '<span class="w-10 shrink-0 text-right truncate">medyan</span>' +
      '</div>';
    var best = null;
    var body = rows.map(function (kind) {
      var k = f.kinds[kind];
      var meta = KINDS[kind];
      var rate = k.seen ? k.missed / k.seen : null;
      if (rate !== null && (!best || rate > best.rate)) {
        best = { kind: kind, rate: rate, seen: k.seen };
      }
      var color = rate === null ? 'text-yellow-50/30' : (rate >= 0.5 ? 'text-red-300' : 'text-yellow-50/70');
      return '<div class="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-white/5">' +
        '<span class="min-w-0 flex-1 truncate text-yellow-100">' + meta.icon + ' ' + esc(meta.label) + '</span>' +
        '<span class="w-8 shrink-0 text-right font-mono">' + fmt(k.boxes) + '</span>' +
        '<span class="w-10 shrink-0 text-right font-mono text-sky-300">' + fmt(k.seen) + '</span>' +
        '<span class="w-8 shrink-0 text-right font-mono text-red-300">' + fmt(k.missed) + '</span>' +
        '<span class="w-10 shrink-0 text-right font-mono ' + color + '">' +
          (rate === null ? '—' : '%' + Math.round(rate * 100)) + '</span>' +
        '<span class="w-10 shrink-0 text-right font-mono text-yellow-50/70">' +
          (k.median === null ? '—' : clock(k.median / 1000)) + '</span>' +
        '</div>';
    }).join('');
    var note = best
      ? 'En çok kaçan tür: ' + KINDS[best.kind].label + ' — görülenlerin %' +
        Math.round(best.rate * 100) + "'i kaçtı (" + best.seen + ' görülen' +
        (best.seen < 5 ? ', az örnek' : '') + ').'
      : 'Görülen kutu yok; türe göre kaçma oranı henüz hesaplanamaz.';
    el.innerHTML = header + '<div class="space-y-0.5 mt-1">' + body + '</div>' +
      '<p class="hint mt-2">' + esc(note) + '</p>';
  }

  function renderFunnel() {
    var summary = $('funnelSummary');
    if (!summary) return;
    var f = funnelStats();
    var unseen = f.boxes - f.seen;
    var reaction = $('funnelReaction');
    renderFunnelExposure(f);
    // Tür ve gün kartları iki durumda da aynı; bir kez burada çizilir.
    renderFunnelKinds(f);
    renderFunnelDays(f);
    if (!f.boxes) {
      summary.innerHTML = '<div class="empty-state col-span-2 lg:col-span-4">' +
        'Hunide sayılacak kutu yok. Görülme kaydı bu sürümle başladı; yeni kutular Fırsatlar listesine düştükçe burası dolar.</div>';
      reaction.textContent = '';
      $('funnelHourly').innerHTML = '<div class="hint">Kaçırma kaydı yok.</div>';
      return;
    }

    function percent(part, total) {
      return total ? Math.round((part / total) * 100) + '%' : '—';
    }

    var cards = [
      ['Kutu (7 gün)', fmt(f.boxes), 'text-amber-300',
        'görünürken ' + fmt(f.visibleBoxes) + ' · kapalıyken ' + fmt(f.closedBoxes) +
        (f.unknownBoxes ? ' · ' + fmt(f.unknownBoxes) + ' bilinmiyor' : '')],
      ['Görüldü', fmt(f.seen), 'text-sky-300',
        'kutuların ' + percent(f.seen, f.boxes) + (unseen ? ' · ' + fmt(unseen) + ' hiç görülmedi' : '')],
      ['Toplandı', fmt(f.collected), 'text-green-300',
        'görülenlerin ' + percent(f.collected, f.seen) + ' · maruz kalanların ' + percent(f.visibleCollected, f.visibleBoxes)],
      ['Kaçtı', fmt(f.missed), 'text-red-300',
        f.open ? f.open + ' kutu açık bekliyor' : 'açık kutu yok']
    ];
    summary.innerHTML = funnelCardsHtml(cards);

    var lines = [];
    lines.push(f.median === null
      ? 'Medyan tepki süresi: henüz toplanan kutu yok.'
      : 'Medyan tepki süresi: ' + clock(f.median / 1000) + ' (' + f.collected + ' toplanan kutuda).');
    if (f.seen === 0) {
      lines.push('Okuma: kutular listeye ulaşmadan gidiyor → darboğaz gösterim.');
    } else if (f.unseenVisible > 0 && f.unseenVisible >= f.unseenClosed) {
      lines.push('Okuma: panel görünürken gelen kutuların bir kısmı hiç görülmedi → Fırsatlar sekmesi kapalı ya da gecikme; panel kapalı değildi.');
    } else if (f.unseenClosed > 0 && unseen / f.boxes >= 0.3) {
      lines.push('Okuma: hiç görülmeyenlerin çoğu panel kapalıyken gelmiş → darboğaz maruz kalma; paneli açık tut.');
    } else if (f.conversion <= 0.5) {
      lines.push('Okuma: kutular görülüyor ama yarısı ya da daha azı toplanıyor → darboğaz kullanıcı tepkisi.');
    } else {
      lines.push('Okuma: görülen kutuların yarısından çoğu toplanıyor → darboğaz algılama tarafında.');
    }
    if (f.since > Date.now() - FUNNEL_WINDOW_MS + 3600000) {
      lines.push('Görülme kaydı ' + ago(f.since) + ' başladı.');
    }
    if (f.visibleMinutes > 0) {
      lines.push('Panel görünür: ' + visibilityMinutesText(f.visibleMinutes) + ' dk · tüm kutu ' +
        perMinuteText(f.boxesPerVisibleMinute) + '/dk · görünürken gelen ' +
        perMinuteText(f.visibleBoxesPerVisibleMinute) + '/dk.');
    } else {
      lines.push('Panel görünür süresi henüz kaydedilmedi; kutu/görünür dakika için sekmeyi açık tut.');
    }
    lines.push(f.visibleBoxes
      ? 'Maruz kalma dönüşümü: ' + percent(f.visibleCollected, f.visibleBoxes) +
        ' (toplanan / görünürken gelen). Görülen dönüşüm: ' + percent(f.collected, f.seen) + '.'
      : 'Maruz kalma dönüşümü: —; panel görünürken gelen kutu yok.');
    lines.push('Hiç görülmeyenler: panel kapalıyken ' + fmt(f.unseenClosed) +
      ' · panel görünürken ' + fmt(f.unseenVisible) + ' · bilinmiyor ' + fmt(f.unseenUnknown) + '.');
    reaction.textContent = lines.join(' ');

    var hourRows = f.hours.map(function (count, hour) {
      return count ? [hour, count] : null;
    }).filter(Boolean);
    var maxMiss = hourRows.reduce(function (max, row) {
      return Math.max(max, row[1]);
    }, 1);
    $('funnelHourly').innerHTML = hourRows.length
      ? hourRows.map(function (row) {
        var width = Math.max(4, Math.round((row[1] / maxMiss) * 100));
        return '<div class="flex items-center gap-2 text-[11px]">' +
          '<span class="w-14 shrink-0 text-yellow-50/50 font-mono">' + (row[0] < 10 ? '0' : '') + row[0] + ':00</span>' +
          '<span class="w-8 shrink-0 text-right font-mono text-red-300">' + row[1] + '</span>' +
          '<span class="flex-1 h-2 rounded bg-white/5 overflow-hidden"><span class="block h-full rounded bg-red-500/70" style="width:' + width + '%"></span></span>' +
          '</div>';
      }).join('')
      : '<div class="hint">Son 7 günde kaçan kutu yok.</div>';
  }

  // ---------- Kutu düşme dakikası ----------
  // Tarayıcı her kutuya dinleme oturumunun kaçıncı saniyesinde düştüğünü yazar
  // (sessionSec). Burada kutu sayısı, akış gelen oturumlarda dinlenen dakikaya bölünür;
  // başarısız ve sessiz denemeler paydaya girmez. Karar, 4–5 dakikanın getirisini
  // 0–4 dakikanın ortalamasıyla karşılaştırır. 5+ kovası yalnızca uzatılan/sıcak
  // oturumlarda dolabildiği için sansürlüdür ve karara girmez.
  var MINUTE_LABELS = ['0–1', '1–2', '2–3', '3–4', '4–5', '5+'];
  // Karar eşikleri tek yerde. Bunlar istatistiksel kesinlik değil, küçük
  // örneklerin gürültüsünü azaltan alt sınırlardır. Karar yalnızca 0–4 ile
  // 4–5 dakika karşılaştırmasına dayanır; 5+ sansürlü olduğu için karara girmez.
  var MINUTE_EARLY_BOXES = 20;
  var MINUTE_EARLY_WATCH = 60;
  var MINUTE_LAST_BOXES = 10;
  var MINUTE_LAST_WATCH = 30;
  var MINUTE_MARGIN = 0.1;

  function minuteRate(boxes, minutes) {
    return minutes > 0 ? (boxes / minutes) * 60 : null;
  }

  function minuteSample(boxes, minutes) {
    return fmt(boxes) + ' kutu / ' + fmt(Math.round(minutes)) + ' dk';
  }

  function minuteDecision(counts, minutes) {
    var earlyBoxes = counts[0] + counts[1] + counts[2] + counts[3];
    var earlyMin = minutes[0] + minutes[1] + minutes[2] + minutes[3];
    if (earlyBoxes < MINUTE_EARLY_BOXES || earlyMin < MINUTE_EARLY_WATCH) {
      return '0–4 dk karşılaştırması için en az ' + fmt(MINUTE_EARLY_BOXES) +
        ' kutu ve ' + fmt(MINUTE_EARLY_WATCH) + ' dk gerekli; şu an ' +
        minuteSample(earlyBoxes, earlyMin) + '.';
    }
    var lastBoxes = counts[4];
    var lastMin = minutes[4];
    if (lastBoxes < MINUTE_LAST_BOXES || lastMin < MINUTE_LAST_WATCH) {
      return '4–5 dk için en az ' + fmt(MINUTE_LAST_BOXES) + ' kutu ve ' +
        fmt(MINUTE_LAST_WATCH) + ' dk gerekli; şu an ' +
        minuteSample(lastBoxes, lastMin) + '. Henüz karar yok.';
    }
    var earlyRate = minuteRate(earlyBoxes, earlyMin);
    var lastRate = minuteRate(lastBoxes, lastMin);
    var change = earlyRate > 0 ? (lastRate / earlyRate - 1) : null;
    var changeText = change === null ? '' :
      ' (' + (change >= 0 ? '+' : '') + Math.round(change * 100) + '%)';
    var reading = '0–4 dk ' + fmt(Math.round(earlyRate * 10) / 10) + '/sa · 4–5 dk ' +
      fmt(Math.round(lastRate * 10) / 10) + '/sa' + changeText;
    var enough = earlyRate > 0
      ? lastRate <= earlyRate * (1 + MINUTE_MARGIN)
      : lastRate === 0;
    return 'Okuma: ' + reading + ' → ' + (enough
      ? '4–5 dk getirisi ilk 4 dakikadan %10’dan fazla yüksek değil; watch-sec 5 dk yeterli.'
      : '4–5 dk getirisi ilk 4 dakikadan %10’dan fazla yüksek; watch-sec 5 dk kesiyor olabilir, uzatmayı dene.');
  }

  function renderBoxMinutes() {
    var bars = $('boxMinuteBars');
    var verdict = $('boxMinuteVerdict');
    var daysEl = $('boxMinuteDays');
    if (!bars || !verdict) return;
    // Hangi pencerenin çizildiği kartta yazılı: eski live.json'da pencere
    // bilgisi yoksa “son 7 gün” demeyip bunu açıkça belirt.
    var windowEl = $('boxMinuteWindow');
    var windowInfo = scanInfo && scanInfo.boxMinuteWindow;
    var windowDays = Number(windowInfo && windowInfo.days);
    var windowKnown = Boolean(windowInfo && windowDays > 0 && windowInfo.from && windowInfo.to);
    var windowText = windowKnown ? 'son ' + windowDays + ' gün' : 'pencere bilinmiyor';
    if (windowEl) {
      windowEl.textContent = windowText;
      windowEl.title = windowKnown
        ? 'UTC ' + windowInfo.from + ' – ' + windowInfo.to + ' (' + windowDays + ' takvim günü, ikisi dahil)'
        : 'Pencere bilgisi olmayan eski ölçüm gösterilmez';
    }
    var data = scanInfo && scanInfo.boxMinutes;
    var watch = scanInfo && scanInfo.watchMin;
    var hasData = Array.isArray(data) && Array.isArray(watch);
    // Pencere bilgisi yoksa eski ömür boyu toplamları çizmeyiz: o veri hangi
    // ayarlarla toplandığı bilinmediği için kararı domine etmemeli.
    if (!windowKnown) {
      bars.innerHTML = hasData
        ? '<div class="hint">Pencere bilgisi olmayan eski ölçüm gösterilmiyor; tarayıcı güncellenince son 7 gün yeniden birikecek.</div>'
        : '<div class="hint">Ölçüm bu sürümle başladı; tarayıcı güncellenince son 7 gün birikecek.</div>';
      verdict.textContent = '';
      if (daysEl) daysEl.innerHTML = '';
      return;
    }
    if (!hasData) {
      bars.innerHTML = '<div class="hint">Ölçüm bu sürümle başladı; tarayıcı ilk oturumları kapattıkça dolar.</div>';
      verdict.textContent = '';
      if (daysEl) daysEl.innerHTML = '';
      return;
    }
    var counts = MINUTE_LABELS.map(function (label, index) { return Math.max(0, Number(data[index]) || 0); });
    var minutes = MINUTE_LABELS.map(function (label, index) { return Math.max(0, Number(watch[index]) || 0); });
    var totalBoxes = counts.reduce(function (sum, count) { return sum + count; }, 0);
    var totalMin = minutes.reduce(function (sum, min) { return sum + min; }, 0);
    if (!totalBoxes || !totalMin) {
      bars.innerHTML = '<div class="hint">Henüz kutu düşme kaydı yok; oturumlar kapandıkça burası dolar.</div>';
      verdict.textContent = '';
      if (daysEl) daysEl.innerHTML = '';
      return;
    }
    var rates = counts.map(function (count, index) { return minuteRate(count, minutes[index]); });
    var maxRate = 0.0001;
    rates.forEach(function (rate) { if (rate !== null) maxRate = Math.max(maxRate, rate); });
    bars.innerHTML = rates.map(function (rate, index) {
      var width = rate === null ? 0 : Math.max(2, Math.round((rate / maxRate) * 100));
      return '<div class="flex items-center gap-2 text-[11px]">' +
        '<span class="w-12 shrink-0 text-yellow-50/50 font-mono">' + MINUTE_LABELS[index] + ' dk</span>' +
        '<span class="w-16 shrink-0 text-right font-mono text-amber-300">' +
          (rate === null ? '—' : fmt(Math.round(rate * 10) / 10) + '/sa') + '</span>' +
        '<span class="flex-1 h-2 rounded bg-white/5 overflow-hidden"><span class="block h-full rounded bg-amber-500/70" style="width:' + width + '%"></span></span>' +
        '<span class="w-24 shrink-0 text-right text-yellow-50/40">' + counts[index] + ' kutu · ' +
          fmt(Math.round(minutes[index])) + ' dk</span>' +
        '</div>';
    }).join('');

    if (daysEl) {
      var daily = scanInfo && Array.isArray(scanInfo.boxMinuteDaily) ? scanInfo.boxMinuteDaily : [];
      if (daily.length) {
        var maxBoxes = daily.reduce(function (max, day) { return Math.max(max, Number(day && day.boxes) || 0); }, 0);
        if (maxBoxes < 1) maxBoxes = 1;
        daysEl.innerHTML = '<div class="text-[10px] text-yellow-50/50 mb-1">Günlük mini seri (UTC ' +
          esc(windowInfo.from) + ' – ' + esc(windowInfo.to) + '):</div>' +
          daily.map(function (day) {
            var boxes = Math.max(0, Number(day && day.boxes) || 0);
            var mins = Math.max(0, Number(day && day.watchMin) || 0);
            var width = boxes ? Math.max(2, Math.round((boxes / maxBoxes) * 100)) : 0;
            return '<div class="flex items-center gap-2 text-[10px]">' +
              '<span class="w-12 shrink-0 font-mono text-yellow-50/50">' + esc(String(day && day.date ? day.date : '').slice(5)) + '</span>' +
              '<span class="w-12 shrink-0 text-right font-mono text-amber-300">' + boxes + ' kutu</span>' +
              '<span class="flex-1 h-1.5 rounded bg-white/5 overflow-hidden"><span class="block h-full rounded bg-amber-500/60" style="width:' + width + '%"></span></span>' +
              '<span class="w-14 shrink-0 text-right text-yellow-50/40">' + (mins ? fmt(Math.round(mins)) + ' dk' : '—') + '</span>' +
              '</div>';
          }).join('');
      } else {
        daysEl.innerHTML = '';
      }
    }
    var lines = ['Örnek: ' + minuteSample(totalBoxes, totalMin) + ' · ' + windowText + '.'];
    lines.push(minuteDecision(counts, minutes));
    lines.push('5+ karara girmez: yalnızca uzatılmış/sıcak oturumlardan dolar.');
    verdict.textContent = lines.join(' ');
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


  // ---------- Sistem sağlığı ----------
  // Veri üretimi sessizce durmasın: dört kaynağın yaşı tek satırda. Veri ve
  // bağlantı eşikleri çalışma düzeninden; kutu ve ölçüm eşikleri saatlik
  // üretim serisinden ölçülür (aşağıda).
  var HEALTH_LIMITS = [
    { key: 'scan', label: 'veri' },
    { key: 'box', label: 'kutu' },
    { key: 'connect', label: 'bağlantı' },
    { key: 'metrics', label: 'ölçüm' }
  ];
  var HOUR_MS = 3600000;

  // Damga okunamıyorsa 0: yaş bilinmiyor demektir, "—" gösterilir ve uyarı üretmez.
  function healthStamp(value) {
    if (!value) return 0;
    var ms = typeof value === 'number' ? value : new Date(value).getTime();
    return isFinite(ms) && ms > 0 ? ms : 0;
  }

  // null = bilinmiyor. Negatif yaş (saat kayması) "şimdi" sayılır, alarm üretmez.
  function shortAge(ms) {
    if (ms === null) return '—';
    var minutes = Math.floor(Math.max(0, ms) / 60000);
    if (minutes < 1) return 'şimdi';
    if (minutes < 60) return minutes + ' dk';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' sa' + (minutes % 60 ? ' ' + (minutes % 60) + ' dk' : '');
    return Math.floor(hours / 24) + ' gün';
  }

  // Yaşlar cihazdaki son kayıtlardan: live.json kendi damgasını, kutular
  // Fırsatlar'a düşen otomatik olayları, bağlantı tarayıcının bildirdiği son
  // başarıyı, ölçüm metrics.json'ın üretim zamanını taşır.
  function healthSources() {
    var boxAt = 0;
    state.events.forEach(function (event) {
      if (!event.auto || !isOpportunity(event)) return;
      boxAt = Math.max(boxAt, healthStamp(event.createdAt));
    });
    return {
      scan: healthStamp(scanInfo && scanInfo.scannedAt),
      box: boxAt,
      connect: healthStamp(scanInfo && scanInfo.connectStats && scanInfo.connectStats.lastOkAt),
      metrics: healthStamp(metricsInfo && metricsInfo.generatedAt)
    };
  }

  // live.json'daki boxHourly: {epochSaat: kutu sayısı}. Sayaç zaten son 48
  // saati tutar; eski damgaları ayrıca elemez.
  // Oda dinlenen saatler varsa kutu eşiği yalnız bu saatlerden hesaplanır:
  // dinlenmeyen saatler boşluk sayılmaz. Eski tarayıcıda watchHourly yoksa
  // kutu serisi olduğu gibi kullanılır (geriye dönük uyum).
  function boxHourPoints() {
    var watchHourly = scanInfo && scanInfo.watchHourly;
    var boxHourly = scanInfo && scanInfo.boxHourly;
    if (watchHourly && typeof watchHourly === 'object' && Object.keys(watchHourly).length) {
      var points = [];
      Object.keys(watchHourly).forEach(function (key) {
        var hour = Number(key);
        if (!isFinite(hour) || hour <= 0) return;
        var count = boxHourly && typeof boxHourly === 'object'
          ? (Number(boxHourly[key]) || 0)
          : 0;
        points.push({ hour: hour, count: count });
      });
      points.sort(function (a, b) { return a.hour - b.hour; });
      return points;
    }
    var hourly = boxHourly;
    if (!hourly || typeof hourly !== 'object') return [];
    var fallback = [];
    Object.keys(hourly).forEach(function (key) {
      var hour = Number(key);
      var count = Number(hourly[key]) || 0;
      if (!isFinite(hour) || hour <= 0 || count <= 0) return;
      fallback.push({ hour: hour, count: count });
    });
    return fallback;
  }

  // metrics.json'daki saatlik kutu serisi: [{hour: 'YYYY-MM-DDTHH', count}].
  function metricsHourPoints() {
    var buckets = metricsInfo && metricsInfo.hourly && metricsInfo.hourly.buckets;
    if (!Array.isArray(buckets)) return [];
    var points = [];
    buckets.forEach(function (bucket) {
      var at = Date.parse(String(bucket && bucket.hour) + ':00:00Z');
      var count = Number(bucket && bucket.count) || 0;
      if (!isFinite(at) || !count) return;
      points.push({ hour: Math.floor(at / HOUR_MS), count: count });
    });
    return points;
  }

  // Eşik = gözlenen sessizliklerin %95'i + 2 saat. +2, saatlik kovanın içindeki
  // geliş anını bilmemekten gelen pay: normal bir boşluk saat sınırına denk
  // geldiğinde alarm çalmasın. En az 2 saat, en çok capHours.
  // Veri yoksa veya seri çok kısaysa null: eşik uydurulmaz, alarm üretilmez.
  // points bir izleme saati serisidir (count 0 olabilir). Boşluklar duvar saati
  // değil, izleme saatleri üzerinden sayılır; dinlenmeyen saatler boşluk değildir.
  function silenceLimit(points, capHours, watched) {
    if (watched) {
      var series = (points || []).slice().sort(function (a, b) {
        return Number(a && a.hour) - Number(b && b.hour);
      });
      if (series.length < 8) return null;
      var present = [];
      series.forEach(function (point, index) {
        if ((Number(point && point.count) || 0) > 0) present.push(index);
      });
      if (present.length < 3) return null;
      var gaps = [];
      for (var i = 1; i < present.length; i += 1) {
        var gap = present[i] - present[i - 1] - 1;
        if (gap > 0) gaps.push(gap);
      }
      gaps.sort(function (a, b) { return a - b; });
      var p95 = gaps.length ? gaps[Math.max(0, Math.ceil(gaps.length * 0.95) - 1)] : 0;
      return Math.min(capHours, Math.max(2, p95 + 2)) * HOUR_MS;
    }
    var byHour = {};
    (points || []).forEach(function (point) {
      var hour = Number(point && point.hour);
      var count = Number(point && point.count) || 0;
      if (!isFinite(hour) || hour <= 0 || count <= 0) return;
      byHour[hour] = Math.max(byHour[hour] || 0, count);
    });
    var hours = Object.keys(byHour).map(Number).sort(function (a, b) { return a - b; });
    if (hours.length < 3) return null;
    var span = hours[hours.length - 1] - hours[0] + 1;
    if (span < 8) return null;
    var wallGaps = [];
    for (var j = 1; j < hours.length; j += 1) {
      var gap = hours[j] - hours[j - 1] - 1;
      if (gap > 0) wallGaps.push(gap);
    }
    wallGaps.sort(function (a, b) { return a - b; });
    var wallP95 = wallGaps.length ? wallGaps[Math.max(0, Math.ceil(wallGaps.length * 0.95) - 1)] : 0;
    return Math.min(capHours, Math.max(2, wallP95 + 2)) * HOUR_MS;
  }

  // Kutu eşiği tarayıcının boxHourly serisinden. Ölçüm eşiği metrics.json'ın
  // saatlik serisinden; o seri yoksa kutu serisiyle aynı üretim ritmi kullanılır.
  function healthLimits() {
    var boxPoints = boxHourPoints();
    return {
      scan: 30 * 60000,
      connect: 30 * 60000,
      box: silenceLimit(boxPoints, 12, true),
      metrics: silenceLimit(metricsHourPoints(), 8, false) || silenceLimit(boxPoints, 8, true)
    };
  }

  function renderHealth() {
    var el = $('systemHealth');
    if (!el) return;
    var now = Date.now();
    var at = healthSources();
    var limits = healthLimits();
    var ages = {};
    HEALTH_LIMITS.forEach(function (source) {
      var stamp = at[source.key];
      // Bilinmeyen damga null kalır: "—" gösterilir, uyarı üretmez.
      ages[source.key] = stamp ? Math.max(0, now - stamp) : null;
    });
    var live = Number(scanInfo && scanInfo.liveCount) || 0;
    var watching = Number(scanInfo && scanInfo.watching) || 0;
    // watching alanını taşımayan eski dosyada 0 varsayıp alarm üretilmez.
    var watchingKnown = Boolean(scanInfo) && typeof scanInfo.watching === 'number';
    var scanStale = ages.scan !== null && ages.scan > limits.scan;
    // Tarayıcı yaşıyorsa bağlantı/kutuya bakılır. Canlı yokken ya da oda
    // dinlenirken eski "son başarı" normaldir; bu yüzden alarm üretmez.
    var scanFresh = ages.scan !== null && !scanStale;
    var connectStale = scanFresh && live > 0 && watchingKnown && watching === 0 &&
      ages.connect !== null && ages.connect > limits.connect;
    // Kutu yaşı izleme saatleri üzerinden sayılır: dinlenmeyen saatler yaşa eklenmez.
    var boxPoints = boxHourPoints();
    var boxWatchedAge = null;
    if (boxPoints.length) {
      var lastBoxIndex = -1;
      for (var bi = boxPoints.length - 1; bi >= 0; bi -= 1) {
        if ((Number(boxPoints[bi].count) || 0) > 0) { lastBoxIndex = bi; break; }
      }
      boxWatchedAge = lastBoxIndex === -1 ? boxPoints.length : (boxPoints.length - 1 - lastBoxIndex);
    }
    var boxStale = scanFresh && watchingKnown && watching > 0 && limits.box !== null &&
      boxWatchedAge !== null && boxWatchedAge * HOUR_MS > limits.box;
    var metricsStale = scanFresh && limits.metrics !== null &&
      ages.metrics !== null && ages.metrics > limits.metrics;
    var flags = { scan: scanStale, connect: connectStale, box: boxStale, metrics: metricsStale };
    var stale = [];
    var parts = HEALTH_LIMITS.map(function (source) {
      // Duraklatılmış taramada eski yaşlar kırmızıya dönmez: uyarı bilerek susturulur.
      var late = !scanPaused && flags[source.key];
      if (late) stale.push(source);
      return '<span' + (late ? ' class="text-red-300 font-semibold"' : '') + '>' +
        esc(source.label + ' ' + shortAge(ages[source.key])) + '</span>';
    });
    // Uyarı metni hangi kaynağın geciktiğini söyler: ölçüm gecikmesi tarayıcı
    // durmuş gibi görünmesin.
    var warnText = flags.scan ? 'tarayıcı durmuş olabilir'
      : flags.connect ? 'bağlantı kurulamıyor olabilir'
      : flags.box ? 'kutu akışı durmuş olabilir'
      : 'ölçüm güncellenmiyor';
    el.classList.toggle('health-stale', stale.length > 0);
    var thresholdText = HEALTH_LIMITS.map(function (source) {
      var limit = limits[source.key];
      var suffix = source.key === 'box' || source.key === 'metrics'
        ? (limit === null ? ' (veri yok)' : ' (veriden)') : '';
      return source.label + ' ' + (limit === null ? '—' : shortAge(limit)) + suffix;
    }).join(' · ');
    el.innerHTML = (stale.length
      ? '<span class="chip chip-danger">⚠ ' + warnText + '</span>'
      : '<span>🩺 sistem</span>') +
      ' · ' + parts.join(' · ') +
      ' <details class="inline-block ml-1"><summary class="cursor-pointer select-none text-[10px] text-yellow-50/60">eşikler</summary><span class="text-[10px] text-yellow-50/60">' + esc(thresholdText) + '</span></details>' +
      (scanPaused ? ' <span>· tarama duraklatıldı</span>' : '');
    el.title = 'Eşikler: ' + HEALTH_LIMITS.map(function (source) {
      var limit = limits[source.key];
      var suffix = source.key === 'box' || source.key === 'metrics'
        ? (limit === null ? ' (veri yok)' : ' (veriden)') : '';
      return source.label + ' ' + (limit === null ? '—' : shortAge(limit)) + suffix;
    }).join(' · ') + ' · yaşlar son kayıtlardan';
  }

  function renderAll() {
    renderStats();
    renderStreamers();
    renderOpportunities();
    renderInventory();
    renderAgencies();
    renderCalc();
    renderMetrics();
    renderFunnel();
    renderDelivery();
    renderBoxMinutes();
    renderHealth();
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

  // Görülme kaydının başlangıcı: bu sürümden önceki kutular hunide
  // “görülmedi” sayılmasın diye ilk açılışta işaretlenir (yedeğe dahil).
  function ensureFunnelSince() {
    var settings = Object.assign({}, state.settings || {});
    if (Number(settings.funnelSeenSince) > 0) return;
    settings.funnelSeenSince = Date.now();
    Store.set({ settings: settings });
    state = Store.get();
  }

  async function boot() {
    await Store.ready();
    state = Store.get();

    migrateEvents();
    ensureFunnelSince();
    // Kutu geldiğinde panelin görünür olup olmadığını kaydedebilmek için
    // görünürlük takibi ilk taramadan önce başlar.
    startVisibilityTracking();

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
    // Sayfaya dönünce Fırsatlar listesi tazelenir; görülme anı bundan sayılır.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') renderAll();
    });
    setInterval(pruneInactive, 600000);
    // Sıralama zamanla değişir (kalan süre azalır): liste kendiliğinden tazelenir.
    setInterval(function () {
      var opp = $('view-opportunities');
      var streams = $('view-hunt');
      var metrics = $('view-metrics');
      if (opp && !opp.classList.contains('hidden')) renderOpportunities();
      if (streams && !streams.classList.contains('hidden')) renderStreamers();
      if (metrics && !metrics.classList.contains('hidden')) { renderFunnel(); renderBoxMinutes(); renderDelivery(); }
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
