# Privacy

**Votive sends nothing anywhere.** It has no server, no account, no analytics, no crash
reporting and no update check. The app, the hook scripts and the MCP server make no network
connections of their own, and you build the app yourself from this source. What it learns about
your sessions stays in files in your home folder.

Two things are outside that promise and are listed under
[What leaves your Mac anyway](#what-leaves-your-mac-anyway): what your agent does with tool
results, and what the services you download from log.

This page lists every file Votive reads, writes and runs, so you can check each claim. A test
(`tests/privacy-manifest.test.js`) fails when the code writes a path the
[writes list](#what-it-writes) does not name. [Verify it yourself](#verify-it-yourself) shows
how to check the rest.

## The one time anything touches the network

Building from source needs tools you install yourself first (`brew install xcodegen`, Xcode),
which download from their own sites. Votive's installer then runs `xcodegen` and `xcodebuild`
on your Mac and fetches nothing. *[If the MCP server still uses the npm SDK when this ships, add:
"`npm install` downloads its dependency once; it is pinned by `mcp-server/package-lock.json`."
Delete this note once the server has no dependencies (AGEN-21).]*

## What it reads

| What | Where | Why |
|---|---|---|
| Session state from every agent | `~/.votive/events/*.json` | The dots |
| Plan usage | `~/.votive/usage/*.json` | The usage rows and the red pulse |
| Your prompt snippets | `~/.votive/snippets.json` | The snippets menu |
| Alert sounds you added | `~/.votive/sounds/` | Playing them |
| A sound file you pick | wherever you choose, once, in a file dialog | It is copied into `sounds/` |
| Claude Code's live session list | `~/.claude/sessions/*.json` | Whether each Claude Code session is busy or idle |
| Claude Code's prompt history | `~/.claude/history.jsonl` | The "last prompt" line. Kept in memory, never copied |
| The end of a session transcript | the path the agent reported, 256 KB for most agents, 512 KB for Codex | The hooks and the status-line wrapper read it at the end of each turn, to find the task list, whether the turn ended on a question, background tasks and (Codex) the rate-limit numbers. Only short excerpts are stored (see below) |
| Process information | macOS (`sysctl`, `/bin/ps`, `pgrep`) | Whether a session's process still runs, and which terminal hosts it |
| Agent configuration files | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.qwen/settings.json`, `~/.cursor/hooks.json`, `~/.codeium/windsurf/hooks.json`, `~/.copilot/hooks/` | The installer and `diagnose` check and edit the hook entries |
| Its own preferences | macOS preferences for `dev.votive.Votive` | Your menu settings |
| Which programs listen on which TCP ports, only if you turn on **Settings → Developer tools → Ports** | `/usr/sbin/lsof` (program name, process id, port, whether it listens on this Mac only), then for each program macOS itself (`proc_pidpath`, working folder, whether it is frozen). Command-line arguments are never read. Nothing is sent anywhere. | The Ports item: every listening port, who uses it, free or in use, paused or not |

The app itself reads the first seven rows, process information and, only when you turn Ports on, the list of listening ports. The hooks, the status-line
wrapper, the MCP server and the installers read the rest.

## What it writes

```text writes
# One path pattern per line. ~ is your home folder, * is one path segment, ** is any depth.
# tests/privacy-manifest.test.js fails if the code writes anything not matched here.
~/.votive/bin/*                        # the hook and status-line scripts
~/.votive/events/*.json                # one small file per session; deleted when it ends
~/.votive/usage/*.json                 # plan-usage numbers, and a copy of your old status line
~/.votive/usage/history/*.jsonl       # plan-usage history: percentages and reset times only
~/.votive/audit.jsonl*                 # what agents changed through the MCP tools, and refusals (no messages, no prompts)
~/.votive/budget/*.json                # optional budget mode: settings and counters
~/.votive/settings.json                # Windows: the same settings as the macOS menu
~/.votive/snippets.json                # snippets you add
~/.votive/ports.json                   # optional Ports tool: the port numbers you chose to watch
~/.votive/paused.json                  # optional Ports tool: programs it froze, so none is left frozen unnoticed
~/.votive/sounds/*                     # sounds you add
~/.votive/cache/*                      # short text from the optional meristem command
~/.votive/locks                        # empty folders that last for milliseconds
~/.agent-overlay                       # one link to ~/.votive, left by the one-time move from the name Agent Overlay
~/.votive/from-agent-overlay/*         # only if both folders existed: older items parked, never deleted
~/.claude/settings.json                       # hook entries and the status-line wrapper
~/.codex/hooks.json
~/.gemini/settings.json
~/.qwen/settings.json
~/.cursor/hooks.json
~/.codeium/windsurf/hooks.json
~/.copilot/hooks/votive.json
~/.config/opencode/plugins/votive.js
~/.claude/commands/notify.md
~/**.bak-*                                    # a full copy of a config file before it is changed
```

Beside the list: the installer puts the app in `~/Applications/Votive.app` and a login
item in `~/Library/LaunchAgents/dev.votive.Votive.plist`; the preferences above live
in `~/Library/Preferences/dev.votive.Votive.plist`; registering the MCP server runs
`claude mcp add`, so Claude Code writes its own `~/.claude.json`.

| What | Where |
|---|---|
| Its folders, created if missing | `~/.votive/events/` and `~/.votive/usage/` (readable only by you) |
| Your prompt snippets, when you add one | `~/.votive/snippets.json` |
| The ports you watch, when you add one in the optional Ports tool (a plain list of numbers, at most 24) | `~/.votive/ports.json` |
| Programs the optional Ports tool paused: process id, port, program name and the time the process started (to tell it from a later process that reuses the id). Checked every time it is read, emptied when you resume or quit. | `~/.votive/paused.json` |
| Plan-usage history (percentages and reset times only), when the status-line wrapper runs | `~/.votive/usage/history/claude-code.jsonl` (readable only by you, trimmed past 1 MB) |
| Budget settings, if you use budget mode | `~/.votive/budget/policy.json` (a mode, two levels, a short list of folders) |
| Budget diagnostics counters, if you use the budget mod | `~/.votive/budget/diag.json` (counts per day, last 14 days, under 4 KB) |
| Settings on Windows (the same keys as the menu settings on macOS) | `~/.votive/settings.json` |
| Start with Windows, only if you turn it on in the tray menu | one value, `Votive`, under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |
| Menu settings (toggles, stuck threshold, and the switch "Let agents change settings") | macOS preferences for `dev.votive.Votive` |
| The sessions you marked **High priority**: each one's agent and session id, and when you marked it (at most 50; one you stop using is dropped after 14 days), and the folders you marked (full path, at most 50, kept until you remove them under Settings). Nothing about a session's content. | macOS preferences for `dev.votive.Votive` |
| Settings of the app under its earlier name (Agent Overlay), copied once on first launch; the switch "Let agents change settings" is not copied, so you decide it again | macOS preferences for `dev.votive.Votive` (read from `app.agentoverlay.AgentOverlay`) |
| The one-time move from the name Agent Overlay (run by the installer): moves `~/.agent-overlay` to `~/.votive`, leaves a link at the old path so agent sessions started before the rename keep working, and removes the two adapter files of the old name that are ours (`~/.copilot/hooks/agent-overlay.json`, `~/.config/opencode/plugins/agent-overlay.js`). Reads no credential. | `~/.votive`, `~/.agent-overlay` |
| What agents changed through the MCP tools, and refusals (no messages, no prompts); capped at 200 lines | `~/.votive/audit.jsonl`, written by the MCP server (private, mode 0600); the macOS app only reads it, and its Undo puts back one of the menu preferences above |
| Clean-up | Deletes its own event files for sessions that ended over a day ago |

**Backups.** Before the installer changes a config file it saves a full copy next to it
(`settings.json.bak-<timestamp>`), with the same permissions. A config can hold keys or tokens
you put there, so the copy holds them too. Backups are never deleted automatically. Delete the
ones you no longer need.

## What the hook scripts record

Each agent runs `~/.votive/bin/votive-event.js` from its hooks. For each session it
writes one file to `~/.votive/events/`, holding:

- the agent's name and the session id
- the last state (working, done, needs you, error), when it happened, and when it started
- the session's working folder and the agent's process id
- the first 200 characters of your latest prompt, when the agent includes it
- the path of the session's transcript, when the agent reports it
- the agent's task list: up to 50 items, each cut to 80 characters
- why a session is waiting, with up to about 60 characters of the assistant's last question or of
  an error message, or the name of a tool waiting for approval
- the ids and kinds of background tasks the agent started
- a notify message, when you asked a session to let you know

When a session ends its file is deleted. Not kept: file contents, whole tool inputs or outputs,
whole model responses. Control and invisible characters are removed from stored text, and a file
larger than 256 KB is ignored by the app.

The Claude Code status-line wrapper saves plan-usage numbers (percent used, reset time) to
`usage/claude-code.json` and a copy of the status-line setting it replaced to `usage/wrapped.json`,
then runs your original command. For Codex, the hook reads the newest rate-limit numbers from
Codex's own session file at the end of a turn and saves those numbers to `usage/codex.json`.
Codex does not always record them; when it does not, nothing is shown.

## What runs

- **The app** runs `/bin/ps` to find which terminal hosts a session and `/usr/bin/osascript` to
  select that tab in Terminal or iTerm2 when you click a session. If you turn on the optional
  **Ports** tool it also runs `/usr/sbin/lsof` with fixed arguments (no shell) when you open the menu,
  and, only after you confirm a named program in a dialog, sends it one signal: SIGTERM to ask it to
  quit (a second confirmation is needed for SIGKILL), or SIGSTOP / SIGCONT to pause and resume it.
  A program Votive paused is remembered in `paused.json`; when you quit Votive it asks whether to resume it. It can only signal your own programs, never
  an agent session, Votive itself or a macOS program, and it opens no network socket. No agent can
  reach it: the MCP tools have nothing for ports.
- **The hook** runs `/bin/ps` to find the agent's process id.
- **The status-line wrapper** runs the status-line command you already had. If you use the
  optional `meristem` tool it may run it in the background to show one line of its output.
- **The MCP server** starts only when an agent launches it, talks to that agent over
  stdin/stdout, and opens no port. `diagnose` only reads: it reads the files named above and runs
  `pgrep`. `settings_get` only reads your preferences. `settings_set` changes them and `repair`
  runs the same install scripts you would, and `launchctl` to restart the app; both are refused
  until you turn on "Let agents change settings" in the menu (off by default; no tool can turn it
  on), are rate limited, and each change or refusal is written to `audit.jsonl` and shown to you.
  `notify` shows a panel and is rate limited; the audit line says that one was sent, never what
  it said. A program running as you could still edit the preference or the file: that is outside
  what this guards (see SECURITY.md).
- **`Scripts/overlay-settings.js` and `Scripts/doctor.js`** do the same from a terminal.
- **The installer** runs `xcodegen`, `xcodebuild`, `codesign` (ad-hoc, local), `claude mcp add` if
  Claude Code is installed, and `launchctl` to start the app at login.

Nothing needs administrator rights and nothing runs as root.

## Permissions macOS may ask for

- **Notifications:** for alert banners. Without it alerts show in a small panel.
- **Automation (Terminal / iTerm2):** to select the exact tab when you click a session. Without it
  the terminal app still comes to the front.

The app asks for no other permission: no Full Disk Access, Accessibility, screen recording,
contacts or location. It shows folders and transcript files in Finder; it never opens or runs
them. *[A notarized build also declares the hardened runtime and may add the Apple-events
entitlement; update this paragraph with the real entitlement list when it ships (AGEN-8).]*

## What leaves your Mac anyway

- **Your agent's model provider.** The agent decides what to send. The result of an MCP tool
  call, such as `diagnose` output or the `settings_get` list, goes to whichever model your agent
  uses.
- **Where you download it.** GitHub logs downloads; Homebrew collects install statistics unless
  you run `brew analytics off`; macOS may check a downloaded, notarized app with Apple the first
  time you open it. Votive itself is not part of any of those.

## Removing everything

```sh
./Scripts/uninstall.sh                          # app, login item, scripts, hook entries, status line
rm -rf ~/.votive                         # session files, usage, snippets, sounds, the audit log
defaults delete dev.votive.Votive   # menu settings
```

The installer backed up each config it changed (`<file>.bak-<timestamp>`); delete those too when
you are happy.

## Budget mode, plan-limit notices and the Windows app

These are optional additions. None of them changes the promise above: nothing is sent anywhere.

- **Usage history.** The status-line wrapper adds one small line (percentages and reset times, nothing
  else) to `usage/history/claude-code.jsonl` at most every 5 minutes. The pacing advisor reads it.
- **Budget mod.** An optional Claude Code plugin (`mods/votive-budget`). It runs inside Claude Code
  with your permissions and reads the plan-usage numbers Claude Code gives it. Above the level you set, it can
  deny new subagents, lower reasoning effort and add one fixed notice to a prompt; sessions you mark heavy are
  left alone. It writes only under `~/.votive/budget/`. It never sends a prompt for you, never talks to
  another session, never touches the network or starts a program, and the check that proves it
  (`tests/budget-mod-allowlist.test.js`) fails if any of that is added.
- **Diagnostics and the beta report.** `diag.json` holds counts only (how many times it denied a subagent, and
  so on). `node Scripts/budget-report.js` prints a short block you can paste into a message: settings, usage
  now, counters. It contains no paths, no folder or project names and no prompts, and it sends nothing.
- **Plan-limit notices.** When Claude Code reports a plan limit, the hook writes one fixed sentence (the reset
  time and whether Claude Code continues by itself) into the session's notify field. The sentence is built
  from fixed templates; no text from the payload or from any file is ever put into it. The status-line wrapper
  records the Claude Code version (a plain version number) in the usage file to choose the sentence.
- **Windows app.** It reads the same folders as the macOS app and writes only `settings.json` and, if you
  turn it on, the Run value above. It contains no networking code or packages (checked by
  `tests/windows-source.test.js`), and never sends input to, or reads from, another program.
  Windows Mica/acrylic and rounded corners are drawn by Windows itself.

## Verify it yourself

**1. There is no networking code.** The test suite fails if any is added:

```sh
node --test tests/*.test.js     # includes tests/no-network.test.js
grep -rnE "URLSession|URLRequest|NWConnection|import Network|CFSocket|socket\(" Votive
grep -rnE "require\(['\"](https?|net|tls|dgram|http2)['\"]\)|fetch\(|WebSocket" Scripts mcp-server
```

The greps print nothing.

**2. The running app has no network connections.**

```sh
lsof -nP -a -i -p "$(pgrep -f 'Votive.app/Contents/MacOS')"
```

It prints nothing. For a live view use `nettop -p <pid>` or a firewall such as LuLu or Little
Snitch; the app never tries to connect.

**3. It writes only what is listed.** `node --test tests/privacy-manifest.test.js`, or watch it:

```sh
sudo fs_usage -w -f filesys "Votive" | grep -E "WrData|mkdir|rename|unlink"
```

**4. The app asks for nothing extra.**

```sh
codesign -d --entitlements - ~/Applications/Votive.app
otool -L ~/Applications/Votive.app/Contents/MacOS/Votive   # Apple libraries only
```

**5. See exactly what is stored.**

```sh
ls -la ~/.votive ~/.votive/events ~/.votive/usage
cat ~/.votive/events/*.json ~/.votive/audit.jsonl
```
