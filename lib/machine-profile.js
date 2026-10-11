'use strict';
// #331 - what the dashboard's Machines section needs to answer "which machine should I
// open a new session on?": free disk per fixed drive, free memory, free VIRTUAL memory
// (commit), CPU load, how many sessions it already runs against its limit, and uptime.
//
// Virtual memory is in here because it is the limit a new session actually hits first on
// a box with a page file, and it is NOT what free memory says. Measured on Home
// 2026-10-11: 33 GB physical free, 19.5 GB commit free. A box can look roomy by the
// sidebar's MEM figure and still refuse allocations.
//
// COST is the design, exactly as for GET /api/resources (#152): commit and the drive list
// need a CIM query, and Windows has no cheaper way to ask. A cold CIM session costs ~2.4 s
// (lib/process-tree.js measured it), so this is read ON DEMAND (only while a client has
// the Machines section open), cached for PROFILE_TTL_MS, and one in-flight query is shared
// by every caller. Nothing here runs on a timer.
//
// The rule for "low" lives HERE, once, and ships on the wire as `level` on each reading,
// so the web dashboard and the companion colour the same box the same way without either
// carrying a copy of the thresholds.
//
// A reading that could not be taken is `null` and renders as unknown, never 0: a 0 here
// says "this box is full" (or for CPU, "idle, put your work here"), which is the wrong
// answer this feature exists to prevent.

const os = require('os');
const { execFile } = require('child_process');

const PROFILE_TTL_MS = 60000;
// A query older than this no longer holds the in-flight slot (lib/process-tree.js #280:
// a hung PowerShell took 25s to call back on office-tests, past execFile's own timeout).
const INFLIGHT_MAX_MS = 30000;

const GB = 1024 * 1024 * 1024;
// Free space below which a reading is `hot` / `warn`. Bytes, not percent: a 2 TB drive
// at 5% still has 100 GB to work in, and a 256 GB one at 20% is close to full for a
// build. Memory matches the sidebar's MEM headroom colours (app.html MEM_HEADROOM_*).
const THRESHOLDS = Object.freeze({
  memory: { hot: 2 * GB, warn: 4 * GB },
  commit: { hot: 2 * GB, warn: 6 * GB },
  disk: { hot: 10 * GB, warn: 40 * GB },
  cpuPct: { hot: 90, warn: 70 },
});

const TAG_OS = 'OS';
const TAG_DISK = 'DISK';

/** `ok` | `warn` | `hot` for a free-bytes reading, or null when it is unknown. */
function freeLevel(freeBytes, t) {
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) return null;
  if (freeBytes < t.hot) return 'hot';
  if (freeBytes < t.warn) return 'warn';
  return 'ok';
}

/** The same for a CPU percentage, where HIGH is bad. */
function cpuLevel(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (pct >= THRESHOLDS.cpuPct.hot) return 'hot';
  if (pct >= THRESHOLDS.cpuPct.warn) return 'warn';
  return 'ok';
}

/** A session count against the server's limit: at the limit a new one is REFUSED. */
function sessionsLevel(count, max) {
  if (!Number.isFinite(count) || !Number.isFinite(max) || max <= 0) return null;
  if (count >= max) return 'hot';
  if (count >= max - 1) return 'warn';
  return 'ok';
}

const _num = (s) => (s === '' || s == null ? NaN : Number(s));

/**
 * The query's stdout, parsed. PURE - the wire format is tested without a spawn.
 * Win32_OperatingSystem reports its virtual-memory sizes in KILOBYTES; Win32_LogicalDisk
 * reports bytes. A line that does not parse is dropped, never read as a zero.
 *
 * @param {string} stdout
 * @returns {{commit: {totalBytes:number, availBytes:number}|null, disks: Array<{root:string, totalBytes:number, freeBytes:number}>}}
 */
function parseProfileOutput(stdout) {
  let commit = null;
  const disks = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts[0] === TAG_OS && parts.length >= 3) {
      const totalKb = _num(parts[1]);
      const freeKb = _num(parts[2]);
      if (Number.isFinite(totalKb) && Number.isFinite(freeKb) && totalKb > 0 && freeKb >= 0 && freeKb <= totalKb) {
        commit = { totalBytes: totalKb * 1024, availBytes: freeKb * 1024 };
      }
    } else if (parts[0] === TAG_DISK && parts.length >= 4) {
      const root = parts[1];
      const total = _num(parts[2]);
      const free = _num(parts[3]);
      // A drive letter and nothing else: this string reaches both clients.
      if (!/^[A-Z]:$/.test(root)) continue;
      if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0 || free > total) continue;
      disks.push({ root, totalBytes: total, freeBytes: free });
    }
  }
  disks.sort((a, b) => a.root.localeCompare(b.root));
  return { commit, disks };
}

/**
 * The body of GET /api/machine. PURE: every input is passed in, so the degraded answer
 * (no query, no worker) is as testable as the full one.
 */
function shapeProfile({ name, resources, os: osPart, cpuCount, uptimeSec, sessions, maxSessions, ts }) {
  const mem = resources && resources.memory;
  const list = Array.isArray(sessions) ? sessions : null;
  const count = list ? list.length : null;
  const commit = osPart && osPart.commit;
  return {
    ts,
    name,
    cpu: {
      pct: resources && typeof resources.cpuPct === 'number' ? resources.cpuPct : null,
      cores: Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : null,
      level: cpuLevel(resources && resources.cpuPct),
    },
    memory: mem && Number.isFinite(mem.totalBytes) && mem.totalBytes > 0
      ? { availBytes: mem.availBytes, totalBytes: mem.totalBytes, level: freeLevel(mem.availBytes, THRESHOLDS.memory) }
      : null,
    commit: commit ? { ...commit, level: freeLevel(commit.availBytes, THRESHOLDS.commit) } : null,
    // null = the drive list could not be read; [] = read, and there are no fixed drives.
    disks: osPart ? osPart.disks.map((d) => ({ ...d, level: freeLevel(d.freeBytes, THRESHOLDS.disk) })) : null,
    sessions: list ? {
      count,
      working: list.filter((s) => s && s.status === 'working').length,
      waiting: list.filter((s) => s && s.status === 'waiting').length,
      max: maxSessions,
      level: sessionsLevel(count, maxSessions),
    } : null,
    uptimeSec: Number.isFinite(uptimeSec) ? Math.round(uptimeSec) : null,
  };
}

function _queryWindows() {
  return new Promise((resolve) => {
    // Each half in its own try/catch: `powershell -Command` takes its exit code from `$?`
    // at the end, so one class this box cannot read would otherwise fail the whole
    // process and discard the half that WAS read (lib/process-tree.js, #165).
    const script =
      "try { $o = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; " +
      "'" + TAG_OS + "|' + $o.TotalVirtualMemorySize + '|' + $o.FreeVirtualMemory } catch { }; " +
      "try { Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop | ForEach-Object { " +
      "'" + TAG_DISK + "|' + $_.DeviceID + '|' + $_.Size + '|' + $_.FreeSpace } } catch { }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (!stdout) return resolve(null);
        const parsed = parseProfileOutput(stdout);
        // Neither half read: a failed query, not an empty machine.
        if (!parsed.commit && !parsed.disks.length) return resolve(null);
        resolve(parsed);
      });
  });
}

let _queryForTests = null;
function _setQueryForTests(fn) { _queryForTests = fn; _cache = { at: 0, value: null, inflight: null, inflightAt: 0 }; }

let _cache = { at: 0, value: null, inflight: null, inflightAt: 0 };

/**
 * `{commit, disks}` from a cached query, or null when it cannot be read (non-Windows, or
 * the query failed). A failure is cached as null for the TTL too: it is reported as
 * unknown rather than serving an older reading that would age into a confident lie, and a
 * box whose PowerShell is failing is not asked again on every poll.
 */
async function readOsPart(now = Date.now()) {
  if (_cache.at && now - _cache.at < PROFILE_TTL_MS) return _cache.value;
  if (_cache.inflight && now - _cache.inflightAt < INFLIGHT_MAX_MS) return _cache.inflight;
  if (!_queryForTests && process.platform !== 'win32') return null;
  const settle = (v) => {
    if (_cache.inflight === mine) _cache = { at: Date.now(), value: v || null, inflight: null, inflightAt: 0 };
    return v || null;
  };
  const mine = Promise.resolve().then(() => (_queryForTests || _queryWindows)()).then(settle, () => settle(null));
  _cache.inflight = mine;
  _cache.inflightAt = now;
  return mine;
}

/** os facts that cost nothing, read per request. */
function hostFacts() {
  return { cpuCount: os.cpus().length, uptimeSec: os.uptime() };
}

module.exports = {
  PROFILE_TTL_MS, THRESHOLDS,
  freeLevel, cpuLevel, sessionsLevel, parseProfileOutput, shapeProfile,
  readOsPart, hostFacts, _setQueryForTests,
};
