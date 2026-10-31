'use strict';
//
// The optional Ports tool (developer tools, off by default): reading lsof's output, checking what a
// person typed, the watch-list file, and stopping a program. The Swift logic is compiled on its own
// and run against a real listener that this test starts and owns.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const S = (n) => path.join(ROOT, 'Votive', 'Services', n);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let haveSwift = process.platform === 'darwin';
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch (e) { haveSwift = false; }
const skip = !haveSwift && 'needs macOS with a Swift toolchain';
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'ao ports ' + n + ' '));

function compile(dir, main, files) {
  fs.writeFileSync(path.join(dir, 'main.swift'), main.join('\n'));
  const exe = path.join(dir, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, ...files.map(S), path.join(dir, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  return exe;
}
function compileRun(dir, main, files, args) {
  const exe = compile(dir, main, files);
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return lines(r);
}
const lines = (r) => Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));

test('ports: lsof output, typed input and the stored list are parsed strictly', { skip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao ports '));
  const sample = 'p612\ncrapportd\nu501\nf10\nn*:63787\nf11\nn*:63787\np825\ncmongod\nu501\nf9\nn127.0.0.1:27017\nf10\nn[::1]:27017\np839\ncpostgres\nu501\nf7\nn[::1]:5432\npx\ncbad\nn*:1\np77\ncodd\\x20name‮\u0007\nu0\nn*:99999\nn*:notaport\nn*:8080\n';
  fs.writeFileSync(path.join(d, 'sample.txt'), sample);
  const exe = compile(d, [
    'import Foundation',
    'let sample = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)',
    'let l = PortScan.parse(sample)',
    'print("parsed", l.map { "\\($0.port):\\($0.pid):\\($0.command):\\($0.uid)" }.joined(separator: ","))',
    'print("input", ["3000", " 8080 ", ":5173", "0", "65536", "30a0", "-1", "", "123456", "٣٠٠٠", "3000 3001"].map { PortScan.parseInput($0).map(String.init) ?? "nil" }.joined(separator: ","))',
    'print("list", PortScan.cleanList([3000, 3000, 80, 0, 70000, "x", 5.5, true, 22] as [Any]))',
    'print("listbad", PortScan.cleanList("nope"), PortScan.cleanList(nil), PortScan.cleanList(["3000"]))',
    'print("cap", PortScan.cleanList(Array(1...100) as [Any]).count)',
    'print("system", PortScan.isSystemPath("/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"), PortScan.isSystemPath("/usr/libexec/rapportd"), PortScan.isSystemPath("/opt/homebrew/bin/node"), PortScan.isSystemPath(nil))',
    'func r(_ pid: Int32, uid: UInt32 = 501, path: String? = "/opt/homebrew/bin/node", agents: Set<Int32> = []) -> String { PortScan.refusal(for: PortListener(port: 3000, pid: pid, command: "node", uid: uid), path: path, ownUID: 501, ownPID: 9, agentPIDs: agents) ?? "ok" }',
    'print("refuse", r(1), r(0), r(9), r(100, uid: 0), r(100, agents: [100]), r(100, path: "/System/x"), r(100))',
    'print("title", PortScan.rowTitle(port: 3000, listeners: []), "|", PortScan.rowTitle(port: 3000, listeners: [PortListener(port: 3000, pid: 7, command: "node", uid: 501)]), "|", PortScan.rowTitle(port: 3000, listeners: [PortListener(port: 3000, pid: 7, command: "node", uid: 501), PortListener(port: 3000, pid: 8, command: "x", uid: 501)]))',
    'print("safe", PortScan.safeText("a\\u{202E}b\\u{07}c\\n"), PortScan.safeText(String(repeating: "z", count: 90)).count)',
    'print("local", l.map { "\\($0.port):\\($0.localOnly)" }.joined(separator: ","))',
    'let row = PortRow(listener: PortListener(port: 5173, pid: 1, command: "node", uid: 501, localOnly: true), path: "/Users/me/bin/node", folder: "/Users/me/dev/app", paused: true, mine: true)',
    'print("details", PortScan.details(for: row, home: "/Users/me").joined(separator: " | "))',
    'let open = PortRow(listener: PortListener(port: 4242, pid: 2, command: "srv", uid: 501), path: nil, folder: nil, paused: false, mine: true)',
    'print("open", PortScan.details(for: open, home: "/Users/me").joined(separator: " | "), "|", PortScan.allPortsTitle(open), "|", PortScan.allPortsTitle(row))',
    'print("tilde", PortScan.tildePath("/Users/me/x", home: "/Users/me"), PortScan.tildePath("/Users/mex/y", home: "/Users/me"), PortScan.tildePath("/opt/a", home: "/Users/me"), PortScan.tildePath("/Users/me", home: "/Users/me"))',
    'print("resume", PortScan.resumeRefusal(for: PortListener(port: 1, pid: 100, command: "x", uid: 501), ownUID: 501, ownPID: 9) ?? "ok", "|", PortScan.resumeRefusal(for: PortListener(port: 1, pid: 100, command: "x", uid: 0), ownUID: 501, ownPID: 9) ?? "ok", "|", PortScan.resumeRefusal(for: PortListener(port: 1, pid: 9, command: "x", uid: 501), ownUID: 501, ownPID: 9) ?? "ok")',
    'print("mine", PortScan.isMine(PortListener(port: 1, pid: 5, command: "x", uid: 501), path: "/opt/homebrew/bin/node", ownUID: 501), PortScan.isMine(PortListener(port: 1, pid: 5, command: "x", uid: 501), path: "/System/Library/x", ownUID: 501), PortScan.isMine(PortListener(port: 1, pid: 5, command: "x", uid: 0), path: nil, ownUID: 501))',
    'print("path", PortScan.safePath("/a/b\\u{202E}c\\u{07}") ?? "nil", PortScan.safePath("") ?? "nil", PortScan.safePath(nil) ?? "nil", PortScan.safePath(String(repeating: "p", count: 400))!.count)',
    'print("db", PortScan.isDatabasePort(5432), PortScan.isDatabasePort(5173), PortScan.databaseNote(3000).isEmpty, PortScan.databaseNote(6379).contains("6379"))',
    'print("hints", PortScan.knownPortNote(5173) ?? "nil", "|", PortScan.knownPortNote(7000) ?? "nil", "|", PortScan.knownPortNote(12345) ?? "nil")',
  ], ['PortScan.swift']);
  const r = spawnSync(exe, [path.join(d, 'sample.txt')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  // pid 612 on 63787 once (two fds), mongod on 27017 once (v4 + v6), postgres, the "bad" process without a numeric pid is skipped,
  // pid 77 has a port out of range (ignored) and 8080 (kept). Control and bidi characters are gone from the name.
  assert.equal(out.parsed, '5432:839:postgres:501,8080:77:odd name:0,27017:825:mongod:501,63787:612:rapportd:501');
  assert.equal(out.input, '3000,8080,5173,nil,nil,nil,nil,nil,nil,nil,nil');
  assert.equal(out.list, '[22, 80, 3000]');
  assert.equal(out.listbad, '[] [] []');
  assert.equal(out.cap, '24');
  assert.equal(out.system, 'true true false false');
  assert.equal(out.refuse.split(' ')[0].startsWith('That'), true);
  assert.match(out.refuse, /core system process\. That is a core system process\. That is Votive itself\. Another user owns that program, so macOS would not allow it\. That port belongs to a running agent session\. Close the session from its terminal instead\. That is part of macOS\. ok$/);
  assert.equal(out.title, '3000  ·  free | 3000  ·  node (pid 7) | 3000  ·  node (pid 7) +1');
  assert.equal(out.safe, 'abc 40');
  // Only loopback addresses count as "this Mac only"; one wildcard makes the whole program reachable.
  assert.equal(out.local, '5432:true,8080:false,27017:true,63787:false');
  assert.equal(out.details, 'Program: ~/bin/node | Started in: ~/dev/app | Reachable from: this Mac only | Port 5173 is usually: Vite dev server | Status: paused (frozen, still holding the port)');
  assert.equal(out.open, 'Reachable from: other devices on your network too | srv  ·  all interfaces | 5173  ·  node  ·  this Mac only  ·  paused'.replace('srv  ·  all', '4242  ·  srv  ·  all').replace('Reachable from: other devices on your network too | ', 'Reachable from: other devices on your network too | '));
  assert.equal(out.tilde, '~/x /Users/mex/y /opt/a ~');
  assert.equal(out.resume, 'ok | Another user owns that program, so macOS would not allow it. | That is Votive itself.');
  assert.equal(out.mine, 'true false false');
  assert.equal(out.path, '/a/bc nil nil 160');
  assert.equal(out.hints, 'Vite dev server | macOS AirPlay Receiver | nil');
  assert.equal(out.db, 'true false true true', 'a database port gets an extra warning in the Stop and Pause dialogs');
});

test('ports: the watch list file is validated, de-duplicated and written privately', { skip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao ports home '));
  const exe = compile(d, [
    'import Foundation',
    'let w = PortWatchList(fileURL: URL(fileURLWithPath: CommandLine.arguments[1]))',
    'print("empty", w.load())',
    'print("add", w.add(3000), w.add(3000), w.add(0), w.add(70000), w.add(5173))',
    'print("loaded", w.load())',
    'w.remove(3000)',
    'print("removed", w.load())',
    'for p in 1...30 { w.add(1000 + p) }',
    'print("capped", w.load().count)',
  ], ['PortScan.swift', 'PortTools.swift', 'Paths.swift', 'BoundedRead.swift']);
  const file = path.join(d, '.votive', 'ports.json');
  const run = () => spawnSync(exe, [file], { encoding: 'utf8', timeout: 20000 });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  assert.equal(out.empty, '[]');
  assert.equal(out.add, 'true false false false true');
  assert.equal(out.loaded, '[3000, 5173]');
  assert.equal(out.removed, '[5173]');
  assert.equal(out.capped, '24');
  assert.ok(fs.existsSync(file), 'the list is a plain file');
  assert.equal(fs.statSync(path.join(d, '.votive')).mode & 0o777, 0o700, 'the folder is private');
  // A hand-edited or hostile file is cleaned, not trusted.
  fs.writeFileSync(file, JSON.stringify([8080, '9', null, { a: 1 }, 8080, 99999, 22]));
  assert.equal(run().stdout.split('\n')[0], 'empty [22, 8080]');
  fs.writeFileSync(file, 'not json');
  assert.equal(run().stdout.split('\n')[0], 'empty []');
});

test('ports: a real listener is found, refused when it is an agent, and stopped only when it is the same program', { skip }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao ports live '));
  const child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res, rej) => { child.stdout.once('data', (b) => res(Number(String(b).trim()))); child.once('error', rej); setTimeout(() => rej(new Error('no port')), 5000); });
    const exe = compile(d, [
      'import Foundation',
      'let args = CommandLine.arguments',
      'let port = Int(args[1])!, pid = Int32(args[2])!',
      'func wait(_ f: (@escaping (PortTools.Outcome) -> Void) -> Void) -> PortTools.Outcome {',
      '  var result: PortTools.Outcome?',
      '  f { result = $0 }',
      '  while result == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }',
      '  return result!',
      '}',
      'let found = PortTools.scan()?.first { $0.port == port }',
      'print("found", found.map { "\\($0.pid == pid) \\($0.uid == getuid())" } ?? "nil")',
      'let mine = PortListener(port: port, pid: pid, command: "node", uid: getuid())',
      'print("nokill", PortTools.refusal(for: mine, agentPIDs: []) ?? "ok", "|", PortTools.refusal(for: mine, agentPIDs: [pid]) ?? "ok")',
      'print("agent", wait { PortTools.stop(mine, agentPIDs: [pid], completion: $0) })',
      'print("alive", kill(pid, 0) == 0)',
      'let stale = PortListener(port: port, pid: pid &+ 1, command: "node", uid: getuid())',
      'print("stale", wait { PortTools.stop(stale, agentPIDs: [], completion: $0) })',
      'print("alive2", kill(pid, 0) == 0)',
      'print("stop", wait { PortTools.stop(mine, agentPIDs: [], completion: $0) })',
      'print("gone", PortTools.scan()?.contains { $0.port == port } ?? true)',
      'print("again", wait { PortTools.stop(mine, agentPIDs: [], completion: $0) })',
    ], ['PortScan.swift', 'PortTools.swift', 'Paths.swift', 'BoundedRead.swift']);
    // Async, so this process can collect the listener's exit like a shell would (spawnSync would block that).
    const r = await new Promise((res) => {
      const p = spawn(exe, [String(port), String(child.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      p.stdout.on('data', (b) => { stdout += b; }); p.stderr.on('data', (b) => { stderr += b; });
      const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
      p.on('close', (status) => { clearTimeout(timer); res({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    const out = lines(r);
    assert.equal(out.found, 'true true', 'lsof sees the listener, with the right pid and owner');
    assert.equal(out.nokill, 'ok | That port belongs to a running agent session. Close the session from its terminal instead.');
    assert.equal(out.agent, 'refused("That port belongs to a running agent session. Close the session from its terminal instead.")');
    assert.equal(out.alive, 'true', 'an agent session is never signalled');
    assert.equal(out.stale, 'gone', 'a pid that is not the one listening on that port is never signalled');
    assert.equal(out.alive2, 'true');
    assert.equal(out.stop, 'stopped');
    assert.equal(out.gone, 'false', 'the port is free afterwards');
    assert.equal(out.again, 'gone');
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* already stopped */ }
  }
});

test('ports: pause freezes a program and keeps its port, resume lets it go on, stop works on a paused one', { skip }, async () => {
  const d = tmp('pause');
  const child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res, rej) => { child.stdout.once('data', (b) => res(Number(String(b).trim()))); setTimeout(() => rej(new Error('no port')), 5000); });
    const exe = compile(d, [
      'import Foundation',
      'let args = CommandLine.arguments',
      'let port = Int(args[1])!, pid = Int32(args[2])!',
      'func wait(_ f: (@escaping (PortTools.Outcome) -> Void) -> Void) -> PortTools.Outcome {',
      '  var result: PortTools.Outcome?',
      '  f { result = $0 }',
      '  while result == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }',
      '  return result!',
      '}',
      'func ps() -> String { let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/ps"); p.arguments = ["-o", "stat=", "-p", "\\(pid)"]; let o = Pipe(); p.standardOutput = o; try! p.run(); p.waitUntilExit(); return String(decoding: o.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }',
      'func held() -> Bool { PortTools.scan()?.contains { $0.port == port && $0.pid == pid } ?? false }',
      'let me = PortListener(port: port, pid: pid, command: "node", uid: getuid())',
      'let store = PausedStore(fileURL: URL(fileURLWithPath: args[3]))',
      'print("start", PortTools.runState(ofPID: pid)!, ps().hasPrefix("T"))',
      'print("agent", wait { PortTools.pause(me, agentPIDs: [pid], completion: $0) }, PortTools.runState(ofPID: pid)!)',
      'print("stale", wait { PortTools.pause(PortListener(port: port, pid: pid &+ 1, command: "node", uid: getuid()), agentPIDs: [], completion: $0) })',
      'print("pause", wait { PortTools.pause(me, agentPIDs: [], completion: $0) }, PortTools.runState(ofPID: pid)!, ps().hasPrefix("T"), held())',
      'print("again", wait { PortTools.pause(me, agentPIDs: [], completion: $0) })',
      'let row = PortTools.inspect(PortTools.scan()!.filter { $0.port == port }).first!',
      'print("row", row.paused, row.mine, row.folder != nil, row.listener.localOnly)',
      'store.add(pid: pid, port: port, command: "node")',
      'print("stored", store.load().map { "\\($0.pid == pid) \\($0.port == port)" })',
      'print("resume", wait { PortTools.resume(me, completion: $0) }, PortTools.runState(ofPID: pid)!, ps().hasPrefix("T"), held())',
      'print("agentResume", wait { PortTools.pause(me, agentPIDs: [], completion: $0) }, wait { PortTools.resume(me, completion: $0) })',
      // paused, remembered, then Votive quits: resumeAll continues it
      'print("pause2", wait { PortTools.pause(me, agentPIDs: [], completion: $0) })',
      'store.add(pid: pid, port: port, command: "node")',
      'print("resumeAll", store.resumeAll(), PortTools.runState(ofPID: pid)!, store.load().count)',
      // stop on a paused program: it is continued first, then asked to quit
      'print("pause3", wait { PortTools.pause(me, agentPIDs: [], completion: $0) })',
      'print("stop", wait { PortTools.stop(me, agentPIDs: [], completion: $0) }, held())',
    ], ['PortScan.swift', 'PortTools.swift', 'PausedStore.swift', 'Paths.swift', 'BoundedRead.swift', 'Liveness.swift']);
    const r = await new Promise((res) => {
      const p = spawn(exe, [String(port), String(child.pid), path.join(d, 'x'), path.join(d, 'paused.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      p.stdout.on('data', (b) => { stdout += b; }); p.stderr.on('data', (b) => { stderr += b; });
      const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
      p.on('close', (status) => { clearTimeout(timer); res({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = lines(r);
    assert.equal(out.start, 'running false');
    assert.match(out.agent, /^refused\("That port belongs to a running agent session/);
    assert.match(out.agent, /running$/, 'an agent session is not frozen');
    assert.equal(out.stale, 'gone', 'a pid that is not the one on that port is never signalled');
    assert.equal(out.pause, 'paused paused true true', 'frozen by the kernel\'s own account (ps shows T), and the port is still held');
    assert.equal(out.again, 'paused', 'pausing twice is harmless');
    assert.equal(out.row, 'true true true true', 'the menu row knows it is paused, is the user\'s, has a folder and is local only');
    assert.equal(out.stored, '["true true"]');
    assert.equal(out.resume, 'resumed running false true');
    assert.equal(out.agentResume, 'paused resumed');
    assert.equal(out.pause2, 'paused');
    assert.equal(out.resumeAll, '1 running 0', 'quitting with "Resume them" continues it and empties the file');
    assert.equal(out.pause3, 'paused');
    assert.equal(out.stop, 'stopped false', 'a frozen program is continued first, otherwise SIGTERM would wait forever');
  } finally {
    try { process.kill(child.pid, 'SIGCONT'); child.kill('SIGKILL'); } catch (e) { /* already stopped */ }
  }
});

test('ports: the paused list is re-checked on every read, so a stale or edited file cannot point at another process', { skip }, () => {
  const d = tmp('paused');
  const f = path.join(d, 'paused.json');
  const out = compileRun(d, [
    'import Foundation',
    'let file = URL(fileURLWithPath: CommandLine.arguments[1])',
    'func store(paused: @escaping (Int32) -> Bool = { _ in true }, start: @escaping (Int32) -> Double? = { _ in 1000 }, owner: @escaping (Int32) -> UInt32? = { _ in getuid() }) -> PausedStore {',
    '  PausedStore(fileURL: file, isPaused: paused, startEpoch: start, owner: owner)',
    '}',
    'let s = store()',
    'print("empty", s.load().count)',
    's.add(pid: 4242, port: 3000, command: "  node\\u{202E}\\u{07}  ")',
    'print("added", s.load().map { "\\($0.pid):\\($0.port):\\($0.command)" })',
    'print("notPaused", store(paused: { _ in false }).load().count)',
    'print("recycled", store(start: { _ in 5000 }).load().count, store(start: { _ in 1001.5 }).load().count, store(start: { _ in nil }).load().count)',
    'print("otherUser", store(owner: { _ in 0 }).load().count, store(owner: { _ in nil }).load().count)',
    'try! #"[{"pid":1,"port":3000,"command":"launchd","startedAt":1000},{"pid":-5,"port":3000,"command":"x","startedAt":1000},{"pid":77,"port":70000,"command":"x","startedAt":1000},{"pid":78,"port":22,"command":"ok","startedAt":1000}]"#.write(to: file, atomically: true, encoding: .utf8)',
    'print("edited", s.load().map { "\\($0.pid):\\($0.command)" })',
    'try! "not json".write(to: file, atomically: true, encoding: .utf8)',
    'print("garbage", s.load().count)',
    'try! #"[{"pid":9,"port":3000,"command":"gone","startedAt":1000}]"#.write(to: file, atomically: true, encoding: .utf8)',
    'store(paused: { _ in false }).prune()',
    'print("pruned", try! String(contentsOf: file, encoding: .utf8))',
    'let missing = URL(fileURLWithPath: CommandLine.arguments[1] + ".none")',
    'PausedStore(fileURL: missing).prune()',
    'print("noFile", FileManager.default.fileExists(atPath: missing.path))',
  ], ['PortScan.swift', 'PortTools.swift', 'PausedStore.swift', 'Paths.swift', 'BoundedRead.swift', 'Liveness.swift'], [f]);
  assert.equal(out.empty, '0');
  assert.equal(out.added, '["4242:3000:node"]', 'the stored name has control and direction characters removed');
  assert.equal(out.notPaused, '0', 'a program that is no longer frozen is dropped');
  assert.equal(out.recycled, '0 1 0', 'a different start time (a recycled pid) is dropped; a 1.5 s clock difference is not');
  assert.equal(out.otherUser, '0 0');
  assert.equal(out.edited, '["78:ok"]', 'pid 1, a negative pid and an impossible port are ignored');
  assert.equal(out.garbage, '0');
  assert.equal(out.pruned, '[]');
  assert.equal(out.noFile, 'false', 'pruning never creates the file');
});

test('ports: the menu shows watched and all ports, who uses each, and the Pause switch', { skip }, async () => {
  const d = tmp('menu');
  const watchFile = path.join(d, 'ports.json');
  const pausedFile = path.join(d, 'paused.json');
  const child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res, rej) => { child.stdout.once('data', (b) => res(Number(String(b).trim()))); setTimeout(() => rej(new Error('no port')), 5000); });
    const exe = compile(d, [
      'import AppKit',
      'let args = CommandLine.arguments',
      'let menu = PortsMenu(watchList: PortWatchList(fileURL: URL(fileURLWithPath: args[1])), pausedStore: PausedStore(fileURL: URL(fileURLWithPath: args[2])), agentPIDs: { Set(args.count > 3 ? [Int32(args[3])!] : []) })',
      'func dump(_ m: NSMenu, _ indent: String = "") {',
      '  for i in m.items {',
      '    print(indent + (i.isSeparatorItem ? "---" : i.title) + (i.isEnabled || i.isSeparatorItem ? "" : " [disabled]") + (i.state == .on ? " [on]" : ""))',
      '    if let s = i.submenu { dump(s, indent + "  ") }',
      '  }',
      '}',
      'print("root", menu.menuItem().title)',
      'dump(menu.menuItem().submenu!)',
      'extension Timer { static func commonModeTimer(interval: TimeInterval, repeats: Bool, block: @escaping (Timer) -> Void) -> Timer { Timer.scheduledTimer(withTimeInterval: interval, repeats: repeats, block: block) } }',
    ], ['../UI/PortsMenu.swift', 'PortScan.swift', 'PortTools.swift', 'PausedStore.swift', 'Paths.swift', 'BoundedRead.swift', 'Liveness.swift', 'DialogAlerter.swift', '../UI/NotifyPanel.swift']);
    const dump = (args) => spawnSync(exe, [watchFile, pausedFile, ...args], { encoding: 'utf8', timeout: 20000 });
    fs.writeFileSync(watchFile, JSON.stringify([port, 59999]));
    const a = dump([]);
    assert.equal(a.status, 0, a.stderr);
    const text = a.stdout;
    assert.match(text, /^root Ports\n/m);
    assert.match(text, /^Watched ports\n/m);   // (a "Resume" shortcut may come first if something else on this Mac is frozen)
    assert.match(text, new RegExp(`${port}  ·  node \\(pid ${child.pid}\\)\\n  Program: .* \\[disabled\\]\\n  Started in: .* \\[disabled\\]\\n  Reachable from: this Mac only \\[disabled\\]\\n  ---\\n  Pause\\n  Stop node \\(pid ${child.pid}\\)…\\n  ---\\n  Stop watching ${port}\\n`), 'a busy watched port: who, from where, who can reach it, the Pause switch, Stop');
    assert.match(text, /59999  ·  free\n  Stop watching 59999/, 'a free port can only be unwatched');
    assert.match(text, /All listening ports \(\d+\)\n  Yours \(\d+\)/, 'the all-ports view lists everything that listens');
    assert.match(text, new RegExp(`\\n  ${port}  ·  node  ·  this Mac only\\n    Program: `), 'and your own programs there carry the same details and actions');
    assert.match(text, /Watch port \d+/, 'an unwatched port can be added to the watch list from the all-ports view');
    assert.ok(!/Stop (rapportd|ControlCenter|launchd)/.test(text), 'a macOS program never gets a Stop item');
    // An agent session is not offered Pause or Stop.
    const b = dump([String(child.pid)]).stdout;
    assert.match(b, /\n  Pause \[disabled\]\n  Stop node \(pid \d+\)… \[disabled\]\n/, 'an agent session cannot be paused or stopped from the menu');
    // Paused: the row says so, the switch is on, and there is a shortcut to resume.
    process.kill(child.pid, 'SIGSTOP');
    await new Promise((r) => setTimeout(r, 300));
    const c = dump([]).stdout;
    assert.match(c, /^Resume the paused program\n---\nWatched ports/m);
    assert.match(c, new RegExp(`${port}  ·  node \\(pid ${child.pid}\\)  ·  paused\\n`));
    assert.match(c, /Status: paused \(frozen, still holding the port\)/);
    assert.match(c, /Paused: click to resume \[on\]/);
    process.kill(child.pid, 'SIGCONT');
    fs.writeFileSync(watchFile, '[]');
    await new Promise((r) => setTimeout(r, 300));
    assert.match(dump([]).stdout, /No ports yet \[disabled\]\nWatch 3000, 5173, 8000, 8080/);
  } finally {
    try { process.kill(child.pid, 'SIGCONT'); child.kill('SIGKILL'); } catch (e) { /* already stopped */ }
  }
});

test('ports: it is off by default, opens no socket, uses no shell and signals one verified process only', () => {
  const tools = read('Votive/Services/PortTools.swift').replace(/\/\/.*$/gm, '');
  const paused = read('Votive/Services/PausedStore.swift').replace(/\/\/.*$/gm, '');
  const menu = read('Votive/UI/PortsMenu.swift').replace(/\/\/.*$/gm, '');
  const ctl = read('Votive/UI/StatusItemController.swift');
  const app = read('Votive/AppDelegate.swift');
  assert.match(ctl, /defaults\.bool\(forKey: "portToolsOn"\)/, 'a plain bool: unset means off');
  assert.match(ctl, /if portToolsOn \{ menu\.addItem\(portsMenu\.menuItem\(\)\) \}/, 'nothing about ports is in the menu until it is on');
  assert.match(tools, /lsofArguments = \["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcun"\]/, 'fixed arguments');
  assert.match(tools, /URL\(fileURLWithPath: "\/usr\/sbin\/lsof"\)/);
  assert.ok(!/\/bin\/(sh|bash|zsh)|system\(|popen\(|osascript|-c"/.test(tools + paused + menu), 'no shell, no script');
  assert.ok(!/kill\(-|killpg|kill\(0,|SIGHUP|SIGUSR/.test(tools + paused), 'never a group or the whole session');
  // Command-line arguments (which can hold tokens) are never read.
  assert.ok(!/KERN_PROCARGS|PROC_PIDARGS|proc_pidinfo\(\s*\w+,\s*PROC_PIDTBSDINFO/.test(tools), 'no command-line arguments');
  // Every signal goes to one pid that was just re-verified (or one remembered and re-validated one).
  const sends = [...(tools + '\n' + paused).matchAll(/\bkill\(([^,)]+)/g)].map((m) => m[1]);
  assert.ok(sends.length >= 6 && sends.every((s) => s === 'live.pid' || s === 'entry.pid'), 'signals go to ' + sends);
  assert.match(tools, /guard let live = now\.first\(where: \{ \$0\.port == target\.port && \$0\.pid == target\.pid \}\)/);
  assert.match(tools, /let why = action == \.resume \? resumeRefusal\(for: live\) : refusal\(for: live, agentPIDs: agentPIDs\)\s*\n\s*if let why \{ return \.refused\(why\) \}/);
  assert.match(paused, /owner\(e\.pid\) == getuid\(\), isPaused\(e\.pid\)/, 'a remembered pid is re-checked before it is signalled');
  assert.match(paused, /abs\(started - e\.startedAt\) < 2/);
  // Confirmation first; Return is Cancel; force quit asks again; Pause asks once per program.
  assert.match(menu, /alert\.addButton\(withTitle: "Cancel"\)[\s\S]*alert\.addButton\(withTitle: "Pause"\)/);
  assert.match(menu, /alert\.addButton\(withTitle: "Cancel"\)[\s\S]*alert\.addButton\(withTitle: "Stop it"\)/);
  assert.match(menu, /alert\.addButton\(withTitle: "Leave it"\)[\s\S]*alert\.addButton\(withTitle: "Force quit"\)/);
  assert.match(menu, /guard alert\.runModal\(\) == \.alertSecondButtonReturn else \{ return \}\s*PortTools\.stop\(l,/);
  assert.match(menu, /PortTools\.stop\(l, force: true/);
  assert.match(menu, /if !confirmedPause\.contains\(l\.pid\)/);
  // Quitting never leaves a frozen program unnoticed.
  assert.match(app, /func applicationShouldTerminate/);
  assert.match(app, /"Resume them"[\s\S]*"Leave paused"[\s\S]*"Don't quit"/);
  assert.match(app, /isSystemShutdown\(\)[\s\S]*resumeAll\(\)/, 'a shutdown or logout resumes silently');
  assert.match(app, /PausedStore\.shared\.prune\(\)/);
  // Agents cannot reach it: nothing in the MCP server or the settings tool knows about it.
  for (const f of ['mcp-server/index.js', 'Scripts/overlay-settings.js', 'Scripts/mcp-guard.js']) {
    assert.ok(!/portTools|PortTools|ports\.json|paused\.json|SIGSTOP/.test(read(f)), f + ' must not expose the Ports tool');
  }
});
