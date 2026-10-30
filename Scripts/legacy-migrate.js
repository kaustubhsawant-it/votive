#!/usr/bin/env node
'use strict';
//
// One-time move from the product's earlier name, Agent Overlay, to Votive. Safe to re-run; run by
// install.sh before the scripts are copied.
//
//   ~/.agent-overlay            -> ~/.votive (the folder is moved, never copied or deleted), and
//                                  ~/.agent-overlay is left behind as a link to it, so hooks of
//                                  agent sessions that are already running keep finding their
//                                  scripts (see Scripts/legacy/) until those sessions restart.
//   Copilot and OpenCode files  -> the two whole-file adapters that carried the old name are
//                                  removed (only when they are ours); install-agents.js writes
//                                  the new ones.
//
// Hook entries inside other agents' settings files are NOT touched here: install-agents.js
// recognises the old script names and replaces those entries with the new command.
// No credential is read: only folders and the two adapter files named above.
//
//   node legacy-migrate.js [--dry-run]
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const OLD_ROOT_NAME = '.agent-overlay';
const NEW_ROOT_NAME = '.votive';
// Whole-file adapters named after the old product, with the text that proves a file is ours.
const OLD_ADAPTERS = [
  { file: path.join('.copilot', 'hooks', 'agent-overlay.json'), mark: 'agent-overlay-event.js' },
  { file: path.join('.config', 'opencode', 'plugins', 'agent-overlay.js'), mark: 'agent-overlay-event.js' },
];

function lstat(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }

/** Moves every entry of `from` that `to` lacks into `to`; returns the names left behind. */
function mergeInto(from, to, log, dry) {
  const left = [];
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (!lstat(dst)) {
      if (!dry) fs.renameSync(src, dst);
      log.push('moved ' + name);
    } else if (lstat(src).isDirectory() && lstat(dst).isDirectory()) {
      const rest = mergeInto(src, dst, log, dry);
      if (rest.length) left.push(name);
    } else {
      left.push(name);
    }
  }
  return left;
}

/**
 * @param {string} home  the home directory (tests pass a throwaway one)
 * @param {{dryRun?: boolean}} [opts]
 * @returns {string[]} what was (or would be) done, one line each
 */
function migrate(home, opts) {
  const dry = !!(opts && opts.dryRun);
  const log = [];
  const oldRoot = path.join(home, OLD_ROOT_NAME);
  const newRoot = path.join(home, NEW_ROOT_NAME);

  const oldStat = lstat(oldRoot);
  if (oldStat && oldStat.isDirectory()) {            // a real folder, not our link
    if (!lstat(newRoot)) {
      if (!dry) fs.renameSync(oldRoot, newRoot);
      log.push('moved ~/' + OLD_ROOT_NAME + ' to ~/' + NEW_ROOT_NAME);
    } else {
      // Both exist (the new app ran first, or a half-finished earlier attempt): bring over what
      // the new folder lacks, park the rest next to it instead of deleting anything.
      const left = mergeInto(oldRoot, newRoot, log, dry);
      if (left.length) {
        const parked = path.join(newRoot, 'from-agent-overlay');
        if (!dry) {
          fs.mkdirSync(parked, { recursive: true, mode: 0o700 });
          for (const name of left) {
            let target = path.join(parked, name);
            if (lstat(target)) target += '.' + Date.now();
            fs.renameSync(path.join(oldRoot, name), target);
          }
        }
        log.push('kept ' + left.length + ' older item(s) in ~/' + NEW_ROOT_NAME + '/from-agent-overlay');
      }
      if (!dry) fs.rmSync(oldRoot, { recursive: true, force: true });
    }
    if (!dry) {
      try { fs.chmodSync(newRoot, 0o700); } catch (e) {}
      try {
        // Relative on macOS, so it survives a renamed home; a junction on Windows (needs no admin).
        if (process.platform === 'win32') fs.symlinkSync(newRoot, oldRoot, 'junction');
        else fs.symlinkSync(NEW_ROOT_NAME, oldRoot);
        log.push('left ~/' + OLD_ROOT_NAME + ' as a link to ~/' + NEW_ROOT_NAME + ' for running sessions');
      } catch (e) {
        log.push('could not leave a link at ~/' + OLD_ROOT_NAME + ' (' + e.code + '); restart open agent sessions so they pick up the new hooks');
      }
    } else {
      log.push('leave ~/' + OLD_ROOT_NAME + ' as a link to ~/' + NEW_ROOT_NAME + ' for running sessions');
    }
  }

  for (const a of OLD_ADAPTERS) {
    const file = path.join(home, a.file);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {}
    if (text !== null && text.indexOf(a.mark) !== -1) {
      if (!dry) fs.unlinkSync(file);
      log.push('removed the old adapter ~/' + a.file);
    }
  }
  return log;
}

module.exports = { migrate, OLD_ROOT_NAME, NEW_ROOT_NAME, OLD_ADAPTERS };

if (require.main === module) {
  const dry = process.argv.includes('--dry-run');
  const lines = migrate(os.homedir(), { dryRun: dry });
  if (!lines.length) console.log('Nothing to move from the Agent Overlay name.');
  else for (const l of lines) console.log((dry ? 'would: ' : '') + l);
}
