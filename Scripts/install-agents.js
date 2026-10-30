#!/usr/bin/env node
'use strict';
//
// Wires the Votive event hook into every supported agent found on this Mac.
//
//   node install-agents.js                    wire every detected agent
//   node install-agents.js --only codex,cursor
//   node install-agents.js --remove           unwire every agent (only our entries)
//   node install-agents.js --list             show what is detected, change nothing
//
// Detection: the agent's config directory exists or its command is on PATH. Every edit is
// idempotent, backs the file up first (settings-io.js) and appends our own entries without
// touching anyone else's. Agents whose hook format can't be installed safely get printed
// instructions instead; docs/AGENTS.md covers them.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadFile, saveFile, shellQuote, SettingsError, DRY_RUN, lineDiff } = require('./settings-io');
const P = require('./overlay-paths');

const HOME = os.homedir();
const EVENT_SCRIPT = path.join(P.root, 'bin', 'votive-event.js');
// Hook scripts of earlier versions: Agent Overlay (the name before Votive) and the Claude-only script.
const LEGACY_MARKS = ['agent-overlay-event.js', 'agent-overlay-status.js'];
const MARKS = ['votive-event.js'].concat(LEGACY_MARKS);   // ours, current + legacy
const cmd = (agent, extra) => 'node ' + shellQuote(EVENT_SCRIPT) + ' --agent ' + agent + (extra || '');
const isOurs = (x) => MARKS.some((m) => JSON.stringify(x).indexOf(m) !== -1);
// True if `x` contains exactly this command (as JSON-encoded text).
const hasCommand = (x, command) => JSON.stringify(x).includes(JSON.stringify(command).slice(1, -1));

// style 'nested': {hooks: {Event: [{matcher?, hooks: [{type, command, ...}]}]}}  (Claude-style)
// style 'flat':   {version?, hooks: {event: [{command}]}}                         (Cursor-style)
// style 'file':   a whole file that belongs to us
const AGENTS = {
  'claude-code': {
    detect: ['.claude', 'claude'], style: 'nested', file: '.claude/settings.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PermissionRequest',
      'PostToolUseFailure', 'StopFailure', 'SessionEnd'],
    entry: () => ({ type: 'command', command: cmd('claude-code'), async: true, timeout: 5 }),
  },
  codex: {
    detect: ['.codex', 'codex'], style: 'nested', file: '.codex/hooks.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop',
      'Interrupt', 'SessionEnd'],
    entry: (ev) => ({ type: 'command', command: cmd('codex'), timeout: ev === 'Interrupt' || ev === 'SessionEnd' ? 3 : 5 }),   // Codex allows 1-3 s there
    note: 'Codex runs new hooks only after you trust them: open Codex and approve them in /hooks.',
  },
  gemini: {
    detect: ['.gemini', 'gemini'], style: 'nested', file: '.gemini/settings.json', matcher: '*',
    events: ['SessionStart', 'BeforeAgent', 'AfterTool', 'Notification', 'AfterAgent', 'SessionEnd'],
    entry: () => ({ name: 'votive', type: 'command', command: cmd('gemini'), timeout: 5000 }),
  },
  qwen: {
    detect: ['.qwen', 'qwen'], style: 'nested', file: '.qwen/settings.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
      'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'],
    entry: () => ({ type: 'command', command: cmd('qwen') }),
  },
  cursor: {
    detect: ['.cursor', 'cursor-agent'], style: 'flat', file: '.cursor/hooks.json', version: 1,
    events: ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'stop', 'sessionEnd'],
    entry: () => ({ command: cmd('cursor') }),
  },
  windsurf: {
    detect: ['.codeium/windsurf'], style: 'flat', file: '.codeium/windsurf/hooks.json',
    events: ['pre_user_prompt', 'post_read_code', 'post_write_code', 'post_run_command',
      'post_mcp_tool_use', 'post_cascade_response'],
    entry: () => ({ command: cmd('windsurf') }),
  },
  copilot: {
    // Copilot's payload has no event name, so each event gets its own command with --event.
    detect: ['.copilot', 'copilot'], style: 'file', file: '.copilot/hooks/votive.json',
    content: () => {
      const events = ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'postToolUseFailure',
        'permissionRequest', 'agentStop', 'errorOccurred', 'sessionEnd'];
      const hooks = {};
      for (const e of events) hooks[e] = [{ type: 'command', bash: cmd('copilot', ' --event ' + e), timeoutSec: 5 }];
      return JSON.stringify({ version: 1, hooks }, null, 2) + '\n';
    },
  },
  opencode: {
    detect: ['.config/opencode', 'opencode'], style: 'file', file: '.config/opencode/plugins/votive.js',
    content: () => fs.readFileSync(path.join(__dirname, 'integrations', 'opencode-plugin.js'), 'utf8')
      .split('__EVENT_SCRIPT__').join(EVENT_SCRIPT.replace(/\\/g, '\\\\').replace(/"/g, '\\"')),
  },
  // Documented, not auto-installed (format unconfirmed or not JSON) — see docs/AGENTS.md.
  goose: { detect: ['goose'], style: 'manual' },
  cline: { detect: ['.cline', 'Documents/Cline'], style: 'manual' },
  amp: { detect: ['.config/amp', 'amp'], style: 'manual' },
  aider: { detect: ['aider', '.aider.conf.yml'], style: 'manual' },
};

function onPath(bin) {
  try {
    // `where` is the Windows `command -v`; the name is always one of the fixed ones in the table above.
    if (process.platform === 'win32') execFileSync('where.exe', [bin], { stdio: 'ignore' });
    else execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin], { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

function detected(a) {
  return a.detect.some((d) => (d.includes('/') || d.startsWith('.') || d.includes('.'))
    ? fs.existsSync(path.join(HOME, d)) : onPath(d));
}

// ---------- per-style install / remove. Each returns a short status string.

function installNested(a) {
  const file = path.join(HOME, a.file);
  const { raw, cfg } = loadFile(file);
  if (cfg.hooks !== undefined && (typeof cfg.hooks !== 'object' || cfg.hooks === null || Array.isArray(cfg.hooks))) {
    throw new SettingsError('Refusing to edit ' + file + ': "hooks" is not an object.');
  }
  cfg.hooks = cfg.hooks || {};
  let changed = 0;
  // Drop entries from the old hook scripts (the Claude-only one and the Agent Overlay-named
  // one), on every event; the current ones are added back below. The Claude-only script was
  // wired to some events we no longer use, like Notification.
  for (const ev of Object.keys(cfg.hooks)) {
    const arr = cfg.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((g) => !LEGACY_MARKS.some((m) => JSON.stringify(g).includes(m)));
    if (kept.length === arr.length) continue;
    changed++;
    if (kept.length) cfg.hooks[ev] = kept; else delete cfg.hooks[ev];
  }
  for (const ev of a.events) {
    const arr = cfg.hooks[ev] === undefined ? (cfg.hooks[ev] = []) : cfg.hooks[ev];
    if (!Array.isArray(arr)) continue;   // unexpected shape: leave the user's value alone
    const entry = a.entry(ev);
    // Already exactly what we would write (same command, same options)? Leave it alone.
    if (arr.some((g) => (g.hooks || []).some((h) => JSON.stringify(h) === JSON.stringify(entry)))) continue;
    // An entry of ours with another command or options (old path, old timeout) is replaced, not kept.
    if (isOurs(arr)) cfg.hooks[ev] = arr.filter((g) => !isOurs(g));
    const group = { hooks: [entry] };
    if (a.matcher) group.matcher = a.matcher;
    cfg.hooks[ev].push(group);
    changed++;
  }
  if (!changed) return 'already wired';
  saveFile(file, raw, cfg);
  return DRY_RUN ? 'would wire' : 'wired (' + file + ')';
}

function installFlat(a) {
  const file = path.join(HOME, a.file);
  const { raw, cfg } = loadFile(file);
  if (cfg.hooks !== undefined && (typeof cfg.hooks !== 'object' || cfg.hooks === null || Array.isArray(cfg.hooks))) {
    throw new SettingsError('Refusing to edit ' + file + ': "hooks" is not an object.');
  }
  cfg.hooks = cfg.hooks || {};
  if (a.version && cfg.version === undefined) cfg.version = a.version;
  let changed = 0;
  for (const ev of a.events) {
    let arr = cfg.hooks[ev] === undefined ? (cfg.hooks[ev] = []) : cfg.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const entry = a.entry();
    if (hasCommand(arr, entry.command)) continue;
    if (isOurs(arr)) arr = cfg.hooks[ev] = arr.filter((g) => !isOurs(g));
    arr.push(entry);
    changed++;
  }
  if (!changed) return 'already wired';
  saveFile(file, raw, cfg);
  return DRY_RUN ? 'would wire' : 'wired (' + file + ')';
}

function installFile(a) {
  const file = path.join(HOME, a.file);
  const content = a.content();
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch (e) {}
  if (current === content) return 'already installed';
  if (DRY_RUN) { console.log('--- ' + file + (current === null ? ' (new file)' : '')); console.log(lineDiff(current || '', content)); return 'would install'; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return 'installed (' + file + ')';
}

function removeHooks(a) {
  const file = path.join(HOME, a.file);
  if (!fs.existsSync(file)) return 'nothing to remove';
  const { raw, cfg } = loadFile(file);
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return 'nothing to remove';
  let removed = 0;
  for (const ev of Object.keys(cfg.hooks)) {
    const arr = cfg.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((g) => !isOurs(g));
    if (kept.length === arr.length) continue;
    removed += arr.length - kept.length;
    if (kept.length) cfg.hooks[ev] = kept; else delete cfg.hooks[ev];
  }
  if (!removed) return 'nothing to remove';
  saveFile(file, raw, cfg);
  return 'removed ' + removed + ' entr' + (removed === 1 ? 'y' : 'ies');
}

function removeFile(a) {
  const file = path.join(HOME, a.file);
  if (DRY_RUN) return fs.existsSync(file) ? 'would remove ' + file : 'nothing to remove';
  try { fs.unlinkSync(file); return 'removed'; } catch (e) { return 'nothing to remove'; }
}

const INSTALL = { nested: installNested, flat: installFlat, file: installFile };
const REMOVE = { nested: removeHooks, flat: removeHooks, file: removeFile };

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const list = args.includes('--list');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx !== -1 ? (args[onlyIdx + 1] || '').split(',').filter(Boolean) : null;
  if (only) {
    const unknown = only.filter((id) => !AGENTS[id]);
    if (unknown.length) { console.error('Unknown agent(s): ' + unknown.join(', ') + '. Known: ' + Object.keys(AGENTS).join(', ')); process.exit(1); }
  }

  let failed = 0;
  for (const [id, a] of Object.entries(AGENTS)) {
    if (only && !only.includes(id)) continue;
    // --remove cleans every agent we know, detected or not; install touches detected ones.
    const found = detected(a);
    if (!remove && !only && !found) continue;
    if (list) { console.log((found ? '  found  ' : '  —      ') + id + (a.style === 'manual' ? '  (manual setup, see docs/AGENTS.md)' : '')); continue; }
    if (a.style === 'manual') {
      if (!remove) console.log('  ' + id + ': found, but needs manual setup — see docs/AGENTS.md');
      continue;
    }
    try {
      const status = (remove ? REMOVE : INSTALL)[a.style](a);
      if (!remove || status !== 'nothing to remove') console.log('  ' + id + ': ' + status);
      if (!remove && a.note && status !== 'already wired') console.log('    note: ' + a.note);
    } catch (e) {
      failed++;
      console.error('  ' + id + ': ' + (e instanceof SettingsError ? e.message : 'failed — ' + e.message));
    }
  }
  if (failed) process.exit(1);
}

if (require.main === module) main();
module.exports = { AGENTS, EVENT_SCRIPT, detected, MARKS };
