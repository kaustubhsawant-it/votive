'use strict';
//
// --dry-run: the installers show the exact change to each config file and write nothing.
// Throwaway HOME, so your real configs are never touched.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const S = path.join(__dirname, '..', 'Scripts');

function tree(dir) {
  const out = {};
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[f.slice(dir.length)] = fs.readFileSync(f, 'utf8'); } })(dir);
  return out;
}

test('dry-run: shows the diff for every config and changes nothing', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao dry '));
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(h, '.copilot'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ env: { KEEP: '1' }, statusLine: { type: 'command', command: 'echo hi' } }, null, 2) + '\n');
  const before = tree(h);
  const env = { ...process.env, HOME: h, USERPROFILE: h };
  const a = spawnSync('node', [path.join(S, 'install-agents.js'), '--dry-run'], { encoding: 'utf8', env });
  const b = spawnSync('node', [path.join(S, 'install-statusline.js'), '--dry-run'], { encoding: 'utf8', env });
  assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(tree(h), before, 'a dry run must not create, change or back up anything');
  assert.match(a.stdout, /^--- .*\.claude[\\/]settings\.json/m);
  assert.match(a.stdout, /^\+ .*votive-event\.js\\?[\"'] --agent claude-code/m);
  assert.match(a.stdout, /^--- .*\.codex[\\/]hooks\.json \(new file\)$/m);
  assert.match(a.stdout, /^--- .*\.copilot[\\/]hooks[\\/]votive\.json \(new file\)$/m);
  assert.match(a.stdout, /^  .*"command": "echo hi"/m, "unchanged lines are shown as context");
  assert.doesNotMatch(a.stdout, /^- .*KEEP/m, 'nothing of the user\'s is removed');
  assert.match(b.stdout, /^\+ .*votive-statusline\.js/m);
  assert.ok(!fs.existsSync(path.join(h, '.votive')));

  const real = spawnSync('node', [path.join(S, 'install-agents.js')], { encoding: 'utf8', env });
  assert.equal(real.status, 0);
  assert.ok(fs.existsSync(path.join(h, '.codex', 'hooks.json')), 'the same command without --dry-run does apply');
});
