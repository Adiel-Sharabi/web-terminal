'use strict';
// #567 - Mission Control's work board: the bug hunter's queue, READ - never reimplemented.
//
// The bug hunter has its own dispatcher (am8_core `.claude/skills/dds-bug-hunter/orchestrator`,
// `next.ps1`): its queue is `run.json`'s `queue` in the run folder the orchestrator was started with
// (`C:\temp\bh-orch` by default, one dated folder per run). This module only finds those folders and
// reads the queue as the orchestrator wrote it: the order is its order, an entry the owner marked
// hands-off (`handsOff`, the entry's item or any `also` id) is shown as hands-off, and nothing here
// starts, closes or requeues anything. The titles come from the tracker reader (lib/tracker-meta.js).
//
// A folder this server cannot read (the orchestrator runs on another machine, nothing configured) is
// no queue: the board says "not wired yet" and why, never a guess. The paths come from the server's
// own config (`mc.board.bugHunter`), never from a request.
//
// Every disk read here is ASYNC (`fs.promises`, injected as `fsx` for tests): the folder may be a UNC
// share that is offline, and a synchronous read of it would stall the whole server. The caller
// (lib/mc-candidates.js) runs it behind its cache and bounds what a request waits for.
const fs = require('fs');
const path = require('path');

const RUN_FILE = 'run.json';
const MAX_BYTES = 2 * 1024 * 1024;
const ACTIVE_MS = 7 * 24 * 3600e3; // a discovered folder older than this is a finished run
const MAX_DIRS = 12;
const MAX_CHILDREN = 200; // folders of a run root that are looked into (the newest-named: dated names sort by age)
const MAX_QUEUE = 500;
const ID_RE = /^\d{1,9}$/;

const num = (v) => (Number.isFinite(v) ? v : null);
const ms = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const cleanDirs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() && x.length <= 500 && !/[\0\r\n]/.test(x)).map((x) => x.trim()) : []);

/** The run folders to read: every explicit `dirs` entry that holds a run.json, plus the ONE newest run
 *  found under `roots` (a root itself or a child folder holding a run.json written within [ACTIVE_MS] of
 *  `now`): an orchestrator keeps one dated folder per run, and the older ones are finished runs whose
 *  queue is somebody else's history. Newest first, at most [MAX_DIRS]. `[{dir, mtime}]`. Async. */
async function discoverRunDirs({ dirs = [], roots = [], now = Date.now(), fsx = fs.promises } = {}) {
  const probe = async (dir) => {
    try {
      const st = await fsx.stat(path.join(dir, RUN_FILE));
      return st.isFile() ? { dir, mtime: st.mtimeMs } : null;
    } catch { return null; }
  };
  const underRoot = async (root) => {
    let names = [];
    try { names = (await fsx.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* a missing root has no runs */ }
    names = names.sort().reverse().slice(0, MAX_CHILDREN);
    return Promise.all([probe(root), ...names.map((n) => probe(path.join(root, n)))]);
  };
  const explicit = (await Promise.all(cleanDirs(dirs).map(probe))).filter(Boolean);
  const recent = (await Promise.all(cleanDirs(roots).map(underRoot))).flat().filter((d) => d && now - d.mtime <= ACTIVE_MS);
  const newest = recent.sort((a, b) => b.mtime - a.mtime)[0];
  const found = new Map();
  for (const d of [...explicit, ...(newest ? [newest] : [])]) found.set(path.resolve(d.dir), d); // a folder named twice is one
  return [...found.values()].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_DIRS);
}

/** A run folder's queue as the orchestrator recorded it. `{ok: true, dir, name, queue, running, updatedAt}`
 *  or `{ok: false, dir, why}`. `queue`: `[{id, key, also, slot, queuedAt, handsOff}]` in the dispatcher's
 *  order (an entry whose item is not a work-item number is not listed). Async. */
async function readRun(dir, fsx = fs.promises) {
  let text;
  let updatedAt;
  try {
    const f = path.join(dir, RUN_FILE);
    const st = await fsx.stat(f);
    if (st.size > MAX_BYTES) return { ok: false, dir, why: `run.json is larger than ${MAX_BYTES >> 20} MB` };
    text = await fsx.readFile(f, 'utf8');
    updatedAt = st.mtimeMs;
  } catch (e) { return { ok: false, dir, why: `run.json is not readable (${e && e.code ? e.code : 'error'})` }; }
  let run;
  try { run = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { ok: false, dir, why: 'run.json is not valid JSON' }; }
  if (!run || typeof run !== 'object') return { ok: false, dir, why: 'run.json is not a run' };
  const handsOff = new Set((Array.isArray(run.handsOff) ? run.handsOff : []).map((x) => String(x)));
  const queue = [];
  for (const q of (Array.isArray(run.queue) ? run.queue : []).slice(0, MAX_QUEUE)) {
    const id = q && typeof q === 'object' ? String(q.item) : '';
    if (!ID_RE.test(id)) continue;
    const also = (Array.isArray(q.also) ? q.also : []).map((x) => String(x)).filter((x) => ID_RE.test(x));
    queue.push({ id, key: `ado:${Number(id)}`, also, slot: typeof q.slot === 'string' ? q.slot.slice(0, 40) : null,
      queuedAt: ms(q.queuedAt), handsOff: handsOff.has(id) || also.some((a) => handsOff.has(a)) });
  }
  const running = (Array.isArray(run.workers) ? run.workers : []).filter((w) => w && (w.state === 'running' || w.state === 'starting')).length;
  const name = typeof run.orchestratorSession === 'string' && run.orchestratorSession.trim() ? run.orchestratorSession.trim().slice(0, 60) : path.basename(dir);
  return { ok: true, dir, name, queue, running, updatedAt: num(updatedAt) };
}

/** The queues of several runs as ONE list. `runs`: `readRun` answers, newest run first. An item queued in two
 *  runs is listed once, as the NEWEST run has it (its hands-off mark and queue time are the current ones); a
 *  run that could not be read adds nothing. `{queue, running, runs}`: `runs` = the readable ones. */
function mergeRuns(runs) {
  const ok = (Array.isArray(runs) ? runs : []).filter((r) => r && r.ok);
  const seen = new Set();
  const queue = [];
  for (const r of ok) for (const q of r.queue) if (!seen.has(q.key)) { seen.add(q.key); queue.push(q); }
  return { queue, running: ok.reduce((n, r) => n + r.running, 0), runs: ok };
}

module.exports = { RUN_FILE, ACTIVE_MS, MAX_DIRS, MAX_CHILDREN, discoverRunDirs, readRun, mergeRuns };
