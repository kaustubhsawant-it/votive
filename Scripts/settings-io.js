'use strict';
//
// Safe read/modify/write of an agent's JSON config file (~/.claude/settings.json,
// ~/.codex/hooks.json, ~/.cursor/hooks.json, …), shared by every installer.
//
// - A missing or whitespace-only file counts as `{}` (a fresh install may not have one yet).
//   Anything else must parse to a plain JSON object, or we refuse without touching anything.
// - The backup keeps the original's permissions (these files can hold secrets under `env`).
// - The write goes to a temp file next to the REAL file and is renamed over it, so a symlinked
//   config stays a symlink and a crash mid-write can't leave half a file.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

// --dry-run: show what every installer would change, as a diff, and change nothing.
const DRY_RUN = process.argv.includes('--dry-run');

/** Unified-style line diff (longest common subsequence); config files are small. */
function lineDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const m = a.length, n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push('  ' + a[i]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push('- ' + a[i++]);
    else out.push('+ ' + b[j++]);
  }
  while (i < m) out.push('- ' + a[i++]);
  while (j < n) out.push('+ ' + b[j++]);
  // keep changed lines plus two lines of context
  const keep = new Set();
  out.forEach((l, k) => { if (l[0] !== ' ') for (let c = Math.max(0, k - 2); c <= Math.min(out.length - 1, k + 2); c++) keep.add(c); });
  const lines = [];
  out.forEach((l, k) => { if (keep.has(k)) lines.push(l); else if (lines[lines.length - 1] !== '  …') lines.push('  …'); });
  return lines.join('\n');
}

class SettingsError extends Error {}

function loadFile(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new SettingsError('Cannot read ' + file + ': ' + e.message);
  }
  if (raw === null || raw.trim() === '') return { raw, cfg: {} };
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new SettingsError('Refusing to edit ' + file + ': not valid JSON (' + e.message + ').'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new SettingsError('Refusing to edit ' + file + ': not a JSON object.');
  }
  return { raw, cfg };
}

function saveFile(file, raw, cfg) {
  if (DRY_RUN) {
    console.log('--- ' + file + (raw === null ? ' (new file)' : ''));
    console.log(lineDiff(raw === null ? '' : raw.replace(/\n$/, ''), JSON.stringify(cfg, null, 2)));
    return;
  }
  const real = (() => { try { return fs.realpathSync(file); } catch (e) { return file; } })();
  let mode = 0o600;
  try { mode = fs.statSync(real).mode & 0o777; } catch (e) {}
  const tmp = real + '.votive.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(real), { recursive: true });
    if (raw !== null && raw.trim() !== '') {
      const backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(backup, raw, { mode });
      fs.chmodSync(backup, mode);   // writeFileSync's mode is masked by umask
      console.log('Backed up ' + path.basename(file) + ' -> ' + backup);
    }
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw new SettingsError('Could not write ' + file + ': ' + e.message + ' (nothing was changed).');
  }
}

// CLI-style wrappers for ~/.claude/settings.json: print the problem and exit 1.
function exitOn(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof SettingsError) { console.error(e.message); process.exit(1); }
    throw e;
  }
}
const load = () => exitOn(() => loadFile(settingsPath));
const save = (raw, cfg) => exitOn(() => saveFile(settingsPath, raw, cfg));

/**
 * Quote a path for a `command` string that an agent runs through a shell. POSIX: single quotes. Windows:
 * agents may run hooks through cmd.exe, PowerShell or Git bash, and the one form all three read the same
 * way is double quotes with forward slashes (node accepts them). A path with a character that is special
 * inside double quotes in one of those shells is refused, because a command that silently misbehaves
 * inside someone else's agent is worse than an installer that says no.
 */
function shellQuote(p, platform = process.platform) {
  const s = String(p);
  if (platform !== 'win32') return "'" + s.replace(/'/g, "'\\''") + "'";
  if (/["$`%\r\n\0]/.test(s)) {
    throw new SettingsError('This path has a character that cannot be quoted safely for every Windows shell (one of " $ ` %): ' + s);
  }
  return '"' + s.replace(/\\/g, '/') + '"';
}

module.exports = { settingsPath, SettingsError, DRY_RUN, lineDiff, loadFile, saveFile, load, save, shellQuote };
