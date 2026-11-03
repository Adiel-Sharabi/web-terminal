// @ts-check
// Cluster resource leases end to end (#412): two real servers - A, the authority, and B, a
// peer that forwards to it over the cluster's bearer tokens - each with its own config,
// tokens, worker, lease table and cleanup ledger. The suite's own server has no `leases`
// block, so these need servers of their own (the pattern of inbox-digest-config.spec.js).
//
// What "done" means in the issue, each a test below:
//   - two sessions on different machines asking for vm:X get one grant and one queued;
//   - killing the holder's session grants the waiter (at once, and within one sweep when
//     the exit was never heard);
//   - recorded pids are cleaned on release, unrelated ones are not;
//   - reserved resources, authority down (fail closed, holders keep running), auth.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd, authCtx } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const sleepers = [];
function sleeper() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  sleepers.push(p);
  return p;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

/** Boot one isolated server in [dir] on [port]. Files and tokens are set up by the caller. */
async function startServer(dir, port, label) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const suffix = crypto.randomUUID().slice(0, 8);
  const f = (name) => path.join(dir, name);
  const env = {
    ...process.env, WT_TEST: '1', WT_CONFIG_FILE: f('config.json'), WT_PORT: String(port), WT_HOST: '127.0.0.1',
    WT_USER: 'testuser', WT_PASS: 'testpass:colon',
    WT_SPAWN_WORKER: '1', WT_WORKER_DATA_DIR: dataDir, WT_WORKER_QUIET: '1', WT_WORKER_NO_DEFAULT: '1',
    WT_WORKER_PIPE: process.platform === 'win32' ? `\\\\.\\pipe\\wt-412-${label}-${suffix}` : `/tmp/wt-412-${label}-${suffix}.sock`,
    WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
    // Every state file of its own: never the suite server's, never production's.
    WT_API_TOKENS_FILE: f('api-tokens.json'), WT_CLUSTER_TOKENS_FILE: f('cluster-tokens.json'),
    WT_LEASES_FILE: f('leases.json'), WT_LEASE_RECORDS_FILE: f('lease-records.json'),
    WT_SESSION_BRIEFS_FILE: f('briefs.json'), WT_SPAWNED_SESSIONS_FILE: f('spawned.json'),
    WT_MAINTENANCE_FILE: f('maintenance.json'), WT_DEVICE_OPS_FILE: f('device-ops.jsonl'),
    WT_CLAUDE_METRICS_FILE: f('metrics.json'), WT_HANDOFF_DIR: f('handoffs'),
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    // The tree, by the pid this function recorded: the server owns a worker that outlives it.
    try { if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    try { proc.kill(); } catch { /* gone */ }
    await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(r, 3000); } });
  };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode !== null) break;
    try {
      const probe = await pwRequest.newContext({ baseURL: base });
      const r = await probe.get('/login', { timeout: 2000 });
      await probe.dispose();
      if (r.status() < 500) return { base, stop, log: () => out };
    } catch { /* not listening yet */ }
  }
  await stop();
  throw new Error(`isolated server ${label} never answered on ${base}:\n${out.slice(0, 2000)}`);
}

const bearer = (base, token) => pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

test.describe.serial('cluster resource leases across two servers (#412)', () => {
  test.setTimeout(120000);
  const portA = 17950 + Math.floor(Math.random() * 20);
  const portB = portA + 25;
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const tokA = crypto.randomBytes(32).toString('hex');
  const tokB = crypto.randomBytes(32).toString('hex');
  let dirA; let dirB; let scratch;
  let A; let B; let a; let b;
  const writeServerFiles = (dir, self, token, peerUrl, peerToken, peerName) => {
    const cluster = [{ name: 'alpha', url: urlA }, { name: 'bravo', url: urlB }];
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: self === urlA ? 'alpha' : 'bravo', publicUrl: self, cluster,
      leases: {
        authority: 'alpha',
        resources: { 'vm:Sanity': { reservedFor: 'release' }, 'vm:ci-vm-1': { neverLease: true } },
        cleanupRoots: [scratch],
      },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [token]: { label: 'lease-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), JSON.stringify({ [peerUrl]: { token: peerToken, name: peerName, authenticated: Date.now() } }));
  };

  test.beforeAll(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-A-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-B-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-scratch-'));
    writeServerFiles(dirA, urlA, tokA, urlB, tokB, 'bravo');
    writeServerFiles(dirB, urlB, tokB, urlA, tokA, 'alpha');
    [A, B] = await Promise.all([startServer(dirA, portA, 'a'), startServer(dirB, portB, 'b')]);
    a = await bearer(A.base, tokA);
    b = await bearer(B.base, tokB);
  });
  test.afterAll(async () => {
    for (const p of sleepers) { try { p.kill(); } catch { /* gone */ } }
    for (const c of [a, b]) { try { await c.dispose(); } catch { /* gone */ } }
    for (const s of [A, B]) { try { await s.stop(); } catch { /* gone */ } }
    for (const d of [dirA, dirB, scratch]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  const session = async (ctx, label) => {
    const r = await ctx.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), autoCommand: '' } });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).id;
  };
  const leaseOf = async (ctx, id) => { const r = await ctx.get(`/api/leases/${id}`); return { status: r.status(), body: await r.json() }; };

  test('two sessions on two machines ask for vm:X: one grant, one queued; killing the holder grants the waiter', async () => {
    const sB = await session(b, 'lease-holder-b');
    const sA = await session(a, 'lease-waiter-a');
    const rb = await b.post('/api/leases', { data: { resource: 'vm:X', holderSessionId: sB, meta: { wi: 1 } } });
    expect(rb.status(), await rb.text()).toBe(200);
    const held = await rb.json();
    expect(held).toMatchObject({ granted: true, lease: { state: 'held', position: 0, holder: { server: 'bravo', sessionId: sB }, heartbeatSec: 0 } });
    const ra = await a.post('/api/leases', { data: { resource: 'vm:X', holderSessionId: sA } });
    const queued = await ra.json();
    expect(queued).toMatchObject({ granted: false, lease: { state: 'queued', position: 1, holder: { server: 'alpha', sessionId: sA } } });
    // The dashboard, read through the PEER (forwarded): who holds, who waits.
    const list = await (await b.get('/api/leases')).json();
    const row = list.resources.find((x) => x.resource === 'vm:X');
    expect(list.authority).toBe('alpha');
    expect(row.holder).toMatchObject({ id: held.lease.id, holder: { server: 'bravo' } });
    expect(row.queue.map((q) => q.id)).toEqual([queued.lease.id]);
    // Kill the holder's session on B: B tells A, A grants the waiter.
    expect((await b.delete(`/api/sessions/${sB}`)).ok()).toBe(true);
    const granted = await until(async () => { const l = await leaseOf(a, queued.lease.id); return l.body.lease && l.body.lease.state === 'held' ? l : null; });
    expect(granted && granted.body.lease).toMatchObject({ state: 'held', position: 0 });
    expect((await leaseOf(a, held.lease.id)).body).toMatchObject({ released: { why: 'holder-ended' } });
    expect((await a.delete(`/api/leases/${queued.lease.id}`, { data: { holderSessionId: sA } })).ok()).toBe(true);
    await a.delete(`/api/sessions/${sA}`);
  });

  test('only the holder session may release or heartbeat a lease; every other caller gets 403 and the lease stays', async () => {
    const sB = await session(b, 'lease-owner-b');
    const sB2 = await session(b, 'lease-bystander-b');
    const lease = (await (await b.post('/api/leases', { data: { resource: 'vm:Owned', holderSessionId: sB } })).json()).lease;
    expect(lease.state).toBe('held');
    const refusals = [
      ['another session on the holder\'s machine', () => b.delete(`/api/leases/${lease.id}`, { data: { holderSessionId: sB2 } })],
      ['the holder\'s machine, no session named', () => b.delete(`/api/leases/${lease.id}`)],
      ['the authority\'s machine, the holder\'s session id', () => a.delete(`/api/leases/${lease.id}`, { data: { holderSessionId: sB } })],
      ['a heartbeat from another session', () => b.post(`/api/leases/${lease.id}/heartbeat`, { data: { holderSessionId: sB2 } })],
      ['a heartbeat from the authority\'s machine', () => a.post(`/api/leases/${lease.id}/heartbeat`, { data: {} })],
    ];
    for (const [who, send] of refusals) {
      const r = await send();
      expect(r.status(), `${who}: ${await r.text()}`).toBe(403);
      expect((await r.json()).error).toMatch(/only its holder/);
    }
    expect((await leaseOf(a, lease.id)).body.lease).toMatchObject({ state: 'held' });
    // A lease taken on the authority with no session is the authority machine's: a peer cannot end it.
    const bare = (await (await a.post('/api/leases', { data: { resource: 'vm:Bare', heartbeatSec: 10 } })).json()).lease;
    expect((await b.delete(`/api/leases/${bare.id}`)).status()).toBe(403);
    expect((await a.delete(`/api/leases/${bare.id}`)).ok()).toBe(true);
    // The holder, through its own server.
    expect((await b.post(`/api/leases/${lease.id}/heartbeat`, { data: { holderSessionId: sB } })).ok()).toBe(true);
    expect((await b.delete(`/api/leases/${lease.id}`, { data: { holderSessionId: sB } })).ok()).toBe(true);
    expect((await leaseOf(a, lease.id)).body).toMatchObject({ released: { why: 'released' } });
    await b.delete(`/api/sessions/${sB}`);
    await b.delete(`/api/sessions/${sB2}`);
  });

  test('a holder whose session is gone from its machine is released by ONE sweep, even when its exit was never heard', async () => {
    // A session id B has never had: nothing will ever announce its exit.
    const ghost = crypto.randomUUID();
    const r1 = await (await b.post('/api/leases', { data: { resource: 'vm:Y', holderSessionId: ghost } })).json();
    expect(r1.lease.state).toBe('held');
    const r2 = await (await a.post('/api/leases', { data: { resource: 'vm:Y', heartbeatSec: 10 } })).json();
    expect(r2.lease.state).toBe('queued');
    expect((await a.post('/api/test/leases-sweep')).ok()).toBe(true);
    expect((await leaseOf(a, r1.lease.id)).body).toMatchObject({ released: { why: 'holder-ended' } });
    expect((await leaseOf(a, r2.lease.id)).body.lease).toMatchObject({ state: 'held' });
    await a.delete(`/api/leases/${r2.lease.id}`);
  });

  test('release cleans up what the lease recorded on its machine - and nothing else', async () => {
    const mine = sleeper();
    const other = sleeper();
    const dir = path.join(scratch, 'vm-work');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-keep-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'precious');
    fs.symlinkSync(outside, path.join(dir, 'sub', 'node_modules'), 'junction');
    await new Promise((r) => setTimeout(r, 300));
    const lease = (await (await b.post('/api/leases', { data: { resource: 'vm:Z' } })).json()).lease;
    expect(lease.state).toBe('held');
    const rec = await b.post(`/api/leases/${lease.id}/record`, { data: { pids: [mine.pid], paths: [dir] } });
    expect(rec.status(), await rec.text()).toBe(200);
    expect((await rec.json()).items.map((x) => x.kind)).toEqual(['pid', 'path']);
    // A path outside the cleanup roots, or this server's own pid, is refused and records nothing.
    const refused = await b.post(`/api/leases/${lease.id}/record`, { data: { paths: [outside] } });
    expect(refused.status()).toBe(400);
    // Release through B; A notifies B, B confirms with A and cleans up.
    expect((await b.delete(`/api/leases/${lease.id}`)).ok()).toBe(true);
    expect(await until(async () => !alive(mine.pid) && !fs.existsSync(dir))).toBe(true);
    expect(alive(other.pid)).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious');
    expect((await (await b.get('/api/leases/records')).json()).records).toEqual({});
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('reserved resources: never-lease is refused to all, a reserved one to every other role', async () => {
    expect((await b.post('/api/leases', { data: { resource: 'vm:ci-vm-1', role: 'release' } })).status()).toBe(403);
    const noRole = await b.post('/api/leases', { data: { resource: 'vm:Sanity' } });
    expect(noRole.status()).toBe(403);
    expect((await noRole.json()).error).toMatch(/reserved for the "release" role/);
    expect((await b.post('/api/leases', { data: { resource: 'vm:Sanity', role: 'test' } })).status()).toBe(403);
    const ok = await (await b.post('/api/leases', { data: { resource: 'vm:Sanity', role: 'release' } })).json();
    expect(ok.lease.state).toBe('held');
    await b.delete(`/api/leases/${ok.lease.id}`);
    // Junk ids and bodies are refused before anything is looked up.
    expect((await b.post('/api/leases', { data: { resource: 'vm:../../x' } })).status()).toBe(400);
    expect((await b.get('/api/leases/not-a-lease')).status()).toBe(400);
  });

  test('admission: a request needing more than this machine has is refused here, before the authority', async () => {
    const r = await b.post('/api/leases', { data: { resource: 'vm:Q', needs: { memGB: 4000 } } });
    expect(r.status()).toBe(409);
    expect((await r.json()).reasons.join(' ')).toMatch(/memory/);
    expect((await b.get('/api/admission?memGB=4000')).status()).toBe(409);
    expect((await b.get('/api/admission?memGB=lots')).status()).toBe(400);
  });

  test('every lease route is behind auth', async () => {
    const anon = await pwRequest.newContext({ baseURL: B.base });
    const id = crypto.randomUUID();
    for (const [m, p] of [['get', '/api/leases'], ['post', '/api/leases'], ['get', `/api/leases/${id}`], ['post', `/api/leases/${id}/heartbeat`],
      ['delete', `/api/leases/${id}`], ['post', '/api/leases/holder-ended'], ['get', '/api/leases/local-sessions'], ['get', '/api/leases/records'],
      ['post', '/api/leases/released-notice'], ['post', `/api/leases/${id}/record`], ['get', '/api/admission']]) {
      const r = await anon[m](p, m === 'get' || m === 'delete' ? {} : { data: {} });
      expect(r.status(), `${m} ${p}`).toBe(401);
    }
    await anon.dispose();
  });

  test('scripts/wt-lease.js: acquire, queue, list and release against this machine\'s own server', async () => {
    const cli = (...argv) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wt-lease.js'), ...argv], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...process.env, WT_API_TOKENS_FILE: path.join(dirB, 'api-tokens.json'), WT_SESSION_PORT: String(portB), WT_SESSION_ID: '' },
    });
    const first = cli('acquire', 'build:bravo', '--no-session', '--meta', '{"wi":7}');
    expect(first.status, first.stderr).toBe(0);
    const id = first.stdout.trim().split(/\s+/)[0];
    expect(first.stdout).toMatch(/build:bravo\s+HELD/);
    const second = cli('acquire', 'build:bravo', '--no-session');
    expect(second.status).toBe(1);
    expect(second.stdout).toMatch(/QUEUED #1/);
    // Taken and no --wait: it says so and leaves the queue, so nobody is granted it later.
    expect(second.stderr).toMatch(/left the queue/);
    const row = (await (await b.get('/api/leases')).json()).resources.find((x) => x.resource === 'build:bravo');
    expect(row.queue).toEqual([]);
    // acquire/record name this machine; --server would name another's pids.
    expect(cli('record', id, '--pid', '1234', '--server', 'alpha').status).toBe(2);
    const list = cli('list');
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/lease authority: alpha/);
    // Without a session and without --no-session it refuses rather than make a lease nobody holds.
    expect(cli('acquire', 'build:bravo').status).toBe(2);
    // A session that is not the holder is refused, and says why.
    const notMine = cli('release', id, '--session', crypto.randomUUID());
    expect(notMine.status).toBe(2);
    expect(notMine.stderr).toMatch(/only its holder/);
    expect(cli('release', id).status).toBe(0);
    expect((await leaseOf(b, id)).status).toBe(404);
  });

  test('authority down: no new lease, holders keep running; the authority comes back with its table', async () => {
    const proc = sleeper();
    const lease = (await (await b.post('/api/leases', { data: { resource: 'vm:W', heartbeatSec: 10 } })).json()).lease;
    expect(lease.state).toBe('held');
    expect((await b.post(`/api/leases/${lease.id}/record`, { data: { pids: [proc.pid] } })).ok()).toBe(true);
    await A.stop();
    const refused = await b.post('/api/leases', { data: { resource: 'vm:V' } });
    expect(refused.status()).toBe(503);
    expect((await refused.json()).error).toMatch(/unreachable/);
    expect((await b.post(`/api/leases/${lease.id}/heartbeat`, { data: {} })).status()).toBe(503);
    // B's own sweep cannot ask the authority, so it cleans up nothing.
    expect((await b.post('/api/test/leases-sweep')).ok()).toBe(true);
    expect(alive(proc.pid)).toBe(true);
    expect(Object.keys((await (await b.get('/api/leases/records')).json()).records)).toEqual([lease.id]);
    // The authority returns (same files): the lease is still there, its heartbeat clock restarted.
    A = await startServer(dirA, portA, 'a2');
    await a.dispose();
    a = await bearer(A.base, tokA);
    expect((await a.post('/api/test/leases-sweep')).ok()).toBe(true);
    expect((await leaseOf(b, lease.id)).body.lease).toMatchObject({ state: 'held' });
    expect((await b.post(`/api/leases/${lease.id}/heartbeat`, { data: {} })).ok()).toBe(true);
    await b.delete(`/api/leases/${lease.id}`);
    expect(await until(async () => !alive(proc.pid))).toBe(true);
  });
});

test.describe('a server with no lease authority configured (#412)', () => {
  test('refuses every lease call (fail closed) and says how to configure one', async () => {
    const ctx = await authCtx();
    const r = await ctx.post('/api/leases', { data: { resource: 'vm:X' } });
    expect(r.status()).toBe(503);
    expect((await r.json()).error).toMatch(/leases\.authority/);
    expect((await ctx.get('/api/leases')).status()).toBe(503);
    await ctx.dispose();
  });
});
