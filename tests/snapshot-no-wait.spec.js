// @ts-check
// #280 — a request must never WAIT on a whole-machine PowerShell query.
//
// Measured on office-tests, 2026-09-23: `powershell.exe` launched from node hung at
// startup (even `-Command 1`), `processTree.snapshot()` took 25s and returned null, and
// because a failed snapshot is deliberately not cached, EVERY `GET /api/sessions` waited
// out a fresh hung query. /api/version stayed at 0.1s and a worker-only route at 0.13s,
// so the box looked healthy while the companion's 10s timeout called it unreachable.
//
// The fix is `snapshotNoWait()`: the last good snapshot, returned at once, with a refresh
// started behind it. These specs drive it with a query that NEVER resolves — the hung
// spawn itself — so a regression to awaiting shows up as a timeout, not a slow pass.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const pt = require('../lib/process-tree');

const PROCS = [{ pid: 10, ppid: 1, name: 'bash.exe', startMs: 1 }];
const HUNG = () => new Promise(() => {});   // the office-tests PowerShell

test.describe('#280 snapshotNoWait — a hung query never blocks a caller', () => {
  test.afterEach(() => pt._resetForTests());

  test('with no snapshot yet, a hung query answers null at once ("cannot tell")', () => {
    let calls = 0;
    pt._setQueryForTests(() => { calls++; return HUNG(); });
    const t0 = Date.now();
    expect(pt.snapshotNoWait()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(calls).toBe(1);   // it DID start a refresh — it just did not wait for it
  });

  test('an expired snapshot is served at once while ONE refresh runs behind it', async () => {
    pt._setQueryForTests(async () => PROCS);
    await pt.snapshot();                                  // a good snapshot
    const at = pt._peekCacheForTests().at;                // stamped with the REAL clock
    let calls = 0;
    pt._setQueryForTests(() => { calls++; return HUNG(); });
    const later = at + pt.SNAPSHOT_TTL_MS + 1;            // expired, and the refresh hangs
    expect(pt.snapshotNoWait(later)).toBe(PROCS);
    expect(pt.snapshotNoWait(later + 5)).toBe(PROCS);     // a second poll mid-hang
    expect(calls).toBe(1);                                // shares the in-flight query
  });

  test('a fresh snapshot is served without starting any query', async () => {
    pt._setQueryForTests(async () => PROCS);
    await pt.snapshot();
    const at = pt._peekCacheForTests().at;
    let calls = 0;
    pt._setQueryForTests(() => { calls++; return HUNG(); });
    expect(pt.snapshotNoWait(at + 1)).toBe(PROCS);
    expect(calls).toBe(0);
  });

  test('a snapshot too old to trust reads as null, never as a stale answer', async () => {
    // If the query keeps failing, the last good snapshot ages without bound. Serving an
    // hour-old tree would report shells that exited long ago as work running NOW.
    pt._setQueryForTests(async () => PROCS);
    await pt.snapshot();
    const at = pt._peekCacheForTests().at;
    pt._setQueryForTests(HUNG);
    expect(pt.snapshotNoWait(at + pt.SNAPSHOT_SERVE_MAX_MS - 1)).toBe(PROCS);
    expect(pt.snapshotNoWait(at + pt.SNAPSHOT_SERVE_MAX_MS)).toBeNull();
  });

  // The Codex matcher: two sessions in one folder are told apart by their agent's start.
  const CODEX_TREE = [
    { pid: 100, ppid: 1, name: 'bash.exe', startMs: 1 },
    { pid: 101, ppid: 100, name: 'codex.exe', startMs: 5000 },
  ];

  test('agentStartFromSnapshot: a fresh tree matches and is NOT provisional', async () => {
    pt._setQueryForTests(async () => CODEX_TREE);
    await pt.snapshot();
    const at = pt._peekCacheForTests().at;
    expect(pt.agentStartFromSnapshot(100, 'codex.exe', at + 1)).toEqual({ startMs: 5000, provisional: false });
  });

  test('agentStartFromSnapshot: a tree past the TTL STILL matches, flagged provisional', async () => {
    // The review's scenario. Refusing a 20s-old tree answered null, fell back to the newest
    // rollout in the folder, and flipped a session to its NEIGHBOUR's conversation every
    // ~23s on a perfectly healthy box. A slightly old tree is still right for an agent that
    // has not been restarted, so it is used - and only held briefly.
    pt._setQueryForTests(async () => CODEX_TREE);
    await pt.snapshot();
    const at = pt._peekCacheForTests().at;
    pt._setQueryForTests(HUNG);
    expect(pt.agentStartFromSnapshot(100, 'codex.exe', at + 20000)).toEqual({ startMs: 5000, provisional: true });
  });

  test('agentStartFromSnapshot: no tree yet is null AND provisional, and never waits', () => {
    pt._setQueryForTests(HUNG);
    expect(pt.agentStartFromSnapshot(100, 'codex.exe')).toEqual({ startMs: null, provisional: true });
  });

  test('a query that NEVER calls back is abandoned after INFLIGHT_MAX_MS, not held forever', () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      let calls = 0;
      pt._setQueryForTests(() => { calls++; return HUNG(); });
      pt.snapshotNoWait(clock);
      expect(calls).toBe(1);
      clock += pt.INFLIGHT_MAX_MS - 1;
      pt.snapshotNoWait(clock);
      expect(calls).toBe(1);            // inside the deadline: joined, not re-spawned
      clock += 1;
      pt.snapshotNoWait(clock);
      expect(calls).toBe(2);            // past it: a new attempt, so the badge can recover
    } finally { Date.now = realNow; }
  });

  test('a LATE answer from an abandoned query cannot overwrite the one that replaced it', async () => {
    const OLD = [{ pid: 20, ppid: 1, name: 'bash.exe', startMs: 1 }];
    const NEW = [{ pid: 21, ppid: 1, name: 'bash.exe', startMs: 2 }];
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const releases = [];
      pt._setQueryForTests(() => new Promise((r) => releases.push(r)));
      pt.snapshotNoWait(clock);                     // query #1 starts, then hangs
      clock += pt.INFLIGHT_MAX_MS;
      pt.snapshotNoWait(clock);                     // query #2 replaces it
      expect(releases).toHaveLength(2);
      releases[1](NEW);
      await new Promise((r) => setImmediate(r));
      releases[0](OLD);                             // #1 finally answers, with older data
      await new Promise((r) => setImmediate(r));
      expect(pt.snapshotNoWait(clock)).toBe(NEW);
    } finally { Date.now = realNow; }
  });

  test('the refresh it started lands, and the next call serves it', async () => {
    const NEWER = [{ pid: 11, ppid: 1, name: 'bash.exe', startMs: 2 }];
    pt._setQueryForTests(async () => PROCS);
    await pt.snapshot();
    const at = pt._peekCacheForTests().at;
    let release;
    pt._setQueryForTests(() => new Promise((r) => { release = r; }));
    const later = at + pt.SNAPSHOT_TTL_MS + 1;
    expect(pt.snapshotNoWait(later)).toBe(PROCS);
    release(NEWER);
    await new Promise((r) => setImmediate(r));
    expect(pt.snapshotNoWait(Date.now())).toBe(NEWER);
  });
});

test.describe('#280 source gate — no request-path helper awaits a fresh snapshot', () => {
  // No behavioural test can see a helper quietly going back to `await snapshot()`: it
  // is only slow on a box whose PowerShell hangs, which CI is not. So read the source.
  // `/api/resources` is the one deliberate exception — its whole job is a fresh CPU
  // reading, it goes through `readTrees`/`snapshotPair`, and it is its own request.
  // Comments are dropped first: the ones explaining this rule name the call, and so does
  // the SERVER_VERSION changelog. A trailing comment needs whitespace before `//`, which
  // leaves a `http://` inside a string alone.
  const code = () => fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');

  test('server.js never calls processTree.snapshot() at all', () => {
    // Whole-source, so a call split across lines or chained with .then() is caught too;
    // \b keeps snapshotNoWait and snapshotPair out of it.
    expect(code().match(/processTree\s*\.\s*snapshot\b\s*\(/g)).toBeNull();
  });

  test('server.js never pulls snapshot out of processTree by destructuring', () => {
    expect(code().match(/\{[^}]*\bsnapshot\b[^}]*\}\s*=\s*(processTree|require\(['"]\.\/lib\/process-tree['"]\))/g)).toBeNull();
  });

  test('a PROVISIONAL Codex resolution is held for the short TTL, not the full one', () => {
    // The behaviour behind \`provisional\` is pinned above; this pins that server.js acts on
    // it. Held briefly rather than not at all, because re-deriving walks the whole rollout
    // folder and a box with a failing snapshot would otherwise do that on every poll.
    expect(code()).toMatch(/transcriptTtlMs\s*=\s*derived\.provisional\s*\?\s*PROVISIONAL_TRANSCRIPT_TTL_MS/);
    expect(code()).toMatch(/>\s*\(\s*st\.transcriptTtlMs\s*\|\|\s*DISCOVERED_TRANSCRIPT_TTL_MS\s*\)/);
  });
});
