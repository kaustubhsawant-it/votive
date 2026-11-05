#!/usr/bin/env node
'use strict';
//
// Tunes the usage habits model against your own history, and says plainly whether a change is worth making.
//
//   node usage-tune.js [--agent claude-code] [--json]
//
// The model (usage-habits.js) has two settings that matter: how fast old days stop counting (half-life, 7 days) and how hard a
// rarely seen hour is pulled toward the usual shape of the day (shrinkage, 2). This tries a small grid of both, scores each
// with the same leave-one-day-out test the report uses (fit without a day, predict that day's total, compare), and compares
// every setting with the current one day by day. A setting is only called better when it is better by more than twice the
// noise of those day-by-day differences AND at least 14 whole days were tested; before that the honest answer is "not
// distinguishable", because a handful of days cannot tell two settings apart. It never changes anything: it prints a
// suggestion, and the constants in usage-habits.js (and its Swift port) stay as they are until a person edits them.
//
// This is the "training" the model gets: a handful of numbers chosen by backtest, not a bigger model. With a few days of
// hourly points, anything more flexible only memorises them. Passive like the habits script: reads the history file,
// opens no socket, writes nothing, runs nothing.
//
const history = require('./usage-history');
const habits = require('./usage-habits');

const DAY = 24 * 3600e3;
const HALF_LIVES = [2, 3, 5, 7, 10, 14, 30];
const SHRINKS = [0.5, 1, 2, 4, 8];
const CURRENT = { halfLifeDays: 7, shrink: 2 };
const SURE_DAYS = 14;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };

/** Absolute error, per whole day, of the leave-one-day-out forecast of that day's points. */
function dayErrors(samples, opts) {
  const full = habits.fit(samples, opts);
  return full.days.map((d) => {
    const m = habits.fit(samples, Object.assign({}, opts, { skipDay: d.key }));
    return { key: d.key, err: Math.abs(habits.expectedBetween(m, d.start, d.start + DAY) - d.total), total: d.total };
  });
}

function tune(samples) {
  const base = dayErrors(samples, CURRENT);
  const n = base.length;
  if (n < 4) return { enough: false, days: n };
  const averageDay = mean(base.map((d, i) => Math.abs(mean(base.filter((_, j) => j !== i).map((x) => x.total)) - d.total)));
  const rows = [];
  for (const halfLifeDays of HALF_LIVES) for (const shrink of SHRINKS) {
    const opts = { halfLifeDays, shrink };
    const errs = dayErrors(samples, opts);
    if (errs.length !== n) continue;                                // the same days for a fair pairing
    const diffs = errs.map((e, i) => e.err - base[i].err);          // negative = better than the current setting
    const mae = mean(errs.map((e) => e.err));
    const se = sd(diffs) / Math.sqrt(n);
    const better = n >= SURE_DAYS && mean(diffs) < -2 * se && se > 0;
    rows.push({ halfLifeDays, shrink, mae, vsCurrent: mean(diffs), se, better, current: halfLifeDays === CURRENT.halfLifeDays && shrink === CURRENT.shrink });
  }
  rows.sort((a, b) => a.mae - b.mae);
  const currentRow = rows.find((r) => r.current);
  const best = rows[0];
  const worthChanging = !!best && !best.current && best.better;
  return { enough: true, days: n, averageDayMae: averageDay, current: currentRow, best, worthChanging, rows, sureDays: SURE_DAYS };
}

const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

function format(t) {
  if (!t.enough) return 'Not enough history yet to tune anything: ' + t.days + ' whole days seen, at least 4 are needed.';
  const out = [];
  out.push(t.days + ' whole days tested, each predicted without being seen. Error in points of the weekly limit (lower is better):');
  out.push('  an average day: ' + f1(t.averageDayMae) + '   current setting (half-life ' + t.current.halfLifeDays + ' days, shrink ' + t.current.shrink + '): ' + f1(t.current.mae));
  out.push('  best of ' + t.rows.length + ' settings tried: half-life ' + t.best.halfLifeDays + ' days, shrink ' + t.best.shrink + ': ' + f1(t.best.mae) + (t.best.current ? ' (it is the current one)' : ''));
  if (t.worthChanging) {
    out.push('Suggestion: change to half-life ' + t.best.halfLifeDays + ', shrink ' + t.best.shrink + '. It is better than the current setting by ' + f1(-t.best.vsCurrent) + ' points a day, more than twice the noise of that difference (' + f1(t.best.se) + ').');
  } else if (t.days < t.sureDays) {
    out.push('No change suggested: ' + t.days + ' days are too few to tell two settings apart (' + t.sureDays + ' are needed). Run this again when there are more.');
  } else {
    out.push('No change suggested: no setting beats the current one by more than the noise.');
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const ai = args.indexOf('--agent');
  const agent = ai !== -1 && args[ai + 1] ? args[ai + 1] : 'claude-code';
  const t = tune(history.read(agent));
  console.log(args.includes('--json') ? JSON.stringify(t, null, 2) : format(t));
}

if (require.main === module) main();
module.exports = { tune, format, dayErrors, HALF_LIVES, SHRINKS, CURRENT };
