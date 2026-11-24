// @ts-check
// #525 - the dispatcher keeps its context short, end to end on one isolated server that is its
// own lease authority. Past its own (low) context point, idle and with NO case in hand, the
// server closes it, and the next case starts a fresh one through dispatcherStart: its rules
// rewritten, the configured model, the waiting case on its command line, handed over once.
// While a case is in hand it is left alone, and the generic #393 auto hand-off never takes it
// (a hand-off run that failed or was kept would leave a dispatcher nothing can type into).
// The rules are pinned in supervisor-525.spec.js. The "agent" is the printf launch the other
// supervisor specs use; hooks, the status line and the agent's posts go through the routes
// Claude itself uses.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');
const { ROOT, sleep, until, startServer, bearer } = require('./supervisor-rig');

test.describe.serial('#525 the dispatcher is replaced by a fresh one between cases', () => {
  test.setTimeout(180000);
  const TAG = '[web-terminal supervisor]';
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; ./claude";
  const port = 18140 + Math.floor(Math.random() * 40);
  const url = `http://127.0.0.1:${port}`;
  const tok = crypto.randomBytes(32).toString('hex');
  let dir; let S; let a;
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const post = async (route, data, headers = {}) => {
    const c = await pwRequest.newContext({ baseURL: url });
    const r = await c.post(route, { data, headers: { 'X-WT-Hook-Token': hookToken(), ...headers } });
    const t = await r.text();
    await c.dispose();
    expect(r.status(), t).toBe(200);
  };
  const rows = async () => (await (await a.get('/api/sessions')).json());
  const rowOf = async (id) => (await rows()).find((s) => s.id === id);
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const jsonl = (name) => { const f = path.join(dir, 'handoffs', name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const supLog = () => jsonl('supervisor-log.jsonl');
  const supervise = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wt-supervise.js'), ...args], {
    env: { ...process.env, WT_SESSION_PORT: String(port), WT_API_TOKENS_FILE: path.join(dir, 'api-tokens.json') }, encoding: 'utf8', windowsHide: true });
  /** One finished turn of [id] reporting [wait]; [pct] of a 1M window in context when given. */
  const turn = async (id, wait, pct = null) => {
    const conv = crypto.randomUUID();
    await post('/api/hook', { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'work' }, { 'X-WT-Session-ID': id });
    await post(`/api/session/${id}/report`, { items: [], headline: 'cases', wait });
    await post('/api/hook', { hook_event_name: 'Stop', session_id: conv }, { 'X-WT-Session-ID': id });
    if (pct !== null) {
      const st = await a.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: pct } } });
      expect(st.ok(), await st.text()).toBe(true);
    }
    await until(async () => (await rowOf(id))?.status === 'idle', `${id} idle`);
  };
  /** A worker session whose wait is past its checkBy: the rules open an R3 case on it. */
  const stuckWorker = async (label) => {
    const r = await a.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), agent: 'claude', autoCommand: LAUNCH } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    await until(async () => (await rowOf(id))?.agentReady === true, `${label} ready`);
    await turn(id, { on: 'self', what: 'the build', checkBy: 1 });
    return id;
  };
  const openCase = async (sessionId) => until(async () => (await state()).cases.find((c) => c.sessionId === sessionId && !c.resolvedAt), `a case on ${sessionId}`);

  test.beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt525-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'alpha', publicUrl: url, cluster: [{ name: 'alpha', url }], leases: { authority: 'alpha' },
      checkIn: { typingQuietMin: 0.01 },
      // The hand-off gates on a short clock (the dispatcher's replacement reads the same ones).
      handoff: { idleMin: 0.001, autoEveryMs: 300 },
      supervisor: { dispatcher: { handoffTokens: 50000 } },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [tok]: { label: 'dispatcher-525', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), '{}');
    S = await startServer(dir, port, 'd525', { WT_SUPERVISOR_DISPATCHER_CMD: LAUNCH, WT_SUPERVISOR_MINUTE_MS: '300' });
    a = await bearer(S.base, tok);
  });
  test.afterAll(async () => {
    try { await a.dispose(); } catch { /* gone */ }
    try { await S.stop(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  let disp; let caseId; let fresh;
  test('with a case in hand it stays, and the generic auto hand-off never takes it', async () => {
    const W = await stuckWorker('w525');
    caseId = (await openCase(W)).id;
    disp = (await until(async () => { const s = await state(); return s.dispatcher && s.dispatcher.id ? s : null; }, 'the dispatcher')).dispatcher.id;
    // Its first turn ends at 600k of context, reporting a third-party wait: the generic rule
    // offers the hand-off on its row, and its own point (50k) is long past.
    await turn(disp, { on: 'external', what: 'the next case' }, 60);
    const row = await until(async () => { const r = await rowOf(disp); return r?.handoff?.ctxTokens === 600000 ? r : null; }, 'its context on the row');
    expect(row.role).toBe('supervisor');
    // It was launched on Sonnet (the seam's command gets the model as a configured one does).
    expect(row.autoCommand).toMatch(/\.\/claude --model sonnet "/);
    expect(row.handoff).toMatchObject({ suggest: true, run: null });
    await sleep(3000); // several hand-off scans and supervisor scans
    const now = await rowOf(disp);
    expect(now).toBeTruthy(); // not closed: the case is in its hand
    expect(now.handoff.run).toBeNull(); // and no #393 run started on it
    expect(supLog().some((e) => e.event === 'dispatcher-recycle')).toBe(false);
    // Nor can a person start a #393 run on it.
    const press = await a.post(`/api/sessions/${disp}/handoff`, { data: { force: true } });
    expect(press.status()).toBe(400);
    expect((await press.json()).why).toBe('dispatcher');
  });

  test('with nothing in hand it is closed, and a fresh dispatcher starts at once: its rules rewritten, the configured model', async () => {
    // The owner changes the dispatcher's model now (the live config is re-read within 5 s), and
    // its standing rules on disk are stale: the fresh one must get both. The generic hand-off
    // switch is off: it does not lift the dispatcher's context cap.
    const cfgFile = path.join(dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, handoff: { ...cfg.handoff, auto: false }, supervisor: { dispatcher: { handoffTokens: 50000, model: 'haiku' } } }));
    fs.writeFileSync(path.join(dir, 'handoffs', 'supervisor', 'CLAUDE.md'), 'stale rules' + String.fromCharCode(10));
    await sleep(6000);
    const done = supervise('resolve', caseId, 'coached it');
    expect(done.status, done.stdout + done.stderr).toBe(0);
    await until(async () => !(await rowOf(disp)), 'the dispatcher closed', 20000);
    expect(supLog().find((e) => e.event === 'dispatcher-recycle')).toMatchObject({ id: disp, ctxTokens: 600000, at: 50000 });
    // Closed by the server, as a close (never read as a crash).
    await until(async () => jsonl('../sessions-journal.jsonl').find((e) => e.id === disp && e.event === 'closed'), 'its journal close');
    expect(jsonl('../sessions-journal.jsonl').find((e) => e.id === disp && e.event === 'closed').why).toBe('closed');
    fresh = (await until(async () => { const st = await state(); return st.dispatcher && st.dispatcher.id && st.dispatcher.id !== disp ? st : null; }, 'a fresh dispatcher')).dispatcher.id;
    const row = await until(() => rowOf(fresh), 'the fresh dispatcher row');
    expect(row.role).toBe('supervisor');
    expect(row.name).toBe('web-terminal supervisor');
    expect(row.autoCommand).toMatch(/\.\/claude --model haiku "/);
    expect(row.autoCommand).toContain(`"${TAG} You are the Supervisor's dispatcher.`);
    const rules = fs.readFileSync(path.join(dir, 'handoffs', 'supervisor', 'CLAUDE.md'), 'utf8');
    expect(rules).toContain('scripts/wt-supervise.js');
    expect(rules).toContain('the server closes you between cases');
    expect(supLog().filter((e) => e.event === 'dispatcher-start').pop()).toMatchObject({ id: fresh, model: 'haiku' });
  });

  test('the next case is handed to the fresh dispatcher, once', async () => {
    await turn(fresh, { on: 'external', what: 'the next case' });
    const W2 = await stuckWorker('w525b');
    const c2 = (await openCase(W2)).id;
    await until(async () => (await state()).cases.find((x) => x.id === c2).deliveredAt, 'the case handed to it');
    await sleep(2000);
    expect(jsonl('supervisor-cases.jsonl').filter((e) => e.event === 'delivered' && e.caseId === c2)).toHaveLength(1);
    expect(supLog().find((e) => e.event === 'case-delivered' && e.caseId === c2)).toMatchObject({ to: fresh });
    expect((await state()).cases.find((x) => x.id === c2)).toMatchObject({ escalated: null, resolvedAt: null });
  });
});
