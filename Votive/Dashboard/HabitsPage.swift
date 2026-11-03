import SwiftUI
import Charts

/// When the plan gets used, and how far to trust what Votive has learned about it.
struct HabitsPage: View {
    let model = DashboardModel.shared

    var body: some View {
        PageForm {
            if let report = model.report, let rhythm = report.rhythm {
                PageTop { HeadlineRow(title: report.insights.first ?? "") }
                summary(rhythm)
                byHour(report, rhythm)
                perDay(report)
                sureness(report)
                notes(report)
            } else if model.report == nil {
                Color.clear.frame(height: 200).listRowBackground(Color.clear)
            } else {
                EmptyPage(title: "Not enough history yet", symbol: "clock.badge.questionmark",
                          message: "Votive learns your rhythm from the plan limits your agents report. A day or two of use is enough to start.")
            }
        }
    }

    // MARK: Summary: plain key and value rows

    private func summary(_ r: UsageHabits.Rhythm) -> some View {
        Section(header: SectionLabel("Your rhythm")) {
            LabeledContent("Busiest hours") { Text("\(Fmt.hourLabel(r.peakStart)) to \(Fmt.hourLabel(r.peakEnd)), \(Fmt.percent(r.peakShare * 100)) of your use") }
            LabeledContent("A weekday") { Text(r.weekdayPerDay.map { Self.points($0) + " points" } ?? "No whole weekday yet") }
            LabeledContent("A weekend day") { Text(r.weekendPerDay.map { Self.points($0) + " points" } ?? "No whole weekend day yet") }
            LabeledContent("Weekday working hours") { Text(r.weekdayDaytimeShare.map { Fmt.percent($0 * 100) + " of use (09:00 to 18:00)" } ?? "–") }
        }
    }

    private static func points(_ v: Double) -> String { v < 10 ? String(format: "%.1f", v) : String(Int(v.rounded())) }

    // MARK: By hour

    private func byHour(_ report: UsageHabits.Report, _ r: UsageHabits.Rhythm) -> some View {
        let top = max(1, ((report.model.we + report.model.wd).max() ?? 1) * 1.15)
        let peak = Set((0..<4).map { (r.peakStart + $0) % 24 })
        return Section {
            VStack(alignment: .leading, spacing: 18) {
                HourChart(title: "Weekdays", values: report.model.wd, top: top, peak: peak)
                HourChart(title: "Weekends", values: report.model.we, top: top, peak: peak)
            }
            .padding(.vertical, 6)
        } header: { SectionLabel("Expected use by hour") } footer: {
            Text("Points of the weekly limit per clock hour. The highlighted bars are your busiest four hours.")
        }
    }

    // MARK: Per day

    @ViewBuilder
    private func perDay(_ report: UsageHabits.Report) -> some View {
        let days = Array(report.model.days.suffix(28))
        if days.count >= 2 {
            Section {
                Chart(days) { d in
                    BarMark(x: .value("Day", Date(timeIntervalSince1970: d.start / 1000), unit: .day), y: .value("Points", d.total))
                        .foregroundStyle(by: .value("Kind", d.weekend ? "Weekend" : "Weekday"))
                }
                .chartForegroundStyleScale(["Weekday": Color.accentColor, "Weekend": Color.orange])
                .chartXAxis { AxisMarks(values: .stride(by: .day)) { _ in AxisValueLabel(format: .dateTime.weekday(.narrow)) } }
                .chartLegend(position: .top, alignment: .leading)
                .frame(height: 180)
                .padding(.vertical, 6)
                .accessibilityLabel("Points of the weekly limit used on each whole day")
            } header: { SectionLabel("Points used each day") } footer: { Text("Whole days Votive has seen, midnight to midnight.") }
        }
    }

    // MARK: How sure

    private func sureness(_ report: UsageHabits.Report) -> some View {
        let b = report.backtest
        return Section {
            if b.enough {
                Chart {
                    BarMark(x: .value("Points off", b.maeModel), y: .value("Method", "Votive's model"))
                        .foregroundStyle(Color.accentColor).annotation(position: .trailing) { Text(Self.points(b.maeModel) + " points").font(.caption).monospacedDigit() }
                    BarMark(x: .value("Points off", b.maeBaseline), y: .value("Method", "An average day"))
                        .foregroundStyle(Color.secondary.opacity(0.55)).annotation(position: .trailing) { Text(Self.points(b.maeBaseline) + " points").font(.caption).monospacedDigit() }
                }
                .chartXAxis(.hidden)
                .chartXScale(domain: 0...(max(b.maeModel, b.maeBaseline) * 1.4 + 0.1))
                .frame(height: 96)
                .padding(.vertical, 6)
                .accessibilityLabel("Average error per day: Votive's model \(Self.points(b.maeModel)) points, an average day \(Self.points(b.maeBaseline)) points")
            }
            if let check = report.insights.first(where: { $0.hasPrefix("Check:") || $0.hasPrefix("Too early") }) {
                Label(check.replacingOccurrences(of: "Check: ", with: ""), systemImage: b.days >= UsageHabits.sureDays && b.beatsBaseline ? "checkmark.seal" : "exclamationmark.circle")
                    .fixedSize(horizontal: false, vertical: true)
            }
            ProgressView(value: min(1, Double(b.days) / Double(UsageHabits.sureDays))) {
                Text("\(b.days) of \(UsageHabits.sureDays) days seen before it can claim to beat a plain average").font(.caption).foregroundStyle(.secondary)
            }
        } header: { SectionLabel("How sure is it?") } footer: {
            if b.enough { Text("Votive predicts each day it has seen using only the other days, then compares with guessing \"an average day\". A shorter bar is better.") }
        }
    }

    private func notes(_ report: UsageHabits.Report) -> some View {
        let rest = report.insights.filter { !$0.hasPrefix("Check:") && !$0.hasPrefix("Too early") }
        return Section(header: SectionLabel("In words")) {
            ForEach(Array(rest.enumerated()), id: \.offset) { _, line in
                Text(line).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct HourChart: View {
    let title: String
    let values: [Double]
    let top: Double
    let peak: Set<Int>

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline.weight(.semibold))
            Chart(0..<24, id: \.self) { h in
                BarMark(x: .value("Hour", Fmt.hourLabel(h)), y: .value("Points", values[h]))
                    .foregroundStyle(peak.contains(h) ? Color.accentColor : Color.secondary.opacity(0.4))
            }
            .chartYScale(domain: 0...top)
            .chartXAxis {
                AxisMarks(values: [0, 3, 6, 9, 12, 15, 18, 21].map { Fmt.hourLabel($0) }) { v in AxisGridLine(); AxisValueLabel { if let s = v.as(String.self) { Text(String(s.prefix(2))) } } }
            }
            .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
            .frame(height: 110)
            .accessibilityLabel("\(title): expected points of the weekly limit for each hour of the day")
        }
    }
}
