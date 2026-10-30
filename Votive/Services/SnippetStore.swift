import Foundation

/// Stores reusable prompt snippets in an editable JSON file
/// (`~/.votive/snippets.json`, a plain array of strings). The menu lists them;
/// clicking one copies it to the clipboard so you can paste it into any agent's terminal.
final class SnippetStore {
    static let shared = SnippetStore()

    let fileURL: URL
    /// Tests pass a file in a scratch folder; the app always uses `~/.votive/snippets.json`.
    init(fileURL: URL = Paths.snippets) { self.fileURL = fileURL }

    enum AddResult: Equatable { case added, duplicate, empty, unreadable }

    /// The snippets, or nil when the file exists but is not a JSON array of strings (for example
    /// after a hand edit left a trailing comma). A missing file is simply an empty list.
    func loadStrict() -> [String]? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        guard let data = BoundedRead.data(at: fileURL, limit: 1024 * 1024),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [String] else { return nil }
        return arr.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    func load() -> [String] { loadStrict() ?? [] }

    func save(_ snippets: [String]) {
        guard let data = try? JSONSerialization.data(
            withJSONObject: snippets, options: [.prettyPrinted, .withoutEscapingSlashes]) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Adds one snippet. It never replaces a file it could not read, so a broken hand edit is
    /// reported (`.unreadable`) and left alone instead of being wiped by the next click.
    @discardableResult
    func add(_ text: String) -> AddResult {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }
        guard var arr = loadStrict() else { return .unreadable }
        guard !arr.contains(trimmed) else { return .duplicate }
        arr.append(trimmed)
        save(arr)
        return .added
    }

    /// Create the file (with a couple of examples) if it doesn't exist, so "Edit" always opens something.
    func ensureFile() {
        guard !FileManager.default.fileExists(atPath: fileURL.path) else { return }
        save(["Review the changes on this branch and list any bugs.",
              "Run the tests and fix anything that fails.",
              "Explain what this file does, briefly."])
    }
}
