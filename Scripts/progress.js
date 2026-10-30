'use strict';
//
// Task progress for a session, kept in its event file and rendered into the status line.
//
// Three questions, answered from what the agent actually did and never from the clock:
//
//   1. How far along is it?  The agent's own task list: Claude Code's TodoWrite or
//      TaskCreate/TaskUpdate, Codex's update_plan, Gemini's write_todos, Cursor's todo_write.
//      Taken from each PostToolUse payload as it happens, with a transcript-tail scan at Stop
//      as a fallback. No task list means no number: state only, never a made-up %.
//   2. Did it finish, or stop to ask you something?  At Stop, the last assistant message is
//      checked for a question or a request for approval (→ waiting/question), then the task
//      list for open items (→ waiting/open-tasks). Otherwise it is done.
//   2b. Is it still running something in the background?  Claude Code's background agents and
//      commands outlive the turn. Launches and their <task-notification> completions are
//      matched by id in the transcript; while any are outstanding the turn is not done.
//   3. How long has it been in this state or step?  `stateSince`, reset when the state or
//      the active step changes, so one long step does not look frozen.
//
// Everything here is pure except readTail(), which reads at most TAIL_BYTES of a transcript.
//
const fs = require('fs');

const TAIL_BYTES = 256 * 1024;
const MAX_ITEMS = 50;
const MAX_TEXT = 80;
const MAX_WIDTH = 40;                    // whole segment, visible columns (code points)
const STALE_PLAN_MS = 10 * 60 * 1000;    // an unfinished list untouched this long is a past job
const BG_MAX_AGE_MS = 12 * 60 * 60 * 1000; // a launch with no completion after this is presumed lost

// ---------- small helpers

/** Strip control characters (incl. ESC, so model text can't inject terminal escapes) and
 *  collapse whitespace; clip by code points so an emoji is never split. */
function clean(s, max = MAX_TEXT) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : t;
}

function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) {}
  }
  return null;
}

function normStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[\s-]/g, '_');
  if (v === 'completed' || v === 'complete' || v === 'done') return 'completed';
  if (v === 'in_progress' || v === 'inprogress' || v === 'active' || v === 'running') return 'in_progress';
  if (v === 'cancelled' || v === 'canceled' || v === 'deleted' || v === 'removed') return 'dropped';
  return 'pending';
}

function item(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clean(raw.content || raw.step || raw.description || raw.title || raw.subject || raw.text || '');
  if (!text) return null;
  const it = { text, status: normStatus(raw.status) };
  const id = raw.id != null ? String(raw.id) : fallbackId;
  if (id) it.id = clean(id, 40);
  const active = clean(raw.activeForm || raw.active_form || '');
  if (active) it.activeForm = active;
  return it;
}

const cap = (items) => items.filter((i) => i.status !== 'dropped').slice(0, MAX_ITEMS);

// ---------- task lists from tool calls

// Tools whose input is the whole list (replace it), or a partial list when `merge` is true.
const LIST_TOOLS = new Set(['todowrite', 'todo_write', 'write_todos', 'update_plan', 'updateplan', 'todo']);

/**
 * Apply one tool call to the task list. `plan` is the previous list (array or undefined).
 * Returns the new array, or undefined when the tool has nothing to do with task lists.
 */
function applyTool(plan, toolName, toolInput, toolResponse) {
  const name = String(toolName || '').toLowerCase();
  const input = asObject(toolInput) || {};
  const prev = Array.isArray(plan) ? plan.map((i) => Object.assign({}, i)) : [];

  if (LIST_TOOLS.has(name)) {
    const list = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan
      : Array.isArray(input.items) ? input.items : null;
    if (!list) return undefined;
    const incoming = list.map((r, n) => item(r, String(n + 1))).filter(Boolean);
    if (input.merge === true) {
      for (const it of incoming) {
        const at = prev.findIndex((p) => p.id && p.id === it.id);
        if (at === -1) prev.push(it); else prev[at] = Object.assign(prev[at], it);
      }
      return cap(prev);
    }
    return cap(incoming);
  }

  if (name === 'taskcreate') {
    const resp = asObject(toolResponse) || {};
    let id = resp.task && resp.task.id != null ? String(resp.task.id) : null;
    if (!id && typeof toolResponse === 'string') { const m = /#(\d+)/.exec(toolResponse); if (m) id = m[1]; }
    if (!id) {   // Claude Code numbers tasks 1, 2, 3… within a session
      const nums = prev.map((p) => parseInt(p.id, 10)).filter(Number.isFinite);
      id = String((nums.length ? Math.max(...nums) : 0) + 1);
    }
    const it = item(Object.assign({}, input, { id, status: input.status || 'pending' }), id);
    if (!it) return undefined;
    const at = prev.findIndex((p) => p.id === id);
    if (at === -1) prev.push(it); else prev[at] = it;
    return cap(prev);
  }

  if (name === 'taskupdate') {
    const id = input.taskId != null ? String(input.taskId) : input.id != null ? String(input.id) : null;
    if (!id) return undefined;
    const at = prev.findIndex((p) => p.id === id);
    if (at === -1) return undefined;   // created before we started watching; nothing to count
    if (input.status) prev[at].status = normStatus(input.status);
    if (input.subject) prev[at].text = clean(input.subject);
    if (input.activeForm) prev[at].activeForm = clean(input.activeForm);
    return cap(prev);
  }
  return undefined;
}

/** { done, total, label } for a task list; label is the in-progress step, if any. */
function summarize(plan) {
  if (!Array.isArray(plan) || !plan.length) return null;
  const total = plan.length;
  const done = plan.filter((i) => i.status === 'completed').length;
  const cur = plan.find((i) => i.status === 'in_progress');
  return { done, total, label: cur ? (cur.activeForm || cur.text) : null };
}

// ---------- reading a transcript tail

/** The last TAIL_BYTES of a file as complete lines (the first, partial line is dropped). */
function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    return lines;
  } catch (e) { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && (b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string')
    .map((b) => b.text).join('\n');
}

// ---------- background agents and commands (Claude Code)

/** A background launch recorded in a tool result: { id, kind: 'agent' | 'command' } or null.
 *  Read from the structured toolUseResult only, never from text, so a transcript that merely
 *  quotes a launch message can't invent one. */
function launchOf(j) {
  if (j.type !== 'user') return null;
  const r = j.toolUseResult;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if ((r.status === 'async_launched' || r.isAsync === true) && typeof r.agentId === 'string' && r.agentId) {
    return { id: r.agentId, kind: 'agent' };
  }
  if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) return { id: r.backgroundTaskId, kind: 'command' };
  return null;
}

const NOTE = /<task-id>([^<\s]+)<\/task-id>[\s\S]*?<status>([a-z_]+)<\/status>/g;

/** Ids finished per a <task-notification> entry (queued or delivered), any final status. */
function finishedIn(j) {
  let text = '';
  if (j.type === 'queue-operation' && typeof j.content === 'string') text = j.content;
  else if (j.type === 'user' && j.message) {
    const c = j.message.content;
    const t = typeof c === 'string' ? c : textOf(c);
    if ((j.origin && j.origin.kind === 'task-notification') || t.trimStart().startsWith('<task-notification>')) text = t;
  }
  if (text.indexOf('<task-notification>') === -1) return [];
  const ids = [];
  for (const m of text.matchAll(NOTE)) ids.push(m[1]);
  return ids;
}

const stamp = (j) => { const t = Date.parse(j.timestamp); return Number.isFinite(t) ? t : null; };

/** Background work launched in the tail and not yet finished: [{ id, kind, at }]. */
function outstanding(parsed, now) {
  const live = new Map();
  for (const j of parsed) {
    const l = launchOf(j);
    if (l) { live.set(l.id, { id: l.id, kind: l.kind, at: stamp(j) }); continue; }
    for (const id of finishedIn(j)) live.delete(id);
  }
  return [...live.values()].filter((b) => b.at === null || now - b.at < BG_MAX_AGE_MS);
}

/** Of `ids`, the ones a transcript tail shows as finished. Cheap: only lines that mention a
 *  task id are parsed. Used by the status line to count down without waiting for a hook. */
function finishedIds(file, ids) {
  const done = new Set();
  if (typeof file !== 'string' || !Array.isArray(ids) || !ids.length) return done;
  for (const line of readTail(file)) {
    if (line.indexOf('<task-id>') === -1) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    if (j && typeof j === 'object') for (const id of finishedIn(j)) if (ids.includes(id)) done.add(id);
  }
  return done;
}

/** A human prompt line (not a tool result, a task notification, or an injected meta line). */
function isPrompt(j) {
  if (j.type === 'user' && j.message && !j.isMeta) {
    if (j.origin && j.origin.kind === 'task-notification') return false;
    const c = j.message.content;
    if (typeof c === 'string') return !c.trimStart().startsWith('<task-notification>');
    return Array.isArray(c) && c.some((b) => b && b.type === 'text') && !c.some((b) => b && b.type === 'tool_result');
  }
  const p = j.type === 'response_item' && j.payload;
  return !!(p && p.type === 'message' && p.role === 'user');
}

/**
 * Scan a JSONL transcript tail (Claude Code or Codex rollout) for the last assistant text
 * and the task list. Task-list calls made since the last human prompt are replayed on top of
 * `seed` (the list the hooks recorded), so the transcript corrects anything the hooks lost,
 * while earlier jobs in the tail can't bring back a list that was already dropped.
 * Unknown shapes are skipped line by line.
 */
function scanTranscript(file, seed, now) {
  const out = { lastText: '', plan: seed, background: [] };
  if (typeof file !== 'string' || !/\.jsonl$/.test(file)) return out;
  const parsed = [];
  for (const line of readTail(file)) {
    if (!line || line.length > 4 << 20) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object') parsed.push(j); } catch (e) {}
  }
  let from = 0;
  for (let i = parsed.length - 1; i >= 0; i--) if (isPrompt(parsed[i])) { from = i + 1; break; }
  const pendingCreates = new Map();   // Claude tool_use id → TaskCreate input
  for (let i = 0; i < parsed.length; i++) {
    const j = parsed[i];
    const replay = i >= from;

    // Claude Code: {type:'assistant', message:{content:[text | tool_use]}}
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      const t = textOf(j.message.content);
      if (t.trim()) out.lastText = t;
      if (!replay) continue;
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name === 'TaskCreate') { pendingCreates.set(b.id, b.input); continue; }
        const next = applyTool(out.plan, b.name, b.input);
        if (next) out.plan = next;
      }
      continue;
    }
    // Claude Code: the TaskCreate result carries the task id.
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_result' || !pendingCreates.has(b.tool_use_id)) continue;
        const resp = j.toolUseResult || textOf(b.content) || b.content;
        const next = applyTool(out.plan, 'TaskCreate', pendingCreates.get(b.tool_use_id), resp);
        pendingCreates.delete(b.tool_use_id);
        if (next) out.plan = next;
      }
      continue;
    }
    // Codex rollout: {type:'response_item', payload:{type:'message'|'function_call', ...}}
    const p = j.type === 'response_item' && j.payload;
    if (p && p.type === 'message' && p.role === 'assistant') {
      const t = textOf(p.content);
      if (t.trim()) out.lastText = t;
    } else if (replay && p && p.type === 'function_call') {
      const next = applyTool(out.plan, p.name, p.arguments);
      if (next) out.plan = next;
    }
  }
  for (const input of pendingCreates.values()) {   // result fell outside the tail or never came
    const next = applyTool(out.plan, 'TaskCreate', input);
    if (next) out.plan = next;
  }
  out.background = outstanding(parsed, now || Date.now());
  return out;
}

// ---------- did it stop to ask?

// Explicit hand-backs that don't always end in "?". Soft sign-offs ("let me know if…") on
// finished work are deliberately NOT here: those turns are done.
const ASKS = /\b(waiting (for|on) (you|your)|awaiting your|need(s)? your (approval|confirmation|go-ahead|input|decision)|please (confirm|approve|choose|pick|decide)|before I (proceed|continue|go ahead)|(shall|should) I (proceed|continue|go ahead)|your call)\b/i;

/** Strip the decoration a message tends to end with: markdown emphasis, quotes, brackets. */
const tidy = (line) => line.replace(/[*_`~>"'”’)\]\s]+$/u, '').replace(/^[\s>*_#-]+/u, '');

/**
 * { question: true, excerpt } when the text hands the turn back to the user; null otherwise.
 * Looks at the last three non-empty lines, so a trailing sign-off line doesn't hide the ask.
 */
function detectQuestion(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const body = text.replace(/```[\s\S]*?```/g, ' ');   // a "?" inside code is not a question
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = tidy(lines[i]);
    if (/\?$/.test(l) || ASKS.test(l)) {
      // The last sentence of that line is the excerpt.
      const sentences = l.split(/(?<=[.!?])\s+/).filter(Boolean);
      return { question: true, excerpt: clean(sentences[sentences.length - 1] || l, 60) };
    }
  }
  return null;
}

/**
 * What a Stop means. `lastText` is the final assistant message, `plan` the task list.
 * Returns { state, waitReason?, detail? }.
 */
function classifyStop(lastText, plan) {
  const q = detectQuestion(lastText);
  if (q) return { state: 'waiting', waitReason: 'question', detail: q.excerpt };
  const s = summarize(plan);
  if (s && s.done < s.total) return { state: 'waiting', waitReason: 'open-tasks' };
  return { state: 'done' };
}

// ---------- one hook event → the progress fields of the event record

/**
 * Given the previous record, the normalized state and the raw payload, return the progress
 * fields to store: { state, plan?, waitReason?, detail?, stateSince }. Never throws.
 */
function track(prev, state, payload, opts = {}) {
  const now = opts.now || Date.now();
  const p = payload && typeof payload === 'object' ? payload : {};
  const pr = prev && typeof prev === 'object' ? prev : {};
  let plan = Array.isArray(pr.plan) ? pr.plan : undefined;
  let planAt = typeof pr.planAt === 'number' ? pr.planAt : undefined;
  let promptAt = typeof pr.promptAt === 'number' ? pr.promptAt : undefined;
  const out = { state };

  const next = applyTool(plan, p.tool_name || p.toolName, p.tool_input || p.toolInput || p.tool_args,
    p.tool_response || p.toolResponse || p.tool_output);
  if (next) { plan = next; planAt = now; }

  // A new prompt starts clean when the old list is finished, or unfinished but untouched for
  // STALE_PLAN_MS (an abandoned job). A recent unfinished list is kept ("continue"), but its
  // step label stays hidden until the list is touched again (see segment()).
  const isPromptEvent = state === 'working' && !!opts.eventName && /prompt/i.test(opts.eventName);
  if (isPromptEvent) {
    promptAt = now;
    const s = summarize(plan);
    if (s && (s.done === s.total || planAt === undefined || now - planAt > STALE_PLAN_MS)) {
      plan = undefined; planAt = undefined;
    }
  }

  if (state === 'waiting') {
    const tool = clean(p.tool_name || '', 30);
    out.waitReason = 'permission';
    if (tool) out.detail = 'approve ' + tool;
  } else if (state === 'error') {
    const msg = typeof p.error === 'string' ? p.error : (p.tool_response && typeof p.tool_response.error === 'string' ? p.tool_response.error : '');
    const d = clean(msg, 50) || clean(p.tool_name || '', 30);
    if (d) out.detail = d;
  } else if (state === 'done' && opts.classify !== false) {
    let text = [p.last_assistant_message, p.prompt_response, p.lastAssistantMessage]
      .find((v) => typeof v === 'string' && v.trim()) || '';
    // The transcript is authoritative for this turn's task list: parallel tool calls run
    // their hooks concurrently, and replaying the turn fixes anything a hook missed.
    const scan = scanTranscript(opts.transcriptPath, plan, now);
    if (!text) text = scan.lastText;
    if (scan.plan && JSON.stringify(scan.plan) !== JSON.stringify(plan)) { plan = scan.plan; planAt = now; }
    // Precedence: a question > background work still running > open tasks > done.
    const q = detectQuestion(text);
    const rest = classifyStop('', plan);
    if (q) Object.assign(out, { state: 'waiting', waitReason: 'question', detail: q.excerpt });
    else if (scan.background.length) {
      out.state = 'working';
      out.bg = { at: now, ids: scan.background.map((b) => b.id), kinds: scan.background.map((b) => b.kind), then: rest };
    } else Object.assign(out, rest);
  } else if (pr.bg && !isPromptEvent) {
    // Tool calls from the background agents themselves report under this session; keep the
    // count until the next Stop recomputes it. A new prompt is a new job and drops it.
    out.bg = pr.bg;
  }

  if (plan && plan.length) {
    out.plan = plan;
    if (planAt !== undefined) out.planAt = planAt;
  }
  if (promptAt !== undefined) out.promptAt = promptAt;
  // Elapsed restarts when the state, the reason or the active step changes.
  const step = (s) => { const x = summarize(s); return x && x.label; };
  const same = prev && prev.lastEvent === out.state && prev.waitReason === out.waitReason && !prev.bg === !out.bg
    && step(prev.plan) === step(out.plan) && typeof prev.stateSince === 'number';
  out.stateSince = same ? prev.stateSince : now;
  return out;
}

// ---------- the status-line segment

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h > 99) return '99h+';
  return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

const COLORS = { working: '36', background: '34', waiting: '35', stopped: '33', done: '32', error: '31' };

const width = (t) => Array.from(t).length;

/** head + text + tail within MAX_WIDTH, clipping text; null when not even `min` columns fit. */
function fit(head, text, tail, min = 6) {
  const room = MAX_WIDTH - width(head) - width(tail);
  if (room < min) return null;
  return head + clean(text, room) + tail;
}

/**
 * One status-line segment for an event record, or '' when there is nothing worth showing
 * (no record, a fresh session, an unknown state). At most MAX_WIDTH visible columns: the
 * status line is not told the terminal width, and the user's own status line follows.
 * `color: false` drops the ANSI codes.
 */
function segment(rec, opts = {}) {
  if (!rec || typeof rec !== 'object') return '';
  const now = opts.now || Date.now();
  const since = typeof rec.stateSince === 'number' ? rec.stateSince : rec.lastEventAt;
  const age = typeof since === 'number' ? duration(now - since) : null;
  const s = summarize(rec.plan);
  const counts = s ? s.done + '/' + s.total : null;
  const detail = clean(rec.detail || '', MAX_WIDTH);
  const ageTail = age ? ' · ' + age : '';
  // A list kept across a new prompt doesn't name its old step until it's touched again.
  const fresh = !(typeof rec.promptAt === 'number' && !(typeof rec.planAt === 'number' && rec.planAt >= rec.promptAt));
  let kind, text;

  // Background work outlives the turn. `opts.finished` (ids the status line has since seen
  // complete in the transcript) counts it down between hook events.
  const bg = rec.bg && typeof rec.bg === 'object' && Array.isArray(rec.bg.ids) ? rec.bg : null;
  if (bg) {
    const fin = opts.finished instanceof Set ? opts.finished : new Set();
    const kinds = bg.ids.map((id, i) => (fin.has(id) ? null : (bg.kinds && bg.kinds[i]) || 'agent')).filter(Boolean);
    if (kinds.length) {
      const a = kinds.filter((k) => k === 'agent').length, c = kinds.length - a;
      const what = c === 0 ? a + (a === 1 ? ' agent' : ' agents')
        : a === 0 ? c + (c === 1 ? ' command' : ' commands') : kinds.length + ' background tasks';
      const t = typeof bg.at === 'number' ? ' · ' + duration(now - bg.at) : '';
      text = '◐ ' + what + ' running' + t;
      return opts.color === false ? text : '\x1b[' + COLORS.background + 'm' + text + '\x1b[0m';
    }
    // All finished. Untouched since the Stop → what that Stop would have been without them;
    // otherwise the agent has moved on and the record's own state stands.
    if (bg.then && typeof bg.then === 'object' && !(rec.lastEventAt > bg.at + 1000)) {
      return segment(Object.assign({}, rec, { bg: undefined, lastEvent: bg.then.state, waitReason: bg.then.waitReason, stateSince: bg.at }), opts);
    }
  }

  switch (rec.lastEvent) {
    case 'working': {
      kind = 'working';
      const tail = (s ? ' · ' + counts + ' · ' + Math.round((s.done / s.total) * 100) + '%' : '') + ageTail;
      const label = s && s.label && fresh ? s.label : 'Working';
      text = fit('● ', label, tail) || '● Working' + tail;
      break;
    }
    case 'waiting':
      if (rec.waitReason === 'open-tasks') {
        kind = 'stopped';
        text = '⏸ Stopped' + (s ? ' · ' + counts + ' done' : '') + ageTail;
      } else {
        kind = 'waiting';
        const full = '⏸ Waiting on you' + (detail ? ': ' + detail : '') + ageTail;
        text = width(full) <= MAX_WIDTH ? full : (fit('⏸ Waiting: ', detail, ageTail) || '⏸ Waiting on you' + ageTail);
      }
      break;
    case 'done':
      kind = 'done';
      text = '✓ Done' + (s ? ' ' + counts : '');
      break;
    case 'error':
      kind = 'error';
      text = (detail && fit('✗ Error: ', detail, ageTail)) || '✗ Error' + ageTail;
      break;
    default:
      return '';
  }
  if (width(text) > MAX_WIDTH) text = clean(text, MAX_WIDTH);   // belt and braces
  return opts.color === false ? text : '\x1b[' + COLORS[kind] + 'm' + text + '\x1b[0m';
}

module.exports = {
  applyTool, summarize, scanTranscript, detectQuestion, classifyStop, track, segment,
  duration, clean, readTail, TAIL_BYTES, MAX_WIDTH, STALE_PLAN_MS,
  finishedIds, launchOf, finishedIn, BG_MAX_AGE_MS,
};
