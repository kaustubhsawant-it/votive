import AppKit

/// Pops a small floating panel ("… finished", "… needs you", …) when a session flips to a
/// notable state — the delivery path that always works and needs no macOS authorization
/// (unlike `Notifier`'s Notification Center banner, which an ad-hoc–signed app frequently
/// can't register for at all).
///
/// This used to shell out to `osascript -e 'display dialog ...'`. That was replaced with a
/// native `NotifyPanel` (`NSPanel` + `.nonactivatingPanel`) because `display dialog` — even
/// stripped of any explicit `tell ... to activate` — is a modal-style system alert that macOS
/// unavoidably makes key and brings to the front, interrupting whatever app you were actually
/// using. `NotifyPanel` shows itself via `orderFrontRegardless()`, never `makeKeyAndOrderFront`
/// — it appears on screen without taking key-window status away from wherever you're
/// currently typing, so it can never interrupt a keystroke you didn't direct at it. A click
/// on one of its buttons still works immediately either way; Escape only routes to the panel
/// once you've clicked into it, which is the correct trade for never pre-empting your
/// keyboard uninvited. It's also simpler and cheaper than the old approach — no subprocess,
/// no AppleScript string escaping, no stdout parsing to detect which button was clicked.
///
/// Must be called on the main thread (AppKit). `StatusItemController` already does this — see
/// its own "Everything runs on the main thread" note.
final class DialogAlerter {
    static let shared = DialogAlerter()
    private init() {}

    /// Beyond this many panels on screen, new ones are dropped rather than queued — a burst
    /// of agents finishing together drops the extras instead of stacking a wall of toasts you
    /// have to dismiss.
    private let maxConcurrent = 3
    private let autoDismissAfter: TimeInterval = 120
    private let margin: CGFloat = 14
    private let gap: CGFloat = 10

    private var panels: [NotifyPanel] = []

    /// Show `body` in a small panel titled `title`. When `openAction` is non-nil the panel
    /// gets a second "Open Terminal" button (Return-equivalent) alongside "Dismiss"
    /// (Escape-equivalent); otherwise a single "OK" (Escape-equivalent).
    func show(title: String, body: String, openAction: (() -> Void)? = nil, replaceOldest: Bool = false) {
        if panels.count >= maxConcurrent {
            // Automatic alerts are dropped when the screen is full; one the user asked for is not:
            // it takes the oldest panel's place.
            guard replaceOldest, let oldest = panels.last else { return }
            oldest.close()
        }
        let panel = NotifyPanel(title: title, body: body, openAction: openAction) { [weak self] closed in
            self?.remove(closed)
        }
        panels.insert(panel, at: 0)   // newest on top of the stack
        restack()
        panel.reveal()
        panel.scheduleAutoDismiss(after: autoDismissAfter)
    }

    private func remove(_ panel: NotifyPanel) {
        panels.removeAll { $0 === panel }
        restack()
    }

    /// Positions every visible panel as a top-right stack, using each panel's own (already
    /// self-sized) height — so panels with different body lengths never overlap or leave gaps.
    private func restack() {
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        var top = vf.maxY - margin
        for panel in panels {
            let x = vf.maxX - panel.frame.width - margin
            panel.setFrameTopLeftPoint(NSPoint(x: x, y: top))
            top -= panel.frame.height + gap
        }
    }
}
