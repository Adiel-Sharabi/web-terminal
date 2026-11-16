'use strict';
// --- #469 Supervisor phase 4: close-out, R5 and the ready-to-close mark ---------------
//
// docs/SUPERVISOR-DESIGN.md section 7. The owner's rule: a done session cleans up after
// itself before it is closed.
//
//   R5  a session that reported `done`, is idle, has no viewer and no live work is ASKED to
//       close out: check and fix its changes, branches, worktrees, the processes and sessions
//       it started, and the tracker. It answers as STATE (scripts/wt-closeout.js -> POST
//       /api/session/:id/closeout, the #359 pattern), never as prose.
//   clean    the owner's session (or one whose opener is not known) is NEVER closed: it is
//            marked ready to close, for the owner's one tap. A session an agent opened is
//            closed once it has stayed idle closeAfterMin since the answer, nobody looks at
//            it, it is not a favourite and no live session names it as its lead (children
//            close before their lead). Its transcript stays on disk: `claude --resume` can
//            bring it back, so closing it can be undone.
//   blocked, no answer in answerMin, or asked maxAsks times with no clean answer -> "Needs
//            you", never a forced close.
//
// THE STATE lives on the session's own server, in its brief entry (`closeout`), and rides
// its session row to the authority like every other brief field:
//   null                     not asked since the session last did work
//   {askedAt}                the close-out prompt was typed (by the gated prompt route)
//   {askedAt, state, left, at}  answered: 'clean' | 'blocked' (`left`: what is left)
// A typed prompt, or a report of a wait that is not `done`, is new work: the record is
// cleared (clearedBy), so the next done is asked again. A report of `done` again (the
// close-out turn reporting its own end) keeps it: otherwise every close-out would re-ask.
//
// Pure: no I/O, no clock (every function takes `now`).

const STATES = Object.freeze(['clean', 'blocked']);
const LEFT_MAX = 300;
const HOUR_MS = 60 * 60 * 1000;

const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _int = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);
const { oneLine: _oneLine } = require('./one-line');

/// `supervisor.closeout` from config.json. Absent = on.
///   enabled        false: R5 never asks, never closes; ready-to-close is the plain
///                  "done, idle, nobody looking" of phase 1
///   close          false: asks and marks, but never closes a session (an off switch for the
///                  close alone; `supervisor.autonomy.close: recommend` makes it a card instead)
///   askAfterMin    idle this long after the done turn before the ask (5)
///   answerMin      an ask with no answer this long -> Needs you (60)
///   closeAfterMin  an agent's clean session idle this long after its answer -> closed (15)
///   maxAsks        asks per session per 24 h before it goes to the owner instead (3)
/// [minuteMs] is one minute; only a WT_TEST seam shortens it (server.js).
function closeoutConfig(raw, minuteMs = 60 * 1000) {
  const c = _isObj(raw) ? raw : {};
  const m = Number.isFinite(minuteMs) && minuteMs > 0 ? minuteMs : 60 * 1000;
  return {
    enabled: c.enabled !== false,
    close: c.close !== false,
    askAfterMs: _int(c.askAfterMin, 0, 24 * 60, 5) * m,
    answerMs: _int(c.answerMin, 5, 24 * 60, 60) * m,
    closeAfterMs: _int(c.closeAfterMin, 1, 7 * 24 * 60, 15) * m,
    maxAsks: _int(c.maxAsks, 1, 10, 3),
  };
}

/// The close-out prompt (section 7.1), built by the SESSION'S OWN server: [cli] is that
/// server's path to scripts/wt-closeout.js, which only it knows. Under 512 bytes with the tag.
function closeoutText(cli) {
  return 'Close-out: you reported done. Before this session is closed, check and fix what you can: '
    + 'uncommitted or untracked changes, unpushed branches, worktrees, processes and sessions you started, '
    + `and the tracker updated with your result. Then answer once, as state: node "${cli}" clean`
    + ', or the same command with blocked "<what is left>" if something is left that you cannot fix.';
}

/// Validate the session's answer: `{state, left?}` -> `{answer: {state, left}}` or `{error}`
/// (written for the agent, which reads it from wt-closeout.js). [wait] is the session's
/// current reported wait: a close-out answers for a DONE session only.
function answerOf(body, wait) {
  if (!_isObj(body)) return { error: 'body must be a JSON object' };
  if (!STATES.includes(body.state)) return { error: `state must be one of: ${STATES.join(', ')}` };
  const left = body.left === undefined || body.left === null ? '' : body.left;
  if (typeof left !== 'string') return { error: 'left must be a string: what is left that you cannot fix' };
  if (body.state === 'blocked' && !left.trim()) return { error: 'blocked needs what is left: wt-closeout.js blocked "<what is left>"' };
  if (!(wait && wait.on === 'done')) {
    return { error: 'a close-out answers for a done session: report your wait as done first (wt-report), then answer' };
  }
  return { answer: { state: body.state, left: body.state === 'blocked' ? _oneLine(left, LEFT_MAX) : '' } };
}

/// [record] (the brief entry's `closeout`, maybe null) with the answer applied at [now].
/// An answer with no ask before it (the session closed out on its own) is kept too.
function applyAnswer(record, answer, now) {
  const r = _isObj(record) ? record : {};
  return { askedAt: Number.isFinite(r.askedAt) ? r.askedAt : null, state: answer.state, left: answer.left, at: now };
}

/// The record after the close-out prompt was typed at [now]: a fresh ask, any older answer dropped.
function askedRecord(now) {
  return { askedAt: now, state: null, left: '', at: null };
}

/// Does this hook event or report end the close-out (new work begins)? [event] is
/// 'prompt' (a TYPED prompt - a person's, never a system turn), 'turn' (any other turn
/// starting: a task notification, a Monitor event, a prompt the server typed) or 'report'
/// with [wait] the new reported wait (null: none). [record] is the close-out as it stands.
///   prompt  always: a person's prompt is new work.
///   turn    only an ANSWERED close-out: the answer comes inside the close-out turn, after
///           that turn's own UserPromptSubmit, so a turn starting after it is work the
///           answer did not audit. An open ask is kept (its own turn is starting).
///   report  a report of done keeps it; a report with NO wait (a progress note inside the
///           close-out turn) keeps it; a wait on anything else is new work.
function clearedBy(event, wait, record) {
  if (event === 'prompt') return true;
  if (event === 'turn') { const r = recordOf(record); return Boolean(r && r.state); }
  if (event === 'report') return Boolean(wait && wait.on !== 'done');
  return false;
}

/// The record as a row publishes it (validated: a peer's row is data). Null when absent.
function recordOf(raw) {
  if (!_isObj(raw)) return null;
  const askedAt = Number.isFinite(raw.askedAt) ? raw.askedAt : null;
  const state = STATES.includes(raw.state) ? raw.state : null;
  const at = state && Number.isFinite(raw.at) ? raw.at : null;
  if (askedAt === null && !(state && at !== null)) return null;
  return { askedAt, state: at !== null ? state : null, left: at !== null && state === 'blocked' ? _oneLine(raw.left, LEFT_MAX) : '', at };
}

/// Is [n] (a lib/supervisor.js graph node) a done session R5 may act on? Fails closed on
/// every gate: reported done, idle, not compacting, no viewer at all (a background socket
/// counts: the reaper's leniency is not this rule's), nothing live under it, not owing an
/// answer, not capped, and not the supervisor's own dispatcher.
function doneIdle(n) {
  return Boolean(n && n.wait && n.wait.on === 'done' && n.status === 'idle' && !n.compacting
    && !n.clients && !n.liveWork && !n.waitingFor && !n.capped && n.role !== 'supervisor');
}

/** When [n] last did anything the authority can see: its turn, its Stop, its report. */
function lastSignAt(n) {
  const t = [n.turnAt, n.stoppedAt, n.reportAt, n.wait && n.wait.at].filter(Number.isFinite);
  return t.length ? Math.max(...t) : null;
}

/// Who may close [n] when its close-out is clean: only a session an AGENT opened (the #351
/// verdict, `spawn.by`). The owner's, and one whose opener is not known (restored, older
/// than the verdict, still pending), is the owner's: marked, never closed.
function closable(n) {
  return Boolean(n && n.by === 'agent');
}

/// R5, one scan. Pure.
///   graph   lib/supervisor.js buildGraph (each node carries `closeout`, recordOf'd)
///   asks    { <id>: [epoch ms of each close-out asked] } (the caller keeps it, from its log)
///   skip    ids R5 never touches (the dispatcher)
///   cfg     closeoutConfig
/// Returns `{ ask, close, ready, needs, why }`:
///   ask    [{key, id, server, name, expectWaitAt}]   type the close-out prompt
///   close  [{key, id, server, name, closeoutAt}]      close it (agent-opened, clean, quiet)
///   ready  [id]                                        the journal's "Ready to close"
///   needs  [{key, id, server, name, why, left, at}]   the owner's: "Needs you"
///   why    { <id>: the gate that held it }             for the log and the state
function closeoutPlan({ graph, asks, skip, now, cfg }) {
  const c = cfg || closeoutConfig(null);
  const out = { ask: [], close: [], ready: [], needs: [], why: {} };
  const no = skip instanceof Set ? skip : new Set();
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  for (const n of nodes) {
    if (no.has(n.id) || !doneIdle(n)) continue;
    const base = { id: n.id, server: n.server, name: n.name || null };
    if (!c.enabled) { out.ready.push(n.id); continue; }
    const r = n.closeout;
    const last = lastSignAt(n);
    if (!r) {
      const recent = ((asks && asks[n.id]) || []).filter((t) => now - t < 24 * HOUR_MS);
      if (recent.length >= c.maxAsks) {
        out.needs.push({ ...base, key: `closeout|${n.id}|asks`, why: 'no-clean-answer', left: `asked to close out ${recent.length} times in 24 h with no clean answer`, at: Math.max(...recent) });
        continue;
      }
      if (last !== null && now - last < c.askAfterMs) { out.why[n.id] = 'settling'; continue; }
      out.ask.push({ ...base, key: `closeout|${n.id}|${n.wait.at}`, expectWaitAt: Number.isFinite(n.wait.at) ? n.wait.at : null });
      continue;
    }
    if (!r.state) {
      if (Number.isFinite(r.askedAt) && now - r.askedAt > c.answerMs) {
        out.needs.push({ ...base, key: `closeout|${n.id}|${r.askedAt}`, why: 'no-answer', left: 'asked to close out, and no answer came', at: r.askedAt });
      } else out.why[n.id] = 'asked';
      continue;
    }
    if (r.state === 'blocked') {
      out.needs.push({ ...base, key: `closeout|${n.id}|${r.at}`, why: 'blocked', left: r.left || 'something is left', at: r.at });
      continue;
    }
    // Clean: the journal marks it, whoever opened it - an agent's leaves the list when it closes.
    out.ready.push(n.id);
    if (!closable(n)) { out.why[n.id] = 'owner'; continue; }
    if (!c.close) { out.why[n.id] = 'close-off'; continue; }
    // Children close before their lead, and a scan some server did not answer cannot say a
    // lead has none: a close waits for a complete scan (asks and marks do not).
    if (!(graph && graph.complete)) { out.why[n.id] = 'incomplete-scan'; continue; }
    if (n.favorite) { out.why[n.id] = 'favorite'; continue; }
    // Children close before their lead: a lead that a live session still names is kept.
    if (Array.isArray(n.children) && n.children.length) { out.why[n.id] = 'live-child'; continue; }
    if (now - Math.max(r.at, last || 0) < c.closeAfterMs) { out.why[n.id] = 'quiet-wait'; continue; }
    out.close.push({ ...base, key: `close|${n.id}|${r.at}`, closeoutAt: r.at });
  }
  return out;
}

/// The dispatcher's `close` verb on node [n]: R5's own plan for that one session decides, so
/// the verb can never close what R5 would hold (switched off, close off, favourite, a live
/// child, an incomplete scan, the quiet wait). [complete] is the last scan's. Returns
/// `{ close: <plan entry> }` or `{ why }`.
function dispatcherClose(n, { complete, now, cfg }) {
  const c = cfg || closeoutConfig(null);
  if (!c.enabled) return { why: 'closeout-off' };
  const plan = closeoutPlan({ graph: { nodes: n ? [n] : [], complete: Boolean(complete) }, asks: {}, now, cfg: c });
  const p = n && plan.close.find((x) => x.id === n.id);
  return p ? { close: p } : { why: (n && plan.why[n.id]) || 'not-due' };
}

/// Why the close-out prompt may NOT be typed into a session whose brief entry is [brief], on
/// top of every gate the gated prompt route applies (lib/safe-prompt.js): it is no longer done
/// ('not-done'), or it was already asked and has not worked since ('asked'). Null: ask it.
function askRefusal(brief) {
  const b = brief || {};
  const w = b.reported && b.reported.wait;
  if (!(w && w.on === 'done')) return 'not-done';
  if (recordOf(b.closeout)) return 'asked';
  return null;
}

/// Why session [row] may NOT be closed by the supervisor now, or null - re-checked by the
/// session's OWN server right before the kill (POST /api/sessions/:id/close): the authority's
/// scan is up to a minute old, and a person may have opened it since. Fails closed.
///   row        the worker's row (status, compacting, clients)
///   brief      its brief entry (reported.wait, closeout, handoff)
///   by         its #351 verdict ('agent' | 'human' | null)
///   viewers    active viewers plus sockets still attaching (server.js activeViewerCount)
///   favorite   pinned
///   work       what runs in it: an array, or null when it could not be read
///   hold       a restart hold is on (#359)
///   handoff    lib/check-in.js handoffBlock(brief): a hand-off in progress
///   closeoutAt the answer the authority acted on: a different (newer) one is 'stale'
///   typing     a person typed into it recently
///   children   how many of this server's live sessions name it as their lead (children
///              close before their lead; the authority checks the whole cluster)
function closeRefusal({ row, brief, by, viewers, favorite, work, hold, handoff, closeoutAt, typing, children = 0 }) {
  if (hold) return 'restart-hold';
  if (handoff) return 'handoff';
  if (by !== 'agent') return 'owner';
  const b = brief || {};
  const w = b.reported && b.reported.wait;
  if (!(w && w.on === 'done')) return 'not-done';
  const r = recordOf(b.closeout);
  if (!r || r.state !== 'clean') return 'not-clean';
  if (!Number.isFinite(closeoutAt) || r.at !== closeoutAt) return 'stale';
  // A turn begun after the answer (typed or not) is work the answer did not audit.
  if (Number.isFinite(b.turnAt) && b.turnAt > r.at) return 'stale';
  if (!row || row.status !== 'idle') return 'not-idle';
  if (row.compacting) return 'compacting';
  if (!Number.isFinite(viewers) || viewers > 0 || (row.clients || 0) > 0) return 'viewer';
  if (favorite) return 'favorite';
  if (typing) return 'typing';
  if (children) return 'live-child';
  if (!Array.isArray(work)) return 'work-unknown';
  if (work.length) return 'live-work';
  return null;
}

module.exports = {
  STATES, LEFT_MAX,
  closeoutConfig, closeoutText, answerOf, applyAnswer, askedRecord, clearedBy, recordOf, doneIdle, lastSignAt, closable,
  closeoutPlan, dispatcherClose, askRefusal, closeRefusal,
};
