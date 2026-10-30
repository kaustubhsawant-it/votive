# Votive for Windows (prototype, AGEN-34)

A native Windows pill and tray icon that shows one dot per agent session, worst state first. It
reads the same `~/.votive/events/*.json` files the hooks already write, so it needs no agent
of its own. C# on .NET 10, WinForms, hand-painted, **no package references** (nothing here may bring
in a network stack or a web engine; `tests/windows-source.test.js` enforces that).

## What it does
- **The pill:** one dot per session, worst state first, six dots then `+N`. Attention states (needs you, error,
  stuck) get a ring, so shape carries meaning too. It never takes focus and is not in the taskbar or Alt-Tab.
  Hover for a tooltip, click to expand, drag to move (floating modes).
- **Where it sits (tray menu, "Where the pill sits"):** **in the taskbar** (inside the bar, just left of the
  tray, centred in its height; the default for taskbar users is your choice), top of the screen, where you
  dragged it (kept on screen if a monitor goes away), or tray icon only. Windows 11 has no supported way to
  draw inside the taskbar, so the pill is a small topmost window placed in the bar's own rectangle and put
  back on top once a second (that timer runs only in this mode). With an auto-hidden or vertical taskbar it
  falls back to the corner beside where the bar is, so it never disappears.
  **Known limit (AGEN-48):** nothing checks where the taskbar buttons end, so on some layouts the pill could cover a
  button and take its click. Not reproduced at 1366x768, 100% scale, 20 open apps (Windows 11 folds the extra buttons
  into its "..." overflow before they reach the pill); not yet tried at
  125%/150% scale, with a centred taskbar (the Windows default; the test PC's taskbar is left-aligned) or "never combine". Hence the menu wording "may cover buttons", until
  the native taskbar button (AGEN-46) replaces this mode.
- **Looks like Windows 11:** rounded corners, shadow and the Mica material come from Windows itself; Segoe UI
  Variable type; light or dark follows your Windows setting (apps and taskbar are separate settings); status
  badges are vector shapes (`?` needs you, `!` error, clock stuck, square stopped, arc working, play starting,
  tick done); fade-in on the list and alerts; context menus follow the system colour mode with rounded corners.
- **Expanded list** (click the pill or the tray icon): project, state, how long ago, agent and what each session
  was asked, plus plan usage bars with reset countdowns. Hover highlight with your accent colour, Up/Down/Esc
  from the keyboard. Closes on click-away. Read-only.
- **Alerts:** a toast-style panel bottom right above the taskbar that never takes focus and fades after 8 s,
  plus per-event sounds (`.wav`, `.mp3`, or a macOS name mapped to the nearest Windows system sound). Pop-ups for
  state changes are off by default (as on macOS); a session's own notify request and plan-limit notices are on.
  No panel is shown over an open list (the sound still plays).
- **Tray icon:** the colour of the worst state, a red badge when a plan limit is over 70%, tooltip with counts.
- **Settings** in the tray menu: pop-ups, sounds, usage warning, stuck threshold, test alert, start with
  Windows (current-user Run key, no admin). They live in `~/.votive/settings.json` under the same key
  names the Node settings tool and the MCP `settings` tool use, so an agent can change them.
- Zero idle cost: file watchers wake it, a one-shot debounce coalesces bursts, and the only recurring timers run
  while sessions or usage exist (and the 1 s keep-on-top only inside the taskbar). DPI-aware.
- States and order match the macOS app: needs you, error, stuck, stopped, working, starting, done.

## Build and check (on Windows with the .NET 10 SDK)
    cd windows\Votive.Win
    dotnet build -c Release
    bin\Release\net10.0-windows\VotiveWin.exe --self-test      # pure logic, no display, exit 0 = pass
    set VOTIVE_HOME=<scratch>\.votive                  # point at fake sessions to try it
    bin\Release\net10.0-windows\VotiveWin.exe --report mem.txt # writes idle memory after 60 s
    bin\Release\net10.0-windows\VotiveWin.exe --render out.png [--light]  # paints pill, list and alert to a picture (run in a desktop session)
    powershell -ExecutionPolicy Bypass -File windows\build.ps1   # trimmed single-file build, self-test, 100 MB check, zip + sha256 in windows\dist

`nuget.config` clears package sources and fallback folders on purpose. To publish self-contained once,
pass a source on the command line: `dotnet publish -r win-x64 --self-contained true -p:PublishSingleFile=true
-p:EnableCompressionInSingleFile=false -p:PublishTrimmed=true -p:_SuppressWinFormsTrimError=true
--source https://api.nuget.org/v3/index.json`.

## Measured 2026-10-18 (Windows 11 22631, i7-7700, 7 fake sessions, 60 s idle, 0.000 s CPU per 10 s)
| Build | Disk | Working set | Private |
|---|---|---|---|
| framework-dependent (needs the .NET 10 Desktop Runtime) | 0.2 MB | 48.4 MB | 13.6 MB |
| self-contained, single file, compressed | 49.1 MB | 114.2 MB | 51.8 MB |
| self-contained, single file, plain | 102.1 MB | 48.7 MB | 12.8 MB |
| self-contained, folder | 108.8 MB | 46.6 MB | 12.1 MB |
| **self-contained, single file, trimmed** | **46.5 MB** | **47.5 MB** | **15.3 MB** |

AGEN-12 kill rule: more than 60 MB working set or more than 100 MB on disk means switch to Rust. The
trimmed build passes both. Caveats: trimming is **not supported** for WinForms (the error is
suppressed on purpose) so every feature must be exercised on a trimmed build before release; the
compressed single file looks small but unpacks the runtime into memory (114 MB); the working set
includes shared runtime pages, private bytes are the app's own.

## Installing the Node side (hooks, status line) on Windows
    node Scripts\install-windows.js --app bin\Release\net10.0-windows\VotiveWin.exe
    node Scripts\doctor.js                      # checks the app, scripts, hooks and status line
    node Scripts\install-windows.js --remove    # unwire everything, restore the original status line
Per user, no admin. Hook commands are written as `node "C:/Users/you/.votive/bin/votive-event.js"
--agent claude-code`: double quotes and forward slashes, the one form cmd.exe, PowerShell and Git bash all read
the same way (tested under all three on Windows 11). A path containing `"`, `$`, a backtick or `%` is refused with
a clear message instead of writing a command that misbehaves inside someone's agent.

## Not done yet
A real installer and signing (the zip holds the one exe; SmartScreen will warn on an unsigned file), multi-monitor
placement and a second taskbar (primary screen only), real agent events (no agent is logged in on the test PC, so
how real Claude Code on Windows launches the hooks is verified only against cmd, PowerShell and Git bash), a click
on a row doing anything (deliberately read-only), and a look at the right-click menu on the live desktop (it
needs a human click; it is styled in code and checked by build only). Trimming is unsupported for WinForms: the
trimmed build starts, paints and passes its self-test, but test every feature on it before releasing.
