#!/usr/bin/env node
'use strict';
//
// The one hook every agent calls. Normalizes the agent's hook payload (see agents.js) and
// records the session's state to ~/.votive/events/<agent>--<session>.json.
//
//   node votive-event.js --agent <id> [--event <name>] [--session <id>] [--cwd <dir>]
//                               [--no-stdin]
//
// The payload is read from stdin when one is piped; agents that pass no payload (Aider) or no
// event name (Copilot, Cline) get it from argv. It is deliberately fail-safe, because it runs
// inside someone else's agent: it ALWAYS exits 0, never writes to stdout or stderr (several
// agents feed hook stdout back to the model), swallows every error, and gives up after 2.5 s.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize } = require('./agents');
const progress = require('./progress');
const procInfo = require('./proc-info');
const P = require('./overlay-paths');

const MAX_STDIN = 8 * 1024 * 1024;   // buffered; the rest of a bigger payload is drained and dropped
const SALVAGE_BYTES = 64 * 1024;     // a truncated payload still yields its leading simple fields

const done = () => process.exit(0);
setTimeout(done, 2500).unref();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-stdin') { out.noStdin = true; continue; }
    const m = /^--(agent|event|session|cwd)$/.exec(argv[i]);
    if (m && i + 1 < argv.length) out[m[1]] = argv[++i];
  }
  return out;
}

// Hooks are often run through `bash -c` or `$SHELL -lc`, so our parent may be a shell that
// exits right away. The agent is the nearest ancestor that isn't one.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'env', 'timeout',
  'cmd', 'powershell', 'pwsh', 'conhost', 'wsl']);   // the last five are the Windows equivalents
function hostPid() {
  let pid = process.ppid;
  if (!(pid > 1)) return pid;
  // One lookup walks the chain; the first ancestor that is not a shell is the agent. If every hop
  // was a shell (or the lookup stopped), the next pid up is the best guess, as before.
  const chain = procInfo.ancestry(pid, 4);
  for (const node of chain) if (!SHELLS.has(node.name.toLowerCase())) return node.pid;
  return chain.length ? chain[chain.length - 1].ppid : pid;
}

// Codex writes its plan usage into the session transcript as `token_count` events. On each
// turn end, read the newest one from the tail of the file.
function codexRollout(transcriptPath) {
  if (!transcriptPath) return null;
  const roots = [path.join(os.homedir(), '.codex')];
  if (process.env.CODEX_HOME) roots.push(process.env.CODEX_HOME);
  try {
    const real = fs.realpathSync(transcriptPath);
    for (const r of roots) {
      let base;
      try { base = fs.realpathSync(path.join(r, 'sessions')); } catch (e) { continue; }
      if (real.startsWith(base + path.sep) && /^rollout-.*\.jsonl$/.test(path.basename(real))) return real;
    }
  } catch (e) {}
  return null;
}

function codexUsage(transcriptPath) {
  const rollout = codexRollout(transcriptPath);   // only Codex's own session files, never an arbitrary .jsonl
  if (!rollout) return;
  let fd;
  try {
    fd = fs.openSync(rollout, 'r');
    if (!fs.fstatSync(fd).isFile()) return;
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf('"rate_limits"') === -1) continue;
      let rl;
      try { rl = JSON.parse(lines[i]).payload.rate_limits; } catch (e) { continue; }
      if (!rl) continue;
      const windows = [rl.primary, rl.secondary].map(codexWindow).filter(Boolean);
      if (windows.length) {
        P.writeJsonAtomic(path.join(P.usageDir, 'codex.json'),
          { agent: 'codex', updatedAt: Date.now(), windows });
      }
      return;
    }
  } catch (e) { /* no usage this time */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}

function codexWindow(w) {
  if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
  if (typeof w.resets_at !== 'number' || !(w.resets_at > 0)) return null;
  const mins = w.window_minutes;
  const label = typeof mins !== 'number' ? 'Limit'
    : mins <= 360 ? 'Session' : mins >= 10080 ? 'Weekly' : Math.round(mins / 60) + 'h';
  return {
    label,
    usedPercentage: Math.min(100, Math.max(0, w.used_percent)),
    resetsAt: w.resets_at > 1e11 ? Math.floor(w.resets_at / 1000) : w.resets_at,
  };
}

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };

// Claude Code runs the hooks of parallel tool calls concurrently, and each one reads, changes
// and rewrites the session's file; unserialized, one TaskCreate can overwrite another's. A
// mkdir lock (atomic on every filesystem) serializes them. It lives in ~/.votive/locks,
// outside the folder the app watches. If the lock can't be had within ~1 s, or is stale
// (> 3 s, a crashed hook), the write goes ahead anyway: losing an update beats losing the event.
function withLock(file, fn) {
  const dir = path.join(P.root, 'locks');
  const lock = path.join(dir, path.basename(file) + '.lock');
  let held = false;
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {}
  for (let i = 0; i < 100 && !held; i++) {
    try { fs.mkdirSync(lock); held = true; }
    catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 3000) { fs.rmdirSync(lock); continue; } } catch (e2) {}
      sleep(10);
    }
  }
  try { return fn(); } finally { if (held) try { fs.rmdirSync(lock); } catch (e) {} }
}

function record(argv, payload) {
  const ev = normalize(argv.agent || 'generic', payload, argv);
  if (!ev.state) return;

  // The agent process of a session does not change, so look it up once and reuse it while it is
  // alive (on Windows the lookup costs about 600 ms, and hooks fire on every tool call).
  const known = ev.sessionId ? (P.readJson(P.eventFile(ev.agent, ev.sessionId)) || {}).pid : undefined;
  const pid = procInfo.isAlive(known) ? known : hostPid();
  const sessionId = ev.sessionId || ('pid-' + pid);   // Aider & co. have no session id
  if (sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) return;   // not an id any agent issues
  const file = P.eventFile(ev.agent, sessionId);

  if (ev.state === 'end') {
    try { fs.unlinkSync(file); } catch (e) {}
    return;
  }

  withLock(file, () => update(file, ev, sessionId, pid, payload));
}

// A plan-limit failure: tell the owner what will happen, once per reset time. Everything is fixed-template
// text chosen from facts (see limit-notify.js); fail-safe, so a problem here never loses the event.
function limitFields(prev, ev, payload) {
  try {
    if (ev.agent !== 'claude-code' || ev.eventName !== 'StopFailure' || !payload || payload.error_type !== 'rate_limit') return null;
    const ln = require('./limit-notify');
    const usage = P.readJson(path.join(P.usageDir, 'claude-code.json')) || {};
    const now = Date.now();
    const resetsAtMs = ln.pickReset(usage.windows, now);
    const key = resetsAtMs ? String(resetsAtMs) : 'unknown';
    if (prev.limitResetsAt === key) return null;
    const text = ln.limitNotice({ errorType: payload.error_type, resetsAtMs, nowMs: now, autoContinue: ln.readAutoContinue(), version: usage.claudeVersion });
    return text ? { notifyMessage: text, notifyAt: now, limitResetsAt: key } : null;
  } catch (e) { return null; }
}

function update(file, ev, sessionId, pid, payload) {
  const prev = P.readJson(file) || {};
  const transcript = ev.transcriptPath || prev.transcriptPath;
  // Task progress and what a Stop really means (done, or waiting on you). Fail-safe: if it
  // throws, the plain state is still recorded.
  let prog = { state: ev.state };
  try {
    prog = progress.track(prev, ev.state, payload, {
      eventName: ev.eventName, transcriptPath: transcript,
      classify: !/interrupt/i.test(ev.eventName || ''),
    });
  } catch (e) { prog = { state: ev.state }; }

  const rec = { agent: ev.agent, sessionId, lastEvent: prog.state, lastEventAt: Date.now() };
  if (pid > 1) rec.pid = pid;
  const cwd = P.clip(ev.cwd, 4096) || prev.cwd || (ev.sessionId ? null : process.cwd());
  if (cwd) rec.cwd = cwd;
  const prompt = ev.prompt ? P.clip(ev.prompt, 200) : prev.prompt;
  if (prompt) rec.prompt = prompt;
  if (transcript) rec.transcriptPath = P.clip(transcript, 4096);
  if (typeof prog.stateSince === 'number') rec.stateSince = prog.stateSince;
  if (prog.plan) rec.plan = prog.plan;
  if (typeof prog.planAt === 'number') rec.planAt = prog.planAt;
  if (typeof prog.promptAt === 'number') rec.promptAt = prog.promptAt;
  if (prog.waitReason) rec.waitReason = prog.waitReason;
  if (prog.detail) rec.detail = prog.detail;
  if (prog.bg) rec.bg = prog.bg;
  // Carry a pending custom notify forward so a lifecycle event can't erase it before the app
  // has shown it (the app dedupes by notifyAt).
  if (typeof prev.notifyMessage === 'string' && typeof prev.notifyAt === 'number') {
    rec.notifyMessage = prev.notifyMessage;
    rec.notifyAt = prev.notifyAt;
  }
  if (typeof prev.limitResetsAt === 'string') rec.limitResetsAt = prev.limitResetsAt;
  const limit = limitFields(prev, ev, payload);
  if (limit) Object.assign(rec, limit);
  P.writeJsonAtomic(file, rec);

  if (ev.usage === 'codex-rollout' && ev.state === 'done') codexUsage(transcript);   // turn end, whatever it meant
}

// Over-size payload: its tool output is what made it big, and Claude Code, Codex and Gemini put
// the identifying fields first. Take the simple string fields from the head and ignore the rest.
function salvage(text) {
  const head = text.slice(0, SALVAGE_BYTES);
  const out = {};
  for (const k of ['hook_event_name', 'session_id', 'sessionId', 'cwd', 'transcript_path', 'conversation_id']) {
    const m = new RegExp('"' + k + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")').exec(head);
    if (m) { try { out[k] = JSON.parse(m[1]); } catch (e) {} }
  }
  return out;
}

(function main() {
  try {
    const argv = parseArgs(process.argv.slice(2));
    // Plugins pass everything in argv (--no-stdin), and Aider's notifications command passes
    // no payload; in both cases stdin may never close, so don't wait on it.
    if (argv.noStdin || process.stdin.isTTY || argv.agent === 'aider') {
      try { record(argv, {}); } catch (e) {}
      return done();
    }
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      if (size >= MAX_STDIN) { size += c.length; return; }   // keep draining so the agent's write never fails
      chunks.push(c); size += c.length;
    });
    process.stdin.on('error', done);
    process.stdin.on('end', () => {
      try {
        let payload = {};
        const text = Buffer.concat(chunks).toString('utf8');
        if (size > MAX_STDIN) payload = salvage(text);
        else { try { payload = JSON.parse(text || '{}') || {}; } catch (e) { payload = {}; } }
        if (typeof payload !== 'object' || Array.isArray(payload)) payload = {};
        record(argv, payload);
      } catch (e) { /* swallow everything */ }
      done();
    });
  } catch (e) { done(); }
})();
