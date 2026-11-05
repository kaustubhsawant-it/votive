import SwiftUI

/// The window: a sidebar of pages (the system gives it the glass look on macOS 26) and the page beside it.
struct DashboardView: View {
    let model = DashboardModel.shared
    @AppStorage("dashboardPage") private var lastPage = DashboardPage.overview.rawValue
    @AppStorage("insightsShow") private var showInsights = true

    private var selection: Binding<DashboardPage?> {
        Binding(get: { DashboardPage(rawValue: lastPage) ?? .overview },
                set: { if let page = $0 { lastPage = page.rawValue } })
    }
    private var page: DashboardPage { DashboardPage(rawValue: lastPage) ?? .overview }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                Section("Usage") {
                    ForEach(DashboardPage.usagePages) { p in Label(p.title, systemImage: p.symbol).tag(p) }
                }
                Section("Votive") {
                    ForEach(DashboardPage.settingsPages) { p in Label(p.title, systemImage: p.symbol).tag(p) }
                }
            }
            .listStyle(.sidebar)
            .safeAreaInset(edge: .bottom, spacing: 0) { sidebarFooter }
            .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 290)
        } detail: {
            detail
                .navigationTitle(page.title)
                .toolbar { toolbar }
        }
        .frame(minWidth: 820, minHeight: 500)
        .onAppear { applyPending() }
        .onChange(of: model.pendingPage) { _, _ in applyPending() }
    }

    @ViewBuilder
    private var detail: some View {
        switch page {
        case .overview: OverviewPage(go: { model.open($0) })
        case .forecast: ForecastPage()
        case .habits:   HabitsPage()
        case .history:  HistoryPage()
        case .general:  GeneralSettingsPage()
        case .order:    OrderPage()
        case .alerts:   AlertSettingsPage()
        case .colors:   ColorSettingsPage()
        case .sounds:   SoundSettingsPage()
        case .agents:   AgentSettingsPage()
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button { model.refresh() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                .help("Read the usage history again now (\u{2318}R)")
                .keyboardShortcut("r", modifiers: .command)
        }
    }

    /// The insights card, and under it how fresh the numbers are, as plain text: a status is not a button.
    private var sidebarFooter: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showInsights { InsightsCard(insights: model.insights, open: { go($0) }) }
            if let at = model.loadedAt {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Label("Updated " + Self.ago(at, now: context.date), systemImage: "clock")
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                .help("The usage history is re-read every minute while this window is open.")
                .padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 10)
    }

    private func go(_ target: InsightTarget) {
        switch target {
        case .overview: model.open(.overview)
        case .forecast: model.open(.forecast)
        case .habits:   model.open(.habits)
        case .history:  model.open(.history)
        case .agents:   model.open(.agents)
        }
    }

    static func ago(_ date: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60) min ago" }
        return "\(s / 3600) h ago"
    }

    private func applyPending() {
        guard let next = model.pendingPage else { return }
        lastPage = next.rawValue
        model.pendingPage = nil
    }
}
