'use strict';
// #558 - moving a session under another parent, and handing a session's children over to
// another session. The links are the #374 family (`spawn.parentId`, with `spawn.replaces`
// making a handed-off parent's old id an alias of its successor); the tree itself is
// lib/mc-tree.js's, the ONE rule for who is whose child. This module only answers the
// questions a MOVE asks of that tree: is the new parent a live session, would the move make
// a loop, and which sessions are the children being handed over.
//
// Pure: no I/O. server.js reads the cluster rows and writes the result.

const { buildTree } = require('./mc-tree');

/** Cluster session rows ({id, spawn: {parentId, replaces}, ...}) -> mc-tree nodes, each
 *  keeping its row. Rows without an id are dropped. */
function nodesOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string' && r.id).map((r) => ({
    id: r.id,
    parentId: (r.spawn && typeof r.spawn.parentId === 'string' && r.spawn.parentId) || null,
    replaces: r.spawn && Array.isArray(r.spawn.replaces) ? r.spawn.replaces : [],
    closed: false,
    row: r,
  }));
}

/** The family of every listed session. */
function familyOf(rows) {
  return buildTree(nodesOf(rows));
}

/**
 * Why [id] may NOT be moved under [parentId] (null = out from under any parent), or null when
 * it may. `{status, error}`:
 *   404 - [parentId] is no listed session (a typo would otherwise leave a dangling link that
 *         nothing draws, with nothing said; a parent on an unreachable peer is refused too:
 *         fail closed, try again when it answers)
 *   409 - [parentId] is [id] itself (or an id [id] replaced), or one of its descendants: the
 *         move would make a loop.
 * [id] itself need not be listed (the caller checks it lives on its own server).
 */
function moveRefusal(tree, id, parentId) {
  if (parentId === null) return null;
  const parent = tree.resolve(parentId);
  if (!parent) return { status: 404, error: 'the new parent is not a live session on any reachable server' };
  const self = tree.resolve(id);
  if (parent.id === id || parent === self) return { status: 409, error: 'a session cannot be its own parent' };
  if (self && tree.descendantsOf(self).includes(parent)) {
    return { status: 409, error: 'the new parent is under this session: the move would make a loop' };
  }
  return null;
}

/**
 * The children of [fromId] to hand over: every listed session drawn directly under it (under
 * its own id, or an id it replaced), or just the ones named in [only]. [fromId] need not be
 * listed: the children of a session that has closed still name it, and handing them on is
 * exactly what a closed parent's helpers need. `{ok:true, children: [rows]}` or
 * `{ok:false, status, error}` when [only] names a session that is not one of them.
 */
function childrenToMove(tree, rows, fromId, only = null) {
  const from = tree.resolve(fromId);
  const nodes = nodesOf(rows);
  const kids = from
    ? tree.childrenOf(from)
    : nodes.filter((n) => n.parentId === fromId).map((n) => tree.resolve(n.id)).filter(Boolean);
  if (only === null) return { ok: true, children: kids.map((n) => n.row) };
  const picked = [];
  for (const want of only) {
    const n = kids.find((k) => k.id === want);
    if (!n) return { ok: false, status: 400, error: `${want} is not a child of this session` };
    if (!picked.includes(n)) picked.push(n);
  }
  return { ok: true, children: picked.map((n) => n.row) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most children one hand-over names. */
const CHILDREN_MAX = 50;

/** `children` on POST /api/sessions/:id/children/move: absent/null = all of them, else a list
 *  of session ids. `{ok, ids}` (ids null = all) or `{ok:false, error}`. Refused, never
 *  filtered: dropping a malformed id would move fewer sessions than were asked for. */
function childrenListOf(raw) {
  if (raw === undefined || raw === null) return { ok: true, ids: null };
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'children must be a non-empty list of session ids, or left out to move all of them' };
  if (raw.length > CHILDREN_MAX) return { ok: false, error: `children must name at most ${CHILDREN_MAX} sessions` };
  if (!raw.every((x) => typeof x === 'string' && UUID_RE.test(x))) return { ok: false, error: 'children must be session ids' };
  return { ok: true, ids: raw.map((x) => x.toLowerCase()) };
}

/** The answer's status for a hand-over: 200 when every child moved (or there were none), the
 *  one refusal's status when exactly one was asked for, 207 when some moved and some did not,
 *  502 when none did. */
function moveStatus(moved, failed) {
  if (!failed.length) return 200;
  if (!moved.length && failed.length === 1) return failed[0].status || 502;
  return moved.length ? 207 : 502;
}

module.exports = { familyOf, moveRefusal, childrenToMove, childrenListOf, moveStatus, CHILDREN_MAX };
