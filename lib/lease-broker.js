'use strict';
// #412 - the lease broker's I/O: the state file, the forward to the authority, the sweeps
// and the cleanup ledger. The rules are lib/leases.js (the table) and lib/lease-cleanup.js
// (what release kills and removes); server.js only registers the routes and hands this
// module its sockets and readers (deps below), so the wiring is testable on its own.
//
// ## Who answers what
//
//   authority routes  POST /api/leases, GET /api/leases[/:id], POST /api/leases/:id/heartbeat,
//                     DELETE /api/leases/:id, POST /api/leases/holder-ended
//                     (DELETE and heartbeat: only the lease's holder - its machine, and the
//                      session it names as holderSessionId - else 403; L.notHolder)
//                     -> answered by the authority; any other server FORWARDS them there
//                        with its cluster bearer token, stamping who it is (holderServer).
//                        Unreachable authority: 503, nothing granted (fail closed).
//   local routes      GET /api/leases/local-sessions  (the authority's liveness read)
//                     POST /api/leases/:id/record     (pids/paths this machine will clean)
//                     GET /api/leases/records
//                     POST /api/leases/released-notice (a hint: re-check that lease now)
//                     GET /api/admission              (needs: memGB/diskGB vs this machine)
//
// ## The cleanup ledger is per machine
//
// A pid only means something on the machine it runs on, so what a lease recorded lives in
// THAT machine's ledger, never on the authority. Each machine reconciles its own ledger:
// a lease the authority no longer has (404) is cleaned up; one it still has, or one it
// could not be asked about, is kept. The authority's "released" notice only makes that
// happen at once instead of at the next sweep - it is never trusted on its own, so the
// route cannot be used to make a machine clean up a lease that is still held.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./leases');
const C = require('./lease-cleanup');
// #429 - log text from a peer or a caller is display text from an untrusted source, the same
// as a spawner label: one owner for "plain text that cannot break a log line".
const { spawnedByLabel: plainText } = require('./spawn-reaper');

const TICK_EVERY_MS = 15 * 1000;
const LIVENESS_EVERY_MS = 60 * 1000;
const FORWARD_TIMEOUT_MS = 8000;
const RECORD_MAX_ITEMS = 32;
const CLEANUP_MAX_ATTEMPTS = 10;
/** #429 - one line per (peer, call, outcome) per window; the repeats are counted into the next. */
const FAILURE_LOG_EVERY_MS = 60 * 1000;
const FAILURE_LOG_KEEP_SUBJECTS = 3;
/** Set on every call one server makes to another, so a call cannot be forwarded twice. */
const HOP_HEADER = 'x-wt-lease-hop';

function readJsonFile(file) {
  try {
    return { absent: false, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { absent: true };
    return { absent: false, error: true };
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * @param deps
 *   stateFile, recordsFile    where the authority's table and this machine's ledger live
 *   checkoutDir               this checkout: never removed, nor anything in or above it
 *   leasesConfig()            config.json `leases` (authority, resources, cleanupRoots)
 *   cluster(), publicUrl(), serverName()
 *   clusterToken(url)         the bearer token this server holds for a peer, or null
 *   fetch(url, opts)          clusterFetch: resolves {status, body}, rejects when unreachable
 *   listLocalSessionIds()     this machine's live session ids (throws when unknown)
 *   readMachine()             the GET /api/machine body (for admission)
 *   protectedPids()           pids recordPid refuses (this server, its worker, its parent)
 *   now(), log, error
 */
function createLeaseBroker(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.log(m));
  const logErr = deps.error || ((m) => console.error(m));

  // --- the table (authority only reads/writes it) ---
  let state = L.emptyState(crypto.randomUUID());
  let stateUnreadable = false;
  {
    const r = readJsonFile(deps.stateFile);
    if (r.error) stateUnreadable = true;
    else if (!r.absent) {
      const p = L.parseState(r.value);
      if (p.ok) state = L.resume(p.state, now()); else stateUnreadable = true;
    }
    if (stateUnreadable) logErr('[leases] the lease state file is unreadable: every lease call is refused until it is fixed');
  }
  /** Make [next] the table - only once it is on disk. A grant answered before it was saved
   *  would be forgotten by the next hot reload and granted again. */
  function commit(next) {
    if (next === state) return true;
    try { writeJsonAtomic(deps.stateFile, next); } catch (e) { logErr(`[leases] save failed, change not made: ${e.message}`); return false; }
    state = next;
    return true;
  }
  const NOT_SAVED = { error: 'the lease table could not be saved; nothing was changed' };

  // --- this machine's cleanup ledger: { [leaseId]: { resource, at, items: [{kind, pid, startMs} | {kind, path}] } } ---
  let records = {};
  let recordsUnreadable = false;
  {
    const r = readJsonFile(deps.recordsFile);
    if (r.error || (!r.absent && (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)))) {
      recordsUnreadable = true;
      logErr('[leases] the cleanup ledger is unreadable: nothing recorded is cleaned up until it is fixed or removed');
    } else if (!r.absent) records = r.value;
  }
  /** -> true when saved. */
  function saveRecords() {
    try {
      if (!Object.keys(records).length) { try { fs.unlinkSync(deps.recordsFile); } catch { /* none */ } return true; }
      writeJsonAtomic(deps.recordsFile, records);
      return true;
    } catch (e) { logErr(`[leases] ledger save failed: ${e.message}`); return false; }
  }

  const cfg = () => { try { return deps.leasesConfig() || {}; } catch { return {}; } };
  const authority = () => L.resolveAuthority(deps.leasesConfig(), deps.cluster(), deps.publicUrl(), deps.serverName());
  const myStamp = () => ({ name: deps.serverName(), url: deps.publicUrl() || null });
  const short = (id) => String(id || '').slice(0, 8);

  /** Why this server cannot answer lease calls at all, or null. A call another server already
   *  forwarded that reaches a server which would forward it AGAIN means two configs name
   *  different authorities: refused, never relayed round in a loop. */
  function unavailable(a, req) {
    if (a.mode === 'remote' && req && req.headers && req.headers[HOP_HEADER]) return { status: 508, error: `lease calls are being forwarded in a loop: this server's leases.authority (${a.name}) is not the authority the forwarding server names` };
    if (a.mode === 'none') return { status: 503, error: 'no lease authority is configured (config.json leases.authority)' };
    if (a.mode === 'invalid') return { status: 503, error: a.error };
    if (a.mode === 'self' && stateUnreadable) return { status: 503, error: 'the lease table could not be read; fix the lease state file' };
    return null;
  }

  function tokenFor(url) {
    try { return deps.clusterToken(url) || null; } catch { return null; }
  }

  /** One call to a peer. -> {status, json, ms} or {unreachable:true, error, ms}. */
  async function callPeer(url, method, p, body) {
    const t0 = Date.now();
    const token = tokenFor(url);
    if (!token) return { unreachable: true, error: 'no cluster token for that server', ms: 0 };
    try {
      const r = await deps.fetch(url.replace(/\/+$/, '') + p, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', [HOP_HEADER]: '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeout: FORWARD_TIMEOUT_MS,
      });
      let json = null;
      try { json = JSON.parse(r.body); } catch { json = null; }
      return { status: r.status, json, ms: Date.now() - t0 };
    } catch (e) {
      return { unreachable: true, error: (e && e.message) || String(e), ms: Date.now() - t0 };
    }
  }

  // --- #429: a failed call between servers leaves a line ---
  // Without it a lost heartbeat is invisible on BOTH machines: the forwarder turned the error
  // into a 503 and dropped it, and an answer from a proxy in front of the authority never
  // reached the authority's log at all. Rate-limited per key, so an outage cannot flood the
  // log; the repeats are counted into the next line for that key (a burst that ends inside
  // the window is counted by the next failure of that kind, if one ever comes).
  // A held-back repeat keeps what it was about (up to FAILURE_LOG_KEEP_SUBJECTS of them), so
  // a second lease failing inside the window is still named by the next line.
  const _failLog = new Map(); // key -> { at, suppressed, subjects: Set }
  function rateLog(key, line, sink = log, subject = null) {
    const t = now();
    const prev = _failLog.get(key);
    if (prev && t - prev.at < FAILURE_LOG_EVERY_MS) {
      prev.suppressed++;
      if (subject && !prev.subjects.has(subject)) {
        if (prev.subjects.size < FAILURE_LOG_KEEP_SUBJECTS) prev.subjects.add(subject); else prev.dropped = true;
      }
      return;
    }
    const held = prev && prev.subjects.size ? `: ${[...prev.subjects].join(', ')}${prev.dropped ? ', ...' : ''}` : '';
    const more = prev && prev.suppressed ? ` (+${prev.suppressed} more like it since the last line${held})` : '';
    _failLog.set(key, { at: t, suppressed: 0, subjects: new Set() });
    if (_failLog.size > 256) _failLog.delete(_failLog.keys().next().value);
    sink(line + more);
  }
  /** Peer or caller text as one safe line: plainText caps it at 120 code points; [max] cuts
   *  shorter, by code point, so a surrogate pair is never split. */
  const txt = (v, max = 120) => Array.from(plainText(String(v === undefined || v === null ? '' : v)) || '-').slice(0, max).join('');
  /** A peer url as a name from this server's cluster list (else its host), for a log line. */
  function peerName(url) {
    const want = String(url || '').replace(/\/+$/, '').toLowerCase();
    let list = [];
    try { list = deps.cluster() || []; } catch { list = []; }
    const hit = list.find((c) => c && typeof c.url === 'string' && c.url.replace(/\/+$/, '').toLowerCase() === want);
    if (hit && typeof hit.name === 'string') return hit.name;
    try { return new URL(want).host; } catch { return 'an unnamed peer'; }
  }
  /** Log [r] (a callPeer result) when the call FAILED: the peer could not be reached (timeout,
   *  refused, reset, DNS), answered 5xx, or answered something that is not JSON (a proxy's page).
   *  A 4xx with a JSON error is the authority ANSWERING (an ended lease, not the holder, a bad
   *  request) - normal traffic its caller already sees, never logged. [what] names the call's
   *  subject (`lease <id8>`, a resource, a session); [r.malformed] marks an answer the caller
   *  could not use at all, whatever its status. */
  function traceFailure(call, what, peer, r, kind = 'forward') {
    if (!r.unreachable && !r.malformed && r.status < 500 && r.json !== null) return;
    let why;
    if (r.unreachable) why = `unreachable (${txt(r.error)})`;
    else if (r.json === null) why = `answered ${r.status} with no JSON`;
    else if (r.json && typeof r.json.error === 'string') why = `answered ${r.status} (${txt(r.json.error)})`;
    else why = `answered ${r.status}${r.malformed ? ' without the expected fields' : ''}`;
    const outcome = r.unreachable ? 'unreachable' : String(r.status);
    rateLog(`${peer}|${call}|${outcome}`, `[leases] ${call} ${kind} for ${txt(what)} to ${txt(peer, 64)} failed after ${r.ms} ms: ${why}`, log, txt(what, 64));
  }
  /** On the authority: a 5xx it answers to a call another server FORWARDED is only otherwise
   *  seen by that server's caller, so say it here too. A local caller reads the error itself. */
  function refuse(req, res, call, status, error) {
    if (status >= 500 && req && req.headers && req.headers[HOP_HEADER]) {
      const from = req.body && req.body.holderServer && req.body.holderServer.name;
      rateLog(`answer|${call}|${status}`, `[leases] ${call} forwarded${from ? ` by ${txt(from, 64)}` : ''} refused with ${status}: ${txt(error)}`, logErr);
    }
    return res.status(status).json({ error });
  }
  /** -> the `what` of a lease call by id. */
  const leaseWhat = (id) => `lease ${short(id)}`;

  async function forward(a, req, res, method, p, body, call, what) {
    const r = await callPeer(a.url, method, p, body);
    traceFailure(call, what, a.name, r);
    if (r.unreachable) return res.status(503).json({ error: 'the lease authority is unreachable; no new lease can be granted', authority: a.name });
    return res.status(r.status).json(r.json === null ? { error: 'the lease authority sent no JSON' } : r.json);
  }

  // --- after the table moves ---

  function noteMoves(r, how) {
    for (const x of r.released || []) log(`[leases] ${x.resource}: lease ${short(x.id)} ended (${x.why || how}) - held by ${x.holder.server || '?'}/${short(x.holder.sessionId) || '-'}`);
    for (const g of r.granted || []) log(`[leases] ${g.resource}: granted to waiter ${short(g.id)} (${g.holder.server || '?'}/${short(g.holder.sessionId) || '-'})`);
    if ((r.released || []).length) notifyReleased(r.released);
  }

  /** Tell the holder's machine to re-check its ledger now. Best effort: its own sweep
   *  catches anything this misses. */
  function notifyReleased(list) {
    for (const x of list) {
      const node = x.holder && x.holder.node;
      if (node === 'self') reconcile([x.id]).catch(() => {});
      else if (node) callPeer(node, 'POST', '/api/leases/released-notice', { id: x.id }).catch(() => {});
    }
  }

  /** Commit a move of the table, then announce it. False (nothing moved) when it could not be saved. */
  function apply(r, how) {
    if (!commit(r.state)) return false;
    noteMoves(r, how);
    return true;
  }

  // Only the authority keeps time on the table: a server that WAS the authority before a
  // config change must not go on expiring (and announcing) leases it no longer owns.
  const tick = () => { if (!stateUnreadable && authority().mode === 'self') apply(L.sweep(state, now()), 'sweep'); };

  // --- authority handlers ---

  async function create(req, res) {
    const a = authority();
    const down = unavailable(a, req);
    if (down) return refuse(req, res, 'acquire', down.status, down.error);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : null;
    if (!body) return res.status(400).json({ error: 'the body must be a JSON object' });
    // Admission runs where the caller is (a request a peer forwards carries its stamp and
    // has been checked there already).
    if (body.holderServer === undefined || a.mode === 'remote') {
      const n = L.parseNeeds(body.needs);
      if (!n.ok) return res.status(400).json({ error: n.error });
      if (n.needs) {
        let machine;
        try { machine = await deps.readMachine(); } catch { machine = null; }
        const adm = L.admission(n.needs, machine, process.env.SystemDrive || 'C:');
        if (!adm.ok) return res.status(409).json({ error: 'this machine cannot take that work now', reasons: adm.reasons });
      }
    }
    delete body.needs;
    if (a.mode === 'remote') return forward(a, req, res, 'POST', '/api/leases', { ...body, holderServer: myStamp() }, 'acquire', body.resource);

    const node = L.holderNodeOf(body.holderServer, deps.cluster(), deps.publicUrl());
    const server = body.holderServer && typeof body.holderServer === 'object' && typeof body.holderServer.name === 'string' ? body.holderServer.name : deps.serverName();
    const parsed = L.parseRequest(body, { holderNode: node, holderServer: server });
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const reg = L.registryOf(cfg().resources);
    if (!reg.ok) return refuse(req, res, 'acquire', 503, `the lease registry is invalid: ${reg.error}`);
    const no = L.admit(parsed.req.resource, parsed.req.role, reg.entries);
    if (no) return res.status(no.status).json({ error: no.error });
    tick();
    const r = L.request(state, parsed.req, now(), () => crypto.randomUUID());
    if (r.error) return res.status(r.status).json({ error: r.error });
    if (!commit(r.state)) return res.status(503).json(NOT_SAVED);
    const lease = L.publicLease(state, state.leases.find((l) => l.id === r.lease.id), now());
    if (!r.existing) log(`[leases] ${lease.resource}: ${lease.state === 'held' ? 'granted' : `queued (#${lease.position})`} ${short(lease.id)} for ${parsed.req.server || '?'}/${short(lease.holder.sessionId) || '-'}`);
    res.json({ lease, granted: lease.state === 'held', existing: r.existing });
  }

  async function list(req, res) {
    const a = authority();
    const down = unavailable(a, req);
    if (down) return refuse(req, res, 'list', down.status, down.error);
    if (a.mode === 'remote') return forward(a, req, res, 'GET', '/api/leases', undefined, 'list', 'the lease table');
    tick();
    res.json({ authority: deps.serverName(), now: now(), ...L.listing(state, now()) });
  }

  const badId = (res) => res.status(400).json({ error: 'not a lease id' });

  async function get(req, res) {
    if (!L.isLeaseId(req.params.id)) return badId(res);
    const a = authority();
    const down = unavailable(a, req);
    if (down) return refuse(req, res, 'get', down.status, down.error);
    if (a.mode === 'remote') return forward(a, req, res, 'GET', `/api/leases/${req.params.id}`, undefined, 'get', leaseWhat(req.params.id));
    tick();
    const hit = L.lookup(state, req.params.id);
    // Every answer names this table: only THIS table's 404 may tell a peer to clean up.
    if (!hit) return res.status(404).json({ error: 'no such lease', tableId: state.tableId });
    if (hit.released) return res.status(404).json({ error: 'that lease has ended', tableId: state.tableId, released: { why: hit.released.why, at: hit.released.at } });
    res.json({ lease: L.publicLease(state, hit.lease, now()), tableId: state.tableId });
  }

  /** Who is asking to end or extend a lease: {sessionId} named in the body, or an error. The
   *  machine is not the caller's to say: on the authority it is the forwarding server's stamp
   *  (none: this machine), and a server that forwards always stamps itself. */
  function callerOf(req) {
    const sid = req.body && req.body.holderSessionId;
    if (sid !== undefined && sid !== null && !(typeof sid === 'string' && L.isLeaseId(sid))) return { error: 'holderSessionId must be a session id' };
    return { sessionId: sid || null };
  }
  /** On the authority: 403 unless the caller holds lease [id]. */
  function refuseNonHolder(req, res, caller) {
    const node = L.holderNodeOf(req.body && req.body.holderServer, deps.cluster(), deps.publicUrl());
    const no = L.notHolder(state, req.params.id, { node, sessionId: caller.sessionId });
    if (!no) return false;
    res.status(no.status).json({ error: no.error });
    return true;
  }
  const holderBody = (caller, extra) => ({ ...extra, ...(caller.sessionId ? { holderSessionId: caller.sessionId } : {}), holderServer: myStamp() });

  async function heartbeat(req, res) {
    if (!L.isLeaseId(req.params.id)) return badId(res);
    const a = authority();
    const down = unavailable(a, req);
    if (down) return refuse(req, res, 'heartbeat', down.status, down.error);
    const caller = callerOf(req);
    if (caller.error) return res.status(400).json({ error: caller.error });
    const ttlSec = req.body && req.body.ttlSec;
    if (a.mode === 'remote') return forward(a, req, res, 'POST', `/api/leases/${req.params.id}/heartbeat`, holderBody(caller, ttlSec === undefined ? {} : { ttlSec }), 'heartbeat', leaseWhat(req.params.id));
    tick();
    if (refuseNonHolder(req, res, caller)) return undefined;
    const r = L.heartbeat(state, req.params.id, now(), ttlSec);
    if (r.status) return res.status(r.status).json({ error: r.error, ...(r.released ? { released: { why: r.released.why, at: r.released.at } } : {}) });
    if (!commit(r.state)) return res.status(503).json(NOT_SAVED);
    res.json({ lease: L.publicLease(state, state.leases.find((l) => l.id === r.lease.id), now()) });
  }

  async function release(req, res) {
    if (!L.isLeaseId(req.params.id)) return badId(res);
    const a = authority();
    const down = unavailable(a, req);
    if (down) return refuse(req, res, 'release', down.status, down.error);
    const caller = callerOf(req);
    if (caller.error) return res.status(400).json({ error: caller.error });
    if (a.mode === 'remote') return forward(a, req, res, 'DELETE', `/api/leases/${req.params.id}`, holderBody(caller), 'release', leaseWhat(req.params.id));
    tick();
    if (refuseNonHolder(req, res, caller)) return undefined;
    const r = L.release(state, req.params.id, 'released', now());
    if (r.status) return res.status(r.status).json({ error: r.error, ...(r.released ? { released: { why: r.released.why, at: r.released.at } } : {}) });
    if (!apply({ state: r.state, released: [r.released], granted: r.granted }, 'released')) return res.status(503).json(NOT_SAVED);
    res.json({ released: { id: r.released.id, resource: r.released.resource }, granted: r.granted.map((g) => ({ id: g.id, holder: { server: g.holder.server, sessionId: g.holder.sessionId } })) });
  }

  /** A holder's machine saw [holderSessionId] end. */
  async function holderEnded(req, res) {
    const a = authority();
    const down = unavailable(a, req);
    if (down) return refuse(req, res, 'holder-ended', down.status, down.error);
    const sid = req.body && req.body.holderSessionId;
    if (typeof sid !== 'string' || !L.isLeaseId(sid)) return res.status(400).json({ error: 'holderSessionId must be a session id' });
    const succ = req.body.successorSessionId;
    if (succ !== undefined && succ !== null && !(typeof succ === 'string' && L.isLeaseId(succ))) return res.status(400).json({ error: 'successorSessionId must be a session id' });
    if (a.mode === 'remote') return forward(a, req, res, 'POST', '/api/leases/holder-ended', { holderSessionId: sid, ...(succ ? { successorSessionId: succ } : {}), holderServer: myStamp() }, 'holder-ended', `session ${short(sid)}`);
    const node = L.holderNodeOf(req.body.holderServer, deps.cluster(), deps.publicUrl());
    if (node === null) return res.status(400).json({ error: 'that server is not in the lease authority\'s cluster list' });
    if (succ) {
      const t = L.transferHolder(state, node, sid, succ);
      if (!commit(t.state)) return res.status(503).json(NOT_SAVED);
      if (t.moved.length) log(`[leases] session ${short(sid)} handed off: ${t.moved.length} lease(s) now held by ${short(succ)}`);
      return res.json({ moved: t.moved, released: [], granted: [] });
    }
    const r = L.holderEnded(state, node, sid, now());
    if (!apply(r, 'holder-ended')) return res.status(503).json(NOT_SAVED);
    res.json({ released: r.released.map((x) => x.id), granted: r.granted.map((g) => g.id) });
  }

  /** This machine's session exited: release whatever it held - or, when it was handed off
   *  (#340/#345) to [successorId], move its leases to the successor, which carries on the same
   *  work. Never throws, never waits. */
  function onSessionExited(id, successorId) {
    if (!L.isLeaseId(id)) return;
    const succ = L.isLeaseId(successorId) ? successorId : null;
    let a;
    try { a = authority(); } catch { return; }
    if (unavailable(a)) return;
    if (a.mode === 'self') {
      if (succ) {
        if (!commit(L.transferHolder(state, 'self', id, succ).state)) logErr(`[leases] hand-off of session ${short(id)} not saved; its leases stay with it until the sweep`);
      } else apply(L.holderEnded(state, 'self', id, now()), 'holder-ended');
    } else if (a.mode === 'remote') {
      callPeer(a.url, 'POST', '/api/leases/holder-ended', { holderSessionId: id, ...(succ ? { successorSessionId: succ } : {}), holderServer: myStamp() })
        .then((r) => traceFailure('holder-ended', `session ${short(id)} (its sweep will catch it)`, a.name, r))
        .catch(() => {});
    }
  }

  /** One liveness pass on the authority: every machine with a session-held lease is asked
   *  which of its sessions are alive. A machine that does not answer releases nobody. */
  async function liveness() {
    if (stateUnreadable || authority().mode !== 'self') return;
    for (const node of L.liveSessionsByNode(state).keys()) {
      const readAt = now();
      let alive = null;
      if (node === 'self') {
        try { alive = new Set((await deps.listLocalSessionIds()).map((x) => String(x).toLowerCase())); } catch { alive = null; }
      } else {
        const r = await callPeer(node, 'GET', '/api/leases/local-sessions');
        if (!r.unreachable && r.status === 200 && r.json && Array.isArray(r.json.ids)) alive = new Set(r.json.ids.map((x) => String(x).toLowerCase()));
        else traceFailure('liveness', 'its live sessions (nobody released)', peerName(node), r.unreachable ? r : { ...r, malformed: true }, 'read');
      }
      apply(L.liveness(state, node, alive, now(), readAt), 'holder-ended');
    }
  }

  // --- local handlers ---

  async function localSessions(req, res) {
    try { res.json({ ids: await deps.listLocalSessionIds() }); } catch (e) { res.status(503).json({ error: 'the session list could not be read' }); }
  }

  /**
   * Is lease [id] still live? -> {status:'live', lease, tableId} | {status:'gone'} |
   * {status:'missing'} | {status:'unknown'}.
   *
   * 'gone' - the one answer that makes a machine kill and delete - needs [tableId] and a JSON
   * 404 from the table that SAME id names. A 404 from anything else is never it: a branch
   * without these routes (Express's HTML 404), a deleted or replaced table (a new id), another
   * authority after a config move, a relay. Those are 'unknown' and keep. Without [tableId]
   * (a record request) a 404 is only 'missing'.
   */
  async function leaseStatus(id, tableId) {
    const a = authority();
    if (a.mode === 'self') {
      if (stateUnreadable) return { status: 'unknown' };
      tick();
      const l = state.leases.find((x) => x.id === id);
      if (l) return { status: 'live', lease: l, tableId: state.tableId };
      if (!tableId) return { status: 'missing' };
      return tableId === state.tableId ? { status: 'gone' } : { status: 'unknown', otherTable: true };
    }
    if (a.mode !== 'remote') return { status: 'unknown' };
    const r = await callPeer(a.url, 'GET', `/api/leases/${id}`);
    if (r.unreachable || !r.json || typeof r.json !== 'object') return { status: 'unknown' };
    if (r.status === 200 && r.json.lease && typeof r.json.tableId === 'string') return { status: 'live', lease: r.json.lease, tableId: r.json.tableId };
    if (r.status === 404 && typeof r.json.tableId === 'string') {
      if (!tableId) return { status: 'missing' };
      return r.json.tableId === tableId ? { status: 'gone' } : { status: 'unknown', otherTable: true };
    }
    return { status: 'unknown' };
  }

  /** The cleanup roots from config: [] when unset (no folder is ever removed), null when the
   *  value is malformed - which refuses, never widens to a default. */
  function cleanupRoots() {
    const roots = cfg().cleanupRoots;
    if (roots === undefined || roots === null) return C.DEFAULT_ROOTS;
    if (Array.isArray(roots) && roots.every((r) => typeof r === 'string' && path.isAbsolute(r))) return roots;
    return null;
  }
  const pathOpts = () => {
    const roots = cleanupRoots();
    return roots ? { roots, protect: [deps.checkoutDir, ...(deps.protectPaths ? deps.protectPaths() : [])] } : null;
  };

  async function record(req, res) {
    const id = req.params.id;
    if (!L.isLeaseId(id)) return badId(res);
    if (recordsUnreadable) return res.status(503).json({ error: 'the cleanup ledger could not be read; fix it' });
    const body = req.body || {};
    const pids = body.pids === undefined ? [] : body.pids;
    const paths = body.paths === undefined ? [] : body.paths;
    if (!Array.isArray(pids) || !Array.isArray(paths)) return res.status(400).json({ error: 'pids and paths must be arrays' });
    if (!pids.length && !paths.length) return res.status(400).json({ error: 'nothing to record' });
    if (pids.length + paths.length > RECORD_MAX_ITEMS) return res.status(400).json({ error: `at most ${RECORD_MAX_ITEMS} items per lease` });
    const st = await leaseStatus(id);
    if (st.status === 'missing') return res.status(404).json({ error: 'no such lease' });
    if (st.status !== 'live') return res.status(503).json({ error: 'the lease authority could not confirm that lease' });
    if (st.lease.state !== 'held') return res.status(409).json({ error: 'that lease is still waiting; record what it starts once it is granted' });
    // A pid only means something on the machine it runs on: only the holder's own machine
    // may record for a lease.
    const holder = st.lease.holder || {};
    const mine = holder.node !== undefined ? holder.node === 'self' : String(holder.server || '').toLowerCase() === String(deps.serverName()).toLowerCase();
    if (!mine) return res.status(409).json({ error: 'that lease is held from another machine; record on the machine where its holder runs' });
    const items = [];
    const prot = deps.protectedPids();
    if (pids.length && !Array.isArray(prot)) return res.status(503).json({ error: 'this server does not know its own worker\'s pid yet, so it cannot refuse it; try again shortly' });
    const opts = paths.length ? pathOpts() : null;
    if (paths.length && !opts) return res.status(503).json({ error: 'leases.cleanupRoots is malformed on this machine (absolute folders only); no folder can be recorded' });
    for (const pid of pids) {
      const r = await C.recordPid(pid, { protectedPids: prot });
      if (!r.ok) return res.status(400).json({ error: r.error, nothingRecorded: true });
      items.push({ kind: 'pid', ...r.item });
    }
    for (const p of paths) {
      const r = await C.checkPath(p, opts);
      if (!r.ok) return res.status(400).json({ error: `${typeof p === 'string' ? p.slice(0, 200) : 'path'}: ${r.error}`, nothingRecorded: true });
      items.push({ kind: 'path', path: r.path });
    }
    const prev = records[id] && Array.isArray(records[id].items) ? records[id].items : [];
    const merged = [...prev];
    for (const it of items) {
      const dup = merged.some((m) => m.kind === it.kind && (it.kind === 'pid' ? m.pid === it.pid && m.startMs === it.startMs : m.path === it.path));
      if (!dup) merged.push(it);
    }
    if (merged.length > RECORD_MAX_ITEMS) return res.status(400).json({ error: `at most ${RECORD_MAX_ITEMS} items per lease` });
    const before = records[id];
    records[id] = { resource: st.lease.resource, tableId: st.tableId, at: now(), items: merged };
    if (!saveRecords()) {
      // Answer only what is saved: a record that would vanish on the next reload is no record.
      if (before) records[id] = before; else delete records[id];
      return res.status(503).json({ error: 'the cleanup ledger could not be saved; nothing was recorded', nothingRecorded: true });
    }
    log(`[leases] ${st.lease.resource}: lease ${short(id)} recorded ${items.length} item(s) to clean up on release`);
    res.json({ id, resource: st.lease.resource, items: merged });
  }

  function recordsList(req, res) {
    if (recordsUnreadable) return res.status(503).json({ error: 'the cleanup ledger could not be read; fix it' });
    res.json({ records });
  }

  /** Clean up what a lease recorded, once the authority says it is gone. */
  // One pass at a time, in order: two overlapping passes would both kill and remove, and
  // the later save could put back an entry the earlier one had finished.
  let _reconcileChain = Promise.resolve();
  function reconcile(only) {
    const next = _reconcileChain.then(() => reconcileOnce(only));
    _reconcileChain = next.catch(() => {});
    return next;
  }
  async function reconcileOnce(only) {
    if (recordsUnreadable) return;
    const ids = Object.keys(records).filter((id) => !only || only.includes(id));
    for (const id of ids) {
      const rec = records[id];
      if (!rec) continue;
      const st = await leaseStatus(id, rec.tableId);
      if (st.otherTable && !rec.stale) {
        logErr(`[leases] ${rec.resource}: lease ${short(id)} was recorded against another lease table; nothing is cleaned up for it - remove it from the ledger by hand once its work is gone`);
        records[id] = { ...rec, stale: true };
        saveRecords();
      }
      if (st.status !== 'gone') continue;
      const opts = pathOpts();
      const left = [];
      for (const it of rec.items || []) {
        let r;
        if (it.kind === 'pid') r = await C.killRecorded(it);
        else if (it.kind === 'path') r = opts ? await C.removeRecorded(it.path, opts) : { result: 'error', error: 'leases.cleanupRoots is malformed' };
        else r = { result: 'refused' };
        const done = ['killed', 'gone', 'reused', 'removed', 'refused'].includes(r.result);
        const what = it.kind === 'pid' ? `pid ${it.pid}` : it.path;
        log(`[leases] ${rec.resource}: cleanup of ${short(id)} - ${what}: ${r.result}${r.error ? ` (${r.error})` : ''}`);
        if (r.result === 'removed' && r.gitDir) await C.pruneWorktrees(r.gitDir);
        if (!done) {
          const attempts = (it.attempts || 0) + 1;
          if (attempts < CLEANUP_MAX_ATTEMPTS) left.push({ ...it, attempts });
          else logErr(`[leases] ${rec.resource}: gave up cleaning ${what} after ${attempts} attempts`);
        }
      }
      if (left.length) records[id] = { ...rec, items: left }; else delete records[id];
      saveRecords();
    }
  }

  function releasedNotice(req, res) {
    const id = req.body && req.body.id;
    if (!L.isLeaseId(id)) return badId(res);
    if (!records[id]) return res.json({ ok: true, recorded: false });
    reconcile([id]).catch((e) => logErr(`[leases] reconcile failed: ${e.message}`));
    res.status(202).json({ ok: true, recorded: true });
  }

  async function admissionRoute(req, res) {
    const q = req.query || {};
    const num = (v) => (v === undefined ? undefined : (/^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN));
    const raw = {};
    if (q.memGB !== undefined) raw.memGB = num(q.memGB);
    if (q.diskGB !== undefined) raw.diskGB = num(q.diskGB);
    if (q.drive !== undefined) raw.drive = String(q.drive);
    const n = L.parseNeeds(raw);
    if (!n.ok) return res.status(400).json({ error: n.error });
    let machine;
    try { machine = await deps.readMachine(); } catch { machine = null; }
    const r = L.admission(n.needs, machine, process.env.SystemDrive || 'C:');
    res.status(r.ok ? 200 : 409).json(r);
  }

  // --- timers ---
  const timers = [];
  let _livenessBusy = false;
  let _reconcileQueued = false;
  async function sweepAll() {
    tick();
    if (!_livenessBusy) {
      _livenessBusy = true;
      try { await liveness(); } finally { _livenessBusy = false; }
    }
    // One full pass waiting at most: a slow authority must not let the minute timer stack them.
    if (_reconcileQueued) return;
    _reconcileQueued = true;
    try { await reconcile(); } finally { _reconcileQueued = false; }
  }
  function start() {
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => logErr(`[leases] sweep failed: ${e.message}`)); }, ms); if (t.unref) t.unref(); timers.push(t); };
    every(TICK_EVERY_MS, tick);
    every(LIVENESS_EVERY_MS, sweepAll);
  }
  function stop() { for (const t of timers.splice(0)) clearInterval(t); }

  return {
    routes: { create, list, get, heartbeat, release, holderEnded, localSessions, record, records: recordsList, releasedNotice, admission: admissionRoute },
    onSessionExited, sweepAll, start, stop,
  };
}

module.exports = { createLeaseBroker, TICK_EVERY_MS, LIVENESS_EVERY_MS };
