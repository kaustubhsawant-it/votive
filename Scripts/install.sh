#!/usr/bin/env bash
# Build (Release) → install app to ~/Applications → install scripts to ~/.votive/bin →
# wire every detected agent (configs backed up first) → Claude Code usage status line →
# notify MCP server → LaunchAgent, so it runs now and auto-starts at login. Safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="$HOME/.votive/bin"

# Preflight: fail before touching anything if a required tool is missing.
for tool in xcodegen xcodebuild node npm; do
  command -v "$tool" >/dev/null || { echo "Missing '$tool' — see Requirements in README.md"; exit 1; }
done

echo "==> Building Release…"
xcodegen generate >/dev/null
xcodebuild -project Votive.xcodeproj -scheme Votive -configuration Release build >/dev/null

DD=$(xcodebuild -project Votive.xcodeproj -scheme Votive -configuration Release \
      -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR /{print $2; exit}')
APP="$DD/Votive.app"
[ -d "$APP" ] || { echo "Build failed: '$APP' not found"; exit 1; }

echo "==> Installing app to ~/Applications…"
mkdir -p "$HOME/Applications"
DEST="$HOME/Applications/Votive.app"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
codesign --force --deep --sign - "$DEST" 2>/dev/null || true

echo "==> Moving data from the old Agent Overlay name, if any…"
node "$ROOT/Scripts/legacy-migrate.js"

echo "==> Installing scripts to ~/.votive/bin…"
mkdir -p "$BIN" "$HOME/.votive/events" "$HOME/.votive/usage"
chmod 700 "$HOME/.votive" "$HOME/.votive/events" "$HOME/.votive/usage"
for f in votive-event.js agents.js overlay-paths.js progress.js statusline-extras.js votive-statusline.js \
         votive-notify.js notify-core.js usage-history.js usage-pacing.js proc-info.js limit-notify.js; do
  cp "$ROOT/Scripts/$f" "$BIN/$f"
done
# Hooks of agent sessions started before the rename still call the old script names: keep thin shims.
cp "$ROOT"/Scripts/legacy/agent-overlay-*.js "$BIN/"
chmod +x "$BIN"/votive-*.js "$BIN"/agent-overlay-*.js

# One-time move from the Claude-only layout of earlier versions (~/.claude/...).
OLD="$HOME/.claude"
if [ -f "$OLD/agent-overlay-usage/wrapped.json" ] && [ ! -f "$HOME/.votive/usage/wrapped.json" ]; then
  mv "$OLD/agent-overlay-usage/wrapped.json" "$HOME/.votive/usage/wrapped.json"
fi
if [ -f "$OLD/agent-overlay-snippets.json" ] && [ ! -f "$HOME/.votive/snippets.json" ]; then
  mv "$OLD/agent-overlay-snippets.json" "$HOME/.votive/snippets.json"
fi
rm -f "$OLD/hooks/agent-overlay-status.js" "$OLD/hooks/agent-overlay-statusline.js" \
      "$OLD/hooks/agent-overlay-notify.js" "$OLD/hooks/notify-core.js"

echo "==> Wiring agents (each config is backed up before it's changed)…"
# A config it refuses to edit (e.g. invalid JSON) is reported and skipped; the rest of the
# install carries on so the app still starts. `node Scripts/doctor.js` shows what's left.
node "$ROOT/Scripts/install-agents.js" || echo "    Some agents could not be wired (see above). Fix the file, then run: node Scripts/install-agents.js"

if [ -d "$HOME/.claude" ] || command -v claude >/dev/null; then
  echo "==> Claude Code: plan-usage status line (your status line looks the same)…"
  node "$ROOT/Scripts/install-statusline.js"

  echo "==> Claude Code: notify MCP server and /notify command…"
  if [ ! -d "$ROOT/mcp-server/node_modules" ]; then
    (cd "$ROOT/mcp-server" && npm install --omit=dev >/dev/null)
  fi
  if command -v claude >/dev/null; then
    claude mcp remove agent-overlay --scope user >/dev/null 2>&1 || true   # the name before Votive
    claude mcp remove votive --scope user >/dev/null 2>&1 || true
    claude mcp add --scope user votive -- node "$ROOT/mcp-server/index.js" >/dev/null
  fi
  mkdir -p "$HOME/.claude/commands"
  cp "$ROOT/Scripts/commands/notify.md" "$HOME/.claude/commands/notify.md"
fi

echo "==> Installing + loading LaunchAgent…"
APPBIN="$DEST/Contents/MacOS/Votive"
UID_="$(id -u)"; LABEL="dev.votive.Votive"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__APP_BINARY__|$APPBIN|g" "$ROOT/Scripts/$LABEL.plist" > "$PLIST_DST"
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
# bootout is async; bootstrap fails with EIO if it runs mid-teardown, so wait until it's gone.
for _ in 1 2 3 4 5 6 7 8; do launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1 || break; sleep 0.3; done
launchctl bootstrap "gui/$UID_" "$PLIST_DST" 2>/dev/null \
  || { sleep 0.5; launchctl bootstrap "gui/$UID_" "$PLIST_DST" 2>/dev/null || true; }
launchctl kickstart -k "gui/$UID_/$LABEL" 2>/dev/null || true

# The Agent Overlay-named login item and app (earlier versions) would start a second menu-bar app.
OLD_LABEL="app.agentoverlay.AgentOverlay"
launchctl bootout "gui/$UID_/$OLD_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
rm -rf "$HOME/Applications/Agent Overlay.app"

# Old state folders go last: a previous version of the app still running above could recreate them.
rm -rf "$OLD/agent-overlay" "$OLD/agent-overlay-usage"

echo "Done. Votive is running in your menu bar and will auto-start at login."
echo "Installed another agent later? Run: node Scripts/install-agents.js"
