import Foundation

/// Codable mirror of one `~/.votive/events/<agent>--<session>.json` file, written by
/// `Scripts/votive-event.js` for any agent (and by the notify tool).
struct OverlayEntry: Codable {
    /// Adapter id from Scripts/agents.js ("claude-code", "codex", …). Missing = claude-code.
    let agent: String?
    let sessionId: String
    let lastEvent: String     // "starting" | "working" | "done" | "waiting" | "error"
    let lastEventAt: Int64    // epoch-ms
    let cwd: String?
    let pid: Int?             // the agent's host process (nearest non-shell ancestor of the hook)
    let prompt: String?       // last prompt, when the agent's payload carries it
    let transcriptPath: String?

    // Written by the on-demand notify tool — a one-shot message independent of lastEvent.
    let notifyMessage: String?
    let notifyAt: Int64?

    var agentId: String { agent ?? AgentKind.claudeCode }
    /// Unique across agents: two agents may reuse the same session id format.
    var key: String { agentId + ":" + sessionId }
}

/// Display names for the adapter ids in Scripts/agents.js.
enum AgentKind {
    static let claudeCode = "claude-code"
    private static let names: [String: String] = [
        "claude-code": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "qwen": "Qwen Code",
        "copilot": "Copilot CLI", "cursor": "Cursor", "windsurf": "Windsurf", "goose": "Goose",
        "cline": "Cline", "opencode": "OpenCode", "amp": "Amp", "aider": "Aider", "generic": "Agent",
    ]
    static func name(_ id: String) -> String {
        names[id] ?? id.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}
