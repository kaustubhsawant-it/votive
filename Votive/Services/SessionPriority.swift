import Foundation

/// High-priority ("pinned") sessions. A pinned session sorts first, in the menu and in the menu-bar dots,
/// and, when the user asks for it, is the only kind that raises automatic alerts.
///
/// A session is high priority in two ways: the user pinned that one session (identified by its key,
/// `AgentSession.id`: agent + session id), or the user marked its folder, so every session started there is
/// high priority without doing anything each time. Both live in macOS preferences as `[key: time]`, so a
/// restart of Votive keeps them and no new file is written.
enum SessionPriority {
    static let pinsKey = "prioritySessions"
    static let foldersKey = "priorityFolders"
    static let onlyKey = "alertsOnlyPriority"
    /// A pin for a session that is no longer running is dropped after this long (a resumed session keeps its pin).
    static let keepSeconds: Double = 14 * 24 * 3600
    static let maxPins = 50
    static let maxFolders = 50

    /// A folder as stored and compared: no trailing slash.
    static func normalize(_ path: String) -> String {
        var p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// When this session became high priority (its own pin, else its folder's rule), or nil if it is not.
    static func pinTime(for s: AgentSession, pins: [String: Double], folders: [String: Double]) -> Double? {
        if let t = pins[s.id] { return t }
        guard !s.cwd.isEmpty else { return nil }
        return folders[normalize(s.cwd)]
    }

    static func isHighPriority(_ s: AgentSession, pins: [String: Double], folders: [String: Double]) -> Bool {
        pinTime(for: s, pins: pins, folders: folders) != nil
    }

    /// High-priority sessions first, in the order they became so; everyone else after them in the order given.
    static func order(_ sessions: [AgentSession], pins: [String: Double], folders: [String: Double] = [:]) -> [AgentSession] {
        let pinned = sessions.filter { isHighPriority($0, pins: pins, folders: folders) }.sorted { a, b in
            let ta = pinTime(for: a, pins: pins, folders: folders) ?? 0
            let tb = pinTime(for: b, pins: pins, folders: folders) ?? 0
            if ta != tb { return ta < tb }
            if a.startedAt != b.startedAt { return a.startedAt < b.startedAt }
            return a.id < b.id
        }
        let rest = sessions.filter { !isHighPriority($0, pins: pins, folders: folders) }
        return pinned + rest
    }

    static func pinnedCount(_ sessions: [AgentSession], pins: [String: Double], folders: [String: Double] = [:]) -> Int {
        sessions.filter { isHighPriority($0, pins: pins, folders: folders) }.count
    }

    /// Whether an automatic alert (banner, pop-up, state-change sound) may fire for this session.
    /// A message a person asked a session to send is not an automatic alert and never goes through this.
    static func shouldAlert(_ s: AgentSession, onlyPriority: Bool, pins: [String: Double], folders: [String: Double] = [:]) -> Bool {
        !onlyPriority || isHighPriority(s, pins: pins, folders: folders)
    }

    /// What is stored, validated: short non-empty keys, positive finite times, at most `limit` (the newest).
    static func clean(_ raw: Any?, limit: Int = maxPins, pathKeys: Bool = false) -> [String: Double] {
        guard let dict = raw as? [String: Any] else { return [:] }
        var out: [String: Double] = [:]
        for (k, v) in dict {
            guard !k.isEmpty, k.count <= (pathKeys ? 1024 : 300), !pathKeys || k.hasPrefix("/"),
                  let t = (v as? NSNumber)?.doubleValue, t.isFinite, t > 0 else { continue }
            out[k] = t
        }
        guard out.count > limit else { return out }
        return Dictionary(uniqueKeysWithValues: out.sorted { $0.value > $1.value }.prefix(limit).map { ($0.key, $0.value) })
    }

    static func cleanFolders(_ raw: Any?) -> [String: Double] { clean(raw, limit: maxFolders, pathKeys: true) }

    /// The pins that are still wanted: every pin of a running session, and recent pins of sessions that are not running.
    static func pruned(_ pins: [String: Double], live: Set<String>, now: Double) -> [String: Double] {
        pins.filter { live.contains($0.key) || now - $0.value < keepSeconds }
    }
}

/// Reads and writes the pins and folder rules in preferences. The only writer.
struct PriorityStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var pins: [String: Double] { SessionPriority.clean(defaults.object(forKey: SessionPriority.pinsKey)) }
    var folders: [String: Double] { SessionPriority.cleanFolders(defaults.object(forKey: SessionPriority.foldersKey)) }
    var onlyPriorityAlerts: Bool { defaults.bool(forKey: SessionPriority.onlyKey) }

    /// Pinned itself, or in a marked folder.
    func isHighPriority(_ s: AgentSession) -> Bool { SessionPriority.isHighPriority(s, pins: pins, folders: folders) }
    func isPinned(_ id: String) -> Bool { pins[id] != nil }
    func isFolderMarked(_ path: String) -> Bool { folders[SessionPriority.normalize(path)] != nil }

    /// Pins or unpins one session. Returns whether it is pinned afterwards.
    @discardableResult
    func toggle(_ id: String, now: Date = Date()) -> Bool {
        var current = pins
        let nowPinned = current[id] == nil
        if nowPinned { current[id] = now.timeIntervalSince1970 } else { current[id] = nil }
        let cleaned = SessionPriority.clean(current)
        defaults.set(cleaned, forKey: SessionPriority.pinsKey)
        return nowPinned
    }

    /// Marks or unmarks a folder: every session started in it is high priority. Returns whether it is marked afterwards.
    @discardableResult
    func toggleFolder(_ path: String, now: Date = Date()) -> Bool {
        let key = SessionPriority.normalize(path)
        guard key.hasPrefix("/") else { return false }
        var current = folders
        let nowMarked = current[key] == nil
        if nowMarked { current[key] = now.timeIntervalSince1970 } else { current[key] = nil }
        let cleaned = SessionPriority.cleanFolders(current)
        defaults.set(cleaned, forKey: SessionPriority.foldersKey)
        return nowMarked
    }

    /// Drops pins nobody needs any more. Writes only when something changed.
    func prune(live: Set<String>, now: Date = Date()) {
        let before = pins
        let after = SessionPriority.pruned(before, live: live, now: now.timeIntervalSince1970)
        if after.count != before.count { defaults.set(after, forKey: SessionPriority.pinsKey) }
    }
}
