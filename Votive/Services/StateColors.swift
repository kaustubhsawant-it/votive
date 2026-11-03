import AppKit

/// The color each state's dot is drawn in, and the owner's own choices of them.
///
/// Every dot in Votive (menu bar, menu, window) asks `AgentState.color`, which asks here first, so a change shows
/// everywhere at once. A state with no choice keeps its system color. Colors are stored as "#RRGGBB" text per
/// state in one preference, validated on every read: anything that is not exactly that, or is for an unknown state, is
/// ignored. Changing a color never changes what a state means: the state is still written next to every dot in the
/// menu, and Colorblind shapes still gives each state its own outline.
enum StateColors {
    static let key = "stateColors"
    static let didChange = Notification.Name("VotiveStateColorsDidChange")

    /// A named set of colors. `colors` empty means "the system colors".
    struct Palette: Identifiable, Equatable {
        let id: String
        let name: String
        let note: String
        let colors: [AgentState: String]
    }

    static let palettes: [Palette] = [
        Palette(id: "default", name: "Default", note: "The system colors, which follow light and dark mode.", colors: [:]),
        // Okabe and Ito's colorblind-safe set (a published, free palette), assigned so the states that matter most differ most.
        Palette(id: "colorblind", name: "Colorblind friendly", note: "Chosen to stay apart for the common kinds of color blindness.", colors: [
            .starting: "#56B4E9", .working: "#F0E442", .done: "#009E73", .needsInput: "#CC79A7",
            .warning: "#E69F00", .stuck: "#0072B2", .stopped: "#D55E00",
        ]),
        Palette(id: "contrast", name: "High contrast", note: "Strong, saturated colors that stand out on any menu bar.", colors: [
            .starting: "#0066FF", .working: "#FFD60A", .done: "#00C853", .needsInput: "#B000FF",
            .warning: "#FF8C00", .stuck: "#8B4513", .stopped: "#FF1744",
        ]),
    ]

    // MARK: - Text form

    /// "#RRGGBB" in upper case, or nil when `raw` is anything else.
    static func clean(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, s.allSatisfy({ $0.isHexDigit }) else { return nil }
        return "#" + s.uppercased()
    }

    static func color(hex: String) -> NSColor? {
        guard let h = clean(hex), let v = UInt32(h.dropFirst(), radix: 16) else { return nil }
        return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    static func hex(_ color: NSColor) -> String? {
        guard let c = color.usingColorSpace(.sRGB) else { return nil }
        func b(_ v: CGFloat) -> Int { Int((min(1, max(0, v)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", b(c.redComponent), b(c.greenComponent), b(c.blueComponent))
    }

    /// What is stored, validated: known states only, each a clean "#RRGGBB".
    static func cleanStored(_ raw: Any?) -> [AgentState: String] {
        guard let dict = raw as? [String: Any] else { return [:] }
        var out: [AgentState: String] = [:]
        for (k, v) in dict {
            guard let state = AgentState(rawValue: k), let s = v as? String, let h = clean(s) else { continue }
            out[state] = h
        }
        return out
    }

    // MARK: - Telling colors apart

    /// Distance between two colors as people see it (CIE76 on CIELAB, from sRGB): about 2 is the smallest difference an
    /// eye notices, and below `tooSimilar` two dots are easy to mix up at menu-bar size.
    static func distance(_ a: NSColor, _ b: NSColor) -> Double {
        let (l1, a1, b1) = lab(a), (l2, a2, b2) = lab(b)
        return ((l1 - l2) * (l1 - l2) + (a1 - a2) * (a1 - a2) + (b1 - b2) * (b1 - b2)).squareRoot()
    }
    static let tooSimilar = 18.0

    private static func lab(_ color: NSColor) -> (Double, Double, Double) {
        let c = color.usingColorSpace(.sRGB) ?? color
        func lin(_ v: CGFloat) -> Double { let x = Double(v); return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
        let r = lin(c.redComponent), g = lin(c.greenComponent), bl = lin(c.blueComponent)
        let x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * bl
        let z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883
        func f(_ t: Double) -> Double { t > 216.0 / 24389.0 ? cbrt(t) : (24389.0 / 27.0 * t + 16) / 116 }
        return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))
    }

    /// Pairs of states whose colors are too close to tell apart, given the color each state really has.
    static func similarPairs(_ colorOf: (AgentState) -> NSColor) -> [(AgentState, AgentState)] {
        let all = AgentState.allCases
        var out: [(AgentState, AgentState)] = []
        for i in 0..<all.count { for j in (i + 1)..<all.count where distance(colorOf(all[i]), colorOf(all[j])) < tooSimilar { out.append((all[i], all[j])) } }
        return out
    }

    // MARK: - What the app uses

    fileprivate static var live: [AgentState: NSColor] = [:]
    private static var installed = false
    private static var watcher: Watcher?

    /// Called once at launch: makes every `AgentState.color` honour the choices, and keeps them current, including
    /// when the preference is changed from outside the app (`defaults write`), which macOS reports through KVO.
    static func install(defaults: UserDefaults = .standard) {
        guard !installed else { return }
        installed = true
        AgentState.userColor = { live[$0] }
        reload(defaults: defaults)
        watcher = Watcher(defaults)
    }

    private final class Watcher: NSObject {
        private let defaults: UserDefaults
        init(_ defaults: UserDefaults) {
            self.defaults = defaults
            super.init()
            defaults.addObserver(self, forKeyPath: StateColors.key, options: [], context: nil)
        }
        deinit { defaults.removeObserver(self, forKeyPath: StateColors.key) }
        override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
            DispatchQueue.main.async { [defaults] in
                let before = StateColors.live
                StateColors.reload(defaults: defaults)
                if before != StateColors.live { NotificationCenter.default.post(name: StateColors.didChange, object: nil) }
            }
        }
    }

    static func reload(defaults: UserDefaults = .standard) {
        live = StateColorStore(defaults: defaults).overrides.compactMapValues { color(hex: $0) }
    }
}

/// Reads and writes the owner's color choices in preferences. The only writer.
struct StateColorStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var overrides: [AgentState: String] { StateColors.cleanStored(defaults.object(forKey: StateColors.key)) }

    /// Sets one state's color; nil puts it back to the system color.
    func set(_ hex: String?, for state: AgentState) {
        var current = overrides
        current[state] = hex.flatMap { StateColors.clean($0) }
        save(current)
    }

    /// Applies a whole palette (the default one clears every choice).
    func apply(_ palette: StateColors.Palette) { save(palette.colors) }

    func reset() { save([:]) }

    private func save(_ map: [AgentState: String]) {
        if map.isEmpty { defaults.removeObject(forKey: StateColors.key) }
        else {
            let stored = Dictionary(uniqueKeysWithValues: map.map { ($0.key.rawValue, $0.value) })
            defaults.set(stored, forKey: StateColors.key)
        }
        StateColors.reload(defaults: defaults)
        NotificationCenter.default.post(name: StateColors.didChange, object: nil)
    }

    /// The palette these choices amount to, or nil when they are a custom mix.
    var palette: StateColors.Palette? { StateColors.palettes.first { $0.colors == overrides } }
}
