'use strict';
// --- #466 The supervisor, phase 1: the cluster work graph (docs/SUPERVISOR-DESIGN.md) ---
//
// On the lease authority only (lib/leases.js resolveAuthority === 'self'), server.js polls
// every server's sessions once a minute and hands the answers here. This file turns them
// into ONE graph of the cluster's sessions - who opened whom, through hand-offs - and
// decides which sessions are ORPHANS.
//
// ORPHAN: a session whose lead (`spawn.parentId`, followed through `replaces`, so a lead
// that handed off is found under its successor) is absent from EVERY server, on two scans
// at least `orphanConfirmMs` apart, with every server answering both. A server that did not
// answer makes the verdict "unknown": the lead may be on it. "unknown" never advances,
// confirms or clears a sighting - it is not a reading.
//
// Phase 1 is READ-ONLY: nothing here acts on a session. Rules that act arrive with phase 2+
// and read this graph.
//
// Pure: no I/O, no clock (every function takes `at`).

const { validateTarget } = require('./wait-target');
const { SUPERVISOR_PROMPT_TAG } = require('./user-turn');
const { refKey } = require('./session-brief');
const closeoutLib = require('./closeout');

const ORPHAN_CONFIRM_MS = 5 * 60 * 1000;
const EVERY_MS = 60 * 1000;
/** Folded journal entries served at most (newest first). */
const JOURNAL_MAX = 500;

const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _str = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);
const _id = (s) => (typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s) ? s.toLowerCase() : null);

/** #467 defaults: a reminder every 2 h by day, at most 4 supervisor prompts per session per
 *  hour, an outside lookup (gh, ADO) at most every 2 min per target, at most 10 per scan. */
const REMIND_EVERY_MIN = 120;
const ACTIONS_PER_HOUR = 4;
const RESOLVE_EVERY_MIN = 2;
const LOOKUPS_PER_SCAN = 10;
const _int = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);

/// `supervisor` from config.json. Absent = on, at the authority only.
///   enabled         false switches it off
///   exclude         server names the supervisor ignores entirely (the MacBook)
///   everySec        seconds between polls (min 30)
///   wake            false: R1/R2 are planned and logged, but nothing is typed (#467; waking
///                   can be undone, so it acts from day one - this is its off switch)
///   ownerPush       false: no owner-wait pushes (#467)
///   remindEveryMin  a reminder for a wait on the owner, by day (default 120)
///   actionsPerHour  supervisor prompts per session per hour (default 4)
///   resolveEveryMin how often one outside target is looked up (default 2)
///   ado             {org, project}: where ADO targets live (no org: ADO targets are unknown)
///   quietHours      parsed by lib/quiet-hours.js quietConfig, not here
function supervisorConfig(raw) {
  const c = _isObj(raw) ? raw : {};
  const every = Number.isFinite(c.everySec) ? Math.max(30, Math.floor(c.everySec)) * 1000 : EVERY_MS;
  const exclude = Array.isArray(c.exclude) ? c.exclude.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()) : [];
  const ado = _isObj(c.ado) && typeof c.ado.org === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(c.ado.org)
    ? { org: c.ado.org, project: typeof c.ado.project === 'string' && /^[A-Za-z0-9 _.-]{1,100}$/.test(c.ado.project) ? c.ado.project : null }
    : null;
  return {
    enabled: c.enabled !== false, everyMs: every, exclude, orphanConfirmMs: ORPHAN_CONFIRM_MS,
    wake: c.wake !== false, ownerPush: c.ownerPush !== false,
    remindEveryMs: _int(c.remindEveryMin, 15, 24 * 60, REMIND_EVERY_MIN) * 60 * 1000,
    actionsPerHour: _int(c.actionsPerHour, 1, 30, ACTIONS_PER_HOUR),
    resolveEveryMs: _int(c.resolveEveryMin, 1, 60, RESOLVE_EVERY_MIN) * 60 * 1000,
    lookupsPerScan: LOOKUPS_PER_SCAN,
    ado,
  };
}

/// Is server [name] out of the supervisor's scope?
function isExcluded(name, cfg) {
  return typeof name === 'string' && (cfg && Array.isArray(cfg.exclude) ? cfg.exclude : []).includes(name.toLowerCase());
}

/// The fields of one session row (a peer's /api/sessions row, or the local slim row) the
/// graph keeps. Anything a peer sends is validated here: a peer's row is data, not trusted.
function nodeOf(row, server) {
  if (!_isObj(row) || !_id(row.id)) return null;
  const spawn = _isObj(row.spawn) ? row.spawn : {};
  const b = _isObj(row.brief) ? row.brief : {};
  const w = _isObj(b.wait) && typeof b.wait.on === 'string' ? b.wait : null;
  // A peer's target is re-validated by the one rule that accepted it there; a bad one is dropped.
  const t = w ? validateTarget(w.target, { refKey }) : null;
  return {
    id: _id(row.id), server,
    name: _str(row.name, 100), cwd: _str(row.cwd, 260),
    status: _str(row.status, 20), agent: _str(row.agent, 20),
    clients: Number.isFinite(row.clients) ? row.clients : 0,
    by: spawn.by === 'agent' || spawn.by === 'human' ? spawn.by : null,
    parentId: _id(spawn.parentId),
    replaces: Array.isArray(spawn.replaces) ? spawn.replaces.map(_id).filter(Boolean).slice(0, 8) : [],
    goal: _str(spawn.goal, 300),
    headline: _str(b.headline, 160),
    // brief.now is `{text, at}` (lib/session-brief.js), a string only from an old peer.
    now: _isObj(b.now) ? _str(b.now.text, 140) : _str(b.now, 140),
    // #468 - what the case rules read (lib/supervisor-cases.js): when a hook last spoke
    // (R6), the last check-in and its answer (R3), live work under a turn (R6), the
    // transcript's repeated failure (R9), the usage cap (the dispatcher's own row).
    nowAt: _isObj(b.now) && Number.isFinite(b.now.at) ? b.now.at : null,
    turnAt: Number.isFinite(b.turnAt) ? b.turnAt : null,
    stoppedAt: Number.isFinite(b.stoppedAt) ? b.stoppedAt : null,
    reportAt: Number.isFinite(b.reportAt) ? b.reportAt : null,
    checkIn: _isObj(b.checkIn) && Number.isFinite(b.checkIn.sentAt) ? {
      n: Number.isFinite(b.checkIn.n) ? b.checkIn.n : 1,
      deliveredAt: Number.isFinite(b.checkIn.deliveredAt) ? b.checkIn.deliveredAt : null,
      endedAt: Number.isFinite(b.checkIn.endedAt) ? b.checkIn.endedAt : null,
      answer: _isObj(b.checkIn.answer) && typeof b.checkIn.answer.on === 'string' ? { on: _str(b.checkIn.answer.on, 20), what: _str(b.checkIn.answer.what, 80) || '' } : null,
    } : null,
    compacting: row.compacting === true,
    waitingFor: _str(row.waitingFor, 20),
    // Every live waker under the turn (#443: a command, a subagent, a Monitor, a wakeup...).
    liveWork: Array.isArray(row.backgroundTasks) ? row.backgroundTasks.filter((t) => _isObj(t) && !t.stale).length : 0,
    // #526 - decisions it holds for the owner (the brief's asks): closing it would drop them.
    openAsks: Array.isArray(b.asks) ? b.asks.filter(_isObj).length : 0,
    circling: _isObj(row.circling) && Number.isFinite(row.circling.count) ? {
      tool: _str(row.circling.tool, 40) || '?', sample: _str(row.circling.sample, 160) || '', fp: _str(row.circling.fp, 220), count: row.circling.count,
      turns: Number.isFinite(row.circling.turns) ? row.circling.turns : 1, lastAt: Number.isFinite(row.circling.lastAt) ? row.circling.lastAt : null,
    } : null,
    capped: Boolean(row.capBlocked || (_isObj(row.usageLimit) && (row.usageLimit.waiting || row.usageLimit.armed))),
    role: row.role === 'supervisor' ? 'supervisor' : null,
    // #469 - R5 reads the close-out (asked, answered) and whether the owner pinned it.
    closeout: closeoutLib.recordOf(b.closeout),
    // #470 - R7: the agent's process was seen under the shell and is gone (lib/replacement.js
    // agentGoneField); endedAt set = someone exited it on purpose, null = it died.
    agentGone: _isObj(row.agentGone) && Number.isFinite(row.agentGone.seenAt) ? {
      seenAt: row.agentGone.seenAt, endedAt: Number.isFinite(row.agentGone.endedAt) ? row.agentGone.endedAt : null,
      reason: _str(row.agentGone.reason, 40),
    } : null,
    favorite: row.favorite === true,
    // #479 - a person's unsent text has sat in its composer since `since`, with nobody typing:
    // every prompt the server would type into it (a wake, the check-in, the close-out) is held.
    // `release`: 'send' (only a prompt sent ends it), 'send-or-clear' (an idle Ctrl-C too), or
    // null: a peer too old to say.
    composerDraft: _isObj(row.composerDraft) && Number.isFinite(row.composerDraft.since)
      ? { since: row.composerDraft.since, release: ['send', 'send-or-clear'].includes(row.composerDraft.release) ? row.composerDraft.release : null } : null,
    prompt: _str(b.prompt, 160),
    items: Array.isArray(b.items) ? b.items.slice(0, 6).filter(_isObj).map((i) => ({ ref: _str(i.ref, 60), title: _str(i.title, 140), state: _str(i.state, 20) })) : [],
    wait: w ? {
      on: _str(w.on, 20), what: _str(w.what, 80) || '', at: Number.isFinite(w.at) ? w.at : null,
      ...(t && t.target ? { target: t.target } : {}),
      ...(Number.isInteger(w.checkBy) ? { checkBy: w.checkBy } : {}),
    } : null,
    reason: _isObj(row.reason) && typeof row.reason.kind === 'string'
      ? { kind: _str(row.reason.kind, 20), text: _str(row.reason.text, 160), source: _str(row.reason.source, 20) } : null,
  };
}

/// One scan: every in-scope server's answer -> the graph.
/// [servers]: `[{ name, ok, reason?, sessions: row[] }]` (ok false = it did not answer).
function buildGraph(servers, at) {
  const list = Array.isArray(servers) ? servers : [];
  const nodes = [];
  const seen = new Set();
  for (const s of list) {
    if (!s || !s.ok) continue;
    for (const row of Array.isArray(s.sessions) ? s.sessions : []) {
      const n = nodeOf(row, s.name);
      // An id listed twice (a peer echoing another's rows) is one session: first wins.
      if (n && !seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
    }
  }
  // A replaced id is an ALIAS of the session that replaced it (#374): a child that names
  // its lead's old id still finds the lead after the lead handed off.
  const live = new Set(nodes.map((n) => n.id));
  const alias = new Map();
  for (const n of nodes) for (const r of n.replaces) if (!live.has(r) && !alias.has(r)) alias.set(r, n.id);
  const resolve = (id) => (!id ? null : live.has(id) ? id : (alias.get(id) || null));
  for (const n of nodes) n.leadId = resolve(n.parentId);
  for (const n of nodes) n.children = nodes.filter((k) => k.leadId === n.id).map((k) => k.id);
  return {
    at,
    // #467 - a replaced id -> the live session that replaced it, for the wait resolvers.
    aliases: Object.fromEntries(alias),
    complete: list.length > 0 && list.every((s) => s && s.ok),
    servers: list.map((s) => ({ name: s.name, ok: Boolean(s && s.ok), reason: s && !s.ok ? _str(s.reason, 120) : null,
      sessions: s && s.ok && Array.isArray(s.sessions) ? s.sessions.length : 0 })),
    nodes,
  };
}

/// Fold one scan into the orphan sightings. [prev]: `{ <childId>: { parentId, firstAt, lastAt } }`
/// from the scan before (persisted by the caller across scans, in memory). Returns
/// `{ sightings, verdicts }`, verdicts `{ <childId>: { state, parentId, since } }` with state
///   suspect  missing on every complete scan so far, but not yet confirmMs apart
///   orphan   missing on two complete scans at least confirmMs apart
///   unknown  missing, but some server did not answer this scan - or the lead was never seen
///            in scope at all: [known] (when given) is every session id the supervisor has
///            seen on an in-scope server, live or in a journal. A lead outside it may live on
///            an excluded server (the MacBook) or one not in the cluster list, where its
///            absence proves nothing.
/// THE absence rule, one step: an id no server lists in [graph], given its sighting [was]
/// from earlier scans (or null). A scan where some server did not answer is not a reading:
/// it keeps the sighting and decides nothing ('unknown'). Otherwise the sighting starts or
/// advances, and the id is 'gone' once it has been missing on complete scans at least
/// [confirmMs] apart, else 'suspect'. Orphans (a missing lead) and gone wait targets both
/// read it, so "gone" means one thing everywhere.
function absenceStep(was, graph, confirmMs = ORPHAN_CONFIRM_MS) {
  if (!graph.complete) return { sighting: was || null, state: 'unknown' };
  const s = was ? { ...was, lastAt: graph.at } : { firstAt: graph.at, lastAt: graph.at };
  return { sighting: s, state: graph.at - s.firstAt >= confirmMs ? 'gone' : 'suspect' };
}

/// #467 - the absence of every id in [ids] that no server lists in [graph] (the session and
/// child ids waits name). [prev] `{ <id>: {firstAt, lastAt} }` from the scan before; [known]
/// as noteOrphans: an id never seen in scope is 'unknown', never 'gone'. Returns
/// `{ sightings, states: { <id>: 'suspect'|'gone'|'unknown' } }`; a listed id has no state.
function noteAbsent(prev, ids, graph, { confirmMs = ORPHAN_CONFIRM_MS, known = null } = {}) {
  const old = _isObj(prev) ? prev : {};
  const present = new Set(graph.nodes.map((n) => n.id));
  for (const [a, to] of Object.entries(graph.aliases || {})) if (to) present.add(a);
  const sightings = {};
  const states = {};
  for (const id of new Set(ids || [])) {
    if (present.has(id)) continue;
    if (known && !known.has(id)) { states[id] = 'unknown'; continue; }
    const step = absenceStep(old[id] || null, graph, confirmMs);
    if (step.sighting) sightings[id] = step.sighting;
    states[id] = step.state;
  }
  return { sightings, states };
}

function noteOrphans(prev, graph, { orphanConfirmMs = ORPHAN_CONFIRM_MS, known = null } = {}) {
  const old = _isObj(prev) ? prev : {};
  const sightings = {};
  const verdicts = {};
  const present = new Set(graph.nodes.map((n) => n.id));
  for (const n of graph.nodes) {
    if (!n.parentId || n.leadId) continue; // no lead, or its lead is here
    const was = old[n.id] && old[n.id].parentId === n.parentId ? old[n.id] : null;
    if (known && !known.has(n.parentId)) {
      verdicts[n.id] = { state: 'unknown', parentId: n.parentId, since: null, why: 'lead-never-seen' };
      continue;
    }
    const step = absenceStep(was, graph, orphanConfirmMs);
    if (step.sighting) sightings[n.id] = step.sighting.parentId ? step.sighting : { parentId: n.parentId, ...step.sighting };
    verdicts[n.id] = { state: step.state === 'gone' ? 'orphan' : step.state, parentId: n.parentId, since: step.sighting ? step.sighting.firstAt : null };
  }
  // A child that is not in this scan: gone if every server answered, else not known - keep it.
  if (!graph.complete) for (const [id, s] of Object.entries(old)) if (!present.has(id) && !sightings[id]) sightings[id] = s;
  return { sightings, verdicts };
}

/// Every session id seen in scope: [prev] (a Set, kept by the caller across scans), the ids
/// (and replaced ids) of [graph]'s nodes, and the ids in [journal] (folded entries). Bounded
/// to the newest [max] ids, so a long-running authority does not grow it forever.
function knownIds(prev, graph, journal, max = 20000) {
  const s = new Set(prev instanceof Set ? prev : []);
  const add = (id) => { if (id) { s.delete(id); s.add(id); } };
  for (const e of Array.isArray(journal) ? journal : []) { add(e.id); for (const r of e.replaces || []) add(r); }
  for (const n of graph && Array.isArray(graph.nodes) ? graph.nodes : []) { add(n.id); for (const r of n.replaces) add(r); }
  if (s.size <= max) return s;
  return new Set([...s].slice(s.size - max));
}

// --- #467 R1 wake on fact, R2 tell an orphan ------------------------------------------------

/** The waits R1 may wake: the agent said it waits on itself or a third party, and named the
 *  target. A wait on the owner ("you") is R4's; "done" waits on nothing. */
const WAKE_ON = Object.freeze(['self', 'external']);
/** A wake's text, tag excluded, fits lib/safe-prompt.js's 511 bytes with the tag and a space. */
const TEXT_BYTES_MAX = 511 - Buffer.byteLength(SUPERVISOR_PROMPT_TAG, 'utf8') - 1;

/// Cut [s] to at most [max] UTF-8 bytes, on a character boundary, as one line.
function clipBytes(s, max) {
  let t = String(s || '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').trim();
  while (Buffer.byteLength(t, 'utf8') > max) t = t.slice(0, -1);
  return t;
}

/// Is [n]'s reported wait one R1 resolves?
function wakeable(n) {
  return Boolean(n && n.wait && WAKE_ON.includes(n.wait.on) && n.wait.target && Number.isFinite(n.wait.at));
}

/// The design's wake prompt (section 5 R1), within the prompt budget.
function wakeText(what, fact) {
  const w = clipBytes(what, 120) || 'your wait';
  const head = `Your wait "${w}" changed: `;
  const tail = '. Carry on, or report a new wait.';
  return head + clipBytes(fact, TEXT_BYTES_MAX - Buffer.byteLength(head + tail, 'utf8')) + tail;
}

/// R2's tell (section 5): the lead is gone, so nobody will answer as it.
function orphanText(parentId) {
  return `Your lead session ${String(parentId).slice(0, 8)} is gone from every machine (missing on two scans 5+ min apart). `
    + 'Nobody will answer as your lead: finish what you can on your own and report done, or report a wait that names what you still need.';
}

/// What the supervisor types this scan (R1 and R2). Pure: the caller delivers each one
/// through the gated prompt route of the session's own server, which re-checks every gate.
///   resolutions  { <id>: {state, fact} } for the wakeable nodes
///   verdicts     the orphan verdicts (noteOrphans)
///   done         Set of action keys already DELIVERED: one wake per wait, one tell per lead
///   acts         { <id>: [epoch ms of each delivered action] }
/// Returns `[{ key, id, server, rule, text, expectWaitAt }]`, at most one per session; a
/// session over its hourly budget gets nothing this scan.
function planActions({ graph, verdicts, resolutions, done, acts, now, cfg }) {
  const out = [];
  const seen = done instanceof Set ? done : new Set();
  const perHour = (cfg && cfg.actionsPerHour) || ACTIONS_PER_HOUR;
  const budgetLeft = (id) => ((acts && acts[id]) || []).filter((t) => now - t < 60 * 60 * 1000).length < perHour;
  for (const n of graph ? graph.nodes : []) {
    if (!budgetLeft(n.id)) continue;
    const res = resolutions && resolutions[n.id];
    if (wakeable(n) && res && (res.state === 'resolved' || res.state === 'gone')) {
      const key = `wake|${n.id}|${n.wait.at}`;
      if (!seen.has(key)) {
        out.push({ key, id: n.id, server: n.server, rule: 'R1', text: wakeText(n.wait.what, res.fact), expectWaitAt: n.wait.at });
        continue;
      }
    }
    const v = verdicts && verdicts[n.id];
    if (v && v.state === 'orphan') {
      // A wait that names the lead is told by R1 (its target is gone), never twice.
      const t = n.wait && n.wait.target;
      const namesLead = wakeable(n) && t && (t.kind === 'lead' || (t.kind === 'session' && t.id === v.parentId));
      const key = `orphan|${n.id}|${v.parentId}`;
      // A session that reported done has nothing left to be told about.
      const done = n.wait && n.wait.on === 'done';
      if (!namesLead && !done && !seen.has(key)) out.push({ key, id: n.id, server: n.server, rule: 'R2', text: orphanText(v.parentId), expectWaitAt: null });
    }
  }
  return out;
}

// --- #467 R4: waits on the owner reach the owner ------------------------------------------

/** A wait on the owner the supervisor pushes: a reported "you" wait whose turn has ended
 *  (lib/session-reason.js says so with source 'reported'). An approval or a question
 *  (source 'status') already pushes from its own server: it is counted, never pushed twice. */
function ownerWaitOf(n) {
  return Boolean(n && n.reason && n.reason.kind === 'you' && n.reason.source === 'reported'
    && n.wait && n.wait.on === 'you' && Number.isFinite(n.wait.at));
}

/// The owner ladder, one scan. [ladder] `{ "<id>|<waitAt>": {firstAt, lastAt, n, held} }`
/// from the scan before; [quiet] is lib/quiet-hours.js quietAt(now).quiet.
///   by day   a new wait pushes at once, then every remindEveryMs
///   quiet    a push that falls due is HELD (held: true): never sent, never dropped
///   after    the first scan out of quiet hours with anything held sends ONE summary
///            ("N things wait on you": every reason.kind 'you' in the cluster) instead of
///            one push per wait
/// A wait that is gone (answered, or replaced by a new report) leaves the ladder, so a new
/// report starts a new one. A wait merely OUT OF SIGHT keeps its place: a session that still
/// carries the same wait but reads working for a moment (a Monitor event, a task note), or one
/// on a server this scan missed - otherwise its return would push again at once, ignoring the
/// reminder interval. Only a complete scan that no longer lists the session drops it.
/// Returns `{ pushes: [{key, id, server, name, what, n}], summary, ladder }`.
/// #468: [extra] owner items that are not a reported wait - a case escalated to the owner,
/// a recommendation card - `[{key, id, server, name, what, at}]` (lib/supervisor-cases.js
/// ownerItems). They climb the same ladder: pushed at once by day, held at night, reminded.
function ownerPlan({ graph, ladder, quiet, now, cfg, extra = [] }) {
  const remind = (cfg && cfg.remindEveryMs) || REMIND_EVERY_MIN * 60 * 1000;
  const old = _isObj(ladder) ? ladder : {};
  const nodes = graph ? graph.nodes : [];
  const waits = nodes.filter(ownerWaitOf).sort((a, b) => a.wait.at - b.wait.at)
    .map((n) => ({ key: `${n.id}|${n.wait.at}`, id: n.id, server: n.server, name: n.name, what: n.wait.what, at: n.wait.at }))
    .concat((Array.isArray(extra) ? extra : []).filter((x) => x && typeof x.key === 'string'));
  const next = {};
  for (const w of waits) {
    const key = w.key;
    next[key] = old[key] ? { ...old[key] } : { firstAt: now, lastAt: null, n: 0, held: false };
    const e = next[key];
    if (quiet && (e.lastAt === null || now - e.lastAt >= remind)) e.held = true;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [key, e] of Object.entries(old)) {
    if (next[key]) continue;
    const [id, at] = key.split('|');
    const n = byId.get(id);
    const sameWait = n && n.wait && String(n.wait.at) === at && n.wait.on === 'you';
    // Kept through a scan that missed its server, but not for ever while a peer stays down.
    if (sameWait || (!n && !(graph && graph.complete) && now - e.firstAt < 7 * 24 * 60 * 60 * 1000)) next[key] = { ...e };
  }
  if (quiet) return { pushes: [], summary: null, ladder: next };
  const current = waits.map((w) => next[w.key]);
  if (current.some((e) => e.held)) {
    // Out of quiet hours with something held: one summary covers every wait waiting now.
    for (const e of current) { e.held = false; e.lastAt = now; e.n += 1; }
    const you = nodes.filter((n) => n.reason && n.reason.kind === 'you');
    const reported = waits.length - (Array.isArray(extra) ? extra.length : 0);
    const first = waits[0];
    return { pushes: [], summary: { count: Math.max(you.length, reported) + (waits.length - reported), id: first.id, server: first.server, name: first.name }, ladder: next };
  }
  const pushes = [];
  for (const w of waits) {
    const e = next[w.key];
    if (e.lastAt === null || now - e.lastAt >= remind) {
      e.lastAt = now; e.n += 1;
      pushes.push({ key: w.key, id: w.id, server: w.server, name: w.name, what: w.what, n: e.n });
    }
  }
  return { pushes, summary: null, ladder: next };
}

/// GET /api/supervisor/state on the authority. [graph] the last scan (null before the first),
/// [verdicts] its orphan verdicts, [journal] the folded journal (lib/session-journal.js).
/// #467: [resolutions] each wakeable session's target answer, [actions] what the supervisor
/// did (newest last: `{at, id, rule, text, outcome}`), [quiet] quietAt(now) - so every
/// action shows inline on the session it touched, and the page can say why nothing buzzed.
/// #468: [dispatch] `{cases, cards, dispatcher, autonomy}` - the open cases and the recent
/// closed ones, the recommendation cards, the dispatcher's state and each class's record -
/// served as they are (server.js shapes them from lib/supervisor-cases.js).
/// #469: [closeout] the last scan's lib/closeout.js closeoutPlan - its `ready` is the journal's
/// "Ready to close", its `needs` join "Needs you", and each session carries `closeoutState`.
function stateOf({ graph, verdicts, journal, cfg, now, resolutions = null, actions = null, quiet = null, dispatch = null, closeout = null }) {
  const acts = Array.isArray(actions) ? actions : [];
  const extra = { quiet: quiet || null, actions: acts.slice(-100).reverse(),
    ...(dispatch ? { cases: dispatch.cases || [], cards: dispatch.cards || [], dispatcher: dispatch.dispatcher || null, autonomy: dispatch.autonomy || null } : {}) };
  if (!graph) {
    return { role: 'authority', at: null, everyMs: cfg.everyMs, complete: false, servers: [],
      sessions: [], orphans: [], needsYou: [], live: [], readyToClose: [], history: [], ...extra };
  }
  const v = verdicts || {};
  const res = resolutions || {};
  const sessions = graph.nodes.map((n) => ({ ...n, orphan: v[n.id] || null,
    ...(res[n.id] ? { waitState: { state: res[n.id].state, fact: res[n.id].fact || '' } } : {}),
    supervisor: acts.filter((a) => a.id === n.id).slice(-5).reverse() }));
  const liveKeys = new Set(sessions.map((n) => `${n.server}|${n.id}`));
  const entries = Array.isArray(journal) ? journal : [];
  // Needs you: a reported "you" wait, oldest first (the longest wait on the owner on top),
  // then (#469) every close-out that is blocked, unanswered or asked too often.
  const co = closeout || { ready: null, needs: [], why: {} };
  const coNeeds = new Map((co.needs || []).map((x) => [x.id, x]));
  const needsYou = sessions.filter((n) => n.wait && n.wait.on === 'you')
    .sort((a, b) => (a.wait.at || 0) - (b.wait.at || 0)).map((n) => n.id)
    .concat([...coNeeds.keys()].filter((id) => sessions.some((n) => n.id === id)));
  // #479 - and every session holding a person's unsent draft nobody is typing: only the owner
  // can send it or clear it, and until then nothing the server types reaches that session.
  for (const n of sessions) if (n.composerDraft && !needsYou.includes(n.id)) needsYou.push(n.id);
  for (const n of sessions) {
    const x = coNeeds.get(n.id);
    if (x) n.closeoutState = { needs: x.why, left: x.left };
    else if (co.why && co.why[n.id]) n.closeoutState = { held: co.why[n.id] };
  }
  // Ready to close (#469): a clean close-out (lib/closeout.js closeoutPlan). Without a plan
  // (R5 not run yet, or switched off) it is phase 1's: reported done, idle, nobody looking.
  const readyToClose = Array.isArray(co.ready) ? co.ready.filter((id) => !coNeeds.has(id) && sessions.some((n) => n.id === id))
    : sessions.filter((n) => n.wait && n.wait.on === 'done' && n.status === 'idle' && !n.clients).map((n) => n.id);
  const live = sessions.filter((n) => !needsYou.includes(n.id) && !readyToClose.includes(n.id)).map((n) => n.id);
  // History: what ended, newest first. A live session's own entry stays out of it.
  const history = entries.filter((e) => e.closedAt && !liveKeys.has(e.key))
    .sort((a, b) => b.closedAt - a.closedAt).slice(0, JOURNAL_MAX);
  // Each live session's journal facts (opened when, by whom, through which path), by key.
  const opened = {};
  for (const e of entries) if (liveKeys.has(e.key) && !e.closedAt) opened[e.key] = { openedAt: e.openedAt, via: e.via, spawnedBy: e.spawnedBy };
  return {
    role: 'authority', at: graph.at, now, everyMs: cfg.everyMs, complete: graph.complete, servers: graph.servers,
    sessions: sessions.map((n) => ({ ...n, journal: opened[`${n.server}|${n.id}`] || null })),
    orphans: sessions.filter((n) => n.orphan && n.orphan.state === 'orphan').map((n) => n.id),
    needsYou, live, readyToClose, history, ...extra,
  };
}

module.exports = {
  ORPHAN_CONFIRM_MS, EVERY_MS, JOURNAL_MAX, REMIND_EVERY_MIN, ACTIONS_PER_HOUR, WAKE_ON, TEXT_BYTES_MAX,
  supervisorConfig, isExcluded, nodeOf, buildGraph, absenceStep, noteAbsent, noteOrphans, knownIds,
  clipBytes, wakeable, wakeText, orphanText, planActions, ownerWaitOf, ownerPlan, stateOf,
};
