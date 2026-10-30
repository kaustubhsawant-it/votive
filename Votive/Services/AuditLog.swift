import Foundation

/// What agents changed through the MCP tools, read from ~/.votive/audit.jsonl (one JSON
/// object per line, written by Scripts/mcp-guard.js). The app only reads it: to show the last
/// few changes in the menu and to raise a panel when a new one arrives.
struct AuditEntry: Decodable, Equatable {
    let at: Int64
    let tool: String
    let agent: String?
    let ok: Bool?
    let summary: String?
    let undo: [String: Change]?

    struct Change: Decodable, Equatable {
        let from: Value
        let to: Value
    }

    /// The settings tool stores booleans, whole numbers and sound names.
    enum Value: Decodable, Equatable {
        case bool(Bool), int(Int), text(String)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let b = try? c.decode(Bool.self) { self = .bool(b) }
            else if let i = try? c.decode(Int.self) { self = .int(i) }
            else { self = .text(try c.decode(String.self)) }
        }
    }
}

enum AuditLog {
    static let file = Paths.root.appendingPathComponent("audit.jsonl")
    static let limit = 256 * 1024

    /// Newest first, junk lines skipped, at most `max` entries.
    static func recent(from url: URL = file, max: Int = 5) -> [AuditEntry] {
        guard let data = BoundedRead.data(at: url, limit: limit), let text = String(data: data, encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        let entries = text.split(separator: "\n").compactMap { try? decoder.decode(AuditEntry.self, from: Data($0.utf8)) }
        return Array(entries.suffix(max).reversed())
    }

    /// Entries newer than `seenAt` that changed something, for the "an agent just did this" panel.
    static func unseen(after seenAt: Int64, from url: URL = file) -> [AuditEntry] {
        recent(from: url, max: 20).filter { $0.at > seenAt && $0.ok == true && $0.tool != "notify" }.reversed()
    }
}
