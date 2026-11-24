// @ts-check
// #468 - supervisor phase 3 end to end, on one isolated server that is its own lease
// authority: a wait past its checkBy opens an R3 case; the server starts its dispatcher
// session and types the case into it; the dispatcher's verbs type through the gated prompt;
// a text asking for something only the owner decides becomes a card, typed only on Approve;
// a class in recommend mode makes cards too; a paused dispatcher sends cases to the owner
// (a push); a case whose trigger moved on is retired. The clock is shortened by WT_TEST
// seams (WT_SUPERVISOR_EVERY_MS, WT_SUPERVISOR_MINUTE_MS); the dispatcher runs the same
// printf "agent" the other supervisor specs use, never a real claude.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');
const { ROOT, sleep, until, startServer, bearer } = require('./supervisor-rig');

test.describe.serial('#468 the dispatcher takes the cases the rules cannot settle', () => {
  test.setTimeout(120000);
  const TAG = '[web-terminal supervisor]';
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
  const port = 18100 + Math.floor(Math.random() * 40);
  const url = `http://127.0.0.1:${port}`;
  const tok = crypto.randomBytes(32).toString('hex');
  let dir; let S; let a;
  const sink = [];
  const drain = async () => { sink.push(...(await (await a.get('/api/push/test-sink')).json()).items); return sink; };
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const post = async (route, data, headers = {}) => {
    const c = await pwRequest.newContext({ baseURL: url });
    const r = await c.post(route, { data, headers: { 'X-WT-Hook-Token': hookToken(), ...headers } });
    const t = await r.text();
    await c.dispose();
    expect(r.status(), t).toBe(200);
  };
  const rows = async () => (await (await a.get('/api/sessions')).json());
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const screen = async (id) => (await (await a.get(`/api/sessions/${id}/scrollback`)).json()).data || '';
  /** An agent session that ran one turn reporting [wait], and is idle again. */
  const turnWith = async (label, wait) => {
    const r = await a.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), agent: 'claude', autoCommand: LAUNCH } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    await until(async () => (await rows()).find((s) => s.id === id)?.agentReady === true, `${label} ready`);
    await report(id, wait);
    return id;
  };
  const report = async (id, wait) => {
    const conv = crypto.randomUUID();
    await post('/api/hook', { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'work' }, { 'X-WT-Session-ID': id });
    await post(`/api/session/${id}/report`, { items: [{ ref: '#1', title: 'phase 3', state: 'in-progress' }], wait });
    await post('/api/hook', { hook_event_name: 'Stop', session_id: conv }, { 'X-WT-Session-ID': id });
    await until(async () => (await rows()).find((s) => s.id === id)?.status === 'idle', `${id} idle`);
  };
  const caseOf = async (id) => (await state()).cases.find((c) => c.sessionId === id && !c.resolvedAt);

  test.beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt468-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'alpha', publicUrl: url, cluster: [{ name: 'alpha', url }], leases: { authority: 'alpha' },
      checkIn: { typingQuietMin: 0.01 }, supervisor: {},
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [tok]: { label: 'dispatcher-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), '{}');
    S = await startServer(dir, port, 'd3', { WT_SUPERVISOR_DISPATCHER_CMD: LAUNCH, WT_SUPERVISOR_MINUTE_MS: '300', WT_FCM_TEST: '1', WT_PUSH_PROVIDER: 'fcm' });
    a = await bearer(S.base, tok);
    const reg = await a.post('/api/push/devices', { data: { fcmToken: `fcm-468-${crypto.randomUUID()}`, deviceName: 'spec' } });
    expect(reg.ok(), await reg.text()).toBe(true);
  });
  test.afterAll(async () => {
    try { await a.dispose(); } catch { /* gone */ }
    try { await S.stop(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  let W; let disp; let caseId;
  test('a wait past its checkBy opens an R3 case, and the server starts its dispatcher and types the case into it', async () => {
    W = await turnWith('w468', { on: 'self', what: 'the build', checkBy: 1 });
    const c = await until(() => caseOf(W), 'an R3 case');
    expect(c.rule).toBe('R3');
    caseId = c.id;
    const st = await until(async () => { const s = await state(); return s.dispatcher && s.dispatcher.id ? s : null; }, 'the dispatcher');
    disp = st.dispatcher.id;
    // Its own session, apart from the list, with its rules and notes in its folder.
    const row = await until(async () => (await rows()).find((s) => s.id === disp), 'the dispatcher row');
    expect(row.role).toBe('supervisor');
    expect(row.name).toBe('web-terminal supervisor');
    expect(row.spawn).toBeNull(); // no spawn record: the #351 reaper never closes it
    const rules = fs.readFileSync(path.join(dir, 'handoffs', 'supervisor', 'CLAUDE.md'), 'utf8');
    expect(rules).toContain('scripts/wt-supervise.js');
    expect(rules).not.toContain('{{CLI}}');
    expect(fs.existsSync(path.join(dir, 'handoffs', 'supervisor', 'notes.md'))).toBe(true);
    // A fresh agent reads `active` until its first turn ends, so its first prompt rides its
    // command line and sends it to the cases open now: those count as delivered.
    expect(row.autoCommand).toContain(`"${TAG} You are the Supervisor's dispatcher.`);
    expect((await state()).cases.find((x) => x.id === caseId).deliveredAt).toBeTruthy();
    // Its first turn ends; a LATER case is typed into it through the gated prompt.
    // Its wait carries a checkBy, so R3 WOULD open a case on it but for the dispatcher skip.
    await report(disp, { on: 'external', what: 'the next case', checkBy: 1 });
    const W1 = await turnWith('w468a', { on: 'self', what: 'the tests', checkBy: 1 });
    const c1 = await until(() => caseOf(W1), 'a second case');
    await until(async () => (await screen(disp)).includes(`${TAG} Case ${c1.id} (R3):`), 'the second case typed into the dispatcher');
    expect((await state()).cases.find((x) => x.id === c1.id).deliveredAt).toBeTruthy();
    // The dispatcher never gets a case about itself (its own wait is long past its checkBy).
    expect((await state()).cases.every((x) => x.sessionId !== disp)).toBe(true);
    // Handed over is not taken: the case waits for the dispatcher to act on it.
    expect((await state()).cases.find((x) => x.id === caseId).takenAt).toBeNull();
  });

  test('the dispatcher reads the case and coaches the session through the gated prompt', async () => {
    const c = await (await a.get(`/api/supervisor/cases/${caseId}`)).json();
    expect(c.case.rule).toBe('R3');
    expect(c.session.id).toBe(W);
    const r = await a.post('/api/supervisor/act', { data: { verb: 'coach', session: W.slice(0, 8), text: 'step back and restate the problem', case: caseId } });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).delivered).toBe(true);
    await until(async () => (await screen(W)).includes(`${TAG} Coaching: step back and restate the problem`), 'the coaching typed');
    // A verb naming the case TAKES it: it no longer goes to the owner after 30 minutes.
    expect((await state()).cases.find((x) => x.id === caseId).takenAt).toBeTruthy();
    // An id is data: an unminted one is never looked up.
    expect((await a.get('/api/supervisor/cases/__proto__')).status()).toBe(404);
    expect((await a.post('/api/supervisor/cards/constructor', { data: { decision: 'dismiss' } })).status()).toBe(404);
    // The dispatcher may not prompt itself.
    expect((await a.post('/api/supervisor/act', { data: { verb: 'wake', session: disp, text: 'hi' } })).status()).toBe(400);
  });

  // #475 - the dispatcher is the fleet's supervisor, not one of its sessions: its row keeps
  // `role: "supervisor"` for the clients, and the server leaves it out of what counts sessions.
  test('the dispatcher stays out of the session count, the Live list and Mission Control', async () => {
    const all = await rows();
    expect(all.some((s) => s.id === disp)).toBe(true);
    const others = all.filter((s) => s.id !== disp).length;
    // The machine's session count is what the soft limit (#421) and Start work read.
    const m = await (await a.get('/api/machine?part=sessions')).json();
    expect(m.sessions.count).toBe(others);
    const st = await state();
    expect(st.dispatcher.id).toBe(disp);
    expect(st.live).not.toContain(disp);
    expect(st.sessions.some((n) => n.id === disp && n.role === 'supervisor')).toBe(true);
    // Mission Control groups every listed session under a project: never the dispatcher.
    await until(async () => {
      const p = await (await a.get('/api/mc/projects')).json();
      return Array.isArray(p.projects) && p.projects.reduce((n, x) => n + x.counts.sessions, 0) === others;
    }, 'Mission Control counting every session but the dispatcher');
    // Start work ranks machines by their sessions: the same count (GET /api/mc/machines).
    await until(async () => {
      const mv = await (await a.get('/api/mc/machines')).json();
      return Array.isArray(mv.machines) && mv.machines.reduce((n, x) => n + x.sessions, 0) === others;
    }, 'Start work counting every session but the dispatcher');
  });

  test('a verb logs its case and its undo as their own fields, for the Supervisor feed', async () => {
    await sleep(1500); // the coaching above was input: the typing quiet period
    const r = await a.post('/api/supervisor/act', { data: { verb: 'answer', session: W, text: 'take the server side', undo: 'tell it to switch to the client side', case: caseId } });
    expect(r.status(), await r.text()).toBe(200);
    const act = (await state()).actions.find((x) => x.rule === 'answer' && x.id === W);
    expect(act, 'the answer in the feed').toMatchObject({ caseId, undo: 'tell it to switch to the client side' });
    expect(act.text).toContain('take the server side');
    // The coaching before it named its case and no undo.
    const coach = (await state()).actions.find((x) => x.rule === 'coach');
    expect(coach).toMatchObject({ caseId, undo: null });
    // A note whose writer names no undo still carries the field, and the case-open note its case.
    const opened = (await state()).actions.find((x) => x.outcome === 'case' && x.caseId === caseId);
    expect(opened, 'the note of the case opening names its case').toBeTruthy();
    expect(opened.undo).toBeNull();
  });

  test('a text only the owner decides becomes a card; it is typed only on Approve, once', async () => {
    await sleep(1500); // the coaching above was input: the typing quiet period
    const r = await a.post('/api/supervisor/act', { data: { verb: 'lead', session: W, text: 'merge the PR to master now', case: caseId } });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.delivered).toBe(false);
    expect(j.card).toBeTruthy();
    expect(await screen(W)).not.toContain('merge the PR to master now');
    const card = (await state()).cards.find((k) => k.id === j.card);
    expect(card).toMatchObject({ cls: 'lead', decision: null, sessionId: W });
    const ok = await a.post(`/api/supervisor/cards/${j.card}`, { data: { decision: 'approve' } });
    expect(ok.status(), await ok.text()).toBe(200);
    await until(async () => (await screen(W)).includes(`${TAG} As your stand-in lead: merge the PR to master now`), 'the approved card typed');
    // The feed's note for the approval names the case the card served (#475).
    const approved = (await state()).actions.find((x) => x.rule === 'lead' && x.outcome === 'delivered');
    expect(approved, 'the approval in the feed').toMatchObject({ id: W, caseId, undo: null });
    expect((await a.post(`/api/supervisor/cards/${j.card}`, { data: { decision: 'approve' } })).status()).toBe(409);
  });

  test('an answer for the owner needs its undo; a class in recommend mode makes cards; Dismiss counts', async () => {
    expect((await a.post('/api/supervisor/act', { data: { verb: 'answer', session: W, text: 'fix it in the server' } })).status()).toBe(400);
    expect((await a.post('/api/supervisor/autonomy', { data: { class: 'wake', mode: 'recommend' } })).status()).toBe(200);
    const r = await (await a.post('/api/supervisor/act', { data: { verb: 'wake', session: W, text: 'CI is green' } })).json();
    expect(r.card).toBeTruthy();
    expect((await a.post(`/api/supervisor/cards/${r.card}`, { data: { decision: 'dismiss' } })).status()).toBe(200);
    const st = await state();
    expect(st.autonomy.wake).toMatchObject({ mode: 'recommend', dismissed: 1 });
    expect(st.autonomy.lead).toMatchObject({ mode: 'act', approved: 1 });
    await a.post('/api/supervisor/autonomy', { data: { class: 'wake', mode: 'act' } });
  });

  test('an answer in recommend mode is a card that keeps its undo; Approve types it and the feed names case and undo', async () => {
    await sleep(1500); // the typing quiet period
    expect((await a.post('/api/supervisor/autonomy', { data: { class: 'answer', mode: 'recommend' } })).status()).toBe(200);
    const r = await (await a.post('/api/supervisor/act', { data: { verb: 'answer', session: W, text: 'take the client side', undo: 'tell it to take the server side', case: caseId } })).json();
    expect(r.card).toBeTruthy();
    const card = (await state()).cards.find((k) => k.id === r.card);
    expect(card).toMatchObject({ cls: 'answer', caseId });
    const ok = await a.post(`/api/supervisor/cards/${r.card}`, { data: { decision: 'approve' } });
    expect(ok.status(), await ok.text()).toBe(200);
    await until(async () => (await screen(W)).includes('take the client side'), 'the approved answer typed');
    const noted = (await state()).actions.find((x) => x.rule === 'answer' && x.outcome === 'delivered' && x.text.includes('take the client side'));
    expect(noted, 'the approved answer in the feed').toMatchObject({ caseId, undo: 'tell it to take the server side' });
    await a.post('/api/supervisor/autonomy', { data: { class: 'answer', mode: 'act' } });
  });

  test('the dispatcher resolves the case through the CLI', async () => {
    const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wt-supervise.js'), ...args], {
      env: { ...process.env, WT_SESSION_PORT: String(port), WT_API_TOKENS_FILE: path.join(dir, 'api-tokens.json') }, encoding: 'utf8', windowsHide: true });
    const list = run('cases');
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain(caseId);
    const done = run('resolve', caseId, 'coached it; it now reports a target');
    expect(done.status, done.stdout + done.stderr).toBe(0);
    const c = (await state()).cases.find((x) => x.id === caseId);
    expect(c.resolution).toMatchObject({ how: 'coached it; it now reports a target' });
    expect(run('cases').stdout).not.toContain(caseId);
  });

  test('paused, a new case goes straight to the owner with a push; a new report retires it', async () => {
    expect((await a.post('/api/supervisor/pause', { data: { paused: true } })).status()).toBe(200);
    const W2 = await turnWith('w468b', { on: 'external', what: 'the reviewer', checkBy: 1 });
    const c = await until(async () => { const x = await caseOf(W2); return x && x.escalated ? x : null; }, 'an escalated case');
    expect(c.deliveredAt).toBeNull();
    expect(c.escalated.by).toContain('paused');
    expect(await screen(disp)).not.toContain(`Case ${c.id}`);
    await until(async () => (await drain()).some((m) => m.data.kind === 'owner-wait' && m.data.sessionId === W2), 'the owner push');
    // The session reports anew: what opened the case has moved on.
    await report(W2, { on: 'self', what: 'carrying on' });
    await until(async () => (await state()).cases.find((x) => x.id === c.id).resolvedAt, 'the case retired');
    expect((await state()).cases.find((x) => x.id === c.id).resolution.by).toBe('rules');
    await a.post('/api/supervisor/pause', { data: { paused: false } });
  });

  test('a session waiting on the owner opens an R4 case for the dispatcher; the owner is pushed too', async () => {
    const W3 = await turnWith('w468c', { on: 'you', what: 'server or client?' });
    const c = await until(() => caseOf(W3), 'an R4 case');
    expect(c.rule).toBe('R4');
    expect(c.line).toContain('server or client?');
    await until(async () => (await drain()).some((m) => m.data.kind === 'owner-wait' && m.data.sessionId === W3), 'the owner push');
  });
});
