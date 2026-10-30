import Foundation

/// A resolved, display-ready agent. This is the ONLY type the UI layer consumes.
/// Small value type (a few scalars + two short strings) so snapshots are cheap to diff.
struct AgentSession: Identifiable, Equatable {
    let id: String            // "<agent>:<sessionId>" — unique across agents
    let agent: String         // adapter id, e.g. "claude-code", "codex"
    let sessionId: String     // the agent's own session id
    let pid: Int32            // agent process pid (0 if unknown)
    let name: String          // e.g. "agent-work-40"
    let cwd: String
    let state: AgentState
    let startedAt: Int64      // epoch-ms, session open time — drives stable ordering
    let lastActivityAt: Int64 // epoch-ms, for relative time display
    let recap: String?        // the session's last prompt (what it's working on)
    let transcriptPath: String?
    /// A fresh, not-yet-alerted custom message from `votive-notify.js`, if any. Set for
    /// exactly one snapshot (AgentScanner marks it consumed once seen) — not a persistent state.
    let pendingNotify: PendingNotify?

    struct PendingNotify: Equatable {
        let message: String
        let at: Int64
    }

    var cwdBasename: String { (cwd as NSString).lastPathComponent }
    var agentName: String { AgentKind.name(agent) }
}
