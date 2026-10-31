#!/usr/bin/env node
'use strict';
//
// Votive MCP server. Tools:
//   notify        -- pop a custom alert in the menu-bar app for the CALLING session
//   settings_get  -- read the app's preferences (read only)
//   settings_set  -- change them (applied immediately); refused unless the user allowed it
//   diagnose      -- check the install (app, login item, scripts, agents, usage) (read only)
//   repair        -- fix what diagnose finds; refused unless the user allowed it
// The tools that change things are guarded by Scripts/mcp-guard.js: a switch only the user can turn
// on in the app's menu, rate limits, and an audit file the app shows (AGEN-22).
// Registered globally:
//
//   claude mcp add --scope user votive -- node <this file's absolute path>
//
// (done by Scripts/install.sh) -- so it's available in every project without per-project
// .mcp.json setup.
//
// Works with any MCP-capable agent (Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, …).
// Session discovery: stdio MCP servers are spawned as a DIRECT CHILD of the calling agent, so
// process.ppid is that agent's pid; notify-core.js matches it against Claude Code's registry
// or the pid recorded in any agent's event file.
//
// Kept deliberately tiny: one dependency (the official SDK), no persistent state, no
// timers, no polling -- it does nothing between tool calls, so idle cost is exactly what an
// idle child process costs the OS.
//
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { writeNotify, findOwningSession } = require(path.join(__dirname, '..', 'Scripts', 'notify-core.js'));
const guard = require(path.join(__dirname, '..', 'Scripts', 'mcp-guard.js'));
const settings = require(path.join(__dirname, '..', 'Scripts', 'overlay-settings.js'));
const doctor = require(path.join(__dirname, '..', 'Scripts', 'doctor.js'));

const NOTIFY_TOOL = {
  name: 'notify',
  description:
    'Pop a custom alert dialog in the user\'s Votive menu-bar app for THIS session, ' +
    'right now — independent of whether your session state actually changed.\n\n' +
    'ONLY call this when the user\'s own prompt in this conversation explicitly asked to be ' +
    'notified, pinged, or told when something happens — e.g. "let me know when this is ' +
    'done", "ping me if you get blocked", "notify me once tests pass". Do NOT call it on ' +
    'your own judgment for a milestone the user never asked to be told about — that is what ' +
    'this mode exists to prevent. If nothing in the prompt asked for a notification, don\'t ' +
    'use this tool, no matter how notable the moment feels.\n\n' +
    'When it does apply: write a message a person could actually understand out of context, ' +
    'not a bare label — a folder name, a branch name, a file path, or a one-word status ' +
    '("done", "api-refactor") tells the user nothing about what happened. Say what you ' +
    'did or what you need in a real sentence.\n' +
    '  GOOD: "Auth refactor done — 3 tests still failing on Firefox, need a decision on the ' +
    'cookie policy before I continue."\n' +
    '  GOOD: "Migrated the pricing page copy; ready for you to review before I deploy."\n' +
    '  BAD:  "api-refactor" (a bare project/folder name — says nothing happened)\n' +
    '  BAD:  "done" / "finished" / "update" (no information about what)\n\n' +
    'The dialog gets an "Open Terminal" button that jumps the user straight back to this ' +
    'session, and it never steals focus from whatever they\'re doing (Escape dismisses it ' +
    'like any other dialog).',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'The alert text, in your own words — what actually happened or what you need. ' +
          'Keep it under ~200 characters, one line.',
      },
    },
    required: ['message'],
  },
  annotations: { title: 'Notify the user', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};

// Settings, diagnose and repair: so the user can say "stop the pop-ups", "why is usage not
// showing?" or "fix Votive" to any agent instead of hunting through the menu.
const settingProps = {};
for (const [name, spec] of Object.entries(settings.SETTINGS)) {
  const description = spec.description + ' Default: ' + spec.default + '.';
  settingProps[name] = spec.type === 'bool' ? { type: 'boolean', description }
    : spec.type === 'sound' ? { type: 'string', description }
    : { type: 'integer', minimum: spec.min, maximum: spec.max, description };
}

const SETTINGS_TOOL_SCHEMA = {
    type: 'object',
    properties: {
      changes: {
        type: 'object',
        description: 'Settings to change. Omit to just read the current settings.',
        properties: settingProps,
        additionalProperties: false,
      },
    },
  };

const SETTINGS_GET_TOOL = {
  name: 'settings_get',
  description:
    'Read the user\'s Votive preferences (the menu-bar app that shows a dot per agent session): ' +
    'every setting with its current value, its default and what it does. Read-only; call it with no arguments. ' +
    'To change a setting use settings_set, which only works if the user has allowed agents to change settings.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Read Votive settings', readOnlyHint: true, openWorldHint: false },
};

const SETTINGS_SET_TOOL = {
  name: 'settings_set',
  description:
    'Change one or more of the user\'s Votive preferences; the running app applies them immediately. ' +
    'Only change a setting when the user asked for that change (e.g. "stop the pop-ups for every ' +
    'session" -> popupOnEveryChange=false and bannerOnEveryChange=false; "only tell me when I ask" ' +
    '-> the same, keeping notifyOnRequest=true; "play Hero when a session is done" -> soundDone=Hero; ' +
    '"no sounds" -> sounds=false). Report what changed.\n\n' +
    'This works only if the user has switched on "Let agents change settings" in the app\'s menu; ' +
    'otherwise it is refused, and you should tell the user how to turn it on or give them the command. ' +
    'It is also rate limited (a few changes an hour), and every change is logged where the user can see and undo it.',
  inputSchema: SETTINGS_TOOL_SCHEMA,
  annotations: { title: 'Change Votive settings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { 'anthropic/requiresUserInteraction': true },
};

const DIAGNOSE_TOOL = {
  name: 'diagnose',
  description:
    'Check the user\'s Votive install: whether the app is installed, running and starts at ' +
    'login, whether its hook scripts are current, which agents are found and wired, whether ' +
    'Claude Code plan usage is being recorded, and recent activity. Read-only. Use it when the ' +
    'user reports missing dots, missing usage, or that something "isn\'t working". The result ' +
    'lists any failing checks and the repairs that would fix them.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Check the Votive install', readOnlyHint: true, openWorldHint: false },
};

const REPAIR_TOOL = {
  name: 'repair',
  description:
    'Fix problems found by `diagnose`. Repairs: ' +
    Object.entries(doctor.REPAIRS).map(([k, v]) => k + ' (' + v.toLowerCase() + ')').join('; ') +
    '. With no `repairs` it runs the ones diagnose recommends. Agent config files are backed up ' +
    'before they change. It does not rebuild or reinstall the app itself; if the app is missing, ' +
    'tell the user to run ./Scripts/install.sh. Only run this when the user asked you to fix ' +
    'Votive, and report what was done. It works only if the user has switched on "Let agents ' +
    'change settings" in the app\'s menu; otherwise it is refused, so tell the user how to turn it on. ' +
    'It is rate limited and logged where the user can see it.',
  inputSchema: {
    type: 'object',
    properties: {
      repairs: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(doctor.REPAIRS) },
        description: 'Which repairs to run. Omit to run the ones diagnose recommends.',
      },
    },
  },
  annotations: { title: 'Repair the Votive install', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  _meta: { 'anthropic/requiresUserInteraction': true }
};

const server = new Server(
  { name: 'votive', version: '1.7.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [NOTIFY_TOOL, SETTINGS_GET_TOOL, SETTINGS_SET_TOOL, DIAGNOSE_TOOL, REPAIR_TOOL],
}));

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const callerAgent = () => { try { const o = findOwningSession(process.ppid); return o ? o.agent : 'unknown'; } catch (e) { return 'unknown'; } };

function describeSettings(all) {
  return Object.entries(all).map(([name, s]) => '- ' + name + ': ' + s.value +
    (s.value === s.default ? '' : ' (default ' + s.default + ')') + ' — ' + s.description).join('\n');
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  try {
    switch (request.params.name) {
      case 'notify': {
        const limited = guard.refuse('notify', false);
        if (limited) { guard.record({ tool: 'notify', agent: callerAgent(), ok: false, summary: 'refused: rate limit' }); return text(limited, true); }
        const result = writeNotify(args.message, process.ppid);
        if (!result.ok) return text('Failed: ' + result.error, true);
        guard.record({ tool: 'notify', agent: callerAgent(), ok: true, summary: 'sent a notification panel' });   // never the message itself
        return text('Notified Votive for this session.');
      }
      case 'settings_get':
        return text('Current Votive settings:\n' + describeSettings(settings.getSettings()));
      case 'settings_set': {
        const refused = guard.refuse('settings_set', true);
        if (refused) { guard.record({ tool: 'settings_set', agent: callerAgent(), ok: false, summary: 'refused: ' + (guard.writesAllowed() ? 'rate limit' : 'agent changes are switched off') }); return text(refused, true); }
        const changes = args.changes;
        if (changes === undefined || changes === null || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
          return text('`changes` must be an object like {"popupOnEveryChange": false}. To only read the settings use settings_get.', true);
        }
        const { changed, unchanged, settings: all } = settings.updateSettings(changes);
        const lines = Object.entries(changed).map(([n, c]) => '- ' + n + ': ' + c.from + ' → ' + c.to);
        if (lines.length) guard.record({ tool: 'settings_set', agent: callerAgent(), ok: true, summary: 'changed ' + lines.map((l) => l.slice(2)).join('; '), undo: changed });
        const same = unchanged.length ? '\nAlready set: ' + unchanged.join(', ') : '';
        return text((lines.length ? 'Changed (applied immediately, and logged for the user):\n' + lines.join('\n') : 'Nothing needed changing.') +
          same + '\n\nAll settings now:\n' + describeSettings(all));
      }
      case 'diagnose': {
        const d = doctor.diagnose();
        const lines = d.checks.map((c) => (c.warn ? '! ' : c.ok ? '✓ ' : '✗ ') + c.id + ': ' + c.detail);
        return text(d.summary + '.\n' + lines.join('\n') +
          (d.repairs.length ? '\n\nRecommended repairs: ' + d.repairs.join(', ') : ''));
      }
      case 'repair': {
        const refused = guard.refuse('repair', true);
        if (refused) { guard.record({ tool: 'repair', agent: callerAgent(), ok: false, summary: 'refused: ' + (guard.writesAllowed() ? 'rate limit' : 'agent changes are switched off') }); return text(refused, true); }
        if (args.repairs !== undefined && !Array.isArray(args.repairs)) {
          return text('`repairs` must be a list, e.g. ["scripts"], or omitted to run the recommended ones.', true);
        }
        const results = doctor.repair(args.repairs || []);
        if (!results.length) return text('Nothing needed repairing.');
        guard.record({ tool: 'repair', agent: callerAgent(), ok: results.every((r) => r.ok), summary: 'ran repairs: ' + results.map((r) => r.repair).join(', ') });
        const lines = results.map((r) => (r.ok ? '✓ ' : '✗ ') + r.repair + ': ' + r.output);
        const after = doctor.diagnose();
        return text(lines.join('\n') + '\n\nAfter repair: ' + after.summary + '.', results.some((r) => !r.ok));
      }
      default:
        return text('Unknown tool: ' + request.params.name, true);
    }
  } catch (e) {
    return text(e.message, true);
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
