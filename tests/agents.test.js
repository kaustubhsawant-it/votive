'use strict';
//
// Multi-agent tests: adapters (payload shapes taken from each agent's documentation), the
// event hook end to end, Codex usage, notify from non-Claude sessions, and the per-agent
// installer. Every test runs against a throwaway HOME.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { normalize } = require('../Scripts/agents');

const S = path.join(__dirname, '..', 'Scripts');
const BIN_FILES = ['votive-event.js', 'agents.js', 'overlay-paths.js', 'progress.js', 'statusline-extras.js',
  'votive-statusline.js', 'votive-notify.js', 'notify-core.js', 'proc-info.js', 'limit-notify.js'];

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao agents '));
  fs.mkdirSync(path.join(h, '.votive', 'bin'), { recursive: true });
  for (const f of BIN_FILES) fs.copyFileSync(path.join(S, f), path.join(h, '.votive', 'bin', f));
  return h;
}
const env = (h) => ({ ...process.env, HOME: h, USERPROFILE: h });
const eventScript = (h) => path.join(h, '.votive', 'bin', 'votive-event.js');
const emit = (h, args, payload) => spawnSync('node', [eventScript(h), ...args],
  { input: payload === undefined ? '' : JSON.stringify(payload), encoding: 'utf8', env: env(h) });
const evFile = (h, agent, id) => path.join(h, '.votive', 'events', agent + '--' + id + '.json');
const ev = (h, agent, id) => JSON.parse(fs.readFileSync(evFile(h, agent, id), 'utf8'));
const install = (h, args) => spawnSync('node', [path.join(S, 'install-agents.js'), ...args], { encoding: 'utf8', env: env(h) });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---------- adapters: event → state for each agent, from documented payloads

const CASES = [
  // [agent, argv, payload, expected {state, sessionId, cwd}]
  ['claude-code', {}, { hook_event_name: 'PermissionRequest', session_id: 'c1', cwd: '/p' }, { state: 'waiting', sessionId: 'c1', cwd: '/p' }],
  ['claude-code', {}, { hook_event_name: 'Notification', session_id: 'c1' }, { state: null }],
  ['codex', {}, { hook_event_name: 'SessionStart', session_id: 'x1', cwd: '/r', source: 'startup' }, { state: 'starting', sessionId: 'x1', cwd: '/r' }],
  ['codex', {}, { hook_event_name: 'PermissionRequest', session_id: 'x1' }, { state: 'waiting' }],
  ['codex', {}, { hook_event_name: 'Stop', session_id: 'x1', stop_hook_active: false }, { state: 'done' }],
  ['codex', {}, { hook_event_name: 'SessionEnd', session_id: 'x1', reason: 'other' }, { state: 'end' }],
  ['gemini', {}, { hook_event_name: 'BeforeAgent', session_id: 'g1', cwd: '/g', prompt: 'hi' }, { state: 'working', sessionId: 'g1', cwd: '/g', prompt: 'hi' }],
  ['gemini', {}, { hook_event_name: 'AfterTool', session_id: 'g1', tool_response: { error: 'boom' } }, { state: 'error' }],
  ['gemini', {}, { hook_event_name: 'AfterTool', session_id: 'g1', tool_response: { llmContent: 'ok' } }, { state: 'working' }],
  ['gemini', {}, { hook_event_name: 'Notification', session_id: 'g1', notification_type: 'ToolPermission' }, { state: 'waiting' }],
  ['gemini', {}, { hook_event_name: 'AfterAgent', session_id: 'g1' }, { state: 'done' }],
  ['qwen', {}, { hook_event_name: 'Notification', session_id: 'q1', notification_type: 'permission_prompt' }, { state: 'waiting' }],
  ['qwen', {}, { hook_event_name: 'Notification', session_id: 'q1', notification_type: 'idle_prompt' }, { state: null }],
  ['copilot', { event: 'agentStop' }, { sessionId: 'p1', cwd: '/c', timestamp: 1 }, { state: 'done', sessionId: 'p1', cwd: '/c' }],
  ['copilot', { event: 'postToolUseFailure' }, { sessionId: 'p1' }, { state: 'error' }],
  ['copilot', { event: 'PreToolUse' }, { sessionId: 'p1' }, { state: null }],
  ['copilot', {}, { sessionId: 'p1', hook_event_name: 'notification', notification_type: 'permission_prompt' }, { state: 'waiting' }],
  ['cursor', {}, { hook_event_name: 'stop', conversation_id: 'u1', workspace_roots: ['/w'], status: 'completed' }, { state: 'done', sessionId: 'u1', cwd: '/w' }],
  ['cursor', {}, { hook_event_name: 'stop', conversation_id: 'u1', status: 'error' }, { state: 'error' }],
  ['cursor', {}, { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'u1', prompt: 'do it' }, { state: 'working', prompt: 'do it' }],
  ['windsurf', {}, { agent_action_name: 'post_cascade_response', trajectory_id: 'w1' }, { state: 'done', sessionId: 'w1' }],
  ['windsurf', {}, { agent_action_name: 'post_run_command', trajectory_id: 'w1' }, { state: 'working' }],
  ['windsurf', {}, { agent_action_name: 'pre_read_code', trajectory_id: 'w1' }, { state: null }],
  ['goose', {}, { event: 'Stop', session_id: 's1', working_dir: '/gz' }, { state: 'done', sessionId: 's1', cwd: '/gz' }],
  ['cline', { event: 'TaskComplete' }, { taskId: 't1', workspaceRoots: ['/cl'] }, { state: 'done', sessionId: 't1', cwd: '/cl' }],
  ['opencode', { event: 'permission.updated', session: 'o1', cwd: '/o' }, {}, { state: 'waiting', sessionId: 'o1', cwd: '/o' }],
  ['opencode', { event: 'session.idle', session: 'o1' }, {}, { state: 'done' }],
  ['amp', { event: 'agent.end', session: 'a1' }, { status: 'error' }, { state: 'error', sessionId: 'a1' }],
  ['aider', {}, {}, { state: 'done', sessionId: null }],
  ['generic', { event: 'waiting', session: 'z' }, {}, { state: 'waiting', sessionId: 'z' }],
  ['generic', { event: 'bogus', session: 'z' }, {}, { state: null }],
  ['some-new-agent', { event: 'done', session: 'n' }, {}, { state: 'done', agent: 'some-new-agent' }],
  ['My Agent!', { event: 'working', session: 'n' }, {}, { state: 'working', agent: 'my-agent' }],
];

for (const [agent, argv, payload, want] of CASES) {
  test(`adapter ${agent} ${argv.event || payload.hook_event_name || payload.agent_action_name || payload.event || ''} → ${want.state}`, () => {
    const got = normalize(agent, payload, argv);
    for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], k);
  });
}

test('adapter: event names match case-insensitively', () => {
  assert.equal(normalize('copilot', {}, { event: 'AGENTSTOP' }).state, 'done');
});

test('adapter: a Cursor payload on the Claude hook is attributed to Cursor', () => {
  const got = normalize('claude-code', { hook_event_name: 'Stop', conversation_id: 'cv', cursor_version: '1.7', workspace_roots: ['/w'] }, {});
  assert.equal(got.agent, 'cursor');
  assert.equal(got.sessionId, 'cv');
  assert.equal(got.state, 'done');
});

// ---------- event hook end to end

test('event: writes one file per agent session, and end deletes it', () => {
  const h = home();
  const r = emit(h, ['--agent', 'codex'], { hook_event_name: 'SessionStart', session_id: 'abc', cwd: '/repo', transcript_path: '/t.jsonl' });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  const f = ev(h, 'codex', 'abc');
  assert.equal(f.agent, 'codex'); assert.equal(f.lastEvent, 'starting'); assert.equal(f.cwd, '/repo');
  assert.equal(f.transcriptPath, '/t.jsonl');
  emit(h, ['--agent', 'codex'], { hook_event_name: 'UserPromptSubmit', session_id: 'abc', prompt: '  fix\nthe   tests ' });
  assert.equal(ev(h, 'codex', 'abc').prompt, 'fix the tests');
  assert.equal(ev(h, 'codex', 'abc').cwd, '/repo', 'cwd carried over');
  emit(h, ['--agent', 'codex'], { hook_event_name: 'SessionEnd', session_id: 'abc' });
  assert.ok(!fs.existsSync(evFile(h, 'codex', 'abc')));
});

test('event: records the agent process, not the shell that ran the hook', () => {
  const h = home();
  // `; true` keeps sh alive as the hook's parent, like `$SHELL -lc` in Codex.
  const win = process.platform === 'win32';   // cmd.exe plays the part of sh; `& rem` keeps it alive as the parent
  const r = win
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"node "${eventScript(h)}" --agent generic --event working --session sh1 & rem"`],
      { input: '', encoding: 'utf8', env: env(h), windowsVerbatimArguments: true })
    : spawnSync('/bin/sh', ['-c', `node '${eventScript(h)}' --agent generic --event working --session sh1; true`],
      { input: '', encoding: 'utf8', env: env(h) });
  assert.equal(r.status, 0);
  assert.equal(ev(h, 'generic', 'sh1').pid, process.pid);
});

test('event: a later event keeps the session\'s recorded host pid while that process lives, and looks again when it is gone', () => {
  const h = home();
  const run = () => spawnSync('node', [eventScript(h), '--agent', 'generic', '--event', 'working', '--session', 'reuse1'], { input: '', encoding: 'utf8', env: env(h) });
  const file = path.join(h, '.votive', 'events', 'generic--reuse1.json');
  const setPid = (pid) => { const rec = JSON.parse(fs.readFileSync(file, 'utf8')); rec.pid = pid; fs.writeFileSync(file, JSON.stringify(rec)); };
  assert.equal(run().status, 0);
  assert.equal(ev(h, 'generic', 'reuse1').pid, process.pid, 'first event: found by looking up the parent');
  setPid(process.ppid);                       // a different, live process
  assert.equal(run().status, 0);
  assert.equal(ev(h, 'generic', 'reuse1').pid, process.ppid, 'a live recorded pid is reused, no lookup');
  setPid(2147483000);                         // a pid nothing has
  assert.equal(run().status, 0);
  assert.equal(ev(h, 'generic', 'reuse1').pid, process.pid, 'a dead recorded pid is replaced by a fresh lookup');
});

test('event: --no-stdin returns at once even when stdin never closes', async () => {
  const h = home();
  const t0 = Date.now();
  const p = spawn('node', [eventScript(h), '--agent', 'opencode', '--no-stdin', '--event', 'session.idle', '--session', 'o9', '--cwd', '/o'],
    { env: env(h), stdio: ['pipe', 'ignore', 'ignore'] });   // stdin left open on purpose
  await new Promise((r) => p.on('exit', r));
  assert.ok(Date.now() - t0 < 2000, 'waited on stdin');
  assert.equal(ev(h, 'opencode', 'o9').lastEvent, 'done');
});

test('event: Aider (no payload, no session id) keys the session by process', () => {
  const h = home();
  const p = spawnSync('node', [eventScript(h), '--agent', 'aider'], { env: env(h), cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(p.status, 0);
  const f = ev(h, 'aider', 'pid-' + process.pid);
  assert.equal(f.lastEvent, 'done');
  assert.equal(fs.realpathSync(f.cwd), fs.realpathSync(os.tmpdir()));
});

test('event: Codex turn end records plan usage from the transcript', () => {
  const h = home();
  const t = path.join(h, '.codex', 'sessions', '2026', '10', '17', 'rollout-2026-10-17T10-00-00-u1.jsonl');
  fs.mkdirSync(path.dirname(t), { recursive: true });
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const line = (primary, secondary) => JSON.stringify({ timestamp: 'x', type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary, secondary, credits: null } } });
  fs.writeFileSync(t, [
    line({ used_percent: 1, window_minutes: 300, resets_at: resets }, null),
    JSON.stringify({ type: 'response_item', payload: {} }),
    line({ used_percent: 42.5, window_minutes: 300, resets_at: resets }, { used_percent: 12.5, window_minutes: 10080, resets_at: resets }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
  ].join('\n') + '\n');
  emit(h, ['--agent', 'codex'], { hook_event_name: 'Stop', session_id: 'u1', transcript_path: t });
  const u = readJson(path.join(h, '.votive', 'usage', 'codex.json'));
  assert.equal(u.agent, 'codex');
  assert.deepEqual(u.windows.map((w) => [w.label, w.usedPercentage]), [['Session', 42.5], ['Weekly', 12.5]]);
});

test('event: bad input never breaks the agent', () => {
  const h = home();
  for (const input of ['', 'garbage', '[1,2]', 'null']) {
    for (const agent of ['codex', 'gemini', 'cursor', 'nope']) {
      const r = spawnSync('node', [eventScript(h), '--agent', agent], { input, encoding: 'utf8', env: env(h) });
      assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
    }
  }
});

// ---------- notify from a non-Claude session

test('notify: finds a Codex session through the pid in its event file', () => {
  const h = home();
  const f = evFile(h, 'codex', 'cx');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ agent: 'codex', sessionId: 'cx', lastEvent: 'working', lastEventAt: Date.now(), pid: process.pid }));
  const r = spawnSync('node', [path.join(h, '.votive', 'bin', 'votive-notify.js'), 'Tests passed'], { encoding: 'utf8', env: env(h) });
  assert.equal(r.status, 0, r.stderr);
  const e = ev(h, 'codex', 'cx');
  assert.equal(e.notifyMessage, 'Tests passed');
  assert.equal(e.lastEvent, 'working', 'state kept');
});

// ---------- installer

test('install: wires Codex, Gemini, Cursor, Windsurf, Qwen in their own formats', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  const r = install(h, ['--only', 'codex,gemini,cursor,windsurf,qwen']);
  assert.equal(r.status, 0, r.stderr);

  const codex = readJson(path.join(h, '.codex', 'hooks.json'));
  assert.match(codex.hooks.PermissionRequest[0].hooks[0].command, /votive-event\.js[\"'] --agent codex$/);
  assert.match(r.stdout, /approve them in \/hooks/);

  const gem = readJson(path.join(h, '.gemini', 'settings.json'));
  assert.equal(gem.theme, 'dark');
  assert.equal(gem.hooks.AfterAgent.length, 2, 'user hook kept');
  assert.equal(gem.hooks.AfterAgent[1].matcher, '*');
  assert.equal(gem.hooks.AfterAgent[1].hooks[0].timeout, 5000);

  const cur = readJson(path.join(h, '.cursor', 'hooks.json'));
  assert.equal(cur.version, 1);
  assert.match(cur.hooks.stop[0].command, /--agent cursor$/);

  const ws = readJson(path.join(h, '.codeium', 'windsurf', 'hooks.json'));
  assert.match(ws.hooks.post_cascade_response[0].command, /--agent windsurf$/);
  assert.match(readJson(path.join(h, '.qwen', 'settings.json')).hooks.Notification[0].hooks[0].command, /--agent qwen$/);
});

test('install: Copilot gets its own file with the event name in each command', () => {
  const h = home();
  install(h, ['--only', 'copilot']);
  const f = readJson(path.join(h, '.copilot', 'hooks', 'votive.json'));
  assert.equal(f.version, 1);
  assert.match(f.hooks.agentStop[0].bash, /--agent copilot --event agentStop$/);
});

test('install: OpenCode plugin is valid ESM and points at the event script', () => {
  const h = home();
  install(h, ['--only', 'opencode']);
  const src = fs.readFileSync(path.join(h, '.config', 'opencode', 'plugins', 'votive.js'), 'utf8');
  const script = path.join(h, '.votive', 'bin', 'votive-event.js');
  assert.ok(src.includes(script) || src.includes(script.replace(/\\/g, '\\\\')), 'the script path, escaped for a JS string on Windows');
  assert.ok(!src.includes('__EVENT_SCRIPT__'));
  const copy = path.join(h, 'plugin-check.mjs');
  fs.writeFileSync(copy, src);
  assert.equal(spawnSync('node', ['--check', copy]).status, 0);
});

test('install: idempotent, upgrades legacy entries, remove cleans every agent', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node "/old/agent-overlay-status.js"' }] }, { hooks: [{ type: 'command', command: 'mine' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'node "/old/agent-overlay-status.js"' }] }],
  } }));
  install(h, ['--only', 'claude-code,codex,cursor,copilot,opencode']);
  let claude = readJson(path.join(h, '.claude', 'settings.json'));
  assert.ok(!JSON.stringify(claude).includes('agent-overlay-status.js'), 'legacy entries removed');
  assert.equal(claude.hooks.Notification, undefined, 'legacy-only event removed');
  assert.equal(claude.hooks.Stop.filter((g) => JSON.stringify(g).includes('votive-event.js')).length, 1);

  const again = install(h, ['--only', 'claude-code,codex,cursor,copilot,opencode']);
  assert.match(again.stdout, /claude-code: already wired/);
  assert.match(again.stdout, /copilot: already installed/);

  install(h, ['--remove']);
  claude = readJson(path.join(h, '.claude', 'settings.json'));
  assert.deepEqual(claude.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] });
  assert.deepEqual(readJson(path.join(h, '.codex', 'hooks.json')).hooks, {});
  assert.ok(!fs.existsSync(path.join(h, '.copilot', 'hooks', 'votive.json')));
  assert.ok(!fs.existsSync(path.join(h, '.config', 'opencode', 'plugins', 'votive.js')));
});

test('install: only detected agents are wired; broken configs are refused, others continue', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(h, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(h, '.gemini', 'settings.json'), '{ not json');
  const r = install(h, []);
  assert.equal(r.status, 1, 'reports the failure');
  assert.match(r.stderr, /gemini: Refusing to edit/);
  assert.ok(fs.existsSync(path.join(h, '.codex', 'hooks.json')), 'codex still wired');
  assert.equal(fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8'), '{ not json');
  assert.ok(!fs.existsSync(path.join(h, '.cursor')), 'undetected agent untouched');
});

test('install: --only rejects unknown agents, --list changes nothing', () => {
  const h = home();
  assert.equal(install(h, ['--only', 'nope']).status, 1);
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  const r = install(h, ['--list']);
  assert.match(r.stdout, /found\s+codex/);
  assert.ok(!fs.existsSync(path.join(h, '.codex', 'hooks.json')));
});
