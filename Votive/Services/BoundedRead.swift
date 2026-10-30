import Foundation

/// Reads a small state file without trusting it: regular files only (a FIFO or device would
/// block or never end), no symlink in the last component, and never more than `limit` bytes.
/// Returns nil for anything else, so one bad file in `events/` can't stall or bloat the app.
enum BoundedRead {
    static let eventLimit = 256 * 1024

    static func data(at url: URL, limit: Int = eventLimit) -> Data? {
        let fd = open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= off_t(limit) else { return nil }
        var out = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n < 0 { return nil }
            if n == 0 { break }
            out.append(chunk, count: n)
            if out.count > limit { return nil }
        }
        return out
    }
}
