'use strict';
// #567 - Mission Control's work board: the CANDIDATE sources and their cache.
//
// A candidate is a work item nobody is working on yet, listed by its tracker or by a dispatcher
// that owns it. This module owns (1) WHICH sources the board lists from (`sourcesOf`: this server's
// own GitHub repo, each configured project's repos and Azure DevOps projects, the bug hunter's
// queue) and (2) the cache that keeps the tracker queries cheap: no model, one read per source
// every `refreshMin` minutes (default 10), served stale while the next read runs, forced by an
// explicit refresh (at most once per [FORCE_MIN_MS] per source). A failed read keeps the last list
// and says why - fail visibly, never blank and never a guess.
//
// What it does NOT own: how a tracker is read (lib/tracker-meta.js list readers, injected as
// `read`), how the bug hunter's queue is read (lib/mc-bughunter.js), and which candidates are
// shown (lib/mc-board.js). Pure but for the injected `read` and the clock.
const crypto = require('crypto');
const { WIQL_NAME_RE } = require('./tracker-meta');

const DEFAULTS = Object.freeze({
  refreshMin: 10,
  perSource: 10,
  // AM8's flow (am8_core .claude/wi-flow/flow.json): Approved is "the go decision" - no role starts
  // work before it - and Reopen is QA sending work back; New is filed, nobody decided yet.
  adoStates: Object.freeze(['Approved', 'Reopen']),
  adoTypes: Object.freeze(['Bug', 'Product Backlog Item', 'Task']),
});
const FORCE_MIN_MS = 20 * 1000; // an explicit refresh re-reads a source at most this often
const RETRY_MS = 60 * 1000; // after a failed read, how long before the poll asks again
const COLD_WAIT_MS = 3000; // a poll waits this long for a source that has never answered
const BUG_HUNTER_TTL_MS = 60 * 1000; // its queue is a local file and moves with every orchestrator tick
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** A read that failed in words a person can read (a tracker's TrackerError is one too). */
class CandidateError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampInt = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const names = (v, d) => {
  const list = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && WIQL_NAME_RE.test(x.trim())).map((x) => x.trim()) : [];
  return list.length ? [...new Set(list)].slice(0, 20) : [...d];
};
const dirs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() && x.length <= 500 && !/[\0\r\n]/.test(x)).map((x) => x.trim()).slice(0, 20) : []);

/** Config `mc.board`, normalised; anything invalid falls back to its default (a typo never blanks the
 *  board). `{refreshMin, perSource, adoStates, adoTypes, bugHunter: {runDirs, roots}, repos}`.
 *  `platform`: the bug hunter's default run root is `C:\temp\bh-orch`, on Windows only. */
function boardConfig(mc, { platform = process.platform } = {}) {
  const b = isObj(mc) && isObj(mc.board) ? mc.board : {};
  const bh = isObj(b.bugHunter) ? b.bugHunter : {};
  const roots = dirs(bh.roots);
  return {
    refreshMin: clampInt(b.refreshMin, 1, 240, DEFAULTS.refreshMin),
    perSource: clampInt(b.perSource, 1, 30, DEFAULTS.perSource),
    adoStates: names(b.adoStates, DEFAULTS.adoStates),
    adoTypes: names(b.adoTypes, DEFAULTS.adoTypes),
    bugHunter: { runDirs: dirs(bh.runDirs), roots: roots.length || platform !== 'win32' ? roots : ['C:\\temp\\bh-orch'] },
    repos: (Array.isArray(b.repos) ? b.repos : []).filter((r) => typeof r === 'string' && REPO_RE.test(r.trim())).map((r) => r.trim()).slice(0, 20),
  };
}

/** The sources of this board, in the order the board lists them: this server's own GitHub repo, then
 *  each project's repos and Azure DevOps projects, then the bug hunter (ONE source: which run folders it
 *  has is found by its own read, behind the cache - a disk is never touched to LIST the sources). A repo
 *  named twice is one source (the project that names it keeps it). `projects`: validated config
 *  `projects[]`; `ownRepo`: "owner/repo" of this server's checkout or null. */
function sourcesOf({ board, projects = [], ownRepo = null }) {
  const out = [];
  const byId = new Map();
  const add = (s) => { if (!byId.has(s.id)) { byId.set(s.id, s); out.push(s); } return byId.get(s.id); };
  const ghSource = (repo, project) => add({ id: `github:${repo.toLowerCase()}`, kind: 'github', name: repo, repo, project: project || null });
  for (const p of Array.isArray(projects) ? projects : []) {
    const project = { id: p.id, name: p.name };
    for (const repo of (p.match && p.match.repos) || []) ghSource(repo, project);
    for (const ap of (p.match && p.match.adoProjects) || []) {
      if (!WIQL_NAME_RE.test(ap)) continue; // a name that could leave a WIQL string is never queried
      add({ id: `ado:${ap.toLowerCase()}`, kind: 'ado', name: ap, adoProject: ap, project, states: board.adoStates, types: board.adoTypes });
    }
  }
  if (ownRepo) ghSource(ownRepo, null).own = true; // a project that names it keeps it, and it is still the server's own
  for (const repo of board.repos) ghSource(repo, null);
  // The server's own repo leads the list.
  out.sort((a, b) => (b.own === true) - (a.own === true));
  // Its id carries a short hash of WHERE it reads (never the path): a changed `mc.board.bugHunter` is a new source, so the
  // cache never serves the old folders' queue under the new config.
  const where = crypto.createHash('sha1').update(JSON.stringify(board.bugHunter || {})).digest('hex').slice(0, 8);
  out.push({ id: `bug-hunter:${where}`, kind: 'bug-hunter', name: 'Bug hunter', project: null, dispatcher: true, ttlMs: BUG_HUNTER_TTL_MS });
  return out;
}

/** The part of a source a client is shown (never a path or a token). */
const publicSource = (s) => ({ id: s.id, kind: s.kind, name: s.name, project: s.project || null, own: s.own === true,
  dispatcher: s.dispatcher === true });

/** The cache over `read(source) -> {items, total, more, note?, claims?}` (or a throw). A read may instead answer
 *  `{notWired: why}`: the source has nothing to read on this server (kept for its refresh time like a list, so a
 *  poll does not look again at once). `claims`: keys a dispatcher's queue holds beyond the `items` it lists (the
 *  board never offers them from a tracker list). `ttlMs`: a number, or a function read at each snapshot (the live
 *  config's `refreshMin`). */
function createCandidates({ read, now = Date.now, ttlMs = DEFAULTS.refreshMin * 60e3, retryMs = RETRY_MS, forceMinMs = FORCE_MIN_MS,
  coldWaitMs = COLD_WAIT_MS, log = console.error }) {
  const cache = new Map(); // source id -> {fetchedAt, startedAt, items, total, more, error, errorAt}
  const inflight = new Map(); // source id -> the read in flight

  function start(source) {
    if (inflight.has(source.id)) return inflight.get(source.id);
    const t0 = now();
    const p = (async () => {
      const prev = cache.get(source.id) || {};
      try {
        const r = await read(source);
        const notWired = r && typeof r.notWired === 'string' && r.notWired ? r.notWired : null;
        cache.set(source.id, { fetchedAt: now(), startedAt: t0, items: Array.isArray(r && r.items) ? r.items : [], notWired,
          claims: Array.isArray(r && r.claims) ? r.claims.filter((k) => typeof k === 'string') : [],
          total: Number.isFinite(r && r.total) ? r.total : 0, more: Boolean(r && r.more), note: (r && r.note) || null, error: null, errorAt: null });
      } catch (e) {
        const shown = e instanceof CandidateError || (e && e.name === 'TrackerError') || (e && e.constructor && e.constructor.name === 'TrackerError');
        if (!shown) log(`[mc-board] ${source.id}: ${e && e.message}`);
        cache.set(source.id, { ...prev, startedAt: t0, error: shown ? e.message : 'the source could not be read', errorAt: now() });
      } finally { inflight.delete(source.id); }
    })();
    inflight.set(source.id, p);
    return p;
  }

  const hasData = (e) => Boolean(e) && Number.isFinite(e.fetchedAt);

  /** Every source's list as the cache holds it NOW, after starting the reads that are due (stale, or
   *  forced by `refresh`) and waiting up to `coldWaitMs` for the ones the reply must carry: a source that has
   *  never answered, and - on `refresh` - every source, so a Refresh shows what it just read, not the old list. */
  async function snapshot(sources, { refresh = false } = {}) {
    const t = now();
    const ids = new Set(sources.map((s) => s.id));
    for (const k of [...cache.keys()]) if (!ids.has(k)) cache.delete(k);
    const cold = [];
    for (const s of sources) {
      const e = cache.get(s.id);
      const stale = !hasData(e) || t - e.fetchedAt >= (s.ttlMs || (typeof ttlMs === 'function' ? ttlMs() : ttlMs));
      const backingOff = Boolean(e && e.errorAt && t - e.errorAt < retryMs);
      const forced = refresh && !(e && e.startedAt && t - e.startedAt < forceMinMs);
      const awaited = !hasData(e) || refresh;
      if ((stale && !backingOff) || (forced && !inflight.has(s.id))) {
        const p = start(s);
        if (awaited) cold.push(p);
      } else if (awaited && inflight.has(s.id)) cold.push(inflight.get(s.id));
    }
    if (cold.length) {
      let timer;
      await Promise.race([Promise.allSettled(cold), new Promise((r) => { timer = setTimeout(r, coldWaitMs); if (timer.unref) timer.unref(); })]);
      clearTimeout(timer);
    }
    return sources.map((s) => {
      const base = { source: publicSource(s), fetchedAt: null, total: 0, more: false, why: null, items: [], claims: [] };
      const e = cache.get(s.id);
      if (hasData(e) && e.notWired && !e.error) return { ...base, state: 'not-wired', why: e.notWired, fetchedAt: e.fetchedAt };
      if (hasData(e)) return { ...base, state: e.error ? 'stale' : 'ok', why: e.error || e.note || null, fetchedAt: e.fetchedAt, total: e.total, more: e.more, items: e.items, claims: e.claims };
      if (e && e.error) return { ...base, state: 'error', why: e.error };
      return { ...base, state: 'loading' };
    });
  }

  return { snapshot };
}

module.exports = { DEFAULTS, FORCE_MIN_MS, RETRY_MS, COLD_WAIT_MS, BUG_HUNTER_TTL_MS, CandidateError, boardConfig, sourcesOf, publicSource, createCandidates };
