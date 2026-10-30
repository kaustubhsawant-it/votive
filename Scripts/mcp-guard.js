'use strict';
//
// What stands between a model's tool call and a change on the user's computer (AGEN-22).
// Anything an agent reads can tell it to call the MCP tools, and the tool descriptions only ask it
// not to, so the app enforces three things itself:
//
//   1. A switch the USER flips in the app's menu ("Let agents change settings", the preference
//      `agentWritesAllowed`, off by default). It is not one of the settings the tools can write, so
//      no tool can turn it on. Until it is on, settings_set and repair are refused.
//   2. Rate limits, counted from the audit file so they hold across MCP server processes (every
//      agent session starts its own). Only calls that succeeded count.
//   3. An audit file, ~/.votive/audit.jsonl (mode 0600, capped), with one line for each
//      call that changed something and each refusal. The app shows the last few and can undo them.
//
// A process running as the same user can still edit these files or the preference: that is the
// stated trust boundary (SECURITY.md), not something this module claims to stop. It stops a model
// that was talked into calling a tool, including in a loop.
//
const fs = require('fs');
const path = require('path');
const { root } = require('./overlay-paths');
const { readUserFlag } = require('./overlay-settings');

const AUDIT = path.join(root, 'audit.jsonl');
const MAX_LINES = 200;
const MAX_TEXT = 200;
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
const LIMITS = {   // tool -> [most calls, per milliseconds]
  notify: [3, MINUTE],
  settings_set: [5, HOUR],
  repair: [2, HOUR],
};

const REFUSAL = 'Votive does not let agents change its settings or repair its install unless the user allows it. ' +
  'Tell the user they can switch it on in the menu-bar app (Let agents change settings), or run the command themselves ' +
  '(node Scripts/overlay-settings.js to change a setting, node Scripts/doctor.js --fix to repair). Do not try again until they say it is on.';

const writesAllowed = () => readUserFlag('agentWritesAllowed');

/** The audit lines, oldest first; a line that is not a JSON object is skipped. */
function recent() {
  let raw;
  try { raw = fs.readFileSync(AUDIT, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o); } catch (e) { /* junk line */ }
  }
  return out;
}

/** null when the call may go ahead, otherwise one sentence for the model to pass on to the user. */
function refuse(tool, mutates, now = Date.now()) {
  if (mutates && !writesAllowed()) return REFUSAL;
  const lim = LIMITS[tool];
  if (!lim) return null;
  const hits = recent().filter((e) => e.tool === tool && e.ok !== false && typeof e.at === 'number' && e.at <= now + MINUTE && now - e.at < lim[1]);
  if (hits.length < lim[0]) return null;
  const oldest = Math.min(...hits.map((e) => e.at));
  const wait = Math.max(1, Math.ceil((oldest + lim[1] - now) / MINUTE));
  return 'Rate limit: ' + tool + ' was already used ' + hits.length + ' times in the last ' + (lim[1] >= HOUR ? 'hour' : 'minute') +
    '. Wait about ' + wait + ' minute(s), or ask the user.';
}

const clean = (s) => String(s == null ? '' : s).replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + '-' + String.fromCharCode(159) + String.fromCharCode(0x2028, 0x2029) + ']+', 'g'), ' ').trim().slice(0, MAX_TEXT);
const scalar = (v) => (typeof v === 'boolean' || Number.isInteger(v) ? v : typeof v === 'string' ? clean(v).slice(0, 64) : null);

/**
 * Appends one line. Never throws and never writes through a symlink: the audit trail must not be
 * able to break a tool or be pointed at another file. Never put a message or prompt in `entry`.
 */
function record(entry) {
  try {
    const undo = {};
    for (const [k, v] of Object.entries(entry.undo || {})) {
      if (v && typeof v === 'object' && scalar(v.from) !== null && scalar(v.to) !== null) undo[clean(k).slice(0, 64)] = { from: scalar(v.from), to: scalar(v.to) };
    }
    const line = { at: Date.now(), tool: clean(entry.tool), agent: clean(entry.agent) || 'unknown', ok: entry.ok !== false, summary: clean(entry.summary) };
    if (Object.keys(undo).length) line.undo = undo;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { if (fs.lstatSync(AUDIT).isSymbolicLink()) return; } catch (e) { /* not there yet */ }
    fs.appendFileSync(AUDIT, JSON.stringify(line) + '\n', { mode: 0o600 });
    try { fs.chmodSync(AUDIT, 0o600); } catch (e) { /* Windows */ }
    const lines = fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      const tmp = AUDIT + '.tmp' + process.pid;
      const valid = lines.filter((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' && !Array.isArray(o); } catch (e) { return false; } });
      fs.writeFileSync(tmp, valid.slice(-MAX_LINES).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, AUDIT);
    }
  } catch (e) { /* the audit trail must never break the tool */ }
}

module.exports = { AUDIT, LIMITS, MAX_LINES, REFUSAL, writesAllowed, refuse, record, recent };
