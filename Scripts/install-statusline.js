#!/usr/bin/env node
'use strict';
//
// Idempotently points ~/.claude/settings.json's statusLine at votive-statusline.js,
// saving the previous statusLine to ~/.votive/usage/wrapped.json so the wrapper
// keeps running it (your visible status line does not change).
//
//   node install-statusline.js            install (backs up settings.json first)
//   node install-statusline.js --remove   restore the original statusLine exactly
//
// Only a statusLine of the form {"type":"command","command":"..."} (or none at all) is
// wrapped; any other shape is left alone rather than guessed at.
//
const fs = require('fs');
const path = require('path');
const { load, save, shellQuote, DRY_RUN } = require('./settings-io');
const P = require('./overlay-paths');

const scriptPath = path.join(P.root, 'bin', 'votive-statusline.js');
const dir = P.usageDir;
const wrappedPath = path.join(dir, 'wrapped.json');
const ourCmd = 'node ' + shellQuote(scriptPath);
const remove = process.argv.includes('--remove');

const { raw, cfg } = load();
const sl = cfg.statusLine;
const isOurs = sl && typeof sl === 'object' && typeof sl.command === 'string'
  && (sl.command.indexOf('votive-statusline.js') !== -1
    || sl.command.indexOf('agent-overlay-statusline.js') !== -1);   // the name before Votive

if (remove) {
  if (!isOurs) { console.log('statusLine is not the Votive wrapper; nothing to restore.'); process.exit(0); }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(wrappedPath, 'utf8')); }
  catch (e) {
    console.error('Cannot read ' + wrappedPath + ' to restore your original statusLine. ' +
      'Leaving settings.json unchanged; restore statusLine from a settings.json.bak-* file.');
    process.exit(1);
  }
  // wrapped.json v2 stores the whole object ({previous}); v1 stored only {command}.
  const prev = 'previous' in saved ? saved.previous
    : (saved.command ? { type: 'command', command: saved.command } : null);
  if (prev) cfg.statusLine = prev; else delete cfg.statusLine;
  save(raw, cfg);
  console.log(prev ? 'Restored your original statusLine.' : 'Removed statusLine (there was none before).');
  process.exit(0);
}

if (isOurs) {
  if (sl.command === ourCmd) { console.log('Usage statusLine wrapper already installed.'); process.exit(0); }
  // Ours, but at an older install location: repoint it, keep wrapped.json as is.
  cfg.statusLine = Object.assign({}, sl, { command: ourCmd });
  save(raw, cfg);
  console.log('Usage statusLine wrapper moved to ' + scriptPath + '.');
  process.exit(0);
}

const wrappable = sl === undefined || sl === null
  || (typeof sl === 'object' && !Array.isArray(sl) && typeof sl.command === 'string'
      && (sl.type === undefined || sl.type === 'command'));
if (!wrappable) {
  console.warn('Warning: statusLine in settings.json has an unexpected shape; not wrapping it. ' +
    'Plan usage will not appear in Votive.');
  process.exit(0);
}

if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!DRY_RUN) fs.writeFileSync(wrappedPath, JSON.stringify({
  version: 2,
  command: sl ? sl.command : null,   // what the wrapper runs
  previous: sl || null,              // what --remove restores
}, null, 2) + '\n');
cfg.statusLine = Object.assign({}, sl || {}, { type: 'command', command: ourCmd });
save(raw, cfg);
console.log('statusLine now records plan usage' + (sl ? ' and still runs your previous status line.' : '.'));
