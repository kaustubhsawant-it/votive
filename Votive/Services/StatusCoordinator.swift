import AppKit

/// Orchestrates the whole watch → scan → publish loop off the main thread.
///
/// - Two kqueue directory watchers (sessions + overlay) trigger a debounced rescan.
/// - An initial scan on launch renders already-running sessions immediately.
/// - A 4 s liveness timer runs ONLY while sessions exist (no polling at rest); it catches
///   silent SIGKILLs and reconciles any in-place status write the vnode source can't see.
/// - Snapshots are diffed; `onChange` fires on the MAIN thread only when they differ.
final class StatusCoordinator {
    /// Called on the main thread with a fresh snapshot whenever it changes.
    var onChange: (([AgentSession]) -> Void)?

    private let scanner = AgentScanner()
    private let workQueue = DispatchQueue(label: "dev.votive.Votive.scan", qos: .utility)
    private var sessionsWatcher: DirectoryWatcher?
    private var overlayWatcher: DirectoryWatcher?
    private var livenessTimer: DispatchSourceTimer?
    private var debounce: DispatchWorkItem?
    private var watcherRetryPending = false   // touched on workQueue only
    /// nil until the first scan is published, so even an empty first scan reaches the UI (it is what
    /// sets the "already running at launch" baseline). Touched on main only.
    private var lastSnapshot: [AgentSession]?

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { [weak self] _ in
            self?.workQueue.async {
                self?.scanner.noteWake(at: Int64(Date().timeIntervalSince1970 * 1000))
                self?.scanNow()
            }
        }
        workQueue.async { [weak self] in
            guard let self else { return }
            self.ensureOverlayDir()
            self.sessionsWatcher = DirectoryWatcher(url: Paths.claudeSessions, queue: self.workQueue) {
                [weak self] in self?.scheduleScan()
            }
            self.overlayWatcher = DirectoryWatcher(url: Paths.events, queue: self.workQueue) {
                [weak self] in self?.scheduleScan()
            }
            self.sessionsWatcher?.start()
            self.overlayWatcher?.start()
            self.scanNow()
        }
    }

    // MARK: - Scanning (all on workQueue)

    private func scheduleScan() {
        debounce?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.scanNow() }
        debounce = item
        workQueue.asyncAfter(deadline: .now() + 0.2, execute: item)   // coalesce bursts
    }

    private func scanNow() {
        rearmIfNeeded()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let sessions = autoreleasepool { scanner.scan(now: now) }
        updateLivenessTimer(hasSessions: !sessions.isEmpty)

        if sessionsWatcher?.isWatching != true { scheduleWatcherRetry() }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if sessions != self.lastSnapshot {
                self.lastSnapshot = sessions
                self.onChange?(sessions)
            }
        }
    }

    /// Claude Code's sessions dir doesn't exist for people who don't use Claude Code (or before
    /// its first run). Keep ONE pending retry that only tries to attach the watcher — a single
    /// `open()` every 10 s — and rescan only once the dir actually appears. (Scheduling a scan
    /// per scan here multiplied into ever more concurrent retry chains.)
    private func scheduleWatcherRetry() {
        guard !watcherRetryPending else { return }
        watcherRetryPending = true
        workQueue.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self else { return }
            self.watcherRetryPending = false
            self.sessionsWatcher?.start()
            if self.sessionsWatcher?.isWatching == true { self.scanNow() }
            else { self.scheduleWatcherRetry() }
        }
    }

    private func rearmIfNeeded() {
        if sessionsWatcher?.isWatching == false { sessionsWatcher?.start() }
        if overlayWatcher?.isWatching == false { ensureOverlayDir(); overlayWatcher?.start() }
    }

    private func ensureOverlayDir() {
        // Only our own dir — never touch any agent's directories. Never fail hard.
        try? FileManager.default.createDirectory(
            at: Paths.events, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    /// Liveness timer exists only while there are sessions → zero wakeups at rest.
    private func updateLivenessTimer(hasSessions: Bool) {
        if hasSessions, livenessTimer == nil {
            let t = DispatchSource.makeTimerSource(queue: workQueue)
            t.schedule(deadline: .now() + 4, repeating: 4, leeway: .seconds(1))
            t.setEventHandler { [weak self] in self?.scanNow() }
            livenessTimer = t
            t.resume()
        } else if !hasSessions, let t = livenessTimer {
            t.cancel()
            livenessTimer = nil
        }
    }
}
