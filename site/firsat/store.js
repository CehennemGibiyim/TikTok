/*
 * store.js — Sunucusuz kalıcı depo.
 *
 * Tüm veri bu cihazda tutulur:
 *   1) IndexedDB (ana depo)
 *   2) localStorage (yedek kopya; IndexedDB kullanılamazsa ana depo olur)
 *   3) JSON dışa/içe aktarma (yedek taşımak için)
 *
 * Hiçbir ağ isteği yapılmaz.
 */
(function () {
  'use strict';

  var DB_NAME = 'tiktok-panel';
  var DB_VERSION = 1;
  var OBJECT_STORE = 'kv';
  var STATE_KEY = 'state';
  var LS_KEY = 'tiktok-panel-state';
  // Yedek dosyası kimliği ve biçim sürümü: uyumsuz yedek sessizce yüklenmesin.
  var BACKUP_APP = 'tiktok-jeton-paneli';
  var BACKUP_VERSION = 2;
  // Panel sürümü ve sürüm geçmişi (Ayarlar'da gösterilir, yedeğe yazılır).
  var APP_VERSION = '1.2.0';
  var CHANGE_LOG = [
    {
      version: '1.2.0',
      date: '2026-11-13',
      items: [
        'Saatlik bağlantı bütçesi: tarama, TikTok kotasına çarpmadan yavaşlıyor ve bütçe boşalınca kendiliğinden devam ediyor.',
        'Panelde bu saat kaç bağlantı yapıldığı, limit ve bütçe doluysa sonraki deneme süresi yazıyor.'
      ]
    },
    {
      version: '1.1.9',
      date: '2026-11-13',
      items: [
        'Telefon düzeni sadeleştirildi: kırılgan CSS seçicileri yerine sayfadaki sınıflar kullanılıyor, durum rozeti dışındaki rozetler tek satırda kalıyor.'
      ]
    },
    {
      version: '1.1.8',
      date: '2026-11-13',
      items: [
        'Penceresi kapanan kutunun listede kaldığı süre artık Ayarlar sekmesinden değiştirilebiliyor (varsayılan 15 dakika).'
      ]
    },
    {
      version: '1.1.7',
      date: '2026-11-13',
      items: [
        'Cep telefonu düzeni: sekmeler tek satırda kaydırılıyor, kart boşlukları küçüldü, tablo sayfayı yana kaydırmıyor, alanlara dokununca sayfa yakınlaşmıyor.',
        'Penceresi kapanan sandık 15 dakika sonra listeden düşüyor (önceden hiç düşmüyordu).',
        'Kutu gönderen yayıncı listede kalıyor: son kutu zamanı da canlılık sayılıyor.',
        'Kutu jetonu için bilinen tüm alan adları okunuyor (diamondCount, coinCount, coins…); hiçbiri yoksa "bilinmiyor" yazılıyor.'
      ]
    },
    {
      version: '1.1.6',
      date: '2026-11-13',
      items: [
        'Bildirim izni açılışta ve ilk tıklamada isteniyor; panelin üstünde izin durumu yazıyor.',
        'İzin yoksa yeni kutu için kısa sesli uyarı ve 4 saniyelik ekran vurgusu çıkıyor.'
      ]
    },
    {
      version: '1.1.5',
      date: '2026-11-13',
      items: [
        'Anlık kutu yayınına doğrulama anahtarı eklendi: anahtarsız mesajlar panelde yok sayılıyor.',
        'Kutu birleştirme tek fonksiyonda toplandı; kullanılmayan alanlar ve test adı süzgeci kaldırıldı.'
      ]
    },
    {
      version: '1.1.4',
      date: '2026-11-13',
      items: [
        'Kutular panelde anlık: tarayıcı yakaladığı anda ntfy yayınıyla geliyor (ölçülen gecikme ~0.3 sn).',
        'Panel kutuyu SSE ile dinliyor; akış koparsa 15 sn\'lik dosya okumasına düşüyor.'
      ]
    },
    {
      version: '1.1.3',
      date: '2026-11-13',
      items: [
        'Sandık/zarf artık saniyeler içinde panelde: hızlı kutu kanalı (boxes.json, 15 sn) ve yeni kutu bildirimi.',
        'Tarama hafifletildi: havuz her turda tamamı yerine 600\'lük dilimler hâlinde yoklanıyor, dinlemeye kaynak kalıyor.',
        'Dinleme bütçesi 40 odaya çıkarıldı.'
      ]
    },
    {
      version: '1.1.2',
      date: '2026-11-13',
      items: [
        'Tarama verisi artık ham dosyadan (raw.githubusercontent) okunuyor: GitHub Pages build kotası yüzünden Fırsatlar saatlerce eski kalıyordu.',
        'Ham dosya okunamazsa Pages kopyasına otomatik düşülüyor (canlı veri + havuz içe alma).'
      ]
    },
    {
      version: '1.1.1',
      date: '2026-11-12',
      items: [
        '“Canlı” etiketi artık tazelik ister: 15 dakikadır doğrulanmayan oda yayında sayılmaz (yanlış CANLI etiketi kalktı).',
        'Yeni taramada bekleyen kutular silinmiyor; listede olmayan yayıncının kutusu da Fırsatlar\'a düşüyor.',
        '“Canlı yayınları bul” tarama duraklatmasından bağımsız çalışıyor.',
        'Bağlantılar taze oda kimliği olan (gerçekten yayında) odalara yapılıyor: başarı oranı %28 → %85.',
        'Kota koruması: hız sınırı 2\'yi geçerse dakikalık bağlantı yarıya iner, aralık iki katına çıkar.'
      ]
    },
    {
      version: '1.1.0',
      date: '2026-11-12',
      items: [
        "Ayarlar'da Panel sürümü kartı: sürüm, yedek biçimi ve sürüm geçmişi listesi.",
        "Yedek dosyasına appVersion eklendi; içe aktarma mesajı panel sürümünü gösteriyor.",
        "README'de sürüm geçmişi, yayın sonrası kontroller ve tek komutluk sürüm betiği (scripts/release.mjs)."
      ]
    },
    {
      version: '1.0.0',
      date: '2026-11-12',
      items: [
        'Sandık/zarf/portal yakalama: jeton alanı boş gelen süper fan kutusu da yazılıyor, aynı kutu iki kez kaydedilmiyor.',
        'Zarf ve portal süresi dolunca 15 dakika “KONTROL ET” olarak listede kalıyor.',
        'Ülke tablolarından keşif (tik.tools anahtarı) ve günde bir otomatik ülke taraması + raporu.',
        'Av listesi: ülke rozetiyle filtreleme, arama ve sıralama kalıcı; havuz 6000 adres.',
        'Görünüm tercihleri yedeğe dahil; yedek biçim sürümü ve uyumsuz yedek reddi.'
      ]
    },
    {
      version: '0.9.0',
      date: '2026-11-11',
      items: [
        'Sandık süresi dolsa da beklemede kalıyor; eski “kaçtı” kayıtları geri alınıyor.',
        'TikTok günlük bağlantı sınırında 3 saat bekleme, panelde sebep gösterimi.'
      ]
    },
    {
      version: '0.8.0',
      date: '2026-11-11',
      items: [
        'Windows kurulum paketi (Electron + NSIS) ve GitHub Releases üzerinden otomatik güncelleme.',
        'Ayarlar’da uygulama/güncelleme ve yerel tarayıcı kartı.'
      ]
    }
  ];

  function emptyState() {
    return {
      version: 1,
      accounts: [],
      agencies: [],
      streamers: [],
      events: [],
      settings: {
        letterTtlSec: 180,
        inactiveDays: 7,
        // Penceresi kapanan sandık/portal/zarf kaç dakika daha listede kalır.
        chestKeepMin: 15,
        notify: true,
        tiktokCutPct: 50,
        agencyCutPct: 10,
        coinUsd: 0.005,
        usdTry: 34.5
      },
      // Görünüm tercihleri: yedeğe dahil olsun diye Store'da tutulur.
      view: {
        country: '',
        search: '',
        sortKey: 'name',
        sortDir: 1
      },
      updatedAt: null
    };
  }

  var state = emptyState();
  var db = null;
  var saveTimer = null;
  var listeners = [];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function openDb() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        var database = event.target.result;
        if (!database.objectStoreNames.contains(OBJECT_STORE)) {
          database.createObjectStore(OBJECT_STORE);
        }
      };

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () {
        console.warn('[STORE] IndexedDB açılamadı, localStorage kullanılacak.');
        resolve(null);
      };
    });
  }

  function readIndexed(database) {
    return new Promise(function (resolve) {
      if (!database) return resolve(null);
      try {
        var transaction = database.transaction(OBJECT_STORE, 'readonly');
        var request = transaction.objectStore(OBJECT_STORE).get(STATE_KEY);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      } catch (e) {
        resolve(null);
      }
    });
  }

  function writeIndexed(database, value) {
    return new Promise(function (resolve) {
      if (!database) return resolve(false);
      try {
        var transaction = database.transaction(OBJECT_STORE, 'readwrite');
        transaction.objectStore(OBJECT_STORE).put(value, STATE_KEY);
        transaction.oncomplete = function () { resolve(true); };
        transaction.onerror = function () { resolve(false); };
      } catch (e) {
        resolve(false);
      }
    });
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeLocal(value) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('[STORE] localStorage yazılamadı:', e.message);
      return false;
    }
  }

  function normalize(saved) {
    var base = emptyState();
    if (!saved || typeof saved !== 'object') return base;
    ['accounts', 'agencies', 'streamers', 'events'].forEach(function (key) {
      base[key] = Array.isArray(saved[key]) ? saved[key] : [];
    });
    base.settings = Object.assign(base.settings, saved.settings || {});
    base.view = Object.assign(base.view, saved.view || {});
    base.updatedAt = saved.updatedAt || null;
    return base;
  }

  async function ready() {
    db = await openDb();
    var saved = await readIndexed(db);
    if (!saved) saved = readLocal();
    state = normalize(saved);
    writeLocal(state);
    return state;
  }

  function get() {
    return state;
  }

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { console.error(e); }
    });
  }

  function saveNow() {
    state.updatedAt = new Date().toISOString();
    writeLocal(state);
    writeIndexed(db, clone(state));
  }

  function set(changes) {
    Object.assign(state, changes);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, 250);
    notify();
  }

  function subscribe(fn) {
    listeners.push(fn);
  }

  function exportJson() {
    return JSON.stringify({
      app: BACKUP_APP,
      appVersion: APP_VERSION,
      formatVersion: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      data: state
    }, null, 2);
  }

  function importJson(text) {
    var parsed = JSON.parse(text);

    // Başka uygulamanın dosyası: sessizce içe alınmaz.
    if (parsed && parsed.app && parsed.app !== BACKUP_APP) {
      throw new Error('Bu dosya bu panelin yedeği değil (uygulama: ' +
        String(parsed.app).slice(0, 40) + ').');
    }
    // Daha yeni biçim: bilinmeyen alanlar sessizce düşmesin, açıkça reddedilsin.
    var formatVersion = Number(parsed && parsed.formatVersion) || 0;
    if (formatVersion > BACKUP_VERSION) {
      throw new Error('Yedek daha yeni bir sürümle oluşturulmuş (biçim v' + formatVersion +
        '). Bu panel en fazla v' + BACKUP_VERSION + ' okuyabiliyor; paneli güncelle.');
    }

    var data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== 'object') throw new Error('Geçersiz yedek dosyası.');

    state = normalize(data);
    saveNow();
    notify();
    return {
      state: state,
      // 0 = sürüm alanı olmayan eski yedek.
      formatVersion: formatVersion,
      appVersion: (parsed && parsed.appVersion) || '',
      exportedAt: (parsed && parsed.exportedAt) || ''
    };
  }

  function clearAll() {
    state = emptyState();
    saveNow();
    notify();
  }

  function storageInfo() {
    var bytes = new Blob([JSON.stringify(state)]).size;
    return {
      engine: db ? 'IndexedDB' : 'localStorage',
      bytes: bytes,
      accounts: state.accounts.length,
      agencies: state.agencies.length,
      streamers: state.streamers.length,
      events: state.events.length,
      updatedAt: state.updatedAt
    };
  }

  window.Store = {
    // Yedek biçimi sürümü (panel bunu bilgi olarak gösterir).
    backupFormat: BACKUP_VERSION,
    // Panel sürümü + sürüm geçmişi.
    appVersion: APP_VERSION,
    changeLog: CHANGE_LOG,
    ready: ready,
    get: get,
    set: set,
    subscribe: subscribe,
    exportJson: exportJson,
    importJson: importJson,
    clearAll: clearAll,
    storageInfo: storageInfo
  };
})();
