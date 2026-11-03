#!/usr/bin/env node
'use strict';
//
// Usage habits: learns when you use your Claude plan from the usage history (usage-history.js), forecasts
// where the weekly limit will stand at the reset, and says what that means in plain sentences.
//
//   node usage-habits.js [--target 80] [--agent claude-code] [--json]
//
// It is a small statistical model, not a neural network, on purpose. The history is a few percentage points
// per hour, so a model with thousands of parameters would only memorise it. This one has a handful:
//   - points used per local hour, from the rise of the weekly percentage between samples (a window reset is
//     never counted as use);
//   - an expected value per (weekday or weekend, hour of day), weighted so last week counts more than three
//     weeks ago (half-life 7 days), and pulled toward the average for that hour of the day when a cell has
//     been seen only a few times (shrinkage), so one odd Saturday cannot set the whole pattern;
//   - the forecast adds the expected points for every hour left until the reset, with a range from how much
//     whole days differ from each other.
// Every claim it prints is checked against the data: a leave-one-day-out test says whether the model predicts
// a day's use better than just "an average day", and the report says so when it does not.
//
// Private and passive: it only reads the history file (percentages and reset times, never a prompt, path or
// session id), opens no socket, writes nothing and runs nothing. It gives advice; it never acts.
//
const history = require('./usage-history');

const HOUR = 3600e3, DAY = 24 * HOUR;
const MAX_GAP_H = 12;          // a gap between samples longer than this is spread over its last 12 hours only
const HALF_LIFE_DAYS = 7;
const SHRINK = 2;              // the prior counts as two sightings of a cell
const MIN_DAYS_FORECAST = 2;   // fewer fully seen days than this: no forecast
const MIN_DAYS_RANGE = 4;      // fewer than this: no range
const MIN_DAYS_BACKTEST = 4;
const SURE_DAYS = 14;          // fewer days than this never earn a "better than average" verdict

const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const isWeekend = (ms) => { const w = new Date(ms).getDay(); return w === 0 || w === 6; };
const hourOf = (ms) => new Date(ms).getHours();
// The start of the local clock hour. Aligned to the local zone, not to UTC, so a half-hour zone (India, UTC+5:30)
// still has hours that begin on :00 by the wall clock.
const startOfHour = (ms) => { const off = new Date(ms).getTimezoneOffset() * 60000; return Math.floor((ms - off) / HOUR) * HOUR + off; };

/**
 * Points used in each local clock hour, as { cells: Map<hourStartMs, points>, first, last }.
 * Every hour from the first sample to the last is present; an hour with no sample is an hour of no use.
 */
function hourlyUse(samples) {
  const cells = new Map();
  if (samples.length < 2) return { cells, first: null, last: null };
  const touch = (h) => { if (!cells.has(h)) cells.set(h, 0); };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.w === null || b.w === null || a.wr !== b.wr) continue;     // a reset between two samples: skip the pair
    const delta = Math.max(0, b.w - a.w);
    const from = Math.max(a.t, b.t - MAX_GAP_H * HOUR);
    const first = startOfHour(from), last = startOfHour(b.t - 1);
    if (last < first) continue;
    const n = Math.round((last - first) / HOUR) + 1;
    for (let k = 0; k < n; k++) {
      const h = first + k * HOUR;
      touch(h);
      cells.set(h, cells.get(h) + delta / n);
    }
  }
  // The status line only reports while an agent is running, so an hour inside the history with no sample at all
  // is an hour of no use (the same rule usage-pacing.js follows), not an unknown.
  for (let h = startOfHour(samples[0].t); h <= startOfHour(samples[samples.length - 1].t); h += HOUR) touch(h);
  return { cells, first: samples[0].t, last: samples[samples.length - 1].t };
}

/** A cell counts as fully seen when the history covers the whole clock hour. */
function fullyCovered(h, use) { return use.first !== null && h >= startOfHour(use.first) + HOUR && h + HOUR <= use.last; }

/**
 * Fits the model. `until` (ms) ignores anything after it and `skipDay` leaves one local day out, which is how the
 * backtest keeps its test honest.
 */
function fit(samples, opts = {}) {
  const use = hourlyUse(samples);
  const now = opts.now === undefined ? (use.last === null ? 0 : use.last) : opts.now;
  const wsum = { we: new Array(24).fill(0), wd: new Array(24).fill(0), any: new Array(24).fill(0) };
  const sum = { we: new Array(24).fill(0), wd: new Array(24).fill(0), any: new Array(24).fill(0) };
  const count = { we: new Array(24).fill(0), wd: new Array(24).fill(0) };
  const days = new Map();                                            // dayKey -> { total, hours, weekend, start }
  for (const [h, pts] of use.cells) {
    if (!fullyCovered(h, use)) continue;
    const key = dayKey(h);
    if (opts.skipDay !== undefined && key === opts.skipDay) continue;
    const w = Math.pow(0.5, Math.max(0, now - h) / DAY / HALF_LIFE_DAYS);
    const t = isWeekend(h) ? 'we' : 'wd', hr = hourOf(h);
    wsum[t][hr] += w; sum[t][hr] += w * pts; count[t][hr] += 1;
    wsum.any[hr] += w; sum.any[hr] += w * pts;
    const d = days.get(key) || { total: 0, hours: 0, weekend: isWeekend(h), start: h };
    if (h < d.start) d.start = h;                                    // cells arrive out of order across a long gap
    d.total += pts; d.hours += 1; days.set(key, d);
  }
  const anyMean = wsum.any.map((w, i) => (w > 0 ? sum.any[i] / w : 0));
  const cellMean = (t, hr) => (wsum[t][hr] > 0 ? sum[t][hr] / wsum[t][hr] : null);
  // The prior for a cell is the usual shape of the hour of the day, scaled by how busy this kind of day is
  // compared with an average day (a weekend day is several times a weekday). With little data the cell leans on
  // that prior; with a lot it speaks for itself.
  const anyDaily = anyMean.reduce((x, y) => x + y, 0);
  const model = { we: [], wd: [], anyMean, scale: {}, days: [] };
  for (const t of ['we', 'wd']) {
    let daily = 0, seenHours = 0;
    for (let hr = 0; hr < 24; hr++) { const c = cellMean(t, hr); if (c !== null) { daily += c; seenHours += 1; } }
    // How many different days of this kind fed the cells; one busy Saturday is not yet a weekend habit.
    const nDays = new Set([...days.values()].filter((d) => d.weekend === (t === 'we')).map((d) => dayKey(d.start))).size;
    const raw = anyDaily > 0 && seenHours === 24 ? daily / anyDaily : 1;
    model.scale[t] = (nDays * raw + SHRINK) / (nDays + SHRINK);
    for (let hr = 0; hr < 24; hr++) {
      const prior = anyMean[hr] * model.scale[t];
      const c = cellMean(t, hr), n = count[t][hr];
      model[t][hr] = c === null ? prior : (n * c + SHRINK * prior) / (n + SHRINK);
    }
  }
  // Whole days seen end to end (24 hours) are the unit for the spread and the backtest.
  for (const [key, d] of days) if (d.hours === 24) model.days.push({ key, total: d.total, weekend: d.weekend, start: d.start });
  model.days.sort((x, y) => x.start - y.start);
  model.trainedOn = days.size;
  return model;
}

/** Expected points in the clock hour that starts at `h`. */
const expectedHour = (model, h) => (isWeekend(h) ? model.we : model.wd)[hourOf(h)];

/** Expected points between `from` and `to` (ms). */
function expectedBetween(model, from, to) {
  let sum = 0;
  for (let t = from; t < to;) {
    const hs = startOfHour(t), next = Math.min(to, hs + HOUR);
    sum += expectedHour(model, hs) * ((next - t) / HOUR);
    t = next;
  }
  return sum;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };

/**
 * Leave-one-day-out: for each whole day, fit without it and predict its total. The comparison is "an average
 * day" (the mean of the other days), the simplest thing a model has to beat.
 */
function backtest(samples) {
  const full = fit(samples);
  if (full.days.length < MIN_DAYS_BACKTEST) return { days: full.days.length, enough: false };
  let errModel = 0, errBase = 0;
  for (const d of full.days) {
    const m = fit(samples, { skipDay: d.key });
    let predicted = 0;
    for (let k = 0; k < 24; k++) predicted += expectedHour(m, d.start + k * HOUR);
    const others = full.days.filter((x) => x.key !== d.key).map((x) => x.total);
    errModel += Math.abs(predicted - d.total);
    errBase += Math.abs(mean(others) - d.total);
  }
  const n = full.days.length;
  return { enough: true, days: n, maeModel: errModel / n, maeBaseline: errBase / n, beatsBaseline: errModel < errBase };
}

/** Latest sample that carries the weekly window, or null when that window has already reset. */
function currentWeekly(samples, now) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const x = samples[i];
    if (x.w === null || x.wr === null) continue;
    return x.wr * 1000 > now ? x : null;
  }
  return null;
}

function analyse(samples, opts = {}) {
  const target = opts.target === undefined ? 80 : opts.target;
  const now = opts.now === undefined ? (samples.length ? samples[samples.length - 1].t : Date.now()) : opts.now;
  const model = fit(samples, { now });
  const out = { now, target, samples: samples.length, daysSeen: model.days.length, trainedOn: model.trainedOn,
    rhythm: null, forecast: null, backtest: null, insights: [] };
  if (!samples.length) return out;

  // Where the use sits (all fully seen hours, recency-weighted would hide the story, so plain totals here).
  const use = hourlyUse(samples);
  const byHour = new Array(24).fill(0), weekdayDaytime = { used: 0, all: 0 };
  let total = 0, weekendTotal = 0, weekdayTotal = 0, weekendDays = new Set(), weekdayDays = new Set();
  for (const [h, pts] of use.cells) {
    if (!fullyCovered(h, use)) continue;
    byHour[hourOf(h)] += pts; total += pts;
    if (isWeekend(h)) { weekendTotal += pts; weekendDays.add(dayKey(h)); } else { weekdayTotal += pts; weekdayDays.add(dayKey(h)); }
    weekdayDaytime.all += pts;
    if (!isWeekend(h) && hourOf(h) >= 9 && hourOf(h) < 18) weekdayDaytime.used += pts;
  }
  if (total > 0) {
    // The 4-hour stretch (wrapping past midnight) that holds the most use.
    let best = 0, bestAt = 0;
    for (let s = 0; s < 24; s++) {
      let m = 0;
      for (let k = 0; k < 4; k++) m += byHour[(s + k) % 24];
      if (m > best) { best = m; bestAt = s; }
    }
    out.rhythm = {
      peakStart: bestAt, peakEnd: (bestAt + 4) % 24, peakShare: best / total,
      weekdayPerDay: weekdayDays.size ? weekdayTotal / weekdayDays.size : null,
      weekendPerDay: weekendDays.size ? weekendTotal / weekendDays.size : null,
      weekdayDaytimeShare: weekdayDaytime.all ? weekdayDaytime.used / weekdayDaytime.all : null,
      totalPoints: total,
    };
  }

  const ws = currentWeekly(samples, now);
  if (ws && model.days.length >= MIN_DAYS_FORECAST) {
    const resetsAt = ws.wr * 1000;
    const expected = expectedBetween(model, now, resetsAt);
    const spread = model.days.length >= MIN_DAYS_RANGE ? sd(model.days.map((d) => d.total)) : null;
    const daysLeft = Math.max(0, (resetsAt - now) / DAY);
    const half = spread === null ? null : 1.28 * spread * Math.sqrt(daysLeft);   // roughly the middle 80%
    const projected = ws.w + expected;
    out.forecast = {
      used: ws.w, resetsAt, hoursLeft: (resetsAt - now) / HOUR, expectedMore: expected, projected,
      low: half === null ? null : Math.max(ws.w, projected - half), high: half === null ? null : Math.min(999, projected + half),
      spare: Math.max(0, target - projected), over: Math.max(0, projected - target),
    };
  }
  out.backtest = backtest(samples);

  // Plain sentences.
  const r = out.rhythm, f = out.forecast, b = out.backtest;
  const hh = (n) => String(n).padStart(2, '0') + ':00';
  const pct = (v) => Math.round(v) + '%';
  if (r) {
    out.insights.push('Most of your use (' + pct(r.peakShare * 100) + ') falls between ' + hh(r.peakStart) + ' and ' + hh(r.peakEnd) + '.');
    if (r.weekdayPerDay !== null && r.weekendPerDay !== null) {
      out.insights.push('Weekdays average ' + (Math.round(r.weekdayPerDay * 10) / 10) + ' points a day, weekend days ' + (Math.round(r.weekendPerDay * 10) / 10) + '.');
    }
    if (r.weekdayDaytimeShare !== null && r.weekdayDaytimeShare < 0.1 && weekdayDays.size >= 2) {
      out.insights.push('Weekday working hours (09:00 to 18:00) hold ' + (r.weekdayDaytimeShare < 0.005 ? 'almost none' : 'only ' + pct(r.weekdayDaytimeShare * 100)) + ' of your use, so the limit is spent in the evening and at the weekend.');
    }
  }
  if (f) {
    const range = f.low !== null ? ' (likely ' + pct(f.low) + ' to ' + pct(f.high) + ')' : '';
    out.insights.push('Forecast at the reset: ' + pct(f.projected) + range + ' of the weekly limit, from ' + pct(f.used) + ' now.');
    if (f.projected >= 100) out.insights.push('At your usual pace the limit runs out before the reset; move big jobs after it.');
    else if (f.over > 0) out.insights.push('That is ' + pct(f.over) + ' over your ' + target + '% target.');
    else if (f.spare >= 5) out.insights.push('About ' + pct(f.spare) + ' of the week is likely to go unused against your ' + target + '% target. A longer job in your usual ' + hh(r ? r.peakStart : 20) + ' stretch would use it.');
    else out.insights.push('That is close to your ' + target + '% target.');
  } else if (ws) {
    out.insights.push('Not enough days seen yet for a forecast (' + model.days.length + ' whole days; it needs ' + MIN_DAYS_FORECAST + ').');
  } else {
    out.insights.push('No current weekly reading: nothing has been recorded since the last reset.');
  }
  if (b.enough) {
    const m = Math.round(b.maeModel * 10) / 10, base = Math.round(b.maeBaseline * 10) / 10;
    const clear = b.beatsBaseline && b.maeModel <= 0.9 * b.maeBaseline && b.days >= SURE_DAYS;
    out.insights.push('Check: on days it had not seen, it was off by ' + m + ' points against ' + base + ' for "an average day". '
      + (clear ? 'It predicts your days better than a plain average.'
        : b.beatsBaseline ? 'That is slightly better, but ' + b.days + ' days is too few to be sure, so read the range, not the single number.'
        : 'It is not better yet, so treat the forecast as a rough guess.'));
  } else {
    out.insights.push('Too early to test it: ' + b.days + ' whole days seen, it needs ' + MIN_DAYS_BACKTEST + '. Four weeks of history will make this far more reliable.');
  }
  return out;
}

function format(a) {
  if (!a.samples) return 'No usage history yet. It starts after the next Claude Code status-line refresh.';
  return a.insights.map((s) => '- ' + s).join('\n') + '\nBased on ' + a.samples + ' samples, ' + a.daysSeen + ' whole days.';
}

function main() {
  const args = process.argv.slice(2);
  const ai = args.indexOf('--agent'), ti = args.indexOf('--target');
  const agent = ai !== -1 && args[ai + 1] ? args[ai + 1] : 'claude-code';
  const target = ti !== -1 && args[ti + 1] !== undefined ? Number(args[ti + 1]) : 80;
  const a = analyse(history.read(agent), { target: Number.isFinite(target) ? target : 80 });
  console.log(args.includes('--json') ? JSON.stringify(a, null, 2) : format(a));
}

if (require.main === module) main();
module.exports = { hourlyUse, fit, expectedBetween, backtest, analyse, format };
