'use strict';
//
// What to tell the owner when Claude Code hits a plan limit (AGEN-45 phase 2). The message is chosen
// from facts only (when the limit resets, the auto-continue setting, the Claude Code version) and is built
// from fixed templates with a time or a day-and-time substituted: nothing from the hook payload or any
// file ever becomes message text. It never sends input anywhere; the event hook stores the text in the
// session's notify field, which both apps already show.
//
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUTO_CONTINUE_SINCE = '2.1.234';   // Claude Code continues by itself at a limit from this version on
const DAY = 24 * 3600e3;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_SETTINGS_BYTES = 64 * 1024;

/** True/false when `v` starts with a version at or above `min`; null when it is not a version at all. */
function versionAtLeast(v, min) {
  if (typeof v !== 'string') return null;
  const a = v.match(/^\s*(\d{1,4})\.(\d{1,4})\.(\d{1,5})/), b = String(min).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return true;
}

/** The reset time (ms) of the fullest plan window that has not reset yet; a tie goes to the sooner one. */
function pickReset(windows, nowMs) {
  if (!Array.isArray(windows)) return undefined;
  let best;
  for (const w of windows) {
    if (!w || typeof w !== 'object') continue;
    const pct = w.usedPercentage, at = w.resetsAt;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 1e9 || at >= 4e9 || at * 1000 <= nowMs) continue;
    if (!best || pct > best.pct || (pct === best.pct && at < best.at)) best = { pct, at };
  }
  return best ? best.at * 1000 : undefined;
}

const two = (n) => String(n).padStart(2, '0');
function when(ms, nowMs) {
  const d = new Date(ms);
  const t = two(d.getHours()) + ':' + two(d.getMinutes());
  return ms - nowMs > DAY ? DAYS[d.getDay()] + ' ' + t : t;
}

/** The notice text for a failed turn, or null when this failure is not a plan limit. */
function limitNotice({ errorType, resetsAtMs, nowMs, autoContinue, version }) {
  if (errorType !== 'rate_limit') return null;
  const reset = typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs) && resetsAtMs > nowMs && resetsAtMs < nowMs + 366 * DAY ? resetsAtMs : undefined;
  const at = reset === undefined ? '' : ' The limit resets at ' + when(reset, nowMs) + '.';
  const head = 'Plan limit reached.';
  if (autoContinue === false) return head + ' Automatic continue is turned off in Claude Code, so it will wait for you.' + at;
  const recent = versionAtLeast(version, AUTO_CONTINUE_SINCE);
  if (recent === false) return head + ' This Claude Code is older than ' + AUTO_CONTINUE_SINCE + ' and does not continue by itself.' + at;
  if (recent === null) return head + at + ' Check Claude Code to see whether it continues by itself.';
  if (reset === undefined) return head + ' Check Claude Code for when it resumes.';
  if (reset - nowMs > DAY) {
    return head + ' The limit resets ' + when(reset, nowMs) + ', more than a day away, so Claude Code will not continue by itself: run /rate-limit-options and choose to wait here.';
  }
  return head + at + ' Claude Code should continue by itself shortly after.';
}

/** `autoContinueAtUsageLimit` from Claude Code's user settings (read only): the value, or undefined if absent or unreadable. */
function readAutoContinue(home = os.homedir()) {
  try {
    const file = path.join(home, '.claude', 'settings.json');
    if (fs.statSync(file).size > MAX_SETTINGS_BYTES) return undefined;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg.autoContinueAtUsageLimit : undefined;
  } catch (e) { return undefined; }
}

module.exports = { limitNotice, pickReset, versionAtLeast, readAutoContinue, AUTO_CONTINUE_SINCE };
