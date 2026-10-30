'use strict';
//
// The adapter table: how each agentic coding tool reports its lifecycle, normalized to the
// overlay's state vocabulary:
//
//   starting | working | done | waiting | error | end      (end = session over, delete file)
//
// An adapter says where the event name, session id, cwd, prompt and transcript path live in
// that agent's hook payload, and maps its event names (case-insensitive) to a state. A map
// value may be a function of the payload for events whose meaning depends on a field, and
// `'*'` is the fallback for names not listed. Returning null ignores the event.
//
// Adding an agent = adding an entry here (+ an installer entry in install-agents.js).
// Anything not listed can still report through the `generic` adapter, where --event must
// already be a state name.
//
const STATES = new Set(['starting', 'working', 'done', 'waiting', 'error', 'end']);

// Claude Code's event names; Qwen Code and Goose reuse them.
const CLAUDE_STYLE = {
  SessionStart: 'starting',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  PermissionRequest: 'waiting',
  PostToolUseFailure: 'error',
  Stop: 'done',
  StopFailure: 'error',
  SessionEnd: 'end',
  // Notification is deliberately unmapped for Claude: its idle notice fires ~60 s after a
  // turn ends and would turn a finished session purple.
};

const ADAPTERS = {
  'claude-code': {
    name: 'Claude Code',
    event: ['hook_event_name'],
    session: ['session_id'], cwd: ['cwd'], prompt: ['prompt'], transcript: ['transcript_path'],
    map: CLAUDE_STYLE,
  },
  codex: {
    name: 'Codex',
    event: ['hook_event_name'],
    session: ['session_id'], cwd: ['cwd'], prompt: ['prompt'], transcript: ['transcript_path'],
    map: {
      SessionStart: 'starting', UserPromptSubmit: 'working', PostToolUse: 'working',
      PermissionRequest: 'waiting', Stop: 'done', Interrupt: 'done', SessionEnd: 'end',
    },
    usage: 'codex-rollout',
  },
  gemini: {
    name: 'Gemini CLI',
    event: ['hook_event_name'],
    session: ['session_id'], cwd: ['cwd'], prompt: ['prompt'], transcript: ['transcript_path'],
    map: {
      SessionStart: 'starting',
      BeforeAgent: 'working',
      AfterTool: (p) => (p.tool_response && p.tool_response.error ? 'error' : 'working'),
      Notification: (p) => (p.notification_type === 'ToolPermission' ? 'waiting' : null),
      AfterAgent: 'done',
      SessionEnd: 'end',
    },
  },
  qwen: {
    name: 'Qwen Code',
    event: ['hook_event_name'],
    session: ['session_id'], cwd: ['cwd'], prompt: ['prompt'], transcript: ['transcript_path'],
    map: Object.assign({}, CLAUDE_STYLE, {
      Notification: (p) => (p.notification_type === 'permission_prompt' ? 'waiting' : null),
    }),
  },
  copilot: {
    name: 'Copilot CLI',
    event: ['hook_event_name'],   // only on `notification`; otherwise --event from argv
    session: ['sessionId', 'session_id'], cwd: ['cwd'], prompt: ['prompt'], transcript: ['transcriptPath', 'transcript_path'],
    map: {
      sessionStart: 'starting', userPromptSubmitted: 'working', postToolUse: 'working',
      postToolUseFailure: 'error', permissionRequest: 'waiting', agentStop: 'done', Stop: 'done',
      errorOccurred: 'error', sessionEnd: 'end',
      notification: (p) => (p.notification_type === 'permission_prompt' ? 'waiting' : null),
    },
  },
  cursor: {
    name: 'Cursor',
    event: ['hook_event_name'],
    session: ['conversation_id', 'session_id'], cwd: ['workspace_roots.0', 'cwd'],
    prompt: ['prompt'], transcript: ['transcript_path'],
    map: {
      sessionStart: 'starting', beforeSubmitPrompt: 'working', postToolUse: 'working',
      postToolUseFailure: 'error',
      UserPromptSubmit: 'working',   // Claude-style name, when Cursor runs imported Claude hooks
      stop: (p) => (p.status === 'error' ? 'error' : 'done'),
      sessionEnd: 'end',
    },
  },
  windsurf: {
    name: 'Windsurf',
    event: ['agent_action_name'],
    session: ['trajectory_id'], cwd: ['tool_info.cwd'], prompt: ['tool_info.user_prompt'], transcript: [],
    map: {
      pre_user_prompt: 'working',
      post_cascade_response: 'done',
      post_cascade_response_with_transcript: 'done',
      '*': (p, name) => (name.startsWith('post_') ? 'working' : null),
    },
  },
  goose: {
    name: 'Goose',
    event: ['event', 'hook_event_name'],
    session: ['session_id'], cwd: ['working_dir', 'cwd'], prompt: ['message', 'prompt'], transcript: [],
    map: CLAUDE_STYLE,
  },
  cline: {
    name: 'Cline',
    event: ['hookName'],
    session: ['taskId'], cwd: ['workspaceRoots.0'], prompt: ['prompt'], transcript: [],
    map: {
      TaskStart: 'working', TaskResume: 'working', UserPromptSubmit: 'working',
      PostToolUse: 'working', TaskComplete: 'done', TaskError: 'error', TaskCancel: 'done',
      SessionShutdown: 'end',
    },
  },
  opencode: {
    name: 'OpenCode',
    event: [],   // the plugin passes --event/--session/--cwd
    session: ['sessionID'], cwd: [], prompt: [], transcript: [],
    map: {
      'session.created': 'starting', 'chat.message': 'working', 'tool.execute.after': 'working',
      'permission.asked': 'waiting', 'permission.updated': 'waiting', 'permission.replied': 'working',
      'session.idle': 'done', 'session.error': 'error', 'session.deleted': 'end',
    },
  },
  amp: {
    name: 'Amp',
    event: [],   // the plugin passes --event/--session
    session: ['thread.id'], cwd: [], prompt: [], transcript: [],
    map: {
      'session.start': 'starting', 'agent.start': 'working', 'tool.result': 'working',
      'agent.end': (p) => (p.status === 'error' ? 'error' : 'done'),
    },
  },
  aider: {
    name: 'Aider',
    event: [], defaultEvent: 'done',   // --notifications-command fires only when a turn is done
    session: [], cwd: [], prompt: [], transcript: [],
    map: { done: 'done' },
  },
  generic: {
    name: 'Agent',
    event: ['event', 'state'],
    session: ['session_id', 'sessionId'], cwd: ['cwd'], prompt: ['prompt'], transcript: [],
    map: { '*': (p, name) => (STATES.has(name) ? name : null) },
  },
};

/** Read a dotted path (`a.b.0`) from an object; returns a non-empty string or null. */
function pick(obj, paths) {
  for (const p of paths || []) {
    let v = obj;
    for (const k of p.split('.')) { v = v == null ? undefined : v[k]; }
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Map an agent event name to a state, or null to ignore it. Case-insensitive. */
function stateFor(adapter, eventName, payload) {
  if (!eventName) return null;
  const lower = eventName.toLowerCase();
  let entry;
  for (const k of Object.keys(adapter.map)) {
    if (k !== '*' && k.toLowerCase() === lower) { entry = adapter.map[k]; break; }
  }
  if (entry === undefined) entry = adapter.map['*'];
  if (entry === undefined) return null;
  const s = typeof entry === 'function' ? entry(payload, lower) : entry;
  return STATES.has(s) ? s : null;
}

/**
 * Normalize one hook invocation. `agentId` comes from --agent; argv overrides win over payload
 * fields. Cursor runs Claude Code's hooks by default, so a Cursor-shaped payload arriving on the
 * Claude hook is attributed to Cursor.
 */
function normalize(agentId, payload, argv) {
  let id = ADAPTERS[agentId] ? agentId : 'generic';
  if (id === 'claude-code' && (payload.cursor_version || payload.conversation_id)) id = 'cursor';
  const a = ADAPTERS[id];
  const eventName = argv.event || pick(payload, a.event) || a.defaultEvent || null;
  // An agent without an adapter keeps its own (sanitized) id, so its dots are labelled with
  // its name rather than a generic "Agent".
  const custom = !ADAPTERS[agentId] && typeof agentId === 'string'
    ? agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : '';
  return {
    agent: custom || id,
    agentName: a.name,
    eventName,
    state: stateFor(a, eventName, payload),
    sessionId: argv.session || pick(payload, a.session),
    cwd: argv.cwd || pick(payload, a.cwd),
    prompt: pick(payload, a.prompt),
    transcriptPath: pick(payload, a.transcript),
    usage: a.usage || null,
  };
}

module.exports = { ADAPTERS, STATES, normalize, stateFor, pick };
