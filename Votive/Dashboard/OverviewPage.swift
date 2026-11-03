import SwiftUI

/// The glance: the forecast in one panel, where each limit stands, and the sessions.
struct OverviewPage: View {
    let go: (DashboardPage) -> Void
    let model = DashboardModel.shared

    var body: some View {
        PageForm {
            if let report = model.report, report.forecast != nil || model.usage != nil || !model.sessions.isEmpty || report.samples > 0 {
                PageTop { ForecastHero(report: report, go: go) }
                limits
                if !model.sessions.isEmpty { sessions }
            } else if model.report == nil {
                // The first read takes milliseconds; show nothing rather than a flash of "empty".
                Color.clear.frame(height: 200).listRowBackground(Color.clear)
            } else {
                EmptyPage(title: "Nothing to show yet", symbol: "chart.xyaxis.line",
                          message: "Votive learns from the plan limits your agents report. They appear after the next reply in Claude Code (claude.ai login) or the next turn in Codex.")
            }
        }
    }

    // MARK: Limits

    @ViewBuilder
    private var limits: some View {
        if let usage = model.usage {
            ForEach(Array(usage.agents.enumerated()), id: \.offset) { i, agent in
                Section {
                    ForEach(Array(agent.windows.enumerated()), id: \.offset) { _, w in LimitRow(window: w) }
                } header: {
                    SectionLabel("\(agent.agentName) limits")
                } footer: {
                    if i == usage.agents.count - 1 { Text("The tick marks \(Int(UsageSnapshot.alertThreshold))%, where the menu-bar icon starts to pulse.") }
                }
            }
        } else {
            Section(header: SectionLabel("Plan limits")) {
                Text("Waiting for an agent to report. Limits appear after the next reply in Claude Code or the next turn in Codex.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Sessions

    private var sessions: some View {
        Section(header: SectionLabel("Sessions now")) {
            ForEach(model.sessions.prefix(8), id: \.id) { s in
                LabeledContent {
                    Text(s.state.label)    // the state is always written, never colour alone
                } label: {
                    HStack(spacing: 8) {
                        Circle().fill(Color(nsColor: s.state.color)).frame(width: 9, height: 9).accessibilityHidden(true)
                        Text(s.name).lineLimit(1)
                        Text(s.agentName).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// One limit window: its name and number, the bar, and when it resets.
private struct LimitRow: View {
    let window: UsageWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                Spacer()
                Text(Fmt.percent(window.usedPercentage)).font(.figure(17))
            }
            LimitBar(value: window.usedPercentage, tick: UsageSnapshot.alertThreshold)
            Text("Resets " + (Calendar.current.isDateInToday(window.resetsAt) ? Fmt.clock(window.resetsAt) : Fmt.dayClock(window.resetsAt)))
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// The one glass panel: the forecast for the weekly limit in a sentence and a number.
struct ForecastHero: View {
    let report: UsageHabits.Report
    let go: (DashboardPage) -> Void

    var body: some View {
        Button { go(.forecast) } label: {
            VStack(alignment: .leading, spacing: 12) {
                if let f = report.forecast { content(f) } else { learning }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .heroPanel(tint: tint)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens Forecast")
    }

    private var tint: Color? {
        guard let f = report.forecast else { return nil }
        if f.projected >= 100 { return .red }
        return f.over > 0 ? .orange : .green
    }

    @ViewBuilder
    private func content(_ f: UsageHabits.Forecast) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Label("Weekly limit at the reset", systemImage: "chart.line.uptrend.xyaxis").font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        if f.projected >= 100 {
            // Over 100% is not a number to read off, it is a message: the week will not last.
            Text("Likely to run out").font(.system(size: 34, weight: .bold, design: .rounded))
            Text((f.projected > 150 ? "At this pace you would be well past the limit before the reset" : "At this pace about \(Fmt.percent(f.projected)) by the reset")
                 + "\(rangeText(f)), and \(Fmt.percent(f.used)) is used now.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } else {
            Text(Fmt.percent(f.projected)).font(.figure(48, weight: .bold))
            Text("\(rangeText(f, bare: true))\(Fmt.percent(f.used)) used now, target \(Fmt.percent(report.target)).")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        verdict(f).font(.callout.weight(.medium))
        if !report.backtest.enough || report.backtest.days < UsageHabits.sureDays {
            Text("Based on \(report.daysSeen) whole day\(report.daysSeen == 1 ? "" : "s") of history. Read the range, not the single number.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func rangeText(_ f: UsageHabits.Forecast, bare: Bool = false) -> String {
        guard let lo = f.low, let hi = f.high else { return "" }
        return bare ? "Likely \(Fmt.percent(lo)) to \(Fmt.capped(hi)). " : " (likely \(Fmt.percent(lo)) to \(Fmt.capped(hi)))"
    }

    @ViewBuilder
    private func verdict(_ f: UsageHabits.Forecast) -> some View {
        if f.projected >= 100 {
            Label("Move big jobs after the reset.", systemImage: "exclamationmark.triangle.fill")
        } else if f.over > 0 {
            Label("\(Fmt.percent(f.over)) over your target.", systemImage: "arrow.up.right.circle.fill")
        } else if f.spare >= 5 {
            Label("About \(Fmt.percent(f.spare)) of the week is likely to go unused.", systemImage: "leaf.fill")
        } else {
            Label("Close to your target.", systemImage: "checkmark.circle.fill")
        }
    }

    @ViewBuilder
    private var learning: some View {
        Label("Weekly forecast", systemImage: "chart.line.uptrend.xyaxis").font(.subheadline).foregroundStyle(.secondary)
        if let line = report.insights.last(where: { $0.hasPrefix("Not enough") || $0.hasPrefix("No current") }) {
            Text(line).font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
        } else {
            Text("Learning your habits").font(.title3.weight(.semibold))
        }
        ProgressView(value: min(1, Double(report.daysSeen) / Double(UsageHabits.minDaysForecast))) {
            Text("\(report.daysSeen) of \(UsageHabits.minDaysForecast) whole days needed").font(.caption).foregroundStyle(.secondary)
        }
    }
}
