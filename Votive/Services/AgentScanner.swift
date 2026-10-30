import Foundation

/// Joins the registry, the overlay map and liveness into a stably-ordered `[AgentSession]`.
/// Owns the per-session "first seen dead" bookkeeping needed for red age-out.
/// All methods run on the coordinator's serial work queue.
final class AgentScanner {
    private let registry = SessionRegistry()
    private let overlayStore = OverlayStore()
    private var resolver = StatusResolver()
    private let history = HistoryReader()
    private var firstSeenDead: [String: Int64] = [:]   // sessionId → epoch-ms
    /// sessionId → epoch-ms of the last `notifyAt` we've already surfaced, so a custom
    /// message fires exactly once even though its file sticks around across scans.
    private var lastNotifiedAt: [String: Int64] = [:]
    private var firstSeenAt: [String: Int64] = [:]   // session key → epoch-ms

    /// How long an event-only session with no known host pid stays visible after its last event.
    private let overlayOnlyTTL: Int64 = 30 * 60 * 1000
    /// Prune stale overlay files at most this often (and once at launch).
    private let pruneEveryMs: Int64 = 60 * 60 * 1000
    private var lastPruneAt: Int64 = 0

    /// The Mac just woke from sleep: stuck detection counts quiet time from now.
    func noteWake(at now: Int64) { resolver.activityFloor = now }

    func scan(now: Int64) -> [AgentSession] {
        // Cheap UserDefaults read (in-memory after first access, no file I/O) — lets the
        // menu's "Stuck threshold" toggle take effect on the very next scan.
        resolver.stuckMs = AgentScanner.stuckThresholdMs()

        let regs = registry.scan()
        if now - lastPruneAt > pruneEveryMs {
            lastPruneAt = now
            let registered = Set(regs.map { AgentKind.claudeCode + ":" + $0.sessionId })
            overlayStore.prune(olderThanMs: 24 * 60 * 60 * 1000, now: now) { ov in
                registered.contains(ov.key) || Self.overlayHostAlive(ov)
            }
        }
        let overlays = overlayStore.scan()

        // Claude Code sessions' last prompt from its history file (cached unless it grew).
        // Other agents' prompts come from their event files.
        let recaps = history.lastPrompts(for: Set(regs.map { $0.sessionId }).union(
            overlays.values.filter { $0.agentId == AgentKind.claudeCode }.map { $0.sessionId }))

        var sessions: [AgentSession] = []
        var present = Set<String>()

        // 1) Claude Code sessions from its live registry, joined with their event file.
        for reg in regs {
            let key = AgentKind.claudeCode + ":" + reg.sessionId
            present.insert(key)
            let alive = Liveness.isAlive(reg.pid) && !isPidReused(reg)
            noteLiveness(key, alive: alive, now: now)

            let ov = overlays[key]
            guard let state = resolver.resolve(
                reg: reg, overlay: ov, isAlive: alive, now: now,
                firstSeenDeadAt: firstSeenDead[key]) else { continue }

            let updatedAt = reg.updatedAt ?? reg.startedAt ?? 0
            let displayName = reg.name?.isEmpty == false
                ? reg.name!
                : (reg.cwd as NSString).lastPathComponent

            sessions.append(AgentSession(
                id: key, agent: AgentKind.claudeCode, sessionId: reg.sessionId,
                pid: reg.pid, name: displayName, cwd: reg.cwd,
                state: state, startedAt: reg.startedAt ?? updatedAt,
                lastActivityAt: max(updatedAt, ov?.lastEventAt ?? 0),
                recap: recaps[reg.sessionId] ?? ov?.prompt,
                transcriptPath: ov?.transcriptPath,
                pendingNotify: consumeNotify(key: key, overlay: ov)))
        }

        // 2) Every other session is known only from its event file: other agents, and Claude
        //    Code sessions not in its registry yet (a brand-new, un-prompted terminal).
        for (key, ov) in overlays where !present.contains(key) {
            let hostPid = ov.pid.map { Int32(truncatingIfNeeded: $0) } ?? 0
            let alive: Bool
            if hostPid > 0 {
                alive = Self.overlayHostAlive(ov)
            } else {
                // No pid to check: trust it only while recent.
                guard now - ov.lastEventAt <= overlayOnlyTTL else { continue }
                alive = true
            }
            // A session that died long before we first saw it is history, not a red dot.
            // (Not for one we have been showing: a session that goes quiet for a minute and then dies
            // while we watch still earns its red dot.)
            if !alive, firstSeenAt[key] == nil, now - ov.lastEventAt > resolver.redGraceMs { continue }
            present.insert(key)
            noteLiveness(key, alive: alive, now: now)
            guard let state = resolver.resolveEvent(
                ov, isAlive: alive, now: now, firstSeenDeadAt: firstSeenDead[key]) else { continue }

            let cwd = ov.cwd ?? ""
            let name = cwd.isEmpty ? "session" : (cwd as NSString).lastPathComponent
            sessions.append(AgentSession(
                id: key, agent: ov.agentId, sessionId: ov.sessionId,
                pid: hostPid, name: name, cwd: cwd,
                state: state, startedAt: firstSeen(key, at: ov.lastEventAt), lastActivityAt: ov.lastEventAt,
                recap: ov.agentId == AgentKind.claudeCode ? (recaps[ov.sessionId] ?? ov.prompt) : ov.prompt,
                transcriptPath: ov.transcriptPath,
                pendingNotify: consumeNotify(key: key, overlay: ov)))
        }

        // Forget bookkeeping for sessions whose files are gone.
        firstSeenDead = firstSeenDead.filter { present.contains($0.key) }
        firstSeenAt = firstSeenAt.filter { present.contains($0.key) }
        // Bounded the same way: only sessions with a current overlay file can still owe a
        // notify comparison, so drop anything else rather than growing forever.
        lastNotifiedAt = lastNotifiedAt.filter { overlays[$0.key] != nil }

        // Stable order: by open time (first-opened = leftmost). Ties broken by id for determinism.
        sessions.sort { (a: AgentSession, b: AgentSession) -> Bool in
            if a.startedAt != b.startedAt { return a.startedAt < b.startedAt }
            return a.id < b.id
        }
        return sessions
    }

    private func noteLiveness(_ key: String, alive: Bool, now: Int64) {
        if alive { firstSeenDead[key] = nil }
        else if firstSeenDead[key] == nil { firstSeenDead[key] = now }
    }

    /// Event files don't record when a session opened, so the first event we saw stands in
    /// for it — keeps dot order stable instead of reshuffling on every new event.
    private func firstSeen(_ key: String, at: Int64) -> Int64 {
        if let t = firstSeenAt[key] { return t }
        firstSeenAt[key] = at
        return at
    }

    /// The overlay file's host pid is alive AND is still the same process: a process that
    /// started after the file's last event can't be the one that wrote it (pid reuse).
    private static func overlayHostAlive(_ ov: OverlayEntry) -> Bool {
        guard let raw = ov.pid, raw > 0 else { return false }
        let pid = Int32(truncatingIfNeeded: raw)
        guard Liveness.isAlive(pid) else { return false }
        if let procStart = Liveness.processStartEpoch(pid),
           Int64(procStart * 1000) > ov.lastEventAt + 5_000 { return false }
        return true
    }

    /// A recycled pid can make `kill(pid,0)` report a *different* live process as alive.
    /// If the real process at this pid started well after our session began, it's not ours.
    private func isPidReused(_ reg: RegistryEntry) -> Bool {
        guard let startedAt = reg.startedAt,
              let procStart = Liveness.processStartEpoch(reg.pid) else { return false }
        return Int64(procStart * 1000) > startedAt + 5_000
    }

    /// Returns a `PendingNotify` exactly once per fresh `notifyAt` written by
    /// `votive-notify.js`, and records it as seen so it never fires twice — the overlay
    /// file itself is left untouched (read-only from this side), so a second scan of the same
    /// file naturally returns nil once `lastNotifiedAt` has caught up.
    private func consumeNotify(key: String, overlay: OverlayEntry?) -> AgentSession.PendingNotify? {
        guard let overlay, let msg = overlay.notifyMessage, let at = overlay.notifyAt,
              at > (lastNotifiedAt[key] ?? 0) else { return nil }
        lastNotifiedAt[key] = at
        return AgentSession.PendingNotify(message: msg, at: at)
    }

    /// Menu-configurable stuck-detection threshold, stored in minutes (0 = off). Read fresh
    /// every scan — a plain UserDefaults lookup, effectively free after the first access.
    private static func stuckThresholdMs() -> Int64 {
        let defaults = UserDefaults.standard
        let minutes = defaults.object(forKey: "stuckThresholdMinutes") == nil
            ? 8 : defaults.integer(forKey: "stuckThresholdMinutes")
        return minutes > 0 ? Int64(minutes) * 60_000 : 0
    }
}
