'use strict';
// --- Bug-hunter runs in the fleet usage ledger (#529) ------------------------------------
//
// A bug-hunter run dir (`<repo>/.claude/bug-hunter/`, or `bug-hunter-1a/` for Bug Hunter 1A and 2A) holds `state.json` (what the orchestrator
// recorded per work item under `processed`) and, once the bug hunter writes it, `events.jsonl`
// (one object per line; every line has `at`, `item`, `kind`):
//   gate       {phase, criterion, status: PASS|FAIL|SKIP, detail}
//   review     {by: reviewer|verifier|pre-pr|pr-thread, verdict, attempt}
//   phase      {phase}
//   worker     {wtId, name, attempt, model}
//   outcome    {outcome, reason}
//   complexity {files, linesAdded, linesDeleted, layers[], gui, hw, db}
// state.json is written by many hands and is wildly uneven between items, so only the fields named
// below are read, each checked for its type; anything else is ignored. events.jsonl may not exist
// yet (an older bug hunter): that is a run with no events, never an error.
//
// One `bh-item` record per (run dir, item, start). Its tokens are NOT in it: they come from the
// session records, joined at report time (a worker session's `bh.item`).
//
// Free text is cut short and kept to what the ledger needs (an escalation's reason).

const fs = require('fs');
const path = require('path');

const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const REASON_MAX = 120;

// Bug Hunter 1A and 2A keep their state in their own folder (their init-run.ps1 default), never in Bug Hunter 1's.
const RUN_DIR_NAMES = ['bug-hunter', 'bug-hunter-1a'];

const RUN_SLACK_MS = 5 * 60e3;
const str = (x, n = 80) => (typeof x === 'string' && x ? x.slice(0, n) : null);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const iso = (x) => { const t = Date.parse(x); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** The run dirs under [roots]: `<root>/<repo>/.claude/<RUN_DIR_NAMES>` that hold a `state.json`. */
function discoverRunDirs(roots, fsx = fs) {
  const out = [];
  for (const root of roots) {
    let ents;
    try { ents = fsx.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      for (const name of RUN_DIR_NAMES) {
        const dir = path.join(root, e.name, '.claude', name);
        try { if (fsx.statSync(path.join(dir, 'state.json')).isFile()) out.push(dir); } catch { /* none */ }
      }
    }
  }
  return out;
}

/** The events of a run dir, parsed, grouped by item. A torn or foreign line is skipped. */
function readEvents(dir, fsx = fs) {
  const by = new Map();
  let text;
  try {
    const f = path.join(dir, 'events.jsonl');
    const size = fsx.statSync(f).size;
    text = size > MAX_EVENTS_BYTES ? null : fsx.readFileSync(f, 'utf8');
  } catch { return by; }
  if (!text) return by;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object' || !Number.isInteger(o.item) || typeof o.kind !== 'string' || !Number.isFinite(Date.parse(o.at))) continue;
    (by.get(o.item) || by.set(o.item, []).get(o.item)).push(o);
  }
  for (const arr of by.values()) arr.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return by;
}

/** A record is capped at 64 KB: these keep an item that ran for days under it. */
const MAX_PHASES = 60;
const MAX_LIST = 20;
const MAX_GATES = 40;

/** Fold one item's events (`gate`, `review`, `phase`, `worker`, `outcome`, `complexity`). */
function foldEvents(events) {
  const r = { phases: [], gates: { pass: 0, fail: 0, byGate: {} }, reviews: {}, workers: [], models: [], outcome: null, complexity: null, attempts: 0 };
  for (const e of events || []) {
    if (e.kind === 'phase' && str(e.phase, 40)) { if (r.phases.length < MAX_PHASES) r.phases.push({ phase: str(e.phase, 40), at: iso(e.at) }); }
    else if (e.kind === 'gate') {
      const status = String(e.status || '').toUpperCase();
      if (status !== 'PASS' && status !== 'FAIL') continue;
      const g = str(e.criterion, 60) || str(e.phase, 40) || 'gate';
      const b = r.gates.byGate[g] || (Object.keys(r.gates.byGate).length < MAX_GATES ? (r.gates.byGate[g] = { pass: 0, fail: 0 }) : { pass: 0, fail: 0 });
      if (status === 'PASS') { r.gates.pass++; b.pass++; } else { r.gates.fail++; b.fail++; }
    } else if (e.kind === 'review') {
      const k = `${str(e.by, 20) || 'review'}:${str(e.verdict, 20) || '?'}`;
      if (k in r.reviews || Object.keys(r.reviews).length < MAX_LIST) r.reviews[k] = (r.reviews[k] || 0) + 1;
    } else if (e.kind === 'worker') {
      const w = str(e.wtId, 40);
      if (w && !r.workers.includes(w) && r.workers.length < MAX_LIST) r.workers.push(w);
      const m = str(e.model, 40);
      if (m && !r.models.includes(m) && r.models.length < MAX_LIST) r.models.push(m);
      r.attempts = Math.max(r.attempts, num(e.attempt) || 0);
    } else if (e.kind === 'outcome') {
      r.outcome = { outcome: str(e.outcome, 40), reason: str(e.reason, REASON_MAX) };
    } else if (e.kind === 'complexity') {
      r.complexity = {
        files: num(e.files), linesAdded: num(e.linesAdded), linesDeleted: num(e.linesDeleted),
        layers: Array.isArray(e.layers) ? e.layers.map((x) => str(x, 24)).filter(Boolean).slice(0, 12) : [],
        gui: e.gui === true, hw: e.hw === true, db: e.db === true,
      };
    }
  }
  return r;
}

/**
 * The LATEST run in an item's events [evs] (sorted, valid `at`): a run opens at a `worker` and is closed by an
 * `outcome` other than `lost`; a `lost` outcome followed by a worker is a retry inside the same run.
 * Returns the run's events, and the `at` of its last closing outcome (null while it still runs).
 */
function latestRun(evs) {
  let from = 0;
  let closed = false;
  evs.forEach((e, i) => {
    if (e.kind === 'worker' && closed) { from = i; closed = false; }
    if (e.kind === 'outcome' && e.outcome !== 'lost') closed = true;
  });
  const run = evs.slice(from);
  const last = run.filter((e) => e.kind === 'outcome' && e.outcome !== 'lost').pop();
  return { run, closedAt: last ? last.at : null };
}

/** The draft of one `bh-item` record from a state.json entry [st] and the item's events. */
function buildBhItem({ origin, run, item, st, events }) {
  let startedAt = iso(st.startedAt);
  let finishedAt = iso(st.finishedAt);
  let own;
  if (startedAt) {
    // state.json holds the LATEST run of an item, but events.jsonl keeps every run: only this run's events belong here
    const lo = Date.parse(startedAt) - RUN_SLACK_MS;
    const hi = finishedAt ? Date.parse(finishedAt) + RUN_SLACK_MS : Infinity;
    own = (events || []).filter((e) => { const t = Date.parse(e.at); return t >= lo && t <= hi; });
  } else {
    // a worker does not stamp state.json: the ledger is then the source of truth for when the run started and ended
    const evs = (events || []).filter((e) => Number.isFinite(Date.parse(e.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const r = latestRun(evs);
    own = r.run;
    startedAt = own.length ? iso(own[0].at) : null;
    if (!finishedAt) finishedAt = iso(r.closedAt);
  }
  const f = foldEvents(own);
  const stateOutcome = str(st.outcome, 40);
  const outcome = (f.outcome && f.outcome.outcome) || stateOutcome;
  const reason = (f.outcome && f.outcome.reason) || str(st.reason, REASON_MAX);
  const attempts = f.attempts || num(st.attempt) || (startedAt ? 1 : null);
  return {
    type: 'bh-item', key: `${origin}|bh|${run}|${item}|${startedAt || finishedAt || '-'}`,
    run, item: Number(item), outcome, band: typeof st.band === 'string' ? st.band.slice(0, 20) : null,
    attempts, startedAt, finishedAt,
    durationMin: num(st.durationMinutes),
    phases: f.phases, gates: f.gates, reviews: f.reviews,
    escalation: isEscalated(outcome) ? { outcome, reason: reason || null } : null,
    complexity: f.complexity, workers: f.workers, models: f.models,
    hasEvents: own.length > 0,
  };
}

const FIXED = /^(fixed|fixed-pushed|pr-open)$/;
const ESCALATED = /^(needs-developer|paused-for-opus|blocked|fix-failed|held-for-qa-smoke)$/;
const isFixed = (o) => FIXED.test(String(o || ''));
const isEscalated = (o) => ESCALATED.test(String(o || ''));

/** Every `bh-item` draft of the run dirs [dirs]. */
function scanBhDirs(dirs, { origin, fsx = fs } = {}) {
  const out = [];
  for (const dir of dirs) {
    let state;
    try { state = JSON.parse(fsx.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { continue; }
    const processed = state && typeof state.processed === 'object' && state.processed ? state.processed : {};
    const run = path.basename(path.dirname(path.dirname(dir))).slice(0, 60);
    const events = readEvents(dir, fsx);
    for (const [item, st] of Object.entries(processed)) {
      if (!/^\d+$/.test(item) || !st || typeof st !== 'object') continue;
      out.push(buildBhItem({ origin, run, item, st, events: events.get(Number(item)) }));
    }
  }
  return out;
}

module.exports = { REASON_MAX, isFixed, isEscalated, discoverRunDirs, readEvents, foldEvents, buildBhItem, scanBhDirs };
