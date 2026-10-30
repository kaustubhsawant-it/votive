'use strict';
//
// AGEN-45 TDD 34: the budget mod may call only the allow-listed Claude Code APIs. The list comes
// from `claude plugin validate --json`, which statically reads the mod source. Skipped when the
// claude binary is not installed (CI without it).
//
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = path.join(__dirname, '..', 'mods', 'votive-budget');
const ALLOWED = ['command.register', 'env.get', 'fs.read', 'fs.write', 'session.cwd', 'session.usage', 'ui.status', 'ui.toast'];
const hasClaude = spawnSync('claude', ['--version']).status === 0;

function callsOf(dir) {
  const r = spawnSync('claude', ['plugin', 'validate', dir, '--json'], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  const calls = new Set();
  for (const c of out.contents || []) for (const n of c.notes || []) {
    const m = /calls: (.*)$/.exec(n);
    if (m) for (const part of m[1].replace(/ \(via [^)]*\)/g, '').split(', ')) calls.add(part.replace(/^\$\./, ''));
  }
  return { ok: out.success === true, calls: [...calls].sort() };
}

test('mod: validates and declares only allow-listed calls', { skip: !hasClaude }, () => {
  const { ok, calls } = callsOf(MOD);
  assert.equal(ok, true, 'plugin validate passes');
  const extra = calls.filter((c) => !ALLOWED.includes(c));
  assert.deepEqual(extra, [], 'calls outside the allow-list');
  assert.ok(calls.length > 0, 'calls were read');
});

test('mod: adding a forbidden call to the source is detected', { skip: !hasClaude }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mod-'));
  fs.cpSync(MOD, tmp, { recursive: true });
  for (const call of ['$.session.send("x")', '$.http.fetch("https://example.com")', '$.process.run("ls")', '$.env.set("A", "b")', '$.store.get("k")']) {
    const f = path.join(tmp, 'hooks', 'register.js');
    const base = fs.readFileSync(path.join(MOD, 'hooks', 'register.js'), 'utf8');
    fs.writeFileSync(f, base.replace("on('session.start', async ($, e, next) => {", `on('session.start', async ($, e, next) => {\n    try { await ${call}; } catch {}`));
    const { calls } = callsOf(tmp);
    assert.ok(calls.filter((c) => !ALLOWED.includes(c)).length > 0, `${call} must show up outside the allow-list (got ${calls.join(', ')})`);
  }
  fs.rmSync(tmp, { recursive: true });
});

test('mod: source holds no network, process or prompt-sending words', () => {
  const src = fs.readFileSync(path.join(MOD, 'hooks', 'register.js'), 'utf8') + fs.readFileSync(path.join(MOD, 'hooks', 'budget-core.mjs'), 'utf8');
  assert.doesNotMatch(src, /\$\.(http|process|model|mcp|store)\b|\$\.session\.(send|append)|\$\.prompt\.submit|\$\.env\.set|\bfetch\s*\(|child_process|setInterval|setTimeout|\$\.clock/);
});
