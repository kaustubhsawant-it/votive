#!/usr/bin/env node
'use strict';
//
// Claude Code status line: model, effort and a context-window progress bar.
//
//   Opus · high │ ctx ████████░░░░ 62%  124k / 200k
//
// Runs as the command Votive's statusLine wrapper chains to (the "wrapped" command in
// ~/.votive/usage/wrapped.json), so usage recording keeps working and this only has to
// print. Claude Code pipes one JSON payload on stdin; the fields used are all optional, and a
// missing one is shown as missing, never as zero:
//
//   model.display_name            "Opus"
//   effort.level                  low | medium | high | xhigh | max   (absent on models without it)
//   context_window.used_percentage   number, or null early in a session and after /compact
//   context_window.current_usage     { input_tokens, cache_creation_input_tokens,
//                                      cache_read_input_tokens, ... }, or null
//   context_window.context_window_size   200000 or 1000000
//
// The bar is green until 70%, amber to 85%, red beyond — the colour is a second signal; the
// percentage is always printed, and NO_COLOR is honoured. Never throws: on any problem it prints
// nothing and exits 0, so it cannot break the status line.
//
const BAR = 12;
const ESC = '\x1b[';

function tokens(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

// Percent of the window in use, or null when it genuinely cannot be known yet.
function usedPercent(cw) {
  if (!cw || typeof cw !== 'object') return null;
  if (typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)) {
    return Math.min(100, Math.max(0, cw.used_percentage));
  }
  const u = cw.current_usage, size = cw.context_window_size;
  if (u && typeof u === 'object' && Number.isFinite(size) && size > 0) {
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    return Math.min(100, Math.max(0, (used / size) * 100));
  }
  return null;
}

function usedTokens(cw) {
  const u = cw && cw.current_usage;
  if (!u || typeof u !== 'object') return null;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

function tone(pct) { return pct >= 85 ? 31 : pct >= 70 ? 33 : 32; }

function render(payload, env) {
  const color = !(env && env.NO_COLOR);
  const paint = (code, s) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
  const cols = Number((env && env.COLUMNS) || 0);
  const narrow = cols > 0 && cols < 60;

  const model = payload && payload.model && payload.model.display_name;
  const effort = payload && payload.effort && payload.effort.level;
  const cw = payload && payload.context_window;
  const pct = usedPercent(cw);

  const head = [];
  if (model) head.push(model);
  if (effort && !narrow) head.push(effort);

  let ctx;
  if (pct === null) {
    ctx = `${paint(2, 'ctx')} ${paint(2, '░'.repeat(BAR))} ${paint(2, '—')}`;
  } else {
    const filled = Math.round((pct / 100) * BAR);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR - filled);
    const code = tone(pct);
    ctx = `${paint(2, 'ctx')} ${paint(code, bar)} ${paint(code, Math.round(pct) + '%')}`;
    const used = usedTokens(cw), size = cw && cw.context_window_size;
    if (!narrow && used !== null && Number.isFinite(size) && size > 0) {
      ctx += paint(2, `  ${tokens(used)} / ${tokens(size)}`);
    }
  }
  return (head.length ? head.join(paint(2, ' · ')) + paint(2, ' │ ') : '') + ctx;
}

module.exports = { render, usedPercent, tokens };

if (require.main === module) {
  let buf = '';
  const guard = setTimeout(() => process.exit(0), 2000);   // never hang if stdin never closes
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(guard);
    try { process.stdout.write(render(JSON.parse(buf || '{}'), process.env) + '\n'); } catch (e) { /* print nothing */ }
    process.exit(0);
  });
}
