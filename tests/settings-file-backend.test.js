'use strict';
//
// The settings store used where macOS `defaults` does not exist (Windows): one JSON file under
// ~/.votive. Runs on every platform by forcing the file backend, in a scratch home.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-settings-'));
const file = path.join(tmp, '.votive', 'settings.json');
const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'Scripts', 'overlay-settings.js'), ...args],
  { encoding: 'utf8', env: { ...process.env, HOME: tmp, USERPROFILE: tmp, VOTIVE_SETTINGS_BACKEND: 'file' } });

test('file backend: defaults first, then a change is stored and read back with its type', () => {
  fs.rmSync(path.join(tmp, '.votive'), { recursive: true, force: true });
  const before = JSON.parse(run().stdout);
  assert.equal(before.colorblindShapes.value, false);
  const r = run('colorblindShapes=true', 'stuckThresholdMinutes=15');
  assert.equal(r.status, 0, r.stderr);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.shapesMode, true, 'a real boolean, not a string');
  assert.strictEqual(stored.stuckThresholdMinutes, 15, 'a real number, not a string');
  const after = JSON.parse(run().stdout);
  assert.equal(after.colorblindShapes.value, true);
  assert.equal(after.stuckThresholdMinutes.value, 15);
});

test('file backend: invalid values change nothing, unknown names are refused', () => {
  const before = fs.readFileSync(file, 'utf8');
  for (const bad of ['stuckThresholdMinutes=241', 'stuckThresholdMinutes=-1', 'stuckThresholdMinutes=abc', 'colorblindShapes=maybe', 'nonsense=1']) {
    const r = run(bad);
    assert.notEqual(r.status, 0, bad);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('file backend: a corrupt or wrong-typed file reads as defaults and is repaired by the next write', () => {
  fs.writeFileSync(file, '{"shapesMode":"yes","stuckThresholdMinutes":"7"}');
  const s = JSON.parse(run().stdout);
  assert.equal(s.colorblindShapes.value, false, 'a string is not a boolean');
  fs.writeFileSync(file, 'not json at all');
  assert.equal(JSON.parse(run().stdout).colorblindShapes.value, false);
  assert.equal(run('colorblindShapes=true').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).shapesMode, true);
});

test('file backend: other keys already in the file are kept', () => {
  fs.writeFileSync(file, JSON.stringify({ somethingElse: 1, shapesMode: false }));
  assert.equal(run('colorblindShapes=true').status, 0);
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(o.somethingElse, 1);
  assert.equal(o.shapesMode, true);
});
