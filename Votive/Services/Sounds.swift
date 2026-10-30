import AVFoundation

/// What a sound can be played for. The custom notify, plus each state an automatic alert
/// covers. Raw values are the suffix of the UserDefaults key (`soundNotify`, `soundDone`, …),
/// shared with Scripts/overlay-settings.js.
enum SoundEvent: String, CaseIterable {
    case notify = "Notify"
    case needsInput = "NeedsYou"
    case warning = "Error"
    case stuck = "Stuck"
    case stopped = "Stopped"
    case done = "Done"

    var key: String { "sound" + rawValue }

    /// Menu label.
    var title: String {
        switch self {
        case .notify:     return "When notified"
        case .needsInput: return "Needs you"
        case .warning:    return "Error"
        case .stuck:      return "Stuck"
        case .stopped:    return "Stopped"
        case .done:       return "Done"
        }
    }

    /// Only the notify chimes out of the box, matching the alerts: the rest is ambient
    /// unless you opt in.
    var defaultSound: String { self == .notify ? "Glass" : Sounds.none }

    init?(state: AgentState) {
        switch state {
        case .needsInput: self = .needsInput
        case .warning:    self = .warning
        case .stuck:      self = .stuck
        case .stopped:    self = .stopped
        case .done:       self = .done
        default:          return nil
        }
    }
}

/// Plays the sound chosen for an event. A sound is stored as a plain name:
/// - `none` — silent;
/// - a file in `~/.votive/sounds/` (has an extension: `done.mp3`), so your own sounds
///   live with the rest of Votive's state and survive moving things around;
/// - otherwise a macOS system sound (`Glass`, `Hero`, …).
///
/// macOS system sounds are mastered quiet (Glass peaks at about -14 dBFS) and `NSSound` can't
/// play above a file's own level, so every sound is loaded once, scaled to a -1 dBFS peak and
/// played through `AVAudioEngine`. The system output volume still applies. The engine only
/// runs while a sound plays, so the audio device isn't held open between alerts.
///
/// Main thread only.
final class Sounds {
    static let shared = Sounds()
    static let none = "none"

    static let systemNames = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
                              "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"]
    static let audioExtensions: Set<String> = ["mp3", "m4a", "aiff", "aif", "wav", "caf"]
    /// A custom file longer than this is cut off: it's an alert, not a song.
    private static let maxSeconds: Double = 10
    /// Target peak, linear. 0.89 ≈ -1 dBFS: as loud as it can go while leaving headroom.
    private static let targetPeak: Float = 0.89

    private let defaults = UserDefaults.standard
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var cache: [URL: AVAudioPCMBuffer] = [:]
    private var stopWork: DispatchWorkItem?

    private init() {
        engine.attach(player)
    }

    // MARK: - Settings

    /// Master switch for every sound. On by default.
    var enabled: Bool {
        get { defaults.object(forKey: "soundsOn") == nil ? true : defaults.bool(forKey: "soundsOn") }
        set { defaults.set(newValue, forKey: "soundsOn") }
    }

    func sound(for event: SoundEvent) -> String {
        defaults.string(forKey: event.key) ?? event.defaultSound
    }

    func setSound(_ name: String, for event: SoundEvent) {
        defaults.set(name, forKey: event.key)
    }

    /// Audio files in `~/.votive/sounds/`, sorted by name.
    static func customFiles() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Paths.sounds.path)) ?? []
        return names.filter { audioExtensions.contains(($0 as NSString).pathExtension.lowercased()) }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    /// Menu label for a stored sound name: a custom file shows without its extension.
    static func displayName(_ name: String) -> String {
        if name == none { return "None" }
        return isCustom(name) ? (name as NSString).deletingPathExtension : name
    }

    private static func isCustom(_ name: String) -> Bool { !(name as NSString).pathExtension.isEmpty }

    private static func url(for name: String) -> URL? {
        if name == none || name.isEmpty { return nil }
        if isCustom(name) {
            // A bare file name only: never read outside the sounds folder.
            guard !name.contains("/") else { return nil }
            return Paths.sounds.appendingPathComponent(name)
        }
        guard systemNames.contains(name) else { return nil }
        return URL(fileURLWithPath: "/System/Library/Sounds/\(name).aiff")
    }

    // MARK: - Playback

    /// Play the sound for `event`, if sounds are on and one is set.
    func play(_ event: SoundEvent) {
        guard enabled else { return }
        play(named: sound(for: event))
    }

    /// Play a sound by its stored name, ignoring the master switch (menu previews).
    func play(named name: String) {
        guard let url = Self.url(for: name), let buffer = buffer(for: url) else { return }
        stopWork?.cancel()
        // A new sound replaces one still playing. Stopping first also lets the player be
        // reconnected, since sounds can differ in sample rate and channel count.
        player.stop()
        engine.stop()
        engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
        do { try engine.start() } catch { return }
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        player.play()

        // Stop the engine once the sound has finished, releasing the audio device.
        let work = DispatchWorkItem { [weak self] in
            self?.player.stop()
            self?.engine.stop()
        }
        stopWork = work
        let seconds = Double(buffer.frameLength) / buffer.format.sampleRate + 0.3
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func buffer(for url: URL) -> AVAudioPCMBuffer? {
        if let cached = cache[url] { return cached }
        guard let buf = Self.loadNormalized(url) else { return nil }
        cache[url] = buf
        return buf
    }

    /// Forget loaded sounds, so a file replaced in the sounds folder is re-read.
    func clearCache() { cache.removeAll() }

    private static func loadNormalized(_ url: URL) -> AVAudioPCMBuffer? {
        guard let file = try? AVAudioFile(forReading: url) else { return nil }
        let format = file.processingFormat
        let frames = AVAudioFrameCount(min(Double(file.length), format.sampleRate * maxSeconds))
        guard frames > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              (try? file.read(into: buf, frameCount: frames)) != nil,
              let channels = buf.floatChannelData else { return nil }
        let count = Int(format.channelCount)
        let n = Int(buf.frameLength)
        var peak: Float = 0
        for c in 0..<count { for i in 0..<n { peak = max(peak, abs(channels[c][i])) } }
        guard peak > 0 else { return buf }
        let gain = targetPeak / peak
        for c in 0..<count { for i in 0..<n { channels[c][i] *= gain } }
        return buf
    }
}
