#!/usr/bin/env node
/*
 * Sürüm paketini GitHub Actions'ta izler: etiket push'undan sonra başlayan
 * "🖥️ Windows Kurulum Paketi" çalışmasını bekler ve sonucu yazar.
 *
 * Tek başına:
 *   node scripts/watch-release.mjs --repo CehennemGibiyim/TikTok --tag v1.1.0 --sha <commit>
 *   node scripts/watch-release.mjs --repo owner/repo --tag v1.1.0 --timeout 600
 *
 * release.mjs içinden --watch ile çağrılır.
 */

const DEFAULT_API = 'https://api.github.com';
const WORKFLOW_PATH = '.github/workflows/release.yml';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mb(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return ' (' + (bytes / (1024 * 1024)).toFixed(1) + ' MB)';
}

function authHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tiktok-radar-release'
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

async function apiGet(api, path, token) {
  const response = await fetch(api + path, { headers: authHeaders(token) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (error) {
    body = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    body,
    reset: response.headers.get('x-ratelimit-reset'),
    remaining: response.headers.get('x-ratelimit-remaining')
  };
}

function rateLimitMessage(result, api) {
  const resetAt = result.reset ? new Date(Number(result.reset) * 1000) : null;
  const when = resetAt ? resetAt.toLocaleString('tr-TR') : 'bir süre sonra';
  return 'GitHub API istek sınırı doldu (anahtarsız saatte 60 istek). ' +
    'Sıfırlanma: ' + when + '. GITHUB_TOKEN (ya da GH_TOKEN) ortam değişkeni vererek ' +
    'saatte 5000 istekle izlemeyi tekrar çalıştır: ' + api;
}

/**
 * @returns {Promise<{ok:boolean, reason:string, runUrl?:string, releaseUrl?:string, assets?:Array, message?:string}>}
 */
export async function watchRelease({
  repo,
  tag,
  sha = '',
  timeoutMs = 20 * 60 * 1000,
  intervalMs = 15000,
  api = process.env.RELEASE_WATCH_API || DEFAULT_API,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  log = console.log
} = {}) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    return { ok: false, reason: 'repo', message: 'Geçerli bir depo adı gerekli (owner/repo).' };
  }

  const apiBase = api.replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  const query = sha ? '?head_sha=' + sha + '&per_page=10' : '?per_page=10';
  const actionsUrl = 'https://github.com/' + repo + '/actions/workflows/release.yml';

  if (!token) {
    log('İzleme anahtarsız çalışıyor (saatte 60 istek). Uzun beklemelerde GITHUB_TOKEN ver.');
  }

  let runSeen = false;
  let warnedNoRun = false;

  while (Date.now() < deadline) {
    const runs = await apiGet(apiBase, '/repos/' + repo + '/actions/runs' + query, token);

    if (runs.status === 403 || runs.status === 429) {
      return { ok: false, reason: 'rate-limit', message: rateLimitMessage(runs, actionsUrl) };
    }
    if (!runs.ok) {
      return {
        ok: false,
        reason: 'api',
        message: 'Actions sorgusu başarısız (HTTP ' + runs.status + '): ' + actionsUrl
      };
    }

    const list = (runs.body && runs.body.workflow_runs) || [];
    const run = list
      .filter((item) => item.path === WORKFLOW_PATH || item.name === '🖥️ Windows Kurulum Paketi')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!run) {
      if (!warnedNoRun) {
        log('Workflow henüz görünmedi (etiket işleniyor olabilir)…');
        warnedNoRun = true;
      }
      await sleep(intervalMs);
      continue;
    }

    runSeen = true;

    if (run.status !== 'completed') {
      log('Paket çalışıyor: ' + run.status + ' · ' + run.html_url);
      await sleep(intervalMs);
      continue;
    }

    if (run.conclusion !== 'success') {
      return {
        ok: false,
        reason: 'failed',
        runUrl: run.html_url,
        message: 'Paket üretilemedi (sonuç: ' + run.conclusion + '). Günlük: ' + run.html_url
      };
    }

    // Workflow bitti; GitHub sürümü ve dosyaları birkaç saniye içinde görünür.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const release = await apiGet(apiBase, '/repos/' + repo + '/releases/tags/' + tag, token);
      if (release.ok && release.body) {
        const assets = (release.body.assets || []).map((asset) => ({
          name: asset.name,
          size: asset.size,
          url: asset.browser_download_url
        }));
        const exe = assets.find((asset) => /\.exe$/i.test(asset.name));
        const updater = assets.find((asset) => asset.name === 'latest.yml');
        if (exe && updater) {
          log('✓ Paket hazır: ' + exe.name + mb(exe.size) + ' + ' + updater.name);
          return {
            ok: true,
            reason: 'success',
            runUrl: run.html_url,
            releaseUrl: release.body.html_url,
            assets
          };
        }
        if (assets.length) {
          log('Sürüm var ama beklenen dosyalar eksik (' + assets.map((a) => a.name).join(', ') + ')');
        }
      }
      await sleep(10000);
    }

    return {
      ok: false,
      reason: 'assets',
      runUrl: run.html_url,
      message: 'Workflow başarılı ama GitHub sürümünde .exe + latest.yml görünmedi: ' +
        'https://github.com/' + repo + '/releases/tag/' + tag
    };
  }

  return {
    ok: false,
    reason: 'timeout',
    message: (runSeen ? 'Zaman aşımı: paket hâlâ çalışıyor.' : 'Zaman aşımı: workflow başlamadı.') +
      ' Durumu buradan kontrol et: ' + actionsUrl
  };
}

// ---- tek başına çalıştırma ----

function isMain() {
  try {
    const entry = process.argv[1] ? new URL('file://' + process.argv[1]).pathname : '';
    return entry === new URL(import.meta.url).pathname;
  } catch (error) {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  // Hem `--ad=deger` hem `--ad deger` biçimini kabul eder.
  const value = (name) => {
    const inline = args.find((arg) => arg.startsWith('--' + name + '='));
    if (inline) return inline.slice(name.length + 3);
    const index = args.indexOf('--' + name);
    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
    return '';
  };
  const repo = value('repo');
  const tag = value('tag') || '';
  const sha = value('sha');
  const timeoutSec = Number(value('timeout')) || 1200;
  const intervalSec = Number(value('interval')) || 15;

  if (!repo) {
    console.error('Kullanım: node scripts/watch-release.mjs --repo owner/repo --tag v1.0.1 [--sha <commit>] ' +
      '[--timeout 1200] [--interval 15]');
    process.exit(2);
  }

  const result = await watchRelease({
    repo,
    tag,
    sha,
    timeoutMs: timeoutSec * 1000,
    intervalMs: intervalSec * 1000
  });

  if (result.ok) {
    console.log('Sürüm: ' + result.releaseUrl);
    process.exit(0);
  }
  if (result.message) console.error('✖ ' + result.message);
  process.exit(result.reason === 'timeout' ? 0 : 1);
}
