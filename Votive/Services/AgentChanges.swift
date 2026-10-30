import Foundation

/// How the app presents what agents changed through the MCP tools (the lines of audit.jsonl), and the one
/// thing it will do about it: put a preference back.
///
/// An audit line is a file that any program running as the user could write, so nothing in it is trusted to
/// say what to do. Undo only ever writes a preference from a fixed allow-list, with the value checked against
/// that preference's own type and range, and cancels entirely if any part of the entry does not fit. The master
/// switch ("Let agents change settings") is not on the list, so no audit line can turn it on or off.
enum AgentChanges {
    enum PrefValue: Equatable, CustomStringConvertible {
        case bool(Bool), int(Int), text(String)
        var description: String {
            switch self {
            case .bool(let b): return "bool(\(b))"
            case .int(let i): return "int(\(i))"
            case .text(let t): return "text(\(t))"
            }
        }
    }

    struct UndoStep: Equatable {
        let key: String
        let value: PrefValue
    }

    private enum Kind {
        case bool
        case int(ClosedRange<Int>)
        case sound
    }

    /// Setting name as the MCP tools call it -> the preference key the app reads (mirrors SETTINGS in
    /// Scripts/overlay-settings.js; tests/agent-changes.test.js and tests/mcp-guard.test.js keep both honest).
    private static let allowed: [String: (key: String, kind: Kind)] = [
        "colorblindShapes": ("shapesMode", .bool),
        "usagePulse": ("usageAlertOn", .bool),
        "notifyOnRequest": ("customNotifyOn", .bool),
        "bannerOnEveryChange": ("notificationsOn", .bool),
        "popupOnEveryChange": ("dialogAlertsOn", .bool),
        "stuckThresholdMinutes": ("stuckThresholdMinutes", .int(0...240)),
        "sounds": ("soundsOn", .bool),
        "soundNotify": ("soundNotify", .sound),
        "soundNeedsYou": ("soundNeedsYou", .sound),
        "soundError": ("soundError", .sound),
        "soundStuck": ("soundStuck", .sound),
        "soundStopped": ("soundStopped", .sound),
        "soundDone": ("soundDone", .sound),
    ]

    private static let soundName = try! NSRegularExpression(pattern: "^[A-Za-z0-9 _.()\\-]{1,64}$")

    /// The preferences to put back, or nil when this entry cannot be undone safely (not a successful
    /// settings change, nothing to undo, an unknown setting, or any value that does not fit).
    static func undoSteps(for entry: AuditEntry) -> [UndoStep]? {
        guard entry.tool == "settings_set", entry.ok == true, let undo = entry.undo, !undo.isEmpty else { return nil }
        var steps: [UndoStep] = []
        for (name, change) in undo {
            guard let spec = allowed[name] else { return nil }
            switch (spec.kind, change.from) {
            case (.bool, .bool(let b)):
                steps.append(UndoStep(key: spec.key, value: .bool(b)))
            case (.int(let range), .int(let i)) where range.contains(i):
                steps.append(UndoStep(key: spec.key, value: .int(i)))
            case (.sound, .text(let t)) where soundName.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil:
                steps.append(UndoStep(key: spec.key, value: .text(t)))
            default:
                return nil
            }
        }
        return steps
    }

    /// Writes the steps into the app's preferences. Returns false when the entry cannot be undone.
    @discardableResult
    static func undo(_ entry: AuditEntry, in defaults: UserDefaults = .standard) -> Bool {
        guard let steps = undoSteps(for: entry) else { return false }
        for s in steps {
            switch s.value {
            case .bool(let b): defaults.set(b, forKey: s.key)
            case .int(let i): defaults.set(i, forKey: s.key)
            case .text(let t): defaults.set(t, forKey: s.key)
            }
        }
        return true
    }

    // MARK: - Wording

    /// "just now", "5m ago", "2h ago", "3d ago"; a time in the future reads as "just now".
    static func ago(_ atMs: Int64, now: Date = Date()) -> String {
        let s = Int(now.timeIntervalSince1970 - Double(atMs) / 1000)
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86400 { return "\(s / 3600)h ago" }
        return "\(s / 86400)d ago"
    }

    private static let names = ["claude-code": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "qwen": "Qwen Code",
                                "copilot": "Copilot CLI", "opencode": "OpenCode", "cursor": "Cursor", "windsurf": "Windsurf"]

    /// Text from the audit file shown to the user: control, bidi and invisible characters become spaces, then clipped.
    static func clean(_ s: String, max: Int) -> String {
        let bad = CharacterSet.controlCharacters
            .union(CharacterSet(charactersIn: "\u{00AD}\u{061C}\u{200B}\u{200C}\u{200D}\u{200E}\u{200F}\u{2028}\u{2029}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2060}\u{2066}\u{2067}\u{2068}\u{2069}\u{FEFF}"))
        let spaced = String(String.UnicodeScalarView(s.unicodeScalars.map { bad.contains($0) ? " " : $0 }))
        let collapsed = spaced.split(whereSeparator: { $0 == " " }).joined(separator: " ")
        return collapsed.count > max ? String(collapsed.prefix(max - 1)) + "\u{2026}" : collapsed
    }

    static func agentName(_ entry: AuditEntry) -> String {
        let raw = entry.agent ?? "an agent"
        return names[raw] ?? clean(raw, max: 24)
    }

    /// One line for the menu: "Claude Code · 5m ago: changed stuckThresholdMinutes: 8 → 20".
    static func menuTitle(for entry: AuditEntry, now: Date = Date()) -> String {
        let summary = clean(entry.summary ?? entry.tool, max: 200)
        return clean("\(agentName(entry)) \u{00B7} \(ago(entry.at, now: now)): \(summary)", max: 90)
    }

    /// The panel shown when an agent has just changed something.
    static func panel(for entry: AuditEntry) -> (title: String, body: String) {
        let what = entry.tool == "repair" ? "repaired the install" : "changed a setting"
        let summary = clean(entry.summary ?? "", max: 200)
        let undo = undoSteps(for: entry) != nil ? " You can undo it in the menu, under Agent changes." : " It is listed in the menu, under Agent changes."
        return (clean("\(agentName(entry)) \(what)", max: 60), summary + "." + undo)
    }
}
