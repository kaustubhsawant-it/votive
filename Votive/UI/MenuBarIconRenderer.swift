import AppKit

/// Renders the ordered agent dots into a single NSImage for the menu-bar button.
///
/// Two modes:
///  - color mode: filled circles; attention states (needs-you / error) pulse via `pulseDimmed`.
///  - shapes mode (colorblind-safe): a DISTINCT shape per state so state reads without color;
///    attention shapes rotate (driven by `angle`) instead of pulsing.
///
/// The produced image sets `isTemplate = false` so the status bar keeps our colors, and every
/// dot gets a subtle dark stroke so it stays visible on light and dark bars.
///
/// `alertAlpha` (plan usage over the limit threshold) paints a red rounded background behind
/// the dots at that opacity; the controller breathes it slowly for the usage pulse.
///
/// `caption` draws that text (e.g. "Weekly", "74%") in place of the dots, for the usage
/// carousel. `contentAlpha` fades whichever of the two is showing, and `minWidth` keeps the
/// image one width through the carousel so the other menu-bar items don't shift.
///
/// `halo` (Caffeinate is on) wraps everything in a capsule: a crisp edge with a soft glow just
/// inside it, in the menu bar's text colour. The red usage background takes the capsule's
/// shape too, so the two sit flush. The image is widened a little so the edge clears the dots.
/// `haloPhase` is where the comet is on its lap round the capsule (0..<1); the controller
/// advances it. nil draws a steady edge.
enum MenuBarIconRenderer {
    static let dotDiameter: CGFloat = 9
    static let dotSpacing: CGFloat = 4
    static let maxDots = 6
    static let height: CGFloat = 18
    static let haloPadding: CGFloat = 8

    enum Shape { case circle, ring, roundedSquare, triangle, diamond, pauseBars, cross }

    static func shape(for state: AgentState) -> Shape {
        switch state {
        case .starting:   return .ring
        case .working:    return .circle
        case .done:       return .roundedSquare
        case .needsInput: return .triangle      // rotates in shapes mode
        case .warning:    return .diamond        // rotates in shapes mode
        case .stuck:      return .pauseBars      // rotates in shapes mode
        case .stopped:    return .cross
        }
    }

    private static func rotates(_ shape: Shape) -> Bool {
        shape == .triangle || shape == .diamond || shape == .pauseBars
    }

    static func image(for states: [AgentState],
                      protectFirst: Int = 0,
                      shapes: Bool = false,
                      angle: CGFloat = 0,
                      pulseDimmed: Bool = false,
                      alertAlpha: CGFloat? = nil,
                      caption: String? = nil,
                      contentAlpha: CGFloat = 1,
                      minWidth: CGFloat = 0,
                      halo: Bool = false,
                      haloPhase: CGFloat? = nil) -> NSImage {
        let shown = AgentState.menuBarSelection(states, max: maxDots, protectFirst: protectFirst)
        let overflow = states.count - shown.count
        let overflowText = overflow > 0 ? "+\(overflow)" : ""
        let font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let textColor = NSColor(calibratedWhite: 0.55, alpha: 1)

        var overflowSize = CGSize.zero
        if !overflowText.isEmpty { overflowSize = (overflowText as NSString).size(withAttributes: [.font: font]) }

        let width = contentWidth(stateCount: states.count)
        let size = NSSize(width: max(ceil(width) + 4 + (halo ? haloPadding : 0), ceil(minWidth)), height: height)
        let image = NSImage(size: size)
        image.lockFocus()

        let bounds = NSRect(origin: .zero, size: size)
        let capsule = haloPath(in: bounds)
        if let alpha = alertAlpha {
            let bg = halo ? capsule : NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 4, yRadius: 4)
            NSColor.systemRed.withAlphaComponent(alpha).setFill()
            bg.fill()
        }

        if halo { drawHalo(capsule, in: bounds, phase: haloPhase) }

        let ctx = NSGraphicsContext.current?.cgContext
        ctx?.saveGState()
        if contentAlpha < 1 {
            ctx?.setAlpha(max(0, contentAlpha))
            ctx?.beginTransparencyLayer(auxiliaryInfo: nil)
        }

        // Centred, so a narrower frame of the carousel sits in the middle of the fixed width.
        let drawnWidth = caption.map { captionWidth($0) } ?? width
        var x: CGFloat = ((size.width - drawnWidth) / 2).rounded()
        let y = ((height - dotDiameter) / 2).rounded()   // whole-pixel row → crisp, evenly aligned

        if let caption {
            let attrs = captionAttributes
            let th = (caption as NSString).size(withAttributes: attrs).height
            (caption as NSString).draw(at: NSPoint(x: x, y: ((height - th) / 2).rounded()),
                                       withAttributes: attrs)
        } else if shown.isEmpty {
            // No sessions: a calm, slowly-rotating dim arc so you can see the overlay is alive.
            let rect = NSRect(x: x, y: y, width: dotDiameter, height: dotDiameter)
            drawIdleArc(in: rect, angle: angle)
        } else {
            for state in shown {
                let rect = NSRect(x: x, y: y, width: dotDiameter, height: dotDiameter)
                var color = state.color
                let sh = shapes ? shape(for: state) : .circle
                // Pulse = brighten a SOLID, same-size dot (not a fade to a faint ring, which
                // read as a smaller / misaligned dot next to the static ones).
                if !shapes, pulseDimmed, state.pulses {
                    let base = color.usingColorSpace(.sRGB) ?? color
                    color = base.blended(withFraction: 0.5, of: .white) ?? color
                }
                let rot = (shapes && rotates(sh)) ? angle : 0
                draw(sh, in: rect, color: color, angle: rot)
                x += dotDiameter + dotSpacing
            }
            if !overflowText.isEmpty {
                let ty = (height - overflowSize.height) / 2
                (overflowText as NSString).draw(at: NSPoint(x: x, y: ty),
                    withAttributes: [.font: font, .foregroundColor: textColor])
            }
        }

        if contentAlpha < 1 { ctx?.endTransparencyLayer() }
        ctx?.restoreGState()

        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    /// Width of the dots (plus any "+N"), or of the idle arc when there are none.
    static func contentWidth(stateCount: Int) -> CGFloat {
        let shown = min(stateCount, maxDots)
        var width: CGFloat = shown == 0
            ? dotDiameter + 4
            : CGFloat(shown) * dotDiameter + CGFloat(max(0, shown - 1)) * dotSpacing
        if stateCount > maxDots {
            let font = NSFont.systemFont(ofSize: 11, weight: .semibold)
            width += dotSpacing + ("+\(stateCount - maxDots)" as NSString).size(withAttributes: [.font: font]).width
        }
        return max(width, dotDiameter + 4)
    }

    /// Image width that fits the dots and every caption, for a steady width through the carousel.
    static func carouselWidth(stateCount: Int, captions: [String]) -> CGFloat {
        let widest = captions.map(captionWidth).max() ?? 0
        return ceil(max(contentWidth(stateCount: stateCount), widest)) + 4 + 6   // + a little padding for the text
    }

    static func captionWidth(_ text: String) -> CGFloat {
        ceil((text as NSString).size(withAttributes: captionAttributes).width)
    }

    /// White on the red background, which is steady and strong while a caption shows.
    /// Monospaced digits so "74%" → "75%" doesn't jiggle.
    private static var captionAttributes: [NSAttributedString.Key: Any] {
        [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold),
         .foregroundColor: NSColor.white]
    }

    private static func haloPath(in rect: NSRect) -> NSBezierPath {
        let r = rect.insetBy(dx: 1, dy: 1)
        return NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)
    }

    /// A faint steady edge with a soft glow just inside it, plus a bright comet with a fading
    /// tail running clockwise around the edge. `phase` (0..<1) is the comet's place on the
    /// loop; nil draws the whole edge steady, for Reduce motion.
    private static func drawHalo(_ capsule: NSBezierPath, in rect: NSRect, phase: CGFloat?) {
        let steady = phase == nil
        NSGraphicsContext.saveGraphicsState()
        capsule.addClip()
        for (width, alpha) in [(5.0, 0.03), (3.0, 0.05), (1.8, 0.08)] as [(CGFloat, CGFloat)] {
            let glow = capsule.copy() as! NSBezierPath
            glow.lineWidth = width
            NSColor.labelColor.withAlphaComponent(alpha * (steady ? 1.4 : 1)).setStroke()
            glow.stroke()
        }
        NSGraphicsContext.restoreGraphicsState()
        capsule.lineWidth = 0.9
        NSColor.labelColor.withAlphaComponent(steady ? 0.7 : 0.3).setStroke()
        capsule.stroke()

        guard let phase else { return }
        let r = rect.insetBy(dx: 1, dy: 1)
        let loop = { (d: CGFloat) in perimeterPoint(in: r, along: d) }
        let total = 2 * max(0, r.width - r.height) + .pi * r.height
        let tail = total * 0.32, steps = 28
        let head = (phase - floor(phase)) * total
        for k in 0..<steps {
            let a = loop(head - tail * CGFloat(k) / CGFloat(steps))
            let b = loop(head - tail * CGFloat(k + 1) / CGFloat(steps))
            let seg = NSBezierPath()
            seg.move(to: a); seg.line(to: b)
            seg.lineWidth = 1.6
            seg.lineCapStyle = .round
            let fade = pow(1 - CGFloat(k) / CGFloat(steps), 1.6)
            NSColor.labelColor.withAlphaComponent(0.95 * fade).setStroke()
            seg.stroke()
        }
    }

    /// A point `s` along the capsule's edge, clockwise from the left end of the top edge.
    /// Wraps, so a tail behind the start comes round from the end of the loop.
    private static func perimeterPoint(in r: NSRect, along s: CGFloat) -> NSPoint {
        let rad = r.height / 2
        let straight = max(0, r.width - r.height)
        let arc = CGFloat.pi * rad
        let total = 2 * straight + 2 * arc
        var d = s.truncatingRemainder(dividingBy: total)
        if d < 0 { d += total }
        if d < straight { return NSPoint(x: r.minX + rad + d, y: r.maxY) }
        d -= straight
        if d < arc {
            let t = CGFloat.pi / 2 - d / rad
            return NSPoint(x: r.maxX - rad + rad * cos(t), y: r.midY + rad * sin(t))
        }
        d -= arc
        if d < straight { return NSPoint(x: r.maxX - rad - d, y: r.minY) }
        d -= straight
        let t = -CGFloat.pi / 2 - d / rad
        return NSPoint(x: r.minX + rad + rad * cos(t), y: r.midY + rad * sin(t))
    }

    // MARK: - Shape drawing

    private static func draw(_ shape: Shape, in rect: NSRect, color: NSColor, angle: CGFloat) {
        NSGraphicsContext.saveGraphicsState()
        if angle != 0 {
            let t = NSAffineTransform()
            t.translateX(by: rect.midX, yBy: rect.midY)
            t.rotate(byRadians: angle)
            t.translateX(by: -rect.midX, yBy: -rect.midY)
            t.concat()
        }
        let stroke = NSColor.black.withAlphaComponent(0.18)
        switch shape {
        case .circle:
            let p = NSBezierPath(ovalIn: rect); fillStroke(p, color, stroke)
        case .ring:
            let inset = rect.insetBy(dx: 1, dy: 1)
            let p = NSBezierPath(ovalIn: inset); p.lineWidth = max(1.5, rect.width * 0.24)
            color.setStroke(); p.stroke()
        case .roundedSquare:
            let p = NSBezierPath(roundedRect: rect.insetBy(dx: 0.3, dy: 0.3),
                                 xRadius: rect.width * 0.22, yRadius: rect.width * 0.22)
            fillStroke(p, color, stroke)
        case .triangle:
            let p = NSBezierPath()
            p.move(to: NSPoint(x: rect.midX, y: rect.maxY))
            p.line(to: NSPoint(x: rect.minX, y: rect.minY))
            p.line(to: NSPoint(x: rect.maxX, y: rect.minY))
            p.close(); fillStroke(p, color, stroke)
        case .diamond:
            let p = NSBezierPath()
            p.move(to: NSPoint(x: rect.midX, y: rect.maxY))
            p.line(to: NSPoint(x: rect.maxX, y: rect.midY))
            p.line(to: NSPoint(x: rect.midX, y: rect.minY))
            p.line(to: NSPoint(x: rect.minX, y: rect.midY))
            p.close(); fillStroke(p, color, stroke)
        case .cross:
            let p = NSBezierPath(); p.lineWidth = max(1.6, rect.width * 0.24); p.lineCapStyle = .round
            let i = rect.insetBy(dx: 1, dy: 1)
            p.move(to: NSPoint(x: i.minX, y: i.minY)); p.line(to: NSPoint(x: i.maxX, y: i.maxY))
            p.move(to: NSPoint(x: i.minX, y: i.maxY)); p.line(to: NSPoint(x: i.maxX, y: i.minY))
            color.setStroke(); p.stroke()
        case .pauseBars:
            // Two rounded bars — the universal "paused" glyph, reads as "halted" at a glance.
            let i = rect.insetBy(dx: 1, dy: 0.5)
            let barWidth = i.width * 0.3
            let leftBar = NSRect(x: i.minX, y: i.minY, width: barWidth, height: i.height)
            let rightBar = NSRect(x: i.maxX - barWidth, y: i.minY, width: barWidth, height: i.height)
            for barRect in [leftBar, rightBar] {
                let p = NSBezierPath(roundedRect: barRect, xRadius: barWidth * 0.35, yRadius: barWidth * 0.35)
                fillStroke(p, color, stroke)
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    private static func fillStroke(_ path: NSBezierPath, _ fill: NSColor, _ stroke: NSColor) {
        fill.setFill(); path.fill()
        stroke.setStroke(); path.lineWidth = 0.5; path.stroke()
    }

    /// A 270° arc that rotates — the "nothing running, but I'm here" idle indicator.
    private static func drawIdleArc(in rect: NSRect, angle: CGFloat) {
        NSGraphicsContext.saveGraphicsState()
        let t = NSAffineTransform()
        t.translateX(by: rect.midX, yBy: rect.midY)
        t.rotate(byRadians: angle)
        t.translateX(by: -rect.midX, yBy: -rect.midY)
        t.concat()
        let p = NSBezierPath()
        p.appendArc(withCenter: NSPoint(x: rect.midX, y: rect.midY),
                    radius: rect.width / 2 - 1, startAngle: 0, endAngle: 270)
        p.lineWidth = 1.6
        p.lineCapStyle = .round
        NSColor.tertiaryLabelColor.setStroke()
        p.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }
}
