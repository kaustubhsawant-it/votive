'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { render, usedPercent, tokens } = require('./statusline-context');

const plain = (p, env = {}) => render(p, Object.assign({ NO_COLOR: '1' }, env));
const cw = (o) => ({ context_window: Object.assign({ context_window_size: 200000 }, o) });

test('shows model, effort and a bar with the percentage and token counts', () => {
  const out = plain(Object.assign({ model: { display_name: 'Opus' }, effort: { level: 'high' } },
    cw({ used_percentage: 62, current_usage: { input_tokens: 100000, cache_read_input_tokens: 24000 } })));
  assert.strictEqual(out, 'Opus · high │ ctx ███████░░░░░ 62%  124k / 200k');
});

test('before the first response the percentage is unknown, shown as a dash, never 0%', () => {
  const out = plain(Object.assign({ model: { display_name: 'Opus' } }, cw({ used_percentage: null, current_usage: null })));
  assert.ok(out.includes('░░░░░░░░░░░░ —'));
  assert.ok(!out.includes('0%'));
});

test('falls back to current_usage over the window size when used_percentage is missing', () => {
  assert.strictEqual(usedPercent(cw({ current_usage: { input_tokens: 50000, cache_creation_input_tokens: 25000, cache_read_input_tokens: 25000 } }).context_window), 50);
});

test('no effort field (a model without it) simply leaves it out', () => {
  assert.ok(!plain({ model: { display_name: 'Haiku' }, ...cw({ used_percentage: 5 }) }).includes('undefined'));
  assert.ok(plain({ model: { display_name: 'Haiku' }, ...cw({ used_percentage: 5 }) }).startsWith('Haiku │ ctx'));
});

test('green to 69, amber from 70, red from 85', () => {
  const colour = (p) => render(cw({ used_percentage: p }), {}).match(/\x1b\[(3\d)m█|\x1b\[(3\d)m░/)[0].slice(2, 4);
  assert.strictEqual(colour(69), '32');
  assert.strictEqual(colour(70), '33');
  assert.strictEqual(colour(85), '31');
});

test('clamps nonsense and survives garbage', () => {
  assert.ok(plain(cw({ used_percentage: 140 })).includes('100%'));
  assert.ok(plain(cw({ used_percentage: -5 })).includes(' 0%'));
  assert.doesNotThrow(() => render(null, {}));
  assert.doesNotThrow(() => render({ context_window: 'x', model: 5 }, {}));
});

test('a narrow terminal drops effort and the token counts but keeps the bar', () => {
  const out = plain(Object.assign({ model: { display_name: 'Opus' }, effort: { level: 'high' } },
    cw({ used_percentage: 50, current_usage: { input_tokens: 100000 } })), { COLUMNS: '40' });
  assert.ok(!out.includes('high') && !out.includes('k /'));
  assert.ok(out.includes('50%'));
});

test('NO_COLOR emits no escape codes', () => {
  assert.ok(!/\x1b/.test(plain(cw({ used_percentage: 90 }))));
});

test('token formatting', () => {
  assert.strictEqual(tokens(950), '950');
  assert.strictEqual(tokens(124000), '124k');
  assert.strictEqual(tokens(1000000), '1M');
  assert.strictEqual(tokens(1500000), '1.5M');
});
