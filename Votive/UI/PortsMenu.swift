import AppKit

/// The optional "Ports" item (Settings → Developer tools → Ports, off by default): a short list of
/// ports you watch, whether each is free or in use and by what, and a button to stop the program
/// that holds one. It stops only a program you click, after a confirmation naming it, and never an
/// agent session, Votive itself, another user's program or a macOS one (see `PortScan.refusal`).
final class PortsMenu: NSObject {
    private let agentPIDs: () -> Set<Int32>
    private let watchList: PortWatchList

    init(watchList: PortWatchList = PortWatchList.shared, agentPIDs: @escaping () -> Set<Int32>) {
        self.watchList = watchList
        self.agentPIDs = agentPIDs
    }

    /// Common dev-server ports offered as a one-click start.
    private static let starterPorts = [3000, 5173, 8000, 8080]

    // MARK: - Menu

    func menuItem() -> NSMenuItem {
        let root = NSMenuItem(title: "Ports", action: nil, keyEquivalent: "")
        root.image = NSImage(systemSymbolName: "network", accessibilityDescription: nil)
        let sub = NSMenu()

        let watched = watchList.load()
        let listeners = PortTools.scan()

        sub.addItem(.sectionHeader(title: "Watched ports"))
        if watched.isEmpty {
            let hint = NSMenuItem(title: "No ports yet", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            sub.addItem(hint)
            let starter = NSMenuItem(title: "Watch " + Self.starterPorts.map(String.init).joined(separator: ", "),
                                     action: #selector(addStarterPorts), keyEquivalent: "")
            starter.target = self
            sub.addItem(starter)
        } else if let listeners {
            for port in watched {
                sub.addItem(row(port: port, listeners: listeners.filter { $0.port == port }))
            }
        } else {
            let failed = NSMenuItem(title: "Couldn't read the listening ports", action: nil, keyEquivalent: "")
            failed.isEnabled = false
            sub.addItem(failed)
            for port in watched {
                let item = NSMenuItem(title: "\(port)", action: nil, keyEquivalent: "")
                item.isEnabled = false
                sub.addItem(item)
            }
        }

        sub.addItem(.separator())
        let add = NSMenuItem(title: "Add port…", action: #selector(addPort), keyEquivalent: "")
        add.target = self
        sub.addItem(add)
        let edit = NSMenuItem(title: "Edit ports file…", action: #selector(editFile), keyEquivalent: "")
        edit.target = self
        sub.addItem(edit)
        sub.addItem(.separator())
        let note = NSMenuItem(title: "Stopping a program asks first", action: nil, keyEquivalent: "")
        note.isEnabled = false
        sub.addItem(note)

        root.submenu = sub
        return root
    }

    private func row(port: Int, listeners: [PortListener]) -> NSMenuItem {
        let busy = !listeners.isEmpty
        let item = NSMenuItem(title: PortScan.rowTitle(port: port, listeners: listeners), action: nil, keyEquivalent: "")
        let config = NSImage.SymbolConfiguration(paletteColors: [busy ? .systemOrange : .tertiaryLabelColor])
        item.image = NSImage(systemSymbolName: busy ? "circle.fill" : "circle", accessibilityDescription: busy ? "in use" : "free")?
            .withSymbolConfiguration(config)
        let sub = NSMenu()
        for l in listeners {
            let stop = NSMenuItem(title: "Stop \(l.command) (pid \(l.pid))…", action: #selector(stopListener(_:)), keyEquivalent: "")
            stop.target = self
            stop.representedObject = ListenerRef(l)
            if let why = PortTools.refusal(for: l, agentPIDs: agentPIDs()) {
                stop.isEnabled = false
                stop.toolTip = why
            }
            sub.addItem(stop)
        }
        if busy { sub.addItem(.separator()) }
        let unwatch = NSMenuItem(title: "Stop watching \(port)", action: #selector(unwatch(_:)), keyEquivalent: "")
        unwatch.target = self
        unwatch.representedObject = NSNumber(value: port)
        sub.addItem(unwatch)
        item.submenu = sub
        return item
    }

    // MARK: - Actions

    @objc private func addStarterPorts() {
        for p in Self.starterPorts { watchList.add(p) }
    }

    @objc private func unwatch(_ sender: NSMenuItem) {
        if let n = sender.representedObject as? NSNumber { watchList.remove(n.intValue) }
    }

    @objc private func editFile() {
        if !FileManager.default.fileExists(atPath: watchList.fileURL.path) { watchList.save([]) }
        NSWorkspace.shared.open(watchList.fileURL)
    }

    @objc private func addPort() {
        var note = "A number from 1 to 65535, for example 3000."
        while true {
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
            field.placeholderString = "3000"
            let alert = NSAlert()
            alert.messageText = "Watch a port"
            alert.informativeText = note
            alert.accessoryView = field
            alert.addButton(withTitle: "Add")
            alert.addButton(withTitle: "Cancel")
            alert.window.initialFirstResponder = field
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            if let port = PortScan.parseInput(field.stringValue) {
                if !watchList.add(port) {
                    note = watchList.load().contains(port) ? "\(port) is already on the list."
                                                                      : "The list is full (\(PortScan.maxWatched) ports)."
                    continue
                }
                return
            }
            note = "That isn't a port. Use a number from 1 to 65535."
        }
    }

    @objc private func stopListener(_ sender: NSMenuItem) {
        guard let ref = sender.representedObject as? ListenerRef else { return }
        let l = ref.listener
        let alert = NSAlert()
        alert.messageText = "Stop \(l.command) on port \(l.port)?"
        alert.informativeText = "It will be asked to quit (process \(l.pid)). Anything it hasn't saved may be lost."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")                 // the Return key does nothing destructive
        alert.addButton(withTitle: "Stop it")
        alert.buttons[1].hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        PortTools.stop(l, agentPIDs: agentPIDs()) { [weak self] outcome in self?.report(outcome, for: l) }
    }

    private func report(_ outcome: PortTools.Outcome, for l: PortListener) {
        switch outcome {
        case .stopped:
            DialogAlerter.shared.show(title: "Port \(l.port) is free", body: "\(l.command) (pid \(l.pid)) has quit.")
        case .gone:
            DialogAlerter.shared.show(title: "Port \(l.port) is already free", body: "Nothing is listening there any more.")
        case .refused(let why):
            DialogAlerter.shared.show(title: "Couldn't stop it", body: why)
        case .failed(let why):
            DialogAlerter.shared.show(title: "Couldn't stop it", body: why)
        case .stillRunning:
            let alert = NSAlert()
            alert.messageText = "\(l.command) didn't quit"
            alert.informativeText = "It is still using port \(l.port). Force quit ends it at once, without letting it save anything."
            alert.alertStyle = .critical
            alert.addButton(withTitle: "Leave it")
            alert.addButton(withTitle: "Force quit")
            alert.buttons[1].hasDestructiveAction = true
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertSecondButtonReturn else { return }
            PortTools.stop(l, force: true, agentPIDs: agentPIDs()) { [weak self] result in
                if result == .stillRunning {
                    DialogAlerter.shared.show(title: "Couldn't stop it", body: "\(l.command) is still running.")
                } else {
                    self?.report(result, for: l)
                }
            }
        }
    }
}

private final class ListenerRef {
    let listener: PortListener
    init(_ l: PortListener) { listener = l }
}
