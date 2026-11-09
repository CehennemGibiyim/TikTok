/*
 * store-client.js — Panel <-> sunucu kalıcı deposu köprüsü.
 *
 * Sorun: tarayıcı verisi temizlenince localStorage'daki hesaplar/ajanslar
 * kayboluyordu. Artık kayıtlar sunucudaki data/store.json dosyasına yazılır
 * ve panel açılışında oradan geri yüklenir.
 *
 * Arka uç adresi panelin "Sistem Bağlantısı" alanından (wsUrl) veya
 * config.js içindeki TIKTOK_BACKEND_URL'den alınır. GitHub Pages üzerinde
 * açık adres yoksa çevrimdışı moda düşer, localStorage yedeği kullanılır.
 */
(function () {
  'use strict';

  var KEY_STORAGE = 'tiktok-radar-backend-url';
  var lastError = null;

  function configuredUrl() {
    if (typeof window.TIKTOK_BACKEND_URL === 'string' && window.TIKTOK_BACKEND_URL.trim()) {
      return window.TIKTOK_BACKEND_URL.trim();
    }
    try {
      var saved = localStorage.getItem(KEY_STORAGE);
      if (saved && saved.trim()) return saved.trim();
    } catch (e) { /* yoksay */ }
    var input = document.getElementById('wsUrl');
    if (input && input.value && input.value.trim()) return input.value.trim();
    return '';
  }

  function websocketUrl() {
    var url = configuredUrl();
    if (url) return url;
    if (/^https?:$/.test(location.protocol)) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    return '';
  }

  function httpBase() {
    // GitHub Pages statiktir; arka uç adresi elle verilmediyse sunucu yoktur.
    if (/\.github\.io$/i.test(location.hostname) && !configuredUrl()) return '';

    var url = websocketUrl();
    if (!url) return '';
    return url
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://')
      .replace(/\/+$/, '');
  }

  function available() {
    return Boolean(httpBase());
  }

  async function api(path, options) {
    var base = httpBase();
    if (!base) {
      var missing = new Error('Arka uç adresi tanımlı değil.');
      missing.code = 'NO_BACKEND';
      throw missing;
    }

    var headers = { 'Content-Type': 'application/json' };
    if (window.TIKTOK_RADAR_KEY) headers['x-radar-key'] = window.TIKTOK_RADAR_KEY;

    var response = await fetch(base + path, Object.assign({
      headers: headers,
      cache: 'no-store',
      mode: 'cors'
    }, options || {}));

    var payload = null;
    try { payload = await response.json(); } catch (e) { /* bos govde */ }

    if (!response.ok) {
      var error = new Error((payload && payload.error) || ('Sunucu hatası: HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function pull() {
    try {
      var payload = await api('/api/state');
      lastError = null;
      return payload;
    } catch (error) {
      lastError = error.message;
      return null;
    }
  }

  async function push(kind, list) {
    if (!available()) return { ok: false, error: 'Arka uç yok' };
    try {
      var payload = await api('/api/' + kind, {
        method: 'PUT',
        body: JSON.stringify(Array.isArray(list) ? list : [])
      });
      lastError = null;
      return payload || { ok: true };
    } catch (error) {
      lastError = error.message;
      console.warn('[STORE] ' + kind + ' kaydedilemedi:', error.message);
      return { ok: false, error: error.message };
    }
  }

  function status() {
    return {
      available: available(),
      base: httpBase(),
      error: lastError
    };
  }

  // ---------- main.js fonksiyonlarini sunucuya bagla ----------

  function install() {
    if (typeof window.saveAccounts === 'function' && !window.__storeAccountsWrapped) {
      var originalSaveAccounts = window.saveAccounts;
      window.saveAccounts = function () {
        var result = originalSaveAccounts.apply(this, arguments);
        push('accounts', (typeof storedAccounts !== 'undefined' ? storedAccounts : []));
        return result;
      };
      window.__storeAccountsWrapped = true;
    }

    if (typeof window.saveAgencies === 'function' && !window.__storeAgenciesWrapped) {
      var originalSaveAgencies = window.saveAgencies;
      window.saveAgencies = function () {
        var result = originalSaveAgencies.apply(this, arguments);
        push('agencies', (typeof agenciesList !== 'undefined' ? agenciesList : []));
        return result;
      };
      window.__storeAgenciesWrapped = true;
    }

    if (typeof window.savePersistedUsers === 'function' && !window.__storeUsersWrapped) {
      var originalSaveUsers = window.savePersistedUsers;
      window.savePersistedUsers = function () {
        var result = originalSaveUsers.apply(this, arguments);
        push('users', (typeof trackedUsernames !== 'undefined' ? trackedUsernames : []));
        return result;
      };
      window.__storeUsersWrapped = true;
    }
  }

  async function syncFromServer() {
    if (!available()) return null;

    var state = await pull();
    if (!state) return null;

    var localAccounts = (typeof storedAccounts !== 'undefined' ? storedAccounts : []);
    var localAgencies = (typeof agenciesList !== 'undefined' ? agenciesList : []);
    var localUsers = (typeof trackedUsernames !== 'undefined' ? trackedUsernames : []);

    if (Array.isArray(state.accounts) && state.accounts.length > 0) {
      if (typeof storedAccounts !== 'undefined') {
        storedAccounts = state.accounts;
        if (typeof renderAccountsUI === 'function') renderAccountsUI();
        if (typeof updateActiveAccountsCount === 'function') updateActiveAccountsCount();
      }
    } else if (localAccounts.length > 0) {
      await push('accounts', localAccounts);
    }

    if (Array.isArray(state.agencies) && state.agencies.length > 0) {
      if (typeof agenciesList !== 'undefined') {
        agenciesList = state.agencies;
        if (typeof renderAgencies === 'function') renderAgencies();
      }
    } else if (localAgencies.length > 0) {
      await push('agencies', localAgencies);
    }

    if (Array.isArray(state.users) && state.users.length > 0) {
      if (typeof trackedUsernames !== 'undefined') {
        trackedUsernames = state.users;
      }
    } else if (localUsers.length > 0) {
      await push('users', localUsers);
    }

    if (state.radar && window.Hunt && typeof window.Hunt.applyState === 'function') {
      window.Hunt.applyState(state.radar, state.radar.events || []);
    }

    document.dispatchEvent(new CustomEvent('radar-store-synced', { detail: state }));
    return state;
  }

  window.RADAR_STORE = {
    api: api,
    pull: pull,
    push: push,
    status: status,
    available: available,
    httpBase: httpBase,
    websocketUrl: websocketUrl,
    syncFromServer: syncFromServer
  };

  function boot() {
    install();
    // main.js yüklendikten sonra bir kez senkronize et
    setTimeout(function () {
      install();
      syncFromServer();
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
