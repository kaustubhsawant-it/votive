'use strict';
//
// Guards the animations: Timer.scheduledTimer fires only in the default run-loop mode, and an
// open menu runs the main loop in event-tracking mode, so a timer made that way freezes while
// the menu is open (the Caffeinate comet, the pulse, the usage carousel). UI code must use
// Timer.commonModeTimer instead.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function files(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel, ext));
    else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}
// Comments may legitimately mention these words; only code counts.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('UI code never uses Timer.scheduledTimer, which stops while a menu is open', () => {
  const hits = [];
  for (const f of files('Votive/UI', '.swift')) {
    const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (/\bTimer\.scheduledTimer\s*\(/.test(src)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});

test('commonModeTimer adds its timer to the common run-loop modes', () => {
  const src = code(fs.readFileSync(path.join(ROOT, 'Votive/UI/StatusItemController.swift'), 'utf8'));
  assert.match(src, /static func commonModeTimer[\s\S]*?RunLoop\.main\.add\(timer, forMode: \.common\)/);
});
