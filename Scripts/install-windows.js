#!/usr/bin/env node
'use strict';
//
// Windows installer, per user, no admin. It does what ./Scripts/install.sh does for the Node half:
// copies the hook scripts to ~/.votive/bin, wires the hooks of every detected agent, and wraps
// the Claude Code status line so plan usage is recorded. With --app it also copies the Windows app
// to %LOCALAPPDATA%\Votive. It reuses the doctor's repairs, so install and repair cannot drift.
//
//   node Scripts/install-windows.js [--app <path\to\VotiveWin.exe>]
//   node Scripts/install-windows.js --remove        unwire the hooks and restore the status line
//
// Start with Windows is the user's choice, in the tray menu.
//
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { repair, windowsAppPath } = require('./doctor');

const args = process.argv.slice(2);
const appIdx = args.indexOf('--app');
const node = (script, extra) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...extra], { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, output: ((r.stdout || '') + (r.stderr || '')).trim() };
};
const say = (ok, what, output) => console.log((ok ? '  done  ' : '  FAIL  ') + what + (output ? ': ' + output.split('\n').join('\n        ') : ''));

function main() {
  if (args.includes('--remove')) {
    const a = node('install-agents.js', ['--remove']); say(a.ok, 'hooks', a.output);
    const s = node('install-statusline.js', ['--remove']); say(s.ok, 'status line', s.output);
    return a.ok && s.ok ? 0 : 1;
  }
  let ok = true;
  if (appIdx !== -1) {
    const from = args[appIdx + 1];
    if (!from || !fs.existsSync(from)) { console.error('App file not found: ' + (from || '(no path given after --app)')); return 1; }
    try {
      const to = windowsAppPath();
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      say(true, 'app', to);
    } catch (e) { say(false, 'app', e.message); ok = false; }
  }
  for (const r of repair(['scripts', 'hooks', 'statusline'])) { say(r.ok, r.repair, r.output); ok = ok && r.ok; }
  console.log(ok ? '\nInstalled. Check with: node Scripts/doctor.js' : '\nSome steps failed (see above).');
  return ok ? 0 : 1;
}

process.exit(main());
