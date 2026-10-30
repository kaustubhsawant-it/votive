'use strict';
//
// The usage history recorder and the pacing advisor. Runs in a scratch HOME, in UTC, so the
// hour-of-week profile is deterministic.
//
//   node --test tests/*.test.js
//
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-usage-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const history = require('../Scripts/usage-history');
const pacing = require('../Scripts/usage-pacing');
const POSIX = process.platform !== 'win32';   // file modes only mean something on Unix

const HOUR = 3600e3, DAY = 24 * HOUR;
const win = (s, sr, w, wr) => [
  { label: 'Session', usedPercentage: s, resetsAt: sr },
  { label: 'Weekly', usedPercentage: w, resetsAt: wr },
];
const reset = () => { try { fs.rmSync(path.dirname(history.fileFor('x')), { recursive: true }); } catch (e) {} };

test('history: throttled, private, and only percentages and reset times', () => {
  reset();
  const t0 = Date.UTC(2026, 9, 14, 12, 0, 0);
  const wr = Math.floor((t0 + 5 * DAY) / 1000), sr = Math.floor((t0 + 2 * HOUR) / 1000);
  assert.equal(history.append('x', win(10, sr, 20, wr), t0), true);
  assert.equal(history.append('x', win(10, sr, 20, wr), t0 + 60e3), false, 'same values within 5 min are skipped');
  assert.equal(history.append('x', win(10.4, sr, 20.4, wr), t0 + 120e3), false, 'moves under a point are skipped');
  assert.equal(history.append('x', win(12, sr, 20, wr), t0 + 180e3), true, 'a point of movement is kept');
  assert.equal(history.append('x', win(12, sr + 18000, 20, wr), t0 + 240e3), true, 'a window reset is kept');
  assert.equal(history.append('x', win(12, sr + 18000, 20, wr), t0 + 10 * 60e3), true, 'after 5 min it is kept');
  assert.equal(history.append('x', [], t0 + 20 * 60e3), false, 'nothing to record');
  const file = history.fileFor('x');
  if (POSIX) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['s', 'sr', 't', 'w', 'wr']);
});

test('history: torn and foreign lines are skipped, and the file is trimmed past 1 MB', () => {
  reset();
  const file = history.fileFor('x');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.UTC(2026, 9, 14, 12, 0, 0);
  const good = JSON.stringify({ t: t0, s: 1, sr: 1792272600, w: 2, wr: 1792368000 });
  fs.writeFileSync(file, 'not json\n' + good + '\n{"t":"x"}\n{"t":' + (t0 + 1) + ',"s":3');
  assert.equal(history.read('x').length, 1);
  const line = JSON.stringify({ t: t0, s: 1, sr: 1792272600, w: 2, wr: 1792368000 }) + '\n';
  fs.writeFileSync(file, line.repeat(Math.ceil((history.MAX_BYTES + 1000) / line.length)));
  history.append('x', win(50, 1792272600, 60, 1792368000), t0 + DAY);
  assert.ok(fs.statSync(file).size <= history.MAX_BYTES, 'trimmed');
  assert.deepEqual(history.read('x').slice(-1)[0].w, 60, 'the newest sample survives');
});

test('history: refuses links, tightens a loose folder, and ignores out-of-range or oversized data', () => {
  reset();
  const t0 = Date.UTC(2026, 9, 14, 12, 0, 0);
  const sr = 1792272600, wr = 1792368000;
  const dir = path.dirname(history.fileFor('x'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-other-'));

  // a symlink in place of the file: nothing is written through it, and reading gives nothing
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(elsewhere, 'victim.txt');
  fs.writeFileSync(target, 'untouched\n');
  fs.symlinkSync(target, history.fileFor('x'));
  assert.equal(history.append('x', win(10, sr, 20, wr), t0), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n');
  assert.deepEqual(history.read('x'), []);

  // a symlink in place of the folder
  fs.rmSync(dir, { recursive: true });
  fs.symlinkSync(elsewhere, dir);
  assert.equal(history.append('x', win(10, sr, 20, wr), t0), false);
  assert.deepEqual(fs.readdirSync(elsewhere), ['victim.txt'], 'nothing was created in the link target');
  fs.unlinkSync(dir);

  // a loose folder is tightened to 0700 before anything is written
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  assert.equal(history.append('x', win(10, sr, 20, wr), t0), true);
  if (POSIX) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  // out-of-range values are refused on write and skipped on read
  assert.equal(history.append('x', win(150, sr, 20, wr), t0 + DAY), false, 'percent above 100');
  assert.equal(history.append('x', win(10, 5, 20, wr), t0 + DAY), false, 'reset time that is not a time');
  const file = history.fileFor('x');
  fs.appendFileSync(file, JSON.stringify({ t: t0, s: -5, sr, w: 20, wr }) + '\n' + JSON.stringify({ t: 1, s: 1, sr, w: 1, wr }) + '\n');
  assert.equal(history.read('x').length, 1);

  // an oversized file is not read at all
  fs.writeFileSync(file, 'x'.repeat(history.MAX_BYTES * 2 + 10));
  assert.deepEqual(history.read('x'), []);
});

// Window: weekly reset 5 days away, so 48 of 168 hours have passed.
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const WR = Math.floor((NOW + 5 * DAY) / 1000), SR = Math.floor((NOW + 2 * HOUR) / 1000);
const mk = (t, s, w, wr = WR, sr = SR) => ({ t, s, sr, w, wr });

test('advise: on track, behind, ahead, will run out, critical', () => {
  const run = (used, before) => pacing.advise([mk(NOW - DAY, 5, before), mk(NOW, 5, used)], { now: NOW }).weekly;
  const onTrack = run(20, 10);
  assert.equal(onTrack.status, 'on_track');
  assert.ok(Math.abs(onTrack.perDay - 12) < 1e-9, 'spend 60 points over 5 days');
  assert.ok(Math.abs(onTrack.projected - 70) < 0.01);
  assert.equal(run(5, 4).status, 'behind');
  assert.equal(run(40, 30).status, 'ahead');
  const out = run(50, 25);
  assert.equal(out.status, 'will_run_out');
  assert.ok(Math.abs(out.runOutAt - (NOW + 48 * HOUR)) < 60e3, 'runs out about 48 h from now');
  assert.equal(run(96, 90).status, 'critical');
});

test('advise: a reset window is not read, and samples from the old window are ignored', () => {
  const stale = pacing.advise([mk(NOW - 2 * DAY, 5, 60, Math.floor((NOW - HOUR) / 1000))], { now: NOW });
  assert.equal(stale.weekly, null);
  const samples = [mk(NOW - 30 * HOUR, 5, 90, WR - 7 * 86400), mk(NOW - 1.5 * HOUR, 5, 1), mk(NOW, 5, 2)];
  const w = pacing.advise(samples, { now: NOW }).weekly;
  assert.ok(Math.abs(w.rate - 1 / 1.5) < 1e-9, 'rate uses only the current window');
});

test('advise: session window says conserve at the threshold and when it lifts', () => {
  const lo = pacing.advise([mk(NOW, 40, 20)], { now: NOW }).session;
  const hi = pacing.advise([mk(NOW, 90, 20)], { now: NOW }).session;
  assert.equal(lo.status, 'ok');
  assert.equal(hi.status, 'conserve');
  assert.ok(Math.abs(hi.minutesLeft - 120) < 1e-9);
  assert.equal(pacing.advise([mk(NOW, 90, 20)], { now: NOW, conserve: 95 }).session.status, 'ok');
});

test('advise: no history gives no readings rather than a guess', () => {
  const a = pacing.advise([], { now: NOW });
  assert.equal(a.weekly, null);
  assert.equal(a.session, null);
  assert.match(pacing.format(a), /no current reading/);
});

test('profile: learns the hours of the week and takes over the forecast after 7 days', () => {
  // Nine days from Mon 5 Oct, 2 points a day between 10:00 and 12:00 UTC, nothing otherwise.
  const t0 = Date.UTC(2026, 9, 5, 0, 0, 0), wr = Math.floor((t0 + 30 * DAY) / 1000);
  const samples = [];
  let used = 0;
  for (let d = 0; d < 9; d++) {
    const day = t0 + d * DAY;
    samples.push(mk(day + 10 * HOUR, 0, used, wr, 0));
    samples.push(mk(day + 11 * HOUR, 0, used += 1, wr, 0));
    samples.push(mk(day + 12 * HOUR, 0, used += 1, wr, 0));
  }
  const profile = pacing.learnProfile(samples);
  assert.ok(profile.observedDays >= 7);
  const from = t0 + 9 * DAY, to = from + DAY;
  assert.ok(Math.abs(pacing.forecast(profile, from, to) - 2) < 0.01, 'two points expected tomorrow');
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  const a = pacing.advise(samples, { now, target: 80 }).weekly;
  assert.equal(a.method, 'weekly profile');
  assert.equal(a.learning, false);
  const short = pacing.advise(samples.slice(0, 6), { now: t0 + 2 * DAY }).weekly;
  assert.equal(short.learning, true, 'too little history to use the profile');
});
