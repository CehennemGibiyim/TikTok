// Geçmiş live.json commit'lerinden koşu bazlı kota raporu.
// Her koşu (runId) için: deneme, başarılı bağlantı, dinlenen oda, yakalanan kutu,
// koşunun süresi üzerinden saatlik kutu getirisi ve 5 dakikalık dinleme oturumu başına kutu.
// Ayrıca boxes.json commit'lerinden saatlik kutu dağılımı çıkarılır.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// --json[=yol]: aynı ölçümleri panelin okuyacağı JSON olarak yazar (yol yoksa stdout).
const jsonArg = process.argv.find((arg) => arg.startsWith('--json'));
const jsonTarget = jsonArg ? (jsonArg.includes('=') ? jsonArg.split('=')[1] : true) : false;
const print = jsonTarget ? () => {} : (...args) => print(...args);

const REPO = process.cwd();
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { maxBuffer: 64 * 1024 * 1024 }).toString();

const liveShas = git('log', '--format=%H', '--', 'site/firsat/data/live.json').trim().split('\n').filter(Boolean);

const runs = new Map();
let parsed = 0, failed = 0;

for (const sha of liveShas) {
  let raw;
  try {
    raw = git('show', `${sha}:site/firsat/data/live.json`);
  } catch { failed++; continue; }
  let data;
  try { data = JSON.parse(raw); } catch { failed++; continue; }
  parsed++;
  const s = data.scanner || {};
  if (!s.runId) continue;

  let args = '';
  try {
    const yml = git('show', `${sha}:.github/workflows/scan.yml`);
    args = (yml.match(/scanner\/index\.js([^\n]*)/) || ['', ''])[1];
  } catch { /* yml yoksa boş kalır */ }

  const cfg = {
    rooms: Number((args.match(/--watch-rooms=(\d+)/) || [])[1]) || 0,
    gap: Number((args.match(/--connect-gap=(\d+)/) || [])[1]) || 0,
    starts: Number((args.match(/--starts-per-min=(\d+)/) || [])[1]) || 0,
    probe: Number((args.match(/--probe-ratio=([\d.]+)/) || [])[1]) || 0,
    watchSec: Number((args.match(/--watch-sec=(\d+)/) || [])[1]) || 0
  };
  const attempts = Number(s.connectStats && s.connectStats.attempts) || 0;
  const ok = Number(s.connectStats && s.connectStats.ok) || 0;
  const watching = Number(s.watching) || 0;
  const events = Array.isArray(data.events) ? data.events : [];
  const boxes = events.filter((e) => ['chest', 'letter', 'portal'].includes(e.kind)).length;
  const boxCoins = events.reduce((sum, e) => sum + (Number(e.coins) || 0), 0);
  const at = Date.parse(data.scannedAt || '') || 0;

  const key = String(s.runId);
  const prev = runs.get(key) || {
    runId: key, cfg, at: data.scannedAt, attempts: 0, ok: 0, watching: 0,
    boxes: 0, boxCoins: 0, snapshots: 0, events: 0, firstAt: at, lastAt: at
  };
  runs.set(key, {
    ...prev,
    cfg,
    at: data.scannedAt || prev.at,
    firstAt: prev.firstAt ? Math.min(prev.firstAt, at) : at,
    lastAt: Math.max(prev.lastAt, at),
    attempts: Math.max(prev.attempts, attempts),
    ok: Math.max(prev.ok, ok),
    watching: Math.max(prev.watching, watching),
    events: Math.max(prev.events, events.length),
    boxes: Math.max(prev.boxes, boxes),
    boxCoins: Math.max(prev.boxCoins, boxCoins),
    snapshots: prev.snapshots + 1
  });
}

// Koşunun ölçülen süresi: ilk ve son live.json anlık görüntüsü arası.
const hoursOf = (r) => (r.lastAt > r.firstAt ? (r.lastAt - r.firstAt) / 3600000 : 0);
const perHour = (boxes, hours) => (hours > 0.02 ? boxes / hours : null);
const fmtHourly = (value) => (value === null ? '      -' : value.toFixed(1).padStart(6));

const list = Array.from(runs.values())
  .filter((r) => r.attempts > 0)
  .sort((a, b) => String(a.at).localeCompare(String(b.at)));

const profile = (c) => {
  const aggressive = (c.gap > 0 && c.gap <= 2000) || c.starts >= 12 || c.probe >= 0.3;
  return aggressive ? 'agresif' : 'guvenli';
};

const groups = new Map();
for (const r of list) {
  const name = profile(r.cfg) + ' | ara ' + (r.cfg.gap || '?') + 'ms, dk ' + (r.cfg.starts || '?') + ', oran ' + (r.cfg.probe || '?') + ', oda ' + (r.cfg.rooms || '?');
  const g = groups.get(name) || { name, runs: 0, attempts: 0, ok: 0, boxes: 0, boxCoins: 0, watchMax: 0, hours: 0 };
  g.runs += 1;
  g.attempts += r.attempts;
  g.ok += r.ok;
  g.boxes += r.boxes;
  g.boxCoins += r.boxCoins;
  g.watchMax += r.watching;
  g.hours += hoursOf(r);
  groups.set(name, g);
}

print('commit:', liveShas.length, '| okunan:', parsed, '| hatali:', failed, '| karsilastirilabilir kosu:', list.length);
print('');
print('KOSU BAZINDA (son 25)');
for (const r of list.slice(-25)) {
  const per = r.attempts ? (r.boxes / r.attempts * 100).toFixed(2) : '0.00';
  const hours = hoursOf(r);
  const boxesPerSession = r.ok ? (r.boxes / r.ok).toFixed(2) : '-';
  // Yarım saatten kısa koşularda kutu/saat yalnızca birkaç dakikadan türetilir: işaretle.
  const short = hours > 0 && hours < 0.5 ? '*' : ' ';
  print([
    new Date(r.at).toISOString().slice(5, 16),
    'oda ' + String(r.cfg.rooms).padStart(2),
    'ara ' + String(r.cfg.gap).padStart(5),
    'dk ' + String(r.cfg.starts).padStart(2),
    'oran ' + String(r.cfg.probe).padEnd(4),
    '| deneme ' + String(r.attempts).padStart(4),
    'ok ' + String(r.ok).padStart(3),
    'dinlenen ' + String(r.watching).padStart(2),
    'kutu ' + String(r.boxes).padStart(2),
    'jeton ' + String(r.boxCoins).padStart(5),
    '| kutu/100 deneme ' + per,
    'kutu/saat ' + fmtHourly(perHour(r.boxes, hours)) + short,
    'kutu/5dk oturum ' + boxesPerSession
  ].join(' '));
}

print('(* = koşu yarım saatten kısa; kutu/saat az sayıda dakikadan türetildi)');
print('');
print('AYAR GRUPLARI (kutu/deneme buyukten kucuge)');
const rows = Array.from(groups.values()).sort((a, b) => (b.boxes / Math.max(1, b.attempts)) - (a.boxes / Math.max(1, a.attempts)));
for (const g of rows) {
  const per100 = (g.boxes / Math.max(1, g.attempts) * 100).toFixed(2);
  const okRate = (g.ok / Math.max(1, g.attempts) * 100).toFixed(0);
  const boxesPerOk = (g.boxes / Math.max(1, g.ok)).toFixed(2);
  print(
    g.name.padEnd(56),
    'kosu ' + String(g.runs).padStart(2),
    '| deneme ' + String(g.attempts).padStart(5),
    'ok %' + okRate.padStart(3),
    '| kutu ' + String(g.boxes).padStart(3),
    'kutu/100 deneme ' + per100.padStart(6),
    'kutu/baglanti ' + boxesPerOk,
    'kutu/saat ' + fmtHourly(perHour(g.boxes, g.hours)),
    '| ort dinlenen ' + (g.watchMax / g.runs).toFixed(1)
  );
}

// Saatlik kutu dağılımı: boxes.json commit'leri kutu kimliğiyle birleştirilir,
// her kutu kendi yakalanma saatine (t) yazılır. Aynı kutu birçok commit'te görünür.
const boxShas = git('log', '--format=%H', '-n', '400', '--', 'site/firsat/data/boxes.json').trim().split('\n').filter(Boolean);
const boxTimes = new Map();
let boxCommits = 0;
for (const sha of boxShas) {
  let data;
  try { data = JSON.parse(git('show', `${sha}:site/firsat/data/boxes.json`)); } catch { continue; }
  boxCommits++;
  for (const box of data.boxes || []) {
    if (!box || !box.id) continue;
    const t = Number(box.t) || 0;
    if (t > 0 && !boxTimes.has(box.id)) boxTimes.set(box.id, t);
  }
}

const perClockHour = new Map();
for (const t of boxTimes.values()) {
  const key = new Date(t).toISOString().slice(0, 13);
  perClockHour.set(key, (perClockHour.get(key) || 0) + 1);
}
const hourKeys = Array.from(perClockHour.keys()).sort();
const boxTotal = boxTimes.size;
const spanHours = hourKeys.length;

if (boxTotal) {
  print('');
  print('SAATLIK KUTU (boxes.json gecmisi, ' + boxCommits + ' commit, ' + boxTotal + ' tekil kutu, ' + spanHours + ' saat)');
  print('ort ' + (boxTotal / Math.max(1, spanHours)).toFixed(1) + ' kutu/saat');
  for (const hour of hourKeys.slice(-24)) {
    const count = perClockHour.get(hour);
    print(hour.replace('T', ' ') + ':00',
      String(count).padStart(3),
      '#'.repeat(Math.min(60, count)));
  }
}

// Panelin Ölçüm sekmesi bu JSON'u okur: aynı sayılar, sunum panelde.
const json = {
  generatedAt: new Date().toISOString(),
  source: { commits: liveShas.length, parsed, failed, comparedRuns: list.length },
  runs: list.slice(-40).map((r) => {
    const hours = hoursOf(r);
    const per = perHour(r.boxes, hours);
    return {
      at: new Date(r.at).toISOString(),
      cfg: r.cfg,
      profile: profile(r.cfg),
      attempts: r.attempts,
      ok: r.ok,
      watching: r.watching,
      boxes: r.boxes,
      boxCoins: r.boxCoins,
      hours: Math.round(hours * 100) / 100,
      boxesPer100: Math.round((r.boxes / Math.max(1, r.attempts)) * 10000) / 100,
      boxesPerHour: per === null ? null : Math.round(per * 10) / 10,
      boxesPerSession: r.ok ? Math.round((r.boxes / r.ok) * 100) / 100 : null,
      // Yarım saatten kısa koşu: kutu/saat az sayıda dakikadan türetildi.
      short: hours > 0 && hours < 0.5
    };
  }),
  groups: rows.map((g) => {
    const per = perHour(g.boxes, g.hours);
    return {
      name: g.name,
      profile: g.name.split(' | ')[0],
      runs: g.runs,
      attempts: g.attempts,
      ok: g.ok,
      okRate: Math.round((g.ok / Math.max(1, g.attempts)) * 100),
      boxes: g.boxes,
      boxCoins: g.boxCoins,
      boxesPer100: Math.round((g.boxes / Math.max(1, g.attempts)) * 10000) / 100,
      boxesPerOk: g.ok ? Math.round((g.boxes / g.ok) * 100) / 100 : null,
      boxesPerHour: per === null ? null : Math.round(per * 10) / 10,
      avgWatching: Math.round((g.watchMax / g.runs) * 10) / 10
    };
  }),
  hourly: {
    commits: boxCommits,
    boxes: boxTotal,
    hours: spanHours,
    avgPerHour: Math.round((boxTotal / Math.max(1, spanHours)) * 10) / 10,
    buckets: hourKeys.map((hour) => ({ hour, count: perClockHour.get(hour) }))
  }
};

if (jsonTarget) {
  const body = JSON.stringify(json, null, 2);
  if (typeof jsonTarget === 'string') writeFileSync(jsonTarget, body + '\n');
  else process.stdout.write(body);
}
