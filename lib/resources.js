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
    for (const key of Object.keys(cpu.times)) total += cpu.times[key];
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
 *
 * #165 — `availBytes` is the HEADROOM, and it is the number this readout leads with.
 * A percentage saturates exactly where the decision matters: 92% -> 98% is six points
 * while the room underneath goes 2.5 GB -> 0.65 GB, the difference between a box that
 * copes and one that is unusable. Above ~90% the percentage has almost no dynamic range
 * left, and picking a box is the entire purpose of this feature.
 *
 * It costs NOTHING and therefore rides this always-on sampler rather than the on-demand
 * process snapshot: `os.freemem()` IS Windows' Available (measured 2026-08-26 against
 * `Win32_PerfRawData_PerfOS_Memory.AvailableBytes` — 35.08 GB vs 35.02 GB, seconds
 * apart), which is also why `usedBytes` above is honestly `Total - Available` and is not
 * inflated by the file cache. Putting headroom behind GET /api/resources would make the
 * primary readout unavailable on every server nobody has opened the panel for.
 *
 * The pressure half (`pageReadsPerSec`) is the opposite case — it needs a CIM counter, so
 * it is folded into lib/process-tree.js's existing snapshot pair and merged into this
 * block by `shapeReport`. See that module for why it must never come near this timer.
 *
 * @returns {{usedBytes: number, totalBytes: number, availBytes: number, usedPct: number|null}}
 */
function memoryReading() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    usedBytes,
    totalBytes,
    // Derived from the SAME pair of reads as usedBytes, never sampled again: two reads a
    // moment apart would describe a box with memory that is neither used nor free.
    availBytes: freeBytes,
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
   * @returns {{cpuPct: number|null, windowMs: number, memory: {usedBytes:number,totalBytes:number,availBytes:number,usedPct:number|null}, ts: number}}
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
 * @returns {null | {cpuPct: number|null, windowMs: number, memory: {usedBytes:number,totalBytes:number,availBytes:number|null,usedPct:number|null}, ts: number}}
 */
function sanitizeResources(r) {
  if (!r || typeof r !== 'object') return null;
  if (!_pctOrNull(r.cpuPct)) return null;
  if (!_nonNegNum(r.windowMs)) return null;
  if (!_nonNegNum(r.ts)) return null;
  const m = r.memory;
  if (!m || typeof m !== 'object') return null;
  if (!_nonNegNum(m.usedBytes) || !_nonNegNum(m.totalBytes)) return null;
  // Cross-field, not just per-field: each number can be individually well-formed and
  // still describe an impossible machine (more memory used than exists). Validating
  // fields in isolation would pass {usedBytes:1e300, totalBytes:1} straight to the
  // sidebar, which would render it as fact.
  if (m.usedBytes > m.totalBytes) return null;
  // A machine with no memory does not exist, and #165 made the consequence worse than
  // the admission: {0, 0, 0} used to render neutrally, but headroom colours on the
  // ABSOLUTE figure, so zero free now paints red. A peer reporting it is broken, not
  // full — and "broken" must read as unknown, never as the most alarming state on the
  // board. `os.totalmem()` is never 0, so this can only arrive from a peer.
  if (m.totalBytes === 0) return null;
  if (!_pctOrNull(m.usedPct)) return null;
  // #165 — headroom gets the SAME treatment, and it matters more here than anywhere
  // else in this object because it is the figure the readout leads with and the one a
  // box is chosen on. Absent means the peer predates the field: that is `null`
  // (unknown, rendered as a dash), never 0 — a 0 says "this box has no memory left"
  // about a server that simply has an older build. A PRESENT but impossible value
  // (negative, NaN, or more free memory than the machine has) rejects the whole reading,
  // like every other field here: a partially-trusted number is still an unearned one.
  const avail = m.availBytes === undefined ? null : m.availBytes;
  if (avail !== null) {
    if (!_nonNegNum(avail) || avail > m.totalBytes) return null;
    // The TRIPLE, not two more pairs. `used <= total` and `avail <= total` can BOTH hold
    // while the three numbers describe no machine that exists — and the survivor of that
    // gap is the worst reading this feature can produce. {used: 16 GiB, total: 32 GiB,
    // avail: 0, usedPct: 50} passes every pairwise check and renders as
    // `MEM 0.0G free of 32.0G (50%)` in the u-hot class: a box with half its memory
    // spare, shown in red, which is precisely the inversion #165 exists to prevent.
    //
    // The tolerance is 1% of total rather than exact equality. Our own memoryReading()
    // derives both halves from ONE pair of reads so they agree to the byte, but a peer is
    // an independent implementation and may read them a moment apart, and a box can
    // allocate real memory in between. 1% is proportionate at every size (~328 MB on a
    // 32 GB box) — far above any sampling skew, far below any contradiction worth
    // catching. Violating it rejects the WHOLE reading, like every other impossible value
    // here: a partially-trusted number is still an unearned one.
    if (Math.abs((m.usedBytes + avail) - m.totalBytes) > m.totalBytes * 0.01) return null;
  }
  return {
    cpuPct: r.cpuPct,
    windowMs: r.windowMs,
    memory: { usedBytes: m.usedBytes, totalBytes: m.totalBytes, availBytes: avail, usedPct: m.usedPct },
    ts: r.ts,
  };
}

module.exports = { SAMPLE_INTERVAL_MS, cpuPercentFromSamples, memoryReading, Sampler, sanitizeResources };
