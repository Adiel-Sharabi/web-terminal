'use strict';
// --- #468 Supervisor phase 3: cases, the dispatcher's verbs, recommendation cards --------
//
// docs/SUPERVISOR-DESIGN.md sections 5 (R2, R3, R6, R9), 6a (the night shift), 9 (the
// dispatcher) and 12 (recommend first, then act).
//
// L1 (lib/supervisor.js + server.js) settles what a fact settles. What it cannot settle
// becomes a CASE: one per (rule, session, the wait or turn it is about). A case goes to the
// dispatcher - one Claude Code session on the authority (L2) - as one short tagged prompt;
// the dispatcher reads the whole case and acts through `wt-supervise.js` verbs, and every
// verb is re-checked here and by the gated prompt route of the session's own server:
// "the AI proposes and the rules dispose".
//
//   R2  an orphan whose lead is gone and who waits on it          -> stand in for the lead
//   R3  no progress: the same check-in answer twice with no work between (a repeat in one
//       idle period, #463), or a wait past its own checkBy          -> work out what it needs
//   R6  hung turn: working, no hook for hungMin, nothing live under it
//       (the worker already turns "no hook AND no output for 5 min" idle, so a hung turn
//       that persists is one whose screen still moves - a spinner)  -> look, then decide
//   R9  going in circles: the same failure back across turns (lib/circling.js) -> coach
//
// The dispatcher cannot take a case (paused, switched off, at its usage cap) -> the case
// goes straight to the owner ("Needs you"), never silently queued.
//
// A verb's CLASS decides whether it acts or becomes a card (section 12): every class starts
// in act mode, because each can be undone; the owner flips one to recommend with
// `supervisor.autonomy.<class>`. Whatever the class, a text that asks for something the
// owner's rules reserve for the owner (merging or pushing, GitHub comments, deleting data,
// an install, spending money, anything outward-facing) is never typed on the dispatcher's
// word: it becomes a card the owner approves or dismisses.
//
// Pure: no I/O, no clock (every function takes `now`).

const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _str = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);
const _int = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);

/** The classes of action (section 12). close and spawn arrive with phases 4 and 5. */
const CLASSES = Object.freeze(['wake', 'coach', 'answer', 'lead', 'close', 'spawn']);
/** The dispatcher's verbs that type into a session, and their class. */
const VERB_CLASS = Object.freeze({ wake: 'wake', coach: 'coach', answer: 'answer', lead: 'lead' });
/** What each typed verb's text starts with, so the session knows who is speaking. */
const VERB_LEAD_IN = Object.freeze({
  wake: '', coach: 'Coaching: ', answer: 'Answered for the owner (can be undone): ', lead: 'As your stand-in lead: ',
});
const RULES = Object.freeze(['R2', 'R3', 'R6', 'R9']);
/** A case's or a card's id: 8 hex characters (server.js mints them). */
const ID_RE = /^[0-9a-f]{8}$/;
/** The dispatcher session's default name (section 9). */
const DISPATCHER_NAME = 'web-terminal supervisor';

/// `supervisor.dispatcher` and `supervisor.autonomy` from config.json.
///   dispatcher.enabled        false: no brain; every case goes to the owner
///   dispatcher.cwd            its working folder (default: <handoffs>/supervisor)
///   dispatcher.autoCommand    what it runs (default `claude --dangerously-skip-permissions`)
///   dispatcher.actionsPerHour verbs that type into a session, all sessions together (30)
///   dispatcher.hungMin        R6: minutes working with no hook (45)
///   dispatcher.circleMin      R9: sightings of one failure (4), over at least 2 turns
///   autonomy.<class>          'act' (default) | 'recommend'
function dispatcherConfig(raw) {
  const c = _isObj(raw) ? raw : {};
  const d = _isObj(c.dispatcher) ? c.dispatcher : {};
  const a = _isObj(c.autonomy) ? c.autonomy : {};
  const autonomy = {};
  for (const k of CLASSES) autonomy[k] = a[k] === 'recommend' ? 'recommend' : 'act';
  return {
    enabled: d.enabled !== false,
    cwd: typeof d.cwd === 'string' && d.cwd.trim() ? d.cwd.trim() : null,
    autoCommand: typeof d.autoCommand === 'string' && d.autoCommand.trim() ? d.autoCommand.trim().slice(0, 500) : 'claude --dangerously-skip-permissions',
    name: DISPATCHER_NAME,
    actionsPerHour: _int(d.actionsPerHour, 1, 200, 30),
    hungMs: _int(d.hungMin, 10, 24 * 60, 45) * 60 * 1000,
    circleMin: _int(d.circleMin, 3, 20, 4),
    // One minute of a wait's checkBy. Only a WT_TEST seam ever shortens it (server.js).
    minuteMs: 60 * 1000,
    autonomy,
  };
}

/// One line for a prompt or a card: control characters folded, cut to [n] characters.
function oneLine(s, n) {
  return String(s || '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

const _name = (n) => oneLine(n.name || String(n.id).slice(0, 8), 60);
/** When the session's agent last spoke through a hook: its last tool, turn start or report. */
function hookAt(n) {
  const t = [n.nowAt, n.turnAt, n.reportAt].filter(Number.isFinite);
  return t.length ? Math.max(...t) : null;
}

/// The cases this scan would open, one per rule per session at most. Pure.
///   graph      lib/supervisor.js buildGraph (nodes carry the #468 fields of nodeOf)
///   verdicts   noteOrphans verdicts; resolutions: supervisorResolve's answers
///   skip       ids never to open a case on (the dispatcher itself)
/// Each candidate `{key, rule, id, server, name, line, waitAt?, turnAt?, sample?}`; the
/// caller opens it unless a case with that key was ever opened (`key` is the dedupe).
function caseCandidates({ graph, verdicts, resolutions, now, cfg, skip }) {
  const out = [];
  const d = cfg || dispatcherConfig(null);
  const no = skip instanceof Set ? skip : new Set();
  for (const n of graph ? graph.nodes : []) {
    if (no.has(n.id)) continue;
    const w = n.wait;
    const waiting = w && (w.on === 'self' || w.on === 'external') && Number.isFinite(w.at);
    // R2 - an orphan that waits on its lead (a lead or session target naming it, or an
    // untargeted external wait: the lead is who an orphan's "external" means).
    const v = verdicts && verdicts[n.id];
    if (v && v.state === 'orphan' && waiting) {
      const t = w.target;
      const onLead = t ? (t.kind === 'lead' || (t.kind === 'session' && t.id === v.parentId)) : w.on === 'external';
      if (onLead) {
        out.push({ key: `R2|${n.id}|${w.at}`, rule: 'R2', id: n.id, server: n.server, name: n.name, waitAt: w.at,
          line: `Session "${_name(n)}" lost its lead (${String(v.parentId).slice(0, 8)}, gone from every machine) and waits on it: "${oneLine(w.what, 80)}". Stand in for the lead.` });
        continue;
      }
    }
    // R3 - no progress. (a) a repeat check-in in one idle period (n >= 2: no turn of work
    // since the first ask, #463) answered with the same untargeted wait, still standing.
    const ci = n.checkIn;
    if (waiting && !w.target && ci && ci.n >= 2 && Number.isFinite(ci.endedAt) && ci.answer && ci.answer.on === w.on
      && Number.isFinite(ci.deliveredAt) && w.at >= ci.deliveredAt) {
      out.push({ key: `R3|${n.id}|${w.at}`, rule: 'R3', id: n.id, server: n.server, name: n.name, waitAt: w.at,
        line: `Session "${_name(n)}" gave the same check-in answer ${ci.n} times with no work between: ${w.on} "${oneLine(w.what, 80)}". Work out what it really waits for.` });
      continue;
    }
    // (b) a wait past its own checkBy, whose target (if any) has not resolved.
    const res = resolutions && resolutions[n.id];
    if (waiting && Number.isInteger(w.checkBy) && now - w.at > w.checkBy * d.minuteMs
      && !(res && (res.state === 'resolved' || res.state === 'gone'))) {
      out.push({ key: `R3|${n.id}|${w.at}`, rule: 'R3', id: n.id, server: n.server, name: n.name, waitAt: w.at,
        line: `Session "${_name(n)}" is past its own checkBy (${w.checkBy} min) on "${oneLine(w.what, 80)}"${w.target ? ` (target ${w.target.kind}, still ${res ? res.state : 'unknown'})` : ''}.` });
      continue;
    }
    // R6 - a hung turn: working, no hook for hungMs, no subagent or Monitor under it.
    const h = hookAt(n);
    if (n.status === 'working' && !n.compacting && !n.waitingFor && h !== null && now - h > d.hungMs && !n.liveAgents) {
      out.push({ key: `R6|${n.id}|${n.turnAt || h}`, rule: 'R6', id: n.id, server: n.server, name: n.name, turnAt: n.turnAt || null,
        line: `Session "${_name(n)}" has been working ${Math.round((now - h) / 60000)} min with no hook${n.now ? ` (last: "${oneLine(n.now, 80)}")` : ''}. Look at its tail and decide.` });
      continue;
    }
    // R9 - going in circles: one failure, circleMin times, over 2+ turns, seen in the last hour.
    const c = n.circling;
    if (c && c.count >= d.circleMin && c.turns >= 2 && Number.isFinite(c.lastAt) && now - c.lastAt < 60 * 60 * 1000 && w && w.on !== 'done') {
      out.push({ key: `R9|${n.id}|${oneLine(c.sample, 120)}`, rule: 'R9', id: n.id, server: n.server, name: n.name, sample: oneLine(c.sample, 120),
        line: `Session "${_name(n)}" hit the same ${oneLine(c.tool, 20)} failure ${c.count} times over ${c.turns} turns: "${oneLine(c.sample, 100)}". Coach it.` });
    }
  }
  return out;
}

/// Does open case [c] still stand, given its session's node [n] this scan? An incomplete
/// scan that misses the session decides nothing (true). The case's own trigger moving on
/// (a new report, the turn ending, the failure no longer the top one) makes it obsolete.
function caseHolds(c, n, graph, verdicts) {
  if (!n) return !(graph && graph.complete);
  if (c.rule === 'R2') { const v = verdicts && verdicts[n.id]; return Boolean(v && v.state === 'orphan' && n.wait && n.wait.at === c.waitAt); }
  if (c.rule === 'R3') return Boolean(n.wait && n.wait.at === c.waitAt);
  if (c.rule === 'R6') return n.status === 'working' && (n.turnAt || null) === (c.turnAt || null);
  if (c.rule === 'R9') return Boolean(n.circling && oneLine(n.circling.sample, 120) === c.sample);
  return true;
}

/// The cases and cards, folded from supervisor-cases.jsonl. Events:
///   open {case}  delivered {caseId}  escalated {caseId, question, by}  resolved {caseId, how, by}
///   card {card}  decided {cardId, decision, by, outcome}
/// Returns `{ cases: {id: case}, cards: {id: card}, keys: Set }` (keys: every case key ever
/// opened, so a restart never opens the same case twice). [base] (a previous result) is
/// folded INTO, so the server applies each new event to what it already holds.
function foldCases(events, base = null) {
  // Null-prototype maps: an id is data, and `__proto__` must never reach Object.prototype.
  const cases = base ? base.cases : Object.create(null);
  const cards = base ? base.cards : Object.create(null);
  const keys = base ? base.keys : new Set();
  for (const e of Array.isArray(events) ? events : []) {
    if (!_isObj(e)) continue;
    if (e.event === 'open' && _isObj(e.case) && ID_RE.test(e.case.id)) {
      cases[e.case.id] = { ...e.case, deliveredAt: null, escalated: null, resolvedAt: null, resolution: null };
      if (typeof e.case.key === 'string') keys.add(e.case.key);
      continue;
    }
    if (e.event === 'card' && _isObj(e.card) && ID_RE.test(e.card.id)) { cards[e.card.id] = { ...e.card, decision: null, decidedAt: null }; continue; }
    const c = typeof e.caseId === 'string' ? cases[e.caseId] : null;
    if (e.event === 'delivered' && c) c.deliveredAt = e.at || null;
    if (e.event === 'escalated' && c) c.escalated = { question: _str(e.question, 400) || c.line, at: e.at || null, by: _str(e.by, 40) };
    if (e.event === 'resolved' && c) { c.resolvedAt = e.at || null; c.resolution = { how: _str(e.how, 400), by: _str(e.by, 40) }; }
    const k = typeof e.cardId === 'string' ? cards[e.cardId] : null;
    if (e.event === 'decided' && k) { k.decision = e.decision === 'approve' ? 'approve' : 'dismiss'; k.decidedAt = e.at || null; k.outcome = _str(e.outcome, 80); }
  }
  return { cases, cards, keys };
}

/** The owner's reserved actions (section 6a, "always step 4"), as phrases a typed text
 *  would ask for. Matched on the text the dispatcher wants typed: a hit makes it a card. */
const RESERVED = Object.freeze([
  ['merge or push a PR', /\b(merge|force-push|push)\b[^.]{0,40}\b(pr|pull request|branch|master|main|origin)\b|\bgh pr (merge|create)\b|\bgit push\b/i],
  ['a GitHub comment or issue', /\bgh (issue|pr) (comment|create|close|edit)\b|\b(post|write|leave|add)\b[^.]{0,30}\b(github )?(comment|issue)\b[^.]{0,30}\b(github|pr|issue)\b/i],
  ['deleting data', /\b(delete|drop|wipe|purge|truncate)\b[^.]{0,40}\b(data|database|table|branch|repo|files?|folder|directory|records?)\b|\brm -rf\b|\bgit (reset --hard|clean -f|push --force)\b/i],
  ['an install on a host', /\b(install|msiexec|setup\.exe|choco|winget)\b/i],
  ['spending money', /\b(pay|purchase|buy|subscribe|upgrade (the )?plan)\b/i],
  ['something outward-facing', /\b(email|e-mail|send|post|publish|announce)\b[^.]{0,40}\b(customer|team|slack|teams|users?|public|release notes)\b/i],
]);

/// The reserved action [text] asks for, by name, or null.
function reservedAction(text) {
  for (const [what, re] of RESERVED) if (re.test(String(text || ''))) return what;
  return null;
}

/// Validate one typing verb's request and decide act vs card. Pure.
///   verb   wake | coach | answer | lead      text   what to type (one line)
///   undo   answer only: how the owner undoes it (required, section 6a step 2)
/// Returns `{error}` | `{mode: 'act'|'card', cls, text, why?}`; `text` is the line the
/// session will see (the verb's lead-in + text, + the undo for an answer).
function verbDecision({ verb, text, undo, cfg }) {
  const cls = VERB_CLASS[verb];
  if (!cls) return { error: `verb must be one of: ${Object.keys(VERB_CLASS).join(', ')}` };
  if (typeof text !== 'string' || !text.trim()) return { error: 'text must be a non-empty string' };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) return { error: 'text must be one line with no control characters' };
  if (cls === 'answer' && (typeof undo !== 'string' || !undo.trim())) return { error: 'an answer for the owner needs undo: how the owner reverses it' };
  const line = VERB_LEAD_IN[verb] + text.trim() + (cls === 'answer' ? ` (to undo: ${oneLine(undo, 160)})` : '');
  const reserved = reservedAction(text);
  const mode = (cfg && cfg.autonomy && cfg.autonomy[cls]) || 'act';
  if (reserved) return { mode: 'card', cls, text: line, why: `asks for ${reserved}, which only the owner decides` };
  if (mode === 'recommend') return { mode: 'card', cls, text: line, why: `${cls} is in recommend mode` };
  return { mode: 'act', cls, text: line };
}

/// Is the dispatcher able to take a case now? [row] its node (null: not running).
/// Returns null (yes) or why not: 'off' | 'paused' | 'capped' | 'starting' | 'gone'.
function dispatcherBlock({ cfg, paused, node }) {
  if (!cfg || !cfg.enabled) return 'off';
  if (paused) return 'paused';
  if (node && node.capped) return 'capped';
  return null;
}

/// The prompt that hands case [c] to the dispatcher (under 512 bytes with the tag).
function casePrompt(c, cli, maxBytes) {
  const tail = ` Read it: node "${cli}" case ${c.id}`;
  let line = `Case ${c.id} (${c.rule}): ${oneLine(c.line, 300)}`;
  while (Buffer.byteLength(line + tail, 'utf8') > maxBytes && line.length > 20) line = line.slice(0, -1);
  return line + tail;
}

/// The owner's queue from cases and cards: escalated open cases and pending cards, oldest
/// first, as owner-ladder items `{key, id, server, name, what, at}` (lib/supervisor.js ownerPlan).
function ownerItems({ cases, cards }) {
  const out = [];
  for (const c of Object.values(cases || {})) {
    if (c.resolvedAt || !c.escalated) continue;
    out.push({ key: `case|${c.id}`, id: c.sessionId, server: c.server, name: c.name, what: oneLine(c.escalated.question, 100), at: c.escalated.at || c.openedAt });
  }
  for (const k of Object.values(cards || {})) {
    if (k.decision) continue;
    out.push({ key: `card|${k.id}`, id: k.sessionId, server: k.server, name: k.name, what: oneLine(`Approve? ${k.text}`, 100), at: k.at });
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/// Each class's record (section 12): mode, and how many of its cards were approved / dismissed.
function autonomyRecord(cfg, cards) {
  const out = {};
  for (const k of CLASSES) out[k] = { mode: (cfg && cfg.autonomy && cfg.autonomy[k]) || 'act', approved: 0, dismissed: 0, pending: 0 };
  for (const c of Object.values(cards || {})) {
    const r = out[c.cls] || (out[c.cls] = { mode: 'act', approved: 0, dismissed: 0, pending: 0 });
    if (c.decision === 'approve') r.approved++; else if (c.decision === 'dismiss') r.dismissed++; else r.pending++;
  }
  return out;
}

/// The morning summary (section 6a): what the night shift did since [since], from the
/// supervisor's recent actions `{at, rule, outcome}`, and how many things still wait on the
/// owner. "Overnight: 2 answered, 1 coached, 3 woken. 4 wait on you."
function nightSummary(actions, since, waiting) {
  const n = { answered: 0, coached: 0, woken: 0, 'stood in': 0, resolved: 0 };
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || !Number.isFinite(a.at) || a.at < since || !['delivered', 'uncertain', 'resolved'].includes(a.outcome)) continue;
    const k = { answer: 'answered', coach: 'coached', wake: 'woken', R1: 'woken', R2: 'woken', lead: 'stood in', resolve: 'resolved' }[a.rule];
    if (k) n[k]++;
  }
  const did = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  const wait = `${waiting} ${waiting === 1 ? 'thing waits' : 'things wait'} on you`;
  return did ? `Overnight: ${did}. ${wait}` : wait;
}

module.exports = {
  CLASSES, VERB_CLASS, VERB_LEAD_IN, RULES, DISPATCHER_NAME, RESERVED, ID_RE,
  dispatcherConfig, oneLine, hookAt, caseCandidates, caseHolds, foldCases, reservedAction, verbDecision,
  dispatcherBlock, casePrompt, ownerItems, autonomyRecord, nightSummary,
};
