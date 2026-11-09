/*
 * web-shim.js — Sadece tarayıcı (web) modunda devreye girer.
 *
 * main.js Electron için yazılmış (require('fs'), __dirname, nodebuffer).
 * Panel bir HTTP sunucusundan açıldığında bu dosya:
 *   1) fs/path modüllerini localStorage tabanlı sanal bir dosya sistemiyle karşılar,
 *   2) __dirname tanımlar,
 *   3) WebSocket adresini bulunduğumuz origin'e göre otomatik doldurur.
 *
 * Electron içinde (window.require zaten varsa) hiçbir şey yapmaz; masaüstü
 * davranışı aynen korunur.
 */
(function () {
  var isElectron = typeof window.require === 'function' && !window.__TIKTOK_WEB_MODE__;
  if (isElectron) return;

  window.__TIKTOK_WEB_MODE__ = true;

  var PREFIX = 'tiktok-radar-vfs:';

  function normalize(p) {
    return String(p)
      .replace(/^\.\//, '')
      .replace(/^web\//, '')
      .replace(/^data\//, 'data/');
  }

  function read(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch (e) {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
      return true;
    } catch (e) {
      console.warn('[WEB FS] Yazılamadı (kota?):', key, e.message);
      return false;
    }
  }

  var fs = {
    existsSync: function (p) {
      return read(normalize(p)) !== null;
    },
    readFileSync: function (p) {
      var value = read(normalize(p));
      if (value === null) {
        var err = new Error('ENOENT: no such file, open \'' + p + '\'');
        err.code = 'ENOENT';
        throw err;
      }
      return value;
    },
    writeFileSync: function (p, data) {
      var value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      write(normalize(p), value);
    },
    appendFileSync: function (p, data) {
      var current = read(normalize(p)) || '';
      write(normalize(p), current + data);
    },
    mkdirSync: function () { /* sanal fs: klasör yok */ },
    unlinkSync: function (p) {
      try { localStorage.removeItem(PREFIX + normalize(p)); } catch (e) { /* yoksay */ }
    },
    readdirSync: function () {
      return [];
    }
  };

  var path = {
    join: function () {
      var parts = Array.prototype.slice.call(arguments).filter(Boolean).map(String);
      return parts.join('/').replace(/\/{2,}/g, '/');
    },
    basename: function (p) {
      var s = String(p).replace(/\/+$/, '');
      return s.substring(s.lastIndexOf('/') + 1);
    },
    dirname: function (p) {
      var s = String(p).replace(/\/+$/, '');
      var i = s.lastIndexOf('/');
      return i <= 0 ? '.' : s.substring(0, i);
    },
    resolve: function () {
      return path.join.apply(null, arguments);
    },
    sep: '/'
  };

  window.require = function (name) {
    if (name === 'fs') return fs;
    if (name === 'path') return path;
    throw new Error('[WEB SHIM] Bu modül tarayıcıda yok: ' + name);
  };
  window.__dirname = 'web';
  window.process = window.process || { platform: 'browser', env: {} };

  // WebSocket adresi sırası: config.js -> son kullanılan -> aynı origin.
  var BACKEND_KEY = 'tiktok-radar-backend-url';

  function resolveBackendUrl() {
    var configured = typeof window.TIKTOK_BACKEND_URL === 'string'
      ? window.TIKTOK_BACKEND_URL.trim()
      : '';
    if (configured) return configured;

    var saved = '';
    try { saved = localStorage.getItem(BACKEND_KEY) || ''; } catch (e) { /* yoksay */ }
    if (saved) return saved;

    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!/^https?:$/.test(location.protocol)) return;
    var input = document.getElementById('wsUrl');
    if (!input) return;

    input.value = resolveBackendUrl();
    input.title = 'Arka uç WebSocket adresi. Bir kez girdikten sonra hatırlanır.';

    input.addEventListener('change', function () {
      try { localStorage.setItem(BACKEND_KEY, input.value.trim()); } catch (e) { /* yoksay */ }
    });
  });
})();
