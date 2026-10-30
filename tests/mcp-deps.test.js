'use strict';
//
// Guards the MCP server's dependency tree (AGEN-21). It reads the lockfile, so it needs no network and
// cannot flake: it fails if a package with a known advisory is locked at an affected version, if the
// declared SDK range could resolve below the fixed release, or if a locked package has no integrity hash.
// It does not replace `npm audit`; it pins what `npm audit` reported on 2026-10-17 so a stale lock is caught
// offline. Re-run `npm audit --omit=dev` in mcp-server before every release and update FIXED when it finds more.
//
//   node --test tests/mcp-deps.test.js
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'mcp-server');
const lock = JSON.parse(fs.readFileSync(path.join(DIR, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));

// First fixed version of each advisory seen by `npm audit --omit=dev` on 2026-10-17.
const FIXED = {
  '@modelcontextprotocol/sdk': { min: '1.31.0', advisory: 'GHSA-6qxp-vccf-f47h (high)' },
  'proxy-addr': { min: '2.0.8', advisory: 'GHSA-jqcg-44mw-7w3h (critical)' },
  'fast-uri': { min: '3.1.8', advisory: 'GHSA-hrr3-gc8f-f4qj (moderate)' },
  'ip-address': { min: '10.7.4', advisory: 'GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw (moderate)' },
};

const parse = (v) => v.replace(/^[^\d]*/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
function atLeast(have, want) {
  const a = parse(have), b = parse(want);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}
const locked = (name) => Object.entries(lock.packages)
  .filter(([p]) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`))
  .map(([p, e]) => ({ at: p, version: e.version }));

test('no locked package is at a version with a known advisory', () => {
  for (const [name, { min, advisory }] of Object.entries(FIXED)) {
    for (const { at, version } of locked(name)) {
      assert.ok(atLeast(version, min), `${at} is ${version}, needs >= ${min} (${advisory})`);
    }
  }
});

test('the declared SDK range cannot resolve below the fixed release', () => {
  const range = pkg.dependencies['@modelcontextprotocol/sdk'];
  assert.ok(range, 'the SDK dependency is declared');
  assert.ok(atLeast(range, FIXED['@modelcontextprotocol/sdk'].min), `range ${range} starts below ${FIXED['@modelcontextprotocol/sdk'].min}`);
});

test('every locked package has an integrity hash and comes from the npm registry', () => {
  for (const [p, e] of Object.entries(lock.packages)) {
    if (!p) continue;                       // the root project itself
    assert.ok(e.integrity && /^sha(256|384|512)-/.test(e.integrity), `${p} has no integrity hash`);
    assert.ok(/^https:\/\/registry\.npmjs\.org\//.test(e.resolved || ''), `${p} does not resolve from registry.npmjs.org (${e.resolved})`);
  }
});

test('the lockfile and package.json agree on the SDK range', () => {
  assert.strictEqual(lock.packages[''].dependencies['@modelcontextprotocol/sdk'], pkg.dependencies['@modelcontextprotocol/sdk']);
});
