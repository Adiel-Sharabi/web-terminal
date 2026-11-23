'use strict';
// #504 - Mission Control: who opened which session, across every server.
//
// The server-side port of the companion's `ai-terminal/lib/util/session_tree.dart` (#374,
// #380), which stays the owner for the old screens (session list, dashboard). Mission
// Control screens render THIS module's answer (`parentId`, runs) and never re-derive it
// (docs/mission-control.md "Subjects"), so for MC there is one rule, here.
//
// The rule, as there: a session's parent is `spawn.parentId`, looked up across EVERY server
// (ids are UUIDs, unique in the cluster); a parent handed off to a fresh session is found
// under its new id through the successor's `spawn.replaces`. The links come from callers, so
// nothing here trusts them to form a tree: a session naming itself, or a loop, is visited
// once and never recursed into forever.
//
// One addition MC needs and the old screens do not: CLOSED sessions (the closed strip, kept
// a week) are nodes too, so a run whose children already finished still groups them. A
// closed record only fills a gap - a live session always wins an id, and a successor (live,
// or closed itself) wins its predecessor's id over that predecessor's own closed record.
//
// Pure: no I/O.

/** `nodes`: [{id, parentId, replaces: [ids], closed: bool, ...}] in list order. */
function buildTree(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && typeof n.id === 'string' && n.id);
  const byId = new Map();
  const put = (id, n) => { if (typeof id === 'string' && id && !byId.has(id)) byId.set(id, n); };
  const live = list.filter((n) => !n.closed);
  // Newest first: of two closed records naming one id, the later hand-off holds it.
  const closed = list.filter((n) => n.closed).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  for (const n of live) put(n.id, n);
  for (const n of live) for (const old of n.replaces || []) put(old, n);
  // A closed successor takes the ids it replaced BEFORE closed records take their own: a run
  // handed off and then finished stays one run (the predecessor's record no longer holds it).
  for (const n of closed) for (const old of n.replaces || []) put(old, n);
  for (const n of closed) put(n.id, n);

  /** The session that opened `n`, when it is known and listed. */
  const parentOf = (n) => {
    const id = n && n.parentId;
    if (typeof id !== 'string' || !id) return null;
    const p = byId.get(id);
    return p && p !== n ? p : null;
  };
  const children = new Map();
  for (const n of list) {
    const p = parentOf(n);
    if (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(n); }
  }
  const childrenOf = (n) => children.get(n) || [];

  /** Everything under `n`, at any depth, parent before child. A loop ends where it closes. */
  function descendantsOf(n) {
    const out = [];
    const seen = new Set([n]);
    const walk = (p) => {
      for (const c of childrenOf(p)) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        walk(c);
      }
    };
    walk(n);
    return out;
  }

  /** Who opened `n`, who opened that, ... nearest first. A loop ends at the first repeat. */
  function ancestorsOf(n) {
    const out = [];
    const seen = new Set([n]);
    for (let p = parentOf(n); p && !seen.has(p); p = parentOf(p)) { seen.add(p); out.push(p); }
    return out;
  }

  /** The node listed under `id` (its own, or the successor it was handed off to). */
  const resolve = (id) => (typeof id === 'string' ? byId.get(id) || null : null);

  /** Sessions no listed session opened. A loop has no root: its first member in list
   *  order is made one, so every node belongs to exactly one root's family. */
  function roots() {
    const out = list.filter((n) => !parentOf(n));
    const placed = new Set();
    for (const r of out) { placed.add(r); for (const d of descendantsOf(r)) placed.add(d); }
    for (const n of list) {
      if (placed.has(n)) continue;
      out.push(n);
      placed.add(n);
      for (const d of descendantsOf(n)) placed.add(d);
    }
    return out;
  }

  return { parentOf, childrenOf, descendantsOf, ancestorsOf, resolve, roots };
}

module.exports = { buildTree };
