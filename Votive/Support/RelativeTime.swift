import Foundation

/// Compact relative-time formatting for dropdown rows ("now", "12s", "3m", "2h", "1d").
enum RelativeTime {
    static func string(fromEpochMs ms: Int64, now: Date = Date()) -> String {
        guard ms > 0 else { return "—" }
        let seconds = Int(now.timeIntervalSince1970 - Double(ms) / 1000.0)
        if seconds < 5 { return "now" }
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}
