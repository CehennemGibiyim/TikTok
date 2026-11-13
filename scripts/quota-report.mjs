// Geçmiş live.json commit'lerinden koşu bazlı kota raporu.
// Her koşu (runId) için: deneme, başarılı bağlantı, dinlenen oda, yakalanan kutu.
import { execFileSync } from 'node:child_process';

const REPO = process.cwd();
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { maxBuffer: 64 * 1024 * 1024 }).toString();

const shas = git('log', '--format=%H', '--', 'site/firsat/data/live.json').trim().split('\n').filter(Boolean);

const runs = new Map();
let parsed = 0, failed = 0;

for (const sha of shas) {
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

  const key = String(s.runId);
  const prev = runs.get(key) || {
    runId: key, cfg, at: data.scannedAt, attempts: 0, ok: 0, watching: 0,
    boxes: 0, boxCoins: 0, snapshots: 0, events: 0
  };
  runs.set(key, {
    ...prev,
    cfg,
    at: data.scannedAt || prev.at,
    attempts: Math.max(prev.attempts, attempts),
    ok: Math.max(prev.ok, ok),
    watching: Math.max(prev.watching, watching),
    events: Math.max(prev.events, events.length),
    boxes: Math.max(prev.boxes, boxes),
    boxCoins: Math.max(prev.boxCoins, boxCoins),
    snapshots: prev.snapshots + 1
  });
}

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
  const g = groups.get(name) || { name, runs: 0, attempts: 0, ok: 0, boxes: 0, boxCoins: 0, watchMax: 0 };
  g.runs += 1;
  g.attempts += r.attempts;
  g.ok += r.ok;
  g.boxes += r.boxes;
  g.boxCoins += r.boxCoins;
  g.watchMax += r.watching;
  groups.set(name, g);
}

console.log('commit:', shas.length, '| okunan:', parsed, '| hatali:', failed, '| karsilastirilabilir kosu:', list.length);
console.log('');
console.log('KOSU BAZINDA (son 25)');
for (const r of list.slice(-25)) {
  const per = r.attempts ? (r.boxes / r.attempts * 100).toFixed(2) : '0.00';
  console.log([
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
    '| kutu/100 deneme ' + per
  ].join(' '));
}

console.log('');
console.log('AYAR GRUPLARI (kutu/deneme buyukten kucuge)');
const rows = Array.from(groups.values()).sort((a, b) => (b.boxes / Math.max(1, b.attempts)) - (a.boxes / Math.max(1, a.attempts)));
for (const g of rows) {
  const per100 = (g.boxes / Math.max(1, g.attempts) * 100).toFixed(2);
  const okRate = (g.ok / Math.max(1, g.attempts) * 100).toFixed(0);
  const boxesPerOk = (g.boxes / Math.max(1, g.ok)).toFixed(2);
  console.log(
    g.name.padEnd(56),
    'kosu ' + String(g.runs).padStart(2),
    '| deneme ' + String(g.attempts).padStart(5),
    'ok %' + okRate.padStart(3),
    '| kutu ' + String(g.boxes).padStart(3),
    'kutu/100 deneme ' + per100.padStart(6),
    'kutu/baglanti ' + boxesPerOk,
    '| ort dinlenen ' + (g.watchMax / g.runs).toFixed(1)
  );
}
