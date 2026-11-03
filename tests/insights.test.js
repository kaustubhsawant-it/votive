'use strict';
//
// The insights card's logic (Votive/Services/VotiveInsights.swift) is compiled and run on made-up situations: what is
// shown, in which order, in which words, and what is never shown. Every
// line needs a real condition, critical first, "all clear" only when nothing is urgent, tips last, at most six.
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
import Foundation
func s(_ n: String, _ st: AgentState) -> AgentSession { AgentSession(id: n, agent: "claude-code", sessionId: n, pid: 1, name: n, cwd: "/", state: st, startedAt: 1, lastActivityAt: 1, recap: nil, transcriptPath: nil, pendingNotify: nil) }
let now = Date(timeIntervalSince1970: 1_800_000_000)
func lim(_ label: String, _ used: Double, ageHours: Double = 0.1) -> LimitReading { LimitReading(agent: "Claude Code", label: label, used: used, resetsAt: now.addingTimeInterval(86400), updatedAt: now.addingTimeInterval(-ageHours * 3600)) }
func fc(_ projected: Double, target: Double = 80, days: Int = 6, enough: Bool = false, backtestDays: Int = 6) -> UsageHabits.Report {
  var r = UsageHabits.Report(); r.target = target; r.samples = 100; r.daysSeen = days
  r.forecast = UsageHabits.Forecast(used: 20, resetsAt: 0, hoursLeft: 24, expectedMore: projected - 20, projected: projected, low: projected * 0.6, high: projected * 1.6, spare: max(0, target - projected), over: max(0, projected - target))
  r.rhythm = UsageHabits.Rhythm(peakStart: 20, peakEnd: 0, peakShare: 0.75, weekdayPerDay: 9, weekendPerDay: 63, weekdayDaytimeShare: 0.01, totalPoints: 300, byHour: [])
  r.backtest = UsageHabits.Backtest(days: backtestDays, enough: enough, maeModel: 1, maeBaseline: 2, beatsBaseline: true)
  return r
}
func run(_ name: String, _ x: InsightInputs) {
  var i = x; i.now = now; i.resetText = { _ in "Mon" }
  let out = VotiveInsights.compute(i)
  print(name + "|" + out.map { "\\($0.id)~\\($0.tone.label)~\\($0.title)~\\($0.body)~\\($0.target.rawValue)" }.joined(separator: "|"))
}
run("empty", InsightInputs())
run("calm", InsightInputs(sessions: [s("a", .working), s("b", .done)], limits: [lim("Session", 9), lim("Weekly", 30)]))
run("calmOne", InsightInputs(sessions: [s("a", .done)]))
run("limitsOnly", InsightInputs(limits: [lim("Weekly", 30)]))
run("stopped", InsightInputs(sessions: [s("a", .stopped), s("b", .working)]))
run("needs", InsightInputs(sessions: [s("a", .needsInput), s("b", .needsInput), s("c", .needsInput), s("d", .done)]))
run("two", InsightInputs(sessions: [s("a", .needsInput), s("b", .needsInput)]))
run("errstuck", InsightInputs(sessions: [s("a", .warning), s("b", .stuck)]))
run("limit74", InsightInputs(limits: [lim("Weekly", 74)]))
run("limit93", InsightInputs(limits: [lim("Session", 93), lim("Weekly", 20)]))
run("limit70", InsightInputs(limits: [lim("Weekly", 70)]))
run("runout", InsightInputs(report: fc(172)))
run("over", InsightInputs(report: fc(92)))
run("spare", InsightInputs(report: fc(60)))
run("near", InsightInputs(report: fc(78)))
run("changes", InsightInputs(agentChanges: 2))
run("changesOne", InsightInputs(agentChanges: 1))
run("stale", InsightInputs(limits: [lim("Weekly", 30, ageHours: 8)]))
run("learned", InsightInputs(report: fc(78, days: 20, enough: true, backtestDays: 20)))
run("many", InsightInputs(sessions: [s("a", .stopped), s("b", .needsInput), s("c", .warning), s("d", .stuck)], limits: [lim("Session", 95), lim("Weekly", 75)], report: fc(172), agentChanges: 3))
`;

function insights() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao insights '));
  fs.writeFileSync(path.join(d, 'main.swift'), MAIN);
  const exe = path.join(d, 'insights');
  const files = ['Services/VotiveInsights.swift', 'Services/UsageHabits.swift', 'Services/UsageStore.swift', 'Services/DirectoryWatcher.swift', 'Services/BoundedRead.swift', 'Services/Paths.swift',
    'Models/AgentSession.swift', 'Models/AgentState.swift', 'Models/OverlayEntry.swift'].map((f) => V(f));
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, ...files, path.join(d, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const out = {};
  for (const line of spawnSync(exe, [], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) {
    const [name, ...rows] = line.split('|');
    out[name] = rows.filter(Boolean).map((r) => { const [id, tone, title, body, target] = r.split('~'); return { id, tone, title, body, target }; });
  }
  fs.rmSync(d, { recursive: true, force: true });
  return out;
}

test('insights: a line exists only when its condition holds, ranked critical, warning, all clear, tips', { skip }, () => {
  const o = insights();
  assert.deepEqual(o.empty, [], 'no data at all: no card');
  assert.deepEqual(o.limitsOnly.map((i) => i.id), ['all-clear'], 'limits alone are enough to say all clear');

  assert.deepEqual(o.calm.map((i) => i.id), ['all-clear']);
  assert.equal(o.calm[0].title, 'Everything looks normal');
  assert.equal(o.calm[0].body, '2 sessions, none need you and every limit is under 70%.');
  assert.equal(o.calmOne[0].body, '1 session, none need you.', 'singular, and no limit clause without a limit');

  assert.deepEqual(o.stopped.map((i) => [i.id, i.tone]), [['sessions-stopped', 'Critical']]);
  assert.equal(o.stopped[0].title, '1 session stopped');
  assert.equal(o.stopped[0].body, 'a is no longer running.');
  assert.ok(!o.stopped.some((i) => i.tone === 'All clear'), 'never "all clear" next to a critical line');

  assert.equal(o.needs[0].title, '3 sessions need you');
  assert.equal(o.needs[0].body, 'a and 2 more are waiting for you.', 'names the worst and counts the rest');
  assert.equal(o.two[0].body, 'a and b are waiting for you.');
  assert.deepEqual(o.errstuck.map((i) => i.title), ['1 session hit an error', '1 session looks stuck']);
});

test('insights: limits are warning above 70% and critical above 90%, and carry where they reset', { skip }, () => {
  const o = insights();
  assert.deepEqual(o.limit70.map((i) => i.id), ['all-clear'], 'exactly 70% is not over the alert level');
  assert.deepEqual(o.limit74.map((i) => [i.tone, i.title, i.body, i.target]), [['Warning', 'Weekly limit at 74%', 'Claude Code resets Mon.', 'forecast']]);
  assert.deepEqual(o.limit93.map((i) => [i.tone, i.title, i.target]), [['Critical', 'Session limit at 93%', 'overview']]);
  assert.match(o.limit93[0].body, /Move big jobs after it\./);
});

test('insights: the forecast speaks only when the model has one, and never prints an absurd range', { skip }, () => {
  const o = insights();
  assert.equal(o.runout.find((i) => i.id === 'forecast-runout').tone, 'Warning');
  assert.equal(o.runout.find((i) => i.id === 'forecast-runout').body, 'At this pace you would be well past the limit before the reset.');
  assert.ok(!/\b[2-9][0-9][0-9]%/.test(o.runout.find((i) => i.id === 'forecast-runout').body), 'no 172% or 275% in the copy');
  assert.equal(o.over.find((i) => i.id === 'forecast-over').body, 'About 12% over your 80% target at the reset.');
  assert.equal(o.spare.find((i) => i.id === 'forecast-spare').tone, 'Tip');
  assert.match(o.spare.find((i) => i.id === 'forecast-spare').body, /About 20% of the week may go unused\. A longer job around 20:00 would use it\./);
  assert.ok(!o.near.some((i) => i.id.startsWith('forecast-')), 'close to target: nothing to say about it');
});

test('insights: tips come last and are honest about how much has been learned', { skip }, () => {
  const o = insights();
  const near = o.near.map((i) => i.id);
  assert.deepEqual(near, ['tip-hours', 'tip-learning'], 'with no sessions and no limits there is nothing to be clear about');
  assert.equal(o.near.find((i) => i.id === 'tip-hours').body, '75% of your use falls between 20:00 and 00:00.');
  assert.equal(o.near.find((i) => i.id === 'tip-learning').body, '6 whole days seen. The forecast is a rough guide until 14.');
  assert.ok(!o.learned.some((i) => i.id === 'tip-learning'), 'once it has beaten an average day over enough days it stops saying it is learning');
  assert.deepEqual(o.changes.map((i) => [i.title, i.target]), [['2 settings changed by agents', 'agents']]);
  assert.equal(o.changesOne[0].title, '1 setting changed by agents');
  assert.equal(o.stale.find((i) => i.id === 'tip-stale').body, 'Last updated 8 h ago. They refresh when an agent replies.');
});

test('insights: at most six, most urgent first, and every line is short enough for a narrow card', { skip }, () => {
  const o = insights();
  assert.equal(o.many.length, 6);
  const tones = o.many.map((i) => i.tone);
  const order = ['Critical', 'Warning', 'All clear', 'Tip'];
  assert.deepEqual(tones, [...tones].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'ranked by tone');
  assert.equal(o.many[0].tone, 'Critical');
  for (const list of Object.values(o)) for (const i of list) {
    assert.ok(i.title.length <= 34, 'title too long: ' + i.title);
    assert.ok(i.body.length <= 110, 'body too long (' + i.body.length + '): ' + i.body);
  }
});
