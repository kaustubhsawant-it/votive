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

/// Reads which programs listen on which ports, and stops one when you ask. Optional, off by
/// default. It runs one fixed program (`/usr/sbin/lsof` with fixed arguments, no shell) and
/// sends one signal to one process you confirmed. It opens no socket and needs no privileges:
/// macOS itself refuses to let you signal anyone else's process.
enum PortTools {
    static let lsof = URL(fileURLWithPath: "/usr/sbin/lsof")
    static let lsofArguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcun"]

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

    static func path(ofPID pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : nil
    }

    enum Outcome: Equatable {
        case stopped
        case stillRunning
        case gone                 // nothing was listening there any more
        case refused(String)
        case failed(String)
    }

    /// Why this listener cannot be stopped (nil when it can), checked against the system now.
    static func refusal(for l: PortListener, agentPIDs: Set<Int32>) -> String? {
        PortScan.refusal(for: l, path: path(ofPID: l.pid), ownUID: getuid(), ownPID: getpid(), agentPIDs: agentPIDs)
    }

    /// Asks the program to quit (SIGTERM), then waits up to `grace` seconds. Runs off the main thread;
    /// `completion` is called on the main thread. Checked again right before signalling, so a pid
    /// that was reused since the menu opened is never hit.
    static func stop(_ target: PortListener, force: Bool = false, agentPIDs: Set<Int32>, grace: TimeInterval = 2,
                     completion: @escaping (Outcome) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = stopNow(target, force: force, agentPIDs: agentPIDs, grace: grace)
            DispatchQueue.main.async { completion(result) }
        }
    }

    private static func stopNow(_ target: PortListener, force: Bool, agentPIDs: Set<Int32>, grace: TimeInterval) -> Outcome {
        guard let now = scan() else { return .failed("Couldn't read the listening ports.") }
        guard let live = now.first(where: { $0.port == target.port && $0.pid == target.pid }) else { return .gone }
        if let why = refusal(for: live, agentPIDs: agentPIDs) { return .refused(why) }
        let signal = force ? SIGKILL : SIGTERM
        if kill(live.pid, signal) != 0 {
            return errno == ESRCH ? .gone : .refused("macOS didn't allow it (error \(errno)).")
        }
        // Done when the program has exited or let go of the port. A program that has quit but whose
        // parent has not collected it yet still answers `kill(pid, 0)`, but it no longer holds the port.
        let deadline = Date().addingTimeInterval(force ? 1 : grace)
        repeat {
            if kill(live.pid, 0) != 0 { return .stopped }
            if let again = scan(), !again.contains(where: { $0.port == live.port && $0.pid == live.pid }) { return .stopped }
            Thread.sleep(forTimeInterval: 0.15)
        } while Date() < deadline
        return .stillRunning
    }
}
