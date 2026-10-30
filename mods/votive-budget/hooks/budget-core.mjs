// Pure logic of the Votive budget mod. No imports, no I/O, no clock: callers pass in what
// the functions need, so the same file is loaded by the mod and by the node tests.
// Fail-open everywhere: anything unexpected means "ok" and "light", never an error.

const DEFAULT_SESSION_AT = 85;
const CRITICAL_AT = 97;
const MAX_POLICY_BYTES = 8192;
const MAX_HEAVY_PROJECTS = 50;
const MAX_PATH_LENGTH = 256;

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.floor(v) : null);
const level100 = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100 ? v : null);

// One plan window as an integer percent, or null when it is missing, malformed or already reset.
function windowPercent(rateLimits, kind, nowMs) {
  if (!Array.isArray(rateLimits)) return null;
  for (const w of rateLimits) {
    if (!w || typeof w !== 'object' || w.kind !== kind) continue;
    const value = pct(w.percentUsed);
    if (value === null) continue;
    if (typeof w.resetsAt === 'string') {
      const t = Date.parse(w.resetsAt);
      if (Number.isFinite(t) && t <= nowMs) continue;
    }
    return value;
  }
  return null;
}

// level: 'ok' | 'conserve' | 'critical'. The weekly level counts only when the user set one.
export function budgetState(rateLimits, settings, nowMs) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const sessionAt = level100(s.sessionAt) ?? DEFAULT_SESSION_AT;
  const weeklyAt = level100(s.weeklyAt);
  const session = windowPercent(rateLimits, 'five_hour', nowMs);
  const weekly = windowPercent(rateLimits, 'seven_day', nowMs);
  const sessionOver = session !== null && session >= sessionAt;
  const weeklyOver = weeklyAt !== null && weekly !== null && weekly >= weeklyAt;
  let level = 'ok';
  if (sessionOver || weeklyOver) {
    level = (sessionOver && session >= CRITICAL_AT) || (weeklyOver && weekly >= CRITICAL_AT) ? 'critical' : 'conserve';
  }
  return { level, session, weekly };
}

// Optional levels in the same policy file (menu or a test run can lower them). Integers 1..100 only.
export function parseLevels(text) {
  if (typeof text !== 'string' || text.length > MAX_POLICY_BYTES) return {};
  let data;
  try { data = JSON.parse(text); } catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  const s = level100(data.sessionAt);
  const w = level100(data.weeklyAt);
  if (s !== null) out.sessionAt = s;
  if (w !== null) out.weeklyAt = w;
  return out;
}

const LIGHT = Object.freeze({ mode: 'light', heavyProjects: [] });
const cleanPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LENGTH && p.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(p);

// The policy file is read as data: a closed enum and a short list of clean absolute folders.
// Anything else leaves the session light.
export function parsePolicy(text) {
  if (typeof text !== 'string' || text.length > MAX_POLICY_BYTES) return { ...LIGHT, heavyProjects: [] };
  let data;
  try { data = JSON.parse(text); } catch { return { ...LIGHT, heavyProjects: [] }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...LIGHT, heavyProjects: [] };
  if (data.mode !== 'light' && data.mode !== 'heavy') return { ...LIGHT, heavyProjects: [] };
  if (data.heavyProjects !== undefined && !Array.isArray(data.heavyProjects)) return { ...LIGHT, heavyProjects: [] };
  const list = Array.isArray(data.heavyProjects) ? data.heavyProjects.filter(cleanPath).slice(0, MAX_HEAVY_PROJECTS) : [];
  return { mode: data.mode, heavyProjects: list };
}

function inFolder(cwd, folder) {
  if (!cleanPath(cwd) || cwd.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  const base = folder.endsWith('/') ? folder : folder + '/';
  return cwd === folder || cwd.startsWith(base);
}

export function isHeavy(policy, cwd) {
  if (!policy || typeof policy !== 'object') return false;
  if (policy.mode === 'heavy') return true;
  return Array.isArray(policy.heavyProjects) && policy.heavyProjects.some((f) => cleanPath(f) && inFolder(cwd, f));
}

export const isCleanFolder = (p) => cleanPath(p) && !p.split('/').some((seg) => seg === '..' || seg === '.');
const asPolicy = (policy) => (policy && typeof policy === 'object' && (policy.mode === 'light' || policy.mode === 'heavy') && Array.isArray(policy.heavyProjects)
  ? { mode: policy.mode, heavyProjects: policy.heavyProjects.filter(cleanPath).slice(0, MAX_HEAVY_PROJECTS) }
  : { mode: 'light', heavyProjects: [] });

export function addHeavyProject(policy, folder) {
  const p = asPolicy(policy);
  if (!isCleanFolder(folder) || p.heavyProjects.includes(folder) || p.heavyProjects.length >= MAX_HEAVY_PROJECTS) return p;
  return { mode: p.mode, heavyProjects: [...p.heavyProjects, folder] };
}

export function removeHeavyProject(policy, folder) {
  const p = asPolicy(policy);
  return { mode: p.mode, heavyProjects: p.heavyProjects.filter((f) => f !== folder) };
}

// A choice typed by the user for this session wins over the file; an unknown value is ignored.
export function effectivePolicy(filePolicy, sessionMode) {
  if (sessionMode === 'heavy') return { mode: 'heavy', heavyProjects: [] };
  if (sessionMode === 'light') return { mode: 'light', heavyProjects: [] };
  return asPolicy(filePolicy);
}

// What the mod does at this level for this session. Light sessions are limited above the level;
// heavy sessions are left alone and only hear about it at critical.
export function policyFor(level, policy, cwd) {
  const off = { denySpawn: false, lowerEffort: false, notice: false };
  if (level !== 'conserve' && level !== 'critical') return off;
  if (isHeavy(policy, cwd)) return level === 'critical' ? { ...off, notice: true } : off;
  return { denySpawn: true, lowerEffort: true, notice: true };
}

// Only lowers: every input, known or not, becomes the lowest setting.
export function lowerEffort(_current) {
  return 'low';
}

export const DENY_REASON = 'Votive budget mode: plan usage is above your limit, so new subagents are paused in this session. Use /budget heavy to allow them.';

export function noticeText(session, weekly) {
  const s = pct(session);
  const w = pct(weekly);
  const head = 'Votive budget notice: plan usage is ';
  let usage = 'above the limit you set';
  if (s !== null && w !== null) usage = `${s}% for the session and ${w}% for the week, above the limit you set`;
  else if (s !== null) usage = `${s}% for the session, above the limit you set`;
  else if (w !== null) usage = `${w}% for the week, above the limit you set`;
  return `${head}${usage}. Keep work lean: avoid launching many subagents, read small parts of files, and write a short handoff note now so work can resume after the limit resets. You can ignore this if the task is nearly done.`;
}

export function statusText(level, mode, session) {
  if (level !== 'conserve' && level !== 'critical') return undefined;
  const m = mode === 'heavy' ? 'heavy' : 'light';
  const s = pct(session);
  const used = s === null ? '' : `, session ${s}%`;
  return m === 'light' ? `budget: light${used}, /budget heavy to allow` : `budget: heavy${used}`;
}

// The words /budget understands. Anything else is help text; nothing from the argument is echoed.
export function parseBudgetCommand(args) {
  if (typeof args !== 'string') return { action: 'help' };
  const a = args.trim().toLowerCase();
  if (a === '' || a === 'status') return { action: 'status' };
  if (a === 'light') return { action: 'light' };
  if (a === 'heavy') return { action: 'heavy' };
  if (a === 'project heavy') return { action: 'projectHeavy' };
  if (a === 'project light') return { action: 'projectLight' };
  return { action: 'help' };
}

// ---------- diagnostics: counts only, the last 14 days, 4 KB ----------
// What the mod did, as numbers per UTC day: nothing about what you worked on, no paths, no text. A closed
// set of counter names, so a file with anything else in it cannot add words or keys.

export const COUNTERS = Object.freeze(['measures', 'overLevel', 'spawnDenied', 'effortLowered', 'noticeAdded', 'commands', 'sessions']);
const COUNTER_SET = new Set(COUNTERS);
const MAX_COUNT = 1e9;
const MAX_DAYS = 14;
const MAX_DIAG_BYTES = 4096;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDay(k) {
  if (typeof k !== 'string' || !DAY_RE.test(k)) return false;
  const d = new Date(k + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === k;   // 2026-13-45 and 2026-02-30 are not days
}
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const emptyDiag = () => ({ v: 1, days: {} });

/** The UTC date (YYYY-MM-DD) of a time in ms, or null when it is not a time. */
export function dayKey(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function newestDays(days, max) {
  const out = {};
  for (const k of Object.keys(days).sort().slice(-max)) out[k] = days[k];
  return out;
}

/** The diagnostics file as data: known counters, whole non-negative numbers, real days, newest 14. */
export function parseDiag(text) {
  if (typeof text !== 'string' || text.length > 2 * MAX_DIAG_BYTES) return emptyDiag();
  let data;
  try { data = JSON.parse(text); } catch { return emptyDiag(); }
  if (!isPlain(data) || data.v !== 1 || !isPlain(data.days)) return emptyDiag();
  const days = {};
  for (const k of Object.keys(data.days)) {
    if (!isDay(k) || !isPlain(data.days[k])) continue;
    const row = {};
    for (const name of COUNTERS) {
      const n = data.days[k][name];
      if (Number.isInteger(n) && n > 0 && n <= MAX_COUNT) row[name] = n;
    }
    if (Object.keys(row).length) days[k] = row;
  }
  return { v: 1, days: newestDays(days, MAX_DAYS) };
}

/** A new diagnostics object with `n` added to one counter on one day. Anything invalid changes nothing. */
export function bump(diag, day, counter, n = 1) {
  const base = isPlain(diag) && isPlain(diag.days) ? diag : emptyDiag();
  if (!COUNTER_SET.has(counter) || !isDay(day) || !Number.isInteger(n) || n <= 0) return base;
  const row = isPlain(base.days[day]) ? base.days[day] : {};
  const next = Math.min(MAX_COUNT, (Number.isInteger(row[counter]) ? row[counter] : 0) + n);
  return { v: 1, days: { ...base.days, [day]: { ...row, [counter]: next } } };
}

/** Several counters at once: `deltas` is {counterName: n}; unknown names are ignored. */
export function mergeDeltas(diag, day, deltas) {
  let out = isPlain(diag) && isPlain(diag.days) ? diag : emptyDiag();
  if (!isDay(day) || !isPlain(deltas)) return out;
  for (const name of COUNTERS) if (Object.prototype.hasOwnProperty.call(deltas, name)) out = bump(out, day, name, deltas[name]);
  return out;
}

/** Keep the newest `maxDays` days and drop the oldest first until it fits `maxBytes`. */
export function trimDiag(diag, maxDays = MAX_DAYS, maxBytes = MAX_DIAG_BYTES) {
  const base = isPlain(diag) && isPlain(diag.days) ? diag : emptyDiag();
  let days = newestDays(base.days, maxDays);
  while (JSON.stringify({ v: 1, days }).length > maxBytes && Object.keys(days).length > 0) days = newestDays(days, Object.keys(days).length - 1);
  return { v: 1, days };
}

/** Each counter summed over every kept day. */
export function totals(diag) {
  const sums = {};
  if (!isPlain(diag) || !isPlain(diag.days)) return sums;
  for (const k of Object.keys(diag.days)) for (const name of COUNTERS) {
    const n = isPlain(diag.days[k]) ? diag.days[k][name] : undefined;
    if (Number.isInteger(n) && n > 0) sums[name] = (sums[name] || 0) + n;
  }
  return sums;
}
