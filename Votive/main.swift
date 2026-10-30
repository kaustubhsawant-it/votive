import AppKit

// Programmatic entry point for a menu-bar-only (accessory) AppKit app — no storyboard,
// no @main, no WindowGroup. Keeps the binary tiny.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
