'use strict';
// #504 - Mission Control: subjects - one work item across every session and machine.
//
// The ONE owner of: which sessions are on a work item (joined on the brief's `globalKey`
// across every server, live sessions and the week's closed ones), what the item waits on,
// which Counts buckets it falls in (the SAME rule feeds /api/mc/projects' counts and each
// subject's `buckets`, so a screen's filter matches the server's number), and which runs
// (an orchestrator whose sessions touch several items) group them. The companion renders
// this answer and never re-derives it (docs/mission-control.md "Subjects").
//
// Pure: the server gathers the rows (its cluster view, every server's closed strip), the
// tracker details and the stored stage history, and passes them in.
const { globalKey, refKey, isUnfiledRef, liveClosed, WAIT_ON, LIMITS, askDigest, askReplyPrefix, clipWords, DECISION_CONTROL_RE } = require('./session-brief');
const { significantWordsOf } = require('./unreported-ask');
const projectsLib = require('./projects');
const mcStage = require('./mc-stage');
const { buildTree } = require('./mc-tree');
// #523 - which line of work each subject is on (the one rule).
const mcLines = require('./mc-lines');

/// A key some tracker can answer for, so it means the same item on every server (one
/// definition, lib/projects.js, which validates a line's listed items against it).
const { TRACKER_KEY_RE } = projectsLib;
/// What a session reason (lib/session-reason.js) says the session is waiting on.
const REASON_WAIT = Object.freeze({ you: 'you', external: 'external', self: 'self', working: 'self', done: 'done' });
/// The order a subject's sessions decide its wait in: anyone asking you wins.
const WAIT_ORDER = Object.freeze(['you', 'external', 'self', 'done']);
const BUCKETS = Object.freeze(['active', 'needsYou', 'waitsOnOthers', 'doneWeek']);

const num = (v) => (Number.isFinite(v) ? v : null);

/** #532 - the supervisor's dispatcher (a row or node with `role: 'supervisor'`, server.js
 *  supervisorRowFields) is the fleet's supervisor, not one of its sessions: the subjects, runs,
 *  project counts and "moving" numbers leave it out, while what it needs from the person (its
 *  `you` wait, its asks) stays an Answer-now card (lib/mc-needs.js). THE one place that reads
 *  the role. */
const isSupervisor = (x) => Boolean(x) && x.role === 'supervisor';
const str = (v) => (typeof v === 'string' && v ? v : null);

/** #526 - the asks a row's brief carries (lib/session-brief.js buildBrief), re-checked: a
 *  peer's row is data. An ask without a question or without its 2-4 options is not an ask, and a
 *  row of a peer too old to send any carries none. */
function asksOf(raw) {
  const out = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (out.length >= LIMITS.asks) break;
    const question = a && typeof a === 'object' && str(a.question) ? clipWords(a.question, LIMITS.decisionQuestion) : '';
    const opts = question && Array.isArray(a.options) ? a.options.filter((o) => o && typeof o === 'object' && str(o.label)) : [];
    // The reply prefix built from the question is TYPED into the session: a control character in
    // any of the ask's words (the same rule the session's own server applied) refuses the ask.
    const words = [a && a.question, a && a.context, ...opts.flatMap((o) => [o.label, o.consequence])];
    if (words.some((x) => typeof x === 'string' && DECISION_CONTROL_RE.test(x))) continue;
    const options = opts.slice(0, 4).map((o) => ({ label: clipWords(o.label, LIMITS.decisionLabel),
      ...(str(o.consequence) ? { consequence: clipWords(o.consequence, LIMITS.decisionConsequence) } : {}) })).filter((o) => o.label);
    if (!question || options.length < 2) continue;
    out.push({ question, context: (str(a.context) || '').slice(0, LIMITS.decisionContext), options,
      ...(Number.isInteger(a.recommended) ? { recommended: a.recommended } : {}),
      // #541 - the item it is about, as the session reported it (lib/mc-needs.js subjectFor matches it).
      ...(str(a.ref) ? { ref: a.ref.slice(0, LIMITS.ref) } : {}), at: num(a.at), maybeAnswered: a.maybeAnswered === true });
  }
  return out;
}

/** #526 - the question a session's last reply may have put (lib/session-brief.js possibleAsk). */
function possibleAskOf(raw) {
  const text = raw && typeof raw === 'object' ? str(raw.text) : null;
  return text ? { text, at: num(raw.at) } : null;
}

/** The cluster's sessions as tree/subject nodes: every live row, then every closed record
 *  (the week's, `liveClosed`) not also live. `rows`: the cluster view's sessions, each with
 *  `origin` set where the server could read it (its own sessions). `closed`: [{server,
 *  serverUrl, rec, origin}]. A session listed twice (two urls for one box) counts once. */
function sessionNodes({ rows, closed, now }) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
    seen.add(r.id);
    const b = r.brief || {};
    const sp = r.spawn || {};
    out.push({
      id: r.id, server: str(r.server), serverUrl: str(r.serverUrl), name: str(r.name), status: str(r.status) || 'unknown',
      role: isSupervisor(r) ? 'supervisor' : null,
      closed: false, closedAt: null, cwd: str(r.cwd), origin: r.origin || null,
      items: Array.isArray(b.items) ? b.items : [], headline: str(b.headline), line: str(b.line), reportAt: num(b.reportAt),
      wait: b.wait && typeof b.wait === 'object' ? b.wait : null, asks: asksOf(b.asks), possibleAsk: possibleAskOf(b.possibleAsk), turnAt: num(b.turnAt),
      // #547 - the last prompt a person TYPED into it (the brief's `prompt`: system turns are no prompt), for "answered elsewhere".
      promptAt: num(b.prompt && b.prompt.at), promptText: str(b.prompt && b.prompt.text),
      // `undefined` = a peer too old to publish a reason (decided from status and wait instead).
      reason: r.reason === undefined ? undefined : r.reason, waitingFor: str(r.waitingFor),
      parentId: str(sp.parentId), replaces: Array.isArray(sp.replaces) ? sp.replaces.filter((x) => typeof x === 'string') : [],
      createdAt: num(sp.createdAt), lastActivity: num(r.lastActivity),
      // #561 - the check-in word the row publishes (lib/check-in.js checkInField), which the efforts view reads as a verdict.
      checkIn: r.checkIn && typeof r.checkIn === 'object' && typeof r.checkIn.state === 'string'
        ? { state: r.checkIn.state.slice(0, 20), sentAt: num(r.checkIn.sentAt), idleMin: num(r.checkIn.idleMin), answeredAt: num(r.checkIn.answeredAt) } : null,
    });
  }
  for (const c of Array.isArray(closed) ? closed : []) {
    const rec = c && c.rec;
    if (!rec || typeof rec.id !== 'string' || seen.has(rec.id)) continue;
    if (!liveClosed([rec], now).length) continue;
    seen.add(rec.id);
    const sp = rec.spawn || {};
    out.push({
      id: rec.id, server: str(c.server), serverUrl: str(c.serverUrl), name: str(rec.name), status: 'closed', role: null,
      closed: true, closedAt: num(rec.at), cwd: str(rec.cwd), origin: c.origin || null,
      items: Array.isArray(rec.items) ? rec.items : [], headline: str(rec.headline), line: str(rec.line), reportAt: null,
      wait: null, asks: [], possibleAsk: null, turnAt: null, promptAt: null, promptText: null, reason: null, waitingFor: null,
      parentId: str(sp.parentId), replaces: Array.isArray(sp.replaces) ? sp.replaces.filter((x) => typeof x === 'string') : [],
      createdAt: num(sp.createdAt), lastActivity: num(rec.at), checkIn: null,
    });
  }
  return out;
}

/** The subject key of one reported item. A tracker key joins across every server; anything
 *  else (a bare `#12` from a cwd with no GitHub origin, a free-text ref) names nothing the
 *  other sessions could share, so it stays a subject of that session alone: `<key>@<id>`. */
function subjectKeyOf(item, node) {
  if (!item) return null;
  const k = str(item.key) || globalKey(item.ref, null);
  // #548 - number 0 is no work item (a placeholder an agent reported before it filed its issue):
  // never a subject, whatever an older server still publishes.
  if (!k || isUnfiledRef(item.ref) || isUnfiledRef(k)) return null;
  return TRACKER_KEY_RE.test(k) ? k : `${k}@${node.id}`;
}

/** Every key a tracker can be asked about (for the tracker-details batch). */
function trackerKeys(nodes) {
  const out = new Set();
  for (const n of nodes) for (const it of n.items) { const k = subjectKeyOf(it, n); if (k && TRACKER_KEY_RE.test(k)) out.add(k); }
  return [...out];
}

/** What one session's work on one item waits on: `you`, `external`, `self`, `done` or null.
 *  An item it reported done is done; a closed session waits on nothing else; a live one
 *  says through its reason (the server's one answer to "why is it not working"). */
function sessionWaitOn(node, item) {
  if (item && item.state === 'done') return 'done';
  if (node.closed) return null;
  if (node.reason !== undefined) return node.reason && REASON_WAIT[node.reason.kind] ? REASON_WAIT[node.reason.kind] : null;
  if (node.status === 'waiting') return 'you';
  if (node.status === 'working') return 'self';
  return node.wait && WAIT_ON.includes(node.wait.on) ? node.wait.on : null;
}

/** THE bucket rule: the Counts keys a subject is counted under. Done this week (the work
 *  item is closed in its tracker, or every session on it that says anything says done) or
 *  else active; and, independently, needs you / waits on others. */
function bucketsOf({ waitsOn, meta }) {
  const done = (meta && meta.closed === true) || waitsOn === 'done';
  const out = [done ? 'doneWeek' : 'active'];
  if (waitsOn === 'you') out.push('needsYou');
  if (waitsOn === 'external') out.push('waitsOnOthers');
  return out;
}

/** The card for a session asking you something (the one card shape: a subject's `needsYou`
 *  and #506's Answer now, lib/mc-needs.js, which adds its rank and why). Its id names the
 *  wait itself, `<server>|<session>|<kind>:<at>`, so a later wait of the same session is a
 *  new card, and a to-do or a "later" made for this one never hides that one. A reported
 *  wait (kind wait, decision) is named by its `at`, which the agent's next report changes.
 *  A question or a permission prompt carries no time of its own: it is named by when it came
 *  up, `node.promptSince` (lib/mc-episodes.js, which the server runs over every view's nodes:
 *  one id while the prompt stays up, a new one for the next prompt), and that is its age.
 *  Without it (a caller that tracks no episodes) the turn and the last activity name it. */
const promptName = (node) => (num(node.promptSince) ? String(node.promptSince) : `${node.turnAt || 0}.${num(node.lastActivity) || 0}`);
function needsYouCard(node, key, ref, title) {
  const r = node.reason || null;
  const w = node.wait || null;
  // #522: a reported wait the person must DO (lib/session-brief.js _validateAction) is an
  // `action`, never phrased as a question; a prompt on screen still outranks it.
  const kind = node.waitingFor === 'question' ? 'question' : node.waitingFor === 'permission' ? 'permission'
    : (w && w.on === 'you' && w.decision ? 'decision' : w && w.on === 'you' && w.kind === 'action' ? 'action' : 'wait');
  const onScreen = kind === 'question' || kind === 'permission';
  const waitAt = onScreen ? null : (r && num(r.since)) || (w && num(w.at)) || null;
  return {
    id: `${node.server || ''}|${node.id}|${kind}:${onScreen ? promptName(node) : waitAt || 0}`, kind,
    server: node.server, serverUrl: node.serverUrl,
    sessionId: node.id, sessionName: node.name, subjectKey: key, ref, title,
    what: (r && str(r.text)) || (w && str(w.what)) || '',
    askedAt: onScreen ? num(node.promptSince) || num(node.lastActivity) : waitAt,
    // #492's decision as the agent reported it (validated there), for a card that answers it.
    decision: kind === 'decision' ? w.decision : null,
    // #522's steps and where, as the agent reported them (validated there).
    action: kind === 'action' ? actionOf(w) : null,
  };
}

/** The one work item of [node] that a card of its is about, when the session alone says so (#541,
 *  #548): the item [ref] names (any spelling; null when the session reports none such), or, with no
 *  [ref], the only REAL item it holds (never `#0`). The ONE rule lib/mc-needs.js subjectFor and
 *  [waitItemKey] share. */
function itemOf(node, ref = null) {
  const items = (Array.isArray(node && node.items) ? node.items : []).filter((it) => it && typeof it === 'object');
  if (typeof ref === 'string' && ref) {
    const want = refKey(ref);
    return items.find((x) => refKey(x.ref) === want) || null;
  }
  const real = items.filter((it) => subjectKeyOf(it, node));
  return real.length === 1 ? real[0] : null;
}

/** The subject key of the item [node]'s reported wait is about by [itemOf], or null. Decided from the
 *  node and its wait alone, never from the card or the screen showing it, so Answer now and a
 *  subject's needsYou mark the same wait the same way. A wait that only the blocked-item or the
 *  shared-words step of subjectFor resolves has no item here: only its descendants can answer it
 *  (fewer marks, never one that depends on the screen). */
function waitItemKey(node) {
  const it = itemOf(node, node && node.wait && node.wait.on === 'you' ? node.wait.ref : null);
  return it ? subjectKeyOf(it, node) : null;
}

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
 *  1b. #548: a session that holds exactly ONE real item (a `#0` placeholder is none: it names no
 *     item, lib/session-brief.js isUnfiledRef), in any state - a session started on one item
 *     that has not reported yet is the same case: that item, named or not. It has nothing else
 *     to be asking about. Two or more real items and nothing below matching: still none.
 *  2. A `you` wait ([wait]): the one item the session reports as `blocked` (two say nothing).
 *  3. [words] (the question and its context, or the wait's text): the open item whose title and
 *     note share at least WORDS_MIN of them, and strictly more than any other item does.
 *  4. None: the card shows its question, and the session's name beneath. */
function subjectFor(n, subjects, { ref = null, words = '', wait = false } = {}) {
  const items = (Array.isArray(n && n.items) ? n.items : []).filter((it) => it && typeof it === 'object');
  const subjectOf = (it) => { const k = subjectKeyOf(it, n); return (k && subjects.get(k)) || null; };
  // The item the card names, else the session's one real item (also a session started on one item
  // that has not reported yet, lib/mc-binding.js; never `#0`): itemOf, which the answered-elsewhere
  // mark reads too. A ref naming nothing the session reports is no subject.
  const named = typeof ref === 'string' && ref;
  const only = itemOf(n, named ? ref : null);
  if (only || named) return only ? subjectOf(only) : null;
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

/** #546 - the subject (a record of [subjects], by key) the `you` wait of session [n] is about by
 *  [subjectFor], or null: the item its report names, else the one it reports blocked, else the one
 *  its words are about. Decided from the node alone, so Answer now (lib/mc-needs.js pendingCards)
 *  and the subjects ([buildView]) put the same wait on the same item. A prompt on screen has no
 *  reported wait: its own words only. */
function waitSubjectFor(n, subjects) {
  const bare = needsYouCard(n, null, null, null);
  const reported = bare.kind === 'wait' || bare.kind === 'decision' || bare.kind === 'action';
  return subjectFor(n, subjects, { ref: reported && n.wait && n.wait.on === 'you' ? n.wait.ref : null, wait: true,
    words: [bare.what, bare.decision && bare.decision.question, bare.decision && bare.decision.context].join(' ') });
}

/** #547 - a reported wait (or decision) that someone answered in ANOTHER session: the person
 *  typed a prompt, after the wait was reported, into a session below the waiting one (its child,
 *  at any depth) or into another live session on the wait's work item ([waitItemKey]). Only a
 *  session that already EXISTED when the wait was reported counts: a prompt that starts or
 *  hands off a session (the orchestrator's launch line, a successor's `continue`) is untagged
 *  like a typed one but nobody answered anything by it. The wait's own session
 *  was never told (a typed prompt clears only the wait of the session it is typed into), so its
 *  card stays in Answer now. Returns the newest such session as the card carries it
 *  (`answeredIn`), or null. A guess, like #526's maybe-answered: the prompt may have been about
 *  something else, so the card is only MARKED (and ranks after its peers), never hidden. Only a
 *  reported wait is marked: a question or a permission prompt is on the waiting session's own
 *  screen and stays there until it is answered there; an action is something to DO. */
function answeredElsewhere(card, node, { tree, nodes }) {
  if (!card || (card.kind !== 'wait' && card.kind !== 'decision') || !Number.isFinite(card.askedAt)) return null;
  if (isSupervisor(node)) return null; // the dispatcher is told nothing (#532)
  const pool = new Set(tree.descendantsOf(node));
  const key = waitItemKey(node);
  if (key) for (const o of nodes) if (o.items.some((it) => subjectKeyOf(it, o) === key)) pool.add(o);
  let best = null;
  // A closed record has no `promptAt` (sessionNodes), so it never counts.
  for (const o of pool) {
    if (o === node || isSupervisor(o) || !Number.isFinite(o.promptAt) || o.promptAt <= card.askedAt) continue;
    if (!Number.isFinite(o.createdAt) || o.createdAt >= card.askedAt) continue;
    if (!best || o.promptAt > best.at) best = { server: o.server, serverUrl: o.serverUrl, sessionId: o.id, name: o.name, at: o.promptAt };
  }
  return best;
}

/** [card] with #547's mark when its wait was answered elsewhere ([answeredElsewhere]). */
function markAnsweredElsewhere(card, node, ctx) {
  const a = answeredElsewhere(card, node, ctx);
  return a ? { ...card, maybeAnswered: true, answeredIn: a } : card;
}

/** An action wait's `{steps, where}` for its card: only well-formed strings pass. */
function actionOf(w) {
  const steps = Array.isArray(w.steps) ? w.steps.filter((s) => typeof s === 'string' && s) : [];
  return { steps, where: str(w.where) || null };
}

/** #526 - the card for one decision the session holds for the person WITHOUT stopping for it
 *  (an ask: lib/session-brief.js). Same shape as [needsYouCard]; kind `ask`; its decision is the
 *  whole ask. Its id names the ask: when it was first asked and the digest of its question, so a
 *  re-report of an ask that still stands is the same card (a to-do or a "later" made for it
 *  holds) while another decision of the same session is another card. `replyPrefix` is what an
 *  answer typed from the card begins with, so the session (and the server) can tell WHICH
 *  decision it answers; the app only prepends it. */
function askCard(node, ask, key, ref, title) {
  const digest = askDigest(ask.question);
  return {
    id: `${node.server || ''}|${node.id}|ask:${ask.at || 0}.${digest}`, kind: 'ask',
    server: node.server, serverUrl: node.serverUrl,
    sessionId: node.id, sessionName: node.name, subjectKey: key, ref, title,
    what: ask.question, askedAt: ask.at, askId: digest, replyPrefix: askReplyPrefix(ask), maybeAnswered: Boolean(ask.maybeAnswered),
    decision: { question: ask.question, ...(ask.context ? { context: ask.context } : {}), options: ask.options,
      ...(ask.recommended !== undefined ? { recommended: ask.recommended } : {}) },
  };
}

/** #526 - the card for a question a session's last reply may have put to the person that is on none
 *  of its lists (lib/session-brief.js possibleAsk): kind `possible-ask`, quoting the sentence. A
 *  guess, so it carries no decision and no reply prefix: the person answers it in their own words. */
function possibleAskCard(node, possible, key, ref, title) {
  return {
    id: `${node.server || ''}|${node.id}|possible:${possible.at || 0}`, kind: 'possible-ask',
    server: node.server, serverUrl: node.serverUrl,
    sessionId: node.id, sessionName: node.name, subjectKey: key, ref, title,
    what: possible.text, askedAt: possible.at, askId: null, replyPrefix: null, maybeAnswered: false, decision: null,
  };
}

/** {subjects, runs, waits}. `waits` (#546): the `you` waits that name no item of their session ([waitSubjectFor]), each `{card, subjects}` - the card, and the keys of the items it covers. `metaByKey`: tracker details by key (lib/tracker-meta.js; parents'
 *  too, for #523's parent rule); `projects`: the validated config; `stageStore`:
 *  {stageHistory(key), setStageHistory(key, h, {changed})} (lib/mc-state.js), optional;
 *  `lineOverrides`: the person's Move-to-line choices by key (lib/mc-state.js), optional.
 *  Subjects newest first; runs newest first. */
function buildView({ nodes: allNodes, metaByKey = {}, projects = [], stageStore = null, lineOverrides = {}, now = Date.now(), platform = process.platform }) {
  // #532 - the dispatcher is no session of any subject or run (its cards are lib/mc-needs.js's).
  const nodes = (Array.isArray(allNodes) ? allNodes : []).filter((n) => !isSupervisor(n));
  const tree = buildTree(nodes);
  const projectOfNode = (n) => projectsLib.projectOfSession({ cwd: n.cwd, origin: n.origin, items: n.items, bound: n.boundProject }, projects, { platform });
  const subj = new Map(); // key -> working record
  const nodesOfKey = new Map(); // key -> its sessions' nodes, newest report first
  const keysOfNode = new Map();
  for (const n of nodes) {
    const keys = [];
    for (const it of n.items) {
      const key = subjectKeyOf(it, n);
      if (!key) continue;
      if (!keys.includes(key)) keys.push(key);
      let s = subj.get(key);
      if (!s) { s = { key, refs: [], sessions: [] }; subj.set(key, s); }
      // #512 - a session bound at birth that has not reported yet is on the subject since it began.
      const at = n.closed ? n.closedAt : (n.reportAt || (it.bound ? num(it.boundAt) : null));
      const p = tree.parentOf(n);
      s.sessions.push({
        node: n, item: it, at, waitOn: sessionWaitOn(n, it),
        ref: {
          server: n.server, serverUrl: n.serverUrl, id: n.id, name: n.name,
          parentId: p ? p.id : n.parentId, status: n.status, closed: n.closed, closedAt: n.closedAt, bound: it.bound === true,
          lastReport: { state: str(it.state), stage: mcStage.stageIndex(it.stage) >= 0 ? it.stage : null, note: str(it.note), headline: n.headline, at },
          wait: n.wait && n.wait.on ? { on: n.wait.on, what: str(n.wait.what) } : null,
        },
      });
    }
    keysOfNode.set(n, keys);
  }

  const subjects = [];
  for (const s of subj.values()) {
    // Newest report first: it names the ref and title an agent last used.
    s.sessions.sort((a, b) => (b.at || 0) - (a.at || 0));
    const latest = s.sessions[0];
    const meta = TRACKER_KEY_RE.test(s.key) ? metaByKey[s.key] || null : null;
    const reportedTitle = (s.sessions.find((x) => str(x.item.title)) || {}).item;
    const title = (meta && str(meta.title)) || (reportedTitle && reportedTitle.title) || latest.item.ref || s.key;
    const sessionProjects = s.sessions.map((x) => projectOfNode(x.node));
    const project = projectsLib.projectOfSubject({ key: s.key, meta, sessionProjects }, projects);
    const pcfg = projects.find((p) => p.id === project);
    const area = projectsLib.areaOf(pcfg, { meta, cwd: latest.node.cwd }, { platform });

    // Every session's current stage counts toward the history (newest first names `reported`),
    // so an older session's further stage is not lost because a newer one reported less.
    const reports = s.sessions.filter((x) => mcStage.stageIndex(x.item.stage) >= 0)
      .map((x) => ({ stage: x.item.stage, at: x.at, detail: `reported by ${x.node.name || 'a session'}` }));
    const fold = mcStage.foldStage({ history: stageStore ? stageStore.stageHistory(s.key) : [], reports, meta, now });
    if (stageStore && (fold.history.length || fold.changed)) stageStore.setStageHistory(s.key, fold.history, { changed: fold.changed });

    const updatedAt = Math.max(0, ...s.sessions.map((x) => x.at || 0)) || null;
    // What it waits on is set below, once every subject is known: where a session's wait lands
    // is read off the subjects' titles (#546).
    subjects.push({
      key: s.key, ref: latest.item.ref || s.key, url: (meta && str(meta.url)) || str(latest.item.url),
      title, project, area, meta, stage: fold.stage,
      sessions: s.sessions.map((x) => x.ref),
      needsYou: null, waitsOn: null, buckets: [], runId: null, updatedAt,
    });
    nodesOfKey.set(s.key, s.sessions.map((x) => x.node));
  }

  // #546 - a session's wait on you is ONE fact: on the item it is about (waitSubjectFor: its `ref`,
  // the one item it reports blocked, the item its words are about, or its only item), else on no
  // item - shown once for the work it covers (`waits`) and counted once, never on each item
  // (owner: five items of one session all said "waits on you: OK for one verify-ci re-run"). Each
  // item keeps only its own stage. An item the session reported done stays done and is never the
  // place of a wait: the wait lands where it showed before, on the items that were waiting.
  const byKey = new Map(subjects.map((x) => [x.key, x]));
  const waiting = new Map(); // node -> the subjects whose item its `you` wait showed on
  for (const s of subj.values()) {
    for (const x of s.sessions) if (x.waitOn === 'you' && !(waiting.get(x.node) || []).includes(s.key)) waiting.set(x.node, [...(waiting.get(x.node) || []), s.key]);
  }
  const placed = new Map(); // node -> the subject key its wait is on, or null
  const about = new Map(); // node -> the subject Answer now says its wait is about (waitSubjectFor), or null
  for (const [n, keys] of waiting) {
    const at = waitSubjectFor(n, byKey);
    about.set(n, at);
    placed.set(n, at && keys.includes(at.key) ? at.key : null);
  }
  for (const s of subj.values()) {
    for (const x of s.sessions) if (x.waitOn === 'you' && placed.get(x.node) !== s.key) x.waitOn = null;
    const out = byKey.get(s.key);
    let waitsOn = null;
    for (const w of WAIT_ORDER) if (s.sessions.some((x) => x.waitOn === w)) { waitsOn = w; break; }
    const asker = waitsOn === 'you' ? s.sessions.find((x) => x.waitOn === 'you') : null;
    out.waitsOn = waitsOn;
    out.buckets = bucketsOf({ waitsOn, meta: out.meta });
    out.needsYou = asker ? markAnsweredElsewhere(needsYouCard(asker.node, s.key, out.ref, out.title), asker.node, { tree, nodes }) : null;
  }
  const waits = [];
  for (const [n, keys] of waiting) {
    if (placed.get(n) !== null) continue;
    // The card is the one Answer now shows: it names its item (subjectKey) when the wait names one the
    // session reported done, which is no place for it (the item stays done), else it names none.
    const at = about.get(n);
    waits.push({ card: markAnsweredElsewhere(at ? needsYouCard(n, at.key, at.ref, at.title) : needsYouCard(n, null, null, null), n, { tree, nodes }), subjects: keys });
  }

  // Runs: a session whose descendants (any depth, any server, closed ones too) report two or
  // more distinct subjects. Only the top of a tree: a sub-orchestrator is part of its run.
  const runs = [];
  const byId = new Map();
  for (const n of nodes) { if (!byId.has(n.id)) byId.set(n.id, []); byId.get(n.id).push(n); }
  for (const root of tree.roots()) {
    const desc = tree.descendantsOf(root);
    const descKeys = new Set();
    for (const d of desc) for (const k of keysOfNode.get(d) || []) descKeys.add(k);
    if (descKeys.size < 2) continue;
    // The sessions it was handed off from carry the same run (their own items included).
    const preds = (root.replaces || []).flatMap((id) => (byId.get(id) || []).filter((n) => n !== root));
    const keys = [];
    for (const n of [root, ...preds, ...desc]) for (const k of keysOfNode.get(n) || []) if (!keys.includes(k)) keys.push(k);
    runs.push({
      id: root.id, server: root.server, sessionId: root.id, name: root.name,
      startedAt: root.createdAt, status: root.status, subjects: keys,
      children: desc.map((d) => ({ server: d.server, id: d.id, name: d.name, status: d.status })),
      _at: root.createdAt || root.lastActivity || 0,
    });
  }
  runs.sort((a, b) => b._at - a._at);
  for (const r of runs) for (const k of r.subjects) { const x = byKey.get(k); if (x && !x.runId) x.runId = r.id; }
  for (const r of runs) delete r._at;
  // #523 - each subject's line of work (after the runs: a run can name it).
  const runById = new Map(runs.map((r) => [r.id, r]));
  const overrides = lineOverrides && typeof lineOverrides === 'object' ? lineOverrides : {};
  for (const x of subjects) {
    x.line = mcLines.lineOfSubject({ subject: x, sessions: nodesOfKey.get(x.key) || [], tree, run: x.runId ? runById.get(x.runId) : null,
      projects, metaByKey, override: Object.prototype.hasOwnProperty.call(overrides, x.key) ? overrides[x.key] : undefined, projectOfNode });
  }
  subjects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { subjects, runs, waits };
}

/** `?project=&area=`: a project id, and an area id or name. `projectsView` (lib/projects.js's
 *  answer for the same subjects) names the ids, so a filter takes exactly the id /api/mc/projects
 *  handed out (a suffixed one after an id collision too); without it the id is `areaId(name)`. */
function filterView({ subjects, runs, waits }, { project, area, line } = {}, { projectsView } = {}) {
  const wantArea = typeof area === 'string' && area ? area.toLowerCase() : null;
  const idOf = (s) => {
    const p = Array.isArray(projectsView) ? projectsView.find((x) => x.id === s.project) : null;
    const a = p && p.areas.find((x) => x.name === s.area);
    return a ? a.id : projectsLib.areaId(s.area);
  };
  // An id wins: a name (no case) is matched only when no subject's area has that id.
  const byId = wantArea && subjects.some((s) => idOf(s) === wantArea);
  const areaOk = (s) => !wantArea || (byId ? idOf(s) === wantArea : String(s.area).toLowerCase() === wantArea);
  // #523 - `?line=` takes a line id as /api/mc/lines hands it out.
  const keep = subjects.filter((s) => (!project || s.project === project) && areaOk(s) && (!line || (s.line && s.line.id === line)));
  const keys = new Set(keep.map((s) => s.key));
  return { subjects: keep, runs: runs.filter((r) => r.subjects.some((k) => keys.has(k))),
    // #546 - the waits of the work kept (a wait covering other work too is shown wherever any of it is).
    waits: (Array.isArray(waits) ? waits : []).filter((w) => w.subjects.some((k) => keys.has(k)))
      .map((w) => ({ ...w, subjects: w.subjects.filter((k) => keys.has(k)) })) };
}

module.exports = {
  BUCKETS, WAIT_ORDER, TRACKER_KEY_RE,
  sessionNodes, isSupervisor, subjectKeyOf, trackerKeys, sessionWaitOn, bucketsOf, needsYouCard, itemOf, subjectFor, waitSubjectFor, waitItemKey, answeredElsewhere, markAnsweredElsewhere, askCard, possibleAskCard, buildView, filterView,
};
