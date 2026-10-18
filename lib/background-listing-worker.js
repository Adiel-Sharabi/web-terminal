'use strict';

/// The worker-thread entry for the background-agent listing (#366). It owns the spawn, the
/// timeout and the tree-kill; the main thread owns the parsing, the cache and the route.
/// See lib/background-listing-exec.js for why the spawn lives here at all.
///
/// Protocol: `{ id, req }` in, `{ id, result }` out, `result` being what the inline exec
/// resolves to. Nothing else crosses: no listing text is ever logged from here.
const { parentPort } = require('worker_threads');
const { execFile } = require('child_process');
const { killTree } = require('./git-safe');
const { createInlineExec } = require('./background-listing-exec');

if (parentPort) {
  const exec = createInlineExec({ execFile, killTree });
  parentPort.on('message', async (m) => {
    if (!m || typeof m !== 'object' || !m.req) return;
    let result;
    try { result = await exec(m.req); } catch { result = { ok: false, reason: 'worker-threw' }; }
    parentPort.postMessage({ id: m.id, result });
  });
}
