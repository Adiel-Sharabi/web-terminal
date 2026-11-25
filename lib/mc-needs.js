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
const { askKey, refKey } = require('./session-brief');
const { significantWordsOf } = require('./unreported-ask');
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
 *  answers it at the desk; an ask (#526) holds nobody up, so there is no wait to park: also
 *  `none`). */
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
  'not-blocking': 'the session is not waiting on this, so it was told nothing',
  supervisor: 'it is the supervisor\'s dispatcher, which runs the fleet\'s cases: nothing is typed into it for a to-do',
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

/** At least this many of a card's words must be an item's own for the card to be about it (and
 *  more than any other item's): one shared word ("build", "phone") is how a title lands on a
 *  question about something else. */
const WORDS_MIN = 2;

/** #541 - THE rule for which work item a card of session [n] is about: the card's subject (a
 *  record of [subjects], lib/mc-subjects.js buildView's by key), or null. It is NEVER the session's
 *  first item: a session works on several, and an ask about one showed the title of another (owner,
 *  twice). In this order:
 *  1. [ref], the item the session NAMED (lib/session-brief.js `ref` on an ask or a wait, one of its
 *     own items): that item, whatever its state. A name that is none of its items today (it was
 *     dropped from a later report) is no subject, never a guess.
 *  1b. A session that has reported nothing yet and was started on ONE item (`bound`): that item.
 *  2. A `you` wait ([wait]): the one item the session reports as `blocked` (two say nothing).
 *  3. [words] (the question and its context, or the wait's text): the open item whose title and
 *     note share at least WORDS_MIN of them, and strictly more than any other item does.
 *  4. None: the card shows its question, and the session's name beneath. */
function subjectFor(n, subjects, { ref = null, words = '', wait = false } = {}) {
  const items = (Array.isArray(n && n.items) ? n.items : []).filter((it) => it && typeof it === 'object');
  const subjectOf = (it) => { const k = mcSubjects.subjectKeyOf(it, n); return (k && subjects.get(k)) || null; };
  if (typeof ref === 'string' && ref) {
    const want = refKey(ref);
    const it = items.find((x) => refKey(x.ref) === want);
    return it ? subjectOf(it) : null;
  }
  // A session started on one item that has not reported yet (lib/mc-binding.js): the person said
  // what it is for, so its one bound item is what its cards are about, named or not.
  if (items.length === 1 && items[0].bound === true) return subjectOf(items[0]);
  const open = items.filter((it) => it.state !== 'done');
  if (wait) {
    const blocked = open.filter((it) => it.state === 'blocked');
    if (blocked.length === 1) return subjectOf(blocked[0]);
  }
  const mine = significantWordsOf(words);
  if (!mine.size) return null;
  let best = null;
  let bestHit = 0;
  let second = 0;
  for (const it of open) {
    const s = subjectOf(it);
    if (!s) continue;
    let hit = 0;
    for (const w of significantWordsOf(`${it.title || ''} ${it.note || ''} ${s.title || ''}`)) if (mine.has(w)) hit += 1;
    if (hit > bestHit) { second = bestHit; best = s; bestHit = hit; } else if (hit > second && s !== best) second = hit;
  }
  return bestHit >= WORDS_MIN && bestHit > second ? best : null;
}

/** The subject fields of a card, for lib/mc-subjects.js's card builders: [key, ref, title]. */
const subjectArgs = (subj) => [subj ? subj.key : null, subj ? subj.ref : null, subj ? subj.title : null];

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
    if (!live(n)) continue;
    cards.push(...askCards(n, subjects, now));
    if (mcSubjects.sessionWaitOn(n, null) !== 'you') continue;
    // #541: the item it is about - the one the wait names, else the blocked one, else the one its
    // words are about, else none. A prompt on screen has no reported wait: its own words only.
    const bare = mcSubjects.needsYouCard(n, null, null, null);
    const reported = bare.kind === 'wait' || bare.kind === 'decision' || bare.kind === 'action';
    const subj = subjectFor(n, subjects, { ref: reported && n.wait && n.wait.on === 'you' ? n.wait.ref : null, wait: true,
      words: [bare.what, bare.decision && bare.decision.question, bare.decision && bare.decision.context].join(' ') });
    const card = mcSubjects.needsYouCard(n, ...subjectArgs(subj));
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
      blocking: true,
      supervisor: mcSubjects.isSupervisor(n),
      hasQuestion: card.kind === 'question',
    });
  }
  return cards;
}

/** What the session is doing while an ask of it stands: the card says it is not held up. */
function carryWords(n) {
  const w = mcSubjects.sessionWaitOn(n, null);
  if (w === 'you') return 'the session also waits on you (its other card)';
  const working = n.reason !== undefined ? Boolean(n.reason && n.reason.kind === 'working') : n.status === 'working';
  if (working) return 'the session is still working';
  if (w === 'self') return 'the session carries on by itself';
  if (w === 'external') return 'the session waits on something else';
  return 'the session is idle';
}

/** #526 - one card per decision a live session holds for the person without stopping for it (its
 *  `asks`: lib/session-brief.js), and one for a question its last reply may have put that is on
 *  no list (`possibleAsk`). Not blocking: `why` blocks nothing, and says what the session is doing
 *  instead; ranked after every wait on the person (compareCards). #541: each card is about the
 *  item ITS ask names (subjectFor), and its project and severity are that item's - an ask about
 *  no item of the session has none (it used to take the worst severity of them all). A decision
 *  the session also reports as its `you` wait is that wait's card, not a second one. */
function askCards(n, subjects, now) {
  const asks = Array.isArray(n.asks) ? n.asks : [];
  const possible = n.possibleAsk || null;
  if (!asks.length && !possible) return [];
  // A decision the session also reports as its `you` wait is that wait's card - when that card is
  // emitted and is the report itself: a working session emits none, and a prompt on screen is the
  // card of the prompt, not of the reported decision. Otherwise the ask stands as its own card.
  const waitCard = mcSubjects.sessionWaitOn(n, null) === 'you' ? mcSubjects.needsYouCard(n, null, null, null) : null;
  const w = waitCard && waitCard.kind !== 'question' && waitCard.kind !== 'permission' && n.wait && n.wait.on === 'you' ? n.wait : null;
  const held = new Set(w ? [w.what, w.decision && w.decision.question].map(askKey).filter(Boolean) : []);
  const base = (build, text, subj) => {
    const card = build(...subjectArgs(subj));
    const ageMin = Number.isFinite(card.askedAt) ? Math.max(0, Math.floor((now - card.askedAt) / MIN)) : null;
    const severity = subj && subj.meta && Number.isFinite(subj.meta.severity) ? subj.meta.severity : null;
    return { ...card, project: subj ? subj.project : null, why: { blocks: 0, blockedSessions: [], subjects: [], severity, ageMin, text },
      rank: null, blocking: false, supervisor: mcSubjects.isSupervisor(n), hasQuestion: false };
  };
  const cards = asks.filter((ask) => !held.has(askKey(ask.question))).map((ask) => base(
    (...args) => mcSubjects.askCard(n, ask, ...args),
    `${ask.maybeAnswered ? 'you wrote to the session after it asked, so this may be answered; ' : ''}${carryWords(n)}: this does not hold it up`,
    subjectFor(n, subjects, { ref: ask.ref, words: `${ask.question} ${ask.context || ''}` })));
  if (possible) {
    cards.push(base((...args) => mcSubjects.possibleAskCard(n, possible, ...args), 'its last reply may ask you something it did not report',
      subjectFor(n, subjects, { words: possible.text })));
  }
  return cards;
}

/** "blocks 3 sessions and 2 work items" - the reason a card ranks where it does. */
function whyText(sessions, items) {
  const s = sessions > 1 ? `blocks ${sessions} sessions` : 'blocks this session';
  if (!items) return s;
  return `${s} and ${items === 1 ? '1 work item' : `${items} work items`}`;
}

/** A card that may not be an open question: an ask a typed prompt may have answered, or a question
 *  only guessed from a reply (#526). It ranks after the open ones of its kind, never before a wait. */
const doubtful = (c) => (c.maybeAnswered || c.kind === 'possible-ask' ? 1 : 0);

/** THE order: blocked sessions, then blocked work items (most first), then severity (1 is
 *  highest; none last), then age (oldest first; unknown last), then id (a stable order).
 *  #526: an ask blocks nothing (`blocks` 0) and every wait on the person blocks at least its
 *  own session, so asks rank after every wait by this rule alone - never a second one. */
function compareCards(a, b) {
  const sa = a.why.severity === null ? Infinity : a.why.severity;
  const sb = b.why.severity === null ? Infinity : b.why.severity;
  const aa = a.why.ageMin === null ? -1 : a.why.ageMin;
  const ab = b.why.ageMin === null ? -1 : b.why.ageMin;
  return (b.why.blocks - a.why.blocks) || (b.why.subjects.length - a.why.subjects.length)
    || (doubtful(a) - doubtful(b)) || (sa - sb) || (ab - aa) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/** GET /api/mc/now: `{answerNow, actions, todo, moving, pending}`. `todos`: the stored
 *  to-dos (lib/mc-state.js); `later`: {cardId: {until}}; `actionsDone`: {cardId: {state, why,
 *  at}} (#522). A card is hidden while a to-do holds it (open or done: the person said they
 *  handle it at the desk) or until its "later" ends; a card whose wait has ended is simply not
 *  pending any more, so it never comes back.
 *  #522: an `action` card (the person must DO something) is never in Answer now: it is in
 *  `actions`, the top of My to-do, ranked by the same order. Its Done hides it once the session
 *  was told; one that may have been told (sending, uncertain) stays, saying so, and is never
 *  told twice; a refused Done keeps it, saying why. */
function buildNow({ nodes, view, todos = [], later = {}, actionsDone = {}, now = Date.now() }) {
  const all = pendingCards({ nodes, view, now });
  const held = new Set(todos.filter(holdsCard).map((t) => t.cardId));
  const shown = all.filter((c) => !held.has(c.id) && !(later[c.id] && later[c.id].until > now)).sort(compareCards);
  const answerNow = shown.filter((c) => c.kind !== 'action');
  answerNow.forEach((c, i) => { c.rank = i + 1; });
  const actions = [];
  for (const c of shown) {
    if (c.kind !== 'action') continue;
    const a = withDone(c, actionsDone);
    // Told: gone (its wait was cleared with the message). Maybe told (sending, uncertain):
    // still shown while the session blocks, saying so, with no Done - never told twice.
    if (a.done && a.done.state === 'delivered') continue;
    actions.push(a);
  }
  actions.forEach((c, i) => { c.rank = i + 1; });
  const todo = todos.filter(holdsCard).sort((a, b) => ((a.state === 'done') - (b.state === 'done')) || (b.createdAt - a.createdAt)).map(publicTodo);
  // Moving on its own: every live session nothing is owed on (a parked one counts once its
  // wait is no longer on the person).
  // An ask owes nothing: the session works around it (#526), so it still counts as moving.
  const owing = new Set(all.filter((c) => c.blocking !== false).map((c) => `${c.server || ''}|${c.sessionId}`));
  let working = 0;
  let idle = 0;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!live(n) || mcSubjects.isSupervisor(n) || owing.has(keyOfRef(n))) continue;
    const w = n.reason !== undefined ? (n.reason && n.reason.kind === 'working') : n.status === 'working';
    if (w) working += 1; else idle += 1;
  }
  return { answerNow, actions, todo, moving: { working, idle, total: working + idle }, pending: all };
}

/** #522 - THE Done message for an action card: one fixed line naming what was done. It goes
 *  through the gated prompt (lib/safe-prompt.js: the supervisor tag, a SYSTEM turn, under 512
 *  bytes), never onto an unsent draft (#479). */
function actionDoneText(card) {
  const s = typeof (card && card.what) === 'string' ? card.what.replace(NOT_ONE_LINE, ' ').replace(/\s+/g, ' ').trim() : '';
  const cps = Array.from(s); // by code point: a cut never splits a surrogate pair
  // 80 code points (a reported `what` is at most 80): 4 bytes each still fits the 512-byte line.
  const what = cps.length > 80 ? `${cps.slice(0, 79).join('')}...` : s;
  return `[Mission Control] Done: ${what || 'what you asked the user to do'}. The user did it; carry on.`;
}

/** The body for POST /api/sessions/:id/prompt: named by the wait's `at`, so a session that
 *  has reported since is refused `stale` rather than told about a wait it no longer has. */
function actionDoneBody(card) {
  const at = card && Number.isInteger(card.askedAt) && card.askedAt > 0 ? card.askedAt : null;
  // clearWait: the Done ENDS that wait on the session's own server (lib/safe-prompt.js), so the
  // owner-wait push, the inbox and the subject's counts stop showing it.
  return { text: actionDoneText(card), tag: 'supervisor', ...(at ? { expectWaitAt: at, clearWait: true } : {}) };
}

/** `{cardId}` -> `{cardId}` or `{error}`. */
function actionDoneInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { error: 'body must be a JSON object' };
  if (typeof b.cardId !== 'string' || !b.cardId || b.cardId.length > 400) return { error: 'cardId must be the id of an action on My to-do' };
  return { cardId: b.cardId };
}

/** What Done may do for [card] (undefined when no longer pending) given its record [rec]
 *  (actionsDone[cardId]): `{send: true}` (record `sending` on disk, then send), `{already: rec}`
 *  (told, or may have been: never sent twice), or `{status, error}`. A card that is not an action is not done here: a question is
 *  answered where it is asked. */
function actionDonePlan(card, rec) {
  // First: a session told (or maybe told) is never told again, even once its wait has ended.
  if (rec && !notSent(rec)) return { already: rec };
  if (!card) return { status: 404, error: 'that action no longer waits on you' };
  if (card.kind !== 'action') return { status: 409, error: 'only an action is marked done here; a question is answered in the inbox' };
  return { send: true };
}

/** The record before the message goes out: never sent twice, even across a crash. */
const actionSending = (now) => ({ state: 'sending', why: null, at: now });

/** The Done message's answer (server.js deliverGatedPrompt's `{delivered}|{uncertain}|{why}`). */
function actionDoneResult(out, now) {
  const state = out && out.delivered ? 'delivered' : out && out.uncertain ? 'uncertain' : 'refused';
  return { state, why: state === 'refused' ? String((out && out.why) || 'refused') : null, at: now };
}

/** A Done record as a card and the route answer carry it. */
function doneOf(rec) {
  const r = rec || {};
  return { state: PARK_STATES.includes(r.state) ? r.state : null, refused: notSent(r) ? r.why || 'refused' : null,
    reason: notSent(r) ? refusalWords(r.why) : null, at: Number.isFinite(r.at) ? r.at : null };
}

/** #522 - an action card with its Done record (`done`, null when never pressed): every screen
 *  that shows an action card (My to-do, a subject) carries it, so they agree on whether Done
 *  is offered. Any other card (or none) is returned as is. Own keys only. */
function withDone(card, actionsDone) {
  if (!card || card.kind !== 'action') return card;
  const rec = actionsDone && Object.hasOwn(actionsDone, card.id) ? actionsDone[card.id] : null;
  return { ...card, done: rec ? doneOf(rec) : null };
}

/** The `done` answer of POST /api/mc/actions/done: the to-do park's answer shape. */
const doneAnswer = (rec, opts) => parkedAnswer({ park: rec }, opts);

/** A to-do is never made of an action: it is on My to-do already, with its own Done. */
function todoRefusal(card) {
  return card && card.kind === 'action' ? { status: 409, error: 'an action is already on My to-do: mark it Done there' } : null;
}

/** The Done records worth keeping: a week, at most TODO_MAX (the oldest go first). */
function pruneActionsDone(rec, now) {
  const keep = Object.entries(rec || {}).filter(([, v]) => v && Number.isFinite(v.at) && now - v.at <= TODO_KEEP_DONE_MS)
    .sort((a, b) => b[1].at - a[1].at).slice(0, TODO_MAX);
  return Object.fromEntries(keep);
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
    park: ON_SCREEN.includes(card.kind) ? { state: 'none', why: 'on-screen', at: now }
      // #526: an ask holds nobody up, so there is no wait to park and nothing to tell the session.
      : card.blocking === false ? { state: 'none', why: 'not-blocking', at: now }
        // #532: the dispatcher runs the supervisor's cases; a "carry on" typed into it is noise.
        : card.supervisor === true ? { state: 'none', why: 'supervisor', at: now }
          : { state: 'sending', why: null, at: now, body: parkBody(card) },
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
  if (p.state === 'none') return { status: 409, error: refusalWords(p.why || 'on-screen') };
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
  parkText, parkBody, refusalWords, pendingCards, subjectFor, compareCards, whyText, buildNow, publicTodo,
  todoInput, newTodo, applyAction, parkResult, parkedAnswer, laterInput, pruneTodos, pruneLater,
  actionDoneText, actionDoneBody, actionDoneInput, actionDonePlan, actionSending, actionDoneResult, doneOf, withDone, doneAnswer,
  todoRefusal, pruneActionsDone,
};
