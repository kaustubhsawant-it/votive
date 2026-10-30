'use strict';
//
// AGEN-22: the MCP tools that change things are guarded by something other than a sentence.
//   - settings is split into settings_get (read only) and settings_set; repair and settings_set are
//     refused until the USER turns on "Let agents change settings" (preference agentWritesAllowed,
//     default off, not one of the settings the tools can write);
//   - every call that changed something, and every refusal, leaves one line in audit.jsonl (0600,
//     capped), with what is needed to undo it, and the lines also drive the rate limits;
//   - notify and the writers are rate limited.
// The server runs against a throwaway HOME and the file settings store, so the real app's
// preferences and files are never touched.
//
//   node --test tests/mcp-guard.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sdkInstalled = fs.existsSync(path.join(ROOT, 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk'));
const skip = !sdkInstalled && 'run npm install in mcp-server first';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao guard '));
const store = (h) => path.join(h, '.votive', 'settings.json');
const audit = (h) => path.join(h, '.votive', 'audit.jsonl');
const env = (h) => ({ ...process.env, HOME: h, USERPROFILE: h, VOTIVE_SETTINGS_BACKEND: 'file' });
// What the user does with the menu switch: not something a tool can do.
function userSwitch(h, on) {
  fs.mkdirSync(path.dirname(store(h)), { recursive: true });
  let o = {}; try { o = JSON.parse(fs.readFileSync(store(h), 'utf8')); } catch (e) {}
  o.agentWritesAllowed = on;
  fs.writeFileSync(store(h), JSON.stringify(o));
}
const readStore = (h) => { try { return JSON.parse(fs.readFileSync(store(h), 'utf8')); } catch (e) { return {}; } };
const auditLines = (h) => { try { return fs.readFileSync(audit(h), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
function seedAudit(h, entries) {
  fs.mkdirSync(path.dirname(audit(h)), { recursive: true });
  fs.writeFileSync(audit(h), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function session(h) {
  const p = spawn('node', [path.join(ROOT, 'mcp-server', 'index.js')], { env: env(h), stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const call = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result;
  const ready = async () => { await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); };
  return { call, tool, ready, close: () => p.kill() };
}
const text = (r) => r.content[0].text;

test('tools: settings is split, and every tool declares what it does', { skip }, async () => {
  const s = session(home());
  try {
    await s.ready();
    const tools = (await s.call('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['diagnose', 'notify', 'repair', 'settings_get', 'settings_set']);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['diagnose', 'settings_get']) assert.equal(by[n].annotations.readOnlyHint, true, n + ' is read only');
    for (const n of ['settings_set', 'repair', 'notify']) assert.equal(by[n].annotations.readOnlyHint, false, n);
    assert.equal(by.repair.annotations.destructiveHint, true, 'repair rewrites other tools\' config files');
    assert.equal(by.settings_set.annotations.destructiveHint, false);
    for (const t of tools) assert.equal(t.annotations.openWorldHint, false, t.name + ' touches only this Mac');
    // Claude Code ignores the standard hints; this marker makes it ask on every call.
    assert.equal(by.settings_set._meta['anthropic/requiresUserInteraction'], true);
    assert.equal(by.repair._meta['anthropic/requiresUserInteraction'], true);
    for (const n of ['diagnose', 'settings_get', 'notify']) assert.ok(!by[n]._meta || by[n]._meta['anthropic/requiresUserInteraction'] === undefined, n + ' must not prompt every time');
  } finally { s.close(); }
});

test('default off: settings_set and repair are refused, nothing changes, the refusal is recorded', { skip }, async () => {
  const h = home();
  const s = session(h);
  try {
    await s.ready();
    const set = await s.tool('settings_set', { changes: { popupOnEveryChange: true } });
    assert.ok(set.isError);
    assert.match(text(set), /unless the user allows it/);
    assert.match(text(set), /Let agents change settings/);
    assert.equal(readStore(h).dialogAlertsOn, undefined, 'nothing was written');
    const rep = await s.tool('repair', { repairs: ['scripts'] });
    assert.ok(rep.isError);
    assert.match(text(rep), /unless the user allows it/);
    assert.ok(!fs.existsSync(path.join(h, '.votive', 'bin')), 'repair did not run');
    const lines = auditLines(h);
    assert.deepEqual(lines.map((l) => [l.tool, l.ok]), [['settings_set', false], ['repair', false]]);
    assert.ok(lines.every((l) => typeof l.at === 'number' && typeof l.summary === 'string'));
    // Reading still works with the switch off.
    assert.match(text(await s.tool('settings_get')), /popupOnEveryChange/);
    assert.match(text(await s.tool('diagnose')), /scripts:/);
  } finally { s.close(); }
});

test('the switch is not a setting: no tool can read it as a setting or flip it', { skip }, async () => {
  const h = home();
  const s = session(h);
  try {
    await s.ready();
    assert.doesNotMatch(text(await s.tool('settings_get')), /agentWritesAllowed/);
    userSwitch(h, true);            // the user turns it on ...
    const r = await s.tool('settings_set', { changes: { agentWritesAllowed: false } });
    assert.ok(r.isError, 'unknown setting');
    assert.equal(readStore(h).agentWritesAllowed, true, '... and a tool cannot turn it off or on');
    userSwitch(h, false);
    const r2 = await s.tool('settings_set', { changes: { agentWritesAllowed: true } });
    assert.ok(r2.isError);
    assert.equal(readStore(h).agentWritesAllowed, false);
  } finally { s.close(); }
});

test('the switch is on only for exactly true: strings, numbers and junk read as off', { skip }, async () => {
  for (const value of ['yes', 'true', 1, [true], { on: true }, null]) {
    const h = home();
    fs.mkdirSync(path.dirname(store(h)), { recursive: true });
    fs.writeFileSync(store(h), JSON.stringify({ agentWritesAllowed: value }));
    const s = session(h);
    try {
      await s.ready();
      const r = await s.tool('settings_set', { changes: { sounds: false } });
      assert.ok(r.isError, 'refused for ' + JSON.stringify(value));
      assert.equal(readStore(h).soundsOn, undefined);
    } finally { s.close(); }
  }
});

test('switch on: a change is applied, audited with its undo, and shown by settings_get', { skip }, async () => {
  const h = home();
  userSwitch(h, true);
  const s = session(h);
  try {
    await s.ready();
    const r = await s.tool('settings_set', { changes: { stuckThresholdMinutes: 20 } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /stuckThresholdMinutes: 8 → 20/);
    assert.equal(readStore(h).stuckThresholdMinutes, 20);
    const [line] = auditLines(h);
    assert.equal(line.tool, 'settings_set'); assert.equal(line.ok, true);
    assert.deepEqual(line.undo, { stuckThresholdMinutes: { from: 8, to: 20 } });
    assert.match(line.summary, /stuckThresholdMinutes/);
    assert.match(text(await s.tool('settings_get')), /stuckThresholdMinutes: 20/);
    // A bad value is an error and is not counted as a change.
    const bad = await s.tool('settings_set', { changes: { stuckThresholdMinutes: -3 } });
    assert.ok(bad.isError);
    assert.equal(readStore(h).stuckThresholdMinutes, 20);
    assert.equal(auditLines(h).filter((l) => l.ok === true).length, 1);
    // Nothing changed (same value): reported, and not audited as a change.
    const same = await s.tool('settings_set', { changes: { stuckThresholdMinutes: 20 } });
    assert.ok(!same.isError);
    assert.equal(auditLines(h).filter((l) => l.ok === true).length, 1);
  } finally { s.close(); }
});

test('rate limits: the sixth settings change in an hour and the fourth notify in a minute are refused', { skip }, async () => {
  const h = home();
  userSwitch(h, true);
  const now = Date.now();
  seedAudit(h, [1, 2, 3, 4, 5].map((i) => ({ at: now - i * 1000, tool: 'settings_set', agent: 'claude-code', ok: true, summary: 'x' })));
  const s = session(h);
  try {
    await s.ready();
    const r = await s.tool('settings_set', { changes: { sounds: false } });
    assert.ok(r.isError); assert.match(text(r), /Rate limit/);
    assert.equal(readStore(h).soundsOn, undefined, 'a refused call changes nothing');
    seedAudit(h, [1, 2, 3].map((i) => ({ at: Date.now() - i * 1000, tool: 'notify', agent: 'claude-code', ok: true, summary: 'x' })));
    const n = await s.tool('notify', { message: 'a perfectly normal message' });
    assert.ok(n.isError); assert.match(text(n), /Rate limit/);
    // Old entries and refusals do not count against the limit.
    seedAudit(h, [{ at: Date.now() - 2 * 3600 * 1000, tool: 'settings_set', ok: true, summary: 'old' }, ...[1, 2, 3, 4, 5, 6].map((i) => ({ at: Date.now() - i * 1000, tool: 'settings_set', ok: false, summary: 'refused' }))]);
    const ok = await s.tool('settings_set', { changes: { sounds: false } });
    assert.ok(!ok.isError, text(ok));
  } finally { s.close(); }
});

test('audit file: private, capped, tolerant of junk, and never holds a notify message', { skip }, async () => {
  const h = home();
  userSwitch(h, true);
  const old = Array.from({ length: 205 }, (_, i) => ({ at: Date.now() - 5 * 3600 * 1000 + i, tool: 'repair', ok: true, summary: 'old ' + i }));
  fs.mkdirSync(path.dirname(audit(h)), { recursive: true });
  fs.writeFileSync(audit(h), old.map((e) => JSON.stringify(e)).join('\n') + '\nnot json at all\n');
  // The MCP server is a child of this process, so a registry entry for our pid makes notify find a session and succeed.
  fs.mkdirSync(path.join(h, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ sessionId: 'guard1' }));
  const s = session(h);
  try {
    await s.ready();
    const r = await s.tool('settings_set', { changes: { sounds: false } });
    assert.ok(!r.isError, text(r));
    const n = await s.tool('notify', { message: 'SECRET-MESSAGE-TEXT' });
    assert.ok(!n.isError, 'notify succeeded: ' + text(n));
    assert.ok(auditLines(h).some((l) => l.tool === 'notify' && l.ok === true), 'the notify call was audited');
    const raw = fs.readFileSync(audit(h), 'utf8');
    assert.ok(!raw.includes('SECRET-MESSAGE-TEXT'), 'message text must never be stored');
    assert.ok(raw.split('\n').filter(Boolean).length <= 200, 'capped at 200 lines');
    assert.ok(auditLines(h).some((l) => l.tool === 'settings_set' && l.ok === true), 'the newest entry survived the cap');
    if (process.platform !== 'win32') assert.equal(fs.statSync(audit(h)).mode & 0o777, 0o600);
  } finally { s.close(); }
});

test('mcp-guard module: refuse() reads the switch from the same store the app writes', { skip: process.platform !== 'darwin' && 'the defaults domain only exists on macOS' }, () => {
  const { spawnSync, execFileSync } = require('child_process');
  const domain = 'dev.votive.guardtest.' + process.pid;
  const run = () => spawnSync('node', ['-e', "const g=require(process.argv[1]); console.log(g.writesAllowed())", path.join(ROOT, 'Scripts', 'mcp-guard.js')], { encoding: 'utf8', env: { ...process.env, HOME: home(), VOTIVE_DEFAULTS_DOMAIN: domain } }).stdout.trim();
  try {
    assert.equal(run(), 'false', 'default is off');
    execFileSync('/usr/bin/defaults', ['write', domain, 'agentWritesAllowed', '-bool', 'true']);
    assert.equal(run(), 'true');
    execFileSync('/usr/bin/defaults', ['write', domain, 'agentWritesAllowed', '-bool', 'false']);
    assert.equal(run(), 'false');
  } finally { try { execFileSync('/usr/bin/defaults', ['delete', domain], { stdio: 'ignore' }); } catch (e) {} }
});
