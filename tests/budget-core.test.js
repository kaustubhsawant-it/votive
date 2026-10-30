'use strict';
//
// The pure logic of the Claude Code budget mod (AGEN-45, TDD 1-5 and 35-41). No I/O, no clock of its
// own: every function takes what it needs. The module is an ES module so the mod and these tests
// load the same file.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const url = require('url');

const CORE = url.pathToFileURL(path.join(__dirname, '..', 'mods', 'votive-budget', 'hooks', 'budget-core.mjs')).href;
const load = () => import(CORE);

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600e3;
const limits = (s, w) => [
  { kind: 'five_hour', percentUsed: s, resetsAt: iso(NOW + 2 * HOUR) },
  { kind: 'seven_day', percentUsed: w, resetsAt: iso(NOW + 3 * 24 * HOUR) },
];

test('state: below the levels is ok, 85 conserves, 97 is critical', async () => {
  const { budgetState } = await load();
  assert.equal(budgetState(limits(10, 10), {}, NOW).level, 'ok');
  assert.equal(budgetState(limits(85, 10), {}, NOW).level, 'conserve');
  assert.equal(budgetState(limits(97, 10), {}, NOW).level, 'critical');
});

test('state: boundaries are inclusive and not off by one', async () => {
  const { budgetState } = await load();
  assert.equal(budgetState(limits(84, 0), {}, NOW).level, 'ok');
  assert.equal(budgetState(limits(84.9, 0), {}, NOW).level, 'ok');
  assert.equal(budgetState(limits(85, 0), {}, NOW).level, 'conserve');
  assert.equal(budgetState(limits(96, 0), {}, NOW).level, 'conserve');
  assert.equal(budgetState(limits(97, 0), {}, NOW).level, 'critical');
});

test('state: the weekly level is off until set', async () => {
  const { budgetState } = await load();
  assert.equal(budgetState(limits(0, 99), {}, NOW).level, 'ok', 'weekly ignored by default');
  assert.equal(budgetState(limits(0, 81), { weeklyAt: 80 }, NOW).level, 'conserve');
  assert.equal(budgetState(limits(0, 79), { weeklyAt: 80 }, NOW).level, 'ok');
});

test('state: hostile numbers and shapes give ok and never throw', async () => {
  const { budgetState } = await load();
  const bad = [NaN, -5, 101, 1e9, Infinity, '90', null, undefined, {}, [], true];
  for (const v of bad) {
    const r = budgetState(limits(v, v), { sessionAt: 85, weeklyAt: 80 }, NOW);
    assert.equal(r.level, 'ok', `value ${String(v)}`);
  }
  for (const rl of [null, undefined, 'x', 7, {}, [], [null], [1], [{}], [{ kind: 'five_hour' }]]) {
    assert.equal(budgetState(rl, {}, NOW).level, 'ok');
  }
  for (const st of [null, undefined, 'x', { sessionAt: 'a' }, { sessionAt: -1 }, { sessionAt: 0 }, { sessionAt: 1e9 }, { weeklyAt: NaN }]) {
    assert.doesNotThrow(() => budgetState(limits(90, 90), st, NOW));
  }
  assert.equal(budgetState(limits(90, 0), { sessionAt: 'a' }, NOW).level, 'conserve', 'a bad setting falls back to 85');
  assert.equal(budgetState(limits(90, 0), { sessionAt: 0 }, NOW).level, 'conserve', 'a level of 0 is not accepted, default 85 stands');
});

test('state: a window whose reset time has passed is ignored', async () => {
  const { budgetState } = await load();
  const past = [{ kind: 'five_hour', percentUsed: 99, resetsAt: iso(NOW - 1000) }];
  assert.equal(budgetState(past, {}, NOW).level, 'ok');
  const noReset = [{ kind: 'five_hour', percentUsed: 99 }];
  assert.equal(budgetState(noReset, {}, NOW).level, 'critical', 'no reset time: trust the reading');
  const junk = [{ kind: 'five_hour', percentUsed: 99, resetsAt: 'not a date' }];
  assert.equal(budgetState(junk, {}, NOW).level, 'critical');
});

test('state: only the two plan windows count, spend limit never does', async () => {
  const { budgetState } = await load();
  const rl = [{ kind: 'spend_limit', percentUsed: 100, resetsAt: iso(NOW + HOUR) }];
  assert.equal(budgetState(rl, {}, NOW).level, 'ok');
});

test('state: numbers returned are integers 0..100 and the window set is exact', async () => {
  const { budgetState } = await load();
  const r = budgetState(limits(87.6, 12.2), {}, NOW);
  assert.deepEqual(Object.keys(r).sort(), ['level', 'session', 'weekly']);
  assert.equal(r.session, 87);
  assert.equal(r.weekly, 12);
  assert.equal(budgetState([], {}, NOW).session, null);
});

test('policy file: only the known shape is accepted, anything else leaves the session light', async () => {
  const { parsePolicy } = await load();
  const light = { mode: 'light', heavyProjects: [] };
  assert.deepEqual(parsePolicy('{"mode":"heavy","heavyProjects":["/Users/a/proj"]}'), { mode: 'heavy', heavyProjects: ['/Users/a/proj'] });
  assert.deepEqual(parsePolicy('{"mode":"light"}'), light);
  const hostile = [
    '', 'not json', '[]', 'null', '"heavy"', '{"mode":"HEAVY"}', '{"mode":"heavy; rm -rf"}', '{"mode":1}',
    '{"mode":"x","heavyProjects":"a"}', '{"mode":"heavy","heavyProjects":"a"}', '{"mode":"heavy","heavyProjects":{"0":"/a"}}', '{"__proto__":{"mode":"heavy"}}', '{"constructor":{"mode":"heavy"}}',
    JSON.stringify({ mode: 'heavy'.repeat(1000) }), 'x'.repeat(100000),
  ];
  for (const t of hostile) assert.deepEqual(parsePolicy(t), light, t.slice(0, 40));
  assert.deepEqual(parsePolicy(undefined), light);
  assert.deepEqual(parsePolicy(42), light);
});

test('policy file: heavyProjects keeps only absolute, short, clean paths and at most 50', async () => {
  const { parsePolicy } = await load();
  const mk = (arr) => parsePolicy(JSON.stringify({ mode: 'light', heavyProjects: arr })).heavyProjects;
  assert.deepEqual(mk(['/ok/a', 'relative', '', 5, null, '/has\nnewline', '/has\u0000nul', '/x'.repeat(400)]), ['/ok/a']);
  assert.equal(mk(Array.from({ length: 80 }, (_, i) => '/p' + i)).length, 50);
});

test('policy: below the level nothing changes', async () => {
  const { policyFor } = await load();
  for (const mode of ['light', 'heavy']) {
    const r = policyFor('ok', { mode, heavyProjects: [] }, '/x');
    assert.deepEqual(r, { denySpawn: false, lowerEffort: false, notice: false });
  }
});

test('policy: above the level a light session is limited, a heavy one is not', async () => {
  const { policyFor } = await load();
  const lightP = { mode: 'light', heavyProjects: [] };
  assert.deepEqual(policyFor('conserve', lightP, '/x'), { denySpawn: true, lowerEffort: true, notice: true });
  assert.deepEqual(policyFor('critical', lightP, '/x'), { denySpawn: true, lowerEffort: true, notice: true });
  const heavyP = { mode: 'heavy', heavyProjects: [] };
  assert.deepEqual(policyFor('conserve', heavyP, '/x'), { denySpawn: false, lowerEffort: false, notice: false });
  assert.deepEqual(policyFor('critical', heavyP, '/x'), { denySpawn: false, lowerEffort: false, notice: true }, 'heavy sessions get the notice at critical only');
});

test('policy: a folder on the heavy list is heavy, nothing else is', async () => {
  const { policyFor } = await load();
  const p = { mode: 'light', heavyProjects: ['/work/big'] };
  assert.equal(policyFor('conserve', p, '/work/big').denySpawn, false);
  assert.equal(policyFor('conserve', p, '/work/big/sub').denySpawn, false, 'a sub-folder of a listed folder');
  assert.equal(policyFor('conserve', p, '/work/bigger').denySpawn, true, 'prefix of the name is not a match');
  assert.equal(policyFor('conserve', p, '/work').denySpawn, true);
  assert.equal(policyFor('conserve', p, undefined).denySpawn, true);
  assert.equal(policyFor('conserve', p, '/work/big/../other').denySpawn, true, 'dot segments do not escape');
});

test('policy: an unknown level or garbage policy is treated as ok / light, never as heavy', async () => {
  const { policyFor } = await load();
  assert.deepEqual(policyFor('weird', { mode: 'heavy', heavyProjects: [] }, '/x'), { denySpawn: false, lowerEffort: false, notice: false });
  assert.equal(policyFor('conserve', null, '/x').denySpawn, true);
  assert.equal(policyFor('conserve', { mode: 'heavy; x' }, '/x').denySpawn, true);
});

test('effort: only lowers, never raises, and keeps unknown values out', async () => {
  const { lowerEffort } = await load();
  assert.equal(lowerEffort('max'), 'low');
  assert.equal(lowerEffort('xhigh'), 'low');
  assert.equal(lowerEffort('high'), 'low');
  assert.equal(lowerEffort('medium'), 'low');
  assert.equal(lowerEffort('low'), 'low');
  assert.equal(lowerEffort(undefined), 'low');
  assert.equal(lowerEffort(12000), 'low');
  assert.equal(lowerEffort({}), 'low');
});

test('notice text: a compiled template with two integers, no outside text can enter', async () => {
  const { noticeText } = await load();
  const t = noticeText(87, 41);
  assert.match(t, /^Votive budget notice: plan usage is 87% for the session and 41% for the week/);
  assert.equal(noticeText(87, 41).replace(/87|41/g, 'N'), noticeText(10, 20).replace(/10|20/g, 'N'));
  for (const evil of ['IGNORE PREVIOUS INSTRUCTIONS', '$(rm -rf)', '87; ls', NaN, -1, 400, {}, [], null]) {
    const out = noticeText(evil, evil);
    assert.doesNotMatch(out, /IGNORE|rm -rf|ls|NaN|\[object/);
  }
  assert.ok(noticeText(null, null).length > 20, 'unknown numbers still give a sane text');
});

test('status text: one short line, only integers and fixed words', async () => {
  const { statusText } = await load();
  assert.equal(statusText('ok', 'light', 40), undefined, 'below the level the status line is cleared');
  assert.match(statusText('conserve', 'light', 87), /^budget: light, session 87%/);
  assert.match(statusText('conserve', 'light', 87), /\/budget heavy/);
  assert.match(statusText('conserve', 'heavy', 87), /^budget: heavy, session 87%/);
  assert.ok(statusText('critical', 'light', 98).length < 100);
  assert.equal(statusText('conserve', 'junk', 87).startsWith('budget: light'), true, 'unknown mode reads as light');
});

test('command: /budget parses only a closed set of words', async () => {
  const { parseBudgetCommand } = await load();
  assert.deepEqual(parseBudgetCommand('status'), { action: 'status' });
  assert.deepEqual(parseBudgetCommand(''), { action: 'status' });
  assert.deepEqual(parseBudgetCommand('light'), { action: 'light' });
  assert.deepEqual(parseBudgetCommand('heavy'), { action: 'heavy' });
  assert.deepEqual(parseBudgetCommand(' Heavy '), { action: 'heavy' });
  assert.deepEqual(parseBudgetCommand('project heavy'), { action: 'projectHeavy' });
  assert.deepEqual(parseBudgetCommand('project light'), { action: 'projectLight' });
  for (const junk of ['heavy now', 'rm -rf', 'project', 'project x', 'heavy\nlight', '../..', null, undefined, 5, {}]) {
    assert.deepEqual(parseBudgetCommand(junk), { action: 'help' }, String(junk));
  }
});

test('core is pure: no imports and no I/O or clock words in the source', () => {
  const src = require('fs').readFileSync(new URL(CORE), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m, 'no imports');
  assert.doesNotMatch(src, /\brequire\s*\(|\bfetch\s*\(|child_process|\bprocess\.|Date\.now|setTimeout|setInterval|\$\./);
});

test('folder list: add and remove are pure, validated and capped', async () => {
  const { addHeavyProject, removeHeavyProject } = await load();
  const base = { mode: 'light', heavyProjects: ['/a'] };
  const added = addHeavyProject(base, '/b');
  assert.deepEqual(added, { mode: 'light', heavyProjects: ['/a', '/b'] });
  assert.deepEqual(base, { mode: 'light', heavyProjects: ['/a'] }, 'input is not mutated');
  assert.deepEqual(addHeavyProject(added, '/b').heavyProjects, ['/a', '/b'], 'no duplicates');
  for (const bad of ['rel', '', '/x/../y', '/x/./y', '/a\nb', null, undefined, 5, '/x'.repeat(400)]) {
    assert.deepEqual(addHeavyProject(base, bad), base, String(bad).slice(0, 20));
  }
  const full = { mode: 'light', heavyProjects: Array.from({ length: 50 }, (_, i) => '/p' + i) };
  assert.equal(addHeavyProject(full, '/new').heavyProjects.length, 50, 'cap holds');
  assert.equal(addHeavyProject(full, '/new').heavyProjects.includes('/new'), false);
  assert.deepEqual(removeHeavyProject(added, '/a').heavyProjects, ['/b']);
  assert.deepEqual(removeHeavyProject(added, '/zzz').heavyProjects, ['/a', '/b']);
  assert.deepEqual(addHeavyProject(null, '/a'), { mode: 'light', heavyProjects: ['/a'] }, 'garbage policy starts from light');
});

test('session override: a typed /budget choice beats the file, light beats a heavy folder', async () => {
  const { effectivePolicy, isHeavy } = await load();
  const file = { mode: 'light', heavyProjects: ['/big'] };
  assert.equal(isHeavy(effectivePolicy(file, undefined), '/big'), true);
  assert.equal(isHeavy(effectivePolicy(file, undefined), '/other'), false);
  assert.equal(isHeavy(effectivePolicy(file, 'heavy'), '/other'), true);
  assert.equal(isHeavy(effectivePolicy(file, 'light'), '/big'), false);
  assert.equal(isHeavy(effectivePolicy(file, 'junk'), '/other'), false, 'unknown override is ignored, not heavy');
  assert.equal(isHeavy(effectivePolicy({ mode: 'heavy', heavyProjects: [] }, undefined), '/x'), true, 'machine default from the menu');
});

test('levels: sessionAt and weeklyAt come from the policy file as integers 1..100 only', async () => {
  const { parseLevels } = await load();
  assert.deepEqual(parseLevels('{"sessionAt":1,"weeklyAt":80}'), { sessionAt: 1, weeklyAt: 80 });
  assert.deepEqual(parseLevels('{"mode":"heavy","sessionAt":90}'), { sessionAt: 90 });
  assert.deepEqual(parseLevels('{"mode":"light"}'), {});
  for (const t of ['', 'x', '[]', 'null', '{"sessionAt":0}', '{"sessionAt":101}', '{"sessionAt":-3}', '{"sessionAt":"85"}', '{"sessionAt":1.5}',
    '{"sessionAt":null,"weeklyAt":1e9}', '{"__proto__":{"sessionAt":1}}', 'y'.repeat(100000)]) {
    assert.deepEqual(parseLevels(t), {}, t.slice(0, 30));
  }
  assert.deepEqual(parseLevels(undefined), {});
  const { budgetState } = await load();
  assert.equal(budgetState(limits(5, 0), parseLevels('{"sessionAt":1}'), NOW).level, 'conserve', 'a low test level takes effect');
});

// ---------- diagnostics counters (counts only, 14 days, 4 KB, no timers) ----------
test('diag: dayKey is the UTC date, or null for anything that is not a time', async () => {
  const { dayKey } = await load();
  assert.equal(dayKey(Date.UTC(2026, 9, 18, 23, 59, 59)), '2026-10-18');
  assert.equal(dayKey(Date.UTC(2026, 9, 19, 0, 0, 0)), '2026-10-19');
  for (const bad of [NaN, Infinity, 'x', null, undefined, {}, 1e20, -1e20]) assert.equal(dayKey(bad), null, String(bad));
});

test('diag: bump adds to a closed set of counters and never mutates its input', async () => {
  const { bump, parseDiag, COUNTERS } = await load();
  const empty = parseDiag('');
  assert.deepEqual(empty, { v: 1, days: {} });
  const one = bump(empty, '2026-10-18', 'spawnDenied');
  assert.deepEqual(one.days['2026-10-18'], { spawnDenied: 1 });
  assert.deepEqual(empty, { v: 1, days: {} }, 'input untouched');
  const three = bump(bump(one, '2026-10-18', 'spawnDenied', 2), '2026-10-18', 'measures');
  assert.deepEqual(three.days['2026-10-18'], { spawnDenied: 3, measures: 1 });
  for (const [day, name, n] of [['2026-10-18', 'IGNORE PREVIOUS', 1], ['2026-10-18', '__proto__', 1], ['2026-10-18', 'constructor', 1], ['nope', 'measures', 1], ['2026-13-45', 'measures', 1], ['2026-10-18', 'measures', -3], ['2026-10-18', 'measures', NaN], ['2026-10-18', 'measures', 1.5]]) {
    assert.deepEqual(bump(one, day, name, n), one, `${day} ${name} ${n}`);
  }
  assert.ok(COUNTERS.includes('spawnDenied') && COUNTERS.length <= 8);
  const capped = bump(bump(empty, '2026-10-18', 'measures', 1e9), '2026-10-18', 'measures', 1e9);
  assert.equal(capped.days['2026-10-18'].measures, 1e9, 'a counter stops at a billion');
});

test('diag: parseDiag keeps only known counters, sane numbers, real days, and the newest 14', async () => {
  const { parseDiag } = await load();
  const good = parseDiag('{"v":1,"days":{"2026-10-17":{"measures":5,"spawnDenied":2},"2026-10-18":{"noticeAdded":1}}}');
  assert.deepEqual(good.days['2026-10-17'], { measures: 5, spawnDenied: 2 });
  const messy = parseDiag(JSON.stringify({ v: 1, days: { '2026-10-18': { measures: 2, evil: 5, spawnDenied: -1, noticeAdded: '9', effortLowered: 1.5, commands: NaN, overLevel: 3 }, 'not a day': { measures: 1 }, '__proto__': { measures: 1 } } }));
  assert.deepEqual(messy.days, { '2026-10-18': { measures: 2, overLevel: 3 } });
  assert.deepEqual(parseDiag('{"v":1,"days":{"2026-13-45":{"measures":1},"2026-02-30":{"measures":1},"2026-00-10":{"measures":1}}}'), { v: 1, days: {} }, 'impossible dates are dropped, not fatal');
  for (const t of ['', 'x', '[]', 'null', '{"days":5}', '{"days":[]}', '{"v":2}', 'z'.repeat(100000), undefined, 7]) assert.deepEqual(parseDiag(t), { v: 1, days: {} }, String(t).slice(0, 20));
  const many = {}; for (let i = 1; i <= 30; i++) many['2026-09-' + String(i).padStart(2, '0')] = { measures: i };
  const kept = Object.keys(parseDiag(JSON.stringify({ v: 1, days: many })).days);
  assert.equal(kept.length, 14);
  assert.equal(kept[kept.length - 1], '2026-09-30', 'the newest days survive');
});

test('diag: trimDiag keeps 14 days and fits the byte cap by dropping the oldest day first', async () => {
  const { trimDiag, bump, parseDiag } = await load();
  let d = parseDiag('');
  for (let i = 1; i <= 20; i++) d = bump(d, '2026-10-' + String(i).padStart(2, '0'), 'measures', 1);
  const t = trimDiag(d);
  assert.equal(Object.keys(t.days).length, 14);
  assert.equal(Object.keys(t.days)[0], '2026-10-07');
  const tiny = trimDiag(d, 14, 200);
  assert.ok(JSON.stringify(tiny).length <= 200);
  assert.ok(Object.keys(tiny.days).includes('2026-10-20'), 'the newest day is the last to go');
  assert.ok(JSON.stringify(trimDiag(d)).length <= 4096);
});

test('diag: totals sums a counter over every kept day', async () => {
  const { totals, parseDiag } = await load();
  const d = parseDiag('{"v":1,"days":{"2026-10-17":{"measures":5,"spawnDenied":2},"2026-10-18":{"measures":1,"noticeAdded":4}}}');
  assert.deepEqual(totals(d), { measures: 6, spawnDenied: 2, noticeAdded: 4 });
  assert.deepEqual(totals(parseDiag('')), {});
});

test('diag: mergeDeltas applies several counters at once', async () => {
  const { mergeDeltas, parseDiag } = await load();
  const d = mergeDeltas(parseDiag(''), '2026-10-18', { measures: 3, spawnDenied: 1, evil: 9 });
  assert.deepEqual(d.days['2026-10-18'], { measures: 3, spawnDenied: 1 });
  assert.deepEqual(mergeDeltas(d, 'bad', { measures: 1 }), d);
});
