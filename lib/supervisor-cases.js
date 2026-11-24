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
//   R4  a session waiting on the owner (section 6a, by day too; the push still goes out)
//                                     -> the ladder: answer if it can be undone, avoid it,
//                                        or ask the owner (and tell it to park cleanly)
//   R3  no progress: the same check-in answer twice with no work between (a repeat in one
//       idle period, #463), or a wait past its own checkBy          -> work out what it needs
//   R6  hung turn: working, no hook for hungMin, nothing live under it
//       (the worker already turns "no hook AND no output for 5 min" idle, so a hung turn
//       that persists is one whose screen still moves - a spinner)  -> look, then decide
//   R9  going in circles: the same failure back across turns (lib/circling.js) -> coach
//   R7  dead agent (#470): its process was seen under the shell and is gone, with no
//       SessionEnd (a deliberate exit sends one), for goneMs      -> usually a replacement
//                                        (wt-supervise.js spawn, lib/replacement.js)
//
// The dispatcher cannot take a case (paused, switched off, at its usage cap) -> the case
// goes straight to the owner ("Needs you"), never silently queued. Nor can a case sit with
// a dispatcher that never acts on it: handed over and not TAKEN (a verb naming the case,
// ask-owner, resolve) within CASE_UNTAKEN_MS -> the owner (caseDue).
//
// Every piece of session-controlled text a case line quotes (a name, a wait, a failure) is
// stripped of the characters that act inside a double-quoted shell word (caseText): if the
// dispatcher's agent has died to its shell, a typed case line must stay inert.
//
// A verb's CLASS decides whether it acts or becomes a card (section 12): every class starts
// in act mode, because each can be undone; the owner flips one to recommend with
// `supervisor.autonomy.<class>`. Whatever the class, a text that asks for something the
// owner's rules reserve for the owner (merging or pushing, GitHub comments, deleting data,
// an install, spending money, anything outward-facing) is never typed on the dispatcher's
// word: it becomes a card the owner approves or dismisses.
//
// Pure: no I/O, no clock (every function takes `now`).

const { clipBytes, ownerWaitOf, noteAbsent, TEXT_BYTES_MAX } = require('./supervisor');
const { oneLine } = require('./one-line');
const { diedAgo, spawnConfig } = require('./replacement');

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
const RULES = Object.freeze(['R2', 'R3', 'R4', 'R6', 'R7', 'R9']);
/** A case handed to the dispatcher and not taken in this long goes to the owner. */
const CASE_UNTAKEN_MS = 30 * 60 * 1000;
/** A case's or a card's id: 8 hex characters (server.js mints them). */
const ID_RE = /^[0-9a-f]{8}$/;
/** The dispatcher session's default name (section 9). */
const DISPATCHER_NAME = 'web-terminal supervisor';
/** #525 - the model the dispatcher runs unless its command names one. Most cases are triage,
 *  but judging which answers can be undone is the risky part: Sonnet, not Haiku. The
 *  dispatcher is always a claude session (server.js dispatcherStart), hence claude's flag. */
const DISPATCHER_MODEL = 'sonnet';
/** A model name: never a flag (`--print`) and nothing a shell acts on. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** #525 - context, in tokens, past which an idle dispatcher with no case in hand is handed
 *  to a fresh session. notes.md is its memory, read at every start, so a fresh one loses
 *  nothing, and every case re-reads the whole context: far below the generic #393 point. */
const DISPATCHER_HANDOFF_TOKENS = 100000;

/// `supervisor.dispatcher` and `supervisor.autonomy` from config.json.
///   dispatcher.enabled        false: no brain; every case goes to the owner
///   dispatcher.cwd            its working folder (default: <handoffs>/supervisor)
///   dispatcher.autoCommand    what it runs (default `claude --dangerously-skip-permissions`)
///   dispatcher.model          #525: added as `--model <m>` unless autoCommand names one
///                             (default sonnet; "" or false runs autoCommand as written)
///   dispatcher.handoffTokens  #525: hand it to a fresh session past this context (100000)
///   dispatcher.actionsPerHour verbs that type into a session, all sessions together (30)
///   dispatcher.hungMin        R6: minutes working with no hook (45)
///   dispatcher.circleMin      R9: sightings of one failure (4), over at least 2 turns
///   spawn.goneMin             R7: minutes a dead agent has been gone (5; lib/replacement.js)
///   autonomy.<class>          'act' (default) | 'recommend'
function dispatcherConfig(raw) {
  const c = _isObj(raw) ? raw : {};
  const d = _isObj(c.dispatcher) ? c.dispatcher : {};
  const a = _isObj(c.autonomy) ? c.autonomy : {};
  const autonomy = {};
  for (const k of CLASSES) autonomy[k] = a[k] === 'recommend' ? 'recommend' : 'act';
  // A bad model name never reaches the command line: the default runs, and `modelRefused`
  // names what was refused (server.js logs it at the dispatcher's start).
  const off = d.model === '' || d.model === false;
  const named = typeof d.model === 'string' && MODEL_RE.test(d.model.trim()) ? d.model.trim() : null;
  const model = off ? null : named || DISPATCHER_MODEL;
  const modelRefused = !off && d.model != null && !named ? String(d.model).slice(0, 80) : null;
  const cmd = typeof d.autoCommand === 'string' && d.autoCommand.trim() ? d.autoCommand.trim().slice(0, 500) : 'claude --dangerously-skip-permissions';
  return {
    enabled: d.enabled !== false,
    cwd: typeof d.cwd === 'string' && d.cwd.trim() ? d.cwd.trim() : null,
    autoCommand: withModel(cmd, model),
    model, modelRefused,
    // At least 50k: a fresh dispatcher starts at 20-30k (its rules and notes.md).
    handoffTokens: _int(d.handoffTokens, 50000, 500000, DISPATCHER_HANDOFF_TOKENS),
    name: DISPATCHER_NAME,
    actionsPerHour: _int(d.actionsPerHour, 1, 200, 30),
    hungMs: _int(d.hungMin, 10, 24 * 60, 45) * 60 * 1000,
    circleMin: _int(d.circleMin, 3, 20, 4),
    goneMs: spawnConfig(c.spawn).goneMs,
    // One minute of a wait's checkBy. Only a WT_TEST seam ever shortens it (server.js).
    minuteMs: 60 * 1000,
    autonomy,
  };
}

/// #525 - [cmd] running [model]: `--model <model>` added unless [cmd] already names a model
/// (its own choice wins) or [model] is null.
function withModel(cmd, model) {
  if (!model || /(^|\s)--model(\s|=|$)/.test(cmd)) return cmd;
  return `${cmd} --model ${model}`;
}

// oneLine lives in lib/one-line.js (a leaf: lib/closeout.js shares it without a require cycle).

/// Session-controlled text for a case line: one line, and none of `` ` $ " \ `` - the
/// characters that act inside the double quotes every case line puts it in.
function caseText(s, n) {
  return oneLine(String(s || '').replace(/[`$"\\]/g, ''), n);
}

const _name = (n) => caseText(n.name || String(n.id).slice(0, 8), 60);
/** A tool's name, as a case line shows it unquoted: word characters only. */
const _tool = (t) => String(t || '?').replace(/[^\w.:-]/g, '').slice(0, 20) || '?';
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
    // R7 - a dead agent comes first: a session whose agent is gone can act on nothing else.
    if (diedAgo(n.agentGone, now, d.goneMs)) {
      out.push({ key: `R7|${n.id}|${n.agentGone.seenAt}`, rule: 'R7', id: n.id, server: n.server, name: n.name, seenAt: n.agentGone.seenAt,
        line: `Session "${_name(n)}" lost its agent: last seen running ${Math.round((now - n.agentGone.seenAt) / 60000)} min ago, and it sent no exit hook, so it died. Replace it (spawn), or resolve if the job is over.` });
      continue;
    }
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
          line: `Session "${_name(n)}" lost its lead (${caseText(v.parentId, 8)}, gone from every machine) and waits on it: "${caseText(w.what, 80)}". Stand in for the lead.` });
        continue;
      }
    }
    // R3 - no progress. (a) a repeat check-in in one idle period (n >= 2: no turn of work
    // since the first ask, #463) answered with the same untargeted wait, still standing.
    const ci = n.checkIn;
    if (waiting && !w.target && ci && ci.n >= 2 && Number.isFinite(ci.endedAt) && ci.answer && ci.answer.on === w.on
      && Number.isFinite(ci.deliveredAt) && w.at >= ci.deliveredAt) {
      out.push({ key: `R3|${n.id}|${w.at}`, rule: 'R3', id: n.id, server: n.server, name: n.name, waitAt: w.at,
        line: `Session "${_name(n)}" gave the same check-in answer ${ci.n} times with no work between: ${w.on} "${caseText(w.what, 80)}". Work out what it really waits for.` });
      continue;
    }
    // (b) a wait past its own checkBy, whose target (if any) has not resolved.
    const res = resolutions && resolutions[n.id];
    if (waiting && Number.isInteger(w.checkBy) && now - w.at > w.checkBy * d.minuteMs
      && !(res && (res.state === 'resolved' || res.state === 'gone'))) {
      out.push({ key: `R3|${n.id}|${w.at}`, rule: 'R3', id: n.id, server: n.server, name: n.name, waitAt: w.at,
        line: `Session "${_name(n)}" is past its own checkBy (${w.checkBy} min) on "${caseText(w.what, 80)}"${w.target ? ` (target ${w.target.kind}, still ${res ? res.state : 'unknown'})` : ''}.` });
      continue;
    }
    // R4 - waiting on the owner (lib/supervisor.js ownerWaitOf: the same waits the owner
    // ladder pushes). The dispatcher works section 6a's ladder; the push still goes out.
    if (ownerWaitOf(n)) {
      out.push({ key: `R4|${n.id}|${w.at}`, rule: 'R4', id: n.id, server: n.server, name: n.name, waitAt: w.at,
        line: `Session "${_name(n)}" waits on the owner: "${caseText(w.what, 100)}". Answer it if the rules settle it or it can be undone, else steer it round the question, else ask the owner.` });
      continue;
    }
    // R6 - a hung turn: working, no hook for hungMs, nothing live under it, and the turn
    // not already over (a Stop at or after its start: the status is what lags).
    const h = hookAt(n);
    const stopped = Number.isFinite(n.stoppedAt) && Number.isFinite(n.turnAt) && n.stoppedAt >= n.turnAt;
    if (n.status === 'working' && !n.compacting && !n.waitingFor && h !== null && now - h > d.hungMs && !n.liveWork && !stopped) {
      out.push({ key: `R6|${n.id}|${n.turnAt || h}`, rule: 'R6', id: n.id, server: n.server, name: n.name, turnAt: n.turnAt || null,
        line: `Session "${_name(n)}" has been working ${Math.round((now - h) / 60000)} min with no hook${n.now ? ` (last: "${caseText(n.now, 80)}")` : ''}. Look at its tail and decide.` });
      continue;
    }
    // R9 - going in circles: one failure, circleMin times, over 2+ turns, seen in the last
    // hour, by a session not done. Keyed on the failure's fingerprint (lib/circling.js `fp`),
    // so a new wording of the same failure is the same case.
    const c = n.circling;
    if (c && c.count >= d.circleMin && c.turns >= 2 && Number.isFinite(c.lastAt) && now - c.lastAt < 60 * 60 * 1000 && !(w && w.on === 'done')) {
      out.push({ key: `R9|${n.id}|${circleId(c)}`, rule: 'R9', id: n.id, server: n.server, name: n.name, fp: circleId(c),
        line: `Session "${_name(n)}" hit the same ${_tool(c.tool)} failure ${c.count} times over ${c.turns} turns: "${caseText(c.sample, 100)}". Coach it.` });
    }
  }
  return out;
}

/// The case candidate [k] opens, as stored (supervisor-cases.jsonl `open`): everything
/// caseHolds reads later comes from here, so a field a rule holds on cannot be dropped
/// between the candidate and the case. [id] is the minted case id.
function openCase(k, id, now) {
  return { id, key: k.key, rule: k.rule, sessionId: k.id, server: k.server, name: k.name || null, line: k.line,
    waitAt: k.waitAt || null, turnAt: k.turnAt || null, fp: k.fp || null, seenAt: k.seenAt || null, openedAt: now };
}

/** R9's identity of a failure: its fingerprint, or (an older peer without one) its wording. */
function circleId(c) {
  return c ? (typeof c.fp === 'string' && c.fp ? c.fp : oneLine(c.sample, 120)) : null;
}

/// Does open case [c] still stand, given its session's node [n] this scan? An incomplete
/// scan that misses the session decides nothing (true). The case's own trigger moving on
/// (a new report, the turn ending, the failure no longer the top one) makes it obsolete.
function caseHolds(c, n, graph, verdicts) {
  if (!n) return !(graph && graph.complete);
  if (c.rule === 'R2') { const v = verdicts && verdicts[n.id]; return Boolean(v && v.state === 'orphan' && n.wait && n.wait.at === c.waitAt); }
  if (c.rule === 'R3') return Boolean(n.wait && n.wait.at === c.waitAt);
  if (c.rule === 'R4') return Boolean(ownerWaitOf(n) && n.wait.at === c.waitAt);
  if (c.rule === 'R6') return n.status === 'working' && (n.turnAt || null) === (c.turnAt || null);
  if (c.rule === 'R9') return Boolean(n.circling && circleId(n.circling) === c.fp);
  // R7 holds while the agent is still gone from the same sighting, and nobody exited it since.
  if (c.rule === 'R7') return Boolean(n.agentGone && n.agentGone.seenAt === c.seenAt && !Number.isFinite(n.agentGone.endedAt));
  return true;
}

/// Where open case [c] stands in the dispatch loop, at [now]. Pure.
///   'deliver'   not yet handed to the dispatcher (and not overdue)
///   'escalate'  not TAKEN for untakenMs since it was handed over (or, never handed over,
///               since it opened): the dispatcher is not acting on it, so the owner gets it
///   null        nothing to do: closed, already with the owner, taken, or handed over and
///               still inside its time
function caseDue(c, now, untakenMs = CASE_UNTAKEN_MS) {
  if (!c || c.resolvedAt || c.takenAt) return null;
  // #498 - escalated only because the dispatcher never got to it: while the supervisor still
  // looks first (caseChecking), it is handed over once it can be. A case handed over before
  // it escalated already had its turn, and one past its second chance is the owner's.
  if (c.escalated) return caseChecking(c, now, untakenMs) && !Number.isFinite(c.deliveredAt) ? 'deliver' : null;
  const since = Number.isFinite(c.deliveredAt) ? c.deliveredAt : c.openedAt;
  if (!Number.isFinite(since) || now - since > untakenMs) return 'escalate';
  return Number.isFinite(c.deliveredAt) ? null : 'deliver';
}

/// #498 - is escalated case [c] still the supervisor's to look at first, at [now]? Only one the
/// rules escalated as `untaken` (the dispatcher did not act on it in time), and only for one
/// more [untakenMs]: from its last hand-over to the dispatcher (a Tell hands it back, too), or
/// from the escalation when it was never handed over (the dispatcher's session stayed busy).
/// After that it is the owner's: a case is never left with nobody.
function caseChecking(c, now, untakenMs = CASE_UNTAKEN_MS) {
  const e = c && c.escalated;
  if (!_isObj(e) || c.resolvedAt || c.takenAt || escalationCause(e) !== 'untaken') return false;
  const since = Number.isFinite(c.deliveredAt) ? c.deliveredAt : e.at;
  return Number.isFinite(since) && Number.isFinite(now) && now - since <= untakenMs;
}

/// The cases and cards, folded from supervisor-cases.jsonl. Events:
///   open {case}  delivered {caseId}  taken {caseId, via}  escalated {caseId, question, by}
///   resolved {caseId, how, by}  card {card}  decided {cardId, decision, by, outcome}
/// `taken` is the dispatcher ACTING on the case (a verb naming it); being handed it is not.
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
      cases[e.case.id] = { ...e.case, deliveredAt: null, takenAt: null, escalated: null, resolvedAt: null, resolution: null };
      if (typeof e.case.key === 'string') keys.add(e.case.key);
      continue;
    }
    if (e.event === 'card' && _isObj(e.card) && ID_RE.test(e.card.id)) { cards[e.card.id] = { ...e.card, decision: null, decidedAt: null }; continue; }
    const c = typeof e.caseId === 'string' ? cases[e.caseId] : null;
    if (e.event === 'delivered' && c) c.deliveredAt = e.at || null;
    if (e.event === 'taken' && c && !c.takenAt) c.takenAt = e.at || null;
    if (e.event === 'escalated' && c) {
      c.escalated = { question: _str(e.question, 400) || c.line, at: e.at || null, by: _str(e.by, 40), auto: e.auto === true,
        cause: ESCALATION_CAUSES.includes(e.cause) ? e.cause : null };
      c.laterUntil = null; // #498 - a new escalation is asked anew: an older Later does not hide it
    }
    // #498 - the owner told the supervisor about an escalated case: it is the dispatcher's again.
    if (e.event === 'handed-back' && c && !c.resolvedAt) { c.escalated = null; c.deliveredAt = e.at || null; c.takenAt = null; c.laterUntil = null; }
    if (e.event === 'resolved' && c) { c.resolvedAt = e.at || null; c.resolution = { how: _str(e.how, 400), by: _str(e.by, 40) }; }
    const k = typeof e.cardId === 'string' ? cards[e.cardId] : null;
    if (e.event === 'decided' && k) {
      k.decision = CARD_DECISIONS.includes(e.decision) && e.decision !== 'retire' ? e.decision : 'dismiss';
      k.decidedAt = e.at || null; k.outcome = _str(e.outcome, 80);
    }
    // #498 - a card whose session is gone leaves the queue by itself, with its reason.
    if (e.event === 'retired' && k && !k.decision) { k.decision = 'retire'; k.decidedAt = e.at || null; k.outcome = _str(e.reason, 80); }
    // #498 - Later: hidden from the owner until [until]; it returns only if still pending.
    if (e.event === 'later' && k && !k.decision) k.laterUntil = Number.isFinite(e.until) ? e.until : null;
    if (e.event === 'later' && c && !c.resolvedAt) c.laterUntil = Number.isFinite(e.until) ? e.until : null;
  }
  return { cases, cards, keys };
}

/** #498 - how a card ends: the owner approves, dismisses, sends their own text (Edit, then
 *  send), or tells the supervisor instead; the server retires it once its session is gone. */
const CARD_DECISIONS = Object.freeze(['approve', 'dismiss', 'send', 'tell', 'retire']);
/** Later's bounds, in hours. */
const LATER_HOURS = Object.freeze({ min: 1, max: 24, default: 3 });

/** The owner's reserved actions (section 6a, "always step 4"), matched WORD by word on the
 *  text the dispatcher wants typed: a hit makes it a card. Deliberately broad - a phrase
 *  list leaked ("commit and push", "open the PR", "Remove-Item -Recurse"), and a false
 *  positive costs only a card the owner approves. A word cannot tell a request from a
 *  mention ("branch pushed once"), so the card says what the text MENTIONS (#498), never
 *  that it "asks for" it; only a word negated right before it ("not pushed") or a
 *  pre-PR review is not a hit (reservedMentions). */
const RESERVED = Object.freeze([
  ['merge or push a PR', /\b(push(es|ed|ing)?|force-push|merg(e|es|ed|ing)|pull requests?|PRs?)\b/i],
  ['a GitHub comment or issue', /\b(comment(s|ed|ing)?|repl(y|ies|ied|ying)|post(s|ed|ing)?)\b/i],
  ['deleting data', /\b(delet(e|es|ed|ing)|remov(e|es|ed|ing)|drop(s|ped|ping)?|reset(s|ting)?|wip(e|es|ed|ing)|purg(e|es|ed|ing)|truncat(e|es|ed|ing))\b|\brm\s+-|\bRemove-Item\b|\brmdir\b|\bdel\s+\//i],
  ['an install on a host', /\b(install(s|ed|ing|er)?|msiexec|setup\.exe|choco|winget)\b/i],
  ['spending money', /\b(pay(s|ing|ment)?|paid|purchas(e|es|ed|ing)|buy(s|ing)?|bought|subscrib(e|es|ed|ing))\b/i],
  ['something outward-facing', /\b(e-?mail(s|ed|ing)?|publish(es|ed|ing)?|announc(e|es|ed|ing))\b|\bsend\s+(it\s+|this\s+)?to\b/i],
]);

/** #498 - what, right before a reserved word, makes it not a request: a negation ("not
 *  pushed", "do not send it to", "don't merge", "has not been published"), optionally with
 *  one helper word between, or the `pre-` of a pre-PR review. Only the word RIGHT after it:
 *  "not only push" or "no PR needed, just push" still hit, so the gate fails closed. */
const NOT_A_REQUEST = /(?:(?:\b(?:not|never|no|nothing|nor|without|cannot)|n['’]t)\s+(?:(?:yet|ever|be|been|is|was|are|were|being)\s+)?|\bpre-)$/i;

/// #498 - every reserved action [text] mentions, in RESERVED's order, each with the first word
/// that is not negated: `[{what, word}]`. Empty: nothing only the owner decides.
function reservedMentions(text) {
  const s = String(text || '');
  const out = [];
  for (const [what, re] of RESERVED) {
    // A fresh /g copy per call: a shared /g regex keeps lastIndex between calls.
    const g = new RegExp(re.source, 'gi');
    for (let m = g.exec(s); m; m = g.exec(s)) {
      if (!m[0]) { g.lastIndex++; continue; }
      if (NOT_A_REQUEST.test(s.slice(Math.max(0, m.index - 40), m.index))) continue;
      out.push({ what, word: oneLine(m[0], 30) });
      break;
    }
  }
  return out;
}

/// The first reserved action [text] mentions, by name, or null.
function reservedAction(text) {
  const m = reservedMentions(text);
  return m.length ? m[0].what : null;
}

/// #498 - why a text is a card and not an act, as the owner reads it: what it MENTIONS and the
/// word that matched ("it mentions deleting data ("reset"), which only the owner decides"), or
/// null. [subject] names the text ("it", "the note").
function reservedWhy(text, subject = 'it') {
  const m = reservedMentions(text).map((x) => `${x.what} ("${x.word}")`);
  if (!m.length) return null;
  const list = m.length === 1 ? m[0] : `${m.slice(0, -1).join(', ')} and ${m[m.length - 1]}`;
  return `${subject} mentions ${list}, which only the owner decides`;
}

/// #498 - why a class in recommend mode makes a card.
function recommendWhy(cls) {
  return `you set "${cls}" to ask you first (recommend mode)`;
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
  const reserved = reservedWhy(text);
  const mode = (cfg && cfg.autonomy && cfg.autonomy[cls]) || 'act';
  if (reserved) return { mode: 'card', cls, text: line, why: reserved };
  if (mode === 'recommend') return { mode: 'card', cls, text: line, why: recommendWhy(cls) };
  return { mode: 'act', cls, text: line };
}

/// Is the dispatcher able to take a case now? [node] its node (null: not running, which
/// is no block: the server starts it). Returns null (yes) or why not: 'off' | 'paused' | 'capped'.
function dispatcherBlock({ cfg, paused, node }) {
  if (!cfg || !cfg.enabled) return 'off';
  if (paused) return 'paused';
  if (node && node.capped) return 'capped';
  return null;
}

/// #525 - the open case the dispatcher holds in [state] (foldCases) at [now], or null. The
/// dispatcher is replaced by a fresh one only with nothing in hand, so no case is cut off half
/// done. In hand: handed to it or taken by it within the last [holdMs] (the untaken window: a
/// case it has not taken by then goes to the owner, and one it acted on and left open is in
/// notes.md and the case list for the next dispatcher, so neither holds it back for ever), and
/// not with the owner. An escalated case is in hand only while #498's second look is the
/// dispatcher's (caseChecking) and it was handed back after the escalation.
function caseInHand(state, now, holdMs = CASE_UNTAKEN_MS) {
  for (const c of Object.values((state && state.cases) || {})) {
    if (!c || c.resolvedAt) continue;
    const had = Math.max(Number.isFinite(c.takenAt) ? c.takenAt : 0, Number.isFinite(c.deliveredAt) ? c.deliveredAt : 0);
    if (!had || !Number.isFinite(now) || now - had > holdMs) continue;
    if (!_isObj(c.escalated)) return c.id;
    const at = Number.isFinite(c.escalated.at) ? c.escalated.at : Infinity;
    if (Number.isFinite(c.deliveredAt) && c.deliveredAt > at && caseChecking(c, now, holdMs)) return c.id;
  }
  return null;
}

/// #525 - the dispatcher's own hand-off terms for lib/handoff.js handoffCandidate: its lower
/// context point, and the case in hand that holds it back. The case log decides, not the
/// dispatcher's report (it reports no wait between cases, which the generic rule reads as
/// "not at a boundary" forever).
function dispatcherHandoffTerms(cfg, state, now) {
  return { ctxThreshold: (cfg || dispatcherConfig(null)).handoffTokens, block: caseInHand(state, now) ? 'case-in-hand' : null };
}

/// The prompt that hands case [c] to the dispatcher (under 512 bytes with the tag).
function casePrompt(c, cli, maxBytes) {
  const tail = ` Read it: node "${cli}" case ${c.id}`;
  const head = `Case ${c.id} (${c.rule}): `;
  return head + clipBytes(oneLine(c.line, 300), maxBytes - Buffer.byteLength(head + tail, 'utf8')) + tail;
}

/// The owner's queue from cases and cards: escalated open cases and pending cards, oldest
/// first, as owner-ladder items `{key, id, server, name, what, at}` (lib/supervisor.js ownerPlan).
/// An R4 case the RULES escalated (`auto`: the dispatcher could not take it) is the owner's
/// wait itself, already on the ladder: not pushed twice. The dispatcher's own question is.
function ownerItems({ cases, cards }, now = null) {
  const out = [];
  for (const c of Object.values(cases || {})) {
    if (c.resolvedAt || !c.escalated || (c.rule === 'R4' && c.escalated.auto)) continue;
    // #498 - the supervisor never got to it (its own session was busy): it still looks first.
    if (caseChecking(c, now)) continue;
    if (Number.isFinite(now) && Number.isFinite(c.laterUntil) && c.laterUntil > now) continue;
    out.push({ key: `case|${c.id}`, id: c.sessionId, server: c.server, name: c.name, what: oneLine(c.escalated.question, 100), at: c.escalated.at || c.openedAt });
  }
  for (const k of Object.values(cards || {})) {
    if (k.decision) continue;
    // #498 - a card put off with Later is not the owner's until its time comes.
    if (Number.isFinite(now) && Number.isFinite(k.laterUntil) && k.laterUntil > now) continue;
    out.push({ key: `card|${k.id}`, id: k.sessionId, server: k.server, name: k.name, what: oneLine(`Approve? ${k.text}`, 100), at: k.at });
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/// Each class's record (section 12): mode, and how many of its cards were approved / dismissed.
function autonomyRecord(cfg, cards) {
  const out = {};
  const blank = (mode) => ({ mode, approved: 0, dismissed: 0, pending: 0, edited: 0, told: 0, retired: 0 });
  for (const k of CLASSES) out[k] = blank((cfg && cfg.autonomy && cfg.autonomy[k]) || 'act');
  // #498: a retired card (its session went) and the owner's own text are no dismissal.
  const bucket = { approve: 'approved', dismiss: 'dismissed', send: 'edited', tell: 'told', retire: 'retired' };
  for (const c of Object.values(cards || {})) {
    const r = out[c.cls] || (out[c.cls] = blank('act'));
    r[bucket[c.decision] || 'pending']++;
  }
  return out;
}

// --- #498 cards that explain themselves, and retire once they cannot apply -------------------

/// The cards to retire this scan: a pending card whose session is PROVEN gone. Pure.
///   cards  `{id: card}` (foldCases)     graph  this scan (lib/supervisor.js buildGraph)
///   prev   the sightings from the scan before `{sessionId: {firstAt, lastAt}}`
/// Gone means missing on two scans confirmMs apart (lib/supervisor.js noteAbsent) in which the
/// card's OWN server answered: a session lives on one server, so that server's list is the
/// proof, and another peer being down (a sleeping laptop) proves nothing either way. A server
/// that did not answer (or one no longer in the cluster) is "cannot tell", never gone: its
/// cards' sightings are kept as they were. A card's session was seen in scope when the card
/// was made, so no `known` filter. A session replaced (the replacement names it in
/// `replaces`) is retired at once, on the same condition.
/// Returns `{ sightings, retire: [{cardId, reason}] }`.
function cardRetirements({ cards, graph, prev, confirmMs }) {
  const pending = Object.values(cards || {}).filter((k) => k && !k.decision && typeof k.sessionId === 'string');
  const answered = new Set(((graph && graph.servers) || []).filter((s) => s.ok).map((s) => s.name));
  const heard = pending.filter((k) => answered.has(k.server)).map((k) => k.sessionId);
  const unheard = pending.filter((k) => !answered.has(k.server)).map((k) => k.sessionId);
  const ab = noteAbsent(prev, heard, { ...graph, complete: true }, { confirmMs, known: null });
  const keep = noteAbsent(prev, unheard, { ...graph, complete: false }, { confirmMs, known: null });
  const aliases = (graph && graph.aliases) || {};
  const retire = [];
  for (const k of pending) {
    if (!answered.has(k.server)) continue;
    if (aliases[k.sessionId]) retire.push({ cardId: k.id, reason: 'session replaced' });
    else if (ab.states[k.sessionId] === 'gone') retire.push({ cardId: k.id, reason: 'session gone' });
  }
  return { sightings: { ...keep.sightings, ...ab.sightings }, retire };
}

// --- #498 an escalation says what the owner is asked ---------------------------------------

/** Why a case reached the owner: the dispatcher asked (`asked`), it cannot look (`blocked`:
 *  switched off, paused, at its cap), or it never got to the case (`untaken`). */
const ESCALATION_CAUSES = Object.freeze(['asked', 'blocked', 'untaken']);

/// The cause of escalation [e]: the event's own, else (an event written before #498) read off
/// how it was written: the dispatcher's ask-owner is not `auto`; the rules wrote
/// `rules (dispatcher <block>)` or `rules (not taken in N min...)`.
function escalationCause(e) {
  if (!_isObj(e)) return null;
  if (ESCALATION_CAUSES.includes(e.cause)) return e.cause;
  if (e.auto !== true) return 'asked';
  return /^rules \(dispatcher /.test(e.by || '') ? 'blocked' : 'untaken';
}

/** What each rule's case IS, as an escalation's title. */
const CASE_TITLES = Object.freeze({
  R2: 'Its lead is gone', R3: 'It is not moving on', R4: 'It waits on you', R6: 'Its turn looks stuck',
  R7: 'Its agent has died', R9: 'It keeps hitting the same failure',
});
/** What the owner is asked to do about each rule's case, in plain words. */
const CASE_ASKS = Object.freeze({
  R2: 'Answer it for its lead: write to it what to do next, or mark it as needing nothing.',
  R3: 'Check whether it still has to wait. Write to it to carry on, or mark it as needing nothing.',
  R4: 'Open the session and answer what it waits on.',
  R6: 'Look at its screen. Write to it, or mark it as needing nothing.',
  R7: 'Open the session and replace it, or mark it as needing nothing if its job is over.',
  R9: 'Write to it what to try instead, or mark it as needing nothing.',
});
const BLOCKED_WORDS = Object.freeze({ off: 'switched off', paused: 'paused', capped: 'at its usage limit' });

/// #498 - escalated case [c] as the owner reads it: `kind` question (the supervisor asks
/// something) or stuck (the rules raised a fact), a `title`, what the owner is `ask`ed to do,
/// `whyYou` (why it reached the owner), and `checking` (the supervisor still looks at it
/// first, at [now]: not the owner's). Null when [c] is not escalated.
function caseOwnerView(c, now = null) {
  const e = c && c.escalated;
  if (!_isObj(e)) return null;
  const cause = escalationCause(e);
  if (cause === 'asked') {
    return { kind: 'question', cause, title: 'The supervisor asks', ask: e.question || c.line,
      whyYou: 'The supervisor could not settle this within your rules, so it asks you.', checking: false };
  }
  const block = cause === 'blocked' ? (/^rules \(dispatcher (\w+)/.exec(e.by || '') || [])[1] : null;
  const checking = caseChecking(c, now);
  let whyYou;
  if (cause === 'blocked') whyYou = `The supervisor cannot look at it: it is ${BLOCKED_WORDS[block] || 'not available'}, so nobody else will act on it.`;
  else if (checking) whyYou = 'The supervisor has not got to it yet (its own session was busy). It looks first; nothing is needed from you.';
  else if (Number.isFinite(c.deliveredAt)) whyYou = 'The supervisor was handed it and did not act on it in time, so it is yours now.';
  else whyYou = 'The supervisor could not get to it in time (its own session stayed busy), so it is yours now.';
  return { kind: 'stuck', cause, title: CASE_TITLES[c.rule] || 'It looks stuck', ask: CASE_ASKS[c.rule] || 'Open the session and decide.', whyYou, checking };
}

/** What each class of card proposes, as the card's title. */
const CARD_TITLES = Object.freeze({
  wake: 'Wake it with a fact', coach: 'Coach it', answer: 'Answer for you', lead: 'Stand in for its lead',
  owner: 'Act on your behalf', close: 'Close it', spawn: 'Replace it',
});

/// What Approve does to card [k]'s session, in plain words (the server decides it: the card
/// route types, closes or replaces by class).
function cardDoes(k) {
  const name = `"${oneLine(k.name || String(k.sessionId || '').slice(0, 8), 60)}"`;
  const on = k.server ? ` on ${k.server}` : '';
  if (k.cls === 'close') return `Approve closes ${name}${on}: its work is done and its close-out is clean. Its conversation stays on disk and can be resumed.`;
  if (k.cls === 'spawn') {
    const fresh = Boolean(k.spawn && k.spawn.fresh);
    return `Approve starts a new session${on} in place of ${name}, ${fresh ? "from a fresh start with the supervisor's note" : 'that carries on its conversation (or its own hand-off)'}, and closes the old one once the new one is up.`;
  }
  return `Approve types the supervisor's message into ${name}${on}, once it is idle with nothing typed in its box.`;
}

/// #498 - a card as the companion reads it: the stored card, plus its title, what Approve does,
/// and its session as the last scan saw it ([node]: status, headline, its first work items;
/// null when the scan does not list it).
function cardView(k, node) {
  return {
    ...k,
    title: CARD_TITLES[k.cls] || 'A proposal',
    does: cardDoes(k),
    target: node ? { status: node.status || null, headline: node.headline || null, items: (Array.isArray(node.items) ? node.items : []).slice(0, 2) } : null,
  };
}

/** #498 - a refusal from the session's own server (lib/safe-prompt.js promptRefusal, the
 *  close and replace gates, supervisorDeliver), in plain words. */
const REFUSALS = Object.freeze({
  'session not found': (s) => `That session no longer exists${s}: it was closed or replaced.`,
  unreachable: (s, srv) => `${srv || 'Its machine'} did not answer, so nothing was sent.`,
  'no-such-server': (s, srv) => `${srv || 'Its machine'} is not in this server's cluster list, so nothing was sent.`,
  'no stored token': (s, srv) => `This server holds no token for ${srv || 'that machine'}, so nothing was sent.`,
  'worker-unavailable': () => 'Its machine could not reach its terminal process, so nothing was typed.',
  busy: () => 'Something else is being typed into that session right now. Try again in a moment.',
  typing: () => 'Someone typed into that session a moment ago. Try again once they stop.',
  draft: () => 'That session has unsent text in its box, and it is never overwritten. Send or clear it first.',
  'not-idle': () => 'That session is working. It can take this once its turn ends.',
  'check-in': () => 'A check-in was just typed into that session. Try again once it answers.',
  capped: () => 'That session is stopped at its usage limit. Try again after it resumes.',
  'api-error': () => 'That session is recovering from an API error. Try again once it is running.',
  'agent-gone': () => 'The agent in that session has exited, so a message would run as a shell command. Replace the session instead.',
  'restart-hold': () => 'A server restart is waiting on the sessions, so nothing is typed now. Try again after it.',
  stale: () => 'The session has moved on since this card was made, so it no longer applies.',
  budget: () => 'The supervisor has used its hourly budget of actions. Try again later.',
  'in-progress': () => 'A hand-off of that session is already running.',
  'handed-off': () => 'That session has already handed off to a new one.',
  handoff: () => 'That session is handing off to a new one.',
  owner: () => 'That session is yours, and the supervisor never closes your sessions.',
  viewer: () => 'Someone has that session open, so it is not closed under them.',
  favorite: () => 'That session is a favorite, so it is not closed.',
  'live-work': () => 'That session still has work running, so it is not closed.',
  'live-child': () => 'That session still has a child session running, so it is not closed.',
  'not-clean': () => 'That session\'s close-out is not clean, so it is not closed.',
  'not-done': () => 'That session is not done any more, so it is not closed.',
});

/// #498 - refusal [code] as a sentence the owner can act on; [server] names the session's machine.
function refusalText(code, server = null) {
  const c = String(code || '');
  const f = REFUSALS[c];
  if (f) return f(server ? ` on ${server}` : '', server);
  return `The session refused it (${oneLine(c, 80) || 'no reason given'}).`;
}

/// #498 - "Tell the supervisor": the owner's note about card [k], as the line typed into the
/// dispatcher (it fits the gated prompt with its tag). [dontAsk]: the owner does not want cards
/// like this one. Null when there is nothing to say.
function tellText(k, note, dontAsk) {
  const n = oneLine(note, NOTE_CHARS_MAX);
  if (!n && !dontAsk) return null;
  // A card the dispatcher proposed with its question names that case: Tell hands it back too.
  const kase = k.caseId ? `, case ${caseText(k.caseId, 20)}` : '';
  const head = `The owner, on card ${k.id} (${k.cls} for "${caseText(k.name || String(k.sessionId || '').slice(0, 8), 60)}"${kase}): `;
  const ask = dontAsk ? `do not ask me about cards like this again (${caseText(k.why || k.cls, 120)}); handle this kind within the rules yourself, or let it be.${n ? ' ' : ''}` : '';
  return fitNote(head + ask, n, '', TEXT_BYTES_MAX);
}

/** The most of a note read at all (the route's body cap bounds it too); what fits is fitNote's call. */
const NOTE_CHARS_MAX = 4000;

/// #498 - the owner's [note] between [head] and [tail], as one line of at most [maxBytes]:
/// `{text}`, or `{error}` in plain words when it does not fit. Never cut: a note cut short says
/// half of what the owner meant, and the supervisor would act on that half.
function fitNote(head, note, tail, maxBytes) {
  const n = oneLine(note, NOTE_CHARS_MAX);
  const over = Buffer.byteLength(head + n + tail, 'utf8') - maxBytes;
  if (over <= 0) return { text: head + n + tail };
  // What the note cannot fix (a long session name in the line around it) is said as such.
  if (over > Buffer.byteLength(n, 'utf8')) return { error: 'The message about this item is too long to send, even with no note. Nothing was sent.' };
  const perChar = Buffer.byteLength(n, 'utf8') / [...n].length;
  return { error: `The note is too long to send: shorten it by about ${Math.ceil(over / perChar)} characters. Nothing was sent.` };
}

/// #498 - "Tell the supervisor" about escalated case [c]: the owner's [note], as the line typed
/// into the dispatcher, naming the case so it reads it again (it is the dispatcher's again).
function caseTellText(c, note, cli, maxBytes) {
  const head = `The owner, on case ${c.id} (${c.rule} for "${caseText(c.name || String(c.sessionId || '').slice(0, 8), 60)}"): `;
  const tail = ` The case is yours again. Read it: node "${cli}" case ${c.id}`;
  return fitNote(head, note, tail, maxBytes);
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
  CLASSES, VERB_CLASS, VERB_LEAD_IN, RULES, DISPATCHER_NAME, DISPATCHER_MODEL, DISPATCHER_HANDOFF_TOKENS, RESERVED, ID_RE, CASE_UNTAKEN_MS, CARD_DECISIONS, CARD_TITLES, LATER_HOURS,
  dispatcherConfig, oneLine, caseText, hookAt, caseCandidates, openCase, circleId, caseHolds, caseDue, foldCases, reservedAction, verbDecision,
  reservedMentions, reservedWhy, recommendWhy,
  dispatcherBlock, casePrompt, withModel, caseInHand, dispatcherHandoffTerms, ownerItems, autonomyRecord, nightSummary,
  cardRetirements, cardDoes, cardView, refusalText, tellText,
  ESCALATION_CAUSES, CASE_TITLES, CASE_ASKS, escalationCause, caseOwnerView, caseTellText, caseChecking, fitNote,
};
