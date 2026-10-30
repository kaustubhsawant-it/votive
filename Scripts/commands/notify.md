---
name: notify
description: Pop a custom alert in Votive for this session, right now
argument-hint: "<message>"
allowed-tools:
  - mcp__votive__notify
---

<objective>
Immediately pop a custom alert panel in the user's Votive menu-bar app for THIS
session, via the `votive` MCP server's `notify` tool
([mcp-server/index.js](../../mcp-server/index.js)). The tool's own description restricts it to
cases where the user's prompt explicitly asked for a notification — running `/notify` **is**
that explicit ask, so call it immediately without re-litigating whether it's warranted.
</objective>

<process>
Call `mcp__votive__notify` with:

- `message`: `$ARGUMENTS` verbatim, if non-empty.
- If `$ARGUMENTS` is empty, write one real sentence yourself describing what you just finished
  or what you're currently waiting on in this conversation — never a bare label like a folder
  name, branch name, or single word ("done").

Call the tool right away. Don't ask for confirmation first and don't add commentary — the
tool's own result is confirmation enough.
</process>
