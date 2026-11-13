'use strict';

// Küçük regresyon kontrolü: huni sadeleştirmelerinde sayıların kaymadığını doğrular.
// Çalıştırma: node scripts/check-funnel-regression.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'site/firsat/app.js'), 'utf8');
const start = src.indexOf('  var FUNNEL_WINDOW_MS');
const end = src.indexOf('  function visibilityMinutesText', start);
if (start < 0 || end < 0) throw new Error('funnel extraction anchors missing');

const now = Date.now();
const code = `
var KINDS = { chest: { label: 'S' }, portal: { label: 'P' }, letter: { label: 'Z' } };
function isOpportunity(e) { return ['chest','portal','letter'].indexOf(e.kind) !== -1; }
function isExpired(e) { return false; }
${src.slice(start, end)}
result = funnelStats();
`;
const state = {
  settings: {
    funnelSeenSince: now - 3600000,
    visibility: { since: now - 3600000, intervals: [{ from: now - 600000, to: 0 }], lastTickAt: now, visible: true }
  },
  events: [
    { auto: true, kind: 'chest', status: 'collected', createdAt: now - 300000, seenAt: now - 290000, collectedAt: now - 280000, arrivedVisible: true },
    { auto: true, kind: 'portal', status: 'collected', createdAt: now - 240000, seenAt: now - 230000, collectedAt: now - 220000, arrivedVisible: true },
    { auto: true, kind: 'letter', status: 'pending', createdAt: now - 180000, seenAt: now - 170000, arrivedVisible: true },
    { auto: true, kind: 'chest', status: 'pending', createdAt: now - 120000, seenAt: 0, arrivedVisible: true },
    { auto: true, kind: 'chest', status: 'pending', createdAt: now - 60000, seenAt: 0, arrivedVisible: false },
    { auto: true, kind: 'portal', status: 'pending', createdAt: now - 30000, seenAt: 0, arrivedVisible: null }
  ]
};
const context = { state, result: null, Date, Math, Object, JSON, console };
vm.runInNewContext(code, context);
const f = context.result;

const checks = [
  ['boxes', f.boxes, 6],
  ['seen', f.seen, 3],
  ['unseen', f.boxes - f.seen, 3],
  ['visibleBoxes', f.visibleBoxes, 4],
  ['closedBoxes', f.closedBoxes, 1],
  ['unknownBoxes', f.unknownBoxes, 1],
  ['unseenClosed', f.unseenClosed, 1],
  ['unseenVisible', f.unseenVisible, 1],
  ['unseenUnknown', f.unseenUnknown, 1],
  ['visibleCollected', f.visibleCollected, 2],
  ['visibleMinutes', f.visibleMinutes, 10],
  ['boxesPerVisibleMinute', f.boxesPerVisibleMinute, 0.6],
  ['visibleBoxesPerVisibleMinute', f.visibleBoxesPerVisibleMinute, 0.4],
  ['exposureConversion', f.exposureConversion, 0.5],
  ['visibleDetection', f.visibleDetection, 0.75]
];

let bad = 0;
for (const [name, got, want] of checks) {
  const ok = Math.abs(got - want) < 0.01;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}=${got} (want ${want})`);
}
process.exitCode = bad ? 1 : 0;
