'use strict';
//
// The usage habits model (Scripts/usage-habits.js). It runs on made-up histories with a known weekly rhythm in
// UTC, so every expectation can be worked out by hand. It reads and writes nothing real.
//
//   node --test tests/*.test.js
//
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-habits-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const habits = require('../Scripts/usage-habits');

const HOUR = 3600e3, DAY = 24 * HOUR;
const MONDAY = Date.UTC(2026, 9, 5);                       // Mon 5 Oct 2026 00:00 UTC; the plan resets on Mondays

/** Points used in the hour starting at `h`: weekday evenings 20-22 use 2, weekend 10-22 use 2, nothing else (a week is 82 points, under the 100 cap). */
function pattern(h) {
  const d = new Date(h), hr = d.getUTCHours(), wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return hr >= 10 && hr <= 22 ? 2 : 0;
  return hr >= 20 && hr <= 22 ? 2 : 0;
}
const nextMonday = (t) => { let m = MONDAY; while (m <= t) m += 7 * DAY; return m; };

/** One sample on every hour boundary from `weeks` weeks after MONDAY until `until`, weekly percent following the pattern. */
function history(until, extra = (h) => 0) {
  const out = [];
  let w = 0, prevReset = nextMonday(MONDAY);
  for (let t = MONDAY; t <= until; t += HOUR) {
    const reset = nextMonday(t);
    if (reset !== prevReset) { w = 0; prevReset = reset; }
    else if (t > MONDAY) w += pattern(t - HOUR) + extra(t - HOUR);
    out.push({ t, s: 0, sr: Math.floor((t + 5 * HOUR) / 1000), w: Math.min(100, w), wr: reset / 1000 });
  }
  return out;
}

test('habits: hours are counted from the rise of the weekly percentage, never from a reset', () => {
  const t0 = MONDAY + 10 * HOUR;
  const wr = (MONDAY + 7 * DAY) / 1000, wr2 = (MONDAY + 14 * DAY) / 1000;
  const s = [
    { t: t0, s: 0, sr: 1, w: 10, wr },
    { t: t0 + HOUR, s: 0, sr: 1, w: 14, wr },          // 4 points in the hour starting 10:00
    { t: t0 + 2 * HOUR, s: 0, sr: 1, w: 30, wr: wr2 }, // the window reset: whatever the new window starts at is not use
    { t: t0 + 3 * HOUR, s: 0, sr: 1, w: 32, wr: wr2 },
  ];
  const u = habits.hourlyUse(s);
  assert.equal(u.cells.get(t0), 4);
  assert.equal(u.cells.get(t0 + HOUR), 0, 'the pair that crosses a reset adds nothing');
  assert.equal(u.cells.get(t0 + 2 * HOUR), 2);
  assert.equal(habits.hourlyUse([]).first, null);
});

test('habits: an hour with no sample is an hour of no use, not an unknown', () => {
  const wr = (MONDAY + 7 * DAY) / 1000;
  const s = [{ t: MONDAY, s: 0, sr: 1, w: 5, wr }, { t: MONDAY + 6 * HOUR, s: 0, sr: 1, w: 5, wr }];
  const u = habits.hourlyUse(s);
  for (let k = 0; k <= 6; k++) assert.equal(u.cells.get(MONDAY + k * HOUR), 0);
});

test('habits: finds the evening window and the weekday and weekend difference', () => {
  const until = MONDAY + 28 * DAY + 12 * HOUR;                       // four weeks, ending Mon 12:00
  const a = habits.analyse(history(until), { now: until });
  assert.equal(a.rhythm.peakStart, 19, 'the busiest 4 hours are 19:00 to 23:00: three evening hours every day plus a busy weekend 19:00');
  assert.ok(a.rhythm.peakShare > 0.25);
  assert.ok(a.rhythm.weekendPerDay > a.rhythm.weekdayPerDay * 3, 'weekend days: 26 points, weekdays: 6');
  assert.equal(Math.round(a.rhythm.weekdayPerDay), 6);
  assert.equal(Math.round(a.rhythm.weekendPerDay), 26);
  assert.equal(a.rhythm.weekdayDaytimeShare, 0);
  assert.ok(a.insights.some((s) => /working hours.*almost none/.test(s)));
});

test('habits: the forecast at the reset lands on the true total of a regular week', () => {
  const now = MONDAY + 21 * DAY + 2 * DAY + 12 * HOUR;               // Wednesday 12:00 of the 4th week
  const hist = history(now);
  const a = habits.analyse(hist, { now, target: 80 });
  // the true week: 5 weekdays x 6 + 2 weekend days x 26 = 82 points
  const used = hist[hist.length - 1].w;
  let truth = used;
  for (let t = now; t < MONDAY + 28 * DAY - HOUR; t += HOUR) truth += pattern(t);
  assert.ok(a.forecast, 'a forecast exists');
  assert.ok(Math.abs(a.forecast.projected - truth) <= 0.1 * truth, 'projected ' + a.forecast.projected + ' vs true ' + truth);
  assert.ok(a.forecast.low <= a.forecast.projected && a.forecast.projected <= a.forecast.high);
  assert.equal(a.forecast.used, used);
});

test('habits: with only a day or two seen it gives no forecast and no verdict', () => {
  const until = MONDAY + 1 * DAY + 12 * HOUR;
  const a = habits.analyse(history(until), { now: until });
  assert.equal(a.forecast, null);
  assert.equal(a.backtest.enough, false);
  assert.ok(a.insights.some((s) => /Not enough days|Too early/.test(s)));
});

test('habits: the leave-one-day-out test beats "an average day" on a regular rhythm', () => {
  const until = MONDAY + 21 * DAY;
  const b = habits.backtest(history(until));
  assert.equal(b.enough, true);
  assert.ok(b.beatsBaseline, 'model error ' + b.maeModel + ' vs average-day error ' + b.maeBaseline);
  assert.ok(b.maeModel < b.maeBaseline / 2);
});

test('habits: one wild day does not take over the pattern (shrinkage)', () => {
  const until = MONDAY + 5 * DAY + 23 * HOUR;                        // history ends on the first Saturday: each weekend cell seen once
  const wildDay = MONDAY + 5 * DAY;                                  // and that Saturday is 12 points busier at 15:00
  const wildHour = (h) => (h >= wildDay && h < wildDay + DAY && new Date(h).getUTCHours() === 15 ? 12 : 0);
  const calm = habits.fit(history(until));
  const wild = habits.fit(history(until, wildHour));
  const lift = wild.we[15] - calm.we[15];
  assert.ok(lift > 0, 'it notices');
  assert.ok(lift < 8, 'but takes well under the full 12 extra points from a single sighting: ' + lift);
  // and with a month of history the same wild day moves the cell only a little
  const long = MONDAY + 28 * DAY;
  const wild4 = habits.fit(history(long, (h) => (h >= MONDAY + 26 * DAY && h < MONDAY + 27 * DAY && new Date(h).getUTCHours() === 15 ? 12 : 0)));
  const calm4 = habits.fit(history(long));
  assert.ok(wild4.we[15] - calm4.we[15] < lift, 'more history, a smaller effect from one day');
});

test('habits: a recent change in habit counts for more than an old one (recency weighting)', () => {
  const until = MONDAY + 28 * DAY;
  const weekdayAt21 = (h) => { const d = new Date(h); return h >= MONDAY + 21 * DAY && d.getUTCHours() === 21 && d.getUTCDay() >= 1 && d.getUTCDay() <= 5 ? 4 : 0; };
  const m = habits.fit(history(until, weekdayAt21), { now: until });
  // 15 old weekdays at 2 points and 5 recent ones at 6: a plain average is 3
  assert.ok(m.wd[21] > 3.2, 'the weekday 21:00 cell leans toward the recent 6, not the plain average: ' + m.wd[21]);
});

test('habits: the verdict is cautious while few days have been seen', () => {
  const until = MONDAY + 10 * DAY;
  const a = habits.analyse(history(until), { now: until });
  const check = a.insights.find((s) => /^Check:/.test(s));
  assert.ok(check, 'there is a check line');
  assert.ok(!/predicts your days better than a plain average/.test(check), 'no strong claim under 14 days');
});

test('habits: reports over-target, spare and run-out in plain words', () => {
  const now = MONDAY + 21 * DAY + 2 * DAY + 12 * HOUR;
  const hist = history(now);
  const over = habits.analyse(hist, { now, target: 20 });
  assert.ok(over.insights.some((s) => /over your 20% target/.test(s) || /limit runs out/.test(s)));
  const spare = habits.analyse(hist, { now, target: 99 });
  assert.ok(spare.insights.some((s) => /unused against your 99% target|close to your 99% target|over your 99%/.test(s)));
});

test('habits: no history, a missing window and garbage input say so instead of crashing', () => {
  assert.match(habits.format(habits.analyse([], { now: MONDAY })), /No usage history yet/);
  const stale = [{ t: MONDAY, s: 0, sr: 1, w: 5, wr: (MONDAY - DAY) / 1000 }, { t: MONDAY + HOUR, s: 0, sr: 1, w: 6, wr: (MONDAY - DAY) / 1000 }];
  const a = habits.analyse(stale, { now: MONDAY + 2 * HOUR });
  assert.equal(a.forecast, null);
  assert.ok(a.insights.some((s) => /No current weekly reading|Not enough days/.test(s)));
});

test('habits: passive by construction: reads the history file, opens nothing, writes nothing, runs nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Scripts', 'usage-habits.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const requires = [...src.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ["'./usage-history'"], 'its only dependency is the history reader');
  assert.ok(!/\b(writeFile|appendFile|mkdir|unlink|rename|chmod|spawn|exec|fetch|XMLHttpRequest|WebSocket|import\()/.test(src));
});

test('habits: hours begin on the wall clock in a half-hour zone (India)', () => {
  const { spawnSync } = require('child_process');
  const script = `
    const h = require(${JSON.stringify(path.join(__dirname, '..', 'Scripts', 'usage-habits'))});
    const HOUR = 3600e3;
    // 21:10 to 22:20 on 3 Nov 2026 in IST is 15:40 to 16:50 UTC
    const t0 = Date.UTC(2026, 10, 3, 15, 40), wr = Date.UTC(2026, 10, 9) / 1000;
    const u = h.hourlyUse([{ t: t0, s: 0, sr: 1, w: 10, wr }, { t: t0 + 70 * 60000, s: 0, sr: 1, w: 17, wr }]);
    console.log(JSON.stringify([...u.cells.keys()].map((k) => new Date(k).toISOString())));
  `;
  const r = spawnSync('node', ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Kolkata' } });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout);
  assert.deepEqual(keys, ['2026-11-03T15:30:00.000Z', '2026-11-03T16:30:00.000Z'], 'cells start at 21:00 and 22:00 IST (15:30 and 16:30 UTC)');
});

test('habits: a whole day starts at its first hour even when a long gap leaves its morning to be filled in later', () => {
  // Tue 6 Oct has samples only at its end (the pair that crosses the gap covers Mon 22:00 to Wed 09:00 only from 12 hours back),
  // so its other hours are filled in after the pairs. Its start must still be Tuesday 00:00, or the self-test scores the wrong 24 hours.
  const wr = (MONDAY + 7 * DAY) / 1000;
  const at = (t, w) => ({ t, s: 0, sr: 1, w, wr });
  const s = [at(MONDAY, 0), at(MONDAY + 1 * DAY - 4 * HOUR, 2), at(MONDAY + 2 * DAY + 10 * HOUR, 8), at(MONDAY + 3 * DAY + 12 * HOUR, 9)];
  const m = habits.fit(s, { now: MONDAY + 4 * DAY });
  const tuesday = m.days.find((d) => d.start === MONDAY + 1 * DAY);
  assert.ok(tuesday, 'Tuesday is a whole day starting at 00:00; days: ' + m.days.map((d) => new Date(d.start).toISOString()).join(', '));
});

