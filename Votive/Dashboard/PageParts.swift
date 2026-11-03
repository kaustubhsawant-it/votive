import SwiftUI

/// Pieces several pages share. Every page is a native grouped Form (the same container System Settings uses), so
/// spacing, section headers, row insets and the system text styles come from macOS and not from numbers in this app.
/// Fonts: only the system font and SF Symbols, which ship with macOS; nothing is bundled or licensed.

/// A page: a grouped Form in a readable column.
struct PageForm<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        Form { content }
            .formStyle(.grouped)
            .headerProminence(.increased)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
    }
}

/// A section's title, drawn the same way everywhere (the system styles the first header after the page top differently).
struct SectionLabel: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View { Text(title).font(.headline).foregroundStyle(.primary).textCase(nil) }
}

/// The sentence a page opens with, then an optional quieter line. No card behind it.
struct HeadlineRow: View {
    let title: String
    var detail: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            if let detail { Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
        .textCase(nil)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Content that belongs at the top of a page but is not a list: a headline, or the hero panel. A section header has no
/// card behind it, which a grouped Form row cannot avoid; the section itself has no rows, so it draws nothing.
struct PageTop<Header: View>: View {
    @ViewBuilder var header: Header
    var body: some View { Section { EmptyView() } header: { header.textCase(nil).padding(.bottom, 10) } }
}

/// A bar for a share of a limit with a tick at the alert level. A bar, not a gauge: easier to compare and to read.
struct LimitBar: View {
    let value: Double          // 0...100
    var tick: Double? = nil    // e.g. 70
    var height: CGFloat = 8

    private var fill: Color { value > 90 ? .red : (value > (tick ?? 101) ? .orange : .accentColor) }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.10))
                Capsule().fill(fill).frame(width: max(height, geo.size.width * min(1, max(0, value / 100))))
                if let tick {
                    Capsule().fill(Color.primary.opacity(0.5)).frame(width: 2, height: height + 6)
                        .offset(x: geo.size.width * tick / 100 - 1)
                }
            }
            .frame(height: height).frame(maxHeight: .infinity)
        }
        .frame(height: height + 6)
        .accessibilityElement()
        .accessibilityLabel("\(Int(value.rounded())) percent used")
    }
}

/// "Nothing here yet" with what to do about it.
struct EmptyPage: View {
    let title: String
    let symbol: String
    let message: String
    var body: some View {
        ContentUnavailableView(title, systemImage: symbol, description: Text(message))
            .frame(maxWidth: .infinity, minHeight: 300)
            .listRowBackground(Color.clear)
    }
}

/// A row of the chart legend: a sample of the mark, then its name.
struct LegendItem<Mark: View>: View {
    let label: String
    @ViewBuilder var mark: Mark
    init(label: String, @ViewBuilder mark: () -> Mark) { self.label = label; self.mark = mark() }
    var body: some View { HStack(spacing: 6) { mark; Text(label).foregroundStyle(.secondary) } }
}

struct DashedLine: Shape {
    func path(in rect: CGRect) -> Path { var p = Path(); p.move(to: CGPoint(x: 0, y: rect.midY)); p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)); return p }
}

enum Fmt {
    static func percent(_ v: Double) -> String { "\(Int((v + 0.5).rounded(.down)))%" }
    /// A figure past what the plan can hold is a bound, not 286%.
    static func capped(_ v: Double) -> String { v > 150 ? "over 150%" : percent(v) }

    static func clock(_ date: Date) -> String {
        let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("jmm"); return f.string(from: date)
    }
    static func dayClock(_ date: Date) -> String {
        let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEEjmm"); return f.string(from: date)
    }
    static func hourLabel(_ h: Int) -> String { (h < 10 ? "0" : "") + "\(h):00" }
}

extension Font {
    /// Big figures: the system's rounded design with fixed-width digits, so a live number does not jitter.
    static func figure(_ size: CGFloat, weight: Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .rounded).monospacedDigit()
    }
}
