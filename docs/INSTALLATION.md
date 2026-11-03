# Installation guide

What `install.sh` actually does, the permissions macOS will ask you for and why, how to verify
the install worked, how to uninstall cleanly, and how to troubleshoot the common failure modes.
Per-agent details (which events are hooked, manual setup for Goose, Cline, Amp and Aider) are in
[AGENTS.md](AGENTS.md).

## Install from a download (no Xcode needed)

Get `Votive-<version>-mac.zip` from the [latest release](https://github.com/kaustubhsawant-it/votive/releases/latest),
unzip it, and in Terminal run `./Scripts/install.sh` from inside the unzipped folder. It needs only Node.js.
Do not double-click `Votive.app`: it is ad-hoc signed and not notarized, so macOS refuses it. The installer
does the same steps as a source install except that it builds nothing, clears the "downloaded from the
internet" flag on the one app it copies, and keeps a copy of the MCP server and its helper scripts in
`~/.votive/release/` (so you can delete the download folder). Check the zip with
`shasum -a 256 -c SHA256SUMS.txt`. The steps below describe the source install.

## Install

```sh
cd votive
./Scripts/install.sh
```

It first checks that `xcodegen`, `xcodebuild`, `node` and `npm` are on your `PATH` and stops
before touching anything if one is missing. Then it does the following, in order, and is safe
to re-run (idempotent):

1. **Builds Release.** `xcodegen generate` (regenerates `Votive.xcodeproj` from
   `project.yml`), then `xcodebuild ... -configuration Release build`. Fails loudly (`set -euo
   pipefail`) if either step fails, or if the built `.app` isn't found afterward.
2. **Installs the app.** Copies the built `Votive.app` to `~/Applications/`, removing
   any previous copy first, then re-signs it ad-hoc (`codesign --force --deep --sign -`) —
   necessary because copying can invalidate the original signature.
3. **Installs the scripts.** Creates `~/.votive/` with `events/` and `usage/` (mode
   `700`) and copies the runtime scripts into `~/.votive/bin/`:
   `votive-event.js` (the hook every agent runs), `agents.js`, `overlay-paths.js`,
   `votive-statusline.js`, `votive-notify.js` and `notify-core.js`.
4. **Migrates an older install, once.** Versions before 1.1.0 kept their files under
   `~/.claude/` (`~/.claude/agent-overlay/`, `~/.claude/agent-overlay-usage/`,
   `~/.claude/agent-overlay-snippets.json`, scripts in `~/.claude/hooks/`). The installer moves
   your saved status line (`wrapped.json`) and your snippets file into `~/.votive/` if
   they aren't there yet, and deletes the rest. Old hook entries in `~/.claude/settings.json`
   are upgraded in step 5.
5. **Wires every detected agent.** Runs `node Scripts/install-agents.js`. An agent counts as
   detected when its config folder exists or its command is on your `PATH`. For each one:

   | Agent | File changed | How |
   |---|---|---|
   | Claude Code | `~/.claude/settings.json` | one hook group per event appended under `hooks` |
   | Codex CLI | `~/.codex/hooks.json` | same format as Claude Code |
   | Gemini CLI | `~/.gemini/settings.json` | same format, with `matcher: "*"` |
   | Qwen Code | `~/.qwen/settings.json` | same format as Claude Code |
   | Cursor | `~/.cursor/hooks.json` | one `{command}` entry per event under `hooks` |
   | Windsurf | `~/.codeium/windsurf/hooks.json` | one `{command}` entry per event under `hooks` |
   | Copilot CLI | `~/.copilot/hooks/votive.json` | a file of its own |
   | OpenCode | `~/.config/opencode/plugins/votive.js` | a plugin file of its own |
   | Goose, Cline, Amp, Aider | — | prints "needs manual setup"; see [AGENTS.md](AGENTS.md#manual-setup) |

   For the JSON files it edits:
   - a missing or empty file counts as `{}`; a file that isn't a JSON object, or whose `hooks`
     value isn't an object, is refused and left unchanged (the other agents still get wired);
   - the file is backed up to `<file>.bak-<ISO-timestamp>` (same permissions as the original)
     only when something is about to change;
   - our entries are appended next to yours; existing hooks are never edited. An entry from a
     pre-1.1.0 install is replaced with the current one;
   - the write is atomic and follows symlinks, so a symlinked config stays a symlink.

   **Codex:** Codex doesn't run a new hook until you trust it. Open Codex once and approve the
   Votive hooks in `/hooks`; the installer prints a reminder.
6. **Claude Code extras** (only when `~/.claude` exists or `claude` is on your `PATH`):
   - **Plan-usage status line.** Runs `Scripts/install-statusline.js`, which saves your current
     `statusLine` (if any) to `~/.votive/usage/wrapped.json` and points `statusLine` at
     `~/.votive/bin/votive-statusline.js` (backing up `settings.json` first). The
     wrapper records `rate_limits` from Claude Code's status-line input to
     `~/.votive/usage/claude-code.json`, then runs your old command with the same input,
     so your status line looks the same, with one task-status segment in front of it
     ([STATUS_LINE.md](STATUS_LINE.md); add `--no-task` to the command to hide it). Claude Code only includes `rate_limits`
     for claude.ai subscription logins; with an API key the usage rows never appear. A
     `statusLine` of an unexpected shape is left alone, with a warning.
   - **Notify.** Installs the MCP server's dependencies (`npm install --omit=dev` in
     `mcp-server/`, first run only), registers it with `claude mcp add --scope user
     votive -- node <repo>/mcp-server/index.js` (removing any previous registration
     first), and copies the `/notify` command to `~/.claude/commands/notify.md`. The MCP server
     runs from the repo folder, so keep the clone where it is. For other agents, see
     [AGENTS.md](AGENTS.md#let-me-know-when-its-done-from-any-agent).
7. **Installs and loads the LaunchAgent.** Writes
   `~/Library/LaunchAgents/dev.votive.Votive.plist` from the
   `Scripts/dev.votive.Votive.plist` template (with the real app binary path
   substituted in place of `__APP_BINARY__`), unloads any previous instance
   (`launchctl bootout`, waited out since it's asynchronous), then `launchctl bootstrap` +
   `launchctl kickstart -k` to load and start it immediately.

When it finishes, the dot-row icon should already be visible in your menu bar — no separate
launch step, no login/logout required.

### Adding an agent later

If you install another agent after Votive, wire it without rebuilding:

```sh
node Scripts/install-agents.js                 # wire everything detected (already-wired agents are skipped)
node Scripts/install-agents.js --only gemini   # or just one (ids: claude-code, codex, gemini, qwen,
                                               #   cursor, windsurf, copilot, opencode)
node Scripts/install-agents.js --list          # show what's detected, change nothing
```

### What auto-start actually means

The LaunchAgent (`dev.votive.Votive.plist`) sets `RunAtLoad` and a conditional `KeepAlive` — the app
starts at every login and macOS relaunches it automatically if it crashes (a normal **Quit** stays
quit until your next login, or until you open Votive again)
(`ProcessType: Interactive`, `LimitLoadToSessionType: Aqua`, so it only loads in a real GUI
login session, never headless/SSH).

## Upgrading from Agent Overlay

Votive is the new name of Agent Overlay. If you have the old one installed, pull the new source and
run `./Scripts/install.sh` again. It moves `~/.agent-overlay/` to `~/.votive/` (a move, never a copy
or a delete), leaves a link and thin scripts at the old names so agent sessions that are already
running keep working until you restart them, points every agent's hooks and the Claude Code status
line at the new scripts, removes the old login item and `Agent Overlay.app`, and registers the MCP
server under its new name, `votive`. To see what it would do first: `node Scripts/legacy-migrate.js --dry-run`.

## Permissions you may be asked for

| Permission | When | Why | If denied |
|---|---|---|---|
| **Notifications** | First launch (`Notifier.setup()`) | To show a Notification Center banner when a session finishes/needs you/errors/stops | Alerts fall back to a small in-app panel automatically — nothing breaks, see [ARCHITECTURE.md](ARCHITECTURE.md#alerts-two-independent-delivery-paths). Ad-hoc-signed builds like this one are frequently refused registration entirely by Notification Center regardless of what you click, which is exactly why the panel fallback exists. |
| **Automation** (control Terminal.app / iTerm2) | First time you click a row to focus its terminal | To select the exact tab by tty, not just raise the app | Clicking a row still raises the *app* (via `NSWorkspace`, no permission needed) — you just land on whatever tab was last active instead of the exact one. |

Neither permission is required for the app to run. They're requested on different triggers,
though: **Notifications** is requested on every app launch
(`AppDelegate.applicationDidFinishLaunching` calls `Notifier.shared.setup()` regardless of
whether anything notification-worthy has happened yet) — since `install.sh`'s last step starts
the app immediately via `launchctl kickstart`, this prompt typically appears as a side effect of
installing. **Automation** is only triggered the first time you click a row to focus its
terminal.

## Verifying a fresh install

```sh
./Scripts/fake-data.sh
```

Writes synthetic sessions in every state — Claude Code registry entries under
`~/.claude/sessions/` and event files under `~/.votive/events/`, plus a working Codex
row and a waiting Gemini CLI row — backed by one real long-lived helper process so liveness
checks pass. Within a moment the dots appear in the menu bar, and the dropdown shows a
`fake-*` name, the agent name and a state for each row. Clean up afterward:

```sh
./Scripts/fake-data.sh clean
```

To confirm an agent's hook is really wired (rather than relying on `fake-data.sh`, which
bypasses it), start a new session in that agent and send a prompt. The dot should turn yellow
while it works and green when the turn ends; agents that report a session start (Claude Code,
Codex, Gemini CLI, Qwen Code, Copilot CLI, Cursor, OpenCode) show a blue dot before the first
prompt. After
any event you should find a file named `<agent>--<session id>.json` in
`~/.votive/events/`.

## Uninstall

```sh
./Scripts/uninstall.sh
```

This:
- unloads and removes the LaunchAgent and deletes `~/Applications/Votive.app`;
- runs `node Scripts/install-agents.js --remove`, which removes only Votive's hook
  entries from every agent config it knows (whether or not the agent is still installed),
  backing up each file before changing it, and deletes the Copilot CLI hooks file and the
  OpenCode plugin;
- restores the Claude Code `statusLine` you had before
  (`node Scripts/install-statusline.js --remove`, which puts back the exact original object, or
  removes `statusLine` if there was none);
- deletes `~/.votive/bin/`, `~/.claude/commands/notify.md`, and the Claude Code
  `votive` MCP registration.

It deliberately does **not** delete `~/.votive/` itself — `events/`, `usage/` and
`snippets.json` are left in place; delete the folder if you want nothing left behind. If you
registered the MCP server with another agent yourself, remove it there too. Manual setups
(Goose, Cline, Amp, Aider) are yours to remove; once the scripts are gone their hook commands
fail silently. Every edited config has a `.bak-<timestamp>` copy next to it if you want to go
back to an exact earlier version.

## Troubleshooting

**No dots appear for an agent.**
Check `~/.votive/events/` while a session of that agent is open. If no file for that
agent appears after you send a prompt, its hook isn't running:
- Run `node Scripts/install-agents.js --list` to see whether the agent is detected, then
  `node Scripts/install-agents.js --only <id>` to wire it.
- Confirm the agent's config (table in [Install](#install) step 5) contains an entry that runs
  `~/.votive/bin/votive-event.js`, and that the file exists there. If it doesn't,
  re-run `./Scripts/install.sh`.
- Confirm `node` is on the `PATH` the agent uses for hooks.
- The installer assumes each agent's config is in its default location. Overrides like
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` aren't supported.

If the file does appear but no dot shows, launch the app with `VOTIVE_DEBUG=1` from a
terminal (see [DEVELOPMENT.md](DEVELOPMENT.md#debug-logging)) and watch stderr for the per-scan
`name=state` log line.

**Codex sessions never show up.**
Codex skips hooks it hasn't been told to trust. Open Codex, go to `/hooks`, and approve the
Votive entries. Then start a new session.

**A Cursor session shows up as Cursor, not Claude Code (or vice versa).**
Cursor runs Claude Code's hooks by default. Events that come from Cursor are recognized by
their payload and labelled Cursor on purpose, so they don't create phantom Claude Code
sessions.

**Claude Code dots show yellow/green/red but never purple/orange/blue (3-color mode).**
Claude Code sessions still appear from Claude Code's own registry (`~/.claude/sessions/`)
without our hook, but only in these colors. Check that `~/.claude/settings.json` has hook
entries running `votive-event.js --agent claude-code` (re-run
`node Scripts/install-agents.js --only claude-code`; it's idempotent), and that
`~/.votive/events/` exists (the app creates it on next launch if missing).

**The dropdown says "Usage: waiting for an agent to report".**
Usage comes only from Claude Code and Codex, and only after the agent has reported it:
- **Claude Code:** the numbers arrive through the status line, so they appear after a reply in
  a session logged in with a claude.ai plan. Check that `~/.claude/settings.json`'s
  `statusLine.command` mentions `votive-statusline.js` and that
  `~/.votive/usage/claude-code.json` exists after the next reply. If you (or another
  tool) replaced `statusLine` later, re-run `node Scripts/install-statusline.js`; it wraps the
  new command.
- **Codex (experimental):** usage is read from the session transcript when a turn ends, so it can
  appear after the first finished turn (with the hooks trusted). Look for
  `~/.votive/usage/codex.json`. If it never appears, Codex did not write rate limits into
  that session; this is a known upstream gap, not something to repair here.

Other agents don't store usage anywhere readable, so they never get a usage section. A limit
also disappears once its reset time has passed.

**`notify` says it can't find the session.**
The notify tool matches the calling process against Claude Code's registry or the pid recorded
in an event file. For any agent other than Claude Code, the session must have reported at least
one event first (send one prompt), and the agent's hook must be wired.

**Clicking a row doesn't raise the terminal window.**
Check whether the process is actually still alive — a `stopped` (red) row's process is gone,
so there is no window to raise. A row with no known process opens its folder in Finder instead.
For a live session that still won't focus, check System Settings → Privacy & Security → Automation, and
confirm "Votive" is allowed to control Terminal or iTerm; if it isn't listed at all,
trigger the prompt again by clicking a row for a session hosted in that terminal.

**No notification banners ever show up.**
Expected on an ad-hoc-signed build much of the time — see the permissions table above.
Automatic alerts are off by default: turn on **Settings → Alerts → Banner on every state
change** and/or **Pop-up on every state change**. The pop-up needs no permission at all. If
neither shows anything, check System Settings → Notifications → Votive isn't set to
"None".

**A pop-up appears every time any session finishes or hits a problem.**
**Settings → Alerts → Pop-up on every state change** (or **Banner on every state change**) is
on. Click it to turn it off. **When a session asks to notify me** is separate: it only fires
when you asked a session to let you know, so it can stay on.

**The installer refuses to edit a config file.**
It prints `Refusing to edit <file>: …` when the file isn't valid JSON, isn't a JSON object, or
has a `hooks` value that isn't an object. Nothing in that file was changed and the other agents
were still wired. Fix the file (or move it aside) and run
`node Scripts/install-agents.js --only <id>`.

**Install fails at the `xcodegen generate` step.**
`xcodegen` isn't on `PATH`. `brew install xcodegen`.

**Install fails at the `xcodebuild` step.**
Run the failing command directly (drop the `>/dev/null` redirect in `Scripts/install.sh` or run
`./Scripts/build.sh`, which doesn't redirect output) to see the actual compiler error — usually
a missing Xcode Command Line Tools install (`xcode-select --install`) or an Xcode license that
hasn't been accepted (`sudo xcodebuild -license accept`).

**`launchctl bootstrap` fails / the app doesn't survive a logout.**
Check `launchctl print gui/$(id -u)/dev.votive.Votive` for its current state. The
installer already retries once with a short delay if the previous instance was still tearing
down; a persistent failure here usually means a stale, permission-mismatched plist —
`./Scripts/uninstall.sh` then `./Scripts/install.sh` again resolves it.
