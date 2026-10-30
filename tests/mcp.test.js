'use strict';
//
// Settings, diagnose and repair — the scripts and the MCP tools that wrap them.
// Preferences go to a throwaway defaults domain and files to a throwaway HOME, so the real
// app's settings and your agents' configs are never touched. The `app` repair (which restarts
// the real menu-bar app through launchd) is deliberately not exercised here.
//
//   node --test tests/*.test.js
//
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'Scripts');
const DOMAIN = 'dev.votive.tests.' + process.pid;
// macOS keeps preferences in a defaults domain, everywhere else they are one JSON file in the home.
const FILE_STORE = process.platform !== 'darwin';
const storePath = (h) => path.join(h || os.tmpdir(), '.votive', 'settings.json');
const storeFile = storePath();
const resetStore = () => {
  if (FILE_STORE) { try { fs.rmSync(storeFile); } catch (e) {} return; }
  try { execFileSync('/usr/bin/defaults', ['delete', DOMAIN], { stdio: 'ignore' }); } catch (e) {}
};
after(resetStore);

const env = (h) => ({ ...process.env, HOME: h || os.tmpdir(), USERPROFILE: h || os.tmpdir(), VOTIVE_DEFAULTS_DOMAIN: DOMAIN });
const settingsCli = (args, h) => spawnSync('node', [path.join(S, 'overlay-settings.js'), ...args], { encoding: 'utf8', env: env(h) });
const doctorCli = (args, h) => spawnSync('node', [path.join(S, 'doctor.js'), ...args], { encoding: 'utf8', env: env(h) });
const readDefault = (key, h) => {
  if (FILE_STORE) {
    try {
      const v = JSON.parse(fs.readFileSync(storePath(h), 'utf8'))[key];
      return v === undefined ? null : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    } catch (e) { return null; }
  }
  try { return execFileSync('/usr/bin/defaults', ['read', DOMAIN, key], { encoding: 'utf8' }).trim(); } catch (e) { return null; }
};

// ---------- settings

test('settings: read, change and read back', () => {
  resetStore();
  const before = JSON.parse(settingsCli([]).stdout);
  assert.equal(before.popupOnEveryChange.value, false);
  assert.equal(before.notifyOnRequest.value, true);
  assert.equal(before.sounds.value, true);
  assert.equal(before.soundNotify.value, 'Glass');
  assert.equal(before.soundDone.value, 'none');
  assert.equal(before.stuckThresholdMinutes.value, 8);

  const r = settingsCli(['popupOnEveryChange=true', 'stuckThresholdMinutes=20']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /popupOnEveryChange: false → true/);
  assert.equal(readDefault('dialogAlertsOn'), '1', 'written to the key the app reads');
  assert.equal(readDefault('stuckThresholdMinutes'), '20');

  const now = JSON.parse(settingsCli([]).stdout);
  assert.equal(now.popupOnEveryChange.value, true);
  assert.equal(now.stuckThresholdMinutes.value, 20);
});

test('settings: an invalid change is rejected and nothing is written', () => {
  settingsCli(['bannerOnEveryChange=false']);
  for (const bad of [['bannerOnEveryChange=true', 'stuckThresholdMinutes=999'], ['bannerOnEveryChange=true', 'nope=1'], ['bannerOnEveryChange=maybe']]) {
    const r = settingsCli(bad);
    assert.equal(r.status, 1, bad.join(' '));
    assert.notEqual(readDefault('notificationsOn'), '1', 'valid part of a bad batch must not be applied');
  }
});

test('settings: sounds take none, a macOS sound, or a file in ~/.votive/sounds', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao sounds '));
  fs.mkdirSync(path.join(h, '.votive', 'sounds'), { recursive: true });
  fs.writeFileSync(path.join(h, '.votive', 'sounds', 'done.mp3'), '');

  let r = settingsCli(['soundDone=hero', 'soundStuck=none'], h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readDefault('soundDone', h), 'Hero', 'system sound names are normalized');

  r = settingsCli(['soundDone=done.mp3'], h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readDefault('soundDone', h), 'done.mp3');

  for (const bad of ['soundDone=Nope', 'soundDone=missing.mp3', 'soundDone=../done.mp3', 'soundDone=/tmp/x.mp3']) {
    r = settingsCli([bad], h);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /done\.mp3/, 'the error lists the sounds you have');
  }
  assert.equal(readDefault('soundDone', h), 'done.mp3', 'a rejected value changes nothing');
  fs.rmSync(h, { recursive: true, force: true });
});

// ---------- diagnose / repair (throwaway HOME)

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao doctor '));
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{}');
  return h;
}

test('diagnose: reports missing scripts, hooks and status line with the right repairs', () => {
  const h = home();
  const r = doctorCli([], h);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+app-installed/);
  assert.match(r.stdout, /FAIL\s+scripts/);
  assert.match(r.stdout, /FAIL\s+agent-claude-code/);
  assert.match(r.stdout, /FAIL\s+claude-usage/);
});

test('repair: scripts, hooks and status line fix their checks', () => {
  const h = home();
  const r = doctorCli(['--fix', 'scripts,hooks,statusline'], h);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const d = doctorCli([], h).stdout;
  assert.match(d, /ok\s+scripts/);
  assert.match(d, /ok\s+agent-claude-code/);
  assert.match(d, /ok\s+claude-usage/);
  assert.ok(fs.existsSync(path.join(h, '.votive', 'bin', 'votive-event.js')));
  assert.equal(doctorCli(['--fix', 'bogus'], h).status, 1, 'unknown repair rejected');
});

test('install.sh copies the same scripts the doctor checks', () => {
  const { BIN_FILES } = require(path.join(S, 'doctor.js'));
  const sh = fs.readFileSync(path.join(S, 'install.sh'), 'utf8');
  const loop = /for f in ([^;]+); do\s+cp "\$ROOT\/Scripts\/\$f"/.exec(sh);
  assert.ok(loop, 'copy loop found in install.sh');
  assert.deepEqual(loop[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean).sort(), [...BIN_FILES].sort());
});

// ---------- the MCP server itself, over stdio

// What the user does with the menu item "Let agents change settings" (AGEN-22); no tool can do this.
function allowAgentChanges(h) {
  if (FILE_STORE) {
    let o = {}; try { o = JSON.parse(fs.readFileSync(storePath(h), 'utf8')); } catch (e) {}
    o.agentWritesAllowed = true;
    fs.mkdirSync(path.dirname(storePath(h)), { recursive: true });
    fs.writeFileSync(storePath(h), JSON.stringify(o));
  } else execFileSync('/usr/bin/defaults', ['write', DOMAIN, 'agentWritesAllowed', '-bool', 'true']);
}

const sdkInstalled = fs.existsSync(path.join(ROOT, 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk'));

function mcpSession(h) {
  const p = spawn('node', [path.join(ROOT, 'mcp-server', 'index.js')], { env: env(h), stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  return { call, close: () => p.kill(), notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}

test('mcp: lists five tools and changes settings through settings_set once the user allows it', { skip: !sdkInstalled && 'run npm install in mcp-server first' }, async () => {
  const h = home();
  settingsCli(['popupOnEveryChange=true'], h);   // a known starting value, whichever store is in use
  allowAgentChanges(h);
  const s = mcpSession(h);
  try {
    await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    s.notify('notifications/initialized');
    const list = await s.call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['diagnose', 'notify', 'repair', 'settings_get', 'settings_set']);

    const read = await s.call('tools/call', { name: 'settings_get', arguments: {} });
    assert.match(read.result.content[0].text, /popupOnEveryChange/);

    const set = await s.call('tools/call', { name: 'settings_set', arguments: { changes: { popupOnEveryChange: false, bannerOnEveryChange: false } } });
    assert.ok(!set.result.isError, set.result.content[0].text);
    assert.match(set.result.content[0].text, /popupOnEveryChange: (true|false) → false/);
    assert.equal(readDefault('dialogAlertsOn', h), '0');

    const bad = await s.call('tools/call', { name: 'settings_set', arguments: { changes: { stuckThresholdMinutes: -3 } } });
    assert.ok(bad.result.isError || bad.error, 'invalid value rejected');

    const diag = await s.call('tools/call', { name: 'diagnose', arguments: {} });
    assert.match(diag.result.content[0].text, /scripts:/);
  } finally { s.close(); }
});

// ---------- review regressions

test('settings: the stuck threshold only takes real whole numbers', () => {
  settingsCli(['stuckThresholdMinutes=8']);
  for (const bad of ['stuckThresholdMinutes=', 'stuckThresholdMinutes= ', 'stuckThresholdMinutes=true', 'stuckThresholdMinutes=0x10', 'stuckThresholdMinutes=1e1', 'stuckThresholdMinutes=-3']) {
    assert.equal(settingsCli([bad]).status, 1, bad);
  }
  assert.equal(readDefault('stuckThresholdMinutes'), '8');
  const { validate } = require(path.join(S, 'overlay-settings.js'));
  for (const v of [null, false, true, [5], '']) assert.throws(() => validate('stuckThresholdMinutes', v), String(v));
  assert.equal(validate('stuckThresholdMinutes', ' 15 '), 15);
});

test('settings: a value that is already set is reported as unchanged', () => {
  settingsCli(['usagePulse=true']);
  const r = settingsCli(['usagePulse=true']);
  assert.match(r.stdout, /usagePulse: already true/);
  assert.doesNotMatch(r.stdout, /→/);
});

test('diagnose: catches partial wiring, stale paths and an old status line; repair fixes them', () => {
  const h = home();
  const ok = doctorCli(['--fix', 'scripts,hooks,statusline'], h);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const file = path.join(h, '.claude', 'settings.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete cfg.hooks.PostToolUse;                                                        // partly wired
  cfg.hooks.Stop = [{ hooks: [{ type: 'command', command: "node '/old/place/votive-event.js' --agent claude-code" }] }]; // stale path
  cfg.statusLine.command = "node '/old/hooks/votive-statusline.js'";           // old usage script
  fs.writeFileSync(file, JSON.stringify(cfg));

  const d = doctorCli([], h);
  assert.equal(d.status, 1);
  assert.match(d.stdout, /FAIL\s+agent-claude-code\s+Only partly wired; missing or outdated: PostToolUse, Stop/);
  assert.match(d.stdout, /FAIL\s+claude-usage\s+The status line points at an old copy/);

  const fix = doctorCli(['--fix', 'hooks,statusline'], h);
  assert.equal(fix.status, 0, fix.stdout + fix.stderr);
  const after = doctorCli([], h).stdout;
  assert.match(after, /ok\s+agent-claude-code/);
  assert.match(after, /ok\s+claude-usage/);
  const fixed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!JSON.stringify(fixed.hooks.Stop).includes('/old/place/'), 'stale entry replaced, not kept alongside');
  assert.equal(fixed.hooks.Stop.length, 1);
});

test('install.sh keeps going when one agent config is broken', () => {
  const sh = fs.readFileSync(path.join(S, 'install.sh'), 'utf8');
  assert.match(sh, /node "\$ROOT\/Scripts\/install-agents\.js" \|\|/);
});

test('mcp: bad argument shapes get a clear error, never a surprise action', { skip: !sdkInstalled && 'run npm install in mcp-server first' }, async () => {
  const h = home();
  allowAgentChanges(h);
  const s = mcpSession(h);
  try {
    await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    s.notify('notifications/initialized');
    const rep = await s.call('tools/call', { name: 'repair', arguments: { repairs: 'scripts' } });
    assert.ok(rep.result.isError);
    assert.match(rep.result.content[0].text, /must be a list/);
    const nul = await s.call('tools/call', { name: 'settings_set', arguments: { changes: null } });
    assert.ok(nul.result.isError, 'settings_set with nothing to change is an error that points at settings_get');
    assert.match(nul.result.content[0].text, /settings_get/);
    const get = await s.call('tools/call', { name: 'settings_get', arguments: {} });
    assert.match(get.result.content[0].text, /Current Votive settings/);
    const str = await s.call('tools/call', { name: 'settings_set', arguments: { changes: 'off' } });
    assert.ok(str.result.isError);
    const nulInt = await s.call('tools/call', { name: 'settings_set', arguments: { changes: { stuckThresholdMinutes: null } } });
    assert.ok(nulInt.result.isError, 'null no longer turns stuck detection off');
  } finally { s.close(); }
});
