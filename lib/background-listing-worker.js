'use strict';

/// The worker-thread entry for the background-agent listing (#366). It owns the spawn, the
/// timeout and the tree-kill; the main thread owns the parsing, the cache and the route.
/// See lib/background-listing-exec.js for why the spawn lives here at all.
///
/// Protocol: `{ id, req }` in, `{ id, result }` out, `result` being what the inline exec
/// resolves to. Nothing else crosses: no listing text is ever logged from here.
///
/// A message carries the ABSOLUTE deadline the main thread stamped on it (see the "two
/// deadlines" note in lib/background-listing-exec.js). A request that reaches this handler
/// already past it - it waited behind a blocked spawn, and the main thread gave up on it long
/// ago - is answered "expired" and never spawned. The handler is a factory so that wiring
/// can be tested without a thread; a thread only ever runs the `parentPort` line.
const { parentPort } = require('worker_threads');
const { execFile } = require('child_process');
const { killTree } = require('./git-safe');
const { createInlineExec } = require('./background-listing-exec');

/// @param {object} o
/// @param {(req: object, deadline: number) => Promise<object>} o.exec
/// @param {(msg: object) => void} o.post
/// @param {() => number} [o.now]
function createHandler(o) {
  const now = o.now || Date.now;
  return async function onMessage(m) {
    if (!m || typeof m !== 'object' || !m.req) return;
    const t = now();
    const deadline = Number.isFinite(m.deadline) ? m.deadline : t + (Number(m.req.timeoutMs) || 0);
    if (t >= deadline) {
      o.post({ id: m.id, result: { ok: false, reason: 'expired' } });
      return;
    }
    let result;
    try { result = await o.exec(m.req, deadline); } catch { result = { ok: false, reason: 'worker-threw' }; }
    o.post({ id: m.id, result });
  };
}

if (parentPort) {
  const port = parentPort;
  port.on('message', createHandler({
    exec: createInlineExec({ execFile, killTree }),
    post: (msg) => port.postMessage(msg),
  }));
}

module.exports = { createHandler };
