import Foundation

/// Reads Claude Code's `~/.claude/sessions/*.json` — a handful of tiny files. Tolerant of half-written
/// files (a file caught mid-write): decode failures get one brief retry, then are skipped.
/// A file that is not a small regular file, or whose numbers are absurd, is ignored rather than trusted:
/// the timestamps feed Int64 arithmetic that would trap on overflow.
struct SessionRegistry {
    private let decoder = JSONDecoder()
    private let directory: URL
    private static let sizeLimit = 64 * 1024
    private static let epochMs: ClosedRange<Int64> = 0...4_102_444_800_000   // 1970 to 2100

    init(directory: URL = Paths.claudeSessions) { self.directory = directory }

    func scan() -> [RegistryEntry] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        else { return [] }
        return urls
            .filter { $0.pathExtension == "json" }
            .compactMap { decode($0) }
    }

    static func plausible(_ e: RegistryEntry) -> Bool {
        guard e.pid > 0 else { return false }
        return [e.updatedAt, e.statusUpdatedAt, e.startedAt].allSatisfy { $0.map { epochMs.contains($0) } ?? true }
    }

    private func decode(_ url: URL) -> RegistryEntry? {
        for attempt in 0..<2 {
            if let data = BoundedRead.data(at: url, limit: Self.sizeLimit),
               let entry = try? decoder.decode(RegistryEntry.self, from: data) {
                return Self.plausible(entry) ? entry : nil
            }
            if attempt == 0 { usleep(15_000) }   // 15ms retry for a mid-write file
        }
        return nil
    }
}
