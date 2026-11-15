// @ts-check
// #466 - the supervisor's cluster work graph end to end: two real servers, A (the lease
// authority, so the supervisor runs there) and B (a peer), each with its own config, tokens,
// worker and journal. The suite's own server is no authority, so these need servers of their
// own (the pattern of lease-routes.spec.js). The orphan rule's clock is shortened by the
// WT_TEST-only seams WT_SUPERVISOR_EVERY_MS / WT_SUPERVISOR_ORPHAN_CONFIRM_MS.
//
//   - A's graph holds both servers' sessions, a child on B under its lead on A, and B's journal;
//   - B is no authority: it says where the authority is;
//   - the lead closes: the child is a suspect, then an orphan only after the confirm time,
//     the lead's close is in the history with why, and the verdict is logged;
//   - B stops answering: a child on A whose lead lives on B is "unknown", never an orphan.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const CONFIRM_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
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
    WT_WORKER_PIPE: process.platform === 'win32' ? `\\\\.\\pipe\\wt-466-${label}-${suffix}` : `/tmp/wt-466-${label}-${suffix}.sock`,
    WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
    // Every state file of its own: never the suite server's, never production's.
    WT_API_TOKENS_FILE: f('api-tokens.json'), WT_CLUSTER_TOKENS_FILE: f('cluster-tokens.json'),
    WT_LEASES_FILE: f('leases.json'), WT_LEASE_RECORDS_FILE: f('lease-records.json'),
    WT_SESSION_BRIEFS_FILE: f('briefs.json'), WT_SPAWNED_SESSIONS_FILE: f('spawned.json'),
    WT_MAINTENANCE_FILE: f('maintenance.json'), WT_DEVICE_OPS_FILE: f('device-ops.jsonl'),
    WT_CLAUDE_METRICS_FILE: f('metrics.json'), WT_HANDOFF_DIR: f('handoffs'),
    WT_WORK_ITEMS_LOG_FILE: f('work-items.jsonl'), WT_SESSIONS_JOURNAL_FILE: f('sessions-journal.jsonl'),
    WT_SUPERVISOR_EVERY_MS: '1000', WT_SUPERVISOR_ORPHAN_CONFIRM_MS: String(CONFIRM_MS),
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
    await sleep(200);
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

test.describe.serial('#466 the supervisor across two servers', () => {
  test.setTimeout(120000);
  const portA = 17990 + Math.floor(Math.random() * 20);
  const portB = portA + 25;
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const tokA = crypto.randomBytes(32).toString('hex');
  const tokB = crypto.randomBytes(32).toString('hex');
  let dirA; let dirB;
  let A; let B; let a; let b;
  const writeServerFiles = (dir, self, token, peerUrl, peerToken, peerName) => {
    const cluster = [{ name: 'alpha', url: urlA }, { name: 'bravo', url: urlB }, { name: 'macbook', url: 'http://127.0.0.1:1' }];
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: self === urlA ? 'alpha' : 'bravo', publicUrl: self, cluster,
      leases: { authority: 'alpha' },
      // Out of scope: never polled, so its silence does not make every verdict "unknown".
      supervisor: { exclude: ['MacBook'] },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [token]: { label: 'supervisor-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), JSON.stringify({ [peerUrl]: { token: peerToken, name: peerName, authenticated: Date.now() } }));
  };
  const session = async (ctx, label, extra = {}) => {
    const r = await ctx.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), autoCommand: '', ...extra } });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).id;
  };
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const node = (st, id) => (st.sessions || []).find((n) => n.id === id);
  const supLog = () => {
    const f = path.join(dirA, 'handoffs', 'supervisor-log.jsonl');
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  test.beforeAll(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wt466-A-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wt466-B-'));
    writeServerFiles(dirA, urlA, tokA, urlB, tokB, 'bravo');
    writeServerFiles(dirB, urlB, tokB, urlA, tokA, 'alpha');
    [A, B] = await Promise.all([startServer(dirA, portA, 'a'), startServer(dirB, portB, 'b')]);
    a = await bearer(A.base, tokA);
    b = await bearer(B.base, tokB);
  });
  test.afterAll(async () => {
    for (const c of [a, b]) { try { await c.dispose(); } catch { /* gone */ } }
    for (const s of [A, B]) { try { await s.stop(); } catch { /* gone */ } }
    for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  test('one graph of both servers; the lead closes and its child becomes an orphan only after the confirm time', async () => {
    const lead = await session(a, 'sup-lead-a', { goal: 'lead the work' });
    const kid = await session(b, 'sup-child-b', { parentId: lead, goal: 'do one part', spawnedBy: 'lead' });
    // B is not the authority, and says which server is.
    expect(await (await b.get('/api/supervisor/state')).json()).toMatchObject({ role: 'peer', authority: { name: 'alpha' } });

    const st = await until(async () => { const s = await state(); return node(s, kid) && node(s, lead) ? s : null; }, 'both sessions in the graph');
    expect(st).toMatchObject({ role: 'authority', complete: true });
    expect(st.servers.map((s) => s.name).sort()).toEqual(['alpha', 'bravo']); // the excluded one is not polled
    expect(node(st, kid)).toMatchObject({ server: 'bravo', parentId: lead, leadId: lead, goal: 'do one part', orphan: null });
    expect(node(st, lead)).toMatchObject({ server: 'alpha', children: [kid], goal: 'lead the work' });
    // B's journal reached A: the child's open, with who asked for it.
    await until(async () => node(await state(), kid)?.journal?.via === 'api', "the child's journal entry");
    expect(node(await state(), kid).journal).toMatchObject({ spawnedBy: 'lead' });

    const closedAt = Date.now();
    expect((await a.delete(`/api/sessions/${lead}`)).status()).toBe(200);
    const suspect = await until(async () => { const n = node(await state(), kid); return n && n.orphan ? n.orphan : null; }, 'a verdict on the child');
    expect(suspect).toMatchObject({ state: 'suspect', parentId: lead });
    expect((await state()).orphans).toEqual([]);
    const orphan = await until(async () => { const n = node(await state(), kid); return n && n.orphan && n.orphan.state === 'orphan' ? n.orphan : null; }, 'the orphan verdict', 30000);
    // Confirmed no sooner than the confirm time after the first sighting.
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(CONFIRM_MS);
    expect(orphan.since).toBeGreaterThanOrEqual(closedAt);
    const st2 = await state();
    expect(st2.orphans).toEqual([kid]);
    expect(st2.history.find((e) => e.id === lead)).toMatchObject({ machine: 'alpha', why: 'closed', goal: 'lead the work' });
    expect(supLog().filter((l) => l.event === 'orphan' && l.id === kid).map((l) => l.state)).toEqual(['suspect', 'orphan']);
    // Read-only: the orphan was not touched.
    expect((await b.get('/api/sessions')).ok()).toBe(true);
    expect((await (await b.get('/api/sessions')).json()).some((s) => s.id === kid)).toBe(true);
  });

  test('a child whose lead was never seen in scope (an excluded server) is "unknown", never an orphan', async () => {
    const kid = await session(a, 'sup-child-of-excluded', { parentId: crypto.randomUUID() });
    await until(async () => node(await state(), kid)?.orphan, 'a verdict on the child');
    await sleep(CONFIRM_MS + 3000);
    const st = await state();
    expect(st.complete).toBe(true);
    expect(node(st, kid).orphan).toMatchObject({ state: 'unknown', why: 'lead-never-seen' });
    expect(st.orphans).not.toContain(kid);
    expect((await a.delete(`/api/sessions/${kid}`)).status()).toBe(200);
  });

  test('a server that stops answering makes its sessions\' children "unknown", never orphans', async () => {
    const lead = await session(b, 'sup-lead-b');
    const kid = await session(a, 'sup-child-a', { parentId: lead });
    await until(async () => node(await state(), kid)?.leadId === lead, 'the child under its lead');
    await B.stop();
    const unknown = await until(async () => { const s = await state(); return s.complete === false && node(s, kid)?.orphan ? s : null; }, 'an incomplete scan');
    expect(node(unknown, kid).orphan).toMatchObject({ state: 'unknown', parentId: lead });
    expect(unknown.servers.find((s) => s.name === 'bravo')).toMatchObject({ ok: false });
    // Well past the confirm time: still not an orphan.
    await sleep(CONFIRM_MS + 3000);
    const later = await state();
    expect(node(later, kid).orphan.state).toBe('unknown');
    expect(later.orphans).not.toContain(kid);
    expect(supLog().some((l) => l.event === 'server' && l.server === 'bravo' && l.ok === false)).toBe(true);
  });
});
