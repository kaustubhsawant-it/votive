'use strict';
//
// The Node side on Windows: how hook commands are quoted, that those commands really run under the
// shells an agent may use, and the installer. Quoting tests that need no Windows run everywhere; the
// ones that start cmd, PowerShell or bash run only on Windows. Everything runs in a scratch home.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao win '));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const { shellQuote, SettingsError } = require('../Scripts/settings-io');
const WIN = process.platform === 'win32';
const S = path.join(__dirname, '..', 'Scripts');

test('quote: POSIX keeps single quotes and escapes an embedded quote', () => {
  assert.equal(shellQuote("/a b/c'd", 'darwin'), "'/a b/c'\\''d'");
  assert.equal(shellQuote('/plain/path.js', 'linux'), "'/plain/path.js'");
});

test('quote: Windows is one double-quoted, forward-slash form that cmd, PowerShell and bash all accept', () => {
  assert.equal(shellQuote('C:\\Users\\a b\\.votive\\bin\\x.js', 'win32'), '"C:/Users/a b/.votive/bin/x.js"');
  assert.equal(shellQuote('D:\\é ü\\x.js', 'win32'), '"D:/é ü/x.js"');
});

test('quote: Windows refuses paths it cannot quote safely for every shell, loudly', () => {
  for (const bad of ['C:\\a"b\\x.js', 'C:\\$HOME\\x.js', 'C:\\a`b\\x.js', 'C:\\%PATH%\\x.js', 'C:\\a\nb\\x.js']) {
    assert.throws(() => shellQuote(bad, 'win32'), SettingsError, bad);
  }
});

test('quote: the quoted command runs under the real shells (Windows: cmd, PowerShell, Git bash)', { skip: !WIN && 'needs Windows shells' }, () => {
  const dir = path.join(tmp, 'dir with space');
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'hello.js');
  fs.writeFileSync(js, 'process.stdout.write("ran:" + process.argv.slice(2).join(","))');
  const command = 'node ' + shellQuote(js) + ' --agent claude-code';
  const shells = [
    ['cmd', 'cmd.exe', ['/d', '/s', '/c', '"' + command + '"'], { windowsVerbatimArguments: true }],
    ['powershell', 'powershell.exe', ['-NoProfile', '-Command', command], {}],
  ];
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (fs.existsSync(gitBash)) shells.push(['git bash', gitBash, ['-c', command], {}]);
  for (const [name, exe, args, opts] of shells) {
    const r = spawnSync(exe, args, { encoding: 'utf8', ...opts });
    assert.equal(r.stdout, 'ran:--agent,claude-code', name + ': ' + r.stdout + r.stderr);
  }
});

test('where: agent detection on Windows uses where.exe, not a POSIX shell', { skip: !WIN && 'needs Windows' }, () => {
  const { detected } = require('../Scripts/install-agents');
  assert.equal(detected({ detect: ['node'] }), true, 'node is on PATH');
  assert.equal(detected({ detect: ['definitely-not-a-real-agent-xyz'] }), false);
});

test('installer: copies the scripts, wires the hooks and status line, is idempotent, and --remove undoes it', () => {
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo hi' } }));
  const run = (...a) => spawnSync(process.execPath, [path.join(S, 'install-windows.js'), ...a], { encoding: 'utf8', env: { ...process.env, HOME: tmp, USERPROFILE: tmp } });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const bin = path.join(tmp, '.votive', 'bin');
  for (const f of ['votive-event.js', 'proc-info.js', 'overlay-paths.js']) assert.ok(fs.existsSync(path.join(bin, f)), f);
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
  assert.equal(cfg.theme, 'dark', 'unrelated settings kept');
  const hookCmd = cfg.hooks.Stop[0].hooks[0].command;
  assert.ok(hookCmd.startsWith('node '), hookCmd);
  assert.ok(hookCmd.includes(WIN ? '"' : "'"), 'quoted for this platform: ' + hookCmd);
  assert.ok(WIN ? !hookCmd.includes('\\') : true, 'no backslashes in a Windows command');
  assert.ok(/votive-statusline\.js/.test(cfg.statusLine.command), 'status line wrapped');
  const first = fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8');
  r = run();
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'), first, 'a second run changes nothing');
  r = run('--remove');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.statusLine.command, 'echo hi', 'the original status line is restored exactly');
  assert.ok(!JSON.stringify(after.hooks || {}).includes('votive-event.js'), 'our hooks are gone');
});

test('installer: --app copies the Windows app next to the user, never anywhere else', () => {
  const exe = path.join(tmp, 'VotiveWin.exe');
  fs.writeFileSync(exe, 'MZ fake');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao app '));
  const r = spawnSync(process.execPath, [path.join(S, 'install-windows.js'), '--app', exe], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(home, 'Local', 'Votive', 'VotiveWin.exe'), 'utf8'), 'MZ fake');
  const bad = spawnSync(process.execPath, [path.join(S, 'install-windows.js'), '--app', path.join(tmp, 'nope.exe')], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local') } });
  assert.notEqual(bad.status, 0, 'a missing app file is an error');
  assert.match(bad.stderr + bad.stdout, /not found/i);
});

test('doctor on Windows: app and login-item checks use Windows facts, and nothing calls a macOS tool', { skip: !WIN && 'needs Windows' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao doc '));
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local') };
  const r = spawnSync(process.execPath, [path.join(S, 'doctor.js')], { encoding: 'utf8', env });
  assert.match(r.stdout, /app-installed\s+Not found/);
  assert.match(r.stdout, /app-running\s+The app is not running/);
  assert.doesNotMatch(r.stdout + r.stderr, /pgrep|launchctl|LaunchAgent|menu-bar|ENOENT/i);
});
