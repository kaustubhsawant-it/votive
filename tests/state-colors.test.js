'use strict';
//
// The colors of the state dots (Votive/Services/StateColors.swift): compiled and run. What is stored is validated, a
// palette is complete and its colors stay apart, a choice reaches AgentState.color, and the store writes only to the
// scratch suite it is given.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const V = (...p) => path.join(ROOT, 'Votive', ...p);
let haveSwift = process.platform === 'darwin';
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch (e) { haveSwift = false; }
const skip = !haveSwift && 'needs macOS with a Swift toolchain';

const MAIN = `
import AppKit
func hex(_ c: NSColor) -> String { StateColors.hex(c) ?? "?" }
print("clean", StateColors.clean("#aabbcc") ?? "nil", StateColors.clean("AABBCC") ?? "nil", StateColors.clean(" #12ab9f ") ?? "nil", StateColors.clean("#abc") ?? "nil", StateColors.clean("#GGGGGG") ?? "nil", StateColors.clean("") ?? "nil", StateColors.clean("#1234567") ?? "nil")
print("roundtrip", hex(StateColors.color(hex: "#56B4E9")!), hex(StateColors.color(hex: "#000000")!), hex(StateColors.color(hex: "#FFFFFF")!), StateColors.color(hex: "red") == nil)
let dirty: [String: Any] = ["working": "#abcdef", "done": "nope", "bogus": "#112233", "stopped": 5, "stuck": "#00ff00 "]
let c = StateColors.cleanStored(dirty)
print("stored", c.keys.map { $0.rawValue }.sorted().joined(separator: ","), c[.working] ?? "-", c[.stuck] ?? "-")
print("notdict", StateColors.cleanStored("x").count, StateColors.cleanStored(nil).count, StateColors.cleanStored([1, 2]).count)
for p in StateColors.palettes {
  let full = p.colors.count == 0 || (p.colors.count == AgentState.allCases.count && p.colors.values.allSatisfy { StateColors.clean($0) == $0 })
  let pairs = StateColors.similarPairs { s in p.colors[s].flatMap { StateColors.color(hex: $0) } ?? s.defaultColor }
  print("palette", p.id, full, pairs.count)
}
print("same", StateColors.distance(NSColor.systemRed, NSColor.systemRed) < 0.001, StateColors.distance(NSColor.black, NSColor.white) > 90)
let two = StateColors.similarPairs { $0 == .done ? NSColor(srgbRed: 0, green: 0.8, blue: 0, alpha: 1) : ($0 == .working ? NSColor(srgbRed: 0, green: 0.78, blue: 0.02, alpha: 1) : $0.defaultColor) }
print("pair", two.map { "\\($0.0.rawValue)+\\($0.1.rawValue)" }.joined(separator: ","))

// the store, on a scratch suite
let suite = "dev.votive.test.colors.\\(getpid())"
let ud = UserDefaults(suiteName: suite)!
let store = StateColorStore(defaults: ud)
print("empty", store.overrides.count, store.palette?.id ?? "custom")
store.set("#112233", for: .working)
print("one", store.overrides[.working] ?? "-", store.palette?.id ?? "custom")
store.set(nil, for: .working)
print("unset", store.overrides.count)
store.apply(StateColors.palettes[1])
print("apply", store.overrides.count, store.palette?.id ?? "custom")
store.set("#000001", for: .done)
print("mixed", store.palette?.id ?? "custom")
store.apply(StateColors.palettes[0])
print("default", store.overrides.count, ud.object(forKey: StateColors.key) == nil)
store.set("bad", for: .done)
print("badignored", store.overrides.count)
ud.set(["working": "#ABCDEF", "done": "zzz"], forKey: StateColors.key)
print("garbage", store.overrides.count)
// AgentState.color follows a choice, and falls back to the system color
store.reset()
store.set("#AA0000", for: .stopped)
AgentState.userColor = { StateColors.color(hex: store.overrides[$0] ?? "") }
print("color", hex(AgentState.stopped.color), hex(AgentState.working.color) == hex(AgentState.working.defaultColor))
store.reset()
UserDefaults.standard.removePersistentDomain(forName: suite)
ud.removePersistentDomain(forName: suite)
`;

function run() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao colors '));
  fs.writeFileSync(path.join(d, 'main.swift'), MAIN);
  const exe = path.join(d, 'colors');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, V('Services/StateColors.swift'), V('Models/AgentState.swift'), path.join(d, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const out = {};
  for (const line of spawnSync(exe, [], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) {
    const i = line.indexOf(' ');
    (out[line.slice(0, i)] = out[line.slice(0, i)] || []).push(line.slice(i + 1));
  }
  fs.rmSync(d, { recursive: true, force: true });
  return out;
}

test('state colors: only a clean six-digit color is accepted, and it comes back the same', { skip }, () => {
  const o = run();
  assert.equal(o.clean[0], '#AABBCC #AABBCC #12AB9F nil nil nil nil');
  assert.equal(o.roundtrip[0], '#56B4E9 #000000 #FFFFFF true');
  assert.equal(o.stored[0], 'stuck,working #ABCDEF #00FF00', 'unknown states and bad values are dropped, the rest is kept');
  assert.equal(o.notdict[0], '0 0 0');
});

test('state colors: every palette is complete, and the colorblind one keeps its states apart', { skip }, () => {
  const o = run();
  const byId = Object.fromEntries(o.palette.map((l) => { const [id, full, pairs] = l.split(' '); return [id, { full, pairs: Number(pairs) }]; }));
  for (const id of ['default', 'colorblind', 'contrast']) assert.equal(byId[id].full, 'true', id + ' has a valid color for every state');
  assert.equal(byId.colorblind.pairs, 0, 'no two states of the colorblind palette look alike');
  assert.equal(o.same[0], 'true true');
  assert.equal(o.pair[0], 'working+done', 'two nearly equal greens are reported as hard to tell apart');
});

test('state colors: the store keeps, clears and validates, and a choice reaches AgentState.color', { skip }, () => {
  const o = run();
  assert.equal(o.empty[0], '0 default');
  assert.equal(o.one[0], '#112233 custom');
  assert.equal(o.unset[0], '0');
  assert.equal(o.apply[0], '7 colorblind');
  assert.equal(o.mixed[0], 'custom', 'a palette with one color changed is a custom mix');
  assert.equal(o.default[0], '0 true', 'the default palette clears the preference instead of storing the system colors');
  assert.equal(o.badignored[0], '0');
  assert.equal(o.garbage[0], '1', 'a hand-edited preference keeps only the valid entry');
  assert.equal(o.color[0], '#AA0000 true', 'the chosen state changes, the others keep the system color');
});

test('state colors: the app installs them at launch and redraws when they change', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('Votive/AppDelegate.swift'), /StateColors\.install\(\)/);
  assert.match(read('Votive/UI/StatusItemController.swift'), /name: StateColors\.didChange/);
  assert.match(read('Votive/Models/AgentState.swift'), /var color: NSColor \{ Self\.userColor\(self\) \?\? defaultColor \}/);
});
