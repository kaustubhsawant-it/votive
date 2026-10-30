import Foundation

/// Codable mirror of one `~/.claude/sessions/{pid}.json` file that Claude Code writes
/// per running process. Only the fields we need are declared; unknown keys are ignored.
///
/// Fields that some Claude Code versions may omit are optional so a single missing key
/// never throws away the whole entry.
struct RegistryEntry: Codable {
    let pid: Int32
    let sessionId: String
    let cwd: String
    let name: String?
    let status: String?           // "busy" | "idle"
    let updatedAt: Int64?         // epoch-ms, advances on activity
    let statusUpdatedAt: Int64?   // epoch-ms, advances when busy/idle flips
    let startedAt: Int64?         // epoch-ms, session start
}
