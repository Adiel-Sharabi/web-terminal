'use strict';
// --- The fleet usage ledger's service (#529) -----------------------------------------------
//
// Ties the pieces together on ONE machine: a collector that turns transcripts, bug-hunter run dirs, the
// project inventory and the settings in force into records of this machine's own ledger file, and a
// syncer that copies every other machine's ledger here. All I/O is injected, so the whole loop runs in a
// spec with stubs; server.js wires the real ones and owns the routes.
//
// Order that matters: a machine must not write its own records before its own history could have been
// recovered from its peers (a wiped disk that wrote seq 1.. again would fork what the peers still hold),
// so the collector waits for the first answer of the recovery pull (lib/usage-sync.js mayCollect).
// Everything here is best effort: a failed pass is logged once and tried again at the next one.

const fs = require('fs');
const path = require('path');
const sync = require('./usage-sync');
const col = require('./usage-collector');
const { readSettings, sameSettings, settingsDraft } = require('./usage-settings');
const { classifyDraft } = require('./usage-classify');
const { MAX_RECORD_BYTES } = require('./usage-store');

const DAY_MS = 24 * 60 * 60e3;
const BACKLOG_RETRY_MS = 60e3;
const KEEP_BH = 6000;
const KEEP_SESSIONS = 30000;

const DEFAULTS = Object.freeze({
  enabled: true, collectMin: 30, firstRunMin: 2, syncMin: 5, activeGapMin: 5, budgetSec: 90,
  workSource: null, projectRoots: null, bhRunDirs: null, ignorePeers: [],
});

/** The effective config: defaults, then the `usageLedger` block of config.json (numbers kept sane). */
function configFrom(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    enabled: c.enabled !== false,
    collectMin: n(c.collectMin, DEFAULTS.collectMin, 1, 24 * 60), firstRunMin: n(c.firstRunMin, DEFAULTS.firstRunMin, 0, 60),
    syncMin: n(c.syncMin, DEFAULTS.syncMin, 1, 24 * 60), activeGapMin: n(c.activeGapMin, DEFAULTS.activeGapMin, 1, 60), budgetSec: n(c.budgetSec, DEFAULTS.budgetSec, 5, 900),
    workSource: typeof c.workSource === 'string' && c.workSource ? c.workSource : null,
    projectRoots: Array.isArray(c.projectRoots) ? c.projectRoots.filter((x) => typeof x === 'string' && x) : null,
    bhRunDirs: Array.isArray(c.bhRunDirs) ? c.bhRunDirs.filter((x) => typeof x === 'string' && x) : null,
    // peers a fresh machine need not wait for (a retired cluster entry that will never answer)
    ignorePeers: Array.isArray(c.ignorePeers) ? c.ignorePeers.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()) : [],
  };
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && s.v === 1) return { v: 1, sessions: s.sessions || {}, projectCache: s.projectCache || {}, bh: s.bh || {}, inventoryAt: s.inventoryAt || 0, inventoryHash: s.inventoryHash || '' };
  } catch { /* none yet */ }
  return { v: 1, sessions: {}, projectCache: {}, bh: {}, inventoryAt: 0, inventoryHash: '' };
}

function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
}

function trimOldest(obj, keep) {
  const keys = Object.keys(obj);
  if (keys.length <= keep) return;
  for (const k of keys.slice(0, keys.length - keep)) delete obj[k];
}

/** @param {object} o
 *  @param {object} o.store                 lib/usage-store.js
 *  @param {{call: (op: string, req: object) => Promise<any>}} o.worker   lib/usage-thread.js
 *  @param {object} o.agentSessions         lib/usage-agent-sessions.js
 *  @param {string} o.claudeDir             the Claude config dir holding `projects/` and `settings.json`
 *  @param {string} o.statePath             where the collector keeps what it has already written
 *  @param {() => object} o.getConfig       the raw `usageLedger` config block
 *  @param {() => string[]} o.defaultRoots  the project roots when none are configured
 *  @param {() => object|null} o.readConfig the web-terminal config (for the hand-off thresholds)
 *  @param {() => Array<{name: string, url: string}>} o.getPeers
 *  @param {(peer: object, path: string) => Promise<{status: number, json: any}>} o.getJson */
function createUsageService(o) {
  const { store, worker, agentSessions, claudeDir, statePath } = o;
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const setTimer = o.setTimer || setTimeout;
  const clearTimer = o.clearTimer || clearTimeout;
  const cfg = () => configFrom(o.getConfig && o.getConfig());
  const state = loadState(statePath);
  let answeredEver = false;  // some peer answered 200 (it runs this feature)
  const reached = new Set(); // peers that have answered at least once in this process (200, or 404 from an older server)
  let ownTheirsMax = 0;      // the highest head of OUR origin any peer has reported: a high-water mark
  let busyCollect = false;
  let busySync = false;
  let started = false;
  let timers = { collect: null, sync: null };
  let first = true;
  const status = { lastCollect: null, lastSync: null, collectError: null, syncError: null };

  const peers = () => (o.getPeers ? o.getPeers() : []).filter((p) => p && p.url && p.name);
  const roots = (c) => (c.projectRoots && c.projectRoots.length ? c.projectRoots : o.defaultRoots());

  // --- replication ---------------------------------------------------------------------

  async function syncOnce() {
    if (busySync) return { skipped: 'busy' };
    if (!cfg().enabled) return { skipped: 'disabled' };
    busySync = true;
    try {
      const list = peers();
      let pulled = 0;
      let answered = 0;
      let rows = [];
      if (first || !answeredEver) {
        // the recovery pull: this machine's OWN history first, before anything else is pulled or written
        const r0 = await sync.pullRound({ store, peers: list, getJson: o.getJson, only: store.origin });
        pulled += r0.pulled; answered += r0.answered; rows = r0.peers;
        noteRound(r0);
      }
      const r = await sync.pullRound({ store, peers: list, getJson: o.getJson });
      pulled += r.pulled; answered = Math.max(answered, r.answered); rows = r.peers;
      noteRound(r);
      if (answered > 0) answeredEver = true;
      status.lastSync = { at: new Date(now()).toISOString(), pulled, answered, peers: rows };
      status.syncError = null;
      return status.lastSync;
    } catch (e) {
      status.syncError = e.message; log(`usage sync: ${e.message}`);
      return { error: e.message };
    } finally { busySync = false; }
  }

  // --- collection ----------------------------------------------------------------------

  /** What a pull round showed: which peers have answered, and how much of OUR history a peer holds. */
  function noteRound(r) {
    for (const row of r.peers) if (row.reached) reached.add(String(row.name).toLowerCase());
    ownTheirsMax = Math.max(ownTheirsMax, r.ownTheirs || 0);
  }

  /** May this machine append to its own ledger now? (lib/usage-sync.js `mayCollect` says why not.) */
  function mayWrite() {
    const list = peers();
    const skip = new Set(cfg().ignorePeers);
    const allReached = list.every((p) => skip.has(String(p.name).toLowerCase()) || reached.has(String(p.name).toLowerCase()));
    return sync.mayCollect({ ownHead: store.head(store.origin), peerCount: list.length, repaired: store.ownRepaired(), behind: ownTheirsMax > store.head(store.origin), allReached });
  }

  /** One pass. Resolves a summary; never throws. */
  async function collectOnce() {
    if (busyCollect) return { skipped: 'busy' };
    if (!cfg().enabled) return { skipped: 'disabled' };
    if (!mayWrite()) return { skipped: 'recovering' };
    busyCollect = true;
    try {
      const c = cfg();
      const t = now();
      const drafts = [];
      const known = {};
      for (const [sid, v] of Object.entries(state.sessions)) {
        const e = agentSessions.bySid(sid);
        if (col.needsReclass({ prev: v, name: e && e.name })) continue; // left out: due again, its class came from a name this build did not read
        known[sid] = { sig: v.sig, at: v.at };
      }
      const scan = !claudeDir ? { sessions: [], left: 0, projectCache: state.projectCache } : await worker.call('scan', { claudeDir, known, now: t, budgetMs: c.budgetSec * 1000, activeGapMs: c.activeGapMin * 60e3, projectCache: state.projectCache });
      state.projectCache = scan.projectCache || state.projectCache;
      const orchestrators = col.orchestratorKeys(agentSessions.all());
      const sessionUpdates = [];
      for (const s of scan.sessions) {
        if (s.empty || !s.summary) { sessionUpdates.push([s.sid, { sig: s.sig, at: t, hash: null }]); continue; }
        const draft = col.buildSessionRecord({ origin: store.origin, sid: s.sid, summary: s.summary, entry: agentSessions.bySid(s.sid), orchestrators });
        const hash = col.hashOf(draft);
        const prev = state.sessions[s.sid];
        if (!prev || prev.hash !== hash) drafts.push(draft);
        sessionUpdates.push([s.sid, { sig: s.sig, at: t, hash, cls: draft.cls }]);
      }
      // bug-hunter items
      let bhN = 0;
      const bhUpdates = [];
      try {
        const bh = await worker.call('bh', { origin: store.origin, roots: roots(c), dirs: c.bhRunDirs });
        for (const it of bh.items || []) {
          const hash = col.hashOf(it);
          if (state.bh[it.key] === hash) continue;
          drafts.push(it); bhUpdates.push([it.key, hash]); bhN++;
        }
      } catch (e) { log(`usage collect (bug hunter): ${e.message}`); }
      // inventory, once a day
      let inventoryDraft = null;
      if (t - state.inventoryAt >= DAY_MS) {
        try {
          const inv = await worker.call('inventory', { roots: roots(c) });
          const hash = (inv.projects || []).join('|');
          if (hash !== state.inventoryHash) inventoryDraft = { type: 'inventory', key: `${store.origin}|inventory`, projects: inv.projects || [] };
          state.inventoryAt = t; state.inventoryHash = hash;
          if (inventoryDraft) drafts.push(inventoryDraft);
        } catch (e) { log(`usage collect (inventory): ${e.message}`); }
      }
      // the settings in force: a record only when something changed
      let settingsChanged = false;
      if (claudeDir) try {
        const snap = readSettings({ claudeDir, config: o.readConfig ? o.readConfig() : null });
        const last = store.records('settings').filter((r) => r.origin === store.origin).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
        if (!sameSettings(last, snap)) { drafts.push(settingsDraft({ origin: store.origin, at: new Date(t).toISOString(), snapshot: snap })); settingsChanged = true; }
      } catch (e) { log(`usage collect (settings): ${e.message}`); }
      // write first, remember after: a failed append leaves the sessions due again at the next pass
      // a record over the store's cap would refuse the whole batch and every later pass: drop it, say so, go on
      const fit = drafts.filter((d) => { const ok = Buffer.byteLength(JSON.stringify(d)) < MAX_RECORD_BYTES - 1024; if (!ok) log(`usage collect: dropped an oversized ${d.type} record`); return ok; });
      const written = fit.length ? store.append(fit) : [];
      for (const [sid, v] of sessionUpdates) state.sessions[sid] = v;
      for (const [k, h] of bhUpdates) state.bh[k] = h;
      trimOldest(state.sessions, KEEP_SESSIONS); trimOldest(state.bh, KEEP_BH);
      saveState(statePath, state);
      status.lastCollect = { at: new Date(t).toISOString(), scanned: scan.sessions.length, left: scan.left, written: written.length, bhItems: bhN, settingsChanged };
      status.collectError = null;
      return status.lastCollect;
    } catch (e) {
      status.collectError = e.message; log(`usage collect: ${e.message}`);
      return { error: e.message };
    } finally { busyCollect = false; }
  }

  /** Append a work/private override from this machine (POST /api/usage/classify). */
  function classify(project, as) {
    const d = classifyDraft(project, as);
    if (d.error) return d;
    if (!mayWrite()) return { error: 'recovering: this machine is still catching up on its own history', status: 503 };
    return { record: store.append([d])[0] };
  }

  // --- schedule ------------------------------------------------------------------------

  function schedule(which, ms, fn) {
    if (!started) return;
    clearTimer(timers[which]);
    timers[which] = setTimer(async () => { const r = await fn(); if (which === 'collect') afterCollect(r); else afterSync(); }, ms);
    if (timers[which] && typeof timers[which].unref === 'function') timers[which].unref();
  }
  function afterSync() { first = false; schedule('sync', cfg().syncMin * 60e3, syncOnce); }
  function afterCollect(r) {
    const c = cfg();
    // a backlog (a first backfill) or a machine still waiting to hear from its peers is retried soon
    const soon = r && (r.skipped === 'recovering' || (r.left > 0)) ? BACKLOG_RETRY_MS : c.collectMin * 60e3;
    schedule('collect', soon, collectOnce);
  }

  return {
    // the folders are counted, not named: this answer goes to every cluster peer and to a script's output
    status: () => { const c = cfg(); return { ...status, origin: store.origin, heads: store.heads(), answeredEver, config: { ...c, projectRoots: c.projectRoots ? c.projectRoots.length : null, bhRunDirs: c.bhRunDirs ? c.bhRunDirs.length : null }, sessionsTracked: Object.keys(state.sessions).length }; },
    syncOnce, collectOnce, classify,
    start() {
      if (started) return;
      started = true;
      const c = cfg();
      if (!c.enabled) return;
      schedule('sync', 5e3, syncOnce);
      schedule('collect', c.firstRunMin * 60e3, collectOnce);
    },
    stop() { started = false; clearTimer(timers.collect); clearTimer(timers.sync); },
  };
}

module.exports = { DEFAULTS, configFrom, createUsageService };
