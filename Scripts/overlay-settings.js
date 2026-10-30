#!/usr/bin/env node
'use strict';
//
// Read and change Votive's preferences without opening the menu. Used by the MCP
// server's `settings` tool, and usable from a terminal:
//
//   node overlay-settings.js                       print every setting as JSON
//   node overlay-settings.js popupOnEveryChange=false stuckThresholdMinutes=15
//
// Preferences live in the app's macOS defaults domain; the running app watches them and
// applies a change immediately. Elsewhere (Windows) the same keys live in
// ~/.votive/settings.json, written atomically, for the app to watch. Only the settings
// listed below can be written.
//
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { root, writeJsonAtomic } = require('./overlay-paths');

// Tests point this at a throwaway domain: `defaults` ignores HOME, so a test would
// otherwise change the real preferences.
const DOMAIN = process.env.VOTIVE_DEFAULTS_DOMAIN || 'dev.votive.Votive';

const SETTINGS = {
  colorblindShapes: {
    key: 'shapesMode', type: 'bool', default: false,
    description: 'Give every state its own shape in the menu bar, not only its own colour.',
  },
  usagePulse: {
    key: 'usageAlertOn', type: 'bool', default: true,
    description: 'While any plan limit is over 70%, pulse the menu-bar icon red and show which limit and how full (e.g. Weekly 74%).',
  },
  notifyOnRequest: {
    key: 'customNotifyOn', type: 'bool', default: true,
    description: 'Show a panel when a session was asked to let you know (the notify tool or /notify).',
  },
  bannerOnEveryChange: {
    key: 'notificationsOn', type: 'bool', default: false,
    description: 'Notification Center banner whenever any session finishes, needs you, errors or stops.',
  },
  popupOnEveryChange: {
    key: 'dialogAlertsOn', type: 'bool', default: false,
    description: 'Floating panel whenever any session finishes, needs you, errors or stops.',
  },
  stuckThresholdMinutes: {
    key: 'stuckThresholdMinutes', type: 'int', default: 8, min: 0, max: 240,
    description: 'Minutes without activity before a busy session shows as stuck (0 turns it off).',
  },
  sounds: {
    key: 'soundsOn', type: 'bool', default: true,
    description: 'Master switch for every sound below. Sounds play even when banners and pop-ups are off.',
  },
};

// One sound per event, mirroring SoundEvent in Votive/Services/Sounds.swift.
// A value is "none", a macOS system sound, or a file name in ~/.votive/sounds/.
const SYSTEM_SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
  'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'];
const AUDIO_EXT = /\.(mp3|m4a|aiff?|wav|caf)$/i;
const SOUNDS_DIR = path.join(root, 'sounds');
const SOUND_EVENTS = [
  ['soundNotify', 'Notify', 'Glass', 'a session you asked to let you know sends its alert'],
  ['soundNeedsYou', 'NeedsYou', 'none', 'a session needs you (permission or input)'],
  ['soundError', 'Error', 'none', 'a session hits an error'],
  ['soundStuck', 'Stuck', 'none', 'a session seems stuck'],
  ['soundStopped', 'Stopped', 'none', 'a session stops'],
  ['soundDone', 'Done', 'none', 'a session finishes its turn'],
];
for (const [name, suffix, def, when] of SOUND_EVENTS) {
  SETTINGS[name] = {
    key: 'sound' + suffix, type: 'sound', default: def,
    description: 'Sound when ' + when + ': "none", a macOS sound (' + SYSTEM_SOUNDS.join(', ') +
      '), or a file name in ~/.votive/sounds/.',
  };
}

/** Audio files in ~/.votive/sounds/. */
function customSounds() {
  try { return fs.readdirSync(SOUNDS_DIR).filter((f) => AUDIO_EXT.test(f)).sort(); } catch (e) { return []; }
}

function defaults(args) {
  return execFileSync('/usr/bin/defaults', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// macOS keeps preferences in a defaults domain; every other platform in one small JSON file.
// (VOTIVE_SETTINGS_BACKEND=file lets the tests exercise the file store on a Mac.)
const USE_DEFAULTS = process.platform === 'darwin' && process.env.VOTIVE_SETTINGS_BACKEND !== 'file';
const settingsFile = () => path.join(root, 'settings.json');
function readStore() {
  try {
    const o = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

function readOne(spec) {
  if (!USE_DEFAULTS) {
    const v = readStore()[spec.key];
    if (spec.type === 'bool') return typeof v === 'boolean' ? v : spec.default;
    if (spec.type === 'sound') return typeof v === 'string' ? v : spec.default;
    return Number.isInteger(v) ? v : spec.default;
  }
  let raw;
  try { raw = defaults(['read', DOMAIN, spec.key]); } catch (e) { return spec.default; }   // not set yet
  if (spec.type === 'bool') return raw === '1' || raw.toLowerCase() === 'true';
  if (spec.type === 'sound') return raw;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : spec.default;
}

function writeOne(spec, value) {
  if (!USE_DEFAULTS) {
    const store = readStore();
    store[spec.key] = value;
    writeJsonAtomic(settingsFile(), store);
    return;
  }
  const flag = { bool: '-bool', int: '-int', sound: '-string' }[spec.type];
  defaults(['write', DOMAIN, spec.key, flag, String(value)]);
}

/**
 * A switch that only the USER flips (the app's menu writes it): read it here, never write it.
 * It is deliberately not in SETTINGS, so no tool or command can change it. Anything that is not
 * exactly "on" reads as off.
 */
function readUserFlag(key) {
  if (!USE_DEFAULTS) return readStore()[key] === true;
  try { const raw = defaults(['read', DOMAIN, key]); return raw === '1' || raw.toLowerCase() === 'true'; } catch (e) { return false; }
}

/** Every setting: { name: { value, default, description } }. */
function getSettings() {
  const out = {};
  for (const [name, spec] of Object.entries(SETTINGS)) {
    out[name] = { value: readOne(spec), default: spec.default, description: spec.description };
  }
  return out;
}

/** Validate a single change. Returns the normalized value or throws with a readable message. */
function validate(name, value) {
  const spec = SETTINGS[name];
  if (!spec) throw new Error('Unknown setting "' + name + '". Known: ' + Object.keys(SETTINGS).join(', ') + '.');
  if (spec.type === 'bool') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'on' || value === 'yes') return true;
    if (value === 'false' || value === 'off' || value === 'no') return false;
    throw new Error(name + ' must be true or false.');
  }
  if (spec.type === 'sound') {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v.toLowerCase() === 'none') return 'none';
    const system = SYSTEM_SOUNDS.find((s) => s.toLowerCase() === v.toLowerCase());
    if (system) return system;
    if (v && !v.includes('/') && AUDIO_EXT.test(v) && customSounds().includes(v)) return v;
    const custom = customSounds();
    throw new Error(name + ' must be "none", one of ' + SYSTEM_SOUNDS.join(', ') +
      (custom.length ? ', or one of your sounds: ' + custom.join(', ') : '') +
      '. To use your own file, copy it into ' + SOUNDS_DIR + ' first.');
  }
  // Only a real number, or a string of digits (from the command line). Not null, "", true, …
  const n = typeof value === 'number' ? value
    : (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) ? parseInt(value, 10) : NaN;
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
    throw new Error(name + ' must be a whole number from ' + spec.min + ' to ' + spec.max + '.');
  }
  return n;
}

/**
 * Apply several changes. All are validated first, so an invalid one changes nothing.
 * Returns { changed: {name: {from, to}}, unchanged: [names], settings }.
 */
function updateSettings(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Pass an object of settings to change.');
  const names = Object.keys(changes);
  if (!names.length) throw new Error('Nothing to change. Known settings: ' + Object.keys(SETTINGS).join(', ') + '.');
  const normalized = {};
  for (const name of names) normalized[name] = validate(name, changes[name]);
  const changed = {};
  const unchanged = [];
  for (const [name, value] of Object.entries(normalized)) {
    const spec = SETTINGS[name];
    const from = readOne(spec);
    if (from === value) { unchanged.push(name); continue; }
    writeOne(spec, value);
    changed[name] = { from, to: value };
  }
  return { changed, unchanged, settings: getSettings() };
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (!args.length) { console.log(JSON.stringify(getSettings(), null, 2)); return; }
    const changes = {};
    for (const a of args) {
      const m = /^([A-Za-z]+)=(.*)$/.exec(a);
      if (!m) throw new Error('Use name=value, e.g. popupOnEveryChange=false');
      changes[m[1]] = m[2];
    }
    const { changed, unchanged } = updateSettings(changes);
    for (const [n, c] of Object.entries(changed)) console.log(n + ': ' + c.from + ' → ' + c.to);
    for (const n of unchanged) console.log(n + ': already ' + changes[n]);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { DOMAIN, SETTINGS, SYSTEM_SOUNDS, SOUNDS_DIR, getSettings, updateSettings, validate, readUserFlag };
