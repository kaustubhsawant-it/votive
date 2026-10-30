# Development guide

How the repository is laid out, how to build and iterate on it, the conventions the existing
code follows, and how to extend it safely. Read [ARCHITECTURE.md](ARCHITECTURE.md) first if
you haven't — this doc assumes you know what `StatusResolver`, `AgentScanner`, the event files
and the adapter table are.

## Repository context

A standalone repository with no dependency on any other project. At runtime the app reads only
local files: its own state under `~/.votive/`, plus Claude Code's session registry and
prompt history under `~/.claude` for Claude Code sessions. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Project layout

```
votive/
├── Votive/                  # App source (the only target)
│   ├── main.swift                 # Programmatic entry point (no storyboard, no @main)
│   ├── AppDelegate.swift          # Wires StatusCoordinator + UsageStore → StatusItemController
│   ├── Models/                    # Plain value types — no logic
│   │   ├── AgentSession.swift     #   the UI layer's only session type (id "agent:sessionId")
│   │   ├── AgentState.swift       #   the 7-state enum + color/label/pulse/shape mapping
│   │   ├── RegistryEntry.swift    #   Codable mirror of ~/.claude/sessions/{pid}.json (Claude Code)
│   │   └── OverlayEntry.swift     #   Codable mirror of ~/.votive/events/*.json, + AgentKind
│   │                              #     (adapter id → display name)
│   ├── Services/                  # Everything off the main thread + system integration
│   │   ├── Paths.swift            #   ~/.votive paths (ours) and ~/.claude paths (read-only)
│   │   ├── SessionRegistry.swift  #   reads Claude Code's sessions/*.json
│   │   ├── OverlayStore.swift     #   reads + prunes events/*.json
│   │   ├── Liveness.swift         #   kill(pid,0) / sysctl process probes
│   │   ├── StatusResolver.swift   #   pure resolve (Claude registry) / resolveEvent (event file) → AgentState
│   │   ├── AgentScanner.swift     #   joins registry + event files + liveness → [AgentSession]
│   │   ├── DirectoryWatcher.swift #   kqueue vnode watcher
│   │   ├── StatusCoordinator.swift#   owns the watch → debounce → scan → publish loop
│   │   ├── UsageStore.swift       #   watches usage/*.json → UsageSnapshot (per-agent windows)
│   │   ├── HistoryReader.swift    #   tails Claude Code's history.jsonl for recap text
│   │   ├── TerminalFocus.swift    #   process-tree walk + raise/AppleScript tab focus
│   │   ├── Notifier.swift         #   UNUserNotificationCenter banner
│   │   ├── DialogAlerter.swift    #   NotifyPanel fallback
│   │   └── SnippetStore.swift     #   ~/.votive/snippets.json
│   ├── UI/
│   │   ├── StatusItemController.swift  # NSStatusItem owner, menu, usage rows, alerts, animation —
│   │   │                               #   the only class allowed to touch AppKit on the main run loop
│   │   ├── AgentRowView.swift          # custom dropdown row (draws itself, handles click)
│   │   ├── NotifyPanel.swift           # non-activating alert panel
│   │   └── MenuBarIconRenderer.swift   # draws the dot row / shapes / idle arc into an NSImage
│   ├── Support/RelativeTime.swift # "now" / "12s" / "3m" / "2h" / "1d" formatting
│   └── Assets.xcassets/           # App icon
├── Scripts/
│   ├── build.sh                   # xcodegen generate + Debug build
│   ├── install.sh                 # Release build → ~/Applications, scripts → ~/.votive/bin,
│   │                              #   wire agents, Claude Code status line + MCP, LaunchAgent
│   ├── uninstall.sh               # reverse of install.sh
│   ├── fake-data.sh               # synthesize every state (Claude Code + Codex/Gemini rows)
│   ├── agents.js                  # the adapter table: payload fields + event → state, per agent
│   ├── votive-event.js     # the one hook every agent runs; writes events/*.json (+ Codex usage)
│   ├── overlay-paths.js           # ~/.votive paths + atomic JSON write, shared by the scripts
│   ├── progress.js                # task lists, done-vs-waiting at Stop, background work, elapsed time, segment
│   ├── statusline-extras.js       # status line: drop items from the wrapped line, cached Meristem segment
│   ├── install-agents.js          # detects agents and wires/unwires/lists their hooks
│   ├── settings-io.js             # safe load/backup/atomic save of an agent's JSON config
│   ├── integrations/
│   │   └── opencode-plugin.js     # OpenCode plugin template (install-agents.js fills in the path)
│   ├── votive-statusline.js # Claude Code statusLine wrapper: records usage, prepends the task segment, runs your old status line
│   ├── install-statusline.js      # installs / --remove's that wrapper in ~/.claude/settings.json
│   ├── notify-core.js             # finds the calling session, writes notifyMessage/notifyAt
│   ├── votive-notify.js    # CLI fallback for notify
│   ├── commands/notify.md         # the /notify command for Claude Code
│   └── dev.votive.Votive.plist  # LaunchAgent template (install.sh fills in the binary path)
├── mcp-server/                    # the votive MCP server (one tool: notify)
├── tests/
│   ├── scripts.test.js            # settings-io, status-line wrapper, Claude hook, notify
│   └── agents.test.js             # adapters, event script, Codex usage, per-agent installer
├── project.yml                    # XcodeGen spec — the source of truth for the Xcode project
├── README.md
└── docs/                          # this directory (AGENTS.md: per-agent setup)
```

`Votive.xcodeproj/` is **generated**, not committed (see `.gitignore`) — it's regenerated
from `project.yml` by `xcodegen generate` every time `Scripts/build.sh` or `Scripts/install.sh`
runs. Don't hand-edit project settings in Xcode and expect them to survive; edit `project.yml`.

## Build & run

```sh
cd votive
./Scripts/build.sh      # xcodegen generate + Debug build (ONLY_ACTIVE_ARCH=YES)
```

`build.sh` prints the built `.app` path; `open` it directly, or run from Xcode after
`xcodegen generate` (open `Votive.xcodeproj`, scheme `Votive`).

Debug builds are ad-hoc signed the same way Release is (`CODE_SIGN_IDENTITY: "-"` in
`project.yml`, applied to both `Debug` and `Release` configs under `settings.base`) — there is
no separate "no signing" dev mode.

A Debug build reads the same `~/.votive/` as the installed app. Changes under `Scripts/`
take effect for real agents only after they're copied to `~/.votive/bin/` (re-run
`install.sh`); the tests below run the scripts straight from the repo.

### Debug logging

Set `VOTIVE_DEBUG=1` in the environment before launching to get:
- `StatusItemController.logDebug()` — one line per scan to stderr:
  `name=state recap="..."` for every session.
- `TerminalFocus.log(_:)` — the resolved host app bundle id / pid / tty on every focus attempt,
  and AppleScript errors.

```sh
VOTIVE_DEBUG=1 "/path/to/Votive.app/Contents/MacOS/Votive"
```

### Requirements

- macOS 14.0+ (matches `deploymentTarget.macOS` in `project.yml`)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- Xcode / Command Line Tools, Swift 5.9
- Node.js on `PATH` — the installers are `node` scripts, and every hook
  (`votive-event.js`), the status-line wrapper and the MCP server run under `node`

## Tests

```sh
node --test tests/*.test.js
```

`tests/mcp.test.js` covers `overlay-settings.js` and `doctor.js` (read, change, reject invalid
batches, diagnose, repair) and drives the MCP server over stdio. It writes preferences to a
throwaway defaults domain (`VOTIVE_DEFAULTS_DOMAIN`), because `defaults` ignores `HOME`;
never run these scripts against the real domain in a test. It also checks that `install.sh`
copies the same scripts `doctor.js` verifies.

`tests/progress.test.js` covers `progress.js`: task lists from each agent's plan tool
(TodoWrite, TaskCreate/TaskUpdate, update_plan, write_todos, todo_write merge), question
detection, Stop classification, transcript-tail scanning (tail only, Claude and Codex shapes),
elapsed time, the segment formats, and end to end the hook and the status-line wrapper. The
wrapper tests check that the wrapped output still follows the segment byte for byte.

It also covers background work: launches and completions from real transcript shapes,
phantom launches from quoted text, precedence at Stop, and the live countdown in the wrapper.

`tests/statusline-extras.test.js` covers dropping items (GSD's exact bytes, ANSI around
neighbours kept), Meristem workspace detection, summarizing, refresh pacing, the timeout,
and that a slow `meristem` never delays the status line.

`tests/no-network.test.js` scans the source: it fails if the app, the scripts or the MCP server
gain any networking code, if the app gets entitlements, or if the MCP server gains a dependency.
It backs the promises in `PRIVACY.md`, so keep it passing; if a change genuinely needs one of
these, update `PRIVACY.md` in the same change.

The other two files run every script as a child process against a throwaway `HOME` in the system temp
folder, so your real `~/.votive`, `~/.claude` and other agents' configs are never
touched:

- `tests/scripts.test.js` — `settings-io` (missing/empty/non-object files, backups keep
  permissions, symlinks stay symlinks), the status-line wrapper (usage recording, pass-through,
  recursion guard, killing the wrapped command), the Claude Code hook, and notify.
- `tests/agents.test.js` — the adapter table against sample payloads taken from each agent's
  hook documentation (`CASES`), Cursor-on-Claude-hook attribution, the event script end to end
  (one file per session, `end` deletes, host pid is not the shell, `--no-stdin`, Aider, bad
  input), Codex usage from a sample transcript, notify from a Codex session, and
  `install-agents.js` for every config style (idempotent, legacy upgrade, `--remove`,
  `--only`, `--list`, refusing broken configs).

Run them after any change under `Scripts/`. The Swift side has no unit-test target; its check
is `fake-data.sh` plus a visual pass.

## Verifying UI changes without waiting for real agents

```sh
./Scripts/fake-data.sh        # synthetic sessions in every state
./Scripts/fake-data.sh clean  # removes them and kills the helper process
```

This writes Claude Code registry entries to `~/.claude/sessions/fake-*.json` and event files to
`~/.votive/events/` for every state, plus a custom notify and two event-only sessions
from other agents (a working Codex row and a waiting Gemini CLI row), all backed by a real
long-lived `sleep 3000` process so liveness checks pass. It's the fastest way to see every
color, shape, label and agent name at once. `clean` removes only the `fake-*` files. It does
write into your real home folders, so run `clean` when you're done. See
[INSTALLATION.md](INSTALLATION.md#verifying-a-fresh-install).

To try one agent's hook by hand, pipe a payload into the repo copy of the event script and look
at the file it writes:

```sh
echo '{"hook_event_name":"PermissionRequest","session_id":"try-1","cwd":"/tmp"}' \
  | node Scripts/votive-event.js --agent codex
cat ~/.votive/events/codex--try-1.json
echo '{"hook_event_name":"SessionEnd","session_id":"try-1"}' \
  | node Scripts/votive-event.js --agent codex      # deletes it again
```

## Coding conventions this codebase follows

These aren't enforced by tooling — they're patterns already consistent across every file, worth
matching if you're extending it:

- **Every file opens with a doc comment on its primary type** (`///` in Swift, a `//` block in
  the scripts) explaining what it is and, where non-obvious, *why* it's structured the way it
  is. Comments explain the **why**, not the what — e.g. `StatusResolver.swift`'s comment on
  why attention states clear themselves, not a restatement of the code. Update it in the same
  edit that changes the file's behavior.
- **`// MARK: -` sections** divide larger Swift files by responsibility (e.g.
  `StatusItemController.swift` has `Update`, `Usage pulse`, `Icon rendering + animation`,
  `Menu`, `Usage rows`, `Per-agent action submenu`, `Prompt snippets`, `Actions`, `Debug`).
- **Small value types over classes** for anything that crosses a thread boundary or gets
  diffed — `AgentSession`, `AgentState`, `RegistryEntry`, `OverlayEntry`, `UsageSnapshot` are
  all `struct`/`enum` and `Equatable` where they need to be compared (see `StatusCoordinator`'s
  diff-before-publish).
- **Pure functions for decision logic.** `StatusResolver.resolve` and `resolveEvent` take only
  their arguments and return a value — no captured state, no I/O. `agents.js`'s `normalize` is
  the same on the script side. Keep new precedence or mapping rules in that shape.
- **Hook scripts never disturb the agent.** Anything an agent runs (`votive-event.js`,
  the status-line wrapper) always exits 0, prints nothing it wasn't asked to, swallows every
  error and has a hard timeout. Several agents feed hook stdout back to the model or block on a
  non-zero exit.
- **Defensive I/O, never a hard failure.** Every file read tolerates a half-written file with a
  short retry-then-skip (`SessionRegistry`, `OverlayStore`), and every directory-missing case
  is retried rather than treated as fatal (`StatusCoordinator`'s self-healing watch). Scripts
  write through temp file + rename (`overlay-paths.js` `writeJsonAtomic`, `settings-io.js`
  `saveFile`) so a watcher never sees half a file.
- **Threading discipline.** All scanning/I/O work happens on `StatusCoordinator.workQueue` (a
  single serial queue; `UsageStore` has its own); all AppKit calls happen on main, reached only
  via `DispatchQueue.main.async`. Don't touch `NSStatusItem`, `NSMenu`, or any `NSView` off
  main; don't do file I/O or process probing on main.
- **Zero third-party dependencies in the app.** AppKit + Foundation + Darwin only; the scripts
  use only Node's standard library. The MCP server's one dependency is the official MCP SDK.
- **Write only inside `~/.votive/`.** The app and the runtime scripts never write into
  an agent's own state (`~/.claude/sessions/` and `history.jsonl` are read-only inputs). The
  only writes to agent config files are the installers', and those go through `settings-io.js`
  (backup first, additive, reversible with `--remove`).

## Common extension points

### Add an agent

Adding an agent is script work only; the app needs no change unless you want a nicer display
name.

1. **Adapter** — add an entry to `ADAPTERS` in `Scripts/agents.js`: `name`, and lists of
   payload fields (dotted paths allowed, e.g. `workspace_roots.0`) for `event`, `session`,
   `cwd`, `prompt` and `transcript`, plus a `map` from the agent's event names to
   `starting | working | done | waiting | error | end`. Matching is case-insensitive; a value
   can be a function `(payload, lowerName) => state | null`; `'*'` catches unlisted names. If
   the agent's payload has no event name, leave `event` empty and have its hook pass
   `--event <name>`. If it has no session id, the event script keys the session by host pid.
   Only map to `waiting` for a genuine "needs your approval" event — not for idle reminders.
2. **Installer entry** — add an entry to `AGENTS` in `Scripts/install-agents.js` with
   `detect` (config folder relative to `$HOME`, or a command name) and a `style`:
   - `nested` or `flat` for a JSON config: `file`, `events` (the agent's event names to hook)
     and `entry()` returning one hook object built with `cmd('<id>')`;
   - `file` for a file that belongs entirely to us: `file` and `content()` (put a template in
     `Scripts/integrations/` if it's more than a few lines);
   - `manual` when the format is unconfirmed or not JSON, and document the steps in
     `docs/AGENTS.md`.
   Add a `note` if the user has to do something after install (like Codex's `/hooks` trust).
3. **Display name** — add the id to `AgentKind.names` in `Models/OverlayEntry.swift`
   (otherwise the id is title-cased: `my-agent` → "My Agent").
4. **Tests** — add sample payloads, copied from the agent's hook documentation, to `CASES` in
   `tests/agents.test.js` (at least session start, a working event, the waiting event if any,
   turn end, and session end), and extend the installer tests for its config style.
5. **Docs** — a row in the tables in `docs/AGENTS.md` and `README.md`.

If the agent writes plan usage somewhere a local script can read, write it to
`~/.votive/usage/<agent>.json` in the documented format (see
[ARCHITECTURE.md § Plan usage](ARCHITECTURE.md#plan-usage)); `UsageStore` picks up any file
there with no app change. Codex's `usage: 'codex-rollout'` in `agents.js` is the example.

### Other extension points

- **Add a new visual state.** Add a case to `AgentState` (`Models/AgentState.swift`) with its
  color, label, and whether it pulses; add its shape to `MenuBarIconRenderer.shape(for:)`;
  decide where it fits in both of `StatusResolver`'s functions
  ([ARCHITECTURE.md](ARCHITECTURE.md#state-resolution)). If it's driven by a new hook state,
  add the state name to `STATES` in `Scripts/agents.js`, map events to it in the adapters, and
  handle it in `StatusResolver.resolveEvent` (unknown `lastEvent` values are hidden).
- **Add a per-session row action.** Add an `NSMenuItem` in
  `StatusItemController.actionsMenu(for:)`, an `@objc` handler under `// MARK: - Actions`, and
  route through the existing `SessionRef` represented-object pattern if it needs the session's
  pid/cwd/id.
- **Add a menu toggle.** Follow the `shapesMode` / `notificationsOn` / `dialogAlertsOn` pattern:
  a computed property backed by `UserDefaults`, an `addToggle(...)` call in
  `menuNeedsUpdate`, and an `@objc` handler that flips it.
- **Change alert copy or add a new transition to alert on.** Edit
  `StatusItemController.detectTransitions` — a single `switch` over the alerted states; each
  case calls `alert(_:title:body:)`, which already handles the notification→panel fallback.

## Design constraints to respect

From `ARCHITECTURE.md`'s design principles — worth restating here because they're easy to
accidentally violate while adding a feature:

1. Any new background work belongs on `StatusCoordinator.workQueue`, not a new ad-hoc queue,
   unless it genuinely needs independent scheduling (as `UsageStore` does).
2. Any new state or alert must degrade gracefully if its data source is unavailable (agent not
   installed, hook not wired, no usage file, no notification permission, no Automation
   permission) — never let a missing optional turn into a crash or a stuck state.
3. Don't add a timer that runs when there's nothing to do. The liveness timer and the animation
   timer exist only while there's something to watch for; `UsageStore`'s once-a-minute tick is
   the one exception, so usage windows expire on time.
4. Don't introduce a dependency. If a task seems to need one, first check whether
   Foundation/AppKit/Darwin (or Node's standard library, for scripts) already expose what's
   needed, as `Liveness.swift` and `TerminalFocus.swift` do via raw `sysctl`/`kqueue`.
5. Don't put agent-specific logic in the app. Anything that depends on how one agent names its
   events or fields belongs in `agents.js`; the app only knows the normalized event file. The
   Claude Code registry join is the one exception.
