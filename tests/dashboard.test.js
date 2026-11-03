'use strict';
//
// The Votive window (Votive/Dashboard): it must keep Votive working on macOS 14 and later while using Liquid Glass on
// macOS 26, and every setting it edits must be a preference the app really reads. The window itself is checked by
// building and looking at it; these tests keep the promises that a build on macOS 26 cannot show.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const swiftFiles = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.swift')).map((f) => path.join(dir, f));

test('dashboard: the app still targets macOS 14', () => {
  assert.match(read('project.yml'), /deploymentTarget:\s*\n\s*macOS: "14\.0"/);
  assert.match(read('project.yml'), /deploymentTarget: "14\.0"/);
  // The generated project is not in a fresh checkout or export (it is gitignored); when it is there, it must agree.
  const generated = path.join(ROOT, 'Votive.xcodeproj', 'project.pbxproj');
  if (fs.existsSync(generated)) for (const m of fs.readFileSync(generated, 'utf8').matchAll(/MACOSX_DEPLOYMENT_TARGET = ([\d.]+);/g)) assert.equal(m[1], '14.0');
});

test('dashboard: macOS 26 glass APIs appear only in Glass.swift, each behind #available(macOS 26)', () => {
  const only26 = /\.glassEffect\(|GlassEffectContainer|\bGlass\.(regular|clear)|\.buttonStyle\(\.glass|\.glassProminent|backgroundExtensionEffect|scrollEdgeEffect|NSGlassEffectView|NSBackgroundExtensionView/;
  for (const f of swiftFiles('Votive/Dashboard')) {
    const lines = code(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (!only26.test(line)) return;
      assert.ok(f.endsWith('Glass.swift'), f + ' line ' + (i + 1) + ' uses a macOS 26 API outside Glass.swift');
      const before = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      assert.match(before, /#available\(macOS 26, \*\)/, f + ' line ' + (i + 1) + ': a macOS 26 API without the availability check right above it');
    });
  }
  // and the fallbacks exist, so macOS 14 and 15 get materials, not nothing
  const glass = code(read('Votive/Dashboard/Glass.swift'));
  assert.match(glass, /\.regularMaterial/);
  assert.match(glass, /buttonStyle\(\.bordered\)/);
});

test('dashboard: nothing in the window can reach the network or run a program', () => {
  for (const f of swiftFiles('Votive/Dashboard').concat(['Votive/Services/UsageHabits.swift'])) {
    const src = code(read(f));
    assert.ok(!/\bProcess\(|\bNSTask\b|\bURLSession\b|\bposix_spawn\b|\bWKWebView\b|\bNSAppleScript\b/.test(src), f);
  }
});

test('dashboard: every preference the window edits is one the app or the MCP settings tool really reads', () => {
  const edited = new Set();
  for (const f of swiftFiles('Votive/Dashboard')) for (const m of code(read(f)).matchAll(/@AppStorage\(([^)]*)\)/g)) edited.add(m[1].trim());
  assert.ok(edited.size >= 11, 'the settings pages declare their preferences');
  // resolve the constants the window uses by name
  const names = { 'SessionPriority.onlyKey': 'alertsOnlyPriority', 'DashboardModel.targetKey': 'usageTargetPercent' };
  const keys = [...edited].map((k) => names[k] || k.replace(/^"|"$/g, ''));
  const app = ['Votive/UI/StatusItemController.swift', 'Votive/Services/Sounds.swift', 'Votive/Services/SessionPriority.swift', 'Votive/Services/AgentScanner.swift']
    .map((f) => code(read(f))).join('\n');
  const own = new Set(['dashboardPage', 'usageTargetPercent', 'insightsShow']);   // the window's own three
  for (const k of keys) {
    if (own.has(k)) continue;
    assert.ok(app.includes('"' + k + '"'), k + ' is edited in the window but the app never reads it');
  }
  // the window's own preferences are read by the window and nobody else
  for (const k of own) assert.ok(keys.includes(k) || k === 'dashboardPage', k);
  assert.ok(edited.size >= 12, 'the settings pages declare their preferences');
});

test('dashboard: every page has a sidebar entry and a detail view', () => {
  const model = code(read('Votive/Dashboard/DashboardModel.swift'));
  const cases = [...model.matchAll(/case ([a-z, ]+)\n/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter(Boolean);
  const pages = ['overview', 'forecast', 'habits', 'history', 'general', 'alerts', 'colors', 'sounds', 'agents'];
  for (const p of pages) assert.ok(cases.includes(p), 'DashboardPage has ' + p);
  const view = code(read('Votive/Dashboard/DashboardView.swift'));
  for (const p of pages) assert.ok(new RegExp('case \\.' + p + ':').test(view), 'the window shows a page for ' + p);
});

test('dashboard: the menu opens the window, and the menu-bar item stays the always-on part', () => {
  const ctl = code(read('Votive/UI/StatusItemController.swift'));
  assert.match(ctl, /Open Votive…/);
  assert.match(ctl, /All Settings…/);
  assert.match(ctl, /DashboardWindowController\.shared\.show\(\)/);
  assert.match(ctl, /DashboardWindowController\.shared\.show\(page: \.general\)/);
  // the controller still feeds the window, so there is one source of live data
  assert.match(ctl, /DashboardModel\.shared\.usage = snapshot/);
  assert.match(ctl, /DashboardModel\.shared\.sessions = sessions/);
  // closing the window returns Votive to menu-bar only
  const win = code(read('Votive/Dashboard/DashboardWindow.swift'));
  assert.match(win, /setActivationPolicy\(\.regular\)/);
  assert.match(win, /setActivationPolicy\(\.accessory\)/);
  assert.match(win, /windowWillClose/);
});
