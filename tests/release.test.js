'use strict';
//
// The downloadable release: Scripts/make-release.sh packages the app, the scripts and an installer that needs
// only Node.js; Scripts/install.sh has a download mode. The package is built from a tiny stand-in app, so no
// Xcode build is needed here, and the installer is read, never run (it would touch the real login item).
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mac = process.platform === 'darwin';
const version = /MARKETING_VERSION: "([^"]+)"/.exec(read('project.yml'))[1];

function standInApp(dir) {
  const app = path.join(dir, 'Votive.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Votive'));
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Votive</string><key>CFBundleIdentifier</key><string>dev.votive.Votive</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const sign = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' });
  assert.equal(sign.status, 0, sign.stderr);
  return app;
}

test('release: the package holds the app, the scripts and an installer, with checksums that verify', { skip: !mac && 'needs macOS' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao release '));
  const app = standInApp(d);
  const out = path.join(d, 'out');
  const r = spawnSync('bash', [path.join(ROOT, 'Scripts', 'make-release.sh')], { encoding: 'utf8', env: { ...process.env, VOTIVE_APP: app, VOTIVE_RELEASE_OUT: out } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const zip = path.join(out, `Votive-${version}-mac.zip`);
  assert.ok(fs.existsSync(zip), 'the zip is named after the version in project.yml');

  const sums = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: out, encoding: 'utf8' });
  assert.equal(sums.status, 0, 'the published checksum matches the zip: ' + sums.stdout + sums.stderr);

  const x = path.join(d, 'x');
  fs.mkdirSync(x);
  assert.equal(spawnSync('ditto', ['-x', '-k', zip, x]).status, 0);
  const top = path.join(x, `Votive-${version}`);
  const has = (p) => fs.existsSync(path.join(top, p));
  for (const p of ['Votive.app/Contents/MacOS/Votive', 'Scripts/install.sh', 'Scripts/uninstall.sh', 'Scripts/doctor.js', 'Scripts/votive-event.js',
    'mcp-server/index.js', 'mcp-server/package.json', 'mcp-server/package-lock.json', 'INSTALL.txt', 'README.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md']) {
    assert.ok(has(p), p + ' is in the package');
  }
  assert.ok(!has('mcp-server/node_modules'), 'dependencies are fetched by the installer, not shipped');
  assert.ok(!has('docs/launch') && !has('Votive.xcodeproj') && !has('tests'), 'no internal docs, project files or tests');
  const mode = fs.statSync(path.join(top, 'Scripts', 'install.sh')).mode;
  assert.ok(mode & 0o100, 'the installer keeps its executable bit through the zip');
  const note = fs.readFileSync(path.join(top, 'INSTALL.txt'), 'utf8');
  assert.match(note, /\.\/Scripts\/install\.sh/);
  assert.match(note, /Do not double-click Votive\.app/);
  assert.match(note, /Node\.js/);

  // The MCP server loads helpers from ../Scripts, so every one it names must be in the package next to it.
  const index = fs.readFileSync(path.join(top, 'mcp-server', 'index.js'), 'utf8');
  const needed = [...index.matchAll(/path\.join\(__dirname, '\.\.', 'Scripts', '([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(needed.length >= 3, 'the server does load helper scripts');
  for (const f of needed) assert.ok(has('Scripts/' + f), 'mcp-server needs Scripts/' + f);
});

test('release: the installer builds nothing from a download, clears the download flag on one app, and keeps the server beside its scripts', () => {
  const sh = read('Scripts/install.sh');
  // A folder that already holds Votive.app means a download.
  assert.match(sh, /\[ -d "\$ROOT\/Votive\.app" \] && PREBUILT=1/);
  // Tools: a download needs only node and npm.
  assert.match(sh, /TOOLS="node npm"\n\[ "\$PREBUILT" = 1 \] \|\| TOOLS="xcodegen xcodebuild node npm"/);
  // The build commands live only in the source branch.
  const [download, source] = sh.split(/\nelse\n/, 2);
  assert.ok(!/xcodegen generate|xcodebuild -project/.test(download.split('if [ "$PREBUILT" = 1 ]; then')[1] || ''), 'the download branch builds nothing');
  assert.match(source, /xcodegen generate/);
  assert.match(source, /xcodebuild -project Votive\.xcodeproj/);
  // The flag is cleared on the installed copy only, and only for a download.
  const quarantine = sh.match(/.*quarantine.*/g).filter((l) => /xattr/.test(l));
  assert.equal(quarantine.length, 1, 'one xattr line');
  assert.match(quarantine[0], /if \[ "\$PREBUILT" = 1 \]; then xattr -dr com\.apple\.quarantine "\$DEST"/);
  // The server and the scripts it requires sit side by side in a stable folder.
  assert.match(sh, /KEEP="\$HOME\/\.votive\/release"/);
  assert.match(sh, /cp -R "\$ROOT\/Scripts\/\." "\$KEEP\/Scripts\/"/);
  assert.match(sh, /claude mcp add --scope user votive -- node "\$MCP\/index\.js"/);
});

test('release: the packaging script deletes nothing', () => {
  const sh = read('Scripts/make-release.sh');
  assert.ok(!/\brm\s/.test(sh.replace(/^\s*#.*$/gm, '')), 'it writes to a temp name and moves it into place');
  assert.match(sh, /codesign --verify --deep/, 'it refuses an app whose signature does not verify');
  assert.match(sh, /ARCHS="arm64 x86_64"/, 'universal: Apple Silicon and Intel');
});

test('release: the docs say what is true about a download', () => {
  const security = read('SECURITY.md');
  const privacy = read('PRIVACY.md');
  const readme = read('README.md');
  assert.ok(!/There are no prebuilt binaries to trust/.test(security), 'a prebuilt zip exists now, so that sentence must not stay');
  assert.match(security, /not notarized/i);
  assert.match(security, /xattr -dr com\.apple\.quarantine/);
  assert.match(security, /SHA256SUMS\.txt/);
  assert.match(privacy, /xattr -dr com\.apple\.quarantine/);
  assert.match(privacy, /^~\/\.votive\/release\/\*\*/m, 'the new folder is in the writes list');
  assert.match(readme, /releases\/latest/);
  assert.match(readme, /don't double-click `Votive\.app`/);
  assert.match(readme, /shasum -a 256 -c SHA256SUMS\.txt/);
});
