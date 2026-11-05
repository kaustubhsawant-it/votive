import SwiftUI

/// The sessions in the order of the dots, each with a grab handle: drag a row to move that session's dot. The list is the
/// same in the menu-bar panel (`ReorderPopover`) and in the window (`OrderPage`). High-priority sessions are their own group
/// and stay first; a row can only be dragged inside its group, so a drag never changes anyone's priority.
struct SessionOrderList: View {
    let model = DashboardModel.shared

    var body: some View {
        let store = PriorityStore()
        let pins = store.pins, folders = store.folders
        let sessions = model.sessions
        let high = sessions.filter { SessionPriority.isHighPriority($0, pins: pins, folders: folders) }
        let rest = sessions.filter { !SessionPriority.isHighPriority($0, pins: pins, folders: folders) }
        List {
            if !high.isEmpty {
                Section("High priority") {
                    ForEach(high) { SessionOrderRow(session: $0) }
                        .onMove { move(high: high, rest: rest, inHigh: true, from: $0, to: $1) }
                }
            }
            Section {
                ForEach(rest) { SessionOrderRow(session: $0) }
                    .onMove { move(high: high, rest: rest, inHigh: false, from: $0, to: $1) }
            } header: {
                if !high.isEmpty { Text("Other sessions") }
            }
        }
        .listStyle(.inset)
        .overlay {
            if sessions.isEmpty {
                Text("No agent sessions are running. Start one and it appears here.")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding()
            }
        }
    }

    private func move(high: [AgentSession], rest: [AgentSession], inHigh: Bool, from: IndexSet, to: Int) {
        var h = high.map { $0.id }, r = rest.map { $0.id }
        if inHigh { h = SessionPriority.dragged(h, from: from, to: to) } else { r = SessionPriority.dragged(r, from: from, to: to) }
        let store = PriorityStore()
        store.setPositions(SessionPriority.placed(h + r, stored: store.positions))
        NotificationCenter.default.post(name: PriorityStore.didChange, object: nil)   // the menu-bar item redraws the dots and feeds the model
    }
}

private struct SessionOrderRow: View {
    let session: AgentSession

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "line.3.horizontal")
                .foregroundStyle(.tertiary)
                .help("Drag to move this session's dot")
                .accessibilityHidden(true)
            Circle().fill(Color(nsColor: session.state.color)).frame(width: 10, height: 10).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.name).fontWeight(.semibold).lineLimit(1)
                Text("\(session.agentName) · \(session.state.label)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Drag to reorder")
    }
}

/// Forgets the hand-set order (priority is untouched) and tells the menu-bar item to redraw.
enum SessionOrder {
    static var hasHandSetOrder: Bool { !PriorityStore().positions.isEmpty }

    static func reset() {
        PriorityStore().setPositions([])
        NotificationCenter.default.post(name: PriorityStore.didChange, object: nil)
    }
}

/// The page in the window.
struct OrderPage: View {
    @State private var tick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Drag a row by its handle to move that session's dot in the menu bar. The first row is the leftmost dot. High-priority sessions stay first, so reordering never changes priority.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            SessionOrderList()
                .frame(minHeight: 200)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            HStack {
                Button("Reset to automatic order") { SessionOrder.reset(); tick += 1 }
                    .softButton().disabled(!SessionOrder.hasHandSetOrder).id(tick)
                    .help("Forget the order you set by hand. Priority is not changed.")
                Spacer()
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: PriorityStore.didChange)) { _ in tick += 1 }
    }
}

/// The panel that opens under the menu-bar icon from **Reorder sessions…**.
struct ReorderPanel: View {
    let done: () -> Void
    @State private var tick = 0
    let model = DashboardModel.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Reorder sessions").font(.headline)
            Text("Drag a row by its handle. The dots in the menu bar follow. High-priority sessions stay first.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            SessionOrderList()
                .frame(height: min(CGFloat(max(model.sessions.count, 2)) * 44 + 36, 380))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            HStack {
                Button("Reset order") { SessionOrder.reset(); tick += 1 }
                    .disabled(!SessionOrder.hasHandSetOrder).id(tick)
                Spacer()
                Button("Done", action: done).keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(width: 340)
        .onReceive(NotificationCenter.default.publisher(for: PriorityStore.didChange)) { _ in tick += 1 }
    }
}

/// Shows `ReorderPanel` in a popover under the status item. Transient: a click outside closes it.
final class ReorderPopover: NSObject, NSPopoverDelegate {
    private var popover: NSPopover?

    func toggle(relativeTo view: NSView?) {
        if let p = popover, p.isShown { p.performClose(nil); return }
        guard let view else { return }
        let p = NSPopover()
        p.behavior = .transient
        let host = NSHostingController(rootView: ReorderPanel(done: { [weak self] in self?.popover?.performClose(nil) }))
        // Give the popover its real size before it is shown. Without it the popover is placed using a still-empty size, the content then
        // grows and pushes the top of the panel above the screen (the title and the hint were cut off). The popover also follows the
        // content afterwards, for when sessions come and go while it is open.
        host.sizingOptions = [.preferredContentSize]
        host.view.layoutSubtreeIfNeeded()
        p.contentSize = host.view.fittingSize
        p.contentViewController = host
        p.delegate = self
        popover = p
        p.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }

    func popoverDidClose(_ notification: Notification) { popover = nil }
}
