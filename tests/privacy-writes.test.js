'use strict';
//
// PRIVACY.md lists everything Votive writes (AGEN-28). Anything the budget feature or the Windows app
// writes has to be named there, so adding a new place to write without telling the reader fails here.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const privacy = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('privacy: every place the budget feature and the Windows app write is listed', () => {
  for (const place of ['usage/history/claude-code.jsonl', 'budget/policy.json', 'budget/diag.json', 'settings.json', 'CurrentVersion\\Run']) {
    assert.ok(privacy.includes(place), 'PRIVACY.md does not mention ' + place);
  }
});

test('privacy: the sources really do write those places (so the list is not stale the other way)', () => {
  assert.match(src('Scripts/usage-history.js'), /history/);
  assert.match(src('Scripts/budget-policy.js'), /policy\.json/);
  assert.match(src('mods/votive-budget/hooks/register.js'), /diag\.json/);
  assert.match(src('windows/Votive.Win/Settings.cs'), /settings\.json/);
  assert.match(src('windows/Votive.Win/Alerts.cs'), /CurrentVersion\\Run/);
});

test('privacy: the budget mod writes only under ~/.votive (every fs.write target is in that folder)', () => {
  const reg = src('mods/votive-budget/hooks/register.js');
  const targets = [...reg.matchAll(/\$\.fs\.write\(\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(targets.length >= 2, 'the mod writes the policy and the diagnostics');
  for (const t of targets) assert.match(t, /^(file|path)$/, 'a write target is a variable, never a literal outside the folder: ' + t);
  assert.match(reg, /\.votive\/budget\//);
  assert.doesNotMatch(reg, /\.claude|\/etc\/|\.ssh|\.zshrc|\.bash/);
});

test('docs: BUDGET.md states what the mod never does and what is not yet proven', () => {
  const doc = src('docs/BUDGET.md');
  for (const must of ['never sends a prompt', 'never goes online', 'Not confirmed', 'Seen live', 'optional']) assert.ok(doc.includes(must), must);
});
