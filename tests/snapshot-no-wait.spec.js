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
  test('server.js never awaits processTree.snapshot()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hits = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /await\s+processTree\.snapshot\s*\(/.test(l) && !/^\s*\/\//.test(l));
    expect(hits.map(({ n, l }) => `server.js:${n}: ${l.trim()}`)).toEqual([]);
  });
});
