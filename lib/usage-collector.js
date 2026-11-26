'use strict';
// --- The fleet usage ledger's collector: transcripts -> session records (#529) --------------
//
// Scripts only; never a model. The cost rules, because the transcripts are GIGABYTES:
//   - a session is re-read only when its files changed (a `size:mtime` signature per session);
//   - a session still being written is re-read at most every REEMIT_MS (2 h), and once it has
//     been quiet for FINAL_QUIET_MS (1 h) a final version is read - so a 50 MB transcript is not
//     re-summarised every half hour;
//   - one pass has a time budget; what is left waits for the next pass (a first backfill of weeks of
//     transcripts takes several), newest sessions first;
//   - a new record is written only when the summary actually changed.
// The reading runs in a worker thread (lib/usage-collector-worker.js): a transcript scan must never
// stall the server's event loop. This file holds the rules and the scan itself, so they are testable
// without a thread.
//
// Never in a record: prompt text, tool output. Names are the web-terminal session names the UI
// already shows.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { wanted, createSessionAccumulator } = require('./usage-session');
const { projectKey } = require('./usage-project');

const REEMIT_MS = 2 * 60 * 60e3;
const FINAL_QUIET_MS = 60 * 60e3;
const DEFAULT_BUDGET_MS = 90e3;

// --- what to read ----------------------------------------------------------------------

/** The session transcripts under `<claudeDir>/projects`: `sid -> { main, subs, sig, mtimeMs }`. A
 *  session's signature changes when any of its files does. Subagent files with no main transcript
 *  beside them are not sessions we can place (no cwd), so they are left out. */
function listSessions(claudeDir, fsx = fs) {
  const root = path.join(claudeDir, 'projects');
  const out = new Map();
  let dirs;
  try { dirs = fsx.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(root, d.name);
    let ents;
    try { ents = fsx.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sid = e.name.slice(0, -'.jsonl'.length);
      let st;
      try { st = fsx.statSync(path.join(pdir, e.name)); } catch { continue; }
      const main = { path: path.join(pdir, e.name), size: st.size, mtimeMs: Math.round(st.mtimeMs) };
      const subs = [];
      const sdir = path.join(pdir, sid, 'subagents');
      let sents = [];
      try { sents = fsx.readdirSync(sdir); } catch { /* no subagents */ }
      for (const n of sents) {
        if (!/^agent-.+\.jsonl$/.test(n)) continue;
        try {
          const s = fsx.statSync(path.join(sdir, n));
          subs.push({ path: path.join(sdir, n), agent: n.slice(0, -'.jsonl'.length), size: s.size, mtimeMs: Math.round(s.mtimeMs) });
        } catch { /* gone */ }
      }
      const mtimeMs = Math.max(main.mtimeMs, ...subs.map((s) => s.mtimeMs));
      const sig = `${main.size}:${main.mtimeMs}|${subs.length}:${subs.reduce((n, s) => n + s.size, 0)}:${Math.max(0, ...subs.map((s) => s.mtimeMs))}`;
      out.set(sid, { main, subs, sig, mtimeMs });
    }
  }
  return out;
}

/** Should this session be read now? [known] is what the main thread remembers of it:
 *  `{sig, at, final}` (`at` = ms of the last record written, `final` = the quiet-hour version is out).
 *  Pure. */
function shouldScan({ known, sig, mtimeMs, now }) {
  if (!known) return true;
  if (known.sig === sig) return false;
  const quiet = now - mtimeMs >= FINAL_QUIET_MS;
  if (quiet) return true;                        // a final version (or the first one after a resume went quiet)
  return now - (known.at || 0) >= REEMIT_MS;     // still growing: not more often than every 2 h
}

// --- reading one session ---------------------------------------------------------------

async function eachLine(file, fn, fsx = fs) {
  const rl = readline.createInterface({ input: fsx.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!wanted(line)) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      fn(o);
    }
  } finally { rl.close(); }
}

function agentTypeOf(file, fsx = fs) {
  try {
    const meta = JSON.parse(fsx.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return typeof meta.agentType === 'string' && meta.agentType ? meta.agentType.slice(0, 40) : 'unknown';
  } catch { return 'unknown'; }
}

/** The summary of one listed session (lib/usage-session.js), plus its `project`. A transcript that
 *  cannot be read answers null: the pass leaves the session as it was and tries again later. */
async function summarizeSession(listed, { activeGapMs, projectCache, fsx = fs } = {}) {
  const acc = createSessionAccumulator({ activeGapMs });
  try {
    await eachLine(listed.main.path, (o) => acc.main(o), fsx);
    for (const s of listed.subs) {
      const type = agentTypeOf(s.path, fsx);
      await eachLine(s.path, (o) => acc.sub(o, type, s.agent), fsx);
    }
  } catch { return null; }
  const summary = acc.finish();
  if (!summary) return { empty: true };
  summary.project = projectKey(summary.cwd, { fsx, cache: projectCache });
  return summary;
}

/** One pass over the transcripts: every session the rules say to read, newest first, until
 *  [budgetMs] is spent. Resolves `{ sessions: [{sid, sig, mtimeMs, summary|null, empty?}], left }`
 *  where `left` is how many were due but not reached. */
async function scanTranscripts({ claudeDir, known = {}, now = Date.now(), budgetMs = DEFAULT_BUDGET_MS, activeGapMs, projectCache = new Map(), fsx = fs, clock = Date.now }) {
  const listed = listSessions(claudeDir, fsx);
  const due = [];
  for (const [sid, l] of listed) if (shouldScan({ known: known[sid], sig: l.sig, mtimeMs: l.mtimeMs, now })) due.push([sid, l]);
  due.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
  const started = clock();
  const sessions = [];
  let i = 0;
  for (; i < due.length; i++) {
    if (clock() - started >= budgetMs) break;
    const [sid, l] = due[i];
    const summary = await summarizeSession(l, { activeGapMs, projectCache, fsx });
    if (summary && summary.empty) sessions.push({ sid, sig: l.sig, mtimeMs: l.mtimeMs, summary: null, empty: true });
    else if (summary) sessions.push({ sid, sig: l.sig, mtimeMs: l.mtimeMs, summary });
  }
  return { sessions, left: due.length - i };
}

// --- turning a summary into a record -----------------------------------------------------

const BH_WORKER_RE = /^BH worker #(\d+)/i;

/** The ledger's class of a session. Order: bug-hunter worker, bug-hunter orchestrator, what the
 *  first prompt says it is (pr-review, pipeline-check, continued, wt-automation, slash), a
 *  hand-off successor, a child, else an interactive session. */
function classOf({ facts, wt, isOrchestrator }) {
  const w = wt || {};
  if (BH_WORKER_RE.test(w.name || '')) return 'bh-worker';
  if (isOrchestrator || (facts && facts.startsBugHunter)) return 'bh-orchestrator';
  if (facts && facts.firstClass && facts.firstClass !== 'human') return facts.firstClass;
  if (Array.isArray(w.replaces) && w.replaces.length) return 'handoff';
  if (w.parentId) return 'child';
  return 'interactive';
}

function bhOf(cls, wt) {
  if (cls === 'bh-worker') { const m = BH_WORKER_RE.exec((wt && wt.name) || ''); return { item: Number(m[1]), role: 'worker' }; }
  if (cls === 'bh-orchestrator') return { item: null, role: 'orchestrator' };
  return null;
}

/** The web-terminal sessions that started bug-hunter workers: a session whose id or name is in
 *  this set is an orchestrator. [entries] are agent-session map entries (lib/usage-agent-sessions.js). */
function orchestratorKeys(entries) {
  const s = new Set();
  for (const e of entries) {
    if (!BH_WORKER_RE.test(e.name || '')) continue;
    if (e.parentId) s.add(String(e.parentId).toLowerCase());
    if (e.spawnedBy) s.add(String(e.spawnedBy).toLowerCase());
  }
  return s;
}

/** The draft of a `session` record (the store stamps origin, seq, at). [entry] is the agent-session
 *  map entry of this Claude session, or null when no hook ever named it. */
function buildSessionRecord({ origin, sid, summary, entry, orchestrators = new Set() }) {
  const wt = entry ? { name: entry.name, parentId: entry.parentId, replaces: entry.replaces, spawnedBy: entry.spawnedBy } : null;
  const isOrchestrator = Boolean(entry) && (orchestrators.has(String(entry.wtId).toLowerCase()) || (entry.name ? orchestrators.has(String(entry.name).toLowerCase()) : false));
  const cls = classOf({ facts: summary.facts, wt, isOrchestrator });
  const { facts, ...rest } = summary; // eslint-disable-line no-unused-vars
  return {
    type: 'session', key: `${origin}|${sid}`, sid,
    start: rest.start, end: rest.end, project: rest.project, branch: rest.branch || undefined,
    wtId: entry ? entry.wtId : null, name: entry ? entry.name || null : null,
    parentWt: entry ? entry.parentId || null : null, spawnedBy: entry ? entry.spawnedBy || null : null, replaces: entry && entry.replaces ? entry.replaces : undefined,
    cls, bh: bhOf(cls, wt),
    tok: rest.tok, units: rest.units, models: rest.models, sub: rest.sub, prompts: rest.prompts, wakes: rest.wakes,
    time: rest.time, compactions: rest.compactions, peakCtx: rest.peakCtx, byDay: rest.byDay, quality: rest.quality,
  };
}

/** A stable fingerprint of a draft: when it equals the last one written, nothing is written. The
 *  parts that move with the session's identity (name, class) are in it, so a rename or a later
 *  attribution is a change. */
function hashOf(draft) {
  return crypto.createHash('sha1').update(JSON.stringify(draft)).digest('hex').slice(0, 16);
}

module.exports = {
  REEMIT_MS, FINAL_QUIET_MS, DEFAULT_BUDGET_MS, BH_WORKER_RE,
  listSessions, shouldScan, summarizeSession, scanTranscripts, classOf, bhOf, orchestratorKeys, buildSessionRecord, hashOf,
};
