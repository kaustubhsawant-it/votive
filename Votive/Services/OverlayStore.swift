import Foundation

/// Reads `~/.votive/events/*.json` (written by the event hook for every agent) into a
/// `agent:session` → entry map.
/// Tolerant of a missing directory (3-color graceful-degradation mode) and half-written files.
struct OverlayStore {
    private let decoder = JSONDecoder()

    func scan() -> [String: OverlayEntry] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: Paths.events, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        else { return [:] }

        var map: [String: OverlayEntry] = [:]
        for url in urls where url.pathExtension == "json" {
            if let entry = decode(url) { map[entry.key] = entry }
        }
        return map
    }

    private func decode(_ url: URL) -> OverlayEntry? {
        for attempt in 0..<2 {
            do {
                guard let data = BoundedRead.data(at: url) else { throw CocoaError(.fileReadUnknown) }
                let entry = try decoder.decode(OverlayEntry.self, from: data)
                // Timestamps feed Int64 arithmetic; a hand-edited file with an absurd value must
                // be ignored rather than overflow (a trap) later.
                return Self.plausible(entry) ? entry : nil
            } catch {
                // Retry once only if the file was JUST written (a half-written file); an old
                // unreadable file would otherwise cost a sleep on every scan forever.
                if attempt == 0, Self.modifiedWithin(url, seconds: 2) { usleep(15_000); continue }
                return nil
            }
        }
        return nil
    }

    /// Epoch-ms between 1970 and 2100 (notify time too, when present).
    private static func plausible(_ e: OverlayEntry) -> Bool {
        let range: ClosedRange<Int64> = 0...4_102_444_800_000
        return range.contains(e.lastEventAt) && (e.notifyAt.map { range.contains($0) } ?? true)
    }

    private static func modifiedWithin(_ url: URL, seconds: TimeInterval) -> Bool {
        guard let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate else { return false }
        return Date().timeIntervalSince(date) < seconds
    }

    /// Deletes our own state files for sessions that are gone: last event older than
    /// `olderThanMs` AND no live process that could still be theirs. The hook normally deletes
    /// on SessionEnd, but a crash or kill skips that, and the files would pile up forever.
    func prune(olderThanMs: Int64, now: Int64, isStillOwned: (OverlayEntry) -> Bool) {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: Paths.events, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        else { return }
        for url in urls where url.pathExtension == "json" {
            guard let entry = decode(url) else {
                // Unreadable and not freshly written: nothing will ever read it.
                if !Self.modifiedWithin(url, seconds: 3600) { try? FileManager.default.removeItem(at: url) }
                continue
            }
            let last = max(entry.lastEventAt, entry.notifyAt ?? 0)
            if now - last > olderThanMs, !isStillOwned(entry) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }
}
