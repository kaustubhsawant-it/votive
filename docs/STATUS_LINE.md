# Task status in the status line

Votive adds one segment to the front of Claude Code's status line (the line under the
prompt box). It shows what this session is actually doing, so you can tell "finished" from
"stopped to ask you something" before you type the next request:

```
● Deploying to c.local · 3/6 · 50% · 2m │ <your status line, unchanged>
⏸ Waiting on you: Should I merge to main? · 4m
⏸ Stopped · 4/6 done · 1m
✓ Done 6/6
✗ Error: npm ERR! missing script: deploy · 0s
```

| Segment | Colour | Meaning |
|---|---|---|
| `● <step> · n/m · p% · t` | cyan | Working. The step is the task list's in-progress item; `n/m` and `%` only appear when the agent keeps a task list |
| `◐ n agents running · t` | blue | The turn ended but background agents or commands it launched are still running (`n commands`, or `n background tasks` when mixed) |
| `⏸ Waiting on you: …` | magenta | A permission prompt (`approve Bash`), or the turn ended on a question or a request for approval (shows that question) |
| `⏸ Stopped · n/m done` | yellow | The turn ended with items still open in the task list, and no question was asked |
| `✓ Done [n/m]` | green | The turn ended, nothing was asked and nothing is left open |
| `✗ Error: …` | red | The last tool call or the turn failed |

The segment is **at most 40 columns**, because the status line isn't told the terminal width and
your own status line follows it. Step names, questions and errors are shortened to fit (with
`…`). When the question is too long for `⏸ Waiting on you: …`, it becomes `⏸ Waiting: …`.

`t` is the time spent **in the current state or step**. It restarts when the state changes or
the active step moves on, so one long step doesn't look frozen. The time updates on each
status-line refresh. A brand-new session that hasn't done anything shows no segment.

## Turning it on and off

It's on as soon as the status-line wrapper is installed (`./Scripts/install.sh`, or
`node Scripts/install-statusline.js` alone) and the scripts in `~/.votive/bin/` are
current. **After updating from 1.3.x, re-run `./Scripts/install.sh`** (or `repair` the scripts
over MCP), because the segment needs the new `progress.js` and the updated hook and wrapper.

To keep the usage recording but hide the segment, add `--no-task` to the command in
`~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node '/Users/you/.votive/bin/votive-statusline.js' --no-task"
}
```

Set `NO_COLOR` in the status line's environment for an uncoloured segment.

## Where the numbers come from

Progress is counted from the **agent's own task list**, never estimated from time. Without a
task list the segment shows the state and the elapsed time only.

| Agent | Task list tool | How it's read |
|---|---|---|
| Claude Code | `TodoWrite`; `TaskCreate` / `TaskUpdate` | `PostToolUse` hook payload; transcript tail at Stop as a fallback |
| Codex | `update_plan` | hook payload when it carries the tool, otherwise the rollout transcript tail at Stop |
| Gemini CLI | `write_todos` | `AfterTool` hook payload |
| Cursor | `todo_write` (including `merge: true` partial updates) | hook payload, when Cursor includes the tool call |
| Others | — | state only (they don't pass tool calls to their hooks) |

Notes:
- `TodoWrite`-style tools send the whole list each time, so the latest call replaces it.
  `TaskCreate`/`TaskUpdate` build it up item by item. A task created before Votive
  started watching the session isn't counted.
- Cancelled or deleted items don't count toward the total.
- **On a new prompt** the list is cleared if it's fully done, or if it's unfinished and hasn't
  changed for 10 minutes (an abandoned job), so an old `4/6` doesn't show on unrelated work.
  A recently changed unfinished list is kept, since the prompt is often "continue". Its old step
  name stays hidden (`● Working · 4/6 · 67%`) until the agent updates the list again.
- **Parallel tool calls.** Claude Code runs the hooks of parallel tool calls at the same time.
  Each hook takes a short lock (`~/.votive/locks/`, waits up to about 1 s, and a lock
  older than 3 s counts as stale), so concurrent `TaskCreate`s don't overwrite each other. As a
  second guard, at the end of every turn the task-list calls made **since the last prompt** are
  replayed from the transcript tail on top of what the hooks recorded. The transcript wins, and
  earlier jobs in the same transcript can't bring back a list that was already cleared.
- Many turns don't use a task list at all. Those show `● Working · 2m`, which is honest: there
  is no step count to report.

## How "done" is told apart from "waiting on you"

At the end of a turn (`Stop` for Claude Code and Codex, `AfterAgent` for Gemini CLI), the hook
looks at the final assistant message. It uses the hook payload's `last_assistant_message` or
`prompt_response` when there is one. Otherwise it reads the last 256 KB of the transcript,
never the whole file.

1. **A question.** One of the last three non-empty lines ends in `?`, or explicitly hands
   the turn back ("please confirm", "waiting for your approval", "before I proceed", …).
   Text inside code blocks is ignored. Checking three lines means a sign-off line after the
   question doesn't hide it. → **waiting** (`waitReason: "question"`), and the question
   becomes the excerpt.
2. **Background work still running.** → **background** (`◐ 4 agents running`). See below.
3. **Open items in the task list.** → **stopped** (`waitReason: "open-tasks"`).
4. Otherwise → **done**.

Soft closings such as "Let me know if you want anything else." on finished work count as done.
A Codex `Interrupt` is never reclassified: you stopped it yourself.

Stopped and question turns are recorded with `lastEvent: "waiting"`, so the menu-bar app shows
them as needs-input (🟣). For other agents that's immediate. For Claude Code the app may still
show green, because its live registry flips to idle right after `Stop` and the app treats the
newer registry timestamp as authoritative. The status line is correct either way.

## Background agents and commands

Claude Code's background agents (the Agent tool) and background commands (Bash with
`run_in_background`) keep running after the turn ends. A turn that leaves any of them running
is not done. The hook finds them in the transcript tail, matched by id:

- **Launch:** a tool result whose structured `toolUseResult` says so:
  `{status: "async_launched", agentId}` for an agent, `{backgroundTaskId}` for a command.
  Only this structured field counts. A transcript that merely quotes "Async agent launched
  successfully" (in a prompt, a grep result, a message) can't create a phantom.
- **Finish:** a `<task-notification>` naming that `<task-id>` with any final `<status>`
  (completed, failed, killed, stopped). It counts whether it's still queued
  (`queue-operation`) or already delivered as a turn. A launch with no completion after 12
  hours is presumed lost.

While any are outstanding the record keeps `bg: { at, ids, kinds, then }`, where `then` is
what the Stop would have been without them. The status line counts down without waiting
for a hook. On each refresh it checks the transcript tail for completions of those ids,
parsing only lines that mention a task id, and it does this only while background work is
outstanding. When the last one finishes it shows `then` (done, or stopped with open tasks).
If the agent has acted since, it shows the record's own state. Tool calls made by the
background agents themselves report under the same session and keep the count. A new prompt
is a new job and drops it. When a completion starts a new turn, that turn's Stop recomputes
everything.

A task notification is never mistaken for a prompt. The task-list replay window
("since the last prompt") stays where the user last typed.

## What gets stored

The event hook adds these fields to `~/.votive/events/<agent>--<session>.json` (see
[ARCHITECTURE.md](ARCHITECTURE.md#overlayentry-fields-event-file-any-agent)):

```
stateSince  Int64?   epoch-ms the current state / step began
planAt      Int64?   epoch-ms the task list last changed
promptAt    Int64?   epoch-ms of the last prompt
plan        [Item]?  ≤50 items: { id?, text, activeForm?, status: pending|in_progress|completed }
waitReason  String?  "permission" | "question" | "open-tasks"   (only while lastEvent = waiting)
detail      String?  short excerpt: the question, "approve <tool>", or the error
bg          Object?  { at, ids: [String], kinds: ["agent"|"command"], then: {state, waitReason?} }
```

While `bg` is set, `lastEvent` is `"working"`.

All text is cleaned before it's stored or printed: control characters (including terminal
escape sequences) are removed, whitespace is collapsed, and long text is cut to length without
splitting an emoji.

## Safety and speed

- The wrapper reads one small JSON file per refresh. It never reads a transcript, and it adds
  roughly the cost of starting Node (about 60 ms in total on an M-series Mac, wrapped command
  included).
- The segment and ` │ ` are written just before the wrapped command's first byte, and every
  byte the command prints is then passed on unchanged and in order. Everything after ` │ ` is
  exactly what your previous status line printed. If that command prints nothing, the segment
  stands alone without a dangling separator. With no segment to show, the output is exactly
  what it was before this feature.
- Any error while building the segment (missing or corrupt event file, bad input) produces no
  segment and the rest of the status line runs normally. The hook falls back to the plain state
  if progress tracking throws, and still always exits 0 silently.

## Dropping items from your status line

`~/.votive/usage/wrapped.json` can list items to remove from the wrapped status line:

```json
{ "version": 2, "command": "node \"/Users/you/.claude/hooks/gsd-statusline.js\"", "previous": { … },
  "drop": ["⬆ /gsd:update"] }
```

Each entry is literal visible text. The item is removed along with the styling codes around
it and one adjacent ` │ ` separator; everything else stays byte for byte. With a `drop` list
the wrapped output is collected and written when the command ends (a few hundred bytes),
instead of being streamed. Without one it streams exactly as before. This is how GSD's
`⬆ /gsd:update` gives way to the Meristem segment without editing GSD's own script, which GSD
updates would overwrite.

## Meristem segment

In a Meristem workspace (the nearest folder with `meristem.toml` or `.meristem/`, stopping
below your home folder, whose `~/.meristem` is Meristem's global store), a short segment
follows the task segment:

```
✓ Done │ ⟳ 3 behind · 2 to review │ Opus 5.5 │ meristem ███░░░░░░░ 38%
```

- It shows only what's worth acting on: `⟳ N behind` (the index is behind the code) and
  `N to review` (captured facts awaiting review), at most 20 columns. When neither is
  non-zero it's hidden.
- **It never adds latency.** The status line serves a cached value from
  `~/.votive/cache/meristem-<key>.json`. When that's older than 15 s, it starts a
  detached refresh and returns at once; a refresh already running suppresses another for
  30 s. The refresh runs `meristem-statusline` (the fast entry point in Meristem ≥ 0.3.0)
  when it's on `PATH`, otherwise `meristem statusline --compact`. It has a 5-second hard
  timeout. A value older than 10 minutes isn't shown.
- Nothing runs when neither command is on `PATH` or the folder isn't a Meristem workspace.
- `--no-meristem` on the statusLine command turns it off.
