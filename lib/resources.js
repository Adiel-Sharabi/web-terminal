'use strict';
// Per-server machine resources (#152, the PER-SERVER slice only — see the issue for the
// per-session and web-terminal-footprint slices, deliberately not built here).
//
// The trap this module exists to avoid: os.cpus() returns CUMULATIVE tick counters since
// boot. Reading it ONCE and turning idle/total into a percentage gives the average CPU
// usage since the machine started — not current load, and actively misleading on a
// long-uptime box (a server that has been 90% idle for three weeks still reads near-idle
// an hour into a sustained 100% burn). The only honest reading is a DELTA between two
// samples over elapsed wall-clock time, so the arithmetic is split from the sampling:
// `cpuPercentFromSamples` is PURE (two snapshots in, a percentage out) and unit-testable
// with hand-built fixtures — no timers, no real CPU load. `Sampler` is the small stateful
// wrapper that keeps one warm snapshot so a request is never the thing paying for a fresh
// os.cpus() call plus a synthetic wait.
//
// os.loadavg() is unusable here: it returns [0, 0, 0] on every Windows box in this fleet
// (Node documents the API as Unix-only). Do not reach for it.
//
// A reading with no CPU delta yet (or a malformed/untrusted one from a peer) is `null`,
// never 0 — a blank reading must never render as "0% busy", which would actively steer
// someone at exactly the wrong server.

const os = require('os');

// How often the warm sampler re-samples, and therefore the window a `cpuPct` reading
// covers. Sampling os.cpus() is cheap (no I/O), so this can run well under the sidebar's
// own poll interval without riding it — the sampler is driven by its own timer in
// server.js, not by GET /api/cluster/sessions (#152 hint 5: sampling must not ride the poll).
const SAMPLE_INTERVAL_MS = 5000;

/**
 * One point-in-time snapshot of every logical CPU's cumulative tick counters.
 * @returns {{idle: number, total: number}}
 */
function sample() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const key in cpu.times) total += cpu.times[key];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Utilisation percentage (0-100, rounded) between two `sample()`-shaped snapshots.
 * PURE — no clock read, no os module call — so it is testable with fixtures alone.
 *
 * `prev` missing, or a pair with no elapsed tick (identical samples, or a bogus
 * non-positive delta), means there is nothing to divide by: the result is `null`,
 * which the caller must render as "unknown", never as 0%.
 *
 * @param {{idle:number, total:number}|null|undefined} prev
 * @param {{idle:number, total:number}|null|undefined} next
 * @returns {number|null}
 */
function cpuPercentFromSamples(prev, next) {
  if (!prev || !next) return null;
  if (!Number.isFinite(prev.idle) || !Number.isFinite(prev.total)) return null;
  if (!Number.isFinite(next.idle) || !Number.isFinite(next.total)) return null;
  const totalDelta = next.total - prev.total;
  if (!(totalDelta > 0)) return null; // covers 0 (no time passed) and negative (bogus pair)
  const idleDelta = next.idle - prev.idle;
  const busyFrac = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(100, Math.round(busyFrac * 100)));
}

/**
 * Current memory reading. os.totalmem()/os.freemem() are correct on Windows (unlike
 * loadavg) — measured, see CLAUDE.md #152 hints.
 * @returns {{usedBytes: number, totalBytes: number, usedPct: number|null}}
 */
function memoryReading() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    usedBytes,
    totalBytes,
    usedPct: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100))) : null,
  };
}

/**
 * Keeps one warm CPU sample so a request never pays for the sampling itself. Call
 * `tick()` on a timer (server.js owns the interval); `read()` is O(1).
 */
class Sampler {
  constructor() {
    this._prev = null;
    this._cpuPct = null;
  }

  /** Take a fresh CPU sample and fold it against the previous one. */
  tick() {
    const next = sample();
    this._cpuPct = cpuPercentFromSamples(this._prev, next);
    this._prev = next;
  }

  /**
   * The current reading for this server's `resources` entry. `cpuPct` is `null`
   * until `tick()` has run at least twice (the first tick only seeds `_prev`).
   * @returns {{cpuPct: number|null, windowMs: number, memory: {usedBytes:number,totalBytes:number,usedPct:number|null}, ts: number}}
   */
  read() {
    return { cpuPct: this._cpuPct, windowMs: SAMPLE_INTERVAL_MS, memory: memoryReading(), ts: Date.now() };
  }
}

// A finite, non-negative number — the shared guard below.
function _nonNegNum(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
// A percentage: either null (unknown, never fabricated) or a finite 0-100 number.
function _pctOrNull(v) {
  return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
}

/**
 * Validates a `resources` object received from a cluster PEER before it is served
 * on to our own clients. A peer is a trusted cluster member (it authenticated with
 * our bearer token to be asked at all), but "trusted to ask" is not "trusted to
 * shape our JSON" — a buggy or compromised peer must not be able to hand a client
 * a malformed field (wrong type, NaN, Infinity, a giant string) via our merge.
 * Anything not conforming to the exact reading shape is rejected wholesale: a
 * partially-trusted number is still an unearned one.
 *
 * @param {*} r
 * @returns {null | {cpuPct: number|null, windowMs: number, memory: {usedBytes:number,totalBytes:number,usedPct:number|null}, ts: number}}
 */
function sanitizeResources(r) {
  if (!r || typeof r !== 'object') return null;
  if (!_pctOrNull(r.cpuPct)) return null;
  if (!_nonNegNum(r.windowMs)) return null;
  if (!_nonNegNum(r.ts)) return null;
  const m = r.memory;
  if (!m || typeof m !== 'object') return null;
  if (!_nonNegNum(m.usedBytes) || !_nonNegNum(m.totalBytes)) return null;
  if (!_pctOrNull(m.usedPct)) return null;
  return {
    cpuPct: r.cpuPct,
    windowMs: r.windowMs,
    memory: { usedBytes: m.usedBytes, totalBytes: m.totalBytes, usedPct: m.usedPct },
    ts: r.ts,
  };
}

module.exports = { SAMPLE_INTERVAL_MS, sample, cpuPercentFromSamples, memoryReading, Sampler, sanitizeResources };
