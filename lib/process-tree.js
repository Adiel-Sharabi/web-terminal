'use strict';
// Which agent process is running INSIDE a session's PTY.
//
// A session's PTY is a shell (`bash.exe`); the agent is a descendant of it, often not a
// direct child. Answering "which codex is this session's" therefore means walking the
// tree from the PTY's pid. That single fact is what lets two Codex sessions in ONE
// folder be told apart — see lib/codex-match.js for what it is used for.
//
// The walk is pure and takes an injected snapshot, so it is unit-testable without
// spawning anything. Only `snapshot()` touches the OS.
//
// #152 levels 2 and 3 (what web-terminal itself costs, and what each session costs) live
// here TOO, rather than in a module of their own, for one reason: they need exactly the
// snapshot this file already takes. A second module would mean a second
// `Get-CimInstance Win32_Process` (~370 ms, measured over 433 processes) running beside
// this one on the same box, for the same rows. The projection below therefore carries
// three more columns and every consumer shares one query.
const os = require('os');
const { execFile } = require('child_process');

// One WMI query serves EVERY session, so it is cached rather than run per session. The
// window is long enough that a session-list poll costs nothing and short enough that an
// agent started moments ago is picked up quickly.
const SNAPSHOT_TTL_MS = 15000;

// `prev` is the snapshot before `procs`, kept because a CPU number cannot be computed
// from one snapshot at all (the counters are cumulative since each process started, so a
// single read reports a process's LIFETIME average and calls it "now"). Holding the
// previous one means an active server — whose session list refreshes this cache anyway —
// usually has an honest delta available for free, over a window of a poll or two.
let _cache = { at: 0, procs: null, inflight: null, prev: null, prevAt: 0 };

/**
 * Every descendant pid of `rootPid`, including nested ones (PTY -> shell -> codex).
 * Cycle-safe: a malformed parent chain (a pid that is its own ancestor) must not hang
 * the session list.
 */
function descendantsOf(procs, rootPid, opts = {}) {
  const byParent = new Map();
  // `startSane` is opt-in rather than the default because it changes what EXISTING
  // callers see, and it arrived with #152. Windows does not clear ParentProcessId when a
  // parent dies, and pids are reused — so a dead pid handed to a new process can appear
  // to parent a tree it has nothing to do with. A child can never start before its
  // parent, which is enough to reject those links. The resource rollup turns it on
  // because there the consequence is charging one session with another's several hundred
  // megabytes; agent matching (newestDescendantNamed) has the same latent exposure and is
  // deliberately left alone — that is a separate change with its own tests, not something
  // to smuggle in here.
  const byPid = opts.startSane ? new Map() : null;
  for (const p of procs || []) {
    const arr = byParent.get(p.ppid) || [];
    arr.push(p);
    byParent.set(p.ppid, arr);
    if (byPid) byPid.set(p.pid, p);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()) || []) {
      if (seen.has(child.pid)) continue;
      if (byPid) {
        const parent = byPid.get(child.ppid);
        if (parent && Number.isFinite(child.startMs) && Number.isFinite(parent.startMs)
            && child.startMs < parent.startMs) continue;
      }
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * The most recently started descendant whose image name matches `exeName`.
 *
 * Newest wins because a session that ran the agent, quit and ran it again is on its
 * SECOND conversation — the older process is history, and matching it would resurrect a
 * finished transcript.
 */
function newestDescendantNamed(procs, rootPid, exeName) {
  const want = String(exeName || '').toLowerCase();
  let best = null;
  for (const p of descendantsOf(procs, rootPid)) {
    if (String(p.name || '').toLowerCase() !== want) continue;
    if (!best || (p.startMs || 0) > (best.startMs || 0)) best = p;
  }
  return best;
}

/// Program names that ARE an agent, and names that mean "a command is running".
/// A shell BELOW the agent is a tool call; whatever it spawns (msbuild, dotnet,
/// npm) hangs below that shell, so counting the shell counts the whole command
/// without maintaining a list of build tools.
const AGENT_NAMES = new Set(['claude.exe', 'codex.exe', 'claude', 'codex']);
const SHELL_NAMES = new Set([
  'powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'sh.exe', 'zsh.exe',
]);

/**
 * Shell commands currently RUNNING inside the session rooted at `rootPid`.
 *
 * Why this exists: a session's status tracks the AGENT'S TURN, and the
 * transcript-derived badge only sees `run_in_background` launches. An ordinary
 * tool call — or anything that outlives the turn — is invisible to both.
 * Measured on Office: "sanity 147" reported `status=idle, backgroundTasks=[]`
 * while a real `powershell.exe -NoProfile -NonInteractive` was alive under its
 * agent (it exited minutes later). Only the process tree can see that.
 *
 * The discriminator comes from real trees, not guesswork:
 *
 *   bash.exe -> bash.exe -> claude.exe        the PTY chain + the agent
 *                             node/memory/python   MCP servers, in EVERY session
 *                             powershell.exe       <- a command  *** work ***
 *
 * So work = a SHELL descended from the AGENT. That subtracts the login chain
 * above the agent and the MCP servers beside it, with no allowlist to maintain.
 * Two sessions sampled with nothing running had no shell under their agent at
 * all, which is what makes this trustworthy rather than merely plausible.
 *
 * Returns `[{ pid, name }]`, outermost shell only — a shell that spawned another
 * shell is one command. Empty when the session has no agent: a plain shell
 * session has no "beside the agent" baseline, so the same rule would report the
 * user's own interactive shell as work.
 */
function runningShellsUnder(procs, rootPid) {
  if (!Array.isArray(procs) || !Number.isFinite(rootPid)) return [];
  const lower = (n) => String(n || '').toLowerCase();

  // Reuse descendantsOf's cycle-safety rather than re-walking by hand: collect
  // the agents under the PTY, then the shells under each agent.
  const all = descendantsOf(procs, rootPid);
  const agents = all.filter((p) => AGENT_NAMES.has(lower(p.name)));
  if (!agents.length) return [];

  const agentPids = new Set(agents.map((p) => p.pid));
  const out = [];
  const claimed = new Set();
  for (const agent of agents) {
    for (const p of descendantsOf(procs, agent.pid)) {
      if (!SHELL_NAMES.has(lower(p.name))) continue;
      if (agentPids.has(p.pid)) continue;
      // Outermost only: skip a shell that is itself under an already-claimed one.
      if (descendantsOf(procs, p.pid).some((c) => claimed.has(c.pid))) continue;
      if (claimed.has(p.pid)) continue;
      claimed.add(p.pid);
      out.push({ pid: p.pid, name: p.name });
    }
  }
  // Drop any shell that is a descendant of another reported shell (one command).
  return out.filter((s) => !out.some((other) =>
    other.pid !== s.pid && descendantsOf(procs, other.pid).some((d) => d.pid === s.pid)));
}

// --- OS access -------------------------------------------------------------------

// Windows only, and deliberately soft: every caller treats a null snapshot as "cannot
// tell", which falls back to the previous newest-in-cwd behaviour rather than erroring.
/**
 * The query's stdout -> process rows. PURE, and separated from the spawn precisely
 * because it is the wire format: fields 5 and 6 were APPENDED for #152, and a test that
 * pins the layout is what stops a later edit from silently shifting `name` one column and
 * turning every agent match into a miss.
 *
 * A field that cannot be read stays null and is later reported as "unknown". It must
 * never become 0 — a 0 in a resource reading is indistinguishable from "idle, put your
 * work here", which is the single wrong answer this feature exists to prevent.
 *
 * @param {string} stdout
 * @returns {Array<{pid:number, ppid:number, name:string, startMs:number|null, rssBytes:number|null, cpu100ns:number|null}>}
 */
function parseSnapshotOutput(stdout) {
  const procs = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const startMs = parseInt(parts[3], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const rss = parseInt(parts[4], 10);
    const cpu = parseInt(parts[5], 10);
    procs.push({
      pid, ppid, name: parts[2],
      startMs: Number.isFinite(startMs) ? startMs : null,
      rssBytes: Number.isFinite(rss) ? rss : null,
      cpu100ns: Number.isFinite(cpu) ? cpu : null,
    });
  }
  return procs;
}

function _queryWindows() {
  return new Promise((resolve) => {
    // CSV out of WMIC-style CIM: ProcessId, ParentProcessId, Name, CreationDate.
    // Fields 5 and 6 (#152) are APPENDED, never reordered: the parser below still reads
    // 1-4 exactly as before, so nothing that consumed this snapshot for agent matching
    // changes. WorkingSetSize is the resident memory Task Manager shows; kernel + user
    // time is the process's total CPU in 100 ns units (kernel alone is not optional — an
    // agent shelling out to git spends most of its time there).
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { " +
      "$_.ProcessId.ToString() + '|' + $_.ParentProcessId + '|' + $_.Name + '|' + " +
      "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + '|' + " +
      "$_.WorkingSetSize + '|' + ($_.KernelModeTime + $_.UserModeTime) }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const procs = parseSnapshotOutput(stdout);
        resolve(procs.length ? procs : null);
      });
  });
}

/**
 * A cached process snapshot, or null when it cannot be taken (non-Windows, or the query
 * failed). Concurrent callers share one in-flight query — the session list resolves
 * every session in parallel, and without this each would spawn its own PowerShell.
 */
async function snapshot(now = Date.now(), opts = {}) {
  const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : SNAPSHOT_TTL_MS;
  if (_cache.procs && now - _cache.at < maxAge) return _cache.procs;
  if (_cache.inflight) return _cache.inflight;
  if (!_queryForTests && process.platform !== 'win32') return null;
  // Stamped when the query STARTS, never when it returns. The query takes ~475 ms against
  // 500 processes and `at` is the number a CPU reading divides by, so completion stamps
  // make the window wrong by the DIFFERENCE of two query durations — a box whose second
  // query happened to run faster over-reports every session on it. The stamp also decides
  // what counts as born-in-window: a process that appeared WHILE the previous query was
  // running is missing from that snapshot, and against a completion stamp it looks older
  // than the snapshot it is missing from, so it silently contributes zero — under-
  // reporting exactly the short-lived build and `git` churn that rule exists to catch.
  const startedAt = Date.now();
  _cache.inflight = (_queryForTests || _queryWindows)().then((procs) => {
    // A FAILED query changes NOTHING. Caching `null` over a good snapshot does not merely
    // lose the reading it failed: the next SUCCESSFUL query would take that `null` as its
    // previous sample, so one failure costs TWO unknown readings and forces the settle
    // path — an extra whole-machine query and a second of waiting — to climb back out.
    if (!procs) { _cache.inflight = null; return null; }
    _cache = { at: startedAt, procs, inflight: null, prev: _cache.procs, prevAt: _cache.at };
    return procs;
  }).catch(() => { _cache.inflight = null; return null; });
  return _cache.inflight;
}

// Test seam. The cache and the pairing rules are the part of this module a pure test
// cannot reach and a real run reproduces only by burning a whole-machine PowerShell query
// per step — which is exactly why two defects lived there. Swapping the OS query out
// turns "a failed query must change nothing" and "a pair closer together than the floor
// is not a reading" into ordinary assertions.
let _queryForTests = null;
function _setQueryForTests(fn) { _queryForTests = fn; }
function _peekCacheForTests() {
  return { at: _cache.at, prevAt: _cache.prevAt, procs: _cache.procs, prev: _cache.prev };
}
function _resetForTests() {
  _cache = { at: 0, procs: null, inflight: null, prev: null, prevAt: 0 };
  _queryForTests = null;
}

// --- #152: what a tree COSTS -------------------------------------------------------
//
// Everything above answers "which processes are in this session". This answers "and what
// are they using". The split matters because the second question needs TWO snapshots and
// the first needs one.

// A pair further apart than this is not a reading of "now" any more — over minutes the
// processes in a tree churn, and the average smooths away exactly the spike someone
// opening this panel is looking for.
const MAX_PAIR_GAP_MS = 120000;
// A pair closer together than this divides by too little elapsed time: a single scheduler
// quantum lands as a double-digit percentage.
const MIN_PAIR_GAP_MS = 700;
// The gap deliberately introduced when no usable pair exists yet.
const PAIR_SETTLE_MS = 900;
// How stale the newer half may be. Memory is read from it directly, so an old one would
// report a session's footprint as it was a quarter of a minute ago.
const PAIR_FRESH_MS = 3000;
// The program names a SESSION's root process may legitimately have: the shells a PTY is
// spawned as, plus whatever this box is actually configured to use. Deriving the last one
// rather than hard-coding a list is what stops the pid-reuse guard above from silently
// reporting `-` forever on a box whose `shell` setting is something unusual.
function sessionRootNames(configuredShell) {
  const names = new Set(SHELL_NAMES);
  const base = String(configuredShell || '').split(/[\\/]/).pop().toLowerCase();
  if (base) names.add(base);
  return names;
}

// The key `readTrees` reports web-terminal's own tree under. `__`-prefixed so it can
// never collide with a caller's key.
const RUNTIME_ROOT_KEY = '__wt';

/**
 * Roll one process tree up into a reading. PURE: two snapshots in, numbers out, no clock
 * read and no OS call, so the arithmetic is testable with hand-built fixtures.
 *
 * `cpuPct` is a share of the WHOLE MACHINE — 100 means every core saturated — so it can
 * be read directly against the machine-wide number from lib/resources.js sitting beside
 * it in the UI. (The per-core convention, where one busy core of twenty reads 100%, would
 * make a single-threaded agent look like it was pinning the server.)
 *
 * The per-process rules, each of which exists because of a wrong number it prevents:
 *  - in both snapshots, same start time -> its honest delta;
 *  - born DURING the window -> all of its CPU, which is by definition in-window (a `git`
 *    the session just spawned is real work and has to count);
 *  - present now, absent from the previous snapshot, and older than it -> contributes
 *    ZERO. Counting its lifetime total is the worst failure available here: it would
 *    charge one window with a Claude process's several thousand accumulated seconds and
 *    render 100% against an idle session;
 *  - died during the window -> not counted, because the pair cannot see it. Sub-second
 *    command churn is under-reported, deliberately: the alternative is tracking every
 *    process that has ever existed.
 *
 * Returns null when the root is not in the newer snapshot: "this session's shell has
 * exited" and "this session is idle" are different answers and must not look alike.
 *
 * @param {Array} prevProcs snapshot rows taken FIRST (empty/absent -> cpu unknown)
 * @param {Array} nextProcs snapshot rows taken SECOND
 * @param {number} rootPid
 * @param {{elapsedMs: number, cpuCount: number, prevAt?: number}} opts
 * @returns {{cpuPct: number|null, rssBytes: number|null, procCount: number, topName: string|null}|null}
 */
function rollUpTree(prevProcs, nextProcs, rootPid, opts = {}) {
  if (!Array.isArray(nextProcs) || !Number.isFinite(rootPid)) return null;
  const root = nextProcs.find((p) => p && p.pid === rootPid);
  if (!root) return null;
  // `startSane` protects the DESCENDANTS from a recycled pid; this protects the root.
  // A session's pid names a shell that may have exited between the session list being
  // read and this snapshot being taken, and Windows hands the number straight back out —
  // so whatever inherited it, browser or build, would be reported as that session's cost.
  // Opt-in: web-terminal's own root is validated by resolveRuntimeRoot's name test
  // instead, and the pure tests build trees out of whatever names they like.
  if (opts.rootNames && !opts.rootNames.has(String(root.name || '').toLowerCase())) return null;
  const { elapsedMs = 0, cpuCount = 0 } = opts;
  const prevByPid = new Map();
  for (const p of prevProcs || []) if (p) prevByPid.set(p.pid, p);

  const tree = [root].concat(descendantsOf(nextProcs, rootPid, { startSane: true }));
  let rssBytes = null, busy100ns = 0, cpuKnown = false, topRss = -1, topName = null;
  for (const cur of tree) {
    if (Number.isFinite(cur.rssBytes)) {
      rssBytes = (rssBytes || 0) + cur.rssBytes;
      if (cur.rssBytes > topRss) { topRss = cur.rssBytes; topName = cur.name || null; }
    }
    if (!Number.isFinite(cur.cpu100ns)) continue;
    const before = prevByPid.get(cur.pid);
    // Both start times must be readable AND equal. Treating an unreadable one as proof
    // of the same process is the lifetime-total failure by another door: a recycled pid
    // whose earlier row had no start time would have its predecessor's entire CPU
    // subtracted from... nothing, charging hours of accumulated time to one window.
    const samePid = before && Number.isFinite(before.cpu100ns) &&
      Number.isFinite(before.startMs) && Number.isFinite(cur.startMs) &&
      before.startMs === cur.startMs;
    if (samePid) {
      busy100ns += Math.max(0, cur.cpu100ns - before.cpu100ns);
      cpuKnown = true;
    } else if (prevByPid.size && Number.isFinite(cur.startMs) && Number.isFinite(opts.prevAt)
               && cur.startMs >= opts.prevAt) {
      busy100ns += Math.max(0, cur.cpu100ns);
      cpuKnown = true;
    }
  }
  let cpuPct = null;
  if (cpuKnown && elapsedMs > 0 && cpuCount > 0) {
    // 1 ms of one core = 10,000 ticks of 100 ns.
    const capacity100ns = elapsedMs * 10000 * cpuCount;
    cpuPct = Math.max(0, Math.min(100, Math.round((busy100ns / capacity100ns) * 1000) / 10));
  }
  return { cpuPct, rssBytes, procCount: tree.length, topName };
}

/**
 * Climb from `selfPid` to the outermost ancestor still running the same runtime, so
 * web-terminal's own footprint can be rooted at monitor.js without anyone having to tell
 * this process what the monitor's pid is.
 *
 * Measured 2026-08-23: server.js's parent is monitor.js (both node.exe), the worker hangs
 * off that same monitor, and the monitor's own parent — wscript.exe from the VBS launcher
 * — exited long ago, so the climb terminates there on its own. One root therefore covers
 * all three processes AND every PTY beneath them.
 *
 * The node.exe test is what keeps this honest when a server is started by hand from a
 * shell: the parent is then bash.exe, the climb stops at once, and the footprint is this
 * process's own tree — under-reporting the worker rather than charging web-terminal for
 * the user's entire shell session.
 *
 * KNOWN LIMIT, recorded rather than guessed at: the test is "is the parent node", not "is
 * the parent OURS", so a launcher that is itself node (`npm start`, `npx`, `nodemon`, pm2)
 * would be absorbed and its unrelated tree counted as ours. Not reachable on this fleet —
 * the shipped VBS launcher makes the monitor's parent wscript.exe, and the test harness's
 * is cmd.exe, both of which stop the climb — so it is left alone rather than fixed
 * speculatively. If web-terminal ever ships an npm-script launcher, this is the line.
 */
function resolveRuntimeRoot(procs, selfPid) {
  if (!Array.isArray(procs)) return null;
  const byPid = new Map();
  for (const p of procs) if (p) byPid.set(p.pid, p);
  let cur = byPid.get(selfPid);
  if (!cur) return null;
  const isRuntime = (n) => /^node(\.exe)?$/i.test(String(n || ''));
  for (let hops = 0; hops < 16; hops++) {
    const parent = byPid.get(cur.ppid);
    if (!parent || parent.pid === cur.pid || !isRuntime(parent.name)) break;
    // Same recycled-pid guard as descendantsOf's: a "parent" that started after its child
    // is a stranger that inherited the pid.
    if (Number.isFinite(parent.startMs) && Number.isFinite(cur.startMs) && parent.startMs > cur.startMs) break;
    cur = parent;
  }
  return cur.pid;
}

/**
 * Two snapshots that can honestly be divided.
 *
 * On a server anyone is looking at this usually costs NOTHING extra: the session list
 * already refreshes the cache, so a previous snapshot is sitting there and only the newer
 * half may need taking. The settle path — two forced queries about a second apart — is
 * the cold case, and it is the reason the panel is opened on demand rather than polled.
 *
 * @returns {Promise<{prev: Array|null, prevAt: number, next: Array, nextAt: number}|null>}
 */
async function snapshotPair(opts = {}) {
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : PAIR_SETTLE_MS;
  let next = await snapshot(Date.now(), { maxAgeMs: PAIR_FRESH_MS });
  if (!next) return null;
  let gap = _cache.at - _cache.prevAt;
  if (_cache.prev && gap >= MIN_PAIR_GAP_MS && gap <= MAX_PAIR_GAP_MS) {
    return { prev: _cache.prev, prevAt: _cache.prevAt, next: _cache.procs, nextAt: _cache.at };
  }
  // No usable partner: make one. `maxAgeMs: 0` forces a query rather than re-reading the
  // snapshot we already hold, which would produce a pair with a zero window.
  await new Promise((r) => setTimeout(r, settleMs));
  next = await snapshot(Date.now(), { maxAgeMs: 0 });
  if (!next) return null;
  gap = _cache.at - _cache.prevAt;
  // The SAME guards as the fast path — this was a real hole, not belt-and-braces. Every
  // session in the sidebar poll calls snapshot(), so one of those can complete during the
  // settle sleep and become our `prev`, leaving a gap of a single query duration (~475 ms
  // measured) — under the floor this module declares unsafe, with a timing error of the
  // same order. Returning null there costs one unknown reading; keeping it prints a
  // number that can be out by a factor of two.
  if (!_cache.prev || gap < MIN_PAIR_GAP_MS || gap > MAX_PAIR_GAP_MS) return null;
  return { prev: _cache.prev, prevAt: _cache.prevAt, next: _cache.procs, nextAt: _cache.at };
}

/**
 * Read several named trees at once, plus web-terminal's own.
 *
 * One snapshot pair serves every group — which is the whole reason levels 2 and 3 of #152
 * cost the same as either one of them alone.
 *
 * @param {Array<{key: string, rootPid: number}>} roots
 * @param {{selfPid?: number, cpuCount?: number, settleMs?: number, rootNames?: Set<string>}} opts
 * @returns {Promise<{ok: boolean, reason?: string, ts?: number, windowMs?: number, cpuCount?: number, groups?: Record<string, any>}>}
 */
async function readTrees(roots, opts = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  let pair;
  try {
    pair = await snapshotPair(opts);
  } catch (e) {
    return { ok: false, reason: 'query-failed' };
  }
  if (!pair) return { ok: false, reason: 'unavailable' };
  const cpuCount = Number.isFinite(opts.cpuCount) ? opts.cpuCount : os.cpus().length;
  const elapsedMs = pair.nextAt - pair.prevAt;
  const groups = {};
  for (const r of roots || []) {
    if (!r || !Number.isFinite(r.rootPid)) continue;
    groups[r.key] = rollUpTree(pair.prev, pair.next, r.rootPid,
      { elapsedMs, cpuCount, prevAt: pair.prevAt, rootNames: opts.rootNames });
  }
  if (Number.isFinite(opts.selfPid)) {
    // Resolved from the SAME snapshot the numbers come from rather than cached at
    // startup: a hot reload replaces server.js under a surviving monitor and a crash
    // restart replaces it the other way, so a pid captured once would eventually name a
    // dead process and report nothing — which reads exactly like "web-terminal is using
    // no memory".
    const root = resolveRuntimeRoot(pair.next, opts.selfPid);
    if (root !== null) {
      groups[RUNTIME_ROOT_KEY] = rollUpTree(pair.prev, pair.next, root, { elapsedMs, cpuCount, prevAt: pair.prevAt });
    }
  }
  return { ok: true, ts: pair.nextAt, windowMs: elapsedMs, cpuCount, groups };
}

/**
 * The GET /api/resources body. PURE, so the DEGRADED shape — the one that only appears on
 * a box that cannot run the query, or under a failure nobody can reproduce on demand — is
 * as testable as the happy one.
 *
 * The contract both clients rely on:
 *  - `machine` is ALWAYS present. It comes from lib/resources.js and costs nothing, so a
 *    process query that fails must not take the machine reading down with it.
 *  - `sampling.ok === false` is the ONLY way a client can tell "this box cannot measure"
 *    apart from "this box is idle". Levels 2 and 3 are then absent rather than zeroed —
 *    a 0% here would steer someone at exactly the wrong server (#152 hint 6 applies to a
 *    local failure as much as to a peer that timed out).
 *  - a session key is present only if that session HAS a reading; a session whose shell
 *    has exited maps to null, which is not the same as 0.
 *
 * @param {{machine: any, reading: any, sessions: Array<{id: string, pid: number}>, ts: number, cpuCount: number}} args
 */
function shapeReport({ machine, reading, sessions, ts, cpuCount }) {
  const ok = !!(reading && reading.ok && reading.groups);
  const out = {
    ts,
    cpuCount,
    machine: machine || null,
    sampling: ok
      ? { ok: true, windowMs: reading.windowMs, ts: reading.ts }
      : { ok: false, reason: (reading && reading.reason) || 'unavailable' },
    webTerminal: ok ? (reading.groups[RUNTIME_ROOT_KEY] || null) : null,
    sessions: {},
  };
  if (ok) {
    for (const s of sessions || []) {
      if (!s || !s.id) continue;
      const key = 's:' + s.id;
      if (key in reading.groups) out.sessions[s.id] = reading.groups[key];
    }
  }
  return out;
}

module.exports = {
  descendantsOf, newestDescendantNamed, runningShellsUnder,
  snapshot, SNAPSHOT_TTL_MS, _resetForTests,
  // #152 levels 2 and 3
  parseSnapshotOutput, rollUpTree, resolveRuntimeRoot, snapshotPair, readTrees, shapeReport,
  sessionRootNames, _setQueryForTests, _peekCacheForTests,
  RUNTIME_ROOT_KEY, MAX_PAIR_GAP_MS, MIN_PAIR_GAP_MS, PAIR_SETTLE_MS, PAIR_FRESH_MS,
};
