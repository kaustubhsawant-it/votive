#!/usr/bin/env node
'use strict';
//
// A short report for closed-beta testers to paste into a message: how budget mode is set up, what plan
// usage is right now, whether Claude Code continues by itself at a limit, and what the budget mod did over
// the last 14 days (counts only). It prints settings and numbers and nothing else: no paths, no folder or
// project names, no prompts, and no text from any file, since every value is read through the same strict
// parsers the mod uses and printed through fixed labels. It makes no network call and starts no program.
//
//   node Scripts/budget-report.js
//
const fs = require('fs');
const path = require('path');
const P = require('./overlay-paths');
const policy = require('./budget-policy');
const limits = require('./limit-notify');

const MAX_BYTES = 64 * 1024;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;

function readSmall(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (e) { return ''; }
}

function json(text) { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }

/** Whole-percent usage of the window with this label, or null (missing, malformed, or already reset). */
function windowPercent(windows, label, nowMs) {
  if (!Array.isArray(windows)) return null;
  for (const w of windows) {
    if (!w || typeof w !== 'object' || w.label !== label) continue;
    const pct = w.usedPercentage, at = w.resetsAt;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 1e9 || at >= 4e9 || at * 1000 <= nowMs) continue;
    return Math.floor(pct);
  }
  return null;
}

const LABELS = [['measures', 'measures'], ['overLevel', 'over level'], ['spawnDenied', 'subagents denied'], ['effortLowered', 'effort lowered'],
  ['noticeAdded', 'notices added'], ['commands', 'commands'], ['sessions', 'sessions']];

async function build(nowMs = Date.now()) {
  const core = policy.core();
  const pol = await policy.read();
  const usage = json(readSmall(path.join(P.usageDir, 'claude-code.json')));
  const diag = core.parseDiag(readSmall(path.join(P.root, 'budget', 'diag.json')));
  const sums = core.totals(diag);

  const mode = pol.policy.mode === 'heavy' ? 'heavy' : 'light';
  const sessionLevel = pol.levels.sessionAt !== undefined ? pol.levels.sessionAt : '85 (default)';
  const weeklyLevel = pol.levels.weeklyAt !== undefined ? pol.levels.weeklyAt : 'off';
  const s = windowPercent(usage.windows, 'Session', nowMs), w = windowPercent(usage.windows, 'Weekly', nowMs);
  const version = typeof usage.claudeVersion === 'string' && VERSION_RE.test(usage.claudeVersion) ? usage.claudeVersion : 'unknown';
  const auto = limits.readAutoContinue() === false ? 'off' : 'on (default)';
  let mod = '';
  try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mods', 'votive-budget', '.claude-plugin', 'plugin.json'), 'utf8')).version; if (VERSION_RE.test(v)) mod = 'mod ' + v + ' | '; } catch (e) { /* not next to the mod */ }

  const lines = [
    `Votive budget report (${new Date(nowMs).toISOString().slice(0, 10)} UTC)`,
    `versions: ${mod}claude-code ${version} | node ${process.versions.node} | ${process.platform}`,
    `policy: mode ${mode}, session level ${sessionLevel}, weekly level ${weeklyLevel}, heavy folders: ${pol.policy.heavyProjects.length}` + (pol.problem ? ' (policy file ignored)' : ''),
    s === null && w === null ? 'usage now: no usage recorded' : `usage now: ${s === null ? 'session n/a' : 'session ' + s + '%'}, ${w === null ? 'week n/a' : 'week ' + w + '%'}`,
    `auto-continue at a limit: ${auto}`,
  ];
  const parts = LABELS.filter(([k]) => sums[k]).map(([k, label]) => `${label} ${sums[k]}`);
  lines.push(parts.length ? 'last 14 days: ' + parts.join(', ') : 'last 14 days: no activity recorded yet');
  return lines.join('\n') + '\n';
}

module.exports = { build };

if (require.main === module) {
  build().then((text) => { process.stdout.write(text); }, (e) => { process.stderr.write('error: ' + e.message + '\n'); process.exit(1); });
}
