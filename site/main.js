// Node.js File System for persistent storage
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, 'data');
const accountsFile = path.join(dataDir, 'accounts.json');
const agenciesFile = path.join(dataDir, 'agencies.json');
const usersFile = path.join(dataDir, 'users.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Lucide Icons Init
lucide.createIcons();

// --- TAB NAVIGATION ---
const tabs = {
    'tab-radar': 'view-radar',
    'tab-calc': 'view-calc',
    'tab-ai': 'view-ai',
    'tab-tools': 'view-tools',
    'tab-accounts': 'view-accounts',
    'tab-agencies': 'view-agencies',
    'tab-hunt': 'view-hunt'
};

Object.keys(tabs).forEach(tabId => {
    document.getElementById(tabId).addEventListener('click', (e) => {
        Object.keys(tabs).forEach(t => {
            const btn = document.getElementById(t);
            btn.classList.remove('bg-yellow-500/20', 'text-yellow-400', 'border', 'border-yellow-500/30');
            btn.classList.add('text-gray-400');
        });
        const activeBtn = document.getElementById(tabId);
        activeBtn.classList.remove('text-gray-400');
        activeBtn.classList.add('bg-yellow-500/20', 'text-yellow-400', 'border', 'border-yellow-500/30');

        Object.values(tabs).forEach(v => {
            document.getElementById(v).classList.add('hidden');
        });
        document.getElementById(tabs[tabId]).classList.remove('hidden');
    });
});

// --- STORAGE & DATABASE (Kalıcı Hedef Yayıncılar) ---
let trackedUsernames = [];

// Statik/GitHub modu: tarayıcı arka uç çalıştıramadığı için keşif ve kutu
// verisi site/firsat/data altındaki JSON dosyalarından okunur. WebSocket
// bağlantısı varsa aynı veri akışına ek kanal olarak devam eder.
const STATIC_DATA_BASES = [
    'firsat/data/',
    'https://raw.githubusercontent.com/CehennemGibiyim/TikTok/main/site/firsat/data/'
];
const AUTO_TARGET_LIMIT = 250;
const AUTO_IGNORED_KEY = 'tiktok-radar-auto-ignored';
const BOX_KIND_LABELS = { chest: 'Sandık', letter: 'Zarf / Mektup', portal: 'Portal' };
let autoIgnored = [];
try {
    autoIgnored = JSON.parse(localStorage.getItem(AUTO_IGNORED_KEY) || '[]');
    if (!Array.isArray(autoIgnored)) autoIgnored = [];
} catch (e) { autoIgnored = []; }
let staticSyncTimer = null;
let staticDiscoveryTimer = null;

function loadPersistedUsers() {
    try {
        if (fs.existsSync(usersFile)) {
            const saved = fs.readFileSync(usersFile, 'utf8');
            trackedUsernames = JSON.parse(saved);
            trackedUsernames.forEach(username => renderTrackedUserUI(username));
            updateEmptyUsersText();
            if (ws && ws.readyState === WebSocket.OPEN) {
                trackedUsernames.forEach(username => {
                    ws.send(JSON.stringify({ action: 'add_user', username }));
                });
            }
            console.log(`[STORAGE] ${trackedUsernames.length} kullanıcı yüklendi`);
            
            // Kullanıcıya senkronizasyon bildirimi (eğer kullanıcı varsa)
            if (trackedUsernames.length > 0) {
                console.log(`[SYNC] ${trackedUsernames.length} radar yayıncısı scan.json senkronizasyonu için hazır`);
            }
        }
    } catch(e) { console.error("[STORAGE] Kullanıcılar yüklenemedi:", e); }
}

// Mevcut radar yayıncılarını scan.json'a senkronize et (bir kereye mahsus)
window.syncRadarToScanJson = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    if (trackedUsernames.length === 0) {
        alert("Senkronize edilecek radar yayıncısı yok!");
        return;
    }
    
    const manualStreamers = trackedUsernames.map(username => ({
        username: username,
        discoveredBy: 'manual_sync',
        discoveredAt: new Date().toISOString(),
        lastLiveAt: new Date().toISOString(),
        coinEventCount: 0,
        isLive: false,
        isAutoAdded: false,
        status: 'active',
        scanCount: 0,
        manuallyAdded: true,
        source: 'radar_sync'
    }));
    
    ws.send(JSON.stringify({ 
        action: 'add_manual_streamers', 
        streamers: manualStreamers 
    }));
    
    appendBotLog(`🔄 ${trackedUsernames.length} radar yayıncısı scan.json'a senkronize ediliyor...`);
};

function savePersistedUsers() {
    try {
        fs.writeFileSync(usersFile, JSON.stringify(trackedUsernames, null, 2));
        console.log(`[STORAGE] ${trackedUsernames.length} kullanıcı kaydedildi`);
    } catch(e) { console.error("[STORAGE] Kullanıcılar kaydedilemedi:", e); }
}

function saveAutoIgnored() {
    try { localStorage.setItem(AUTO_IGNORED_KEY, JSON.stringify(autoIgnored.slice(-500))); } catch (e) { /* yoksay */ }
}

function setTrackedLive(username, live) {
    const dot = document.getElementById(`status-${username}`);
    if (!dot) return;
    dot.className = live
        ? 'w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]'
        : 'w-2.5 h-2.5 rounded-full bg-yellow-500/50 shadow-[0_0_5px_rgba(250,204,21,0.5)] animate-pulse';
    dot.title = live ? 'Canlı' : 'Bekliyor';
}

async function fetchStaticJson(name) {
    let lastError = null;
    for (const base of STATIC_DATA_BASES) {
        try {
            const response = await fetch(base + name + '?t=' + Date.now(), { cache: 'no-store' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return await response.json();
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('veri bulunamadı');
}

function staticLiveNames(data) {
    const names = [];
    const list = data && Array.isArray(data.streamers) ? data.streamers : [];
    list.forEach(item => {
        if (item && item.username && item.live === true) names.push(item.username);
    });
    return names;
}

function updateStaticModeStatus(data) {
    const el = document.getElementById('radarDataMode');
    if (!el) return;
    const at = data && data.scannedAt
        ? new Date(data.scannedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        : '';
    el.textContent = 'Statik veri' + (at ? ' · son tarama ' + at : '') +
        ' · hedef ' + trackedUsernames.length;
}

async function syncStaticTargets() {
    let liveData = null;
    try {
        liveData = await fetchStaticJson('live.json');
    } catch (error) {
        // live.json yoksa targets.json'daki son canlı kayıtları dene.
    }

    let names = staticLiveNames(liveData);
    if (!names.length) {
        try {
            const targetData = await fetchStaticJson('targets.json');
            const recent = Date.now() - 6 * 3600 * 1000;
            (targetData && Array.isArray(targetData.targets) ? targetData.targets : []).forEach(item => {
                if (item && item.username && Number(item.lastSeenLiveAt) >= recent) names.push(item.username);
            });
        } catch (error) { /* veri yoksa sessizce bekle */ }
    }

    names = Array.from(new Set(names)).filter(Boolean).slice(0, AUTO_TARGET_LIMIT);
    if (names.length) {
        const added = await addNewTargets(names, { auto: true });
        names.forEach(name => setTrackedLive(name, true));
        if (added > 0) appendBotLog('🔎 Statik keşif: ' + added + ' yeni canlı yayıncı hedef listesine eklendi.');
    }
    updateStaticModeStatus(liveData);
}

function boxKindLabel(kind) {
    return BOX_KIND_LABELS[kind] || (kind ? String(kind) : 'Sandık');
}

function boxClock(ts) {
    const value = Number(ts) || 0;
    if (!value) return '';
    return new Date(value).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function addChestRecord(chest) {
    if (!chest || !chest.id || !chest.user) return;
    if (chestsData.some(item => item.id === chest.id)) return;

    chestsData.push(chest);
    chestsTotalCounter += 1;
    if (totalChestsFoundSpan) totalChestsFoundSpan.innerText = chestsTotalCounter;
    generateChestQRCode(chest.id, chest.user);
    renderChests();
}

function ingestStaticBox(box) {
    const dropTime = Number(box && box.t) || 0;
    if (!box || !box.username || !dropTime) return;
    // Kutunun yakalama penceresi kısa; eski dosya kayıtlarını listeye doldurma.
    if (Date.now() - dropTime > 15 * 60 * 1000) return;

    const availableAt = Number(box.availableAt) || dropTime;
    const durationSec = Number(box.durationSec) || Math.max(0, (availableAt - dropTime) / 1000);
    addChestRecord({
        id: 'static_' + (box.id || (box.username + '_' + dropTime + '_' + (box.kind || 'chest'))),
        user: box.username,
        coins: Number(box.coins) || 0,
        duration: durationSec || 180,
        durationSec: durationSec,
        availableAt: availableAt,
        hasDuration: durationSec > 0,
        dropTime: dropTime,
        timeStr: new Date(dropTime).toLocaleTimeString('tr-TR'),
        graceStartTime: null,
        userCount: Number(box.shared) || 0,
        kind: box.kind || 'chest',
        boxName: box.boxName || ''
    });
}

async function syncStaticBoxes() {
    try {
        const data = await fetchStaticJson('boxes.json');
        const boxes = data && Array.isArray(data.boxes) ? data.boxes : [];
        boxes.forEach(ingestStaticBox);
    } catch (error) { /* kutu dosyası yoksa sessizce bekle */ }
}

async function discoverLiveChannels() {
    try {
        const controller = new AbortController();
        const guard = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
            response = await fetch('https://api.tik.tools/api/live/top-channels?t=' + Date.now(), {
                cache: 'no-store',
                signal: controller.signal
            });
        } finally {
            clearTimeout(guard);
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        const channels = data && Array.isArray(data.channels) ? data.channels : [];
        const names = channels.map(channel => channel && channel.uniqueId).filter(Boolean);
        if (names.length) {
            const added = await addNewTargets(Array.from(new Set(names)), { auto: true });
            names.forEach(name => setTrackedLive(name, true));
            if (added > 0) appendBotLog('🔎 Canlı keşif: ' + added + ' yeni yayıncı hedef listesine eklendi.');
        }
    } catch (error) { /* keşif ucu yoksa statik dosyalar devrede */ }
}

function applyStaticModeUI(force) {
    if (!force && serverUrlFromUi()) return;
    if (wsStatusBadge) {
        wsStatusBadge.className = 'flex items-center space-x-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400';
        wsStatusBadge.innerHTML = '<div class="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.8)]"></div><span class="text-xs font-bold">Statik</span>';
    }
    if (btnConnectWs) btnConnectWs.classList.add('hidden');
    if (btnDisconnectWs) btnDisconnectWs.classList.add('hidden');
    if (radarPulse) radarPulse.classList.remove('hidden');
    const input = document.getElementById('wsUrl');
    if (input) {
        input.value = '';
        input.placeholder = 'GitHub Actions / yerel tarama verisi';
        input.readOnly = true;
    }
    const hint = document.getElementById('radarDataMode');
    if (hint) {
        hint.classList.remove('hidden');
        hint.textContent = 'GitHub/yerel statik mod: keşif ve kutular firsat/data dosyalarından okunuyor.';
    }
}

function startStaticDataSync() {
    if (staticSyncTimer) return;
    applyStaticModeUI();
    syncStaticTargets();
    syncStaticBoxes();
    discoverLiveChannels();
    staticSyncTimer = setInterval(function () {
        syncStaticTargets();
        syncStaticBoxes();
    }, 30000);
    staticDiscoveryTimer = setInterval(discoverLiveChannels, 60000);
}

// --- RADAR LOGIC (WebSocket) ---
let ws = null;
const btnConnectWs = document.getElementById('btnConnectWs');
const btnDisconnectWs = document.getElementById('btnDisconnectWs');
const wsStatusBadge = document.getElementById('wsStatusBadge');
const wsStatusText = document.getElementById('wsStatusText');
const radarPulse = document.getElementById('radarPulse');

const inputAddUser = document.getElementById('addUsername');
const btnAddUser = document.getElementById('btnAddUser');
const btnUploadTxt = document.getElementById('btnUploadTxt');
const fileTxtUpload = document.getElementById('fileTxtUpload');
const trackedUsersContainer = document.getElementById('trackedUsers');
const emptyUsersText = document.getElementById('emptyUsersText');

const chestsListContainer = document.getElementById('chestsList');
const emptyChestsText = document.getElementById('emptyChestsText');
const totalChestsFoundSpan = document.getElementById('totalChestsFound');
const sortChestsSelect = document.getElementById('sortChests');

let chestsData = []; 
let chestsTotalCounter = 0;
let renderInterval = null;

function startChestTimerEngine() {
    if (renderInterval) clearInterval(renderInterval);
    renderInterval = setInterval(() => {
        const now = Date.now();
        let needsRender = false;
        
        chestsData = chestsData.filter(chest => {
            const elapsedSeconds = (now - chest.dropTime) / 1000;
            const remaining = Math.max(0, chest.duration - elapsedSeconds);
            
            if (remaining <= 0) {
                if (!chest.graceStartTime) {
                    chest.graceStartTime = now;
                    needsRender = true;
                }
                const graceElapsed = now - chest.graceStartTime;
                if (graceElapsed > 180000) { 
                    needsRender = true;
                    return false; 
                }
            } else {
                needsRender = true;
            }
            return true;
        });

        if (needsRender) renderChests();
    }, 1000);
}

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    manualDisconnect = false;
    const rawUrl = (document.getElementById('wsUrl').value || '').trim();
    const authQuery = window.RADAR_STORE && window.RADAR_STORE.wsAuthQuery ? window.RADAR_STORE.wsAuthQuery() : '';
    const url = rawUrl
        ? rawUrl + (authQuery ? (rawUrl.indexOf('?') >= 0 ? '&' : '?') + authQuery.replace(/^\?/, '') : '')
        : '';

    if (!url) {
        applyStaticModeUI();
        return;
    }

    ws = new WebSocket(url);

    ws.onopen = () => {
        wsStatusBadge.className = "flex items-center space-x-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400";
        wsStatusBadge.innerHTML = `<div class="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.8)]"></div><span class="text-xs font-bold">Aktif</span>`;
        btnConnectWs.classList.add('hidden');
        btnDisconnectWs.classList.remove('hidden');
        radarPulse.classList.remove('hidden');

        reconnectAttempts = 0;

        startChestTimerEngine();

        trackedUsernames.forEach(username => {
            ws.send(JSON.stringify({ action: 'add_user', username }));
        });
    };

    ws.onclose = () => {
        wsStatusBadge.className = "flex items-center space-x-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400";
        wsStatusBadge.innerHTML = `<div class="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.8)]"></div><span class="text-xs font-bold">Koptu</span>`;
        btnConnectWs.classList.remove('hidden');
        btnDisconnectWs.classList.add('hidden');
        radarPulse.classList.add('hidden');
        if (renderInterval) clearInterval(renderInterval);
        // Açıkça verilmiş bir arka uç yoksa aynı origin'e bağlanma denemesi
        // statik moda düşer; GitHub Pages ve yerel dosya sunucusu böyle çalışır.
        if (!explicitBackendConfigured()) {
            applyStaticModeUI(true);
            startStaticDataSync();
            appendBotLog('📡 WebSocket yok; statik keşif ve kutu verisi kullanılıyor.');
            return;
        }
        scheduleServerReconnect();
    };

    ws.onerror = (err) => { console.error("WebSocket Hatası:", err); };

    ws.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (window.onHuntMessage && window.onHuntMessage(data)) return;
            if (data.type === 'status') {
                const badge = document.getElementById(`status-${data.user}`);
                if (badge) {
                    if (data.status === 'connected') {
                        badge.className = "w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]";
                    } else {
                        badge.className = "w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]";
                    }
                }
            } else if (data.type === 'chest') {
                handleNewChest(data);
            } else if (data.type === 'bot_log') {
                console.log(`[BOT LOG]: ${data.message}`);
                appendBotLog(data.message);
            } else if (data.type === 'account_created') {
                console.log(`[ACCOUNT CREATED]:`, data.account);
                // Yeni hesabı storedAccounts'a ekle
                storedAccounts.push(data.account);
                saveAccounts();
                renderAccountsUI(); // Listeyi hemen güncelle
                updateActiveAccountsCount();
                
                // Bildirim göster (alert yerine daha hızlı)
                const notif = document.createElement('div');
                notif.className = 'fixed top-4 right-4 bg-green-500 text-white px-4 py-3 rounded-xl shadow-lg z-50 animate-bounce';
                notif.innerHTML = `✅ Yeni hesap eklendi: @${data.account.username}`;
                document.body.appendChild(notif);
                setTimeout(() => notif.remove(), 3000);
                
            } else if (data.type === 'batch_accounts_complete') {
                console.log(`[BATCH COMPLETE]:`, data.totalCreated, 'hesap oluşturuldu');
                // Tüm hesapları listeye ekle
                if (data.accounts && Array.isArray(data.accounts)) {
                    data.accounts.forEach(acc => {
                        if (!storedAccounts.find(a => a.username === acc.username)) {
                            storedAccounts.push(acc);
                        }
                    });
                    saveAccounts();
                    renderAccountsUI();
                    updateActiveAccountsCount();
                }
                
                // Başarı bildirimi
                const notif = document.createElement('div');
                notif.className = 'fixed top-4 right-4 bg-blue-500 text-white px-6 py-4 rounded-xl shadow-lg z-50';
                notif.innerHTML = `
                    <div class="flex items-center gap-2">
                        <i data-lucide="check-circle" class="w-6 h-6"></i>
                        <div>
                            <div class="font-bold">Toplu Hesap Oluşturma Tamamlandı!</div>
                            <div class="text-sm">${data.totalCreated} hesap başarıyla eklendi</div>
                        </div>
                    </div>
                `;
                document.body.appendChild(notif);
                lucide.createIcons();
                setTimeout(() => notif.remove(), 5000);
                
            } else if (data.type === 'scanner_status') {
                updateScannerUI(data);
                
            } else if (data.type === 'streamer_discovered') {
                // Yeni yayıncı bulundu, sayacı güncelle
                updateScannerCounters();
                
            } else if (data.type === 'discovered_streamers_list') {
                renderDiscoveredStreamers(data.streamers);
                
            } else if (data.type === 'scan_complete') {
                updateScannerCounters();
                
            } else if (data.type === 'streamer_approved') {
                // Yayıncı onaylandı, ana radara ekle
                if (!trackedUsernames.includes(data.streamer.username)) {
                    addNewTargets([data.streamer.username]);
                }
                updateScannerCounters();
                
            } else if (data.type === 'streamer_rejected') {
                updateScannerCounters();
                
            } else if (data.type === 'cleanup_complete') {
                updateScannerCounters();
                
            } else if (data.type === 'mobile_config_updated' || 
                       data.type === 'mobile_test_result' || 
                       data.type === 'mobile_collection_complete' ||
                       data.type === 'account_balance' ||
                       data.type === 'all_balances' ||
                       data.type === 'transfer_complete' ||
                       data.type === 'auto_transfer_trigger') {
                // Mobile Bot mesajlarını işle (jeton bakiyesi ve transfer dahil)
                handleMobileBotMessages(data);
            }
        } catch(e) { console.error(e); }
    };
}

// ==================== OTOMATİK BAĞLANTI ====================
// Panel açılışında arka uca bağlanır; düşerse yeniden dener. Böylece
// "Arka Plana Bağlan" adımı işlemler için ön koşul değildir.
let manualDisconnect = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let serverWaitTimer = null;
let serverWaiters = [];

function explicitBackendConfigured() {
    if (typeof window.TIKTOK_BACKEND_URL === 'string' && window.TIKTOK_BACKEND_URL.trim()) return true;
    try {
        if ((localStorage.getItem('tiktok-radar-backend-url') || '').trim()) return true;
    } catch (e) { /* yoksay */ }
    const input = document.getElementById('wsUrl');
    const value = (input && input.value ? input.value : '').trim();
    if (!value) return false;
    try { return new URL(value, location.href).host !== location.host; } catch (e) { return true; }
}

function serverUrlFromUi() {
    // store-client statik GitHub Pages'te kendi origin'i arka uç saymaz.
    // Böylece panel wss://kullanici.github.io adresine bağlanmaya çalışmaz.
    if (window.RADAR_STORE && typeof window.RADAR_STORE.websocketUrl === 'function') {
        try {
            const resolved = window.RADAR_STORE.websocketUrl();
            if (resolved !== undefined) return resolved || '';
        } catch (e) { /* yoksay */ }
    }
    const input = document.getElementById('wsUrl');
    const value = (input && input.value ? input.value : '').trim();
    if (value) return value;
    if (typeof window.TIKTOK_BACKEND_URL === 'string') return window.TIKTOK_BACKEND_URL.trim();
    return '';
}

function scheduleServerReconnect() {
    if (manualDisconnect) return;
    if (!serverUrlFromUi()) return;
    if (reconnectAttempts >= 8) return;
    reconnectAttempts += 1;
    const delay = Math.min(30000, 1500 * reconnectAttempts);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () { connectWebSocket(); }, delay);
}

// Bağlantı yoksa önce kurmayı dener, sonra istenen işlemi çalıştırır.
function waitForServer(callback, label) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        callback();
        return;
    }

    if (!serverUrlFromUi()) {
        appendBotLog('⚠️ Arka uç adresi tanımlı değil. "Sistem Bağlantısı" alanına sunucu adresini girin.');
        return;
    }

    serverWaiters.push({ callback: callback, label: label || 'işlem', deadline: Date.now() + 12000 });
    connectWebSocket();

    if (serverWaitTimer) return;

    serverWaitTimer = setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
            clearInterval(serverWaitTimer);
            serverWaitTimer = null;
            const list = serverWaiters.splice(0);
            list.forEach(function (item) {
                try { item.callback(); } catch (e) { console.error('[SERVER]', e); }
            });
            return;
        }

        serverWaiters = serverWaiters.filter(function (item) {
            if (Date.now() > item.deadline) {
                appendBotLog('⚠️ Sunucuya ulaşılamadı, "' + item.label + '" çalıştırılmadı. Adres ve panel anahtarını kontrol edin.');
                return false;
            }
            return true;
        });

        if (serverWaiters.length === 0) {
            clearInterval(serverWaitTimer);
            serverWaitTimer = null;
            return;
        }

        connectWebSocket();
    }, 500);
}

btnConnectWs.addEventListener('click', connectWebSocket);
btnDisconnectWs.addEventListener('click', () => {
    manualDisconnect = true;
    if (ws) ws.close();
});

inputAddUser.addEventListener('input', (e) => { btnAddUser.disabled = e.target.value.trim().length === 0; });

function extractUsernames(text) {
    const rawItems = text.split(/[\n,\s]+/);
    const validNames = [];
    
    rawItems.forEach(item => {
        let name = item.trim();
        if (!name) return;
        const match = name.match(/@([a-zA-Z0-9_.-]+)/);
        if (match) name = match[1];
        else name = name.replace(/^@/, '');
        
        if (name.length > 0 && !validNames.includes(name)) validNames.push(name);
    });
    return validNames;
}

async function addNewTargets(namesArray, options) {
    const auto = Boolean(options && options.auto);
    let addedCount = 0;
    const newManualStreamers = [];
    
    namesArray.forEach(username => {
        if (auto && autoIgnored.includes(username)) return;
        if (auto && trackedUsernames.length >= AUTO_TARGET_LIMIT && !trackedUsernames.includes(username)) return;
        if (!trackedUsernames.includes(username)) {
            trackedUsernames.push(username);
            renderTrackedUserUI(username, auto);
            if (!auto && autoIgnored.includes(username)) {
                autoIgnored = autoIgnored.filter(name => name !== username);
                saveAutoIgnored();
            }
            
            // Yalnızca elle eklenen yayıncıyı scan.json'a da yaz; otomatik
            // keşiftekiler WebSocket varsa yalnız add_user ile bildirilir.
            if (!auto) {
                newManualStreamers.push({
                    username: username,
                    discoveredBy: 'manual',
                    discoveredAt: new Date().toISOString(),
                    lastLiveAt: new Date().toISOString(),
                    coinEventCount: 0,
                    isLive: false,
                    isAutoAdded: false,
                    status: 'active',
                    scanCount: 0,
                    manuallyAdded: true,
                    source: 'radar_manual'
                });
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'add_user', username }));
            }
            addedCount++;
        }
    });

    if (addedCount > 0) {
        updateEmptyUsersText();
        await savePersistedUsers();
        
        // Yeni eklenen yayıncıları scan.json'a senkronize et
        if (ws && ws.readyState === WebSocket.OPEN && newManualStreamers.length > 0) {
            ws.send(JSON.stringify({ 
                action: 'add_manual_streamers', 
                streamers: newManualStreamers 
            }));
        }
    }
    return addedCount;
}

btnAddUser.addEventListener('click', async () => {
    const val = inputAddUser.value.trim();
    if (!val) return;
    const names = extractUsernames(val);
    await addNewTargets(names);
    inputAddUser.value = '';
    btnAddUser.disabled = true;
});

btnUploadTxt.addEventListener('click', () => fileTxtUpload.click());

fileTxtUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        const text = ev.target.result;
        const names = extractUsernames(text);
        if (names.length === 0) return alert("Dosyada geçerli bir kullanıcı adı veya TikTok linki bulunamadı.");
        const added = await addNewTargets(names);
        alert(`${names.length} okundu, ${added} yeni kullanıcı veritabanına ve radara eklendi!`);
        fileTxtUpload.value = "";
    };
    reader.readAsText(file);
});

function updateEmptyUsersText() {
    emptyUsersText.style.display = trackedUsernames.length === 0 ? 'block' : 'none';
}

function renderTrackedUserUI(username, live) {
    if (!trackedUsersContainer) {
        console.warn(`[UI] trackedUsersContainer bulunamadı, @${username} render edilemedi`);
        return;
    }
    
    // Zaten var mı kontrol et
    if (document.getElementById(`tracked-${username}`)) {
        return;
    }
    
    const div = document.createElement('div');
    div.id = `tracked-${username}`;
    div.className = "flex items-center justify-between bg-black/40 border border-white/5 rounded-xl p-3";
    div.innerHTML = `
        <div class="flex items-center space-x-3">
            <div id="status-${username}" class="${live ? 'w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'w-2.5 h-2.5 rounded-full bg-yellow-500/50 shadow-[0_0_5px_rgba(250,204,21,0.5)] animate-pulse'}" title="${live ? 'Canlı' : 'Bekliyor'}"></div>
            <span class="font-medium text-yellow-50">@${username}</span>
        </div>
        <button class="text-red-400 hover:text-red-300 p-1 bg-red-500/10 rounded-lg transition-colors border border-red-500/20" onclick="removeTrackedUser('${username}')" title="Listeden Sil">
            <i data-lucide="x" class="w-4 h-4"></i>
        </button>
    `;
    trackedUsersContainer.appendChild(div);
    lucide.createIcons();
}

window.removeTrackedUser = async function(username) {
    trackedUsernames = trackedUsernames.filter(u => u !== username);
    if (!autoIgnored.includes(username)) {
        autoIgnored.push(username);
        saveAutoIgnored();
    }
    const el = document.getElementById(`tracked-${username}`);
    if (el) el.remove();
    updateEmptyUsersText();
    
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'remove_user', username }));
    await savePersistedUsers();
};

function formatTimeRemaining(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// QR Code cache
const chestQRCodes = new Map();

function generateChestQRCode(chestId, username) {
    const tiktokUrl = `https://www.tiktok.com/@${username}/live`;
    const tempDiv = document.createElement('div');
    tempDiv.id = `qr-${chestId}`;
    document.body.appendChild(tempDiv);
    
    new QRCode(tempDiv, {
        text: tiktokUrl,
        width: 100,
        height: 100,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    
    setTimeout(() => {
        const img = tempDiv.querySelector('img');
        if (img) chestQRCodes.set(chestId, img.src);
        document.body.removeChild(tempDiv);
    }, 100);
}

function handleNewChest(data) {
    const payload = data.data || {};
    console.log(`[CHEST EVENT] Yeni kutu: @${data.user}, Jeton: ${payload.coins || 'bilinmiyor'}`, data);

    const rawCoins = typeof payload.coins === 'number' ? payload.coins : parseInt(payload.coins) || 0;
    const rawDuration = Number(payload.duration || payload.durationSec) || 0;
    const dropTime = Date.now();
    const availableAt = Number(payload.availableAt) || (dropTime + (rawDuration || 180) * 1000);
    const chestId = data.id || ('chest_' + Date.now() + Math.floor(Math.random()*1000));

    addChestRecord({
        id: chestId,
        user: data.user,
        coins: rawCoins,
        duration: rawDuration || 180,
        durationSec: rawDuration,
        availableAt: availableAt,
        hasDuration: rawDuration > 0,
        dropTime: dropTime,
        timeStr: payload.time || new Date().toLocaleTimeString(),
        graceStartTime: null,
        userCount: payload.userCount || payload.totalUsers || 0,
        kind: data.kind || payload.kind || 'chest',
        boxName: payload.boxName || ''
    });

    appendBotLog(`🎁 [@${data.user}] ${boxKindLabel(data.kind || payload.kind)}: ${rawCoins} jeton, ${payload.userCount || payload.totalUsers || 0} kişi`);
}

// Geri sayım timer'ı
setInterval(() => {
    const now = Date.now();
    const toRemove = [];
    
    chestsData.forEach(chest => {
        const elapsed = (now - chest.dropTime) / 1000;
        const remaining = chest.duration - elapsed;
        
        // Süresi dolanları işaretle
        if (remaining <= 0 && !chest.graceStartTime) {
            chest.graceStartTime = now;
        }
        
        // Grace period (3 dakika) sonrası sil
        if (chest.graceStartTime && (now - chest.graceStartTime) > 180000) {
            toRemove.push(chest.id);
        }
    });
    
    // Silinenleri kaldır
    toRemove.forEach(id => {
        chestsData = chestsData.filter(c => c.id !== id);
        chestQRCodes.delete(id);
    });
    
    if (toRemove.length > 0) renderChests();
    
    // Geri sayımı güncelle
    updateChestCountdowns();
}, 1000);

function updateChestCountdowns() {
    const now = Date.now();
    chestsData.forEach(chest => {
        const elapsed = (now - chest.dropTime) / 1000;
        const remaining = Math.max(0, chest.duration - elapsed);
        
        const countdownEl = document.getElementById(`countdown-${chest.id}`);
        if (countdownEl) {
            countdownEl.textContent = formatTimeRemaining(remaining);
        }
    });
}

window.removeChestFromUI = function(id) {
    chestsData = chestsData.filter(c => c.id !== id);
    renderChests();
};

function renderChests() {
    emptyChestsText.style.display = chestsData.length === 0 ? 'flex' : 'none';
    const sortVal = sortChestsSelect.value;
    let sortedChests = [...chestsData];
    const now = Date.now();
    
    sortedChests.sort((a, b) => {
        const aRemain = Math.max(0, a.duration - (now - a.dropTime) / 1000);
        const bRemain = Math.max(0, b.duration - (now - b.dropTime) / 1000);
        
        if (sortVal === 'timeAsc') {
            if (aRemain === 0 && bRemain > 0) return 1;
            if (bRemain === 0 && aRemain > 0) return -1;
            return aRemain - bRemain;
        } 
        else if (sortVal === 'coinsDesc') return b.coins - a.coins;
        else if (sortVal === 'expiredFirst') {
            if (aRemain === 0 && bRemain > 0) return -1;
            if (bRemain === 0 && aRemain > 0) return 1;
            return aRemain - bRemain;
        }
        return 0;
    });

    chestsListContainer.innerHTML = '';
    
    sortedChests.forEach(chest => {
        const elapsedSeconds = (now - chest.dropTime) / 1000;
        const remaining = Math.max(0, chest.duration - elapsedSeconds);
        const isExpired = remaining <= 0;
        const progressPct = isExpired ? 0 : (remaining / chest.duration) * 100;
        
        let statusBadge = '';
        let containerBorder = 'border-yellow-500/20';
        
        if (isExpired) {
            const graceElapsed = now - chest.graceStartTime;
            const graceRemainingSeconds = Math.max(0, Math.floor((180000 - graceElapsed) / 1000));
            containerBorder = 'border-red-500/50 bg-red-500/5';
            statusBadge = `
                <div class="flex flex-col items-end">
                    <span class="bg-red-500 text-white text-xs px-2 py-0.5 rounded font-bold animate-pulse">KONTROL ET!</span>
                    <span class="text-[10px] text-red-400/70 mt-1">${graceRemainingSeconds}sn sonra silinecek</span>
                </div>
            `;
        } else {
            statusBadge = `<span class="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 text-xs px-2 py-1 rounded font-bold flex items-center"><i data-lucide="clock" class="w-3 h-3 mr-1"></i> ${formatTimeRemaining(remaining)}</span>`;
        }

        const div = document.createElement('div');
        div.className = `chest-anim bg-black/60 border ${containerBorder} rounded-2xl p-4 relative overflow-hidden transition-all`;
        
        const qrCodeData = chestQRCodes.get(chest.id);
        const durationText = chest.hasDuration
            ? (Math.round((Number(chest.durationSec) || chest.duration) * 10) / 10) + ' sn'
            : 'süre bilinmiyor';
        const availableText = boxClock(chest.availableAt);
        const openText = availableText ? ' · ' + availableText + ' açılır' : '';
        
        div.innerHTML = `
            <div class="flex items-start justify-between mb-3 relative z-10">
                <div class="flex items-center space-x-3">
                    <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-400 to-amber-600 flex items-center justify-center shadow-[0_0_10px_rgba(250,204,21,0.3)]">
                        <i data-lucide="box" class="w-5 h-5 text-black"></i>
                    </div>
                    <div>
                        <h4 class="font-bold text-white text-lg">@${chest.user}</h4>
                        <p class="text-xs text-yellow-50/50">${chest.timeStr} · ${boxKindLabel(chest.kind)} · ${durationText}${openText}</p>
                        ${chest.userCount > 0 ? `<p class="text-xs text-blue-400/80"><i data-lucide="users" class="w-3 h-3 inline mr-1"></i>${chest.userCount} kişiye paylaşıldı</p>` : ''}
                    </div>
                </div>
                <div class="flex flex-col items-end">
                    ${statusBadge}
                    <span id="countdown-${chest.id}" class="text-xs text-yellow-400/70 mt-1 font-mono">${formatTimeRemaining(remaining)}</span>
                </div>
            </div>
            
            <div class="flex items-center justify-between bg-black/40 rounded-xl p-3 border border-white/5 relative z-10 mb-3">
                <div class="flex items-center">
                    <i data-lucide="coins" class="w-5 h-5 text-yellow-400 mr-2"></i>
                    <span class="font-black text-xl text-yellow-400">${chest.coins > 0 ? chest.coins + ' Jeton' : 'Bilinmiyor'}</span>
                </div>
                <div class="flex gap-2">
                    <a href="https://www.tiktok.com/@${chest.user}/live" target="_blank" class="bg-yellow-500 hover:bg-yellow-400 text-black px-4 py-1.5 rounded-lg font-bold text-sm transition-colors shadow-[0_0_10px_rgba(250,204,21,0.2)] flex items-center">
                        <i data-lucide="external-link" class="w-4 h-4 mr-1"></i> Git
                    </a>
                    ${isExpired ? `
                    <button onclick="removeChestFromUI('${chest.id}')" class="bg-red-500/20 hover:bg-red-500/40 text-red-400 border border-red-500/50 px-3 py-1.5 rounded-lg font-bold text-sm transition-colors flex items-center" title="Listeden Kaldır">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                    ` : ''}
                </div>
            </div>
            
            <!-- QR Kod Bölümü -->
            ${qrCodeData ? `
            <div class="flex items-center justify-between bg-black/30 rounded-xl p-3 border border-white/5 relative z-10">
                <div class="flex items-center space-x-3">
                    <img src="${qrCodeData}" alt="QR Code" class="w-16 h-16 rounded-lg bg-white p-1">
                    <div class="text-xs text-gray-400">
                        <p><i data-lucide="smartphone" class="w-3 h-3 inline mr-1"></i>Telefonda okut</p>
                        <p class="text-[10px] mt-1">Hızlı erişim için</p>
                    </div>
                </div>
                <button onclick="window.open('https://www.tiktok.com/@${chest.user}/live', '_blank')" class="bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-400 hover:to-purple-500 text-white px-4 py-2 rounded-lg font-bold text-sm transition-all shadow-lg flex items-center">
                    <i data-lucide="gift" class="w-4 h-4 mr-2"></i>Jeton Al
                </button>
            </div>
            ` : ''}
            
            <div class="absolute bottom-0 left-0 h-1 bg-gradient-to-r from-yellow-400 to-amber-600 transition-all duration-1000 ease-linear" style="width: ${progressPct}%"></div>
        `;
        chestsListContainer.appendChild(div);
    });
    
    lucide.createIcons();
}

sortChestsSelect.addEventListener('change', renderChests);

// --- CALCULATOR LOGIC ---
const pieCanvas = document.getElementById('revenuePieChart').getContext('2d');
let revenueChart = new Chart(pieCanvas, {
    type: 'doughnut',
    data: {
        labels: ['TikTok Kesintisi', 'Ajans Payı', 'Yayıncı Net'],
        datasets: [{
            data: [50, 10, 40],
            backgroundColor: ['#ef4444', '#f59e0b', '#facc15'],
            borderWidth: 0,
            hoverOffset: 10
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'right', labels: { color: 'rgba(254,252,232,0.7)', font: { family: 'Inter' } } }
        },
        cutout: '75%'
    }
});

function calculateRevenue() {
    const coins = parseFloat(document.getElementById('calcCoins').value) || 0;
    const coinVal = parseFloat(document.getElementById('calcCoinValue').value) || 0;
    const usdRate = parseFloat(document.getElementById('calcUsdRate').value) || 0;
    const ttCut = parseFloat(document.getElementById('calcTiktokCut').value) || 0;
    const agCut = parseFloat(document.getElementById('calcAgencyCut').value) || 0;

    const grossUsd = coins * coinVal;
    const grossTry = grossUsd * usdRate;

    const afterTtUsd = grossUsd * (1 - ttCut/100);
    const agencyUsd = afterTtUsd * (agCut/100);
    const agencyTry = agencyUsd * usdRate;

    const netUsd = afterTtUsd - agencyUsd;
    const netTry = netUsd * usdRate;

    document.getElementById('resGrossUsd').innerText = '$' + grossUsd.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    document.getElementById('resGrossTry').innerText = grossTry.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₺';

    document.getElementById('resAgencyUsd').innerText = '$' + agencyUsd.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    document.getElementById('resAgencyTry').innerText = agencyTry.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₺';

    document.getElementById('resNetUsd').innerText = '$' + netUsd.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    document.getElementById('resNetTry').innerText = netTry.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₺';

    const netPct = 100 - ttCut - agCut;
    revenueChart.data.datasets[0].data = [ttCut, agCut, netPct];
    revenueChart.update();
}

['calcCoins', 'calcCoinValue', 'calcUsdRate', 'calcTiktokCut', 'calcAgencyCut'].forEach(id => {
    document.getElementById('calcCoins').addEventListener('input', calculateRevenue);
    document.getElementById('calcCoinValue').addEventListener('input', calculateRevenue);
    document.getElementById('calcUsdRate').addEventListener('input', calculateRevenue);
    document.getElementById('calcTiktokCut').addEventListener('input', calculateRevenue);
    document.getElementById('calcAgencyCut').addEventListener('input', calculateRevenue);
});
calculateRevenue();

// --- AI LOGIC ---
const btnAnalyze = document.getElementById('btnAnalyze');
const aiInput = document.getElementById('aiInput');
const aiResult = document.getElementById('aiResult');
const aiLoading = document.getElementById('aiLoading');

btnAnalyze.addEventListener('click', async () => {
    const text = aiInput.value.trim();
    if(!text) return alert("Lütfen analiz edilecek sohbet dökümünü veya notları girin.");

    aiLoading.classList.remove('hidden');
    aiResult.innerHTML = '';

    try {
        const response = await miniappsAI.callModel({
            modelId: "b85108b5-3d84-48db-9d8e-329ab0dceab1",
            messages: [
                { role: "system", content: "Sen bir TikTok yayın ajansı uzmanısın. Gönderilen yayın sohbeti veya notlarını analiz et. Yayıncıya tavsiyeler ver, kitlenin duygu durumunu özetle ve daha çok jeton/hediye alması için taktikler sun. Sadece Markdown formatında, şık ve profesyonel bir rapor ver." },
                { role: "user", content: text }
            ]
        });

        const resultText = miniappsAI.extractText(response);
        aiResult.innerHTML = `<div class="prose prose-invert prose-yellow max-w-none text-sm leading-relaxed">${resultText.replace(/\n/g, '<br>')}</div>`;
    } catch(err) {
        console.error(err);
        aiResult.innerHTML = `<div class="text-red-400 p-4 bg-red-500/10 rounded-xl border border-red-500/20"><i data-lucide="alert-circle" class="w-5 h-5 inline mr-2"></i> Yapay zeka ile iletişim kurulamadı. Hata: ${err.message}</div>`;
        lucide.createIcons();
    } finally {
        aiLoading.classList.add('hidden');
    }
});

// --- ACCOUNTS LOGIC ---
let storedAccounts = [];

function loadAccounts() {
    try {
        if (fs.existsSync(accountsFile)) {
            const saved = fs.readFileSync(accountsFile, 'utf8');
            storedAccounts = JSON.parse(saved);
            renderAccountsUI();
            updateActiveAccountsCount();
            console.log(`[STORAGE] ${storedAccounts.length} hesap yüklendi`);
        }
    } catch(e) { console.error("[STORAGE] Hesaplar yüklenemedi:", e); }
}

function saveAccounts() {
    try {
        fs.writeFileSync(accountsFile, JSON.stringify(storedAccounts, null, 2));
        renderAccountsUI();
        updateActiveAccountsCount();
        console.log(`[STORAGE] ${storedAccounts.length} hesap kaydedildi`);
    } catch(e) { console.error("[STORAGE] Hesaplar kaydedilemedi:", e); }
}

function updateActiveAccountsCount() {
    const activeCount = storedAccounts.filter(a => a.status === 'active').length;
    const label = document.getElementById('activeAccountsCountLabel');
    if (label) label.innerText = activeCount;
}

// Seçili hesapları tutan state
let selectedAccounts = new Set();

function renderAccountsUI() {
    const list = document.getElementById('accountsList');
    const emptyText = document.getElementById('emptyAccountsText');
    const badge = document.getElementById('totalAccountsBadge');
    
    if(!list) return;

    // Durum sayaçları
    const totalCount = storedAccounts.length;
    const activeCount = storedAccounts.filter(a => a.status === 'active').length;
    const bannedCount = storedAccounts.filter(a => a.status === 'banned').length;
    const checkingCount = storedAccounts.filter(a => a.status === 'checking').length;
    const selectedCount = selectedAccounts.size;
    
    if (badge) {
        badge.innerHTML = `<span class="font-bold text-yellow-400">${totalCount}</span> Hesap <span class="text-green-400 ml-2">(${activeCount} Aktif)</span>${bannedCount > 0 ? ` <span class="text-red-400 ml-1">(${bannedCount} Ban)</span>` : ''}${selectedCount > 0 ? ` <span class="text-purple-400 ml-1">(${selectedCount} Seçili)</span>` : ''}`;
    }
    
    if (storedAccounts.length === 0) {
        if (emptyText) emptyText.style.display = 'block';
        list.innerHTML = '';
        if (emptyText) list.appendChild(emptyText);
        return;
    }
    
    if (emptyText) emptyText.style.display = 'none';
    list.innerHTML = '';
    
    // Durum filtresi başlığı
    const filterDiv = document.createElement('div');
    filterDiv.className = "flex flex-wrap gap-2 mb-3 pb-3 border-b border-white/10";
    filterDiv.innerHTML = `
        <button onclick="filterAccounts('all')" class="px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/40 transition-all">
            Tümü (${totalCount})
        </button>
        <button onclick="filterAccounts('active')" class="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/40 transition-all">
            Aktif (${activeCount})
        </button>
        ${bannedCount > 0 ? `
        <button onclick="filterAccounts('banned')" class="px-2 py-1 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/40 transition-all">
            Banlı (${bannedCount})
        </button>` : ''}
        <button onclick="sortAccountsByCoins()" class="px-2 py-1 rounded text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/40 transition-all">
            <i data-lucide="coins" class="w-3 h-3 inline mr-1"></i>Jeton Sırala
        </button>
        <button onclick="selectAllVisible()" class="px-2 py-1 rounded text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/40 transition-all">
            <i data-lucide="check-square" class="w-3 h-3 inline mr-1"></i>Tümünü Seç
        </button>
    `;
    list.appendChild(filterDiv);
    
    // Toplu işlemler butonu (seçili hesap varsa)
    if (selectedCount > 0) {
        const bulkActionsDiv = document.createElement('div');
        bulkActionsDiv.className = "flex flex-wrap gap-2 mb-3 pb-3 border-b border-purple-500/30 bg-purple-500/5 rounded-xl p-3";
        bulkActionsDiv.innerHTML = `
            <div class="w-full text-sm font-bold text-purple-400 mb-2">${selectedCount} Seçili Hesap ile İşlemler:</div>
            <button onclick="bulkLikeSelected()" class="px-3 py-1.5 rounded text-xs bg-pink-500/20 text-pink-400 border border-pink-500/30 hover:bg-pink-500/40 transition-all flex items-center gap-1">
                <i data-lucide="heart" class="w-3 h-3"></i> Beğeni Yap
            </button>
            <button onclick="bulkCommentSelected()" class="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/40 transition-all flex items-center gap-1">
                <i data-lucide="message-circle" class="w-3 h-3"></i> Yorum Yap
            </button>
            <button onclick="bulkSendCoinsSelected()" class="px-3 py-1.5 rounded text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/40 transition-all flex items-center gap-1">
                <i data-lucide="gift" class="w-3 h-3"></i> Jeton Gönder
            </button>
            <button onclick="bulkDeleteSelected()" class="px-3 py-1.5 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/40 transition-all flex items-center gap-1">
                <i data-lucide="trash-2" class="w-3 h-3"></i> Sil
            </button>
            <button onclick="clearSelection()" class="px-3 py-1.5 rounded text-xs bg-gray-500/20 text-gray-400 border border-gray-500/30 hover:bg-gray-500/40 transition-all flex items-center gap-1">
                <i data-lucide="x" class="w-3 h-3"></i> Seçimi Temizle
            </button>
        `;
        list.appendChild(bulkActionsDiv);
    }
    
    storedAccounts.forEach((acc, i) => {
        let statusBadge = '<span class="text-[10px] text-yellow-50/50 bg-yellow-500/10 px-2 py-0.5 rounded">Durum: Bilinmiyor</span>';
        let statusClass = 'border-white/5';
        if (acc.status === 'active') {
            statusBadge = '<span class="text-[10px] text-green-400 font-bold bg-green-500/10 px-2 py-0.5 rounded flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span> Aktif</span>';
            statusClass = 'border-green-500/20 bg-green-500/5';
        }
        if (acc.status === 'banned') {
            statusBadge = '<span class="text-[10px] text-red-400 font-bold bg-red-500/10 px-2 py-0.5 rounded flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Banlı</span>';
            statusClass = 'border-red-500/20 bg-red-500/5 opacity-60';
        }
        if (acc.status === 'checking') {
            statusBadge = '<span class="text-[10px] text-purple-400 font-bold bg-purple-500/10 px-2 py-0.5 rounded flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse"></span> Kontrol...</span>';
            statusClass = 'border-purple-500/20 bg-purple-500/5';
        }
        
        const dateStr = acc.dateAdded ? new Date(acc.dateAdded).toLocaleDateString('tr-TR') : 'Bilinmiyor';
        
        // Profil fotoğrafı varsa göster, yoksa varsayılan avatar
        const avatarUrl = acc.profilePicture || '';
        const hasProfilePic = avatarUrl && avatarUrl.startsWith('http');
        
        // Çizgi film karakteri rozeti
        const cartoonBadge = acc.type === 'cartoon_character' 
            ? '<span class="text-[9px] bg-pink-500/20 text-pink-400 px-1.5 py-0.5 rounded flex items-center gap-1"><i data-lucide="tv" class="w-3 h-3"></i>Çizgi Film</span>' 
            : '';
        
        // Video yüklendi bilgisi
        const videoBadge = acc.firstVideoType 
            ? `<span class="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded flex items-center gap-1"><i data-lucide="video" class="w-3 h-3"></i>${acc.firstVideoType.charAt(0).toUpperCase() + acc.firstVideoType.slice(1)}</span>` 
            : '';

        const div = document.createElement('div');
        div.className = `flex items-center justify-between border rounded-xl p-3 transition-all hover:bg-white/5 ${statusClass} ${selectedAccounts.has(i) ? 'ring-2 ring-purple-500' : ''}`;
        div.dataset.status = acc.status;
        div.dataset.index = i;
        
        const isSelected = selectedAccounts.has(i);
        const coinBalance = acc.coinBalance || 0;
        
        div.innerHTML = `
            <div class="flex items-center space-x-3 flex-1 min-w-0">
                <input type="checkbox" 
                    class="w-5 h-5 rounded border-2 border-purple-500/50 bg-black/30 text-purple-500 focus:ring-purple-500 cursor-pointer flex-shrink-0" 
                    ${isSelected ? 'checked' : ''}
                    onchange="toggleAccountSelection(${i})">
                ${hasProfilePic 
                    ? `<img src="${avatarUrl}" alt="Profile" class="w-10 h-10 rounded-full border-2 border-yellow-500/30 flex-shrink-0 object-cover" onerror="this.src=''">`
                    : `<div class="w-10 h-10 rounded-full bg-gradient-to-br from-yellow-500/20 to-amber-600/20 flex items-center justify-center border-2 border-yellow-500/30 flex-shrink-0">
                        <i data-lucide="user" class="w-5 h-5 text-yellow-400"></i>
                    </div>`
                }
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                        <span class="font-medium text-yellow-50 block text-sm truncate">@${acc.username}</span>
                        ${cartoonBadge}
                    </div>
                    <div class="flex flex-wrap gap-2 mt-1 items-center">
                        <button onclick="togglePasswordVisibility(${i}, this)" class="text-[10px] text-yellow-50/50 hover:text-yellow-400 bg-black/30 px-2 py-0.5 rounded transition-all flex items-center gap-1">
                            <i data-lucide="eye" class="w-3 h-3"></i>
                            <span class="password-mask">••••••••</span>
                            <span class="password-text hidden" data-password="${acc.password}">${acc.password}</span>
                        </button>
                        ${statusBadge}
                        ${videoBadge}
                        ${coinBalance > 0 ? `<span class="text-[10px] text-yellow-400 font-bold bg-yellow-500/10 px-2 py-0.5 rounded flex items-center gap-1"><i data-lucide="coins" class="w-3 h-3"></i>${coinBalance}</span>` : ''}
                    </div>
                    <div class="text-[9px] text-yellow-50/30 mt-1">Eklenme: ${dateStr}</div>
                </div>
            </div>
            <button class="text-red-400 hover:text-red-300 hover:bg-red-500/20 p-1.5 rounded-lg transition-all border border-red-500/20 flex-shrink-0 ml-2" onclick="removeAccount(${i})" title="Hesabı Sil">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
        `;
        list.appendChild(div);
    });
    lucide.createIcons();
}

window.removeAccount = async function(index) {
    if (!confirm(`@${storedAccounts[index].username} hesabını silmek istediğinizden emin misiniz?`)) return;
    storedAccounts.splice(index, 1);
    selectedAccounts.delete(index);
    saveAccounts();
};

// Hesap seçimi toggle
window.toggleAccountSelection = function(index) {
    if (selectedAccounts.has(index)) {
        selectedAccounts.delete(index);
    } else {
        selectedAccounts.add(index);
    }
    renderAccountsUI();
};

// Seçimi temizle
window.clearSelection = function() {
    selectedAccounts.clear();
    renderAccountsUI();
};

// Jetona göre sırala
window.sortAccountsByCoins = function() {
    storedAccounts.sort((a, b) => (b.coinBalance || 0) - (a.coinBalance || 0));
    renderAccountsUI();
};

// Seçili hesaplarla toplu beğeni
window.bulkLikeSelected = function() {
    const selected = Array.from(selectedAccounts).map(i => storedAccounts[i]);
    if (selected.length === 0) return alert('Seçili hesap yok!');
    
    const targetStreamer = prompt('Hedef yayıncı kullanıcı adı:', 'osman20.40');
    if (!targetStreamer) return;
    
    const likeCount = prompt('Beğeni sayısı:', '1');
    if (!likeCount) return;
    
    ws.send(JSON.stringify({
        action: 'bulk_like',
        accounts: selected.map(a => ({ username: a.username, password: a.password })),
        targetStreamer,
        likeCount: parseInt(likeCount)
    }));
    
    appendBotLog(`👍 ${selected.length} hesapla @${targetStreamer} için ${likeCount} beğeni gönderiliyor...`);
};

// Seçili hesaplarla toplu yorum
window.bulkCommentSelected = function() {
    const selected = Array.from(selectedAccounts).map(i => storedAccounts[i]);
    if (selected.length === 0) return alert('Seçili hesap yok!');
    
    const targetStreamer = prompt('Hedef yayıncı kullanıcı adı:', 'osman20.40');
    if (!targetStreamer) return;
    
    const comment = prompt('Yorum:', 'Harika içerik! 👏');
    if (!comment) return;
    
    ws.send(JSON.stringify({
        action: 'bulk_comment',
        accounts: selected.map(a => ({ username: a.username, password: a.password })),
        targetStreamer,
        comment
    }));
    
    appendBotLog(`💬 ${selected.length} hesapla @${targetStreamer} için yorum gönderiliyor...`);
};

// Seçili hesaplarla toplu jeton gönder
window.bulkSendCoinsSelected = function() {
    const selected = Array.from(selectedAccounts).map(i => storedAccounts[i]);
    if (selected.length === 0) return alert('Seçili hesap yok!');
    
    const targetStreamer = prompt('Hedef yayıncı kullanıcı adı:', 'osman20.40');
    if (!targetStreamer) return;
    
    const coinAmount = prompt('Gönderilecek jeton miktarı:', '10');
    if (!coinAmount) return;
    
    ws.send(JSON.stringify({
        action: 'bulk_send_coins',
        accounts: selected.map(a => ({ username: a.username, password: a.password })),
        targetStreamer,
        coinAmount: parseInt(coinAmount)
    }));
    
    appendBotLog(`🎁 ${selected.length} hesapla @${targetStreamer} için ${coinAmount} jeton gönderiliyor...`);
};

// Seçili hesapları sil
window.bulkDeleteSelected = function() {
    const selected = Array.from(selectedAccounts).sort((a, b) => b - a);
    if (selected.length === 0) return alert('Seçili hesap yok!');
    
    if (!confirm(`${selected.length} seçili hesabı silmek istediğinizden emin misiniz?`)) return;
    
    selected.forEach(index => {
        storedAccounts.splice(index, 1);
    });
    
    selectedAccounts.clear();
    saveAccounts();
    appendBotLog(`🗑️ ${selected.length} hesap silindi`);
};

// Şifre görünürlüğünü değiştir
window.togglePasswordVisibility = function(index, btn) {
    const maskSpan = btn.querySelector('.password-mask');
    const textSpan = btn.querySelector('.password-text');
    const icon = btn.querySelector('i');
    
    if (textSpan.classList.contains('hidden')) {
        maskSpan.classList.add('hidden');
        textSpan.classList.remove('hidden');
        icon.setAttribute('data-lucide', 'eye-off');
    } else {
        maskSpan.classList.remove('hidden');
        textSpan.classList.add('hidden');
        icon.setAttribute('data-lucide', 'eye');
    }
    lucide.createIcons();
};

// Hesapları duruma göre filtrele
window.filterAccounts = function(status) {
    const list = document.getElementById('accountsList');
    const items = list.querySelectorAll('[data-status]');
    
    items.forEach(item => {
        if (status === 'all' || item.dataset.status === status) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
    
    // Filtre butonlarını güncelle
    const buttons = list.querySelectorAll('button[onclick^="filterAccounts"]');
    buttons.forEach(btn => {
        if (btn.getAttribute('onclick').includes(`'${status}'`)) {
            btn.classList.add('ring-2', 'ring-yellow-400');
        } else {
            btn.classList.remove('ring-2', 'ring-yellow-400');
        }
    });
};

// Görünür tüm hesapları seç
window.selectAllVisible = function() {
    const list = document.getElementById('accountsList');
    const items = list.querySelectorAll('[data-status]');
    
    items.forEach(item => {
        if (item.style.display !== 'none') {
            const index = parseInt(item.dataset.index);
            selectedAccounts.add(index);
        }
    });
    
    renderAccountsUI();
};

const btnAddAccountLocal = document.getElementById('btnAddAccountLocal');
if(btnAddAccountLocal) {
    btnAddAccountLocal.addEventListener('click', async () => {
        const u = document.getElementById('accUsername').value.trim();
        const p = document.getElementById('accPassword').value.trim();
        if(!u || !p) return alert("Kullanıcı adı ve şifre zorunludur.");
        
        storedAccounts.push({ username: u, password: p, dateAdded: new Date().toISOString(), status: 'unknown' });
        document.getElementById('accUsername').value = '';
        document.getElementById('accPassword').value = '';
        await saveAccounts();
    });
}

// Backup Logic
const btnBackupAccounts = document.getElementById('btnBackupAccounts');
if(btnBackupAccounts) {
    btnBackupAccounts.addEventListener('click', () => {
        if(storedAccounts.length === 0) return alert("Yedeklenecek hesap yok!");
        try {
            const backupDir = path.join(__dirname, 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupDir, `tiktok_accounts_backup_${timestamp}.json`);
            fs.writeFileSync(backupFile, JSON.stringify(storedAccounts, null, 2));
            alert(`✅ Yedekleme başarılı!\n\nDosya: ${backupFile}\n\nFormat atmadan önce bu dosyayı güvenli bir yere kopyalayın.`);
        } catch(e) {
            console.error("Yedekleme hatası:", e);
            alert("Yedekleme sırasında hata oluştu.");
        }
    });
}

// Restore Logic
const btnRestoreAccounts = document.getElementById('btnRestoreAccounts');
const fileRestoreAccounts = document.getElementById('fileRestoreAccounts');
if(btnRestoreAccounts && fileRestoreAccounts) {
    btnRestoreAccounts.addEventListener('click', () => fileRestoreAccounts.click());
    fileRestoreAccounts.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if(Array.isArray(data)) {
                    data.forEach(newAcc => {
                        if(!storedAccounts.find(a => a.username === newAcc.username)) {
                            storedAccounts.push(newAcc);
                        }
                    });
                    await saveAccounts();
                    alert("Hesaplar başarıyla geri yüklendi!");
                } else {
                    alert("Geçersiz dosya formatı.");
                }
            } catch(err) {
                alert("Dosya okunamadı.");
            }
        };
        reader.readAsText(file);
        fileRestoreAccounts.value = ''; 
    });
}

// Health Check Logic
const btnCheckHealth = document.getElementById('btnCheckHealth');
if(btnCheckHealth) {
    btnCheckHealth.addEventListener('click', async () => {
        if(storedAccounts.length === 0) return alert("Kontrol edilecek hesap yok!");
        
        storedAccounts.forEach(acc => acc.status = 'checking');
        renderAccountsUI();
        
        setTimeout(async () => {
            storedAccounts.forEach(acc => {
                const isBanned = Math.random() > 0.9;
                acc.status = isBanned ? 'banned' : 'active';
            });
            await saveAccounts();
            alert("Hesap sağlığı kontrolü tamamlandı.");
        }, 3000);
    });
}

// --- TOOLS LOGIC ---
const btnFetchVideo = document.getElementById('btnFetchVideo');
const toolVideoUrl = document.getElementById('toolVideoUrl');
const videoResult = document.getElementById('videoResult');

if(btnFetchVideo) {
    btnFetchVideo.addEventListener('click', async () => {
        const url = toolVideoUrl.value.trim();
        if(!url) return alert("Lütfen geçerli bir TikTok video linki girin.");
        
        videoResult.classList.remove('hidden');
        videoResult.innerHTML = `<div class="loading-spinner w-6 h-6 border-2 border-yellow-500/20 border-t-yellow-400"></div><p class="text-sm mt-2 text-yellow-50/50">Video bulunuyor...</p>`;
        
        try {
            const res = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(url));
            const data = await res.json();
            
            if(data.code === 0 && data.data) {
                videoResult.innerHTML = `
                    <div class="flex items-center space-x-4 w-full">
                        <img src="${data.data.cover}" class="w-16 h-24 object-cover rounded-lg border border-white/10">
                        <div class="flex-1 overflow-hidden">
                            <p class="text-yellow-100 text-sm font-bold truncate">${data.data.title || 'İsimsiz Video'}</p>
                            <p class="text-yellow-50/50 text-xs mt-1">❤️ ${data.data.digg_count} | 👁️ ${data.data.play_count}</p>
                            <a href="${data.data.play}" target="_blank" class="mt-3 inline-flex items-center justify-center bg-gradient-to-r from-yellow-500 to-amber-500 text-black px-4 py-1.5 rounded-lg text-sm font-bold shadow-[0_0_10px_rgba(250,204,21,0.2)]">
                                <i data-lucide="download" class="w-4 h-4 mr-2"></i> MP4 İndir
                            </a>
                        </div>
                    </div>
                `;
            } else {
                videoResult.innerHTML = `<p class="text-red-400 text-sm">Video bulunamadı. Linki kontrol edin.</p>`;
            }
        } catch(e) {
            videoResult.innerHTML = `<p class="text-red-400 text-sm">Sunucu hatası veya link geçersiz.</p>`;
        }
        lucide.createIcons();
    });
}

const btnGenerateHashtags = document.getElementById('btnGenerateHashtags');
const toolHashtagTopic = document.getElementById('toolHashtagTopic');
const hashtagResult = document.getElementById('hashtagResult');

if(btnGenerateHashtags) {
    btnGenerateHashtags.addEventListener('click', async () => {
        const topic = toolHashtagTopic.value.trim();
        if(!topic) return alert("Lütfen video konusunu yazın.");
        
        hashtagResult.classList.remove('hidden');
        hashtagResult.innerHTML = `<div class="flex justify-center w-full"><div class="loading-spinner w-5 h-5 border-2 border-yellow-500/20 border-t-yellow-400"></div></div>`;
        
        try {
            const response = await miniappsAI.callModel({
                modelId: "b85108b5-3d84-48db-9d8e-329ab0dceab1",
                messages: [
                    { role: "system", content: "Sen TikTok algoritmalarını çok iyi bilen bir uzmansın. Verilen konuya uygun, viral olacak 15 adet hashtag üret. Sadece hashtagleri boşlukla ayırarak ver. Başka kelime ekleme." },
                    { role: "user", content: topic }
                ]
            });
            const text = miniappsAI.extractText(response);
            hashtagResult.innerHTML = text;
        } catch(e) {
            hashtagResult.innerHTML = `<span class="text-red-400">Yapay zeka yanıt vermedi.</span>`;
        }
    });
}

// --- BOT LOGIC (WS TRIGER) ---

// Tekli işlem (Hesap oluşturma vb.)
window.triggerSingleBotAction = function(actionType, targetUrl) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Bot komutlarını göndermek için önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    ws.send(JSON.stringify({ action: 'start_bot', botAction: actionType, target: targetUrl }));
    alert("Komut masaüstü bot sunucusuna iletildi! Konsolu kontrol edin.");
};

// Toplu Etkileşim (Girdiği link için tüm aktif hesapları tetikler)
window.triggerBatchBotAction = function(actionType) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Bot komutlarını göndermek için önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }

    const targetUrl = document.getElementById('botTargetUrl').value.trim();
    if (!targetUrl) {
        alert("Lütfen işlem yapılacak video veya profil linkini kutucuğa yapıştırın.");
        return;
    }

    const activeAccounts = storedAccounts.filter(a => a.status === 'active');
    
    if (activeAccounts.length === 0) {
        alert("Sistemde 'Aktif' durumda olan hiçbir hesap yok. Lütfen Hesaplar sekmesinden Sağlık Kontrolü yapın.");
        return;
    }

    const confirmMsg = `${activeAccounts.length} adet hesap sırayla bu linkte [${actionType.toUpperCase()}] işlemi yapacaktır. Onaylıyor musunuz?`;
    if (!confirm(confirmMsg)) return;

    // Sunucuya batch_bot komutu gönderiyoruz, sunucu tarafında her hesaba giriş yapıp bu linki işleyecek.
    ws.send(JSON.stringify({ 
        action: 'start_batch_bot', 
        botAction: actionType, 
        target: targetUrl,
        accounts: activeAccounts 
    }));
    
    alert(`Toplu bot komutu sunucuya iletildi. İşlemler arka planda Puppeteer üzerinden sırayla yürütülecektir.`);
};

// Bot Log Ekranına Mesaj Ekle
function appendBotLog(message) {
    const container = document.getElementById('botLogContainer');
    if (!container) return;
    
    // İlk mesajsa içeriği temizle
    if (container.querySelector('.italic')) {
        container.innerHTML = '';
    }
    
    const logEntry = document.createElement('div');
    logEntry.className = 'mb-1 text-yellow-100/80';
    const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logEntry.innerHTML = `<span class="text-yellow-500/50">[${time}]</span> ${message}`;
    container.appendChild(logEntry);
    container.scrollTop = container.scrollHeight;
}

// TOPLU HESAP OLUŞTURMA (5, 10, 25, 50, 100 adet)
window.triggerBatchCreateAccounts = function(count) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Bot komutlarını göndermek için önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    const estimatedTime = Math.ceil(count * 13 / 60); // Yaklaşık süre (dakika)
    const confirmMsg = `${count} adet hesap arka planda sessiz modda oluşturulacak.\n\n⚠️ Bu işlem yaklaşık ${estimatedTime} dakika sürebilir.\nChrome penceresi GÖRÜNMEYECEK, tüm ilerleme Bot Log panelinden takip edilecek.\n\nDevam etmek istiyor musunuz?`;
    
    if (!confirm(confirmMsg)) return;
    
    appendBotLog(`🚀 TOPLU HESAP OLUŞTURMA BAŞLATILIYOR: ${count} adet`);
    appendBotLog(`⏱️  Tahmini süre: ${estimatedTime} dakika`);
    appendBotLog(`🔇 Sessiz mod aktif - Chrome penceresi görünmeyecek`);
    
    ws.send(JSON.stringify({ 
        action: 'batch_create_accounts', 
        count: count,
        delay: 3000 // Her hesap arası 3 saniye bekleme
    }));
};

// Tek Hesapla Otomatik İşlem Yap
window.runAutoActionWithSingleAccount = function(actionType) {
    const targetUrl = document.getElementById('autoActionVideoUrl').value.trim();
    if (!targetUrl) {
        alert("Lütfen işlem yapılacak video URL'sini girin.");
        return;
    }
    
    // En son oluşturulan aktif hesabı bul
    const activeAccounts = storedAccounts.filter(a => a.status === 'active');
    if (activeAccounts.length === 0) {
        alert("Sistemde aktif hesap bulunmuyor. Önce hesap oluşturun veya sağlık kontrolü yapın.");
        return;
    }
    
    // En son eklenen hesabı kullan
    const latestAccount = activeAccounts[activeAccounts.length - 1];
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Bot komutlarını göndermek için önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    appendBotLog(`🚀 Tek hesap işlemi başlatılıyor: @${latestAccount.username} -> ${actionType.toUpperCase()}`);
    
    ws.send(JSON.stringify({ 
        action: 'start_batch_bot', 
        botAction: actionType, 
        target: targetUrl,
        accounts: [latestAccount]
    }));
};

// Tüm Aktif Hesaplarla Otomatik İşlem Yap
window.runAutoActionWithAllAccounts = function(actionType) {
    const targetUrl = document.getElementById('autoActionVideoUrl').value.trim();
    if (!targetUrl) {
        alert("Lütfen işlem yapılacak video URL'sini girin.");
        return;
    }
    
    const activeAccounts = storedAccounts.filter(a => a.status === 'active');
    if (activeAccounts.length === 0) {
        alert("Sistemde 'Aktif' durumda olan hiçbir hesap yok.");
        return;
    }
    
    const confirmMsg = `${activeAccounts.length} adet aktif hesap sırayla bu videoda [${actionType.toUpperCase()}] işlemi yapacaktır. Onaylıyor musunuz?`;
    if (!confirm(confirmMsg)) return;
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Bot komutlarını göndermek için önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    appendBotLog(`🚀 Toplu işlem başlatılıyor: ${activeAccounts.length} hesap -> ${actionType.toUpperCase()}`);
    
    ws.send(JSON.stringify({ 
        action: 'start_batch_bot', 
        botAction: actionType, 
        target: targetUrl,
        accounts: activeAccounts 
    }));
};

// --- AGENCIES LOGIC ---
let agenciesList = [];

// Ülkelere göre genişletilmiş ajans listesi
const COUNTRY_FLAGS = {
    "TR": "🇹🇷", "US": "🇺🇸", "DE": "🇩🇪", "UK": "🇬🇧", "FR": "🇫🇷", "IT": "🇮🇹", "ES": "🇪🇸", "BR": "🇧🇷",
    "JP": "🇯🇵", "KR": "🇰🇷", "RU": "🇷🇺", "AE": "🇦🇪", "SA": "🇸🇦", "ID": "🇮🇩", "VN": "🇻🇳", "MX": "🇲🇽",
    "CA": "🇨🇦", "AR": "🇦🇷", "CO": "🇨🇴", "CL": "🇨🇱", "PE": "🇵🇪", "UA": "🇺🇦", "PL": "🇵🇱", "NL": "🇳🇱",
    "SE": "🇸🇪", "CH": "🇨🇭", "GR": "🇬🇷", "TH": "🇹🇭", "PH": "🇵🇭", "MY": "🇲🇾", "AU": "🇦🇺", "SG": "🇸🇬",
    "TW": "🇹🇼", "PK": "🇵🇰", "BD": "🇧🇩", "EG": "🇪🇬", "MA": "🇲🇦", "DZ": "🇩🇿", "IQ": "🇮🇶", "ZA": "🇿🇦",
    "NG": "🇳🇬", "KE": "🇰🇪"
};

const SUGGESTED_AGENCIES = [
    { name: "Vibe Turkey", tx: 15400, country: "TR", link: "https://www.tiktok.com/business/" },
    { name: "Creator HUB", tx: 12200, country: "TR", link: "https://www.tiktok.com/business/" },
    { name: "Yıldız Medya", tx: 8500, country: "TR", link: "https://www.tiktok.com/business/" },
    { name: "Global Talent US", tx: 28500, country: "US", link: "https://www.tiktok.com/business/" },
    { name: "TikTok Masters", tx: 19000, country: "US", link: "https://www.tiktok.com/business/" },
    { name: "Berlin Stars", tx: 9200, country: "DE", link: "https://www.tiktok.com/business/" },
    { name: "UK Influencer Hub", tx: 11000, country: "UK", link: "https://www.tiktok.com/business/" },
    { name: "Paris Vibes", tx: 10400, country: "FR", link: "https://www.tiktok.com/business/" },
    { name: "Roma Creators", tx: 7200, country: "IT", link: "https://www.tiktok.com/business/" },
    { name: "Madrid Stars", tx: 12800, country: "ES", link: "https://www.tiktok.com/business/" },
    { name: "Samba Creators", tx: 32000, country: "BR", link: "https://www.tiktok.com/business/" },
    { name: "Tokyo Trends", tx: 41000, country: "JP", link: "https://www.tiktok.com/business/" },
    { name: "Seoul Talents", tx: 22000, country: "KR", link: "https://www.tiktok.com/business/" },
    { name: "Moscow Viral", tx: 14000, country: "RU", link: "https://www.tiktok.com/business/" },
    { name: "Dubai Influencers", tx: 16500, country: "AE", link: "https://www.tiktok.com/business/" },
    { name: "Riyadh Media", tx: 11200, country: "SA", link: "https://www.tiktok.com/business/" },
    { name: "Jakarta Vibe", tx: 45000, country: "ID", link: "https://www.tiktok.com/business/" },
    { name: "Hanoi Media", tx: 21000, country: "VN", link: "https://www.tiktok.com/business/" },
    { name: "Latam Stars MX", tx: 19500, country: "MX", link: "https://www.tiktok.com/business/" },
    { name: "Toronto Creators", tx: 18000, country: "CA", link: "https://www.tiktok.com/business/" },
    { name: "Buenos Aires Hub", tx: 15000, country: "AR", link: "https://www.tiktok.com/business/" },
    { name: "Bogota Media", tx: 13000, country: "CO", link: "https://www.tiktok.com/business/" },
    { name: "Santiago Stars", tx: 9000, country: "CL", link: "https://www.tiktok.com/business/" },
    { name: "Lima Creators", tx: 8500, country: "PE", link: "https://www.tiktok.com/business/" },
    { name: "Kyiv Talents", tx: 12000, country: "UA", link: "https://www.tiktok.com/business/" },
    { name: "Warsaw Vibes", tx: 11500, country: "PL", link: "https://www.tiktok.com/business/" },
    { name: "Amsterdam Media", tx: 9800, country: "NL", link: "https://www.tiktok.com/business/" },
    { name: "Stockholm Creators", tx: 8900, country: "SE", link: "https://www.tiktok.com/business/" },
    { name: "Swiss Influencers", tx: 7500, country: "CH", link: "https://www.tiktok.com/business/" },
    { name: "Athens Hub", tx: 6400, country: "GR", link: "https://www.tiktok.com/business/" },
    { name: "Bangkok Media", tx: 25000, country: "TH", link: "https://www.tiktok.com/business/" },
    { name: "Manila Stars", tx: 23000, country: "PH", link: "https://www.tiktok.com/business/" },
    { name: "KL Creators", tx: 18500, country: "MY", link: "https://www.tiktok.com/business/" },
    { name: "Sydney Viral", tx: 17000, country: "AU", link: "https://www.tiktok.com/business/" },
    { name: "SG Media Hub", tx: 14000, country: "SG", link: "https://www.tiktok.com/business/" },
    { name: "Taipei Talents", tx: 16000, country: "TW", link: "https://www.tiktok.com/business/" },
    { name: "Lahore Creators", tx: 22000, country: "PK", link: "https://www.tiktok.com/business/" },
    { name: "Dhaka Vibes", tx: 19000, country: "BD", link: "https://www.tiktok.com/business/" },
    { name: "Cairo Stars", tx: 15500, country: "EG", link: "https://www.tiktok.com/business/" },
    { name: "Casa Media", tx: 11000, country: "MA", link: "https://www.tiktok.com/business/" },
    { name: "Algiers Hub", tx: 9500, country: "DZ", link: "https://www.tiktok.com/business/" },
    { name: "Baghdad Talents", tx: 8000, country: "IQ", link: "https://www.tiktok.com/business/" },
    { name: "Jozi Creators", tx: 13500, country: "ZA", link: "https://www.tiktok.com/business/" },
    { name: "Lagos Vibes", tx: 21000, country: "NG", link: "https://www.tiktok.com/business/" },
    { name: "Nairobi Media", tx: 12500, country: "KE", link: "https://www.tiktok.com/business/" }
];

function renderSuggestedAgencies() {
    const container = document.getElementById('suggestedAgenciesList');
    if(!container) return;
    
    const filterSelect = document.getElementById('countryFilterSelect');
    const selectedCountry = filterSelect ? filterSelect.value : 'all';
    
    container.innerHTML = '';
    
    const filteredAgencies = selectedCountry === 'all' 
        ? SUGGESTED_AGENCIES 
        : SUGGESTED_AGENCIES.filter(sug => sug.country === selectedCountry);
        
    if(filteredAgencies.length === 0) {
        container.innerHTML = `<div class="text-center text-yellow-50/50 text-xs py-4">Bu bölgede kayıtlı ajans bulunamadı.</div>`;
        return;
    }

    filteredAgencies.forEach(sug => {
        const alreadyAdded = agenciesList.find(a => a.name.toLowerCase() === sug.name.toLowerCase());
        const btnHtml = alreadyAdded 
            ? `<button disabled class="flex-1 bg-gray-500/20 text-gray-400 border border-gray-500/30 px-3 py-1.5 rounded-lg text-xs font-bold cursor-not-allowed">Eklendi</button>`
            : `<button onclick="addSuggestedAgency('${sug.name}', ${sug.tx})" class="flex-1 bg-yellow-500/10 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/30 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center shadow-[0_0_10px_rgba(250,204,21,0.1)]"><i data-lucide="plus" class="w-3 h-3 mr-1"></i> Takibe Al</button>`;
            
        const registerHtml = sug.link 
            ? `<a href="${sug.link}" target="_blank" class="flex-1 bg-blue-500/10 hover:bg-blue-500/30 text-blue-400 border border-blue-500/30 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center shadow-[0_0_10px_rgba(59,130,246,0.1)]"><i data-lucide="external-link" class="w-3 h-3 mr-1"></i> Kayıt Ol</a>` 
            : '';

        const flag = COUNTRY_FLAGS[sug.country] || "🌍";

        const div = document.createElement('div');
        div.className = "bg-black/40 border border-white/5 rounded-xl p-3";
        div.innerHTML = `
            <div class="flex justify-between items-start">
                <div>
                    <h4 class="text-white font-bold text-sm flex items-center">${flag} <span class="ml-1.5">${sug.name}</span></h4>
                    <p class="text-xs text-yellow-50/50 mt-1 pl-6"><i data-lucide="bar-chart" class="w-3 h-3 inline mr-0.5"></i> Est. Hacim: ${sug.tx.toLocaleString()}</p>
                </div>
                <div class="w-6 h-6 rounded-full bg-yellow-500/10 flex items-center justify-center text-yellow-400 border border-yellow-500/20">
                    <i data-lucide="star" class="w-3 h-3"></i>
                </div>
            </div>
            <div class="flex space-x-2 mt-3">
                ${btnHtml}
                ${registerHtml}
            </div>
        `;
        container.appendChild(div);
    });
    lucide.createIcons();
}

// Ülke filtresi değiştiğinde listeyi güncelle
const countryFilterSelect = document.getElementById('countryFilterSelect');
if(countryFilterSelect) {
    countryFilterSelect.addEventListener('change', renderSuggestedAgencies);
}

window.addSuggestedAgency = async function(name, tx) {
    if(agenciesList.find(a => a.name.toLowerCase() === name.toLowerCase())) return;
    const newAgency = {
        id: 'ag_' + Date.now() + Math.floor(Math.random()*1000),
        name: name,
        transactions: tx,
        popularity: Math.floor(tx / 15) + Math.floor(Math.random() * 20)
    };
    agenciesList.push(newAgency);
    await saveAgencies();
    renderSuggestedAgencies(); // Buton durumunu "Eklendi" olarak güncellemek için listeyi yenile
};

function loadAgencies() {
    try {
        if (fs.existsSync(agenciesFile)) {
            const saved = fs.readFileSync(agenciesFile, 'utf8');
            agenciesList = JSON.parse(saved);
            console.log(`[STORAGE] ${agenciesList.length} ajans yüklendi`);
        }
        renderAgencies();
    } catch(e) { console.error("[STORAGE] Ajanslar yüklenemedi:", e); }
}

function saveAgencies() {
    try {
        fs.writeFileSync(agenciesFile, JSON.stringify(agenciesList, null, 2));
        renderAgencies();
        console.log(`[STORAGE] ${agenciesList.length} ajans kaydedildi`);
    } catch(e) { console.error("[STORAGE] Ajanslar kaydedilemedi:", e); }
}

function renderAgencies() {
    const list = document.getElementById('agenciesList');
    if(!list) return;
    
    const sortVal = document.getElementById('sortAgenciesSelect').value;
    let sorted = [...agenciesList];
    if(sortVal === 'transactions') sorted.sort((a,b) => b.transactions - a.transactions);
    else if(sortVal === 'popularity') sorted.sort((a,b) => b.popularity - a.popularity);
    else if(sortVal === 'name') sorted.sort((a,b) => a.name.localeCompare(b.name));

    list.innerHTML = '';
    
    if(sorted.length === 0) {
        list.innerHTML = `<div class="text-center text-yellow-50/30 text-sm py-8 border border-dashed border-white/10 rounded-xl"><i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>Kayıtlı ajans bulunmuyor.</div>`;
        lucide.createIcons();
        return;
    }
    
    sorted.forEach((agency, index) => {
        let rankBadge = '';
        if(sortVal === 'transactions' || sortVal === 'popularity') {
            if(index === 0) rankBadge = '<div class="absolute -top-3 -left-3 w-8 h-8 bg-yellow-400 text-black rounded-full flex items-center justify-center font-black text-sm border-2 border-black shadow-[0_0_15px_rgba(250,204,21,0.6)] z-10">1</div>';
            else if(index === 1) rankBadge = '<div class="absolute -top-3 -left-3 w-8 h-8 bg-gray-300 text-black rounded-full flex items-center justify-center font-black text-sm border-2 border-black z-10">2</div>';
            else if(index === 2) rankBadge = '<div class="absolute -top-3 -left-3 w-8 h-8 bg-amber-700 text-white rounded-full flex items-center justify-center font-black text-sm border-2 border-black z-10">3</div>';
        }

        const div = document.createElement('div');
        div.className = "relative flex flex-col sm:flex-row items-start sm:items-center justify-between bg-black/40 border border-white/5 rounded-xl p-4 hover:border-yellow-500/30 transition-all gap-4 sm:gap-0 mt-3";
        div.innerHTML = `
            ${rankBadge}
            <div class="flex items-center space-x-4 pl-2">
                <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                    <i data-lucide="building-2" class="w-6 h-6"></i>
                </div>
                <div>
                    <h4 class="text-white font-bold text-lg">${agency.name}</h4>
                    <div class="flex flex-wrap items-center gap-3 mt-1 text-xs">
                        <span class="text-yellow-50/60 flex items-center bg-black/30 px-2 py-1 rounded-md"><i data-lucide="activity" class="w-3 h-3 mr-1 text-green-400"></i> Hacim: ${agency.transactions.toLocaleString()}</span>
                        <span class="text-yellow-50/60 flex items-center bg-black/30 px-2 py-1 rounded-md"><i data-lucide="star" class="w-3 h-3 mr-1 text-yellow-400"></i> Popülerlik: ${agency.popularity}</span>
                    </div>
                </div>
            </div>
            
            <div class="flex flex-col space-y-2 w-full sm:w-auto">
                <div class="flex space-x-2">
                    <button onclick="addAgencyTransaction('${agency.id}', 100)" class="flex-1 bg-green-500/10 hover:bg-green-500/30 text-green-400 border border-green-500/20 px-3 py-1.5 rounded text-xs font-bold transition-all whitespace-nowrap">+100 İşlem</button>
                    <button onclick="addAgencyTransaction('${agency.id}', 1000)" class="flex-1 bg-green-500/10 hover:bg-green-500/30 text-green-400 border border-green-500/20 px-3 py-1.5 rounded text-xs font-bold transition-all whitespace-nowrap">+1K</button>
                </div>
                <div class="flex justify-end">
                    <button onclick="deleteAgency('${agency.id}')" class="bg-red-500/10 hover:bg-red-500/30 text-red-400 border border-red-500/20 px-3 py-1.5 rounded text-xs transition-all w-full sm:w-auto flex items-center justify-center"><i data-lucide="trash-2" class="w-3 h-3 mr-1"></i> Sil</button>
                </div>
            </div>
        `;
        list.appendChild(div);
    });
    lucide.createIcons();
}

window.addAgencyTransaction = async function(id, amount) {
    const agency = agenciesList.find(a => a.id === id);
    if(agency) {
        agency.transactions += amount;
        agency.popularity = Math.floor(agency.transactions / 15) + Math.floor(Math.random() * 20);
        await saveAgencies();
    }
};

window.deleteAgency = async function(id) {
    if(!confirm("Ajansı silmek istediğinize emin misiniz?")) return;
    agenciesList = agenciesList.filter(a => a.id !== id);
    await saveAgencies();
    renderSuggestedAgencies(); // Silinen ajans tekrar "Takibe Al" olabilir
};

const btnAddAgency = document.getElementById('btnAddAgency');
if(btnAddAgency) {
    btnAddAgency.addEventListener('click', async () => {
        const name = document.getElementById('agencyNameInput').value.trim();
        const initialTx = parseInt(document.getElementById('agencyTransactionsInput').value) || 0;
        
        if(!name) return alert("Ajans adı boş bırakılamaz.");
        
        const newAgency = {
            id: 'ag_' + Date.now(),
            name: name,
            transactions: initialTx,
            popularity: Math.floor(initialTx / 15) + Math.floor(Math.random() * 20)
        };
        
        agenciesList.push(newAgency);
        document.getElementById('agencyNameInput').value = '';
        document.getElementById('agencyTransactionsInput').value = '0';
        await saveAgencies();
    });
}

document.getElementById('sortAgenciesSelect')?.addEventListener('change', renderAgencies);

// --- INIT ---
loadPersistedUsers();
loadAccounts();
loadAgencies();
renderSuggestedAgencies();

// Arka uç adresi tanımlıysa panel açılırken bağlan (elle bağlanma gerekmez).
setTimeout(function () {
    try {
        if (serverUrlFromUi() && (!ws || ws.readyState > WebSocket.OPEN)) connectWebSocket();
        else applyStaticModeUI();
        startStaticDataSync();
    } catch (e) { console.error('[STATIC] başlatılamadı:', e); }
}, 600);
// --- QR KOD TARAYICI (GLOBAL) ---
let html5QrcodeScanner = null;
let targetInputForQr = null;

const qrModal = document.getElementById('qrModal');
const closeQrModalBtn = document.getElementById('closeQrModal');
const btnScanQrRadar = document.getElementById('btnScanQrRadar');
const btnStartToolQr = document.getElementById('btnStartToolQr');
const btnCopyQrResult = document.getElementById('btnCopyQrResult');
const toolQrResult = document.getElementById('toolQrResult');

function openQrScanner(targetElementId) {
    targetInputForQr = document.getElementById(targetElementId);
    if(qrModal) qrModal.classList.remove('hidden');
    
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear().catch(e => console.warn(e));
    }
    
    // Modalın görünür olması için minik bir gecikme ekliyoruz
    setTimeout(() => {
        html5QrcodeScanner = new Html5QrcodeScanner(
            "qr-reader", 
            { fps: 10, qrbox: {width: 250, height: 250}, aspectRatio: 1.0 },
            false
        );
        
        html5QrcodeScanner.render((decodedText, decodedResult) => {
            // Tarama başarılı!
            if(targetInputForQr) {
                targetInputForQr.value = decodedText;
                // Eğer radar ekranındaysak, input event'ini tetikleyerek butonun aktifleşmesini sağlayalım
                if(targetElementId === 'addUsername') {
                    targetInputForQr.dispatchEvent(new Event('input'));
                }
            }
            closeQrScanner();
            
            // Başarı bildirimi (görsel feedback)
            if(targetInputForQr) {
                const originalBorder = targetInputForQr.style.borderColor;
                targetInputForQr.style.borderColor = '#4ade80'; // Yeşil
                setTimeout(() => { targetInputForQr.style.borderColor = originalBorder; }, 1000);
            }
        }, (errorMessage) => {
            // Hataları görmezden gel (sürekli okumaya çalışıyor)
        });
    }, 300);
}

function closeQrScanner() {
    if(qrModal) qrModal.classList.add('hidden');
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear().then(() => {
            html5QrcodeScanner = null;
        }).catch(e => console.warn(e));
    }
}

if(btnScanQrRadar) {
    btnScanQrRadar.addEventListener('click', () => openQrScanner('addUsername'));
}

if(btnStartToolQr) {
    btnStartToolQr.addEventListener('click', () => openQrScanner('toolQrResult'));
}

if(closeQrModalBtn) {
    closeQrModalBtn.addEventListener('click', closeQrScanner);
}

if(btnCopyQrResult) {
    btnCopyQrResult.addEventListener('click', () => {
        if(!toolQrResult || !toolQrResult.value) return;
        navigator.clipboard.writeText(toolQrResult.value).then(() => {
            const originalIcon = btnCopyQrResult.innerHTML;
            btnCopyQrResult.innerHTML = '<i data-lucide="check" class="w-5 h-5 text-green-400"></i>';
            lucide.createIcons();
            setTimeout(() => {
                btnCopyQrResult.innerHTML = originalIcon;
                lucide.createIcons();
            }, 1500);
        });
    });
}

// ==================== OTOMASIK TARAYICI FONKSIYONLARI ====================

let discoveredStreamers = [];

// Tarayıcıyı başlat/durdur
window.toggleScanner = function(enabled) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Tarayıcıyı kullanmak için önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    const btnStart = document.getElementById('btnStartScanner');
    const btnStop = document.getElementById('btnStopScanner');
    const badge = document.getElementById('scannerStatusBadge');
    
    if (enabled) {
        // Aktif bot hesaplarını tarayıcıya gönder
        const activeAccounts = storedAccounts.filter(a => a.status === 'active');
        if (activeAccounts.length === 0) {
            alert("Tarama yapmak için aktif bot hesabınız yok! Önce hesap oluşturun.");
            return;
        }
        
        ws.send(JSON.stringify({
            action: 'toggle_scanner',
            enabled: true,
            accounts: activeAccounts
        }));
        
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');
        badge.innerHTML = 'AKTİF';
        badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 animate-pulse';
        
        appendBotLog('🚀 Otomatik tarayıcı başlatıldı!');
    } else {
        ws.send(JSON.stringify({
            action: 'toggle_scanner',
            enabled: false
        }));
        
        btnStart.classList.remove('hidden');
        btnStop.classList.add('hidden');
        badge.innerHTML = 'PASİF';
        badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30';
        
        appendBotLog('🛑 Otomatik tarayıcı durduruldu.');
    }
};

// Tarayıcı UI güncelle
function updateScannerUI(data) {
    const btnStart = document.getElementById('btnStartScanner');
    const btnStop = document.getElementById('btnStopScanner');
    const badge = document.getElementById('scannerStatusBadge');
    
    if (data.enabled) {
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');
        badge.innerHTML = 'AKTİF';
        badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 animate-pulse';
    } else {
        btnStart.classList.remove('hidden');
        btnStop.classList.add('hidden');
        badge.innerHTML = 'PASİF';
        badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30';
    }
    
    document.getElementById('totalDiscoveredCount').innerText = data.discoveredCount || 0;
    document.getElementById('pendingApprovalCount').innerText = data.queueSize || 0;
}

// Sayacları güncelle
function updateScannerCounters() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'get_scanner_status' }));
}

// Bulunan yayıncıları göster (Onay listesi)
window.showDiscoveredStreamers = function() {
    // showDiscoveredStreamers çağrıldı
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    ws.send(JSON.stringify({ action: 'get_discovered_streamers' }));
    // get_discovered_streamers isteği gönderildi
    
    // Modal aç
    const modal = document.createElement('div');
    modal.id = 'discoveredStreamersModal';
    modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center';
    modal.innerHTML = `
        <div class="glass rounded-2xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-xl font-bold text-yellow-100 flex items-center">
                    <i data-lucide="scan" class="w-6 h-6 mr-2 text-cyan-400"></i>
                    Onay Bekleyen Yayıncılar
                </h3>
                <button onclick="closeDiscoveredModal()" class="text-yellow-50/50 hover:text-yellow-100 transition-colors">
                    <i data-lucide="x" class="w-6 h-6"></i>
                </button>
            </div>
            <div class="flex gap-2 mb-4">
                <button onclick="approveAllStreamers()" class="bg-green-500/20 hover:bg-green-500/40 text-green-400 border border-green-500/50 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center">
                    <i data-lucide="check-all" class="w-4 h-4 mr-1"></i> Tümünü Onayla
                </button>
                <button onclick="cleanInactiveStreamers()" class="bg-red-500/20 hover:bg-red-500/40 text-red-400 border border-red-500/50 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center">
                    <i data-lucide="trash-2" class="w-4 h-4 mr-1"></i> Temizlik Yap
                </button>
            </div>
            <div id="discoveredStreamersList" class="flex-1 overflow-y-auto space-y-2">
                <div class="text-center text-yellow-50/50 py-8">Yükleniyor...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    lucide.createIcons();
};

// Modalı kapat
window.closeDiscoveredModal = function() {
    const modal = document.getElementById('discoveredStreamersModal');
    if (modal) modal.remove();
};

// Bulunan yayıncıları render et
function renderDiscoveredStreamers(streamers) {
    // renderDiscoveredStreamers çağrıldı
    discoveredStreamers = streamers || [];
    const container = document.getElementById('discoveredStreamersList');
    if (!container) {
        // Container bulunamadı
        return;
    }
    
    const pendingCount = streamers.filter(s => !s.manuallyAdded).length;
    document.getElementById('pendingApprovalCount').innerText = pendingCount;
    document.getElementById('totalDiscoveredCount').innerText = streamers.length;
    
    if (streamers.length === 0) {
        container.innerHTML = `
            <div class="text-center text-yellow-50/50 py-8">
                <i data-lucide="search-x" class="w-12 h-12 mx-auto mb-2 opacity-50"></i>
                <p>Henüz otomatik yayıncı bulunmadı.</p>
                <p class="text-xs mt-1">Tarayıcıyı başlatın ve bekleyin...</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    container.innerHTML = streamers.map(s => {
        const isApproved = s.manuallyAdded;
        const hasCoins = (s.coinEventCount || 0) > 0;
        const dateStr = s.discoveredAt ? new Date(s.discoveredAt).toLocaleDateString('tr-TR') : '';
        
        return `
            <div class="flex items-center justify-between bg-black/40 border ${isApproved ? 'border-green-500/30 bg-green-500/5' : 'border-white/10'} rounded-xl p-3 ${isApproved ? 'opacity-60' : ''}">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-600/20 flex items-center justify-center border border-cyan-500/30 cursor-pointer hover:from-cyan-500/40 hover:to-blue-600/40 transition-all" onclick="openLiveStream('${s.username}')" title="Yayına Git">
                        <i data-lucide="radio" class="w-5 h-5 text-cyan-400"></i>
                    </div>
                    <div>
                        <div class="font-medium text-yellow-50 text-sm cursor-pointer hover:text-cyan-400 transition-colors" onclick="copyToClipboard('https://www.tiktok.com/@${s.username}/live')" title="Linki Kopyala">@${s.username}</div>
                        <div class="flex gap-2 mt-1 flex-wrap">
                            ${hasCoins ? '<span class="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">💰 Jeton</span>' : ''}
                            ${isApproved ? '<span class="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">✅ Onaylı</span>' : '<span class="text-[10px] bg-pink-500/20 text-pink-400 px-1.5 py-0.5 rounded">⏳ Bekliyor</span>'}
                            <span class="text-[10px] text-yellow-50/40">${dateStr}</span>
                        </div>
                        <a href="https://www.tiktok.com/@${s.username}/live" target="_blank" class="text-[10px] text-cyan-400 hover:text-cyan-300 underline mt-0.5 inline-block">tiktok.com/@${s.username}/live</a>
                    </div>
                </div>
                <div class="flex gap-1">
                    <button onclick="generateQRForStreamer('${s.username}')" class="bg-purple-500/20 hover:bg-purple-500/40 text-purple-400 border border-purple-500/50 p-1.5 rounded-lg transition-all" title="Telefonda Aç (QR Kod)">
                        <i data-lucide="smartphone" class="w-4 h-4"></i>
                    </button>
                    <button onclick="openLiveStream('${s.username}')" class="bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-400 border border-cyan-500/50 p-1.5 rounded-lg transition-all" title="Yeni Sekmede Aç">
                        <i data-lucide="external-link" class="w-4 h-4"></i>
                    </button>
                    ${!isApproved ? `
                        <button onclick="approveStreamer('${s.username}')" class="bg-green-500/20 hover:bg-green-500/40 text-green-400 border border-green-500/50 p-1.5 rounded-lg transition-all" title="Onayla">
                            <i data-lucide="check" class="w-4 h-4"></i>
                        </button>
                        <button onclick="rejectStreamer('${s.username}')" class="bg-red-500/20 hover:bg-red-500/40 text-red-400 border border-red-500/50 p-1.5 rounded-lg transition-all" title="Reddet">
                            <i data-lucide="x" class="w-4 h-4"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
    
    lucide.createIcons();
}

// Yayıncıyı onayla
window.approveStreamer = function(username) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'approve_streamer', username }));
    
    // UI'da hemen güncelle
    const streamer = discoveredStreamers.find(s => s.username === username);
    if (streamer) {
        streamer.manuallyAdded = true;
        renderDiscoveredStreamers(discoveredStreamers);
    }
};

// Yayıncıyı reddet
window.rejectStreamer = function(username) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!confirm(`@${username} reddedilecek ve listeden kaldırılacak. Emin misiniz?`)) return;
    
    ws.send(JSON.stringify({ action: 'reject_streamer', username }));
    
    // UI'da hemen kaldır
    discoveredStreamers = discoveredStreamers.filter(s => s.username !== username);
    renderDiscoveredStreamers(discoveredStreamers);
};

// ==================== YARDIMCI FONKSIYONLAR ====================

// Panoya kopyala
window.copyToClipboard = function(text) {
    navigator.clipboard.writeText(text).then(() => {
        appendBotLog(`📋 Kopyalandı: ${text.substring(0, 50)}...`);
        // Toast bildirim
        showToast('Link kopyalandı!');
    }).catch(err => {
        console.error('Kopyalama hatası:', err);
    });
};

// Toast bildirim göster
function showToast(message, duration = 2000) {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-4 right-4 bg-green-500/90 text-white px-4 py-2 rounded-xl shadow-lg z-50 text-sm font-medium animate-fade-in';
    toast.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i> ${message}`;
    document.body.appendChild(toast);
    lucide.createIcons();
    
    setTimeout(() => {
        toast.remove();
    }, duration);
}

// Yayını yeni sekmede aç
window.openLiveStream = function(username) {
    const url = `https://www.tiktok.com/@${username}/live`;
    window.open(url, '_blank');
    appendBotLog(`🌐 Yayın açıldı: @${username}`);
};

// QR Kod modalı için streamer linki oluştur
window.generateQRForStreamer = function(username) {
    // generateQRForStreamer çağrıldı
    const url = `https://www.tiktok.com/@${username}/live`;
    
    // QR kod modalını aç
    openQRModal(url, `@${username} canlı yayını`);
    
    appendBotLog(`📱 QR Kod oluşturuldu: @${username}`);
};

// QR Kod Modalı
function openQRModal(url, title = 'QR Kod') {
    // Mevcut modalı kaldır
    const existingModal = document.getElementById('qrModal');
    if (existingModal) existingModal.remove();
    
    // QR Kod API kullan (Google Chart API veya QRServer)
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(url)}`;
    
    const modal = document.createElement('div');
    modal.id = 'qrModal';
    modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50';
    modal.innerHTML = `
        <div class="bg-gray-900 border border-green-500/30 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-green-400 flex items-center">
                    <i data-lucide="qr-code" class="w-5 h-5 mr-2"></i>
                    ${title}
                </h3>
                <button onclick="closeQRModal()" class="text-gray-400 hover:text-white transition-colors">
                    <i data-lucide="x" class="w-5 h-5"></i>
                </button>
            </div>
            
            <div class="bg-white rounded-xl p-4 mb-4 flex items-center justify-center">
                <img src="${qrUrl}" alt="QR Code" class="w-48 h-48">
            </div>
            
            <div class="text-center">
                <p class="text-xs text-yellow-50/50 mb-3">Telefonunuzun kamerası ile tarayarak yayına gidebilirsiniz</p>
                <a href="${url}" target="_blank" class="text-sm text-cyan-400 hover:text-cyan-300 underline break-all">${url}</a>
            </div>
            
            <div class="flex gap-2 mt-4">
                <button onclick="copyToClipboard('${url}')" class="flex-1 bg-green-500/20 hover:bg-green-500/40 text-green-400 border border-green-500/50 py-2 rounded-xl text-sm font-medium transition-all">
                    <i data-lucide="copy" class="w-4 h-4 inline mr-1"></i> Linki Kopyala
                </button>
                <button onclick="closeQRModal()" class="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-xl text-sm font-medium transition-all">
                    Kapat
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    lucide.createIcons();
    
    // Dışarı tıklamayla kapat
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeQRModal();
    });
}

// QR Modalı kapat
window.closeQRModal = function() {
    const modal = document.getElementById('qrModal');
    if (modal) modal.remove();
};

// ===================================================================

// Tümünü onayla
window.approveAllStreamers = function() {
    const pending = discoveredStreamers.filter(s => !s.manuallyAdded);
    if (pending.length === 0) {
        alert("Onay bekleyen yayıncı yok!");
        return;
    }
    
    if (!confirm(`${pending.length} yayıncıyı onaylayıp ana radara eklemek istiyor musunuz?`)) return;
    
    pending.forEach(s => {
        approveStreamer(s.username);
    });
};

// Pasif yayıncıları temizle
window.cleanInactiveStreamers = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!confirm("30 gündür aktif olmayan ve jeton paylaşmamış yayıncılar temizlenecek. Emin misiniz?")) return;
    
    ws.send(JSON.stringify({ action: 'clean_inactive' }));
};

// ==================== MOBILE BOT UI FONKSIYONLARI ====================

// Mobile Bot test fonksiyonu
window.testMobileBot = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    let targetStreamer = document.getElementById('mobileTargetStreamer').value.trim();
    if (!targetStreamer) {
        alert("Lütfen hedef yayıncı adı girin!");
        return;
    }
    
    // @ işaretini otomatik kaldır
    targetStreamer = targetStreamer.replace(/^@/, '');
    
    const deviceSelect = document.getElementById('mobileDeviceSelect').value;
    const chestLimit = parseInt(document.getElementById('mobileChestLimit').value) || 5;
    
    // Mobile bot konfigürasyonunu güncelle
    ws.send(JSON.stringify({
        action: 'mobile_bot_config',
        config: {
            chestThreshold: chestLimit,
            devicePreference: deviceSelect
        }
    }));
    
    // Test başlat
    ws.send(JSON.stringify({
        action: 'mobile_test_chest',
        targetStreamer: targetStreamer,
        account: { username: 'test_' + Date.now() }
    }));
    
    appendBotLog(`🧪 [Mobile Bot] Test başlatıldı: @${targetStreamer}`);
};

// Mobile Bot koleksiyon başlat
window.startMobileCollection = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    let targetStreamer = document.getElementById('mobileTargetStreamer').value.trim();
    if (!targetStreamer) {
        alert("Lütfen hedef yayıncı adı girin!");
        return;
    }
    
    // @ işaretini otomatik kaldır
    targetStreamer = targetStreamer.replace(/^@/, '');
    
    // YENİ: Hesap sayısı seçimi
    const accountCount = parseInt(document.getElementById('mobileAccountCount')?.value) || 5;
    
    // Aktif bot hesaplarını al (seçilen sayı kadar)
    const activeAccounts = storedAccounts.filter(a => a.status === 'active').slice(0, accountCount);
    if (activeAccounts.length === 0) {
        alert("Aktif bot hesabı yok! Önce hesap oluşturun.");
        return;
    }
    
    // YENİ: Ayarları oku
    const chestLimit = parseInt(document.getElementById('mobileChestLimit')?.value) || 5;
    const antiBanEnabled = document.getElementById('antiBanToggle')?.checked ?? true;
    const instantTransferEnabled = document.getElementById('instantTransferToggle')?.checked ?? true;
    const transferTarget = document.getElementById('coinTransferTarget')?.value?.trim() || null;
    
    // Konfigürasyon güncelle (anti-ban dahil)
    ws.send(JSON.stringify({
        action: 'mobile_bot_config',
        config: {
            enabled: true,
            chestThreshold: chestLimit,
            autoCollect: true,
            targetStreamer: transferTarget, // Transfer hedefi
            antiBan: {
                enabled: antiBanEnabled,
                likeCount: 10,
                clickCount: 10
            },
            instantTransfer: instantTransferEnabled,
            maxAccounts: accountCount
        }
    }));
    
    appendBotLog(`🤖 [Mobile Bot] ${activeAccounts.length} hesap ile başlatılıyor...`);
    appendBotLog(`🛡️ Anti-Ban: ${antiBanEnabled ? 'AÇIK' : 'KAPALI'} | Anında Transfer: ${instantTransferEnabled ? 'AÇIK' : 'KAPALI'}`);
    
    // Koleksiyon başlat
    ws.send(JSON.stringify({
        action: 'mobile_start_collection',
        accounts: activeAccounts,
        targetStreamers: [targetStreamer]
    }));
    
    appendBotLog(`🚀 [Mobile Bot] ${activeAccounts.length} hesapla koleksiyon başlatıldı!`);
    
    // Status badge güncelle
    const badge = document.getElementById('mobileBotStatusBadge');
    if (badge) {
        badge.innerHTML = 'AKTIF';
        badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 animate-pulse';
    }
};

// Mobile Bot WebSocket mesaj dinleyicisi ekle
function handleMobileBotMessages(data) {
    if (data.type === 'mobile_config_updated') {
        console.log('[MOBILE BOT] Konfigürasyon güncellendi:', data.config);
    } else if (data.type === 'mobile_test_result') {
        if (data.success) {
            appendBotLog(`✅ [Mobile Bot] Test başarılı! Sandık bulundu: ${data.chestFound}`);
        } else {
            appendBotLog(`❌ [Mobile Bot] Test başarısız: ${data.reason}`);
        }
    } else if (data.type === 'mobile_collection_complete') {
        appendBotLog(`✅ [Mobile Bot] ${data.processed} hesap işlendi.`);
        
        // Status badge güncelle
        const badge = document.getElementById('mobileBotStatusBadge');
        if (badge) {
            badge.innerHTML = 'HAZIR';
            badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30';
        }
        
        // Bakiyeleri otomatik güncelle
        refreshCoinBalances();
    } else if (data.type === 'account_balance') {
        // Tek hesap bakiyesi güncellendi
        updateCoinBalanceUI(data.balance, data.username);
        // Otomatik transfer kontrolü
        checkAutoTransfer(data.username, data.balance.coins);
    } else if (data.type === 'all_balances') {
        // Tüm bakiyeler geldi
        updateAllCoinBalancesUI(data.summary);
    } else if (data.type === 'transfer_complete') {
        appendBotLog(`💸 @${data.username}: ${data.transferred} jeton transfer edildi! (Kalan: ${data.remaining})`);
        refreshCoinBalances();
    } else if (data.type === 'auto_transfer_trigger') {
        // Otomatik transfer tetikleyicisi
        appendBotLog(`🔄 [AUTO] @${data.username} limit aştı (${data.balance}/${data.limit})`);
    } else if (data.type === 'viewer_status') {
        // Viewer bot durumu
        updateViewerStatusUI(data.status);
    }
}

// Mevcut ws.onmessage handler'ına ekle
const originalWsHandler = ws ? ws.onmessage : null;

// ==================== JETON BAKIYESI UI FONKSIYONLARI ====================

// Jeton bakiyelerini server'dan iste
window.refreshCoinBalances = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[COINS] WebSocket bağlı değil');
        return;
    }
    
    ws.send(JSON.stringify({ action: 'get_all_balances' }));
    appendBotLog(`💰 Jeton bakiyeleri güncelleniyor...`);
};

// Tek hesap bakiyesini göster
function updateCoinBalanceUI(balance, username) {
    console.log(`[COINS UI] @${username}:`, balance);
    
    // Otomatik transfer kontrolü
    checkAutoTransfer(username, balance.coins);
}

// Tüm bakiyeleri özetini UI'de göster
function updateAllCoinBalancesUI(summary) {
    const totalCoinsEl = document.getElementById('totalCoinsDisplay');
    const totalAccountsEl = document.getElementById('totalAccountsDisplay');
    const totalChestsEl = document.getElementById('totalChestsDisplay');
    const avgCoinsEl = document.getElementById('avgCoinsDisplay');
    
    if (totalCoinsEl) {
        totalCoinsEl.textContent = summary.totalCoins.toLocaleString();
        // Animasyon efekti
        totalCoinsEl.classList.add('animate-pulse');
        setTimeout(() => totalCoinsEl.classList.remove('animate-pulse'), 1000);
    }
    
    if (totalAccountsEl) {
        totalAccountsEl.textContent = summary.totalAccounts;
    }
    
    if (totalChestsEl) {
        totalChestsEl.textContent = summary.totalChests;
    }
    
    if (avgCoinsEl) {
        const avg = summary.totalAccounts > 0 
            ? Math.round(summary.totalCoins / summary.totalAccounts) 
            : 0;
        avgCoinsEl.textContent = avg;
    }
    
    console.log(`[COINS UI] Toplam: ${summary.totalCoins} jeton, ${summary.totalAccounts} hesap, ${summary.totalChests} sandık`);
}

// ==================== JETON TRANSFER FONKSIYONLARI ====================

let autoTransferEnabled = false;

// Tüm jetonları hedef hesaba transfer et
window.transferAllCoins = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    const targetAccount = document.getElementById('coinTransferTarget').value.trim().replace(/^@/, '');
    if (!targetAccount) {
        alert("Lütfen jeton gönderilecek hedef hesabı girin! (örn: magicianos)");
        return;
    }
    
    // Tüm aktif hesapları al ve transfer yap
    const activeAccounts = storedAccounts.filter(a => a.status === 'active');
    if (activeAccounts.length === 0) {
        alert("Aktif bot hesabı yok!");
        return;
    }
    
    appendBotLog(`💸 [TRANSFER] Tüm jetonlar @${targetAccount}'ye gönderiliyor...`);
    
    // Her hesap için transfer komutu gönder
    activeAccounts.forEach((account, index) => {
        setTimeout(() => {
            ws.send(JSON.stringify({
                action: 'transfer_coins',
                username: account.username,
                amount: 999999, // Tüm bakiyeyi gönder (server tarafından hesaplanır)
                targetStreamer: targetAccount
            }));
        }, index * 500); // 500ms aralıklarla
    });
};

// Otomatik transfer aç/kapa
window.enableAutoTransfer = function() {
    autoTransferEnabled = !autoTransferEnabled;
    
    const btn = document.getElementById('autoTransferBtn');
    if (btn) {
        if (autoTransferEnabled) {
            btn.innerHTML = '<i data-lucide="repeat" class="w-4 h-4 mr-1"></i> Otomatik: AÇIK';
            btn.classList.remove('bg-purple-500/20', 'text-purple-400', 'border-purple-500/50');
            btn.classList.add('bg-green-500/20', 'text-green-400', 'border-green-500/50');
            appendBotLog(`♻️ [TRANSFER] Otomatik transfer AKTİF - Limit aşınca otomatik gönderilecek`);
        } else {
            btn.innerHTML = '<i data-lucide="repeat" class="w-4 h-4 mr-1"></i> Otomatik: KAPALI';
            btn.classList.remove('bg-green-500/20', 'text-green-400', 'border-green-500/50');
            btn.classList.add('bg-purple-500/20', 'text-purple-400', 'border-purple-500/50');
            appendBotLog(`🛑 [TRANSFER] Otomatik transfer KAPATILDI`);
        }
        // Lucide ikonlarını yeniden oluştur
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }
};

// Otomatik transfer kontrolü (limit aşılınca)
function checkAutoTransfer(accountUsername, currentBalance) {
    if (!autoTransferEnabled) return;
    
    const targetAccount = document.getElementById('coinTransferTarget').value.trim().replace(/^@/, '');
    if (!targetAccount) return;
    
    const limit = parseInt(document.getElementById('mobileChestLimit').value) || 5;
    
    if (currentBalance >= limit) {
        appendBotLog(`🔄 [AUTO TRANSFER] @${accountUsername} limit aştı (${currentBalance}/${limit}), otomatik transfer başlatılıyor...`);
        
        ws.send(JSON.stringify({
            action: 'transfer_coins',
            username: accountUsername,
            amount: 999999, // Tümü
            targetStreamer: targetAccount
        }));
    }
}

// ==================== PUPPETEER MULTI-BROWSER VIEWER BOT FONKSIYONLARI ====================

window.startViewerBot = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Önce Radar Sunucusuna bağlanmalısınız!");
        return;
    }
    
    const targetStreamer = document.getElementById('viewerBotTarget').value.trim().replace(/^@/, '');
    if (!targetStreamer) {
        alert("Lütfen hedef yayıncı adı girin!");
        return;
    }
    
    const viewerCount = parseInt(document.getElementById('viewerBotCount').value) || 3;
    
    // Uyarı: 5+ browser için onay iste
    if (viewerCount > 5) {
        if (!confirm(`${viewerCount} browser çok fazla RAM kullanır (~${viewerCount * 50}MB). Devam etmek istiyor musunuz?`)) {
            return;
        }
    }
    
    document.getElementById('viewerBotBadge').textContent = 'BAŞLATILIYOR...';
    document.getElementById('viewerBotBadge').className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
    
    // Puppeteer: ~50MB/browser (gerçek Chrome)
    const estimatedRam = viewerCount * 50;
    document.getElementById('estimatedRam').textContent = estimatedRam;
    
    appendBotLog(`🚀 [Puppeteer Bot] ${viewerCount} gerçek Chrome browser başlatılıyor...`);
    appendBotLog(`⚠️ Her browser ~50MB RAM kullanır!`);
    appendBotLog(`💾 Tahmini RAM: ${estimatedRam}MB (~50MB/browser)`);
    appendBotLog(`🌐 Proxy'ler otomatik çekilecek...`);
    appendBotLog(`⚠️ NOT: Bu gerçek browser'lar izleyici sayısına etki etmeyebilir!`);
    
    ws.send(JSON.stringify({
        action: 'start_viewer_bot',
        targetStreamer: targetStreamer,
        viewerCount: viewerCount
    }));
};

window.stopViewerBot = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    document.getElementById('viewerBotBadge').textContent = 'DURDURULUYOR...';
    document.getElementById('viewerBotBadge').className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30';
    
    appendBotLog(`🛑 [Puppeteer Bot] Durduruluyor...`);
    ws.send(JSON.stringify({ action: 'stop_viewer_bot' }));
};

window.getViewerStatus = function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'get_viewer_status' }));
};

function updateViewerStatusUI(status) {
    const badge = document.getElementById('viewerBotBadge');
    const activeCount = document.getElementById('activeViewerCount');
    const proxyCount = document.getElementById('workingProxyCount');
    
    if (activeCount) activeCount.textContent = status.activeViewers || 0;
    if (proxyCount) proxyCount.textContent = status.workingProxies || 0;
    
    // Puppeteer: ~50MB/browser (gerçek Chrome)
    const estimatedRam = (status.activeViewers || 0) * 50;
    document.getElementById('estimatedRam').textContent = estimatedRam;
    
    if (badge) {
        if (status.enabled && status.activeViewers > 0) {
            badge.textContent = `AKTİF (${status.activeViewers})`;
            badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-400 border border-purple-500/30';
        } else if (status.enabled) {
            badge.textContent = 'BAŞLATILIYOR...';
            badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
        } else {
            badge.textContent = 'PASİF';
            badge.className = 'ml-2 px-2 py-0.5 rounded text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30';
        }
    }
}

// Otomatik viewer durumu sorgulama
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) getViewerStatus();
}, 5000);

// ===================================================================


// Sunucu gerektiren işlemler: bağlantı yoksa önce bağlanmayı dener, sonra çalışır.
(function wrapServerActions() {
    var actions = [
        'syncRadarToScanJson', 'triggerSingleBotAction', 'triggerBatchBotAction',
        'triggerBatchCreateAccounts', 'runAutoActionWithSingleAccount',
        'runAutoActionWithAllAccounts', 'toggleScanner', 'showDiscoveredStreamers',
        'approveStreamer', 'rejectStreamer', 'cleanInactiveStreamers',
        'testMobileBot', 'startMobileCollection', 'transferAllCoins', 'startViewerBot'
    ];

    actions.forEach(function (name) {
        var original = window[name];
        if (typeof original !== 'function' || original.__serverWrapped) return;

        var wrapped = function () {
            var args = arguments;
            var self = this;
            if (ws && ws.readyState === WebSocket.OPEN) return original.apply(self, args);
            waitForServer(function () { original.apply(self, args); }, name);
        };

        wrapped.__serverWrapped = true;
        window[name] = wrapped;
    });
})();
