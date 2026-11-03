# Votive for Linux (plan and status)

Not released, and not started as an app yet. This file records what was decided and what has been checked, so the
work can continue from here.

## Decisions (2026-11-03)
- **Ubuntu first** (24.04 LTS). Its GNOME session ships the AppIndicator extension switched on, so a tray icon shows
  up without anything extra. KDE and Fedora GNOME come after.
- **Node, not a web engine.** A small tray app written in Node that talks to the desktop over D-Bus
  (StatusNotifierItem for the icon and tooltip, dbusmenu for the menu). It reuses the core that already runs on every
  platform: the hook script, the event files in `~/.votive/events`, the settings file, the MCP server and the usage
  history and habits scripts. Electron and Tauri are out: the project does not bundle a web engine.
- **Same data as the other platforms.** The tray only reads `~/.votive`; it never talks to an agent. Windows already
  works this way (`windows/`).

## Phases
0. **The core on Linux.** Done: the Node suite passes on Debian 12 (aarch64, Node 22): 307 pass, 0 fail, 39 skipped
   (Swift, the MCP server's npm packages, Windows). One fix was needed: the process lookup shelled out to `ps`, which
   a minimal install does not have; it now reads `/proc/<pid>/stat` on Linux.
1. **Tray MVP.** Dots as one icon (with a tooltip per state), the session rows with agent, state, age and last prompt,
   usage rows, desktop notifications through the freedesktop notification service, a systemd user service as the
   installer, `doctor.js` taught about systemd instead of launchd. Tested headless in Docker against a pretend tray host
   on a private D-Bus.
2. **Parity.** Sounds, keep-awake (systemd inhibit), ports (`ss`), high priority and dot order, colors, the settings file.
3. **GNOME and terminal focus.** An optional extension for vanilla GNOME (no tray there), raising the terminal on X11
   (and through the extension on Wayland), `tmux select-pane`.
4. **Packaging and docs.** A tarball with an installer first; `.deb` or AppImage later.

## Known limits to say out loud
- No Votive window (forecast, habits, history) at first. The habits script runs from the command line.
- A Node tray idles at about 40 to 60 MB, against 15 to 25 MB for the Mac app.
- Wayland does not let one app raise another's window; the extension or KDE scripting is the only way.

## Checking it
```sh
./Scripts/test-linux.sh        # the whole Node suite in a throwaway Debian container (Docker needed)
```
