import AppKit

extension Sounds {
    /// Asks for an audio file, copies it into ~/.votive/sounds/ (so moving or deleting the original can't silence it)
    /// and uses it for `event`. Shared by the menu and the settings window.
    func chooseFile(for event: SoundEvent) {
        let panel = NSOpenPanel()
        panel.title = "Choose a sound for “\(event.title)”"
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)   // an accessory app's panel opens behind otherwise
        guard panel.runModal() == .OK, let src = panel.url else { return }
        let fm = FileManager.default
        let dest = Paths.sounds.appendingPathComponent(src.lastPathComponent)
        do {
            try fm.createDirectory(at: Paths.sounds, withIntermediateDirectories: true)
            if src.standardizedFileURL != dest.standardizedFileURL {
                if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
                try fm.copyItem(at: src, to: dest)
            }
        } catch {
            DialogAlerter.shared.show(title: "Couldn't add the sound", body: error.localizedDescription)
            return
        }
        clearCache()
        setSound(dest.lastPathComponent, for: event)
        play(named: dest.lastPathComponent)
    }

    /// Opens ~/.votive/sounds/ in Finder.
    func openFolder() {
        try? FileManager.default.createDirectory(at: Paths.sounds, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.sounds)
    }
}
