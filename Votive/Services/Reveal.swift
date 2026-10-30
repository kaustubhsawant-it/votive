import AppKit
import UniformTypeIdentifiers

/// Shows files and folders from an agent's payload to the user without ever running them.
/// The paths come from event files that an agent (or injected text steering it) wrote, so they
/// are untrusted: `NSWorkspace.open(_:)` on such a path would start an app bundle, run a
/// Unix executable or `.command` file in Terminal, or launch an installer. Revealing in Finder
/// never does, and documents are opened only in a fixed viewer, never in "whatever is default".
enum Reveal {
    enum Plan: Equatable {
        case openFolderWindow(URL)     // contents of a plain folder
        case revealInFinder(URL)       // select the item itself; used for anything that must not run
        case viewAsText(URL)
        case refuse(String)
    }

    static let viewableExtensions: Set<String> = ["jsonl", "json", "log", "txt", "md"]
    static let maxViewBytes: Int64 = 50 * 1024 * 1024

    /// Pure decision, no side effects, so it can be tested without a GUI.
    static func plan(forFolder raw: String) -> Plan {
        guard let url = resolved(raw) else { return .refuse("not an absolute, existing path") }
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isPackageKey]
        guard let v = try? url.resourceValues(forKeys: keys), v.isDirectory == true else { return .refuse("not a folder") }
        return v.isPackage == true ? .revealInFinder(url) : .openFolderWindow(url)   // an .app or .pkg is selected, never launched
    }

    static func plan(forTranscript raw: String) -> Plan {
        guard let url = resolved(raw) else { return .refuse("not an absolute, existing path") }
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isPackageKey, .contentTypeKey, .fileSizeKey]
        guard let v = try? url.resourceValues(forKeys: keys), v.isRegularFile == true, v.isPackage != true
        else { return .revealInFinder(url) }
        if let t = v.contentType, [UTType.application, .executable, .script, .shellScript, .diskImage, .package, .bundle]
            .contains(where: { t.conforms(to: $0) }) { return .revealInFinder(url) }
        guard viewableExtensions.contains(url.pathExtension.lowercased()),
              Int64(v.fileSize ?? Int.max) <= maxViewBytes else { return .revealInFinder(url) }
        return .viewAsText(url)
    }

    static func folder(_ raw: String) {
        perform(plan(forFolder: raw))
    }

    static func transcript(_ raw: String) {
        perform(plan(forTranscript: raw))
    }

    private static func perform(_ plan: Plan) {
        switch plan {
        case .openFolderWindow(let url):
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: url.path)
        case .revealInFinder(let url):
            NSWorkspace.shared.activateFileViewerSelecting([url])
        case .viewAsText(let url):
            guard let textEdit = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.TextEdit") else {
                NSWorkspace.shared.activateFileViewerSelecting([url]); return
            }
            NSWorkspace.shared.open([url], withApplicationAt: textEdit, configuration: NSWorkspace.OpenConfiguration())
        case .refuse:
            NSSound.beep()
        }
    }

    /// Absolute, NUL-free, symlinks resolved (so the check sees what would really be touched), and present.
    private static func resolved(_ raw: String) -> URL? {
        guard raw.hasPrefix("/"), !raw.contains("\0"), raw.utf8.count < 4096 else { return nil }
        let url = URL(fileURLWithPath: raw).resolvingSymlinksInPath().standardizedFileURL
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}
