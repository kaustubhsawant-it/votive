'use strict';
//
// Tests for the Node scripts: installers, event hook, statusLine wrapper, notify.
// Every test runs against a throwaway HOME, so your real ~/.claude is never touched.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const POSIX = process.platform !== 'win32';   // file modes only mean something on Unix
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers');
const { spawnSync, spawn } = require('child_process');

const S = path.join(__dirname, '..', 'Scripts');

const BIN_FILES = ['votive-event.js', 'agents.js', 'overlay-paths.js', 'progress.js', 'statusline-extras.js',
  'votive-statusline.js', 'votive-notify.js', 'notify-core.js', 'proc-info.js', 'limit-notify.js'];

function home(settings) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao test '));   // space on purpose
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(h, '.votive', 'bin'), { recursive: true });
  for (const f of BIN_FILES) fs.copyFileSync(path.join(S, f), path.join(h, '.votive', 'bin', f));
  if (settings !== undefined) fs.writeFileSync(path.join(h, '.claude', 'settings.json'), settings);
  return h;
}
const run = (h, script, args = [], input = '', env = {}) =>
  spawnSync('node', [path.join(S, script), ...args], { input, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, ...env } });
const binPath = (h, name) => path.join(h, '.votive', 'bin', name);
const runHook = (h, name, input, env = {}, args = []) =>
  spawnSync('node', [binPath(h, name), ...args], { input, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, ...env } });
const runEvent = (h, agent, payload, args = []) =>
  runHook(h, 'votive-event.js', payload === undefined ? '' : JSON.stringify(payload), {}, ['--agent', agent, ...args]);
const settings = (h) => JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'));
const backups = (h) => fs.readdirSync(path.join(h, '.claude')).filter((f) => f.startsWith('settings.json.bak-'));
const future = () => Math.floor(Date.now() / 1000) + 3600;

// ---------- installers

test('fresh machine with no settings.json installs cleanly', () => {
  const h = home();
  assert.equal(run(h, 'install-agents.js', ['--only', 'claude-code']).status, 0);
  assert.equal(backups(h).length, 0, 'no backup of a file that did not exist');
  assert.equal(run(h, 'install-statusline.js').status, 0);
  const cfg = settings(h);
  assert.ok(cfg.hooks.PostToolUse && cfg.hooks.SessionEnd);
  assert.match(cfg.statusLine.command, /votive-statusline\.js/);
});

test('empty settings.json counts as {}', () => {
  const h = home('  \n');
  assert.equal(run(h, 'install-agents.js', ['--only', 'claude-code']).status, 0);
});

test('non-object settings.json is refused without changes', () => {
  for (const bad of ['null', '[]', '{"a":1,}']) {
    const h = home(bad);
    assert.notEqual(run(h, 'install-agents.js', ['--only', 'claude-code']).status, 0, bad);
    assert.equal(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'), bad);
    assert.equal(backups(h).length, 0);
  }
});

test('backups keep the original permissions', () => {
  const h = home('{"env":{"SECRET":"x"}}');
  fs.chmodSync(path.join(h, '.claude', 'settings.json'), 0o600);
  run(h, 'install-agents.js', ['--only', 'claude-code']);
  const b = backups(h);
  assert.equal(b.length, 1);
  if (POSIX) {
    assert.equal(fs.statSync(path.join(h, '.claude', b[0])).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(h, '.claude', 'settings.json')).mode & 0o777, 0o600);
  }
});

test('hooks: idempotent, keeps user hooks, no rewrite when nothing changes', () => {
  const h = home(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-sound-hook' }] }] } }));
  run(h, 'install-agents.js', ['--only', 'claude-code']);
  const n = backups(h).length;
  const second = run(h, 'install-agents.js', ['--only', 'claude-code']);
  assert.match(second.stdout, /already wired/);
  assert.equal(backups(h).length, n, 'second run must not back up/rewrite');
  const cfg = settings(h);
  assert.equal(cfg.hooks.Stop.length, 2);
  assert.ok(JSON.stringify(cfg).includes('my-sound-hook'));
  assert.equal(cfg.hooks.Notification, undefined);
});

test('hooks: a non-array event is left alone, --remove unwires only ours', () => {
  const h = home(JSON.stringify({ hooks: { Stop: { weird: true }, SessionStart: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  run(h, 'install-agents.js', ['--only', 'claude-code']);
  assert.deepEqual(settings(h).hooks.Stop, { weird: true });
  run(h, 'install-agents.js', ['--remove', '--only', 'claude-code']);
  const cfg = settings(h);
  assert.ok(!JSON.stringify(cfg).includes('votive-event.js'));
  assert.deepEqual(cfg.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'mine' }] }]);
});

test('statusLine: wraps, restores the exact original object', () => {
  const original = { type: 'command', command: 'echo hi', padding: 2 };
  const h = home(JSON.stringify({ statusLine: original }));
  run(h, 'install-statusline.js');
  assert.match(settings(h).statusLine.command, /votive-statusline\.js/);
  assert.equal(settings(h).statusLine.padding, 2);
  assert.match(run(h, 'install-statusline.js').stdout, /already installed/);
  run(h, 'install-statusline.js', ['--remove']);
  assert.deepEqual(settings(h).statusLine, original);
  assert.match(run(h, 'install-statusline.js', ['--remove']).stdout, /nothing to restore/);
});

test('statusLine: an unexpected shape is not wrapped', () => {
  const h = home(JSON.stringify({ statusLine: 'echo hi' }));
  run(h, 'install-statusline.js');
  assert.equal(settings(h).statusLine, 'echo hi');
});

test('statusLine: --remove without wrapped.json leaves settings alone', () => {
  const h = home('{}');
  run(h, 'install-statusline.js');
  fs.rmSync(path.join(h, '.votive', 'usage', 'wrapped.json'));
  const before = fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8');
  assert.notEqual(run(h, 'install-statusline.js', ['--remove']).status, 0);
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'), before);
});

test('symlinked settings.json stays a symlink', () => {
  const h = home();
  const real = path.join(h, 'real-settings.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, path.join(h, '.claude', 'settings.json'));
  run(h, 'install-agents.js', ['--only', 'claude-code']);
  assert.ok(fs.lstatSync(path.join(h, '.claude', 'settings.json')).isSymbolicLink());
  assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).hooks);
});

// ---------- statusLine wrapper

function wrapped(h, command) {
  const d = path.join(h, '.votive', 'usage');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'wrapped.json'), JSON.stringify({ command }));
}
const usageOf = (h, agent) => JSON.parse(fs.readFileSync(path.join(h, '.votive', 'usage', agent + '.json'), 'utf8'));
const win = (h, agent, label) => usageOf(h, agent).windows.find((w) => w.label === label);

test('wrapper: records usage and passes output through unchanged', () => {
  const h = home();
  wrapped(h, helpers.cat());   // echoes stdin back: proves stdin reaches it and stdout passes through
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42.5, resets_at: future() }, seven_day: { used_percentage: 71, resets_at: future() } } });
  const r = runHook(h, 'votive-statusline.js', input);
  assert.equal(r.stdout, input);
  assert.equal(win(h, 'claude-code', 'Session').usedPercentage, 42.5);
  assert.equal(win(h, 'claude-code', 'Weekly').usedPercentage, 71);
});

test('wrapper: clamps, converts ms, rejects junk, merges windows', () => {
  const h = home();
  runHook(h, 'votive-statusline.js', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 250, resets_at: future() * 1000 }, seven_day: { used_percentage: 10, resets_at: future() } } }));
  assert.equal(win(h, 'claude-code', 'Session').usedPercentage, 100);
  assert.ok(win(h, 'claude-code', 'Session').resetsAt < 1e11);
  runHook(h, 'votive-statusline.js', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: future() } } }));
  assert.equal(win(h, 'claude-code', 'Session').usedPercentage, 5);
  assert.equal(win(h, 'claude-code', 'Weekly').usedPercentage, 10, 'seven-day kept from the previous write');
  runHook(h, 'votive-statusline.js', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 'x', resets_at: -1 } } }));
  assert.equal(win(h, 'claude-code', 'Session').usedPercentage, 5, 'junk ignored');
});

test('wrapper: no temp files left when the write fails', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.votive', 'usage', 'claude-code.json'), { recursive: true });
  runHook(h, 'votive-statusline.js', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: future() } } }));
  assert.deepEqual(fs.readdirSync(path.join(h, '.votive', 'usage')).filter((f) => f.endsWith('.tmp')), []);
});

test('wrapper: exit code passes through; no command means exit 0', () => {
  const h = home();
  assert.equal(runHook(h, 'votive-statusline.js', '{}').status, 0);
  wrapped(h, 'exit 7');
  assert.equal(runHook(h, 'votive-statusline.js', '{}').status, 7);
});

test('wrapper: pointing at itself does not recurse', () => {
  const h = home();
  wrapped(h, helpers.then(helpers.node + ' ' + helpers.q(binPath(h, 'votive-statusline.js')), helpers.say('end')));
  const r = runHook(h, 'votive-statusline.js', '{}');
  assert.equal(r.stdout.trim(), 'end');
});

test('wrapper: killing it also kills the wrapped command', async () => {
  const h = home();
  const marker = path.join(h, 'still-running');
  wrapped(h, `sleep 2 && touch ${JSON.stringify(marker)}`);
  const p = spawn('node', [binPath(h, 'votive-statusline.js')], { env: { ...process.env, HOME: h, USERPROFILE: h } });
  p.stdin.end('{}');
  await new Promise((r) => setTimeout(r, 400));
  p.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!fs.existsSync(marker), 'wrapped command survived its parent');
});

// ---------- hook + notify

const ovFile = (h, id, agent = 'claude-code') => path.join(h, '.votive', 'events', agent + '--' + id + '.json');
const ev = (h, id, agent) => JSON.parse(fs.readFileSync(ovFile(h, id, agent), 'utf8'));

test('hook: events map to states; PostToolUse clears an error', () => {
  const h = home();
  runEvent(h, 'claude-code', { session_id: 's1', hook_event_name: 'PostToolUseFailure' });
  assert.equal(ev(h, 's1').lastEvent, 'error');
  runEvent(h, 'claude-code', { session_id: 's1', hook_event_name: 'PostToolUse' });
  assert.equal(ev(h, 's1').lastEvent, 'working');
  runEvent(h, 'claude-code', { session_id: 's1', hook_event_name: 'SessionEnd' });
  assert.ok(!fs.existsSync(ovFile(h, 's1')));
});

test('hook: always exits 0 silently on bad input, parses big payloads', () => {
  const h = home();
  for (const bad of ['', 'garbage', '{"session_id":5}', '{"session_id":"../../x","hook_event_name":"Stop"}']) {
    const r = runHook(h, 'votive-event.js', bad, {}, ['--agent', 'claude-code']);
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  assert.ok(!fs.existsSync(path.join(h, 'x.json')));
  const big = JSON.stringify({ session_id: 'big', hook_event_name: 'PostToolUseFailure', tool_response: 'x'.repeat(3 << 20) });
  runHook(h, 'votive-event.js', big, {}, ['--agent', 'claude-code']);
  assert.equal(JSON.parse(fs.readFileSync(ovFile(h, 'big'))).lastEvent, 'error');
});

function registerSession(h, id) {
  // The notify CLI walks up from its own parent pid; register this test process's pid.
  const d = path.join(h, '.claude', 'sessions');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, process.pid + '.json'), JSON.stringify({ sessionId: id }));
}

test('notify: works with no prior overlay file, and a hook event keeps it', () => {
  const h = home();
  registerSession(h, 'n1');
  const r = spawnSync('node', [binPath(h, 'votive-notify.js'), 'Build finished'], { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h } });
  assert.equal(r.status, 0, r.stderr);
  let f = JSON.parse(fs.readFileSync(ovFile(h, 'n1')));
  assert.equal(f.notifyMessage, 'Build finished');
  assert.equal(typeof f.lastEvent, 'string');
  assert.equal(typeof f.lastEventAt, 'number');
  runEvent(h, 'claude-code', { session_id: 'n1', hook_event_name: 'Stop' });
  f = JSON.parse(fs.readFileSync(ovFile(h, 'n1')));
  assert.equal(f.lastEvent, 'done');
  assert.equal(f.notifyMessage, 'Build finished');
});

test('notify: clipping never splits an emoji; non-strings are rejected', () => {
  const h = home();
  registerSession(h, 'n2');
  const core = require(path.join(S, 'notify-core.js'));
  const msg = 'a'.repeat(499) + '😀'.repeat(50);
  spawnSync('node', [binPath(h, 'votive-notify.js'), msg], { env: { ...process.env, HOME: h, USERPROFILE: h } });
  const raw = fs.readFileSync(ovFile(h, 'n2'), 'utf8');
  assert.ok(!/\\ud83d(?!\\ude00)/i.test(raw), 'lone surrogate written');
  assert.equal(Array.from(JSON.parse(raw).notifyMessage).length, 501);
  assert.equal(core.writeNotify(123, process.pid).ok, false);
});
