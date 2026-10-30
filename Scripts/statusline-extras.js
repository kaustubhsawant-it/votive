#!/usr/bin/env node
'use strict';
//
// Extras for the Claude Code status-line wrapper (votive-statusline.js):
//
//   dropItems(out, drops)  remove items from the wrapped status line, e.g. GSD's
//                          "⬆ /gsd:update", together with their " │ " separator. Configured
//                          as `drop: [...]` in ~/.votive/usage/wrapped.json.
//   meristemSegment(cwd)   a short Meristem segment ("⟳ 3 behind · 2 to review") for a cwd
//                          inside a Meristem workspace. It NEVER runs Meristem in the
//                          foreground: it serves a cached value and, at most every 15 s,
//                          starts a detached refresh (this file with --refresh <root>) that
//                          runs Meristem with a hard timeout: `meristem-statusline` (the fast
//                          entry point, Meristem ≥ 0.3.0) when it's on PATH, otherwise
//                          `meristem statusline --compact`.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./overlay-paths');
const { clean } = require('./progress');

const CACHE_DIR = path.join(P.root, 'cache');
const REFRESH_MS = 15 * 1000;        // how old a cached value may get before a refresh starts
const MAX_STALE_MS = 10 * 60 * 1000; // older than this, the cached value isn't shown
const TIMEOUT_MS = 5 * 1000;         // hard limit on one `meristem statusline` run
const MAX_COLS = 20;

// ---------- drop items from the wrapped output

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OPEN = '(?:\\x1b\\[(?!0?m)[0-9;]*m)*';   // style codes right before an item (not resets)
const RESET = '(?:\\x1b\\[0?m)?';

/**
 * Remove each literal `drops` item from a status line, with its styling and one adjacent
 * " │ " separator (the one after it, or before it when it's last). Everything else is left
 * byte for byte. Matching is on the visible text; ANSI codes around the item are removed too.
 */
function dropItems(out, drops) {
  if (typeof out !== 'string' || !Array.isArray(drops) || !drops.length) return out;
  let s = out;
  for (const d of drops) {
    if (typeof d !== 'string' || !d.trim()) continue;
    const item = OPEN + reEscape(d) + RESET;
    const forms = [
      new RegExp(item + '[ \\t]*│[ \\t]?', 'g'),            // "item │ next"
      new RegExp('[ \\t]?│[ \\t]*' + item + '(?=\\s*$)', 'g'), // "prev │ item" at the end
      new RegExp(item, 'g'),                                // alone
    ];
    for (const re of forms) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; break; }
    }
  }
  return s;
}

// ---------- Meristem segment

/** The Meristem workspace containing `cwd`: the nearest folder with meristem.toml or a
 *  .meristem/ folder, stopping below $HOME (its ~/.meristem is the global store). */
function findWorkspace(cwd, home = os.homedir()) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (dir === home || dir === path.dirname(dir)) return null;
    try { if (fs.statSync(path.join(dir, 'meristem.toml')).isFile()) return dir; } catch (e) {}
    try { if (fs.statSync(path.join(dir, '.meristem')).isDirectory()) return dir; } catch (e) {}
    dir = path.dirname(dir);
  }
  return null;
}

function onPath(cmd) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch (e) {}
  }
  return false;
}

/** FNV-1a, 2 × 32 bit: a stable file-name key per workspace (not security-relevant). */
function key(root) {
  let a = 0x811c9dc5, b = 0x01000193 ^ root.length;
  for (let i = 0; i < root.length; i++) {
    const c = root.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
const cacheFile = (root) => path.join(CACHE_DIR, 'meristem-' + key(root) + '.json');

/**
 * Meristem's compact output → the part worth a glance: how far behind the index is and how
 * many captured facts wait for review. '' when neither is there (nothing to act on).
 */
function summarize(out) {
  if (typeof out !== 'string') return '';
  const line = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').find((l) => l.trim()) || '';
  const behind = /(\d+)\s*behind/i.exec(line);
  const review = /(\d+)\s*(?:to review|for review|pending review|awaiting review|review)/i.exec(line);
  const parts = [];
  if (behind && behind[1] !== '0') parts.push('⟳ ' + behind[1] + ' behind');
  if (review && review[1] !== '0') parts.push(review[1] + ' to review');
  let text = parts.join(' · ');
  if (Array.from(text).length > MAX_COLS && behind && review) text = '⟳' + behind[1] + ' · ' + review[1] + ' to review';
  return clean(text, MAX_COLS);
}

/** Start a detached refresh unless one started in the last 30 s. Never waits. */
function kick(root) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const flag = cacheFile(root) + '.refreshing';
    try {
      if (Date.now() - fs.statSync(flag).mtimeMs < 30 * 1000) return;
      fs.unlinkSync(flag);
    } catch (e) {}
    fs.writeFileSync(flag, String(process.pid), { flag: 'wx' });   // wx: one wins a race
    const child = spawn(process.execPath, [__filename, '--refresh', root],
      { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {});
    child.unref();
  } catch (e) { /* no refresh this time */ }
}

/** The cached segment for `cwd` ('' outside a workspace or without meristem), refreshing
 *  it in the background when due. `opts.now`, `opts.home`, `opts.kick` are for tests. */
function meristemSegment(cwd, opts = {}) {
  try {
    const root = findWorkspace(cwd, opts.home);
    if (!root) return '';
    const now = opts.now || Date.now();
    const c = P.readJson(cacheFile(root));
    const at = c && typeof c.at === 'number' ? c.at : 0;
    if (now - at > REFRESH_MS && (opts.kick || onPath('meristem-statusline') || onPath('meristem'))) (opts.kick || kick)(root);
    if (!c || typeof c.text !== 'string' || now - at > MAX_STALE_MS) return '';
    return clean(c.text, MAX_COLS);
  } catch (e) { return ''; }
}

/** The detached refresh: run Meristem once (hard timeout) and cache what it said. */
function refresh(root) {
  const flag = cacheFile(root) + '.refreshing';
  try {
    const [cmd, args] = onPath('meristem-statusline') ? ['meristem-statusline', []]
      : ['meristem', ['statusline', '--compact']];
    const r = spawnSync(cmd, args, {
      cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    });
    const text = r.status === 0 ? summarize(r.stdout) : '';
    P.writeJsonAtomic(cacheFile(root), { at: Date.now(), root, text });
  } catch (e) {}
  try { fs.unlinkSync(flag); } catch (e) {}
}

if (require.main === module) {
  const i = process.argv.indexOf('--refresh');
  if (i !== -1 && process.argv[i + 1]) refresh(process.argv[i + 1]);
}

module.exports = { dropItems, meristemSegment, findWorkspace, summarize, cacheFile, refresh, REFRESH_MS, MAX_COLS };
