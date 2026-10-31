import Foundation

/// Where the overlay reads from.
///
/// Its own state lives in the agent-neutral `~/.votive/` (written by the event hook,
/// the usage writers and the snippets menu). Claude Code's own files under `~/.claude` are
/// read-only extras for Claude sessions (live registry, prompt history, transcripts).
enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser

    // MARK: Ours
    static let root = home.appendingPathComponent(".votive", isDirectory: true)
    /// One file per agent session: `<agent>--<session>.json` (see Scripts/votive-event.js).
    static let events = root.appendingPathComponent("events", isDirectory: true)
    /// One file per agent with plan-usage windows: `<agent>.json`.
    static let usage = root.appendingPathComponent("usage", isDirectory: true)
    static let snippets = root.appendingPathComponent("snippets.json")
    /// The ports you chose to watch (Settings → Developer → Ports). A plain array of numbers.
    static let ports = root.appendingPathComponent("ports.json")
    /// Programs Votive froze with Ports → Pause, so none is left frozen unnoticed. Checked every time it is read.
    static let paused = root.appendingPathComponent("paused.json")
    /// Your own alert sounds (Settings → Sounds → Add Sound File…).
    static let sounds = root.appendingPathComponent("sounds", isDirectory: true)

    // MARK: Claude Code's, read-only
    static let claude = home.appendingPathComponent(".claude", isDirectory: true)
    /// Claude Code's live session registry (busy/idle per pid).
    static let claudeSessions = claude.appendingPathComponent("sessions", isDirectory: true)
}
