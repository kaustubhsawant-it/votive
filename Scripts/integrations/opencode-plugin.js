// Votive plugin for OpenCode: reports session state to the Votive menu-bar app.
// Installed by Scripts/install-agents.js, which fills in the event script path below.
const SCRIPT = "__EVENT_SCRIPT__";

// Event types the overlay understands (see opencode in Scripts/agents.js). Everything else is
// ignored here, so busy streams like message.part.updated never spawn a process.
const REPORTED = new Set([
  "session.created", "session.idle", "session.error", "session.deleted",
  "permission.asked", "permission.updated", "permission.replied",
]);

export const Votive = async ({ $, directory }) => {
  const report = async (type, sessionID) => {
    if (!sessionID) return;
    try {
      await $`node ${SCRIPT} --agent opencode --no-stdin --event ${type} --session ${sessionID} --cwd ${directory}`
        .quiet().nothrow();
    } catch {}
  };
  return {
    event: async ({ event }) => {
      if (!REPORTED.has(event.type)) return;
      const p = event.properties || {};
      await report(event.type, p.sessionID || (p.info && p.info.id));
    },
    "chat.message": async (input) => { await report("chat.message", input && input.sessionID); },
    "tool.execute.after": async (input) => { await report("tool.execute.after", input && input.sessionID); },
  };
};
