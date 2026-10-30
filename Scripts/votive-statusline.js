#!/usr/bin/env node
'use strict';
//
// Claude Code statusLine wrapper — records plan usage for the Votive menu-bar app.
//
// Claude Code pipes a JSON payload to the statusLine command on every refresh. For claude.ai
// subscribers that payload carries `rate_limits.five_hour` (session limit) and
// `rate_limits.seven_day` (weekly limit), each { used_percentage, resets_at }. This is the
// documented, supported way to see those numbers — no credentials, no network calls.
//
// Claude Code allows only ONE statusLine command, so this script wraps whatever was there
// before (saved by install-statusline.js in ~/.votive/usage/wrapped.json):
//   1. save rate_limits to ~/.votive/usage/claude-code.json (atomic temp + rename)
//   2. run the wrapped command with the SAME stdin and pass its stdout straight through
// so the visible status line is byte-for-byte what it was. Recording is fail-safe: any error
// there is swallowed and the wrapped status line still runs.
//
// It also prepends ONE segment with this session's task status, read from the session's
// event file (see progress.js), e.g. `● Deploying · 3/6 · 50% · 2m │ <your status line>`.
// The segment (≤40 columns) is written just before the wrapped command's first byte, followed
// by ` │ `, so what follows it is exactly the wrapped output; when that command prints nothing,
// the segment stands alone. Nothing is printed when there is no state to show. Pass
// `--no-task` on the statusLine command to turn the segment off.
//
// Two optional extras (statusline-extras.js):
//   - `drop: ["⬆ /gsd:update", ...]` in wrapped.json removes those items (and their " │ ")
//     from the wrapped output; everything else stays byte for byte. With a drop list the
//     wrapped output is collected and written once it ends, instead of streamed.
//   - In a Meristem workspace, a short cached Meristem segment follows the task segment
//     (`--no-meristem` turns it off). It never runs Meristem in the foreground.
//
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./overlay-paths');
const progress = require('./progress');
const extras = require('./statusline-extras');

const dir = P.usageDir;

// A window only counts if both numbers are finite; percentage is clamped to 0-100 and a
// reset time that looks like milliseconds is converted to seconds.
function win(w) {
  if (!w || typeof w !== 'object') return undefined;
  const used = w.used_percentage, resets = w.resets_at;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return undefined;
  return {
    usedPercentage: Math.min(100, Math.max(0, used)),
    resetsAt: resets > 1e11 ? Math.floor(resets / 1000) : resets,
  };
}

function recordUsage(raw) {
  try {
    const j = JSON.parse(raw || '{}');
    const rl = j && j.rate_limits;
    if (!rl || typeof rl !== 'object') return;
    const five = win(rl.five_hour), seven = win(rl.seven_day);
    if (!five && !seven) return;
    // Merge: a refresh that reports only one window keeps the other's last known value
    // (the app still drops any window whose reset time has passed).
    const file = path.join(dir, 'claude-code.json');
    const prev = {};
    for (const w of (P.readJson(file) || {}).windows || []) prev[w.label] = w;
    const windows = [];
    const session = five ? Object.assign({ label: 'Session' }, five) : prev.Session;
    const weekly = seven ? Object.assign({ label: 'Weekly' }, seven) : prev.Weekly;
    if (session) windows.push(session);
    if (weekly) windows.push(weekly);
    // The Claude Code version, so the limit notice knows whether it continues by itself. Only a plain
    // version number is kept; anything else is dropped and the last good one stays.
    const seen = typeof j.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,5}$/.test(j.version.trim()) ? j.version.trim() : undefined;
    const claudeVersion = seen || (P.readJson(file) || {}).claudeVersion;
    P.writeJsonAtomic(file, Object.assign({ agent: 'claude-code', updatedAt: Date.now(), windows }, typeof claudeVersion === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,5}$/.test(claudeVersion) ? { claudeVersion } : {}));
    // History for the pacing advisor; a failure here must not lose the reading above.
    try { require('./usage-history').append('claude-code', windows); } catch (e) { /* optional */ }
  } catch (e) { /* never break the status line */ }
}

const SEP = ' \x1b[2m│\x1b[0m ';

/** This session's status segment ('' when there is none). Reads one small JSON file. */
function taskSegment(raw) {
  try {
    if (process.argv.includes('--no-task')) return '';
    const j = JSON.parse(raw || '{}');
    const id = j && typeof j.session_id === 'string' ? j.session_id : null;
    if (!id) return '';
    // Cursor runs Claude Code's hooks too; its sessions are recorded under its own name.
    const rec = P.readJson(P.eventFile('claude-code', id)) || P.readJson(P.eventFile('cursor', id));
    // Background work: count down from the transcript between hook events (only while some
    // is outstanding; reads the tail, and only parses lines that mention a task id).
    const finished = rec && rec.bg && Array.isArray(rec.bg.ids)
      ? progress.finishedIds(rec.transcriptPath, rec.bg.ids) : undefined;
    return progress.segment(rec, { color: process.env.NO_COLOR === undefined, finished });
  } catch (e) { return ''; }
}

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };

/** Write all of `data` to stdout, synchronously and in order (Node's stdout is asynchronous
 *  for pipes on macOS). Retries a full non-blocking pipe briefly; gives up on other errors. */
function writeOut(data) {
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  for (let tries = 0; buf.length && tries < 2000;) {
    try { buf = buf.subarray(fs.writeSync(1, buf)); }
    catch (e) { if (e.code !== 'EAGAIN') return; tries++; sleep(1); }
  }
}

function meristemPart(raw) {
  try {
    if (process.argv.includes('--no-meristem')) return '';
    const j = JSON.parse(raw || '{}');
    const cwd = (j.workspace && j.workspace.current_dir) || j.cwd;
    const t = extras.meristemSegment(cwd);
    return t ? (process.env.NO_COLOR === undefined ? '\x1b[33m' + t + '\x1b[0m' : t) : '';
  } catch (e) { return ''; }
}

/** { command, drop } from wrapped.json; command null when there's nothing to run. */
function wrappedConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'wrapped.json'), 'utf8'));
    const command = typeof cfg.command === 'string' && cfg.command.trim() ? cfg.command : null;
    const drop = Array.isArray(cfg.drop) ? cfg.drop.filter((d) => typeof d === 'string' && d.trim()) : [];
    return { command, drop };
  } catch (e) { return { command: null, drop: [] }; }
}

let buf = '';
const guard = setTimeout(() => process.exit(0), 3000);   // never hang if stdin never closes
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  clearTimeout(guard);
  recordUsage(buf);
  // Guard against wrapped.json (directly or indirectly) pointing back at this wrapper.
  if (process.env.VOTIVE_STATUSLINE === '1') return process.exit(0);
  const seg = [taskSegment(buf), meristemPart(buf)].filter(Boolean).join(SEP);
  const { command: cmd, drop } = wrappedConfig();
  if (!cmd) { if (seg) writeOut(seg); return process.exit(0); }
  // stdout is piped (not inherited) only so the separator can wait for the first byte; every
  // chunk is passed on unchanged and in order. With a drop list, the output is collected and
  // filtered at the end instead (status lines are a few hundred bytes).
  let started = false;
  const begin = () => { if (!started) { started = true; if (seg) writeOut(seg + SEP); } };
  const held = [];
  const finish = () => {
    if (!drop.length) { if (!started && seg) writeOut(seg); return; }
    let out = Buffer.concat(held).toString('utf8');
    try { out = extras.dropItems(out, drop); } catch (e) {}
    if (out) { begin(); writeOut(out); } else if (seg) writeOut(seg);
  };
  const WIN = process.platform === 'win32';
  const child = spawn(cmd, {
    // POSIX: own process group, so we can kill all of it. Windows: `detached` would open a new
    // console and cut the pipes, so stay attached, hidden, and kill the tree with taskkill.
    shell: true, detached: !WIN, windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: Object.assign({}, process.env, { VOTIVE_STATUSLINE: '1' }),
  });
  const killChild = () => {
    if (WIN) { try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 }); } catch (e) {} return; }
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
  };
  // When Claude Code cancels or times out a refresh, take the user's command down with us
  // instead of leaving it orphaned.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { killChild(); process.exit(0); });
  }
  const hardStop = setTimeout(() => { killChild(); finish(); process.exit(0); }, 10000);
  child.stdout.on('data', (c) => { if (drop.length) held.push(c); else { begin(); writeOut(c); } });
  child.on('error', () => process.exit(0));
  // 'close', not 'exit': it fires after the last of stdout has been read.
  child.on('close', (code) => {
    clearTimeout(hardStop);
    finish();
    process.exit(code || 0);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(buf);
});
