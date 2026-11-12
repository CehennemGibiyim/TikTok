#!/usr/bin/env node
/*
 * Sürüm çıkarma betiği — README'deki "Yeni sürüm çıkarma" kontrol listesini
 * tek komutta yürütür.
 *
 *   node scripts/release.mjs 1.0.1 "Kısa madde" "İkinci madde"
 *   node scripts/release.mjs 1.0.1 --item="Madde" --push
 *
 * Yaptıkları:
 *   1. Sürüm numarasını desktop/package.json ve site/firsat/store.js içinde eşitler,
 *   2. CHANGE_LOG listesinin başına yeni sürümü tarih + maddelerle ekler,
 *   3. (isteğe bağlı) --bump-backup ile yedek biçimi sürümünü artırır,
 *   4. node --check + tarayıcı selftest çalıştırır,
 *   5. değişiklikleri commit'ler ve vX.Y.Z etiketini oluşturur,
 *   6. --push verilirse dalı ve etiketi gönderir (Actions paketi üretir).
 *
 * --dry-run: hiçbir dosyaya yazmaz, commit/etiket oluşturmaz; ne yapacağını yazar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_FILE = path.join(ROOT, 'site', 'firsat', 'store.js');
const DESKTOP_FILE = path.join(ROOT, 'desktop', 'package.json');
const CHECK_FILES = [
  'scanner/index.js',
  'site/firsat/app.js',
  'site/firsat/store.js',
  'desktop/main.js',
  'desktop/preload.js'
];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const positional = [];
const inlineItems = [];

argv.forEach((arg) => {
  if (arg.startsWith('--item=')) inlineItems.push(arg.slice('--item='.length));
  else if (!arg.startsWith('--')) positional.push(arg);
});

const version = positional[0];
const items = positional.slice(1).concat(inlineItems).map((item) => String(item).trim()).filter(Boolean);

const DRY = flags.has('--dry-run');
const PUSH = flags.has('--push');
const ALLOW_DIRTY = flags.has('--allow-dirty');
const BUMP_BACKUP = flags.has('--bump-backup');

function fail(message) {
  console.error('✖ ' + message);
  process.exit(1);
}

function info(message) {
  console.log('• ' + message);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit'
  });
}

function compareVersions(a, b) {
  const parse = (value) => String(value).split('.').map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

// ---------- 1) doğrulama ----------

if (!version) {
  fail('Sürüm numarası gerekli. Örnek: node scripts/release.mjs 1.0.1 "Yeni özellik"');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail('Sürüm numarası X.Y.Z biçiminde olmalı (örn. 1.0.1).');
}
if (!items.length) {
  fail('En az bir değişiklik maddesi ver: node scripts/release.mjs ' + version + ' "Kısa madde"');
}

const desktopRaw = fs.readFileSync(DESKTOP_FILE, 'utf8');
const desktopJson = JSON.parse(desktopRaw);
const currentVersion = String(desktopJson.version || '0.0.0');

if (compareVersions(version, currentVersion) <= 0) {
  fail('Yeni sürüm (' + version + ') mevcut sürümden (' + currentVersion + ') büyük olmalı.');
}

const storeRaw = fs.readFileSync(STORE_FILE, 'utf8');
const storeVersion = (storeRaw.match(/var APP_VERSION = '([^']+)'/) || [])[1];
if (storeVersion && storeVersion !== currentVersion) {
  fail('Sürümler zaten uyuşmuyor: desktop ' + currentVersion + ' · panel ' + storeVersion + '. Önce elle eşitle.');
}

if (!DRY && !ALLOW_DIRTY) {
  const status = git(['status', '--porcelain'], { quiet: true }).trim();
  if (status) {
    fail('Çalışma ağacı temiz değil. Değişiklikleri commit et ya da --allow-dirty kullan.\n' + status);
  }
}

if (!DRY) {
  let tagExists = false;
  try {
    git(['rev-parse', '--verify', 'refs/tags/v' + version], { quiet: true });
    tagExists = true;
  } catch (error) {
    tagExists = false;
  }
  if (tagExists) fail('v' + version + ' etiketi zaten var.');
}

// ---------- 2) dosyaları hazırla ----------

const today = new Date().toISOString().slice(0, 10);

const changeEntry = [
  '    {',
  "      version: '" + version + "',",
  "      date: '" + today + "',",
  '      items: [',
  items.map((item) => '        ' + JSON.stringify(item)).join(',\n'),
  '      ]',
  '    },'
].join('\n');

let nextStore = storeRaw
  .replace(/var APP_VERSION = '[^']+';/, "var APP_VERSION = '" + version + "';")
  .replace(/var CHANGE_LOG = \[\n/, 'var CHANGE_LOG = [\n' + changeEntry + '\n');

if (BUMP_BACKUP) {
  const backupVersion = Number((nextStore.match(/var BACKUP_VERSION = (\d+);/) || [])[1]) || 1;
  nextStore = nextStore.replace(/var BACKUP_VERSION = \d+;/, 'var BACKUP_VERSION = ' + (backupVersion + 1) + ';');
  info('Yedek biçimi sürümü ' + backupVersion + ' → ' + (backupVersion + 1));
}

const nextDesktop = desktopRaw.replace(/("version"\s*:\s*")[^"]+(")/, '$1' + version + '$2');

if (nextStore === storeRaw) fail('store.js içinde APP_VERSION/CHANGE_LOG bulunamadı; elle kontrol et.');

if (DRY) {
  console.log('\n--- dry-run: yazılacak değişiklikler ---');
  console.log('desktop/package.json: ' + currentVersion + ' → ' + version);
  console.log('site/firsat/store.js:');
  console.log(changeEntry);
  console.log('--- (dosyaya yazılmadı) ---\n');
} else {
  fs.writeFileSync(STORE_FILE, nextStore);
  fs.writeFileSync(DESKTOP_FILE, nextDesktop);
  info('Sürüm ' + version + ' yazıldı (desktop + panel)');
}

// ---------- 3) kontroller ----------

info('Sözdizimi kontrolü…');
CHECK_FILES.forEach((file) => {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  } catch (error) {
    fail(file + ' sözdizimi hatalı:\n' + String(error.stderr || error.message));
  }
});
info('Sözdizimi temiz (' + CHECK_FILES.length + ' dosya)');

info('Tarayıcı selftest (ağa çıkmaz)…');
try {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scanner', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { SCANNER_SELFTEST: '1' }),
    encoding: 'utf8'
  });
  const failedFrames = (output.match(/^ATLADI /gm) || []).length;
  info('Selftest bitti · atlanan çerçeve: ' + failedFrames + ' (beklenen 3: hediye, mükerrer kutu, boş zarf)');
} catch (error) {
  fail('Selftest başarısız:\n' + String(error.stdout || '') + String(error.stderr || error.message));
}

if (DRY) {
  console.log('\nDry-run tamam: hiçbir dosya, commit veya etiket değişmedi.');
  process.exit(0);
}

// ---------- 4) commit + etiket ----------

const subject = 'Sürüm v' + version;
const body = items.map((item) => '- ' + item).join('\n');
git(['add', 'site/firsat/store.js', 'desktop/package.json']);
git(['commit', '-m', subject + '\n\n' + body]);
git(['tag', '-a', 'v' + version, '-m', 'v' + version]);
info('Commit ve v' + version + ' etiketi hazır');

// ---------- 5) gönderim ----------

if (PUSH) {
  info('Dal ve etiket gönderiliyor…');
  git(['push']);
  git(['push', 'origin', 'v' + version]);
  info('Gönderildi · Actions → 🖥️ Windows Kurulum Paketi paketi üretip Releases’e yükleyecek');
} else {
  console.log('\nGöndermek için:');
  console.log('  git push && git push origin v' + version);
  console.log('Ya da tek komutta: node scripts/release.mjs ' + version + ' ' +
    items.map((item) => JSON.stringify(item)).join(' ') + ' --push');
}
