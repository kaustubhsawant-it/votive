import AppKit

/// The six visual states an agent can be in, each mapped to a macOS system color.
///
/// Palette rationale (see plan): anchored to the CI/CD status model developers already
/// carry — yellow = running, green = passed, red = failed — reinforced by native macOS
/// system colors so red already reads "bad" and green "good".
enum AgentState: String, Equatable, CaseIterable {
    case starting     // 🔵 brand-new session, pre-work
    case working      // 🟡 actively generating (registry status == busy)
    case done         // 🟢 turn finished / idle-complete
    case needsInput   // 🟣 waiting on the human (Notification / PermissionRequest)
    case warning      // 🟠 recoverable error (a tool / turn errored, session alive)
    case stuck        // 🟤 busy but no activity for the configured threshold
    case stopped      // 🔴 process gone / crashed (fatal)

    /// Set at launch by `StateColors`: the owner's own colour for a state, if they chose one.
    static var userColor: (AgentState) -> NSColor? = { _ in nil }

    /// The colour the dot is drawn in: the owner's choice if there is one, else the system colour.
    var color: NSColor { Self.userColor(self) ?? defaultColor }

    var defaultColor: NSColor {
        switch self {
        case .starting:   return .systemBlue
        case .working:    return .systemYellow
        case .done:       return .systemGreen
        case .needsInput: return .systemPurple
        case .warning:    return .systemOrange
        case .stuck:      return .systemBrown
        case .stopped:    return .systemRed
        }
    }

    /// Human-readable label shown beside every dot in the dropdown — so meaning is
    /// never conveyed by hue alone (color-blind safety).
    var label: String {
        switch self {
        case .starting:   return "starting"
        case .working:    return "working"
        case .done:       return "done"
        case .needsInput: return "needs you"
        case .warning:    return "error"
        case .stuck:      return "stuck"
        case .stopped:    return "stopped"
        }
    }

    /// Lower = higher attention = sorted first and survives the menu-bar cap.
    /// Order: needs-you › warning › stuck › stopped › working › starting › done.
    var sortPriority: Int {
        switch self {
        case .needsInput: return 0
        case .warning:    return 1
        case .stuck:      return 2
        case .stopped:    return 3
        case .working:    return 4
        case .starting:   return 5
        case .done:       return 6
        }
    }

    /// Which dots to draw when there are more sessions than the menu bar has room for: the most urgent
    /// ones win a seat (ties go to the earlier session), and the survivors keep their original order.
    /// The first `protectFirst` dots (the user's high-priority sessions) always keep a seat.
    static func menuBarSelection(_ states: [AgentState], max: Int, protectFirst: Int = 0) -> [AgentState] {
        guard states.count > max else { return states }
        let protected = min(max, Swift.max(0, protectFirst))
        let ranked = states.enumerated().sorted {
            let a = $0.offset < protected ? -1 : $0.element.sortPriority
            let b = $1.offset < protected ? -1 : $1.element.sortPriority
            return (a, $0.offset) < (b, $1.offset)
        }
        let keep = Set(ranked.prefix(max).map { $0.offset })
        return states.enumerated().filter { keep.contains($0.offset) }.map { $0.element }
    }

    /// Attention states pulse to catch the eye: "needs you" (input/permission), "error"
    /// and "stuck" — the states that want you to look. Everything else is static.
    var pulses: Bool { self == .needsInput || self == .warning || self == .stuck }
}
