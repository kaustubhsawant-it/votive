'use strict';
//
// PRIVACY.md lists every path Votive writes, in the fenced block marked `text writes`.
// These tests fail when the code writes somewhere that block does not list, so the page cannot
// quietly stop being true. Scripts run against a throwaway HOME; the Swift app is checked by
// reading its source (a new write call must be added here AND to PRIVACY.md).
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'Scripts');
const privacy = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');

function manifest() {
  const m = /```text writes\n([\s\S]*?)```/.exec(privacy);
  assert.ok(m, 'PRIVACY.md needs a ```text writes block');
  return m[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}
function matcher(patterns) {
  const res = patterns.map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$'));
  return (rel) => res.some((r) => r.test(rel));
}
function snapshot(home) {
  const out = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      const st = fs.lstatSync(f);
      out.set('~' + f.slice(home.length).replace(/\\/g, '/'), e.isDirectory() ? 'dir' : st.size + ':' + st.mtimeMs);
      if (e.isDirectory()) walk(f);
    }
  })(home);
  return out;
}
// A folder is fine when something listed lives inside it; a file or folder must match a listed pattern.
function unlisted(before, after, isListed, patterns = []) {
  const touched = [];
  for (const [p, sig] of after) if (before.get(p) !== sig && !(sig === 'dir' && before.has(p))) touched.push(p);
  return touched.filter((p) => !(isListed(p) || (after.get(p) === 'dir' && patterns.some((pat) => pat.startsWith(p + '/')))));
}

test('privacy: the writes block exists and does not allow whole home folders', () => {
  const m = manifest();
  assert.ok(m.length >= 10);
  for (const p of m) assert.ok(p.startsWith('~/'), p);
  assert.ok(!m.some((p) => /^~\/(\*\*|\*)?$/.test(p) || p === '~/.claude/**' || p === '~/.codex/**'), 'too broad');
});

test('privacy: a path that is not listed is caught (the check can fail)', () => {
  const isListed = matcher(manifest());
  const before = new Map();
  const after = new Map([['~/.ssh/authorized_keys', '5:1'], ['~/.votive/events/codex--a.json', '9:1']]);
  assert.deepEqual(unlisted(before, after, isListed, manifest()), ['~/.ssh/authorized_keys']);
});

test('privacy: installers, hooks, wrapper, notify and doctor write only listed paths', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao privacy '));
  for (const d of ['.claude', '.codex', '.gemini', '.qwen', '.cursor', '.codeium/windsurf', '.copilot', '.config/opencode']) fs.mkdirSync(path.join(h, d), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }));
  const env = { ...process.env, HOME: h, USERPROFILE: h, VOTIVE_DEFAULTS_DOMAIN: 'dev.votive.privacytest.' + process.pid };
  const node = (script, args = [], input = '') => spawnSync('node', [script, ...args], { input, encoding: 'utf8', env });
  const before = snapshot(h);

  node(path.join(S, 'doctor.js'), ['--fix', 'scripts,hooks,statusline']);
  const bin = (f) => path.join(h, '.votive', 'bin', f);
  const rollout = path.join(h, '.codex', 'sessions', '2026', '10', '17', 'rollout-a.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  const resets = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(rollout, JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: resets } } } }) + '\n');
  const hook = (agent, p) => node(bin('votive-event.js'), ['--agent', agent], JSON.stringify(p));
  for (const [ev, extra] of [['SessionStart', {}], ['UserPromptSubmit', { prompt: 'hi' }], ['PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'a', status: 'pending' }] } }], ['Stop', {}]]) {
    hook('claude-code', { hook_event_name: ev, session_id: 's1', cwd: '/tmp/x', ...extra });
  }
  hook('codex', { hook_event_name: 'Stop', session_id: 'c1', cwd: '/tmp/x', transcript_path: rollout });
  node(bin('votive-statusline.js'), [], JSON.stringify({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 3, resets_at: resets } } }));
  fs.mkdirSync(path.join(h, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ sessionId: 's1' }));
  node(bin('votive-notify.js'), ['hello']);
  node(path.join(S, 'overlay-settings.js'), ['stuckThresholdMinutes=9']);
  node(path.join(S, 'install-agents.js'), ['--remove']);
  node(path.join(S, 'install-statusline.js'), ['--remove']);

  const after = snapshot(h);
  try { spawnSync('/usr/bin/defaults', ['delete', env.VOTIVE_DEFAULTS_DOMAIN], { stdio: 'ignore' }); } catch (e) {}
  const extras = [rollout, path.dirname(rollout), path.join(h, '.claude', 'sessions', process.pid + '.json')].map((f) => '~' + f.slice(h.length).replace(/\\/g, '/'));
  const isListed = matcher(manifest());
  const bad = unlisted(before, after, (p) => isListed(p) || extras.includes(p) || /^~\/\.codex\/sessions(\/|$)/.test(p) || p === '~/.claude/sessions'
    // Windows only: empty parent folders under AppData created by something that is not our script (nothing is written inside them; a file there would still fail)
    || (process.platform === 'win32' && /^~\/AppData(\/Roaming)?$/.test(p)), manifest());
  assert.deepEqual(bad, [], 'written but not listed in PRIVACY.md: ' + bad.join(', '));
  fs.rmSync(h, { recursive: true, force: true });
});

test('privacy: the Swift app has exactly the write calls PRIVACY.md describes', () => {
  const dir = path.join(ROOT, 'Votive');
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.swift')) files.push(f); } })(dir);
  const sinks = /\.write\(to:|\.createDirectory\(|\.copyItem\(|\.moveItem\(|\.removeItem\(|\.createFile\(|FileHandle\(forWriting|\.replaceItem|\.trashItem\(|\.setAttributes\(|\bsymbolicLink|\.set\(\w+, forKey:/g;
  const found = {};
  for (const f of files) {
    const n = (fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').match(sinks) || []).length;
    if (n) found[path.relative(dir, f).replace(/\\/g, '/')] = n;
  }
  // File: number of write calls. Every entry is explained in PRIVACY.md ("What the app writes").
  assert.deepEqual(found, {
    'Services/AgentChanges.swift': 3,        // Undo in the Agent changes menu: puts one known preference back
    'Services/LegacySettings.swift': 2,      // one-time copy of the settings of the earlier app name (Agent Overlay)
    'Services/OverlayStore.swift': 2,        // deletes its own stale event files
    'Services/PausedStore.swift': 2,         // ~/.votive and paused.json (programs the optional Ports tool froze)
    'Services/PortTools.swift': 2,           // ~/.votive and ports.json (optional Ports tool)
    'Services/SnippetStore.swift': 2,        // ~/.votive and snippets.json
    'Services/Sounds.swift': 2,              // sound choices in macOS preferences
    'Services/StatusCoordinator.swift': 1,   // ~/.votive/events
    'Services/UsageStore.swift': 1,          // ~/.votive/usage
    'UI/StatusItemController.swift': 12,     // preferences (including the Let agents change settings switch and the Ports switch), ~/.votive/sounds
  });
});

test('privacy: every folder the app names in Paths.swift is in the writes block or the reads list', () => {
  const swift = fs.readFileSync(path.join(ROOT, 'Votive', 'Services', 'Paths.swift'), 'utf8');
  const names = [...swift.matchAll(/appendingPathComponent\("([^"]+)"/g)].map((m) => m[1]);
  for (const n of names) assert.ok(privacy.includes(n.replace(/\/$/, '')), 'Paths.swift names ' + n + ' but PRIVACY.md never mentions it');
});

test('privacy: a repair on a fresh machine creates ~/.votive readable only by you', { skip: process.platform === 'win32' && 'Windows has no Unix modes; privacy there rests on the profile folder (PRIVACY.md says so)' }, () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao privacy mode '));
  const r = spawnSync('node', [path.join(S, 'doctor.js'), '--fix', 'scripts'], { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.statSync(path.join(h, '.votive')).mode & 0o777, 0o700);
  fs.rmSync(h, { recursive: true, force: true });
});
