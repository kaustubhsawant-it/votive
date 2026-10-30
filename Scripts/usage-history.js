'use strict';
//
// Keeps a small history of plan-usage samples, one JSON line each, in
// ~/.votive/usage/history/<agent>.jsonl, so the pacing advisor (usage-pacing.js) can learn
// how fast the weekly limit is used. A sample holds percentages and reset times only, never a
// prompt, path or session id. One is appended at most every 5 minutes unless a percentage moved
// by a point or a window reset, and the file is trimmed to its newest half past 1 MB. Callers sit
// on the status-line path, so they wrap it in try/catch like the rest of the recording.
//
// Private by construction: the folder is 0700 and the file 0600, nothing here listens, opens a
// socket or runs anything, and no other component writes to it. Because other programs running
// as the same user can still touch files, it also refuses to write through a symlink or into a
// folder that is not the real, owner-only history folder, rejects out-of-range values on read,
// and caps how much it reads. Nothing in this file may ever trigger an action: it is data for
// advice only.
//
//   { t: ms, s: session %, sr: session resets (s), w: weekly %, wr: weekly resets (s) }
//
const fs = require('fs');
const path = require('path');
const P = require('./overlay-paths');

const MIN_GAP_MS = 5 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;

const fileFor = (agent) => path.join(P.usageDir, 'history', P.safe(agent) + '.jsonl');

function sampleOf(windows, now) {
  const by = {};
  for (const w of windows || []) by[w.label] = w;
  const s = by.Session, w = by.Weekly;
  return {
    t: now,
    s: s ? s.usedPercentage : null, sr: s ? s.resetsAt : null,
    w: w ? w.usedPercentage : null, wr: w ? w.resetsAt : null,
  };
}

function worthKeeping(last, cur) {
  if (!last) return true;
  if (cur.t - last.t >= MIN_GAP_MS) return true;
  if (cur.sr !== last.sr || cur.wr !== last.wr) return true;
  const moved = (a, b) => a != null && b != null && Math.abs(a - b) >= 1;
  return moved(cur.s, last.s) || moved(cur.w, last.w);
}

function validSample(x) {
  const num = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  const percent = (v) => num(v) && (v === null || (v >= 0 && v <= 100));
  const seconds = (v) => num(v) && (v === null || (v > 1e9 && v < 4e9));
  return !!x && typeof x === 'object' && typeof x.t === 'number' && Number.isFinite(x.t)
    && x.t > 1e12 && x.t < 4e12
    && percent(x.s) && percent(x.w) && seconds(x.sr) && seconds(x.wr);
}

/** The real, owner-only history folder, or null: no symlink anywhere in the path, ours, 0700. */
function safeDir() {
  const dir = path.join(P.usageDir, 'history');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const expect = path.join(fs.realpathSync(P.root), 'usage', 'history');
    if (fs.realpathSync(dir) !== expect) return null;
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
    return dir;
  } catch (e) { return null; }
}

/** True when the file does not exist yet or is a plain file of ours (never a link or a device). */
function plainFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    return typeof process.getuid !== 'function' || st.uid === process.getuid();
  } catch (e) { return e.code === 'ENOENT'; }
}

function lastSample(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 2048);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const x = JSON.parse(lines[i]); if (validSample(x)) return x; } catch (e) { /* torn first line of the tail */ }
    }
  } catch (e) { /* no history yet */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
  return null;
}

function trim(file) {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n';
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, keep, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { /* trimming is housekeeping, never fatal */ }
}

/** Appends a sample when it is worth keeping; returns whether it did. */
function append(agent, windows, now = Date.now()) {
  const cur = sampleOf(windows, now);
  if (cur.s === null && cur.w === null) return false;
  if (!validSample(cur)) return false;
  const dir = safeDir();
  if (!dir) return false;
  const file = path.join(dir, P.safe(agent) + '.jsonl');
  if (!plainFile(file)) return false;
  if (!worthKeeping(lastSample(file), cur)) return false;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, JSON.stringify(cur) + '\n');
  } finally { fs.closeSync(fd); }
  trim(file);
  return true;
}

/** Every valid sample, oldest first. Torn or foreign lines are skipped; a link or oversized file reads as empty. */
function read(agent) {
  const file = fileFor(agent);
  let raw = '';
  try {
    const st = fs.lstatSync(file);
    if (!plainFile(file) || st.size > MAX_BYTES * 2) return [];
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { const x = JSON.parse(line); if (validSample(x)) out.push(x); } catch (e) { /* skip */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

module.exports = { append, read, fileFor, MIN_GAP_MS, MAX_BYTES };
