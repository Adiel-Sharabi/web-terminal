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

/** The statuses a REFUSAL of one move carries (lib's own moveRefusal/childrenToMove, or the
 *  same answer from a peer's PATCH). Anything else a peer answers - a 401 for our token, a 5xx -
 *  is that peer's trouble, never this server's verdict on the caller's request. */
const REFUSAL_STATUSES = new Set([400, 404, 409]);

/**
 * #558 - how ONE child of a hand-over is moved: `{local: true}` (this server writes it),
 * `{url, token}` (forward to the owning peer), or `{fail: {status, error}}`.
 * [child] is a cluster row (`serverUrl` null for this server's own); [servers] the cluster
 * view's servers[]; [tokens] cluster-tokens.json. Fails closed: a peer that does not advertise
 * `session-parent` would 404 the route, which must never read as "that session is gone".
 */
function forwardPlan(child, servers, tokens) {
  if (!child || typeof child.id !== 'string' || !UUID_RE.test(child.id)) {
    return { fail: { status: 502, error: 'that server listed a malformed session id' } };
  }
  if (!child.serverUrl) return { local: true };
  const peer = (Array.isArray(servers) ? servers : []).find((x) => x && x.url === child.serverUrl);
  if (!peer || !Array.isArray(peer.capabilities) || !peer.capabilities.includes('session-parent')) {
    return { fail: { status: 501, error: 'that server cannot move sessions yet (update it)' } };
  }
  const entry = tokens && tokens[child.serverUrl];
  const token = entry && (typeof entry === 'string' ? entry : entry.token);
  if (!token) return { fail: { status: 502, error: 'no token for that server' } };
  return { url: `${child.serverUrl}/api/sessions/${child.id}/parent`, token };
}

/** A peer's answer to a forwarded PATCH -> `{ok:true, parentId}` or `{ok:false, status, error}`.
 *  A refusal (400/404/409) keeps its status and reason; a 401/403 means the peer refused THIS
 *  server's token (never the caller's: passing it on would tell the app its own login is
 *  wrong); anything else is a failure of that server (502). */
function peerAnswer(status, body, fallbackParent) {
  let j = {};
  try { j = typeof body === 'string' ? JSON.parse(body) : (body || {}); } catch { /* not JSON */ }
  if (status === 200) return { ok: true, parentId: j.parentId === undefined ? fallbackParent : j.parentId };
  if (REFUSAL_STATUSES.has(status)) return { ok: false, status, error: (j && j.error) || `HTTP ${status}` };
  if (status === 401 || status === 403) return { ok: false, status: 502, error: "that server refused this server's token" };
  return { ok: false, status: 502, error: `that server failed (HTTP ${status})` };
}

/** The servers of the cluster view a hand-over could not see into: offline, or refusing our
 *  token. Their sessions are not listed, so their children of the session cannot be moved -
 *  and must be SAID to be missing, never silently left behind. Names, this server excluded. */
function unreachableServers(servers) {
  return (Array.isArray(servers) ? servers : [])
    .filter((x) => x && x.url && (x.online === false || x.needsAuth === true))
    .map((x) => x.name || x.url);
}

/** The answer's status for a hand-over: 200 when every child moved (or there were none) and
 *  every server was seen; the one REFUSAL's status when exactly one child was asked about and
 *  refused; 207 when the result is partial (some failed, or a server could not be seen); 502
 *  when nothing moved and something failed. */
function moveStatus(moved, failed, unreachable = []) {
  if (!failed.length) return unreachable.length ? 207 : 200;
  if (!moved.length && failed.length === 1 && !unreachable.length) {
    return REFUSAL_STATUSES.has(failed[0].status) ? failed[0].status : 502;
  }
  return moved.length ? 207 : 502;
}

module.exports = {
  familyOf, moveRefusal, childrenToMove, childrenListOf, forwardPlan, peerAnswer, unreachableServers, moveStatus, CHILDREN_MAX,
};
