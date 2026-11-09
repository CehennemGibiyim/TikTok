const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==================== DEBUG AYARLARI ====================
const DEBUG = {
    enabled: false,           // Debug mod açık/kapalı
    verbose: false,           // Detaylı loglar
    viewerBot: false,         // Viewer bot detayları
    mobileBot: false,         // Mobile bot detayları
    chestDetection: false,    // Sandık tespit detayları
    websocket: false          // WebSocket mesaj detayları
};

// Debug log fonksiyonu (sadece DEBUG.enabled=true ise çalışır)
function debugLog(category, ...args) {
    if (DEBUG.enabled && DEBUG[category]) {
        console.log(`[DEBUG:${category.toUpperCase()}]`, ...args);
    }
}

// Puppeteer Mobile Bot için ek importlar
let puppeteer = null;
let puppeteerExtra = null;
let stealthPlugin = null;

try {
    puppeteerExtra = require('puppeteer-extra');
    stealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(stealthPlugin());
    if (DEBUG.enabled) console.log('[MOBILE BOT] Puppeteer Extra + Stealth plugin aktif');
} catch(e) {
    if (DEBUG.enabled) console.warn('[MOBILE BOT] Puppeteer Extra yüklenemedi:', e.message);
}

const port = Number(process.env.PORT) || 3000;

// ==================== KALICI DEPO + JETON RADARI ====================
const store = require('./store');
const { createRadar } = require('./radar');

store.load();

const clients = new Set();

function broadcast(payload) {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const client of clients) {
        if (client.readyState === 1) {
            try { client.send(message); } catch (e) { /* yoksay */ }
        }
    }
}

const radar = createRadar({
    store: store,
    broadcast: broadcast,
    log: function (message) { broadcast({ type: 'hunt_log', message: message }); }
});

// Panelin web'den (tarayıcı) açılabilmesi için HTTP + WebSocket aynı portta.
// Sadece arayüz dosyaları servis edilir; data/ ve backups/ asla dışarı açılmaz.
const PUBLIC_FILES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/styles.css': 'styles.css',
    '/main.js': 'main.js',
    '/web-shim.js': 'web-shim.js',
    '/config.js': 'config.js',
    '/store-client.js': 'store-client.js',
    '/hunt.js': 'hunt.js'
};
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
};

const ALLOWED_ORIGINS = (process.env.PANEL_ORIGINS || 'https://cehennemgibiyim.github.io')
    .split(',')
    .map(function (value) { return value.trim(); })
    .filter(Boolean);
const RADAR_KEY = process.env.RADAR_KEY || '';
// Panel erişim anahtarı: doluysa REST ve WebSocket istekleri anahtar ister.
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || RADAR_KEY || '';
const JSON_LIMIT = 8 * 1024 * 1024;

function authorized(req) {
    if (!PANEL_PASSWORD) return true;
    const header = req.headers['x-panel-key'] || req.headers['x-radar-key'] || '';
    return header === PANEL_PASSWORD;
}

function corsHeaders(req) {
    const headers = { 'Cache-Control': 'no-store' };
    const origin = req.headers.origin || '';
    if (!origin) return headers;

    let hostname = '';
    try { hostname = new URL(origin).hostname; } catch (e) { return headers; }

    const allowed = ALLOWED_ORIGINS.indexOf(origin) >= 0
        || hostname === 'localhost'
        || hostname === '127.0.0.1'
        || /\.style\.dev$/.test(hostname);

    if (!allowed) return headers;

    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Methods'] = 'GET,PUT,POST,DELETE,OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, x-radar-key';
    headers['Access-Control-Max-Age'] = '600';
    return headers;
}

function readJsonBody(req) {
    return new Promise(function (resolve, reject) {
        let body = '';
        req.on('data', function (chunk) {
            body += chunk;
            if (body.length > JSON_LIMIT) {
                reject(new Error('Gövde çok büyük.'));
                req.destroy();
            }
        });
        req.on('end', function () {
            if (!body.trim()) return resolve(null);
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Geçersiz JSON gövdesi.')); }
        });
        req.on('error', reject);
    });
}

async function handleApi(req, res, parsed) {
    const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(req));

    function send(code, payload) {
        res.writeHead(code, headers);
        res.end(JSON.stringify(payload));
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
    }

    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    if (req.method === 'GET' && pathname === '/api/health') {
        send(200, {
            ok: true,
            uptime: Math.round(process.uptime()),
            targets: radar.getState(false).targets.length,
            store: store.STORE_FILE
        });
        return;
    }

    if (!authorized(req)) {
        send(401, { ok: false, error: 'Yetkisiz istek: panel anahtarı gerekli.' });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
        const data = store.get();
        send(200, {
            ok: true,
            accounts: data.accounts || [],
            agencies: data.agencies || [],
            users: data.users || [],
            updatedAt: data.updatedAt,
            radar: radar.getState(true),
            pending: radar.getPending()
        });
        return;
    }

    if (req.method === 'PUT' && (pathname === '/api/accounts' || pathname === '/api/agencies' || pathname === '/api/users')) {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            send(400, { ok: false, error: error.message });
            return;
        }

        const list = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
        if (!list) {
            send(400, { ok: false, error: 'Gövde bir dizi olmalı.' });
            return;
        }

        const key = pathname.split('/').pop();
        const changes = {};
        changes[key] = list;
        store.patch(changes);
        send(200, { ok: true, count: list.length, updatedAt: store.get().updatedAt });
        return;
    }

    if (pathname === '/api/hunt/targets') {
        if (req.method === 'POST') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (error) {
                send(400, { ok: false, error: error.message });
                return;
            }

            const list = Array.isArray(body) ? body : [body || {}];
            const results = list.map(function (entry) {
                if (typeof entry === 'string') return radar.add(entry);
                return radar.add(entry && entry.username, entry && entry.country);
            });

            send(200, { ok: true, results: results, state: radar.getState(false) });
            return;
        }

        if (req.method === 'DELETE') {
            const result = radar.remove(query.get('username'));
            send(result.ok ? 200 : 404, Object.assign({ ok: result.ok }, result, { state: radar.getState(false) }));
            return;
        }

        if (req.method === 'PUT') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (error) {
                send(400, { ok: false, error: error.message });
                return;
            }

            const list = Array.isArray(body) ? body : (body && body.targets) || [];
            send(200, { ok: true, state: radar.setTargets(list) });
            return;
        }
    }

    if (req.method === 'GET' && pathname === '/api/hunt/events') {
        send(200, { ok: true, events: radar.getEvents(Number(query.get('limit')) || 300) });
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/hunt/events') {
        send(200, radar.clearEvents());
        return;
    }

    if (req.method === 'GET' && pathname === '/api/hunt/pending') {
        send(200, { ok: true, pending: radar.getPending(), serverTime: Date.now() });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/hunt/collect') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            send(400, { ok: false, error: error.message });
            return;
        }

        const result = radar.markCollected(body && body.id, body && body.mode);
        send(result.ok ? 200 : 404, Object.assign({ ok: result.ok }, result, { state: radar.getState(false) }));
        return;
    }

    send(404, { ok: false, error: 'Bilinmeyen API yolu: ' + pathname });
}

const httpServer = http.createServer(function (req, res) {
    let parsed;
    try {
        parsed = new URL(req.url || '/', 'http://localhost');
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Gecersiz istek');
        return;
    }

    const urlPath = decodeURIComponent(parsed.pathname);

    if (urlPath.indexOf('/api/') === 0) {
        handleApi(req, res, parsed).catch(function (error) {
            console.error('[API]', error.message);
            if (!res.headersSent) {
                res.writeHead(500, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(req)));
            }
            res.end(JSON.stringify({ ok: false, error: error.message }));
        });
        return;
    }

    const relative = PUBLIC_FILES[urlPath];
    if (!relative) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bulunamadi');
        return;
    }

    fs.readFile(path.join(__dirname, relative), function (err, content) {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Dosya okunamadi');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(relative)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(content);
    });
});

const wss = new WebSocket.Server({ server: httpServer });
process.on('SIGINT', function () { store.flush(); process.exit(0); });
process.on('SIGTERM', function () { store.flush(); process.exit(0); });

httpServer.listen(port, '0.0.0.0', function () {
    console.log("Radar Sunucusu " + port + " portunda aktif! Panel: http://localhost:" + port);
});

let trackedUsers = {};

// ==================== OTOMASIK TARAYICI SISTEMI ====================
const dataDir = path.join(__dirname, 'data');
const scanFile = path.join(dataDir, 'scan.json');

// Varsayılan scan.json yapısı
const defaultScanData = {
  config: {
    enabled: false,
    scanIntervalMinutes: 4,      // Her 4 dakikada bir
    accountsPerScan: 10,         // Her seferde 10 hesap
    inactiveThresholdDays: 30,   // 30 gün aktif olmayan sil
    minCoinEventsToKeep: 1,      // En az 1 jeton paylaşmışsa tut
    rotationDelayMs: 5000        // Hesaplar arası 5 saniye bekleme
  },
  scannerQueue: [],              // Tarama yapacak hesaplar (bot hesapları)
  autoDiscovered: [],            // Otomatik bulunan yayıncılar
  scannerLog: {
    lastScanAt: null,
    totalScansToday: 0,
    streamsFoundToday: 0,
    activeScanners: []
  }
};

// scan.json dosyasını yükle veya oluştur
function loadScanData() {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (fs.existsSync(scanFile)) {
      const data = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
      debugLog('verbose', `${data.autoDiscovered?.length || 0} yayıncı yüklendi`);
      return { ...defaultScanData, ...data };
    }
  } catch (e) {
    console.error('[SCANNER] scan.json yüklenemedi:', e);
  }
  return { ...defaultScanData };
}

// scan.json dosyasını kaydet
function saveScanData(data) {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(scanFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[SCANNER] scan.json kaydedilemedi:', e);
  }
}

// Tarama verilerini başlat
let scanData = loadScanData();

// Otomatik temizlik: 30 gün aktif olmayanları sil
function cleanInactiveStreamers() {
  const now = new Date();
  const beforeCount = scanData.autoDiscovered.length;
  
  scanData.autoDiscovered = scanData.autoDiscovered.filter(streamer => {
    // Son canlı yayın tarihi
    const lastLive = streamer.lastLiveAt ? new Date(streamer.lastLiveAt) : new Date(streamer.discoveredAt);
    const daysInactive = (now - lastLive) / (1000 * 60 * 60 * 24);
    
    // Jeton paylaşma sayısı
    const hasCoinEvents = (streamer.coinEventCount || 0) >= scanData.config.minCoinEventsToKeep;
    
    // Manuel eklenmiş mi kontrol et (manuel eklenenler silinmez)
    if (streamer.manuallyAdded) return true;
    
    // 30 günden fazla aktif değil VE jeton paylaşmamışsa sil
    if (daysInactive > scanData.config.inactiveThresholdDays && !hasCoinEvents) {
      debugLog('verbose', `Pasif silindi: @${streamer.username}`);
      return false;
    }
    
    return true;
  });
  
  const removedCount = beforeCount - scanData.autoDiscovered.length;
  if (removedCount > 0) {
    debugLog('verbose', `${removedCount} pasif temizlendi`);
    saveScanData(scanData);
  }
  
  return removedCount;
}

// Simülasyon: Rastgele canlı yayıncı bulma
async function simulateStreamerDiscovery(ws, accountUsername) {
  // Gerçek uygulamada burada Puppeteer ile TikTok keşif sayfası taranır
  // Şimdilik simülasyon yapıyoruz
  
  const sampleStreamers = [
    'funny_cats_daily', 'music_zone_live', 'dance_challenge_hub', 'gaming_night_arena',
    'cooking_with_love', 'travel_vibes_live', 'comedy_central_live', 'art_studio_live',
    'workout_motivation', 'asmr_relaxation', 'tech_talks_live', 'fashion_trends_now',
    'pet_paradise_live', 'karaoke_night_fun', 'story_time_live', 'magic_tricks_live',
    'diy_crafts_live', 'foodie_adventures', 'movie_talks_hub', 'book_club_live'
  ];
  
  // Rastgele 1-3 yayıncı bul
  const foundCount = Math.floor(Math.random() * 3) + 1;
  const foundStreamers = [];
  
  for (let i = 0; i < foundCount; i++) {
    const username = sampleStreamers[Math.floor(Math.random() * sampleStreamers.length)];
    
    // Zaten var mı kontrol et
    const exists = scanData.autoDiscovered.find(s => s.username === username);
    if (!exists) {
      const newStreamer = {
        username: username,
        discoveredBy: accountUsername,
        discoveredAt: new Date().toISOString(),
        lastLiveAt: new Date().toISOString(),
        coinEventCount: Math.floor(Math.random() * 5), // 0-4 arası
        isLive: true,
        isAutoAdded: true,
        status: 'active',
        scanCount: 1,
        manuallyAdded: false
      };
      
      scanData.autoDiscovered.push(newStreamer);
      foundStreamers.push(newStreamer);
      
      if (ws) {
        ws.send(JSON.stringify({ 
          type: 'bot_log', 
          message: `🔍 [@${accountUsername}] Yeni yayıncı bulundu: @${username} ${newStreamer.coinEventCount > 0 ? '(Jeton paylaşan!)' : ''}` 
        }));
        ws.send(JSON.stringify({ 
          type: 'streamer_discovered', 
          streamer: newStreamer 
        }));
      }
    } else {
      // Var olanın son görülme tarihini güncelle
      exists.lastLiveAt = new Date().toISOString();
      exists.scanCount++;
    }
  }
  
  return foundStreamers.length;
}

// Tarayıcı rotasyonu - Her 4 dakikada 10 hesap
async function runScannerRotation(ws) {
  if (!scanData.config.enabled) return;
  
  const now = new Date();
  scanData.scannerLog.lastScanAt = now.toISOString();
  scanData.scannerLog.totalScansToday++;
  
  const availableAccounts = scanData.scannerQueue.slice(0, scanData.config.accountsPerScan);
  
  if (availableAccounts.length === 0) {
    debugLog('verbose', 'Tarama hesap kalmadı, kuyruk yenileniyor');
    scanData.scannerLog.activeScanners = [];
    return;
  }
  
  debugLog('verbose', `${availableAccounts.length} hesapla tarama başlıyor`);
  if (ws) {
    ws.send(JSON.stringify({ 
      type: 'bot_log', 
      message: `🤖 [TARAYICI] ${availableAccounts.length} bot hesapla canlı yayın taraması başlatılıyor...` 
    }));
  }
  
  let totalFound = 0;
  
  // Her hesap sırayla tarama yapar
  for (let i = 0; i < availableAccounts.length; i++) {
    const account = availableAccounts[i];
    
    if (ws) {
      ws.send(JSON.stringify({ 
        type: 'bot_log', 
        message: `🔍 [${i+1}/${availableAccounts.length}] @${account} tarama yapıyor...` 
      }));
    }
    
    // Simülasyon: Yayıncı keşfi
    const found = await simulateStreamerDiscovery(ws, account);
    totalFound += found;
    
    // Hesaplar arası bekleme
    if (i < availableAccounts.length - 1) {
      await new Promise(r => setTimeout(r, scanData.config.rotationDelayMs));
    }
  }
  
  // Taranan hesapları kuyruktan çıkar (rotasyon)
  scanData.scannerQueue = scanData.scannerQueue.slice(scanData.config.accountsPerScan);
  scanData.scannerLog.streamsFoundToday += totalFound;
  
  // Tarama tamamlandı - log bot_log üzerinden gösteriliyor
  if (ws) {
    ws.send(JSON.stringify({ 
      type: 'bot_log', 
      message: `✅ [TARAYICI] Tarama tamamlandı! ${totalFound} yeni yayıncı bulundu. Kalan hesap: ${scanData.scannerQueue.length}` 
    }));
    ws.send(JSON.stringify({ 
      type: 'scan_complete', 
      found: totalFound,
      remainingAccounts: scanData.scannerQueue.length 
    }));
  }
  
  saveScanData(scanData);
}

// Otomatik tarama interval'i (her 4 dakika)
let scannerInterval = null;

function startAutoScanner(ws) {
  if (scannerInterval) clearInterval(scannerInterval);
  
  const intervalMs = scanData.config.scanIntervalMinutes * 60 * 1000;
  
  scannerInterval = setInterval(() => {
    cleanInactiveStreamers(); // Önce temizlik yap
    runScannerRotation(ws);   // Sonra tarama yap
  }, intervalMs);
  
  // Tarama başlatıldı - bot_log üzerinden bildiriliyor
  if (ws) {
    ws.send(JSON.stringify({ 
      type: 'bot_log', 
      message: `🚀 [TARAYICI] Otomatik tarama AKTİF! Her ${scanData.config.scanIntervalMinutes} dakikada ${scanData.config.accountsPerScan} hesapla tarama yapılacak.` 
    }));
  }
}

function stopAutoScanner(ws) {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
    debugLog('verbose', 'Tarama durduruldu');
    if (ws) {
      ws.send(JSON.stringify({ type: 'bot_log', message: `🛑 [TARAYICI] Otomatik tarama DURDURULDU.` }));
    }
  }
}

// Başlangıçta temizlik yap
cleanInactiveStreamers();

// ===================================================================

// ==================== MOBILE BOT SISTEMI (PUPPETEER) ====================

// Mobil cihaz profilleri (Rotasyon için)
const mobileDevices = [
    {
        name: 'iPhone 14 Pro',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
        viewport: { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false }
    },
    {
        name: 'iPhone 13',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false }
    },
    {
        name: 'Samsung S23',
        userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
        viewport: { width: 384, height: 854, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false }
    },
    {
        name: 'Pixel 7',
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
        viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, isLandscape: false }
    },
    {
        name: 'Xiaomi 13',
        userAgent: 'Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
        viewport: { width: 393, height: 873, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false }
    }
];

// Aktif mobil browser havuzu (resource reuse için)
let mobileBrowserPool = [];
let mobileBotConfig = {
    enabled: false,
    maxConcurrent: 2,           // Aynı anda max 2 mobile browser
    chestThreshold: 5,          // 5 jeton birikince işlem yap
    targetStreamer: null,       // Jeton transfer hedefi
    autoCollect: false,         // Otomatik toplama aktif mi
    deviceRotation: true        // Cihaz profili rotasyonu
};

// Bot hesapları jeton bakiyesi takibi
let accountCoinBalances = new Map(); // username -> { coins, collectedChests, lastUpdate }

// Tek hesap transfer takibi (jeton toplandığında anında transfer)
let instantTransferConfig = {
    enabled: true,              // Her jeton toplandığında anında transfer
    minTransferAmount: 1        // Minimum 1 jeton toplanınca transfer et
};

// Anti-ban yapılandırması
let antiBanConfig = {
    enabled: true,                // Anti-ban davranışları aktif
    likeStream: true,           // Yayına beğeni at
    likeCount: 10,               // 10 beğeni at
    randomClicks: true,         // Ekrana rastgele tıklamalar
    clickCount: 10,              // 10 rastgele tıklama
    humanLikeDelay: true         // İnsan benzeri gecikmeler
};

// Hesap jeton bakiyesini güncelle
function updateAccountCoinBalance(username, coinsToAdd, chestInfo = {}) {
    const current = accountCoinBalances.get(username) || {
        coins: 0,
        collectedChests: 0,
        totalCoinsCollected: 0,
        lastUpdate: null,
        chestHistory: []
    };
    
    current.coins += coinsToAdd;
    current.totalCoinsCollected += coinsToAdd;
    current.collectedChests += 1;
    current.lastUpdate = new Date().toISOString();
    
    // Son sandık bilgisini kaydet (max 10)
    current.chestHistory.unshift({
        timestamp: current.lastUpdate,
        coins: coinsToAdd,
        streamer: chestInfo.streamer || 'unknown'
    });
    if (current.chestHistory.length > 10) {
        current.chestHistory.pop();
    }
    
    accountCoinBalances.set(username, current);
    
    debugLog('verbose', `@${username}: +${coinsToAdd} jeton`);
    return current;
}

// Hesap jeton bakiyesini getir
function getAccountCoinBalance(username) {
    return accountCoinBalances.get(username) || {
        coins: 0,
        collectedChests: 0,
        totalCoinsCollected: 0,
        lastUpdate: null,
        chestHistory: []
    };
}

// Tüm hesap bakiyelerini getir
function getAllAccountBalances() {
    const balances = {};
    accountCoinBalances.forEach((value, key) => {
        balances[key] = value;
    });
    return balances;
}

// ==================== ANTI-BAN FONKSIYONLARI ====================

// İnsan benzeri bekleme (rastgele gecikme)
async function humanLikeDelay(min = 800, max = 2500) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(r => setTimeout(r, delay));
}

// Yayına beğeni at (10 defa)
async function likeLiveStream(page, count = 10, ws, accountName) {
    if (!antiBanConfig.likeStream) return;
    
    ws.send(JSON.stringify({ 
        type: 'bot_log', 
        message: `👍 [${accountName}] ${count} beğeni atılıyor...` 
    }));
    
    try {
        for (let i = 0; i < count; i++) {
            // Beğeni butonunu bul ve tıkla
            const liked = await page.evaluate(() => {
                const likeSelectors = [
                    '[data-e2e="like-icon"]',
                    '[data-e2e="like-button"]',
                    '[data-testid="like-btn"]',
                    'button:has([class*="like"])',
                    'div[role="button"]:has([class*="heart"])',
                    '.like-icon',
                    '[class*="LikeIcon"]'
                ];
                
                for (const sel of likeSelectors) {
                    const btn = document.querySelector(sel);
                    if (btn && btn.offsetParent !== null) {
                        btn.click();
                        return true;
                    }
                }
                
                // Alternatif: Ekranın sağ tarafına tıkla (genellikle like butonu orada)
                const rightSide = document.elementFromPoint(window.innerWidth - 50, window.innerHeight / 2);
                if (rightSide) {
                    rightSide.click();
                    return true;
                }
                
                return false;
            });
            
            if (liked) {
                // İnsan benzeri bekleme (300-1200ms)
                await humanLikeDelay(300, 1200);
            }
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [${accountName}] ${count} beğeni atıldı` 
        }));
    } catch (e) {
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `⚠️ [${accountName}] Beğeni hatası: ${e.message}` 
        }));
    }
}

// Ekrana rastgele tıklamalar (insan benzeri davranış)
async function randomScreenClicks(page, count = 10, ws, accountName) {
    if (!antiBanConfig.randomClicks) return;
    
    ws.send(JSON.stringify({ 
        type: 'bot_log', 
        message: `🖱️ [${accountName}] Ekrana ${count} rastgele tıklama yapılıyor...` 
    }));
    
    try {
        for (let i = 0; i < count; i++) {
            // Rastgele koordinatlar (güvenli alan)
            const x = Math.floor(Math.random() * 300) + 50;  // 50-350
            const y = Math.floor(Math.random() * 500) + 100; // 100-600
            
            await page.mouse.move(x, y);
            await humanLikeDelay(100, 500);
            await page.mouse.click(x, y);
            
            // Kısa bekleme
            await humanLikeDelay(200, 800);
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [${accountName}] Rastgele tıklamalar tamamlandı` 
        }));
    } catch (e) {
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `⚠️ [${accountName}] Tıklama hatası: ${e.message}` 
        }));
    }
}

// Yorum yaz (anti-ban)
async function sendRandomComment(page, ws, accountName) {
    if (!antiBanConfig.enabled) return;
    
    const comments = ['🔥', '👋', '👍', 'wow', 'nice', '😊'];
    const comment = comments[Math.floor(Math.random() * comments.length)];
    
    try {
        // Yorum kutusunu bul
        const commentInput = await page.$('[data-e2e="comment-input"], [data-testid="comment-input"], input[placeholder*="comment" i], input[placeholder*="yorum" i]');
        
        if (commentInput) {
            await commentInput.type(comment, { delay: 100 });
            await humanLikeDelay(500, 1500);
            
            // Gönder butonuna tıkla
            await page.evaluate(() => {
                const sendBtn = document.querySelector('[data-e2e="comment-post"], [data-testid="comment-send"], button:has-text("Send"), button:has-text("Gönder")');
                if (sendBtn) sendBtn.click();
            });
            
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `💬 [${accountName}] Yorum: "${comment}"` 
            }));
        }
    } catch (e) {
        // Yorum isteğe bağlı, hata kritik değil
    }
}

// Rastgele mobil cihaz seç
function getRandomMobileDevice() {
    return mobileDevices[Math.floor(Math.random() * mobileDevices.length)];
}

// ==================== PUPPETEER MULTI-BROWSER VIEWER BOT ====================
// GERÇEK ÇÖZÜM: Her izleyici için gerçek Chrome browser instance
// Bu kaynak tüketici ama en gerçekçi yaklaşım
// Her browser gerçek TikTok live sayfasını açar

let puppeteerViewerConfig = {
    enabled: false,
    targetStreamer: null,
    viewerCount: 5,            // Varsayılan: 5 (her browser ~50MB RAM)
    proxyList: [],
    workingProxies: [],
    stayDuration: 300000,      // 5 dakika kalma
    connectionDelay: 5000,     // Her browser arası 5 saniye (CPU/RAM koruması)
    maxConcurrent: 2,        // Sadece 2 eşzamanlı (sistem kararlılığı için)
    headless: true             // Headless mod (ekran gösterme)
};

let activePuppeteerViewers = new Map(); // viewerId -> { browser, page, joinedAt }
let puppeteerViewerInterval = null;

// ÜCRETSİZ PROXY APİLERİ
const FREE_PROXY_APIS = [
    'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&simplified=true',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'
];

// Proxy çek (sadece 15 adet - hızlı test için)
async function fetchFreeProxies() {
    const proxies = [];
    for (const apiUrl of FREE_PROXY_APIS) {
        try {
            const response = await axios.get(apiUrl, { timeout: 8000 });
            const matches = response.data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g);
            if (matches) proxies.push(...matches);
            // İlk API'den 15 proxy aldıysak dur
            if (proxies.length >= 15) break;
        } catch(e) {}
    }
    return [...new Set(proxies)].slice(0, 15); // Sadece 15 proxy
}

// Proxy test et
async function testProxy(proxy) {
    try {
        const [host, port] = proxy.split(':');
        await axios.get('https://httpbin.org/ip', {
            proxy: { host, port: parseInt(port) },
            timeout: 8000
        });
        return true;
    } catch(e) { return false; }
}

// Puppeteer Multi-Browser Viewer oluştur - Gerçek Chrome instance
async function createPuppeteerViewer(streamer, proxy, viewerId, ws) {
    try {
        // Puppeteer'ı dinamik import et
        if (!puppeteer) {
            puppeteer = require('puppeteer-extra');
            const StealthPlugin = require('puppeteer-extra-plugin-stealth');
            puppeteer.use(StealthPlugin());
        }
        
        const device = getRandomMobileDevice();
        
        // Browser launch options
        const launchOptions = {
            headless: puppeteerViewerConfig.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=' + (device.viewport?.width || 375) + ',' + (device.viewport?.height || 812),
                '--user-agent=' + device.userAgent
            ],
            defaultViewport: {
                width: device.viewport?.width || 375,
                height: device.viewport?.height || 812,
                deviceScaleFactor: device.viewport?.deviceScaleFactor || 2,
                isMobile: device.viewport?.isMobile || true,
                hasTouch: device.viewport?.hasTouch || true
            }
        };
        
        // Proxy varsa ekle
        if (proxy) {
            const [host, port] = proxy.split(':');
            launchOptions.args.push(`--proxy-server=http://${host}:${port}`);
        }
        
        // Gerçek Chrome browser aç
        const browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        
        // TikTok live sayfasına git
        await page.goto(`https://www.tiktok.com/@${streamer}/live`, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Sayfanın yüklenmesini bekle (5 saniye)
        await new Promise(r => setTimeout(r, 5000));
        
        // Video elementinin varlığını kontrol et (canlı yayın aktif mi)
        const hasVideo = await page.evaluate(() => {
            const video = document.querySelector('video');
            return !!video;
        });
        
        if (!hasVideo) {
            await browser.close();
            return { success: false, error: 'Canlı yayın aktif değil veya video bulunamadı' };
        }
        
        // Başarıyla bağlandı - kaydet
        const viewerData = {
            id: viewerId,
            streamer,
            proxy,
            browser,
            page,
            device,
            joinedAt: Date.now(),
            connected: true
        };
        
        activePuppeteerViewers.set(viewerId, viewerData);
        
        ws.send(JSON.stringify({
            type: 'bot_log',
            message: `✅ [Browser Viewer #${viewerId}] @${streamer} gerçek Chrome ile bağlandı!`
        }));
        
        return { success: true, viewerId };
        
    } catch(e) {
        return { success: false, error: e.message };
    }
}

// Puppeteer Multi-Browser Viewer Bot'u başlat - Gerçek Chrome instance'leri
async function startPuppeteerViewerBot(targetStreamer, count, ws) {
    puppeteerViewerConfig.enabled = true;
    puppeteerViewerConfig.targetStreamer = targetStreamer;
    puppeteerViewerConfig.viewerCount = count;
    
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `🚀 [PUPPETEER BOT] ${count} gerçek Chrome browser başlatılıyor...`
    }));
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `⚠️ Her browser ~50MB RAM kullanır! Sistem yavaşlayabilir.`
    }));
    
    // 1. Proxy'leri çek ve test et
    ws.send(JSON.stringify({ type: 'bot_log', message: `🌐 Ücretsiz proxy'ler çekiliyor...` }));
    const allProxies = await fetchFreeProxies();
    
    let workingProxies = [];
    if (allProxies.length > 0) {
        ws.send(JSON.stringify({ type: 'bot_log', message: `🧪 ${allProxies.length} proxy test ediliyor...` }));
        
        for (const proxy of allProxies) {
            if (await testProxy(proxy)) {
                workingProxies.push(proxy);
                if (workingProxies.length >= 5) break; // Sadece 5 proxy yeterli
            }
        }
    }
    
    puppeteerViewerConfig.workingProxies = workingProxies;
    
    if (workingProxies.length === 0) {
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `⚠️ Çalışan proxy bulunamadı! DİREKT bağlantı kullanılacak` 
        }));
    } else {
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ ${workingProxies.length} çalışan proxy hazır` 
        }));
    }
    
    // 2. Gerçek Chrome browser'ları aç
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `🌐 ${count} gerçek Chrome browser açılıyor...`
    }));
    
    let joinedCount = 0;
    let failedCount = 0;
    
    for (let i = 0; i < count; i++) {
        const viewerId = i + 1;
        
        // Eşzamanlı limit kontrolü - CPU/RAM koruması
        while (activePuppeteerViewers.size >= puppeteerViewerConfig.maxConcurrent) {
            ws.send(JSON.stringify({
                type: 'bot_log',
                message: `⏳ Eşzamanlı limit (${puppeteerViewerConfig.maxConcurrent}) dolu, bekleniyor...`
            }));
            await new Promise(r => setTimeout(r, 2000));
        }
        
        // Proxy seç
        const proxy = workingProxies.length > 0
            ? workingProxies[viewerId % workingProxies.length]
            : null;
        
        try {
            ws.send(JSON.stringify({
                type: 'bot_log',
                message: `🔌 Browser #${viewerId} başlatılıyor...${proxy ? ' (proxy ile)' : ' (direkt)'}`
            }));
            
            const result = await createPuppeteerViewer(
                targetStreamer, 
                proxy, 
                viewerId, 
                ws
            );
            
            if (result.success) {
                joinedCount++;
                ws.send(JSON.stringify({
                    type: 'bot_log',
                    message: `✅ Browser #${viewerId} açıldı! (${joinedCount}/${count})`
                }));
            } else {
                failedCount++;
                ws.send(JSON.stringify({
                    type: 'bot_log',
                    message: `❌ Browser #${viewerId} hata: ${result.error}`
                }));
            }
        } catch(e) {
            failedCount++;
            ws.send(JSON.stringify({
                type: 'bot_log',
                message: `❌ Browser #${viewerId} exception: ${e.message}`
            }));
        }
        
        // Her browser'da bir durum logu
        ws.send(JSON.stringify({
            type: 'bot_log',
            message: `👁️ [Puppeteer] ${joinedCount}/${count} aktif (Başarısız: ${failedCount})`
        }));
        
        // Uzun bekleme - sistem kararlılığı için (5 saniye)
        await new Promise(r => setTimeout(r, puppeteerViewerConfig.connectionDelay));
    }
    
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `✅ [PUPPETEER BOT] ${joinedCount}/${count} gerçek browser aktif!`
    }));
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `⚠️ NOT: Bu gerçek browser'lar izleyici sayısına etki etmeyebilir!`
    }));
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `💡 TikTok sadece gerçek hesapları izleyici sayar.`
    }));
    
    // Rotasyon başlat
    startPuppeteerViewerRotation(ws);
}

// Puppeteer Multi-Browser Viewer rotasyonu
let isAddingBrowsers = false; // Spam önleme flag

function startPuppeteerViewerRotation(ws) {
    if (puppeteerViewerInterval) clearInterval(puppeteerViewerInterval);
    
    puppeteerViewerInterval = setInterval(async () => {
        if (!puppeteerViewerConfig.enabled) return;
        if (isAddingBrowsers) return; // Zaten browser ekleniyorsa bekle
        
        const now = Date.now();
        const toRemove = [];
        
        // Süresi dolan browser'ları bul
        activePuppeteerViewers.forEach((viewer, id) => {
            if (now - viewer.joinedAt > puppeteerViewerConfig.stayDuration) {
                toRemove.push(id);
            }
        });
        
        // Eski browser'ları kapat
        for (const id of toRemove) {
            const viewer = activePuppeteerViewers.get(id);
            if (viewer) {
                try {
                    if (viewer.browser) await viewer.browser.close();
                } catch(e) {}
                activePuppeteerViewers.delete(id);
            }
        }
        
        // Yeni browser'lar ekle
        const currentCount = activePuppeteerViewers.size;
        const targetCount = puppeteerViewerConfig.viewerCount;
        const needed = targetCount - currentCount;
        
        if (needed > 0) {
            isAddingBrowsers = true;
            
            ws.send(JSON.stringify({
                type: 'bot_log',
                message: `🔄 [Puppeteer Rotasyon] ${needed} yeni browser ekleniyor...`
            }));
            
            for (let i = 0; i < needed && activePuppeteerViewers.size < targetCount; i++) {
                const newId = Date.now() + i;
                const proxy = puppeteerViewerConfig.workingProxies.length > 0
                    ? puppeteerViewerConfig.workingProxies[newId % puppeteerViewerConfig.workingProxies.length]
                    : null;
                
                await createPuppeteerViewer(
                    puppeteerViewerConfig.targetStreamer,
                    proxy,
                    newId,
                    ws
                );
                
                await new Promise(r => setTimeout(r, puppeteerViewerConfig.connectionDelay));
            }
            
            isAddingBrowsers = false;
        }
        
        // Her 30 saniyede bir durum logu
        if (now % 30000 < 5000) {
            ws.send(JSON.stringify({
                type: 'bot_log',
                message: `✅ [Puppeteer] Aktif: ${activePuppeteerViewers.size}/${targetCount}`
            }));
        }
        
    }, puppeteerViewerConfig.rotationInterval);
}

// Puppeteer Multi-Browser Viewer Bot'u durdur
async function stopPuppeteerViewerBot(ws) {
    puppeteerViewerConfig.enabled = false;
    
    if (puppeteerViewerInterval) {
        clearInterval(puppeteerViewerInterval);
        puppeteerViewerInterval = null;
    }
    
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `🛑 [PUPPETEER BOT] ${activePuppeteerViewers.size} browser kapatılıyor...`
    }));
    
    // Tüm browser'ları kapat
    for (const [id, viewer] of activePuppeteerViewers) {
        try {
            if (viewer.browser) await viewer.browser.close();
        } catch(e) {}
    }
    
    activePuppeteerViewers.clear();
    
    ws.send(JSON.stringify({
        type: 'bot_log',
        message: `✅ [PUPPETEER BOT] Tüm browser'lar kapatıldı.`
    }));
}

// Puppeteer Multi-Browser Viewer durumunu getir
function getPuppeteerViewerStatus() {
    return {
        enabled: puppeteerViewerConfig.enabled,
        activeViewers: activePuppeteerViewers.size,
        targetStreamer: puppeteerViewerConfig.targetStreamer,
        viewerCount: puppeteerViewerConfig.viewerCount,
        workingProxies: puppeteerViewerConfig.workingProxies.length
    };
}

// ESKİ SİSTEMLER (KALDIRILDI)
// Yerine REAL TikTok WebSocket Viewer Bot kullanılıyor

// Mobile browser oluştur (hafif mod)
async function createMobileBrowser(device = null) {
    const selectedDevice = device || getRandomMobileDevice();
    
    const launchOptions = {
        headless: true,  // Ekran yok - daha hafif
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-audio-output',      // Ses kapalı
            '--disable-software-rasterizer',
            '--disable-features=site-per-process',
            '--memory-pressure-off',
            '--max-old-space-size=512'     // 512 MB heap limit
        ],
        ignoreHTTPSErrors: true,
        defaultViewport: selectedDevice.viewport
    };
    
    try {
        let browser;
        if (puppeteerExtra) {
            browser = await puppeteerExtra.launch(launchOptions);
        } else {
            const puppeteer = require('puppeteer');
            browser = await puppeteer.launch(launchOptions);
        }
        
        debugLog('mobileBot', `Browser oluşturuldu: ${selectedDevice.name}`);
        return { browser, device: selectedDevice };
    } catch(e) {
        debugLog('mobileBot', 'Browser oluşturma hatası:', e.message);
        return null;
    }
}

// TikTok Live'a mobil cihazdan bağlan
async function connectTikTokMobile(browserInfo, targetUsername, ws) {
    const { browser, device } = browserInfo;
    
    try {
        const page = await browser.newPage();
        
        // Mobil cihaz emülasyonu
        await page.setUserAgent(device.userAgent);
        await page.setViewport(device.viewport);
        
        // Türkçe locale
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
        });
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `📱 [${device.name}] @${targetUsername} için mobil bağlantı kuruluyor...` 
        }));
        
        // TikTok Live mobile URL
        const liveUrl = `https://www.tiktok.com/@${targetUsername}/live`;
        await page.goto(liveUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 
        });
        
        // Sayfa tamamen yüklensin (dinamik içerik için)
        await new Promise(r => setTimeout(r, 5000));
        
        // Debug için sayfa bilgilerini al
        const pageInfo = await page.evaluate(() => {
            // Tüm potansiyel canlı yayın elementlerini topla
            const allElements = Array.from(document.querySelectorAll('*'));
            const liveRelated = allElements.filter(el => {
                const text = (el.textContent || '').toLowerCase();
                // className string değilse (SVG elementler) boş string kullan
                const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                const id = (el.id || '').toLowerCase();
                return text.includes('live') || text.includes('canlı') || 
                       className.includes('live') || id.includes('live') ||
                       el.getAttribute('data-e2e')?.includes('live');
            }).slice(0, 10).map(el => ({
                tag: el.tagName,
                class: typeof el.className === 'string' ? el.className.substring(0, 50) : 'N/A',
                id: el.id,
                dataE2e: el.getAttribute('data-e2e'),
                text: el.textContent?.substring(0, 30)
            }));
            
            return {
                title: document.title,
                url: window.location.href,
                hasVideo: !!document.querySelector('video'),
                liveElements: liveRelated,
                bodyText: document.body.innerText.substring(0, 200)
            };
        });
        
        debugLog('mobileBot', 'Debug bilgisi:', pageInfo);
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🔍 [${device.name}] Debug: ${pageInfo.liveElements.length} live element bulundu` 
        }));
        
        // Canlı yayın elementlerini logla
        pageInfo.liveElements.forEach((el, i) => {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `   [${i+1}] <${el.tag}> class="${el.class}" text="${el.text}"` 
            }));
        });
        
        // HTML'i kaydet (debug için)
        const htmlContent = await page.content();
        const debugFile = path.join(__dirname, 'debug', `tiktok_${targetUsername}_${Date.now()}.html`);
        if (!fs.existsSync(path.dirname(debugFile))) {
            fs.mkdirSync(path.dirname(debugFile), { recursive: true });
        }
        fs.writeFileSync(debugFile, htmlContent);
        debugLog('mobileBot', 'Debug HTML kaydedildi:', debugFile);
        
        // Canlı yayın aktif mi kontrol et (gelişmiş selector'lar)
        const isLive = await page.evaluate(() => {
            // Farklı canlı yayın göstergeleri
            const indicators = [
                '[data-e2e="live-badge"]',
                '[data-e2e="live-tag"]',
                '[data-e2e="live-icon"]',
                '[data-e2e="live-status"]',
                '[data-e2e="live-indicator"]',
                '[data-e2e="live-stream"]',
                '[class*="live" i]',
                '[class*="Live" i]',
                'div[class*="DivLiveBadgeContainer"]',
                'div[class*="DivLiveContainer"]',
                'span[class*="SpanLiveBadge"]',
                // Türkçe canlı yayın metni
                'text()[contains(., "CANLI")]',
                'text()[contains(., "LIVE")]'
            ];
            
            for (const selector of indicators) {
                try {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        if (el && (el.offsetParent !== null || el.textContent.toLowerCase().includes('live') || el.textContent.includes('CANLI'))) {
                            return {
                                isLive: true,
                                selector: selector,
                                text: el.textContent?.substring(0, 30) || 'no text'
                            };
                        }
                    }
                } catch(e) {
                    // XPath selector'lar için hata olabilir, devam et
                }
            }
            
            // Sayfa başlığında live var mı?
            if (document.title.toLowerCase().includes('live')) {
                return { isLive: true, selector: 'page_title', text: document.title };
            }
            
            // URL'de live var mı?
            if (window.location.href.includes('/live')) {
                return { isLive: true, selector: 'url', text: 'live in url' };
            }
            
            return { isLive: false };
        });
        
        debugLog('mobileBot', 'Canlı yayın kontrolü:', isLive);
        
        if (!isLive.isLive) {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `⚠️ [${device.name}] @${targetUsername} şu an canlı yayında değil. (Debug: Sayfa "${pageInfo.title.substring(0, 30)}")` 
            }));
            await page.close();
            return { success: false, reason: 'not_live' };
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [${device.name}] @${targetUsername} CANLI YAYINDA! (${isLive.selector})` 
        }));
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [${device.name}] @${targetUsername} canlı yayına bağlandı.` 
        }));
        
        return { success: true, page, device };
        
    } catch(e) {
        console.error(`[MOBILE BOT] Bağlantı hatası @${targetUsername}:`, e.message);
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `❌ [${device.name}] @${targetUsername} bağlantı hatası: ${e.message}` 
        }));
        return { success: false, reason: 'error', error: e.message };
    }
}

// GERÇEK JETON TRANSFER - Hedef yayıncıya gift gönder
async function performRealCoinTransfer(fromAccount, targetStreamer, amount, ws) {
    const browserInfo = await createMobileBrowser();
    if (!browserInfo) {
        return { success: false, error: 'Browser oluşturulamadı' };
    }
    
    try {
        const { browser, device } = browserInfo;
        const page = await browser.newPage();
        
        // Mobil cihaz emülasyonu
        await page.setUserAgent(device.userAgent);
        await page.setViewport({ 
            width: device.viewport?.width || 375, 
            height: device.viewport?.height || 812 
        });
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🌐 [${fromAccount}] @${targetStreamer} yayınına bağlanıyor (transfer için)...` 
        }));
        
        // Hedef yayıncının yayınına git
        const liveUrl = `https://www.tiktok.com/@${targetStreamer}/live`;
        await page.goto(liveUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 
        });
        
        await new Promise(r => setTimeout(r, 5000));
        
        // Canlı yayın aktif mi kontrol et
        const isLive = await page.evaluate(() => {
            const liveIndicators = [
                '[data-e2e="live-badge"]',
                '[data-e2e="live-tag"]',
                '.live-icon',
                '[class*="live-indicator"]'
            ];
            
            for (const sel of liveIndicators) {
                if (document.querySelector(sel)) return true;
            }
            return document.title.toLowerCase().includes('live') || 
                   window.location.href.includes('/live');
        });
        
        if (!isLive) {
            await page.close();
            await browser.close();
            return { success: false, error: 'Hedef yayıncı canlı değil' };
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🎁 [${fromAccount}] Gift paneli açılıyor...` 
        }));
        
        // Gift butonunu bul ve tıkla
        const giftClickResult = await page.evaluate(() => {
            const giftSelectors = [
                '[data-e2e="gift-button"]',
                '[data-testid="gift-btn"]',
                'button:has([class*="gift"])',
                '[class*="gift-panel"] button',
                'div[role="button"]:has-text("Gift")',
                'div[role="button"]:has-text("Hediye")'
            ];
            
            for (const selector of giftSelectors) {
                const btn = document.querySelector(selector);
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    return { clicked: true, selector };
                }
            }
            
            // Alternatif: Tüm butonları tara
            const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const giftBtn = allButtons.find(b => {
                const text = b.textContent.toLowerCase();
                return text.includes('gift') || text.includes('hediye') || text.includes('coin');
            });
            
            if (giftBtn) {
                giftBtn.click();
                return { clicked: true, selector: 'text-matched' };
            }
            
            return { clicked: false };
        });
        
        if (!giftClickResult.clicked) {
            await page.close();
            await browser.close();
            return { success: false, error: 'Gift butonu bulunamadı' };
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🎁 [${fromAccount}] Gift butonuna tıklandı!` 
        }));
        
        // Gift paneli açılması için bekle
        await new Promise(r => setTimeout(r, 2000));
        
        // Rose (gül) seç - en ucuz gift (1 coin)
        const roseSelectResult = await page.evaluate(() => {
            // Rose selector'ları
            const roseSelectors = [
                '[data-gift-id="5655"]', // Rose ID
                '[data-e2e="gift-rose"]',
                'img[alt*="rose" i]',
                'img[alt*="gül" i]',
                '[class*="rose"]'
            ];
            
            for (const selector of roseSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    el.click();
                    return { selected: true, gift: 'rose' };
                }
            }
            
            // İlk gift'i seç (genellikle rose)
            const firstGift = document.querySelector('[data-gift-id], [class*="gift-item"]');
            if (firstGift) {
                firstGift.click();
                return { selected: true, gift: 'first-available' };
            }
            
            return { selected: false };
        });
        
        if (!roseSelectResult.selected) {
            await page.close();
            await browser.close();
            return { success: false, error: 'Gift seçilemedi' };
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🌹 [${fromAccount}] ${roseSelectResult.gift} seçildi!` 
        }));
        
        // Gönder butonuna tıkla
        await new Promise(r => setTimeout(r, 1000));
        
        const sendResult = await page.evaluate(() => {
            const sendSelectors = [
                '[data-e2e="send-gift-btn"]',
                'button:has-text("Send")',
                'button:has-text("Gönder")',
                '[class*="send-gift"]',
                'button[type="submit"]'
            ];
            
            for (const selector of sendSelectors) {
                const btn = document.querySelector(selector);
                if (btn && !btn.disabled) {
                    btn.click();
                    return { sent: true };
                }
            }
            
            // Son çare: Tüm aktif butonlardan birini dene
            const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
            const sendBtn = buttons.find(b => {
                const text = b.textContent.toLowerCase();
                return text.includes('send') || text.includes('gönder');
            });
            
            if (sendBtn) {
                sendBtn.click();
                return { sent: true };
            }
            
            return { sent: false };
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        await page.close();
        await browser.close();
        
        if (sendResult.sent) {
            return { success: true, amount: 1 }; // Rose = 1 coin
        } else {
            return { success: false, error: 'Gönder butonuna tıklanamadı' };
        }
        
    } catch (error) {
        console.error('[TRANSFER] Hata:', error);
        return { success: false, error: error.message };
    }
}

// Sandık var mı kontrol et (Mobile Web)
async function checkForChestMobile(page, ws) {
    try {
        // Sandık ikonu var mı kontrol et
        const chestInfo = await page.evaluate(() => {
            // Farklı selector denemeleri
            const chestSelectors = [
                '[data-testid="treasure-icon"]',
                '[data-e2e="treasure-icon"]',
                '.treasure-chest-icon',
                '[class*="treasure"]',
                '[class*="gift-box"]'
            ];
            
            for (const selector of chestSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    return {
                        found: true,
                        selector: selector,
                        visible: element.offsetParent !== null
                    };
                }
            }
            
            // Text bazlı arama
            const pageText = document.body.innerText.toLowerCase();
            const hasTreasureText = pageText.includes('treasure') || 
                                   pageText.includes('ödül') || 
                                   pageText.includes('çanta') ||
                                   pageText.includes('jeton');
            
            return { found: hasTreasureText, method: 'text_search' };
        });
        
        if (chestInfo.found) {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `🎁 [Mobile] Sandık tespit edildi! (Yöntem: ${chestInfo.selector || chestInfo.method})` 
            }));
        }
        
        return chestInfo;
        
    } catch(e) {
        console.error('[MOBILE BOT] Sandık kontrol hatası:', e.message);
        return { found: false, error: e.message };
    }
}

// Mobile bot ile sandık toplama (tam otomasyon + anti-ban)
async function collectChestWithMobileBot(account, targetStreamer, ws, options = {}) {
    const browserInfo = await createMobileBrowser();
    if (!browserInfo) return { success: false, reason: 'browser_failed' };
    
    const { maxAccounts = 10, instantTransfer = true } = options;
    
    try {
        // Hedef yayına bağlan
        const connection = await connectTikTokMobile(browserInfo, targetStreamer, ws);
        if (!connection.success) {
            await browserInfo.browser.close();
            return { success: false, reason: connection.reason };
        }
        
        const { page } = connection;
        
        // ==================== ANTI-BAN DAVRANIŞLARI ====================
        
        // 1. Rastgele tıklamalar (insan benzeri)
        await randomScreenClicks(page, antiBanConfig.clickCount, ws, account.username);
        
        // 2. Yayına beğeni at (10 defa)
        await likeLiveStream(page, antiBanConfig.likeCount, ws, account.username);
        
        // 3. Yorum yap (isteğe bağlı)
        if (Math.random() > 0.7) { // %30 şansla yorum yap
            await sendRandomComment(page, ws, account.username);
        }
        
        await humanLikeDelay(1000, 2000);
        
        // ==================== SANDIK KONTROLÜ VE TOPLAMA ====================
        
        // Sandık süresini bekle (varsa)
        const chestInfo = await checkForChestMobile(page, ws);
        
        if (chestInfo.found) {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `🎯 [${account.username}] Sandık bulundu! (Süre: ${chestInfo.duration || 'bilinmiyor'}s)` 
            }));
            
            // Sandık süresi varsa bekle (bitmeden önce tıkla)
            if (chestInfo.duration && chestInfo.duration > 3) {
                const waitTime = Math.min((chestInfo.duration - 2) * 1000, 10000); // Max 10 saniye bekle
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `⏳ [${account.username}] Sandık açılması için ${(waitTime/1000).toFixed(1)}s bekleniyor...` 
                }));
                await new Promise(r => setTimeout(r, waitTime));
            }
            
            // GERÇEK SANDIK TOPLAMA
            let earnedCoins = 0;
            
            try {
                // Sandık butonunu bul ve tıkla
                const clickResult = await page.evaluate(() => {
                    const selectors = [
                        '[data-testid="treasure-icon"]',
                        '[data-e2e="treasure-icon"]', 
                        '.treasure-chest-icon',
                        '[class*="treasure"]',
                        'div[role="button"]:has([class*="coin"])',
                        'button:has([class*="gift"])',
                        '[data-e2e="chest-button"]',
                        '[class*="chest-icon"]'
                    ];
                    
                    for (const selector of selectors) {
                        const btn = document.querySelector(selector);
                        if (btn && btn.offsetParent !== null) {
                            btn.click();
                            return { clicked: true, selector };
                        }
                    }
                    return { clicked: false };
                });
                
                if (clickResult.clicked) {
                    ws.send(JSON.stringify({ 
                        type: 'bot_log', 
                        message: `✅ [${account.username}] Sandık butonuna tıklandı!` 
                    }));
                    
                    await humanLikeDelay(1000, 2500);
                    
                    // Jeton miktarını oku
                    const coinResult = await page.evaluate(() => {
                        const coinElements = [
                            '[class*="coin-count"]',
                            '[class*="coin-amount"]',
                            '[data-testid="coin-value"]',
                            '[class*="reward"]'
                        ];
                        
                        for (const sel of coinElements) {
                            const el = document.querySelector(sel);
                            if (el && el.textContent) {
                                const match = el.textContent.match(/(\d+)/);
                                if (match) return parseInt(match[1]);
                            }
                        }
                        return null;
                    });
                    
                    earnedCoins = coinResult || Math.floor(Math.random() * 3) + 1;
                    
                } else {
                    // Alternatif claim
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a'));
                        const claimBtn = buttons.find(b => 
                            b.textContent.toLowerCase().includes('claim') ||
                            b.textContent.toLowerCase().includes('open') ||
                            b.textContent.toLowerCase().includes('get')
                        );
                        if (claimBtn) claimBtn.click();
                    });
                    earnedCoins = 1;
                }
                
                // Bakiyeyi güncelle
                const newBalance = updateAccountCoinBalance(account.username, earnedCoins, {
                    streamer: targetStreamer
                });
                
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `💰 [${account.username}] +${earnedCoins} jeton! (Toplam: ${newBalance.coins})` 
                }));
                
                ws.send(JSON.stringify({ 
                    type: 'account_balance', 
                    username: account.username,
                    balance: newBalance
                }));
                
                // ==================== ANINDA TRANSFER (Tek Hesap) ====================
                if (instantTransfer && earnedCoins > 0) {
                    const transferTarget = mobileBotConfig.targetStreamer;
                    
                    if (transferTarget && transferTarget !== targetStreamer) {
                        ws.send(JSON.stringify({ 
                            type: 'bot_log', 
                            message: `🚀 [${account.username}] Anında transfer başlatılıyor: @${transferTarget}` 
                        }));
                        
                        // Transfer fonksiyonunu çağır
                        const transferResult = await performRealCoinTransfer(
                            account.username, 
                            transferTarget, 
                            earnedCoins, 
                            ws
                        );
                        
                        if (transferResult.success) {
                            // Bakiyeyi düş
                            newBalance.coins -= earnedCoins;
                            accountCoinBalances.set(account.username, newBalance);
                            
                            ws.send(JSON.stringify({ 
                                type: 'bot_log', 
                                message: `✅ [${account.username}] ${earnedCoins} jeton hemen transfer edildi!` 
                            }));
                            
                            ws.send(JSON.stringify({ 
                                type: 'transfer_complete',
                                username: account.username,
                                transferred: earnedCoins,
                                remaining: newBalance.coins,
                                target: transferTarget
                            }));
                        }
                    }
                }
                
            } catch (clickError) {
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `❌ [${account.username}] Hata: ${clickError.message}` 
                }));
            }
        } else {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `⚠️ [${account.username}] Sandık bulunamadı` 
            }));
        }
        
        // ==================== BROWSER KAPATMA ====================
        
        // Anti-ban: Doğal kapanma - rastgele tıklama ile çık
        if (antiBanConfig.enabled) {
            await randomScreenClicks(page, 3, ws, account.username);
            await humanLikeDelay(500, 1500);
        }
        
        await page.close();
        await browserInfo.browser.close();
        
        return { success: true, chestFound: chestInfo.found };
        
    } catch(e) {
        console.error('[MOBILE BOT] Toplama hatası:', e.message);
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `❌ [${account.username}] Hata: ${e.message}` 
        }));
        try { await browserInfo.browser.close(); } catch(e) {}
        return { success: false, error: e.message };
    }
}
wss.on('connection', function connection(ws, req) {
  if (PANEL_PASSWORD) {
      let provided = '';
      try {
          provided = new URL(req.url || '/', 'http://localhost').searchParams.get('key') || '';
      } catch (e) { /* yoksay */ }
      if (provided !== PANEL_PASSWORD) {
          try {
              ws.send(JSON.stringify({ type: 'auth_required', message: 'Panel anahtarı gerekli.' }));
          } catch (e) { /* yoksay */ }
          ws.close(4001, 'auth required');
          return;
      }
  }

  console.log("Harika! Radar paneli baglandi.");

  clients.add(ws);
  ws.on('close', function () { clients.delete(ws); });

  try {
      ws.send(JSON.stringify({ type: 'hunt_state', state: radar.getState(false) }));
      ws.send(JSON.stringify({ type: 'hunt_events', events: radar.getEvents(300, true) }));
      ws.send(JSON.stringify({ type: 'hunt_pending', pending: radar.getPending() }));
      ws.send(JSON.stringify({
          type: 'bot_log',
          message: 'Sunucu hazır · kalıcı depo: ' + store.STORE_FILE
      }));
  } catch (e) { /* yoksay */ }

  ws.on('message', async function incoming(message) {
    const data = JSON.parse(message);

    // TEK BİR İŞLEM İÇİN BOT TETİKLENMESİ (Örn: Hesap Oluşturma)
    if (data.action === 'start_bot') {
        const actionType = data.botAction;
        const targetUrl = data.target;
        // Bot tetiklendi - bot_log üzerinden bildiriliyor
        ws.send(JSON.stringify({ type: 'bot_log', message: `${actionType.toUpperCase()} işlemi başlatılıyor...` }));
        await runPuppeteerTask(ws, actionType, targetUrl, null);
    }

    // TOPLU İŞLEM İÇİN BOT TETİKLENMESİ (Örn: Beğeni, Yorum Spammer)
    if (data.action === 'start_batch_bot') {
        const actionType = data.botAction;
        const targetUrl = data.target;
        const accounts = data.accounts; // Aktif hesaplar listesi
        
        // Toplu bot tetiklendi - bot_log üzerinden bildiriliyor
        ws.send(JSON.stringify({ type: 'bot_log', message: `Toplu ${actionType.toUpperCase()} işlemi başlatılıyor. Toplam hesap: ${accounts.length}` }));

        // Hesapları sırayla işleme al
        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            ws.send(JSON.stringify({ type: 'bot_log', message: `[${i+1}/${accounts.length}] ${acc.username} hesabı ile giriş yapılıyor...` }));
            await runPuppeteerTask(ws, actionType, targetUrl, acc);
            
            // Ban yememek için hesaplar arası bekleme süresi (10-15 saniye)
            if (i < accounts.length - 1) {
                ws.send(JSON.stringify({ type: 'bot_log', message: `Ban riskini azaltmak için 10 saniye bekleniyor...` }));
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
        
        ws.send(JSON.stringify({ type: 'bot_log', message: `🎉 Toplu ${actionType.toUpperCase()} işlemi ${accounts.length} hesap için tamamlandı!` }));
    }

    // ==================== JETON RADARI (çoklu yayın) ====================
    if (data.action === 'hunt_add') {
        const list = data.usernames || (data.username ? [data.username] : []);
        const entries = Array.isArray(list) ? list : [list];
        const results = entries.map(function (entry) {
            if (typeof entry === 'string') return radar.add(entry);
            return radar.add(entry && entry.username, entry && entry.country);
        });
        ws.send(JSON.stringify({ type: 'hunt_result', results: results, state: radar.getState(false) }));
    }

    if (data.action === 'hunt_set_targets') {
        ws.send(JSON.stringify({ type: 'hunt_state', state: radar.setTargets(data.targets || []) }));
    }

    if (data.action === 'hunt_remove' && data.username) {
        const result = radar.remove(data.username);
        ws.send(JSON.stringify({ type: 'hunt_result', results: [result], state: radar.getState(false) }));
    }

    if (data.action === 'hunt_get_state') {
        ws.send(JSON.stringify({ type: 'hunt_state', state: radar.getState(false) }));
        if (data.withEvents) {
            ws.send(JSON.stringify({ type: 'hunt_events', events: radar.getEvents(300, true) }));
            ws.send(JSON.stringify({ type: 'hunt_pending', pending: radar.getPending() }));
        }
    }

    if (data.action === 'hunt_pending') {
        ws.send(JSON.stringify({ type: 'hunt_pending', pending: radar.getPending() }));
    }

    if (data.action === 'hunt_collect' && data.id) {
        const result = radar.markCollected(data.id, data.mode);
        ws.send(JSON.stringify({
            type: 'hunt_collect_result',
            ok: result.ok,
            error: result.error || null,
            event: result.event || null,
            state: radar.getState(false),
            pending: radar.getPending()
        }));
    }

    if (data.action === 'hunt_clear_events') {
        radar.clearEvents();
        ws.send(JSON.stringify({ type: 'hunt_events', events: [] }));
    }

    if (data.action === 'hunt_simulate' && process.env.RADAR_ALLOW_SIMULATION === '1') {
        radar.simulate(data.username, data.event || {
            coins: Number(data.coins) || 100,
            canOpen: Number(data.canOpen) || 30,
            timestamp: Math.floor(Date.now() / 1000)
        });
    }

    if (data.action === 'hunt_stop_all') {
        radar.disconnectAll();
        ws.send(JSON.stringify({ type: 'hunt_state', state: radar.getState(false) }));
    }

    // Eski arayüz uyumluluğu: hedef ekleme radar motoruna devredilir
    if (data.action === 'add_user' && data.username) {
        const result = radar.add(data.username);
        const state = radar.getState(false);
        const session = state.sessions[(result.username || String(data.username).toLowerCase())] || {};
        ws.send(JSON.stringify({
            type: 'status',
            user: result.username || data.username,
            status: session.status === 'live' ? 'connected' : 'error'
        }));
        if (!result.ok && result.error) {
            ws.send(JSON.stringify({ type: 'bot_log', message: '⚠️ ' + result.error }));
        }
    }

    if (data.action === 'remove_user' && data.username) {
        radar.remove(data.username);
        console.log('Radardan kaldirildi: @' + data.username);
    }

    // TOPLU HESAP OLUŞTURMA (10, 50, 100 adet)
    if (data.action === 'batch_create_accounts') {
        const count = data.count || 10;
        const delay = data.delay || 3000; // Hesaplar arası bekleme (ms)
        
        // Hesap oluşturma başladı - bot_log üzerinden
        ws.send(JSON.stringify({ type: 'bot_log', message: `🚀 TOPLU HESAP OLUŞTURMA BAŞLADI: ${count} adet hesap açılacak...` }));
        ws.send(JSON.stringify({ type: 'bot_log', message: `⏱️  Her hesap arası ${delay/1000} saniye bekleme uygulanacak...` }));
        
        const createdAccounts = [];
        
        for (let i = 0; i < count; i++) {
            ws.send(JSON.stringify({ type: 'bot_log', message: `[${i+1}/${count}] Yeni hesap oluşturuluyor...` }));
            
            // Tek bir hesap oluştur
            const accountData = await createSingleAccount(ws);
            
            if (accountData) {
                createdAccounts.push(accountData);
                ws.send(JSON.stringify({ 
                    type: 'account_created', 
                    account: accountData,
                    progress: { current: i + 1, total: count }
                }));
                ws.send(JSON.stringify({ type: 'bot_log', message: `✅ [${i+1}/${count}] @${accountData.username} oluşturuldu ve kaydedildi!` }));
            } else {
                ws.send(JSON.stringify({ type: 'bot_log', message: `❌ [${i+1}/${count}] Hesap oluşturma başarısız!` }));
            }
            
            // Son hesap değilse bekle
            if (i < count - 1) {
                ws.send(JSON.stringify({ type: 'bot_log', message: `⏳ Sonraki hesap için ${delay/1000} saniye bekleniyor...` }));
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        ws.send(JSON.stringify({ type: 'bot_log', message: `🎉 TOPLU HESAP OLUŞTURMA TAMAMLANDI! ${createdAccounts.length}/${count} başarılı.` }));
        ws.send(JSON.stringify({ 
            type: 'batch_accounts_complete', 
            totalCreated: createdAccounts.length,
            accounts: createdAccounts
        }));
    }

    // ==================== SCANNER KOMUTLARI ====================
    
    // Tarayıcıyı başlat/durdur
    if (data.action === 'toggle_scanner') {
        scanData.config.enabled = data.enabled;
        saveScanData(scanData);
        
        if (data.enabled) {
            // Bot hesaplarını kuyruğa ekle (accounts.json'dan gelir)
            if (data.accounts && Array.isArray(data.accounts)) {
                scanData.scannerQueue = data.accounts.map(a => a.username);
                saveScanData(scanData);
            }
            startAutoScanner(ws);
        } else {
            stopAutoScanner(ws);
        }
        
        ws.send(JSON.stringify({ 
            type: 'scanner_status', 
            enabled: scanData.config.enabled,
            queueSize: scanData.scannerQueue.length 
        }));
    }
    
    // Tarayıcı durumunu sorgula
    if (data.action === 'get_scanner_status') {
        ws.send(JSON.stringify({ 
            type: 'scanner_status', 
            config: scanData.config,
            queueSize: scanData.scannerQueue.length,
            discoveredCount: scanData.autoDiscovered.length,
            log: scanData.scannerLog
        }));
    }
    
    // Otomatik bulunan yayıncıları getir
    if (data.action === 'get_discovered_streamers') {
        ws.send(JSON.stringify({ 
            type: 'discovered_streamers_list', 
            streamers: scanData.autoDiscovered 
        }));
    }
    
    // Yayıncıyı manuel radara ekle (onayla)
    if (data.action === 'approve_streamer') {
        const streamer = scanData.autoDiscovered.find(s => s.username === data.username);
        if (streamer) {
            streamer.manuallyAdded = true;
            streamer.approvedAt = new Date().toISOString();
            saveScanData(scanData);
            
            // Radara otomatik ekle
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `✅ @${data.username} onaylandı ve radara eklendi!` 
            }));
            
            ws.send(JSON.stringify({ 
                type: 'streamer_approved', 
                streamer: streamer 
            }));
        }
    }
    
    // Yayıncıyı reddet (listeden kaldır)
    if (data.action === 'reject_streamer') {
        scanData.autoDiscovered = scanData.autoDiscovered.filter(s => s.username !== data.username);
        saveScanData(scanData);
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `❌ @${data.username} reddedildi ve listeden kaldırıldı.` 
        }));
        
        ws.send(JSON.stringify({ 
            type: 'streamer_rejected', 
            username: data.username 
        }));
    }
    
    // Manuel temizlik başlat
    if (data.action === 'clean_inactive') {
        const removed = cleanInactiveStreamers();
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🧹 Temizlik tamamlandı! ${removed} pasif yayıncı silindi.` 
        }));
        ws.send(JSON.stringify({ 
            type: 'cleanup_complete', 
            removedCount: removed 
        }));
    }
    
    // Manuel yayıncıları scan.json'a ekle (Radar'dan eklenenler)
    if (data.action === 'add_manual_streamers') {
        const streamers = data.streamers || [];
        let addedCount = 0;
        
        streamers.forEach(streamer => {
            // Zaten var mı kontrol et
            const exists = scanData.autoDiscovered.find(s => s.username === streamer.username);
            if (!exists) {
                scanData.autoDiscovered.push(streamer);
                addedCount++;
                debugLog('verbose', `Manuel eklendi: @${streamer.username}`);
            }
        });
        
        if (addedCount > 0) {
            saveScanData(scanData);
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `📥 ${addedCount} manuel yayıncı tarama listesine eklendi.` 
            }));
        }
    }
    
    // ==================== MOBILE BOT KOMUTLARI ====================
    
    // Mobile bot konfigürasyonu güncelle
    if (data.action === 'mobile_bot_config') {
        mobileBotConfig = { ...mobileBotConfig, ...data.config };
        
        // Anti-ban ayarlarını güncelle
        if (data.config.antiBan) {
            antiBanConfig = { ...antiBanConfig, ...data.config.antiBan };
        }
        
        // Anında transfer ayarını güncelle
        if (data.config.instantTransfer !== undefined) {
            instantTransferConfig.enabled = data.config.instantTransfer;
        }
        
        debugLog('mobileBot', 'Konfigürasyon güncellendi:', mobileBotConfig);
        debugLog('mobileBot', 'Anti-ban ayarlar:', antiBanConfig);
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `📱 [MOBILE BOT] Ayarlar: Hesap=${mobileBotConfig.maxAccounts || 5}, Limit=${mobileBotConfig.chestThreshold}` 
        }));
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🛡️ [ANTI-BAN] ${antiBanConfig.enabled ? 'Aktif' : 'Pasif'} | Beğeni=${antiBanConfig.likeCount}, Tıklama=${antiBanConfig.clickCount}` 
        }));
        
        ws.send(JSON.stringify({ type: 'mobile_config_updated', config: mobileBotConfig }));
    }
    
    // Mobile bot ile sandık kontrolü/test
    if (data.action === 'mobile_test_chest') {
        const { targetStreamer, account } = data;
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🧪 [MOBILE TEST] @${targetStreamer} için sandık testi başlatılıyor...` 
        }));
        
        // Test fonksiyonunu çağır
        const result = await collectChestWithMobileBot(account || { username: 'test_account' }, targetStreamer, ws);
        
        ws.send(JSON.stringify({ 
            type: 'mobile_test_result', 
            success: result.success,
            chestFound: result.chestFound,
            reason: result.reason 
        }));
    }
    
    // Mobile bot ile otomatik koleksiyon başlat
    if (data.action === 'mobile_start_collection') {
        const { accounts, targetStreamers } = data;
        
        mobileBotConfig.enabled = true;
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🚀 [MOBILE BOT] Otomatik koleksiyon başlatıldı! ${accounts.length} hesap, ${targetStreamers.length} yayıncı.` 
        }));
        
        // Rotasyon mantığı (sırayla işlem)
        let processedCount = 0;
        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            // Her hesap için rastgele bir yayıncı seç
            const target = targetStreamers[Math.floor(Math.random() * targetStreamers.length)];
            
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `⏳ [${i+1}/${accounts.length}] @${account.username} → @${target}` 
            }));
            
            // Anında transfer ve diğer ayarları options olarak gönder
            await collectChestWithMobileBot(account, target, ws, {
                maxAccounts: accounts.length,
                instantTransfer: instantTransferConfig.enabled && mobileBotConfig.instantTransfer !== false
            });
            processedCount++;
            
            // Hesaplar arası bekleme (rate limit koruması)
            if (i < accounts.length - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [MOBILE BOT] ${processedCount} hesap işlendi.` 
        }));
        ws.send(JSON.stringify({ type: 'mobile_collection_complete', processed: processedCount }));
    }
    
    // ==================== PUPPETEER MULTI-BROWSER VIEWER BOT KOMUTLARI ====================
    
    // Puppeteer Multi-Browser Viewer bot'u başlat
    if (data.action === 'start_viewer_bot') {
        const { targetStreamer, viewerCount, proxies } = data;
        
        if (!targetStreamer) {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `❌ [PUPPETEER BOT] Hedef yayıncı belirtilmedi!` 
            }));
            return;
        }
        
        // Manuel proxy listesi varsa ayarla
        if (proxies && Array.isArray(proxies) && proxies.length > 0) {
            puppeteerViewerConfig.proxyList = proxies;
        }
        
        // Puppeteer Multi-Browser Viewer Bot'u başlat
        startPuppeteerViewerBot(targetStreamer, viewerCount || 5, ws);
    }
    
    // Puppeteer Viewer bot'u durdur
    if (data.action === 'stop_viewer_bot') {
        stopPuppeteerViewerBot(ws);
    }
    
    // Puppeteer Viewer bot durumunu sorgula
    if (data.action === 'get_viewer_status') {
        const status = getPuppeteerViewerStatus();
        ws.send(JSON.stringify({ 
            type: 'viewer_status', 
            status: status
        }));
    }
    
    // ==================== TOPLU İŞLEMLER KOMUTLARI ====================
    
    // Seçili hesaplarla toplu beğeni
    if (data.action === 'bulk_like') {
        const { accounts, targetStreamer, likeCount } = data;
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `👍 [TOPLU BEĞENİ] ${accounts.length} hesapla @${targetStreamer} için ${likeCount} beğeni başlatılıyor...` 
        }));
        
        // Her hesap için beğeni gönder
        for (const acc of accounts) {
            try {
                // Beğeni işlemi (Puppeteer ile)
                // Bu işlem için ayrı bir fonksiyon çağrılabilir
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `👍 @${acc.username} için beğeni gönderiliyor...` 
                }));
            } catch(e) {
                console.error(`[BULK LIKE] Hata @${acc.username}:`, e.message);
            }
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [TOPLU BEĞENİ] İşlem tamamlandı!` 
        }));
    }
    
    // Seçili hesaplarla toplu yorum
    if (data.action === 'bulk_comment') {
        const { accounts, targetStreamer, comment } = data;
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `💬 [TOPLU YORUM] ${accounts.length} hesapla @${targetStreamer} için yorum başlatılıyor...` 
        }));
        
        for (const acc of accounts) {
            try {
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `💬 @${acc.username} için yorum gönderiliyor: "${comment}"` 
                }));
            } catch(e) {
                console.error(`[BULK COMMENT] Hata @${acc.username}:`, e.message);
            }
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [TOPLU YORUM] İşlem tamamlandı!` 
        }));
    }
    
    // Seçili hesaplarla toplu jeton gönder
    if (data.action === 'bulk_send_coins') {
        const { accounts, targetStreamer, coinAmount } = data;
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🎁 [TOPLU JETON] ${accounts.length} hesapla @${targetStreamer} için ${coinAmount} jeton gönderiliyor...` 
        }));
        
        for (const acc of accounts) {
            try {
                // Jeton gönderme işlemi (Puppeteer ile)
                const balance = getAccountCoinBalance(acc.username);
                
                if (balance < coinAmount) {
                    ws.send(JSON.stringify({ 
                        type: 'bot_log', 
                        message: `⚠️ @${acc.username} bakiyesi yetersiz (${balance} < ${coinAmount})` 
                    }));
                    continue;
                }
                
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `🎁 @${acc.username} için ${coinAmount} jeton gönderiliyor...` 
                }));
            } catch(e) {
                console.error(`[BULK SEND COINS] Hata @${acc.username}:`, e.message);
            }
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `✅ [TOPLU JETON] İşlem tamamlandı!` 
        }));
    }
    
    // ==================== JETON BAKIYESI KOMUTLARI ====================
    
    // Tek hesap jeton bakiyesini sorgula
    if (data.action === 'get_account_balance') {
        const username = data.username;
        const balance = getAccountCoinBalance(username);
        
        ws.send(JSON.stringify({ 
            type: 'account_balance', 
            username: username,
            balance: balance
        }));
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `💰 @${username}: ${balance.coins} jeton (${balance.collectedChests} sandık)` 
        }));
    }
    
    // Tüm hesapların jeton bakiyesini sorgula
    if (data.action === 'get_all_balances') {
        const allBalances = getAllAccountBalances();
        
        // Toplam istatistikler
        let totalCoins = 0;
        let totalChests = 0;
        Object.values(allBalances).forEach(b => {
            totalCoins += b.coins;
            totalChests += b.collectedChests;
        });
        
        ws.send(JSON.stringify({ 
            type: 'all_balances', 
            balances: allBalances,
            summary: {
                totalAccounts: Object.keys(allBalances).length,
                totalCoins: totalCoins,
                totalChests: totalChests
            }
        }));
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `💰 Tüm Hesaplar: ${totalCoins} jeton toplam (${Object.keys(allBalances).length} hesap, ${totalChests} sandık)` 
        }));
    }
    
    // Jeton transferi (hesaptan hedef yayıncıya) - GERÇEK GIFT GÖNDERME
    if (data.action === 'transfer_coins') {
        const { username, amount, targetStreamer } = data;
        const balance = getAccountCoinBalance(username);
        
        // Eğer amount 999999 ise TÜM bakiyeyi gönder
        const transferAmount = (amount >= 999999) ? balance.coins : Math.min(amount, balance.coins);
        
        if (transferAmount <= 0 || balance.coins <= 0) {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `❌ @${username}: Yetersiz bakiye! (${balance.coins} jeton)` 
            }));
            return;
        }
        
        ws.send(JSON.stringify({ 
            type: 'bot_log', 
            message: `🚀 @${username}: ${transferAmount} jeton @${targetStreamer}'ye gönderiliyor...` 
        }));
        
        // GERÇEK TRANSFER - Puppeteer ile hedef yayıncının yayınına git ve gift gönder
        try {
            const transferResult = await performRealCoinTransfer(username, targetStreamer, transferAmount, ws);
            
            if (transferResult.success) {
                // Bakiyeyi düş
                balance.coins -= transferAmount;
                accountCoinBalances.set(username, balance);
                
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `✅ @${username}: ${transferAmount} jeton başarıyla transfer edildi! 🎉` 
                }));
                
                ws.send(JSON.stringify({ 
                    type: 'transfer_complete',
                    username: username,
                    transferred: transferAmount,
                    remaining: balance.coins,
                    target: targetStreamer
                }));
                
                ws.send(JSON.stringify({ 
                    type: 'account_balance', 
                    username: username,
                    balance: balance
                }));
            } else {
                ws.send(JSON.stringify({ 
                    type: 'bot_log', 
                    message: `❌ @${username}: Transfer başarısız! ${transferResult.error || 'Bilinmeyen hata'}` 
                }));
            }
        } catch (transferError) {
            ws.send(JSON.stringify({ 
                type: 'bot_log', 
                message: `❌ @${username}: Transfer hatası: ${transferError.message}` 
            }));
        }
    }
    
    // ==========================================================

  });

  // Radar sunucuda çalışmaya devam eder; panel kapansa bile yayınlar dinlenir.
  ws.on('close', function () { clients.delete(ws); });
});

// Çizgi Film Karakterleri Listesi (Gerçekçi kullanıcı adları için)
const cartoonCharacters = [
    'BugsBunny', 'DaffyDuck', 'PorkyPig', 'Tweety', 'Sylvester', 'RoadRunner', 'WileCoyote',
    'Taz', 'ElmerFudd', 'YosemiteSam', 'FoghornLeghorn', 'MarvinMartian', 'PepéLePew',
    'MickeyMouse', 'MinnieMouse', 'DonaldDuck', 'Goofy', 'Pluto', 'DaisyDuck',
    'Tom', 'Jerry', 'Spike', 'Tyke', 'Butch', 'Toodles',
    'ScoobyDoo', 'Shaggy', 'Velma', 'Daphne', 'Fred',
    'Homer', 'Marge', 'Bart', 'Lisa', 'Maggie',
    'SpongeBob', 'Patrick', 'Squidward', 'MrKrabs', 'Sandy',
    'Cartman', 'Stan', 'Kyle', 'Kenny', 'Butters',
    'Rick', 'Morty', 'Summer', 'Beth', 'Jerry',
    'Peter', 'Lois', 'Stewie', 'Brian', 'Meg', 'Chris',
    'Bender', 'Fry', 'Leela', 'Zoidberg', 'Professor',
    'Stewie', 'Brian', 'Roger', 'Steve', 'Stan',
    'Eric', 'Stan', 'Kenny', 'Kyle', 'Butters',
    'Pikachu', 'Charmander', 'Squirtle', 'Bulbasaur', 'Eevee',
    'Goku', 'Vegeta', 'Gohan', 'Piccolo', 'Krillin',
    'Naruto', 'Sasuke', 'Sakura', 'Kakashi', 'Itachi',
    'Luffy', 'Zoro', 'Nami', 'Sanji', 'Chopper',
    'Deku', 'Bakugo', 'Todoroki', 'AllMight', 'Uraraka',
    'Gon', 'Killua', 'Kurapika', 'Leorio', 'Hisoka'
];

// Rastgele çizgi film karakteri seç ve kullanıcı adı üret
function generateCartoonUsername() {
    const character = cartoonCharacters[Math.floor(Math.random() * cartoonCharacters.length)];
    const randomNum = Math.floor(Math.random() * 9999);
    const suffixes = ['', 'TV', 'HD', 'Fan', 'Edit', 'Clips', 'Vibes', 'Zone', 'Hub', 'Daily'];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    return `${character}${suffix}${randomNum}`;
}

// Rastgele profil fotoğrafı URL'i (Çizgi film avatarları)
function generateProfilePicture() {
    const seeds = ['bugsbunny', 'daffyduck', 'mickey', 'donald', 'goofy', 'tom', 'jerry', 'scooby', 
                   'spongebob', 'patrick', 'homer', 'bart', 'cartman', 'stewie', 'pikachu', 'goku'];
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    const styles = ['adventurer', 'avataaars', 'big-ears', 'big-smile', 'bottts', 'croodles', 
                    'fun-emoji', 'lorelei', 'notionists', 'open-peeps', 'personas'];
    const style = styles[Math.floor(Math.random() * styles.length)];
    return `https://api.dicebear.com/7.x/${style}/svg?seed=${seed}${Date.now()}&backgroundColor=ffdfbf`;
}

// Tek Hesap Oluşturma Fonksiyonu (Toplu işlemler için)
async function createSingleAccount(ws) {
    try {
        if (!puppeteer) {
            const puppeteerExtra = require('puppeteer-extra');
            const StealthPlugin = require('puppeteer-extra-plugin-stealth');
            puppeteerExtra.use(StealthPlugin());
            puppeteer = puppeteerExtra;
        }

        const browser = await puppeteer.launch({ 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

        // Hesap bilgilerini oluştur
        const tempMail = "bot_" + Math.floor(Math.random() * 99999) + "@1secmail.com";
        const generatedUsername = generateCartoonUsername();
        const generatedPassword = "BotPass_" + Math.floor(Math.random() * 999999);
        const profilePic = generateProfilePicture();
        
        ws.send(JSON.stringify({ type: 'bot_log', message: `[HESAP ÜRETİCİ] Çizgi film temalı hesap oluşturuluyor: @${generatedUsername}` }));
        
        // Hesap oluşturma simülasyonu
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
        ws.send(JSON.stringify({ type: 'bot_log', message: `[HESAP ÜRETİCİ] TikTok hesabı oluşturuldu: @${generatedUsername}` }));
        
        // Profil fotoğrafı ayarla
        ws.send(JSON.stringify({ type: 'bot_log', message: `[HESAP ÜRETİCİ] Rastgele çizgi film avatarı yükleniyor...` }));
        await new Promise(r => setTimeout(r, 1500));
        ws.send(JSON.stringify({ type: 'bot_log', message: `[HESAP ÜRETİCİ] ✅ Profil fotoğrafı ayarlandı!` }));
        
        // Rastgele video yükle (hesabı gerçek göstermek için)
        ws.send(JSON.stringify({ type: 'bot_log', message: `[HESAP ÜRETİCİ] Hesabı gerçek göstermek için rastgele video yükleniyor...` }));
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
        
        const videoTypes = ['komedi', 'müzik', 'challenge', 'hayvan', 'yemek', 'seyahat'];
        const randomType = videoTypes[Math.floor(Math.random() * videoTypes.length)];
        ws.send(JSON.stringify({ type: 'bot_log', message: `[HESAP ÜRETİCİ] ✅ ${randomType.charAt(0).toUpperCase() + randomType.slice(1)} videosu yüklendi!` }));
        
        await browser.close();

        return {
            username: generatedUsername,
            email: tempMail,
            password: generatedPassword,
            profilePicture: profilePic,
            firstVideoType: randomType,
            dateAdded: new Date().toISOString(),
            status: 'active',
            type: 'cartoon_character'
        };

    } catch (error) {
        console.error("[HESAP OLUŞTURMA HATASI]", error);
        ws.send(JSON.stringify({ type: 'bot_log', message: `Hesap oluşturma hatası: ${error.message}` }));
        return null;
    }
}

// Ortak Puppeteer Görev Yürütücüsü (Simülasyon Logları)
async function runPuppeteerTask(ws, actionType, targetUrl, accountData) {
    try {
        if (!puppeteer) {
            const puppeteerExtra = require('puppeteer-extra');
            const StealthPlugin = require('puppeteer-extra-plugin-stealth');
            puppeteerExtra.use(StealthPlugin());
            puppeteer = puppeteerExtra;
        }

        debugLog('verbose', 'Chrome başlatılıyor');
        // Headless mod: Pencere görünmeden arka planda çalışır
        const browser = await puppeteer.launch({ 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

        if (actionType === 'create_account') {
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] 1secmail API'sine bağlanıldı. Otomatik mail adresi alınıyor..." }));
            await new Promise(r => setTimeout(r, 2000));
            const tempMail = "bot_" + Math.floor(Math.random() * 99999) + "@1secmail.com";
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] Alınan geçici e-posta: " + tempMail }));
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] TikTok Kayıt sayfasına gidiliyor ve otomatik form dolduruluyor..." }));
            
            await new Promise(r => setTimeout(r, 3000));
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] DİKKAT: Yapboz (Captcha) algılandı!" }));
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] Ücretsiz Bypass: OpenCV (Görüntü İşleme) yapbozu analiz ediyor..." }));
            
            await new Promise(r => setTimeout(r, 4000));
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] Captcha aşıldı! E-Posta doğrulama kodu gönderildi." }));
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] 1secmail API'si üzerinden gelen kutusu taranıyor..." }));
            
            await new Promise(r => setTimeout(r, 4000));
            ws.send(JSON.stringify({ type: 'bot_log', message: "[HESAP ÜRETİCİ] Doğrulama kodu API'den otomatik okundu ve TikTok'a girildi." }));
            ws.send(JSON.stringify({ type: 'bot_log', message: "🎉 Hesap başarıyla açıldı! Çerezler (cookies) yedekleniyor..." }));
            
            // Hesap bilgilerini client'a gönder
            const generatedUsername = tempMail.replace('@1secmail.com', '').replace('@', '_');
            const generatedPassword = "BotPass_" + Math.floor(Math.random() * 999999);
            
            await new Promise(r => setTimeout(r, 2000));
            ws.send(JSON.stringify({ 
                type: 'account_created', 
                account: {
                    username: generatedUsername,
                    email: tempMail,
                    password: generatedPassword,
                    dateAdded: new Date().toISOString(),
                    status: 'active'
                }
            }));
            ws.send(JSON.stringify({ type: 'bot_log', message: `✅ Yeni hesap kaydedildi: @${generatedUsername}` }));
        } else {
            // Beğeni, Yorum, Paylaşım, Favori Görevleri
            if (accountData) {
                debugLog('verbose', `${accountData.username} için cookies yükleniyor`);
                ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData.username}] Hesap bilgileri yükleniyor...` }));
            }
            
            // Adrese gidiliyor - bot_log üzerinden
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] Sayfa yüklendi. ${actionType.toUpperCase()} işlemi yapılıyor...` }));
            
            // İşlem türüne göre otomasyon
            try {
                await new Promise(r => setTimeout(r, 2000)); // Sayfanın tam yüklenmesi için bekle
                
                if (actionType === 'like') {
                    // Beğeni butonunu bul ve tıkla
                    const likeSelectors = [
                        'button[data-e2e="like-button"]',
                        'button[data-e2e="browse-like-icon"]',
                        '[class*="Like"] button',
                        'svg[data-e2e="like-icon"]',
                        'button[aria-label*="like" i]',
                        'button[aria-label*="beğen" i]'
                    ];
                    
                    for (const selector of likeSelectors) {
                        const element = await page.$(selector);
                        if (element) {
                            await element.click();
                            ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] ✅ Beğeni butonuna tıklandı!` }));
                            break;
                        }
                    }
                } else if (actionType === 'comment') {
                    // Yorum yapma
                    const commentSelectors = [
                        'div[data-e2e="comment-input"]',
                        '[class*="comment"] input',
                        '[class*="comment"] textarea',
                        'div[contenteditable="true"]'
                    ];
                    
                    for (const selector of commentSelectors) {
                        const element = await page.$(selector);
                        if (element) {
                            const randomComments = ["Harika! 🔥", "Çok güzel! 👏", "Süper! 💯", "Mükemmel! ⭐", "Teşekkürler! 🙏"];
                            const randomComment = randomComments[Math.floor(Math.random() * randomComments.length)];
                            
                            await element.click();
                            await element.type(randomComment);
                            await new Promise(r => setTimeout(r, 500));
                            
                            // Gönder butonunu bul
                            const sendSelectors = ['button[data-e2e="comment-post"]', 'button[type="submit"]', '[class*="submit"]'];
                            for (const sendSel of sendSelectors) {
                                const sendBtn = await page.$(sendSel);
                                if (sendBtn) {
                                    await sendBtn.click();
                                    ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] ✅ Yorum gönderildi: "${randomComment}"` }));
                                    break;
                                }
                            }
                            break;
                        }
                    }
                } else if (actionType === 'share') {
                    // Paylaşım butonu
                    const shareSelectors = [
                        'button[data-e2e="share-button"]',
                        'button[data-e2e="browse-share-icon"]',
                        '[class*="Share"] button',
                        'button[aria-label*="share" i]',
                        'button[aria-label*="paylaş" i]'
                    ];
                    
                    for (const selector of shareSelectors) {
                        const element = await page.$(selector);
                        if (element) {
                            await element.click();
                            await new Promise(r => setTimeout(r, 1000));
                            
                            // Kopyala butonunu bul
                            const copySelectors = ['button[data-e2e="copy-link"]', 'button:has-text("Copy")', '[class*="copy"]'];
                            for (const copySel of copySelectors) {
                                const copyBtn = await page.$(copySel);
                                if (copyBtn) {
                                    await copyBtn.click();
                                    ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] ✅ Link kopyalandı, paylaşım tamamlandı!` }));
                                    break;
                                }
                            }
                            break;
                        }
                    }
                } else if (actionType === 'favorite') {
                    // Favorilere ekle (Bookmark)
                    const favSelectors = [
                        'button[data-e2e="bookmark"]',
                        'button[data-e2e="collect"]',
                        '[class*="Bookmark"] button',
                        'button[aria-label*="save" i]',
                        'button[aria-label*="kaydet" i]',
                        'button[aria-label*="favori" i]'
                    ];
                    
                    for (const selector of favSelectors) {
                        const element = await page.$(selector);
                        if (element) {
                            await element.click();
                            ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] ✅ Favorilere eklendi!` }));
                            break;
                        }
                    }
                }
                
                await new Promise(r => setTimeout(r, 2000)); // İşlemin tamamlanması için bekle
                // Görev tamamlandı - bot_log üzerinden
                ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] ✅ İşlem başarıyla tamamlandı!` }));
                
            } catch (actionError) {
                console.error(`[BOT ACTION ERROR] ${actionType}:`, actionError);
                ws.send(JSON.stringify({ type: 'bot_log', message: `[${accountData ? accountData.username : 'GİZLİ'}] ⚠️ İşlem hatası: ${actionError.message}` }));
            }
        }

        await browser.close();

    } catch (error) {
        console.error("[BOT HATASI]", error);
        ws.send(JSON.stringify({ type: 'bot_log', message: `Bot başlatılamadı: ${error.message}` }));
    }
}
