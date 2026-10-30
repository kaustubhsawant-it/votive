import Foundation

/// One program that is listening on one TCP port.
struct PortListener: Equatable {
    let port: Int
    let pid: Int32
    let command: String
    let uid: UInt32
}

/// The pure part of the optional Ports tool (developer tools, off by default): reading what
/// `lsof` printed, checking what a person typed, and deciding what must never be stopped.
/// It touches no file and starts no program, so a test can compile it alone.
enum PortScan {
    static let validPorts = 1...65535
    /// The watch list stays short on purpose: it is a menu, not an inventory.
    static let maxWatched = 24

    /// Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcun`. Field output is one tag letter per line:
    /// `p` starts a process, `c` its command, `u` its user id, `n` one listening address
    /// (`*:3000`, `127.0.0.1:5432`, `[::1]:5173`). Unknown lines are skipped; the same pid
    /// on the same port (IPv4 and IPv6) is reported once.
    static func parse(_ text: String) -> [PortListener] {
        var out: [PortListener] = []
        var pid: Int32?
        var command = ""
        var uid: UInt32 = 0
        var seen = Set<String>()
        for line in text.split(whereSeparator: \.isNewline) {
            guard let tag = line.first else { continue }
            let rest = String(line.dropFirst())
            switch tag {
            case "p":
                pid = Int32(rest)
                command = ""
                uid = 0
            case "c":
                command = safeText(unescape(rest))
            case "u":
                uid = UInt32(rest) ?? 0
            case "n":
                guard let pid, pid > 0, let port = port(inAddress: rest) else { continue }
                if seen.insert("\(pid):\(port)").inserted {
                    out.append(PortListener(port: port, pid: pid, command: command.isEmpty ? "unknown" : command, uid: uid))
                }
            default:
                continue
            }
        }
        return out.sorted { ($0.port, $0.pid) < ($1.port, $1.pid) }
    }

    /// lsof writes a space (and other odd bytes) in a name as `\xNN`; turn those back into characters.
    static func unescape(_ s: String) -> String {
        guard s.contains("\\x") else { return s }
        var bytes: [UInt8] = []
        let u = Array(s.utf8)
        var i = 0
        while i < u.count {
            if u[i] == 0x5C, i + 3 < u.count, u[i + 1] == 0x78,
               let b = UInt8(String(decoding: u[(i + 2)...(i + 3)], as: UTF8.self), radix: 16) {
                bytes.append(b)
                i += 4
            } else {
                bytes.append(u[i])
                i += 1
            }
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// The port at the end of an lsof address, or nil.
    static func port(inAddress address: String) -> Int? {
        guard let colon = address.lastIndex(of: ":") else { return nil }
        guard let p = Int(address[address.index(after: colon)...]), validPorts.contains(p) else { return nil }
        return p
    }

    /// What a person typed in "Add port…": digits, optionally with a leading colon. Nothing else
    /// is accepted, so a typo can't become anything but "not a port".
    static func parseInput(_ text: String) -> Int? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix(":") { t.removeFirst() }
        guard !t.isEmpty, t.count <= 5, t.allSatisfy({ $0 >= "0" && $0 <= "9" }),
              let p = Int(t), validPorts.contains(p) else { return nil }
        return p
    }

    /// The watch list as stored: whole numbers in range, no repeats, sorted, at most `maxWatched`.
    /// Anything else in the file is ignored rather than trusted.
    static func cleanList(_ raw: Any?) -> [Int] {
        guard let arr = raw as? [Any] else { return [] }
        var seen = Set<Int>()
        var out: [Int] = []
        for v in arr {
            guard let n = v as? Int, validPorts.contains(n), seen.insert(n).inserted else { continue }
            out.append(n)
        }
        return Array(out.sorted().prefix(maxWatched))
    }

    /// Programs that belong to macOS. Votive never offers to stop these, even if the same user
    /// owns them (for example ControlCenter holds port 7000 for AirPlay).
    static func isSystemPath(_ path: String?) -> Bool {
        guard let path else { return false }
        return ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/"].contains { path.hasPrefix($0) }
    }

    /// Why a listener must not be stopped from the menu, or nil when it may be offered.
    /// `ownUID` is the user running Votive; `ownPID` is Votive itself; `agentPIDs` are the
    /// sessions Votive is showing (an agent can listen on a local port for its editor link, and
    /// stopping that port would end the session).
    static func refusal(for l: PortListener, path: String?, ownUID: UInt32, ownPID: Int32,
                        agentPIDs: Set<Int32>) -> String? {
        if l.pid <= 1 { return "That is a core system process." }
        if l.pid == ownPID { return "That is Votive itself." }
        if l.uid != ownUID { return "Another user owns that program, so macOS would not allow it." }
        if agentPIDs.contains(l.pid) { return "That port belongs to a running agent session. Close the session from its terminal instead." }
        if isSystemPath(path) { return "That is part of macOS." }
        return nil
    }

    /// Text that came from another program (a command name) and is about to be shown: control
    /// and direction-changing characters removed, at most 40 characters.
    static func safeText(_ s: String) -> String {
        let bad: Set<UInt32> = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F, 0x061C]
        let kept = s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F && !bad.contains($0.value) && !($0.value >= 0x80 && $0.value < 0xA0) }
        return String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespaces).prefix(40).description
    }

    /// One line for a menu row: `3000 · node (pid 4123)` or `5173 · free`.
    static func rowTitle(port: Int, listeners: [PortListener]) -> String {
        guard let first = listeners.first else { return "\(port)  ·  free" }
        let extra = listeners.count > 1 ? " +\(listeners.count - 1)" : ""
        return "\(port)  ·  \(first.command) (pid \(first.pid))\(extra)"
    }
}
