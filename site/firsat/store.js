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
      app: 'tiktok-jeton-paneli',
      exportedAt: new Date().toISOString(),
      data: state
    }, null, 2);
  }

  function importJson(text) {
    var parsed = JSON.parse(text);
    var data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== 'object') throw new Error('Geçersiz yedek dosyası.');
    state = normalize(data);
    saveNow();
    notify();
    return state;
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
