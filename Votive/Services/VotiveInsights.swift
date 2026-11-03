import Foundation

/// The insights card: a few short, ranked things worth knowing right now, one card each. Every line exists only
/// because a real condition holds, lines are ranked critical first, then warning, then "all clear" (only when nothing is urgent), then tips, at most `maxInsights`. Pure: it takes
/// plain values and returns plain values, so it is tested without the window.
///
/// Copy is short on purpose: a title of a few words with its count, one body sentence that names the worst item and its
/// number, and one action that goes to the right page. The card is narrow and copy that runs long gets cut.
enum InsightTone: Int, Comparable {
    case critical, warning, good, info
    static func < (a: InsightTone, b: InsightTone) -> Bool { a.rawValue < b.rawValue }

    /// Said in words on the card, so the tone is never carried by colour alone.
    var label: String {
        switch self {
        case .critical: return "Critical"
        case .warning:  return "Warning"
        case .good:     return "All clear"
        case .info:     return "Tip"
        }
    }
}

/// Where an insight's action leads (the window maps these to its pages).
enum InsightTarget: String {
    case overview, forecast, habits, history, agents

    var actionLabel: String {
        switch self {
        case .overview: return "Open overview"
        case .forecast: return "See forecast"
        case .habits:   return "See habits"
        case .history:  return "See history"
        case .agents:   return "Review changes"
        }
    }
}

struct Insight: Identifiable, Equatable {
    let id: String
    let tone: InsightTone
    let title: String
    let body: String
    let target: InsightTarget
    var action: String { target.actionLabel }
}

/// One plan-limit window as the card needs it.
struct LimitReading: Equatable {
    let agent: String
    let label: String
    let used: Double
    let resetsAt: Date
    let updatedAt: Date
}

struct InsightInputs {
    var sessions: [AgentSession] = []
    var limits: [LimitReading] = []
    var report: UsageHabits.Report?
    /// Settings agents changed through the MCP tools in the last 24 hours.
    var agentChanges = 0
    var now = Date()
    /// How a reset time is written ("Mon 5:30 AM"); injectable so tests do not depend on the locale.
    var resetText: (Date) -> String = { d in
        let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEEjmm"); return f.string(from: d)
    }
}

enum VotiveInsights {
    static let maxInsights = 6
    /// Above this the limit line is critical; above the app's alert threshold (70%) it is a warning.
    static let criticalPercent = 90.0
    static let staleAfter: TimeInterval = 6 * 3600

    static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) " + (n == 1 ? one : (many ?? one + "s")) }

    /// "A", "A and B", "A and 2 more".
    static func names(_ ps: [AgentSession]) -> String {
        ps.count <= 2 ? ps.map { $0.name }.joined(separator: " and ") : "\(ps[0].name) and \(ps.count - 1) more"
    }

    private static func pct(_ v: Double) -> String { "\(Int((v + 0.5).rounded(.down)))%" }
    /// A figure past what the plan can hold is shown as a bound, not as 286%.
    private static func capped(_ v: Double) -> String { v > 150 ? "over 150%" : pct(v) }
    private static func hour(_ n: Int) -> String { (n < 10 ? "0" : "") + "\(n):00" }

    static func compute(_ i: InsightInputs) -> [Insight] {
        var found: [Insight] = []

        // Sessions: what wants a person, worst first.
        func sessions(_ state: AgentState) -> [AgentSession] { i.sessions.filter { $0.state == state } }
        let stopped = sessions(.stopped), needs = sessions(.needsInput), errored = sessions(.warning), stuck = sessions(.stuck)
        if !stopped.isEmpty {
            found.append(Insight(id: "sessions-stopped", tone: .critical, title: plural(stopped.count, "session") + " stopped",
                                 body: "\(names(stopped)) \(stopped.count == 1 ? "is" : "are") no longer running.", target: .overview))
        }
        if !needs.isEmpty {
            found.append(Insight(id: "sessions-needs", tone: .warning, title: plural(needs.count, "session") + (needs.count == 1 ? " needs you" : " need you"),
                                 body: "\(names(needs)) \(needs.count == 1 ? "is" : "are") waiting for you.", target: .overview))
        }
        if !errored.isEmpty {
            found.append(Insight(id: "sessions-error", tone: .warning, title: plural(errored.count, "session") + " hit an error",
                                 body: "\(names(errored)) reported an error and \(errored.count == 1 ? "is" : "are") still running.", target: .overview))
        }
        if !stuck.isEmpty {
            found.append(Insight(id: "sessions-stuck", tone: .warning, title: plural(stuck.count, "session") + (stuck.count == 1 ? " looks stuck" : " look stuck"),
                                 body: "\(names(stuck)) \(stuck.count == 1 ? "has" : "have") not moved for a while.", target: .overview))
        }

        // Plan limits that are close to full, the fullest first.
        let high = i.limits.filter { $0.used > UsageSnapshot.alertThreshold }.sorted { $0.used > $1.used }
        for l in high {
            let critical = l.used > criticalPercent
            found.append(Insight(id: "limit-\(l.agent)-\(l.label)", tone: critical ? .critical : .warning,
                                 title: "\(l.label) limit at \(pct(l.used))",
                                 body: critical ? "\(l.agent) resets \(i.resetText(l.resetsAt)). Move big jobs after it."
                                                : "\(l.agent) resets \(i.resetText(l.resetsAt)).",
                                 target: l.label == "Weekly" ? .forecast : .overview))
        }

        // The forecast, only when the model has one.
        if let r = i.report, let f = r.forecast {
            if f.projected >= 100 {
                let body = f.projected > 150 ? "At this pace you would be well past the limit before the reset."
                    : "At this pace about \(pct(f.projected)) by the reset (likely \(f.low.map(pct) ?? "?") to \(f.high.map(capped) ?? "?"))."
                found.append(Insight(id: "forecast-runout", tone: .warning, title: "Weekly limit may run out", body: body, target: .forecast))
            } else if f.over > 0 {
                found.append(Insight(id: "forecast-over", tone: .warning, title: "Forecast is over target",
                                     body: "About \(pct(f.over)) over your \(Int(r.target))% target at the reset.", target: .forecast))
            } else if f.spare >= 5 {
                found.append(Insight(id: "forecast-spare", tone: .info, title: "Room to spare",
                                     body: "About \(pct(f.spare)) of the week may go unused. A longer job around \(hour(r.rhythm?.peakStart ?? 20)) would use it.",
                                     target: .forecast))
            }
        }

        // Settings an agent changed lately: worth a look, never urgent.
        if i.agentChanges > 0 {
            found.append(Insight(id: "agent-changes", tone: .info, title: plural(i.agentChanges, "setting") + " changed by agents",
                                 body: "In the last 24 hours. Review them, and undo any you did not want.", target: .agents))
        }

        let urgent = found.contains { $0.tone == .critical || $0.tone == .warning }

        // All clear, only when something exists to be clear about and nothing is urgent.
        if !urgent && (!i.sessions.isEmpty || !i.limits.isEmpty) {
            var parts: [String] = []
            if !i.sessions.isEmpty { parts.append("\(plural(i.sessions.count, "session")), none need you") }
            if !i.limits.isEmpty { parts.append("every limit is under \(Int(UsageSnapshot.alertThreshold))%") }
            let sentence = parts.joined(separator: " and ")
            let body = sentence.prefix(1).uppercased() + sentence.dropFirst() + "."
            found.append(Insight(id: "all-clear", tone: .good, title: "Everything looks normal", body: body, target: .overview))
        }

        // Tips: last, and each only when its condition really holds.
        if let r = i.report {
            if let rhythm = r.rhythm {
                found.append(Insight(id: "tip-hours", tone: .info, title: "Your busiest hours",
                                     body: "\(pct(rhythm.peakShare * 100)) of your use falls between \(hour(rhythm.peakStart)) and \(hour(rhythm.peakEnd)).", target: .habits))
            }
            if r.samples > 0 && !(r.backtest.enough && r.backtest.days >= UsageHabits.sureDays) {
                found.append(Insight(id: "tip-learning", tone: .info, title: "Still learning your habits",
                                     body: "\(plural(r.daysSeen, "whole day")) seen. The forecast is a rough guide until \(UsageHabits.sureDays).", target: .habits))
            }
        }
        if let oldest = i.limits.map({ $0.updatedAt }).min(), i.now.timeIntervalSince(oldest) > staleAfter {
            let hours = Int(i.now.timeIntervalSince(oldest) / 3600)
            found.append(Insight(id: "tip-stale", tone: .info, title: "Limits may be out of date",
                                 body: "Last updated \(hours) h ago. They refresh when an agent replies.", target: .overview))
        }

        // Stable by tone: the order they were found in is kept inside one tone.
        let ranked = found.enumerated().sorted { ($0.element.tone, $0.offset) < ($1.element.tone, $1.offset) }.map { $0.element }
        return Array(ranked.prefix(maxInsights))
    }
}
