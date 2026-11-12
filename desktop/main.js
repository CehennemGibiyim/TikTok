'use strict';

/*
 * TikTok Sandık Radarı — masaüstü kabuk.
 *
 * • Paneli (site/firsat) 127.0.0.1 üzerindeki yerel sunucudan açar; böylece
 *   tarayıcıdaki gibi fetch('data/live.json') çalışır.
 * • Tarayıcıyı (scanner/index.js) bu bilgisayarda çalıştırır: GitHub sırası
 *   beklemez, veriyi kullanıcı klasörüne yazar.
 * • Güncellemeyi GitHub sürümlerinden indirir (electron-updater).
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'site')
  : path.join(__dirname, '..', 'site');
const SCANNER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'scanner')
  : path.join(__dirname, '..', 'scanner');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// Panelin ilk açılışta boş görünmemesi için depodaki son tarama verisi kopyalanır.
const SEED_FILES = ['targets.json', 'live.json'];

let win = null;
let server = null;
let updater = null;
let updateState = { state: 'idle' };

const scan = {
  child: null,
  since: 0,
  lastError: '',
  restarts: 0,
  timer: null,
  stopping: false,
  log: []
};

// ---------- ayarlar ----------

function readSettings() {
  // tikToolsKey: panelden girilen keşif anahtarı (yalnızca bu cihazda durur).
  const fallback = { autoUpdate: true, scanOnStart: true, tikToolsKey: '' };
  try {
    return Object.assign({}, fallback, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (error) {
    return fallback;
  }
}

function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch || {});
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n');
  } catch (error) {
    scan.lastError = 'ayarlar yazılamadı: ' + error.message;
  }
  return next;
}

// ---------- veri ----------

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  SEED_FILES.forEach((name) => {
    const target = path.join(DATA_DIR, name);
    if (fs.existsSync(target)) return;
    const source = path.join(SITE_DIR, 'firsat', 'data', name);
    try {
      fs.copyFileSync(source, target);
    } catch (error) {
      // Depoda dosya yoksa tarayıcı ilk turda kendisi oluşturur.
    }
  });
}

// ---------- yerel sunucu ----------

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      let rel;
      try {
        rel = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      } catch (error) {
        response.writeHead(400).end('bozuk istek');
        return;
      }
      if (rel === '/') rel = '/index.html';
      if (rel.endsWith('/')) rel += 'index.html';

      // Tarama verisi kullanıcı klasöründen okunur (uygulama dizini salt okunur).
      const dataHit = rel.match(/^\/firsat\/data\/(live|targets)\.json$/);
      const root = dataHit ? DATA_DIR : SITE_DIR;
      const file = dataHit ? path.join(DATA_DIR, dataHit[1] + '.json') : path.join(SITE_DIR, rel);

      if (path.relative(root, file).startsWith('..')) {
        response.writeHead(403).end('yasak');
        return;
      }
      fs.readFile(file, (error, buffer) => {
        if (error) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bulunamadı');
          return;
        }
        response.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        response.end(buffer);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ---------- tarayıcı süreci ----------

function scannerStatus() {
  return {
    running: Boolean(scan.child),
    since: scan.since,
    lastError: scan.lastError,
    restarts: scan.restarts,
    log: scan.log.slice(-15)
  };
}

function sendScan() {
  if (win && !win.isDestroyed()) win.webContents.send('scan:status', scannerStatus());
}

function pushLog(line) {
  const text = String(line || '').trim();
  if (!text) return;
  scan.log.push(text);
  if (scan.log.length > 200) scan.log.shift();
}

function startScanner() {
  if (scan.child) return scannerStatus();
  const entry = path.join(SCANNER_DIR, 'index.js');
  if (!fs.existsSync(entry)) {
    scan.lastError = 'tarayıcı dosyası bulunamadı: ' + entry;
    sendScan();
    return scannerStatus();
  }

  const args = [
    entry,
    // Süresiz çalışır: uygulama açık kaldıkça tarama sürer.
    '--minutes=0', '--watch=1', '--watch-rooms=32', '--watch-sec=600',
    '--connect-gap=4000', '--min-rooms=8', '--discover-sec=60',
    '--max-pool=6000', '--concurrency=12', '--poll=120',
    // Yerelde git yok: commit kapalı.
    '--commit=0'
  ];

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: SCANNER_DIR,
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        SCANNER_DATA_DIR: DATA_DIR,
        // Panelden anahtar girildiyse tarayıcı bölge tablolarını da kullanır.
        TIKTOOLS_KEY: readSettings().tikToolsKey || process.env.TIKTOOLS_KEY || ''
      }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    scan.lastError = 'tarayıcı başlatılamadı: ' + error.message;
    sendScan();
    return scannerStatus();
  }

  scan.child = child;
  scan.since = Date.now();
  scan.stopping = false;
  scan.lastError = '';

  child.stdout.on('data', (chunk) => pushLog(chunk.toString()));
  child.stderr.on('data', (chunk) => pushLog(chunk.toString()));

  child.on('error', (error) => {
    scan.lastError = error.message;
    pushLog(error.message);
  });

  child.on('exit', (code) => {
    // Yeniden başlatmada eski sürecin kapanışı yeni süreci silmesin.
    if (scan.child !== child) return;
    scan.child = null;
    scan.since = 0;
    if (scan.stopping) {
      sendScan();
      return;
    }
    // Beklenmedik kapanış (ağ, TikTok, güncelleme): 30 sn sonra yeniden dene.
    scan.restarts += 1;
    if (code !== 0 && code !== null) scan.lastError = 'tarayıcı kapandı (kod ' + code + ') — yeniden başlatılıyor';
    scan.timer = setTimeout(() => {
      scan.timer = null;
      if (!scan.child) {
        startScanner();
        sendScan();
      }
    }, 30000);
    sendScan();
  });

  sendScan();
  return scannerStatus();
}

// Panelden eklenen adresler yerel tarayıcı havuzuna yazılır: yayın açtıklarında
// sessizce izlenirler. Tarayıcı kendi listesini yazarken bunları korur (merge).
function addTargets(list) {
  const file = path.join(DATA_DIR, 'targets.json');
  let payload = { targets: [] };
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // Dosya yoksa yenisi yazılır.
  }
  const targets = Array.isArray(payload)
    ? payload.slice()
    : (Array.isArray(payload.targets) ? payload.targets.slice() : []);
  const known = new Set(targets.map((item) => String((item && item.username) || item).toLowerCase()));
  let added = 0;
  (Array.isArray(list) ? list : []).forEach((item) => {
    const username = String((item && item.username) || item || '').trim().replace(/^@/, '');
    if (!username) return;
    if (known.has(username.toLowerCase())) return;
    known.add(username.toLowerCase());
    targets.push({
      username,
      country: String((item && item.country) || ''),
      source: 'board',
      addedAt: Date.now(),
      lastSeenLiveAt: 0
    });
    added += 1;
  });
  if (added) {
    const body = Array.isArray(payload)
      ? { targets }
      : Object.assign({}, payload, { targets, updatedAt: new Date().toISOString() });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 1) + '\n');
  }
  return { added, total: targets.length };
}

// Anahtar değişince tarayıcı yeni anahtarla yeniden başlar.
function restartScanner() {
  const wasRunning = Boolean(scan.child) || Boolean(scan.timer);
  stopScanner();
  if (!wasRunning && !readSettings().scanOnStart) return scannerStatus();
  setTimeout(() => {
    if (!scan.child) startScanner();
  }, 800);
  return scannerStatus();
}

function stopScanner() {
  scan.stopping = true;
  if (scan.timer) {
    clearTimeout(scan.timer);
    scan.timer = null;
  }
  const child = scan.child;
  scan.child = null;
  scan.since = 0;
  if (child) {
    try { child.kill(); } catch (error) { /* zaten kapalı */ }
  }
  sendScan();
  return scannerStatus();
}

// ---------- güncelleme ----------

function sendUpdate(state, extra) {
  updateState = Object.assign({ state }, extra || {});
  if (win && !win.isDestroyed()) win.webContents.send('update:status', updateState);
}

function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (error) {
    updater = null;
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => sendUpdate('checking'));
  updater.on('update-available', (info) => sendUpdate('available', { version: info && info.version }));
  updater.on('update-not-available', (info) => sendUpdate('not-available', { version: info && info.version }));
  updater.on('download-progress', (progress) => sendUpdate('downloading', { percent: Math.round(progress.percent || 0) }));
  updater.on('update-downloaded', (info) => sendUpdate('downloaded', { version: info && info.version }));
  updater.on('error', (error) => sendUpdate('error', { message: (error && error.message) || 'güncelleme hatası' }));
}

async function checkForUpdates() {
  if (!updater) {
    sendUpdate('unsupported', { message: 'Geliştirme sürümünde güncelleme denetlenmez.' });
    return updateState;
  }
  try {
    await updater.checkForUpdates();
  } catch (error) {
    sendUpdate('error', { message: error.message });
  }
  return updateState;
}

// ---------- pencere ----------

async function createWindow() {
  seedData();
  const port = await startServer();

  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'TikTok Sandık Radarı',
    backgroundColor: '#0b0b0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  await win.loadURL('http://127.0.0.1:' + port + '/firsat/');
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    dataDir: DATA_DIR
  }));
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_event, patch) => {
    const before = readSettings();
    const next = writeSettings(patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'tikToolsKey') &&
        before.tikToolsKey !== next.tikToolsKey) {
      restartScanner();
    }
    return next;
  });
  ipcMain.handle('targets:add', (_event, list) => addTargets(list));
  ipcMain.handle('scan:status', () => scannerStatus());
  ipcMain.handle('scan:start', () => startScanner());
  ipcMain.handle('scan:stop', () => stopScanner());
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:install', () => {
    if (updater) updater.quitAndInstall();
  });
  ipcMain.handle('app:open-data', () => shell.openPath(DATA_DIR));
}

app.whenReady().then(async () => {
  setupUpdater();
  registerIpc();
  await createWindow();

  const settings = readSettings();
  if (settings.autoUpdate) checkForUpdates();
  if (settings.scanOnStart) startScanner();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopScanner();
  app.quit();
});

app.on('before-quit', () => {
  stopScanner();
});
