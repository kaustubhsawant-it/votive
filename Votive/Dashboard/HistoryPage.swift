import SwiftUI
import Charts

/// What the readings looked like over time, for the weekly or the session window.
struct HistoryPage: View {
    let model = DashboardModel.shared
    @State private var range = Span.week
    @State private var metric = Metric.weekly
    @State private var selected: Date?

    enum Span: String, CaseIterable, Identifiable {
        case day = "24 hours", week = "7 days", month = "30 days"
        var id: String { rawValue }
        var seconds: Double { self == .day ? 86_400 : (self == .week ? 7 * 86_400 : 30 * 86_400) }
    }
    enum Metric: String, CaseIterable, Identifiable {
        case weekly = "Weekly", session = "Session"
        var id: String { rawValue }
    }

    private struct Reading: Identifiable { let at: Date; let value: Double; let window: Int; var id: Date { at } }

    private var readings: [Reading] {
        let from = Date().addingTimeInterval(-range.seconds)
        let all: [Reading] = model.samples.compactMap { s in
            let v = metric == .weekly ? s.w : s.s
            let r = metric == .weekly ? s.wr : s.sr
            guard let v, let r else { return nil }
            let at = Date(timeIntervalSince1970: s.t / 1000)
            return at >= from ? Reading(at: at, value: v, window: Int(r)) : nil
        }
        let stride = max(1, all.count / 500)
        return all.enumerated().filter { $0.offset % stride == 0 || $0.offset == all.count - 1 }.map { $0.element }
    }

    var body: some View {
        PageForm {
            Section {
                Picker("Window", selection: $metric) { ForEach(Metric.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                Picker("Range", selection: $range) { ForEach(Span.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
            }
            let data = readings
            if model.report == nil {
                Color.clear.frame(height: 200).listRowBackground(Color.clear)
            } else if data.count < 2 {
                EmptyPage(title: "No readings in the last \(range.rawValue)", symbol: "calendar.badge.exclamationmark",
                          message: "Votive records the plan limits only while an agent is running, so a quiet stretch has no readings. Try a longer range.")
            } else {
                Section { chart(data).padding(.vertical, 6) } header: { SectionLabel("\(metric.rawValue) limit used") }
                summary(data)
            }
        }
    }

    private func chart(_ data: [Reading]) -> some View {
        let hit = selected.flatMap { s in data.min { abs($0.at.timeIntervalSince(s)) < abs($1.at.timeIntervalSince(s)) } }
        return Chart {
            RuleMark(y: .value("Alert", UsageSnapshot.alertThreshold)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 4])).foregroundStyle(Color.secondary)
                .annotation(position: .top, alignment: .leading, spacing: 2) { Text("Menu-bar alert \(Int(UsageSnapshot.alertThreshold))%").font(.caption2).foregroundStyle(.secondary) }
            ForEach(data) { r in
                LineMark(x: .value("Time", r.at), y: .value("Used", r.value), series: .value("Window", r.window))
                    .foregroundStyle(Color.accentColor).lineStyle(StrokeStyle(lineWidth: 2.2))
            }
            if let hit {
                RuleMark(x: .value("Time", hit.at)).foregroundStyle(Color.secondary.opacity(0.5))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(Fmt.dayClock(hit.at)).font(.caption2).foregroundStyle(.secondary)
                            Text("Used \(Fmt.percent(hit.value))").font(.caption.weight(.semibold)).monospacedDigit()
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                PointMark(x: .value("Time", hit.at), y: .value("Used", hit.value)).foregroundStyle(Color.accentColor)
            }
        }
        .chartXSelection(value: $selected)
        .chartYScale(domain: 0...100)
        .chartYAxis { AxisMarks(position: .leading, values: [0, 25, 50, 75, 100]) { v in AxisGridLine(); AxisValueLabel { if let d = v.as(Double.self) { Text("\(Int(d))%").monospacedDigit() } } } }
        .frame(height: 300)
        .accessibilityLabel("\(metric.rawValue) limit used over the last \(range.rawValue)")
    }

    private func summary(_ data: [Reading]) -> some View {
        let peak = data.max { $0.value < $1.value }
        let resets = max(0, Set(data.map { $0.window }).count - 1)
        return Section(header: SectionLabel("In this range")) {
            LabeledContent("Readings") { Text("\(data.count)").monospacedDigit() }
            LabeledContent("Highest") { Text(peak.map { "\(Fmt.percent($0.value)), \(Fmt.dayClock($0.at))" } ?? "–").monospacedDigit() }
            LabeledContent("Window resets") { Text("\(resets)").monospacedDigit() }
        }
    }
}
