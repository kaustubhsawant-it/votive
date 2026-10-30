import AppKit

/// A single floating alert panel used by `DialogAlerter` — a small, self-sized toast with a
/// title, body, and one or two buttons. Positioning (stacking multiple panels) is owned by
/// `DialogAlerter`; this class only knows how to size and draw itself.
///
/// `.nonactivatingPanel` is the whole point: this style lets a panel become key — so its
/// buttons and the Escape/Return key equivalents work — WITHOUT activating the app that owns
/// it or moving focus away from whatever app you were actually using. A plain `NSWindow`, an
/// `NSAlert`, or AppleScript's `display dialog` all force an app/focus switch; this doesn't.
final class NotifyPanel: NSPanel {
    private let onOpen: (() -> Void)?
    private let onClosed: (NotifyPanel) -> Void
    private var dismissTimer: Timer?

    private static let width: CGFloat = 300
    private static let margin: CGFloat = 14
    private static let buttonHeight: CGFloat = 24

    init(title: String, body: String, openAction: (() -> Void)?, onClosed: @escaping (NotifyPanel) -> Void) {
        self.onOpen = openAction
        self.onClosed = onClosed

        let titleFont = NSFont.boldSystemFont(ofSize: 13)
        let bodyFont = NSFont.systemFont(ofSize: 12)
        let textWidth = Self.width - Self.margin * 2
        let bodyHeight = ceil((body as NSString).boundingRect(
            with: NSSize(width: textWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: bodyFont]).height)
        let contentHeight = Self.margin + 16 /* title row */ + 6 + bodyHeight
            + 10 + Self.buttonHeight + Self.margin

        super.init(
            contentRect: NSRect(x: 0, y: 0, width: Self.width, height: contentHeight),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView, .closable],
            backing: .buffered, defer: false)

        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovableByWindowBackground = true
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        backgroundColor = .clear
        hasShadow = true
        delegate = nil

        buildContent(title: title, body: body, bodyHeight: bodyHeight,
                    showOpenButton: openAction != nil, height: contentHeight,
                    titleFont: titleFont, bodyFont: bodyFont)
    }

    private func buildContent(title: String, body: String, bodyHeight: CGFloat, showOpenButton: Bool,
                              height: CGFloat, titleFont: NSFont, bodyFont: NSFont) {
        let frame = NSRect(x: 0, y: 0, width: Self.width, height: height)
        // All controls go in `visual`; its backdrop is Liquid Glass on macOS 26 and the
        // standard HUD blur on earlier versions.
        let visual = NSView(frame: frame)
        // Liquid Glass (NSGlassEffectView) on macOS 26. It's looked up by name so the app still
        // compiles with older SDKs (Xcode 15/16), where the class doesn't exist at build time.
        if let glassType = NSClassFromString("NSGlassEffectView") as? NSView.Type {
            let glass = glassType.init(frame: frame)
            glass.setValue(visual, forKey: "contentView")
            glass.setValue(18.0, forKey: "cornerRadius")
            contentView = glass
        } else {
            let blur = NSVisualEffectView(frame: frame)
            blur.material = .hudWindow
            blur.blendingMode = .behindWindow
            blur.state = .active
            blur.wantsLayer = true
            blur.layer?.cornerRadius = 12
            blur.layer?.masksToBounds = true
            blur.addSubview(visual)
            contentView = blur
        }

        let textWidth = Self.width - Self.margin * 2
        var y = height - Self.margin - 16
        let icon = NSImageView(image: NSImage(systemSymbolName: "bell.badge.fill", accessibilityDescription: nil) ?? NSImage())
        icon.symbolConfiguration = .init(pointSize: 13, weight: .semibold)
        icon.contentTintColor = .controlAccentColor
        icon.frame = NSRect(x: Self.margin, y: y, width: 18, height: 16)
        visual.addSubview(icon)

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = titleFont
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.frame = NSRect(x: Self.margin + 22, y: y, width: textWidth - 22, height: 16)
        visual.addSubview(titleLabel)

        y -= 6 + bodyHeight
        let bodyLabel = NSTextField(wrappingLabelWithString: body)
        bodyLabel.font = bodyFont
        bodyLabel.textColor = .secondaryLabelColor
        bodyLabel.frame = NSRect(x: Self.margin, y: y, width: textWidth, height: bodyHeight)
        visual.addSubview(bodyLabel)

        y = Self.margin
        if showOpenButton {
            let dismiss = NSButton(title: "Dismiss", target: self, action: #selector(dismissTapped))
            dismiss.bezelStyle = .push
            dismiss.keyEquivalent = "\u{1b}"   // Escape
            let open = NSButton(title: "Open Terminal", target: self, action: #selector(openTapped))
            open.bezelStyle = .push
            open.keyEquivalent = "\r"          // Return — the affirmative default action
            open.sizeToFit()
            let openWidth = max(open.frame.width, 96)
            dismiss.sizeToFit()
            let dismissWidth = max(dismiss.frame.width, 74)
            open.frame = NSRect(x: Self.width - Self.margin - openWidth, y: y, width: openWidth, height: Self.buttonHeight)
            dismiss.frame = NSRect(x: open.frame.minX - 8 - dismissWidth, y: y, width: dismissWidth, height: Self.buttonHeight)
            visual.addSubview(dismiss)
            visual.addSubview(open)
        } else {
            let ok = NSButton(title: "OK", target: self, action: #selector(dismissTapped))
            ok.bezelStyle = .push
            ok.keyEquivalent = "\u{1b}"
            ok.sizeToFit()
            let width = max(ok.frame.width, 70)
            ok.frame = NSRect(x: Self.width - Self.margin - width, y: y, width: width, height: Self.buttonHeight)
            visual.addSubview(ok)
        }
    }

    /// Shows the panel WITHOUT making it key. `.nonactivatingPanel` only stops the app from
    /// activating — `makeKeyAndOrderFront` still moves the KEY window (wherever the next
    /// keystroke actually goes) to this panel, which is exactly what interrupted typing in
    /// whatever app you were using. `orderFrontRegardless()` just makes it visible: your
    /// current app keeps every keystroke. A direct click on a button still works immediately
    /// (single click both keys the panel and fires the action — standard panel behavior);
    /// Escape only routes here once you've clicked into the panel, which is the correct
    /// trade — nothing here should ever pre-empt your keyboard without you touching it first.
    func reveal() {
        orderFrontRegardless()
    }

    func scheduleAutoDismiss(after seconds: TimeInterval) {
        dismissTimer?.invalidate()
        dismissTimer = Timer.commonModeTimer(interval: seconds, repeats: false) { [weak self] _ in
            self?.close()
        }
    }

    @objc private func dismissTapped() { close() }
    @objc private func openTapped() { onOpen?(); close() }

    override func close() {
        dismissTimer?.invalidate()
        dismissTimer = nil
        super.close()
        onClosed(self)
    }
}
