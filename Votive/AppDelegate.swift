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
}
