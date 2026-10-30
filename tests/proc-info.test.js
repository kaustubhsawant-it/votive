'use strict';
//
// Process ancestry lookup shared by the event hook and the notify CLI. Same assertions on macOS
// and Windows; only the way the table is read differs.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const info = require('../Scripts/proc-info');

test('ancestry: starts at the pid asked for and reports its parent and a clean name', () => {
  const chain = info.ancestry(process.pid, 1);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].pid, process.pid);
  assert.equal(chain[0].ppid, process.ppid);
  assert.match(chain[0].name, /^node/i);
  assert.doesNotMatch(chain[0].name, /\.exe$/i, 'no extension');
  assert.doesNotMatch(chain[0].name, /[\\/]/, 'no path');
});

test('ancestry: walks upward and stops at the end of the chain', () => {
  const chain = info.ancestry(process.pid, 6);
  assert.ok(chain.length >= 2, 'at least this process and its parent');
  for (let i = 1; i < chain.length; i++) assert.equal(chain[i].pid, chain[i - 1].ppid, 'each hop is the previous parent');
  assert.ok(chain.length <= 6);
});

test('ancestry: unknown, hostile or malformed pids give an empty chain without throwing', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '123', '1; whoami', null, undefined, {}, [], 2 ** 40, 4294967295]) {
    assert.deepEqual(info.ancestry(bad, 3), [], String(bad));
  }
  assert.deepEqual(info.ancestry(2147483000, 3), [], 'a pid that does not exist');
});

test('parentPid: returns the parent, or null when there is none to find', () => {
  assert.equal(info.parentPid(process.pid), process.ppid);
  assert.equal(info.parentPid(2147483000), null);
  assert.equal(info.parentPid('x'), null);
});

test('the lookup never builds a shell command from input', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Scripts', 'proc-info.js'), 'utf8');
  assert.doesNotMatch(src, /shell:\s*true|(?<![.\w])exec\(|execSync\(/, 'only execFileSync with an argument list');
  assert.doesNotMatch(src, /\bhttps?\b|fetch\(/);
});

test('isAlive: true for a running process, false for a missing or invalid pid', () => {
  assert.equal(info.isAlive(process.pid), true);
  assert.equal(info.isAlive(process.ppid), true);
  assert.equal(info.isAlive(2147483000), false);
  for (const bad of [0, -1, 1.5, NaN, '12', null, undefined, {}]) assert.equal(info.isAlive(bad), false, String(bad));
});
