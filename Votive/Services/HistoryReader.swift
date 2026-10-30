import Foundation

/// Tracks each session's most-recent prompt from `~/.claude/history.jsonl` (which Claude Code
/// appends to on every prompt, for every session). Used as the "recap" line in the dropdown.
///
/// Efficiency: history.jsonl is an append-only log, so we read the whole file exactly once and
/// thereafter consume only the newly-appended bytes when it grows (checked via a cheap `stat`).
/// Steady-state cost per prompt is O(bytes appended) — a few hundred bytes. Runs on the
/// coordinator's background queue.
final class HistoryReader {
    private var offset: UInt64 = 0                 // bytes consumed up to a line boundary
    private var cache: [String: String] = [:]      // sessionId → last prompt (≤200 chars)

    /// Last-prompt text for each requested sessionId (absent when the session has no prompt).
    func lastPrompts(for ids: Set<String>) -> [String: String] {
        guard !ids.isEmpty else { return [:] }
        let url = Paths.claude.appendingPathComponent("history.jsonl")   // Claude Code only

        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attrs[.size] as? NSNumber)?.uint64Value else { return current(ids) }

        if size < offset { offset = 0; cache.removeAll() }   // rotated/truncated → resync
        if size > offset { autoreleasepool { consume(url) } }

        return current(ids)
    }

    private func current(_ ids: Set<String>) -> [String: String] {
        cache.filter { ids.contains($0.key) }
    }

    /// Read from `offset` to EOF, parse complete lines forward (later lines override earlier,
    /// so the last prompt per session wins), and advance `offset` to the last line boundary.
    private func consume(_ url: URL) {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? fh.close() }
        do { try fh.seek(toOffset: offset) } catch { return }
        guard let data = try? fh.readToEnd(), !data.isEmpty else { return }

        // Only process up to the last complete line; a trailing partial line waits for next time.
        guard let lastNL = data.lastIndex(of: 0x0A) else { return }
        let complete = data[data.startIndex...lastNL]
        defer { offset += UInt64(complete.count) }

        guard let text = String(data: complete, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let sid = obj["sessionId"] as? String,
                  let display = obj["display"] as? String else { continue }
            let trimmed = display.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { cache[sid] = String(trimmed.prefix(200)) }
        }
    }
}
