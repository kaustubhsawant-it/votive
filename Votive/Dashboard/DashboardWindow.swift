import AppKit
import SwiftUI

/// Opens Votive's window. The menu-bar item is the always-on part; this is the detailed part (forecast, habits,
/// history, every setting), shown when asked for. While it is open Votive appears in the Dock and Cmd-Tab with a
/// normal menu bar so the window behaves like any Mac window; when it closes Votive goes back to being menu-bar only.
final class DashboardWindowController: NSObject, NSWindowDelegate {
    static let shared = DashboardWindowController()

    private var window: NSWindow?
    private var refreshTimer: Timer?

    func show(page: DashboardPage? = nil) {
        let model = DashboardModel.shared
        if let page { model.open(page) }
        if window == nil { window = makeWindow() }
        guard let window else { return }
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        model.refresh()
        startTimer()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow() -> NSWindow {
        let host = NSHostingController(rootView: DashboardView())
        host.sizingOptions = []   // the window keeps the size you give it; it does not chase the content
        let w = NSWindow(contentViewController: host)
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        w.title = "Votive"
        w.toolbarStyle = .unified
        w.isReleasedWhenClosed = false
        w.setContentSize(NSSize(width: 1040, height: 700))
        w.contentMinSize = NSSize(width: 820, height: 560)
        w.setFrameAutosaveName("VotiveDashboard")
        w.center()
        w.delegate = self
        return w
    }

    func windowWillClose(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    private func startTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in DashboardModel.shared.refresh() }
        refreshTimer?.tolerance = 5
    }

    // MARK: - Main menu (only visible while the window is open)

    private func installMainMenu() {
        guard NSApp.mainMenu == nil else { return }
        let main = NSMenu()

        let appItem = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "About Votive", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        app.addItem(settings)
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Votive", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Votive", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        main.addItem(appItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        main.addItem(windowItem)
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc private func openSettings() { show(page: .general) }
}
