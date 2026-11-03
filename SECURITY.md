# Security

## Reporting a problem

Please report security issues privately through the repository's **Security → Report a
vulnerability** page (GitHub private vulnerability reporting), not in a public issue. Include
what you found, how to reproduce it, and which version (`CHANGELOG.md`) you ran. If you can't use
that page, email **parabkaustubh13@gmail.com** with "Votive security" in the subject, and please
don't put exploit details in a public place first. This is a one-person project: you'll get an
acknowledgement within 7 days (best effort), and credit in the fix's changelog entry if you'd like it.

Only the latest release gets fixes.

## How Votive is built to be safe

See [PRIVACY.md](PRIVACY.md) for what it reads, writes and runs. The security-relevant design
choices:

**No network, no privileges.** Votive's own code (the app, the hooks and the MCP server's
`index.js`) contains no networking code, and `tests/no-network.test.js` fails if any appears. One
caveat: the MCP server's npm dependency tree ships HTTP server libraries (express, hono) that the
stdio server never loads; they sit on disk but no code path reaches them. Nothing listens on a
port, and nothing runs as root or asks for an administrator password. The app has no entitlements.

**Two ways to install, and what you trust in each.** *From source:* `install.sh` compiles the app on
your Mac and signs it ad-hoc for your Mac only, so there is no binary to trust. *From a release zip:* you trust
a universal app that the maintainer built from the same tagged source, ad-hoc signed and **not notarized** (no
Apple Developer ID). Check the zip against `SHA256SUMS.txt` on the release page, or build from source if you
would rather not trust a binary; the zip is not byte-for-byte reproducible. Because macOS refuses an app it
cannot check with Apple, the installer clears the "downloaded from the internet" flag on the one copy it installs
(`xattr -dr com.apple.quarantine`, the step Homebrew casks take). It is a single line in `Scripts/install.sh`
and `tests/release.test.js` pins it to that one app.

**Hooks can't disturb your agent.** The event hook runs inside other programs, so it:
- always exits with status 0, whatever happens
- never prints anything (several agents feed hook output back to the model)
- gives up after 2.5 seconds instead of waiting
- treats every payload field as data: nothing from a payload is ever run as a command

**Config files are edited carefully.** Before changing any agent's config, the installer:
- refuses a file that isn't a valid JSON object
- backs it up with the same permissions as the original
- writes the new version to a temporary file and renames it into place, so a crash can't leave
  half a file; symlinks are preserved

It only adds or removes entries that run Votive's own script, and leaves everything
else alone.

**Your data stays private to you.** `~/.votive`, `events/` and `usage/` are created
readable only by your user (mode `0700`), because event files hold folder names and the start
of your latest prompt.

**No command injection from the process tree.** To select a terminal tab, the app passes a tty
name from `/bin/ps` (like `/dev/ttys004`) to AppleScript. It never builds scripts from folder
names, prompts or any other text an agent could influence. AppleScript runs through
`/usr/bin/osascript` with arguments, not through a shell.

**The optional Ports tool can end a program, so it is narrow.** It is off by default. When on, it runs
`/usr/sbin/lsof` with fixed arguments (no shell) and, only after you confirm a dialog naming the
program, sends one signal to that one process id (SIGTERM to ask it to quit, SIGSTOP to freeze it, SIGCONT to
continue it). Just before sending it checks again that the
same process still listens on that port, so a recycled process id is never hit. It refuses your
agent sessions, Votive, programs owned by another user and programs under `/System`, `/usr/libexec`,
`/usr/sbin` and `/sbin`; macOS itself refuses anything you cannot already stop with `kill`. The
default button in the dialog is Cancel. A program it froze is remembered in `~/.votive/paused.json`, which is
re-validated on every read (same user, still frozen, same process start time), so an edited or stale file
cannot make it signal another process; quitting Votive asks to resume what it froze, and command-line
arguments, which can hold secrets, are never read. No MCP tool or setting an agent can write reaches it
(`tests/ports.test.js` fails if one does).

**Alert text is plain text.** Notify panels show messages as plain labels: no links, no HTML,
and no buttons beyond "Open Terminal", "Dismiss" and "OK".

**MCP tools that change things are guarded.** `settings_set` and `repair` are refused until you turn on
"Let agents change settings" in the app's menu; it is off by default and is not one of the settings
a tool can write. They are also rate limited (a few calls an hour, `notify` a few a minute), and each
change or refusal is written to `~/.votive/audit.jsonl` (private, capped at 200 lines), which
the macOS app lists under "Agent changes" with an Undo for settings changes and a panel when something
changes. `settings_set` can only write the documented preferences and validates every value before
writing any; `repair` can only run the named repairs, each through the same backed-up installers.
Neither takes a path, command or free-form input. Claude Code is also asked to confirm every
`settings_set` and `repair` call (a marker on the tools); other agents may or may not ask. Not covered:
a program running as you can still change the preference or the files directly (see below).

## Limits of the design

- **Other programs running as you can write the same files.** Any process with your user's
  permissions can write to `~/.votive`, just as it could edit your shell config. The
  worst it can do there is show wrong dots or a plain-text notify panel.
- **Agents decide what the hooks see.** Votive only records what an agent sends to its
  hook; it can't make an agent report more or less.
- **The MCP server's dependencies come from npm.** `mcp-server/package-lock.json` pins exact
  versions and integrity hashes (about 90 packages, most never loaded), and `tests/mcp-deps.test.js`
  fails if a package with a known advisory is locked. `npm audit` was clean on 2026-10-20 and will
  not stay clean forever: run `npm audit --omit=dev` in `mcp-server` if that matters to you, or
  skip the MCP server; the dots and usage don't need it.
- **Not hardened, not notarized.** The app is signed ad-hoc and built without the hardened runtime
  (`ENABLE_HARDENED_RUNTIME: NO`), so macOS applies none of its extra runtime protections to it.
  That is a consequence of building on your own Mac; a notarized build would need both.

## Before you install

The whole project is small enough to read. The parts that touch your system are:

| File | What to check |
|---|---|
| `Scripts/install.sh`, `Scripts/uninstall.sh` | Every file they create, change or delete |
| `Scripts/install-agents.js`, `Scripts/settings-io.js` | How agent configs are edited |
| `Scripts/votive-event.js`, `Scripts/agents.js` | What the hook records |
| `Scripts/votive-statusline.js` | The Claude Code status-line wrapper |
| `Votive/Services/TerminalFocus.swift` | The only place the app runs AppleScript |
| `mcp-server/index.js`, `Scripts/overlay-settings.js`, `Scripts/doctor.js` | What the MCP tools can change |
