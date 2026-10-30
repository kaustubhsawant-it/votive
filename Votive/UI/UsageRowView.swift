import AppKit

/// One plan-limit row in the dropdown: label, a native level indicator, percentage and reset
/// time. `NSLevelIndicator` colours itself (normal → amber → red) from its warning/critical
/// values, so the bar turns red at the same threshold that starts the menu-bar pulse.
final class UsageRowView: NSView {
    static let height: CGFloat = 22

    init(label: String, usedPercentage: Double, resetText: String, threshold: Double) {
        super.init(frame: NSRect(x: 0, y: 0, width: AgentRowView.minWidth, height: Self.height))
        autoresizingMask = [.width]   // stretch with the menu, like the session rows

        let hot = usedPercentage > threshold

        let name = NSTextField(labelWithString: label)
        name.font = .menuFont(ofSize: 0)
        name.textColor = .labelColor

        let level = NSLevelIndicator()
        level.levelIndicatorStyle = .continuousCapacity
        level.minValue = 0
        level.maxValue = 100
        level.warningValue = threshold * 0.75
        level.criticalValue = threshold + 0.0001   // strictly above the threshold = red
        level.doubleValue = usedPercentage
        level.isEditable = false
        level.controlSize = .small
        level.setAccessibilityLabel("\(label) usage")
        level.setAccessibilityValueDescription("\(Int(usedPercentage.rounded())) percent used")

        let percent = NSTextField(labelWithString: "\(Int(usedPercentage.rounded()))%")
        percent.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: hot ? .semibold : .regular)
        percent.textColor = hot ? .systemRed : .labelColor
        percent.alignment = .right

        let reset = NSTextField(labelWithString: "resets \(resetText)")
        reset.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        reset.textColor = .secondaryLabelColor
        reset.lineBreakMode = .byTruncatingTail

        for v in [name, level, percent, reset] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        // Leading inset matches native menu item text (after the checkmark column).
        NSLayoutConstraint.activate([
            name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 22),
            name.centerYAnchor.constraint(equalTo: centerYAnchor),
            name.widthAnchor.constraint(equalToConstant: 58),
            level.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 6),
            level.centerYAnchor.constraint(equalTo: centerYAnchor),
            level.widthAnchor.constraint(equalToConstant: 110),
            percent.leadingAnchor.constraint(equalTo: level.trailingAnchor, constant: 6),
            percent.centerYAnchor.constraint(equalTo: centerYAnchor),
            percent.widthAnchor.constraint(equalToConstant: 40),
            reset.leadingAnchor.constraint(equalTo: percent.trailingAnchor, constant: 10),
            reset.centerYAnchor.constraint(equalTo: centerYAnchor),
            reset.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
        ])
        setAccessibilityElement(true)
        setAccessibilityLabel("\(label): \(Int(usedPercentage.rounded())) percent used, resets \(resetText)")
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
