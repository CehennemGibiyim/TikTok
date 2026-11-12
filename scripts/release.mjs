#!/usr/bin/env node
/*
 * Sürüm çıkarma betiği — README'deki "Yeni sürüm çıkarma" kontrol listesini
 * tek komutta yürütür.
 *
 *   node scripts/release.mjs 1.0.1 "Kısa madde" "İkinci madde"
 *   node scripts/release.mjs 1.0.1 --item="Madde" --push
 *   node scripts/release.mjs 1.0.1 "Madde" --push --watch
 *
 * Yaptıkları:
 *   1. Sürüm numarasını desktop/package.json ve site/firsat/store.js içinde eşitler,
 *   2. CHANGE_LOG listesinin başına yeni sürümü tarih + maddelerle ekler,
 *   3. (isteğe bağlı) --bump-backup ile yedek biçimi sürümünü artırır,
 *   4. node --check + tarayıcı selftest çalıştırır,
 *   5. değişiklikleri commit'ler ve vX.Y.Z etiketini oluşturur,
 *   6. --push verilirse dalı ve etiketi gönderir (Actions paketi üretir),
 *   7. --watch verilirse paketin Actions'ta bitmesini bekleyip sonucu yazar
 *      (izleme mantığı: scripts/watch-release.mjs).
 *
 * --dry-run: hiçbir dosyaya yazmaz, commit/etiket oluşturmaz; ne yapacağını yazar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchRelease } from './watch-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_FILE = path.join(ROOT, 'site', 'firsat', 'store.js');
const DESKTOP_FILE = path.join(ROOT, 'desktop', 'package.json');
// CHANGE_LOG'daki bir sürümün maddelerini store.js kaynagindan okur.
function changeItemsFor(version) {
  const source = fs.readFileSync(STORE_FILE, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = source.match(new RegExp("version: '" + escaped + "'[\\s\\S]*?items: \\[([\\s\\S]*?)\\]"));
  if (!block) return [];
  return (block[1].match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) || []).map((literal) =>
    literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\'/g, "'")
  );
}

// GitHub sürüm notları: panel sürümü + CHANGE_LOG maddeleri + indirme bilgisi.
function buildReleaseNotes(version, entries) {
  return [
    '## Panel v' + version,
    '',
    '### Değişiklikler',
    entries.map((entry) => '- ' + entry).join('\n'),
    '',
    '**Windows kurulum:** `TikTok-Sandik-Radari-' + version + '-x64.exe` dosyasını indirip çalıştır; ' +
      'kurulu sürüm kendini otomatik günceller.',
    '**Panel:** https://cehennemgibiyim.github.io/TikTok/firsat/'
  ].join('\n');
}

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
const WATCH = flags.has('--watch');
const watchTimeoutArg = argv.find((arg) => arg.startsWith('--watch-timeout='));
const WATCH_TIMEOUT = Math.max(30, (Number(watchTimeoutArg && watchTimeoutArg.split('=')[1]) || 1200)) * 1000;
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

// Uzaktaki etiketin commit'i (yoksa boş dize).
function remoteTagSha(tag) {
  const out = git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], { quiet: true }).trim();
  return out ? out.split(/\s+/)[0] : '';
}

function currentBranch() {
  try {
    return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { quiet: true })
      .trim()
      .replace(/^[^/]+\//, '');
  } catch (error) {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).trim();
  }
}

function repoSlug() {
  // `git config --get` yazılan adresi döndürür; `remote get-url` insteadOf kurallarını uygulayıp
  // GitHub adresini yerel bir yola çevirebilir.
  let url = '';
  try {
    url = git(['config', '--get', 'remote.origin.url'], { quiet: true }).trim();
  } catch (error) {
    url = '';
  }
  if (!url) url = git(['remote', 'get-url', 'origin'], { quiet: true }).trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1].replace(/\.git$/, '') : '';
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
  if (tagExists) {
    const branch = currentBranch();
    fail('v' + version + ' etiketi yerelde zaten var. Sadece gönderim kaldıysa:\n' +
      '  git push --atomic origin HEAD:' + branch + ' refs/tags/v' + version + '\n' +
      '(Etiket push\'u workflow\'u tetikler; ayrıca “Run workflow” başlatma, yinelenen sürüm oluşur.)');
  }
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
  const headSha = git(['rev-parse', 'HEAD'], { quiet: true }).trim();
  const remoteSha = remoteTagSha('v' + version);
  const releaseUrl = repoSlug() ? 'https://github.com/' + repoSlug() + '/releases/tag/v' + version : 'Releases sayfası';

  if (remoteSha && remoteSha !== headSha) {
    fail('Uzakta v' + version + ' etiketi başka bir commit\'e (' + remoteSha.slice(0, 7) +
      ') işaret ediyor. Yeni bir sürüm numarasıyla çalıştır.');
  }

  if (remoteSha) {
    // Etiket zaten uzakta: push workflow'u daha önce tetiklendi. Yeniden göndermek ya da
    // elle “Run workflow” başlatmak yinelenen GitHub sürümü üretir — sadece dal gönderilir.
    info('v' + version + ' etiketi zaten uzakta (' + remoteSha.slice(0, 7) + '): paket workflow\'u daha önce tetiklenmiş.');
    info('Yinelenen sürüm oluşmaması için etiket yeniden gönderilmiyor; yalnızca dal gönderiliyor.');
    git(['push']);
    console.log('\nActions → 🖥️ Windows Kurulum Paketi çalışmasını “Run workflow” ile YENİDEN BAŞLATMA.');
    console.log('Paketi buradan doğrula: ' + releaseUrl);
  } else {
    // Dal ve etiket tek atomik push ile gider: biri reddedilirse ikisi de gitmez,
    // böylece “dal gitti, etiket gitmedi” durumunda elle tetikleme ihtiyacı doğmaz.
    info('Dal ve etiket birlikte gönderiliyor…');
    const branch = currentBranch();
    try {
      git(['push', '--atomic', 'origin', 'HEAD:' + branch, 'refs/tags/v' + version]);
    } catch (error) {
      fail(
        'Gönderim başarısız (atomik push reddedildi); hiçbir şey gitmedi. Commit ve etiket yerelde hazır.\n' +
          'Göndermek için: git push --atomic origin HEAD:' + branch + ' refs/tags/v' + version + '\n' +
          'Etiketi ayrıca gönderme ve Actions\'ta “Run workflow” başlatma — yinelenen sürüm oluşur.\n' +
          String(error.stderr || error.message)
      );
    }
    info('Gönderildi · Actions → 🖥️ Windows Kurulum Paketi paketi üretip Releases’e yükleyecek');
    console.log('\nNot: etiket gönderimi workflow’u zaten tetikledi.');
    console.log('Actions’ta ayrıca “Run workflow”a basma — aynı etiket için yinelenen GitHub sürümü oluşur.');
    console.log('Paket hazır olunca: ' + releaseUrl);
  }
} else {
  console.log('\nGöndermek için:');
  console.log('  git push && git push origin v' + version);
  console.log('Ya da tek komutta: node scripts/release.mjs ' + version + ' ' +
    items.map((item) => JSON.stringify(item)).join(' ') + ' --push --watch');
}

// ---------- 6) izleme (--watch) ----------

if (WATCH) {
  if (!PUSH) {
    info('--watch yalnızca --push ile anlamlı; izleme atlandı.');
  } else {
    const slug = repoSlug();
    if (!slug) {
      info('origin bir GitHub deposu değil, izleme atlandı.');
    } else {
      const watchedSha = git(['rev-parse', 'HEAD'], { quiet: true }).trim();
      console.log('\nPaket izleniyor (en fazla ' + Math.round(WATCH_TIMEOUT / 60000) + ' dk)…');
      const entries = changeItemsFor(version);
      const notes = buildReleaseNotes(version, entries.length ? entries : items);
      const result = await watchRelease({
        repo: slug,
        tag: 'v' + version,
        sha: watchedSha,
        notes,
        timeoutMs: WATCH_TIMEOUT
      });
      if (result.ok) {
        console.log('✓ Sürüm yayında: ' + result.releaseUrl +
          (result.notesUpdated ? ' (notlar: ' + (changeItemsFor(version).length || items.length) + ' madde)' : ''));
      } else {
        if (result.message) console.error('✖ ' + result.message);
        process.exitCode = result.reason === 'timeout' ? 0 : 1;
      }
    }
  }
}
