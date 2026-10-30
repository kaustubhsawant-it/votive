'use strict';
//
// The Windows app promises what the macOS one does: nothing in it goes online, and nothing in it
// sends input to another program. .NET has no cheap "no networking" switch, so this greps the C#
// for the namespaces and calls that would (AGEN-12 section 3.1), the same idea as
// tests/no-network.test.js for Swift and JavaScript.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'windows', 'Votive.Win');
const files = () => fs.readdirSync(DIR, { recursive: true }).filter((f) => /\.(cs|csproj)$/.test(f) && !/(^|[\\/])(obj|bin)[\\/]/.test(f));
// Comments are not code. The one allowed mention is the project REMOVING System.Net.Http from the implicit usings.
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<Using Remove="System\.Net\.Http"\s*\/>/g, '');

test('windows app: there is source to check', () => {
  assert.ok(files().some((f) => f.endsWith('.csproj')), 'a project file');
  assert.ok(files().filter((f) => f.endsWith('.cs')).length >= 3, 'several source files');
});

test('windows app: no networking namespaces, packages or calls', () => {
  const banned = [/System\.Net\b/, /\bHttpClient\b/, /\bWebClient\b/, /\bHttpListener\b/, /\bTcpListener\b/, /\bTcpClient\b/, /\bSocket\b/,
    /\bWebSocket\b/, /\bWebView2?\b/i, /\bPackageReference\b/, /https?:\/\//];
  const hits = [];
  for (const f of files()) for (const re of banned) if (re.test(read(f))) hits.push(f + ': ' + re);
  assert.deepEqual(hits, []);
});

test('windows app: System.Net.Http is removed from the implicit usings', () => {
  assert.match(fs.readFileSync(path.join(DIR, 'Votive.Win.csproj'), 'utf8'), /<Using Remove="System\.Net\.Http"\s*\/>/);
});

test('windows app: it never sends input to, or reads from, another program', () => {
  const banned = [/\bSendKeys\b/, /\bSendInput\b/, /\bkeybd_event\b/, /\bPostMessage\b/, /\bSendMessage\b/, /\bSetForegroundWindow\b/,
    /\bProcess\.Start\b/, /\bReadProcessMemory\b/, /\bWriteProcessMemory\b/, /\bSetWindowsHookEx\b/];
  const hits = [];
  for (const f of files().filter((x) => x.endsWith('.cs'))) for (const re of banned) if (re.test(read(f))) hits.push(f + ': ' + re);
  assert.deepEqual(hits, []);
});

test('windows build script: self-tests the app, enforces the size limit, and ships a checksum', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'windows', 'build.ps1'), 'utf8');
  for (const must of ['--self-test', '100', 'PublishTrimmed=true', 'PublishSingleFile=true', 'Get-FileHash', 'SHA256']) assert.ok(ps.includes(must), must);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'windows', '.gitignore'), 'utf8'), /dist\//);
});
