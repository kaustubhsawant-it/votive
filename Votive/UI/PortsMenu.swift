import AppKit

/// The optional "Ports" item (Settings → Developer tools → Ports, off by default): the ports you watch,
/// every port that has a program listening on it, what is using each, and for your own programs a
/// Pause switch (freeze it, keep its port) and Stop (ask it to quit). It acts only on a program you click,
/// never an agent session, Votive itself, another user's program or a macOS one (see `PortScan.refusal`).
final class PortsMenu: NSObject {
    private let agentPIDs: () -> Set<Int32>
    private let watchList: PortWatchList
    private let pausedStore: PausedStore
    /// Programs the user already agreed to pause in this run: after that, Pause is one click.
    private var confirmedPause = Set<Int32>()
    private let home = Paths.home.path

    init(watchList: PortWatchList = PortWatchList.shared, pausedStore: PausedStore = PausedStore.shared,
         agentPIDs: @escaping () -> Set<Int32>) {
        self.watchList = watchList
        self.pausedStore = pausedStore
        self.agentPIDs = agentPIDs
    }

    /// Common dev-server ports offered as a one-click start.
    private static let starterPorts = [3000, 5173, 8000, 8080]
    private static let maxMineRows = 25
    private static let maxOtherRows = 30

    // MARK: - Menu

    func menuItem() -> NSMenuItem {
        let root = NSMenuItem(title: "Ports", action: nil, keyEquivalent: "")
        root.image = NSImage(systemSymbolName: "network", accessibilityDescription: nil)
        let sub = NSMenu()

        let watched = watchList.load()
        let listeners = PortTools.scan()
        let rows = listeners.map { PortTools.inspect($0) } ?? []
        let byPort = Dictionary(grouping: rows, by: { $0.listener.port })

        let paused = rows.filter { $0.paused && $0.mine }
        if !paused.isEmpty {
            let title = paused.count == 1 ? "Resume the paused program" : "Resume \(paused.count) paused programs"
            let item = NSMenuItem(title: title, action: #selector(resumeAllPaused(_:)), keyEquivalent: "")
            item.target = self
            item.image = tinted("play.circle.fill", .systemGreen)
            item.representedObject = paused.map { ListenerRef($0.listener) }
            sub.addItem(item)
            sub.addItem(.separator())
        }

        sub.addItem(.sectionHeader(title: "Watched ports"))
        if watched.isEmpty {
            sub.addItem(disabled("No ports yet"))
            let starter = NSMenuItem(title: "Watch " + Self.starterPorts.map(String.init).joined(separator: ", "),
                                     action: #selector(addStarterPorts), keyEquivalent: "")
            starter.target = self
            sub.addItem(starter)
        } else if listeners != nil {
            for port in watched {
                sub.addItem(watchedRow(port: port, rows: byPort[port] ?? []))
            }
        } else {
            sub.addItem(disabled("Couldn't read the listening ports"))
            for port in watched { sub.addItem(disabled("\(port)")) }
        }

        sub.addItem(.separator())
        sub.addItem(allPortsItem(rows: rows, scanned: listeners != nil, watched: Set(watched)))

        sub.addItem(.separator())
        let add = NSMenuItem(title: "Add port…", action: #selector(addPort), keyEquivalent: "")
        add.target = self
        sub.addItem(add)
        let edit = NSMenuItem(title: "Edit ports file…", action: #selector(editFile), keyEquivalent: "")
        edit.target = self
        sub.addItem(edit)
        sub.addItem(.separator())
        sub.addItem(disabled("Stopping or pausing a program asks first"))

        root.submenu = sub
        return root
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func tinted(_ symbol: String, _ color: NSColor) -> NSImage? {
        NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [color]))
    }

    private func dot(for rows: [PortRow]) -> NSImage? {
        if rows.contains(where: { $0.paused }) { return tinted("pause.circle.fill", .systemYellow) }
        if !rows.isEmpty { return tinted("circle.fill", .systemOrange) }
        return tinted("circle", .tertiaryLabelColor)
    }

    /// A watched port: free, or in use (and by what), with the actions for each program on it.
    private func watchedRow(port: Int, rows: [PortRow]) -> NSMenuItem {
        let item = NSMenuItem(title: PortScan.rowTitle(port: port, listeners: rows.map { $0.listener }, paused: rows.contains { $0.paused }),
                              action: nil, keyEquivalent: "")
        item.image = dot(for: rows)
        item.submenu = actions(port: port, rows: rows, watched: true)
        return item
    }

    /// Everything that has a program listening: your own programs with actions, then a read-only list of the rest.
    private func allPortsItem(rows: [PortRow], scanned: Bool, watched: Set<Int>) -> NSMenuItem {
        let mine = rows.filter { $0.mine }
        let others = rows.filter { !$0.mine }
        let root = NSMenuItem(title: scanned ? "All listening ports (\(rows.count))" : "All listening ports", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        guard scanned else {
            sub.addItem(disabled("Couldn't read the listening ports"))
            root.submenu = sub
            return root
        }
        sub.addItem(.sectionHeader(title: "Yours (\(mine.count))"))
        if mine.isEmpty { sub.addItem(disabled("Nothing of yours is listening")) }
        for row in mine.prefix(Self.maxMineRows) {
            let item = NSMenuItem(title: PortScan.allPortsTitle(row), action: nil, keyEquivalent: "")
            item.image = dot(for: [row])
            item.submenu = actions(port: row.listener.port, rows: [row], watched: watched.contains(row.listener.port))
            sub.addItem(item)
        }
        if mine.count > Self.maxMineRows { sub.addItem(disabled("…and \(mine.count - Self.maxMineRows) more")) }
        if !others.isEmpty {
            sub.addItem(.separator())
            let group = NSMenuItem(title: "macOS and other users (\(others.count))", action: nil, keyEquivalent: "")
            let list = NSMenu()
            for row in others.prefix(Self.maxOtherRows) {
                let item = disabled(PortScan.allPortsTitle(row))
                item.toolTip = PortScan.details(for: row, home: home).joined(separator: "\n")
                list.addItem(item)
            }
            if others.count > Self.maxOtherRows { list.addItem(disabled("…and \(others.count - Self.maxOtherRows) more")) }
            group.submenu = list
            sub.addItem(group)
        }
        root.submenu = sub
        return root
    }

    /// The submenu of one port: what is using it, the Pause switch and Stop for each program, and watch / unwatch.
    private func actions(port: Int, rows: [PortRow], watched: Bool) -> NSMenu {
        let sub = NSMenu()
        if rows.isEmpty, let note = PortScan.knownPortNote(port) {
            sub.addItem(disabled("Free. Port \(port) is usually: " + note))
        }
        for (i, row) in rows.enumerated() {
            let l = row.listener
            if rows.count > 1 { sub.addItem(.sectionHeader(title: "\(l.command) (pid \(l.pid))")) }
            for line in PortScan.details(for: row, home: home) { sub.addItem(disabled(line)) }
            sub.addItem(.separator())

            // The Pause switch: a check mark means it is paused right now.
            let pause = NSMenuItem(title: row.paused ? "Paused: click to resume" : "Pause",
                                   action: row.paused ? #selector(resumeProgram(_:)) : #selector(pauseProgram(_:)), keyEquivalent: "")
            pause.target = self
            pause.state = row.paused ? .on : .off
            pause.image = NSImage(systemSymbolName: row.paused ? "play.fill" : "pause.fill", accessibilityDescription: nil)
            pause.representedObject = ListenerRef(l)
            let why = row.paused ? PortTools.resumeRefusal(for: l) : PortTools.refusal(for: l, agentPIDs: agentPIDs())
            if let why { pause.isEnabled = false; pause.toolTip = why }
            else { pause.toolTip = row.paused ? "Let it carry on." : "Freeze it. It keeps port \(port), so anything that connects waits." }
            sub.addItem(pause)

            let stop = NSMenuItem(title: "Stop \(l.command) (pid \(l.pid))…", action: #selector(stopProgram(_:)), keyEquivalent: "")
            stop.target = self
            stop.representedObject = ListenerRef(l)
            if let why = PortTools.refusal(for: l, agentPIDs: agentPIDs()) { stop.isEnabled = false; stop.toolTip = why }
            sub.addItem(stop)
            if i < rows.count - 1 { sub.addItem(.separator()) }
        }
        if !sub.items.isEmpty { sub.addItem(.separator()) }
        let watch = NSMenuItem(title: watched ? "Stop watching \(port)" : "Watch port \(port)",
                               action: watched ? #selector(unwatch(_:)) : #selector(watch(_:)), keyEquivalent: "")
        watch.target = self
        watch.representedObject = NSNumber(value: port)
        sub.addItem(watch)
        return sub
    }

    // MARK: - Watch list

    @objc private func addStarterPorts() {
        for p in Self.starterPorts { watchList.add(p) }
    }

    @objc private func watch(_ sender: NSMenuItem) {
        if let n = sender.representedObject as? NSNumber { watchList.add(n.intValue) }
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

    // MARK: - Pause, resume, stop

    @objc private func pauseProgram(_ sender: NSMenuItem) {
        guard let l = (sender.representedObject as? ListenerRef)?.listener else { return }
        if !confirmedPause.contains(l.pid) {
            let alert = NSAlert()
            alert.messageText = "Pause \(l.command) on port \(l.port)?"
            alert.informativeText = "It freezes (process \(l.pid)) until you resume it from this menu. It keeps port \(l.port), so anything that connects to it will wait. Votive offers to resume it when you quit." + PortScan.databaseNote(l.port)
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Cancel")                 // the Return key does nothing
            alert.addButton(withTitle: "Pause")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        PortTools.pause(l, agentPIDs: agentPIDs()) { [weak self] outcome in
            guard let self else { return }
            if outcome == .paused {
                self.confirmedPause.insert(l.pid)
                self.pausedStore.add(pid: l.pid, port: l.port, command: l.command)
                DialogAlerter.shared.show(title: "Paused \(l.command)",
                    body: "Port \(l.port) is still taken. Open Ports and click it again to resume.")
            } else {
                self.report(outcome, for: l, verb: "pause")
            }
        }
    }

    @objc private func resumeProgram(_ sender: NSMenuItem) {
        guard let l = (sender.representedObject as? ListenerRef)?.listener else { return }
        PortTools.resume(l) { [weak self] outcome in
            guard let self else { return }
            if outcome == .resumed || outcome == .gone { self.pausedStore.remove(pid: l.pid) }
            if outcome == .resumed {
                DialogAlerter.shared.show(title: "Resumed \(l.command)", body: "Port \(l.port) is working again.")
            } else {
                self.report(outcome, for: l, verb: "resume")
            }
        }
    }

    @objc private func resumeAllPaused(_ sender: NSMenuItem) {
        guard let refs = sender.representedObject as? [ListenerRef] else { return }
        for ref in refs {
            PortTools.resume(ref.listener) { [weak self] outcome in
                if outcome == .resumed || outcome == .gone { self?.pausedStore.remove(pid: ref.listener.pid) }
                else { self?.report(outcome, for: ref.listener, verb: "resume") }
            }
        }
    }

    @objc private func stopProgram(_ sender: NSMenuItem) {
        guard let l = (sender.representedObject as? ListenerRef)?.listener else { return }
        let alert = NSAlert()
        alert.messageText = "Stop \(l.command) on port \(l.port)?"
        alert.informativeText = "It will be asked to quit (process \(l.pid)). Anything it hasn't saved may be lost." + PortScan.databaseNote(l.port)
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")                 // the Return key does nothing destructive
        alert.addButton(withTitle: "Stop it")
        alert.buttons[1].hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        PortTools.stop(l, agentPIDs: agentPIDs()) { [weak self] outcome in
            if outcome == .stopped || outcome == .gone { self?.pausedStore.remove(pid: l.pid) }
            self?.report(outcome, for: l, verb: "stop")
        }
    }

    private func report(_ outcome: PortTools.Outcome, for l: PortListener, verb: String) {
        switch outcome {
        case .stopped:
            DialogAlerter.shared.show(title: "Port \(l.port) is free", body: "\(l.command) (pid \(l.pid)) has quit.")
        case .gone:
            DialogAlerter.shared.show(title: "Port \(l.port) is already free", body: "Nothing is listening there any more.")
        case .refused(let why), .failed(let why):
            DialogAlerter.shared.show(title: "Couldn't \(verb) it", body: why)
        case .paused, .resumed:
            break
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
                    self?.report(result, for: l, verb: "stop")
                }
            }
        }
    }
}

private final class ListenerRef {
    let listener: PortListener
    init(_ l: PortListener) { listener = l }
}
