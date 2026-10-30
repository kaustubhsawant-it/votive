import Foundation
import IOKit.pwr_mgt

/// Keeps the Mac awake and the screen unlocked-by-idle while on, including on battery.
///
/// Holds two IOKit power assertions, the same ones `/usr/bin/caffeinate -di` takes: no idle
/// system sleep, and no idle display sleep (the display going to sleep is what triggers the
/// lock screen after the "require password" delay). The assertions belong to this process, so
/// macOS drops them if the app quits or crashes. That is why the state is never persisted: a
/// relaunch always starts off, and the halo can never claim more than what is actually held.
///
/// What it cannot do: stop a manual lock (Ctrl-Cmd-Q), a lid close, or the forced sleep macOS
/// triggers at critically low battery.
final class Caffeinate {
    static let shared = Caffeinate()
    static let didChange = Notification.Name("VotiveCaffeinateDidChange")

    private let reason = "Votive: Caffeinate is on" as CFString
    private var systemID = IOPMAssertionID(0)
    private var displayID = IOPMAssertionID(0)

    private(set) var isOn = false

    private init() {}

    /// Turns it on or off. Returns whether the requested state was reached; when an assertion
    /// is refused, nothing stays held and `isOn` stays false.
    @discardableResult
    func set(_ on: Bool) -> Bool {
        if on == isOn { return true }
        if on {
            let a = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                                IOPMAssertionLevel(kIOPMAssertionLevelOn), reason, &systemID)
            let b = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                IOPMAssertionLevel(kIOPMAssertionLevelOn), reason, &displayID)
            guard a == kIOReturnSuccess, b == kIOReturnSuccess else {
                release()
                return false
            }
            isOn = true
        } else {
            release()
            isOn = false
        }
        NotificationCenter.default.post(name: Self.didChange, object: self)
        return true
    }

    @discardableResult
    func toggle() -> Bool { set(!isOn) }

    private func release() {
        if systemID != 0 { IOPMAssertionRelease(systemID); systemID = 0 }
        if displayID != 0 { IOPMAssertionRelease(displayID); displayID = 0 }
    }
}
