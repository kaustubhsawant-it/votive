'use strict';
//
// Reads and writes the budget policy file, ~/.votive/budget/policy.json, shared with the
// Claude Code budget mod (mods/votive-budget). The mod can only write it with the process
// umask, so this script is where the file is made private: folder 0700, file 0600, tightened on
// every write and by `harden`. It refuses links, files that are not ours, and anything oversized,
// and validates through the same pure rules the mod uses (budget-core.mjs), so the two cannot
// disagree. Nothing here touches the network, a process, or a session; a policy file can only
// change integers and a short list of folders, never add text or trigger an action.
//
//   node Scripts/budget-policy.js status | level session|weekly <1-100|off> | mode light|heavy
//                                 | project add|remove <absolute folder> | harden
//
const fs = require('fs');
const path = require('path');
const P = require('./overlay-paths');

const MAX_BYTES = 8192;
const MAX_FOLDERS = 50;
const DIR = () => path.join(P.root, 'budget');
const FILE = () => path.join(DIR(), 'policy.json');
// Unix modes do not exist on NTFS (everything reads 0666); there, privacy is the user profile's ACL.
const POSIX = process.platform !== 'win32';
const mine = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();

// The shared rules live in an ES module (the mod loads the same file). Node 22.12+ can require() it;
// older Node gets a clear message, and the rest of Votive does not depend on this script.
let coreModule;
function core() {
  if (coreModule) return coreModule;
  const attempts = [
    () => require(path.join(__dirname, 'budget-core.mjs')),
    () => require(path.join(__dirname, '..', 'mods', 'votive-budget', 'hooks', 'budget-core.mjs')),
  ];
  let sawEsmError = false;
  for (const load of attempts) {
    try { coreModule = load(); return coreModule; } catch (e) {
      if (e && e.code !== 'MODULE_NOT_FOUND') sawEsmError = true;
    }
  }
  throw new Error(sawEsmError
    ? 'this needs Node 22.12 or newer (it loads an ES module); found ' + process.versions.node
    : 'budget-core.mjs not found next to this script');
}

/** 'missing' | 'ok' | 'unsafe-folder': the folder must be a real directory of ours directly under the overlay root. */
function folderState() {
  const dir = DIR();
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'unsafe-folder'; }
  if (!st.isDirectory() || st.isSymbolicLink() || !mine(st)) return 'unsafe-folder';
  try {
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(P.root), 'budget')) return 'unsafe-folder';
  } catch (e) { return 'unsafe-folder'; }
  return 'ok';
}

/** 'missing' | 'ok' | 'not-a-plain-file' | 'too-large' */
function fileState() {
  let st;
  try { st = fs.lstatSync(FILE()); } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'not-a-plain-file'; }
  if (!st.isFile() || st.isSymbolicLink() || !mine(st)) return 'not-a-plain-file';
  return st.size > MAX_BYTES ? 'too-large' : 'ok';
}

async function read() {
  const c = core();
  const empty = (problem) => ({ policy: c.parsePolicy(''), levels: {}, loose: false, problem });
  const fs1 = folderState();
  if (fs1 === 'unsafe-folder') return empty('unsafe-folder');
  if (fs1 === 'missing') return empty(null);
  const fl = fileState();
  if (fl === 'missing') return empty(null);
  if (fl !== 'ok') return empty(fl);
  let text;
  try {
    const fd = fs.openSync(FILE(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { text = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  } catch (e) { return empty('not-a-plain-file'); }
  const loose = POSIX && Boolean((fs.lstatSync(DIR()).mode & 0o077) || (fs.lstatSync(FILE()).mode & 0o077));
  return { policy: c.parsePolicy(text), levels: c.parseLevels(text), loose, problem: null };
}

/** Makes the folder 0700 and the file 0600 when they are ours and not links. */
async function harden() {
  let changed = false;
  if (POSIX && folderState() === 'ok') {
    const st = fs.lstatSync(DIR());
    if (st.mode & 0o077) { fs.chmodSync(DIR(), 0o700); changed = true; }
    if (fileState() === 'ok') {
      const fst = fs.lstatSync(FILE());
      if (fst.mode & 0o077) { fs.chmodSync(FILE(), 0o600); changed = true; }
    }
  }
  return { changed };
}

const isLevel = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;

/** patch: { mode?, sessionAt?, weeklyAt? (null = off), heavyProjects? }. Anything invalid throws and writes nothing. */
async function update(patch) {
  const c = core();
  const cur = await read();
  if (cur.problem === 'unsafe-folder' || cur.problem === 'not-a-plain-file') throw new Error('policy file location is not safe (link or foreign owner); not writing');
  if ('mode' in patch && patch.mode !== 'light' && patch.mode !== 'heavy') throw new Error('mode must be light or heavy');
  if ('sessionAt' in patch && !isLevel(patch.sessionAt)) throw new Error('session level must be a whole number from 1 to 100');
  if ('weeklyAt' in patch && patch.weeklyAt !== null && !isLevel(patch.weeklyAt)) throw new Error('weekly level must be a whole number from 1 to 100, or off');
  const next = {
    mode: 'mode' in patch ? patch.mode : cur.policy.mode,
    heavyProjects: 'heavyProjects' in patch ? patch.heavyProjects : cur.policy.heavyProjects,
  };
  const sessionAt = 'sessionAt' in patch ? patch.sessionAt : cur.levels.sessionAt;
  const weeklyAt = 'weeklyAt' in patch ? patch.weeklyAt : cur.levels.weeklyAt;
  if (sessionAt != null) next.sessionAt = sessionAt;
  if (weeklyAt != null) next.weeklyAt = weeklyAt;
  const body = JSON.stringify(next);
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  if (folderState() !== 'ok') throw new Error('policy folder is not safe; not writing');
  if (POSIX && (fs.lstatSync(DIR()).mode & 0o077)) fs.chmodSync(DIR(), 0o700);
  if (fileState() === 'not-a-plain-file') throw new Error('policy file is not a plain file; not writing');
  const tmp = FILE() + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, FILE()); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
  return next;
}

async function addProject(folder) {
  const c = core();
  if (!c.isCleanFolder(folder)) throw new Error('folder must be an absolute path with no dot segments, no control characters, at most 256 characters');
  const cur = (await read()).policy;
  if (cur.heavyProjects.includes(folder)) return cur;
  if (cur.heavyProjects.length >= MAX_FOLDERS) throw new Error('the heavy folder list is full (50)');
  return update({ heavyProjects: c.addHeavyProject(cur, folder).heavyProjects });
}

async function removeProject(folder) {
  const c = core();
  const cur = (await read()).policy;
  return update({ heavyProjects: c.removeHeavyProject(cur, folder).heavyProjects });
}

const USAGE = 'Usage: budget-policy.js status | level session|weekly <1-100|off> | mode light|heavy | project add|remove <absolute folder> | harden';

async function cli(argv) {
  const [cmd, a, b] = argv;
  const num = (s) => (/^\d{1,3}$/.test(String(s)) ? Number(s) : NaN);
  if (cmd === 'status' && argv.length === 1) {
    const r = await read();
    const lines = [
      `mode: ${r.policy.mode}`,
      `session level: ${r.levels.sessionAt !== undefined ? r.levels.sessionAt : '85 (default)'}`,
      `weekly level: ${r.levels.weeklyAt !== undefined ? r.levels.weeklyAt : 'off'}`,
      `heavy folders: ${r.policy.heavyProjects.length}`,
      ...r.policy.heavyProjects.map((f) => `  ${f}`),
    ];
    if (r.loose) lines.push('file or folder is readable by others: run `harden`');
    if (r.problem) lines.push(`problem: ${r.problem} (policy ignored, sessions stay light)`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  if (cmd === 'level' && argv.length === 3 && (a === 'session' || a === 'weekly')) {
    if (b === 'off' && a === 'weekly') await update({ weeklyAt: null });
    else await update({ [a === 'session' ? 'sessionAt' : 'weeklyAt']: num(b) });
    return 0;
  }
  if (cmd === 'mode' && argv.length === 2) { await update({ mode: a }); return 0; }
  if (cmd === 'project' && argv.length === 3 && a === 'add') { await addProject(b); return 0; }
  if (cmd === 'project' && argv.length === 3 && a === 'remove') { await removeProject(b); return 0; }
  if (cmd === 'harden' && argv.length === 1) {
    const r = await harden();
    process.stdout.write(r.changed ? 'tightened modes\n' : 'already private\n');
    return 0;
  }
  process.stderr.write(USAGE + '\n');
  return 2;
}

module.exports = { read, update, harden, addProject, removeProject, core, FILE, DIR };

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
}
