#!/usr/bin/env node
// Yakalanan kutu satırlarını (NDJSON: her satır bir JSON) /ingest ucuna gönderir.
// Emülatör/cihaz yakalamasını bir dosyaya ya da doğrudan boruya (pipe) yazıp
// bu betiği çalıştırabilirsin:
//
//   INGEST_TOKEN=... node tools/ingest/send.mjs --file=capture.ndjson
//   adb logcat -s TikTokBox | node tools/ingest/send.mjs
//
// Örnek satır (uygulamadan gelen ham mesaj da olur):
//   {"username":"ornek","event":"envelope","envelopeInfo":{"businessType":20,"diamondCount":51,"envelopeId":"abc","secondsUntilOpen":60}}
import fs from 'node:fs';
import readline from 'node:readline';

const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : '1'];
}));
const arg = (name, fallback) => (args.has(name) ? args.get(name) : fallback);

const URL_ = arg('url', 'http://127.0.0.1:8788/ingest');
const KEY = process.env.INGEST_TOKEN || arg('key', '');
const FILE = arg('file', '-');
const DELAY_MS = Number(arg('delay', 0)) || 0;

if (!KEY) {
  console.error('INGEST_TOKEN (ya da --key=...) gerekli.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendOne(line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return { ok: false, note: 'JSON değil' };
  }
  try {
    const response = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, note: body.error || ('HTTP ' + response.status) };
    if (body.duplicate) return { ok: true, duplicate: true, note: 'zaten var' };
    return { ok: true, note: body.kind + ' @' + ((payload.username || (payload.envelopeInfo || {}).username) || '?') };
  } catch (error) {
    return { ok: false, note: 'bağlantı hatası: ' + error.message };
  }
}

let accepted = 0;
let duplicated = 0;
let failed = 0;

async function handleLine(raw) {
  const line = String(raw || '').trim();
  if (!line) return;
  const result = await sendOne(line);
  if (!result.ok) failed += 1;
  else if (result.duplicate) duplicated += 1;
  else accepted += 1;
  console.log((result.ok ? 'OK   ' : 'HATA ') + result.note);
  if (DELAY_MS > 0) await sleep(DELAY_MS);
}

if (FILE === '-') {
  // adb logcat gibi canlı boru: satır geldikçe gönder, EOF bekleme.
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) await handleLine(line);
} else {
  const text = fs.readFileSync(FILE, 'utf8');
  for (const line of text.split('\n')) await handleLine(line);
}

console.log('kabul: ' + accepted + ' · yinelenen: ' + duplicated + ' · hatalı: ' + failed);
process.exitCode = failed > 0 ? 1 : 0;
