'use strict';
// --- The collector's thread (#529) -------------------------------------------------------
//
// `call(op, req)` runs a handler of lib/usage-collector-worker.js. Two hosts, one interface:
//   createThreadedWorker - a single long-lived worker thread, made on first use. A thread that dies is
//                          replaced on the next call; the call that was in flight rejects. The thread never
//                          keeps the server alive. Used by server.js.
//   createInlineWorker   - the handlers called on this thread. Used by WT_TEST and the specs.

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'usage-collector-worker.js');
const CALL_TIMEOUT_MS = 15 * 60e3;

function createInlineWorker() {
  const { handlers } = require('./usage-collector-worker');
  return { call: (op, req) => (handlers[op] ? handlers[op](req || {}) : Promise.reject(new Error('unknown op'))), dispose() {} };
}

function createThreadedWorker({ workerPath = WORKER_PATH, WorkerCtor = Worker, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map(); // id -> { worker, resolve, reject, timer }

  function drop(w, why) {
    if (worker === w) worker = null;
    for (const [id, p] of [...pending]) {
      if (p.worker !== w) continue;
      pending.delete(id); clearTimeout(p.timer); p.reject(new Error(why));
    }
  }
  function start() {
    const w = new WorkerCtor(workerPath);
    if (typeof w.unref === 'function') w.unref();
    w.on('message', (m) => {
      const p = m && pending.get(m.id);
      if (!p || p.worker !== w) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result);
    });
    w.on('error', () => drop(w, 'usage worker error'));
    w.on('exit', () => drop(w, 'usage worker exited'));
    return w;
  }
  return {
    call(op, req) {
      return new Promise((resolve, reject) => {
        const w = worker || (worker = start());
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('usage worker timed out')); }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, { worker: w, resolve, reject, timer });
        try { w.postMessage({ id, op, req }); } catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
    dispose() { const w = worker; worker = null; if (w) { drop(w, 'disposed'); w.terminate().catch(() => {}); } },
  };
}

module.exports = { createInlineWorker, createThreadedWorker };
