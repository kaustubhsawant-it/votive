# Supported agents

Votive works with any agentic coding tool that can run a command when something happens
in a session. Every agent reports through the same script, and a table of adapters
(`Scripts/agents.js`) translates each agent's event names into Votive's states:

| State | Dot | Meaning |
|---|---|---|
| `starting` | blue | session opened |
| `working` | yellow | prompt submitted, or a tool just finished |
| `waiting` | purple | waiting for you to approve something |
| `error` | orange | a tool or turn failed |
| `done` | green | turn finished |
| `end` | (removed) | session closed |

`working` with no new event for the stuck threshold shows as **stuck** (brown). A session
whose process disappears without an `end` shows as **stopped** (red) for a minute.

`./Scripts/install.sh` wires every agent it detects (config folder exists or command on your
`PATH`). If you install another agent later:

```sh
node Scripts/install-agents.js                 # wire everything detected
node Scripts/install-agents.js --only codex    # or just one
node Scripts/install-agents.js --list          # see what's detected, change nothing
```

## Wired automatically

| Agent | Where the hook goes | Events used | Needs you (purple) | Plan usage |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json` | SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, StopFailure, SessionEnd | yes | yes (status line) |
| **Codex CLI** | `~/.codex/hooks.json` | SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Stop, Interrupt, SessionEnd | yes | yes (session transcript) |
| **Gemini CLI** | `~/.gemini/settings.json` | SessionStart, BeforeAgent, AfterTool, Notification, AfterAgent, SessionEnd | yes | no |
| **Qwen Code** | `~/.qwen/settings.json` | Claude Code's events plus Notification | yes | no |
| **Copilot CLI** | `~/.copilot/hooks/votive.json` (its own file) | sessionStart, userPromptSubmitted, postToolUse, postToolUseFailure, permissionRequest, agentStop, errorOccurred, sessionEnd | yes | no |
| **Cursor** (IDE and `cursor-agent`) | `~/.cursor/hooks.json` | sessionStart, beforeSubmitPrompt, postToolUse, postToolUseFailure, stop, sessionEnd | no | no |
| **Windsurf** | `~/.codeium/windsurf/hooks.json` | pre_user_prompt, post_* tool events, post_cascade_response | no | no |
| **OpenCode** | `~/.config/opencode/plugins/votive.js` (a plugin) | session.created/idle/error/deleted, permission.*, chat.message, tool.execute.after | yes | no |

Notes:
- **Codex** runs a new hook only after you trust it. Open Codex once and approve the Votive hooks in `/hooks`.
- **Cursor** also runs Claude Code's hooks by default. Those events are recognized as Cursor
  (by `cursor_version` / `conversation_id` in the payload), so they never show up as a Claude
  Code session.
- The Cursor CLI has fired fewer events than the IDE in some versions; dots still update on
  every event it does send.
- Task progress (`3/6 · 50%`) is counted from the agent's own task list when its hooks pass
  the tool call: Claude Code (TodoWrite, TaskCreate/TaskUpdate), Codex (update_plan), Gemini
  CLI (write_todos), Cursor (todo_write). For every agent, a turn that ends on a question is
  recorded as waiting rather than done when the end-of-turn payload or transcript carries the
  last message. See [STATUS_LINE.md](STATUS_LINE.md).
- Plan usage appears only for agents that write it somewhere a local script can read. Claude
  Code passes it to the status line, and Codex writes it to its session transcript. Gemini CLI,
  Copilot and the others keep it in memory only.

## Manual setup

These agents can report too, but their hook format isn't safe to edit automatically. Replace
`EVENT` below with the full path to `~/.votive/bin/votive-event.js`.

### Aider

Aider can only say "the turn is done" (`--notifications-command`). Add to `~/.aider.conf.yml`:

```yaml
notifications: true
notifications-command: node EVENT --agent aider
```

Each Aider process shows as one session, green when it's waiting for you.

### Goose

Goose hooks live in a plugin folder with Claude Code's layout, for example
`~/.agents/plugins/votive/hooks/hooks.json` (check Goose's plugin docs for any manifest
your version needs next to it):

```json
{ "hooks": {
  "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node EVENT --agent goose" }] }],
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node EVENT --agent goose" }] }],
  "PostToolUse":        [{ "hooks": [{ "type": "command", "command": "node EVENT --agent goose" }] }],
  "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "node EVENT --agent goose" }] }],
  "Stop":               [{ "hooks": [{ "type": "command", "command": "node EVENT --agent goose" }] }],
  "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node EVENT --agent goose" }] }]
} }
```

### Cline

Cline runs an executable named after each event from its hooks folder (turn hooks on under
Settings → Features). For each of `TaskStart`, `TaskResume`, `UserPromptSubmit`, `PostToolUse`,
`TaskComplete`, `TaskError`, `TaskCancel`, `SessionShutdown`, create a file with that name:

```sh
#!/bin/sh
exec node EVENT --agent cline --event "$(basename "$0")"
```

and `chmod +x` it.

### Amp

Amp uses TypeScript plugins in `~/.config/amp/plugins/`. Call the script from the events you
want, passing the thread id:

```ts
amp.on('agent.end', (event, ctx) =>
  amp.$`node EVENT --agent amp --no-stdin --event agent.end --session ${ctx.thread.id}`)
```

Use `session.start`, `agent.start` and `tool.result` the same way. Check Amp's plugin docs for
the exact shape of `event` and `ctx` in your version.

## Any other agent

If a tool can run a command, it can report. Use the generic adapter and pass a state directly:

```sh
node ~/.votive/bin/votive-event.js --agent my-agent --no-stdin \
  --event working --session "$SESSION_ID" --cwd "$PWD"
```

`--event` is one of `starting`, `working`, `waiting`, `error`, `done`, `end`. The dot is labelled
with the agent name you pass (`my-agent` → "My Agent"). Without `--session`, the calling process
stands in for the session.

To add first-class support, add an adapter to `Scripts/agents.js` (where the event name,
session id and cwd live in the payload, plus an event → state map) and, if its config is JSON,
an entry in `Scripts/install-agents.js`. Add sample payloads to `tests/agents.test.js`.

## MCP tools from any agent

The bundled MCP server has five tools: `notify` ("let me know when it's done"), `settings_get`
(read preferences), `settings_set` (change them), `diagnose` (check the install) and `repair`
(fix what diagnose finds). `settings_set` and `repair` are refused until you turn on **Settings →
Agents → Let agents change settings** in the menu (it is off by default and no tool can turn it
on), they are rate limited, and every change is logged for you to see and undo. It's an ordinary stdio MCP server, so any agent that supports MCP can use it. The
installer registers it with Claude Code. For another agent, point its MCP config at:

```
node /path/to/votive/mcp-server/index.js
```

(for example `codex mcp add votive -- node …/mcp-server/index.js`). `notify` finds its
own session automatically once that session has reported at least one event; the other tools
work from any session.
