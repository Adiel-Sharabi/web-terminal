// @ts-check
// #366 - the background / dispatched agents `claude agents --json` lists, served read-only.
//
// What is under test is the SERVER half: what the CLI's output is allowed to become
// (lib/background-listing.js), when it is run and cached (lib/background-listing-runner.js),
// where the child is started - a worker thread, so a slow CreateProcess cannot freeze the
// server's loop (lib/background-listing-exec.js) - which registry entry says so
// (lib/agents.js), and that the route is auth-only.
//
// EVERY ROW BELOW IS SYNTHETIC. The real listing names every project's sessions and working
// directories on the machine, so no fixture is copied from it - the shapes (field names,
// the five `state` words, `kind`, `waitingFor`) come from the issue and from probing the
// CLI's KEYS, never its values. The suite never launches the real CLI either: the exec layers
// are driven through a stub executable (a tiny node script) over a REAL child process and
// real worker threads, and the shared server is pointed at a nonexistent binary by
// playwright.config.js (WT_CLAUDE_BIN).
//
// NO TEST HERE BETS ON A WALL-CLOCK WINDOW. This host's processes stall for seconds at a time,
// so a watchdog is fired by hand once the stub says it is ready, a clock is injected for the
// TTL, and a pending exec is a deferred promise rather than a sleeping process.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { killTree } = require('../lib/git-safe');
const agents = require('../lib/agents');
const {
  parseBackgroundListing, scrubEnv, resolveBin, MAX_ROWS,
} = require('../lib/background-listing');
const { createBackgroundListing } = require('../lib/background-listing-runner');
const {
  createInlineExec, createThreadedExec, MAX_STDOUT_BYTES, DEFAULT_WORKER_PATH,
} = require('../lib/background-listing-exec');
const { createHandler } = require('../lib/background-listing-worker');
const { authCtx, noAuthCtx } = require('./test-helpers');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';

/** A background row as the CLI writes it: the documented fields plus a pid and a full cwd. */
function bg(over = {}) {
  return {
    cwd: 'D:\\projects\\widget-factory',
    kind: 'background',
    startedAt: 1760000000000,
    sessionId: U1,
    name: 'nightly build',
    id: 'a1b2c3d4',
    state: 'working',
    pid: 4242,
    status: 'busy',
    ...over,
  };
}
function interactive(over = {}) {
  return {
    cwd: 'D:\\projects\\widget-factory',
    kind: 'interactive',
    startedAt: 1760000000000,
    sessionId: U2,
    name: 'my chat',
    pid: 999,
    status: 'idle',
    ...over,
  };
}

// ============================================================================
// The parser - pure
// ============================================================================

test.describe('parseBackgroundListing (pure)', () => {
  test('keeps exactly the safe shape and drops pid and the full cwd', () => {
    const rows = parseBackgroundListing(JSON.stringify([bg()]));
    expect(rows).toEqual([{
      id: 'a1b2c3d4',
      sessionId: U1,
      name: 'nightly build',
      cwdTail: 'widget-factory',
      state: 'working',
      status: 'busy',
      waitingFor: null,
      startedAt: 1760000000000,
    }]);
    const wire = JSON.stringify(rows);
    expect(wire, 'the pid must not survive').not.toContain('4242');
    expect(wire, 'the full cwd must not survive - only its last segment').not.toContain('projects');
    expect(Object.keys(rows[0]).sort())
      .toEqual(['cwdTail', 'id', 'name', 'sessionId', 'startedAt', 'state', 'status', 'waitingFor']);
  });

  test('every documented state passes through, and waitingFor rides on a blocked row', () => {
    const states = ['working', 'blocked', 'done', 'failed', 'stopped'];
    const rows = parseBackgroundListing(JSON.stringify(
      states.map((state, i) => bg({
        state, id: `0000000${i}`, sessionId: `${i}${U1.slice(1)}`,
        ...(state === 'blocked' ? { status: 'waiting', waitingFor: 'dialog open' } : {}),
      })),
    ));
    expect(rows.map((r) => r.state)).toEqual(states);
    expect(rows[1].status).toBe('waiting');
    expect(rows[1].waitingFor).toBe('dialog open');
  });

  test('interactive rows are filtered out - they are the PTY sessions already listed', () => {
    const rows = parseBackgroundListing(JSON.stringify([interactive(), bg(), interactive({ sessionId: U3 })]));
    expect(rows.map((r) => r.id)).toEqual(['a1b2c3d4']);
    expect(parseBackgroundListing(JSON.stringify([interactive()]))).toEqual([]);
  });

  test('a row with fields missing still renders, each absent field null', () => {
    const rows = parseBackgroundListing(JSON.stringify([
      { kind: 'background', id: 'deadbeef' },
      { kind: 'background', sessionId: U4 },
    ]));
    expect(rows).toEqual([
      { id: 'deadbeef', sessionId: null, name: null, cwdTail: null, state: null, status: null, waitingFor: null, startedAt: null },
      { id: null, sessionId: U4, name: null, cwdTail: null, state: null, status: null, waitingFor: null, startedAt: null },
    ]);
  });

  test('a row that can be neither named nor mapped to a conversation is dropped', () => {
    const rows = parseBackgroundListing(JSON.stringify([
      { kind: 'background', name: 'orphan' },
      { kind: 'background', id: '../../etc', sessionId: 'not-a-uuid', name: 'bad ids' },
      bg(),
    ]));
    expect(rows.map((r) => r.id)).toEqual(['a1b2c3d4']);
  });

  test('field-level validation: bad types become null, never pass through', () => {
    const [r] = parseBackgroundListing(JSON.stringify([bg({
      sessionId: 'nope', startedAt: 'yesterday', state: '<script>', status: 42, waitingFor: { a: 1 },
      name: 12, cwd: 7,
    })]));
    expect(r).toEqual({
      id: 'a1b2c3d4', sessionId: null, name: null, cwdTail: null,
      state: null, status: null, waitingFor: null, startedAt: null,
    });
  });

  test('an unfamiliar but word-shaped state or status is passed through, lowercased', () => {
    const [r] = parseBackgroundListing(JSON.stringify([bg({ state: 'Paused', status: 'sleeping' })]));
    expect(r.state).toBe('paused');
    expect(r.status).toBe('sleeping');
  });

  test('cwdTail is the last segment for Windows, POSIX and trailing separators', () => {
    const tail = (cwd) => parseBackgroundListing(JSON.stringify([bg({ cwd })]))[0].cwdTail;
    expect(tail('C:\\a\\b\\proj')).toBe('proj');
    expect(tail('/home/u/proj')).toBe('proj');
    expect(tail('/home/u/proj/')).toBe('proj');
    expect(tail('C:\\')).toBe('C:');
    expect(tail('/')).toBeNull();
    expect(tail('')).toBeNull();
  });

  test('text fields lose control characters (ESC included) and are capped', () => {
    const [r] = parseBackgroundListing(JSON.stringify([bg({
      name: 'a\u001b[31mred\u0007\nb',
      waitingFor: 'x'.repeat(5000),
    })]));
    expect(r.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(r.name).toContain('red');
    expect(Array.from(r.waitingFor).length).toBeLessThanOrEqual(200);
  });

  test('not an array is UNAVAILABLE (null), never an empty list', () => {
    for (const text of ['{}', '{"agents":[]}', '"x"', '7', 'null', 'true', '']) {
      expect(parseBackgroundListing(text), `input ${JSON.stringify(text)}`).toBeNull();
    }
    expect(parseBackgroundListing(undefined)).toBeNull();
    expect(parseBackgroundListing(null)).toBeNull();
  });

  test('malformed JSON is UNAVAILABLE (null)', () => {
    for (const text of ['[', '[{"kind":"background"', 'not json', '[1,2,', '<html>']) {
      expect(parseBackgroundListing(text), `input ${JSON.stringify(text)}`).toBeNull();
    }
  });

  test('an empty array is a real, empty answer', () => {
    expect(parseBackgroundListing('[]')).toEqual([]);
  });

  test('junk entries inside the array are skipped, the rest survive', () => {
    const rows = parseBackgroundListing(JSON.stringify([null, 7, 'x', [], bg(), { kind: 'background' }]));
    expect(rows.map((r) => r.id)).toEqual(['a1b2c3d4']);
  });

  test('rows are capped', () => {
    const many = Array.from({ length: MAX_ROWS + 50 }, (_, i) => bg({ id: `id${i}` }));
    expect(parseBackgroundListing(JSON.stringify(many))).toHaveLength(MAX_ROWS);
  });
});

// ============================================================================
// scrubEnv / resolveBin - pure
// ============================================================================

test.describe('scrubEnv (pure)', () => {
  const spec = { names: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'] };

  test('drops exactly the named markers, case-insensitively, and nothing else', () => {
    const input = {
      CLAUDECODE: '1', Claude_Code_Entrypoint: 'cli', CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CONFIG_DIR: 'C:\\cfg', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
      CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'keep-me', PATH: 'C:\\bin',
    };
    const out = scrubEnv(input, spec);
    expect(Object.keys(out).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'PATH'],
    );
  });

  test('the registry list strips every marker a live session carries and none of the operator settings', () => {
    const { scrubEnv: reg } = /** @type {any} */ (agents.backgroundListingFor('claude'));
    const markers = [
      'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID',
    ];
    // Settings an operator chose, which a server started with them needs the child to honour.
    const operator = [
      'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'ANTHROPIC_API_KEY',
    ];
    const input = Object.fromEntries([...markers, ...operator].map((k) => [k, 'x']));
    const out = scrubEnv(input, reg);
    for (const k of markers) expect(out, k).not.toHaveProperty(k);
    for (const k of operator) expect(out, k).toHaveProperty(k);
  });

  test('does not mutate its input, and survives a missing env or spec', () => {
    const input = { CLAUDECODE: '1', A: 'b' };
    scrubEnv(input, spec);
    expect(input).toEqual({ CLAUDECODE: '1', A: 'b' });
    expect(scrubEnv(undefined, spec)).toEqual({});
    expect(scrubEnv({ A: '1' }, undefined)).toEqual({ A: '1' });
  });
});

test.describe('resolveBin (pure)', () => {
  const win = (extra) => ({
    bin: 'claude', platform: 'win32', home: 'C:\\Users\\u', pathValue: 'C:\\x;"C:\\y z"', ...extra,
  });

  test('an override is used verbatim, even when nothing exists', () => {
    expect(resolveBin(win({ override: ' D:\\stub\\claude.exe ', exists: () => false }))).toBe('D:\\stub\\claude.exe');
  });

  test('Windows finds <bin>.exe on PATH (quoted entries unquoted) and ignores a .cmd shim', () => {
    const seen = [];
    const exists = (p) => { seen.push(p); return p === 'C:\\y z\\claude.exe'; };
    expect(resolveBin(win({ exists }))).toBe('C:\\y z\\claude.exe');
    expect(seen.every((p) => p.endsWith('claude.exe'))).toBe(true);
    expect(resolveBin(win({ exists: (p) => p.endsWith('claude.cmd') }))).toBeNull();
  });

  test('a relative PATH entry is never consulted - it would resolve against the server\'s cwd', () => {
    const seen = [];
    const exists = (p) => { seen.push(p); return true; };
    expect(resolveBin(win({ pathValue: '.;bin;..\\up;C:\\ok', exists }))).toBe('C:\\ok\\claude.exe');
    expect(seen).toEqual(['C:\\ok\\claude.exe']);

    const seenPosix = [];
    const found = resolveBin({
      bin: 'claude', platform: 'linux', home: '/home/u', pathValue: './bin::bin:/usr/bin',
      exists: (p) => { seenPosix.push(p); return p === '/usr/bin/claude'; },
    });
    expect(found).toBe('/usr/bin/claude');
    expect(seenPosix).toEqual(['/usr/bin/claude']);
  });

  test('falls back to ~/.local/bin when PATH does not carry it', () => {
    const exists = (p) => p === 'C:\\Users\\u\\.local\\bin\\claude.exe';
    expect(resolveBin(win({ exists }))).toBe('C:\\Users\\u\\.local\\bin\\claude.exe');
  });

  test('POSIX uses the bare name', () => {
    const exists = (p) => p === '/usr/local/bin/claude';
    expect(resolveBin({ bin: 'claude', platform: 'linux', home: '/home/u', pathValue: '/usr/bin:/usr/local/bin', exists }))
      .toBe('/usr/local/bin/claude');
  });

  test('nothing found, or an exists() that throws, is null rather than an error', () => {
    expect(resolveBin(win({ exists: () => false }))).toBeNull();
    expect(resolveBin(win({ exists: () => { throw new Error('boom'); } }))).toBeNull();
    expect(resolveBin({ platform: 'linux', exists: () => true })).toBeNull();
  });
});

// ============================================================================
// The registry
// ============================================================================

test.describe('registry: backgroundListing', () => {
  test('claude declares it, and the argv always carries --json', () => {
    const cfg = agents.backgroundListingFor('claude');
    expect(cfg).not.toBeNull();
    // `claude agents` WITHOUT --json restarts the background daemon (measured on 2.1.302);
    // --json is part of the contract, not a formatting choice.
    expect([...cfg.argv]).toEqual(['agents', '--json']);
    expect(cfg.bin).toBe('claude');
    expect(cfg.timeoutMs).toBeGreaterThan(0);
    expect(cfg.ttlMs).toBeGreaterThan(0);
    // An explicit list: the operator's own CLAUDE_* settings must reach the child.
    expect(cfg.scrubEnv.names).toContain('CLAUDECODE');
    expect(cfg.scrubEnv.names).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(cfg.scrubEnv.names).not.toContain('CLAUDE_CONFIG_DIR');
    expect(cfg.scrubEnv).not.toHaveProperty('prefix');
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.argv)).toBe(true);
  });

  test('codex, a plain shell and unknown ids have none', () => {
    expect(agents.backgroundListingFor('codex')).toBeNull();
    for (const id of [null, undefined, '', 'bash', 'nonsense', '__proto__', 'constructor']) {
      expect(agents.backgroundListingFor(/** @type {any} */ (id)), `id ${String(id)}`).toBeNull();
    }
  });

  test('backgroundListingAgent names the declaring provider, so server.js holds no agent id', () => {
    expect(agents.backgroundListingAgent()).toBe('claude');
  });
});

// ============================================================================
// The runner - single-flight, cache, failure reporting. A fake exec: no process at all.
// ============================================================================

test.describe('runner (fake exec)', () => {
  const rowsText = (rows = [bg(), interactive()]) => JSON.stringify(rows);

  function harness(over = {}) {
    const ctl = {
      t: 1000,
      bin: /** @type {string|null} */ ('/opt/claude'),
      calls: /** @type {any[]} */ ([]),
      failures: /** @type {string[]} */ ([]),
      // What the next exec call returns (a function so a test can hand back a pending promise).
      next: /** @type {(req: any) => any} */ (() => ({ ok: true, stdout: rowsText() })),
    };
    const cfg = { ...agents.backgroundListingFor('claude'), ...(over.cfg || {}) };
    const runner = createBackgroundListing({
      cfg,
      resolve: () => ctl.bin,
      exec: over.exec || ((req) => { ctl.calls.push(req); return ctl.next(req); }),
      now: () => ctl.t,
      env: () => ({
        PATH: 'C:\\bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 's',
        CLAUDE_CONFIG_DIR: 'C:\\cfg', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
      }),
      cwd: 'D:\\home',
      onFailure: (r) => ctl.failures.push(r),
    });
    return { runner, ctl, cfg };
  }

  test('asks exec for the registry argv and timeout, in the right cwd, with a scrubbed env', async () => {
    const h = harness();
    const out = await h.runner.get();
    expect(out.available).toBe(true);
    expect(out.agents.map((r) => r.id)).toEqual(['a1b2c3d4']);
    expect(JSON.stringify(out)).not.toContain('4242');

    expect(h.ctl.calls).toHaveLength(1);
    const req = h.ctl.calls[0];
    expect(req.bin).toBe('/opt/claude');
    expect(req.argv).toEqual(['agents', '--json']);
    expect(req.cwd).toBe('D:\\home');
    expect(req.timeoutMs).toBe(h.cfg.timeoutMs);
    expect(req.env.CLAUDECODE).toBeUndefined();
    expect(req.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(req.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(req.env.CLAUDE_CONFIG_DIR).toBe('C:\\cfg');
    expect(req.env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\git\\bash.exe');
    expect(req.env.PATH).toBe('C:\\bin');
    expect(h.ctl.failures).toEqual([]);
  });

  test('a failed exec is unavailable and its reason is passed to the failure hook', async () => {
    const h = harness();
    h.ctl.next = () => ({ ok: false, reason: 'exec:1' });
    expect(await h.runner.get()).toEqual({ available: false });
    expect(h.ctl.failures).toEqual(['exec:1']);
  });

  test('output that is not JSON, or not an array, is unavailable', async () => {
    for (const stdout of ['{not json', '{"agents":[]}', '']) {
      const h = harness();
      h.ctl.next = () => ({ ok: true, stdout });
      expect(await h.runner.get(), stdout).toEqual({ available: false });
      expect(h.ctl.failures, stdout).toEqual(['bad-output']);
    }
  });

  test('no resolvable binary is unavailable and starts nothing', async () => {
    const h = harness();
    h.ctl.bin = null;
    expect(await h.runner.get()).toEqual({ available: false });
    expect(h.ctl.failures).toEqual(['no-binary']);
    expect(h.ctl.calls).toHaveLength(0);
  });

  test('an exec that throws or rejects, or a resolver that throws, is unavailable - never a rejection', async () => {
    const a = harness({ exec: () => { throw new Error('exploded'); } });
    expect(await a.runner.get()).toEqual({ available: false });
    expect(a.ctl.failures).toEqual(['exec-threw']);

    const b = harness({ exec: () => Promise.reject(new Error('rejected')) });
    expect(await b.runner.get()).toEqual({ available: false });
    expect(b.ctl.failures).toEqual(['exec-threw']);

    const c = createBackgroundListing({
      cfg: agents.backgroundListingFor('claude'), resolve: () => { throw new Error('nope'); },
      exec: () => { throw new Error('unreachable'); },
    });
    expect(await c.get()).toEqual({ available: false });

    const d = harness({ exec: () => ({ ok: false }) });
    expect(await d.runner.get()).toEqual({ available: false });
    expect(d.ctl.failures).toEqual(['exec-failed']);
  });

  test('concurrent callers share ONE exec; the answer is then served from memory until the TTL', async () => {
    const h = harness();
    /** @type {(v: any) => void} */ let release = () => {};
    h.ctl.next = () => new Promise((resolve) => { release = resolve; });
    const calls = [h.runner.get(), h.runner.get(), h.runner.get()];
    expect(h.ctl.calls, 'all three joined the one in flight').toHaveLength(1);
    release({ ok: true, stdout: rowsText() });
    const [a, b, c] = await Promise.all(calls);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.available).toBe(true);

    h.ctl.t += h.cfg.ttlMs - 1;
    expect(await h.runner.get()).toBe(a);
    expect(h.ctl.calls, 'inside the TTL: no new exec').toHaveLength(1);

    h.ctl.t += 2;
    h.ctl.next = () => ({ ok: true, stdout: rowsText() });
    await h.runner.get();
    expect(h.ctl.calls, 'past the TTL: exactly one more').toHaveLength(2);
  });

  test('a FAILURE is held for the TTL too, so a broken CLI is not respawned by every poll', async () => {
    const h = harness();
    h.ctl.next = () => ({ ok: false, reason: 'exec:1' });
    expect(await h.runner.get()).toEqual({ available: false });
    expect(await h.runner.get()).toEqual({ available: false });
    expect(await h.runner.get()).toEqual({ available: false });
    expect(h.ctl.calls).toHaveLength(1);

    h.ctl.t += h.cfg.ttlMs + 1;
    h.ctl.next = () => ({ ok: true, stdout: rowsText() });
    expect((await h.runner.get()).available, 'recovers once the window lapses').toBe(true);
    expect(h.ctl.calls).toHaveLength(2);
  });

  test('the failure hook fires when the reason CHANGES, not once per window', async () => {
    const h = harness();
    const again = async (next) => { h.ctl.t += h.cfg.ttlMs + 1; h.ctl.next = next; await h.runner.get(); };
    const fail = (reason) => () => ({ ok: false, reason });
    const good = () => ({ ok: true, stdout: rowsText() });

    h.ctl.next = fail('timeout');
    await h.runner.get();
    await again(fail('timeout'));
    await again(fail('timeout'));
    expect(h.ctl.failures, 'an outage that lasts is one line').toEqual(['timeout']);

    await again(fail('exec:1'));
    expect(h.ctl.failures, 'a different reason is reported').toEqual(['timeout', 'exec:1']);

    await again(good);
    await again(fail('exec:1'));
    expect(h.ctl.failures, 'after a success, the same failure is news again').toEqual(['timeout', 'exec:1', 'exec:1']);
  });

  test('nothing is started at construction', async () => {
    const h = harness();
    expect(h.ctl.calls).toHaveLength(0);
  });
});

// ============================================================================
// The inline exec - where the child is started. Fake execFile for the options and the
// ordering rules; a REAL stub process for what only a process can show.
// ============================================================================

const STUB_SOURCE = `
const fs = require('fs');
const { spawn } = require('child_process');
const log = process.env.STUB_LOG;
fs.appendFileSync(log, 'pid ' + process.pid + '\\n');
const mode = process.env.STUB_MODE;
if (mode === 'ok') process.stdout.write(process.env.STUB_ROWS);
else if (mode === 'exit1') { process.stdout.write('SECRET-STDOUT-MARKER'); process.stderr.write('SECRET-STDERR-MARKER'); process.exit(1); }
else if (mode === 'tree') {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  fs.appendFileSync(log, 'grandchild ' + g.pid + '\\n');
  fs.appendFileSync(log, 'ready\\n');   // everything the test waits for exists by now
  setInterval(() => {}, 1000);
}
`;

test.describe('inline exec', () => {
  /** @type {string} */ let dir;
  /** @type {string} */ let stub;

  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt366-'));
    stub = path.join(dir, 'stub-claude.js');
    fs.writeFileSync(stub, STUB_SOURCE);
  });
  test.afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const aliveState = (pid) => {
    try { process.kill(pid, 0); return 'alive'; } catch (e) { return e.code === 'EPERM' ? 'alive' : 'gone'; }
  };
  const logLines = (log) => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);

  /** A request that runs the stub in `mode`; its log is a file of its own. */
  function stubReq(mode, over = {}) {
    const log = path.join(dir, `run-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(log, '');
    return {
      log,
      req: {
        bin: process.execPath,
        argv: [stub],
        env: { ...process.env, STUB_MODE: mode, STUB_LOG: log, STUB_ROWS: JSON.stringify([bg(), interactive()]) },
        cwd: os.tmpdir(),
        timeoutMs: 60000,
        ...over,
      },
    };
  }

  // ---- fake execFile: options, ordering, and the watchdog's wiring ----

  test('hands execFile the request verbatim, hidden, with an output ceiling', async () => {
    /** @type {any[]} */ const calls = [];
    const exec = createInlineExec({
      execFile: (file, args, opts, cb) => { calls.push({ file, args, opts }); setImmediate(() => cb(null, '[]')); return { pid: 1 }; },
      killTree: () => {},
    });
    const env = { A: '1' };
    const res = await exec({ bin: 'B', argv: ['x', 'y'], env, cwd: 'C', timeoutMs: 5 });
    expect(res).toEqual({ ok: true, stdout: '[]' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('B');
    expect(calls[0].args).toEqual(['x', 'y']);
    expect(calls[0].opts.env).toBe(env);
    expect(calls[0].opts.cwd).toBe('C');
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.maxBuffer).toBe(MAX_STDOUT_BYTES);
  });

  test('a failure is a short reason code; a throwing execFile is "spawn-threw"', async () => {
    const failing = (err) => createInlineExec({
      execFile: (f, a, o, cb) => { setImmediate(() => cb(err, 'SECRET-STDOUT-MARKER')); return { pid: 1 }; },
      killTree: () => {},
    });
    const req = { bin: 'b', argv: [], env: {}, timeoutMs: 5 };
    expect(await failing(Object.assign(new Error('x'), { code: 1 }))(req)).toEqual({ ok: false, reason: 'exec:1' });
    expect(await failing(Object.assign(new Error('x'), { code: 'ENOENT' }))(req)).toEqual({ ok: false, reason: 'exec:ENOENT' });
    expect(await failing(new Error('x'))(req)).toEqual({ ok: false, reason: 'exec:error' });

    const throwing = createInlineExec({ execFile: () => { throw new Error('boom'); }, killTree: () => {} });
    expect(await throwing(req)).toEqual({ ok: false, reason: 'spawn-threw' });
  });

  test('an execFile that calls back BEFORE it returns settles at once and arms no watchdog', async () => {
    let armed = 0;
    const exec = createInlineExec({
      execFile: (f, a, o, cb) => { cb(null, '[]'); return { pid: 7 }; },     // synchronous callback
      killTree: () => { throw new Error('must not kill a finished request'); },
      setTimer: () => { armed++; return null; },
    });
    expect(await exec({ bin: 'b', argv: [], env: {}, timeoutMs: 5 })).toEqual({ ok: true, stdout: '[]' });
    expect(armed, 'no timer should be left behind for a request that is already over').toBe(0);
  });

  test('the watchdog is armed for timeoutMs and, when it fires, kills the TREE of the child it started', async () => {
    /** @type {{fn: Function, ms: number}|null} */ let armed = null;
    /** @type {Function|null} */ let lateCallback = null;
    /** @type {number[]} */ const killed = [];
    const exec = createInlineExec({
      execFile: (f, a, o, cb) => { lateCallback = cb; return { pid: 4242 }; },
      killTree: (pid) => killed.push(pid),
      setTimer: (fn, ms) => { armed = { fn, ms }; return { unref() {} }; },
      now: () => 1000,
    });
    const pending = exec({ bin: 'b', argv: [], env: {}, timeoutMs: 12345 });
    expect(armed && armed.ms).toBe(12345);
    /** @type {any} */ (armed).fn();
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    expect(killed).toEqual([4242]);
    // The killed child's callback arrives afterwards: it must change nothing.
    /** @type {Function} */ (lateCallback)(null, '[]');
  });

  /**
   * A fake execFile that takes `spawnMs` of a fake clock to RETURN - a CreateProcess held by an
   * AV hook - and hangs afterwards. Returns what the watchdog was armed with and who it killed.
   */
  function slowLaunch(spawnMs, timeoutMs, receivedAt) {
    const clock = { t: 5000 };
    /** @type {{fn: Function, ms: number}|null} */ let armed = null;
    /** @type {number[]} */ const killed = [];
    const exec = createInlineExec({
      execFile: () => { clock.t += spawnMs; return { pid: 777 }; },
      killTree: (pid) => killed.push(pid),
      setTimer: (fn, ms) => { armed = { fn, ms }; return { unref() {} }; },
      now: () => clock.t,
    });
    const pending = exec({ bin: 'b', argv: [], env: {}, timeoutMs }, receivedAt === undefined ? clock.t : receivedAt);
    return { pending, armed: () => armed, killed };
  }

  test('the child\'s budget counts from RECEIPT: a spawn that took 8.3 s leaves 1.7 s of 10 s', async () => {
    const r = slowLaunch(8300, 10000);
    expect(r.armed()?.ms, 'armed for what is left, not for the full 10 s').toBe(1700);
    /** @type {any} */ (r.armed()).fn();
    expect(await r.pending).toEqual({ ok: false, reason: 'timeout' });
    expect(r.killed, 'the worker\'s own watchdog killed its child').toEqual([777]);
  });

  test('a spawn that used up the whole budget gets its child killed at once (clamped to zero)', async () => {
    const r = slowLaunch(13000, 10000);
    expect(r.armed()?.ms).toBe(0);
    /** @type {any} */ (r.armed()).fn();
    expect(await r.pending).toEqual({ ok: false, reason: 'timeout' });
    expect(r.killed).toEqual([777]);
  });

  test('time spent QUEUED before the request was handled counts too: the deadline is receipt-based', async () => {
    // Received 4 s before the spawn began (the thread was busy), spawn itself instant: 6 s left.
    const r = slowLaunch(0, 10000, 1000);
    expect(r.armed()?.ms).toBe(6000);
    /** @type {any} */ (r.armed()).fn();
    await r.pending;
  });

  test('the worker handler stamps the request when it RECEIVES it and passes that to the exec', async () => {
    /** @type {any[]} */ const seen = [];
    /** @type {any[]} */ const posted = [];
    let t = 100;
    const handle = createHandler({
      now: () => t,
      exec: async (req, receivedAt) => { seen.push({ req, receivedAt }); t = 9999; return { ok: true, stdout: '[]' }; },
      post: (m) => posted.push(m),
    });
    await handle({ id: 7, req: { bin: 'b' } });
    expect(seen).toEqual([{ req: { bin: 'b' }, receivedAt: 100 }]);
    expect(posted).toEqual([{ id: 7, result: { ok: true, stdout: '[]' } }]);

    await handle(null);                                            // junk is ignored, not answered
    await handle({ id: 8 });
    expect(posted).toHaveLength(1);

    const throwing = createHandler({ exec: async () => { throw new Error('x'); }, post: (m) => posted.push(m) });
    await throwing({ id: 9, req: {} });
    expect(posted[1]).toEqual({ id: 9, result: { ok: false, reason: 'worker-threw' } });
  });

  // ---- a real stub process ----

  test('runs a real child: stdout comes back, and the registry-shaped request works end to end', async () => {
    const { req, log } = stubReq('ok');
    const res = await createInlineExec({ execFile, killTree })(req);
    expect(res.ok).toBe(true);
    expect(JSON.parse(/** @type {any} */ (res).stdout)).toHaveLength(2);
    expect(logLines(log)).toHaveLength(1);
  });

  test('a non-zero exit is "exec:1" and NOTHING the child printed reaches the result', async () => {
    const { req } = stubReq('exit1');
    const res = await createInlineExec({ execFile, killTree })(req);
    expect(res).toEqual({ ok: false, reason: 'exec:1' });
    expect(JSON.stringify(res)).not.toContain('SECRET');
  });

  test('a hung child is killed together with the grandchild it started', async () => {
    // The stub starts a grandchild and then says "ready". The watchdog is driven BY HAND once
    // that line exists, so no bet is placed on how fast a process boots on a host that stalls
    // for seconds at a time (a fixed timeout shorter than the boot reads an empty log).
    /** @type {Function|null} */ let fire = null;
    const exec = createInlineExec({
      execFile, killTree,
      setTimer: (fn) => { fire = fn; return { unref() {} }; },
    });
    const { req, log } = stubReq('tree');
    const pending = exec(req);
    await expect.poll(() => logLines(log).includes('ready'), {
      timeout: 60000, message: 'the stub never became ready',
    }).toBe(true);

    const lines = logLines(log);
    const child = Number(lines.find((l) => l.startsWith('pid '))?.slice(4));
    const grandchild = Number(lines.find((l) => l.startsWith('grandchild '))?.slice(11));
    expect(child).toBeGreaterThan(0);
    expect(grandchild).toBeGreaterThan(0);
    expect(aliveState(child)).toBe('alive');
    expect(aliveState(grandchild)).toBe('alive');

    /** @type {Function} */ (fire)();
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    for (const [who, pid] of [['child', child], ['grandchild', grandchild]]) {
      await expect.poll(() => aliveState(/** @type {number} */ (pid)), {
        timeout: 20000, message: `the ${who} must not be left running`,
      }).toBe('gone');
    }
  });
});

// ============================================================================
// The threaded exec - the worker thread server.js uses. REAL threads; a hostile worker
// script stands in for a thread that is blocked in CreateProcess or has died.
// ============================================================================

test.describe('threaded exec (real worker thread)', () => {
  /** @type {string} */ let dir;
  /** @type {string} */ let stub;
  /** @type {string} */ let hostile;
  /** @type {ReturnType<typeof createThreadedExec>[]} */ const hosts = [];

  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt366t-'));
    stub = path.join(dir, 'stub-claude.js');
    fs.writeFileSync(stub, STUB_SOURCE);
    // Behaves like the real worker, except for four bins. BLOCK parks the thread for good (as
    // far as a test is concerned) the way a CreateProcess stuck in an AV hook does: its own
    // timers cannot fire. LATE parks it briefly and then lets the real worker answer, so the
    // reply arrives AFTER the main thread's deadline. CRASH ends the thread. THROW is an
    // uncaught exception.
    hostile = path.join(dir, 'hostile-worker.js');
    fs.writeFileSync(hostile, `
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => {
  if (m.req.bin === 'LATE') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  if (m.req.bin === 'BLOCK') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  if (m.req.bin === 'CRASH') process.exit(3);
  if (m.req.bin === 'THROW') throw new Error('worker blew up');
});
require(${JSON.stringify(DEFAULT_WORKER_PATH)});
`);
  });
  test.afterAll(() => {
    for (const h of hosts) { try { h.dispose(); } catch { /* best effort */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** @param {object} [o] */
  function host(o = {}) {
    const h = createThreadedExec(o);
    hosts.push(h);
    return h;
  }
  const stubReq = (mode) => {
    const log = path.join(dir, `t-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(log, '');
    return {
      bin: process.execPath,
      argv: [stub],
      env: { ...process.env, STUB_MODE: mode, STUB_LOG: log, STUB_ROWS: JSON.stringify([bg()]) },
      cwd: os.tmpdir(),
      timeoutMs: 60000,
    };
  };
  const trivial = (bin) => ({ bin, argv: [], env: {}, cwd: os.tmpdir(), timeoutMs: 200 });

  /** A Worker constructor that remembers each thread and whether it has really exited. */
  function recordingCtor() {
    const Real = require('worker_threads').Worker;
    /** @type {{ w: any, exited: boolean }[]} */ const made = [];
    class Recording {
      constructor(p) {
        const w = new Real(p);
        const rec = { w, exited: false };
        w.once('exit', () => { rec.exited = true; });
        made.push(rec);
        return w;
      }
    }
    return { Ctor: Recording, made };
  }

  test('is lazy: no thread until the first call, then ONE long-lived thread serves every call', async () => {
    const rec = recordingCtor();
    const h = host({ WorkerCtor: rec.Ctor });
    expect(h.running()).toBe(false);
    expect(rec.made, 'nothing is constructed up front').toHaveLength(0);
    const a = await h.exec(stubReq('ok'));
    expect(a.ok).toBe(true);
    expect(JSON.parse(/** @type {any} */ (a).stdout)).toHaveLength(1);
    expect(h.running()).toBe(true);
    // Further calls, a failing one among them, reuse the same thread.
    expect((await h.exec(stubReq('ok'))).ok).toBe(true);
    expect((await h.exec(stubReq('exit1'))).ok).toBe(false);
    expect((await h.exec(stubReq('ok'))).ok).toBe(true);
    expect(h.running()).toBe(true);
    expect(rec.made, 'ONE thread across every call').toHaveLength(1);
    expect(rec.made[0].exited).toBe(false);
  });

  test('failures cross the thread as a reason code, with nothing the child printed', async () => {
    const h = host();
    const failed = await h.exec(stubReq('exit1'));
    expect(failed).toEqual({ ok: false, reason: 'exec:1' });
    expect(JSON.stringify(failed)).not.toContain('SECRET');
    expect(await h.exec({ ...stubReq('ok'), bin: path.join(dir, 'does-not-exist.exe') }))
      .toEqual({ ok: false, reason: 'exec:ENOENT' });
  });

  test('at its deadline the main thread stops WAITING - it does not terminate or replace the thread', async () => {
    // The thread's own deadline is what kills the child, and a terminated thread takes that
    // timer with it: terminating here would orphan a claude.exe on every window.
    const rec = recordingCtor();
    const h = host({ workerPath: hostile, graceMs: 100, WorkerCtor: rec.Ctor });
    const t0 = Date.now();
    const stuck = await h.exec(trivial('BLOCK'));       // the thread parks for up to 30 s
    expect(stuck).toEqual({ ok: false, reason: 'worker-timeout' });
    expect(Date.now() - t0, 'answered by the main-thread deadline, not by waiting out the block').toBeLessThan(25000);
    expect(h.running(), 'the thread is still the host\'s thread').toBe(true);
    expect(rec.made, 'and no replacement was made').toHaveLength(1);
    // Give a (wrong) terminate() every chance to land before looking.
    await new Promise((r) => setTimeout(r, 500));
    expect(rec.made[0].exited, 'the thread must not have been terminated').toBe(false);
  });

  test('a reply that arrives after the deadline is ignored, and does not disturb the next request', async () => {
    const rec = recordingCtor();
    const h = host({ workerPath: hostile, graceMs: 100, WorkerCtor: rec.Ctor });
    // 'LATE' parks the thread for 1.5 s, then answers (exec:ENOENT) - long after the 200 ms deadline.
    expect(await h.exec(trivial('LATE'))).toEqual({ ok: false, reason: 'worker-timeout' });
    // This one queues behind the late one in the same thread. If the late reply were taken for
    // its answer, it would read exec:ENOENT instead of the stub's rows.
    const next = await h.exec(stubReq('ok'));
    expect(next.ok, 'the next request gets ITS reply').toBe(true);
    expect(JSON.parse(/** @type {any} */ (next).stdout)).toHaveLength(1);
    expect(rec.made, 'the same thread served both').toHaveLength(1);
    expect(rec.made[0].exited).toBe(false);
  });

  test('a request that cannot be posted fails alone: it says nothing about the thread, which is kept', async () => {
    const rec = recordingCtor();
    const h = host({ WorkerCtor: rec.Ctor });
    // A function cannot be structured-cloned, so postMessage throws DataCloneError.
    const bad = { ...stubReq('ok'), env: { f() {} } };
    expect(await h.exec(bad)).toEqual({ ok: false, reason: 'worker-post' });
    expect(h.running()).toBe(true);
    expect((await h.exec(stubReq('ok'))).ok).toBe(true);
    expect(rec.made, 'the same thread served the next request').toHaveLength(1);
    expect(rec.made[0].exited).toBe(false);
  });

  test('a thread that dies, or throws, is reported and recreated - and only then', async () => {
    const rec = recordingCtor();
    const h = host({ workerPath: hostile, graceMs: 20000, WorkerCtor: rec.Ctor });
    expect(await h.exec(trivial('CRASH'))).toEqual({ ok: false, reason: 'worker-exit' });
    expect(h.running()).toBe(false);
    expect((await h.exec(stubReq('ok'))).ok).toBe(true);
    expect(rec.made, 'recreated after it died').toHaveLength(2);

    expect(await h.exec(trivial('THROW'))).toEqual({ ok: false, reason: 'worker-error' });
    expect(h.running()).toBe(false);
    expect((await h.exec(stubReq('ok'))).ok, 'restartable more than once').toBe(true);
    expect(rec.made).toHaveLength(3);
  });

  test('dispose answers what is in flight, stops the thread, and the host can start another', async () => {
    const rec = recordingCtor();
    const h = host({ workerPath: hostile, graceMs: 20000, WorkerCtor: rec.Ctor });
    const inflight = h.exec(trivial('BLOCK'));
    await expect.poll(() => h.running()).toBe(true);
    h.dispose();
    expect(await inflight).toEqual({ ok: false, reason: 'disposed' });
    expect(h.running()).toBe(false);
    await expect.poll(() => rec.made[0].exited, {
      timeout: 20000, message: 'dispose must stop the thread - no worker outlives a shutdown',
    }).toBe(true);
    h.dispose();                                         // idempotent
    expect((await h.exec(stubReq('ok'))).ok).toBe(true);
  });

  test('a thread that cannot be started is "worker-start", and the next call tries again', async () => {
    let attempts = 0;
    const Real = require('worker_threads').Worker;
    const h = host({
      WorkerCtor: class {
        constructor(p) { attempts++; if (attempts === 1) throw new Error('no threads today'); return new Real(p); }
      },
    });
    expect(await h.exec(stubReq('ok'))).toEqual({ ok: false, reason: 'worker-start' });
    expect((await h.exec(stubReq('ok'))).ok).toBe(true);
    expect(attempts).toBe(2);
  });
});

// ============================================================================
// The route - on the suite's server (WT_CLAUDE_BIN points at a binary that is not there)
// ============================================================================

test.describe('server.js wiring (source gate)', () => {
  // A behavioural test of either needs a server that is spawning on the main thread or being
  // SIGTERM'd, which is exactly what a hot reload does to production. So these read the source,
  // the way tests/app-input-path.spec.js does: nothing here can be seen by a request.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The CODE of the block AND of the route handler, through its closing `});`: a spawn inside
  // the handler body is as bad as one in the setup. Comments explain why nothing here may
  // spawn, so they say "spawn" and are dropped.
  const blockStart = src.indexOf('// #366 - the background / dispatched agents');
  const handlerStart = src.indexOf("app.get('/api/dashboard/background-agents'");
  const close = /\r?\n\}\);/.exec(src.slice(handlerStart));
  const handlerEnd = close ? handlerStart + close.index + close[0].length : blockStart;
  const routeBlock = src.slice(blockStart, handlerEnd).replace(/^\s*\/\/.*$/gm, '');

  test('the listing is started through the worker-thread exec, never an execFile on the main loop', () => {
    expect(routeBlock.length, 'the #366 block was not found').toBeGreaterThan(200);
    expect(routeBlock, 'the slice must reach into the handler body, or a spawn there goes unseen')
      .toContain('res.json(await _backgroundListing.get())');
    expect(routeBlock.trimEnd().endsWith('});'), 'and end at the handler\'s closing').toBe(true);
    expect(routeBlock).toContain('createThreadedExec(');
    expect(routeBlock).toContain('exec: _backgroundListingExec.exec');
    expect(routeBlock, 'CreateProcess on the main thread is the freeze this exists to avoid')
      .not.toMatch(/\bexecFile\b|\bspawn\b|createInlineExec|\bexecFileSync\b|\bexecSync\b/);
  });

  test('graceful shutdown stops the worker thread', () => {
    const start = src.indexOf('async function gracefulShutdown');
    const body = src.slice(start, src.indexOf("process.on('SIGINT'", start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('_backgroundListingExec.dispose()');
  });
});

test.describe('GET /api/dashboard/background-agents', () => {
  test('is auth-only: 401 with no credentials', async () => {
    const anon = await noAuthCtx();
    const res = await anon.get('/api/dashboard/background-agents');
    expect(res.status()).toBe(401);
    expect(await res.text()).not.toContain('available');
    await anon.dispose();
  });

  test('is auth-only: 401 for a bad bearer token', async () => {
    const anon = await noAuthCtx();
    const res = await anon.get('/api/dashboard/background-agents', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test('a missing CLI is a 200 { available:false }, uncached by the browser, honouring WT_CLAUDE_BIN', async () => {
    // playwright.config.js points WT_CLAUDE_BIN at a path that does not exist. If the
    // override were ignored, a machine with a real `claude` would answer available:true.
    const ctx = await authCtx();
    const res = await ctx.get('/api/dashboard/background-agents');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.json()).toEqual({ available: false });
    await ctx.dispose();
  });
});
