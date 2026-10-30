import Foundation

/// The bundle id changed with the app's name (Agent Overlay → Votive), so macOS gives the app a new,
/// empty settings domain. Carry the old settings over once so sounds, toggles and thresholds survive.
enum LegacySettings {
    /// The settings domain of the app under its earlier name.
    static let oldDomain = "app.agentoverlay.AgentOverlay"
    /// Set in the new domain once the copy has run, so a later change is never overwritten.
    static let doneKey = "legacySettingsMigrated"
    /// Not carried over: a security choice is made again for the renamed app. Agents may change
    /// settings only after the user allows it in this app's menu (see AGEN-22).
    static let notCarried: Set<String> = ["agentWritesAllowed"]

    /// Copies each old value the new domain does not already have. Returns how many were copied.
    @discardableResult
    static func carryOver(_ old: [String: Any], into defaults: UserDefaults) -> Int {
        var copied = 0
        for (key, value) in old where !notCarried.contains(key) && defaults.object(forKey: key) == nil {
            defaults.set(value, forKey: key)
            copied += 1
        }
        return copied
    }

    /// Runs once, before anything reads a setting.
    static func migrate(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: doneKey) else { return }
        if let old = defaults.persistentDomain(forName: oldDomain) {
            carryOver(old, into: defaults)
        }
        defaults.set(true, forKey: doneKey)
    }
}
