import AppKit
import UniformTypeIdentifiers

/// Owns the menu-bar `NSStatusItem`: renders the dots (color or colorblind-shapes mode),
/// animates attention (pulse in color mode, rotation in shapes mode) and an idle arc when
/// nothing is running, posts targeted notifications on state transitions, and builds the
/// dropdown (host-app icon + recap per row, per-agent action submenus, prompt snippets).
///
/// Everything runs on the main thread (the coordinator dispatches updates to main).
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private var sessions: [AgentSession] = []
    private var prevStates: [String: AgentState] = [:]
    private var baselineEstablished = false

    private var cacheKey = ""
    private var animTimer: Timer?
    private var animMode: (rotate: Bool, interval: TimeInterval)?
    private var angle: CGFloat = 0
    private var dimmed = false

    private var haloTimer: Timer?
    private var haloStart = Date()
    private var haloPhase: CGFloat?

    private var usage: UsageSnapshot?
    private var usageTimer: Timer?
    private var usageAlpha: CGFloat?
    private var carousel: UsageCarousel?
    private var carouselStart = Date()
    private var carouselFrame: UsageCarousel.Frame?
    private var carouselSig = ""

    private let defaults = UserDefaults.standard
    private let debug = ProcessInfo.processInfo.environment["VOTIVE_DEBUG"] == "1"

    /// "Let agents change settings": the master switch for the MCP tools that change things (settings_set and
    /// repair). Off unless the user turns it on here; the tools cannot write it (Scripts/mcp-guard.js).
    private var agentWritesAllowed: Bool {
        get { defaults.bool(forKey: "agentWritesAllowed") }
        set { defaults.set(newValue, forKey: "agentWritesAllowed") }
    }
    /// Newest audit entry already announced; starts at what is in the file so launch is quiet.
    private var auditSeenAt: Int64 = AuditLog.recent(max: 1).first?.at ?? 0
    /// Entries undone from this menu in this run, so Undo is not offered twice for the same one.
    private var undoneAudit = Set<Int64>()

    private var shapesMode: Bool {
        get { defaults.bool(forKey: "shapesMode") }
        set { defaults.set(newValue, forKey: "shapesMode") }
    }
    /// Governs the AUTOMATIC alerts only (done/needs-you/error/stuck/stopped — every state
    /// transition, for every session). Off by default: the whole point of the menu-bar dots
    /// is to be glanceable and ambient, not an interruption on every session that finishes.
    /// The one alert that's always meant to reach you — an agent session explicitly asked to
    /// ping you when it's done — is `customNotifyOn` below, which is separate on purpose.
    private var notificationsOn: Bool {
        get { defaults.bool(forKey: "notificationsOn") }
        set { defaults.set(newValue, forKey: "notificationsOn") }
    }
    private var dialogAlertsOn: Bool {
        get { defaults.bool(forKey: "dialogAlertsOn") }
        set { defaults.set(newValue, forKey: "dialogAlertsOn") }
    }
    /// Governs ONLY the custom, on-demand notify (the `votive` MCP tool / CLI) — a
    /// session explicitly told, by the user's own prompt, to ping when a specific task is
    /// done. On by default: this is the one interruption meant to always reach you, since it
    /// only ever fires when you actually asked for it (enforced by the tool's own
    /// description, not by this toggle).
    private var customNotifyOn: Bool {
        get { defaults.object(forKey: "customNotifyOn") == nil ? true : defaults.bool(forKey: "customNotifyOn") }
        set { defaults.set(newValue, forKey: "customNotifyOn") }
    }
    /// Minutes of no `updatedAt` movement while busy before a session shows as stuck. 0 = off.
    /// Developer tools: the optional Ports item. Off by default; the menu shows nothing about ports until it is on.
    private var portToolsOn: Bool {
        get { defaults.bool(forKey: "portToolsOn") }
        set { defaults.set(newValue, forKey: "portToolsOn") }
    }
    private lazy var portsMenu = PortsMenu(agentPIDs: { [weak self] in Set((self?.sessions ?? []).map { $0.pid }) })

    /// Read directly by `AgentScanner` too (same UserDefaults key) — this is just the menu's view.
    private var stuckThresholdMinutes: Int {
        get { defaults.object(forKey: "stuckThresholdMinutes") == nil ? 8 : defaults.integer(forKey: "stuckThresholdMinutes") }
        set { defaults.set(newValue, forKey: "stuckThresholdMinutes") }
    }
    /// While any plan limit is over 70%: a slow red pulse behind the dots, alternating with
    /// the limit's name and number (the usage carousel). On by default.
    private var usageAlertOn: Bool {
        get { defaults.object(forKey: "usageAlertOn") == nil ? true : defaults.bool(forKey: "usageAlertOn") }
        set { defaults.set(newValue, forKey: "usageAlertOn") }
    }

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.toolTip = "AI agents"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        render(force: true)
        updateAnimation()
        // Settings can change from outside the menu (the MCP `settings` tool, or `defaults`
        // in a terminal). macOS delivers those changes through KVO, so redraw right away.
        for key in Self.observedDefaults {
            defaults.addObserver(self, forKeyPath: key, options: [], context: nil)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(caffeinateChanged),
                                               name: Caffeinate.didChange, object: nil)
    }

    @objc private func caffeinateChanged() {
        statusItem.button?.toolTip = Caffeinate.shared.isOn ? "AI agents — Caffeinate on" : "AI agents"
        updateHaloPulse()
        render(force: true)
        updateAnimation()
    }

    /// While Caffeinate is on a bright comet runs round the halo (one lap every ~2.4 s). Its own
    /// timer, only alive while on; Reduce motion swaps the lap for a steady outline.
    private func updateHaloPulse() {
        if Caffeinate.shared.isOn, haloTimer == nil {
            haloStart = Date()
            let step = 1.0 / 20
            let t = Timer.commonModeTimer(interval: step, repeats: true) { [weak self] _ in
                self?.haloTick()
            }
            t.tolerance = step * 0.2
            haloTimer = t
            haloTick()
        } else if !Caffeinate.shared.isOn, let t = haloTimer {
            t.invalidate(); haloTimer = nil
            haloPhase = nil
        }
    }

    private func haloTick() {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let elapsed = Date().timeIntervalSince(haloStart)
        let phase: CGFloat? = reduceMotion ? nil : CGFloat(elapsed / 2.4)
        if reduceMotion, haloPhase == nil, elapsed > 0.1 { return }
        haloPhase = phase
        setImage(angle: angle, dimmed: dimmed)
    }

    private static let observedDefaults = ["shapesMode", "usageAlertOn"]

    override func observeValue(forKeyPath keyPath: String?, of object: Any?,
                               change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        guard let keyPath, Self.observedDefaults.contains(keyPath) else {
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.render(force: true)
            self.updateAnimation()
            self.updateUsagePulse()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        for key in Self.observedDefaults { defaults.removeObserver(self, forKeyPath: key) }
    }

    // MARK: - Update

    func update(_ sessions: [AgentSession]) {
        // Captured before detectTransitions flips it true, so a custom notify already present
        // on the very first post-launch scan is recorded (never re-fires) but not alerted on —
        // same launch-quiet convention the state-transition alerts already follow.
        let hadBaseline = baselineEstablished
        var sounds = detectTransitions(sessions)
        if hadBaseline, detectPendingNotifies(sessions) { sounds.insert(.notify) }
        // One sound per scan, however many sessions changed: the most important one wins,
        // in SoundEvent's order (notify › needs you › error › stuck › stopped › done).
        if let event = SoundEvent.allCases.first(where: sounds.contains) {
            Sounds.shared.play(event)
        }
        self.sessions = sessions
        render(force: false)
        updateAnimation()
        announceAgentChanges()
        if debug { logDebug() }
    }

    func updateUsage(_ snapshot: UsageSnapshot?) {
        usage = snapshot
        statusItem.button?.toolTip = snapshot.map { "AI agents — " + usageSummary($0) } ?? "AI agents"
        updateUsagePulse()
    }

    // MARK: - Usage carousel

    /// While a limit is over the threshold, the icon loops: the dots on a slowly breathing red
    /// background (~2.4 s per breath), then a fade to the limit's name ("Weekly"), then its
    /// number ("74%"), then back to the dots — see `UsageCarousel` for the timeline. Behind
    /// the text the red holds steady so the white text reads. Its own timer, separate from
    /// the dot animation: both just redraw via `setImage`, which reads the current state.
    private func updateUsagePulse() {
        let next = usageAlertOn ? usage.flatMap { UsageCarousel($0) } : nil
        if next != nil, carousel == nil { carouselStart = Date() }
        // A new number (74% → 75%) changes the captions but keeps the loop where it is.
        carousel = next
        carouselSig = ""

        if carousel != nil, usageTimer == nil {
            let step = 1.0 / 20
            let t = Timer.commonModeTimer(interval: step, repeats: true) { [weak self] _ in
                self?.usageTick()
            }
            t.tolerance = step * 0.2
            usageTimer = t
            usageTick()
        } else if carousel == nil, let t = usageTimer {
            t.invalidate(); usageTimer = nil
            usageAlpha = nil; carouselFrame = nil
            render(force: true)
        }
    }

    private func usageTick() {
        guard let carousel else { return }
        let elapsed = Date().timeIntervalSince(carouselStart)
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let frame = carousel.frame(at: elapsed, reduceMotion: reduceMotion)
        let breath = reduceMotion ? 0.6 : 0.25 + 0.5 * (0.5 - 0.5 * cos(elapsed / 2.4 * 2 * .pi))
        let background = breath * (1 - frame.captionness) + UsageCarousel.captionBackground * frame.captionness
        // Most ticks while a caption holds draw the same picture: skip those.
        let sig = "\(frame.caption ?? "")|\(Int(frame.contentAlpha * 60))|\(Int(background * 100))"
        guard sig != carouselSig else { return }
        carouselSig = sig
        carouselFrame = frame
        usageAlpha = CGFloat(background)
        setImage(angle: angle, dimmed: dimmed)
    }

    private func usageSummary(_ u: UsageSnapshot) -> String {
        u.agents.map { a in
            a.agentName + " " + a.windows
                .map { "\($0.label.lowercased()) \(Int($0.usedPercentage.rounded()))%" }
                .joined(separator: ", ")
        }.joined(separator: " · ")
    }

    /// One-shot custom alerts fired via the `votive` MCP tool (or its CLI fallback) —
    /// the ONE alert meant to always reach you, since it only fires when a session's own
    /// prompt explicitly asked for a ping (enforced by the tool's own description). Governed
    /// by `customNotifyOn` alone — deliberately NOT the automatic-alert toggles, so turning
    /// those off (the default) never silences a notify you actually asked for.
    /// Returns whether any notify fired, so `update` can play its sound.
    private func detectPendingNotifies(_ new: [AgentSession]) -> Bool {
        guard customNotifyOn else { return false }
        var fired = false
        for s in new {
            guard let notify = s.pendingNotify else { continue }
            alert(s, title: "📣 \(s.name)", body: notify.message, notify: true, dialog: true, requested: true)
            fired = true
        }
        return fired
    }

    /// Announce a session flipping to a notable state — banner, dialog, or both. OFF by
    /// default (`notificationsOn`/`dialogAlertsOn` both default false): this is the ambient
    /// layer — the dots already show state at a glance, so an active interruption on every
    /// session's every transition is opt-in, not the default.
    ///
    /// Returns the sound events those transitions call for. Sounds have their own settings
    /// (`Sounds`), so they're collected whether or not the banner/pop-up toggles are on.
    private func detectTransitions(_ new: [AgentSession]) -> Set<SoundEvent> {
        defer {
            var map: [String: AgentState] = [:]
            for s in new { map[s.id] = s.state }
            prevStates = map
            baselineEstablished = true
        }
        // baselineEstablished only: the first scan sees every session as "new" and would
        // otherwise fire a burst. The two delivery toggles are checked per-alert instead,
        // so switching banners off does not also switch dialogs off.
        guard baselineEstablished else { return [] }
        var sounds = Set<SoundEvent>()
        for s in new {
            // prev stays optional on purpose. A session that shows up already finished —
            // a short run that starts and ends inside one scan window — has no previous
            // state, and requiring one silently swallowed exactly the "it finished but
            // never told me" case this whole path exists for. nil counts as a change.
            let prev = prevStates[s.id]
            guard prev != s.state else { continue }
            if let event = SoundEvent(state: s.state), !(s.state == .done && prev == .stopped) {
                sounds.insert(event)
            }
            guard notificationsOn || dialogAlertsOn else { continue }
            switch s.state {
            case .done where prev != .stopped:
                alert(s, title: "✅ \(s.name) finished", body: recapText(s), notify: notificationsOn, dialog: dialogAlertsOn)
            case .needsInput:
                alert(s, title: "🟣 \(s.name) needs you", body: "Waiting for your permission.", notify: notificationsOn, dialog: dialogAlertsOn)
            case .warning:
                alert(s, title: "🟠 \(s.name) hit an error", body: recapText(s), notify: notificationsOn, dialog: dialogAlertsOn)
            case .stuck:
                alert(s, title: "🟤 \(s.name) seems stuck", body: stuckBody(s), notify: notificationsOn, dialog: dialogAlertsOn)
            case .stopped:
                alert(s, title: "🔴 \(s.name) stopped", body: recapText(s), notify: notificationsOn, dialog: dialogAlertsOn)
            default: break
            }
        }
        return sounds
    }

    private func stuckBody(_ s: AgentSession) -> String {
        let minutes = max(1, Int((Int64(Date().timeIntervalSince1970 * 1000) - s.lastActivityAt) / 60_000))
        return "No progress for \(minutes)m — \(recapText(s))"
    }

    /// Try the banner first; fall back to a dialog whenever the banner didn't actually go out
    /// (unauthorized, or banners turned off). `notify`/`dialog` are which of the CALLER's own
    /// toggles apply — automatic transitions and the custom on-demand notify are gated by
    /// separate toggle sets, see `detectTransitions` / `detectPendingNotifies`. Every dialog
    /// gets a one-click "Open Terminal" jump when we know a real pid to focus.
    private func alert(_ s: AgentSession, title: String, body: String, notify: Bool, dialog: Bool, requested: Bool = false) {
        let delivered = notify
            && Notifier.shared.notify(sessionId: s.id, pid: s.pid, title: title, body: body)
        if dialog, !delivered {
            let pid = s.pid
            DialogAlerter.shared.show(title: title, body: body,
                openAction: pid > 0 ? { TerminalFocus.focus(sessionPID: pid) } : nil, replaceOldest: requested)
        }
    }

    // MARK: - Icon rendering + animation

    private func render(force: Bool) {
        guard let button = statusItem.button else { return }
        let states = sessions.map { $0.state }
        let sig = states.map { $0.rawValue }.joined(separator: ",")
            + "|\(shapesMode)|\(Caffeinate.shared.isOn)|\(button.effectiveAppearance.name.rawValue)"
        if !force, animTimer == nil, usageTimer == nil, sig == cacheKey { return }
        cacheKey = sig
        setImage(angle: 0, dimmed: false)
    }

    private func setImage(angle: CGFloat, dimmed: Bool) {
        guard let button = statusItem.button else { return }
        let states = sessions.map { $0.state }
        button.effectiveAppearance.performAsCurrentDrawingAppearance {
            button.image = MenuBarIconRenderer.image(
                for: states, shapes: shapesMode, angle: angle, pulseDimmed: dimmed,
                alertAlpha: usageAlpha,
                caption: carouselFrame?.caption,
                contentAlpha: CGFloat(carouselFrame?.contentAlpha ?? 1),
                minWidth: carousel.map {
                    MenuBarIconRenderer.carouselWidth(stateCount: states.count, captions: $0.captions)
                } ?? 0,
                halo: Caffeinate.shared.isOn,
                haloPhase: haloPhase)
        }
    }

    private func updateAnimation() {
        let hasAttention = sessions.contains { $0.state.pulses }
        let idle = sessions.isEmpty
        let animate = hasAttention || idle

        if animate {
            let rotate = idle || (hasAttention && shapesMode)
            let interval = idle ? (1.0 / 12) : (rotate ? (1.0 / 15) : 0.6)
            // Rebuild when the mode changes (idle arc ↔ pulse ↔ rotate), not just on/off —
            // otherwise the timer keeps animating the way it did when it was first created.
            if animTimer != nil, let m = animMode, m.rotate == rotate, m.interval == interval { return }
            animTimer?.invalidate()
            angle = 0; dimmed = false
            animMode = (rotate, interval)
            let t = Timer.commonModeTimer(interval: interval, repeats: true) { [weak self] _ in
                self?.tick(rotate: rotate)
            }
            t.tolerance = interval * 0.2   // lets macOS coalesce wakeups
            animTimer = t
        } else if let timer = animTimer {
            timer.invalidate(); animTimer = nil; animMode = nil
            angle = 0; dimmed = false
            render(force: true)
        }
    }

    private func tick(rotate: Bool) {
        if rotate {
            angle += .pi / 15
            if angle > .pi * 2 { angle -= .pi * 2 }
            setImage(angle: angle, dimmed: false)
        } else {
            dimmed.toggle()
            setImage(angle: 0, dimmed: dimmed)
        }
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        addUsageItems(menu)

        menu.addItem(.sectionHeader(title: "Sessions"))
        if sessions.isEmpty {
            let none = NSMenuItem(title: "No agents running", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        } else {
            for session in sessions {
                let item = NSMenuItem()
                item.view = AgentRowView(
                    session: session,
                    stateImage: dotImage(for: session.state),
                    hostIcon: TerminalFocus.hostingApp(forPID: session.pid)?.icon,
                    recap: recapLine(session))
                item.submenu = actionsMenu(for: session)   // opens on hover
                menu.addItem(item)
            }
            let summary = NSMenuItem(title: summaryLine(), action: nil, keyEquivalent: "")
            summary.isEnabled = false
            menu.addItem(summary)
        }

        addAgentChanges(menu)

        menu.addItem(.separator())
        menu.addItem(caffeinateMenuItem())
        menu.addItem(snippetsMenuItem())
        if portToolsOn { menu.addItem(portsMenu.menuItem()) }
        menu.addItem(settingsMenuItem())

        menu.addItem(.separator())
        menu.addItem(actionItem("Open ~/.votive", symbol: "folder", #selector(openSessionsDir)))
        menu.addItem(actionItem("About Votive", symbol: "info.circle", #selector(showAbout)))
        menu.addItem(actionItem("Quit Votive", symbol: "power", #selector(quit), key: "q"))

        // Session and usage rows are custom views: give them the menu's full width so their
        // content lines up with the native items (their autoresizing mask covers later resizes).
        let width = max(AgentRowView.minWidth, menu.size.width)
        for item in menu.items {
            if let v = item.view { v.frame.size.width = width }
        }
    }

    private func actionItem(_ title: String, symbol: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        return item
    }

    /// One click to keep the Mac awake on battery too. The menu-bar icon wears a halo while it's on.
    private func caffeinateMenuItem() -> NSMenuItem {
        let on = Caffeinate.shared.isOn
        let item = NSMenuItem(title: "Caffeinate", action: #selector(toggleCaffeinate), keyEquivalent: "")
        item.target = self
        item.state = on ? .on : .off
        item.image = NSImage(systemSymbolName: on ? "cup.and.saucer.fill" : "cup.and.saucer", accessibilityDescription: nil)
        item.toolTip = on
            ? "On: this Mac won't sleep or lock from being idle, even on battery. Click to turn off."
            : "Off. Click to stop this Mac sleeping or locking from being idle, even on battery."
        return item
    }

    /// Every preference, in one submenu (the usual shape for a menu-bar app's settings).
    private func settingsMenuItem() -> NSMenuItem {
        let root = NSMenuItem(title: "Settings", action: nil, keyEquivalent: "")
        root.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        let sub = NSMenu()

        sub.addItem(.sectionHeader(title: "Menu bar"))
        addToggle(sub, title: "Colorblind shapes", on: shapesMode, action: #selector(toggleShapes))
        addToggle(sub, title: "Show limits over 70% in the menu bar", on: usageAlertOn, action: #selector(toggleUsageAlert))
        sub.addItem(stuckThresholdMenuItem())

        sub.addItem(.separator())
        sub.addItem(.sectionHeader(title: "Alerts"))
        addToggle(sub, title: "When a session asks to notify me", on: customNotifyOn, action: #selector(toggleCustomNotify))
        sub.items.last?.toolTip = "Only fires when you ask a session to let you know (the notify tool or /notify)."
        addToggle(sub, title: "Banner on every state change", on: notificationsOn, action: #selector(toggleNotifications))
        sub.items.last?.toolTip = "A Notification Center banner whenever any session finishes, needs you, errors or stops."
        addToggle(sub, title: "Pop-up on every state change", on: dialogAlertsOn, action: #selector(toggleDialogAlerts))
        sub.items.last?.toolTip = "A floating panel whenever any session finishes, needs you, errors or stops."

        sub.addItem(.separator())
        sub.addItem(.sectionHeader(title: "Agents"))
        addToggle(sub, title: "Let agents change settings", on: agentWritesAllowed, action: #selector(toggleAgentWrites))
        sub.items.last?.toolTip = "Off by default. When on, an agent you ask can change these settings or repair this install through the MCP tools (a few times an hour); every change is listed under Agent changes, where you can undo it."

        sub.addItem(.separator())
        sub.addItem(.sectionHeader(title: "Developer tools"))
        addToggle(sub, title: "Ports: watch and free", on: portToolsOn, action: #selector(togglePortTools))
        sub.items.last?.toolTip = "Off by default. Adds a Ports item to the menu: a short list of ports you watch, who is using each, and a button to stop that program (it asks first). Only programs you own, never an agent session."

        sub.addItem(.separator())
        sub.addItem(.sectionHeader(title: "Sounds"))
        addToggle(sub, title: "Play sounds", on: Sounds.shared.enabled, action: #selector(toggleSounds))
        sub.items.last?.toolTip = "Every sound below. Each one plays even when the banner and pop-up are off."
        for event in SoundEvent.allCases { sub.addItem(soundMenuItem(event)) }

        root.submenu = sub
        return root
    }

    // MARK: - Usage rows

    private func addUsageItems(_ menu: NSMenu) {
        let now = Date()
        // Re-read on open so an expired window never shows, even between store ticks.
        guard let u = UsageStore.read(now: now) else {
            menu.addItem(.sectionHeader(title: "Usage"))
            let none = NSMenuItem(title: "Waiting for an agent to report", action: nil, keyEquivalent: "")
            none.isEnabled = false
            none.toolTip = "Plan limits appear after the next reply in Claude Code (claude.ai login) or the next turn in Codex."
            menu.addItem(none)
            menu.addItem(.separator())
            return
        }
        for agent in u.agents {
            let header = NSMenuItem.sectionHeader(
                title: "\(agent.agentName) usage · updated \(Self.ago(agent.updatedAt, now: now))")
            menu.addItem(header)
            for w in agent.windows {
                let item = NSMenuItem()
                item.view = UsageRowView(label: w.label, usedPercentage: w.usedPercentage,
                                         resetText: Self.resetText(w.resetsAt, now: now),
                                         threshold: UsageSnapshot.alertThreshold)
                menu.addItem(item)
            }
        }
        menu.addItem(.separator())
    }

    private static func resetText(_ date: Date, now: Date) -> String {
        // Template, not a fixed format: follows the user's locale and 12/24-hour setting.
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate(Calendar.current.isDate(date, inSameDayAs: now) ? "jmm" : "EEEjmm")
        return f.string(from: date)
    }

    private static func ago(_ date: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86_400 { return "\(s / 3600)h ago" }
        return "\(s / 86_400)d ago"
    }

    private func addToggle(_ menu: NSMenu, title: String, on: Bool, action: Selector) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.state = on ? .on : .off
        menu.addItem(item)
    }

    private static let stuckThresholdOptions: [(label: String, minutes: Int)] =
        [("Off", 0), ("5 min", 5), ("8 min", 8), ("15 min", 15)]

    private func stuckThresholdMenuItem() -> NSMenuItem {
        let root = NSMenuItem(title: "Stuck threshold", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        let current = stuckThresholdMinutes
        // A value set outside the menu (MCP `settings`, `defaults`) that isn't one of the presets.
        if !Self.stuckThresholdOptions.contains(where: { $0.minutes == current }) {
            let custom = NSMenuItem(title: "\(current) min", action: nil, keyEquivalent: "")
            custom.state = .on
            custom.isEnabled = false
            sub.addItem(custom)
        }
        for option in Self.stuckThresholdOptions {
            let item = NSMenuItem(title: option.label, action: #selector(setStuckThreshold(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = option.minutes
            item.state = (option.minutes == current) ? .on : .off
            sub.addItem(item)
        }
        root.submenu = sub
        return root
    }

    @objc private func setStuckThreshold(_ sender: NSMenuItem) {
        guard let minutes = sender.representedObject as? Int else { return }
        stuckThresholdMinutes = minutes
    }

    private func recapLine(_ s: AgentSession) -> String {
        if let r = s.recap {
            let flat = r.replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !flat.isEmpty {
                return "“" + (flat.count > 72 ? String(flat.prefix(72)) + "…" : flat) + "”"
            }
        }
        return "📁 " + s.cwdBasename
    }

    /// Dialog body for the automatic alerts. Deliberately does NOT fall back to
    /// `s.cwdBasename` — the dialog's TITLE already shows that (via `s.name`), so repeating it
    /// in the body is pure noise ("✅ api-refactor finished" / body: "api-refactor"
    /// tells you nothing). Say plainly that nothing more specific is known instead of implying
    /// the folder name IS the description.
    private func recapText(_ s: AgentSession) -> String {
        if let r = s.recap, !r.isEmpty { return String(r.prefix(120)) }
        return "No recent prompt on record for this session."
    }

    private func summaryLine() -> String {
        var counts: [AgentState: Int] = [:]
        for s in sessions { counts[s.state, default: 0] += 1 }
        let order: [AgentState] = [.needsInput, .warning, .stuck, .stopped, .working, .starting, .done]
        return order.compactMap { st in counts[st].map { "\($0) \(st.label)" } }
            .joined(separator: " · ")
    }

    private func dotImage(for state: AgentState) -> NSImage {
        let d: CGFloat = 12
        let image = NSImage(size: NSSize(width: d, height: d))
        image.lockFocus()
        MenuBarIconRenderer.image(for: [state], shapes: shapesMode)
            .draw(in: NSRect(x: 0, y: 0, width: d, height: d))
        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    // MARK: - Per-agent action submenu

    /// Actions menu for one agent, popped on right-click / "⋯" from its row.
    func actionsMenu(for s: AgentSession) -> NSMenu {
        let menu = NSMenu()
        let ref = SessionRef(pid: s.pid, cwd: s.cwd, id: s.sessionId)
        if s.pid > 0 {
            addItem(menu, "Open terminal window", #selector(focusSession(_:)), ref, bold: true)
            menu.addItem(.separator())
        }
        if !s.cwd.isEmpty {
            addItem(menu, "Reveal folder in Finder", #selector(revealFolder(_:)), ref)
            addItem(menu, "Copy folder path", #selector(copyPath(_:)), ref)
        }
        addItem(menu, "Copy session ID", #selector(copySessionID(_:)), ref)
        if let url = transcriptURL(for: s) {
            let r = SessionRef(pid: s.pid, cwd: url.path, id: s.sessionId)
            addItem(menu, "Open transcript", #selector(openTranscript(_:)), r)
        }
        return menu
    }

    private func addItem(_ menu: NSMenu, _ title: String, _ action: Selector, _ ref: SessionRef, bold: Bool = false) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.representedObject = ref
        if bold {
            item.attributedTitle = NSAttributedString(string: title,
                attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)])
        }
        menu.addItem(item)
    }

    /// The transcript path the agent reported, else Claude Code's conventional location.
    private func transcriptURL(for s: AgentSession) -> URL? {
        if let p = s.transcriptPath, FileManager.default.fileExists(atPath: p) {
            return URL(fileURLWithPath: p)
        }
        guard s.agent == AgentKind.claudeCode, !s.cwd.isEmpty else { return nil }
        let munged = String(s.cwd.map { ($0.isLetter || $0.isNumber) ? $0 : "-" })
        let url = Paths.claude.appendingPathComponent("projects/\(munged)/\(s.sessionId).jsonl")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - Prompt snippets

    private func snippetsMenuItem() -> NSMenuItem {
        let root = NSMenuItem(title: "Prompt snippets", action: nil, keyEquivalent: "")
        root.image = NSImage(systemSymbolName: "text.bubble", accessibilityDescription: nil)
        let sub = NSMenu()
        let snippets = SnippetStore.shared.load()
        if snippets.isEmpty {
            let hint = NSMenuItem(title: "No snippets yet", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            sub.addItem(hint)
        } else {
            for snip in snippets {
                let title = snip.replacingOccurrences(of: "\n", with: " ")
                let shown = title.count > 48 ? String(title.prefix(48)) + "…" : title
                let item = NSMenuItem(title: shown, action: #selector(copySnippet(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = snip
                item.toolTip = "Copy to clipboard: \(title)"
                sub.addItem(item)
            }
        }
        sub.addItem(.separator())
        let add = NSMenuItem(title: "Add from clipboard", action: #selector(addSnippetFromClipboard), keyEquivalent: "")
        add.target = self
        sub.addItem(add)
        let edit = NSMenuItem(title: "Edit snippets…", action: #selector(editSnippets), keyEquivalent: "")
        edit.target = self
        sub.addItem(edit)
        root.submenu = sub
        return root
    }

    // MARK: - Actions

    @objc private func focusSession(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? SessionRef else { return }
        if ref.pid > 0 { TerminalFocus.focus(sessionPID: ref.pid) }
        else if !ref.cwd.isEmpty { Reveal.folder(ref.cwd) }
    }

    @objc private func revealFolder(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? SessionRef, !ref.cwd.isEmpty else { return }
        Reveal.folder(ref.cwd)
    }

    @objc private func copyPath(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? SessionRef else { return }
        copyToClipboard(ref.cwd)
    }

    @objc private func copySessionID(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? SessionRef else { return }
        copyToClipboard(ref.id)
    }

    @objc private func openTranscript(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? SessionRef else { return }
        Reveal.transcript(ref.cwd)   // cwd carries the transcript path here
    }

    @objc private func copySnippet(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        copyToClipboard(text)
    }

    @objc private func addSnippetFromClipboard() {
        guard let text = NSPasteboard.general.string(forType: .string) else { return }
        if SnippetStore.shared.add(text) == .unreadable {
            DialogAlerter.shared.show(title: "Snippets file isn't valid JSON",
                body: "Nothing was added and your file was left as it is. Fix it with Edit snippets… (a list of quoted strings separated by commas).")
        }
    }

    @objc private func editSnippets() {
        SnippetStore.shared.ensureFile()
        NSWorkspace.shared.open(SnippetStore.shared.fileURL)
    }

    @objc private func toggleShapes() {
        shapesMode.toggle()
        render(force: true)
        updateAnimation()
    }

    @objc private func toggleUsageAlert() {
        usageAlertOn.toggle()
        updateUsagePulse()
    }

    @objc private func toggleCaffeinate() {
        if !Caffeinate.shared.toggle() {
            DialogAlerter.shared.show(title: "Couldn't turn on Caffeinate",
                                      body: "macOS refused the power assertion, so the Mac may still sleep.")
        }
    }

    @objc private func toggleNotifications() { notificationsOn.toggle() }

    @objc private func toggleDialogAlerts() { dialogAlertsOn.toggle() }

    @objc private func toggleCustomNotify() { customNotifyOn.toggle() }

    @objc private func toggleAgentWrites() { agentWritesAllowed.toggle() }

    @objc private func togglePortTools() { portToolsOn.toggle() }

    // MARK: - Agent changes (what agents did through the MCP tools)

    /// The last five entries of the audit file, newest first, each with an Undo when it can safely be undone.
    private func addAgentChanges(_ menu: NSMenu) {
        let entries = AuditLog.recent(max: 5).filter { $0.tool != "notify" }
        guard !entries.isEmpty else { return }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Agent changes"))
        for entry in entries {
            let item = NSMenuItem(title: AgentChanges.menuTitle(for: entry), action: nil, keyEquivalent: "")
            item.isEnabled = entry.ok == true && AgentChanges.undoSteps(for: entry) != nil && !undoneAudit.contains(entry.at)
            if item.isEnabled {
                let sub = NSMenu()
                let undo = NSMenuItem(title: "Undo this change", action: #selector(undoAgentChange(_:)), keyEquivalent: "")
                undo.target = self
                undo.representedObject = AuditRef(entry)
                sub.addItem(undo)
                item.submenu = sub
            }
            menu.addItem(item)
        }
    }

    @objc private func undoAgentChange(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? AuditRef else { return }
        if AgentChanges.undo(ref.entry, in: defaults) {
            undoneAudit.insert(ref.entry.at)
            render(force: true)
            updateUsagePulse()
        }
    }

    /// A panel the moment an agent changes something, so a change never happens silently.
    private func announceAgentChanges() {
        let fresh = AuditLog.unseen(after: auditSeenAt)
        guard !fresh.isEmpty else { return }
        auditSeenAt = max(auditSeenAt, fresh.map { $0.at }.max() ?? auditSeenAt)
        for entry in fresh {
            let text = AgentChanges.panel(for: entry)
            DialogAlerter.shared.show(title: text.title, body: text.body)
        }
    }

    @objc private func toggleSounds() {
        Sounds.shared.enabled.toggle()
        if Sounds.shared.enabled { Sounds.shared.play(.notify) }   // preview what you just turned on
    }

    // MARK: - Sounds

    /// "Done: Hero ▸" with every choice: none, the system sounds, your own files, and a way
    /// to add one. Picking a sound plays it.
    private func soundMenuItem(_ event: SoundEvent) -> NSMenuItem {
        let sounds = Sounds.shared
        let current = sounds.sound(for: event)
        let root = NSMenuItem(title: "\(event.title): \(Sounds.displayName(current))", action: nil, keyEquivalent: "")
        root.isEnabled = sounds.enabled
        let sub = NSMenu()
        func choice(_ name: String) {
            let item = NSMenuItem(title: Sounds.displayName(name), action: #selector(pickSound(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [event.rawValue, name]
            item.state = (name == current) ? .on : .off
            sub.addItem(item)
        }
        choice(Sounds.none)
        sub.addItem(.separator())
        let custom = Sounds.customFiles()
        // A setting that points at a file that's no longer there still shows, ticked.
        if current != Sounds.none, !Sounds.systemNames.contains(current), !custom.contains(current) {
            let missing = NSMenuItem(title: "\(Sounds.displayName(current)) (missing)", action: nil, keyEquivalent: "")
            missing.state = .on
            missing.isEnabled = false
            sub.addItem(missing)
        }
        if !custom.isEmpty {
            sub.addItem(.sectionHeader(title: "Your sounds"))
            custom.forEach(choice)
            sub.addItem(.separator())
        }
        sub.addItem(.sectionHeader(title: "macOS"))
        Sounds.systemNames.forEach(choice)
        sub.addItem(.separator())
        let add = NSMenuItem(title: "Add Sound File…", action: #selector(addSoundFile(_:)), keyEquivalent: "")
        add.target = self
        add.representedObject = event.rawValue
        sub.addItem(add)
        sub.addItem(actionItem("Open Sounds Folder", symbol: "folder", #selector(openSoundsDir)))
        root.submenu = sub
        return root
    }

    @objc private func pickSound(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [String], pair.count == 2,
              let event = SoundEvent(rawValue: pair[0]) else { return }
        Sounds.shared.setSound(pair[1], for: event)
        Sounds.shared.play(named: pair[1])
    }

    /// Copies the chosen file into ~/.votive/sounds/ (so moving or deleting the
    /// original can't silence it) and uses it for this event.
    @objc private func addSoundFile(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let event = SoundEvent(rawValue: raw) else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a sound for “\(event.title)”"
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)   // an accessory app's panel opens behind otherwise
        guard panel.runModal() == .OK, let src = panel.url else { return }
        let fm = FileManager.default
        let dest = Paths.sounds.appendingPathComponent(src.lastPathComponent)
        do {
            try fm.createDirectory(at: Paths.sounds, withIntermediateDirectories: true)
            if src.standardizedFileURL != dest.standardizedFileURL {
                if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
                try fm.copyItem(at: src, to: dest)
            }
        } catch {
            DialogAlerter.shared.show(title: "Couldn't add the sound", body: error.localizedDescription)
            return
        }
        Sounds.shared.clearCache()
        Sounds.shared.setSound(dest.lastPathComponent, for: event)
        Sounds.shared.play(named: dest.lastPathComponent)
    }

    @objc private func openSoundsDir() {
        try? FileManager.default.createDirectory(at: Paths.sounds, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.sounds)
    }

    @objc private func openSessionsDir() { NSWorkspace.shared.open(Paths.root) }

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.icon = NSApp.applicationIconImage
        alert.messageText = "Votive"
        alert.informativeText = """
        A small menu-bar utility that shows the live status of your AI coding-agent sessions \
        (Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI and more) as colored dots — \
        working, done, needs-you, error, stopped. Click a row to jump to that session's terminal.

        Where the agent exposes it (Claude Code, Codex), it also shows plan usage. When a limit \
        goes over 70%, the menu-bar icon pulses red and shows which limit it is and how full.

        It only reads local files on this Mac and sends nothing to any network or external \
        service. MIT licensed; remove any time with Scripts/uninstall.sh. Not affiliated with \
        any agent's maker.
        """
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func copyToClipboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    // MARK: - Debug

    private func logDebug() {
        let line = sessions.map {
            "\($0.name)=\($0.state.rawValue) recap=\($0.recap.map { "\"\($0.prefix(40))\"" } ?? "nil")"
        }.joined(separator: " | ")
        FileHandle.standardError.write(Data("[Votive] \(sessions.count): \(line)\n".utf8))
    }
}

extension Timer {
    /// A timer that also fires while the menu is open. `Timer.scheduledTimer` runs only in the
    /// default run-loop mode, and an open menu switches the main loop to event-tracking mode, so
    /// every animation built on it froze until the menu closed. Use this for anything that
    /// should keep moving or dismissing itself while the user is in the menu.
    static func commonModeTimer(interval: TimeInterval, repeats: Bool,
                                block: @escaping (Timer) -> Void) -> Timer {
        let timer = Timer(timeInterval: interval, repeats: repeats, block: block)
        RunLoop.main.add(timer, forMode: .common)
        return timer
    }
}

/// An audit entry as a menu item's payload (representedObject needs a class).
private final class AuditRef {
    let entry: AuditEntry
    init(_ entry: AuditEntry) { self.entry = entry }
}

/// Small reference-type payload for a menu item (representedObject needs a class).
private final class SessionRef {
    let pid: Int32
    let cwd: String
    let id: String
    init(pid: Int32, cwd: String, id: String) { self.pid = pid; self.cwd = cwd; self.id = id }
}
