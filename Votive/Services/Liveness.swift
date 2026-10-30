import Darwin
import Foundation

/// Process-liveness probes. A SIGKILL'd terminal leaves its registry file behind with
/// no filesystem event, so we confirm the pid is genuinely alive on each rescan.
enum Liveness {
    /// True if a process with `pid` currently exists.
    static func isAlive(_ pid: Int32) -> Bool {
        if pid <= 0 { return false }
        if kill(pid, 0) == 0 { return true }
        // EPERM: exists but owned by another user (defensive — our own procs won't hit this).
        // ESRCH: no such process => dead.
        return errno == EPERM
    }

    /// Real process start time (seconds since epoch) via sysctl, for the PID-reuse guard.
    /// Returns nil if it can't be determined.
    static func processStartEpoch(_ pid: Int32) -> TimeInterval? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        let rc = mib.withUnsafeMutableBufferPointer { buf in
            sysctl(buf.baseAddress, u_int(buf.count), &info, &size, nil, 0)
        }
        if rc != 0 || size == 0 { return nil }
        let tv = info.kp_proc.p_starttime
        return TimeInterval(tv.tv_sec) + TimeInterval(tv.tv_usec) / 1_000_000
    }
}
