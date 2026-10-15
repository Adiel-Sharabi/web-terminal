// @ts-check
// #351 - an agent in one session creates helper sessions with POST /api/sessions (often on
// a cluster peer) and never closes them; each machine has a session cap, and an orphan held
// a slot for 21 hours. The owner's rule: close an AGENT-STARTED session once its turn has
// ended and nobody has viewed it for hours.
//
// Who started a session is decided by BEHAVIOUR, never by auth (the companion, the cluster
// proxy and an agent all use Bearer): a session POSTed here is `agent`-started unless an
// ACTIVE viewer attaches within the classify window. The rules are lib/spawn-reaper.js and
// are pinned first, gate by gate; the second half drives the real server, worker and sockets.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { test, expect } = require('@playwright/test');
const { BASE, AUTH, authCtx } = require('./test-helpers');
const R = require('../lib/spawn-reaper');
const { negotiateSize, isActiveViewer } = require('../lib/terminal-size');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HOUR = 3600 * 1000;
const NOW = 1_800_000_000_000;

// --- the pure rule ------------------------------------------------------------

/** A session that is entitled to be closed: agent-started, 10 hours old, untouched. */
const cfg = R.reaperConfig(6);
const meta = (o = {}) => ({ by: 'agent', createdAt: NOW - 10 * HOUR, spawnedBy: null, lastViewedAt: null, ...o });
const row = (o = {}) => ({
  status: 'idle', compacting: false, lastActivity: NOW - 10 * HOUR, activeViewers: 0, favorite: false,
  usageLimit: { waiting: false }, backgroundTasks: [], ...o,
});
const decide = (r = row(), m = meta(), c = cfg) => R.shouldClose(r, m, NOW, c);

test.describe('#351 shouldClose - every gate, alone', () => {
  test('the baseline closes: agent-started, idle, unviewed, nothing running', () => {
    expect(decide()).toMatchObject({ close: true, why: 'idle' });
  });

  // Each row below changes ONE thing about the baseline and must flip the answer. A gate
  // whose test is missing is a gate someone can delete with the suite still green.
  const gates = [
    ['an active viewer is attached', { activeViewers: 1 }, 'viewer'],
    ['the row does not say how many viewers (fail closed)', { activeViewers: undefined }, 'viewer'],
    ['its turn is running', { status: 'working' }, 'working'],
    ['it is waiting on a person', { status: 'waiting' }, 'waiting'],
    ['it is compacting', { compacting: true }, 'compacting'],
    ['a background command is running', { backgroundTasks: [{ id: 'b1', description: 'build' }] }, 'background-work'],
    ['whether work is running is unknown (fail closed)', { backgroundTasks: null }, 'work-unknown'],
    ['it is a favorite', { favorite: true }, 'favorite'],
    ['it is sitting out a usage limit', { usageLimit: { waiting: true } }, 'capped'],
    ['it has no usage-limit reading (fail closed)', { usageLimit: undefined }, 'no-data'],
    ['it produced output a moment ago', { lastActivity: NOW - 1000 }, 'recent'],
  ];
  for (const [what, patch, why] of gates) {
    test(`not closed while: ${what}`, () => {
      expect(decide(row(patch))).toEqual({ close: false, why });
    });
  }

  test('not closed when the verdict is recent: created a moment ago', () => {
    expect(decide(row({ lastActivity: 0 }), meta({ createdAt: NOW - 1000 }))).toEqual({ close: false, why: 'recent' });
  });

  test('not closed when somebody looked at it a moment ago', () => {
    expect(decide(row(), meta({ lastViewedAt: NOW - 1000 }))).toEqual({ close: false, why: 'recent' });
  });

  test('a STALE background task is not running work (the badge\'s own backstop)', () => {
    expect(decide(row({ backgroundTasks: [{ id: 'p1', description: 'shell command', stale: true }] })).close).toBe(true);
    expect(decide(row({ backgroundTasks: [{ id: 'p1', stale: true }, { id: 'b2' }] })).close).toBe(false);
  });

  test('the idle clock is the NEWEST of created / last viewed / last output', () => {
    const idle = 6 * HOUR;
    const c = R.reaperConfig(6);
    expect(c.idleMs).toBe(idle);
    // exactly at the threshold closes; one millisecond short does not
    expect(R.shouldClose(row({ lastActivity: NOW - idle }), meta({ createdAt: NOW - 9 * HOUR }), NOW, c).close).toBe(true);
    expect(R.shouldClose(row({ lastActivity: NOW - idle + 1 }), meta({ createdAt: NOW - 9 * HOUR }), NOW, c).close).toBe(false);
    expect(R.shouldClose(row({ lastActivity: NOW - 9 * HOUR }), meta({ lastViewedAt: NOW - idle + 1 }), NOW, c).close).toBe(false);
  });

  test('a session this server did not classify as agent-started is NEVER closed', () => {
    expect(decide(row(), null)).toEqual({ close: false, why: 'unknown' });
    expect(R.shouldClose(row(), undefined, NOW, cfg).close).toBe(false);
    expect(decide(row(), meta({ by: 'human' }))).toEqual({ close: false, why: 'human' });
    expect(decide(row(), meta({ by: 'pending' })).close).toBe(false);
    expect(decide(row(), meta({ by: 'whatever' })).close).toBe(false);
    expect(decide(row(), meta({ createdAt: undefined }))).toEqual({ close: false, why: 'no-data' });
  });

  test('a row that was never read is not closed', () => {
    expect(R.shouldClose(null, meta(), NOW, cfg).close).toBe(false);
    expect(R.shouldClose(row(), meta(), undefined, cfg).close).toBe(false);
  });
});

test.describe('#351 the config knob', () => {
  test('default 6 hours; fractions allowed', () => {
    expect(R.reaperConfig(undefined)).toEqual({ enabled: true, idleMs: 6 * HOUR });
    expect(R.reaperConfig(null)).toEqual({ enabled: true, idleMs: 6 * HOUR });
    expect(R.reaperConfig(0.5)).toEqual({ enabled: true, idleMs: 0.5 * HOUR });
    expect(R.reaperConfig('2').idleMs).toBe(2 * HOUR);
  });

  test('0 disables it - and so does false', () => {
    expect(R.reaperConfig(0).enabled).toBe(false);
    expect(R.reaperConfig(false).enabled).toBe(false);
    expect(decide(row(), meta(), R.reaperConfig(0))).toEqual({ close: false, why: 'disabled' });
    expect(decide(row(), meta(), R.reaperConfig(false))).toEqual({ close: false, why: 'disabled' });
    expect(R.shouldClose(row(), meta(), NOW, undefined).close).toBe(false);
  });

  test('a typo or a negative is the default, not a surprise', () => {
    expect(R.reaperConfig('never').idleMs).toBe(6 * HOUR);
    expect(R.reaperConfig(-3).idleMs).toBe(6 * HOUR);
    expect(R.reaperConfig(NaN).idleMs).toBe(6 * HOUR);
  });

  test('a test override shortens the threshold but never re-enables a disabled reaper', () => {
    expect(R.reaperConfig(6, 1500)).toEqual({ enabled: true, idleMs: 1500 });
    expect(R.reaperConfig(0, 1500).enabled).toBe(false);
  });
});

test.describe('#351 classifySpawn - behaviour, not credentials', () => {
  const c = 1_700_000_000_000;
  const W = R.CLASSIFY_MS;

  test('the window is 60 seconds', () => { expect(W).toBe(60_000); });

  test('a viewer inside the window makes it a person\'s', () => {
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + 5_000, now: c + 5_000 })).toBe('human');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + W - 1, now: c + 10 * W })).toBe('human');
  });

  test('nobody yet: pending until the window closes, then agent-started', () => {
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + W - 1 })).toBe('pending');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + W })).toBe('agent');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + 10 * HOUR })).toBe('agent');
  });

  test('a viewer who arrives AFTER the window does not make it a person\'s', () => {
    // judged by when the view happened, not by when somebody asks - a lazy caller (a list,
    // a sweep) must get the answer an eager timer would have
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + W, now: c + W + 1 })).toBe('agent');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + 2 * W, now: c + 3 * W })).toBe('agent');
  });

  test('no creation time is no verdict', () => {
    expect(R.classifySpawn({ createdAt: undefined, now: c })).toBe('unknown');
  });

  test('the window is overridable per call (the suite shortens it)', () => {
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + 4000, classifyMs: 3000 })).toBe('agent');
  });
});

test.describe('#351 ACTIVE viewer - the same notion terminal-size uses', () => {
  test('a background socket is not a viewer; an active one (or one that never said) is', () => {
    expect(R.countActiveViewers([])).toBe(0);
    expect(R.countActiveViewers(null)).toBe(0);
    expect(R.countActiveViewers([{ background: true }, { background: true }])).toBe(0);
    expect(R.countActiveViewers([{ background: true }, { background: false }])).toBe(1);
    expect(R.countActiveViewers([{ background: false }, {}, { background: false }])).toBe(3);
  });

  test('ONE definition: exactly the sockets that have a vote in the PTY size', () => {
    for (const background of [true, false, undefined]) {
      const v = { cols: 80, rows: 24, background };
      expect(isActiveViewer(v)).toBe(negotiateSize([v]) !== null);
    }
    expect(isActiveViewer(null)).toBe(false);
  });
});

test.describe('#351 the spawner\'s label', () => {
  test('plain text, trimmed, capped at 120', () => {
    expect(R.spawnedByLabel('  helper agent  ')).toBe('helper agent');
    expect(R.spawnedByLabel('x'.repeat(300))).toHaveLength(120);
    expect(R.spawnedByLabel('a' + String.fromCharCode(13, 10) + 'b' + String.fromCharCode(7) + 'c' + String.fromCharCode(0x2028, 0x2029) + 'd')).toBe('abcd');
  });
  test('absent or not a string is no label', () => {
    for (const v of [undefined, null, 7, {}, [], '', '   ', '\n']) expect(R.spawnedByLabel(v)).toBeNull();
  });
  test('the log line is the one the owner asked for', () => {
    expect(R.closeLogLine({ name: 'helper', id: 'abc', spawnedBy: 'nightly', idleMs: 6.04 * HOUR }))
      .toBe('spawn-reaper: closed "helper" (abc) - agent-started, by "nightly", idle 6h');
    expect(R.closeLogLine({ name: 'helper', id: 'abc', spawnedBy: null, idleMs: 7.26 * HOUR }))
      .toBe('spawn-reaper: closed "helper" (abc) - agent-started, idle 7.3h');
  });
});

// --- the source gates -----------------------------------------------------------

test.describe('#351 server.js wiring (pinned against the source)', () => {
  const list = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('/api/sessions'"));
  const merge = SERVER_SRC.slice(SERVER_SRC.indexOf('async function _computeClusterSessions'));

  test('both session shapers carry `spawn` from the one helper', () => {
    // Fields were each forgotten in one of these two hand-shaped lists before (#298).
    expect(list.slice(0, list.indexOf('res.json(shaped)'))).toContain('spawn: spawnField(s.id)');
    expect(merge.slice(0, merge.indexOf('result.push(...localShaped)'))).toContain('spawn: spawnField(s.id)');
  });

  test('DELETE and the reaper end a session through the same function', () => {
    const del = SERVER_SRC.slice(SERVER_SRC.indexOf("app.delete('/api/sessions/:id'"));
    expect(del.slice(0, del.indexOf('\n});'))).toContain('killLocalSession(req.params.id)');
    const sweep = SERVER_SRC.slice(SERVER_SRC.indexOf('async function spawnReaperSweep'));
    expect(sweep.slice(0, sweep.indexOf('const _spawnReaperTicker'))).toContain('killLocalSession(s.id)');
  });

  test('the sweep is local-only: it never reaches into a peer', () => {
    const sweep = SERVER_SRC.slice(SERVER_SRC.indexOf('async function spawnReaperSweep'));
    const body = sweep.slice(0, sweep.indexOf('const _spawnReaperTicker'));
    for (const peer of ['clusterFetch', 'loadClusterTokens', 'getClusterConfig', '/cluster/']) {
      expect(body).not.toContain(peer);
    }
  });

  test('the test-only env knobs are read in ONE place, and only under WT_TEST', () => {
    const at = SERVER_SRC.indexOf('const SPAWN_TEST = process.env.WT_TEST ?');
    const end = SERVER_SRC.indexOf('const SPAWN_CLASSIFY_MS');
    expect(at).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(at);
    const block = SERVER_SRC.slice(at, end);
    // every read of either variable in the whole file sits inside that one block
    // (WT_SPAWN_WORKER is the unrelated, older "spawn the pty-worker" switch)
    const all = SERVER_SRC.match(/process\.env\.WT_SPAWN_(?!WORKER)[A-Z_]+/g) || [];
    const inBlock = block.match(/process\.env\.WT_SPAWN_(?!WORKER)[A-Z_]+/g) || [];
    expect(all.length).toBeGreaterThan(0);
    expect(inBlock).toEqual(all);
    expect(new Set(all)).toEqual(new Set(['process.env.WT_SPAWN_CLASSIFY_MS', 'process.env.WT_SPAWN_IDLE_MS']));
  });

  test('the knob is read live, by the documented name, with the library default', () => {
    expect(SERVER_SRC).toContain("liveConfig('spawnedSessionIdleCloseHours', spawnReaper.DEFAULT_IDLE_HOURS)");
  });

  test('every active-viewer transition feeds the clock', () => {
    const ws = SERVER_SRC.slice(SERVER_SRC.indexOf("app.ws('/ws/:id'"));
    // becoming active, leaving active (mode change), leaving active (close), legacy attach
    expect((ws.match(/noteSpawnViewed\(id\)/g) || []).length).toBe(4);
  });
});

// --- the real server -------------------------------------------------------------

const CLASSIFY_MS = Number(process.env.WT_SPAWN_CLASSIFY_MS) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** A viewer socket on /ws/:id. `mode`: 'active' | 'background' | null (say nothing). */
async function attach(cookie, id, mode) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  if (mode) ws.send(JSON.stringify({ mode, browserId: `reaper-${Math.random()}` }));
  await sleep(500); // the attach RPC, and the mode message queued behind it
  return {
    ws,
    close: () => new Promise((r) => { ws.once('close', r); try { ws.close(); } catch { r(); } }),
  };
}

test.describe('#351 against the real server', () => {
  test.skip(!CLASSIFY_MS, 'needs the suite server\'s shortened classify window (playwright.config.js)');
  test.setTimeout(60000);

  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string} */
  let cookie;
  /** @type {string[]} */
  let made = [];

  test.beforeAll(async () => { cookie = await rawCookie(); });
  test.beforeEach(async () => { ctx = await authCtx(); made = []; });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
  });

  async function create(name, extra = {}) {
    const r = await ctx.post('/api/sessions', { data: { name: `${name}-${Date.now()}`, ...extra } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    made.push(id);
    return id;
  }
  const rowOf = async (id) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
  const clusterRowOf = async (id) => (await (await ctx.get('/api/cluster/sessions')).json()).sessions.find((s) => s.id === id);
  const exists = async (id) => Boolean(await rowOf(id));
  /** Run the reaper now. `idleMs` is the test threshold; omit it for the real 6 hours. */
  const sweep = async (idleMs) => (await ctx.post('/api/test/spawn-reaper-sweep', { data: idleMs ? { idleMs } : {} })).json();
  const pastWindow = () => sleep(CLASSIFY_MS + 400);

  test('no viewer in the window -> agent-started; the sweep closes it only once it is idle long enough', async () => {
    const id = await create('rp-agent', { spawnedBy: `   a helper agent   ${'x'.repeat(200)}` });
    // Inside the window nothing is claimed yet.
    expect((await rowOf(id)).spawn).toMatchObject({ by: 'pending' });
    await pastWindow();

    const r = await rowOf(id);
    expect(r.spawn.by).toBe('agent');
    expect(r.spawn.spawnedBy).toHaveLength(120);
    expect(r.spawn.spawnedBy.startsWith('a helper agent')).toBe(true);
    expect(typeof r.spawn.createdAt).toBe('number');
    // ...on the cluster list too (the second shaper)
    expect((await clusterRowOf(id)).spawn).toMatchObject({ by: 'agent' });

    // The real threshold is 6 hours: a brand-new session is kept, and says why.
    const kept = await sweep();
    expect(kept.closed).not.toContain(id);
    expect(kept.kept[id]).toBe('recent');
    expect(await exists(id)).toBe(true);

    // Shortened to 1.5s it closes - once its last output is that old.
    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      closed = (await sweep(1500)).closed.includes(id);
      if (!closed) await sleep(500);
    }
    expect(closed).toBe(true);
    expect(await exists(id)).toBe(false);
    expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(404);
  });

  test('an ACTIVE viewer that stays past the window -> a person\'s session, never closed', async () => {
    const id = await create('rp-human-stays');
    const v = await attach(cookie, id, 'active'); // the mode message alone must classify it
    await pastWindow();
    expect((await rowOf(id)).spawn.by).toBe('human');
    await v.close();
    await sleep(1600);
    const s = await sweep(1500);
    expect(s.closed).not.toContain(id);
    expect(await exists(id)).toBe(true);
  });

  test('an ACTIVE viewer that looks and leaves inside the window -> a person\'s session too', async () => {
    const id = await create('rp-human-leaves');
    const v = await attach(cookie, id, 'active');
    await v.close(); // gone again: only the CLASSIFICATION is under test, not the viewer gate
    await pastWindow();

    expect((await rowOf(id)).spawn.by).toBe('human');
    expect((await clusterRowOf(id)).spawn.by).toBe('human');
    await sleep(1600);
    const s = await sweep(1500);
    expect(s.closed).not.toContain(id);
    expect(await exists(id)).toBe(true);
  });

  test('a BACKGROUND socket is not a viewer: it neither classifies a person nor holds the session open', async () => {
    const id = await create('rp-bg');
    const v = await attach(cookie, id, 'background');
    await pastWindow();
    expect((await rowOf(id)).spawn.by).toBe('agent');

    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      closed = (await sweep(1500)).closed.includes(id);
      if (!closed) await sleep(500);
    }
    expect(closed).toBe(true);
    expect(await exists(id)).toBe(false);
    await v.close().catch(() => {});
  });

  test('a viewer who is attached holds an agent-started session; once they leave, the clock starts from then', async () => {
    const id = await create('rp-watch');
    await pastWindow();
    expect((await rowOf(id)).spawn.by).toBe('agent');

    const v = await attach(cookie, id, 'active'); // a person opens it, late
    await sleep(1700);
    const held = await sweep(1500);
    expect(held.closed).not.toContain(id);
    expect(held.kept[id]).toBe('viewer');
    expect(await exists(id)).toBe(true);

    await v.close();
    await sleep(300);
    // They have only just left: viewed a moment ago, so not idle for 1.5s yet.
    const fresh = await sweep(60_000);
    expect(fresh.closed).not.toContain(id);
    expect(fresh.kept[id]).toBe('recent');

    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      closed = (await sweep(1500)).closed.includes(id);
      if (!closed) await sleep(500);
    }
    expect(closed).toBe(true);
  });

  test('a session that is running a command is not closed', async () => {
    const id = await create('rp-busy');
    await pastWindow();
    expect((await rowOf(id)).spawn.by).toBe('agent');
    // Output keeps it open: a shell printing every 300ms for a while. A background socket's
    // input is dropped by the server, so an ACTIVE one types the command and then hands the
    // session back (background), so no viewer is attached while the sweep decides.
    const typer = await attach(cookie, id, 'active');
    typer.ws.send('for i in $(seq 1 40); do echo tick$i; sleep 0.3; done\r');
    typer.ws.send(JSON.stringify({ mode: 'background' }));
    await sleep(1500);
    const s = await sweep(1000);
    expect(s.closed).not.toContain(id);
    expect(['recent', 'background-work']).toContain(s.kept[id]);
    expect(await exists(id)).toBe(true);
    await typer.close().catch(() => {});
  });
});
