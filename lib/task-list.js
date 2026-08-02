'use strict';
// #73 — the agent's task list, as ONE typed shape both agents produce and one panel renders.
//
// This module is PURE: no fs, no session, no HTTP. It owns the rules; lib/agents.js says
// which rule an agent uses, and server.js applies them. Nothing here knows an agent id.
//
// THE SHAPE (one per task, in display order):
//     { id: string, subject: string, status: 'pending' | 'in_progress' | 'completed' }
//
// WHY TWO SOURCES, AND WHY THAT ISN'T A BRANCH. The issue assumed one tool carrying the
// whole list on every call. That describes CODEX exactly and CLAUDE not at all, and the
// difference is the whole design:
//
//   Codex  `update_plan` carries the entire plan every time (`arguments` is a JSON
//          STRING holding `plan: [{step, status}]`). Newest call = current state. It is
//          recoverable from the transcript alone, so nothing needs to be remembered.
//
//   Claude `TaskCreate` / `TaskUpdate` are DELTAS, and the task id is not in the tool
//          input at all — it exists only in the result PROSE ("Task #7 created
//          successfully: …"). Reconstructing the list means folding forward from the
//          start of a session, which a BACKWARD-paging transcript reader cannot do. So
//          Claude's list is folded live from its hook stream instead.
//
// Verified against real data before it was built (400 Claude transcripts, 56 Codex
// rollouts): TaskCreate 45 calls {subject,description,activeForm}; TaskUpdate 73 calls
// {taskId,status}; `TodoWrite` — the tool the issue is named after — appears as an actual
// tool_use exactly ZERO times. Codex: 20 update_plan calls, step shape {step,status},
// statuses pending/in_progress/completed.
//
// THE REPAIR PATH, which is what makes the fold safe. A fold that starts mid-session
// (server restarted, hot reload, session adopted) has missed earlier creates. Two things
// stop that from being a permanent hole:
//   * `TaskList`'s RESULT is a whole-list snapshot ("#6 [completed] subject (owner)"),
//     and Claude is explicitly told to call TaskList after finishing a task — so a
//     snapshot arrives on its own and replaces whatever the fold had.
//   * an update for an id we never saw created still produces a row (subject ''), so the
//     panel under-reports nothing; the client renders it as "Task #<id>" until a later
//     create or snapshot supplies the real subject.
// Both are tested. Dropping unknown-id updates instead would silently hide in-progress
// work, which is the one thing this panel exists to show.

/** The only status vocabulary that crosses the wire. Both agents normalise into it. */
const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed']);

// Claude's TaskUpdate input uses these verbatim; Codex's plan steps use the same three.
// Anything unrecognised becomes 'pending' rather than being dropped: an unknown status is
// still a task the user should see, and 'pending' is the reading that over-reports work
// remaining rather than claiming work is done.
const _STATUS_ALIASES = Object.freeze({
  pending: 'pending',
  todo: 'pending',
  not_started: 'pending',
  in_progress: 'in_progress',
  active: 'in_progress',
  running: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
});

function normalizeStatus(raw) {
  const k = String(raw == null ? '' : raw).trim().toLowerCase();
  return _STATUS_ALIASES[k] || 'pending';
}

/** A task id is only ever compared and displayed — keep it a trimmed string. */
function _id(v) {
  return String(v == null ? '' : v).trim();
}

// ---------------------------------------------------------------------------
// Claude — deltas from the hook stream
// ---------------------------------------------------------------------------

// "Task #7 created successfully: Wire AppConfig to ServerStore"  → 7
// "Updated task #6 status"                                        → 6
// The id lives ONLY here, so this parse is load-bearing. It is also the one brittle
// part of the design: a wording change upstream breaks it silently. `foldTaskEvent`
// therefore accepts a create with no id and assigns the next sequential one — observed
// ids are sequential and match creation order, so the fallback degrades to correct
// rather than to empty.
const _ID_IN_PROSE = /\btask #(\d+)/i;

function _idFromProse(text) {
  const m = _ID_IN_PROSE.exec(String(text == null ? '' : text));
  return m ? m[1] : '';
}

// One line of a TaskList result: "#6 [completed] Build the store (app-core-3)".
const _SNAPSHOT_LINE = /^#(\d+)\s+\[([a-z_]+)\]\s*(.*)$/i;

/**
 * A TaskList result — the whole list at once. Returns [] for "No tasks found" (a real
 * answer: the list is empty), null when the text is not a snapshot at all.
 */
function parseTaskListSnapshot(resultText) {
  const text = String(resultText == null ? '' : resultText);
  if (!text.trim()) return null;
  if (/^\s*no tasks found\s*$/i.test(text)) return [];
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = _SNAPSHOT_LINE.exec(line.trim());
    if (!m) continue;
    items.push({ id: m[1], subject: m[3].trim(), status: normalizeStatus(m[2]) });
  }
  return items.length ? items : null;
}

/**
 * One Claude PostToolUse payload -> a normalised delta, or null when the tool has
 * nothing to do with the task list. Shapes:
 *   { kind: 'create',   id, subject }      id may be '' (see _idFromProse)
 *   { kind: 'update',   id, status }
 *   { kind: 'snapshot', items }
 */
function parseClaudeTaskDelta(toolName, toolInput, toolResponse) {
  const name = String(toolName || '');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  // A tool_response is a string in some versions and a {content} envelope in others.
  const resp = typeof toolResponse === 'string'
    ? toolResponse
    : (toolResponse && typeof toolResponse === 'object'
      ? String(toolResponse.content ?? toolResponse.output ?? toolResponse.text ?? '')
      : '');

  if (name === 'TaskCreate') {
    return {
      kind: 'create',
      id: _idFromProse(resp),
      subject: String(input.subject || '').trim(),
    };
  }
  if (name === 'TaskUpdate') {
    // The id IS in this input (`taskId`) — the prose is only the fallback.
    const id = _id(input.taskId) || _idFromProse(resp);
    if (!id) return null;
    if (!input.status) return null; // an owner-only update carries no status change
    return { kind: 'update', id, status: normalizeStatus(input.status) };
  }
  if (name === 'TaskList') {
    const items = parseTaskListSnapshot(resp);
    return items ? { kind: 'snapshot', items } : null;
  }
  return null;
}

/**
 * Apply one delta to the current list, returning a NEW array (callers compare identity
 * to decide whether to publish). Order is creation order, which is the order the agent
 * intends to work in and the order both its own TUI and TaskList print.
 */
function foldTaskEvent(items, delta) {
  const cur = Array.isArray(items) ? items : [];
  if (!delta || !delta.kind) return cur;

  if (delta.kind === 'snapshot') {
    // Authoritative — but keep a subject we already know. The snapshot line appends the
    // owner ("… (app-core-3)") and subjects legitimately end in parentheses too
    // ("… (desktop)"), so stripping it would mangle real titles; preferring the
    // TaskCreate subject sidesteps the ambiguity entirely.
    const known = new Map(cur.map((t) => [t.id, t.subject]));
    return delta.items.map((t) => ({
      id: _id(t.id),
      subject: known.get(_id(t.id)) || t.subject || '',
      status: normalizeStatus(t.status),
    }));
  }

  if (delta.kind === 'create') {
    // No id recoverable from the prose → next sequential. Observed ids are 1,2,3,…
    // in creation order, so this lands on the right one in practice and, when it does
    // not, still shows the task rather than losing it.
    const id = _id(delta.id) || String(cur.length + 1);
    const at = cur.findIndex((t) => t.id === id);
    const row = { id, subject: String(delta.subject || ''), status: 'pending' };
    if (at < 0) return cur.concat([row]);
    const next = cur.slice();
    // A re-created id keeps its status: the create is the stale event here.
    next[at] = { ...row, status: next[at].status, subject: row.subject || next[at].subject };
    return next;
  }

  if (delta.kind === 'update') {
    const id = _id(delta.id);
    const at = cur.findIndex((t) => t.id === id);
    if (at < 0) {
      // An update for a task whose create we never saw — a fold that began mid-session.
      // Show it anyway; the client renders a blank subject as "Task #<id>".
      return cur.concat([{ id, subject: '', status: normalizeStatus(delta.status) }]);
    }
    const next = cur.slice();
    next[at] = { ...next[at], status: normalizeStatus(delta.status) };
    return next;
  }

  return cur;
}

// ---------------------------------------------------------------------------
// Codex — a whole-plan snapshot recovered from the rollout
// ---------------------------------------------------------------------------

/**
 * Find the NEWEST `update_plan` in a slice of rollout text and return it as items.
 * Returns null when the slice holds none — which the caller must treat as "unknown",
 * not as "the plan is empty", or a long turn would blank a live panel.
 *
 * Codex restates `response_item` content in `event_msg` lines, so the same plan can
 * appear twice; taking the last match is correct either way because both carry the
 * identical payload. `arguments` is a JSON STRING (the documented Codex trap).
 */
function parseCodexPlan(text) {
  const s = String(text == null ? '' : text);
  if (!s.includes('update_plan')) return null;
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('update_plan') === -1) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const payload = (o && o.payload) || o;
    if (!payload || payload.name !== 'update_plan') continue;
    let args = payload.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { continue; }
    }
    if (!args || !Array.isArray(args.plan)) continue;
    return args.plan.map((step, idx) => ({
      // A Codex plan step has no id of its own — its position IS its identity.
      id: String(idx + 1),
      subject: String((step && step.step) || '').trim(),
      status: normalizeStatus(step && step.status),
    }));
  }
  return null;
}

module.exports = {
  TASK_STATUSES,
  normalizeStatus,
  parseClaudeTaskDelta,
  parseTaskListSnapshot,
  foldTaskEvent,
  parseCodexPlan,
};
