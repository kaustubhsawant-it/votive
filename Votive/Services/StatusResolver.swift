import Foundation

/// Pure state-resolution: (registry entry + optional overlay + liveness) → AgentState.
/// Returns nil when the session should be hidden entirely (clean exit / aged-out crash).
///
/// Precedence (first match wins):
///   dead ............................ red   (aged out after `redGraceMs`)
///   overlay "waiting" newer than reg .. purple  (overrides busy AND idle)
///   overlay "error"   newer than reg .. orange
///   registry busy, no recent activity  brown  (aged past `stuckMs`; activity = the newer of
///                                               registry `updatedAt` and the hook's last event)
///   registry busy .................... yellow
///   overlay "starting" newer than reg  blue   (fresh, pre-work)
///   otherwise (idle) ................. green
struct StatusResolver {
    var redGraceMs: Int64 = 60_000
    /// 0 disables stuck detection entirely. Otherwise: busy + no `updatedAt` movement for this
    /// long → `.stuck`. Purely derived from data already fetched every scan — no extra I/O.
    var stuckMs: Int64 = 8 * 60_000
    /// Epoch-ms of the last wake from sleep (0 = none). A Mac that slept was not working, so quiet time
    /// is counted from the wake, never from before the lid closed.
    var activityFloor: Int64 = 0

    func resolve(reg: RegistryEntry,
                 overlay: OverlayEntry?,
                 isAlive: Bool,
                 now: Int64,
                 firstSeenDeadAt: Int64?) -> AgentState? {
        // (1) Death — process gone (SIGKILL orphan). Show red, then age out.
        if !isAlive {
            if let deadAt = firstSeenDeadAt, now - deadAt > redGraceMs { return nil }
            return .stopped
        }

        // Registry `updatedAt` only moves on busy<->idle flips. Within a turn, attention states
        // clear because the hook writes a newer "working" event (PostToolUse) over them.
        let updatedAt = reg.updatedAt ?? reg.startedAt ?? 0

        // (2) Attention overrides — only while the event is the most-recent thing that happened.
        if let ov = overlay, ov.lastEventAt > updatedAt {
            if ov.lastEvent == "waiting" { return .needsInput }
            if ov.lastEvent == "error"   { return .warning }
        }

        // (3) Active work — flagged stuck when neither the registry nor the hook has recorded
        // anything for `stuckMs`. Every successful tool call writes a hook event, so a long
        // turn that's still calling tools never counts as stuck.
        if (reg.status ?? "idle") == "busy" {
            let lastActivity = max(updatedAt, overlay?.lastEventAt ?? 0, activityFloor)
            if stuckMs > 0, now - lastActivity > stuckMs { return .stuck }
            return .working
        }

        // (4) Fresh session that hasn't produced any work yet.
        if let ov = overlay, ov.lastEventAt > updatedAt, ov.lastEvent == "starting" {
            return .starting
        }

        // (5) Idle / done — also the benign default in 3-color mode (no overlay file).
        return .done
    }

    /// State for a session known only from its event file (every agent other than a
    /// registry-backed Claude Code session). Same precedence, with the last event standing in
    /// for the registry: dead → red then hidden, attention states, stuck, then the event itself.
    func resolveEvent(_ ov: OverlayEntry,
                      isAlive: Bool,
                      now: Int64,
                      firstSeenDeadAt: Int64?) -> AgentState? {
        if !isAlive {
            if let deadAt = firstSeenDeadAt, now - deadAt > redGraceMs { return nil }
            return .stopped
        }
        switch ov.lastEvent {
        case "waiting":  return .needsInput
        case "error":    return .warning
        case "starting": return .starting
        case "done":     return .done
        case "working":
            if stuckMs > 0, now - max(ov.lastEventAt, activityFloor) > stuckMs { return .stuck }
            return .working
        default:         return nil
        }
    }
}
