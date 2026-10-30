'use strict';
//
// statusline-extras.js: dropping items from the wrapped status line, and the cached Meristem
// segment (workspace detection, summarizing, refresh pacing, never blocking). Every test runs
// against a throwaway HOME.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers');
const { spawnSync } = require('child_process');

const S = path.join(__dirname, '..', 'Scripts');
const BIN_FILES = ['votive-event.js', 'agents.js', 'overlay-paths.js', 'progress.js', 'statusline-extras.js',
  'votive-statusline.js', 'votive-notify.js', 'notify-core.js', 'proc-info.js', 'limit-notify.js'];

function home() {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao extras ')));
  fs.mkdirSync(path.join(h, '.votive', 'bin'), { recursive: true });
  for (const f of BIN_FILES) fs.copyFileSync(path.join(S, f), path.join(h, '.votive', 'bin', f));
  return h;
}
// The module reads HOME at load time (overlay-paths), so load a fresh copy per HOME.
function load(h) {
  const prev = process.env.HOME, prevProfile = process.env.USERPROFILE;
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  try {
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(h, '.votive'))) delete require.cache[k];
    return require(path.join(h, '.votive', 'bin', 'statusline-extras.js'));
  } finally {
    process.env.HOME = prev;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  }
}
const bin = (h, f) => path.join(h, '.votive', 'bin', f);
const runSL = (h, input, args = [], env = {}) => spawnSync('node', [bin(h, 'votive-statusline.js'), ...args],
  { input, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, ...env } });
function wrapped(h, cfg) {
  const d = path.join(h, '.votive', 'usage');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'wrapped.json'), JSON.stringify(cfg));
}

// GSD's exact output with and without its update item (from gsd-statusline.js).
const GSD_TAIL = '\x1b[2mOpus 5.5\x1b[0m │ \x1b[1mFixing\x1b[0m │ \x1b[2mmeristem\x1b[0m \x1b[32m███░░░░░░░ 38%\x1b[0m';
const GSD_UPDATE = '\x1b[33m⬆ /gsd:update\x1b[0m │ ' + GSD_TAIL;

// ---------- drop

test('drop: removes the GSD update item and its separator, leaving the rest byte for byte', () => {
  const { dropItems } = load(home());
  assert.equal(dropItems(GSD_UPDATE, ['⬆ /gsd:update']), GSD_TAIL);
  assert.equal(dropItems(GSD_TAIL, ['⬆ /gsd:update']), GSD_TAIL, 'absent: unchanged');
});

test('drop: an item last or alone, several items, styles around neighbours kept', () => {
  const { dropItems } = load(home());
  assert.equal(dropItems('\x1b[2ma\x1b[0m │ \x1b[33mX\x1b[0m', ['X']), '\x1b[2ma\x1b[0m');
  assert.equal(dropItems('X', ['X']), '');
  assert.equal(dropItems('X │ a │ Y │ b', ['X', 'Y']), 'a │ b');
  assert.equal(dropItems('\x1b[2ma\x1b[0m\x1b[33mX\x1b[0m │ b', ['X']), '\x1b[2ma\x1b[0mb', 'a neighbour\'s reset is not eaten');
  assert.equal(dropItems('a.b │ c', ['.']), 'a.b │ c'.replace('.', ''), 'literal, not a regex');
  for (const bad of [undefined, null, 'X', [], [5, '', '  ']]) assert.equal(dropItems('X │ a', bad), 'X │ a');
});

test('wrapper: a drop list filters the wrapped output; no drop list streams it unchanged', () => {
  const h = home();
  const out = path.join(h, 'gsd.txt');
  fs.writeFileSync(out, GSD_UPDATE);
  wrapped(h, { command: helpers.cat(out), drop: ['⬆ /gsd:update'] });
  assert.equal(runSL(h, '{}').stdout, GSD_TAIL);
  wrapped(h, { command: helpers.cat(out) });
  assert.equal(runSL(h, '{}').stdout, GSD_UPDATE);
  wrapped(h, { command: helpers.say('⬆ /gsd:update'), drop: ['⬆ /gsd:update'] });
  assert.equal(runSL(h, '{}').stdout, '', 'everything dropped: nothing, no separator');
  wrapped(h, { command: 'exit 3', drop: ['x'] });
  assert.equal(runSL(h, '{}').status, 3, 'exit code still passes through');
});

// ---------- Meristem segment

test('workspace: nearest meristem.toml or .meristem/, never $HOME itself', () => {
  const h = home();
  const { findWorkspace } = load(h);
  const ws = path.join(h, 'code', 'repo');
  fs.mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(h, '.meristem'));                   // the global store
  assert.equal(findWorkspace(path.join(ws, 'src'), h), null);
  fs.writeFileSync(path.join(ws, 'meristem.toml'), '');
  assert.equal(findWorkspace(path.join(ws, 'src', 'deep'), h), ws);
  fs.mkdirSync(path.join(ws, 'src', '.meristem'));
  assert.equal(findWorkspace(path.join(ws, 'src', 'deep'), h), path.join(ws, 'src'));
  assert.equal(findWorkspace('relative/path', h), null);
  assert.equal(findWorkspace(undefined, h), null);
});

test('summarize: only "behind" and "to review", ≤ 20 columns, empty when nothing to act on', () => {
  const { summarize, MAX_COLS } = load(home());
  assert.equal(summarize('Meristem │ 🧠 1651 · ⏵Observe · ⚠ 70 stale · ✦ tick 12'), '', 'today\'s output: nothing actionable');
  assert.equal(summarize('Meristem │ 🧠 1651 · ⟳ 3 behind · ⏵Observe'), '⟳ 3 behind');
  assert.equal(summarize('\x1b[1mMeristem\x1b[0m │ 🧠 9 · 2 to review'), '2 to review');
  assert.equal(summarize('Meristem │ ⟳ 3 behind · 12 to review · ⚠ 70 stale'), '⟳3 · 12 to review');
  assert.equal(summarize('Meristem │ ⟳ 0 behind · 0 to review'), '');
  assert.ok([...summarize('Meristem │ ⟳ 123456 behind · 987654 to review')].length <= MAX_COLS);
  assert.equal(summarize(null), '');
});

test('segment: served from cache; refresh only when due, outside a workspace nothing at all', () => {
  const h = home();
  const X = load(h);
  const ws = path.join(h, 'repo');
  fs.mkdirSync(path.join(ws, '.meristem'), { recursive: true });
  const kicks = [];
  const kick = (root) => kicks.push(root);
  const now = 10 ** 12;
  assert.equal(X.meristemSegment(ws, { home: h, now, kick }), '', 'no cache yet');
  assert.deepEqual(kicks, [ws], 'first call starts a refresh');
  fs.mkdirSync(path.dirname(X.cacheFile(ws)), { recursive: true });
  fs.writeFileSync(X.cacheFile(ws), JSON.stringify({ at: now, text: '⟳ 3 behind' }));
  assert.equal(X.meristemSegment(ws, { home: h, now: now + 1000, kick }), '⟳ 3 behind');
  assert.equal(kicks.length, 1, 'fresh cache: no refresh');
  assert.equal(X.meristemSegment(ws, { home: h, now: now + X.REFRESH_MS + 1, kick }), '⟳ 3 behind', 'stale value still served');
  assert.equal(kicks.length, 2, 'and a refresh started');
  assert.equal(X.meristemSegment(ws, { home: h, now: now + 11 * 60 * 1000, kick }), '', 'too old to show');
  assert.equal(X.meristemSegment(path.join(h, 'elsewhere'), { home: h, now, kick }), '');
  assert.equal(kicks.length, 3);
});

test('refresh: prefers meristem-statusline, caches the summary, never hangs', { skip: process.platform === 'win32' && 'fakes are sh scripts; Meristem has no Windows build' }, () => {
  const h = home();
  const X = load(h);
  const ws = path.join(h, 'repo');
  fs.mkdirSync(path.join(ws, '.meristem'), { recursive: true });
  const fake = path.join(h, 'fakebin');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'meristem'), '#!/bin/sh\necho "Meristem │ ⟳ 9 behind"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'meristem-statusline'), '#!/bin/sh\necho "Meristem │ 4 to review"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: h, USERPROFILE: h, PATH: fake + ':/usr/bin:/bin' };
  spawnSync(process.execPath, [bin(h, 'statusline-extras.js'), '--refresh', ws], { env });
  assert.equal(JSON.parse(fs.readFileSync(X.cacheFile(ws))).text, '4 to review');
  fs.unlinkSync(path.join(fake, 'meristem-statusline'));
  spawnSync(process.execPath, [bin(h, 'statusline-extras.js'), '--refresh', ws], { env });
  assert.equal(JSON.parse(fs.readFileSync(X.cacheFile(ws))).text, '⟳ 9 behind', 'falls back to meristem statusline --compact');
  fs.writeFileSync(path.join(fake, 'meristem'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  spawnSync(process.execPath, [bin(h, 'statusline-extras.js'), '--refresh', ws], { env });
  assert.ok(Date.now() - t0 < 8000, 'hard timeout');
  assert.equal(JSON.parse(fs.readFileSync(X.cacheFile(ws))).text, '');
  assert.ok(!fs.existsSync(X.cacheFile(ws) + '.refreshing'), 'refresh flag cleared');
});

test('wrapper: Meristem segment sits between the task segment and the wrapped line, and never blocks', () => {
  const h = home();
  const X = load(h);
  const ws = path.join(h, 'repo');
  fs.mkdirSync(path.join(ws, '.meristem'), { recursive: true });
  fs.mkdirSync(path.dirname(X.cacheFile(ws)), { recursive: true });
  fs.writeFileSync(X.cacheFile(ws), JSON.stringify({ at: Date.now(), text: '⟳ 3 behind' }));
  const ev = path.join(h, '.votive', 'events');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'claude-code--m1.json'), JSON.stringify({ lastEvent: 'done', lastEventAt: Date.now() }));
  const out = path.join(h, 'gsd.txt');
  fs.writeFileSync(out, GSD_UPDATE);
  wrapped(h, { command: helpers.cat(out), drop: ['⬆ /gsd:update'] });
  // A meristem on PATH that would take 30 s: the status line must not wait for it.
  const fake = path.join(h, 'fakebin');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'meristem'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const input = JSON.stringify({ session_id: 'm1', workspace: { current_dir: ws } });
  const t0 = Date.now();
  const r = runSL(h, input, [], { NO_COLOR: '1', PATH: fake + ':' + process.env.PATH });
  assert.ok(Date.now() - t0 < 2000, 'no foreground wait');
  assert.equal(r.stdout, '✓ Done \x1b[2m│\x1b[0m ⟳ 3 behind \x1b[2m│\x1b[0m ' + GSD_TAIL);
  assert.equal(runSL(h, input, ['--no-meristem'], { NO_COLOR: '1' }).stdout, '✓ Done \x1b[2m│\x1b[0m ' + GSD_TAIL);
});
