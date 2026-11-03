'use strict';
//
// High-priority sessions: pinned sessions sort first (menu and dots), survive the 6-dot cap, and can be the
// only ones that alert. The ordering, the alert rule and the stored list are compiled and run; the wiring
// is checked in the source. Preferences go to a scratch suite, never the real app's.
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

test('priority: pinned sessions come first, in pin order; the rest keep their order', { skip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao prio '));
  fs.writeFileSync(path.join(d, 'main.swift'), [
    'import Foundation',
    'func s(_ id: String, _ start: Int64, _ cwd: String = "/") -> AgentSession { AgentSession(id: id, agent: "claude-code", sessionId: id, pid: 1, name: id, cwd: cwd, state: .working, startedAt: start, lastActivityAt: start, recap: nil, transcriptPath: nil, pendingNotify: nil) }',
    'func ids(_ x: [AgentSession]) -> String { x.map { $0.id }.joined(separator: ",") }',
    'let all = [s("a", 1), s("b", 2), s("c", 3), s("d", 4)]',
    'print("none", ids(SessionPriority.order(all, pins: [:])))',
    'print("one", ids(SessionPriority.order(all, pins: ["c": 100])))',
    'print("two", ids(SessionPriority.order(all, pins: ["d": 50, "b": 100])), "|", ids(SessionPriority.order(all, pins: ["d": 200, "b": 100])))',
    'print("unknown", ids(SessionPriority.order(all, pins: ["zzz": 1])))',
    'print("tie", ids(SessionPriority.order(all, pins: ["d": 10, "c": 10])))',
    'print("count", SessionPriority.pinnedCount(all, pins: ["a": 1, "d": 2, "zzz": 3]))',
    'print("alert", SessionPriority.shouldAlert(all[0], onlyPriority: false, pins: [:]), SessionPriority.shouldAlert(all[0], onlyPriority: true, pins: [:]), SessionPriority.shouldAlert(all[0], onlyPriority: true, pins: ["a": 5]), SessionPriority.shouldAlert(all[1], onlyPriority: true, pins: ["a": 5]))',
    // folder rules: every session started in a marked folder is high priority
    'let fs = [s("a", 1, "/p/a"), s("b", 2, "/p/b"), s("c", 3, "/p/b/"), s("d", 4, "/p/d"), s("e", 5, "")]',
    'print("folder", ids(SessionPriority.order(fs, pins: [:], folders: ["/p/b": 100])), "|", ids(SessionPriority.order(fs, pins: ["d": 50], folders: ["/p/b": 100])), "|", ids(SessionPriority.order(fs, pins: [:], folders: ["/p/b": 100, "/p/d": 90])))',
    'print("subfolder", ids(SessionPriority.order([s("x", 1, "/p/b/inner"), s("y", 2, "/p/b")], pins: [:], folders: ["/p/b": 1])), "|", SessionPriority.pinnedCount(fs, pins: [:], folders: ["/p/b": 1]))',
    'print("norm", SessionPriority.normalize("/p/b/"), SessionPriority.normalize("/p/b//"), SessionPriority.normalize("/"), SessionPriority.normalize("  /x  "))',
    'print("falert", SessionPriority.shouldAlert(fs[1], onlyPriority: true, pins: [:], folders: ["/p/b": 1]), SessionPriority.shouldAlert(fs[0], onlyPriority: true, pins: [:], folders: ["/p/b": 1]), SessionPriority.shouldAlert(fs[4], onlyPriority: true, pins: [:], folders: ["": 1, "/": 1]))',
    'let fdirty: [String: Any] = ["/ok": 5.0, "relative/path": 5.0, "": 1.0, "/neg": -1.0, "/long" + String(repeating: "x", count: 1030): 2.0]',
    'print("fclean", SessionPriority.cleanFolders(fdirty).keys.sorted(), SessionPriority.cleanFolders(Dictionary(uniqueKeysWithValues: (1...80).map { ("/f\\($0)", Double($0)) })).count)',
    'let big = Dictionary(uniqueKeysWithValues: (1...80).map { ("k\\($0)", Double($0)) })',
    'let cleanedBig = SessionPriority.clean(big)',
    'print("cap", cleanedBig.count, cleanedBig["k80"] != nil, cleanedBig["k30"] == nil, cleanedBig["k31"] != nil)',
    'let dirty: [String: Any] = ["ok": 5.0, "": 1.0, "neg": -3.0, "zero": 0.0, "str": "x", "nan": Double.nan, "inf": Double.infinity, String(repeating: "x", count: 301): 2.0, "int": 7]',
    'print("clean", SessionPriority.clean(dirty).keys.sorted())',
    'print("notdict", SessionPriority.clean("nope").count, SessionPriority.clean(nil).count, SessionPriority.clean([1, 2]).count)',
    'let now = 2_000_000.0',
    'let day = 86_400.0',
    'let p = ["live": 1.0, "recent": now - 13 * day, "old": now - 15 * day, "fresh": now - 5]',
    'print("prune", SessionPriority.pruned(p, live: ["live"], now: now).keys.sorted())',
    // the store, on a scratch suite
    'let suite = "dev.votive.test.priority.\\(getpid())"',
    'let ud = UserDefaults(suiteName: suite)!',
    'let store = PriorityStore(defaults: ud)',
    'print("store0", store.pins.count, store.onlyPriorityAlerts)',
    'print("on", store.toggle("x", now: Date(timeIntervalSince1970: 1000)), store.isPinned("x"), store.pins["x"] ?? 0)',
    'print("persist", PriorityStore(defaults: UserDefaults(suiteName: suite)!).isPinned("x"))',
    'print("off", store.toggle("x"), store.isPinned("x"), store.pins.count)',
    'store.toggle("old", now: Date(timeIntervalSince1970: 1000)); store.toggle("keep", now: Date())',
    'store.prune(live: [], now: Date())',
    'print("storePrune", store.pins.keys.sorted())',
    'ud.set(true, forKey: SessionPriority.onlyKey)',
    'print("only", store.onlyPriorityAlerts)',
    'ud.set("garbage", forKey: SessionPriority.pinsKey)',
    'print("garbage", store.pins.count)',
    'print("fstore", store.folders.count, store.toggleFolder("/p/b/", now: Date(timeIntervalSince1970: 7)), store.isFolderMarked("/p/b"), store.isFolderMarked("/p/b/"), store.folders)',
    'print("fpersist", PriorityStore(defaults: UserDefaults(suiteName: suite)!).isFolderMarked("/p/b"), store.toggleFolder("relative"), store.toggleFolder(""), store.folders.count)',
    'print("fhigh", store.isHighPriority(s("q", 1, "/p/b")), store.isHighPriority(s("q", 1, "/p/other")))',
    'print("foff", store.toggleFolder("/p/b"), store.folders.count)',
    'ud.set(["/p/z": "nope", "x": 1], forKey: SessionPriority.foldersKey)',
    'print("fgarbage", store.folders.count)',
    'UserDefaults.standard.removePersistentDomain(forName: suite)',
    'ud.removePersistentDomain(forName: suite)',
    // hand-set order: moves stay inside the priority group and never pin or unpin
    'let five = [s("a", 1), s("b", 2), s("c", 3), s("d", 4), s("e", 5)]',
    'let pp: [String: Double] = ["d": 10, "e": 20]',
    'let shown = SessionPriority.order(five, pins: pp)',
    'print("base", ids(shown))',
    'let m1 = SessionPriority.moved("c", by: -1, displayed: shown, pins: pp)',
    'print("moveUp", m1.map { $0.joined(separator: ",") } ?? "nil", ids(SessionPriority.order(five, pins: pp, positions: m1 ?? [])))',
    'print("edgeTop", SessionPriority.moved("d", by: -1, displayed: shown, pins: pp) == nil, SessionPriority.moved("c", by: -1, displayed: SessionPriority.order(five, pins: pp, positions: m1 ?? []), pins: pp) != nil)',
    'print("groupWall", SessionPriority.moved("a", by: -1, displayed: shown, pins: pp) == nil, SessionPriority.moved("e", by: 1, displayed: shown, pins: pp) == nil, SessionPriority.canMove("a", by: -1, displayed: shown, pins: pp))',
    'let m2 = SessionPriority.moved("e", by: -1, displayed: shown, pins: pp)',
    'print("pinnedSwap", ids(SessionPriority.order(five, pins: pp, positions: m2 ?? [])))',
    'print("newcomer", ids(SessionPriority.order(five + [s("f", 6)], pins: pp, positions: m1 ?? [])))',
    'print("unpin", ids(SessionPriority.order(five, pins: [:], positions: m1 ?? [])))',
    'print("keepStale", SessionPriority.moved("c", by: -1, displayed: shown, pins: pp, stored: ["zzz", "c"])?.last ?? "nil")',
    'print("missing", SessionPriority.moved("nope", by: 1, displayed: shown, pins: pp) == nil, SessionPriority.moved("c", by: 0, displayed: shown, pins: pp) == nil)',
    'print("cleanOrder", SessionPriority.cleanOrder(["a", "", "a", 3, "b", String(repeating: "x", count: 301)]), SessionPriority.cleanOrder("no"), SessionPriority.cleanOrder((1...150).map { "k\\($0)" }).count)',
    'let ostore = PriorityStore(defaults: UserDefaults(suiteName: "dev.votive.test.order.\\(getpid())")!)',
    'ostore.setPositions(["b", "a"])',
    'print("ostore", ostore.positions, ostore.pins.count, ostore.folders.count)',
    'ostore.setPositions([])',
    'print("oreset", ostore.positions.count)',
    'ostore.defaults.set("garbage", forKey: SessionPriority.orderKey)',
    'print("ogarbage", ostore.positions.count)',
    'ostore.defaults.removePersistentDomain(forName: "dev.votive.test.order.\\(getpid())")',
    // the dot cap
    'func show(_ x: [AgentState], _ p: Int) -> String { AgentState.menuBarSelection(x, max: 6, protectFirst: p).map { $0.rawValue }.joined(separator: ",") }',
    'let seven: [AgentState] = [.done, .done, .working, .working, .working, .working, .needsInput]',
    'print("cap0", show(seven, 0))',
    'print("cap2", show(seven, 2))',
    'let lowFirst: [AgentState] = [.done, .working, .working, .working, .working, .working, .working, .needsInput]',
    'print("capKeep", show(lowFirst, 1).hasPrefix("done,"), show(lowFirst, 1).contains("needsInput"))',
    'print("capAll", show(lowFirst, 9).split(separator: ",").count, show(lowFirst, 9).contains("needsInput"))',
    'print("small", show([.done, .working], 1))',
  ].join('\n'));
  const exe = path.join(d, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, V('Services/SessionPriority.swift'), V('Models/AgentSession.swift'), V('Models/AgentState.swift'), V('Models/OverlayEntry.swift'), path.join(d, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
  assert.equal(out.none, 'a,b,c,d');
  assert.equal(out.one, 'c,a,b,d', 'a pinned session jumps to the front, the others keep their order');
  assert.equal(out.two, 'd,b,a,c | b,d,a,c', 'pinned ones are ordered by when they were pinned');
  assert.equal(out.unknown, 'a,b,c,d', 'a pin for a session that is not running changes nothing');
  assert.equal(out.tie, 'c,d,a,b', 'equal pin times fall back to start order');
  assert.equal(out.count, '2');
  assert.equal(out.alert, 'true false true false', 'only-priority mode: only a pinned session may alert');
  assert.equal(out.cap, '50 true true true', 'the list is capped at 50, keeping the newest');
  assert.equal(out.clean, '["int", "ok"]', 'bad keys and bad times are ignored');
  assert.equal(out.notdict, '0 0 0');
  assert.equal(out.prune, '["fresh", "live", "recent"]', 'live and recent pins stay, a pin unused for 15 days goes');
  assert.equal(out.store0, '0 false');
  assert.equal(out.on, 'true true 1000.0');
  assert.equal(out.persist, 'true', 'a pin survives the app restarting');
  assert.equal(out.off, 'false false 0');
  assert.equal(out.storePrune, '["keep"]');
  assert.equal(out.only, 'true');
  assert.equal(out.garbage, '0', 'a damaged preference is ignored, not trusted');
  assert.match(out.cap0, /needsInput$/, 'without pins the urgent dot is shown (as before)');
  assert.equal(out.cap2.split(',').slice(0, 2).join(','), 'done,done', 'protected dots keep their seats and their place');
  assert.ok(out.cap2.includes("needsInput"));
  assert.equal(out.capKeep, 'true true', 'a pinned dot is kept even when it is the calmest one');
  assert.equal(out.capAll, '6 false', 'if everything is pinned the cap still holds');
  assert.equal(out.small, 'done,working');
  // folder rules
  assert.equal(out.folder, 'b,c,a,d,e | d,b,c,a,e | d,b,c,a,e', 'sessions in a marked folder come first, ordered by when the pin or rule was made');
  assert.equal(out.subfolder, 'y,x | 2', 'only the exact folder matches, not a folder inside it');
  assert.equal(out.norm, '/p/b /p/b / /x');
  assert.equal(out.falert, 'true false false', 'a folder rule counts for alerts; no cwd never matches');
  assert.equal(out.fclean, '["/ok"] 50', 'only absolute paths are kept, capped at 50');
  assert.equal(out.fstore, '0 true true true ["/p/b": 7.0]', 'a trailing slash is the same folder');
  assert.equal(out.fpersist, 'true false false 1', 'it survives a restart; a relative or empty path is refused');
  assert.equal(out.fhigh, 'true false');
  assert.equal(out.foff, 'false 0');
  assert.equal(out.fgarbage, '0', 'damaged folder rules are ignored');
  // hand-set order
  assert.equal(out.base, 'd,e,a,b,c');
  assert.equal(out.moveUp, 'd,e,a,c,b d,e,a,c,b', 'moving c earlier swaps it with b, inside the unpinned group');
  assert.equal(out.edgeTop, 'true true', 'the first of its group cannot move earlier; a moved session can move again');
  assert.equal(out.groupWall, 'true true false', 'a move never crosses from unpinned to pinned or back, so priority is untouched');
  assert.equal(out.pinnedSwap, 'e,d,a,b,c', 'pinned sessions can be reordered among themselves');
  assert.equal(out.newcomer, 'd,e,a,c,b,f', 'a new session joins the end of its group');
  assert.equal(out.unpin, 'd,e,a,c,b', 'the hand-set order survives a change of pins');
  assert.equal(out.keepStale, 'zzz', 'older entries stay after the shown ones');
  assert.equal(out.missing, 'true true');
  assert.equal(out.cleanOrder, '["a", "b"] [] 100', 'bad entries are dropped, repeats removed, capped at 100');
  assert.equal(out.ostore, '["b", "a"] 0 0', 'the order is stored on its own, apart from pins and folders');
  assert.equal(out.oreset, '0');
  assert.equal(out.ogarbage, '0', 'a damaged preference is ignored');
});

test('priority: the wiring: sort once for menu and dots, filter automatic alerts only, never reachable by an agent', () => {
  const ctl = read('Votive/UI/StatusItemController.swift');
  const row = read('Votive/UI/AgentRowView.swift');
  // one ordered list feeds both the rows and the dots
  assert.match(ctl, /let sessions = SessionPriority\.order\(incoming, pins: pins, folders: folders, positions: priority\.positions\)/);
  assert.match(ctl, /protectFirst: pinnedCount/);
  assert.match(ctl, /sessions = SessionPriority\.order\(rawSessions, pins: pins, folders: folders, positions: priority\.positions\)/, 'unpinning restores the original order');
  assert.match(ctl, /High priority: every session in this folder, now and later/);
  assert.match(ctl, /menu\.autoenablesItems = false/, 'a greyed Move item stays greyed');
  assert.match(ctl, /Move earlier/);
  assert.match(ctl, /Move later/);
  // the filter is on automatic alerts and sounds, not on a message a person asked a session to send
  assert.match(ctl, /guard SessionPriority\.shouldAlert\(s, onlyPriority: onlyPriority, pins: pins, folders: folders\) else \{ continue \}/);
  const notify = /private func detectPendingNotifies[\s\S]*?\n    \}/.exec(ctl)[0];
  assert.ok(!/shouldAlert|alertsOnlyPriority/.test(notify), 'a requested notify is never filtered');
  // off by default, and a plain bool
  assert.match(ctl, /get \{ defaults\.bool\(forKey: SessionPriority\.onlyKey\) \}/);
  assert.match(ctl, /Only alert for high-priority sessions/);
  assert.match(ctl, /High priority: this session/);
  assert.match(row, /pinned: Bool = false/);
  // agents cannot set it
  for (const f of ['mcp-server/index.js', 'Scripts/overlay-settings.js', 'Scripts/mcp-guard.js']) {
    assert.ok(!/prioritySessions|priorityFolders|alertsOnlyPriority|sessionOrder|SessionPriority/.test(read(f)), f + ' must not expose session priority');
  }
});
