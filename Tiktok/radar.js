'use strict';
/*
 * radar.js — Çoklu yayın jeton radarı.
 *
 * Aynı anda birden fazla yayıncıya bağlanır, TikTok'un canlı "envelope"
 * (zarf / sandık) olaylarını yakalar ve şu bilgileri çıkarır:
 *   - paylaşılan jeton (coins)
 *   - açılma süresi (canOpen)
 *   - olay zamanı
 *   - yayıncının ülkesi (tikwm üzerinden, elle girilen ülke öncelikli)
 *   - oturum süresi ve yayıncı bazlı toplamlar
 *
 * Veriler store.json içinde tutulur; panel kapansa da kaybolmaz.
 */

const { WebcastPushConnection } = require('tiktok-live-connector');
const axios = require('axios');

const MAX_TARGETS = Number(process.env.RADAR_MAX_TARGETS) || 40;
const MAX_EVENTS = 2000;
const CONNECT_STAGGER_MS = Number(process.env.RADAR_STAGGER_MS) || 1500;
const ONLINE_RETRY_MS = 60 * 1000;      // yayında değilse tekrar dene
const ERROR_RETRY_MS = 20 * 1000;       // bağlantı hatasında
const MAX_ERROR_RETRIES = 6;

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

function createRadar(options) {
    const store = options.store;
    const broadcast = options.broadcast || function () { };
    const log = options.log || function () { };

    const targets = new Map();   // username -> { username, country, addedAt }
    const live = new Map();      // username -> { conn, status, startedAt, retries, reconnectTimer }
    const queue = [];
    let pumping = false;
    let stateBroadcastTimer = null;

    // Diskten hedefleri geri yükle
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

    function sessionFor(username) {
        const sessions = store.get().huntSessions || {};
        const existing = sessions[username];
        if (existing) {
            if (!existing.totals || typeof existing.totals !== 'object') {
                existing.totals = { coins: 0, events: 0, envelopes: 0, portals: 0 };
            }
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
            totals: { coins: 0, events: 0, envelopes: 0, portals: 0 }
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

    function handleEnvelope(username, raw) {
        const box = (raw && (raw.treasureBoxData || raw.data)) || raw || {};
        const coins = num(box.coins || box.coinCount || box.coin_amount);
        const canOpen = num(box.canOpen || box.can_open || box.delay);
        const rawTimestamp = num(box.timestamp);
        const at = rawTimestamp > 0
            ? new Date(rawTimestamp * 1000)
            : new Date();
        const isPortal = Boolean(box.portal || box.isPortal || box.portalId || box.portal_id);
        const kind = isPortal ? 'portal' : 'envelope';
        const session = sessionFor(username);

        const event = {
            id: username + '-' + at.getTime() + '-' + Math.random().toString(36).slice(2, 6),
            username: username,
            kind: kind,
            coins: coins,
            canOpenSec: canOpen,
            region: session.region || (targets.get(username) && targets.get(username).country) || '',
            at: at.toISOString(),
            receivedAt: Date.now()
        };

        const events = [event].concat(store.get().huntEvents || []).slice(0, MAX_EVENTS);
        store.patch({ huntEvents: events });

        const totals = session.totals || { coins: 0, events: 0, envelopes: 0, portals: 0 };
        patchSession(username, {
            status: 'live',
            lastEventAt: event.at,
            firstSeenAt: session.firstSeenAt || event.at,
            lastCoins: coins,
            lastCanOpenSec: canOpen,
            totals: {
                coins: num(totals.coins) + coins,
                events: num(totals.events) + 1,
                envelopes: num(totals.envelopes) + (kind === 'envelope' ? 1 : 0),
                portals: num(totals.portals) + (kind === 'portal' ? 1 : 0)
            }
        });

        broadcast({ type: 'hunt_event', event: event });
        // Eski Radar sekmesi de çalışmaya devam etsin
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

        const entry = {
            conn: null,
            status: 'connecting',
            startedAt: null,
            retries: 0,
            reconnectTimer: null
        };
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
            const message = String(error && error.message || error);
            const offline = /not online|offline|has ended|stream.*end|user_not_found|is not currently live/i.test(message);
            entry.status = offline ? 'offline' : 'error';
            patchSession(username, {
                status: entry.status,
                error: message,
                startedAt: null
            });
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

    function clearEvents() {
        store.patch({ huntEvents: [], huntSessions: {} });
        broadcast({ type: 'hunt_events', events: [] });
        return { ok: true };
    }

    function getEvents(limit) {
        return (store.get().huntEvents || []).slice(0, limit || 300);
    }

    function getState(includeEvents) {
        const sessions = store.get().huntSessions || {};
        const state = {
            targets: Array.from(targets.values()),
            sessions: sessions,
            limits: { maxTargets: MAX_TARGETS },
            serverTime: Date.now()
        };
        if (includeEvents) state.events = getEvents(300);
        return state;
    }

    return {
        add: add,
        addMany: addMany,
        remove: remove,
        setTargets: setTargets,
        disconnectAll: disconnectAll,
        clearEvents: clearEvents,
        getEvents: getEvents,
        getState: getState,
        // Test/demo: gerçek yayın olmadan zarf olayı üretir (RADAR_ALLOW_SIMULATION=1 iken sunucudan çağrılır)
        simulate: function (username, payload) {
            const clean = cleanUsername(username);
            const data = payload || {};
            const country = String(data.country || data.region || '').toUpperCase();
            if (country) patchSession(clean, { region: country, status: 'live' });
            if (!sessionFor(clean).startedAt) patchSession(clean, { startedAt: new Date().toISOString() });
            if (!targets.has(clean)) {
                targets.set(clean, { username: clean, country: country, addedAt: new Date().toISOString() });
                persistTargets();
            }
            handleEnvelope(clean, data);
        }
    };
}

module.exports = { createRadar: createRadar, cleanUsername: cleanUsername };
