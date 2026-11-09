'use strict';
/*
 * radar.js — Çoklu yayın jeton radarı (sandık / zarf-mektup / portal).
 *
 * Aynı anda birden fazla yayıncıya bağlanır, TikTok'un canlı jeton
 * olaylarını yakalar ve şu bilgileri çıkarır:
 *   - tür: sandık (chest), zarf/mektup (letter), portal
 *   - paylaşılan jeton (coins)
 *   - açılma süresi (canOpen) ve gerçek zaman damgası
 *   - yayıncının ülkesi
 *   - oturum süresi ve yayıncı bazlı toplamlar
 *
 * Davranış kuralları:
 *   - Sandık: süresi dolsa da kaybolmaz, "Fırsatlar" listesinde bekler.
 *   - Zarf/mektup: süresi dolunca jeton yayıncıya döner; listeden düşer.
 *   - 1 jeton bile beklemede olsa fırsat sayılır.
 *
 * Veriler store.json içinde tutulur; panel kapansa da kaybolmaz.
 */

const { WebcastPushConnection } = require('tiktok-live-connector');
const axios = require('axios');

const MAX_TARGETS = Number(process.env.RADAR_MAX_TARGETS) || 40;
const MAX_EVENTS = 3000;
const CONNECT_STAGGER_MS = Number(process.env.RADAR_STAGGER_MS) || 1500;
const ONLINE_RETRY_MS = 60 * 1000;
const ERROR_RETRY_MS = 20 * 1000;
const MAX_ERROR_RETRIES = 6;

// Zarf/mektup jetonu süre sonunda yayıncıya döner. TikTok'un kendi süresi
// bildirilmediğinde bu varsayılan kullanılır (saniye).
const LETTER_TTL_SEC = Number(process.env.RADAR_LETTER_TTL) || 180;

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function cleanUsername(value) {
    return String(value || '')
        .trim()
        .replace(/^@/, '')
        .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
        .split(/[/?#]/)[0]
        .toLowerCase();
}

/*
 * Olay türünü ayırır.
 * tiktok-live-connector "envelope" olayı hem sandık hem zarf verisiyle gelebilir.
 * Ayırt edici alanlar varsa onlara bakar, yoksa sandık kabul eder
 * (WebcastEnvelopeMessage normalde sandık mesajıdır).
 */
function detectKind(raw, box) {
    if (box && (box.portal || box.isPortal || box.portalId || box.portal_id)) return 'portal';
    if (box && (box.envelopeInfo || box.envelope_info || box.isEnvelope || box.letter)) return 'letter';
    if (raw && (raw.envelopeInfo || raw.envelope_info || raw.isEnvelope)) return 'letter';
    if (box && (box.treasureBoxData || box.canOpen || box.can_open)) return 'chest';
    return 'chest';
}

function createRadar(options) {
    const store = options.store;
    const broadcast = options.broadcast || function () { };
    const log = options.log || function () { };

    const targets = new Map();
    const live = new Map();
    const queue = [];
    let pumping = false;
    let stateBroadcastTimer = null;

    (store.get().huntTargets || []).forEach(function (target) {
        if (!target) return;
        const username = cleanUsername(target.username || target);
        if (!username) return;
        targets.set(username, {
            username: username,
            country: String(target.country || '').toUpperCase(),
            addedAt: target.addedAt || new Date().toISOString()
        });
    });

    function emptyTotals() {
        return { coins: 0, events: 0, chests: 0, letters: 0, portals: 0, collected: 0 };
    }

    function sessionFor(username) {
        const sessions = store.get().huntSessions || {};
        const existing = sessions[username];
        if (existing) {
            const totals = Object.assign(emptyTotals(), existing.totals || {});
            existing.totals = totals;
            return existing;
        }
        return {
            username: username,
            status: 'idle',
            region: '',
            title: '',
            viewerCount: 0,
            startedAt: null,
            firstSeenAt: null,
            lastEventAt: null,
            error: null,
            totals: emptyTotals()
        };
    }

    function patchSession(username, changes) {
        const sessions = Object.assign({}, store.get().huntSessions || {});
        sessions[username] = Object.assign(sessionFor(username), changes);
        store.patch({ huntSessions: sessions });
    }

    function persistTargets() {
        store.patch({ huntTargets: Array.from(targets.values()) });
    }

    function scheduleStateBroadcast() {
        if (stateBroadcastTimer) return;
        stateBroadcastTimer = setTimeout(function () {
            stateBroadcastTimer = null;
            broadcast({ type: 'hunt_state', state: getState(false) });
        }, 300);
    }

    async function resolveRegion(username) {
        const target = targets.get(username);
        if (target && target.country) return target.country;

        const cache = store.get().huntRegions || {};
        if (cache[username]) return cache[username];

        try {
            const response = await axios.get('https://www.tikwm.com/api/user/info', {
                params: { unique_id: username },
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokRadar/1.0)' }
            });
            const payload = response.data || {};
            const user = (payload.data && payload.data.user) || payload.data || {};
            const region = String(user.region || '').toUpperCase();
            if (region) {
                store.patch({ huntRegions: Object.assign({}, cache, { [username]: region }) });
                return region;
            }
        } catch (e) {
            // Ülke bulunamazsa boş kalır; panel "Bilinmiyor" gösterir.
        }
        return '';
    }

    function isExpired(event, now) {
        return event.kind === 'letter' && event.expiresAt && event.expiresAt <= (now || Date.now());
    }

    function handleEnvelope(username, raw) {
        const box = (raw && (raw.treasureBoxData || raw.data)) || raw || {};
        const kind = detectKind(raw, box);
        const coins = num(box.coins || box.coinCount || box.coin_amount || (raw && raw.coins));
        const canOpen = num(
            box.canOpen || box.can_open || box.delay ||
            (raw && (raw.canOpen || raw.can_open)) || 0
        );
        const rawTimestamp = num(box.timestamp || (raw && raw.timestamp));
        const receivedAt = Date.now();
        const at = rawTimestamp > 0 ? new Date(rawTimestamp * 1000) : new Date(receivedAt);
        const availableAt = receivedAt + canOpen * 1000;
        const session = sessionFor(username);
        const region = session.region || (targets.get(username) && targets.get(username).country) || '';

        const event = {
            id: username + '-' + at.getTime() + '-' + Math.random().toString(36).slice(2, 6),
            username: username,
            kind: kind,
            coins: coins,
            canOpenSec: canOpen,
            region: region,
            at: at.toISOString(),
            receivedAt: receivedAt,
            availableAt: availableAt,
            // Sandık süresi dolunca kaybolmaz; zarf/mektup jetonu geri döner.
            expiresAt: kind === 'letter' ? availableAt + LETTER_TTL_SEC * 1000 : null,
            collectedAt: null,
            collectedBy: null
        };

        const events = [event].concat(store.get().huntEvents || []).slice(0, MAX_EVENTS);
        store.patch({ huntEvents: events });

        const totals = session.totals || emptyTotals();
        totals.coins = num(totals.coins) + coins;
        totals.events = num(totals.events) + 1;
        if (kind === 'portal') totals.portals = num(totals.portals) + 1;
        else if (kind === 'letter') totals.letters = num(totals.letters) + 1;
        else totals.chests = num(totals.chests) + 1;

        patchSession(username, {
            status: 'live',
            lastEventAt: event.at,
            firstSeenAt: session.firstSeenAt || event.at,
            lastCoins: coins,
            lastCanOpenSec: canOpen,
            totals: totals
        });

        broadcast({ type: 'hunt_event', event: event });
        broadcast({
            type: 'chest',
            user: username,
            data: {
                coins: coins,
                time: at.toLocaleTimeString('tr-TR'),
                duration: canOpen || 180,
                userCount: 0,
                chestType: kind
            }
        });
        scheduleStateBroadcast();
    }

    function clearReconnect(username) {
        const entry = live.get(username);
        if (entry && entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
            entry.reconnectTimer = null;
        }
    }

    function scheduleReconnect(username, delay) {
        if (!targets.has(username)) return;
        const entry = live.get(username);
        if (!entry) return;
        clearReconnect(username);
        entry.reconnectTimer = setTimeout(function () {
            entry.reconnectTimer = null;
            if (!targets.has(username)) return;
            const current = live.get(username);
            if (current) {
                if (current.conn) {
                    try { current.conn.disconnect(); } catch (e) { /* yoksay */ }
                }
                live.delete(username);
            }
            queue.push(username);
            pump();
        }, delay);
    }

    async function connectOne(username) {
        if (live.has(username)) return;
        if (!targets.has(username)) return;

        const entry = { conn: null, status: 'connecting', startedAt: null, retries: 0, reconnectTimer: null };
        live.set(username, entry);
        patchSession(username, { status: 'connecting', error: null });
        scheduleStateBroadcast();

        const connection = new WebcastPushConnection(username, {
            processInitialData: false,
            fetchRoomInfoOnConnect: true,
            enableExtendedGiftInfo: false
        });
        entry.conn = connection;

        connection.on('envelope', function (data) {
            try { handleEnvelope(username, data); } catch (e) { console.error('[RADAR] envelope hatasi:', e.message); }
        });

        function markOffline(reason) {
            const current = live.get(username);
            if (!current) return;
            current.status = 'offline';
            patchSession(username, { status: 'offline', startedAt: null });
            broadcast({ type: 'status', user: username, status: 'error' });
            scheduleStateBroadcast();
            log('@' + username + ' yayını bitti (' + reason + '), tekrar denenecek.');
            scheduleReconnect(username, ONLINE_RETRY_MS);
        }

        connection.on('streamEnd', function () { markOffline('streamEnd'); });
        connection.on('disconnected', function () { markOffline('disconnected'); });

        try {
            const state = (await connection.connect()) || {};
            entry.status = 'live';
            entry.startedAt = Date.now();
            entry.retries = 0;

            const roomInfo = state.roomInfo || {};
            const region = await resolveRegion(username);

            patchSession(username, {
                status: 'live',
                region: region,
                title: roomInfo.title || '',
                viewerCount: num(roomInfo.user_count || roomInfo.userCount),
                startedAt: new Date(entry.startedAt).toISOString(),
                error: null
            });
            broadcast({ type: 'status', user: username, status: 'connected' });
            log('@' + username + ' dinleniyor' + (region ? ' · ' + region : ''));
            scheduleStateBroadcast();
        } catch (error) {
            const message = String((error && error.message) || error);
            const offline = /not online|offline|has ended|stream.*end|user_not_found|is not currently live/i.test(message);
            entry.status = offline ? 'offline' : 'error';
            patchSession(username, { status: entry.status, error: message, startedAt: null });
            broadcast({ type: 'status', user: username, status: 'error' });
            log('@' + username + ' bağlanamadı: ' + message);
            scheduleStateBroadcast();

            if (offline) {
                scheduleReconnect(username, ONLINE_RETRY_MS);
            } else {
                entry.retries += 1;
                if (entry.retries <= MAX_ERROR_RETRIES) {
                    scheduleReconnect(username, ERROR_RETRY_MS * Math.min(entry.retries, 4));
                }
            }
        }
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        while (queue.length > 0) {
            const username = queue.shift();
            if (!username || !targets.has(username)) continue;
            await connectOne(username);
            await sleep(CONNECT_STAGGER_MS);
        }
        pumping = false;
    }

    function add(username, country) {
        const clean = cleanUsername(username);
        if (!clean) return { ok: false, error: 'Kullanıcı adı boş.' };
        if (targets.has(clean)) return { ok: false, error: '@' + clean + ' zaten listede.' };
        if (targets.size >= MAX_TARGETS) {
            return { ok: false, error: 'Aynı anda en fazla ' + MAX_TARGETS + ' yayın dinlenebilir.' };
        }

        targets.set(clean, {
            username: clean,
            country: String(country || '').toUpperCase(),
            addedAt: new Date().toISOString()
        });
        persistTargets();
        patchSession(clean, { status: 'queued' });
        queue.push(clean);
        pump();
        scheduleStateBroadcast();
        log('@' + clean + ' kuyruğa eklendi.');
        return { ok: true, username: clean };
    }

    function addMany(list) {
        const results = [];
        (Array.isArray(list) ? list : []).forEach(function (item) {
            results.push(add(item && item.username ? item.username : item, item && item.country));
        });
        return results;
    }

    function remove(username) {
        const clean = cleanUsername(username);
        if (!targets.has(clean)) return { ok: false, error: 'Listede yok.' };

        targets.delete(clean);
        persistTargets();
        clearReconnect(clean);

        const entry = live.get(clean);
        if (entry && entry.conn) {
            try { entry.conn.disconnect(); } catch (e) { /* yoksay */ }
        }
        live.delete(clean);

        const index = queue.indexOf(clean);
        if (index >= 0) queue.splice(index, 1);

        patchSession(clean, { status: 'stopped', startedAt: null });
        scheduleStateBroadcast();
        return { ok: true };
    }

    function setTargets(list) {
        const wanted = new Map();
        (Array.isArray(list) ? list : []).forEach(function (item) {
            const username = cleanUsername(item && item.username ? item.username : item);
            if (!username) return;
            wanted.set(username, String((item && item.country) || '').toUpperCase());
        });

        Array.from(targets.keys()).forEach(function (username) {
            if (!wanted.has(username)) remove(username);
        });
        wanted.forEach(function (country, username) {
            if (!targets.has(username)) add(username, country);
        });

        return getState(false);
    }

    function disconnectAll() {
        Array.from(targets.keys()).forEach(remove);
        targets.clear();
        persistTargets();
        scheduleStateBroadcast();
    }

    /** Bir fırsatı "toplandı" ya da "kaçırıldı" olarak işaretler. */
    function markCollected(id, mode) {
        const events = store.get().huntEvents || [];
        const index = events.findIndex(function (event) { return event.id === id; });
        if (index < 0) return { ok: false, error: 'Olay bulunamadı.' };
        if (events[index].collectedAt) return { ok: true, event: events[index] };

        const updated = events.slice();
        updated[index] = Object.assign({}, events[index], {
            collectedAt: Date.now(),
            collectedBy: mode === 'dismissed' ? 'dismissed' : 'manual'
        });
        store.patch({ huntEvents: updated });

        const username = updated[index].username;
        const session = sessionFor(username);
        session.totals.collected = num(session.totals.collected) + (mode === 'dismissed' ? 0 : num(updated[index].coins));
        patchSession(username, { totals: session.totals });

        broadcast({ type: 'hunt_event_update', event: updated[index] });
        scheduleStateBroadcast();
        return { ok: true, event: updated[index] };
    }

    function clearEvents() {
        store.patch({ huntEvents: [], huntSessions: {} });
        broadcast({ type: 'hunt_events', events: [] });
        broadcast({ type: 'hunt_state', state: getState(false) });
        return { ok: true };
    }

    function getEvents(limit, includeAll) {
        const now = Date.now();
        return (store.get().huntEvents || [])
            .filter(function (event) {
                if (includeAll) return true;
                return !event.collectedAt && !isExpired(event, now);
            })
            .slice(0, limit || 300);
    }

    /** Bekleyen jetonlar: sandık (süresi dolmuş olsa da), süresi geçmemiş zarf, portal. */
    function getPending() {
        const now = Date.now();
        return (store.get().huntEvents || [])
            .filter(function (event) {
                if (event.collectedAt) return false;
                if (num(event.coins) < 1) return false;
                if (isExpired(event, now)) return false;
                return true;
            })
            .sort(function (a, b) {
                const aLetter = a.kind === 'letter';
                const bLetter = b.kind === 'letter';
                if (aLetter !== bLetter) return aLetter ? -1 : 1;
                if (aLetter) return (a.expiresAt || 0) - (b.expiresAt || 0);
                return num(b.coins) - num(a.coins);
            })
            .slice(0, 200);
    }

    function getState(includeEvents) {
        const sessions = store.get().huntSessions || {};
        const pending = getPending();
        const state = {
            targets: Array.from(targets.values()),
            sessions: sessions,
            pendingCount: pending.length,
            pendingCoins: pending.reduce(function (sum, event) { return sum + num(event.coins); }, 0),
            limits: { maxTargets: MAX_TARGETS, letterTtlSec: LETTER_TTL_SEC },
            serverTime: Date.now()
        };
        if (includeEvents) {
            state.events = getEvents(300, true);
            state.pending = pending;
        }
        return state;
    }

    return {
        add: add,
        addMany: addMany,
        remove: remove,
        setTargets: setTargets,
        disconnectAll: disconnectAll,
        clearEvents: clearEvents,
        markCollected: markCollected,
        getEvents: getEvents,
        getPending: getPending,
        getState: getState,
        // Test/demo: gerçek yayın olmadan jeton olayı üretir
        // (yalnızca RADAR_ALLOW_SIMULATION=1 iken sunucudan çağrılır).
        simulate: function (username, payload) {
            const clean = cleanUsername(username);
            const data = payload || {};
            const country = String(data.country || data.region || '').toUpperCase();
            const kind = data.kind === 'letter' || data.kind === 'portal' ? data.kind : 'chest';
            if (country || kind) {
                patchSession(clean, { region: country || sessionFor(clean).region, status: 'live' });
            }
            if (!sessionFor(clean).startedAt) patchSession(clean, { startedAt: new Date().toISOString() });
            if (!targets.has(clean)) {
                targets.set(clean, { username: clean, country: country, addedAt: new Date().toISOString() });
                persistTargets();
            }
            const box = {
                coins: Number(data.coins) || 100,
                canOpen: Number(data.canOpen) || 30,
                timestamp: Number(data.timestamp) || Math.floor(Date.now() / 1000)
            };
            if (kind === 'letter') box.envelopeInfo = { letter: true };
            if (kind === 'portal') box.portal = true;
            handleEnvelope(clean, { treasureBoxData: box });
        }
    };
}

module.exports = { createRadar: createRadar, cleanUsername: cleanUsername };
