// @ts-check
// #366 - the background / dispatched agents `claude agents --json` lists, served read-only.
//
// What is under test is the SERVER half: what the CLI's output is allowed to become
// (lib/background-listing.js), when and how it is run (lib/background-listing-runner.js),
// which registry entry says so (lib/agents.js), and that the route is auth-only.
//
// EVERY ROW BELOW IS SYNTHETIC. The real listing names every project's sessions and working
// directories on the machine, so no fixture is copied from it - the shapes (field names,
// the five `state` words, `kind`, `waitingFor`) come from the issue and from probing the
// CLI's KEYS, never its values. The suite never launches the real CLI either: the runner is
// driven through a stub executable (a tiny node script) over a REAL child process, and the
// shared server is pointed at a nonexistent binary by playwright.config.js (WT_CLAUDE_BIN).
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
  const spec = { prefix: 'CLAUDE', keep: ['CLAUDE_CONFIG_DIR'] };

  test('drops every CLAUDE* variable except CLAUDE_CONFIG_DIR, case-insensitively', () => {
    const input = {
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', Claude_Other: 'x',
      CLAUDE_CONFIG_DIR: 'C:\\cfg', claude_config_dir: 'lower',
      PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'keep-me', HOME: 'h',
    };
    const out = scrubEnv(input, spec);
    expect(Object.keys(out).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'claude_config_dir'].sort());
    expect(out.CLAUDE_CONFIG_DIR).toBe('C:\\cfg');
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
    expect(cfg.scrubEnv).toEqual({ prefix: 'CLAUDE', keep: ['CLAUDE_CONFIG_DIR'] });
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
// The runner - a REAL child process, a stub executable, an injected clock
// ============================================================================

const STUB_SOURCE = `
const fs = require('fs');
fs.appendFileSync(process.env.STUB_LOG, process.pid + '\\n');
const mode = process.env.STUB_MODE;
const rows = JSON.stringify(JSON.parse(process.env.STUB_ROWS));
if (mode === 'ok') process.stdout.write(rows);
else if (mode === 'slow') setTimeout(() => process.stdout.write(rows), 500);
else if (mode === 'exit1') { process.stdout.write('SECRET-STDOUT-MARKER'); process.stderr.write('SECRET-STDERR-MARKER'); process.exit(1); }
else if (mode === 'badjson') process.stdout.write('{not json SECRET-STDOUT-MARKER');
else if (mode === 'object') process.stdout.write('{"agents":[]}');
else if (mode === 'hang') setInterval(() => {}, 1000);
`;

test.describe('runner (real child process, stub executable)', () => {
  /** @type {string} */ let dir;
  /** @type {string} */ let stub;

  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt366-'));
    stub = path.join(dir, 'stub-claude.js');
    fs.writeFileSync(stub, STUB_SOURCE);
  });
  test.afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  /** A runner over the stub; `ctl.mode` picks what the stub does, `ctl.t` is the clock. */
  function harness(over = {}) {
    const log = path.join(dir, `spawns-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(log, '');
    const ctl = {
      mode: 'ok', t: 1000, bin: /** @type {string|null} */ ('stub'),
      calls: /** @type {any[]} */ ([]), failures: /** @type {string[]} */ ([]),
    };
    const cfg = { ...agents.backgroundListingFor('claude'), timeoutMs: 5000, ...(over.cfg || {}) };
    const runner = createBackgroundListing({
      cfg,
      resolve: () => ctl.bin,
      // The wrapper swaps the executable for node + the stub, but hands the runner's own
      // options through untouched (recording them), so what the runner asked for is
      // what is asserted.
      execFile: over.execFile || ((file, args, o, cb) => {
        ctl.calls.push({ file, args, opts: o });
        return execFile(process.execPath, [stub, ...args], {
          ...o,
          env: {
            ...o.env,
            STUB_MODE: ctl.mode,
            STUB_LOG: log,
            STUB_ROWS: JSON.stringify([bg(), interactive()]),
          },
        }, cb);
      }),
      killTree,
      now: () => ctl.t,
      env: () => ({
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: 'C:\\cfg',
      }),
      cwd: os.tmpdir(),
      onFailure: (r) => ctl.failures.push(r),
    });
    const spawns = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { runner, ctl, cfg, spawns };
  }

  test('success: parsed rows, the registry argv, a scrubbed env, no console window', async () => {
    const h = harness();
    const out = await h.runner.get();
    expect(out.available).toBe(true);
    expect(out.agents.map((r) => r.id)).toEqual(['a1b2c3d4']);
    expect(JSON.stringify(out)).not.toContain('4242');

    expect(h.ctl.calls).toHaveLength(1);
    const { args, opts } = h.ctl.calls[0];
    expect(args).toEqual(['agents', '--json']);
    expect(opts.windowsHide).toBe(true);
    expect(opts.cwd).toBe(os.tmpdir());
    expect(opts.env.CLAUDECODE).toBeUndefined();
    expect(opts.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('C:\\cfg');
    expect(opts.env.PATH).toBe(process.env.PATH);
    expect(h.ctl.failures).toEqual([]);
  });

  test('a non-zero exit is unavailable, and neither stdout nor stderr reaches the failure hook', async () => {
    const h = harness();
    h.ctl.mode = 'exit1';
    expect(await h.runner.get()).toEqual({ available: false });
    expect(h.ctl.failures).toEqual(['exec:1']);
    expect(h.ctl.failures.join(' ')).not.toContain('SECRET');
  });

  test('output that is not JSON, or not an array, is unavailable', async () => {
    for (const mode of ['badjson', 'object']) {
      const h = harness();
      h.ctl.mode = mode;
      expect(await h.runner.get(), mode).toEqual({ available: false });
      expect(h.ctl.failures, mode).toEqual(['bad-output']);
      expect(h.ctl.failures.join(' ')).not.toContain('SECRET');
    }
  });

  test('a hang past the timeout is unavailable, and the child is really killed', async () => {
    const h = harness({ cfg: { timeoutMs: 600 } });
    h.ctl.mode = 'hang';
    const t0 = Date.now();
    expect(await h.runner.get()).toEqual({ available: false });
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(h.ctl.failures).toEqual(['timeout']);

    const pid = Number(h.spawns()[0]);
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => {
      try { process.kill(pid, 0); return 'alive'; } catch (e) { return e.code === 'EPERM' ? 'alive' : 'gone'; }
    }, { timeout: 8000, message: 'the timed-out child must not be left running' }).toBe('gone');
  });

  test('no resolvable binary is unavailable and spawns nothing', async () => {
    const h = harness();
    h.ctl.bin = null;
    expect(await h.runner.get()).toEqual({ available: false });
    expect(h.ctl.failures).toEqual(['no-binary']);
    expect(h.spawns()).toHaveLength(0);
  });

  test('a spawn that throws, or a resolver that throws, is unavailable - never a rejection', async () => {
    const a = harness({ execFile: () => { throw new Error('spawn exploded'); } });
    expect(await a.runner.get()).toEqual({ available: false });
    expect(a.ctl.failures).toEqual(['spawn-threw']);

    const b = harness();
    b.ctl.bin = /** @type {any} */ ('stub');
    const throwing = createBackgroundListing({
      cfg: b.cfg, resolve: () => { throw new Error('nope'); }, execFile: () => { throw new Error('unreachable'); },
      killTree,
    });
    expect(await throwing.get()).toEqual({ available: false });
  });

  test('concurrent callers share ONE spawn; the answer is then served from memory until the TTL', async () => {
    const h = harness();
    h.ctl.mode = 'slow';
    const [a, b, c] = await Promise.all([h.runner.get(), h.runner.get(), h.runner.get()]);
    expect(h.spawns()).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.available).toBe(true);

    h.ctl.t += h.cfg.ttlMs - 1;
    expect(await h.runner.get()).toBe(a);
    expect(h.spawns(), 'inside the TTL: no new spawn').toHaveLength(1);

    h.ctl.t += 2;
    h.ctl.mode = 'ok';
    await h.runner.get();
    expect(h.spawns(), 'past the TTL: exactly one more').toHaveLength(2);
  });

  test('a FAILURE is held for the TTL too, so a broken CLI is not respawned by every poll', async () => {
    const h = harness();
    h.ctl.mode = 'exit1';
    expect(await h.runner.get()).toEqual({ available: false });
    expect(await h.runner.get()).toEqual({ available: false });
    expect(await h.runner.get()).toEqual({ available: false });
    expect(h.spawns()).toHaveLength(1);

    h.ctl.t += h.cfg.ttlMs + 1;
    h.ctl.mode = 'ok';
    expect((await h.runner.get()).available, 'recovers once the window lapses').toBe(true);
    expect(h.spawns()).toHaveLength(2);
  });

  test('nothing spawns at construction or until asked', async () => {
    const h = harness();
    expect(h.spawns()).toHaveLength(0);
    expect(h.ctl.calls).toHaveLength(0);
  });
});

// ============================================================================
// The route - on the suite's server (WT_CLAUDE_BIN points at a binary that is not there)
// ============================================================================

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
