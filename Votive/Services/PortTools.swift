import Foundation
import Darwin

/// The watch list: `~/.votive/ports.json`, a plain array of port numbers you can also edit by hand.
final class PortWatchList {
    static let shared = PortWatchList()

    let fileURL: URL
    /// Tests pass a file in a scratch folder; the app always uses `~/.votive/ports.json`.
    init(fileURL: URL = Paths.ports) { self.fileURL = fileURL }

    func load() -> [Int] {
        guard let data = BoundedRead.data(at: fileURL, limit: 4096),
              let raw = try? JSONSerialization.jsonObject(with: data) else { return [] }
        return PortScan.cleanList(raw)
    }

    @discardableResult
    func add(_ port: Int) -> Bool {
        var list = load()
        guard PortScan.validPorts.contains(port), !list.contains(port), list.count < PortScan.maxWatched else { return false }
        list.append(port)
        save(list)
        return true
    }

    func remove(_ port: Int) { save(load().filter { $0 != port }) }

    func save(_ ports: [Int]) {
        guard let data = try? JSONSerialization.data(withJSONObject: PortScan.cleanList(ports), options: [.prettyPrinted]) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? data.write(to: fileURL, options: .atomic)
    }
}

/// Reads which programs listen on which ports, and stops or pauses one when you ask. Optional, off by
/// default. It runs one fixed program (`/usr/sbin/lsof` with fixed arguments, no shell) and sends one
/// signal to one process you confirmed. It opens no socket and needs no privileges: macOS itself
/// refuses to let you signal anyone else's process.
enum PortTools {
    static let lsof = URL(fileURLWithPath: "/usr/sbin/lsof")
    static let lsofArguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcun"]

    enum RunState: Equatable { case running, paused }

    /// Everything listening on TCP right now, or nil when `lsof` could not be run in time.
    static func scan(timeout: TimeInterval = 1.5) -> [PortListener]? {
        let p = Process()
        p.executableURL = lsof
        p.arguments = lsofArguments
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        var data = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            return nil
        }
        p.waitUntilExit()
        guard p.terminationStatus == 0 || !data.isEmpty, data.count <= 2_000_000 else { return nil }
        return PortScan.parse(String(decoding: data, as: UTF8.self))
    }

    // MARK: - Facts about a process

    static func path(ofPID pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : nil
    }

    /// The folder the process was started from (its working directory), when macOS lets us read it.
    static func workingFolder(ofPID pid: Int32) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        let folder = withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
        return folder.isEmpty ? nil : folder
    }

    private static func kinfo(_ pid: Int32) -> kinfo_proc? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        let rc = mib.withUnsafeMutableBufferPointer { sysctl($0.baseAddress, u_int($0.count), &info, &size, nil, 0) }
        return rc == 0 && size > 0 ? info : nil
    }

    /// Whether the process is frozen (stopped by SIGSTOP, or by Ctrl-Z in a shell), or nil if it is gone.
    static func runState(ofPID pid: Int32) -> RunState? {
        guard let info = kinfo(pid) else { return nil }
        return Int32(info.kp_proc.p_stat) == SSTOP ? .paused : .running
    }

    /// The user id that owns the process, or nil if it is gone.
    static func ownerUID(ofPID pid: Int32) -> UInt32? {
        guard let info = kinfo(pid) else { return nil }
        return info.kp_eproc.e_ucred.cr_uid
    }

    /// The listeners with what the system says about each program, one lookup per distinct pid.
    static func inspect(_ listeners: [PortListener]) -> [PortRow] {
        var cache: [Int32: (path: String?, folder: String?, paused: Bool)] = [:]
        let me = getuid()
        return listeners.map { l in
            let facts = cache[l.pid] ?? {
                let f = (path: PortScan.safePath(path(ofPID: l.pid)),
                         folder: l.uid == me ? PortScan.safePath(workingFolder(ofPID: l.pid)) : nil,
                         paused: runState(ofPID: l.pid) == .paused)
                cache[l.pid] = f
                return f
            }()
            return PortRow(listener: l, path: facts.path, folder: facts.folder, paused: facts.paused,
                           mine: PortScan.isMine(l, path: facts.path, ownUID: me))
        }
    }

    // MARK: - Acting on a program

    enum Outcome: Equatable {
        case stopped
        case stillRunning
        case paused
        case resumed
        case gone                 // nothing was listening there any more
        case refused(String)
        case failed(String)
    }

    enum Action { case terminate, kill, pause, resume }

    /// Why this listener cannot be stopped or paused (nil when it can), checked against the system now.
    static func refusal(for l: PortListener, agentPIDs: Set<Int32>) -> String? {
        PortScan.refusal(for: l, path: path(ofPID: l.pid), ownUID: getuid(), ownPID: getpid(), agentPIDs: agentPIDs)
    }

    static func resumeRefusal(for l: PortListener) -> String? {
        PortScan.resumeRefusal(for: l, ownUID: getuid(), ownPID: getpid())
    }

    /// Asks the program to quit (SIGTERM), then waits up to `grace` seconds. Runs off the main thread;
    /// `completion` is called on the main thread. Checked again right before signalling, so a pid
    /// that was reused since the menu opened is never hit.
    static func stop(_ target: PortListener, force: Bool = false, agentPIDs: Set<Int32>, grace: TimeInterval = 2,
                     completion: @escaping (Outcome) -> Void) {
        run(target, force ? .kill : .terminate, agentPIDs: agentPIDs, grace: grace, completion: completion)
    }

    /// Freezes the program (SIGSTOP). It keeps its port; anything that connects waits until it is resumed.
    static func pause(_ target: PortListener, agentPIDs: Set<Int32>, completion: @escaping (Outcome) -> Void) {
        run(target, .pause, agentPIDs: agentPIDs, grace: 1.5, completion: completion)
    }

    /// Lets a frozen program carry on (SIGCONT).
    static func resume(_ target: PortListener, completion: @escaping (Outcome) -> Void) {
        run(target, .resume, agentPIDs: [], grace: 1.5, completion: completion)
    }

    private static func run(_ target: PortListener, _ action: Action, agentPIDs: Set<Int32>, grace: TimeInterval,
                            completion: @escaping (Outcome) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = perform(target, action, agentPIDs: agentPIDs, grace: grace)
            DispatchQueue.main.async { completion(result) }
        }
    }

    private static func perform(_ target: PortListener, _ action: Action, agentPIDs: Set<Int32>, grace: TimeInterval) -> Outcome {
        guard let now = scan() else { return .failed("Couldn't read the listening ports.") }
        guard let live = now.first(where: { $0.port == target.port && $0.pid == target.pid }) else { return .gone }
        let why = action == .resume ? resumeRefusal(for: live) : refusal(for: live, agentPIDs: agentPIDs)
        if let why { return .refused(why) }
        let state = runState(ofPID: live.pid)

        switch action {
        case .pause:
            if state == .paused { return .paused }
            if kill(live.pid, SIGSTOP) != 0 { return errno == ESRCH ? .gone : .refused("macOS didn't allow it (error \(errno)).") }
            return wait(grace) { runState(ofPID: live.pid) == .paused } ? .paused : .failed("It didn't pause.")
        case .resume:
            if state == .running { return .resumed }
            if kill(live.pid, SIGCONT) != 0 { return errno == ESRCH ? .gone : .refused("macOS didn't allow it (error \(errno)).") }
            return wait(grace) { runState(ofPID: live.pid) == .running } ? .resumed : .failed("It didn't resume.")
        case .terminate, .kill:
            // A frozen program cannot act on SIGTERM until it is continued.
            if state == .paused { _ = kill(live.pid, SIGCONT) }
            if kill(live.pid, action == .kill ? SIGKILL : SIGTERM) != 0 {
                return errno == ESRCH ? .gone : .refused("macOS didn't allow it (error \(errno)).")
            }
            // Done when the program has exited or let go of the port. A program that has quit but whose
            // parent has not collected it yet still answers `kill(pid, 0)`, but it no longer holds the port.
            let ended = wait(action == .kill ? 1 : grace) {
                if kill(live.pid, 0) != 0 { return true }
                if let again = scan(), !again.contains(where: { $0.port == live.port && $0.pid == live.pid }) { return true }
                return false
            }
            return ended ? .stopped : .stillRunning
        }
    }

    /// Polls `done` every 150 ms until it is true or `seconds` have passed.
    private static func wait(_ seconds: TimeInterval, _ done: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if done() { return true }
            Thread.sleep(forTimeInterval: 0.15)
        } while Date() < deadline
        return done()
    }
}
