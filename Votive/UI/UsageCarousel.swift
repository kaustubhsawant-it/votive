import Foundation

/// The menu-bar loop shown while a plan limit is over the threshold, or the CPU is hot:
///
///     dots → "Weekly" → "74%" → dots → …
///
/// with a fade out and a fade in between each frame. With more than one limit over the
/// threshold, each one gets its own name + number pair, the worst first. The menu bar never
/// says which limit is hot otherwise, which is the whole point of this loop. A hot CPU is one more
/// pair ("CPU", "97°"), first, because it is the one that needs you now.
///
/// Pure timeline math: `frame(at:)` turns a time into what to draw, so the controller only
/// owns a timer and the result is easy to reason about (and to test).
struct UsageCarousel: Equatable {
    /// The text frames that follow the dots, in order: name, number, name, number, …
    let captions: [String]

    static let fade: TimeInterval = 0.35
    static let dotsHold: TimeInterval = 4.0
    static let captionHold: TimeInterval = 1.6
    static let maxLimits = 3

    /// Opacity of the red background while a caption shows: steady and strong enough that the
    /// white text reads on a light menu bar. Behind the dots it breathes, as before.
    static let captionBackground: Double = 0.85

    /// What to draw at one instant.
    struct Frame: Equatable {
        /// nil = the dots.
        let caption: String?
        /// Opacity of the content (dots or caption), 0…1, for the fades.
        let contentAlpha: Double
        /// 0 while the dots show, 1 while a caption shows, in between during the fades. The
        /// controller blends the red background from breathing to steady with it.
        let captionness: Double
    }

    /// Limits strictly over `threshold`, worst first (highest use; on a tie, the one that
    /// resets later, since it stays a problem longer). The agent's name goes in front only
    /// when more than one agent reports usage, so a lone "Weekly" can't be ambiguous.
    init?(_ snapshot: UsageSnapshot, threshold: Double = UsageSnapshot.alertThreshold) {
        let captions = Self.limitCaptions(snapshot, threshold: threshold)
        guard !captions.isEmpty else { return nil }
        self.captions = captions
    }

    /// name, number, name, number for the limits over `threshold`, worst first; empty when none is.
    static func limitCaptions(_ snapshot: UsageSnapshot, threshold: Double = UsageSnapshot.alertThreshold) -> [String] {
        let named = snapshot.agents.count > 1
        var hot: [(agent: AgentUsage, window: UsageWindow)] = []
        for agent in snapshot.agents {
            for window in agent.windows where window.usedPercentage > threshold {
                hot.append((agent, window))
            }
        }
        hot.sort { a, b in
            if a.window.usedPercentage != b.window.usedPercentage {
                return a.window.usedPercentage > b.window.usedPercentage
            }
            return a.window.resetsAt > b.window.resetsAt
        }
        var captions: [String] = []
        for (agent, window) in hot.prefix(Self.maxLimits) {
            captions.append(named ? "\(agent.agentName) \(window.label)" : window.label)
            captions.append("\(Int(window.usedPercentage.rounded()))%")
        }
        return captions
    }

    /// The loop for what is wrong now: a hot CPU (`heat` is its number, "97°") first, then the limits over the threshold
    /// when `limitsOn`. nil when nothing is.
    static func make(snapshot: UsageSnapshot?, limitsOn: Bool, heat: String?) -> UsageCarousel? {
        var captions: [String] = []
        if let heat { captions += ["CPU", heat] }
        if limitsOn, let snapshot { captions += limitCaptions(snapshot) }
        return captions.isEmpty ? nil : UsageCarousel(captions: captions)
    }

    init(captions: [String]) { self.captions = captions }

    /// One loop: the dots, then every caption, each faded in and out.
    func cycle(fade: TimeInterval = UsageCarousel.fade) -> TimeInterval {
        fade * 2 * Double(captions.count + 1) + Self.dotsHold + Double(captions.count) * Self.captionHold
    }

    /// `reduceMotion` swaps the fades for plain cuts (System Settings → Accessibility).
    func frame(at t: TimeInterval, reduceMotion: Bool = false) -> Frame {
        let fade = reduceMotion ? 0 : Self.fade
        let period = cycle(fade: fade)
        var local = t.truncatingRemainder(dividingBy: period)
        if local < 0 { local += period }

        let slots: [(caption: String?, hold: TimeInterval)] =
            [(nil, Self.dotsHold)] + captions.map { ($0, Self.captionHold) }
        for (i, slot) in slots.enumerated() {
            let length = fade * 2 + slot.hold
            if local < length || i == slots.count - 1 {   // last slot also absorbs rounding
                let alpha = Self.opacity(local, fade: fade, hold: slot.hold)
                return Frame(caption: slot.caption, contentAlpha: alpha,
                             captionness: slot.caption == nil ? 1 - alpha : 1)
            }
            local -= length
        }
        return Frame(caption: nil, contentAlpha: 1, captionness: 0)   // unreachable: captions is never empty
    }

    /// Fade in, hold, fade out, eased so the ends don't snap.
    private static func opacity(_ t: TimeInterval, fade: TimeInterval, hold: TimeInterval) -> Double {
        guard fade > 0 else { return 1 }
        let x: Double
        if t < fade { x = t / fade }
        else if t < fade + hold { x = 1 }
        else { x = max(0, (fade * 2 + hold - t) / fade) }
        let c = min(1, max(0, x))
        return c * c * (3 - 2 * c)   // smoothstep
    }
}
