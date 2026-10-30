import Foundation

/// Event-driven directory watcher built on a kqueue vnode source (`DispatchSource`
/// file-system-object source on a directory fd). Near-zero idle cost, no run loop, no
/// history buffer — fires within milliseconds when a file is added / removed / renamed
/// in the directory, which is exactly "session started / ended / overlay written".
///
/// A silent in-place rewrite of an existing file does NOT fire a directory vnode; that
/// gap is covered by the coordinator's periodic rescan (see StatusCoordinator).
final class DirectoryWatcher {
    private let url: URL
    private let queue: DispatchQueue
    private let onChange: () -> Void
    private var source: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1

    init(url: URL, queue: DispatchQueue, onChange: @escaping () -> Void) {
        self.url = url
        self.queue = queue
        self.onChange = onChange
    }

    /// (Re)arm the watcher. Safe to call repeatedly; opens a fresh fd each time.
    func start() {
        stop()
        let descriptor = open(url.path, O_EVTONLY)
        guard descriptor >= 0 else { return }   // dir missing — caller retries later
        fd = descriptor

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .extend],
            queue: queue)

        src.setEventHandler { [weak self] in
            guard let self, let s = self.source else { return }
            let flags = s.data
            if flags.contains(.delete) || flags.contains(.rename) {
                // The directory itself was replaced — re-open on a fresh fd.
                self.start()
            }
            self.onChange()
        }
        // Close THIS source's descriptor, captured by value: by the time a cancel handler
        // runs, `start()` may already have stored a newer fd in `self.fd`.
        src.setCancelHandler { close(descriptor) }
        source = src
        src.resume()
    }

    func stop() {
        source?.cancel()   // cancel handler closes the fd
        source = nil
        fd = -1
    }

    var isWatching: Bool { source != nil && fd >= 0 }

    deinit { stop() }
}
