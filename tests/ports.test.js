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

function compile(dir, main, files) {
  fs.writeFileSync(path.join(dir, 'main.swift'), main.join('\n'));
  const exe = path.join(dir, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, ...files.map(S), path.join(dir, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  return exe;
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

test('ports: the menu shows free and busy ports, and disables stopping an agent session', { skip }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao ports menu '));
  const file = path.join(d, 'ports.json');
  const child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res, rej) => { child.stdout.once('data', (b) => res(Number(String(b).trim()))); setTimeout(() => rej(new Error('no port')), 5000); });
    const exe = compile(d, [
      'import AppKit',
      'let args = CommandLine.arguments',
      'let menu = PortsMenu(watchList: PortWatchList(fileURL: URL(fileURLWithPath: args[1])), agentPIDs: { Set(args.count > 2 ? [Int32(args[2])!] : []) })',
      'func dump(_ m: NSMenu, _ indent: String = "") {',
      '  for i in m.items {',
      '    print(indent + (i.isSeparatorItem ? "---" : i.title) + (i.isEnabled || i.isSeparatorItem ? "" : " [disabled]"))',
      '    if let s = i.submenu { dump(s, indent + "  ") }',
      '  }',
      '}',
      'print("root", menu.menuItem().title)',
      'dump(menu.menuItem().submenu!)',
      'extension Timer { static func commonModeTimer(interval: TimeInterval, repeats: Bool, block: @escaping (Timer) -> Void) -> Timer { Timer.scheduledTimer(withTimeInterval: interval, repeats: repeats, block: block) } }',
    ], ['PortsMenu.swift', 'PortScan.swift', 'PortTools.swift', 'Paths.swift', 'BoundedRead.swift', 'DialogAlerter.swift'].map((f, i) => (i === 0 ? '../UI/' : '') + f).concat(['../UI/NotifyPanel.swift']));
    const dump = (args) => spawnSync(exe, [file, ...args], { encoding: 'utf8', timeout: 20000 });
    fs.writeFileSync(file, JSON.stringify([port, 59999]));
    const a = dump([]);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, new RegExp(`${port}  ·  node \\(pid ${child.pid}\\)\n  Stop node \\(pid ${child.pid}\\)…\n`), 'a busy port names the program and offers to stop it');
    assert.match(a.stdout, /59999  ·  free\n  Stop watching 59999/, 'a free port can only be unwatched');
    assert.ok(!/Stop node.*\[disabled\]/.test(a.stdout));
    const b = dump([String(child.pid)]);
    assert.match(b.stdout, new RegExp(`Stop node \\(pid ${child.pid}\\)… \\[disabled\\]`), 'an agent session cannot be stopped from the menu');
    fs.writeFileSync(file, '[]');
    assert.match(dump([]).stdout, /No ports yet \[disabled\]\nWatch 3000, 5173, 8000, 8080/);
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* already stopped */ }
  }
});

test('ports: it is off by default, opens no socket, uses no shell and signals one process only', () => {
  const tools = read('Votive/Services/PortTools.swift').replace(/\/\/.*$/gm, '');
  const menu = read('Votive/UI/PortsMenu.swift').replace(/\/\/.*$/gm, '');
  const ctl = read('Votive/UI/StatusItemController.swift');
  assert.match(ctl, /defaults\.bool\(forKey: "portToolsOn"\)/, 'a plain bool: unset means off');
  assert.match(ctl, /if portToolsOn \{ menu\.addItem\(portsMenu\.menuItem\(\)\) \}/, 'nothing about ports is in the menu until it is on');
  assert.match(tools, /lsofArguments = \["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcun"\]/, 'fixed arguments');
  assert.match(tools, /URL\(fileURLWithPath: "\/usr\/sbin\/lsof"\)/);
  assert.ok(!/\/bin\/(sh|bash|zsh)|system\(|popen\(|osascript|-c"/.test(tools + menu), 'no shell, no script');
  assert.ok(!/kill\(-|killpg|kill\(0,|kill\(pid, SIGSTOP|SIGHUP/.test(tools), 'never a group or the whole session');
  const kills = tools.match(/\bkill\([^,)]+/g) || [];
  assert.ok(kills.length >= 2 && kills.every((k) => k === 'kill(live.pid'), 'every signal goes to the one verified pid: ' + kills);
  // The signal is checked against the live system first and goes to one pid.
  assert.match(tools, /guard let live = now\.first\(where: \{ \$0\.port == target\.port && \$0\.pid == target\.pid \}\)/);
  assert.match(tools, /if let why = refusal\(for: live, agentPIDs: agentPIDs\) \{ return \.refused\(why\) \}/);
  // Confirmation first; Return is Cancel; force quit asks again.
  assert.match(menu, /alert\.addButton\(withTitle: "Cancel"\)[\s\S]*alert\.addButton\(withTitle: "Stop it"\)/);
  assert.match(menu, /alert\.addButton\(withTitle: "Leave it"\)[\s\S]*alert\.addButton\(withTitle: "Force quit"\)/);
  assert.match(menu, /guard alert\.runModal\(\) == \.alertSecondButtonReturn else \{ return \}\s*PortTools\.stop\(l,/);
  assert.match(menu, /PortTools\.stop\(l, force: true/);
  // Agents cannot reach it: nothing in the MCP server or the settings tool knows about it.
  for (const f of ['mcp-server/index.js', 'Scripts/overlay-settings.js', 'Scripts/mcp-guard.js']) {
    assert.ok(!/portTools|PortTools|ports\.json/.test(read(f)), f + ' must not expose the Ports tool');
  }
});
