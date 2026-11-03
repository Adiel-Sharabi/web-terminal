'use strict';
// #413 - run the configured work-item command (lib/work-items.js hookConfig) with one
// JSON payload on its stdin. execFile with an argv array: no shell, no string building,
// so nothing in a payload (written partly by an agent) can reach a command line. Hidden
// window, bounded time and output. It never throws and never rejects: a failure is a
// result the caller logs, and a session's close never waits on it.

const { execFile } = require('child_process');

const MAX_OUTPUT = 64 * 1024;

/// Run [cfg] once with [payload]. Resolves to {ok:true, code:0} | {ok:false, code?, error}
/// | {ok:false, skipped:'off'}.
function runHook(cfg, payload, { exec = execFile } = {}) {
  if (!cfg || !cfg.enabled) return Promise.resolve({ ok: false, skipped: 'off' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = exec(cfg.command, cfg.args, { windowsHide: true, timeout: cfg.timeoutMs, maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL' },
        (err, _stdout, stderr) => {
          if (!err) return finish({ ok: true, code: 0 });
          const tail = String(stderr || '').trim().split(/\r?\n/).slice(-1)[0] || '';
          if (err.killed) return finish({ ok: false, error: `timed out after ${cfg.timeoutMs} ms` });
          if (typeof err.code === 'number') return finish({ ok: false, code: err.code, error: `exit ${err.code}${tail ? `: ${tail.slice(0, 200)}` : ''}` });
          finish({ ok: false, error: String(err.code || err.message).slice(0, 200) });
        });
    } catch (e) {
      return finish({ ok: false, error: String(e && e.message).slice(0, 200) });
    }
    // A program that exits without reading stdin closes the pipe under the write: EPIPE
    // must not escape as an unhandled 'error' (it would take server.js down).
    if (child && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    }
  });
}

/// One command at a time, in order, at most [max] waiting or running. A close of many
/// sessions at once (a restart, a sweep) queues instead of starting N processes.
function createQueue({ max = 100, log = (m) => console.warn(m), exec } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    enqueue(cfg, payload) {
      if (pending >= max) {
        log(`[work-items] command queue full (${max}); not run for ${payload && payload.item ? payload.item.ref : '?'}`);
        return Promise.resolve({ ok: false, skipped: 'queue-full' });
      }
      pending += 1;
      const run = tail.then(() => runHook(cfg, payload, exec ? { exec } : {}));
      tail = run.then(() => { pending -= 1; });
      return run;
    },
    get pending() { return pending; },
  };
}

module.exports = { MAX_OUTPUT, runHook, createQueue };
