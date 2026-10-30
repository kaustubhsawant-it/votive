'use strict';
//
// AGEN-22, app side: the menu shows what agents changed (from audit.jsonl) and can undo it. The risky
// part is undo: an audit line is a file that other programs running as the user could write, so the app
// must never turn it into anything but "put this known preference back to a sane value". This compiles
// Votive/Services/AgentChanges.swift on its own and checks exactly that; needs the Swift toolchain.
//
//   node --test tests/agent-changes.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let haveSwift = true;
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch (e) { haveSwift = false; }

test('agent changes: undo is an allow-list with validation; titles and times read well', { skip: !haveSwift && 'no Swift toolchain' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao changes '));
  const S = (n) => path.join(ROOT, 'Votive', 'Services', n);
  const lines = [
    'import Foundation',
    'func dec(_ j: String) -> AuditEntry { try! JSONDecoder().decode(AuditEntry.self, from: Data(j.utf8)) }',
    'func steps(_ j: String) -> String { guard let s = AgentChanges.undoSteps(for: dec(j)) else { return "nil" }; return s.map { "\\($0.key)=\\($0.value)" }.sorted().joined(separator: ",") }',
    'func set(_ undo: String, ok: String = "true", tool: String = "settings_set") -> String { "{\\"at\\":1,\\"tool\\":\\"\\(tool)\\",\\"ok\\":\\(ok),\\"undo\\":\\(undo)}" }',
    'print("bool", steps(set(#"{"popupOnEveryChange":{"from":true,"to":false}}"#)))',
    'print("int", steps(set(#"{"stuckThresholdMinutes":{"from":8,"to":20}}"#)))',
    'print("sound", steps(set(#"{"soundDone":{"from":"Hero","to":"none"},"soundNotify":{"from":"my song.mp3","to":"Glass"}}"#)))',
    'print("renamed", steps(set(#"{"colorblindShapes":{"from":false,"to":true},"usagePulse":{"from":true,"to":false},"notifyOnRequest":{"from":true,"to":false},"bannerOnEveryChange":{"from":false,"to":true},"sounds":{"from":true,"to":false}}"#)))',
    // things that must never be undone by the app
    'print("switch", steps(set(#"{"agentWritesAllowed":{"from":false,"to":true}}"#)))',
    'print("unknown", steps(set(#"{"nope":{"from":true,"to":false}}"#)))',
    'print("range", steps(set(#"{"stuckThresholdMinutes":{"from":999,"to":8}}"#)), steps(set(#"{"stuckThresholdMinutes":{"from":-1,"to":8}}"#)))',
    'print("types", steps(set(#"{"popupOnEveryChange":{"from":1,"to":false}}"#)), steps(set(#"{"stuckThresholdMinutes":{"from":true,"to":8}}"#)), steps(set(#"{"soundDone":{"from":"../x","to":"none"}}"#)), steps(set(#"{"soundDone":{"from":5,"to":"none"}}"#)))',
    'print("allornothing", steps(set(#"{"popupOnEveryChange":{"from":true,"to":false},"agentWritesAllowed":{"from":false,"to":true}}"#)))',
    'print("notok", steps(set(#"{"popupOnEveryChange":{"from":true,"to":false}}"#, ok: "false")))',
    'print("tools", steps(set(#"{"popupOnEveryChange":{"from":true,"to":false}}"#, tool: "repair")), steps(set(#"{"popupOnEveryChange":{"from":true,"to":false}}"#, tool: "notify")))',
    'print("empty", steps(set("{}")), steps("{\\"at\\":1,\\"tool\\":\\"settings_set\\",\\"ok\\":true}"))',
    // wording
    'let now = Date(timeIntervalSince1970: 1_800_000_000)',
    'let ms = { (secondsAgo: Double) -> Int64 in Int64((now.timeIntervalSince1970 - secondsAgo) * 1000) }',
    'print("ago", AgentChanges.ago(ms(3), now: now), AgentChanges.ago(ms(300), now: now), AgentChanges.ago(ms(7300), now: now), AgentChanges.ago(ms(3 * 86400 + 5), now: now), AgentChanges.ago(ms(-50), now: now))',
    'let e1 = dec("{\\"at\\":\\(ms(300)),\\"tool\\":\\"settings_set\\",\\"agent\\":\\"claude-code\\",\\"ok\\":true,\\"summary\\":\\"changed stuckThresholdMinutes: 8 \\u{2192} 20\\"}")',
    'print("title", AgentChanges.menuTitle(for: e1, now: now))',
    'let e2 = dec("{\\"at\\":\\(ms(60)),\\"tool\\":\\"repair\\",\\"agent\\":\\"codex\\",\\"ok\\":false,\\"summary\\":\\"refused: agent changes are switched off\\"}")',
    'print("refused", AgentChanges.menuTitle(for: e2, now: now))',
    'let long = dec("{\\"at\\":\\(ms(10)),\\"tool\\":\\"settings_set\\",\\"agent\\":\\"gemini\\",\\"ok\\":true,\\"summary\\":\\"\\(String(repeating: "x", count: 300))\\"}")',
    'print("clip", AgentChanges.menuTitle(for: long, now: now).count <= 90)',
    'let p = AgentChanges.panel(for: e1)',
    'print("panel", p.title, "|", p.body.contains("stuckThresholdMinutes: 8"), p.body.contains("Agent changes"))',
    'let weird = dec("{\\"at\\":1,\\"tool\\":\\"settings_set\\",\\"agent\\":\\"evil\\\\u0007\\\\u202eagent\\",\\"ok\\":true,\\"summary\\":\\"s\\"}")',
    'print("weird", AgentChanges.panel(for: weird).title.unicodeScalars.contains { $0.value < 32 || $0.value == 0x202e })',
  ];
  fs.writeFileSync(path.join(d, 'main.swift'), lines.join('\n'));
  const exe = path.join(d, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, S('AgentChanges.swift'), S('AuditLog.swift'), S('BoundedRead.swift'), S('Paths.swift'), path.join(d, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
  assert.equal(out.bool, 'dialogAlertsOn=bool(true)');
  assert.equal(out.int, 'stuckThresholdMinutes=int(8)');
  assert.equal(out.sound, 'soundDone=text(Hero),soundNotify=text(my song.mp3)');
  assert.equal(out.renamed, 'customNotifyOn=bool(true),notificationsOn=bool(false),shapesMode=bool(false),soundsOn=bool(true),usageAlertOn=bool(true)');
  assert.equal(out.switch, 'nil', 'an audit line must never make the app flip the master switch');
  assert.equal(out.unknown, 'nil');
  assert.equal(out.range, 'nil nil');
  assert.equal(out.types, 'nil nil nil nil');
  assert.equal(out.allornothing, 'nil', 'one bad entry cancels the whole undo');
  assert.equal(out.notok, 'nil');
  assert.equal(out.tools, 'nil nil', 'repairs and notifications cannot be undone');
  assert.equal(out.empty, 'nil nil');
  assert.equal(out.ago, 'just now 5m ago 2h ago 3d ago just now');
  assert.equal(out.title, 'Claude Code · 5m ago: changed stuckThresholdMinutes: 8 → 20');
  assert.equal(out.refused, 'Codex · 1m ago: refused: agent changes are switched off');
  assert.equal(out.clip, 'true');
  assert.match(out.panel, /^Claude Code changed a setting \| true true$/);
  assert.equal(out.weird, 'false', 'control and bidi characters from the audit file never reach a panel title');
});
