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

const TICK_EVERY_MS = 15 * 1000;
const LIVENESS_EVERY_MS = 60 * 1000;
const FORWARD_TIMEOUT_MS = 8000;
const RECORD_MAX_ITEMS = 32;
const CLEANUP_MAX_ATTEMPTS = 10;

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
  let state = L.emptyState();
  let stateUnreadable = false;
  {
    const r = readJsonFile(deps.stateFile);
    if (r.error) stateUnreadable = true;
    else if (!r.absent) {
      const p = L.parseState(r.value);
      if (p.ok) state = L.resume(p.state, now()); else stateUnreadable = true;
    }
    if (stateUnreadable) logErr('[leases] the lease state file is unreadable: every lease call is refused until it is fixed or removed');
  }
  function saveState() {
    try { writeJsonAtomic(deps.stateFile, state); } catch (e) { logErr(`[leases] save failed: ${e.message}`); }
  }

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
  function saveRecords() {
    try {
      if (!Object.keys(records).length) { try { fs.unlinkSync(deps.recordsFile); } catch { /* none */ } return; }
      writeJsonAtomic(deps.recordsFile, records);
    } catch (e) { logErr(`[leases] ledger save failed: ${e.message}`); }
  }

  const cfg = () => { try { return deps.leasesConfig() || {}; } catch { return {}; } };
  const authority = () => L.resolveAuthority(deps.leasesConfig(), deps.cluster(), deps.publicUrl(), deps.serverName());
  const myStamp = () => ({ name: deps.serverName(), url: deps.publicUrl() || null });
  const short = (id) => String(id || '').slice(0, 8);

  /** Why this server cannot answer lease calls at all, or null. */
  function unavailable(a) {
    if (a.mode === 'none') return { status: 503, error: 'no lease authority is configured (config.json leases.authority)' };
    if (a.mode === 'invalid') return { status: 503, error: a.error };
    if (a.mode === 'self' && stateUnreadable) return { status: 503, error: 'the lease table could not be read; fix or remove the lease state file' };
    return null;
  }

  function tokenFor(url) {
    try { return deps.clusterToken(url) || null; } catch { return null; }
  }

  /** One call to a peer. -> {status, json} or {unreachable:true, error}. */
  async function callPeer(url, method, p, body) {
    const token = tokenFor(url);
    if (!token) return { unreachable: true, error: 'no cluster token for that server' };
    try {
      const r = await deps.fetch(url.replace(/\/+$/, '') + p, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeout: FORWARD_TIMEOUT_MS,
      });
      let json = null;
      try { json = JSON.parse(r.body); } catch { json = null; }
      return { status: r.status, json };
    } catch (e) {
      return { unreachable: true, error: e.message };
    }
  }

  async function forward(a, req, res, method, p, body) {
    const r = await callPeer(a.url, method, p, body);
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

  function apply(r, how) {
    if (r.state !== state) { state = r.state; saveState(); }
    noteMoves(r, how);
  }

  // Only the authority keeps time on the table: a server that WAS the authority before a
  // config change must not go on expiring (and announcing) leases it no longer owns.
  const tick = () => { if (!stateUnreadable && authority().mode === 'self') apply(L.sweep(state, now()), 'sweep'); };

  // --- authority handlers ---

  async function create(req, res) {
    const a = authority();
    const down = unavailable(a);
    if (down) return res.status(down.status).json({ error: down.error });
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
    if (a.mode === 'remote') return forward(a, req, res, 'POST', '/api/leases', { ...body, holderServer: myStamp() });

    const node = L.holderNodeOf(body.holderServer, deps.cluster(), deps.publicUrl());
    const server = body.holderServer && typeof body.holderServer === 'object' && typeof body.holderServer.name === 'string' ? body.holderServer.name : deps.serverName();
    const parsed = L.parseRequest(body, { holderNode: node, holderServer: server });
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const reg = L.registryOf(cfg().resources);
    if (!reg.ok) return res.status(503).json({ error: `the lease registry is invalid: ${reg.error}` });
    const no = L.admit(parsed.req.resource, parsed.req.role, reg.entries);
    if (no) return res.status(no.status).json({ error: no.error });
    tick();
    const r = L.request(state, parsed.req, now(), () => crypto.randomUUID());
    if (r.error) return res.status(r.status).json({ error: r.error });
    if (r.state !== state) { state = r.state; saveState(); }
    const lease = L.publicLease(state, state.leases.find((l) => l.id === r.lease.id), now());
    if (!r.existing) log(`[leases] ${lease.resource}: ${lease.state === 'held' ? 'granted' : `queued (#${lease.position})`} ${short(lease.id)} for ${server}/${short(lease.holder.sessionId) || '-'}`);
    res.json({ lease, granted: lease.state === 'held', existing: r.existing });
  }

  async function list(req, res) {
    const a = authority();
    const down = unavailable(a);
    if (down) return res.status(down.status).json({ error: down.error });
    if (a.mode === 'remote') return forward(a, req, res, 'GET', '/api/leases');
    tick();
    res.json({ authority: deps.serverName(), now: now(), ...L.listing(state, now()) });
  }

  const badId = (res) => res.status(400).json({ error: 'not a lease id' });

  async function get(req, res) {
    if (!L.isLeaseId(req.params.id)) return badId(res);
    const a = authority();
    const down = unavailable(a);
    if (down) return res.status(down.status).json({ error: down.error });
    if (a.mode === 'remote') return forward(a, req, res, 'GET', `/api/leases/${req.params.id}`);
    tick();
    const hit = L.lookup(state, req.params.id);
    if (!hit) return res.status(404).json({ error: 'no such lease' });
    if (hit.released) return res.status(404).json({ error: 'that lease has ended', released: { why: hit.released.why, at: hit.released.at } });
    res.json({ lease: L.publicLease(state, hit.lease, now()) });
  }

  async function heartbeat(req, res) {
    if (!L.isLeaseId(req.params.id)) return badId(res);
    const a = authority();
    const down = unavailable(a);
    if (down) return res.status(down.status).json({ error: down.error });
    const ttlSec = req.body && req.body.ttlSec;
    if (a.mode === 'remote') return forward(a, req, res, 'POST', `/api/leases/${req.params.id}/heartbeat`, ttlSec === undefined ? {} : { ttlSec });
    tick();
    const r = L.heartbeat(state, req.params.id, now(), ttlSec);
    if (r.status) return res.status(r.status).json({ error: r.error, ...(r.released ? { released: { why: r.released.why, at: r.released.at } } : {}) });
    state = r.state;
    saveState();
    res.json({ lease: L.publicLease(state, state.leases.find((l) => l.id === r.lease.id), now()) });
  }

  async function release(req, res) {
    if (!L.isLeaseId(req.params.id)) return badId(res);
    const a = authority();
    const down = unavailable(a);
    if (down) return res.status(down.status).json({ error: down.error });
    if (a.mode === 'remote') return forward(a, req, res, 'DELETE', `/api/leases/${req.params.id}`);
    tick();
    const r = L.release(state, req.params.id, 'released', now());
    if (r.status) return res.status(r.status).json({ error: r.error, ...(r.released ? { released: { why: r.released.why, at: r.released.at } } : {}) });
    apply({ state: r.state, released: [r.released], granted: r.granted }, 'released');
    res.json({ released: { id: r.released.id, resource: r.released.resource }, granted: r.granted.map((g) => ({ id: g.id, holder: { server: g.holder.server, sessionId: g.holder.sessionId } })) });
  }

  /** A holder's machine saw [holderSessionId] end. */
  async function holderEnded(req, res) {
    const a = authority();
    const down = unavailable(a);
    if (down) return res.status(down.status).json({ error: down.error });
    const sid = req.body && req.body.holderSessionId;
    if (typeof sid !== 'string' || !L.isLeaseId(sid)) return res.status(400).json({ error: 'holderSessionId must be a session id' });
    if (a.mode === 'remote') return forward(a, req, res, 'POST', '/api/leases/holder-ended', { holderSessionId: sid, holderServer: myStamp() });
    const node = L.holderNodeOf(req.body.holderServer, deps.cluster(), deps.publicUrl());
    if (node === null) return res.status(400).json({ error: 'that server is not in the lease authority\'s cluster list' });
    const r = L.holderEnded(state, node, sid, now());
    apply(r, 'holder-ended');
    res.json({ released: r.released.map((x) => x.id), granted: r.granted.map((g) => g.id) });
  }

  /** This machine's session exited: release whatever it held. Never throws, never waits. */
  function onSessionExited(id) {
    if (!L.isLeaseId(id)) return;
    let a;
    try { a = authority(); } catch { return; }
    if (unavailable(a)) return;
    if (a.mode === 'self') {
      apply(L.holderEnded(state, 'self', id, now()), 'holder-ended');
    } else if (a.mode === 'remote') {
      callPeer(a.url, 'POST', '/api/leases/holder-ended', { holderSessionId: id, holderServer: myStamp() })
        .then((r) => { if (r.unreachable) log(`[leases] could not tell the authority that session ${short(id)} ended (${r.error}); its sweep will`); })
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
      }
      apply(L.liveness(state, node, alive, now(), readAt), 'holder-ended');
    }
  }

  // --- local handlers ---

  async function localSessions(req, res) {
    try { res.json({ ids: await deps.listLocalSessionIds() }); } catch (e) { res.status(503).json({ error: 'the session list could not be read' }); }
  }

  /** Who the authority is, as a name a ledger entry can be compared with. */
  const authorityName = (a) => (a.mode === 'self' ? deps.serverName() : a.mode === 'remote' ? a.name : null);

  /** Is lease [id] still live at the authority? 'live' | 'gone' | 'unknown'. [recordedWith] is
   *  the authority the ledger entry was recorded against: a different one now (the config
   *  moved the authority) has never heard of the lease, and its 404 would clean up live work,
   *  so it is 'unknown' instead. */
  async function leaseStatus(id, recordedWith) {
    const a = authority();
    const name = authorityName(a);
    if (recordedWith && (!name || String(name).toLowerCase() !== String(recordedWith).toLowerCase())) return { status: 'unknown' };
    if (a.mode === 'self') {
      if (stateUnreadable) return { status: 'unknown' };
      tick();
      const l = state.leases.find((x) => x.id === id);
      return l ? { status: 'live', lease: l } : { status: 'gone' };
    }
    if (a.mode !== 'remote') return { status: 'unknown' };
    const r = await callPeer(a.url, 'GET', `/api/leases/${id}`);
    if (r.unreachable) return { status: 'unknown' };
    if (r.status === 404) return { status: 'gone' };
    if (r.status === 200 && r.json && r.json.lease) return { status: 'live', lease: r.json.lease };
    return { status: 'unknown' };
  }

  function cleanupRoots() {
    const roots = cfg().cleanupRoots;
    if (Array.isArray(roots) && roots.length && roots.every((r) => typeof r === 'string' && path.isAbsolute(r))) return roots;
    return C.defaultRoots(deps.checkoutDir);
  }
  const pathOpts = () => ({ roots: cleanupRoots(), protect: [deps.checkoutDir, ...(deps.protectPaths ? deps.protectPaths() : [])] });

  async function record(req, res) {
    const id = req.params.id;
    if (!L.isLeaseId(id)) return badId(res);
    if (recordsUnreadable) return res.status(503).json({ error: 'the cleanup ledger could not be read; fix or remove it' });
    const body = req.body || {};
    const pids = body.pids === undefined ? [] : body.pids;
    const paths = body.paths === undefined ? [] : body.paths;
    if (!Array.isArray(pids) || !Array.isArray(paths)) return res.status(400).json({ error: 'pids and paths must be arrays' });
    if (!pids.length && !paths.length) return res.status(400).json({ error: 'nothing to record' });
    if (pids.length + paths.length > RECORD_MAX_ITEMS) return res.status(400).json({ error: `at most ${RECORD_MAX_ITEMS} items per lease` });
    const st = await leaseStatus(id);
    if (st.status === 'gone') return res.status(404).json({ error: 'no such lease' });
    if (st.status !== 'live') return res.status(503).json({ error: 'the lease authority could not confirm that lease' });
    if (st.lease.state !== 'held') return res.status(409).json({ error: 'that lease is still waiting; record what it starts once it is granted' });
    const items = [];
    const prot = deps.protectedPids();
    for (const pid of pids) {
      const r = await C.recordPid(pid, { protectedPids: prot });
      if (!r.ok) return res.status(400).json({ error: r.error, nothingRecorded: true });
      items.push({ kind: 'pid', ...r.item });
    }
    for (const p of paths) {
      const r = await C.checkPath(p, pathOpts());
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
    records[id] = { resource: st.lease.resource, authority: authorityName(authority()), at: now(), items: merged };
    saveRecords();
    log(`[leases] ${st.lease.resource}: lease ${short(id)} recorded ${items.length} item(s) to clean up on release`);
    res.json({ id, resource: st.lease.resource, items: merged });
  }

  function recordsList(req, res) {
    if (recordsUnreadable) return res.status(503).json({ error: 'the cleanup ledger could not be read; fix or remove it' });
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
      const st = await leaseStatus(id, rec.authority);
      if (st.status !== 'gone') continue;
      const left = [];
      for (const it of rec.items || []) {
        let r;
        if (it.kind === 'pid') r = await C.killRecorded(it);
        else if (it.kind === 'path') r = await C.removeRecorded(it.path, pathOpts());
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
  async function sweepAll() {
    tick();
    if (!_livenessBusy) {
      _livenessBusy = true;
      try { await liveness(); } finally { _livenessBusy = false; }
    }
    await reconcile();
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
