import AppKit
import Darwin

/// Brings the terminal/IDE window hosting a given agent to the front.
///
/// Strategy: walk the process tree up from the agent's pid to the first ancestor that is a
/// regular GUI app (Terminal.app, iTerm2, VSCode, Ghostty, …), then:
///   1. raise it via LaunchServices (`NSWorkspace.openApplication`) — reliable on macOS 14+
///      and needs no permission (plain `NSRunningApplication.activate()` is often ignored for
///      a background menu-bar app due to Apple's cooperative-activation rules), and
///   2. for Terminal.app / iTerm2, select the exact tab by matching the session's tty via
///      AppleScript (one-time Automation permission). VSCode's integrated terminal can't be
///      tab-targeted from outside, so raising the window is the result there.
///
/// Everything is wrapped defensively — any failure is swallowed; it can never crash the app.
enum TerminalFocus {
    private static let debug = ProcessInfo.processInfo.environment["VOTIVE_DEBUG"] == "1"

    static func focus(sessionPID pid: Int32) {
        guard pid > 0 else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let chain = ancestry(from: pid, maxDepth: 30)
            let tty = ttyName(of: pid)
            DispatchQueue.main.async { raise(chain: chain, tty: tty) }
        }
    }

    /// The GUI app (Terminal/iTerm/VSCode/…) hosting a given agent pid, for showing its icon.
    static func hostingApp(forPID pid: Int32) -> NSRunningApplication? {
        guard pid > 0 else { return nil }
        return hostingApp(in: ancestry(from: pid, maxDepth: 30))
    }

    // MARK: - Raise (main thread)

    private static func raise(chain: [Int32], tty: String?) {
        guard let app = hostingApp(in: chain) else {
            // iTerm2 runs sessions under a server process re-parented to launchd, so the
            // ancestry can miss it. With a tty we can still find the tab by asking iTerm2.
            log("no hosting GUI app found in chain \(chain)")
            if let tty, !NSRunningApplication.runningApplications(
                withBundleIdentifier: "com.googlecode.iterm2").isEmpty {
                focusITermTab(tty: tty)
            }
            return
        }
        let bundle = app.bundleIdentifier ?? ""
        log("host=\(bundle) pid=\(app.processIdentifier) tty=\(tty ?? "nil")")

        // 1) Bring the app forward via LaunchServices (no permission; reliable on macOS 14+).
        if let url = app.bundleURL {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: cfg, completionHandler: nil)
        }
        app.activate()

        // 2) Best-effort exact-tab focus (needs one-time Automation permission).
        guard let tty = tty else { return }
        if bundle == "com.apple.Terminal" { focusTerminalTab(tty: tty) }
        else if bundle == "com.googlecode.iterm2" { focusITermTab(tty: tty) }
    }

    private static func hostingApp(in chain: [Int32]) -> NSRunningApplication? {
        for pid in chain {
            if let app = NSRunningApplication(processIdentifier: pid),
               app.activationPolicy == .regular, app.bundleIdentifier != nil {
                return app
            }
        }
        return nil
    }

    // MARK: - Process tree

    private static func ancestry(from pid: Int32, maxDepth: Int) -> [Int32] {
        var chain: [Int32] = []
        var current = pid
        var depth = 0
        while current > 1, depth < maxDepth {
            chain.append(current)
            guard let parent = parentPID(current), parent != current else { break }
            current = parent
            depth += 1
        }
        return chain
    }

    private static func parentPID(_ pid: Int32) -> Int32? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        let rc = mib.withUnsafeMutableBufferPointer { buf in
            sysctl(buf.baseAddress, u_int(buf.count), &info, &size, nil, 0)
        }
        if rc != 0 || size == 0 { return nil }
        return info.kp_eproc.e_ppid
    }

    private static func ttyName(of pid: Int32) -> String? {
        guard let out = run("/bin/ps", ["-o", "tty=", "-p", "\(pid)"]) else { return nil }
        var t = out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t != "??", t != "?", t != "-" else { return nil }
        if !t.hasPrefix("/dev/") { t = "/dev/" + t }
        return t
    }

    // MARK: - AppleScript tab targeting (best-effort; ignores denial)

    private static func focusTerminalTab(tty: String) {
        runAppleScript("""
        tell application "Terminal"
          repeat with w in windows
            repeat with t in tabs of w
              try
                if tty of t is "\(tty)" then
                  set selected of t to true
                  set frontmost of w to true
                  activate
                  return
                end if
              end try
            end repeat
          end repeat
        end tell
        """)
    }

    private static func focusITermTab(tty: String) {
        runAppleScript("""
        tell application "iTerm"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                try
                  if tty of s is "\(tty)" then
                    select w
                    select t
                    select s
                    activate
                    return
                  end if
                end try
              end repeat
            end repeat
          end repeat
        end tell
        """)
    }

    /// Runs through `osascript` on a background queue: the first-use Automation prompt or a
    /// hung terminal app can block for up to the AppleEvent timeout, and that must never
    /// freeze the menu bar. The tty is from `ps` (`/dev/ttysNNN`), never user-controlled text.
    private static let scriptQueue = DispatchQueue(label: "dev.votive.Votive.applescript")
    private static func runAppleScript(_ source: String) {
        scriptQueue.async {
            let out = run("/usr/bin/osascript", ["-e", source])
            if debug { log("osascript done: \(out ?? "failed to launch")") }
        }
    }

    // MARK: - Subprocess helper

    private static func run(_ launchPath: String, _ args: [String]) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    private static func log(_ msg: String) {
        guard debug else { return }
        FileHandle.standardError.write(Data("[TerminalFocus] \(msg)\n".utf8))
    }
}
