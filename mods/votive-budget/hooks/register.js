// Votive budget mod. Event driven: no timers, no network, no prompts sent.
// Allowed calls (checked in CI against `claude plugin validate`): session.usage, session.cwd,
// ui.status, ui.toast, command.register, fs.read and fs.write under ~/.votive/, env.get('HOME').
import {
  budgetState, parsePolicy, parseLevels, effectivePolicy, policyFor, lowerEffort, noticeText, statusText,
  parseBudgetCommand, addHeavyProject, removeHeavyProject, DENY_REASON,
  dayKey, parseDiag, mergeDeltas, trimDiag,
} from './budget-core.mjs';

const POLICY_RE_READ_MS = 60000;
const FLUSH_EVERY_MS = 60000;
const HELP = 'Usage: /budget status | light | heavy | project heavy | project light';

// Per-session state, kept in memory only.
const mem = { pending: {}, flushedAt: 0, policy: parsePolicy(''), levels: {}, policyReadAt: 0, sessionMode: undefined, level: 'ok', session: null, weekly: null, status: undefined };

const show = (v) => (v === null ? 'n/a' : `${v}%`);

function policyPath(home) {
  return typeof home === 'string' && home.startsWith('/') ? `${home}/.votive/budget/policy.json` : undefined;
}

// Diagnostics are counts only, kept in memory and written at most once a minute (from a finished turn) and
// once when the session ends: no timers. Several sessions each add their own counts to the one small file.
function count(name) { mem.pending[name] = (mem.pending[name] || 0) + 1; }

async function flush($, force) {
  const now = Date.now();
  if (Object.keys(mem.pending).length === 0 || (!force && now - mem.flushedAt < FLUSH_EVERY_MS)) return;
  const home = await $.env.get('HOME');
  const file = typeof home === 'string' && home.startsWith('/') ? `${home}/.votive/budget/diag.json` : undefined;
  const day = dayKey(now);
  if (!file || !day) return;
  mem.flushedAt = now;
  const deltas = mem.pending;
  mem.pending = {};
  let text = '';
  try { text = await $.fs.read(file); } catch { /* first write */ }
  await $.fs.write(file, JSON.stringify(trimDiag(mergeDeltas(parseDiag(text), day, deltas))));
}

async function loadPolicy($, force) {
  const now = Date.now();
  if (!force && now - mem.policyReadAt < POLICY_RE_READ_MS) return;
  mem.policyReadAt = now;
  const file = policyPath(await $.env.get('HOME'));
  if (!file) return;
  try {
    const text = await $.fs.read(file);
    mem.policy = parsePolicy(text);
    mem.levels = parseLevels(text);
  } catch {
    mem.policy = parsePolicy('');
    mem.levels = {};
  }
}

async function savePolicy($, policy) {
  const file = policyPath(await $.env.get('HOME'));
  if (!file) return;
  await $.fs.write(file, JSON.stringify({ ...policy, ...mem.levels }));
  mem.policy = policy;
}

function refresh($, rateLimits) {
  const s = budgetState(rateLimits, mem.levels, Date.now());
  mem.level = s.level;
  mem.session = s.session;
  mem.weekly = s.weekly;
  const eff = effectivePolicy(mem.policy, mem.sessionMode);
  const text = statusText(s.level, eff.mode, s.session);
  if (text !== mem.status) {
    mem.status = text;
    $.ui.status(text);
  }
}

async function current($) {
  return policyFor(mem.level, effectivePolicy(mem.policy, mem.sessionMode), await $.session.cwd());
}

export function register(on) {
  on('session.measure', async ($, e, next) => {
    try {
      await loadPolicy($, false);
      refresh($, e.rateLimits);
      count('measures');
      if (mem.level !== 'ok') count('overLevel');
    } catch {}
    return next(e);
  });

  on('agent.spawn', async ($, e, next) => {
    try {
      if ((await current($)).denySpawn) { count('spawnDenied'); return { deny: DENY_REASON }; }
    } catch {}
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    let input = e;
    try {
      if ((await current($)).lowerEffort) { input = { ...e, effort: lowerEffort(e.effort) }; count('effortLowered'); }
    } catch {}
    const result = yield* next(input);
    return result;
  });

  on('prompt.submit', async ($, e, next) => {
    try {
      if ((await current($)).notice) { count('noticeAdded'); return next({ ...e, context: [...(e.context ?? []), noticeText(mem.session, mem.weekly)] }); }
    } catch {}
    return next(e);
  });

  on('command.run', async ($, e, next) => {
    if (e.command !== 'budget') return next(e);
    try {
      count('commands');
      await loadPolicy($, true);
      const cmd = parseBudgetCommand(e.args);
      const cwd = await $.session.cwd();
      if (cmd.action === 'light') mem.sessionMode = 'light';
      else if (cmd.action === 'heavy') mem.sessionMode = 'heavy';
      else if (cmd.action === 'projectHeavy') await savePolicy($, addHeavyProject(mem.policy, cwd));
      else if (cmd.action === 'projectLight') await savePolicy($, removeHeavyProject(mem.policy, cwd));
      else if (cmd.action === 'help') return { text: HELP };
      const eff = effectivePolicy(mem.policy, mem.sessionMode);
      const usage = await $.session.usage();
      refresh($, usage && usage.rateLimits);
      return { text: `budget: ${eff.mode}, level ${mem.level}, session ${show(mem.session)}, week ${show(mem.weekly)}` };
    } catch {
      return { text: HELP };
    }
  });

  on('session.start', async ($, e, next) => {
    try {
      count('sessions');
      await loadPolicy($, true);
      $.command.register({ name: 'budget', description: 'Budget mode: status, light, heavy, project heavy|light', argumentHint: 'status|light|heavy|project heavy' });
    } catch {}
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    try { await flush($, false); } catch {}
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    try { await flush($, true); } catch {}
    return next(e);
  });
}
