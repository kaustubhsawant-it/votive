'use strict';
//
// The habits tuner (Scripts/usage-tune.js): it only suggests a change when the data can support one, it is deterministic, and it changes and writes nothing.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const habits = require('../Scripts/usage-habits');
const T = require('../Scripts/usage-tune');

const HOUR = 3600e3, DAY = 24 * HOUR;

/** `days` days of evening-heavy use (weekends all day), a Monday window reset, samples every 15 minutes while active. */
function history(days, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const start = Date.UTC(2026, 9, 5);
  const out = [];
  let w = 0, week = 0;
  for (let t = start; t < start + days * DAY; t += 15 * 60e3) {
    const d = new Date(t), hr = d.getUTCHours(), wd = d.getUTCDay();
    const thisWeek = Math.floor((t - start) / (7 * DAY));
    if (thisWeek !== week) { week = thisWeek; w = 0; }
    const active = (wd === 0 || wd === 6) ? hr >= 9 && hr <= 22 : hr >= 19 && hr <= 23;
    if (active) w = Math.min(100, w + rnd() * 0.5);
    out.push({ t, s: null, sr: null, w: Math.round(w * 10) / 10, wr: (start + (thisWeek + 1) * 7 * DAY) / 1000 });
  }
  return out;
}

test('too little history: nothing is tuned', () => {
  const t = T.tune(history(3));
  assert.equal(t.enough, false);
  assert.match(T.format(t), /Not enough history/);
});

test('a short history never earns a suggestion, however good a setting looks', () => {
  const t = T.tune(history(10));
  assert.equal(t.enough, true);
  assert.ok(t.days < 14);
  assert.equal(t.worthChanging, false);
  assert.match(T.format(t), /too few to tell two settings apart/);
  assert.equal(t.rows.length, T.HALF_LIVES.length * T.SHRINKS.length);
  assert.ok(t.rows.some((r) => r.current), 'the current setting is in the grid, so every row is compared with it');
});

test('a longer history: the verdict follows the numbers, and the same history gives the same answer', () => {
  const h = history(45);
  const a = T.tune(h), b = T.tune(h);
  assert.deepEqual(a, b);
  assert.ok(a.days >= 14);
  assert.equal(a.worthChanging, !!(a.best && !a.best.current && a.best.better));
  for (const r of a.rows) if (r.better) assert.ok(r.vsCurrent < -2 * r.se && r.se > 0);          // "better" means beyond twice the noise
  assert.ok(a.rows.every((r, i, all) => i === 0 || all[i - 1].mae <= r.mae), 'sorted best first');
  const text = T.format(a);
  assert.match(text, /whole days tested/);
  assert.ok(a.worthChanging ? /Suggestion: change to/.test(text) : /No change suggested/.test(text));
});

test('the settings are overridable and the defaults did not move', () => {
  const h = history(20);
  assert.deepEqual(habits.fit(h), habits.fit(h, { halfLifeDays: 7, shrink: 2 }));               // the app's numbers are the defaults
  assert.notDeepEqual(habits.fit(h).wd, habits.fit(h, { halfLifeDays: 2, shrink: 0.5 }).wd);
  assert.deepEqual(habits.backtest(h), habits.backtest(h, {}));
  assert.deepEqual(T.CURRENT, { halfLifeDays: 7, shrink: 2 });
});

test('it only reads: no write, no network, no process in the script', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Scripts', 'usage-tune.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/writeFile|appendFile|child_process|require\(['"]https?['"]\)|net\b|fetch\(/.test(src.replace(/require\('\.\/[^']+'\)/g, '')));
});
