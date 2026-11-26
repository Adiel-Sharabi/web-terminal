'use strict';

/// The worker-thread entry of the fleet usage collector (#529): the heavy, blocking reads - every
/// session transcript, the bug-hunter run dirs, the project inventory - happen here, never on the loop
/// that serves requests. The main thread (lib/usage-service.js) owns the state, the store and every
/// write; this thread only READS and answers.
///
/// Protocol: `{ id, op, req }` in; `{ id, result }` or `{ id, error }` out. The handlers are exported so
/// a test (and WT_TEST) can run them inline without a thread.
const fs = require('fs');
const { scanTranscripts } = require('./usage-collector');
const { discoverRunDirs, scanBhDirs } = require('./usage-bh');
const { reposUnder } = require('./usage-project');

const handlers = {
  /** `{claudeDir, known, now, budgetMs, activeGapMs, projectCache}` -> `{sessions, left, projectCache}` */
  async scan(req) {
    const cache = new Map(Object.entries(req.projectCache || {}));
    const r = await scanTranscripts({ claudeDir: req.claudeDir, known: req.known || {}, now: req.now, budgetMs: req.budgetMs, activeGapMs: req.activeGapMs, projectCache: cache });
    return { ...r, projectCache: Object.fromEntries([...cache].slice(-5000)) };
  },
  /** `{origin, roots, dirs}` -> `{items}` (the run dirs: `dirs` when named, else every `<root>/<repo>/.claude/bug-hunter`) */
  async bh(req) {
    const dirs = Array.isArray(req.dirs) && req.dirs.length ? req.dirs : discoverRunDirs(req.roots || []);
    return { items: scanBhDirs(dirs, { origin: req.origin }), runDirs: dirs.length };
  },
  /** `{roots}` -> `{projects}` */
  async inventory(req) {
    const all = new Set();
    for (const root of req.roots || []) for (const p of reposUnder(root, fs)) all.add(p);
    return { projects: [...all].sort() };
  },
};

function createHandler({ post }) {
  return async function onMessage(m) {
    if (!m || typeof m !== 'object' || typeof m.op !== 'string' || !handlers[m.op]) { if (m && m.id !== undefined) post({ id: m.id, error: 'unknown op' }); return; }
    try { post({ id: m.id, result: await handlers[m.op](m.req || {}) }); } catch (e) { post({ id: m.id, error: (e && e.message) || 'failed' }); }
  };
}

const { parentPort } = require('worker_threads');
if (parentPort) {
  const port = parentPort;
  port.on('message', createHandler({ post: (msg) => port.postMessage(msg) }));
}

module.exports = { handlers, createHandler };
