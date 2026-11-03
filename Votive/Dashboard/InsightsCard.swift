import SwiftUI

/// The insights card, at the foot of the sidebar: a few ranked, plain-language things worth knowing, one card at a
/// time. How it behaves:
///  - each insight is a whole card in its own tone (a tinted surface, an icon, the tone in words), which slides as a unit;
///  - the dots and "Next" are a fixed overlay that does not slide, so there is never a moving target to click;
///  - the sliding area is clipped, so the next card never spills over the page;
///  - it turns itself every 6 s, and while the pointer is over it waits 15 s instead of stopping;
///  - with Reduce Motion on it never turns by itself and changes cards without sliding;
///  - the card is a fixed height, and copy is short, because a narrow card cuts long text;
///  - it is not shown at all when there is nothing to say.
/// The logic that decides what to say is `VotiveInsights` (pure and tested).
struct InsightsCard: View {
    let insights: [Insight]
    let open: (InsightTarget) -> Void
    /// Tests and previews can switch the timer off.
    var autoplay = true

    static let rotate: Double = 6
    static let rotateHovered: Double = 15
    static let height: CGFloat = 168

    @State private var index = 0
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var signature: String { insights.map { $0.id }.joined(separator: ",") }
    private var page: Int { min(index, max(0, insights.count - 1)) }

    private struct Tick: Hashable { let signature: String; let index: Int; let hovering: Bool }

    var body: some View {
        if insights.isEmpty { EmptyView() } else { card }
    }

    private var card: some View {
        let current = insights[page]
        return ZStack(alignment: .bottom) {
            InsightPage(insight: current, reserveControls: insights.count > 1, open: open)
                .id(current.id)
                .transition(reduceMotion ? .identity
                    : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if insights.count > 1 {
                HStack(spacing: 0) {
                    HStack(spacing: 0) {
                        ForEach(insights.indices, id: \.self) { i in
                            Button { show(i) } label: {
                                Capsule().fill(i == page ? Color.primary.opacity(0.75) : Color.primary.opacity(0.25))
                                    .frame(width: i == page ? 14 : 6, height: 6)
                                    .frame(width: i == page ? 20 : 12, height: 22)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Insight \(i + 1) of \(insights.count)")
                            .accessibilityAddTraits(i == page ? .isSelected : [])
                        }
                    }
                    Spacer(minLength: 4)
                    Button { show((page + 1) % insights.count) } label: {
                        HStack(spacing: 2) { Text("Next").font(.caption.weight(.semibold)); Image(systemName: "chevron.right").font(.caption2.weight(.bold)) }
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .background(.thinMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                    .help("Show the next insight")
                }
                .padding(.horizontal, 14).padding(.bottom, 10)
            }
        }
        .frame(height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onHover { hovering = $0 }
        .onChange(of: signature) { _, _ in index = 0 }
        .task(id: Tick(signature: signature, index: index, hovering: hovering)) {
            guard autoplay, !reduceMotion, insights.count > 1 else { return }
            try? await Task.sleep(nanoseconds: UInt64((hovering ? Self.rotateHovered : Self.rotate) * 1_000_000_000))
            if !Task.isCancelled { show((page + 1) % insights.count) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Insights")
    }

    private func show(_ i: Int) {
        if reduceMotion { index = i } else { withAnimation(.easeInOut(duration: 0.42)) { index = i } }
    }
}

private struct InsightPage: View {
    let insight: Insight
    let reserveControls: Bool
    let open: (InsightTarget) -> Void

    private var tint: Color {
        switch insight.tone {
        case .critical: return .red
        case .warning:  return .orange
        case .good:     return .green
        case .info:     return .blue
        }
    }

    private var symbol: String {
        switch insight.tone {
        case .critical: return "exclamationmark.octagon.fill"
        case .warning:  return "exclamationmark.triangle.fill"
        case .good:     return "checkmark.circle.fill"
        case .info:     return "lightbulb.fill"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: symbol).font(.caption).foregroundStyle(tint).accessibilityHidden(true)
                Text(insight.tone.label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)   // the tone in words, not only color
            }
            Text(insight.title).font(.callout.weight(.semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Text(insight.body).font(.caption).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { open(insight.target) } label: {
                HStack(spacing: 4) { Text(insight.action).lineLimit(1); Image(systemName: "arrow.right").font(.caption2.weight(.bold)) }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if reserveControls { Color.clear.frame(height: 24) }
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(tint.opacity(0.13))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(tint.opacity(0.35)))
        .accessibilityElement(children: .combine)
        .accessibilityHint(insight.action)
    }
}
