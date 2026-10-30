'use strict';
//
// Regression tests for AGEN-24: hook hardening. Same style as scripts.test.js: every test
// runs against a throwaway HOME, so your real ~/.votive and ~/.codex are never touched.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const S = path.join(__dirname, '..', 'Scripts');
const ROOT = path.join(__dirname, '..');
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao hard '));   // space on purpose
  fs.mkdirSync(path.join(h, '.votive', 'bin'), { recursive: true });
  for (const f of fs.readdirSync(S).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) fs.copyFileSync(path.join(S, f), path.join(h, '.votive', 'bin', f));
  return h;
}
const bin = (h) => path.join(h, '.votive', 'bin', 'votive-event.js');
const emit = (h, agent, payload, opts = {}) => spawnSync('node', [...(opts.nodeArgs || []), bin(h), '--agent', agent],
  { input: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), encoding: 'utf8',
    maxBuffer: 1 << 20, env: { ...process.env, HOME: h, USERPROFILE: h, ...(opts.env || {}) } });
const events = (h) => {
  try { return fs.readdirSync(path.join(h, '.votive', 'events')).filter((f) => f.endsWith('.json')).sort(); }
  catch (e) { return []; }
};
const readEvent = (h, f) => JSON.parse(fs.readFileSync(path.join(h, '.votive', 'events', f), 'utf8'));

// ---------- session ids

test('hardening: ids that differ only by punctuation or case get different files', () => {
  const h = home();
  for (const id of ['a/b', 'a_b', 'ABC', 'abc', 'x'.repeat(250) + '1', 'x'.repeat(250) + '2']) {
    const r = emit(h, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: id, cwd: '/r' });
    assert.equal(r.status, 0);
  }
  const files = events(h);
  assert.equal(files.length, 6, 'one file per id, none merged: ' + files.join(' '));
  assert.deepEqual(files.map((f) => readEvent(h, f).sessionId).sort(), ['ABC', 'a/b', 'a_b', 'abc', 'x'.repeat(250) + '1', 'x'.repeat(250) + '2'].sort());
  emit(h, 'claude-code', { hook_event_name: 'SessionEnd', session_id: 'a/b' });
  assert.equal(events(h).length, 5, 'SessionEnd removes only its own file');
  assert.ok(events(h).some((f) => readEvent(h, f).sessionId === 'a_b'));
});

test('hardening: a normal id keeps its plain file name, a hostile one stays inside events/', () => {
  const h = home();
  emit(h, 'codex', { hook_event_name: 'SessionStart', session_id: '0f3c9a1e-5b7d-4c21-9e0a-1d2b3c4d5e6f' });
  assert.deepEqual(events(h), ['codex--0f3c9a1e-5b7d-4c21-9e0a-1d2b3c4d5e6f.json']);
  for (const id of ['../../../escape', '..', '/etc/passwd', 'a\\b', '.hidden']) {
    emit(h, 'codex', { hook_event_name: 'SessionStart', session_id: id });
  }
  assert.ok(!fs.existsSync(path.join(h, 'escape.json')) && !fs.existsSync(path.join(h, '.votive', 'escape.json')));
  for (const f of events(h)) assert.ok(!f.includes('/'), f);
});

test('hardening: an id with control characters or over 256 characters is ignored, not stored', () => {
  const h = home();
  for (const id of ['bad\nid', 'bad\u0000id', 'y'.repeat(300)]) {
    const r = emit(h, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: id });
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  assert.deepEqual(events(h), []);
});

// ---------- raw control characters

test('hardening: control, escape and bidi characters never reach the event file', () => {
  const h = home();
  const evil = 'run \u001b[2J\u001b]0;pwned\u0007 now ‮gnp.exe‬ ⁦x⁩ \u0000 end';
  emit(h, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'c1', prompt: evil, cwd: '/tmp/a\nb‮', transcript_path: '/t/\u001b.jsonl' });
  const raw = fs.readFileSync(path.join(h, '.votive', 'events', 'claude-code--c1.json'), 'utf8');
  const rec = JSON.parse(raw);
  const bad = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
  for (const k of ['prompt', 'cwd', 'transcriptPath']) assert.ok(!bad.test(rec[k]), k + ' = ' + JSON.stringify(rec[k]));
  assert.match(rec.prompt, /^run .*now .* end$/);
});

test('hardening: a notify message is single-line plain text', () => {
  const h = home();
  const d = path.join(h, '.claude', 'sessions');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, process.pid + '.json'), JSON.stringify({ sessionId: 'n9' }));
  const r = spawnSync('node', [path.join(h, '.votive', 'bin', 'votive-notify.js'), 'done\n\u001b[31mRED\u001b[0m ‮txt.exe'],
    { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h } });
  assert.equal(r.status, 0, r.stderr);
  const msg = readEvent(h, 'claude-code--n9.json').notifyMessage;
  assert.ok(!/[\u0000-\u001f\u007f-\u009f‪-‮]/.test(msg), JSON.stringify(msg));
});

// ---------- unbounded stdin

test('hardening: a 64 MB payload is drained, the state is still recorded, memory stays small', () => {
  const h = home();
  const head = '{"session_id":"huge","hook_event_name":"PostToolUseFailure","cwd":"/big","tool_response":"';
  const body = Buffer.concat([Buffer.from(head), Buffer.alloc(64 << 20, 0x78), Buffer.from('"}')]);
  const t0 = Date.now();
  // 40 MB old-space limit: the old `buf += chunk` loop needs a 64 MB string and dies here.
  const r = emit(h, 'claude-code', body, { nodeArgs: ['--max-old-space-size=40'] });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
  const rec = readEvent(h, 'claude-code--huge.json');
  assert.equal(rec.lastEvent, 'error');
  assert.equal(rec.cwd, '/big');
});

test('hardening: the largest event file the hook can write stays under 64 KB', () => {
  const h = home();
  const todos = Array.from({ length: 2000 }, (_, i) => ({ content: 'task ' + 'z'.repeat(500) + i, status: 'pending', activeForm: 'a'.repeat(500) }));
  emit(h, 'claude-code', { hook_event_name: 'PostToolUse', session_id: 'sz', tool_name: 'TodoWrite', tool_input: { todos },
    cwd: '/' + 'c'.repeat(100000), prompt: 'p'.repeat(100000), transcript_path: '/' + 't'.repeat(100000) });
  const size = fs.statSync(path.join(h, '.votive', 'events', 'claude-code--sz.json')).size;
  assert.ok(size < 64 * 1024, 'event file is ' + size + ' bytes');
});

// ---------- Codex usage source

function rolloutLine(pct) {
  const resets = Math.floor(Date.now() / 1000) + 3600;
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: resets }, secondary: null } } }) + '\n';
}
const usageFile = (h) => path.join(h, '.votive', 'usage', 'codex.json');
const codexStop = (h, t, env) => emit(h, 'codex', { hook_event_name: 'Stop', session_id: 'cx', transcript_path: t }, { env });

test('hardening: Codex usage is read only from Codex session files', () => {
  const h = home();
  const evil = path.join(h, 'evil.jsonl');
  fs.writeFileSync(evil, rolloutLine(99));
  codexStop(h, evil);
  assert.ok(!fs.existsSync(usageFile(h)), 'an arbitrary .jsonl set the usage numbers');

  const dir = path.join(h, '.codex', 'sessions', '2026', '10', '17');
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, 'rollout-link.jsonl');
  fs.symlinkSync(evil, link);
  codexStop(h, link);
  assert.ok(!fs.existsSync(usageFile(h)), 'a symlink out of sessions/ was followed');

  const wrongName = path.join(dir, 'notes.jsonl');
  fs.writeFileSync(wrongName, rolloutLine(98));
  codexStop(h, wrongName);
  assert.ok(!fs.existsSync(usageFile(h)), 'a file that is not rollout-*.jsonl was read');

  const good = path.join(dir, 'rollout-2026-10-17T10-00-00-abc.jsonl');
  fs.writeFileSync(good, rolloutLine(37));
  codexStop(h, good);
  assert.equal(JSON.parse(fs.readFileSync(usageFile(h), 'utf8')).windows[0].usedPercentage, 37);
});

test('hardening: CODEX_HOME moves the allowed folder', () => {
  const h = home();
  const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'ao codexhome '));
  const f = path.join(alt, 'sessions', '2026', '10', '17', 'rollout-x.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rolloutLine(21));
  codexStop(h, f, { CODEX_HOME: alt });
  assert.equal(JSON.parse(fs.readFileSync(usageFile(h), 'utf8')).windows[0].usedPercentage, 21);
});

// ---------- bare ps

test('hardening: the hook runs /bin/ps, never a `ps` found on PATH', { skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake ps' }, () => {
  const h = home();
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'ao fakeps '));
  const marker = path.join(fake, 'ran');
  fs.writeFileSync(path.join(fake, 'ps'), '#!/bin/sh\ntouch "' + marker + '"\necho "1 zsh"\n', { mode: 0o755 });
  emit(h, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'p1' }, { env: { PATH: fake + path.delimiter + process.env.PATH } });
  assert.ok(!fs.existsSync(marker), 'a ps from PATH was executed');
  assert.equal(events(h).length, 1, 'the event is still recorded');
});

test('hardening: no script resolves ps, launchctl, defaults or pgrep through PATH', () => {
  const offenders = [];
  for (const f of fs.readdirSync(S).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(S, f), 'utf8');
    for (const m of src.matchAll(/(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"]([^'"/]+)['"]/g)) {
      if (['ps', 'launchctl', 'defaults', 'pgrep', 'open', 'osascript', 'codesign'].includes(m[1])) offenders.push(f + ': ' + m[1]);
    }
  }
  assert.deepEqual(offenders, []);
});

// ---------- Swift event-file size cap (needs the Swift toolchain; skipped without it)

let swiftc = null;
try { swiftc = execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim(); } catch (e) {}

test('hardening: the app refuses event files that are huge, not regular, or symlinks', { skip: !swiftc && 'no Swift toolchain' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao swift '));
  fs.writeFileSync(path.join(d, 'main.swift'), [
    'import Foundation',
    'func d(_ n: String) -> Data? { BoundedRead.data(at: URL(fileURLWithPath: CommandLine.arguments[1] + "/" + n)) }',
    'print(d("small.json")?.count ?? -1, d("big.json")?.count ?? -1, d("fifo.json")?.count ?? -1, d("link.json")?.count ?? -1, d("nope.json")?.count ?? -1)',
  ].join('\n'));
  const exe = path.join(d, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, path.join(ROOT, 'Votive', 'Services', 'BoundedRead.swift'), path.join(d, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const data = path.join(d, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'small.json'), '{"a":1}');
  fs.writeFileSync(path.join(data, 'big.json'), Buffer.alloc(300 * 1024, 0x78));
  execFileSync('/usr/bin/mkfifo', [path.join(data, 'fifo.json')]);
  fs.symlinkSync(path.join(data, 'small.json'), path.join(data, 'link.json'));
  const r = spawnSync(exe, [data], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, 'a FIFO must not hang the reader: ' + r.stderr);
  assert.equal(r.stdout.trim(), '7 -1 -1 -1 -1');
});
