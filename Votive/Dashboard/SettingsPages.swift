import SwiftUI

/// Every setting the menu has, in the window. They are the same preferences the menu and the MCP `settings` tool use, so
/// a change here shows in the menu bar at once (the menu-bar item watches them) and the other way round.

// MARK: - General

struct GeneralSettingsPage: View {
    @AppStorage("shapesMode") private var shapes = false
    @AppStorage("usageAlertOn") private var usagePulse = true
    @AppStorage("stuckThresholdMinutes") private var stuck = 8
    @AppStorage("cpuHeatWarn") private var cpuHeatWarn = false
    @AppStorage("cpuHeatAt") private var cpuHeatAt = CpuTemperature.defaultHotAt
    @AppStorage(DashboardModel.targetKey) private var target = DashboardModel.defaultTarget
    @AppStorage("insightsShow") private var showInsights = true
    @State private var folders: [(path: String, since: Double)] = []
    @State private var hasOrder = false
    @State private var awakeTick = 0

    private static let stuckChoices: [(label: String, minutes: Int)] = [("Off", 0), ("5 minutes", 5), ("8 minutes", 8), ("15 minutes", 15)]

    var body: some View {
        Form {
            Section {
                Toggle("Colorblind shapes", isOn: $shapes)
                Toggle("Show limits over \(Int(UsageSnapshot.alertThreshold))% in the menu bar", isOn: $usagePulse)
                Toggle("Warn when the CPU is hot", isOn: $cpuHeatWarn)
                if cpuHeatWarn {
                    Picker("Warn when the CPU is over", selection: $cpuHeatAt) {
                        if ![85, 90, 95, 100, 105].contains(cpuHeatAt) { Text("\(cpuHeatAt) °C").tag(cpuHeatAt) }
                        ForEach([85, 90, 95, 100, 105], id: \.self) { Text("\($0) °C").tag($0) }
                    }
                }
                Picker("Stuck threshold", selection: $stuck) {
                    if !Self.stuckChoices.contains(where: { $0.minutes == stuck }) { Text("\(stuck) minutes").tag(stuck) }
                    ForEach(Self.stuckChoices, id: \.minutes) { Text($0.label).tag($0.minutes) }
                }
            } header: { Text("Menu bar") } footer: {
                Text("Shapes give every state its own outline as well as its own color. A busy session with no activity for the stuck threshold shows as stuck. The CPU heat warning is off by default: when the hottest CPU die sensor passes the line, or macOS reports serious thermal pressure, the menu-bar icon flashes red and shows CPU and the degrees, like a plan limit. The sensor is read on this Mac only.")
            }

            Section {
                LabeledContent("Weekly target") {
                    HStack {
                        Slider(value: $target, in: 10...100, step: 5).frame(width: 180)
                        Text(Fmt.percent(target)).monospacedDigit().frame(width: 44, alignment: .trailing)
                    }
                }
            } header: { Text("Plan") } footer: {
                Text("The share of the weekly limit you aim to use. Forecast and Habits say whether you are on track for it. Nothing is limited or blocked.")
            }

            Section {
                Toggle("Show the insights card in the sidebar", isOn: $showInsights)
            } header: { Text("This window") } footer: {
                Text("A few ranked, plain-language things worth knowing: sessions that need you, limits close to full, the forecast. It rotates every few seconds, and not at all when Reduce Motion is on.")
            }

            Section {
                if folders.isEmpty {
                    Text("None. Mark a folder from a session's menu in the menu bar: every session started there is then high priority.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(folders, id: \.path) { f in
                    LabeledContent((f.path as NSString).abbreviatingWithTildeInPath) {
                        Button("Stop") { stopFolder(f.path) }.softButton().help("Sessions started here are no longer high priority")
                    }
                }
                LabeledContent("Dot order") {
                    Button("Reset") { PriorityStore().setPositions([]); Self.priorityChanged(); reload() }
                        .softButton().disabled(!hasOrder)
                        .help("Forget the order you set with Move earlier and Move later")
                }
            } header: { Text("High priority") } footer: {
                Text("Folders whose sessions are always high priority, and the order of the dots you set by hand. Resetting the order never changes priority.")
            }

            Section {
                Toggle("Caffeinate", isOn: Binding(
                    get: { Caffeinate.shared.isOn },
                    set: { on in
                        if !Caffeinate.shared.set(on) {
                            DialogAlerter.shared.show(title: "Couldn't turn on Caffeinate", body: "macOS refused the power assertion, so the Mac may still sleep.")
                        }
                    }))
                    .id(awakeTick)
                LabeledContent("Votive's files") {
                    Button("Open ~/.votive") { NSWorkspace.shared.open(Paths.root) }.softButton()
                }
            } header: { Text("This Mac") } footer: {
                Text("Caffeinate keeps the Mac from sleeping or locking from being idle, even on battery, until you turn it off or quit Votive.")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
        .onChange(of: target) { _, _ in DashboardModel.shared.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: Caffeinate.didChange)) { _ in awakeTick += 1 }
    }

    private func reload() {
        let store = PriorityStore()
        folders = store.folders.sorted { $0.value < $1.value }.map { (path: $0.key, since: $0.value) }
        hasOrder = !store.positions.isEmpty
    }

    private func stopFolder(_ path: String) {
        PriorityStore().toggleFolder(path)
        Self.priorityChanged()
        reload()
    }

    static func priorityChanged() { NotificationCenter.default.post(name: PriorityStore.didChange, object: nil) }
}

// MARK: - Alerts

struct AlertSettingsPage: View {
    @AppStorage("customNotifyOn") private var onRequest = true
    @AppStorage("notificationsOn") private var banners = false
    @AppStorage("dialogAlertsOn") private var popups = false
    @AppStorage(SessionPriority.onlyKey) private var onlyPriority = false

    var body: some View {
        Form {
            Section {
                Toggle("When a session asks to notify me", isOn: $onRequest)
            } header: { Text("On request") } footer: {
                Text("Only fires when you ask a session to let you know (the notify tool or /notify). Always meant to reach you.")
            }
            Section {
                Toggle("Banner on every state change", isOn: $banners)
                Toggle("Pop-up on every state change", isOn: $popups)
            } header: { Text("Automatic") } footer: {
                Text("Off by default, so the dots stay glanceable. A banner (Notification Center) or a floating pop-up whenever any session finishes, needs you, errors or stops.")
            }
            Section {
                Toggle("Only alert for high-priority sessions", isOn: $onlyPriority)
            } header: { Text("Priority") } footer: {
                Text("When on, banners, pop-ups and state-change sounds come only from sessions you marked high priority (hover a session in the menu). A message you asked a session to send always shows.")
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Sounds

struct SoundSettingsPage: View {
    @AppStorage("soundsOn") private var on = true
    @State private var choices: [String: String] = [:]
    @State private var custom: [String] = []

    var body: some View {
        Form {
            Section {
                Toggle("Play sounds", isOn: Binding(get: { on }, set: { value in
                    on = value
                    if value { Sounds.shared.play(.notify) }   // hear what you just turned on
                }))
            } footer: { Text("Master switch for every sound below. Each one plays even when the banner and pop-up are off.") }

            Section {
                ForEach(SoundEvent.allCases, id: \.rawValue) { event in
                    HStack {
                        Picker(event.title, selection: binding(event)) {
                            Text("None").tag(Sounds.none)
                            if !custom.isEmpty { Section("Your sounds") { ForEach(custom, id: \.self) { Text(Sounds.displayName($0)).tag($0) } } }
                            Section("macOS") { ForEach(Sounds.systemNames, id: \.self) { Text($0).tag($0) } }
                            if let c = choices[event.rawValue], c != Sounds.none, !Sounds.systemNames.contains(c), !custom.contains(c) {
                                Text("\(Sounds.displayName(c)) (missing)").tag(c)
                            }
                        }
                        Button { Sounds.shared.play(named: choices[event.rawValue] ?? Sounds.none) } label: { Image(systemName: "play.fill") }
                            .buttonStyle(.borderless).help("Play").accessibilityLabel("Play \(event.title) sound")
                        Menu {
                            Button("Add sound file…") { Sounds.shared.chooseFile(for: event); reload() }
                            Button("Open sounds folder") { Sounds.shared.openFolder() }
                        } label: { Image(systemName: "ellipsis.circle") }
                            .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("More for \(event.title)")
                    }
                }
            } header: { Text("Play a sound when…") }
            .disabled(!on)
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in reload() }
    }

    private func binding(_ event: SoundEvent) -> Binding<String> {
        Binding(get: { choices[event.rawValue] ?? event.defaultSound },
                set: { name in
                    choices[event.rawValue] = name
                    Sounds.shared.setSound(name, for: event)
                    Sounds.shared.play(named: name)
                })
    }

    private func reload() {
        choices = Dictionary(uniqueKeysWithValues: SoundEvent.allCases.map { ($0.rawValue, Sounds.shared.sound(for: $0)) })
        custom = Sounds.customFiles()
    }
}

// MARK: - Agents and tools

struct AgentSettingsPage: View {
    @AppStorage("agentWritesAllowed") private var agentWrites = false
    @AppStorage("portToolsOn") private var ports = false
    @State private var changes: [AuditEntry] = []

    var body: some View {
        Form {
            Section {
                Toggle("Let agents change settings", isOn: $agentWrites)
            } header: { Text("Agents") } footer: {
                Text("Off by default. When on, an agent you ask can change these settings or repair this install through the MCP tools (a few times an hour). Every change is listed below, and in the menu where you can undo it.")
            }

            Section {
                Toggle("Ports: watch, pause and stop", isOn: $ports)
            } header: { Text("Developer tools") } footer: {
                Text("Off by default. Adds a Ports item to the menu: the ports you watch and every port that is listening, who is using each, and a switch to pause that program or stop it (both ask first). Only programs you own, never an agent session.")
            }

            Section {
                if changes.isEmpty {
                    Text("Agents have not changed anything.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(changes, id: \.at) { entry in
                    LabeledContent {
                        Text(Date(timeIntervalSince1970: Double(entry.at) / 1000), style: .relative).foregroundStyle(.secondary).monospacedDigit()
                    } label: { Text(AgentChanges.menuTitle(for: entry)).lineLimit(2) }
                }
            } header: { Text("Recent agent changes") } footer: {
                Text("Undo is in the menu-bar menu, under Agent changes.")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { _ in reload() }
    }

    private func reload() { changes = AuditLog.recent(max: 8).filter { $0.tool != "notify" } }
}

// MARK: - Colors

/// The color of each state's dot. Native color pickers, three ready-made palettes, and a warning when two states look
/// too alike to tell apart in the menu bar. The change shows in the menu bar at once.
struct ColorSettingsPage: View {
    @State private var overrides: [AgentState: String] = [:]
    @State private var tick = 0

    private static let meaning: [AgentState: String] = [
        .starting: "Just opened, before any work",
        .working: "Generating now",
        .done: "Finished its turn",
        .needsInput: "Waiting for you (permission or input)",
        .warning: "Hit an error and is still running",
        .stuck: "Busy, with no activity for a while",
        .stopped: "No longer running",
    ]

    private static func sentence(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
    private var store: StateColorStore { StateColorStore() }
    private var current: StateColors.Palette? { store.palette }
    private var similar: [(AgentState, AgentState)] { StateColors.similarPairs { $0.color } }

    var body: some View {
        Form {
            Section {
                Picker("Palette", selection: paletteBinding) {
                    ForEach(StateColors.palettes) { Text($0.name).tag($0.id) }
                    if current == nil { Text("Custom").tag("custom") }
                }
            } header: { Text("Palette") } footer: {
                Text((current?.note ?? "Your own colors, set below.") + " Changing a color never changes what a state means: the state is still written beside every dot in the menu, and Colorblind shapes (General) gives each state its own outline too.")
            }

            Section {
                ForEach(AgentState.allCases, id: \.rawValue) { state in
                    HStack(spacing: 12) {
                        Circle().fill(Color(nsColor: state.color)).frame(width: 16, height: 16)
                            .overlay(Circle().strokeBorder(Color.primary.opacity(0.25)))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(Self.sentence(state.label))
                            Text(Self.meaning[state] ?? "").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        ColorPicker("Color for \(state.label)", selection: binding(for: state), supportsOpacity: false)
                            .labelsHidden()
                        Button("Reset") { store.set(nil, for: state); reload() }
                            .softButton().disabled(overrides[state] == nil)
                            .help("Back to the system color for \(state.label)")
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                }
            } header: { Text("Each state") }

            if !similar.isEmpty {
                Section {
                    ForEach(Array(similar.enumerated()), id: \.offset) { _, pair in
                        Label("\(Self.sentence(pair.0.label)) and \(pair.1.label) look almost the same.", systemImage: "exclamationmark.triangle.fill")
                    }
                } header: { Text("Hard to tell apart") } footer: {
                    Text("Pick colors that differ more, choose the Colorblind friendly palette, or turn on Colorblind shapes under General so each state also has its own outline.")
                }
            }

            Section {
                LabeledContent("All colors") {
                    Button("Reset to the system colors") { store.reset(); reload() }.softButton().disabled(overrides.isEmpty)
                }
            }
        }
        .formStyle(.grouped)
        .id(tick)
        .onAppear(perform: reload)
        .onReceive(NotificationCenter.default.publisher(for: StateColors.didChange)) { _ in reload() }
    }

    private func reload() { overrides = store.overrides; tick += 1 }

    private var paletteBinding: Binding<String> {
        Binding(get: { current?.id ?? "custom" },
                set: { id in if let p = StateColors.palettes.first(where: { $0.id == id }) { store.apply(p); reload() } })
    }

    private func binding(for state: AgentState) -> Binding<Color> {
        Binding(get: { Color(nsColor: state.color) },
                set: { new in
                    if let hex = StateColors.hex(NSColor(new)) { store.set(hex, for: state); reload() }
                })
    }
}
