#!/usr/bin/env bash
# Reverse of install.sh: unloads the LaunchAgent, removes the app, unwires every agent,
# restores your original Claude Code status line, and removes the scripts, /notify command
# and MCP server. Each config edit is backed up first.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="dev.votive.Votive"

echo "==> Unloading LaunchAgent…"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
# ...and the Agent Overlay-named one from earlier versions, if it is still there.
launchctl bootout "gui/$(id -u)/app.agentoverlay.AgentOverlay" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/app.agentoverlay.AgentOverlay.plist"

echo "==> Removing app…"
rm -rf "$HOME/Applications/Votive.app" "$HOME/Applications/Agent Overlay.app"

echo "==> Unwiring agents (configs are backed up first)…"
node "$HERE/install-agents.js" --remove || echo "    (some configs could not be edited — see above)"
node "$HERE/install-statusline.js" --remove || echo "    (could not restore statusLine — see the message above)"

echo "==> Removing scripts, /notify command and MCP server…"
rm -rf "$HOME/.votive/bin"
rm -f "$HOME/.claude/commands/notify.md"
if command -v claude >/dev/null; then
  claude mcp remove votive --scope user >/dev/null 2>&1 || true
  claude mcp remove agent-overlay --scope user >/dev/null 2>&1 || true   # the name before Votive
fi

echo
echo "Uninstalled. Session state and snippets in ~/.votive are left in place;"
echo "delete that folder too if you want nothing left behind."
