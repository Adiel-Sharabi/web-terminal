'use strict';
// --- Usage logs (#425) --------------------------------------------------------
//
// Three small jsonl logs the server writes for ITS OWNER to read afterwards, none of
// them ever shown to an agent (so they cost no tokens):
//   handoff-skips.jsonl   - a hand-off candidate the automatic scan looked at and did NOT hand off, and why
//   session-cost.jsonl    - sampled statusLine `cost` + context size per session
//   device-views.jsonl    - a client attaching to / switching mode on / leaving a session
// Only server.js requires this module (pty-worker.js and monitor.js do not), so a
// change here deploys by hot reload.
//
// WHAT IS RECORDED: ids, times, numbers, reasons. NEVER prompt text, never a token.
// The client address comes from lib/device-ops.js clientSource (#311) - one owner.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 20 * 1024 * 1024; // one generation kept as `<file>.1`

const _sizes = new Map();   // file -> bytes written so far (approximate after a restart: stat'd once)
const _errored = new Set(); // files whose first failure has been reported

function reportOnce(file, what) {
  if (_errored.has(file)) return;
  _errored.add(file);
  console.error(`[${new Date().toISOString()}] usage-log: ${path.basename(file)}: ${what}; further failures not logged`);
}

/// Append one record, best effort: asynchronous, never throws into the caller, one error
/// line per file and then quiet (the lib/device-ops.js pattern). Past [maxBytes] the file
/// becomes `<file>.1` (replacing the previous one), so a log is bounded at 2 x [maxBytes].
function appendRecord(file, rec, maxBytes = MAX_BYTES) {
  try {
    if (!file) return;
    if (!_sizes.has(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* none yet */ }
      _sizes.set(file, size);
    }
    const line = `${JSON.stringify(rec)}\n`;
    const bytes = Buffer.byteLength(line);
    if (_sizes.get(file) + bytes > maxBytes) {
      try {
        fs.renameSync(file, `${file}.1`);
        _sizes.set(file, 0);
      } catch (err) {
        if (err.code === 'ENOENT') _sizes.set(file, 0); // nothing there to roll
        else reportOnce(file, `cannot roll over (${err.code || err.message})`); // size stays: retried on the next record
      }
    }
    _sizes.set(file, _sizes.get(file) + bytes);
    fs.appendFile(file, line, (err) => {
      if (err && !_errored.has(file)) {
        _errored.add(file);
        console.error(`[${new Date().toISOString()}] usage-log: cannot append to ${path.basename(file)} (${err.code || err.message}); further failures not logged`);
      }
    });
  } catch (err) {
    if (!_errored.has(file)) {
      _errored.add(file);
      console.error(`[${new Date().toISOString()}] usage-log: ${err.message}; further failures not logged`);
    }
  }
}

// --- hand-off skips ------------------------------------------------------------

const SKIP_REPEAT_MS = 15 * 60e3;  // the same reason again: at most this often per session

/// Should a skip be logged? [prev] is the last LOGGED `{reason, at}` for the session: a
/// CHANGED reason is news and always logs (the scan itself runs only every autoEveryMs, so
/// a flapping status is bounded by that); the same reason again waits SKIP_REPEAT_MS.
/// Pure: the caller owns the map.
function shouldLogSkip(prev, reason, now) {
  if (!prev) return true;
  return prev.reason !== reason || now - prev.at >= SKIP_REPEAT_MS;
}

/// One skip line. [reason] is the gate the code itself named (lib/handoff.js
/// handoffCandidate `why`, autoBlock's answer, or the scan's own `not-idle`).
function skipRecord({ id, name, agent, reason, source, ctxTokens, status }, now) {
  return {
    at: new Date(now).toISOString(), event: 'skipped', id, name: name || null, agent: agent || null,
    reason, source, status: status || null,
    ctxTokens: Number.isFinite(ctxTokens) ? ctxTokens : null,
  };
}

// --- session cost --------------------------------------------------------------

const COST_EVERY_MS = 5 * 60e3;
const COST_STEP_USD = 0.25;

/// The statusLine payload's `cost` object as given: its primitive number/string/boolean
/// fields only (a nested object or array is not copied). null when it carries nothing.
function costFields(body) {
  const c = body && typeof body.cost === 'object' && body.cost ? body.cost : null;
  if (!c || Array.isArray(c)) return null;
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number' ? Number.isFinite(v) : (typeof v === 'string' && v.length <= 64) || typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/// Sample a cost report? [prev] is the last LOGGED `{at, usd}` for the session: log the
/// first, then every COST_EVERY_MS, or sooner when the dollar total moved by a step.
function shouldLogCost(prev, cost, now) {
  if (!cost) return false;
  if (!prev) return true;
  if (now - prev.at >= COST_EVERY_MS) return true;
  const usd = cost.total_cost_usd;
  return typeof usd === 'number' && typeof prev.usd === 'number' && Math.abs(usd - prev.usd) >= COST_STEP_USD;
}

/// One cost line from the raw payload [body] and the parsed metrics [parsed]
/// (lib/metrics-claude.js owns what the context fields mean). [id] is the web-terminal
/// session when a hook has told us which one owns this agent session, else null.
function costRecord({ id, agentSessionId, cost, parsed, body }, now) {
  const model = body && body.model && typeof body.model === 'object' && typeof body.model.id === 'string' ? body.model.id.slice(0, 80) : null;
  return {
    t: new Date(now).toISOString(), id: id || null, agentSessionId, model, cost,
    ctxTokens: parsed && Number.isFinite(parsed.ctxTokens) ? parsed.ctxTokens : null,
    ctxWindow: parsed && Number.isFinite(parsed.ctxWindow) ? parsed.ctxWindow : null,
  };
}

// --- viewer time per device ----------------------------------------------------

/// One viewer line. [event] is attach | mode | detach; [src] is deviceOps.clientSource(req);
/// [ms] (detach only) is how long the socket was attached. No content.
function viewRecord(event, { id, mode, src, server, ms }, now) {
  const rec = { t: new Date(now).toISOString(), event, id, mode, src, server };
  if (Number.isFinite(ms)) rec.ms = ms;
  return rec;
}

module.exports = {
  MAX_BYTES, SKIP_REPEAT_MS, COST_EVERY_MS, COST_STEP_USD,
  appendRecord, shouldLogSkip, skipRecord, costFields, shouldLogCost, costRecord, viewRecord,
};
