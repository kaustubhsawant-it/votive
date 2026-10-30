'use strict';
//
// Regression tests for defects found in a review of the macOS app (AGEN-53 pass): a corrupt registry
// file that overflowed, a snippets file wiped by "Add from clipboard", stuck detection after sleep,
// attention dots hidden by the 6-dot cap, and the alert paths. Swift logic is compiled on its own.
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let haveSwift = process.platform === 'darwin';
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch (e) { haveSwift = false; }
const skip = !haveSwift && 'needs macOS with a Swift toolchain';

function probe(dir, main, files, args = []) {
  fs.writeFileSync(path.join(dir, 'main.swift'), main.join('\n'));
  const exe = path.join(dir, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, ...files.map((f) => V(f)), path.join(dir, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
}
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'ao fix ' + n + ' '));

test('registry: a file with absurd numbers or a bad pid is ignored, not trapped on', { skip }, () => {
  const d = tmp('reg');
  const dir = path.join(d, 'sessions');
  fs.mkdirSync(dir);
  const put = (n, o) => fs.writeFileSync(path.join(dir, n + '.json'), typeof o === 'string' ? o : JSON.stringify(o));
  put('1', { pid: 111, sessionId: 'ok', cwd: '/p', startedAt: 1_800_000_000_000, updatedAt: 1_800_000_001_000 });
  put('2', '{"pid":222,"sessionId":"huge","cwd":"/p","startedAt":9223372036854775807}');      // Int64.max: + 5000 would trap
  put('3', '{"pid":333,"sessionId":"neg","cwd":"/p","updatedAt":-9223372036854775807}');      // now - this would trap
  put('4', { pid: 0, sessionId: 'zero', cwd: '/p' });
  put('5', { pid: -4, sessionId: 'negpid', cwd: '/p' });
  put('6', '{"pid": 66, "sessionId": "half"');                           // half-written
  put('7', { pid: 777, sessionId: 'big', cwd: '/p', pad: 'x'.repeat(70 * 1024) });   // over the size limit
  put('8', { pid: 888, sessionId: 'nodates', cwd: '/p' });               // no timestamps at all is fine
  const out = probe(d, [
    'import Foundation',
    'let r = SessionRegistry(directory: URL(fileURLWithPath: CommandLine.arguments[1]))',
    'print("ids", r.scan().map { $0.sessionId }.sorted().joined(separator: ","))',
    'print("overflowSafe", SessionRegistry.plausible(RegistryEntry(pid: 1, sessionId: "a", cwd: "/", name: nil, status: nil, updatedAt: nil, statusUpdatedAt: nil, startedAt: Int64.max)))',
  ], ['Models/RegistryEntry.swift', 'Services/SessionRegistry.swift', 'Services/Paths.swift', 'Services/BoundedRead.swift'], [dir]);
  assert.equal(out.ids, 'nodates,ok');
  assert.equal(out.overflowSafe, 'false');
});

test('snippets: a file that cannot be read is never overwritten by "Add from clipboard"', { skip }, () => {
  const d = tmp('snip');
  const f = path.join(d, 'snippets.json');
  const out = probe(d, [
    'import Foundation',
    'let s = SnippetStore(fileURL: URL(fileURLWithPath: CommandLine.arguments[1]))',
    'print("missing", s.loadStrict().map { String($0.count) } ?? "nil")',
    'print("add1", s.add("  run the tests  "), s.add("run the tests"), s.add("   "))',
    'print("list", s.load())',
    'try! "[\\"keep me\\" \\"x\\"]".write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)',   // a comma is missing
    'print("broken", s.loadStrict() == nil, s.add("new"))',
    'print("bytes", try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))',
    'try! "[\\"a\\", 5]".write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)',     // a number in the list
    'print("number", s.add("new"))',
    'print("bytes2", try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))',
  ], ['Services/SnippetStore.swift', 'Services/Paths.swift', 'Services/BoundedRead.swift'], [f]);
  assert.equal(out.missing, '0');
  assert.equal(out.add1, 'added duplicate empty');
  assert.equal(out.list, '["run the tests"]');
  assert.equal(out.broken, 'true unreadable');
  assert.equal(out.bytes, '["keep me" "x"]', 'the user\'s file is left exactly as it was');
  assert.equal(out.number, 'unreadable');
  assert.equal(out.bytes2, '["a", 5]');
});

test('stuck detection counts quiet time from the last wake, not from before the lid closed', { skip }, () => {
  const d = tmp('stuck');
  const out = probe(d, [
    'import Foundation',
    'let now: Int64 = 1_800_000_000_000',
    'let old = now - 20 * 60_000',                                       // 20 minutes of silence
    'let reg = RegistryEntry(pid: 1, sessionId: "s", cwd: "/p", name: nil, status: "busy", updatedAt: old, statusUpdatedAt: old, startedAt: old)',
    'let ov = OverlayEntry(agent: "codex", sessionId: "s", lastEvent: "working", lastEventAt: old, cwd: "/p", pid: 1, prompt: nil, transcriptPath: nil, notifyMessage: nil, notifyAt: nil)',
    'var r = StatusResolver()',
    'print("before", r.resolve(reg: reg, overlay: nil, isAlive: true, now: now, firstSeenDeadAt: nil)!.rawValue, r.resolveEvent(ov, isAlive: true, now: now, firstSeenDeadAt: nil)!.rawValue)',
    'r.activityFloor = now - 3_000',                                     // woke 3 seconds ago
    'print("justWoke", r.resolve(reg: reg, overlay: nil, isAlive: true, now: now, firstSeenDeadAt: nil)!.rawValue, r.resolveEvent(ov, isAlive: true, now: now, firstSeenDeadAt: nil)!.rawValue)',
    'print("later", r.resolve(reg: reg, overlay: nil, isAlive: true, now: now + 9 * 60_000, firstSeenDeadAt: nil)!.rawValue, r.resolveEvent(ov, isAlive: true, now: now + 9 * 60_000, firstSeenDeadAt: nil)!.rawValue)',
  ], ['Services/StatusResolver.swift', 'Models/AgentState.swift', 'Models/RegistryEntry.swift', 'Models/OverlayEntry.swift']);
  const [a, b] = out.before.split(' ');
  assert.equal(a, b);
  assert.notEqual(a, 'working', 'sanity: 20 quiet minutes is stuck when nothing was slept through');
  const stuck = a;
  assert.notEqual(out.justWoke.split(' ')[0], stuck, 'right after waking, a busy session is not stuck');
  assert.notEqual(out.justWoke.split(' ')[1], stuck);
  assert.equal(out.later, out.before, 'but 9 awake minutes of silence is stuck again');
});

test('menu bar: with more sessions than dots, the ones that need you keep their seat', { skip }, () => {
  const d = tmp('dots');
  const out = probe(d, [
    'import Foundation',
    'func show(_ s: [AgentState]) -> String { AgentState.menuBarSelection(s, max: 6).map { $0.rawValue }.joined(separator: ",") }',
    'let few: [AgentState] = [.done, .working, .needsInput]',
    'print("few", show(few) == few.map { $0.rawValue }.joined(separator: ","))',
    'let seven: [AgentState] = [.done, .done, .working, .done, .working, .done, .needsInput]',
    'print("seven", AgentState.menuBarSelection(seven, max: 6).count, AgentState.menuBarSelection(seven, max: 6).contains(.needsInput), AgentState.menuBarSelection(seven, max: 6).last == .needsInput)',
    'let tie: [AgentState] = [.working, .working, .working, .working, .working, .working, .working]',
    'print("tie", AgentState.menuBarSelection(tie, max: 6).count)',
    'let errs: [AgentState] = [.done, .warning, .done, .done, .done, .done, .done, .done, .needsInput]',
    'let sel = AgentState.menuBarSelection(errs, max: 6)',
    'print("order", sel.map { $0.rawValue }.joined(separator: ","), sel.contains(.warning), sel.contains(.needsInput))',
  ], ['Models/AgentState.swift']);
  assert.equal(out.few, 'true');
  assert.equal(out.seven, '6 true true', 'the needs-you dot is drawn, in its own place');
  assert.equal(out.tie, '6');
  assert.match(out.order, /true true$/, 'both urgent states are shown');
});

test('alerts and scanning: the wiring that has no pure seam is checked in the source', () => {
  const scanner = read('Votive/Services/AgentScanner.swift').replace(/\/\/.*$/gm, '');
  const coord = read('Votive/Services/StatusCoordinator.swift').replace(/\/\/.*$/gm, '');
  const alerter = read('Votive/Services/DialogAlerter.swift').replace(/\/\/.*$/gm, '');
  const ctl = read('Votive/UI/StatusItemController.swift').replace(/\/\/.*$/gm, '');
  // A session we have been showing still gets its red dot if it dies after a quiet minute.
  assert.match(scanner, /if !alive, firstSeenAt\[key\] == nil, now - ov\.lastEventAt > resolver\.redGraceMs \{ continue \}/);
  // Wake from sleep restarts the stuck clock and rescans.
  assert.match(coord, /NSWorkspace\.didWakeNotification/);
  assert.match(coord, /scanner\.noteWake\(at:/);
  // Even an empty first scan reaches the UI, so the launch baseline is set at launch.
  assert.match(coord, /private var lastSnapshot: \[AgentSession\]\?/);
  // A notify the user asked for takes the oldest panel's place instead of being dropped.
  assert.match(alerter, /guard replaceOldest, let oldest = panels\.last else \{ return \}/);
  assert.match(ctl, /requested: true\)/);
  assert.match(ctl, /replaceOldest: requested/);
  // "Add from clipboard" tells the user when it refused to touch a broken file.
  assert.match(ctl, /SnippetStore\.shared\.add\(text\) == \.unreadable/);
});
