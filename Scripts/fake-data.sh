#!/usr/bin/env bash
# Verification harness: writes synthetic registry + overlay files to force EACH of the
# seven states plus a custom notify dialog, so you can eyeball every color/label/alert
# without waiting for real agents.
#
#   ./fake-data.sh          # create fake sessions (keeps a live helper process alive)
#   ./fake-data.sh clean    # remove all fake-* files and kill the helper
set -euo pipefail

S="$HOME/.claude/sessions"
O="$HOME/.votive/events"
PIDFILE="/tmp/votive-fake.pid"

clean() {
  rm -f "$S"/fake-*.json "$O"/*--fake-*.json 2>/dev/null || true
  if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
  echo "Cleaned fake data."
}

if [ "${1:-}" = "clean" ]; then clean; exit 0; fi

mkdir -p "$S" "$O"

# A real, long-lived process so the "alive" states pass the liveness check.
sleep 3000 & LIVE=$!
echo "$LIVE" > "$PIDFILE"

now=$(( $(date +%s) * 1000 ))
future=$(( now + 60000 ))   # newer than updatedAt → attention overrides fire

reg() { # file pid sessionId name status
  cat > "$S/$1.json" <<EOF
{"pid":$2,"sessionId":"$3","cwd":"/tmp/$4","name":"$4","status":"$5","updatedAt":$now,"statusUpdatedAt":$now,"startedAt":$now}
EOF
}
ovl() { # sessionId event at   (a Claude Code session's event file)
  cat > "$O/claude-code--$1.json" <<EOF
{"agent":"claude-code","sessionId":"$1","lastEvent":"$2","lastEventAt":$3}
EOF
}
other() { # agent sessionId event prompt   (an event-only session from another agent)
  cat > "$O/$1--$2.json" <<EOF
{"agent":"$1","sessionId":"$2","lastEvent":"$3","lastEventAt":$now,"pid":$LIVE,"cwd":"/tmp/$2","prompt":"$4"}
EOF
}

# yellow — working (busy, no attention override)
reg fake-working "$LIVE" fake-working fake-working busy

# green — done (idle, no overlay)
reg fake-done "$LIVE" fake-done fake-done idle

# purple — needs input (idle + waiting newer than updatedAt)
reg fake-needs "$LIVE" fake-needs fake-needs idle
ovl fake-needs waiting "$future"

# orange — warning (busy + error newer than updatedAt)
reg fake-warn "$LIVE" fake-warn fake-warn busy
ovl fake-warn error "$future"

# blue — starting (idle + starting newer than updatedAt)
reg fake-start "$LIVE" fake-start fake-start idle
ovl fake-start starting "$future"

# red — stopped (dead pid; large unlikely-alive value)
reg fake-dead 999999 fake-dead fake-dead idle

# brown — stuck (busy, but updatedAt is stale past the default 8 min threshold)
stale=$(( now - 9 * 60 * 1000 ))
cat > "$S/fake-stuck.json" <<EOF
{"pid":$LIVE,"sessionId":"fake-stuck","cwd":"/tmp/fake-stuck","name":"fake-stuck","status":"busy","updatedAt":$stale,"statusUpdatedAt":$stale,"startedAt":$stale}
EOF

# custom notify panel — fires once, independent of state (stays "working" here on purpose),
# on by default (customNotifyOn). Only pops if Votive was ALREADY running before this
# file appears (baseline suppression skips whatever's already there at launch) — start the
# app first, then re-run this script, to actually see the panel.
reg fake-notify "$LIVE" fake-notify fake-notify busy
cat > "$O/claude-code--fake-notify.json" <<EOF
{"agent":"claude-code","sessionId":"fake-notify","lastEvent":"working","lastEventAt":$now,"notifyMessage":"Fake custom notify — click Open Terminal to test the jump-to-agent button","notifyAt":$now}
EOF

# other agents: event-only sessions, labelled with their agent in the dropdown
other codex fake-codex working "Add retries to the upload client"
other gemini fake-gemini waiting "Refactor the settings screen"

echo "Created 10 fake sessions (helper pid $LIVE). Expect DOTS for: 2 working (one Codex),"
echo "1 done, 2 needs-you (one Gemini CLI), 1 error, 1 starting, 1 stopped, 1 stuck (brown),"
echo "all visible immediately in the menu bar / dropdown regardless of any toggle."
echo ""
echo "Automatic ALERTS (banner/panel on those state changes) are OFF by default — enable"
echo "'Notifications' / 'Alert dialogs' under the menu's 'Automatic alerts' section first if"
echo "you want to see those pop up too."
echo ""
echo "The custom notify PANEL is on by default (customNotifyOn) and independent of the above:"
echo "make sure Votive was already running BEFORE this script ran (baseline suppression"
echo "skips anything present at launch), then look for a panel titled '📣 fake-notify' with an"
echo "Open Terminal button, top-right of your screen."
echo "Run './fake-data.sh clean' when done."
