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
const { refKey } = require('./session-brief');

const ORPHAN_CONFIRM_MS = 5 * 60 * 1000;
const EVERY_MS = 60 * 1000;
/** Folded journal entries served at most (newest first). */
const JOURNAL_MAX = 500;

const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _str = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);
const _id = (s) => (typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s) ? s.toLowerCase() : null);

/// `supervisor` from config.json. Absent = on (phase 1 only reads), at the authority only.
///   enabled    false switches it off
///   exclude    server names the supervisor ignores entirely (the MacBook)
///   everySec   seconds between polls (min 30)
function supervisorConfig(raw) {
  const c = _isObj(raw) ? raw : {};
  const every = Number.isFinite(c.everySec) ? Math.max(30, Math.floor(c.everySec)) * 1000 : EVERY_MS;
  const exclude = Array.isArray(c.exclude) ? c.exclude.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()) : [];
  return { enabled: c.enabled !== false, everyMs: every, exclude, orphanConfirmMs: ORPHAN_CONFIRM_MS };
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
    now: _str(b.now, 140),
    prompt: _str(b.prompt, 160),
    items: Array.isArray(b.items) ? b.items.slice(0, 6).filter(_isObj).map((i) => ({ ref: _str(i.ref, 60), title: _str(i.title, 140), state: _str(i.state, 20) })) : [],
    wait: w ? {
      on: _str(w.on, 20), what: _str(w.what, 80) || '', at: Number.isFinite(w.at) ? w.at : null,
      ...(t && t.target ? { target: t.target } : {}),
      ...(Number.isInteger(w.checkBy) ? { checkBy: w.checkBy } : {}),
    } : null,
    reason: _isObj(row.reason) && typeof row.reason.kind === 'string'
      ? { kind: _str(row.reason.kind, 20), text: _str(row.reason.text, 160) } : null,
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
    if (!graph.complete) {
      // Not a reading: keep whatever was seen, decide nothing.
      if (was) sightings[n.id] = was;
      verdicts[n.id] = { state: 'unknown', parentId: n.parentId, since: was ? was.firstAt : null };
      continue;
    }
    const s = was ? { ...was, lastAt: graph.at } : { parentId: n.parentId, firstAt: graph.at, lastAt: graph.at };
    sightings[n.id] = s;
    verdicts[n.id] = { state: graph.at - s.firstAt >= orphanConfirmMs ? 'orphan' : 'suspect', parentId: n.parentId, since: s.firstAt };
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

/// GET /api/supervisor/state on the authority. [graph] the last scan (null before the first),
/// [verdicts] its orphan verdicts, [journal] the folded journal (lib/session-journal.js).
function stateOf({ graph, verdicts, journal, cfg, now }) {
  if (!graph) {
    return { role: 'authority', at: null, everyMs: cfg.everyMs, complete: false, servers: [],
      sessions: [], orphans: [], needsYou: [], live: [], readyToClose: [], history: [] };
  }
  const v = verdicts || {};
  const sessions = graph.nodes.map((n) => ({ ...n, orphan: v[n.id] || null }));
  const liveKeys = new Set(sessions.map((n) => `${n.server}|${n.id}`));
  const entries = Array.isArray(journal) ? journal : [];
  // Needs you: a reported "you" wait, oldest first (the longest wait on the owner on top).
  const needsYou = sessions.filter((n) => n.wait && n.wait.on === 'you')
    .sort((a, b) => (a.wait.at || 0) - (b.wait.at || 0)).map((n) => n.id);
  // Ready to close: reported done, idle, nobody looking. Phase 4 adds the close-out audit.
  const readyToClose = sessions.filter((n) => n.wait && n.wait.on === 'done' && n.status === 'idle' && !n.clients).map((n) => n.id);
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
    needsYou, live, readyToClose, history,
  };
}

module.exports = {
  ORPHAN_CONFIRM_MS, EVERY_MS, JOURNAL_MAX,
  supervisorConfig, isExcluded, nodeOf, buildGraph, noteOrphans, knownIds, stateOf,
};
