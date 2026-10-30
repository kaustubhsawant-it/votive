#!/usr/bin/env node
'use strict';
//
// Checks a Votive install and repairs what it can. Used by the MCP server's
// `diagnose` and `repair` tools, and usable from a terminal:
//
//   node doctor.js                  report every check
//   node doctor.js --fix            repair everything that failed and can be repaired
//   node doctor.js --fix scripts,hooks
//
// Repairs never rebuild the app (that's ./Scripts/install.sh); they re-copy the hook scripts,
// re-wire agents, re-wrap the Claude Code status line, and restart the app.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync, spawn } = require('child_process');
const P = require('./overlay-paths');
const { AGENTS, detected } = require('./install-agents');
const { shellQuote } = require('./settings-io');
const limits = require('./limit-notify');

const HOME = os.homedir();
const APP = path.join(HOME, 'Applications', 'Votive.app');
const LABEL = 'dev.votive.Votive';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', LABEL + '.plist');
const WIN = process.platform === 'win32';
// Windows: the per-user app folder the installer uses (no admin needed).
const windowsAppPath = (env = process.env) => path.join(env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Votive', 'VotiveWin.exe');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const BIN = path.join(P.root, 'bin');
// Keep in step with the copy loop in install.sh (tests check they match).
const BIN_FILES = ['votive-event.js', 'agents.js', 'overlay-paths.js', 'progress.js', 'statusline-extras.js',
  'votive-statusline.js', 'votive-notify.js', 'notify-core.js', 'usage-history.js', 'usage-pacing.js', 'proc-info.js', 'limit-notify.js'];

const REPAIRS = {
  scripts: 'Copy the hook scripts to ~/.votive/bin again',
  hooks: 'Re-wire the hooks of every detected agent',
  statusline: 'Re-wrap the Claude Code status line so plan usage is recorded',
  app: 'Restart the menu-bar app',
};

function run(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/**
 * Whether an agent is wired exactly as the installer would wire it now: every event it needs
 * runs the current event script. Returns { ok, detail }.
 */
function wiring(a) {
  const file = path.join(HOME, a.file);
  if (a.style === 'file') {
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch (e) {}
    if (current === null) return { ok: false, detail: 'Found, but its hook file is missing.' };
    return current === a.content() ? { ok: true, detail: 'Hooks wired (' + a.file + ')' }
      : { ok: false, detail: 'Its hook file is out of date.' };
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, detail: fs.existsSync(file) ? a.file + ' is not valid JSON, so it cannot be wired.' : 'Found, but its hooks are not wired.' };
  }
  const want = a.entry().command;
  const hooks = (cfg && cfg.hooks) || {};
  const missing = a.events.filter((ev) => !Array.isArray(hooks[ev]) || !JSON.stringify(hooks[ev]).includes(JSON.stringify(want).slice(1, -1)));
  if (!missing.length) return { ok: true, detail: 'Hooks wired (' + a.file + ')' };
  return { ok: false, detail: missing.length === a.events.length ? 'Found, but its hooks are not wired.'
    : 'Only partly wired; missing or outdated: ' + missing.join(', ') };
}

/** What the newest Codex session file says about plan usage. Never throws. */
function codexUsageStatus() {
  try {
    const base = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');
    let newest = null;
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory() && depth < 4) walk(f, depth + 1);
        else if (/^rollout-.*\.jsonl$/.test(e.name)) { const m = fs.statSync(f).mtimeMs; if (!newest || m > newest.m) newest = { f, m }; }
      }
    };
    walk(base, 0);
    if (!newest) return 'No Codex session file yet, so Codex plan usage is unconfirmed.';
    const fd = fs.openSync(newest.f, 'r');
    let tail;
    try { const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024); tail = Buffer.alloc(len); fs.readSync(fd, tail, 0, len, size - len); }
    finally { fs.closeSync(fd); }
    const lines = tail.toString('utf8').split('\n').filter((l) => l.includes('"token_count"'));
    if (!lines.length) return 'Newest Codex session file has no token_count events yet.';
    const last = lines[lines.length - 1];
    return /"rate_limits"\s*:\s*\{/.test(last) ? 'Codex wrote plan usage in its newest session file.'
      : 'Codex wrote no rate_limits in its newest session file (a known Codex issue), so Codex plan usage will not show.';
  } catch (e) { return 'Could not check Codex plan usage: ' + e.message; }
}

/** Every check: { id, ok, detail, repair? } — `repair` names the fix from REPAIRS. */
function diagnose() {
  const checks = [];
  const add = (id, ok, detail, repair) => checks.push(Object.assign({ id, ok, detail }, ok || !repair ? {} : { repair }));
  // A warning is worth knowing but does not fail the run.
  const warn = (id, detail) => checks.push({ id, ok: true, warn: true, detail });

  // The app
  if (WIN) {
    const exe = windowsAppPath();
    add('app-installed', fs.existsSync(exe), fs.existsSync(exe) ? exe
      : 'Not found at ' + exe + '. Run: node Scripts/install-windows.js --app <path to VotiveWin.exe>');
    const running = run('tasklist', ['/fi', 'imagename eq VotiveWin.exe', '/fo', 'csv', '/nh']);
    const up = running.ok && /VotiveWin\.exe/i.test(running.out);
    add('app-running', up, up ? 'Running' : 'The app is not running.', fs.existsSync(exe) ? 'app' : undefined);
    const login = run('reg', ['query', RUN_KEY, '/v', 'Votive']);
    add('login-item', login.ok, login.ok ? 'Starts with Windows' : 'Not set to start with Windows (tray menu: Start with Windows).');
  } else {
    add('app-installed', fs.existsSync(APP),
      fs.existsSync(APP) ? APP : 'Not found at ' + APP + '. Run ./Scripts/install.sh to build and install it.');
    const running = run('/usr/bin/pgrep', ['-f', 'Votive.app/Contents/MacOS']);
    add('app-running', running.ok, running.ok ? 'pid ' + running.out.trim().split('\n')[0] : 'The menu-bar app is not running.', fs.existsSync(APP) ? 'app' : undefined);
    add('login-item', fs.existsSync(PLIST),
      fs.existsSync(PLIST) ? 'Starts at login (' + LABEL + ')' : 'No LaunchAgent, so the app will not start at login. Run ./Scripts/install.sh.');
  }

  // Scripts
  const stale = BIN_FILES.filter((f) => {
    try { return fs.readFileSync(path.join(BIN, f), 'utf8') !== fs.readFileSync(path.join(__dirname, f), 'utf8'); }
    catch (e) { return true; }
  });
  add('scripts', !stale.length, stale.length ? 'Missing or out of date in ~/.votive/bin: ' + stale.join(', ') : 'Up to date', 'scripts');

  // Node version (the hooks run under node)
  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('node', major >= 18, 'Node ' + process.versions.node + (major >= 18 ? '' : ' — version 18 or later is needed'));

  // Agents
  let anyAgent = false;
  for (const [id, a] of Object.entries(AGENTS)) {
    if (!detected(a)) continue;
    anyAgent = true;
    if (a.style === 'manual') {
      checks.push({ id: 'agent-' + id, ok: true, detail: 'Found; needs manual setup (see docs/AGENTS.md)' });
      continue;
    }
    const w = wiring(a);
    add('agent-' + id, w.ok, w.detail, 'hooks');
  }
  add('agents-found', anyAgent, anyAgent ? 'At least one supported agent is installed' : 'No supported agent found on this Mac.');

  // Claude Code status line (plan usage)
  if (detected(AGENTS['claude-code'])) {
    let cmd = '';
    try { cmd = (JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')).statusLine || {}).command || ''; }
    catch (e) {}
    const want = 'node ' + shellQuote(path.join(BIN, 'votive-statusline.js'));
    const ok = cmd === want;
    add('claude-usage', ok, ok ? 'Status line records plan usage'
      : (cmd.includes('votive-statusline.js') || cmd.includes('agent-overlay-statusline.js')) ? 'The status line points at an old copy of the usage script.'
        : 'The Claude Code status line is not wrapped, so usage will not show.', 'statusline');
  }

  // Plan limits: does Claude Code continue by itself at one? (read only; the version is the one the status line recorded)
  if (detected(AGENTS['claude-code'])) {
    if (limits.readAutoContinue(HOME) === false) {
      warn('auto-continue', 'Automatic continue is turned off in Claude Code (autoContinueAtUsageLimit is false), so a session waits at a plan limit until you continue it.');
    } else {
      checks.push({ id: 'auto-continue', ok: true, detail: 'Automatic continue at a plan limit is on (the Claude Code default).' });
    }
    const v = (P.readJson(path.join(P.usageDir, 'claude-code.json')) || {}).claudeVersion;
    const recent = typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,5}$/.test(v) ? limits.versionAtLeast(v, limits.AUTO_CONTINUE_SINCE) : null;
    if (recent === false) warn('claude-version', 'Claude Code ' + v + ' is older than ' + limits.AUTO_CONTINUE_SINCE + ', so it does not continue by itself at a plan limit.');
    else if (recent === true) checks.push({ id: 'claude-version', ok: true, detail: 'Claude Code ' + v + ' continues by itself at a plan limit (from ' + limits.AUTO_CONTINUE_SINCE + ').' });
    else checks.push({ id: 'claude-version', ok: true, detail: 'Claude Code version unknown; it is recorded the next time the status line refreshes.' });
  }
  // Codex plan usage comes from rate_limits in Codex's own session file; recent builds often
  // write null there (openai/codex#14880). Say what the newest session file shows. Informational.
  if (detected(AGENTS.codex)) checks.push({ id: 'codex-usage', ok: true, detail: codexUsageStatus() });

  // Recent activity (informational)
  let newest = 0, count = 0;
  try {
    for (const f of fs.readdirSync(P.eventsDir)) {
      if (!f.endsWith('.json')) continue;
      count++;
      newest = Math.max(newest, fs.statSync(path.join(P.eventsDir, f)).mtimeMs);
    }
  } catch (e) {}
  checks.push({ id: 'activity', ok: true, detail: count ? count + ' session file(s); last event ' + ago(newest) : 'No session events yet — start or use an agent session.' });
  try {
    const usage = fs.readdirSync(P.usageDir).filter((f) => f.endsWith('.json') && f !== 'wrapped.json');
    checks.push({ id: 'usage', ok: true, detail: usage.length ? 'Usage recorded for: ' + usage.map((f) => f.replace(/\.json$/, '')).join(', ') : 'No usage recorded yet (Claude Code with a claude.ai login, or Codex).' });
  } catch (e) {
    checks.push({ id: 'usage', ok: true, detail: 'No usage recorded yet (Claude Code with a claude.ai login, or Codex).' });
  }

  const failing = checks.filter((c) => !c.ok);
  const warnings = checks.filter((c) => c.warn);
  return {
    ok: !failing.length,
    summary: failing.length ? failing.length + ' problem(s) found' : warnings.length ? 'Healthy, with ' + warnings.length + ' warning(s)' : 'Everything looks healthy',
    checks,
    repairs: [...new Set(failing.map((c) => c.repair).filter(Boolean))],
  };
}

/** Run the named repairs (default: whatever diagnose suggests). Returns [{ repair, ok, output }]. */
function repair(which) {
  const todo = which && which.length ? which : diagnose().repairs;
  const unknown = todo.filter((r) => !REPAIRS[r]);
  if (unknown.length) throw new Error('Unknown repair(s): ' + unknown.join(', ') + '. Known: ' + Object.keys(REPAIRS).join(', ') + '.');
  const results = [];
  const node = (script, args) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8', timeout: 60000 });
    return { ok: r.status === 0, output: ((r.stdout || '') + (r.stderr || '')).trim() };
  };
  for (const r of todo) {
    if (r === 'scripts') {
      try {
        require('./legacy-migrate').migrate(HOME);   // an old ~/.agent-overlay folder moves to ~/.votive first
        fs.mkdirSync(P.root, { recursive: true, mode: 0o700 });   // PRIVACY.md promises a folder only you can read
        fs.mkdirSync(BIN, { recursive: true });
        for (const f of BIN_FILES) fs.copyFileSync(path.join(__dirname, f), path.join(BIN, f));
        // Thin shims for hooks of agent sessions started under the old name (see Scripts/legacy/).
        const legacyDir = path.join(__dirname, 'legacy');
        const shims = fs.existsSync(legacyDir) ? fs.readdirSync(legacyDir).filter((f) => f.endsWith('.js')) : [];
        for (const f of shims) fs.copyFileSync(path.join(legacyDir, f), path.join(BIN, f));
        results.push({ repair: r, ok: true, output: 'Copied ' + BIN_FILES.length + ' scripts to ' + BIN });
      } catch (e) { results.push({ repair: r, ok: false, output: e.message }); }
    } else if (r === 'hooks') {
      results.push(Object.assign({ repair: r }, node('install-agents.js', [])));
    } else if (r === 'statusline') {
      results.push(Object.assign({ repair: r }, node('install-statusline.js', [])));
    } else if (r === 'app') {
      if (WIN) {
        try {
          const exe = windowsAppPath();
          if (!fs.existsSync(exe)) throw new Error('not found: ' + exe);
          spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();   // our own app, started like a double-click
          results.push({ repair: r, ok: true, output: 'Started' });
        } catch (e) { results.push({ repair: r, ok: false, output: 'Could not start: ' + e.message }); }
        continue;
      }
      const uid = String(process.getuid());
      let k = run('/bin/launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + LABEL]);
      if (!k.ok && fs.existsSync(PLIST)) {
        run('/bin/launchctl', ['bootstrap', 'gui/' + uid, PLIST]);
        k = run('/bin/launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + LABEL]);
      }
      if (!k.ok && fs.existsSync(APP)) k = run('/usr/bin/open', ['-g', APP]);
      results.push({ repair: r, ok: k.ok, output: k.ok ? 'Restarted' : ('Could not restart: ' + k.out.trim()) });
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const fixIdx = args.indexOf('--fix');
  try {
    if (fixIdx === -1) {
      const d = diagnose();
      for (const c of d.checks) console.log((c.warn ? '  warn  ' : c.ok ? '  ok    ' : '  FAIL  ') + c.id.padEnd(18) + c.detail);
      console.log('\n' + d.summary + (d.repairs.length ? '. Fix with: node Scripts/doctor.js --fix' : '.'));
      process.exit(d.ok ? 0 : 1);
    }
    const which = (args[fixIdx + 1] && !args[fixIdx + 1].startsWith('--')) ? args[fixIdx + 1].split(',') : [];
    const results = repair(which);
    if (!results.length) console.log('Nothing to repair.');
    for (const r of results) console.log((r.ok ? '  done  ' : '  FAIL  ') + r.repair + ': ' + r.output.split('\n').join('\n        '));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { diagnose, repair, REPAIRS, BIN_FILES, windowsAppPath };
