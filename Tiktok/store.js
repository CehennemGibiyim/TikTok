'use strict';
/*
 * store.js — Sunucu tarafı kalıcı depo.
 *
 * Tarayıcı verisi silinse bile hesaplar, ajanslar, hedef yayıncılar ve
 * jeton olayları burada (data/store.json) durur.
 * İlk çalıştırmada eski data/accounts.json, agencies.json, users.json
 * dosyaları varsa otomatik olarak buraya taşınır.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function emptyState() {
    return {
        version: 1,
        accounts: [],
        agencies: [],
        users: [],
        huntTargets: [],
        huntRegions: {},
        huntSessions: {},
        huntEvents: [],
        updatedAt: null
    };
}

let state = emptyState();
let saveTimer = null;

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonIfExists(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.warn('[STORE] Okunamadi:', path.basename(file), e.message);
        return null;
    }
}

function load() {
    ensureDir();

    const saved = readJsonIfExists(STORE_FILE);
    if (saved && typeof saved === 'object') {
        state = Object.assign(emptyState(), saved);
    } else {
        // Eski dosyalardan tek seferlik göç
        const accounts = readJsonIfExists(path.join(DATA_DIR, 'accounts.json'));
        const agencies = readJsonIfExists(path.join(DATA_DIR, 'agencies.json'));
        const users = readJsonIfExists(path.join(DATA_DIR, 'users.json'));
        if (Array.isArray(accounts)) state.accounts = accounts;
        if (Array.isArray(agencies)) state.agencies = agencies;
        if (Array.isArray(users)) state.users = users;
        if (Array.isArray(accounts) || Array.isArray(agencies) || Array.isArray(users)) {
            console.log('[STORE] Eski veri dosyalari store.json icine tasindi.');
            saveNow();
        }
    }

    // Tip guvenligi
    ['accounts', 'agencies', 'users', 'huntTargets', 'huntEvents'].forEach(function (key) {
        if (!Array.isArray(state[key])) state[key] = [];
    });
    ['huntRegions', 'huntSessions'].forEach(function (key) {
        if (!state[key] || typeof state[key] !== 'object') state[key] = {};
    });

    return state;
}

function get() {
    return state;
}

function patch(changes) {
    Object.assign(state, changes);
    state.updatedAt = new Date().toISOString();
    scheduleSave();
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
        saveTimer = null;
        saveNow();
    }, 500);
}

function saveNow() {
    try {
        ensureDir();
        const tmp = STORE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, STORE_FILE);
    } catch (e) {
        console.error('[STORE] Yazilamadi:', e.message);
    }
}

function flush() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveNow();
}

module.exports = {
    load: load,
    get: get,
    patch: patch,
    flush: flush,
    STORE_FILE: STORE_FILE,
    DATA_DIR: DATA_DIR
};
