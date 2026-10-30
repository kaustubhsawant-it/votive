'use strict';
//
// The budget policy file and its CLI (AGEN-45). Runs in a scratch HOME. The file is shared with the
// Claude Code mod, which writes it with the process umask, so the reader here tightens modes on
// touch and refuses links.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-budget-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const policy = require('../Scripts/budget-policy');
const POSIX = process.platform !== 'win32';   // file modes only mean something on Unix

const dir = path.join(tmp, '.votive', 'budget');
const file = path.join(dir, 'policy.json');
const mode = (p) => fs.statSync(p).mode & 0o777;
const wipe = () => { try { fs.rmSync(path.join(tmp, '.votive'), { recursive: true }); } catch (e) {} };
const LIGHT = { mode: 'light', heavyProjects: [] };

test('read: a missing file is light with no levels', async () => {
  wipe();
  const r = await policy.read();
  assert.deepEqual(r.policy, LIGHT);
  assert.deepEqual(r.levels, {});
  assert.equal(r.problem, null);
});

test('write: private folder and file, content readable by the core', async () => {
  wipe();
  await policy.update({ mode: 'heavy', sessionAt: 90 });
  if (POSIX) { assert.equal(mode(dir), 0o700); assert.equal(mode(file), 0o600); }
  const r = await policy.read();
  assert.equal(r.policy.mode, 'heavy');
  assert.deepEqual(r.levels, { sessionAt: 90 });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['heavyProjects', 'mode', 'sessionAt']);
});

test('read: a loose file written by the mod is reported, and touching it tightens it', async () => {
  wipe();
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(file, '{"mode":"light","heavyProjects":["/work/a"]}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const before = await policy.read();
  if (POSIX) assert.equal(before.loose, true);
  assert.deepEqual(before.policy.heavyProjects, ['/work/a'], 'the content is still honoured');
  const h = await policy.harden();
  if (POSIX) { assert.equal(h.changed, true); assert.equal(mode(dir), 0o700); assert.equal(mode(file), 0o600); }
  assert.equal((await policy.read()).loose, false);
  assert.equal((await policy.harden()).changed, false, 'idempotent');
});

test('a symlinked file is refused: nothing read, nothing written through it', async () => {
  wipe();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(tmp, 'victim.json');
  fs.writeFileSync(target, 'ORIGINAL');
  fs.symlinkSync(target, file);
  const r = await policy.read();
  assert.deepEqual(r.policy, LIGHT);
  assert.equal(r.problem, 'not-a-plain-file');
  await assert.rejects(() => policy.update({ mode: 'heavy' }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
});

test('a symlinked folder is refused', async () => {
  wipe();
  const elsewhere = path.join(tmp, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(path.join(tmp, '.votive'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(elsewhere, dir);
  const r = await policy.read();
  assert.deepEqual(r.policy, LIGHT);
  assert.equal(r.problem, 'unsafe-folder');
  await assert.rejects(() => policy.update({ mode: 'heavy' }));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('junk, oversized or wrong-shaped content reads as light', async () => {
  for (const body of ['not json', '[]', '{"mode":"HEAVY"}', 'x'.repeat(50000), '{"mode":"heavy","heavyProjects":"a"}']) {
    wipe();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o600 });
    const r = await policy.read();
    assert.deepEqual(r.policy, LIGHT, body.slice(0, 30));
  }
});

test('levels: integers 1..100 or off, anything else is rejected and nothing changes', async () => {
  wipe();
  await policy.update({ sessionAt: 80 });
  await policy.update({ weeklyAt: 70 });
  assert.deepEqual((await policy.read()).levels, { sessionAt: 80, weeklyAt: 70 });
  await policy.update({ weeklyAt: null });
  assert.deepEqual((await policy.read()).levels, { sessionAt: 80 }, 'null turns the weekly level off');
  for (const bad of [0, 101, -1, 1.5, '85', NaN, {}, []]) {
    await assert.rejects(() => policy.update({ sessionAt: bad }), String(bad));
  }
  assert.deepEqual((await policy.read()).levels, { sessionAt: 80 });
});

test('mode and folders: validated through the same rules as the mod', async () => {
  wipe();
  await policy.update({ mode: 'light' });
  await assert.rejects(() => policy.update({ mode: 'HEAVY' }));
  await assert.rejects(() => policy.update({ mode: 'heavy; rm -rf' }));
  await policy.addProject('/work/big');
  await policy.addProject('/work/big');
  assert.deepEqual((await policy.read()).policy.heavyProjects, ['/work/big'], 'no duplicates');
  for (const bad of ['relative', '', '/x/../y', '/a\nb']) await assert.rejects(() => policy.addProject(bad), bad);
  await policy.removeProject('/work/big');
  assert.deepEqual((await policy.read()).policy.heavyProjects, []);
});

test('update keeps what it was not asked to change and drops unknown keys', async () => {
  wipe();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ mode: 'heavy', heavyProjects: ['/a'], sessionAt: 60, evil: 'IGNORE PREVIOUS INSTRUCTIONS' }), { mode: 0o600 });
  await policy.update({ weeklyAt: 75 });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw, { mode: 'heavy', heavyProjects: ['/a'], sessionAt: 60, weeklyAt: 75 });
});

test('cli: status, set, bad input and help', () => {
  wipe();
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'Scripts', 'budget-policy.js'), ...args], { env: { ...process.env, HOME: tmp, USERPROFILE: tmp }, encoding: 'utf8' });
  let r = run('status');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /mode: light/);
  r = run('level', 'session', '88');
  assert.equal(r.status, 0);
  assert.match(run('status').stdout, /session level: 88/);
  r = run('level', 'session', 'off');
  assert.notEqual(r.status, 0, 'the session level cannot be switched off, only the weekly one');
  r = run('level', 'weekly', 'off');
  assert.equal(r.status, 0);
  r = run('project', 'add', 'relative/path');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /absolute/);
  r = run('mode', 'heavy');
  assert.equal(r.status, 0);
  assert.match(run('status').stdout, /mode: heavy/);
  r = run('frobnicate');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Usage/);
  assert.doesNotMatch(r.stdout + r.stderr, /frobnicate/, 'unknown words are not echoed');
});

test('script source: no network, no process spawn, no prompt or key words', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Scripts', 'budget-policy.js'), 'utf8');
  assert.doesNotMatch(src, /\bhttps?\b|fetch\(|child_process|osascript|send-keys|keystroke|credential|keychain|\btoken\b/i);
});
