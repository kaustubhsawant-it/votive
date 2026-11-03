'use strict';
//
// Process ancestry, shared by the event hook (which agent is my parent?) and the notify CLI
// (which session am I inside?). Read-only: it lists processes and walks parents, nothing else.
//
// macOS asks `ps` once per hop. Linux reads /proc/<pid>/stat directly (no program to start, and a minimal
// install may have no `ps`). Windows has no ps, and starting PowerShell is slow, so it reads the whole process
// table in a single call and walks the chain in JavaScript. A pid is
// only ever passed as a validated integer in an argument list, never through a shell.
//
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Never resolve `ps` or PowerShell through the agent's PATH: a hostile PATH entry would otherwise run inside every hook.
const PS = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const MAX_PID = 2 ** 31 - 1;
const validPid = (p) => Number.isInteger(p) && p > 0 && p <= MAX_PID;
// "C:\\Program Files\\nodejs\\node.exe" -> "node", "-zsh" -> "zsh"
const cleanName = (s) => path.basename(String(s).trim().replace(/\\/g, '/')).replace(/^-/, '').replace(/\.exe$/i, '');

const LINUX_PROC = process.platform === 'linux' && fs.existsSync('/proc/self/stat');

/**
 * One line of /proc/<pid>/stat: "pid (comm) state ppid ...". The name may hold spaces and parentheses, so the
 * fields after it are found from the LAST ")". Null for anything that does not parse.
 */
function parseProcStat(line) {
  const s = String(line);
  const open = s.indexOf('('), close = s.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const pid = parseInt(s.slice(0, open), 10);
  const rest = s.slice(close + 1).trim().split(/\s+/);        // rest[0] is the state, rest[1] the parent
  const ppid = parseInt(rest[1], 10);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, name: cleanName(s.slice(open + 1, close)) };
}

function linuxHop(pid) {
  try {
    const node = parseProcStat(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'));
    return node && node.pid === pid ? node : null;
  } catch (e) { return null; }
}

function posixHop(pid) {
  let out;
  try { out = execFileSync(PS, ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return null; }
  const m = /^(\d+)\s+(.*)$/.exec(out);
  return m ? { pid, ppid: parseInt(m[1], 10), name: cleanName(m[2]) } : null;
}

let winTable;   // one read per process, the table is only needed once per hook run
function windowsTable() {
  if (winTable) return winTable;
  const table = new Map();
  try {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }';
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+),(\d+),(.*)$/.exec(line);
      if (m) table.set(parseInt(m[1], 10), { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), name: cleanName(m[3]) });
    }
  } catch (e) { /* no table: callers see an empty chain */ }
  winTable = table;
  return table;
}

/** The chain from `pid` upward, nearest first: [{pid, ppid, name}], at most `maxHops` long. */
function ancestry(pid, maxHops) {
  if (!validPid(pid)) return [];
  const hops = Number.isInteger(maxHops) && maxHops > 0 ? Math.min(maxHops, 16) : 4;
  const chain = [];
  const seen = new Set();
  let cur = pid;
  while (chain.length < hops && validPid(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node = process.platform === 'win32' ? windowsTable().get(cur) : (LINUX_PROC ? linuxHop(cur) : posixHop(cur));
    if (!node) break;
    chain.push(node);
    cur = node.ppid;
  }
  return chain;
}

/** The parent pid of `pid`, or null when unknown or it is the root. */
function parentPid(pid) {
  const [node] = ancestry(pid, 1);
  return node && node.ppid > 1 ? node.ppid : null;
}

/** True when a process with this pid is running (a process we may not signal still counts). */
function isAlive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { ancestry, parentPid, isAlive, cleanName, parseProcStat };
