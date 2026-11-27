'use strict';
// #567 - Mission Control's work board (step 1: read-only): current work in columns, plus the next
// candidates per source.
//
//   Candidates | In progress | PR / in review | Committed / merged | Ready for test
//
// This module is a MAPPING over evidence other modules own; it adds no stage rule and no verdict:
//  - which column a work item is in = `columnOf`, read off the subject's `stage` (lib/mc-stage.js:
//    the ADO station, the folded stage), its class when nobody runs it (`idleClassOf`, lib/mc-efforts.js)
//    and whether a live session is on it. The furthest evidence wins; Done / closed / tested is not
//    current work and is off the board.
//  - a card's wait badge = what `GET /api/mc/efforts` serves for it (lib/mc-efforts.js: the supervisor's
//    verdict on its live sessions, the cards that owe the person an answer, `owesAnswer`) - read, never
//    re-derived.
//  - the candidates are lib/mc-candidates.js's cache of the trackers' own lists; the bug hunter's queue
//    keeps its dispatcher's order.
// Pure: no I/O. Step 2 (a Queued column, Start, any write) is not here. docs/mission-control.md
// "Work board (#567)".
const { stageIndex } = require('./mc-stage');
const { idleClassOf, owesAnswer } = require('./mc-efforts');

/// The columns of CURRENT work, left to right (Candidates, per source, comes first on screen).
const COLUMNS = Object.freeze(['in-progress', 'pr-review', 'committed-merged', 'ready-for-test']);
const COLUMN_CAP = 100;
const SESSIONS_MAX = 5;
const TEXT_MAX = 160;
const PR_OPEN = stageIndex('pr-open');
const MERGED = stageIndex('merged');
/// The badge kinds, in the order a column lists them (what needs the person first).
const BADGES = Object.freeze(['you', 'suspect', 'unknown', 'legit', 'none']);

const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
const stationOf = (s) => (typeof (s.stage || {}).station === 'string' ? s.stage.station.trim().toLowerCase() : '');
/** Oldest first; a missing time sorts last. */
const oldestFirst = (a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0) || (a || 0) - (b || 0);

/** The live sessions on a subject (its `sessions` are the live ones and the week's closed). */
const liveSessionsOf = (s) => (Array.isArray(s.sessions) ? s.sessions : []).filter((x) => x && !x.closed);

/** The column a work item is in, or null (not current work). `subject`: one record of lib/mc-subjects.js
 *  buildView's `subjects`; `live`: a session is on it right now.
 *   - finished (the tracker closed it, Done, tested, every session said done) -> off the board;
 *   - ADO station Ready for test -> Ready for test; Committed -> Committed / merged (the station is the
 *     authority on how far the code got, as lib/mc-stage.js reads it: it holds a Committed item's stage at
 *     pr-open, but the owner's board lists it with the merged work);
 *   - else the stage: merged (an ADO Merged item's too) -> Committed / merged, pr-open / in-review -> PR / in review;
 *   - else a live session on it, or work begun with nobody on it (`idleClassOf` = stranded) -> In progress;
 *   - anything else (a start binding no session ever reported on) is a candidate if its tracker lists it,
 *     never a card here. */
function columnOf(subject, live) {
  const s = subject || {};
  const cls = idleClassOf(s);
  if (cls === 'finished') return null;
  const station = stationOf(s);
  if (station === 'ready for test') return 'ready-for-test';
  if (station === 'committed') return 'committed-merged';
  const idx = stageIndex((s.stage || {}).current);
  if (idx >= MERGED) return 'committed-merged';
  if (idx >= PR_OPEN) return 'pr-review';
  if (live || cls === 'stranded') return 'in-progress';
  return null;
}

/** When the card entered its column, or null (unknown - shown as no age, never a guess). Where the STATION put
 *  the card in its column (Ready for test; Committed) the Azure DevOps item's own state change is the truth. Where
 *  the stage did (In progress, PR / in review, merged) the station's change time says nothing about it - an item
 *  In Progress for a month whose PR opened yesterday has been in PR / in review for a day - so: the time a session
 *  REPORTED the stage (exact), then the first time the tracker was seen to prove it (a late bound: the proof is at
 *  least that old). A closed item is off the board, so the tracker's close time is never an age here. */
function sinceOf(s, column) {
  const range = {
    'in-progress': (i) => i < PR_OPEN,
    'pr-review': (i) => i >= PR_OPEN && i < MERGED,
    'committed-merged': (i) => i >= MERGED,
    'ready-for-test': (i) => i >= MERGED,
  }[column];
  const steps = ((s.stage || {}).history || []).filter((h) => h && range(stageIndex(h.stage)) && num(h.at) !== null);
  const reported = steps.find((h) => h.source === 'report');
  const seen = steps.find((h) => h.source !== 'report');
  const reportedAt = reported ? reported.at : null;
  const seenAt = seen ? seen.at : null;
  const byStation = column === 'ready-for-test' || (column === 'committed-merged' && stationOf(s) === 'committed');
  const stateAt = num(s.meta && s.meta.stateAt);
  const order = byStation ? [stateAt, reportedAt, seenAt] : [reportedAt, seenAt];
  const first = order.find((x) => x !== null);
  return first === undefined ? null : first;
}

/** Where a work item lives, as `{kind, name}`: an ADO project, a GitHub repo, or neither (a subject of one session). */
function trackerSourceOf(key, meta) {
  if (/^ado:\d+$/.test(key)) return { kind: 'ado', name: str(meta && meta.adoProject) };
  const m = /^([\w.-]+\/[\w.-]+)#\d+$/.exec(key);
  if (m) return { kind: 'github', name: str(meta && meta.repo) || m[1] };
  return { kind: 'other', name: null };
}

/** The wait badge, from what the efforts view says: a card that owes the person an answer on THIS item -> `you`;
 *  else the supervisor's verdict on its live sessions (the oldest suspect, else a legit, else an unknown); else none.
 *  `ctx`: `{owedByKey, sessionById}` built from the efforts (see [buildBoard]). */
function badgeOf(key, live, ctx) {
  const owed = ctx.owedByKey.get(key);
  if (owed) return { kind: 'you', text: oneLine(owed.what) || 'waits on you', rule: null, at: num(owed.askedAt) };
  const verdicts = live.map((x) => (ctx.sessionById.get(x.id) || {}).verdict).filter(Boolean);
  for (const kind of ['suspect', 'legit', 'unknown']) {
    const v = verdicts.filter((x) => x.kind === kind).sort((a, b) => oldestFirst(num(a.at), num(b.at)))[0];
    if (v) return { kind, text: oneLine(v.text), rule: str(v.rule), at: num(v.at) };
  }
  return { kind: 'none', text: '', rule: null, at: null };
}

/** The tracker's own ranking of what to take next: priority, then severity (lower = more urgent, none last),
 *  then the oldest; what ties keeps the order the tracker listed it in (a stable sort). A dispatcher's list (the bug
 *  hunter) is never re-ranked. */
function candidateOrder(a, b) {
  const k = (v) => (Number.isFinite(v) ? v : 99);
  return k(a.priority) - k(b.priority) || k(a.severity) - k(b.severity) || oldestFirst(num(a.createdAt), num(b.createdAt));
}

/** The board. `efforts`: lib/mc-efforts.js buildEfforts' answer (the SAME compute `GET /api/mc/efforts` serves);
 *  `subjects`: lib/mc-subjects.js buildView's; `candidates`: lib/mc-candidates.js `snapshot`; `projects`: validated
 *  config `projects[]` (names for the cards); `perSource`: candidates shown per source. */
function buildBoard({ efforts, subjects = [], candidates = [], projects = [], perSource = 10, now = Date.now() }) {
  const ef = efforts || {};
  const projectName = new Map((Array.isArray(projects) ? projects : []).map((p) => [p.id, p.name]));
  const ctx = { owedByKey: new Map(), sessionById: new Map() };
  for (const e of Array.isArray(ef.efforts) ? ef.efforts : []) {
    for (const s of e.sessions || []) ctx.sessionById.set(s.id, s);
    for (const c of e.needsYou || []) if (owesAnswer(c) && c.subjectKey && !ctx.owedByKey.has(c.subjectKey)) ctx.owedByKey.set(c.subjectKey, c);
  }

  const cols = new Map(COLUMNS.map((id) => [id, []]));
  const onBoard = new Set(); // an item with a card is never also a candidate
  const hasSession = new Set(); // nor is one with a live session, whatever its column
  for (const s of Array.isArray(subjects) ? subjects : []) {
    const live = liveSessionsOf(s);
    if (live.length) hasSession.add(s.key);
    const column = columnOf(s, live.length > 0);
    if (!column) continue;
    onBoard.add(s.key);
    cols.get(column).push({
      key: s.key, ref: s.ref, title: s.title, url: str(s.url),
      source: trackerSourceOf(s.key, s.meta), project: s.project ? projectName.get(s.project) || (s.project === 'other' ? 'Other' : s.project) : null,
      station: (s.stage || {}).station || null, stage: (s.stage || {}).current || null,
      since: sinceOf(s, column), live: live.length > 0,
      badge: badgeOf(s.key, live, ctx),
      sessions: live.slice(0, SESSIONS_MAX).map((x) => ({ server: x.server, id: x.id, name: x.name, status: x.status })),
      line: s.line && typeof s.line.id === 'string' ? { id: s.line.id, name: s.line.name || s.line.id } : null,
    });
  }
  const badgeRank = (c) => BADGES.indexOf(c.badge.kind);
  const columns = COLUMNS.map((id) => {
    const all = cols.get(id).sort((a, b) => badgeRank(a) - badgeRank(b) || oldestFirst(a.since, b.since) || (a.key < b.key ? -1 : 1));
    return { id, count: all.length, more: Math.max(0, all.length - COLUMN_CAP), cards: all.slice(0, COLUMN_CAP) };
  });

  // Candidates: a dispatcher's list claims its items (the bug hunter's queue is where they start), so the
  // same item is not offered a second time by a tracker list.
  // `claims`: its whole queue, of which `items` are only the entries whose titles were read.
  const claimed = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!(c.source && c.source.dispatcher)) continue;
    for (const it of c.items || []) claimed.add(it.key);
    for (const k of c.claims || []) claimed.add(k);
  }
  const cands = (Array.isArray(candidates) ? candidates : []).map((c) => {
    const dispatcher = Boolean(c.source && c.source.dispatcher);
    const eligible = (c.items || []).filter((it) => it && it.key && !onBoard.has(it.key) && !hasSession.has(it.key) && (dispatcher || !claimed.has(it.key)));
    const picked = (dispatcher ? eligible : [...eligible].sort(candidateOrder)).slice(0, Math.max(1, perSource));
    return {
      source: c.source, state: c.state, why: c.why, fetchedAt: num(c.fetchedAt), total: c.total, more: c.more === true,
      hidden: (c.items || []).length - eligible.length,
      cards: picked.map((it) => ({
        key: it.key, ref: it.ref, title: it.title || it.ref, url: str(it.url),
        source: it.tracker === 'ado' ? { kind: 'ado', name: str(it.adoProject) } : { kind: 'github', name: str(it.repo) },
        project: c.source && c.source.project ? c.source.project.name : null,
        station: str(it.state), stage: null, since: num(it.queuedAt) !== null ? it.queuedAt : num(it.createdAt), live: false,
        badge: { kind: 'none', text: '', rule: null, at: null }, sessions: [], line: null,
        type: str(it.type), priority: num(it.priority), severity: num(it.severity), handsOff: it.handsOff === true,
      })),
    };
  });
  const fetched = cands.map((c) => c.fetchedAt).filter((x) => x !== null);
  return { columns, candidates: cands, complete: ef.complete !== false, generatedAt: now, refreshedAt: fetched.length ? Math.max(...fetched) : null };
}

module.exports = { COLUMNS, BADGES, COLUMN_CAP, columnOf, sinceOf, badgeOf, candidateOrder, buildBoard };
