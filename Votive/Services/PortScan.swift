import Foundation

/// One program that is listening on one TCP port.
struct PortListener: Equatable {
    let port: Int
    let pid: Int32
    let command: String
    let uid: UInt32
    /// True when every address this program listens on for this port is loopback (127.x or ::1), so only
    /// this Mac can reach it. False when any address is a wildcard or a network address.
    var localOnly: Bool = false
}

/// A listener plus what the system says about its process: the facts the Ports menu shows.
struct PortRow: Equatable {
    let listener: PortListener
    let path: String?        // the program's file (proc_pidpath)
    let folder: String?      // the folder it was started from
    let paused: Bool         // the process is stopped (SIGSTOP, or Ctrl-Z in a shell)
    let mine: Bool           // owned by this user and not a macOS program
}

/// The pure part of the optional Ports tool (developer tools, off by default): reading what
/// `lsof` printed, checking what a person typed, describing a listener, and deciding what must
/// never be stopped or paused. It touches no file and starts no program, so a test can compile it alone.
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
        var index: [String: Int] = [:]
        var pid: Int32?
        var command = ""
        var uid: UInt32 = 0
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
                let loopback = isLoopback(rest)
                let key = "\(pid):\(port)"
                if let i = index[key] {
                    out[i].localOnly = out[i].localOnly && loopback
                } else {
                    index[key] = out.count
                    out.append(PortListener(port: port, pid: pid, command: command.isEmpty ? "unknown" : command, uid: uid, localOnly: loopback))
                }
            default:
                continue
            }
        }
        return out.sorted { ($0.port, $0.pid) < ($1.port, $1.pid) }
    }

    /// Whether an lsof address (`127.0.0.1:3000`, `[::1]:3000`, `localhost:3000`) is loopback only.
    static func isLoopback(_ address: String) -> Bool {
        guard let colon = address.lastIndex(of: ":") else { return false }
        let host = String(address[..<colon])
        return host.hasPrefix("127.") || host == "[::1]" || host == "localhost"
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

    /// Programs that belong to macOS. Votive never offers to stop or pause these, even if the same user
    /// owns them (for example ControlCenter holds port 7000 for AirPlay).
    static func isSystemPath(_ path: String?) -> Bool {
        guard let path else { return false }
        return ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/"].contains { path.hasPrefix($0) }
    }

    /// Why a listener must not be stopped or paused from the menu, or nil when it may be offered.
    /// `ownUID` is the user running Votive; `ownPID` is Votive itself; `agentPIDs` are the
    /// sessions Votive is showing (an agent can listen on a local port for its editor link, and
    /// stopping or freezing that port would end or hang the session).
    static func refusal(for l: PortListener, path: String?, ownUID: UInt32, ownPID: Int32,
                        agentPIDs: Set<Int32>) -> String? {
        if l.pid <= 1 { return "That is a core system process." }
        if l.pid == ownPID { return "That is Votive itself." }
        if l.uid != ownUID { return "Another user owns that program, so macOS would not allow it." }
        if agentPIDs.contains(l.pid) { return "That port belongs to a running agent session. Close the session from its terminal instead." }
        if isSystemPath(path) { return "That is part of macOS." }
        return nil
    }

    /// Why a paused program cannot be resumed, or nil. Resuming is gentle, so it is allowed for any program
    /// of the user's, an agent session included (something else may have frozen it).
    static func resumeRefusal(for l: PortListener, ownUID: UInt32, ownPID: Int32) -> String? {
        if l.pid <= 1 { return "That is a core system process." }
        if l.pid == ownPID { return "That is Votive itself." }
        if l.uid != ownUID { return "Another user owns that program, so macOS would not allow it." }
        return nil
    }

    /// True for the user's own programs that are not part of macOS.
    static func isMine(_ l: PortListener, path: String?, ownUID: UInt32) -> Bool {
        l.uid == ownUID && !isSystemPath(path)
    }

    private static let hiddenScalars: Set<UInt32> = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F, 0x061C]

    /// Control and direction-changing characters removed: text from another program must not be able to
    /// reorder or hide what the menu shows.
    private static func clean(_ s: String) -> String {
        let kept = s.unicodeScalars.filter {
            $0.value >= 0x20 && $0.value != 0x7F && !hiddenScalars.contains($0.value) && !($0.value >= 0x80 && $0.value < 0xA0)
        }
        return String(String.UnicodeScalarView(kept))
    }

    /// Text that came from another program (a command name) and is about to be shown: cleaned,
    /// at most 40 characters.
    static func safeText(_ s: String) -> String {
        String(clean(s).trimmingCharacters(in: .whitespaces).prefix(40))
    }

    /// A path from the system, cleaned the same way, at most 160 characters; nil when nothing is left.
    static func safePath(_ s: String?) -> String? {
        guard let s else { return nil }
        let cleaned = String(clean(s).prefix(160))
        return cleaned.isEmpty ? nil : cleaned
    }

    /// `/Users/me/dev/app` → `~/dev/app`.
    static func tildePath(_ path: String, home: String) -> String {
        guard !home.isEmpty, home != "/", path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }

    /// Well-known ports a developer meets, as a hint ("usually ..."), never as a claim about the program.
    static let knownPorts: [Int: String] = [
        80: "HTTP web server", 443: "HTTPS web server",
        1313: "Hugo dev server", 3000: "dev server (Node, React, Rails)", 3306: "MySQL",
        4000: "dev server (Phoenix, Jekyll)", 4200: "Angular dev server", 4321: "Astro dev server",
        5000: "Flask dev server, or macOS AirPlay Receiver", 5173: "Vite dev server", 5432: "PostgreSQL",
        5500: "Live Server (VS Code)", 6379: "Redis", 7000: "macOS AirPlay Receiver",
        8000: "dev server (Django, python -m http.server)", 8080: "common web or proxy port",
        8081: "Metro (React Native) or a web port", 8888: "Jupyter", 9000: "common dev port (PHP-FPM, SonarQube)",
        9200: "Elasticsearch", 11434: "Ollama", 27017: "MongoDB",
    ]

    static func knownPortNote(_ port: Int) -> String? { knownPorts[port] }

    /// Ports that usually belong to a database, where freezing or stopping a program mid-work can lose changes.
    static func isDatabasePort(_ port: Int) -> Bool { [3306, 5432, 6379, 9200, 11211, 27017].contains(port) }

    /// Added to the confirmation of Stop and Pause on such a port.
    static let databaseWarning = "\n\nPort %d is usually a database. Stopping or freezing one in the middle of work can leave connections hanging or lose changes that are not saved yet."
    static func databaseNote(_ port: Int) -> String { isDatabasePort(port) ? String(format: databaseWarning, port) : "" }

    /// The detail lines under a row: what is using the port, from where, and who can reach it.
    static func details(for row: PortRow, home: String) -> [String] {
        var lines: [String] = []
        if let p = row.path { lines.append("Program: " + tildePath(p, home: home)) }
        if let f = row.folder { lines.append("Started in: " + tildePath(f, home: home)) }
        lines.append(row.listener.localOnly ? "Reachable from: this Mac only" : "Reachable from: other devices on your network too")
        if let note = knownPortNote(row.listener.port) { lines.append("Port \(row.listener.port) is usually: " + note) }
        if row.paused { lines.append("Status: paused (frozen, still holding the port)") }
        return lines
    }

    /// One line for a menu row: `3000 · node (pid 4123)`, `3000 · node (pid 4123) · paused` or `5173 · free`.
    static func rowTitle(port: Int, listeners: [PortListener], paused: Bool = false) -> String {
        guard let first = listeners.first else { return "\(port)  ·  free" }
        let extra = listeners.count > 1 ? " +\(listeners.count - 1)" : ""
        return "\(port)  ·  \(first.command) (pid \(first.pid))\(extra)" + (paused ? "  ·  paused" : "")
    }

    /// A row in the all-ports list: `3000  ·  node  ·  this Mac only`.
    static func allPortsTitle(_ row: PortRow) -> String {
        let l = row.listener
        return "\(l.port)  ·  \(l.command)  ·  " + (l.localOnly ? "this Mac only" : "all interfaces") + (row.paused ? "  ·  paused" : "")
    }
}
