'use strict';
// #506 - Mission Control: "Answer now" vs "My to-do", ranked by what each one blocks.
//
// The ONE owner of: which waits are on the person NOW (a session that cannot continue
// without them: a question or permission prompt on screen, a decision card, a reported
// `you` wait), which of those the person moved to their desk (My to-do) or put off
// (Later), how Answer now is ranked and why, the fixed message that tells a session its
// wait was parked, and what each to-do action may do. The companion renders these fields
// and never re-derives them (docs/mission-control.md "Answer now / My to-do").
//
// The card itself (its id, kind, what, since when) is lib/mc-subjects.js `needsYouCard`, the
// same card a subject's `needsYou` carries; who waits on whom is lib/mc-tree.js. This module
// only reads them.
//
// Pure: the server passes in the session nodes, the subjects view, the stored to-dos and
// "later"s (lib/mc-state.js) and the clock.
const mcSubjects = require('./mc-subjects');
const { buildTree } = require('./mc-tree');

/** C0, DEL, C1 and the Unicode line separators: what would break a one-line text. */
const NOT_ONE_LINE = new RegExp(`[\x00-\x1f\x7f-\x9f${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** "Later": how long a card may be put off, in whole hours. */
const LATER_HOURS_MIN = 1;
const LATER_HOURS_MAX = 24;
/** A to-do the person ticked done (or sent back) is kept this long, then dropped. */
const TODO_KEEP_DONE_MS = 7 * 24 * HOUR;
/** At most this many to-dos are kept (the oldest finished ones go first). */
const TODO_MAX = 500;
const TODO_TEXT_MAX = 500;
const TODO_ACTIONS = Object.freeze(['done', 'reopen', 'back', 'park']);
/** What became of the park message: `sending` (recorded, not yet answered: after a
 *  restart it may have landed, so it is never sent again), `delivered`, `refused` (the
 *  session's gates said no: the person may ask again), `uncertain` (the request went out
 *  and no answer came: it may have landed, never sent again), `none` (a question or a
 *  permission prompt on screen: text typed there would ANSWER it, and once it is gone
 *  nothing says the message is still about the same wait, so none is ever sent; the person
 *  answers it at the desk). */
const PARK_STATES = Object.freeze(['sending', 'delivered', 'refused', 'uncertain', 'none']);
/** The kinds a park message is never sent for: the prompt is on the session's screen. */
const ON_SCREEN = Object.freeze(['question', 'permission']);

/** The ref as the park message names it: one line, short, no control characters. */
function cleanRef(ref) {
  const s = typeof ref === 'string' ? ref.replace(NOT_ONE_LINE, ' ').trim() : '';
  const cps = Array.from(s); // by code point: a cut never splits a surrogate pair
  return cps.length > 80 ? `${cps.slice(0, 79).join('')}...` : s;
}

/** THE park message: one fixed sentence (the work item named, when there is one). It goes
 *  through the gated prompt (lib/safe-prompt.js), which adds the supervisor tag (a SYSTEM
 *  turn, lib/user-turn.js) and keeps the whole line under 512 bytes. */
function parkText(card) {
  const ref = cleanRef(card && card.ref);
  const what = ref ? `your wait on ${ref}` : 'your current wait on them';
  return `[Mission Control] The user moved ${what} to their to-do list and will handle it at the desk. `
    + 'Park it (do not wait for it), carry on with your other work, and report that wait as external.';
}

/** The body for POST /api/sessions/:id/prompt. A reported wait (wait, decision) is named by
 *  its `at`, so a session that has reported since is refused `stale` rather than told about a
 *  wait it no longer has; a prompt on screen carries no such time. */
function parkBody(card) {
  const reported = card && (card.kind === 'wait' || card.kind === 'decision') && Number.isInteger(card.askedAt) && card.askedAt > 0;
  return { text: parkText(card), tag: 'supervisor', ...(reported ? { expectWaitAt: card.askedAt } : {}) };
}

/** A refusal code from the gated prompt (lib/safe-prompt.js REASONS) in plain words. */
const PARK_REFUSAL_WORDS = Object.freeze({
  'on-screen': 'a question or permission prompt is on its screen: answer it there (a message typed in would answer it)',
  draft: 'it has unsent text in its prompt box',
  typing: 'someone typed into it a moment ago',
  waiting: 'a question or permission prompt is on its screen (answer or dismiss it there first)',
  'not-idle': 'it is in the middle of a turn',
  busy: 'another prompt is being typed into it',
  stale: 'it has reported again since this card',
  'no-agent': 'no agent runs in it',
  'agent-gone': 'its agent has exited',
  'not-ready': 'its agent is still starting',
  menu: 'a menu is open over its prompt',
  'blocked-prompt': 'a startup prompt is on its screen',
  compacting: 'it is compacting',
  capped: 'it is waiting out a usage limit',
  'api-error': 'it is recovering from an API error',
  'check-in': 'a check-in was just typed into it',
  'restart-hold': 'a restart hold is in progress',
  handoff: 'it is handing off',
  'handed-off': 'it was handed off to a successor',
  unreachable: 'its server is unreachable',
  'no-such-server': 'its server is not in this cluster',
  'no stored token': 'this server holds no token for its server',
});
const refusalWords = (why) => PARK_REFUSAL_WORDS[why] || String(why || 'refused');

/** A node is still running (not a closed record). */
const live = (n) => n && !n.closed;
const keyOfRef = (n) => `${n.server || ''}|${n.id}`;

/** Every wait on the person now, as cards with `why` (what it blocks), unranked: one per
 *  live session whose wait (lib/mc-subjects.js sessionWaitOn, the subjects' own rule) is
 *  `you`. `view`: lib/mc-subjects.js buildView's answer for the same nodes. */
function pendingCards({ nodes, view, now = Date.now() }) {
  const list = Array.isArray(nodes) ? nodes : [];
  const tree = buildTree(list);
  const subjects = new Map(((view && view.subjects) || []).map((s) => [s.key, s]));
  const keysOf = (n) => {
    const out = [];
    for (const it of n.items || []) {
      if (!it || it.state === 'done') continue;
      const k = mcSubjects.subjectKeyOf(it, n);
      if (k && !out.includes(k)) out.push(k);
    }
    return out;
  };
  const cards = [];
  for (const n of list) {
    if (!live(n) || mcSubjects.sessionWaitOn(n, null) !== 'you') continue;
    const own = keysOf(n);
    const subj = own.map((k) => subjects.get(k)).find(Boolean) || null;
    const card = mcSubjects.needsYouCard(n, subj ? subj.key : null, subj ? subj.ref : null, subj ? subj.title : null);
    // What it blocks: itself, and every live session above it (an orchestrator waits on the
    // children it opened, at any depth: lib/mc-tree.js), and the work items they carry.
    const blocked = [n, ...tree.ancestorsOf(n).filter(live)];
    const seen = new Set();
    const blockedSessions = [];
    for (const b of blocked) {
      if (seen.has(keyOfRef(b))) continue;
      seen.add(keyOfRef(b));
      blockedSessions.push({ server: b.server, id: b.id, name: b.name });
    }
    const blockedSubjects = [];
    for (const b of blocked) for (const k of keysOf(b)) if (!blockedSubjects.includes(k)) blockedSubjects.push(k);
    const sevs = blockedSubjects.map((k) => subjects.get(k)).map((s) => s && s.meta && s.meta.severity).filter((x) => Number.isFinite(x));
    const severity = sevs.length ? Math.min(...sevs) : null;
    const ageMin = Number.isFinite(card.askedAt) ? Math.max(0, Math.floor((now - card.askedAt) / MIN)) : null;
    cards.push({
      ...card,
      project: subj ? subj.project : null,
      why: { blocks: blockedSessions.length, blockedSessions, subjects: blockedSubjects, severity, ageMin,
        text: whyText(blockedSessions.length, blockedSubjects.length) },
      rank: null,
      hasQuestion: card.kind === 'question',
    });
  }
  return cards;
}

/** "blocks 3 sessions and 2 work items" - the reason a card ranks where it does. */
function whyText(sessions, items) {
  const s = sessions > 1 ? `blocks ${sessions} sessions` : 'blocks this session';
  if (!items) return s;
  return `${s} and ${items === 1 ? '1 work item' : `${items} work items`}`;
}

/** THE order: blocked sessions, then blocked work items (most first), then severity (1 is
 *  highest; none last), then age (oldest first; unknown last), then id (a stable order). */
function compareCards(a, b) {
  const sa = a.why.severity === null ? Infinity : a.why.severity;
  const sb = b.why.severity === null ? Infinity : b.why.severity;
  const aa = a.why.ageMin === null ? -1 : a.why.ageMin;
  const ab = b.why.ageMin === null ? -1 : b.why.ageMin;
  return (b.why.blocks - a.why.blocks) || (b.why.subjects.length - a.why.subjects.length)
    || (sa - sb) || (ab - aa) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A to-do that hides its card: every one but those sent back. */
const holdsCard = (t) => t && t.state !== 'back';

/** The park message was not sent, and the to-do says why. */
const notSent = (p) => p.state === 'refused' || p.state === 'none';

/** The to-do as the wire carries it. */
function publicTodo(t) {
  const p = t.park || {};
  return {
    id: t.id, cardId: t.cardId, kind: t.kind || null, subjectKey: t.subjectKey || null, ref: t.ref || null, title: t.title || null,
    project: t.project || null, text: t.text || null, server: t.server || null, sessionId: t.sessionId || null,
    sessionName: t.sessionName || null, createdAt: t.createdAt, doneAt: t.state === 'done' ? t.doneAt || null : null,
    park: { state: PARK_STATES.includes(p.state) ? p.state : null, refused: notSent(p) ? p.why || 'refused' : null,
      reason: notSent(p) ? refusalWords(p.why) : null, at: Number.isFinite(p.at) ? p.at : null },
  };
}

/** GET /api/mc/now: `{answerNow, todo, moving, later}`. `todos`: the stored to-dos
 *  (lib/mc-state.js); `later`: {cardId: {until}}. A card is hidden while a to-do holds it
 *  (open or done: the person said they handle it at the desk) or until its "later" ends; a
 *  card whose wait has ended is simply not pending any more, so it never comes back. */
function buildNow({ nodes, view, todos = [], later = {}, now = Date.now() }) {
  const all = pendingCards({ nodes, view, now });
  const held = new Set(todos.filter(holdsCard).map((t) => t.cardId));
  const answerNow = all.filter((c) => !held.has(c.id) && !(later[c.id] && later[c.id].until > now)).sort(compareCards);
  answerNow.forEach((c, i) => { c.rank = i + 1; });
  const todo = todos.filter(holdsCard).sort((a, b) => ((a.state === 'done') - (b.state === 'done')) || (b.createdAt - a.createdAt)).map(publicTodo);
  // Moving on its own: every live session nothing is owed on (a parked one counts once its
  // wait is no longer on the person).
  const owing = new Set(all.map((c) => `${c.server || ''}|${c.sessionId}`));
  let working = 0;
  let idle = 0;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!live(n) || owing.has(keyOfRef(n))) continue;
    const w = n.reason !== undefined ? (n.reason && n.reason.kind === 'working') : n.status === 'working';
    if (w) working += 1; else idle += 1;
  }
  return { answerNow, todo, moving: { working, idle, total: working + idle }, pending: all };
}

/** `{cardId, text?}` -> `{cardId, text}` or `{error}`. */
function todoInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { error: 'body must be a JSON object' };
  if (typeof b.cardId !== 'string' || !b.cardId || b.cardId.length > 400) return { error: 'cardId must be the id of an Answer-now card' };
  if (b.text !== undefined && b.text !== null && typeof b.text !== 'string') return { error: 'text must be a string' };
  const text = typeof b.text === 'string' ? b.text.replace(NOT_ONE_LINE, ' ').trim() : '';
  if (text.length > TODO_TEXT_MAX) return { error: `text must be at most ${TODO_TEXT_MAX} characters` };
  return { cardId: b.cardId, text: text || null };
}

/** A new to-do for [card]. `id` is the caller's (random). The park starts as `sending`: it is
 *  recorded BEFORE the message goes out, so a crash in between never sends it twice. A prompt
 *  on screen gets none (`none`, PARK_STATES). */
function newTodo(card, { id, text, now }) {
  return {
    id, cardId: card.id, kind: card.kind, subjectKey: card.subjectKey || null, ref: card.ref || null, title: card.title || null,
    project: card.project || null, text: text || null, server: card.server || null, serverUrl: card.serverUrl || null,
    sessionId: card.sessionId || null, sessionName: card.sessionName || null, createdAt: now, state: 'open', doneAt: null,
    park: ON_SCREEN.includes(card.kind) ? { state: 'none', why: 'on-screen', at: now } : { state: 'sending', why: null, at: now, body: parkBody(card) },
  };
}

/** What `action` does to to-do [t]: `{todo, park: bool}` (park = send the park message now),
 *  or `{error, status}`. `park` is an explicit retry of a REFUSED message only: a delivered
 *  one is never sent again, and neither is one that may have landed (sending, uncertain). */
function applyAction(t, action, now) {
  if (!TODO_ACTIONS.includes(action)) return { status: 400, error: `action must be one of: ${TODO_ACTIONS.join(', ')}` };
  if (!t || t.state === 'back') return { status: 404, error: 'no such to-do' };
  if (action === 'done') return t.state === 'done' ? { status: 409, error: 'already done' } : { todo: { ...t, state: 'done', doneAt: now } };
  if (action === 'reopen') return t.state !== 'done' ? { status: 409, error: 'it is not done' } : { todo: { ...t, state: 'open', doneAt: null } };
  if (action === 'back') return { todo: { ...t, state: 'back', backAt: now } };
  const p = t.park || {};
  if (p.state === 'none') return { status: 409, error: refusalWords('on-screen') };
  if (p.state !== 'refused') return { status: 409, error: p.state === 'delivered' ? 'the session was already told' : 'the message may already have reached the session, so it is not sent again' };
  return { todo: { ...t, park: { ...p, state: 'sending', why: null, at: now } }, park: true };
}

/** The park message's answer (server.js deliverGatedPrompt's `{delivered}|{uncertain}|{why}`)
 *  recorded on the to-do. */
function parkResult(t, out, now) {
  const state = out && out.delivered ? 'delivered' : out && out.uncertain ? 'uncertain' : 'refused';
  return { ...t, park: { ...(t.park || {}), state, why: state === 'refused' ? String((out && out.why) || 'refused') : null, at: now } };
}

/** The `parked` answer of POST /api/mc/todo. */
function parkedAnswer(t, { already = false } = {}) {
  const p = t.park || {};
  return {
    delivered: p.state === 'delivered',
    ...(notSent(p) ? { refused: p.why || 'refused', reason: refusalWords(p.why) } : {}),
    ...(p.state === 'uncertain' || p.state === 'sending' ? { uncertain: true } : {}),
    ...(already ? { already: true } : {}),
  };
}

/** `{cardId, hours}` -> `{cardId, hours}` or `{error}`. */
function laterInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { error: 'body must be a JSON object' };
  if (typeof b.cardId !== 'string' || !b.cardId || b.cardId.length > 400) return { error: 'cardId must be the id of an Answer-now card' };
  if (!Number.isInteger(b.hours) || b.hours < LATER_HOURS_MIN || b.hours > LATER_HOURS_MAX) {
    return { error: `hours must be a whole number from ${LATER_HOURS_MIN} to ${LATER_HOURS_MAX}` };
  }
  return { cardId: b.cardId, hours: b.hours };
}

/** The to-dos worth keeping: open ones, and finished ones (done, sent back) for a week; at
 *  most TODO_MAX (the oldest finished go first). A to-do sent back is kept that week too, so
 *  moving the same card to My to-do again never sends its session a second message. */
function pruneTodos(todos, now) {
  const ended = (t) => (t.state === 'done' ? t.doneAt : t.state === 'back' ? t.backAt : null);
  let keep = todos.filter((t) => { const e = ended(t); return !Number.isFinite(e) || now - e <= TODO_KEEP_DONE_MS; });
  if (keep.length > TODO_MAX) {
    const open = keep.filter((t) => t.state === 'open');
    const fin = keep.filter((t) => t.state !== 'open').sort((a, b) => ended(b) - ended(a));
    keep = [...open, ...fin].slice(0, TODO_MAX);
  }
  return keep;
}

/** The "later"s still running. */
function pruneLater(later, now) {
  const out = {};
  for (const [k, v] of Object.entries(later || {})) if (v && Number.isFinite(v.until) && v.until > now) out[k] = v;
  return out;
}

module.exports = {
  LATER_HOURS_MIN, LATER_HOURS_MAX, TODO_ACTIONS, PARK_STATES, ON_SCREEN, TODO_KEEP_DONE_MS,
  parkText, parkBody, refusalWords, pendingCards, compareCards, whyText, buildNow, publicTodo,
  todoInput, newTodo, applyAction, parkResult, parkedAnswer, laterInput, pruneTodos, pruneLater,
};
