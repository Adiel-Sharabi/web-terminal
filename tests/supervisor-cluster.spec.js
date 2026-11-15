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
async function startServer(dir, port, label, extraEnv = {}) {
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
    WT_PUSH_DEVICES_FILE: f('push-devices.json'),
    WT_SUPERVISOR_EVERY_MS: '1000', WT_SUPERVISOR_ORPHAN_CONFIRM_MS: String(CONFIRM_MS),
    // #467: quiet hours pinned off (a run at night must not hold pushes); a spec flips them.
    WT_QUIET_FORCE: '0',
    ...extraEnv,
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

// #467 - phase 2 across the same two-server rig: R1 wakes a session on the PEER through the
// peer's own gated prompt, once per wait; R4 pushes a wait on the owner from the authority,
// naming the peer; quiet hours hold both kinds of push and release ONE when they end.
test.describe.serial('#467 the supervisor wakes and reaches the owner across two servers', () => {
  test.setTimeout(120000);
  const TAG = '[web-terminal supervisor]';
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
  const portA = 18040 + Math.floor(Math.random() * 20);
  const portB = portA + 25;
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const tokA = crypto.randomBytes(32).toString('hex');
  const tokB = crypto.randomBytes(32).toString('hex');
  let dirA; let dirB; let A; let B; let a; let b;
  const sink = [];
  const drain = async () => { sink.push(...(await (await a.get('/api/push/test-sink')).json()).items); return sink; };
  const files = (dir, self, token, peerUrl, peerToken, peerName) => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: self === urlA ? 'alpha' : 'bravo', publicUrl: self,
      cluster: [{ name: 'alpha', url: urlA }, { name: 'bravo', url: urlB }],
      leases: { authority: 'alpha' }, checkIn: { typingQuietMin: 0.01 }, supervisor: {},
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [token]: { label: 'supervisor-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), JSON.stringify({ [peerUrl]: { token: peerToken, name: peerName, authenticated: Date.now() } }));
  };
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const hook = async (base, id, event, body = {}) => {
    const c = await pwRequest.newContext({ baseURL: base });
    const r = await c.post('/api/hook', { data: { hook_event_name: event, ...body }, headers: { 'X-WT-Hook-Token': hookToken(), 'X-WT-Session-ID': id } });
    await c.dispose();
    expect(r.status()).toBe(200);
  };
  const report = async (base, id, body) => {
    const c = await pwRequest.newContext({ baseURL: base });
    const r = await c.post(`/api/session/${id}/report`, { data: body, headers: { 'X-WT-Hook-Token': hookToken() } });
    const t = await r.text();
    await c.dispose();
    expect(r.status(), t).toBe(200);
  };
  /** An agent session on [ctx] that is ready, has run one turn reporting [wait], and is idle. */
  const turnWith = async (ctx, base, label, wait) => {
    const r = await ctx.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), agent: 'claude', autoCommand: LAUNCH } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    const row = async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
    await until(async () => (await row())?.agentReady === true, `${label} ready`);
    const conv = crypto.randomUUID();
    await hook(base, id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' });
    await report(base, id, { items: [{ ref: '#1', title: 'phase 2', state: 'in-progress' }], wait });
    await hook(base, id, 'Stop', { session_id: conv });
    await until(async () => (await row())?.status === 'idle', `${label} idle`);
    return id;
  };
  const supLog = (dir) => {
    const f = path.join(dir, 'handoffs', 'supervisor-log.jsonl');
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const ownerPushes = (id) => sink.filter((m) => m.data.kind === 'owner-wait' && m.data.sessionId === id);

  test.beforeAll(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wt467-A-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wt467-B-'));
    files(dirA, urlA, tokA, urlB, tokB, 'bravo');
    files(dirB, urlB, tokB, urlA, tokA, 'alpha');
    [A, B] = await Promise.all([
      startServer(dirA, portA, 'a2', { WT_FCM_TEST: '1', WT_PUSH_PROVIDER: 'fcm' }),
      startServer(dirB, portB, 'b2')]);
    a = await bearer(A.base, tokA);
    b = await bearer(B.base, tokB);
    const reg = await a.post('/api/push/devices', { data: { fcmToken: `fcm-467-${crypto.randomUUID()}`, deviceName: 'spec' } });
    expect(reg.ok(), await reg.text()).toBe(true);
  });
  test.afterAll(async () => {
    for (const c of [a, b]) { try { await c.dispose(); } catch { /* gone */ } }
    for (const s of [A, B]) { try { await s.stop(); } catch { /* gone */ } }
    for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  test('R1: a wait on the peer whose target resolves is woken with the fact, once', async () => {
    const at = new Date(Date.now() + 2000).toISOString();
    const id = await turnWith(b, B.base, 'sup-wake-b', { on: 'external', what: 'the timer', target: { kind: 'time', until: at } });
    const wake = await until(async () => supLog(dirA).find((l) => l.event === 'wake' && l.id === id), 'the wake', 40000);
    expect(wake).toMatchObject({ server: 'bravo', rule: 'R1' });
    expect(wake.text).toBe(`Your wait "the timer" changed: the time ${at} has passed. Carry on, or report a new wait.`);
    // Typed on B, through B's own gate.
    // The scrollback route answers JSON: read its text, never the escaped body (a `"` is `\"` there).
    await until(async () => (await (await b.get(`/api/sessions/${id}/scrollback`)).json()).data.includes(`${TAG} Your wait "the timer" changed`), 'the prompt on B');
    expect(supLog(dirB).some((l) => l.event === 'prompt-delivered' && l.id === id)).toBe(true);
    // Once: the same wait is never woken again.
    await sleep(4000);
    expect(supLog(dirA).filter((l) => l.event === 'wake' && l.id === id)).toHaveLength(1);
    const n = (await state()).sessions.find((x) => x.id === id);
    expect(n.waitState).toMatchObject({ state: 'resolved' });
    expect(n.supervisor[0]).toMatchObject({ rule: 'R1', outcome: 'delivered' });
    expect((await b.delete(`/api/sessions/${id}`)).status()).toBe(200);
  });

  test('R4: a wait on the owner pushes from the authority, naming the peer; quiet hours hold it and send ONE summary', async () => {
    await drain(); sink.length = 0;
    const id = await turnWith(b, B.base, 'sup-owner-b', { on: 'you', what: 'pick a name' });
    const push = await until(async () => { await drain(); return ownerPushes(id)[0]; }, 'the owner push', 30000);
    expect(push.data).toMatchObject({ serverName: 'bravo', deepLink: `${urlB}/app/${id}` });
    expect(push.android.priority).toBe('high');
    await sleep(3000);
    await drain();
    expect(ownerPushes(id)).toHaveLength(1); // no repeat by day before remindEveryMin

    // Quiet: a NEW wait on the owner is held, not pushed.
    expect((await a.post('/api/test/quiet', { data: { quiet: true } })).ok()).toBe(true);
    await report(B.base, id, { wait: { on: 'you', what: 'pick again' } });
    await sleep(4000);
    await drain();
    expect(ownerPushes(id)).toHaveLength(1);
    expect(supLog(dirA).some((l) => l.event === 'owner-summary')).toBe(false);
    // Quiet ends: ONE summary push.
    expect((await a.post('/api/test/quiet', { data: { quiet: false } })).ok()).toBe(true);
    await until(async () => { await drain(); return ownerPushes(id).length === 2; }, 'the summary push', 20000);
    expect(supLog(dirA).filter((l) => l.event === 'owner-summary')).toEqual([expect.objectContaining({ count: 1 })]);
    await sleep(3000);
    await drain();
    expect(ownerPushes(id)).toHaveLength(2);
    expect((await b.delete(`/api/sessions/${id}`)).status()).toBe(200);
  });

  test('R4 on the authority itself: a wait on the owner of one of ITS OWN sessions pushes too', async () => {
    // The supervisor reads its own server through the /api/sessions rows (sessionsListRows),
    // reason included; a slimmer local row once lacked it, so a local wait never pushed.
    await drain(); sink.length = 0;
    const id = await turnWith(a, A.base, 'sup-owner-a', { on: 'you', what: 'pick locally' });
    const push = await until(async () => { await drain(); return ownerPushes(id)[0]; }, 'the local owner push', 30000);
    expect(push.data).toMatchObject({ serverName: 'alpha' });
    expect((await a.delete(`/api/sessions/${id}`)).status()).toBe(200);
  });

  test('an approval push in quiet hours is held, and sent when they end only if it still waits', async () => {
    await drain(); sink.length = 0;
    const mk = async (label) => (await (await a.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label) } })).json()).id;
    const ask = (id) => hook(A.base, id, 'Notification', { message: 'Claude needs your permission to run a command' });
    const approvals = (id) => sink.filter((m) => m.data.kind === 'approval' && m.data.sessionId === id);
    const kept = await mk('sup-quiet-kept');
    const answered = await mk('sup-quiet-answered');
    expect((await a.post('/api/test/quiet', { data: { quiet: true } })).ok()).toBe(true);
    await ask(kept);
    await ask(answered);
    await until(async () => (await (await a.get(`/api/sessions/${kept}/attention`)).json()).kind === 'approval', 'the attention record');
    await sleep(2500);
    await drain();
    expect(approvals(kept)).toEqual([]);
    expect(approvals(answered)).toEqual([]);
    await hook(A.base, answered, 'UserPromptSubmit', { prompt: 'yes' }); // answered in the night
    expect((await a.post('/api/test/quiet', { data: { quiet: false } })).ok()).toBe(true);
    await until(async () => { await drain(); return approvals(kept).length === 1; }, 'the held approval', 20000);
    await sleep(2500);
    await drain();
    expect(approvals(kept)).toHaveLength(1);
    expect(approvals(answered)).toEqual([]);
    for (const id of [kept, answered]) await a.delete(`/api/sessions/${id}`);
  });
});
