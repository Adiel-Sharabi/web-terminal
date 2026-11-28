'use strict';
// #561 - Mission Control: the home is what RUNS. One EFFORT per lead session tree (a lead and
// every session it started, any machine, recently closed ones included), and below them the work
// items nobody is running ("Not running"), grouped by line.
//
// What this module owns and what it only reads:
//  - the tree is lib/mc-tree.js (THE rule: `parentId` across servers, a hand-off through
//    `replaces`); the items, their stage and station are lib/mc-subjects.js buildView's subjects
//    (lib/mc-stage.js); the cards a person owes an answer are lib/mc-needs.js pendingCards (the
//    same ids Answer now shows). None of them is derived again here.
//  - a wait's VALIDITY is the supervisor's, never MC's (#465 R1/R3, check-in #443/#456): a
//    verdict is READ from the supervisor's state (lib/supervisor.js stateOf: `waitState`,
//    `orphan`, the open `cases`) and from the published check-in word (lib/check-in.js outcome,
//    the session row's `checkIn.state`). Nothing below decides whether a wait still stands.
//    Supervisor off -> every verdict is null.
//  - the one rule that is MC's own: `idleClassOf`, how a work item nobody runs is sorted.
// Fail CLOSED (#562): a server that did not answer makes the view `complete: false`; a lead that
// may live there is marked `partial` and never called gone. A verdict that rests on a session's
// absence is the supervisor's own: it judges an id's absence from the server the id was last seen
// on, so it says unknown itself where that server did not answer, and a peer down for days blinds
// nothing else. Pure: no I/O. docs/mission-control.md "Efforts (#561)".
const { buildTree } = require('./mc-tree');
const { isSupervisor, subjectKeyOf } = require('./mc-subjects');
const { stageIndex } = require('./mc-stage');
const { CASE_TITLES } = require('./supervisor-cases');

const STATES = Object.freeze(['needs-you', 'stuck', 'moving', 'waiting']);
/// A not-running item's class, in the order a group lists them (owner, 2026-11-26: waits for
/// test/review, not started, stranded, finished).
const IDLE_CLASSES = Object.freeze(['waits-test', 'not-started', 'stranded', 'finished']);
/// The ADO stations that say the work is done / is with testers or reviewers (lib/mc-stage.js
/// stationOf: the workflow state as ADO names it).
const FINISHED_STATIONS = Object.freeze(['done']);
const WAITS_TEST_STATIONS = Object.freeze(['ready for test', 'committed', 'merged']);
const STRANDED_STATIONS = Object.freeze(['in progress']);
/// The supervisor's cases that read as a verdict on a session (R4 is "reach the owner": that is
/// a needs-you card, not a stuck session).
const CASE_RULES = Object.freeze(['R2', 'R3', 'R6', 'R7', 'R9']);
/// The check-in outcomes (lib/check-in.js outcome) that say nothing is going to move by itself.
const CHECKIN_STUCK = Object.freeze({
  stuck: 'asked, it still reports nothing running',
  lost: 'its check-in never reached it',
  interrupted: 'its check-in was interrupted',
});
const ITEMS_MAX = 60;
const TEXT_MAX = 160;

const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Oldest first; a missing time sorts last. */
const oldestFirst = (a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0) || (a || 0) - (b || 0);

/** Whether a card is a real debt to the person. A card that is only a guess (a question the last reply
 *  may have put, a wait that may have been answered elsewhere) is listed on the effort but does not turn
 *  it into "needs you". THE one rule: the work board (lib/mc-board.js, #567) badges a card "on you" by it. */
const owesAnswer = (c) => Boolean(c) && c.kind !== 'possible-ask' && !c.maybeAnswered;

/** A work item nobody runs, sorted into ONE class (the rule `idle` and the companion share):
 *  - finished   the tracker closed it, its station is Done, its stage is tested, or every session on
 *               it said done (done this week) with no pull request still open;
 *  - waits-test its station is Ready for test / Committed / Merged, or its stage is pr-open or
 *               later (the code is with a reviewer or a tester); the station outranks a session's
 *               own "done";
 *  - stranded   its station is In Progress, or its stage is triage..fixing, or a session reported
 *               on it: someone began and nobody is on it now;
 *  - not-started anything else: no stage and no session ever beyond a start binding.
 *  `subject`: one record of lib/mc-subjects.js buildView's `subjects`. */
function idleClassOf(subject) {
  const s = subject || {};
  const stage = s.stage || {};
  const station = typeof stage.station === 'string' ? stage.station.trim().toLowerCase() : '';
  const idx = stageIndex(stage.current);
  const doneWeek = Array.isArray(s.buckets) && s.buckets.includes('doneWeek');
  // The tracker's own word first: closed, Done or tested is finished; Ready for test / Committed / Merged
  // waits for a tester however a session worded its last report.
  if ((s.meta && s.meta.closed === true) || FINISHED_STATIONS.includes(station) || stage.current === 'tested') return 'finished';
  if (WAITS_TEST_STATIONS.includes(station)) return 'waits-test';
  // Every session on it said done, the tracker still open: finished, unless a pull request is still open for review.
  if (doneWeek) return idx === stageIndex('pr-open') || idx === stageIndex('in-review') ? 'waits-test' : 'finished';
  if (idx >= stageIndex('pr-open')) return 'waits-test';
  if (STRANDED_STATIONS.includes(station) || idx >= 0) return 'stranded';
  const touched = (Array.isArray(s.sessions) ? s.sessions : []).some((x) => x && (x.bound !== true || (x.lastReport && (x.lastReport.state || x.lastReport.note))));
  return touched ? 'stranded' : 'not-started';
}

/** `{kind, rule, text, at}`: [kind] legit | suspect | unknown, [rule] which of the supervisor's
 *  rules (or `check-in`) said it. `text` is one line, a person's words. */
const verdict = (kind, rule, text, at) => ({ kind, rule, text: oneLine(text), at: num(at) });

/** A supervisor row's `waitState` judged the wait the row held at ITS last scan. It stands for the node
 *  only while that is still the node's wait (same `at`): the scan runs every minute and the view every
 *  few seconds, so a session that has since resumed (no wait) or re-reported (a new `at`) is never
 *  judged by an answer about the wait before. */
const sameWait = (n, row) => Boolean(n.wait && row.wait && num(n.wait.at) === num(row.wait.at));

/** Every live session's verdict, read from the supervisor's state ([supervisor]: lib/supervisor.js
 *  stateOf's answer, `{enabled, complete, sessions: [{id, wait, orphan, waitState}], cases}`) and the
 *  check-in word on the node. Map id -> Verdict (a session with nothing to say has none).
 *  Supervisor absent or off: an empty map. A verdict that rests on a session's ABSENCE (R1 `gone`,
 *  R2 `orphan`, an open R2 case) is read as the supervisor states it (#562): it judges an id's
 *  absence from the server that id was last seen on (lib/supervisor.js absenceStep) and answers
 *  unknown where that server did not answer, so one peer down for days does not blind the rest.
 *  The cluster-wide `complete` is not re-applied here: that would second-guess the supervisor. */
function verdictsOf(nodes, supervisor) {
  const out = new Map();
  if (!supervisor || supervisor.enabled === false) return out;
  const rows = new Map((Array.isArray(supervisor.sessions) ? supervisor.sessions : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  const open = new Map();
  for (const c of Array.isArray(supervisor.cases) ? supervisor.cases : []) {
    if (!c || c.resolvedAt || !CASE_RULES.includes(c.rule) || typeof c.sessionId !== 'string') continue;
    if (!open.has(c.sessionId)) open.set(c.sessionId, []);
    open.get(c.sessionId).push(c);
  }
  const rank = { suspect: 0, legit: 1, unknown: 2 };
  for (const n of nodes) {
    if (n.closed) continue;
    const found = [];
    const row = rows.get(n.id) || null;
    const ws = row && row.waitState && typeof row.waitState.state === 'string' && sameWait(n, row) ? row.waitState : null;
    const waitText = (n.wait && str(n.wait.what)) || 'its wait';
    if (ws) {
      if (ws.state === 'resolved') found.push(verdict('suspect', 'R1', ws.fact || `${waitText}: what it waits on has happened`, n.wait && n.wait.at));
      else if (ws.state === 'gone') found.push(verdict('suspect', 'R1', ws.fact || `${waitText}: what it waits on is gone`, n.wait && n.wait.at));
      else if (ws.state === 'pending') found.push(verdict('legit', 'R1', waitText, n.wait && n.wait.at));
      else found.push(verdict('unknown', 'R1', '', n.wait && n.wait.at));
    }
    const orphan = row && row.orphan && typeof row.orphan.state === 'string' ? row.orphan : null;
    if (orphan && orphan.state === 'orphan') found.push(verdict('suspect', 'R2', CASE_TITLES.R2 || 'its lead is gone', orphan.since));
    for (const c of open.get(n.id) || []) found.push(verdict('suspect', c.rule, CASE_TITLES[c.rule] || c.line || 'it looks stuck', c.openedAt));
    const ci = n.checkIn && Object.prototype.hasOwnProperty.call(CHECKIN_STUCK, n.checkIn.state) ? n.checkIn : null;
    if (ci) found.push(verdict('suspect', 'check-in', CHECKIN_STUCK[ci.state], ci.sentAt));
    if (!found.length) continue;
    found.sort((a, b) => rank[a.kind] - rank[b.kind] || oldestFirst(a.at, b.at));
    out.set(n.id, found[0]);
  }
  return out;
}

/** The items of a tree's sessions as their subjects show them. */
function itemsOf(members, subjectByKey) {
  const out = [];
  const seen = new Set();
  for (const n of members) {
    for (const it of n.items || []) {
      const key = subjectKeyOf(it, n);
      const s = key ? subjectByKey.get(key) : null;
      if (!s || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, ref: s.ref, title: s.title, stage: s.stage ? s.stage.current : null, station: s.stage ? s.stage.station : null, waitsOn: s.waitsOn });
    }
  }
  return out;
}

/** The effort view. `nodes`: lib/mc-subjects.js sessionNodes (live and the week's closed); `subjects`:
 *  buildView's; `cards`: the cards Now's Answer-now list SHOWS (lib/mc-needs.js buildNow `answerNow`, faced: a
 *  card held on My to-do or put off by Later is not one, and the dispatcher's own are left out here);
 *  `actions`: buildNow's `actions` (the person's own to-dos: listed on My to-do, and under their effort as
 *  `todo`, so the effort page that says it needs the person shows what to do - #584);
 *  `servers`: `[{name, ok}]`, ok false = it did not answer; `supervisor`: stateOf's answer or null;
 *  `slots`: `{ <server>: maxSessions }` (absent = not read). */
function buildEfforts({ nodes: allNodes, subjects = [], cards = [], actions = [], servers = [], supervisor = null, slots = {}, now = Date.now() }) {
  const nodes = (Array.isArray(allNodes) ? allNodes : []).filter((n) => n && !isSupervisor(n));
  const serverList = (Array.isArray(servers) ? servers : []).filter((s) => s && typeof s.name === 'string').map((s) => ({ name: s.name, ok: s.ok !== false }));
  const missing = serverList.filter((s) => !s.ok).map((s) => s.name);
  const complete = missing.length === 0;
  const tree = buildTree(nodes);
  const subjectByKey = new Map((Array.isArray(subjects) ? subjects : []).map((s) => [s.key, s]));
  const verdicts = verdictsOf(nodes, supervisor);
  const cardsBySession = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.supervisor === true || typeof c.sessionId !== 'string') continue;
    if (!cardsBySession.has(c.sessionId)) cardsBySession.set(c.sessionId, []);
    cardsBySession.get(c.sessionId).push(c);
  }
  const actionsBySession = new Map();
  for (const c of Array.isArray(actions) ? actions : []) {
    if (!c || c.supervisor === true || typeof c.sessionId !== 'string') continue;
    if (!actionsBySession.has(c.sessionId)) actionsBySession.set(c.sessionId, []);
    actionsBySession.get(c.sessionId).push(c);
  }

  const efforts = [];
  const covered = new Set();
  for (const root of tree.roots()) {
    const members = [root, ...tree.descendantsOf(root)];
    const live = members.filter((n) => !n.closed);
    if (!live.length) continue;
    const memberIds = new Set(members.map((n) => n.id));
    const needsYou = [];
    for (const n of live) for (const c of cardsBySession.get(n.id) || []) needsYou.push(c);
    const todo = [];
    for (const n of live) for (const c of actionsBySession.get(n.id) || []) todo.push(c);
    const owed = [...needsYou, ...todo].filter(owesAnswer);
    const sessions = members.map((n) => {
      const p = tree.parentOf(n);
      return { server: n.server, id: n.id, name: n.name, status: n.status, closed: n.closed, closedAt: n.closedAt,
        parentId: p ? p.id : n.parentId, depth: tree.ancestorsOf(n).length,
        wait: !n.closed && n.wait && n.wait.on ? { on: n.wait.on, what: str(n.wait.what) || '' } : null,
        verdict: verdicts.get(n.id) || null };
    });
    const suspects = live.map((n) => verdicts.get(n.id)).filter((v) => v && v.kind === 'suspect').sort((a, b) => oldestFirst(a.at, b.at));
    let state;
    if (owed.length) state = 'needs-you';
    else if (suspects.length) state = 'stuck';
    else if (live.some((n) => n.status === 'working')) state = 'moving';
    else state = 'waiting';
    // The effort's verdict: the oldest suspect; else the lead's own, else the first that says anything.
    const leadVerdict = !root.closed ? verdicts.get(root.id) || null : null;
    const anyVerdict = live.map((n) => verdicts.get(n.id)).filter(Boolean).sort((a, b) => (a.kind === 'legit' ? 0 : 1) - (b.kind === 'legit' ? 0 : 1) || oldestFirst(a.at, b.at));
    const effortVerdict = suspects[0] || leadVerdict || anyVerdict[0] || null;
    const newest = [...live].sort((a, b) => (num(b.reportAt) || num(b.lastActivity) || 0) - (num(a.reportAt) || num(a.lastActivity) || 0)).find((n) => n.headline) || null;
    const items = itemsOf(members, subjectByKey);
    for (const it of items) covered.add(it.key);
    // A lead that names a parent nobody lists, while a server did not answer, may be a tree whose
    // top lives there: this card is that tree's part, never a lead whose parent is gone (#562).
    const partial = !complete && Boolean(root.parentId) && !memberIds.has(root.parentId) && !tree.resolve(root.parentId);
    const created = members.map((n) => n.createdAt).filter(Number.isFinite);
    const waitAts = live.map((n) => (n.wait && Number.isFinite(n.wait.at) ? n.wait.at : null)).filter((x) => x !== null);
    efforts.push({
      id: root.id, name: root.name, server: root.server,
      machines: [...new Set(live.map((n) => n.server).filter(Boolean))],
      startedAt: created.length ? Math.min(...created) : null,
      lastActivity: Math.max(0, ...live.map((n) => num(n.lastActivity) || num(n.reportAt) || 0)) || null,
      state, doing: newest ? newest.headline : null, verdict: effortVerdict, sessions,
      items: items.slice(0, ITEMS_MAX), needsYou, todo, todoCount: todo.length,
      partial, missing: partial ? missing : [],
      _ask: Math.min(...owed.map((c) => (Number.isFinite(c.askedAt) ? c.askedAt : Infinity)), Infinity),
      _wait: waitAts.length ? Math.min(...waitAts) : null,
    });
  }
  // Order: needs you (oldest ask first), stuck (oldest verdict first), moving (newest activity
  // first), then waiting on others (oldest wait first); ties by the lead's id.
  const stateRank = (e) => STATES.indexOf(e.state);
  efforts.sort((a, b) => stateRank(a) - stateRank(b)
    || (a.state === 'needs-you' ? a._ask - b._ask : 0)
    || (a.state === 'stuck' ? oldestFirst(a.verdict && a.verdict.at, b.verdict && b.verdict.at) : 0)
    || (a.state === 'moving' ? (b.lastActivity || 0) - (a.lastActivity || 0) : 0)
    || (a.state === 'waiting' ? oldestFirst(a._wait, b._wait) : 0)
    || byIdAsc(a, b));
  for (const e of efforts) { delete e._ask; delete e._wait; }

  // Not running: every subject no effort covers, by line, in class order inside a group.
  const classRank = (c) => IDLE_CLASSES.indexOf(c);
  const groups = new Map();
  for (const s of Array.isArray(subjects) ? subjects : []) {
    if (!s || covered.has(s.key)) continue;
    const line = s.line && typeof s.line.id === 'string' ? { id: s.line.id, name: s.line.name || s.line.id, project: s.line.project || null, kind: s.line.kind || null } : null;
    const gk = line ? line.id : '';
    if (!groups.has(gk)) groups.set(gk, { line, items: [] });
    groups.get(gk).items.push({ key: s.key, ref: s.ref, title: s.title, stage: s.stage ? s.stage.current : null,
      station: s.stage ? s.stage.station : null, cls: idleClassOf(s), updatedAt: num(s.updatedAt) });
  }
  const idle = [...groups.values()].map((g) => {
    g.items.sort((a, b) => classRank(a.cls) - classRank(b.cls) || (b.updatedAt || 0) - (a.updatedAt || 0) || (a.key < b.key ? -1 : 1));
    return { ...g, _best: classRank(g.items[0].cls), _at: Math.max(...g.items.map((i) => i.updatedAt || 0)) };
  }).sort((a, b) => a._best - b._best || (a.line === null) - (b.line === null) || b._at - a._at
    || String(a.line && a.line.id).localeCompare(String(b.line && b.line.id)));
  for (const g of idle) { delete g._best; delete g._at; }

  // The header's chips: live sessions out of the slots each machine has.
  const machines = serverList.map((s) => {
    const mine = nodes.filter((n) => !n.closed && n.server === s.name);
    const cap = slots && Number.isFinite(slots[s.name]) ? slots[s.name] : null;
    return { name: s.name, live: mine.length, working: mine.filter((n) => n.status === 'working').length, slots: cap, ok: s.ok };
  });
  return { efforts, idle, machines, servers: serverList, complete, generatedAt: now };
}

module.exports = { STATES, IDLE_CLASSES, CASE_RULES, CHECKIN_STUCK, idleClassOf, owesAnswer, verdictsOf, buildEfforts };
