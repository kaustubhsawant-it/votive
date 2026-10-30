'use strict';
//
// Guards the promise in PRIVACY.md: nothing in Votive talks to the network.
// Fails if networking code is added to the app, the scripts or the MCP server, so the
// promise can't quietly stop being true.
//
//   node --test tests/*.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function files(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...files(rel, ext)); }
    else if (ext.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Comments may legitimately mention these words; only code counts.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the Swift app uses no networking API', () => {
  const banned = [/\bURLSession\b/, /\bURLRequest\b/, /\bNWConnection\b/, /\bNWListener\b/,
    /import\s+Network\b/, /\bCFSocket/, /\bCFStream/, /\bNSURLConnection\b/, /\bWebSocket/,
    /\bSocketPort\b/, /\bURL\(string:\s*"https?:/, /\bgetaddrinfo\b/, /\bsocket\(/];
  const hits = [];
  for (const f of files('Votive', ['.swift'])) {
    const src = code(read(f));
    for (const re of banned) if (re.test(src)) hits.push(f + ': ' + re);
  }
  assert.deepEqual(hits, []);
});

test('the scripts and MCP server load only local modules', () => {
  // Everything these files may require: Node built-ins without network access, their own
  // sibling files, and the MCP SDK's stdio server (no HTTP transport).
  const allowed = new Set(['fs', 'os', 'path', 'crypto', 'child_process', 'node:test', 'node:assert',
    '@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/stdio.js',
    '@modelcontextprotocol/sdk/types.js']);
  const hits = [];
  const sources = [...files('Scripts', ['.js']), 'mcp-server/index.js'];
  for (const f of sources) {
    const src = code(read(f));
    for (const m of src.matchAll(/require\(\s*([^)]*?)\s*\)/g)) {
      const arg = m[1];
      const lit = /^['"]([^'"]+)['"]$/.exec(arg);
      if (lit && (lit[1].startsWith('./') || allowed.has(lit[1]))) continue;
      if (/^path\.join\(__dirname/.test(arg)) continue;   // a sibling file by absolute path
      hits.push(f + ': require(' + arg + ')');
    }
    for (const re of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bimport\s*\(/, /https?:\/\/(?!docs\.|github\.com)/]) {
      if (re.test(src)) hits.push(f + ': ' + re);
    }
  }
  assert.deepEqual(hits, []);
});

test('the MCP server has exactly one dependency and talks over stdio', () => {
  const pkg = JSON.parse(read('mcp-server/package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), ['@modelcontextprotocol/sdk']);
  const src = code(read('mcp-server/index.js'));
  assert.match(src, /StdioServerTransport/);
  assert.doesNotMatch(src, /Http|SSE|StreamableHTTP|listen\(/);
});

test('the app asks for no entitlements', () => {
  const yml = read('project.yml');
  assert.doesNotMatch(yml, /entitlements/i);
  assert.equal(files('Votive', ['.entitlements']).length, 0);
});
