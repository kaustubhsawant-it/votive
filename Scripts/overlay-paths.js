'use strict';
//
// Where Votive keeps its own state, shared by every script. Agent-neutral on purpose:
// ~/.votive/{events,usage}/ — never inside one agent's config directory.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.join(os.homedir(), '.votive');
const eventsDir = path.join(root, 'events');
const usageDir = path.join(root, 'usage');

/**
 * Filesystem-safe piece of a file name, one-to-one: ids made only of a-z 0-9 _ . - (UUIDs, pids)
 * pass through unchanged; any other id (a slash, a capital letter, a long id) becomes a readable
 * prefix plus a hash of the exact original, so `a/b` and `a_b`, or `ABC` and `abc` on a
 * case-insensitive volume, never share a file.
 */
function safe(s) {
  const raw = String(s);
  if (/^[a-z0-9_.-]{1,100}$/.test(raw) && !/^\.+$/.test(raw)) return raw;
  const prefix = raw.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 60) || '_';
  return prefix + '~' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Text from an untrusted payload that will be stored or shown: control, bidi and invisible characters become spaces, cut to `max` code points. */
function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

function eventFile(agent, sessionId) {
  return path.join(eventsDir, safe(agent) + '--' + safe(sessionId) + '.json');
}

/** Write JSON atomically (temp + rename) so the app's watcher never sees half a file. */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

module.exports = { root, eventsDir, usageDir, safe, clip, eventFile, writeJsonAtomic, readJson };
