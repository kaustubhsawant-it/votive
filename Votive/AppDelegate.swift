import AppKit

/// Wires the coordinator (off-main watch + scan) to the status-item controller (main).
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: StatusItemController?
    private let coordinator = StatusCoordinator()
    private let usage = UsageStore()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu-bar-only: no Dock icon, no app menu. (Also set via LSUIElement in Info.plist.)
        NSApp.setActivationPolicy(.accessory)

        LegacySettings.migrate()   // settings of the app under its earlier name, before anything reads one
        StateColors.install()      // the dot colours you chose, before the first dot is drawn
        PausedStore.shared.prune() // programs Votive froze earlier: keep only those still frozen and still the same process

        Notifier.shared.setup()   // request notification permission (one-time)

        let controller = StatusItemController()
        self.controller = controller

        coordinator.onChange = { [weak controller] sessions in
            controller?.update(sessions)
        }
        coordinator.start()

        usage.onChange = { [weak controller] snapshot in
            controller?.updateUsage(snapshot)
        }
        usage.start()
    }

    /// Never leave a program frozen without the user knowing: if Votive paused something, a Quit asks what
    /// to do with it. Logging out, restarting or shutting down resume it silently, so nothing blocks that.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let frozen = PausedStore.shared.load()
        guard !frozen.isEmpty else { return .terminateNow }
        if Self.isSystemShutdown() {
            PausedStore.shared.resumeAll()
            return .terminateNow
        }
        let names = frozen.prefix(5).map { "\($0.command) (port \($0.port))" }.joined(separator: ", ")
            + (frozen.count > 5 ? " and \(frozen.count - 5) more" : "")
        let alert = NSAlert()
        alert.messageText = frozen.count == 1 ? "Resume the paused program before quitting?" : "Resume \(frozen.count) paused programs before quitting?"
        alert.informativeText = "Votive paused \(names). If you leave \(frozen.count == 1 ? "it" : "them") paused, \(frozen.count == 1 ? "it stays" : "they stay") frozen until you resume \(frozen.count == 1 ? "it" : "them") from Votive's Ports menu (once Votive is running again)."
        alert.addButton(withTitle: "Resume them")
        alert.addButton(withTitle: "Leave paused")
        alert.addButton(withTitle: "Don't quit")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            PausedStore.shared.resumeAll()
            return .terminateNow
        case .alertSecondButtonReturn:
            return .terminateNow
        default:
            return .terminateCancel
        }
    }

    /// True when the quit comes from logging out, restarting or shutting down (macOS says why in the quit event).
    private static func isSystemShutdown() -> Bool {
        func code(_ s: String) -> UInt32 { s.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }
        guard let reason = NSAppleEventManager.shared().currentAppleEvent?.attributeDescriptor(forKeyword: code("why?")) else { return false }
        return ["logo", "rlgo", "shut", "rest", "rrst", "rsdn"].map(code).contains(reason.enumCodeValue)
    }
}
