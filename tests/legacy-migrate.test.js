'use strict';
//
// The move from the product's earlier name, Agent Overlay, to Votive: the data folder, the hooks of
// agent sessions that are already running, hook entries in an agent's settings, and the app's
// settings. Everything runs against a throwaway HOME; no credential is touched.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { migrate } = require('../Scripts/legacy-migrate');

const S = path.join(__dirname, '..', 'Scripts');
const ROOT = path.join(__dirname, '..');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao legacy '));
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const env = (h) => ({ ...process.env, HOME: h, USERPROFILE: h });
const run = (h, script, args, input) => spawnSync(process.execPath, [path.join(S, script), ...args], { input: input || '', encoding: 'utf8', env: env(h) });
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; } };
// Windows needs a privilege for links and a junction is reported differently; the link is a convenience there.
const LINKS = process.platform !== 'win32';

test('the old data folder moves to ~/.votive and keeps its files', () => {
  const h = home();
  write(path.join(h, '.agent-overlay', 'snippets.json'), '["a"]');
  write(path.join(h, '.agent-overlay', 'events', 'claude-code--s1.json'), '{"state":"done"}');
  write(path.join(h, '.agent-overlay', 'sounds', 'mine.wav'), 'x');
  const log = migrate(h);
  assert.ok(log.length >= 1);
  assert.equal(fs.readFileSync(path.join(h, '.votive', 'snippets.json'), 'utf8'), '["a"]');
  assert.equal(fs.readFileSync(path.join(h, '.votive', 'events', 'claude-code--s1.json'), 'utf8'), '{"state":"done"}');
  assert.ok(fs.existsSync(path.join(h, '.votive', 'sounds', 'mine.wav')));
  if (LINKS) {
    assert.ok(isLink(path.join(h, '.agent-overlay')), 'the old path is a link now');
    assert.equal(fs.readFileSync(path.join(h, '.agent-overlay', 'snippets.json'), 'utf8'), '["a"]', 'and it reads through');
  }
});

test('running it again changes nothing', () => {
  const h = home();
  write(path.join(h, '.agent-overlay', 'snippets.json'), '[]');
  migrate(h);
  assert.deepEqual(migrate(h), []);
  assert.ok(fs.existsSync(path.join(h, '.votive', 'snippets.json')));
});

test('a fresh install with no old folder does nothing', () => {
  const h = home();
  assert.deepEqual(migrate(h), []);
  assert.ok(!fs.existsSync(path.join(h, '.votive')));
  assert.ok(!fs.existsSync(path.join(h, '.agent-overlay')));
});

test('both folders present: the new one wins, the old items are parked, nothing is deleted', () => {
  const h = home();
  write(path.join(h, '.votive', 'snippets.json'), '["new"]');
  write(path.join(h, '.agent-overlay', 'snippets.json'), '["old"]');
  write(path.join(h, '.agent-overlay', 'usage', 'wrapped.json'), '{"v":2}');
  migrate(h);
  assert.equal(fs.readFileSync(path.join(h, '.votive', 'snippets.json'), 'utf8'), '["new"]');
  assert.equal(fs.readFileSync(path.join(h, '.votive', 'usage', 'wrapped.json'), 'utf8'), '{"v":2}', 'what the new folder lacked came over');
  assert.equal(fs.readFileSync(path.join(h, '.votive', 'from-agent-overlay', 'snippets.json'), 'utf8'), '["old"]', 'the conflicting old file is kept');
});

test('--dry-run reports and changes nothing', () => {
  const h = home();
  write(path.join(h, '.agent-overlay', 'snippets.json'), '[]');
  const log = migrate(h, { dryRun: true });
  assert.ok(log.length >= 1);
  assert.ok(fs.existsSync(path.join(h, '.agent-overlay', 'snippets.json')));
  assert.ok(!fs.existsSync(path.join(h, '.votive')));
  assert.ok(!isLink(path.join(h, '.agent-overlay')));
});

test('an old adapter file is removed only when it is ours', () => {
  const h = home();
  const ours = path.join(h, '.copilot', 'hooks', 'agent-overlay.json');
  const theirs = path.join(h, '.config', 'opencode', 'plugins', 'agent-overlay.js');
  write(ours, '{"hooks":{"agentStop":[{"command":"node /x/agent-overlay-event.js"}]}}');
  write(theirs, '// my own plugin that happens to share the name');
  migrate(h);
  assert.ok(!fs.existsSync(ours));
  assert.ok(fs.existsSync(theirs), 'a file we cannot prove is ours stays');
});

test('install-agents replaces a hook that points at the old script, once', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  const old = 'node "' + path.join(h, '.agent-overlay', 'bin', 'agent-overlay-event.js') + '" --agent claude-code';
  const mine = { hooks: [{ type: 'command', command: 'echo mine' }] };
  write(path.join(h, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: old }] }, mine], SessionStart: [{ hooks: [{ type: 'command', command: old }] }] },
  }));
  const first = run(h, 'install-agents.js', []);
  assert.equal(first.status, 0, first.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'));
  const text = JSON.stringify(cfg);
  assert.ok(!text.includes('agent-overlay-event.js'), 'no hook points at the old name any more');
  assert.equal((text.match(/votive-event\.js/g) || []).length, Object.values(cfg.hooks).reduce((n, arr) => n + arr.filter((g) => JSON.stringify(g).includes('votive-event.js')).length, 0));
  assert.ok(cfg.hooks.Stop.some((g) => JSON.stringify(g).includes('echo mine')), 'a hook that is not ours is kept');
  const again = run(h, 'install-agents.js', []);
  assert.equal(again.status, 0);
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'), JSON.stringify(cfg, null, 2) + '\n', 'a second run changes nothing');
});

test('install-statusline treats the old wrapper as ours: it is repointed, not wrapped again', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  const oldCmd = 'node "' + path.join(h, '.agent-overlay', 'bin', 'agent-overlay-statusline.js') + '"';
  write(path.join(h, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: oldCmd } }));
  const r = run(h, 'install-statusline.js', []);
  assert.equal(r.status, 0, r.stderr);
  const sl = JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8')).statusLine;
  assert.ok(sl.command.includes('votive-statusline.js'));
  assert.ok(!sl.command.includes('agent-overlay'));
  assert.ok(!fs.existsSync(path.join(h, '.votive', 'usage', 'wrapped.json')), 'the old wrapper is not saved as "your previous status line"');
});

test('a hook of a session started before the rename still works through the old path', { skip: !LINKS && 'needs a link' }, () => {
  const h = home();
  write(path.join(h, '.agent-overlay', 'snippets.json'), '[]');        // an old install
  const fix = run(h, 'doctor.js', ['--fix', 'scripts']);               // the repair moves the folder and copies the scripts + shims
  assert.equal(fix.status === 0 || fix.status === 1, true, fix.stderr);
  assert.ok(fs.existsSync(path.join(h, '.votive', 'bin', 'agent-overlay-event.js')), 'shim present');
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'legacy1', cwd: '/p' });
  // Exactly what the old hook command line runs:
  const r = spawnSync(process.execPath, [path.join(h, '.agent-overlay', 'bin', 'agent-overlay-event.js'), '--agent', 'claude-code'], { input: payload, encoding: 'utf8', env: env(h) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(h, '.votive', 'events', 'claude-code--legacy1.json')), 'the event landed in the new folder');
});

test('the app does not carry the "let agents change settings" switch over to the renamed app', () => {
  const swift = fs.readFileSync(path.join(ROOT, 'Votive', 'Services', 'LegacySettings.swift'), 'utf8');
  assert.match(swift, /notCarried: Set<String> = \["agentWritesAllowed"\]/);
  assert.match(swift, /oldDomain = "app\.agentoverlay\.AgentOverlay"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'Votive', 'AppDelegate.swift'), 'utf8'), /LegacySettings\.migrate\(\)/);
});

test('install.sh runs the migration, copies the shims and removes the old login item', () => {
  const sh = fs.readFileSync(path.join(S, 'install.sh'), 'utf8');
  assert.match(sh, /legacy-migrate\.js/);
  assert.match(sh, /Scripts\/legacy\/agent-overlay-\*\.js/);
  assert.match(sh, /bootout "gui\/\$UID_\/\$OLD_LABEL"/);
  assert.match(sh, /claude mcp remove agent-overlay/);
});
