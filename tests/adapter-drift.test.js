'use strict';
//
// Regression tests for AGEN-26: adapter drift against the vendors' current hook documents
// (checked 2026-10-18). Payload shapes are copied from those documents.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalize } = require('../Scripts/agents');

const S = path.join(__dirname, '..', 'Scripts');

test('adapter: Goose reads the prompt from `message` on UserPromptSubmit', () => {
  const got = normalize('goose', { event: 'UserPromptSubmit', session_id: 'g1', message: 'fix the build' }, {});
  assert.equal(got.prompt, 'fix the build');
  assert.equal(got.state, 'working');
});

test('adapter: Windsurf takes the prompt and folder from tool_info', () => {
  const p = normalize('windsurf', { agent_action_name: 'pre_user_prompt', trajectory_id: 't1', tool_info: { user_prompt: 'add tests' } }, {});
  assert.equal(p.prompt, 'add tests');
  const c = normalize('windsurf', { agent_action_name: 'post_run_command', trajectory_id: 't1', tool_info: { command_line: 'ls', cwd: '/repo' } }, {});
  assert.equal(c.cwd, '/repo');
});

test('adapter: Copilot agentStop carries transcriptPath', () => {
  const got = normalize('copilot', { sessionId: 'c1', timestamp: 1, cwd: '/r', transcriptPath: '/t/x.jsonl', stopReason: 'end_turn' }, { event: 'agentStop' });
  assert.equal(got.transcriptPath, '/t/x.jsonl');
  assert.equal(got.state, 'done');
});

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao drift '));
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  return h;
}
const install = (h, args = ['--only', 'codex']) => spawnSync('node', [path.join(S, 'install-agents.js'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h } });
const hooks = (h) => JSON.parse(fs.readFileSync(path.join(h, '.codex', 'hooks.json'), 'utf8')).hooks;

test('install: Codex Interrupt and SessionEnd get a 3 s timeout, the rest 5 s', () => {
  const h = home();
  assert.equal(install(h).status, 0);
  const t = (ev) => hooks(h)[ev][0].hooks[0].timeout;
  assert.equal(t('Interrupt'), 3);
  assert.equal(t('SessionEnd'), 3);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop']) assert.equal(t(ev), 5, ev);
});

test('install: an older Codex entry with a 5 s Interrupt timeout is upgraded in place, once', () => {
  const h = home();
  install(h);
  const file = path.join(h, '.codex', 'hooks.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.hooks.Interrupt[0].hooks[0].timeout = 5;
  fs.writeFileSync(file, JSON.stringify(cfg));
  const r = install(h);
  assert.match(r.stdout, /wired/);
  assert.equal(hooks(h).Interrupt.length, 1, 'replaced, not duplicated');
  assert.equal(hooks(h).Interrupt[0].hooks[0].timeout, 3);
  assert.match(install(h).stdout, /already wired/);
});

// ---------- AGEN-27: say honestly what Codex wrote

function codexHome(line) {
  const h = home();
  const f = path.join(h, '.codex', 'sessions', '2026', '10', '17', 'rollout-2026-10-17T10-00-00-d1.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (line) fs.writeFileSync(f, line + '\n');
  return h;
}
const codexCheck = (h) => spawnSync('node', [path.join(S, 'doctor.js')], { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h } })
  .stdout.split('\n').find((l) => /codex-usage/.test(l)) || '';

test('doctor: says whether Codex wrote plan usage in its newest session file', () => {
  const tc = (rl) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });
  assert.match(codexCheck(codexHome(null)), /No Codex session file yet/);
  assert.match(codexCheck(codexHome(tc(null))), /wrote no rate_limits/);
  assert.match(codexCheck(codexHome(tc({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1 } }))), /wrote plan usage/);
});
