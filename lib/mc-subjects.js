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
const { globalKey, liveClosed, WAIT_ON, LIMITS, askDigest, askReplyPrefix, clipWords, DECISION_CONTROL_RE } = require('./session-brief');
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
      // `undefined` = a peer too old to publish a reason (decided from status and wait instead).
      reason: r.reason === undefined ? undefined : r.reason, waitingFor: str(r.waitingFor),
      parentId: str(sp.parentId), replaces: Array.isArray(sp.replaces) ? sp.replaces.filter((x) => typeof x === 'string') : [],
      createdAt: num(sp.createdAt), lastActivity: num(r.lastActivity),
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
      wait: null, asks: [], possibleAsk: null, turnAt: null, reason: null, waitingFor: null,
      parentId: str(sp.parentId), replaces: Array.isArray(sp.replaces) ? sp.replaces.filter((x) => typeof x === 'string') : [],
      createdAt: num(sp.createdAt), lastActivity: num(rec.at),
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
  if (!k) return null;
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

/** {subjects, runs}. `metaByKey`: tracker details by key (lib/tracker-meta.js; parents'
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

    let waitsOn = null;
    for (const w of WAIT_ORDER) if (s.sessions.some((x) => x.waitOn === w)) { waitsOn = w; break; }
    const asker = waitsOn === 'you' ? s.sessions.find((x) => x.waitOn === 'you') : null;
    const updatedAt = Math.max(0, ...s.sessions.map((x) => x.at || 0)) || null;
    subjects.push({
      key: s.key, ref: latest.item.ref || s.key, url: (meta && str(meta.url)) || str(latest.item.url),
      title, project, area, meta, stage: fold.stage,
      sessions: s.sessions.map((x) => x.ref),
      needsYou: asker ? needsYouCard(asker.node, s.key, latest.item.ref || s.key, title) : null,
      waitsOn, buckets: bucketsOf({ waitsOn, meta }), runId: null, updatedAt,
    });
    nodesOfKey.set(s.key, s.sessions.map((x) => x.node));
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
  const byKey = new Map(subjects.map((x) => [x.key, x]));
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
  return { subjects, runs };
}

/** `?project=&area=`: a project id, and an area id or name. `projectsView` (lib/projects.js's
 *  answer for the same subjects) names the ids, so a filter takes exactly the id /api/mc/projects
 *  handed out (a suffixed one after an id collision too); without it the id is `areaId(name)`. */
function filterView({ subjects, runs }, { project, area, line } = {}, { projectsView } = {}) {
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
  return { subjects: keep, runs: runs.filter((r) => r.subjects.some((k) => keys.has(k))) };
}

module.exports = {
  BUCKETS, WAIT_ORDER, TRACKER_KEY_RE,
  sessionNodes, isSupervisor, subjectKeyOf, trackerKeys, sessionWaitOn, bucketsOf, needsYouCard, askCard, possibleAskCard, buildView, filterView,
};
