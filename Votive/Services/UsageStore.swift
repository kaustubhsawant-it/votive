import Foundation

/// One plan-limit window, e.g. Claude Code's 5-hour "Session" or Codex's "Weekly".
struct UsageWindow: Equatable {
    let label: String
    let usedPercentage: Double
    let resetsAt: Date
}

/// Latest plan usage for one agent, from `~/.votive/usage/<agent>.json`. Windows whose
/// reset time has passed are dropped on read, so a stale 90% from a window that already reset
/// can never keep the menu bar pulsing red.
struct AgentUsage: Equatable {
    let agent: String
    let windows: [UsageWindow]
    let updatedAt: Date

    var agentName: String { AgentKind.name(agent) }
}

/// Every agent's usage. Strictly above `alertThreshold` in any window of any agent = red pulse.
struct UsageSnapshot: Equatable {
    let agents: [AgentUsage]

    static let alertThreshold: Double = 70

    var overThreshold: Bool {
        agents.contains { $0.windows.contains { $0.usedPercentage > Self.alertThreshold } }
    }
}

/// Watches `~/.votive/usage/` (kqueue — writers use atomic rename, so a directory vnode
/// fires) and publishes a snapshot on the main thread when it changes. A once-a-minute tick
/// re-reads so windows expire at their reset time even with no writes.
final class UsageStore {
    var onChange: ((UsageSnapshot?) -> Void)?

    private let queue = DispatchQueue(label: "dev.votive.Votive.usage", qos: .utility)
    private var watcher: DirectoryWatcher?
    private var timer: DispatchSourceTimer?
    private var last: UsageSnapshot?

    func start() {
        queue.async { [weak self] in
            guard let self else { return }
            try? FileManager.default.createDirectory(
                at: Paths.usage, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            self.watcher = DirectoryWatcher(url: Paths.usage, queue: self.queue) { [weak self] in
                self?.reload()
            }
            self.watcher?.start()
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + 60, repeating: 60, leeway: .seconds(5))
            t.setEventHandler { [weak self] in
                if self?.watcher?.isWatching == false { self?.watcher?.start() }
                self?.reload()
            }
            self.timer = t
            t.resume()
            self.reload(force: true)
        }
    }

    private func reload(force: Bool = false) {
        let snap = Self.read(now: Date())
        guard force || snap != last else { return }
        last = snap
        DispatchQueue.main.async { [weak self] in self?.onChange?(snap) }
    }

    /// All agents with at least one live window, Claude Code first, then by name.
    static func read(now: Date) -> UsageSnapshot? {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: Paths.usage, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        else { return nil }
        var agents: [AgentUsage] = []
        for url in urls where url.pathExtension == "json" && url.lastPathComponent != "wrapped.json" {
            if let a = readAgent(url, now: now) { agents.append(a) }
        }
        agents.sort(by: Self.displayOrder)
        return agents.isEmpty ? nil : UsageSnapshot(agents: agents)
    }

    private static func displayOrder(_ a: AgentUsage, _ b: AgentUsage) -> Bool {
        let aClaude = a.agent == AgentKind.claudeCode
        let bClaude = b.agent == AgentKind.claudeCode
        if aClaude != bClaude { return aClaude }
        return a.agentName < b.agentName
    }

    static func readAgent(_ url: URL, now: Date) -> AgentUsage? {
        guard let data = BoundedRead.data(at: url, limit: 64 * 1024),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawWindows = obj["windows"] as? [[String: Any]]
        else { return nil }
        func number(_ v: Any?) -> Double? {
            // JSON booleans also bridge to NSNumber; reject them explicitly.
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
            let d = n.doubleValue
            return d.isFinite ? d : nil
        }
        let windows: [UsageWindow] = rawWindows.compactMap { w in
            guard let used = number(w["usedPercentage"]),
                  var resets = number(w["resetsAt"]), resets > 0 else { return nil }
            if resets > 1e11 { resets /= 1000 }   // milliseconds → seconds
            let resetsAt = Date(timeIntervalSince1970: resets)
            guard resetsAt > now else { return nil }
            let label = (w["label"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(20)) } ?? "Limit"
            return UsageWindow(label: label, usedPercentage: min(100, max(0, used)), resetsAt: resetsAt)
        }
        guard !windows.isEmpty else { return nil }
        let agent = (obj["agent"] as? String) ?? url.deletingPathExtension().lastPathComponent
        let updated = number(obj["updatedAt"]).map { Date(timeIntervalSince1970: $0 / 1000) } ?? now
        return AgentUsage(agent: agent, windows: windows, updatedAt: updated)
    }
}
