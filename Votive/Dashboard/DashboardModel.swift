import Foundation
import Observation
import SwiftUI

/// Where the window can open.
enum DashboardPage: String, CaseIterable, Identifiable {
    case overview, forecast, habits, history
    case general, alerts, colors, sounds, agents

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .forecast: return "Forecast"
        case .habits:   return "Habits"
        case .history:  return "History"
        case .general:  return "General"
        case .alerts:   return "Alerts"
        case .colors:   return "Colors"
        case .sounds:   return "Sounds"
        case .agents:   return "Agents & tools"
        }
    }

    var symbol: String {
        switch self {
        case .overview: return "gauge.with.dots.needle.50percent"
        case .forecast: return "chart.line.uptrend.xyaxis"
        case .habits:   return "clock.badge.checkmark"
        case .history:  return "calendar"
        case .general:  return "gearshape"
        case .alerts:   return "bell"
        case .colors:   return "paintpalette"
        case .sounds:   return "speaker.wave.2"
        case .agents:   return "wrench.and.screwdriver"
        }
    }

    static let usagePages: [DashboardPage] = [.overview, .forecast, .habits, .history]
    static let settingsPages: [DashboardPage] = [.general, .alerts, .colors, .sounds, .agents]
}

/// What the window shows. The menu bar item stays the always-on view and keeps feeding this (`usage`, `sessions`); the
/// habits report is worked out from the usage history file, off the main thread, whenever the window asks.
@Observable
final class DashboardModel {
    static let shared = DashboardModel()

    /// Live, from the menu-bar controller.
    var usage: UsageSnapshot?
    var sessions: [AgentSession] = []

    /// From the history file.
    var agents: [String] = []
    var agent = AgentKind.claudeCode
    var samples: [HabitSample] = []
    var report: UsageHabits.Report?
    var loadedAt: Date?
    var loading = false

    /// Settings agents changed through the MCP tools in the last 24 hours (for the insights card).
    var agentChanges = 0

    /// What the insights card says now: derived from the live data above, ranked, at most six.
    var insights: [Insight] {
        let limits = (usage?.agents ?? []).flatMap { a in
            a.windows.map { LimitReading(agent: a.agentName, label: $0.label, used: $0.usedPercentage, resetsAt: $0.resetsAt, updatedAt: a.updatedAt) }
        }
        return VotiveInsights.compute(InsightInputs(sessions: sessions, limits: limits, report: report, agentChanges: agentChanges, now: Date()))
    }

    /// A page somebody asked for (the menu, a link inside a page). The window moves there and clears it.
    var pendingPage: DashboardPage?

    static let targetKey = "usageTargetPercent"
    static let defaultTarget = 80.0

    /// The share of the weekly limit the owner aims to use (Settings > General). Only the forecast reads it.
    static var target: Double {
        let v = UserDefaults.standard.object(forKey: targetKey) as? Double
        return min(100, max(10, v ?? defaultTarget))
    }

    private let queue = DispatchQueue(label: "dev.votive.Votive.dashboard", qos: .userInitiated)
    private init() {}

    func open(_ page: DashboardPage) { pendingPage = page }

    /// Re-reads the history and refits the model. Cheap (milliseconds), so it runs whenever the window is shown, every
    /// minute while it is open, and when the target or agent changes.
    func refresh() {
        let wanted = agent, target = Self.target
        loading = true
        queue.async { [weak self] in
            let found = HabitsHistory.agents()
            let pick = found.contains(wanted) ? wanted : (found.first ?? wanted)
            let samples = HabitsHistory.read(agent: pick)
            let report = UsageHabits().analyse(samples, target: target, now: Date().timeIntervalSince1970 * 1000)
            let since = (Date().timeIntervalSince1970 - 24 * 3600) * 1000
            let changes = AuditLog.recent(max: 100).filter { $0.tool != "notify" && $0.ok == true && Double($0.at) > since }.count
            DispatchQueue.main.async {
                guard let self else { return }
                self.agents = found
                self.agent = pick
                self.samples = samples
                self.report = report
                self.agentChanges = changes
                self.loadedAt = Date()
                self.loading = false
            }
        }
    }
}
