import AppKit

/// Custom dropdown row: draws the state dot, host-app icon, name/state/time and recap, and
/// handles a left-click to focus the agent's terminal. The per-agent ACTIONS are provided by
/// a native submenu on the menu item (opens on hover) — NSMenu forwards only a single click to
/// a custom view, so a manual "⋯"/right-click can't be received here; the hover submenu can.
final class AgentRowView: NSView {
    private let session: AgentSession
    private let stateImage: NSImage
    private let hostIcon: NSImage?
    private let recap: String
    private let pinned: Bool

    init(session: AgentSession, stateImage: NSImage, hostIcon: NSImage?, recap: String, pinned: Bool = false) {
        self.pinned = pinned
        self.session = session
        self.stateImage = stateImage
        self.hostIcon = hostIcon
        self.recap = recap
        super.init(frame: NSRect(x: 0, y: 0, width: Self.minWidth, height: 42))
        // Stretch to the menu's width. Without this the row keeps its initial width while
        // wider native items (usage rows, toggles) widen the menu, so the row's text and
        // arrow stop short of every other item's right edge.
        autoresizingMask = [.width]
    }

    static let minWidth: CGFloat = 340
    /// Space kept clear on the right for the submenu arrow, matching native menu items.
    private static let trailing: CGFloat = 28
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds, options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved],
            owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { needsDisplay = true }
    override func mouseExited(with event: NSEvent) { needsDisplay = true }
    override func mouseMoved(with event: NSEvent) { needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        let highlighted = enclosingMenuItem?.isHighlighted ?? false
        if highlighted {
            NSColor.selectedContentBackgroundColor.setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 1), xRadius: 5, yRadius: 5).fill()
        }
        let primary = highlighted ? NSColor.white : NSColor.labelColor
        let secondary = highlighted ? NSColor.white.withAlphaComponent(0.85) : NSColor.secondaryLabelColor

        stateImage.draw(in: NSRect(x: 14, y: 15, width: 12, height: 12))

        var textX: CGFloat = 34
        if let host = hostIcon {
            host.draw(in: NSRect(x: 32, y: 14, width: 14, height: 14))
            textX = 52
        }

        let rel = RelativeTime.string(fromEpochMs: session.lastActivityAt)
        let line1 = NSMutableAttributedString(string: session.name, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: primary])
        line1.append(NSAttributedString(string: "   \(session.agentName) · \(session.state.label) · \(rel)", attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: secondary]))
        let clip = NSMutableParagraphStyle()
        clip.lineBreakMode = .byTruncatingTail
        let pinRoom: CGFloat = pinned ? 16 : 0
        let textWidth = max(0, bounds.width - textX - Self.trailing - pinRoom)
        line1.addAttribute(.paragraphStyle, value: clip, range: NSRange(location: 0, length: line1.length))
        line1.draw(in: NSRect(x: textX, y: 5, width: textWidth, height: 17))

        NSAttributedString(string: recap, attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: secondary, .paragraphStyle: clip])
            .draw(in: NSRect(x: textX, y: 23, width: textWidth, height: 14))

        // A small pin marks a High priority session.
        if pinned, let pin = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: "High priority")?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .regular)) {
            let tintedPin = NSImage(size: pin.size, flipped: false) { rect in
                pin.draw(in: rect)
                secondary.set()
                rect.fill(using: .sourceAtop)
                return true
            }
            tintedPin.draw(in: NSRect(x: bounds.width - 30 - pin.size.width, y: (bounds.height - pin.size.height) / 2,
                                      width: pin.size.width, height: pin.size.height))
        }

        // Submenu arrow, in the same spot and style as the native arrows on items like
        // "Prompt snippets" (hovering the row opens the actions submenu).
        if let chevron = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold)) {
            let tinted = NSImage(size: chevron.size, flipped: false) { rect in
                chevron.draw(in: rect)
                secondary.set()
                rect.fill(using: .sourceAtop)
                return true
            }
            let size = chevron.size
            tinted.draw(in: NSRect(x: bounds.width - 12 - size.width, y: (bounds.height - size.height) / 2,
                                   width: size.width, height: size.height))
        }
    }

    // Left-click anywhere on the row → focus that agent's terminal window.
    override func mouseUp(with event: NSEvent) {
        enclosingMenuItem?.menu?.cancelTracking()
        if session.pid > 0 { TerminalFocus.focus(sessionPID: session.pid) }
        else if !session.cwd.isEmpty { Reveal.folder(session.cwd) }
    }
}
