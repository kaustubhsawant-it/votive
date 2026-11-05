'use strict';
//
// The CPU heat warning (Votive/Services/CpuTemperature.swift) is compiled with a small program and run: which sensors count, when it is hot
// (including macOS's own thermal pressure, and not flickering around the line), what the menu-bar loop says, and that the setting is clamped. On a Mac with the HID temperature sensors it
// also reads the real ones once and checks the numbers are believable. Nothing is written and nothing leaves the machine.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let haveSwift = process.platform === 'darwin';
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch (e) { haveSwift = false; }
const skip = !haveSwift && 'needs macOS with a Swift toolchain';

let dir, bin;
before(() => {
  if (!haveSwift) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-cpu-'));
  fs.writeFileSync(path.join(dir, 'main.swift'), `
import Foundation
typealias S = CpuTemperature.Sensor
func sensors(_ a: [(String, Double)]) -> [S] { a.map { S(name: $0.0, celsius: $0.1) } }
var o: [String: Any] = [:]
let r = CpuTemperature.reading(from: sensors([("PMU tdie1", 60), ("PMU tdie2", 80), ("PMU tdev1", 99), ("gas gauge battery", 120), ("NAND CH0 temp", 90)]))
o["reading"] = r.map { ["hottest": $0.hottest, "average": $0.average, "count": $0.count] } ?? [:]
o["noDie"] = CpuTemperature.reading(from: sensors([("PMU tdev1", 50)])) == nil
o["junk"] = CpuTemperature.reading(from: sensors([("PMU tdie1", .nan), ("PMU tdie2", -5), ("PMU tdie3", 400), ("PMU tdie4", 0)])) == nil
o["junkPlusGood"] = CpuTemperature.reading(from: sensors([("PMU tdie1", .nan), ("PMU tdie2", 70)]))?.hottest ?? -1
func hot(_ t: Double?, _ s: ProcessInfo.ThermalState, _ h: Int = 95, _ was: Bool = false) -> Bool { CpuTemperature.isHot(hottest: t, thermalState: s, hotAt: h, wasHot: was) }
o["hot"] = [hot(50, .nominal), hot(94.9, .nominal), hot(95, .nominal), hot(120, .nominal),
            hot(50, .serious), hot(50, .critical), hot(50, .fair), hot(nil, .nominal), hot(nil, .serious), hot(nil, .fair),
            hot(90, .nominal, 100), hot(100, .nominal, 100), hot(75, .nominal, 5), hot(75, .nominal, 500)]
o["hysteresis"] = [hot(93, .nominal, 95, false), hot(93, .nominal, 95, true), hot(92.1, .nominal, 95, true), hot(91.9, .nominal, 95, true)]
o["clamp"] = [CpuTemperature.clampedHotAt(5), CpuTemperature.clampedHotAt(95), CpuTemperature.clampedHotAt(500)]
o["captions"] = [CpuTemperature.caption(hottest: 97.4), CpuTemperature.caption(hottest: 97.5), CpuTemperature.caption(hottest: nil), CpuTemperature.caption(hottest: .nan)]
o["summary"] = [CpuTemperature.summary(r, thermalState: .nominal), CpuTemperature.summary(nil, thermalState: .serious)]
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "live" {
    if let s = HIDTemperatureSensors() {
        let all = s.read()
        o["live"] = ["sensors": all.count, "dies": all.filter { $0.name.contains("tdie") }.count, "hottest": CpuTemperature.reading(from: all)?.hottest ?? -1]
    } else { o["live"] = ["unavailable": true] }
}
print(String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!)
`);
  bin = path.join(dir, 'run');
  const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', bin, path.join(ROOT, 'Votive/Services/CpuTemperature.swift'), path.join(dir, 'main.swift')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const run = (...a) => JSON.parse(execFileSync(bin, a, { encoding: 'utf8' }));

test('only die sensors count, and junk values are dropped', { skip }, () => {
  const o = run();
  assert.deepEqual(o.reading, { hottest: 80, average: 70, count: 2 });     // the power chip (99), battery (120) and SSD (90) are not the CPU
  assert.equal(o.noDie, true);
  assert.equal(o.junk, true);                                              // NaN, negative, zero, 400: no reading, not an average of nonsense
  assert.equal(o.junkPlusGood, 70);
});

test('hot at the line, or when macOS is slowing the chip down; once on it does not flicker; a silly setting is clamped', { skip }, () => {
  const o = run();
  const [n50, n949, h95, h120, serious, critical, fair, none, noneSerious, noneFair, at100below, at100on, low, high] = o.hot;
  assert.deepEqual([n50, n949, h95, h120], [false, false, true, true]);
  assert.deepEqual([serious, critical], [true, true]);                       // macOS's own throttling signal wins over a cool-looking sensor
  assert.equal(fair, false);                                                 // "fair" says nothing on macOS: not a warning
  assert.deepEqual([none, noneSerious, noneFair], [false, true, false]);     // no sensors: only the public signal can say hot
  assert.deepEqual([at100below, at100on], [false, true]);                    // the line is settable
  assert.deepEqual([low, high], [true, false]);                              // clamped to 70 and 110, not obeyed
  assert.deepEqual(o.clamp, [70, 95, 110]);
  assert.deepEqual(o.hysteresis, [false, true, true, false], 'once on, it stays on until 3 degrees below the line');
});

test('what the menu-bar loop says after "CPU", and the one-line summary', { skip }, () => {
  const o = run();
  assert.deepEqual(o.captions, ['97°', '98°', 'hot', 'hot']);               // "hot" only when macOS says so and there is no number
  assert.equal(o.summary[0], 'CPU 80° hottest, 70° average · thermal pressure normal');
  assert.match(o.summary[1], /unavailable.*serious \(macOS is slowing the chip down\)/);
});

test('on this Mac the real sensors answer with believable numbers (skipped where there are none)', { skip }, (t) => {
  const live = run('live').live;
  if (live.unavailable || live.dies === 0) return t.skip('no HID temperature sensors here');
  assert.ok(live.dies >= 2, 'several die sensors');
  assert.ok(live.hottest > 10 && live.hottest < 110, 'a believable die temperature, got ' + live.hottest);
});

test('the settings the app and the agents tool both know: names, keys, bounds', () => {
  const s = require('../Scripts/overlay-settings').SETTINGS;
  const swift = fs.readFileSync(path.join(ROOT, 'Votive/Services/AgentChanges.swift'), 'utf8');
  assert.deepEqual([s.cpuHeatWarning.key, s.cpuHeatWarning.type, s.cpuHeatWarning.default], ['cpuHeatWarn', 'bool', false]);
  assert.deepEqual([s.cpuHeatWarningAt.key, s.cpuHeatWarningAt.default, s.cpuHeatWarningAt.min, s.cpuHeatWarningAt.max], ['cpuHeatAt', 95, 70, 110]);
  assert.match(swift, /"cpuHeatWarning": \("cpuHeatWarn", \.bool\)/);
  assert.match(swift, /"cpuHeatWarningAt": \("cpuHeatAt", \.int\(70\.\.\.110\)\)/);
  assert.ok(!/cpuTemp(Show|Warn|HotAt)|cpuTemperature/.test(swift), 'no leftover names from the first version');
});

test('the warning is part of the usage loop, not a permanent number: "CPU" and the degrees come first, then any limits', () => {
  const car = fs.readFileSync(path.join(ROOT, 'Votive/UI/UsageCarousel.swift'), 'utf8');
  assert.match(car, /captions \+= \["CPU", heat\]/);
  const ctl = fs.readFileSync(path.join(ROOT, 'Votive/UI/StatusItemController.swift'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(ctl, /UsageCarousel\.make\(snapshot: usage, limitsOn: usageAlertOn, heat: heatCaption\)/);
  assert.ok(!/button\??\.(attributedTitle|title)\b|\.imageLeft/.test(ctl), 'nothing is written beside the icon');
  const raw = fs.readFileSync(path.join(ROOT, 'Votive/UI/StatusItemController.swift'), 'utf8');
  assert.match(raw, /if cpuHeatOn, let snap = cpuTemp\.latest \{\s+menu\.addItem\(\.separator\(\)\)/, 'a divider between the session list and the temperature line');
});
