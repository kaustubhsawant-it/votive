# Changelog

All notable changes to Votive (called Agent Overlay until 2026-10-26) are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [1.8.0] — 2026-11-02

This release also carries everything in 1.7.1 below, which was never published on its own (the downloadable zip and the new README front page).

### Added
- **The Votive window** (menu bar: **Open Votive…**, or **All Settings…**). A native SwiftUI window with a sidebar:
  Overview, Forecast, Habits and History for your plan usage, and General, Alerts, Sounds and Agents & tools for every
  setting the menu has (the same preferences, so a change shows in the menu bar at once and the other way round).
  The menu-bar item stays the always-on part; the window is the detailed part. It uses Liquid Glass on macOS 26 and
  system materials on macOS 14 and 15 (the app still runs on macOS 14), the system font and SF Symbols only, and while
  it is open Votive appears in the Dock like any Mac app and goes back to menu-bar only when you close it.
- **Insights card** at the foot of the window's sidebar: a few ranked, plain-language things worth knowing (sessions
  that need you, a limit close to full, the forecast, settings agents changed), one card at a time, critical first,
  "all clear" only when nothing is urgent, at most six, each with one action that opens the right page. It turns every
  6 s (15 s while the pointer is over it), not at all with Reduce Motion, and can be switched off under General.
- **Usage habits** (`node ~/.votive/bin/usage-habits.js`). Learns from your own usage history when you use your plan
  (weekday or weekend, hour of day), forecasts the weekly limit at the reset with a range, and says what that means in
  plain sentences. A small statistical model, not a neural network: the history is a few points an hour, so it would
  only memorise it. It tests itself on days it has not seen and says when it is no better than an average day. Reads
  the history file only; writes nothing, opens nothing, never acts.
- **Reorder the dots.** Hover a session and choose **Move earlier** or **Move later** to change where its dot sits in
  the menu bar (and its row in the menu). A move stays inside the session's own group, so it never pins, unpins or
  changes priority: pinned sessions keep their place at the front. The order is kept in preferences.

### Fixed
- **Usage habits** counted hours from UTC, not from your wall clock, so in a half-hour zone such as India (UTC+5:30) every
  hour was 30 minutes off; hours now start on the local hour. A day's start was also taken from the first hour found
  rather than the earliest, which made the model's self-test score the wrong 24 hours after a long gap; both fixed and tested.

### Changed
- The two priority items are named for what they do: **High priority: this session**, and **High priority: every
  session in this folder, now and later** (a standing rule). A session that is high priority only because of its
  folder shows a dash in the first item instead of an empty box.

## [1.7.1] — 2026-11-01

### Added
- **Downloadable release.** Each release now carries `Votive-<version>-mac.zip` (a universal app for Apple Silicon
  and Intel, the scripts, and an installer) and `SHA256SUMS.txt`, so Votive installs without Xcode or XcodeGen:
  unzip it and run `./Scripts/install.sh` (Node.js is the only requirement). The app is ad-hoc signed and not
  notarized, so use the installer, not a double-click. Built by `Scripts/make-release.sh`.
- `Scripts/install.sh` has a download mode: when it sits next to `Votive.app` it builds nothing, clears the
  "downloaded" flag on the one app it installs, and keeps the MCP server and its scripts in `~/.votive/release/`.

### Changed
- README, INSTALLATION, SECURITY and PRIVACY describe both ways to install and what you trust in each.
- The quick guide's install steps use the download.
- **The repo's front page.** A light and dark banner, badges, pictures of the menu bar and the menu, and a two-minute
  install block at the top of the README; issue forms for bug reports and ideas; `CONTRIBUTING.md`.

## [1.7.0] — 2026-10-31

### Added
- **High priority sessions.** Hover a session and choose **High priority**: it sorts first in the menu and in the
  menu-bar dots (in the order you pinned them), shows a small pin, and keeps its dot when there are more than six
  sessions. **Settings › Alerts › Only alert for high-priority sessions** (off by default) limits banners, pop-ups and
  state-change sounds to those sessions; a message you asked a session to send is never filtered. Pins are kept in
  preferences, not in a new file, and dropped 14 days after a session stops. **High priority for every session in this
  folder** makes every new session started in that exact folder high priority, so you do not pin each one; remove the
  rule under Settings › Alerts › High priority folders. Not reachable from the MCP tools.

### Changed
- **Quick guide.** A three-page illustrated guide, `docs/Votive-Quick-Guide.pdf`: what Votive does, how to install it,
  what each dot means, the menu, and fixes.
- **New app icon.** Three overlapping lights (yellow, green, purple) blending where they meet, on a dark tile. Smooth
  gradients, no gloss, and it stays readable down to 16 pixels. The menu-bar dots are unchanged.

## [1.6.0] — 2026-10-31

### Fixed
- **Quit Votive now stays quit.** The login item restarted the app after a normal Quit within about two
  seconds (its `KeepAlive` was unconditional). It now restarts only after a crash. Run `./Scripts/install.sh`
  again to update the installed login item.

### Added
- **Ports: Pause switch and the all-ports view.** In **Settings → Developer tools → Ports**, each of your
  own programs on a port now has a **Pause** switch (freezes the program with SIGSTOP, keeps its port;
  click again to resume) next to **Stop**. **All listening ports** lists everything that listens: the
  program, the folder it was started from, whether only this Mac or your network can reach it, and what
  the port is usually for; macOS and other users' programs are listed read-only. Programs Votive paused are
  remembered in `~/.votive/paused.json` and re-checked on every read; quitting Votive asks whether to
  resume them (logging out or shutting down resumes them silently). Stop on a paused program continues
  it first. Stop and Pause add a warning on database ports. Still never an agent session, Votive itself,
  another user's program or a macOS program, and not reachable from the MCP tools.

## [1.5.0] — 2026-10-30

### Changed
- **Renamed to Votive** (it was Agent Overlay). The app is `Votive.app` (bundle id `dev.votive.Votive`),
  the data folder is `~/.votive/`, the scripts are `votive-event.js`, `votive-statusline.js` and
  `votive-notify.js`, the MCP server is `votive` (its tool is `mcp__votive__notify`), and the
  environment variables start with `VOTIVE_`. Nothing about how it works changed.
- **Upgrading needs one step: run `./Scripts/install.sh` again.** It moves `~/.agent-overlay/` to
  `~/.votive/` (nothing is copied or deleted), leaves a link at the old path and thin scripts under
  the old names so agent sessions that are already running keep reporting until they restart, rewires
  your agents' hooks and the status line to the new scripts, removes the old login item and
  `Agent Overlay.app`, and re-registers the MCP server. The app copies its menu settings from the old
  app on first launch, except **Let agents change settings**, which you allow again on purpose.
- macOS treats the renamed app as a new app: expect one more notification permission prompt and,
  the first time you click a session, one more Automation prompt for your terminal.
- If you allowed `mcp__agent-overlay__notify` in a Claude Code permission rule, allow `mcp__votive__notify` too.

### Added
- **Ports (developer tools, off by default).** **Settings → Developer tools → Ports** adds a
  **Ports** item to the menu: a short list of ports you watch, whether each is free or in use and by
  which program, and **Stop** to free one. It asks first, names the program, sends a normal quit
  (SIGTERM) and offers a force quit only if that fails. It will not stop an agent session, Votive,
  another user's program or a macOS program, and the MCP tools cannot reach it. Reads the listening
  ports with `/usr/sbin/lsof` (fixed arguments, no shell); the list is `~/.votive/ports.json`.
- **Caffeinate.** One click on **Caffeinate** in the menu keeps the Mac from sleeping or
  locking from being idle, on battery too; click again to turn it off. While it is on the
  menu-bar icon sits in a capsule with a bright comet running round its edge (a steady edge
  instead when Reduce motion is on), and the red limit pulse fills the same capsule. It is
  never remembered: after a quit or restart it starts off, so it can't drain a battery
  unnoticed. It does not stop a manual lock, a lid close, or the forced sleep at very low
  battery.

### Changed
- **The menu bar says which limit is hot.** While a plan limit is over 70%, the icon loops:
  the dots on the breathing red background, then a fade to the limit's name ("Weekly"), then
  its number ("74%"), then back to the dots, about every 9 seconds. Several limits over → each
  gets its name and number, worst first (up to three); with more than one agent reporting, the
  name includes the agent ("Codex Weekly"). The icon keeps one width through the loop so items
  next to it don't move, and Reduce motion swaps the fades for cuts. The menu toggle is now
  **Show limits over 70% in the menu bar** (same `usageAlertOn` setting).

## [1.4.0] — 2026-10-03

### Added
- **Sounds, from the app itself.** A sound per event: notify, needs you, error, stuck, stopped
  and done, each with its own choice under **Settings → Sounds**, plus a **Play sounds** master
  switch. They play for every agent the app watches, even with banners and pop-ups off. Out of
  the box only the notify chimes (Glass). Pick a macOS sound, or **Add Sound File…** to use your
  own: it's copied into `~/.agent-overlay/sounds/`, so moving the original can't silence it.
  macOS ships its sounds quiet, so every sound is played at full level. One sound per scan,
  the most important event winning. Also settable as `sounds`, `soundNotify`, `soundDone`, …
  through `overlay-settings.js` or the MCP `settings` tool. This replaces `afplay` hooks in
  your agent's config.
- **Task status in the Claude Code status line.** One segment in front of your status line
  shows what the session is really doing, e.g. `● Deploying to c.local · 3/6 · 50% · 2m`,
  `⏸ Waiting on you: merge?`, `⏸ Stopped · 4/6 done`, `✓ Done 6/6`, `✗ Error: …`. Everything
  after it is byte-for-byte your previous status line. `--no-task` on the statusLine command
  turns it off. See [docs/STATUS_LINE.md](docs/STATUS_LINE.md).
- **Progress from the agent's own task list**, never from time: Claude Code TodoWrite and
  TaskCreate/TaskUpdate, Codex update_plan, Gemini write_todos, Cursor todo_write. With no
  task list, only the state and the time in it are shown.
- **Elapsed time in the current state or step**, so one long step doesn't look frozen.
- The segment is capped at 40 columns, so it can't push your status line off the screen.
- **Background work isn't "done".** A Claude Code turn that leaves background agents or
  commands running shows `◐ 4 agents running · 3m`, counting down live as their task
  notifications arrive, then falls back to done/stopped.
- **`drop` list** in `wrapped.json` removes items such as GSD's `⬆ /gsd:update` from the
  wrapped status line, leaving the rest byte for byte.
- **Meristem segment** in Meristem workspaces (`⟳ 3 behind · 2 to review`). It's served from
  a cache and refreshed in the background every 15 s at most, so it never adds latency.
  `--no-meristem` turns it off.

### Changed
- **A turn that ends on a question is no longer "done".** At Stop the hook checks the last
  assistant message, from the payload or the transcript tail (256 KB, never the whole file).
  A question or request for approval is recorded as waiting. Open task-list items are recorded
  as waiting with `waitReason: "open-tasks"` (shown as Stopped). A Codex Interrupt is left
  as done.
- Event files gain `stateSince`, `plan`, `planAt`, `promptAt`, `waitReason` and `detail`. The
  app ignores them. A new prompt clears a finished or abandoned (untouched for 10 min) task list.

### Fixed
- Concurrent hooks (parallel tool calls) could overwrite each other's update to the event file.
  Writes are now serialized with a short lock, and each turn's task list is re-checked against
  the transcript at Stop.
- New script `progress.js` in `~/.agent-overlay/bin/`; re-run `./Scripts/install.sh` after
  updating.

## [1.3.1] — 2026-09-24

### Fixed
- Without Claude Code installed, background rescans multiplied over time and CPU use kept
  growing. The app now keeps a single 10-second check for Claude Code's folder and rescans
  only on real activity.
- Builds with Xcode 15/16 (macOS 14/15 SDKs) failed on the Liquid Glass panel. It's now looked
  up at run time, so any supported Xcode builds the app and macOS 26 still gets Liquid Glass.
- One unreadable agent config (e.g. invalid JSON) no longer stops `install.sh` partway; it's
  reported and the rest of the install completes.
- `diagnose` now checks that every hook points at the current script (it reported partly wired
  or outdated hooks and an old status line as healthy), and `repair` replaces outdated entries
  instead of leaving them in place.
- The stuck threshold only accepts whole numbers; `null`, empty text or `true` no longer turn
  stuck detection off. Settings already at the requested value are reported as unchanged.
- The MCP `repair` tool rejects a non-list `repairs` instead of running every repair, and
  `settings` treats `changes: null` as a read.
- Event files with impossible timestamps are ignored instead of crashing the app.

## [1.3.0] — 2026-09-24

### Added
- **Control Agent Overlay by asking your agent.** The MCP server gains three tools next to
  `notify`: `settings` (read or change any preference, applied to the running app at once),
  `diagnose` (checks the app, login item, scripts, every agent's hooks and the usage status
  line) and `repair` (re-copies scripts, re-wires hooks, re-wraps the status line or restarts
  the app).
- The same from a terminal: `node Scripts/overlay-settings.js` and `node Scripts/doctor.js
  [--fix]`.
- The app now reacts immediately to preference changes made outside its menu, and the stuck
  threshold menu shows custom values.

## [1.2.0] — 2026-09-23

### Changed
- **Native macOS UI throughout.** Usage limits are native `NSLevelIndicator` bars that turn amber
  and then red on their own; the dropdown uses native section headers ("Sessions", per-agent
  usage) and SF Symbol icons; alert panels use Liquid Glass (`NSGlassEffectView`) on macOS 26,
  with the previous blur on macOS 14–15, and current push-button styles.
- **Settings submenu.** The toggles moved out of the main dropdown into **Settings**, grouped
  into "Menu bar" and "Alerts". The two automatic-alert switches are now named for what they
  do: **Banner on every state change** and **Pop-up on every state change** (both still off by
  default), next to **When a session asks to notify me**.

## [1.1.1] — 2026-09-23

### Fixed
- Session rows in the dropdown now stretch to the menu's full width, so their text and arrow
  line up with the other menu items. Long names and prompts are cut off with "…" instead of
  running under the arrow, and the arrow matches the native submenu arrows.

### Added
- `PRIVACY.md`: everything the app reads, writes and runs, and how to verify each claim.
- `SECURITY.md`: security design, known limits, and private reporting.
- `tests/no-network.test.js`: fails if networking code, entitlements or new MCP server
  dependencies are added.

## [1.1.0] — 2026-09-23

Agent Overlay now works with any agentic coding tool, not only Claude Code.

### Added
- **Works with any agent.** Hooks are wired automatically for Claude Code, Codex CLI, Gemini
  CLI, Qwen Code, Copilot CLI, Cursor, Windsurf and OpenCode. Goose, Cline, Amp and Aider work
  with a few lines of manual config (see `docs/AGENTS.md`), and any other tool that can run a
  command can report through the generic adapter (`--agent <name> --event <state>`).
- One shared hook, `agent-overlay-event.js`, plus a table of per-agent adapters
  (`Scripts/agents.js`). Supporting a new agent is an adapter and an installer entry, not app
  code.
- **Per-agent install and uninstall:** `node Scripts/install-agents.js` wires every detected
  agent; `--only <ids>` wires specific ones, `--list` shows what's detected, and `--remove`
  removes only Agent Overlay's entries. Every config is backed up before it changes.
- **Codex plan usage.** Session and weekly limits are read from the Codex session transcript
  at the end of each turn. The menu shows a usage section per agent, and the red pulse fires
  when any limit of any agent is over 70%.
- **Notify from any MCP-capable agent.** The `notify` tool finds its session through Claude
  Code's registry or the process id recorded in any agent's event file.
- **Agent name on each row** ("Codex · working"), and a recap line from the stored prompt for
  agents other than Claude Code.

### Changed
- All app state moved to `~/.agent-overlay/` (`bin/`, `events/`, `usage/`, `snippets.json`).
  `install.sh` migrates a 1.0.0 install once: it keeps your saved status line and snippets and
  removes the old files under `~/.claude`.
- Event files are now one per agent session (`events/<agent>--<session>.json`) and carry the
  agent, host process id, last prompt and transcript path.
- Sessions of agents other than Claude Code are tracked from their event files alone: dead
  process → stopped for a minute, working with no events for the stuck threshold → stuck.
- `uninstall.sh` now removes the hook entries from every agent's config (backed up first).

## [1.0.0] — 2026-09-23

First public release.

### Added
- One colored dot per running Claude Code session in the menu bar: starting, working, done,
  needs you, error, stuck, stopped. Positions stay stable; attention states pulse.
- Dropdown with each session's name, state, last prompt and host-app icon. Click a row to
  raise its terminal (exact tab in Terminal.app and iTerm2).
- Per-session actions: reveal folder, copy path, copy session ID, open transcript.
- **Plan usage:** session (5-hour) and weekly limits with reset times, read from the
  `rate_limits` field Claude Code passes to the status line. The menu-bar icon pulses red
  while either limit is above 70% (toggleable).
- On-demand "let me know when this is done" alerts through the `agent-overlay` MCP server's
  `notify` tool and the `/notify` command.
- Optional automatic alerts (banners or dialogs) on state changes, off by default.
- Stuck detection with a configurable threshold, colorblind shapes mode, prompt snippets.
- `install.sh` / `uninstall.sh`: Release build, fail-safe hooks, status-line wrapper,
  LaunchAgent. Every edit to `~/.claude/settings.json` is backed up first.
