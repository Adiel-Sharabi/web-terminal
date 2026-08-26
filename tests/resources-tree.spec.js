// @ts-check
const { test, expect } = require('@playwright/test');
const {
  parseSnapshotOutput, rollUpTree, resolveRuntimeRoot, shapeReport, descendantsOf,
  sessionRootNames, snapshot, snapshotPair, _setQueryForTests, _peekCacheForTests,
  _resetForTests, MIN_PAIR_GAP_MS, PAIR_SETTLE_MS, RUNTIME_ROOT_KEY,
  parseMemoryCounters, pageReadsPerSecFromSamples,
} = require('../lib/process-tree');

// #152 levels 2 and 3 — what web-terminal itself costs and what each session costs.
// Everything here is PURE: hand-built snapshots in, numbers out. No live processes, no
// timers, no PowerShell — so the arithmetic is pinned independently of whatever happens
// to be running on the machine executing the suite.

// The shape of a real session, measured on a fleet server 2026-08-23. The agent is FOUR
// levels below the pid the session actually carries, which is the whole reason a rollup
// exists: reading session.pid's own numbers reports 1 MB for a session holding 700 MB.
const MB = 1024 * 1024;
function session(rootPid, { agentRss = 640 * MB, agentCpu = 0, startBase = 1000 } = {}) {
  return [
    { pid: rootPid, ppid: 1, name: 'bash.exe', startMs: startBase, rssBytes: 1 * MB, cpu100ns: 0 },
    { pid: rootPid + 1, ppid: rootPid, name: 'bash.exe', startMs: startBase + 1, rssBytes: 1 * MB, cpu100ns: 0 },
    { pid: rootPid + 2, ppid: rootPid + 1, name: 'bash.exe', startMs: startBase + 2, rssBytes: 1 * MB, cpu100ns: 0 },
    { pid: rootPid + 3, ppid: rootPid + 2, name: 'claude.exe', startMs: startBase + 3, rssBytes: agentRss, cpu100ns: agentCpu },
  ];
}

test.describe('rollUpTree — memory', () => {
  test('sums the WHOLE tree, not the pid the session carries', () => {
    const procs = session(100);
    const r = rollUpTree(procs, procs, 100, { elapsedMs: 1000, cpuCount: 4 });
    expect(r.rssBytes).toBe(643 * MB);
    expect(r.procCount).toBe(4);
    // The label names what dominates, so "which one do I close" has an answer beyond a number.
    expect(r.topName).toBe('claude.exe');
  });

  test('a root that is not in the snapshot reports null, never zeros', () => {
    // "this session's shell has exited" and "this session is idle" must not look alike.
    expect(rollUpTree(session(100), session(100), 999, { elapsedMs: 1000, cpuCount: 4 })).toBeNull();
  });

  test('a tree whose processes report no memory reports null, not 0 bytes', () => {
    const procs = [{ pid: 5, ppid: 1, name: 'bash.exe', startMs: 1, rssBytes: null, cpu100ns: null }];
    expect(rollUpTree(procs, procs, 5, { elapsedMs: 1000, cpuCount: 4 }).rssBytes).toBeNull();
  });
});

test.describe('rollUpTree — CPU', () => {
  test('a delta over the window, normalised to the WHOLE machine', () => {
    // 0.5s of CPU across a 1s window on 4 cores = half of one core = 12.5% of the machine.
    const prev = session(100, { agentCpu: 0 });
    const next = session(100, { agentCpu: 5000000 }); // 0.5s in 100ns units
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBeCloseTo(12.5, 1);
  });

  test('a tree using every core of the machine reads 100%', () => {
    const prev = session(100, { agentCpu: 0 });
    const next = session(100, { agentCpu: 40000000 }); // 4s of CPU in a 1s window on 4 cores
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBe(100);
  });

  test('one saturated core of twenty does NOT read as 100%', () => {
    // The per-core convention would make a single-threaded agent look like it was
    // pinning the server. This is the assertion that pins the machine-wide convention.
    const prev = session(100, { agentCpu: 0 });
    const next = session(100, { agentCpu: 10000000 }); // 1s of CPU in a 1s window
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 20, prevAt: 5000 });
    expect(r.cpuPct).toBeCloseTo(5, 1);
  });

  test('no previous snapshot -> cpuPct null, but memory still reported', () => {
    // A single snapshot can only yield "average CPU since each process started", which
    // for an hours-old agent is a small, plausible-looking, WRONG number.
    const procs = session(100, { agentCpu: 73000000000 });
    const r = rollUpTree(null, procs, 100, { elapsedMs: 1000, cpuCount: 4 });
    expect(r.cpuPct).toBeNull();
    expect(r.rssBytes).toBe(643 * MB);
  });

  test('a process present NOW but absent from the previous snapshot contributes ZERO', () => {
    // THE trap. This process has 7,398 accumulated seconds. Counting its lifetime total
    // against one 1s window would render 100% against a session doing nothing.
    const prev = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 1000, rssBytes: MB, cpu100ns: 0 }];
    const next = prev.concat([
      { pid: 101, ppid: 100, name: 'claude.exe', startMs: 500, rssBytes: 640 * MB, cpu100ns: 73980000000 },
    ]);
    // startMs 500 is BEFORE the previous snapshot at 5000, so its history is not ours to charge.
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBe(0);
  });

  test('a process BORN inside the window contributes all of its CPU', () => {
    // The mirror of the case above: a `git` the session just spawned is real in-window work.
    const prev = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 1000, rssBytes: MB, cpu100ns: 0 }];
    const next = prev.concat([
      { pid: 102, ppid: 100, name: 'git.exe', startMs: 5500, rssBytes: 10 * MB, cpu100ns: 4000000 }, // 0.4s
    ]);
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBeCloseTo(10, 1); // 0.4s of 4 core-seconds
  });

  test('a counter that went BACKWARDS (pid reuse) clamps at 0, never negative', () => {
    const prev = session(100, { agentCpu: 90000000 });
    const next = session(100, { agentCpu: 10000000 });
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBe(0);
  });

  test('a pid whose START TIME changed is a different process — its total is not a delta', () => {
    const prev = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 1000, rssBytes: MB, cpu100ns: 50000000 }];
    const next = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 9000, rssBytes: MB, cpu100ns: 30000000 }];
    // Same pid, different process (started at 9000, inside the window) -> counted in full,
    // NOT as 30000000 - 50000000.
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBeCloseTo(75, 1);
  });

  test('never exceeds 100 even when the arithmetic overshoots', () => {
    const prev = session(100, { agentCpu: 0 });
    const next = session(100, { agentCpu: 999000000000 });
    const r = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBe(100);
  });

  test('a zero-length window yields null, not Infinity or NaN', () => {
    const procs = session(100, { agentCpu: 100 });
    const r = rollUpTree(procs, procs, 100, { elapsedMs: 0, cpuCount: 4, prevAt: 5000 });
    expect(r.cpuPct).toBeNull();
  });
});

test.describe('descendantsOf startSane — recycled parent pids', () => {
  // Windows does not clear ParentProcessId when a parent dies, and pids are reused. A
  // stranger that inherited the pid would otherwise hand one session another session's
  // entire cost — several hundred megabytes of it.
  const procs = [
    { pid: 100, ppid: 1, name: 'bash.exe', startMs: 5000, rssBytes: MB, cpu100ns: 0 },
    { pid: 101, ppid: 100, name: 'claude.exe', startMs: 6000, rssBytes: 100 * MB, cpu100ns: 0 },
    // Started BEFORE its "parent": it cannot be its child.
    { pid: 102, ppid: 100, name: 'stranger.exe', startMs: 4000, rssBytes: 900 * MB, cpu100ns: 0 },
  ];

  test('a child older than its parent is rejected', () => {
    const kids = descendantsOf(procs, 100, { startSane: true }).map(p => p.pid);
    expect(kids).toContain(101);
    expect(kids).not.toContain(102);
  });

  test('the guard is opt-in — existing callers are unchanged', () => {
    const kids = descendantsOf(procs, 100).map(p => p.pid);
    expect(kids).toContain(102);
  });

  test('the rollup uses the guard, so a stranger is not charged to the session', () => {
    const r = rollUpTree(procs, procs, 100, { elapsedMs: 1000, cpuCount: 4 });
    expect(r.rssBytes).toBe(101 * MB); // not 1001
  });
});

test.describe('resolveRuntimeRoot', () => {
  // server.js -> monitor.js (both node.exe) -> wscript.exe (gone). One root covers the
  // monitor, the worker, the web process and every PTY below them.
  const fleet = [
    { pid: 30328, ppid: 900, name: 'node.exe', startMs: 1000 },   // monitor.js
    { pid: 37576, ppid: 30328, name: 'node.exe', startMs: 2000 }, // pty-worker.js
    { pid: 47060, ppid: 30328, name: 'node.exe', startMs: 2000 }, // server.js
  ];

  test('climbs to the monitor when the launcher has exited', () => {
    expect(resolveRuntimeRoot(fleet, 47060)).toBe(30328);
  });

  test('stops at a non-node parent — a hand-started server is not charged the whole shell', () => {
    const shellLaunched = fleet.concat([{ pid: 900, ppid: 800, name: 'bash.exe', startMs: 500 }]);
    expect(resolveRuntimeRoot(shellLaunched, 47060)).toBe(30328);
  });

  test('stops at a parent that started AFTER its child (a recycled pid)', () => {
    const recycled = [
      { pid: 30328, ppid: 900, name: 'node.exe', startMs: 9000 }, // "parent", but younger
      { pid: 47060, ppid: 30328, name: 'node.exe', startMs: 2000 },
    ];
    expect(resolveRuntimeRoot(recycled, 47060)).toBe(47060);
  });

  test('a pid that is not in the snapshot -> null', () => {
    expect(resolveRuntimeRoot(fleet, 12345)).toBeNull();
  });

  test('a parent cycle terminates instead of hanging the event loop', () => {
    const cyclic = [
      { pid: 1, ppid: 2, name: 'node.exe', startMs: 1 },
      { pid: 2, ppid: 1, name: 'node.exe', startMs: 1 },
    ];
    expect(typeof resolveRuntimeRoot(cyclic, 1)).toBe('number');
  });
});

test.describe('parseSnapshotOutput — the wire format', () => {
  test('reads all six fields', () => {
    const rows = parseSnapshotOutput('123|4|claude.exe|1700000000000|1048576|500000');
    expect(rows).toEqual([{
      pid: 123, ppid: 4, name: 'claude.exe', startMs: 1700000000000,
      rssBytes: 1048576, cpu100ns: 500000,
    }]);
  });

  test('the first four columns keep their meaning — agent matching must not shift', () => {
    // Fields 5 and 6 were APPENDED for #152. If a later edit reorders them, `name` moves
    // a column and every newestDescendantNamed() lookup silently misses.
    const rows = parseSnapshotOutput('9|8|codex.exe|42|1|2');
    expect(rows[0].name).toBe('codex.exe');
    expect(rows[0].startMs).toBe(42);
  });

  test('a metric the OS did not report is null, never 0', () => {
    const rows = parseSnapshotOutput('123|4|bash.exe|1700000000000||');
    expect(rows[0].rssBytes).toBeNull();
    expect(rows[0].cpu100ns).toBeNull();
  });

  test('blank lines and short rows are skipped, not turned into NaN processes', () => {
    expect(parseSnapshotOutput('\r\n\r\nbroken|row\r\n7|1|a|1|2|3\r\n')).toHaveLength(1);
  });
});

test.describe('shapeReport — the API contract', () => {
  const machine = { cpuPct: 18, windowMs: 5000, memory: { usedBytes: 1, totalBytes: 2, usedPct: 50 } };
  const reading = {
    ok: true, windowMs: 1400, ts: 1234,
    groups: {
      [RUNTIME_ROOT_KEY]: { cpuPct: 1.2, rssBytes: 128, procCount: 3, topName: 'node.exe' },
      's:alive': { cpuPct: 15, rssBytes: 700, procCount: 9, topName: 'claude.exe' },
      's:dead': null,
    },
  };
  const sessions = [{ id: 'alive', pid: 100 }, { id: 'dead', pid: 200 }, { id: 'nopid' }];

  test('carries machine, footprint and per-session readings', () => {
    const out = shapeReport({ machine, reading, sessions, ts: 99, cpuCount: 20 });
    expect(out.sampling).toEqual({ ok: true, windowMs: 1400, ts: 1234 });
    expect(out.webTerminal.rssBytes).toBe(128);
    expect(out.sessions.alive.rssBytes).toBe(700);
    // A session whose shell has exited is null — present, and explicitly unknown.
    expect(out.sessions.dead).toBeNull();
    // A session that never had a pid is absent rather than invented.
    expect('nopid' in out.sessions).toBe(false);
  });

  test('a failed process query still reports the machine — and reports 2/3 as UNKNOWN, not 0', () => {
    // The degraded shape only ever appears on a box that cannot run the query, so this
    // test is the only place it is ever exercised before a user sees it.
    const out = shapeReport({ machine, reading: { ok: false, reason: 'timeout' }, sessions, ts: 99, cpuCount: 20 });
    // Carried through field for field. Not by IDENTITY: #165 folds the on-demand paging
    // rate into this same memory block, so the report builds its own object rather than
    // mutating the warm sampler's — which every other caller of read() shares.
    expect(out.machine.cpuPct).toBe(machine.cpuPct);
    expect(out.machine.memory.usedBytes).toBe(machine.memory.usedBytes);
    expect(out.machine.memory.totalBytes).toBe(machine.memory.totalBytes);
    expect(out.sampling).toEqual({ ok: false, reason: 'timeout' });
    expect(out.webTerminal).toBeNull();
    expect(out.sessions).toEqual({});
  });

  test('a reading with no reason still says why it cannot answer', () => {
    const out = shapeReport({ machine, reading: null, sessions, ts: 99, cpuCount: 20 });
    expect(out.sampling.ok).toBe(false);
    expect(out.sampling.reason).toBe('unavailable');
  });
});

// --- the guards a REVIEW found, each pinned by the number it used to produce ---------

test.describe('#152 pid reuse cannot be mistaken for continuity', () => {
  test('an unreadable PREVIOUS start time is not proof of the same process', () => {
    // The trap: pid 100 in the older snapshot had no readable start time, and pid 100
    // now is a DIFFERENT, long-lived process that inherited the number. Treating the
    // unreadable field as "same process" subtracts one process's counter from another's
    // and charges the difference — here 25 hours of accumulated CPU — to a 1s window.
    const prev = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: null, rssBytes: 1, cpu100ns: 1e6 }];
    const next = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 1000, rssBytes: 1, cpu100ns: 9e11 }];
    const out = rollUpTree(prev, next, 100, { elapsedMs: 1000, cpuCount: 4, prevAt: 5000 });
    // Unknown, because the pair genuinely cannot say. Not 100%.
    expect(out.cpuPct).toBeNull();
    expect(out.rssBytes).toBe(1);
  });

  test('a matching pid with matching start times still reads its honest delta', () => {
    const prev = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 1000, rssBytes: 1, cpu100ns: 0 }];
    const next = [{ pid: 100, ppid: 1, name: 'bash.exe', startMs: 1000, rssBytes: 1, cpu100ns: 2e7 }];
    // 2e7 ticks = 2s of one core; over 4s on 1 core that is 50%.
    const out = rollUpTree(prev, next, 100, { elapsedMs: 4000, cpuCount: 1, prevAt: 5000 });
    expect(out.cpuPct).toBe(50);
  });

  test('a stranger holding a recycled ROOT pid is unreportable, not reported', () => {
    // A session's pid is read from the session list; by the time the snapshot is taken
    // its shell may have exited and Windows may have handed the number to anything.
    const next = [
      { pid: 100, ppid: 1, name: 'chrome.exe', startMs: 1000, rssBytes: 2.4e9, cpu100ns: 0 },
      { pid: 101, ppid: 100, name: 'chrome.exe', startMs: 1001, rssBytes: 5e8, cpu100ns: 0 },
    ];
    const names = sessionRootNames('C:' + String.fromCharCode(92) + 'x' + String.fromCharCode(92) + 'bash.exe');
    expect(rollUpTree([], next, 100, { elapsedMs: 1000, cpuCount: 4, rootNames: names })).toBeNull();
    // Without the guard the same tree is reported in full — 2.9 GB charged to a session
    // that no longer exists. That is the shape of the bug, kept visible on purpose.
    const unguarded = rollUpTree([], next, 100, { elapsedMs: 1000, cpuCount: 4 });
    expect(unguarded.rssBytes).toBe(2.9e9);
  });

  test('the guard accepts the shell this box is actually configured to use', () => {
    // The reason the allowed names are DERIVED rather than a fixed list: a hard-coded
    // one silently blanks the whole feature on a box with an unusual `shell` setting.
    const next = [{ pid: 100, ppid: 1, name: 'fish.exe', startMs: 1000, rssBytes: 7, cpu100ns: 0 }];
    const names = sessionRootNames('D:/tools/Fish.exe');
    expect(rollUpTree([], next, 100, { elapsedMs: 1000, cpuCount: 4, rootNames: names }).rssBytes).toBe(7);
    expect(names.has('bash.exe')).toBe(true);
  });

  test('the configured shell is recognised through a WINDOWS path', () => {
    // The branch that matters on the machines this runs on, and the one a forward-slash
    // fixture cannot cover: narrow the split to `/` and this box's own configured shell
    // stops being recognised, so every session reads unknown — forever, and silently.
    const win = sessionRootNames('C:' + String.fromCharCode(92) + 'tools' +
      String.fromCharCode(92) + 'bin' + String.fromCharCode(92) + 'Fish.exe');
    expect(win.has('fish.exe')).toBe(true);
    // And the real default this fleet actually runs.
    const git = sessionRootNames('C:' + String.fromCharCode(92) + 'Program Files' +
      String.fromCharCode(92) + 'Git' + String.fromCharCode(92) + 'bin' +
      String.fromCharCode(92) + 'bash.exe');
    expect(git.has('bash.exe')).toBe(true);
    expect(git.has('c:')).toBe(false);
  });
});

test.describe('#152 the snapshot cache and the pair it hands out', () => {
  test.beforeEach(() => _resetForTests());
  test.afterEach(() => _resetForTests());

  const rows = (cpu) => [{ pid: 1, ppid: 0, name: 'bash.exe', startMs: 1, rssBytes: 1, cpu100ns: cpu }];

  test('a FAILED query changes nothing — the next good one still has a partner', async () => {
    // The bug this pins cost TWO readings per failure, not one: caching `null` over the
    // good snapshot meant the next SUCCESSFUL query took that null as its previous
    // sample, so it could not produce a CPU number either.
    let n = 0;
    _setQueryForTests(async () => { n += 1; return n === 3 ? null : rows(n * 100); });
    await snapshot(Date.now(), { maxAgeMs: 0 });          // 1: seeds
    await snapshot(Date.now(), { maxAgeMs: 0 });          // 2: now a pair exists
    const before = _peekCacheForTests();
    expect(before.prev).not.toBeNull();
    expect(await snapshot(Date.now(), { maxAgeMs: 0 })).toBeNull();   // 3: fails
    const after = _peekCacheForTests();
    expect(after.at).toBe(before.at);                     // untouched, in full
    expect(after.procs).toBe(before.procs);
    expect(after.prevAt).toBe(before.prevAt);
    await snapshot(Date.now(), { maxAgeMs: 0 });          // 4: succeeds
    // The partner is the last GOOD snapshot, not the failure.
    expect(_peekCacheForTests().prev).toBe(before.procs);
  });

  test('a pair closer together than the floor is refused, not divided', async () => {
    // The settle path used to accept any gap above zero. A concurrent snapshot() — the
    // session list takes one per session — landing during the settle sleep leaves a gap
    // of one query duration, and dividing by that reports a number that can be out by
    // a factor of two.
    _setQueryForTests(async () => rows(1));
    expect(await snapshotPair({ settleMs: 30 })).toBeNull();
    expect(30).toBeLessThan(MIN_PAIR_GAP_MS);
  });

  test('the SHIPPED settle default produces a usable pair — the cold path is not dead', async () => {
    // The gate this exists to be. Every other test here passes `settleMs` explicitly, so
    // lowering PAIR_SETTLE_MS below the floor would leave the whole suite green while
    // levels 2 and 3 returned null on every freshly started server — and the API spec
    // would SKIP rather than fail, because its guard reads `sampling.ok`, which is
    // exactly the symptom. A feature that dies silently everywhere must cost a red test.
    expect(PAIR_SETTLE_MS).toBeGreaterThanOrEqual(MIN_PAIR_GAP_MS);
    _setQueryForTests(async () => rows(1));
    const pair = await snapshotPair();               // no settleMs: the shipped path
    expect(pair).not.toBeNull();
    expect(pair.nextAt - pair.prevAt).toBeGreaterThanOrEqual(MIN_PAIR_GAP_MS);
  });

  test('a query landing mid-settle cannot narrow the window any more', async () => {
    // The older half is captured BEFORE the sleep. Read back from the cache afterwards, a
    // concurrent snapshot() — the session list takes one per session — became `prev` and
    // the gap collapsed to one query duration, so the reading was thrown away and the user
    // saw an intermittent dash with nothing to explain it.
    _setQueryForTests(async () => rows(1));
    const settling = snapshotPair({ settleMs: MIN_PAIR_GAP_MS + 250 });
    await new Promise((r) => setTimeout(r, 120));
    await snapshot(Date.now(), { maxAgeMs: 0 });     // a third party, mid-settle
    const pair = await settling;
    expect(pair).not.toBeNull();
    expect(pair.nextAt - pair.prevAt).toBeGreaterThanOrEqual(MIN_PAIR_GAP_MS);
  });

  test('a settled pair wide enough to divide IS returned', async () => {
    _setQueryForTests(async () => rows(1));
    const pair = await snapshotPair({ settleMs: MIN_PAIR_GAP_MS + 250 });
    expect(pair).not.toBeNull();
    expect(pair.nextAt - pair.prevAt).toBeGreaterThanOrEqual(MIN_PAIR_GAP_MS);
  });

  test('the snapshot is stamped when the query STARTS, not when it returns', async () => {
    // `at` is what a CPU reading divides by. Stamping on completion makes the window
    // wrong by the difference of two query durations, so a box whose second query ran
    // faster over-reports every session on it.
    _setQueryForTests(() => new Promise((r) => setTimeout(() => r(rows(1)), 300)));
    const t0 = Date.now();
    await snapshot(Date.now(), { maxAgeMs: 0 });
    const { at } = _peekCacheForTests();
    expect(at - t0).toBeLessThan(150);
  });
});

// --- #165: memory PRESSURE, folded into the pair this module already takes ----------
//
// Everything here is PURE, mirroring the cpuPercentFromSamples specs in resources.spec.js
// for the same reason: a raw performance counter is CUMULATIVE, so a single read reports
// the machine's average since boot and calls it "now" — and the arithmetic that turns two
// of them into a rate must be pinnable without a running Windows box.

test.describe('pageReadsPerSecFromSamples', () => {
  // Perf-counter time is measured in its OWN ticks, not wall clock: `perfTime` counts at
  // `perfFreq` Hz. 10 MHz is what Windows reports on this fleet.
  const HZ = 10000000;
  const at = (pageReads, seconds) => ({ pageReads, perfTime: seconds * HZ, perfFreq: HZ });

  test('a real rate: the delta divided by the elapsed time the counter itself reports', () => {
    // 1902 reads over 2 s = 951/s — the measured figure from the report in #165.
    expect(pageReadsPerSecFromSamples(at(1000, 10), at(2902, 12))).toBe(951);
  });

  test('a healthy box reads a small NON-ZERO rate, kept to one decimal', () => {
    // 2.6/s and 2.89/s are the figures that must stay distinguishable from 951 without
    // any ratio arithmetic in the client. Rounding them to an integer would be tolerable;
    // rounding them AWAY would not, so the precision is pinned.
    expect(pageReadsPerSecFromSamples(at(0, 0), at(26, 10))).toBe(2.6);
  });

  test('no previous sample -> null (never 0 reads/sec)', () => {
    // 0 reads/sec is the reading of a perfectly healthy box. Fabricating it for a box we
    // could not measure says "no memory pressure here" about the one server nobody knows
    // anything about.
    expect(pageReadsPerSecFromSamples(null, at(1, 1))).toBeNull();
    expect(pageReadsPerSecFromSamples(undefined, at(1, 1))).toBeNull();
    expect(pageReadsPerSecFromSamples(at(1, 1), null)).toBeNull();
  });

  test('zero elapsed counter time -> null, not Infinity and not NaN', () => {
    expect(pageReadsPerSecFromSamples(at(100, 5), at(200, 5))).toBeNull();
  });

  test('a counter that went BACKWARDS is a reset, not a negative rate', () => {
    // PageReadsPersec is a uint32 in Win32_PerfRawData_PerfOS_Memory, so it wraps; a
    // reboot between two samples does the same thing. Either way the delta is a lie, and
    // the honest answer is "unknown" until the next pair.
    expect(pageReadsPerSecFromSamples(at(5000, 1), at(10, 3))).toBeNull();
  });

  test('rewound counter TIME (a bogus pair) -> null', () => {
    expect(pageReadsPerSecFromSamples(at(10, 9), at(20, 1))).toBeNull();
  });

  test('missing or non-finite fields -> null', () => {
    expect(pageReadsPerSecFromSamples({}, at(1, 1))).toBeNull();
    expect(pageReadsPerSecFromSamples(at(1, 1), {})).toBeNull();
    expect(pageReadsPerSecFromSamples({ pageReads: NaN, perfTime: 0, perfFreq: HZ }, at(1, 1))).toBeNull();
    expect(pageReadsPerSecFromSamples(at(1, 1), { pageReads: 2, perfTime: Infinity, perfFreq: HZ })).toBeNull();
  });

  test('a zero or missing frequency -> null, never a division by nothing', () => {
    // Frequency is what converts ticks to seconds. Without it the "rate" would silently
    // be a per-tick figure ten million times too small — a wrong number, not a missing one.
    expect(pageReadsPerSecFromSamples(
      { pageReads: 0, perfTime: 0, perfFreq: 0 },
      { pageReads: 1000, perfTime: HZ, perfFreq: 0 })).toBeNull();
    expect(pageReadsPerSecFromSamples(
      { pageReads: 0, perfTime: 0 },
      { pageReads: 1000, perfTime: HZ })).toBeNull();
  });

  test('an unchanged counter over real elapsed time IS 0 — a measured calm box', () => {
    // The one case that must NOT be null: we measured it, and the answer is zero.
    expect(pageReadsPerSecFromSamples(at(4200, 1), at(4200, 3))).toBe(0);
  });
});

test.describe('parseMemoryCounters — the counter rides the SAME query', () => {
  const rows = '123|4|claude.exe|1700000000000|1048576|500000\r\n9|8|bash.exe|42|1|2\r\n';

  test('reads the counter line out of the process output', () => {
    const c = parseMemoryCounters(rows + 'PERFMEM|9182|123456789|10000000\r\n');
    expect(c).toEqual({ pageReads: 9182, perfTime: 123456789, perfFreq: 10000000 });
  });

  test('the counter line is NOT parsed as a process — agent matching must not see it', () => {
    // parseSnapshotOutput is the wire format every agent match depends on. A tagged line
    // appended to the same stdout must be invisible to it, or every session gains a
    // phantom process and the rollup charges it to somebody.
    const procs = parseSnapshotOutput(rows + 'PERFMEM|9182|123456789|10000000\r\n');
    expect(procs).toHaveLength(2);
    expect(procs.map((p) => p.name)).toEqual(['claude.exe', 'bash.exe']);
  });

  test('no counter line (an older query, or one the OS refused) -> null', () => {
    expect(parseMemoryCounters(rows)).toBeNull();
    expect(parseMemoryCounters('')).toBeNull();
    expect(parseMemoryCounters(null)).toBeNull();
  });

  test('a malformed counter line -> null, never a half-read sample', () => {
    expect(parseMemoryCounters('PERFMEM|||')).toBeNull();
    expect(parseMemoryCounters('PERFMEM|nope|123|10000000')).toBeNull();
    expect(parseMemoryCounters('PERFMEM|1|2')).toBeNull();
  });
});

test.describe('#165 the snapshot pair carries the memory counter', () => {
  test.beforeEach(() => _resetForTests());
  test.afterEach(() => _resetForTests());

  const rows = () => [{ pid: 1, ppid: 0, name: 'bash.exe', startMs: 1, rssBytes: 1, cpu100ns: 1 }];
  const HZ = 10000000;

  test('a pair hands back both counter samples, so the rate needs no second query', async () => {
    // The design constraint, made testable: folding the counter into the existing
    // snapshotPair costs ~35 ms (measured), a standalone CIM query costs ~2436 ms.
    // Nothing here may spawn a query of its own.
    let n = 0;
    _setQueryForTests(async () => {
      n += 1;
      return { procs: rows(), perf: { pageReads: n * 1000, perfTime: n * HZ, perfFreq: HZ } };
    });
    const pair = await snapshotPair({ settleMs: MIN_PAIR_GAP_MS + 250 });
    expect(pair).not.toBeNull();
    expect(pair.prevPerf).toEqual({ pageReads: 1000, perfTime: HZ, perfFreq: HZ });
    expect(pair.nextPerf).toEqual({ pageReads: 2000, perfTime: 2 * HZ, perfFreq: HZ });
    expect(pageReadsPerSecFromSamples(pair.prevPerf, pair.nextPerf)).toBe(1000);
  });

  test('a query that reports no counter still yields a usable process pair', async () => {
    // Non-Windows, or a box whose perf counters are broken. Levels 2 and 3 must not go
    // down with the pressure figure — they never depended on it.
    _setQueryForTests(async () => rows());
    const pair = await snapshotPair({ settleMs: MIN_PAIR_GAP_MS + 250 });
    expect(pair).not.toBeNull();
    expect(pair.next).toHaveLength(1);
    expect(pair.prevPerf == null && pair.nextPerf == null).toBe(true);
  });
});

test.describe('#165 shapeReport publishes pressure inside the memory block', () => {
  const machine = {
    cpuPct: 18, windowMs: 5000,
    memory: { usedBytes: 1, totalBytes: 2, availBytes: 1, usedPct: 50 },
  };
  const groups = { [RUNTIME_ROOT_KEY]: { cpuPct: 1.2, rssBytes: 128, procCount: 3, topName: 'node.exe' } };

  test('the rate lands on machine.memory, beside the headroom it explains', () => {
    // One memory block on the wire, so no client has to join two readings to say
    // "12.7 GB free and not paging" or "0.65 GB free and reading 951 pages a second".
    const out = shapeReport({
      machine,
      reading: { ok: true, windowMs: 1400, ts: 1234, groups, pageReadsPerSec: 951 },
      sessions: [], ts: 99, cpuCount: 20,
    });
    expect(out.machine.memory.pageReadsPerSec).toBe(951);
    // The always-on half is untouched by the on-demand half.
    expect(out.machine.memory.availBytes).toBe(1);
    expect(out.machine.cpuPct).toBe(18);
  });

  test('a failed process query reports pressure as UNKNOWN and keeps the headroom', () => {
    // The degraded shape. `availBytes` is free and rides the always-on sampler, so it
    // must survive a process query that could not run; the rate could not be measured and
    // must be null — a 0 there reads as "this box is not paging", which is a claim.
    const out = shapeReport({
      machine, reading: { ok: false, reason: 'timeout' }, sessions: [], ts: 99, cpuCount: 20,
    });
    expect(out.machine.memory.availBytes).toBe(1);
    expect(out.machine.memory.pageReadsPerSec).toBeNull();
  });

  test('a successful query that could not read the counter still reports null, not 0', () => {
    const out = shapeReport({
      machine, reading: { ok: true, windowMs: 1400, ts: 1234, groups, pageReadsPerSec: null },
      sessions: [], ts: 99, cpuCount: 20,
    });
    expect(out.machine.memory.pageReadsPerSec).toBeNull();
    expect(out.webTerminal.rssBytes).toBe(128);
  });

  test('the field is ALWAYS present, so a client never has to guess', () => {
    // Absent and null would both render as a dash, but only one of them lets a client
    // distinguish "this server is too old to answer" from "it answered, and does not know".
    const out = shapeReport({ machine, reading: null, sessions: [], ts: 99, cpuCount: 20 });
    expect('pageReadsPerSec' in out.machine.memory).toBe(true);
  });

  test('a report with no machine reading at all does not throw', () => {
    const out = shapeReport({ machine: null, reading: null, sessions: [], ts: 99, cpuCount: 20 });
    expect(out.machine).toBeNull();
  });
});
