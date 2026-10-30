'use strict';
//
// AGEN-23: paths from an agent's payload are shown in Finder or read as text, never opened with
// whatever app macOS associates with them. Compiles Votive/Services/Reveal.swift on its
// own and asks it what it would do with each kind of file; needs the Swift toolchain.
//
//   node --test tests/*.test.js
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

test('reveal: apps, executables, scripts and installers are revealed, text is viewed, junk is refused', { skip: !haveSwift && 'no Swift toolchain' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao reveal '));
  const sh = '#!/bin/sh\necho hi\n';
  fs.writeFileSync(path.join(d, 'plainexec'), sh, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'run.command'), sh, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'run.sh'), sh, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'session.jsonl'), '{}\n');
  fs.writeFileSync(path.join(d, 'big.jsonl'), Buffer.alloc(51 * 1024 * 1024, 0x20));
  fs.mkdirSync(path.join(d, 'Evil.app', 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Evil.app', 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>x</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  fs.mkdirSync(path.join(d, 'Setup.pkg'));
  fs.mkdirSync(path.join(d, 'project'));
  fs.symlinkSync(path.join(d, 'run.command'), path.join(d, 'looks-like.jsonl'));

  fs.writeFileSync(path.join(d, 'main.swift'), [
    'import Foundation',
    'let base = CommandLine.arguments[1]',
    'func name(_ p: Reveal.Plan) -> String { switch p { case .openFolderWindow: return "folder"; case .revealInFinder: return "reveal"; case .viewAsText: return "text"; case .refuse: return "refuse" } }',
    'for n in ["project", "Evil.app", "Setup.pkg", "plainexec", "run.command"] { print("folder", n, name(Reveal.plan(forFolder: base + "/" + n))) }',
    'for n in ["session.jsonl", "big.jsonl", "plainexec", "run.command", "run.sh", "Evil.app", "Setup.pkg", "project", "looks-like.jsonl", "missing.jsonl"] { print("transcript", n, name(Reveal.plan(forTranscript: base + "/" + n))) }',
    'print("transcript relative", name(Reveal.plan(forTranscript: "relative.jsonl")))',
    'print("transcript NUL", name(Reveal.plan(forTranscript: base + "/session.jsonl\\0.app")))',
  ].join('\n'));
  const exe = path.join(d, 'probe');
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-o', exe, path.join(ROOT, 'Votive', 'Services', 'Reveal.swift'), path.join(d, 'main.swift')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(exe, [d], { encoding: 'utf8', timeout: 20000 });
  const got = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const [k, n, v] = l.split(' '); return [k + ' ' + n, v]; }));
  assert.deepEqual(got, {
    'folder project': 'folder', 'folder Evil.app': 'reveal', 'folder Setup.pkg': 'reveal', 'folder plainexec': 'refuse', 'folder run.command': 'refuse',
    'transcript session.jsonl': 'text', 'transcript big.jsonl': 'reveal', 'transcript plainexec': 'reveal', 'transcript run.command': 'reveal',
    'transcript run.sh': 'reveal', 'transcript Evil.app': 'reveal', 'transcript Setup.pkg': 'reveal', 'transcript project': 'reveal',
    'transcript looks-like.jsonl': 'reveal', 'transcript missing.jsonl': 'refuse', 'transcript relative': 'refuse', 'transcript NUL': 'refuse',
  });
});

test('reveal: the app never calls NSWorkspace.open on a path that came from a payload', () => {
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.swift')) {
        const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
        for (const m of src.matchAll(/NSWorkspace\.shared\.open\(([^)]*\))?/g)) hits.push(path.relative(ROOT, f) + ': ' + m[0]);
      }
    }
  })(path.join(ROOT, 'Votive'));
  // Allowed: opening the app's own files and folders (snippets, sounds, ~/.votive) and
  // the explicit-application form inside Reveal.swift.
  const bad = hits.filter((h) => !/Paths\.(root|sounds|ports)|watchList\.fileURL|SnippetStore\.shared\.fileURL|Reveal\.swift/.test(h));
  assert.deepEqual(bad, []);
});
