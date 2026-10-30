#!/usr/bin/env node
'use strict';
//
// Manual/scripting fallback for the on-demand custom notify. PREFERRED path for an agent
// session is the "votive" MCP server's `notify` tool (mcp-server/index.js,
// registered globally via `claude mcp add --scope user`) -- it's a native tool call, no
// shelling out required. This CLI stays for anything that isn't an MCP-capable agent
// session (a plain shell, fake-data.sh-style testing, etc).
//
// Usage:  node votive-notify.js "your message here"
//
// All the actual logic (finding the owning session, read-merge-writing the overlay file)
// lives in notify-core.js, shared with the MCP server -- see that file's header.
//
const { writeNotify } = require('./notify-core.js');

const message = process.argv[2] || '';
if (!message.trim()) {
  process.stderr.write('[votive-notify] usage: votive-notify.js "<message>"\n');
  process.exit(1);
}

const result = writeNotify(message, process.pid);
if (!result.ok) {
  process.stderr.write('[votive-notify] ' + result.error + '\n');
  process.exit(1);
}
process.stdout.write('Notified Votive for session ' + result.sessionId + '\n');
