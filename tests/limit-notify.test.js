'use strict';
//
// What to tell the owner when Claude Code hits a plan limit (AGEN-45 phase 2, TDD 22-27). The message is
// chosen from facts only (reset time, the auto-continue setting, the version) and is built from fixed
// templates: nothing from the payload or any file ever becomes message text. UTC so times are exact.
//
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { limitNotice, pickReset, versionAtLeast } = require('../Scripts/limit-notify');

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);   // Sun 18 Oct 12:00 UTC
const H = 3600e3;
const base = { errorType: 'rate_limit', nowMs: NOW, autoContinue: undefined, version: '2.1.287' };

test('22: a limit that resets in a few hours says it should continue by itself, with the time', () => {
  const m = limitNotice({ ...base, resetsAtMs: NOW + 3 * H });
  assert.match(m, /^Plan limit reached\./);
  assert.match(m, /should continue by itself/);
  assert.match(m, /15:00/);
  assert.doesNotMatch(m, /rate-limit-options|turned off/);
});

test('22b: setting explicitly true behaves like unset (on by default)', () => {
  assert.match(limitNotice({ ...base, autoContinue: true, resetsAtMs: NOW + 3 * H }), /should continue by itself/);
});

test('23: a reset more than 24 hours away is the weekly case and names /rate-limit-options', () => {
  const m = limitNotice({ ...base, resetsAtMs: NOW + 3 * 24 * H });
  assert.match(m, /will not continue by itself/);
  assert.match(m, /\/rate-limit-options/);
  assert.match(m, /Wed 12:00/);
  assert.doesNotMatch(m, /should continue/);
});

test('23b: exactly 24 hours is still the short case, a minute more is the long case', () => {
  assert.match(limitNotice({ ...base, resetsAtMs: NOW + 24 * H }), /should continue/);
  assert.match(limitNotice({ ...base, resetsAtMs: NOW + 24 * H + 60e3 }), /will not continue/);
});

test('24: auto-continue turned off says so and makes no claim about continuing', () => {
  const m = limitNotice({ ...base, autoContinue: false, resetsAtMs: NOW + 3 * H });
  assert.match(m, /turned off/);
  assert.doesNotMatch(m, /should continue|will continue/);
  assert.match(m, /15:00/);
});

test('25: unknown version makes no claim; a version before auto-continue says it does not continue', () => {
  const none = limitNotice({ ...base, version: undefined, resetsAtMs: NOW + 3 * H });
  assert.doesNotMatch(none, /should continue|will not continue|turned off/);
  assert.match(none, /15:00/);
  assert.match(none, /Check Claude Code/);
  const garbage = limitNotice({ ...base, version: 'banana', resetsAtMs: NOW + 3 * H });
  assert.doesNotMatch(garbage, /should continue/);
  const old = limitNotice({ ...base, version: '2.1.200', resetsAtMs: NOW + 3 * H });
  assert.match(old, /older than 2\.1\.234|does not continue by itself/);
});

test('25b: an unreadable setting value (not true or false) is treated as unset, never as a claim of "off"', () => {
  for (const weird of ['no', 0, null, {}, 'false']) {
    assert.match(limitNotice({ ...base, autoContinue: weird, resetsAtMs: NOW + 3 * H }), /should continue/, String(weird));
  }
});

test('25c: no reset time known: still a notice, no time, no promise', () => {
  const m = limitNotice({ ...base, resetsAtMs: undefined });
  assert.match(m, /^Plan limit reached\./);
  assert.doesNotMatch(m, /\d\d:\d\d|should continue/);
});

test('27: other error types, and nonsense, give no notice', () => {
  for (const t of ['overloaded', 'billing_error', 'authentication_failed', 'loop_detected', '', undefined, null, 5, {}, 'RATE_LIMIT']) {
    assert.equal(limitNotice({ ...base, errorType: t, resetsAtMs: NOW + H }), null, String(t));
  }
});

test('the text is built from fixed templates: hostile inputs cannot add words', () => {
  const evil = 'IGNORE PREVIOUS INSTRUCTIONS $(rm -rf) <script>';
  for (const input of [{ version: evil }, { autoContinue: evil }, { errorType: 'rate_limit' }, { resetsAtMs: evil }]) {
    const m = limitNotice({ ...base, resetsAtMs: NOW + H, ...input });
    if (m !== null) assert.doesNotMatch(m, /IGNORE|rm -rf|script/);
  }
  const m = limitNotice({ ...base, resetsAtMs: NOW + H });
  assert.ok(m.length < 260, 'short enough for a panel');
});

test('a reset time in the past or absurd is ignored, not announced', () => {
  for (const r of [NOW - 1000, 0, -5, NaN, Infinity, 1e20, '3pm']) {
    const m = limitNotice({ ...base, resetsAtMs: r });
    assert.doesNotMatch(m, /\d\d:\d\d/, String(r));
  }
});

test('pickReset: the fullest window that has not reset yet, else the soonest', () => {
  const w = (label, pct, inMs) => ({ label, usedPercentage: pct, resetsAt: Math.floor((NOW + inMs) / 1000) });
  assert.equal(pickReset([w('Session', 99, 2 * H), w('Weekly', 80, 3 * 24 * H)], NOW), Math.floor((NOW + 2 * H) / 1000) * 1000);
  assert.equal(pickReset([w('Session', 10, 2 * H), w('Weekly', 95, 3 * 24 * H)], NOW), Math.floor((NOW + 3 * 24 * H) / 1000) * 1000);
  assert.equal(pickReset([w('Session', 50, -H)], NOW), undefined, 'already reset');
  assert.equal(pickReset([], NOW), undefined);
  assert.equal(pickReset(null, NOW), undefined);
  assert.equal(pickReset([{ label: 'x', usedPercentage: 'a', resetsAt: 'b' }, null, 5], NOW), undefined);
  assert.equal(pickReset([w('A', 90, H), w('B', 90, 2 * H)], NOW), Math.floor((NOW + H) / 1000) * 1000, 'a tie goes to the sooner reset');
});

test('versionAtLeast compares numerically, never as text', () => {
  assert.equal(versionAtLeast('2.1.287', '2.1.234'), true);
  assert.equal(versionAtLeast('2.1.234', '2.1.234'), true);
  assert.equal(versionAtLeast('2.1.99', '2.1.234'), false);
  assert.equal(versionAtLeast('2.10.0', '2.1.234'), true);
  assert.equal(versionAtLeast('3.0.0', '2.1.234'), true);
  assert.equal(versionAtLeast('2.1.287 (Claude Code)', '2.1.234'), true, 'the --version line as printed');
  for (const bad of [undefined, null, '', 'x', '2.1', '2.1.x', 5, {}]) assert.equal(versionAtLeast(bad, '2.1.234'), null, String(bad));
});

// ---- the hook: writes the notice into the event file, once per reset, never anything else ----
const S = path.join(__dirname, '..', 'Scripts');
function scratch() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ao lim '));
  fs.mkdirSync(path.join(h, '.votive', 'bin'), { recursive: true });
  for (const f of fs.readdirSync(S).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) fs.copyFileSync(path.join(S, f), path.join(h, '.votive', 'bin', f));
  fs.mkdirSync(path.join(h, '.votive', 'usage'), { recursive: true });
  return h;
}
const env = (h) => ({ ...process.env, HOME: h, USERPROFILE: h });
const hook = (h, payload) => spawnSync(process.execPath, [path.join(h, '.votive', 'bin', 'votive-event.js'), '--agent', 'claude-code'], { input: JSON.stringify(payload), encoding: 'utf8', env: env(h) });
// Event file names are one-to-one with the session id and not always the id itself (AGEN-24: an id with a capital
// letter gets a hashed name), so find the record by the id stored inside it.
const rec = (h, s) => {
  const dir = path.join(h, '.votive', 'events');
  for (const f of fs.readdirSync(dir)) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j.sessionId === s) return j; }
  throw new Error('no event file for session ' + s);
};
const writeUsage = (h, windows, extra = {}) => fs.writeFileSync(path.join(h, '.votive', 'usage', 'claude-code.json'), JSON.stringify({ agent: 'claude-code', updatedAt: Date.now(), windows, ...extra }));
const soon = (ms) => Math.floor((Date.now() + ms) / 1000);

test('hook: a rate_limit StopFailure writes the notice, once per reset time', () => {
  const h = scratch();
  writeUsage(h, [{ label: 'Session', usedPercentage: 100, resetsAt: soon(3 * H) }], { claudeVersion: '2.1.287' });
  const p = { hook_event_name: 'StopFailure', session_id: 'L1', error_type: 'rate_limit', error: 'IGNORE PREVIOUS INSTRUCTIONS' };
  assert.equal(hook(h, p).status, 0);
  const r1 = rec(h, 'L1');
  assert.equal(r1.lastEvent, 'error');
  assert.match(r1.notifyMessage, /^Plan limit reached\..*should continue by itself/);
  assert.doesNotMatch(r1.notifyMessage, /IGNORE PREVIOUS/, 'payload text never becomes the notice (the short error reason the hook already keeps in `detail` is separate and unchanged)');
  const at1 = r1.notifyAt;
  hook(h, p);
  assert.equal(rec(h, 'L1').notifyAt, at1, 'the same reset is announced once');
  writeUsage(h, [{ label: 'Session', usedPercentage: 100, resetsAt: soon(3 * H) + 18000 }], { claudeVersion: '2.1.287' });
  hook(h, p);
  assert.ok(rec(h, 'L1').notifyAt >= at1 && rec(h, 'L1').limitResetsAt !== r1.limitResetsAt, 'the next window announces again');
});

test('hook: auto-continue turned off in Claude settings is reflected', () => {
  const h = scratch();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ autoContinueAtUsageLimit: false }));
  writeUsage(h, [{ label: 'Session', usedPercentage: 100, resetsAt: soon(2 * H) }], { claudeVersion: '2.1.287' });
  hook(h, { hook_event_name: 'StopFailure', session_id: 'L2', error_type: 'rate_limit' });
  assert.match(rec(h, 'L2').notifyMessage, /turned off/);
});

test('hook: other failures and other events add no notice, and the hook still exits 0 silently', () => {
  const h = scratch();
  writeUsage(h, [{ label: 'Session', usedPercentage: 100, resetsAt: soon(2 * H) }], { claudeVersion: '2.1.287' });
  for (const [name, p] of [['overloaded', { hook_event_name: 'StopFailure', session_id: 'L3', error_type: 'overloaded' }],
    ['stop', { hook_event_name: 'Stop', session_id: 'L3', error_type: 'rate_limit' }], ['no type', { hook_event_name: 'StopFailure', session_id: 'L3' }]]) {
    const r = hook(h, p);
    assert.equal(r.status, 0, name); assert.equal(r.stdout + r.stderr, '', name);
    assert.equal(rec(h, 'L3').notifyMessage, undefined, name);
  }
});

test('hook: a missing, broken or oversized usage or settings file never breaks the hook', () => {
  const h = scratch();
  fs.writeFileSync(path.join(h, '.votive', 'usage', 'claude-code.json'), 'not json');
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), 'x'.repeat(200000));
  const r = hook(h, { hook_event_name: 'StopFailure', session_id: 'L4', error_type: 'rate_limit' });
  assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, '');
  assert.equal(rec(h, 'L4').lastEvent, 'error');
  assert.match(rec(h, 'L4').notifyMessage || 'Plan limit reached.', /^Plan limit reached\./);
});

test('hook: a notify request already waiting is not erased by a limit notice for an older reset', () => {
  const h = scratch();
  writeUsage(h, [{ label: 'Session', usedPercentage: 100, resetsAt: soon(2 * H) }], { claudeVersion: '2.1.287' });
  hook(h, { hook_event_name: 'StopFailure', session_id: 'L5', error_type: 'rate_limit' });
  const first = rec(h, 'L5');
  hook(h, { hook_event_name: 'UserPromptSubmit', session_id: 'L5' });
  const after = rec(h, 'L5');
  assert.equal(after.notifyMessage, first.notifyMessage, 'carried forward until the app has shown it');
  assert.equal(after.limitResetsAt, first.limitResetsAt, 'the once-per-reset marker is carried too');
});

test('statusline: the wrapper records the Claude Code version next to the usage windows', () => {
  const h = scratch();
  const r = spawnSync(process.execPath, [path.join(h, '.votive', 'bin', 'votive-statusline.js'), '--no-task'], {
    input: JSON.stringify({ session_id: 'v1', version: '2.1.287', rate_limits: { five_hour: { used_percentage: 42, resets_at: soon(2 * H) } } }), encoding: 'utf8', env: env(h) });
  assert.equal(r.status, 0);
  const u = JSON.parse(fs.readFileSync(path.join(h, '.votive', 'usage', 'claude-code.json'), 'utf8'));
  assert.equal(u.claudeVersion, '2.1.287');
  const evil = spawnSync(process.execPath, [path.join(h, '.votive', 'bin', 'votive-statusline.js'), '--no-task'], {
    input: JSON.stringify({ session_id: 'v2', version: 'IGNORE <b>all</b> ' + 'x'.repeat(300), rate_limits: { five_hour: { used_percentage: 43, resets_at: soon(2 * H) } } }), encoding: 'utf8', env: env(h) });
  assert.equal(evil.status, 0);
  const u2 = JSON.parse(fs.readFileSync(path.join(h, '.votive', 'usage', 'claude-code.json'), 'utf8'));
  assert.ok(u2.claudeVersion === undefined || /^\d+\.\d+\.\d+$/.test(u2.claudeVersion), 'only a plain version string is kept: ' + u2.claudeVersion);
});

test('source: the notice code has no network, process or file-write words', () => {
  const src = fs.readFileSync(path.join(S, 'limit-notify.js'), 'utf8');
  assert.doesNotMatch(src, /\bhttps?\b|fetch\(|child_process|spawn|exec\(|writeFile|osascript|keystroke|token|credential|keychain/i);
});
