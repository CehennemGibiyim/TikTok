#!/usr/bin/env node
// Uçtan uca doğrulama: örnek NDJSON → /ingest → boxes.json.
// Gerçek TikTok trafiği gerekmez; örnek kayıtlar `sample-capture.ndjson` içinde.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
const PORT = 8900 + Math.floor(Math.random() * 90);
const TOKEN = 'test-token-' + 'a'.repeat(24);
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(ROOT, 'tools/ingest/sample-capture.ndjson');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['OK  ', name]);
  } catch (error) {
    results.push(['FAIL', name + ' — ' + error.message]);
    process.exitCode = 1;
  }
};

const server = spawn(process.execPath, [
  'tools/ingest/server.mjs',
  `--port=${PORT}`,
  '--host=127.0.0.1',
  `--data-dir=${TMP}`,
  '--ntfy=0'
], { env: { ...process.env, INGEST_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });

const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch { /* henüz açılmadı */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('sunucu açılmadı: ' + serverLog.join(''));
}

const post = (body, headers = {}) => fetch(BASE + '/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

try {
  const health = await waitForServer();
  check('sunucu açıldı ve /health yanıt verdi', () => assert.equal(health.ok, true));

  const noKey = await post({ username: 'ornek_yayinci', businessType: 20 });
  check('anahtarsız istek 401 döner', () => assert.equal(noKey.status, 401));

  const garbage = await post('bu json değil', { 'x-ingest-key': TOKEN });
  check('bozuk gövde 400 döner', () => assert.equal(garbage.status, 400));

  const sender = spawnSync(process.execPath, [
    'tools/ingest/send.mjs',
    `--file=${FIXTURE}`,
    `--url=${BASE}/ingest`
  ], { cwd: ROOT, env: { ...process.env, INGEST_TOKEN: TOKEN }, encoding: 'utf8' });

  check('send.mjs örnek kayıtları gönderdi (çıkış 0)', () => assert.equal(sender.status, 0, sender.stdout + sender.stderr));
  check('yinelenen kayıt uçta yakalandı', () => assert.match(sender.stdout, /zaten var/));
  check('3 kabul + 1 yinelenen yazıldı', () => assert.match(sender.stdout, /kabul: 3 · yinelenen: 1 · hatalı: 0/));

  const boxes = JSON.parse(fs.readFileSync(path.join(TMP, 'boxes.json'), 'utf8')).boxes;
  check('boxes.json 3 kutu içeriyor (yinelenen yazılmadı)', () => assert.equal(boxes.length, 3));
  check('en yeni kutu başta', () => assert.equal(boxes[0].id, 'ornek-3'));
  check('chest/portal/zarf türleri korunmuş', () => {
    const kinds = boxes.map((box) => box.kind).sort();
    assert.deepEqual(kinds, ['chest', 'letter', 'portal']);
  });
  check('jeton değerleri kayıpla aynı', () => {
    const chest = boxes.find((box) => box.id === 'ornek-1');
    assert.equal(chest.coins, 51);
    assert.equal(chest.username, 'ornek_yayinci');
    assert.equal(chest.businessType, 20);
  });
  check('açılış penceresi hesaplanmış', () => {
    const chest = boxes.find((box) => box.id === 'ornek-1');
    assert.equal(chest.hasWindow, true);
    assert.ok(chest.unpackAt > Date.now());
  });

  const after = await (await fetch(BASE + '/health')).json();
  check('/health sayaçları doğru', () => {
    assert.equal(after.stats.accepted, 3);
    assert.equal(after.stats.duplicate, 1);
  });
} catch (error) {
  results.push(['FAIL', 'test çalıştırılamadı — ' + error.message]);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(TMP, { recursive: true, force: true });
}

for (const [status, name] of results) console.log(status, name);
const failed = results.filter(([status]) => status === 'FAIL').length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' kontrol geçti');
process.exit(process.exitCode || 0);
