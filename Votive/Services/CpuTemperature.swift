import Foundation
import IOKit

/// The CPU heat warning for the menu bar: when it is "hot", what it says, and how the temperature is read.
///
/// The warning is not a permanent number: only when it is hot does the menu-bar icon loop through "CPU" and the degrees, the way
/// it does for a plan limit (`UsageCarousel`). Two signals, used for different jobs:
///  - The die sensors ("PMU tdie1" ... on Apple silicon) give the degrees. They are read through the HID sensor interface
///    that macOS itself publishes without root. It is not a documented API, so it is loaded at run time and every piece
///    of it may be missing: then there is simply no number.
///  - `ProcessInfo.thermalState` is the public signal. `serious` and `critical` mean macOS itself is cutting performance,
///    so they count as hot whatever the sensors say (and when there are no sensors). `fair` is not used: on macOS it
///    covers throttled and unthrottled alike, so it would say nothing.
///
/// Pure parts (`reading`, `isHot`, `caption`) are Foundation only and tested by compiling this file
/// (tests/cpu-temperature.test.js). Nothing here touches the network or writes a file.
enum CpuTemperature {
    /// The warning starts at this many degrees C. The die of an M-series chip is cut back from roughly the high 90s to 100s;
    /// 95 leaves time to react. Settable between `hotRange` bounds.
    static let defaultHotAt = 95
    static let hotRange = 70...110
    /// Once the warning is on it stays on until the chip is this much below the line, so it does not flicker on and off around it.
    static let coolMargin = 3

    struct Sensor: Equatable {
        let name: String
        let celsius: Double
    }

    struct Reading: Equatable {
        let hottest: Double
        let average: Double
        let count: Int
    }

    /// The CPU die temperature from every sensor the machine lists. Only die sensors count (the battery, the SSD and the
    /// power chip have their own); a value that is not a plausible temperature is dropped, not averaged in.
    static func reading(from sensors: [Sensor]) -> Reading? {
        let dies = sensors.filter { $0.name.contains("tdie") && $0.celsius.isFinite && $0.celsius > 0 && $0.celsius < 150 }
        guard !dies.isEmpty else { return nil }
        let values = dies.map(\.celsius)
        return Reading(hottest: values.max() ?? 0, average: values.reduce(0, +) / Double(values.count), count: values.count)
    }

    /// Whether the warning is on: macOS reports serious or critical thermal pressure, or the hottest die sensor is at or over `hotAt`
    /// (and, once on, until it is `coolMargin` below it).
    static func isHot(hottest: Double?, thermalState: ProcessInfo.ThermalState, hotAt: Int, wasHot: Bool = false) -> Bool {
        if thermalState == .serious || thermalState == .critical { return true }
        guard let t = hottest else { return false }
        return t >= Double(clampedHotAt(hotAt)) - (wasHot ? Double(coolMargin) : 0)
    }

    static func clampedHotAt(_ v: Int) -> Int { min(max(v, hotRange.lowerBound), hotRange.upperBound) }

    /// The number the menu-bar loop shows after "CPU", "97°". Without a reading (only macOS's signal says hot): "hot".
    static func caption(hottest: Double?) -> String {
        if let t = hottest, t.isFinite { return String(Int(t.rounded())) + "°" }
        return "hot"
    }

    /// One line for the tooltip and the menu.
    static func summary(_ r: Reading?, thermalState: ProcessInfo.ThermalState) -> String {
        let state: String
        switch thermalState {
        case .nominal: state = "normal"
        case .fair: state = "fair"
        case .serious: state = "serious (macOS is slowing the chip down)"
        case .critical: state = "critical (macOS is slowing the chip down)"
        @unknown default: state = "unknown"
        }
        guard let r else { return "CPU temperature unavailable · thermal pressure " + state }
        return "CPU \(Int(r.hottest.rounded()))° hottest, \(Int(r.average.rounded()))° average · thermal pressure " + state
    }
}

// MARK: - Reading the sensors

/// The HID temperature sensors, through functions found at run time. `init` fails when any is missing (another macOS, an
/// Intel Mac), and then the monitor falls back to the public thermal state alone.
final class HIDTemperatureSensors {
    private typealias CreateFn = @convention(c) (CFAllocator?) -> Unmanaged<CFTypeRef>?
    private typealias SetMatchingFn = @convention(c) (CFTypeRef, CFDictionary) -> Int32
    private typealias CopyServicesFn = @convention(c) (CFTypeRef) -> Unmanaged<CFArray>?
    private typealias CopyPropFn = @convention(c) (CFTypeRef, CFString) -> Unmanaged<CFTypeRef>?
    private typealias CopyEventFn = @convention(c) (CFTypeRef, Int64, Int32, Int64) -> Unmanaged<CFTypeRef>?
    private typealias FloatFn = @convention(c) (CFTypeRef, Int32) -> Double

    private static let temperatureEvent: Int64 = 15            // kIOHIDEventTypeTemperature
    private let client: CFTypeRef
    private let copyServices: CopyServicesFn
    private let copyProp: CopyPropFn
    private let copyEvent: CopyEventFn
    private let floatValue: FloatFn

    init?() {
        guard let h = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW) else { return nil }
        func find<T>(_ name: String, _ type: T.Type) -> T? { dlsym(h, name).map { unsafeBitCast($0, to: type) } }
        guard let create = find("IOHIDEventSystemClientCreate", CreateFn.self),
              let setMatching = find("IOHIDEventSystemClientSetMatching", SetMatchingFn.self),
              let services = find("IOHIDEventSystemClientCopyServices", CopyServicesFn.self),
              let prop = find("IOHIDServiceClientCopyProperty", CopyPropFn.self),
              let event = find("IOHIDServiceClientCopyEvent", CopyEventFn.self),
              let value = find("IOHIDEventGetFloatValue", FloatFn.self),
              let made = create(kCFAllocatorDefault)?.takeRetainedValue() else { return nil }
        // usage page 0xff00, usage 5: the vendor page Apple lists its temperature sensors on
        _ = setMatching(made, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5] as CFDictionary)
        client = made
        copyServices = services; copyProp = prop; copyEvent = event; floatValue = value
    }

    /// Every temperature sensor and its value now, in degrees C. Empty when none answers.
    func read() -> [CpuTemperature.Sensor] {
        guard let list = copyServices(client)?.takeRetainedValue() as? [CFTypeRef] else { return [] }
        var out: [CpuTemperature.Sensor] = []
        for service in list {
            guard let name = copyProp(service, "Product" as CFString)?.takeRetainedValue() as? String,
                  let event = copyEvent(service, Self.temperatureEvent, 0, 0)?.takeRetainedValue() else { continue }
            out.append(CpuTemperature.Sensor(name: name, celsius: floatValue(event, Int32(Self.temperatureEvent << 16))))
        }
        return out
    }
}

/// Reads the temperature every few seconds while something is showing it, and says so on the main thread when what is
/// shown (the rounded number or the thermal pressure) changes. Nothing runs when it is stopped.
final class CpuTemperatureMonitor {
    struct Snapshot: Equatable {
        let reading: CpuTemperature.Reading?
        let thermalState: ProcessInfo.ThermalState
        /// The rounded number, so a change of a fraction of a degree is not a change.
        var shown: Int? { reading.map { Int($0.hottest.rounded()) } }
        static func == (a: Snapshot, b: Snapshot) -> Bool { a.shown == b.shown && a.thermalState == b.thermalState }
    }

    var onChange: ((Snapshot) -> Void)?
    private(set) var latest: Snapshot?

    static let interval: TimeInterval = 5
    private let queue = DispatchQueue(label: "dev.votive.Votive.cputemp", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var sensors: HIDTemperatureSensors?
    private var triedSensors = false
    private var observer: NSObjectProtocol?

    func start() {
        guard timer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { self?.poll() }
        }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: Self.interval, leeway: .seconds(1))
        t.setEventHandler { [weak self] in self?.poll() }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel(); timer = nil
        if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
        latest = nil
    }

    private func poll() {
        if !triedSensors { sensors = HIDTemperatureSensors(); triedSensors = true }
        let snap = Snapshot(reading: sensors.flatMap { CpuTemperature.reading(from: $0.read()) },
                            thermalState: ProcessInfo.processInfo.thermalState)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.timer != nil else { return }
            if self.latest == snap { return }
            self.latest = snap
            self.onChange?(snap)
        }
    }
}
