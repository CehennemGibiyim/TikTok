/*
 * store-client.js — Panel <-> sunucu köprüsü.
 *
 * - Hesaplar, ajanslar, hedefler ve jeton olayları sunucudaki data/store.json
 *   dosyasında tutulur; tarayıcı verisi silinse bile kaybolmaz.
 * - Sunucu PANEL_PASSWORD ile korunuyorsa panel bir kez anahtar sorar.
 * - GitHub Pages gibi statik barındırmada kendi origin'i arka uç saymaz;
 *   arka uç adresi config.js veya arayüzdeki alandan verilir.
 */
(function () {
  'use strict';

  var KEY_BACKEND = 'tiktok-radar-backend-url';
  var KEY_PANEL = 'tiktok-radar-panel-key';
  var lastError = null;
  var loginShown = false;

  function readStorage(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* yoksay */ }
  }

  function isStaticHost() {
    return /\.github\.io$/i.test(location.hostname);
  }

  function configuredUrl() {
    if (typeof window.TIKTOK_BACKEND_URL === 'string' && window.TIKTOK_BACKEND_URL.trim()) {
      return window.TIKTOK_BACKEND_URL.trim();
    }
    var saved = readStorage(KEY_BACKEND);
    if (saved.trim()) return saved.trim();
    var input = document.getElementById('wsUrl');
    if (input && input.value && input.value.trim()) return input.value.trim();
    return '';
  }

  function websocketUrl() {
    var url = configuredUrl();
    if (!url) {
      if (/^https?:$/.test(location.protocol) && !isStaticHost()) {
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
      }
      return '';
    }
    // Statik sitede kendi adresimiz arka uç değildir.
    if (isStaticHost()) {
      try {
        if (new URL(url).host === location.host) return '';
      } catch (e) { return ''; }
    }
    return url;
  }

  function httpBase() {
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

  function panelKey() {
    return readStorage(KEY_PANEL);
  }

  function wsAuthQuery() {
    var key = panelKey();
    return key ? '?key=' + encodeURIComponent(key) : '';
  }

  async function api(path, options) {
    var base = httpBase();
    if (!base) {
      var missing = new Error('Arka uç adresi tanımlı değil.');
      missing.code = 'NO_BACKEND';
      throw missing;
    }

    var headers = { 'Content-Type': 'application/json' };
    var key = panelKey();
    if (key) headers['x-panel-key'] = key;

    var response = await fetch(base + path, Object.assign({
      headers: headers,
      cache: 'no-store',
      mode: 'cors'
    }, options || {}));

    var payload = null;
    try { payload = await response.json(); } catch (e) { /* boş gövde */ }

    if (response.status === 401) {
      lastError = 'Panel anahtarı gerekli.';
      promptLogin();
      var authError = new Error(lastError);
      authError.status = 401;
      throw authError;
    }

    if (!response.ok) {
      var error = new Error((payload && payload.error) || ('Sunucu hatası: HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }

    lastError = null;
    return payload;
  }

  async function pull() {
    try {
      return await api('/api/state');
    } catch (error) {
      lastError = error.message;
      return null;
    }
  }

  async function push(kind, list) {
    if (!available()) return { ok: false, error: 'Arka uç yok' };
    try {
      return await api('/api/' + kind, {
        method: 'PUT',
        body: JSON.stringify(Array.isArray(list) ? list : [])
      });
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
      error: lastError,
      hasKey: Boolean(panelKey())
    };
  }

  // ---------- Giriş ----------

  function promptLogin() {
    if (loginShown) return;
    var base = httpBase();
    if (!base) return;
    loginShown = true;

    var overlay = document.createElement('div');
    overlay.id = 'panelLoginOverlay';
    overlay.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur px-4';
    overlay.innerHTML = [
      '<div class="glass rounded-2xl p-7 w-full max-w-sm border-t-4 border-t-yellow-500">',
      '  <h2 class="text-xl font-bold text-yellow-100 mb-1">Panel anahtarı</h2>',
      '  <p class="text-[11px] text-yellow-50/50 mb-4">Bu sunucu erişim anahtarıyla korunuyor. Anahtarı bir kez girin; bu tarayıcı hatırlar.</p>',
      '  <input id="panelKeyInput" type="password" autocomplete="current-password" placeholder="Panel anahtarı" class="w-full bg-black/60 border border-yellow-500/30 rounded-xl px-3 py-2.5 text-yellow-100 text-sm outline-none focus:border-yellow-400 mb-3">',
      '  <div id="panelKeyError" class="text-[11px] text-red-400 mb-3 hidden"></div>',
      '  <button id="panelKeySubmit" class="w-full bg-yellow-500/20 hover:bg-yellow-500/40 border border-yellow-500/50 text-yellow-300 font-bold py-2.5 rounded-xl transition-all">Giriş yap</button>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);

    var input = overlay.querySelector('#panelKeyInput');
    var errorBox = overlay.querySelector('#panelKeyError');
    var submit = overlay.querySelector('#panelKeySubmit');

    input.focus();
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') submit.click();
    });

    submit.addEventListener('click', function () {
      var value = input.value.trim();
      if (!value) {
        errorBox.textContent = 'Anahtar boş olamaz.';
        errorBox.classList.remove('hidden');
        return;
      }

      fetch(base + '/api/state', { headers: { 'x-panel-key': value }, cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('Anahtar hatalı (' + response.status + ')');
          writeStorage(KEY_PANEL, value);
          location.reload();
        })
        .catch(function (error) {
          errorBox.textContent = error.message;
          errorBox.classList.remove('hidden');
        });
    });
  }

  // ---------- main.js kayıtlarını sunucuya bağla ----------

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
      if (typeof trackedUsernames !== 'undefined') trackedUsernames = state.users;
    } else if (localUsers.length > 0) {
      await push('users', localUsers);
    }

    if (state.radar && window.Hunt && typeof window.Hunt.applyState === 'function') {
      window.Hunt.applyState(state.radar, state.radar.events || [], state.pending || state.radar.pending || []);
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
    wsAuthQuery: wsAuthQuery,
    promptLogin: promptLogin,
    syncFromServer: syncFromServer
  };

  function boot() {
    install();

    // GitHub Pages'te "wss://kendi-adresim" yanıltıcı olmasın.
    if (isStaticHost()) {
      var input = document.getElementById('wsUrl');
      if (input && (!input.value || new URL(input.value, location.href).host === location.host)) {
        input.value = '';
        input.placeholder = 'wss://sunucu-adresin';
      }
    }

    setTimeout(function () {
      install();
      syncFromServer();
    }, 300);

    // Arka uç tanımlıysa gerçek zamanlı akış için otomatik bağlan.
    setTimeout(function () {
      try {
        if (typeof connectWebSocket !== 'function') return;
        if (typeof ws !== 'undefined' && ws && ws.readyState <= 1) return;
        var url = websocketUrl();
        if (!url) return;
        var input = document.getElementById('wsUrl');
        if (input && !input.value) input.value = url;
        connectWebSocket();
      } catch (e) { /* yoksay */ }
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
