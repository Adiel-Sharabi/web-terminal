'use strict';
// #412 - cluster resource leases: one queue for AM8 slots, test VMs, office controllers
// and build turns, so two sessions on two machines cannot both take vm:X, and a session
// that dies cannot hold a resource forever.
//
// ## One authority
//
// Exactly one server (config `leases.authority`, normally Office) owns the table; every
// other peer forwards its lease calls there over the cluster's own bearer tokens
// (lib/lease-broker.js). An authority that cannot be reached means NO new lease - fail
// closed - while whoever already holds one keeps going: nothing on a holder's machine is
// stopped because the broker went quiet, and a returning authority restarts every
// heartbeat clock (resume) rather than expiring the holders it could not hear.
//
// ## Every way a lease ends
//
//   released      - DELETE by the holder
//   ttl           - the lease's lifetime ran out (a heartbeat with ttlSec extends it)
//   heartbeat     - no heartbeat for HEARTBEAT_MISSES intervals (heartbeatSec > 0 only)
//   holder-ended  - the holder's session ended: closed, reaped (#351) or crashed. Told at
//                   once by the holder's server when it sees the exit, and confirmed by a
//                   liveness read of that server's session list on every sweep.
//
// When a held lease ends, the oldest waiter for that resource is granted (FIFO). A waiter
// can end the same ways (its heartbeat, its session), and is then simply dropped.
//
// A lease whose holder names a session on a machine the authority can check needs no
// heartbeat (heartbeatSec 0 is its default): the session's own life vouches for it, which
// is what an agent - who has no background loop to beat with - can actually give. A
// holder the authority cannot check must heartbeat.
//
// This module is the pure rule. lib/lease-broker.js owns the file, the network and the
// clock; lib/lease-cleanup.js owns what is killed and removed on release.

const { spawnedByLabel } = require('./spawn-reaper');

const RESOURCE_RE = /^(slot|vm|controller|build):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_NAME_MAX = 64;
const DRIVE_RE = /^[A-Z]:$/;

const DEFAULTS = Object.freeze({ ttlSec: 3600, heartbeatSec: 60 });
const LIMITS = Object.freeze({
  ttlMinSec: 30, ttlMaxSec: 24 * 3600,
  heartbeatMinSec: 10, heartbeatMaxSec: 3600,
  maxLeases: 500, maxQueue: 50, metaMaxBytes: 2048,
  releasedKeep: 50, releasedKeepMs: 24 * 3600 * 1000,
  memGBMax: 4096, diskGBMax: 1024 * 1024,
});
/** A heartbeat lease is lost after this many intervals of silence. */
const HEARTBEAT_MISSES = 3;
const STATE_VERSION = 1;
const GB = 1024 * 1024 * 1024;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (error, status = 400) => ({ ok: false, status, error });

function normUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  return u.replace(/\/+$/, '').toLowerCase();
}

/** A new, empty table. [tableId] names THIS table for good: a lease is only ever declared
 *  ended by the table that granted it, so a deleted or replaced table (a new id) can never
 *  make a peer clean up work it never heard of. */
function emptyState(tableId) { return { version: STATE_VERSION, tableId: String(tableId), leases: [], released: [] }; }

function isResource(r) { return typeof r === 'string' && RESOURCE_RE.test(r); }
function isLeaseId(id) { return typeof id === 'string' && UUID_RE.test(id); }

function intIn(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

/**
 * A POST /api/leases body -> the request the table takes, or a refusal that says why.
 * `holderNode` is the broker's verdict on WHERE the holder lives: 'self', a peer's
 * normalised url, or null when the authority has no way to check that machine.
 * Nothing is coerced: a string where a number belongs is refused, never parsed.
 */
function parseRequest(body, { holderNode = 'self', holderServer = null } = {}) {
  if (!isPlainObject(body)) return bad('the body must be a JSON object');
  if (!isResource(body.resource)) return bad('resource must be slot:|vm:|controller:|build: and a name of letters, digits, . _ - (max 64)');
  let ttlSec = DEFAULTS.ttlSec;
  if (body.ttlSec !== undefined) {
    if (!intIn(body.ttlSec, LIMITS.ttlMinSec, LIMITS.ttlMaxSec)) return bad(`ttlSec must be a whole number from ${LIMITS.ttlMinSec} to ${LIMITS.ttlMaxSec}`);
    ttlSec = body.ttlSec;
  }
  let sessionId = null;
  if (body.holderSessionId !== undefined && body.holderSessionId !== null) {
    if (!isLeaseId(body.holderSessionId)) return bad('holderSessionId must be a session id');
    sessionId = body.holderSessionId.toLowerCase();
  }
  const checkable = !!sessionId && holderNode !== null;
  let heartbeatSec = checkable ? 0 : DEFAULTS.heartbeatSec;
  if (body.heartbeatSec !== undefined) {
    if (body.heartbeatSec === 0) {
      if (!checkable) return bad('heartbeatSec 0 needs a holderSessionId on a machine the authority can check');
      heartbeatSec = 0;
    } else if (!intIn(body.heartbeatSec, LIMITS.heartbeatMinSec, LIMITS.heartbeatMaxSec)) {
      return bad(`heartbeatSec must be 0 or a whole number from ${LIMITS.heartbeatMinSec} to ${LIMITS.heartbeatMaxSec}`);
    } else heartbeatSec = body.heartbeatSec;
  }
  let role = null;
  if (body.role !== undefined && body.role !== null) {
    if (typeof body.role !== 'string' || !ROLE_RE.test(body.role)) return bad('role must be lower-case letters, digits and - (max 32)');
    role = body.role;
  }
  let meta = null;
  if (body.meta !== undefined && body.meta !== null) {
    if (!isPlainObject(body.meta)) return bad('meta must be a JSON object');
    if (Buffer.byteLength(JSON.stringify(body.meta), 'utf8') > LIMITS.metaMaxBytes) return bad(`meta must be at most ${LIMITS.metaMaxBytes} bytes of JSON`);
    meta = clone(body.meta);
  }
  // A peer's name is display text from the request: the #351 label rule strips the control,
  // bidi and zero-width characters that could forge a log line or reorder a row.
  const label = spawnedByLabel(holderServer);
  const server = label ? Array.from(label).slice(0, SERVER_NAME_MAX).join('') : null;
  return { ok: true, req: { resource: body.resource, ttlSec, heartbeatSec, sessionId, role, meta, node: holderNode, server } };
}

/**
 * The reserved-resource registry from config `leases.resources`:
 *   { "vm:AM8-SanityVM": { "reservedFor": "release" }, "vm:ci-vm-1": { "neverLease": true } }
 * ANY malformed entry makes the whole registry unreadable - a typo must never silently
 * turn a never-lease VM into a leasable one - and the broker then refuses every lease.
 */
function registryOf(raw) {
  if (raw === undefined || raw === null) return { ok: true, entries: new Map() };
  if (!isPlainObject(raw)) return { ok: false, error: 'leases.resources must be an object' };
  const entries = new Map();
  for (const [id, e] of Object.entries(raw)) {
    if (!isResource(id)) return { ok: false, error: `leases.resources: "${String(id).slice(0, 80)}" is not a resource id` };
    if (!isPlainObject(e)) return { ok: false, error: `leases.resources["${id}"] must be an object` };
    for (const k of Object.keys(e)) if (k !== 'reservedFor' && k !== 'neverLease' && k !== 'note') return { ok: false, error: `leases.resources["${id}"]: unknown field "${k.slice(0, 40)}"` };
    if (e.neverLease !== undefined && typeof e.neverLease !== 'boolean') return { ok: false, error: `leases.resources["${id}"].neverLease must be true or false` };
    if (e.reservedFor !== undefined && (typeof e.reservedFor !== 'string' || !ROLE_RE.test(e.reservedFor))) return { ok: false, error: `leases.resources["${id}"].reservedFor must be a role name` };
    entries.set(id, { neverLease: e.neverLease === true, reservedFor: e.reservedFor || null });
  }
  return { ok: true, entries };
}

/** Null when [resource] may be leased by [role]; otherwise the 403 that says why. */
function admit(resource, role, entries) {
  const e = entries && entries.get(resource);
  if (!e) return null;
  if (e.neverLease) return { status: 403, error: `${resource} is never leased` };
  if (e.reservedFor && role !== e.reservedFor) return { status: 403, error: `${resource} is reserved for the "${e.reservedFor}" role` };
  return null;
}

/** Where the authority is, from config `leases` plus the cluster list and this server's own
 *  url and name. The same config on every box names the same server; on that server it
 *  resolves to 'self'. */
function resolveAuthority(leasesCfg, cluster, publicUrl, serverName) {
  if (!isPlainObject(leasesCfg) || leasesCfg.authority === undefined || leasesCfg.authority === null || leasesCfg.authority === '') return { mode: 'none' };
  const want = leasesCfg.authority;
  if (typeof want !== 'string') return { mode: 'invalid', error: 'leases.authority must be a server name' };
  if (want.toLowerCase() === 'self') return { mode: 'self' };
  // Our own name first: a box whose publicUrl is unset (or spelled differently from its cluster
  // entry) would otherwise resolve itself as a peer and forward to itself forever.
  if (typeof serverName === 'string' && serverName.toLowerCase() === want.toLowerCase()) return { mode: 'self' };
  const me = normUrl(publicUrl);
  const hit = (Array.isArray(cluster) ? cluster : []).find((c) => c && typeof c.name === 'string' && c.name.toLowerCase() === want.toLowerCase());
  if (hit && typeof hit.url === 'string' && hit.url) {
    if (me && normUrl(hit.url) === me) return { mode: 'self' };
    return { mode: 'remote', name: hit.name, url: hit.url.replace(/\/+$/, '') };
  }
  return { mode: 'invalid', error: `leases.authority "${want.slice(0, 64)}" is not in this server's cluster list` };
}

/** The holder's machine as the authority can reach it: 'self' (no stamp - the caller is
 *  local), a peer url from the authority's OWN cluster list, or null (unknown: never
 *  fetched, so a forged url cannot make the authority call out anywhere). */
function holderNodeOf(holderServer, cluster, publicUrl) {
  if (holderServer === undefined || holderServer === null) return 'self';
  if (!isPlainObject(holderServer)) return null;
  const u = normUrl(holderServer.url);
  if (!u) return null;
  if (u === normUrl(publicUrl)) return 'self';
  const hit = (Array.isArray(cluster) ? cluster : []).find((c) => c && normUrl(c.url) === u);
  return hit ? u : null;
}

// --- the table -----------------------------------------------------------------------

const LEASE_FIELDS = ['id', 'resource', 'state', 'holder', 'ttlSec', 'heartbeatSec', 'requestedAt', 'lastHeartbeatAt'];

/** The persisted file -> state. Anything off is UNREADABLE (ok:false), never an empty
 *  table: an authority that forgot its leases would grant every held VM again, and every
 *  peer would clean up its holders' processes on the next reconcile. */
function parseState(raw) {
  if (!isPlainObject(raw) || raw.version !== STATE_VERSION || typeof raw.tableId !== 'string' || !raw.tableId || !Array.isArray(raw.leases) || !Array.isArray(raw.released)) return { ok: false };
  for (const l of raw.leases) {
    if (!isPlainObject(l) || LEASE_FIELDS.some((k) => l[k] === undefined)) return { ok: false };
    if (!isLeaseId(l.id) || !isResource(l.resource) || (l.state !== 'held' && l.state !== 'queued') || !isPlainObject(l.holder)) return { ok: false };
    if (!finite(l.ttlSec) || !finite(l.heartbeatSec) || !finite(l.requestedAt) || !finite(l.lastHeartbeatAt)) return { ok: false };
    if (l.state === 'held' && (!finite(l.grantedAt) || !finite(l.expiresAt))) return { ok: false };
  }
  return { ok: true, state: clone(raw) };
}

function heldOf(state, resource) { return state.leases.find((l) => l.resource === resource && l.state === 'held') || null; }

/** 0 for the holder, 1.. for a waiter's place in the queue, null when unknown. */
function positionOf(state, id) {
  const l = state.leases.find((x) => x.id === id);
  if (!l) return null;
  if (l.state === 'held') return 0;
  return state.leases.filter((x) => x.resource === l.resource && x.state === 'queued').findIndex((x) => x.id === id) + 1;
}

function grantLease(l, now) {
  l.state = 'held';
  l.grantedAt = now;
  l.expiresAt = now + l.ttlSec * 1000;
  l.lastHeartbeatAt = now;
}

/** Grant the oldest waiter of every resource nobody holds. Array order IS arrival order. */
function fill(state, now) {
  const granted = [];
  for (const l of state.leases) {
    if (l.state !== 'queued' || heldOf(state, l.resource)) continue;
    grantLease(l, now);
    granted.push(clone(l));
  }
  return granted;
}

function remember(state, l, why, now) {
  state.released.unshift({ id: l.id, resource: l.resource, holder: clone(l.holder), state: l.state, why, at: now, grantedAt: l.grantedAt || null });
  state.released = state.released.filter((r) => now - r.at < LIMITS.releasedKeepMs).slice(0, LIMITS.releasedKeep);
}

/** Remove every lease [pick] selects, remember why, then grant what that freed. */
function drop(state, pick, why, now) {
  const s = clone(state);
  const released = [];
  s.leases = s.leases.filter((l) => {
    const w = pick(l);
    if (!w) return true;
    const reason = typeof w === 'string' ? w : why;
    remember(s, l, reason, now);
    released.push({ ...clone(l), why: reason });
    return false;
  });
  const granted = released.length ? fill(s, now) : [];
  return { state: released.length ? s : state, released, granted };
}

/** Ask for [req.resource]. Granted when free, queued (FIFO) otherwise. The same checkable
 *  holder asking again gets its own lease back. `newId` makes the lease id. */
function request(state, req, now, newId) {
  if (req.sessionId) {
    const mine = state.leases.find((l) => l.resource === req.resource && l.holder.sessionId === req.sessionId && l.holder.node === req.node);
    if (mine) return { state, lease: clone(mine), existing: true };
  }
  if (state.leases.length >= LIMITS.maxLeases) return { status: 429, error: `the lease table is full (${LIMITS.maxLeases})` };
  const queued = state.leases.filter((l) => l.resource === req.resource && l.state === 'queued').length;
  if (heldOf(state, req.resource) && queued >= LIMITS.maxQueue) return { status: 429, error: `${req.resource} already has ${LIMITS.maxQueue} waiters` };
  const s = clone(state);
  const l = {
    id: newId(), resource: req.resource, state: 'queued',
    holder: { node: req.node, server: req.server || null, sessionId: req.sessionId },
    role: req.role, meta: req.meta, ttlSec: req.ttlSec, heartbeatSec: req.heartbeatSec,
    requestedAt: now, grantedAt: null, expiresAt: null, lastHeartbeatAt: now,
  };
  s.leases.push(l);
  fill(s, now);
  return { state: s, lease: clone(s.leases.find((x) => x.id === l.id)), existing: false };
}

/** A sign of life. With [ttlSec], a held lease's expiry moves to now + ttlSec (a waiter
 *  keeps it for when it is granted). */
function heartbeat(state, id, now, ttlSec) {
  if (ttlSec !== undefined && !intIn(ttlSec, LIMITS.ttlMinSec, LIMITS.ttlMaxSec)) return { status: 400, error: `ttlSec must be a whole number from ${LIMITS.ttlMinSec} to ${LIMITS.ttlMaxSec}` };
  const i = state.leases.findIndex((l) => l.id === id);
  if (i < 0) return { status: 404, error: 'no such lease', released: releasedOf(state, id) };
  const s = clone(state);
  const l = s.leases[i];
  l.lastHeartbeatAt = now;
  if (ttlSec !== undefined) {
    l.ttlSec = ttlSec;
    if (l.state === 'held') l.expiresAt = now + ttlSec * 1000;
  }
  return { state: s, lease: clone(l) };
}

/** Is [caller] - {node, sessionId}: where the call came from (holderNodeOf) and the session
 *  it names - NOT lease [id]'s holder? -> {status:403, error} when it is not, else null (an
 *  unknown lease is null: release/heartbeat answer that 404). The holder is the same machine
 *  AND the same session; a lease taken with no session is its machine's, held by a caller
 *  there that names none. The authority's own endings (TTL, heartbeat, holder-ended) never
 *  ask this. It stops one session ending another's lease by mistake; it is not a credential -
 *  every caller already holds a token that can run anything on the machine. */
function notHolder(state, id, caller) {
  const l = state.leases.find((x) => x.id === id);
  if (!l) return null;
  const c = caller || {};
  const sid = typeof c.sessionId === 'string' ? c.sessionId.toLowerCase() : null;
  if (c.node !== undefined && c.node !== null && c.node === l.holder.node && sid === (l.holder.sessionId || null)) return null;
  const who = `${l.holder.server || '?'}${l.holder.sessionId ? ` session ${l.holder.sessionId.slice(0, 8)}` : ' (no session)'}`;
  return { status: 403, error: `lease ${id.slice(0, 8)} is held by ${who}; only its holder may release it or heartbeat it (from its own machine, naming its session)` };
}

function release(state, id, why, now) {
  if (!state.leases.some((l) => l.id === id)) return { status: 404, error: 'no such lease', released: releasedOf(state, id) };
  const r = drop(state, (l) => l.id === id, why, now);
  return { state: r.state, released: r.released[0], granted: r.granted };
}

/** Expiry and lost heartbeats, then fill. Cheap: run it on every tick and before a read. */
function sweep(state, now) {
  return drop(state, (l) => {
    if (l.state === 'held' && now >= l.expiresAt) return 'ttl';
    if (l.heartbeatSec > 0 && now - l.lastHeartbeatAt > l.heartbeatSec * HEARTBEAT_MISSES * 1000) return 'heartbeat';
    return false;
  }, null, now);
}

/** The holder's server saw session [sessionId] end. */
function holderEnded(state, node, sessionId, now) {
  if (!sessionId) return { state, released: [], granted: [] };
  const sid = String(sessionId).toLowerCase();
  return drop(state, (l) => l.holder.node === node && l.holder.sessionId === sid, 'holder-ended', now);
}

/** A hand-off (#340/#345): session [fromSid] on [node] ended because [toSid] took over its
 *  work. Its leases - held or waiting - move to the successor instead of ending; nothing is
 *  granted, nothing is cleaned up. */
function transferHolder(state, node, fromSid, toSid) {
  const from = String(fromSid || '').toLowerCase();
  const to = String(toSid || '').toLowerCase();
  if (!isLeaseId(from) || !isLeaseId(to)) return { state, moved: [] };
  const s = clone(state);
  const moved = [];
  for (const l of s.leases) {
    if (l.holder.node === node && l.holder.sessionId === from) { l.holder.sessionId = to; moved.push(l.id); }
  }
  return { state: moved.length ? s : state, moved };
}

/** A read of [node]'s live session ids, taken at [readAt]. Null (the read failed) releases
 *  nobody, and neither does a lease asked for AFTER the read began: its session may simply
 *  be younger than the list. */
function liveness(state, node, aliveIds, now, readAt = now) {
  if (!(aliveIds instanceof Set)) return { state, released: [], granted: [] };
  return drop(state, (l) => l.holder.node === node && !!l.holder.sessionId && l.requestedAt <= readAt && !aliveIds.has(l.holder.sessionId), 'holder-ended', now);
}

/** node -> the session ids it holds leases for: what one liveness sweep has to read. */
function liveSessionsByNode(state) {
  const out = new Map();
  for (const l of state.leases) {
    if (!l.holder.sessionId || !l.holder.node) continue;
    if (!out.has(l.holder.node)) out.set(l.holder.node, new Set());
    out.get(l.holder.node).add(l.holder.sessionId);
  }
  return out;
}

/** The authority is back: whatever silence it could not hear is not the holders' fault. */
function resume(state, now) {
  const s = clone(state);
  for (const l of s.leases) l.lastHeartbeatAt = Math.max(l.lastHeartbeatAt, now);
  return s;
}

function releasedOf(state, id) { return state.released.find((r) => r.id === id) || null; }

/** What a caller may see of a lease. `node` stays inside: it is the authority's own
 *  routing fact. */
function publicLease(state, l, now) {
  const out = {
    id: l.id, resource: l.resource, state: l.state, position: positionOf(state, l.id),
    holder: { server: l.holder.server, sessionId: l.holder.sessionId },
    role: l.role, meta: l.meta, ttlSec: l.ttlSec, heartbeatSec: l.heartbeatSec,
    requestedAt: l.requestedAt, grantedAt: l.grantedAt, expiresAt: l.expiresAt, lastHeartbeatAt: l.lastHeartbeatAt,
  };
  if (l.state === 'held') out.heldForSec = Math.max(0, Math.round((now - l.grantedAt) / 1000));
  else out.waitingForSec = Math.max(0, Math.round((now - l.requestedAt) / 1000));
  return out;
}

function lookup(state, id) {
  const l = state.leases.find((x) => x.id === id);
  if (l) return { lease: l };
  const r = releasedOf(state, id);
  return r ? { released: r } : null;
}

/** The dashboard: per resource, who holds it and who waits, with for how long. */
function listing(state, now) {
  const byRes = new Map();
  for (const l of state.leases) {
    if (!byRes.has(l.resource)) byRes.set(l.resource, { resource: l.resource, holder: null, queue: [] });
    const row = byRes.get(l.resource);
    if (l.state === 'held') row.holder = publicLease(state, l, now);
    else row.queue.push(publicLease(state, l, now));
  }
  return {
    resources: [...byRes.values()].sort((a, b) => a.resource.localeCompare(b.resource)),
    released: state.released.map((r) => ({ id: r.id, resource: r.resource, holder: { server: r.holder.server, sessionId: r.holder.sessionId }, why: r.why, at: r.at })),
  };
}

// --- admission (not a lease) ------------------------------------------------------------

/** `needs: {memGB?, diskGB?, drive?}` -> checked needs, null for none, or a refusal. */
function parseNeeds(raw) {
  if (raw === undefined || raw === null) return { ok: true, needs: null };
  if (!isPlainObject(raw)) return bad('needs must be an object');
  for (const k of Object.keys(raw)) if (!['memGB', 'diskGB', 'drive'].includes(k)) return bad(`needs: unknown field "${k.slice(0, 40)}"`);
  const num = (v, max) => v === undefined || (finite(v) && v > 0 && v <= max);
  if (!num(raw.memGB, LIMITS.memGBMax)) return bad('needs.memGB must be a positive number');
  if (!num(raw.diskGB, LIMITS.diskGBMax)) return bad('needs.diskGB must be a positive number');
  if (raw.drive !== undefined && (typeof raw.drive !== 'string' || !DRIVE_RE.test(raw.drive))) return bad('needs.drive must be a drive letter like "C:"');
  return { ok: true, needs: { memGB: raw.memGB ?? null, diskGB: raw.diskGB ?? null, drive: raw.drive || null } };
}

/** Does this machine (a GET /api/machine body) have what [needs] asks? A reading that could
 *  not be taken refuses: "unknown" is not "enough". */
function admission(needs, machine, defaultDrive) {
  const reasons = [];
  if (!needs) return { ok: true, reasons };
  const gb = (b) => (b / GB).toFixed(1);
  if (needs.memGB !== null) {
    const avail = machine && machine.memory && finite(machine.memory.availBytes) ? machine.memory.availBytes : null;
    if (avail === null) reasons.push('free memory is unknown on this machine');
    else if (avail < needs.memGB * GB) reasons.push(`memory: ${gb(avail)} GB free, ${needs.memGB} needed`);
  }
  if (needs.diskGB !== null) {
    const drive = needs.drive || defaultDrive || 'C:';
    const disks = machine && Array.isArray(machine.disks) ? machine.disks : null;
    const d = disks ? disks.find((x) => x && x.root === drive) : null;
    if (!disks) reasons.push('free disk is unknown on this machine');
    else if (!d || !finite(d.freeBytes)) reasons.push(`disk: ${drive} is unknown on this machine`);
    else if (d.freeBytes < needs.diskGB * GB) reasons.push(`disk: ${drive} has ${gb(d.freeBytes)} GB free, ${needs.diskGB} needed`);
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  DEFAULTS, LIMITS, HEARTBEAT_MISSES, RESOURCE_RE,
  normUrl, isResource, isLeaseId, emptyState, parseState, parseRequest, registryOf, admit,
  resolveAuthority, holderNodeOf, request, heartbeat, notHolder, release, sweep, holderEnded, liveness,
  liveSessionsByNode, resume, transferHolder, positionOf, lookup, listing, publicLease, parseNeeds, admission,
};
