#!/usr/bin/env node
'use strict';
//
// Pacing advisor: from the usage history (usage-history.js) it says how fast the weekly limit
// is being used, how much can be spent per day to land near a target (default 80%), whether the
// limit will run out before it resets, and when the 5-hour session window lifts.
//
//   node usage-pacing.js [--target 80] [--conserve 85] [--agent claude-code] [--json]
//
// The forecast is plain arithmetic, so every number can be checked by hand:
//   - recent pace: points used per hour over the last 24 h of the current window (else the
//     average since the window began), carried to the reset;
//   - learned profile: once there are 7 days of history, the average points used in each
//     hour of the week replaces the single recent pace, so a quiet work week and a busy
//     weekend are forecast differently. Hours with no samples count as zero use.
// Nothing here is a trained model; it only becomes one if the data justifies it.
//
const history = require('./usage-history');

const HOUR = 3600e3, DAY = 24 * HOUR;
const WEEK_H = 168;
const PROFILE_MIN_DAYS = 7;
const MAX_GAP_H = 12;
const UNDER_MARGIN = 15;
const OVER_MARGIN = 5;

/** Latest sample that carries this window, or null when that window has already reset. */
function latest(samples, key, rkey, now) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const x = samples[i];
    if (x[key] === null || x[rkey] === null) continue;
    return x[rkey] * 1000 > now ? x : null;
  }
  return null;
}

/** Points per hour inside one window over the last `spanMs`, or null with under an hour of data. */
function recentRate(samples, key, rkey, resets, now, spanMs) {
  const inWin = samples.filter((x) => x[key] !== null && x[rkey] === resets && x.t >= now - spanMs);
  if (inWin.length < 2) return null;
  const a = inWin[0], b = inWin[inWin.length - 1];
  const h = (b.t - a.t) / HOUR;
  if (h < 1) return null;
  return Math.max(0, (b[key] - a[key]) / h);
}

const bucketOf = (ms) => { const d = new Date(ms); return d.getDay() * 24 + d.getHours(); };

/** Average weekly points used in each hour of the week (0 = Sunday 00:00, local time). */
function learnProfile(samples) {
  const total = new Array(WEEK_H).fill(0);
  const occurrences = new Array(WEEK_H).fill(0);
  if (samples.length < 2) return { mean: total, observedDays: 0 };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.w === null || b.w === null || a.wr !== b.wr) continue;
    const delta = Math.max(0, b.w - a.w);
    const from = Math.max(a.t, b.t - MAX_GAP_H * HOUR);
    const first = Math.floor(from / HOUR), last = Math.floor((b.t - 1) / HOUR);
    if (last < first) continue;
    const share = delta / (last - first + 1);
    for (let s = first; s <= last; s++) total[bucketOf(s * HOUR)] += share;
  }
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  for (let s = Math.floor(t0 / HOUR); s <= Math.floor(t1 / HOUR); s++) occurrences[bucketOf(s * HOUR)] += 1;
  return {
    mean: total.map((v, i) => (occurrences[i] ? v / occurrences[i] : 0)),
    observedDays: Math.ceil((t1 - t0) / DAY),
  };
}

/** Points the profile expects to be used between `from` and `to` (ms). */
function forecast(profile, from, to) {
  let sum = 0;
  for (let t = from; t < to;) {
    const next = Math.min(to, (Math.floor(t / HOUR) + 1) * HOUR);
    sum += profile.mean[bucketOf(t)] * ((next - t) / HOUR);
    t = next;
  }
  return sum;
}

function runOutAt(used, now, resetsAt, rate, profile) {
  if (profile) {
    let acc = used;
    for (let t = now; t < resetsAt; t += HOUR) {
      acc += profile.mean[bucketOf(t)];
      if (acc >= 100) return t;
    }
    return null;
  }
  if (!rate || rate <= 0) return null;
  const t = now + ((100 - used) / rate) * HOUR;
  return t < resetsAt ? t : null;
}

function advise(samples, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const target = opts.target === undefined ? 80 : opts.target;
  const conserve = opts.conserve === undefined ? 85 : opts.conserve;
  const out = { now, target, conserve, samples: samples.length, weekly: null, session: null };

  const ws = latest(samples, 'w', 'wr', now);
  if (ws) {
    const used = ws.w, resetsAt = ws.wr * 1000;
    const hoursLeft = (resetsAt - now) / HOUR;
    const elapsedH = Math.max(0, WEEK_H - hoursLeft);
    const toSpend = Math.max(0, target - used);
    const profile = learnProfile(samples);
    const useProfile = profile.observedDays >= PROFILE_MIN_DAYS;
    const recent = recentRate(samples, 'w', 'wr', ws.wr, now, DAY);
    const rate = recent !== null ? recent : (elapsedH > 1 ? used / elapsedH : null);
    let projected = null, method = 'none';
    if (useProfile) { projected = used + forecast(profile, now, resetsAt); method = 'weekly profile'; }
    else if (rate !== null) { projected = used + rate * hoursLeft; method = 'recent pace'; }
    let status = 'unknown';
    if (used >= 95) status = 'critical';
    else if (projected !== null) {
      if (projected >= 100) status = 'will_run_out';
      else if (projected > target + OVER_MARGIN) status = 'ahead';
      else if (projected < target - UNDER_MARGIN) status = 'behind';
      else status = 'on_track';
    }
    out.weekly = {
      used, resetsAt, hoursLeft, target,
      evenPaceNow: target * elapsedH / WEEK_H,
      toSpend, perDay: hoursLeft > 0 ? toSpend / (hoursLeft / 24) : 0,
      rate, projected, method, status,
      runOutAt: status === 'will_run_out' || status === 'critical'
        ? runOutAt(used, now, resetsAt, rate, useProfile ? profile : null) : null,
      learning: !useProfile, observedDays: profile.observedDays,
    };
  }

  const ss = latest(samples, 's', 'sr', now);
  if (ss) {
    out.session = {
      used: ss.s, resetsAt: ss.sr * 1000, minutesLeft: (ss.sr * 1000 - now) / 60000,
      status: ss.s >= conserve ? 'conserve' : 'ok',
    };
  }
  return out;
}

const fmtTime = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
function fmtHours(h) {
  if (h < 1) return Math.max(0, Math.round(h * 60)) + ' min';
  if (h < 48) return Math.floor(h) + ' h ' + String(Math.round((h % 1) * 60)).padStart(2, '0') + ' min';
  return (h / 24).toFixed(1) + ' days';
}
const pct = (v) => Math.round(v * 10) / 10 + '%';

function format(a) {
  const lines = [];
  const w = a.weekly;
  if (w) {
    lines.push('Weekly limit: ' + pct(w.used) + ' used, resets ' + fmtTime(w.resetsAt) + ' (in ' + fmtHours(w.hoursLeft) + '). Target ' + a.target + '%.');
    lines.push('  Even pace would be ' + pct(w.evenPaceNow) + ' by now; you can spend about ' + pct(w.toSpend) + ' more, ' + pct(w.perDay) + ' per day if spread evenly.');
    if (w.projected !== null) {
      lines.push('  Forecast at the reset: ' + pct(Math.min(w.projected, 999)) + ' (' + w.method + (w.rate !== null && w.method === 'recent pace' ? ', ' + (Math.round(w.rate * 100) / 100) + '%/h' : '') + ').');
    } else {
      lines.push('  Not enough history for a forecast yet.');
    }
    const say = {
      critical: '  Nearly out: stop heavy work, write handoffs, wait for the reset.',
      will_run_out: '  At this pace the limit runs out' + (w.runOutAt ? ' around ' + fmtTime(w.runOutAt) : ' before the reset') + '. Slow down or move big jobs after the reset.',
      ahead: '  Ahead of target: ease off by about ' + pct(Math.max(0, w.projected - a.target)) + ' to land on ' + a.target + '%.',
      behind: '  Under target: room for about ' + pct(Math.max(0, a.target - w.projected)) + ' more, so heavier or longer tasks are fine.',
      on_track: '  On track for the target.',
      unknown: '  No pace yet.',
    };
    lines.push(say[w.status]);
    if (w.learning) lines.push('  Learning your week: the hour-by-hour profile is used after ' + PROFILE_MIN_DAYS + ' days of history (' + w.observedDays + ' so far).');
  } else {
    lines.push('Weekly limit: no current reading (no sample yet, or the window has reset). Use Claude Code once and rerun.');
  }
  const s = a.session;
  if (s) {
    lines.push('Session window: ' + pct(s.used) + ' used, lifts ' + fmtTime(s.resetsAt) + ' (in ' + fmtHours(s.minutesLeft / 60) + ').'
      + (s.status === 'conserve' ? ' Conserve: finish the current task, write a handoff, avoid subagents until it lifts.' : ''));
  }
  lines.push('Based on ' + a.samples + ' samples.');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const val = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] !== undefined ? Number(args[i + 1]) : def; };
  const agentIdx = args.indexOf('--agent');
  const agent = agentIdx !== -1 && args[agentIdx + 1] ? args[agentIdx + 1] : 'claude-code';
  const samples = history.read(agent);
  if (!samples.length) {
    console.log('No usage history yet. It starts after the next Claude Code status-line refresh once the updated scripts are installed.');
    return;
  }
  const a = advise(samples, { target: val('--target', 80), conserve: val('--conserve', 85) });
  console.log(args.includes('--json') ? JSON.stringify(a, null, 2) : format(a));
}

if (require.main === module) main();
module.exports = { advise, format, learnProfile, forecast, recentRate, latest };
