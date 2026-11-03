import SwiftUI
import Charts

/// Where the weekly limit stands now, where it is expected to be at the reset, and how sure that is.
struct ForecastPage: View {
    let model = DashboardModel.shared
    @AppStorage(DashboardModel.targetKey) private var target = DashboardModel.defaultTarget
    @State private var selected: Date?

    private struct Reading: Identifiable { let at: Date; let value: Double; var id: Date { at } }

    var body: some View {
        PageForm {
            if let report = model.report, report.samples > 0 {
                if let f = report.forecast { forecast(report, f) } else {
                    PageTop { ForecastHero(report: report, go: { _ in }) }
                    Section {
                        Text("The forecast needs \(UsageHabits.minDaysForecast) whole days of history and a current weekly reading. Until then Votive only shows what it has seen.")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if model.report == nil {
                Color.clear.frame(height: 200).listRowBackground(Color.clear)
            } else {
                EmptyPage(title: "No usage history yet", symbol: "chart.line.uptrend.xyaxis",
                          message: "Votive keeps a small history of the plan limits your agents report. It starts after the next Claude Code status-line refresh.")
            }
        }
        .onChange(of: target) { _, _ in model.refresh() }
    }

    // MARK: Content

    @ViewBuilder
    private func forecast(_ report: UsageHabits.Report, _ f: UsageHabits.Forecast) -> some View {
        PageTop { headline(report, f) }

        Section {
            LabeledContent("Weekly target") {
                Stepper(value: $target, in: 10...100, step: 5) { Text(Fmt.percent(target)).monospacedDigit() }
                    .help("The share of the weekly limit you aim to use. It only changes what the forecast says; nothing is limited or blocked.")
            }
            VStack(alignment: .leading, spacing: 12) {
                legend
                chart(report, f)
            }
            .padding(.vertical, 6)
        } header: { SectionLabel("This window") }

        Section {
            DisclosureGroup("Numbers by day") { numbers(report) }
            DisclosureGroup("How this is worked out") {
                Text("Votive adds up how many points of the weekly limit you usually use in each remaining hour, split into weekdays and weekends and leaning on recent days, and adds that to what is used now. The shaded band is the middle 80% of how much whole days differ from each other, so it widens the further away the reset is. A point is one percent of the weekly limit. Nothing leaves this Mac.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            }
        }
    }

    /// The sentence the page opens with. Numbers past what the plan can hold are a bound, never "287%".
    private func headline(_ report: UsageHabits.Report, _ f: UsageHabits.Forecast) -> some View {
        let range = (f.low != nil && f.high != nil) ? " (likely \(Fmt.percent(f.low!)) to \(Fmt.capped(f.high!)))" : ""
        let title = f.projected >= 100 ? "Likely to run out before the reset" : "Forecast at the reset: \(Fmt.percent(f.projected))\(range)"
        let detail: String
        if f.projected >= 100 {
            detail = (f.projected > 150 ? "At this pace you would be well past the weekly limit" : "At this pace about \(Fmt.percent(f.projected)) of the weekly limit")
                + ", from \(Fmt.percent(f.used)) now. Move big jobs after the reset."
        }
        else if f.over > 0 { detail = "\(Fmt.percent(f.over)) over your \(Int(report.target))% target, from \(Fmt.percent(f.used)) now." }
        else if f.spare >= 5 { detail = "About \(Fmt.percent(f.spare)) of the week is likely to go unused against your \(Int(report.target))% target, from \(Fmt.percent(f.used)) now." }
        else { detail = "Close to your \(Int(report.target))% target, from \(Fmt.percent(f.used)) now." }
        return HeadlineRow(title: title, detail: detail)
    }

    // MARK: Chart

    private func actual(_ f: UsageHabits.Forecast) -> [Reading] {
        let wr = f.resetsAt / 1000
        let all = model.samples.compactMap { s -> Reading? in
            guard s.wr == wr, let w = s.w else { return nil }
            return Reading(at: Date(timeIntervalSince1970: s.t / 1000), value: w)
        }
        let stride = max(1, all.count / 400)
        return all.enumerated().filter { $0.offset % stride == 0 || $0.offset == all.count - 1 }.map { $0.element }
    }

    private func chart(_ report: UsageHabits.Report, _ f: UsageHabits.Forecast) -> some View {
        let used = actual(f)
        let end = Date(timeIntervalSince1970: f.resetsAt / 1000)
        let start = end.addingTimeInterval(-7 * 86_400)
        // The plan cannot go past 100%, so the chart stops just above it; a forecast beyond that is drawn at the edge and the
        // sentence above the chart says by how much (an axis stretching to 275% would hide everything that matters).
        let top = 125.0
        func cl(_ v: Double) -> Double { min(v, top) }
        return Chart {
            ForEach(report.path) { p in
                if let lo = p.low, let hi = p.high {
                    AreaMark(x: .value("Time", p.at), yStart: .value("Low", cl(lo)), yEnd: .value("High", cl(hi)), series: .value("s", "range"))
                        .foregroundStyle(Color.orange.opacity(0.16))
                }
            }
            RuleMark(y: .value("Limit", 100)).lineStyle(StrokeStyle(lineWidth: 1)).foregroundStyle(Color.red.opacity(0.55))
                .annotation(position: .top, alignment: .leading, spacing: 2) { Text("Limit 100%").font(.caption2).foregroundStyle(.secondary) }
            RuleMark(y: .value("Target", report.target)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 4])).foregroundStyle(Color.secondary)
                .annotation(position: .top, alignment: .leading, spacing: 2) { Text("Target \(Fmt.percent(report.target))").font(.caption2).foregroundStyle(.secondary) }
            ForEach(report.path) { p in
                LineMark(x: .value("Time", p.at), y: .value("Forecast", cl(p.mid)), series: .value("s", "forecast"))
                    .lineStyle(StrokeStyle(lineWidth: 2.2, dash: [6, 4])).foregroundStyle(Color.orange)
            }
            ForEach(used) { r in
                LineMark(x: .value("Time", r.at), y: .value("Used", r.value), series: .value("s", "used"))
                    .lineStyle(StrokeStyle(lineWidth: 2.6)).foregroundStyle(Color.accentColor)
            }
            if let hit = nearest(report, used) {
                RuleMark(x: .value("Time", hit.at)).foregroundStyle(Color.secondary.opacity(0.5))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) { readout(hit) }
                PointMark(x: .value("Time", hit.at), y: .value("Value", cl(hit.value))).foregroundStyle(hit.isForecast ? Color.orange : Color.accentColor)
            }
        }
        .chartXSelection(value: $selected)
        .chartXScale(domain: start...end)
        .chartYScale(domain: 0...top)
        .chartYAxis {
            AxisMarks(position: .leading, values: [0, 25, 50, 75, 100]) { v in
                AxisGridLine()
                AxisValueLabel { if let d = v.as(Double.self) { Text("\(Int(d))%").monospacedDigit() } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day)) { _ in
                AxisGridLine(); AxisTick()
                AxisValueLabel(format: .dateTime.weekday(.abbreviated), centered: true)
            }
        }
        .frame(height: 320)
        .accessibilityLabel("Weekly limit used so far and forecast to the reset")
        .accessibilityValue(report.insights.first(where: { $0.hasPrefix("Forecast at the reset") }) ?? "")
    }

    private struct Hit { let at: Date; let value: Double; let isForecast: Bool; let low: Double?; let high: Double? }

    /// The reading or forecast hour closest to the pointer.
    private func nearest(_ report: UsageHabits.Report, _ used: [Reading]) -> Hit? {
        guard let selected else { return nil }
        let now = Date(timeIntervalSince1970: report.now / 1000)
        var best: Hit?
        var bestGap = Double.infinity
        for r in used where abs(r.at.timeIntervalSince(selected)) < bestGap {
            bestGap = abs(r.at.timeIntervalSince(selected)); best = Hit(at: r.at, value: r.value, isForecast: false, low: nil, high: nil)
        }
        for p in report.path where p.at >= now && abs(p.at.timeIntervalSince(selected)) < bestGap {
            bestGap = abs(p.at.timeIntervalSince(selected)); best = Hit(at: p.at, value: p.mid, isForecast: true, low: p.low, high: p.high)
        }
        return best
    }

    private func readout(_ h: Hit) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(Fmt.dayClock(h.at)).font(.caption2).foregroundStyle(.secondary)
            Text(h.isForecast ? "Forecast \(Fmt.percent(h.value))" : "Used \(Fmt.percent(h.value))").font(.caption.weight(.semibold)).monospacedDigit()
            if let lo = h.low, let hi = h.high, h.isForecast { Text("likely \(Fmt.percent(lo)) to \(Fmt.percent(hi))").font(.caption2).monospacedDigit() }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var legend: some View {
        HStack(spacing: 14) {
            LegendItem(label: "Used so far") { Capsule().fill(Color.accentColor).frame(width: 22, height: 3) }
            LegendItem(label: "Forecast") { DashedLine().stroke(Color.orange, style: StrokeStyle(lineWidth: 2.2, dash: [5, 3])).frame(width: 22, height: 3) }
            LegendItem(label: "Likely range") { RoundedRectangle(cornerRadius: 2).fill(Color.orange.opacity(0.25)).frame(width: 18, height: 9) }
        }
        .font(.caption)
    }

    // MARK: Table (the same numbers, readable without a pointer)

    private func numbers(_ report: UsageHabits.Report) -> some View {
        let cal = Calendar.current
        var rows: [(Date, Double, Double?, Double?)] = []
        for (i, p) in report.path.enumerated() {
            let last = i == report.path.count - 1
            if last || !cal.isDate(p.at, inSameDayAs: report.path[i + 1].at) { rows.append((p.at, p.mid, p.low, p.high)) }
        }
        return VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                if i > 0 { Divider() }
                HStack {
                    Text("End of " + r.0.formatted(.dateTime.weekday(.wide)))
                    Spacer()
                    Text(Fmt.percent(r.1)).monospacedDigit().fontWeight(.semibold)
                    if let lo = r.2, let hi = r.3 { Text("\(Fmt.percent(lo)) to \(Fmt.percent(hi))").foregroundStyle(.secondary).monospacedDigit().frame(width: 130, alignment: .trailing) }
                }
                .font(.callout).padding(.vertical, 6)
            }
        }
        .padding(.top, 6)
    }
}
