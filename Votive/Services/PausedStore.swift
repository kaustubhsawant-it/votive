import Foundation
import Darwin

/// A program Votive froze, remembered so it is never left frozen without anyone knowing.
struct PausedEntry: Codable, Equatable {
    let pid: Int32
    let port: Int
    let command: String
    /// When the process started (seconds since 1970). A pid that has been recycled by a different
    /// program has a different start time, so it is never mistaken for the one that was paused.
    let startedAt: Double
}

/// `~/.votive/paused.json`: the programs Votive paused. Entries are checked every time they are read
/// (still running, still frozen, same start time, still the user's own), so a stale or hand-edited file
/// can never make Votive signal anything else.
final class PausedStore {
    static let shared = PausedStore()

    let fileURL: URL
    private let isPaused: (Int32) -> Bool
    private let startEpoch: (Int32) -> Double?
    private let owner: (Int32) -> UInt32?

    init(fileURL: URL = Paths.paused,
         isPaused: @escaping (Int32) -> Bool = { PortTools.runState(ofPID: $0) == .paused },
         startEpoch: @escaping (Int32) -> Double? = { Liveness.processStartEpoch($0) },
         owner: @escaping (Int32) -> UInt32? = { PortTools.ownerUID(ofPID: $0) }) {
        self.fileURL = fileURL
        self.isPaused = isPaused
        self.startEpoch = startEpoch
        self.owner = owner
    }

    private func valid(_ e: PausedEntry) -> Bool {
        guard e.pid > 1, e.pid != getpid(), PortScan.validPorts.contains(e.port),
              owner(e.pid) == getuid(), isPaused(e.pid),
              let started = startEpoch(e.pid), abs(started - e.startedAt) < 2 else { return false }
        return true
    }

    /// The programs that are still frozen and still the ones Votive froze.
    func load() -> [PausedEntry] {
        guard let data = BoundedRead.data(at: fileURL, limit: 64 * 1024),
              let all = try? JSONDecoder().decode([PausedEntry].self, from: data) else { return [] }
        return Array(all.filter(valid).prefix(64))
    }

    func add(pid: Int32, port: Int, command: String) {
        guard let started = startEpoch(pid) else { return }
        var list = load().filter { $0.pid != pid }
        list.append(PausedEntry(pid: pid, port: port, command: PortScan.safeText(command), startedAt: started))
        save(list)
    }

    func remove(pid: Int32) { save(load().filter { $0.pid != pid }) }

    /// Writes the list that is still true, dropping entries that no longer are.
    func prune() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        save(load())
    }

    func save(_ entries: [PausedEntry]) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Continues every program Votive froze that is still frozen. Returns how many were resumed.
    /// Synchronous and quick: used when Votive quits.
    @discardableResult
    func resumeAll() -> Int {
        var resumed = 0
        for entry in load() where kill(entry.pid, SIGCONT) == 0 { resumed += 1 }
        save([])
        return resumed
    }
}
