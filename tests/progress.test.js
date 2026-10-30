'use strict';
//
// Task progress: task lists from each agent's plan tool, done vs. waiting at Stop, elapsed
// time, the status-line segment, and the hook + statusLine wrapper end to end. Every test
// runs against a throwaway HOME.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers');
const { spawnSync, spawn } = require('child_process');
const G = require('../Scripts/progress');

const S = path.join(__dirname, '..', 'Scripts');
const BIN_FILES = ['votive-event.js', 'agents.js', 'overlay-paths.js', 'progress.js', 'statusline-extras.js',
  'votive-statusline.js', 'votive-notify.js', 'notify-core.js', 'proc-info.js', 'limit-notify.js'];

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao progress '));
  fs.mkdirSync(path.join(h, '.votive', 'bin'), { recursive: true });
  for (const f of BIN_FILES) fs.copyFileSync(path.join(S, f), path.join(h, '.votive', 'bin', f));
  return h;
}
const bin = (h, f) => path.join(h, '.votive', 'bin', f);
const run = (h, f, input, args = [], env = {}) => spawnSync('node', [bin(h, f), ...args],
  { input, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, ...env } });
const emit = (h, payload, agent = 'claude-code') => run(h, 'votive-event.js', JSON.stringify(payload), ['--agent', agent]);
const ev = (h, id, agent = 'claude-code') =>
  JSON.parse(fs.readFileSync(path.join(h, '.votive', 'events', agent + '--' + id + '.json'), 'utf8'));
function wrapped(h, command) {
  const d = path.join(h, '.votive', 'usage');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'wrapped.json'), JSON.stringify({ command }));
}
const todos = (...st) => ({ todos: st.map((s, i) => ({ content: 'Step ' + (i + 1), activeForm: 'Doing step ' + (i + 1), status: s })) });

// ---------- task lists, one shape per agent

test('TodoWrite replaces the list; summary counts done and names the active step', () => {
  const plan = G.applyTool(undefined, 'TodoWrite', todos('completed', 'in_progress', 'pending'));
  assert.deepEqual(G.summarize(plan), { done: 1, total: 3, label: 'Doing step 2' });
  const next = G.applyTool(plan, 'TodoWrite', todos('completed', 'completed'));
  assert.deepEqual(G.summarize(next), { done: 2, total: 2, label: null });
});

test('TaskCreate / TaskUpdate build a list by id, deleted tasks stop counting', () => {
  let p = G.applyTool(undefined, 'TaskCreate', { subject: 'Build', activeForm: 'Building' }, { task: { id: '1', subject: 'Build' } });
  p = G.applyTool(p, 'TaskCreate', { subject: 'Test' }, 'Task #2 created successfully: Test');
  p = G.applyTool(p, 'TaskCreate', { subject: 'Deploy' });   // no id in the response: next number
  assert.deepEqual(p.map((i) => i.id), ['1', '2', '3']);
  p = G.applyTool(p, 'TaskUpdate', { taskId: '1', status: 'completed' });
  p = G.applyTool(p, 'TaskUpdate', { taskId: '2', status: 'in_progress', activeForm: 'Testing' });
  assert.deepEqual(G.summarize(p), { done: 1, total: 3, label: 'Testing' });
  p = G.applyTool(p, 'TaskUpdate', { taskId: '3', status: 'deleted' });
  assert.equal(G.summarize(p).total, 2);
  assert.equal(G.applyTool(p, 'TaskUpdate', { taskId: '99', status: 'completed' }), undefined, 'unknown id ignored');
});

test('Codex update_plan (JSON-string arguments), Gemini write_todos, Cursor merge', () => {
  const codex = G.applyTool(undefined, 'update_plan', JSON.stringify({ plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }] }));
  assert.deepEqual(G.summarize(codex), { done: 1, total: 2, label: 'b' });
  const gem = G.applyTool(undefined, 'write_todos', { todos: [{ description: 'x', status: 'cancelled' }, { description: 'y', status: 'pending' }] });
  assert.equal(G.summarize(gem).total, 1, 'cancelled is not counted');
  let cur = G.applyTool(undefined, 'todo_write', { todos: [{ id: 'a', content: 'A', status: 'pending' }, { id: 'b', content: 'B', status: 'pending' }] });
  cur = G.applyTool(cur, 'todo_write', { merge: true, todos: [{ id: 'a', content: 'A', status: 'completed' }] });
  assert.deepEqual(G.summarize(cur), { done: 1, total: 2, label: null });
});

test('tools that are not task lists change nothing', () => {
  assert.equal(G.applyTool(undefined, 'Bash', { command: 'ls' }), undefined);
  assert.equal(G.applyTool(undefined, 'TodoWrite', { nope: 1 }), undefined);
  assert.equal(G.applyTool(undefined, undefined, undefined), undefined);
});

test('labels are cleaned: no terminal escapes, clipped without splitting an emoji', () => {
  const p = G.applyTool(undefined, 'TodoWrite', { todos: [{ content: 'x', activeForm: '\x1b[31mred\x1b]0;title\x07 ' + '🚀'.repeat(100), status: 'in_progress' }] });
  const label = G.summarize(p).label;
  assert.ok(!/[\x00-\x1f]/.test(label), 'no control characters');
  assert.ok(Array.from(label).length <= 80);
  assert.ok(!/[\ud800-\udbff]$/.test(label.replace(/…$/, '')), 'no half emoji');
});

// ---------- done vs. waiting on you

test('a question or a request for approval is detected, a soft sign-off is not', () => {
  const yes = [
    'Built it.\n\nShould I merge to main?',
    'All set. Want me to deploy it now?**',
    'Plan is ready.\nPlease confirm before I proceed.',
    'Done with step 1.\nWhich option do you prefer?\n\n— master-planner → @exec',
  ];
  for (const t of yes) assert.ok(G.detectQuestion(t), t);
  const no = [
    'Done. All 83 tests pass.',
    'Fixed it. Let me know if you want anything else.',
    'Here is the code:\n```js\nconst ok = a ? b : c; // why?\n```\nShipped.',
    '', null,
  ];
  for (const t of no) assert.equal(G.detectQuestion(t), null, String(t));
  assert.equal(G.detectQuestion('Tests pass. Should I merge?').excerpt, 'Should I merge?');
});

test('Stop: question → waiting, open tasks → stopped, otherwise done', () => {
  const open = G.applyTool(undefined, 'TodoWrite', todos('completed', 'pending'));
  const all = G.applyTool(undefined, 'TodoWrite', todos('completed', 'completed'));
  assert.deepEqual(G.classifyStop('Merge it?', all), { state: 'waiting', waitReason: 'question', detail: 'Merge it?' });
  assert.deepEqual(G.classifyStop('Paused here.', open), { state: 'waiting', waitReason: 'open-tasks' });
  assert.deepEqual(G.classifyStop('All done.', all), { state: 'done' });
  assert.deepEqual(G.classifyStop('All done.', undefined), { state: 'done' });
});

// ---------- transcript tail

test('transcript: last assistant text and the task list, from Claude Code JSONL', () => {
  const t = path.join(home(), 't.jsonl');
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskCreate', input: { subject: 'A' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'Task #7 created successfully: A' }] }, toolUseResult: { task: { id: '7', subject: 'A' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Ready. Ship it?' }] } },
    'not json',
  ];
  fs.writeFileSync(t, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const scan = G.scanTranscript(t);
  assert.equal(scan.lastText, 'Ready. Ship it?');
  assert.deepEqual(G.summarize(scan.plan), { done: 1, total: 1, label: null });
});

test('transcript: Codex rollout messages and update_plan calls', () => {
  const t = path.join(home(), 'rollout.jsonl');
  fs.writeFileSync(t, [
    { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }] }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Stopping here.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  const scan = G.scanTranscript(t);
  assert.equal(scan.lastText, 'Stopping here.');
  assert.deepEqual(G.classifyStop(scan.lastText, scan.plan), { state: 'waiting', waitReason: 'open-tasks' });
});

test('transcript: only the tail is read, and a missing file is harmless', () => {
  const t = path.join(home(), 'big.jsonl');
  const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'old question?' }] } });
  fs.writeFileSync(t, (filler + '\n').repeat(Math.ceil((2 * G.TAIL_BYTES) / filler.length)) +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final.' }] } }) + '\n');
  const lines = G.readTail(t);
  assert.ok(lines.join('\n').length <= G.TAIL_BYTES);
  assert.equal(G.scanTranscript(t).lastText, 'final.');
  assert.deepEqual(G.scanTranscript('/nope/missing.jsonl'), { lastText: '', plan: undefined, background: [] });
  assert.deepEqual(G.scanTranscript(undefined), { lastText: '', plan: undefined, background: [] });
});

// ---------- elapsed time

test('stateSince holds while state and step stay the same, restarts when either changes', () => {
  const a = G.track({}, 'working', { tool_name: 'TodoWrite', tool_input: todos('in_progress', 'pending') }, { now: 1000 });
  assert.equal(a.stateSince, 1000);
  const prev = { lastEvent: 'working', stateSince: a.stateSince, plan: a.plan };
  assert.equal(G.track(prev, 'working', { tool_name: 'Bash' }, { now: 5000 }).stateSince, 1000, 'same step');
  const b = G.track(prev, 'working', { tool_name: 'TodoWrite', tool_input: todos('completed', 'in_progress') }, { now: 6000 });
  assert.equal(b.stateSince, 6000, 'next step');
  assert.equal(G.track({ lastEvent: 'working', stateSince: 1 }, 'waiting', { tool_name: 'Bash' }, { now: 7000 }).stateSince, 7000);
});

test('a new prompt drops a finished or abandoned list, keeps a recent unfinished one', () => {
  const now = 100 * 60 * 1000;
  const prompt = (rec) => G.track(rec, 'working', {}, { eventName: 'UserPromptSubmit', now });
  const finished = { lastEvent: 'done', planAt: now - 1000, plan: G.applyTool(undefined, 'TodoWrite', todos('completed')) };
  assert.equal(prompt(finished).plan, undefined);
  const open = G.applyTool(undefined, 'TodoWrite', todos('completed', 'in_progress', 'pending'));
  const recent = prompt({ lastEvent: 'waiting', planAt: now - 60e3, plan: open });
  assert.equal(recent.plan.length, 3, 'kept for "continue"');
  assert.equal(recent.promptAt, now);
  assert.equal(prompt({ lastEvent: 'waiting', planAt: now - G.STALE_PLAN_MS - 1, plan: open }).plan, undefined, 'abandoned');
  assert.equal(prompt({ lastEvent: 'waiting', plan: open }).plan, undefined, 'no planAt = unknown age = dropped');
});

test('a kept list hides its old step until it is touched again', () => {
  const plan = G.applyTool(undefined, 'TodoWrite', todos('completed', 'in_progress'));
  const rec = { lastEvent: 'working', plan, planAt: 1000, promptAt: 2000, stateSince: 2000 };
  assert.equal(G.segment(rec, { now: 2000, color: false }), '● Working · 1/2 · 50% · 0s');
  assert.equal(G.segment(Object.assign({}, rec, { planAt: 3000 }), { now: 3000, color: false }), '● Doing step 2 · 1/2 · 50% · 1s');
});

test('segment never exceeds 40 columns, in any state, with long inputs', () => {
  const long = 'Deploying the entire monorepo to the production cluster on c.local and then verifying it '.repeat(3);
  const plan = Array.from({ length: 60 }, (_, i) => ({ text: long, activeForm: long, status: i < 49 ? 'completed' : 'in_progress' }));
  const old = 1;   // decades ago: the longest duration
  const recs = [
    { lastEvent: 'working', plan, stateSince: old },
    { lastEvent: 'working', stateSince: old },
    { lastEvent: 'waiting', waitReason: 'question', detail: long + '?', stateSince: old },
    { lastEvent: 'waiting', waitReason: 'permission', detail: 'approve ' + long, stateSince: old },
    { lastEvent: 'waiting', waitReason: 'open-tasks', plan, stateSince: old },
    { lastEvent: 'done', plan },
    { lastEvent: 'error', detail: long, stateSince: old },
    { lastEvent: 'error', stateSince: old },
  ];
  for (const r of recs) {
    const seg = G.segment(Object.assign({}, r, { plan: r.plan && G.applyTool(undefined, 'TodoWrite', { todos: r.plan.map((x) => ({ content: x.text, activeForm: x.activeForm, status: x.status })) }) }), { color: false });
    assert.ok(seg, r.lastEvent);
    assert.ok([...seg].length <= G.MAX_WIDTH, `${[...seg].length} cols: ${seg}`);
  }
  // A short question keeps the full wording; a long one keeps the question, shortened.
  assert.equal(G.segment({ lastEvent: 'waiting', waitReason: 'question', detail: 'merge?', stateSince: 0 }, { now: 60e3, color: false }), '⏸ Waiting on you: merge? · 1m');
  assert.match(G.segment(recs[2], { color: false }), /^⏸ Waiting: Deploying.*… · 99h\+$/);
});

// ---------- the segment

test('segment: one format per state, no made-up % without a task list', () => {
  const now = 10 * 60 * 1000;
  const plan = G.applyTool(undefined, 'TodoWrite', { todos: [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'completed' },
    { content: 'd', activeForm: 'Deploying to c.local', status: 'in_progress' }, { content: 'e', status: 'pending' }, { content: 'f', status: 'pending' }] });
  const seg = (rec) => G.segment(Object.assign({ stateSince: now - 125000 }, rec), { now, color: false });
  assert.equal(seg({ lastEvent: 'working', plan }), '● Deploying to c.local · 3/6 · 50% · 2m');
  assert.equal(seg({ lastEvent: 'working' }), '● Working · 2m');
  assert.equal(seg({ lastEvent: 'waiting', waitReason: 'question', detail: 'merge?' }), '⏸ Waiting on you: merge? · 2m');
  assert.equal(seg({ lastEvent: 'waiting', waitReason: 'permission', detail: 'approve Bash' }), '⏸ Waiting on you: approve Bash · 2m');
  assert.equal(seg({ lastEvent: 'waiting', waitReason: 'open-tasks', plan }), '⏸ Stopped · 3/6 done · 2m');
  assert.equal(seg({ lastEvent: 'done', plan: G.applyTool(undefined, 'TodoWrite', todos('completed', 'completed')) }), '✓ Done 2/2');
  assert.equal(seg({ lastEvent: 'error', detail: 'npm ERR! missing script' }), '✗ Error: npm ERR! missing script · 2m');
  assert.equal(seg({ lastEvent: 'starting' }), '');
  assert.equal(G.segment(null), '');
  assert.match(G.segment({ lastEvent: 'done' }), /^\x1b\[32m✓ Done\x1b\[0m$/);
});

test('duration formats', () => {
  assert.deepEqual([0, 59e3, 60e3, 3599e3, 3600e3, 3900e3, -5].map(G.duration), ['0s', '59s', '1m', '59m', '1h00m', '1h05m', '0s']);
});

// ---------- end to end: hook

test('hook: PostToolUse TodoWrite is recorded; Stop asking a question is waiting, not done', () => {
  const h = home();
  emit(h, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'deploy' });
  emit(h, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'TodoWrite', tool_input: todos('completed', 'in_progress', 'pending'), tool_response: {} });
  let r = ev(h, 's1');
  assert.equal(r.lastEvent, 'working');
  assert.deepEqual(G.summarize(r.plan), { done: 1, total: 3, label: 'Doing step 2' });
  assert.equal(typeof r.stateSince, 'number');
  emit(h, { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Staged it. Should I push?' });
  r = ev(h, 's1');
  assert.equal(r.lastEvent, 'waiting');
  assert.equal(r.waitReason, 'question');
  assert.equal(r.detail, 'Should I push?');
  assert.equal(r.plan.length, 3, 'plan kept');
});

test('hook: Stop with open tasks is stopped; with everything done it is done', () => {
  const h = home();
  emit(h, { hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'TodoWrite', tool_input: todos('completed', 'pending') });
  emit(h, { hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'Took care of the first part.' });
  assert.equal(ev(h, 's2').waitReason, 'open-tasks');
  emit(h, { hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'TodoWrite', tool_input: todos('completed', 'completed') });
  emit(h, { hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'All done.' });
  const r = ev(h, 's2');
  assert.equal(r.lastEvent, 'done');
  assert.equal(r.waitReason, undefined);
});

test('hook: Stop reads the transcript when the payload has no last message', () => {
  const h = home();
  const t = path.join(h, 'session.jsonl');
  fs.writeFileSync(t, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Approve the migration?' }] } }) + '\n');
  emit(h, { hook_event_name: 'Stop', session_id: 's3', transcript_path: t });
  assert.equal(ev(h, 's3').waitReason, 'question');
});

test('hook: PermissionRequest stays waiting with the tool name; errors keep a short reason', () => {
  const h = home();
  emit(h, { hook_event_name: 'PermissionRequest', session_id: 's4', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.deepEqual([ev(h, 's4').lastEvent, ev(h, 's4').waitReason, ev(h, 's4').detail], ['waiting', 'permission', 'approve Bash']);
  emit(h, { hook_event_name: 'PostToolUseFailure', session_id: 's4', tool_name: 'Bash', error: 'Exit code 1\nnpm ERR! missing script: deploy' });
  assert.equal(ev(h, 's4').detail, 'Exit code 1 npm ERR! missing script: deploy');
  emit(h, { hook_event_name: 'PostToolUse', session_id: 's4', tool_name: 'Bash' });
  assert.equal(ev(h, 's4').detail, undefined, 'detail clears with the state');
});

test('hook: Gemini write_todos via AfterTool, Codex Interrupt is never reclassified', () => {
  const h = home();
  emit(h, { hook_event_name: 'AfterTool', session_id: 'g1', tool_name: 'write_todos', tool_input: { todos: [{ description: 'x', status: 'in_progress' }] }, tool_response: {} }, 'gemini');
  assert.deepEqual(G.summarize(ev(h, 'g1', 'gemini').plan), { done: 0, total: 1, label: 'x' });
  emit(h, { hook_event_name: 'AfterAgent', session_id: 'g1', prompt_response: 'Proceed with the rest?' }, 'gemini');
  assert.equal(ev(h, 'g1', 'gemini').waitReason, 'question');
  emit(h, { hook_event_name: 'Interrupt', session_id: 'x1', last_assistant_message: 'Shall I go on?' }, 'codex');
  assert.equal(ev(h, 'x1', 'codex').lastEvent, 'done');
});

test('Stop: the transcript corrects a task list the hooks recorded short', () => {
  const h = home();
  const t = path.join(h, 'session.jsonl');
  const line = (j) => JSON.stringify(j);
  fs.writeFileSync(t, [
    line({ type: 'user', message: { content: 'old job' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'TodoWrite', input: todos('pending', 'pending', 'pending', 'pending') }] } }),
    line({ type: 'user', message: { content: 'build and ship it' } }),
    // three parallel creates in one message, then their results
    line({ type: 'assistant', message: { content: ['Build', 'Test', 'Ship'].map((x, i) => ({ type: 'tool_use', id: 'c' + i, name: 'TaskCreate', input: { subject: x } })) } }),
    ...[0, 1, 2].map((i) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c' + i, content: `Task #${i + 1} created successfully` }] } })),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Built. Moving on next turn.' }] } }),
  ].join('\n') + '\n');
  // What concurrent hooks might have left: task 2 lost, and task 1 never marked complete.
  emit(h, { hook_event_name: 'PostToolUse', session_id: 'r1', tool_name: 'TaskCreate', tool_input: { subject: 'Build' }, tool_response: { task: { id: '1' } } });
  emit(h, { hook_event_name: 'PostToolUse', session_id: 'r1', tool_name: 'TaskCreate', tool_input: { subject: 'Ship' }, tool_response: { task: { id: '3' } } });
  assert.equal(ev(h, 'r1').plan.length, 2);
  emit(h, { hook_event_name: 'Stop', session_id: 'r1', transcript_path: t });
  const r = ev(h, 'r1');
  assert.deepEqual(r.plan.map((i) => [i.id, i.text, i.status]), [['1', 'Build', 'completed'], ['3', 'Ship', 'pending'], ['2', 'Test', 'pending']]);
  assert.equal(r.waitReason, 'open-tasks');
  assert.equal(G.segment(r, { color: false }).split(' · ').slice(0, 2).join(' · '), '⏸ Stopped · 1/3 done', 'the old job\'s 4-item list stays out');
});

test('hook: concurrent TaskCreate hooks all land (no lost updates)', async () => {
  const h = home();
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    const c = spawn('node', [bin(h, 'votive-event.js'), '--agent', 'claude-code'], { env: { ...process.env, HOME: h, USERPROFILE: h } });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'par', tool_name: 'TaskCreate', tool_input: { subject: 'T' + i }, tool_response: { task: { id: String(i + 1) } } }));
  })));
  assert.equal(ev(h, 'par').plan.length, N);
  assert.deepEqual(fs.readdirSync(path.join(h, '.votive', 'locks')), [], 'locks released');
});

// ---------- end to end: statusLine wrapper

const EXACT = 'GSD \x1b[1mbold\x1b[0m │ ctx 42%\nsecond line';

function withRecord(h, id, rec) {
  const d = path.join(h, '.votive', 'events');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'claude-code--' + id + '.json'), JSON.stringify(Object.assign({ agent: 'claude-code', sessionId: id, lastEventAt: Date.now() }, rec)));
}

test('wrapper: prepends the segment; the wrapped output follows byte for byte', () => {
  const h = home();
  const out = path.join(h, 'gsd.txt');
  fs.writeFileSync(out, EXACT);
  wrapped(h, helpers.cat(out));
  withRecord(h, 'w1', { lastEvent: 'waiting', waitReason: 'question', detail: 'merge?', stateSince: Date.now() });
  const r = run(h, 'votive-statusline.js', JSON.stringify({ session_id: 'w1' }), [], { NO_COLOR: '1' });
  assert.ok(r.stdout.startsWith('⏸ Waiting on you: merge? · 0s'), r.stdout);
  assert.ok(r.stdout.endsWith(EXACT), 'wrapped output unchanged');
  assert.equal(r.stdout.indexOf(EXACT), r.stdout.length - EXACT.length);
});

test('wrapper: no record, an unknown session, or --no-task leaves the output exactly as before', () => {
  const h = home();
  const out = path.join(h, 'gsd.txt');
  fs.writeFileSync(out, EXACT);
  wrapped(h, helpers.cat(out));
  const plain = (input, args) => run(h, 'votive-statusline.js', input, args).stdout;
  assert.equal(plain(JSON.stringify({ session_id: 'nobody' })), EXACT);
  assert.equal(plain('not json'), EXACT);
  withRecord(h, 'w2', { lastEvent: 'done' });
  assert.notEqual(plain(JSON.stringify({ session_id: 'w2' })), EXACT);
  assert.equal(plain(JSON.stringify({ session_id: 'w2' }), ['--no-task']), EXACT);
});

test('wrapper: a wrapped command that prints nothing leaves no dangling separator', () => {
  const h = home();
  wrapped(h, 'true');
  withRecord(h, 'w4', { lastEvent: 'done' });
  assert.equal(run(h, 'votive-statusline.js', JSON.stringify({ session_id: 'w4' }), [], { NO_COLOR: '1' }).stdout, '✓ Done');
});

test('wrapper: large wrapped output passes through intact', () => {
  const h = home();
  const out = path.join(h, 'big.txt');
  const big = Buffer.from(Array.from({ length: 300000 }, (_, i) => String.fromCharCode(32 + (i % 90))).join(''));
  fs.writeFileSync(out, big);
  wrapped(h, helpers.cat(out));
  withRecord(h, 'w5', { lastEvent: 'done' });
  const r = spawnSync('node', [bin(h, 'votive-statusline.js')], { input: JSON.stringify({ session_id: 'w5' }), env: { ...process.env, HOME: h, USERPROFILE: h, NO_COLOR: '1' }, maxBuffer: 1 << 24 });
  assert.ok(r.stdout.subarray(r.stdout.length - big.length).equals(big));
});

test('wrapper: with no wrapped command, prints the segment alone; a corrupt record is skipped', () => {
  const h = home();
  withRecord(h, 'w3', { lastEvent: 'working', stateSince: Date.now() });
  assert.equal(run(h, 'votive-statusline.js', JSON.stringify({ session_id: 'w3' }), [], { NO_COLOR: '1' }).stdout, '● Working · 0s');
  fs.writeFileSync(path.join(h, '.votive', 'events', 'claude-code--w3.json'), '{broken');
  const r = run(h, 'votive-statusline.js', JSON.stringify({ session_id: 'w3' }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ---------- background agents and commands (shapes from real Claude Code transcripts)

const J = (j) => JSON.stringify(j);
const ts = (ms) => new Date(ms).toISOString();
const launchAgent = (id, at) => J({ type: 'user', timestamp: ts(at), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-' + id, content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + id }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } });
const launchCmd = (id, at) => J({ type: 'user', timestamp: ts(at), message: { content: [{ type: 'tool_result', tool_use_id: 'tb-' + id, content: 'Command running in background with ID: ' + id }] }, toolUseResult: { stdout: '', backgroundTaskId: id } });
const note = (id, status = 'completed') => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu-${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`;
const queued = (id, status) => J({ type: 'queue-operation', operation: 'enqueue', content: note(id, status) });
const delivered = (id) => J({ type: 'user', origin: { kind: 'task-notification' }, message: { content: note(id) } });
const said = (text) => J({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const prompt = (text) => J({ type: 'user', message: { content: text } });

function transcript(h, lines) {
  const t = path.join(h, 'bg-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(t, lines.join('\n') + '\n');
  return t;
}

test('background: launches and completions are matched by id; any final status finishes one', () => {
  const now = Date.now();
  const t = transcript(home(), [
    prompt('run four reviewers'),
    launchAgent('a1', now), launchAgent('a2', now), launchAgent('a3', now), launchCmd('b1', now),
    queued('a1'), delivered('a2'), queued('b1', 'killed'),
    said('Launched them; I will report back.'),
  ]);
  const scan = G.scanTranscript(t, undefined, now);
  assert.deepEqual(scan.background.map((b) => [b.id, b.kind]), [['a3', 'agent']]);
});

test('background: quoted launch text or notification-looking prompts invent nothing', () => {
  const now = Date.now();
  const t = transcript(home(), [
    prompt('Launches are tool_result text containing "Async agent launched successfully" with agentId: zzz'),
    J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g', content: 'Async agent launched successfully.\nagentId: fake1' }] } }),
    said('agentId: fake2 — Command running in background with ID: fake3'),
  ]);
  assert.deepEqual(G.scanTranscript(t, undefined, now).background, []);
});

test('background: a launch older than the max age is presumed lost', () => {
  const now = Date.now();
  const t = transcript(home(), [launchAgent('old', now - G.BG_MAX_AGE_MS - 1000), launchAgent('new', now - 1000)]);
  assert.deepEqual(G.scanTranscript(t, undefined, now).background.map((b) => b.id), ['new']);
});

test('background: a task notification is not a prompt (the task-list replay window survives it)', () => {
  const now = Date.now();
  const t = transcript(home(), [
    prompt('do it'),
    J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'TodoWrite', input: todos('completed', 'pending') }] } }),
    delivered('a9'),
    said('Noted.'),
  ]);
  assert.deepEqual(G.summarize(G.scanTranscript(t, undefined, now).plan), { done: 1, total: 2, label: null });
});

test('Stop precedence: question > background running > open tasks > done', () => {
  const h = home();
  const now = Date.now();
  const bg = [prompt('go'), launchAgent('a1', now), launchAgent('a2', now)];
  emit(h, { hook_event_name: 'Stop', session_id: 'p1', transcript_path: transcript(h, [...bg, said('Two agents are on it. Want me to wait?')]) });
  assert.equal(ev(h, 'p1').waitReason, 'question', 'a question still wins');
  emit(h, { hook_event_name: 'Stop', session_id: 'p2', transcript_path: transcript(h, [...bg, said('Two agents are on it.')]) });
  const r = ev(h, 'p2');
  assert.equal(r.lastEvent, 'working');
  assert.deepEqual(r.bg.ids, ['a1', 'a2']);
  assert.deepEqual(r.bg.then, { state: 'done' });
  assert.match(G.segment(r, { color: false }), /^◐ 2 agents running · \d+s$/);
  emit(h, { hook_event_name: 'Stop', session_id: 'p3', transcript_path: transcript(h, [...bg, queued('a1'), queued('a2'), said('Both reported back.')]) });
  assert.equal(ev(h, 'p3').lastEvent, 'done');
  assert.equal(ev(h, 'p3').bg, undefined);
});

test('background segment: counts down as completions arrive, then falls back to the Stop result', () => {
  const rec = { lastEvent: 'working', lastEventAt: 1000, bg: { at: 1000, ids: ['a1', 'a2', 'b1'], kinds: ['agent', 'agent', 'command'], then: { state: 'waiting', waitReason: 'open-tasks' } },
    plan: G.applyTool(undefined, 'TodoWrite', todos('completed', 'pending')) };
  const seg = (fin) => G.segment(rec, { now: 61000, color: false, finished: new Set(fin) });
  assert.equal(seg([]), '◐ 3 background tasks running · 1m');
  assert.equal(seg(['b1']), '◐ 2 agents running · 1m');
  assert.equal(seg(['a1', 'a2']), '◐ 1 command running · 1m');
  assert.equal(seg(['a1', 'a2', 'b1']), '⏸ Stopped · 1/2 done · 1m');
  // The agent moved on after the Stop (a later event): its own state stands.
  assert.equal(G.segment(Object.assign({}, rec, { lastEventAt: 9000, stateSince: 9000 }), { now: 9000, color: false, finished: new Set(['a1', 'a2', 'b1']) }), '● Working · 1/2 · 50% · 0s');
  assert.match(G.segment(rec, { now: 61000, finished: new Set() }), /^\x1b\[34m◐/);
  assert.ok([...'◐ 50 background tasks running · 99h+'].length <= G.MAX_WIDTH);
});

test('background: subagent tool events keep the count; a new prompt drops it', () => {
  const h = home();
  const now = Date.now();
  emit(h, { hook_event_name: 'Stop', session_id: 'k1', transcript_path: transcript(h, [prompt('go'), launchAgent('a1', now), said('On it.')]) });
  emit(h, { hook_event_name: 'PostToolUse', session_id: 'k1', tool_name: 'Read' });
  assert.deepEqual(ev(h, 'k1').bg.ids, ['a1']);
  emit(h, { hook_event_name: 'UserPromptSubmit', session_id: 'k1', prompt: 'something else' });
  assert.equal(ev(h, 'k1').bg, undefined);
});

test('wrapper: counts background work down from the transcript between hook events', () => {
  const h = home();
  const now = Date.now();
  const t = transcript(h, [prompt('go'), launchAgent('a1', now), launchAgent('a2', now), said('On it.')]);
  emit(h, { hook_event_name: 'Stop', session_id: 'sl', transcript_path: t });
  const line = () => run(h, 'votive-statusline.js', JSON.stringify({ session_id: 'sl' }), [], { NO_COLOR: '1' }).stdout;
  assert.match(line(), /^◐ 2 agents running/);
  fs.appendFileSync(t, queued('a1') + '\n');
  assert.match(line(), /^◐ 1 agent running/);
  fs.appendFileSync(t, queued('a2', 'failed') + '\n');
  assert.equal(line(), '✓ Done');
});
