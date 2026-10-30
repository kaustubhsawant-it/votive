'use strict';
//
// Shared by Scripts/votive-notify.js (CLI, installed to ~/.votive/bin/ next to
// this file) and mcp-server/index.js (the MCP tool, the preferred path). Keep this the ONLY
// place that knows how to find the calling agent session and write a notify entry -- both
// callers just supply a message and a starting pid.
//
const fs = require('fs');
const os = require('os');
const path = require('path');


const P = require('./overlay-paths');
// Claude Code's own live registry (pid → session). Other agents are found through the pid
// that votive-event.js records in each event file.
const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');

const { parentPid } = require('./proc-info');

// pid → {agent, sessionId} for every event file that recorded a host pid, newest event wins.
function eventSessionsByPid() {
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(P.eventsDir); } catch (e) { return map; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = P.readJson(path.join(P.eventsDir, n));
    if (!rec || typeof rec.pid !== 'number' || typeof rec.sessionId !== 'string') continue;
    const prev = map.get(rec.pid);
    if (!prev || (rec.lastEventAt || 0) > prev.at) {
      map.set(rec.pid, { agent: rec.agent || 'claude-code', sessionId: rec.sessionId, at: rec.lastEventAt || 0 });
    }
  }
  return map;
}

// Walks the process ancestry from `startPid` until a pid is a known agent session: Claude
// Code's registry first, then any agent's event file. For the MCP server `startPid` is
// process.ppid (the agent spawns MCP servers as direct children), so this usually matches on
// hop 0; the extra hops cover agents that proxy through an intermediary process.
function findOwningSession(startPid) {
  const byPid = eventSessionsByPid();
  let pid = startPid;
  for (let hop = 0; hop < 12; hop++) {
    const candidate = path.join(sessionsDir, pid + '.json');
    if (fs.existsSync(candidate)) {
      try {
        const reg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (reg && typeof reg.sessionId === 'string' && reg.sessionId) {
          return { agent: 'claude-code', sessionId: reg.sessionId };
        }
      } catch (e) { /* half-written or unreadable -- keep walking */ }
    }
    const hit = byPid.get(pid);
    if (hit) return { agent: hit.agent, sessionId: hit.sessionId };
    const next = parentPid(pid);
    if (!next) break;
    pid = next;
  }
  return null;
}

// Writes a notify entry for the owning session found from `startPid`. Read-merge-write:
// preserves whatever the lifecycle hook already recorded (lastEvent, lastEventAt, cwd, pid)
// and only adds/replaces notifyMessage/notifyAt, so this can never clobber real state.
// Returns {ok:true, sessionId} or {ok:false, error}.
function writeNotify(message, startPid) {
  if (typeof message !== 'string') return { ok: false, error: 'message must be a string' };
  const trimmed = P.clip(message, 1000);   // one line of plain text: no control, escape or bidi characters
  if (!trimmed) return { ok: false, error: 'message is empty' };
  // Clip by code point, not UTF-16 unit: slicing through a surrogate pair writes invalid
  // JSON text for the app's decoder and would hide the session's whole overlay state.
  const chars = Array.from(trimmed);
  const clipped = chars.length > 500 ? chars.slice(0, 500).join('') + '…' : trimmed;

  const owner = findOwningSession(startPid);
  if (!owner) {
    return {
      ok: false,
      error: 'could not find the agent session this was called from -- is Votive ' +
        'installed for this agent, and has the session reported at least one event?',
    };
  }
  const sessionId = owner.sessionId;
  const file = P.eventFile(owner.agent, sessionId);

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { existing = {}; }

  // The app needs lastEvent/lastEventAt to decode the file. When the lifecycle hook hasn't
  // written one yet, lastEventAt 0 keeps this from overriding the registry's real state.
  const rec = Object.assign({ lastEvent: 'working', lastEventAt: 0 }, existing, {
    agent: owner.agent,
    sessionId: sessionId,
    notifyMessage: clipped,
    notifyAt: Date.now(),
  });

  try { P.writeJsonAtomic(file, rec); }
  catch (e) { return { ok: false, error: 'could not write the event file: ' + e.message }; }

  return { ok: true, sessionId: sessionId };
}

module.exports = { writeNotify, findOwningSession };
