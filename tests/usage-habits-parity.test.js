'use strict';
//
// The Swift port of the usage habits model (Votive/Services/UsageHabits.swift) is compiled and run on the same messy
// history as the script (Scripts/usage-habits.js). Both must give the same numbers and the same sentences, in two time
// zones (one of them a half-hour zone), so the window the owner opens shows what the command line shows.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const V = (...p) => path.join(ROOT, 'Votive', ...p);
let haveSwift = process.platform === 'darwin';
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch (e) { haveSwift = false; }
const skip = !haveSwift && 'needs macOS with a Swift toolchain';

const HOUR = 3600e3, DAY = 24 * HOUR;

/** Five weeks of evening-heavy use with long gaps, window resets every Monday 00:00 UTC, and a few bad lines. */
function fixture() {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const monday = Date.UTC(2026, 9, 5);
  const lines = [];
  let w = 0, week = 0;
  for (let t = monday; t < monday + 33 * DAY + 15 * HOUR; t += 5 * 60e3 * (1 + Math.floor(rnd() * 6))) {
    const d = new Date(t), hr = d.getUTCHours(), wd = d.getUTCDay();
    const thisWeek = Math.floor((t - monday) / (7 * DAY));
    if (thisWeek !== week) { week = thisWeek; w = 0; }
    const active = (wd === 0 || wd === 6) ? hr >= 9 && hr <= 22 : hr >= 19 && hr <= 23;
    if (!active && rnd() < 0.93) continue;                       // the status line only samples while an agent runs
    w = Math.min(100, w + (active ? rnd() * 0.9 : 0));
    const wr = (monday + (thisWeek + 1) * 7 * DAY) / 1000;
    lines.push(JSON.stringify({ t, s: Math.round(rnd() * 90), sr: Math.floor(t / 1000) + 3600, w: Math.round(w * 10) / 10, wr }));
  }
  lines.push('{"t": 1700000000000, "w": 140, "wr": 1700000000}');   // percent out of range
  lines.push('{"t": 1700000000001, "w": true}');                    // a boolean is not a number
  lines.push('{"t": 17000000');                                     // torn line
  lines.push('not json');
  return { text: lines.join('\n') + '\n', last: monday + 33 * DAY + 15 * HOUR };
}

function compile(dir) {
  fs.writeFileSync(path.join(dir, 'main.swift'), [
    'import Foundation',
    'let a = CommandLine.arguments',
    'let text = try! String(contentsOfFile: a[1], encoding: .utf8)',
    'let samples = HabitsHistory.parse(text)',
    'let h = UsageHabits(timeZone: TimeZone(identifier: a[2])!)',
    'let r = h.analyse(samples, target: Double(a[3])!, now: Double(a[4])!)',
    'var o: [String: Any] = ["samples": r.samples, "daysSeen": r.daysSeen, "trainedOn": r.trainedOn, "insights": r.insights, "we": r.model.we, "wd": r.model.wd, "parsed": samples.count]',
    'if let x = r.rhythm { o["rhythm"] = ["peakStart": x.peakStart, "peakEnd": x.peakEnd, "peakShare": x.peakShare, "weekdayPerDay": x.weekdayPerDay as Any, "weekendPerDay": x.weekendPerDay as Any, "weekdayDaytimeShare": x.weekdayDaytimeShare as Any, "totalPoints": x.totalPoints] }',
    'if let f = r.forecast { o["forecast"] = ["used": f.used, "projected": f.projected, "low": f.low as Any, "high": f.high as Any, "spare": f.spare, "over": f.over, "expectedMore": f.expectedMore, "pathLast": r.path.last?.mid ?? -1, "pathCount": r.path.count] }',
    'o["backtest"] = ["enough": r.backtest.enough, "days": r.backtest.days, "maeModel": r.backtest.maeModel, "maeBaseline": r.backtest.maeBaseline, "beats": r.backtest.beatsBaseline]',
    'let data = try! JSONSerialization.data(withJSONObject: o.mapValues { v -> Any in v }, options: [.sortedKeys])',
    'print(String(data: data, encoding: .utf8)!)',
  ].join('\n'));
  const exe = path.join(dir, 'habits');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, V('Services/UsageHabits.swift'), V('Services/BoundedRead.swift'), V('Services/Paths.swift'), V('Models/OverlayEntry.swift'), path.join(dir, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  return exe;
}

function close(a, b, where) {
  if (typeof a === 'number' && typeof b === 'number') return assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)), where + ': ' + a + ' vs ' + b);
  if (Array.isArray(a)) { assert.equal(a.length, b.length, where + ' length'); return a.forEach((x, i) => close(x, b[i], where + '[' + i + ']')); }
  if (a && typeof a === 'object') { assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), where + ' keys'); return Object.keys(a).forEach((k) => close(a[k], b[k], where + '.' + k)); }
  assert.equal(a, b, where);
}

test('habits parity: the Swift model and the script agree on numbers and sentences, in UTC and in India', { skip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao habits parity '));
  const exe = compile(d);
  const fx = fixture();
  const file = path.join(d, 'history.jsonl');
  fs.writeFileSync(file, fx.text);
  for (const [tz, target, now] of [['UTC', 80, fx.last], ['Asia/Kolkata', 80, fx.last], ['Asia/Kolkata', 60, fx.last - 2 * DAY - 5 * HOUR]]) {
    const js = JSON.parse(spawnSync('node', ['-e', `
      const h = require(${JSON.stringify(path.join(ROOT, 'Scripts', 'usage-habits'))});
      const fs = require('fs');
      const s = [];
      for (const line of fs.readFileSync(${JSON.stringify(file)}, 'utf8').split('\\n')) {
        try { const x = JSON.parse(line); if (x && typeof x.t === 'number' && x.t > 1e12 && x.t < 4e12 && (x.w === undefined || x.w === null || (typeof x.w === 'number' && x.w >= 0 && x.w <= 100))) s.push(x); } catch (e) {}
      }
      s.forEach((x) => { for (const k of ['s', 'sr', 'w', 'wr']) if (x[k] === undefined) x[k] = null; });
      s.sort((a, b) => a.t - b.t);
      const a = h.analyse(s, { now: ${now}, target: ${target} });
      const m = h.fit(s, { now: ${now} });
      const o = { samples: a.samples, daysSeen: a.daysSeen, trainedOn: a.trainedOn, insights: a.insights, we: m.we, wd: m.wd, parsed: s.length,
        backtest: { enough: a.backtest.enough, days: a.backtest.days, maeModel: a.backtest.maeModel || 0, maeBaseline: a.backtest.maeBaseline || 0, beats: !!a.backtest.beatsBaseline } };
      if (a.rhythm) { const r = a.rhythm; o.rhythm = { peakStart: r.peakStart, peakEnd: r.peakEnd, peakShare: r.peakShare, weekdayPerDay: r.weekdayPerDay, weekendPerDay: r.weekendPerDay, weekdayDaytimeShare: r.weekdayDaytimeShare, totalPoints: r.totalPoints }; }
      if (a.forecast) { const f = a.forecast; o.forecast = { used: f.used, projected: f.projected, low: f.low, high: f.high, spare: f.spare, over: f.over, expectedMore: f.expectedMore }; }
      console.log(JSON.stringify(o));
    `], { encoding: 'utf8', env: { ...process.env, TZ: tz } }).stdout);
    const sw = JSON.parse(spawnSync(exe, [file, tz, String(target), String(now)], { encoding: 'utf8' }).stdout);
    if (sw.forecast) { assert.ok(sw.forecast.pathCount > 24, 'the forecast line has an hourly point per hour to the reset'); close(sw.forecast.pathLast, sw.forecast.projected, tz + ' the forecast line ends on the forecast'); delete sw.forecast.pathLast; delete sw.forecast.pathCount; }
    assert.equal(sw.parsed, js.parsed, tz + ': both read the same valid lines (bad ones are dropped by both)');
    assert.deepEqual(sw.insights, js.insights, tz + ': the same sentences');
    // JSON drops nil as null in one and missing in the other; compare through a normal form
    const norm = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v)));
    close(norm(sw), norm(js), tz);
    assert.ok(js.forecast && js.backtest.enough, tz + ': the fixture is rich enough to exercise the forecast and the backtest');
  }
  fs.rmSync(d, { recursive: true, force: true });
});
