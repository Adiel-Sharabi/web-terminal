// @ts-check
// #469 - supervisor phase 4 end to end, on one isolated server that is its own lease
// authority: a done session is asked to close out (the gated prompt's template, built by the
// session's own server); it answers as state with the real scripts/wt-closeout.js; an agent's
// clean session is closed through the gated close and the journal says closed-out; the
// owner's is marked ready to close and never closed; a blocked close-out goes to the owner
// (Needs you, a push); new work clears it and the next done is asked again; in recommend mode
// the close is a card, closed on Approve. The clock is shortened by WT_TEST seams; the agent is
// the printf "agent" the other supervisor specs use, never a real claude.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');
const { ROOT, sleep, until, startServer, bearer } = require('./supervisor-rig');

test.describe.serial('#469 close-out, then close or mark ready', () => {
  test.setTimeout(120000);
  const TAG = '[web-terminal supervisor]';
  const ASK = `${TAG} Close-out: you reported done.`;
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
  const port = 18140 + Math.floor(Math.random() * 40);
  const url = `http://127.0.0.1:${port}`;
  const tok = crypto.randomBytes(32).toString('hex');
  let dir; let S; let a;
  const sink = [];
  const drain = async () => { sink.push(...(await (await a.get('/api/push/test-sink')).json()).items); return sink; };
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const hookPost = async (route, data, headers = {}) => {
    const c = await pwRequest.newContext({ baseURL: url });
    const r = await c.post(route, { data, headers: { 'X-WT-Hook-Token': hookToken(), ...headers } });
    const out = { status: r.status(), json: await r.json().catch(() => ({})) };
    await c.dispose();
    return out;
  };
  const post = async (route, data, headers = {}) => { const r = await hookPost(route, data, headers); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  const rows = async () => (await (await a.get('/api/sessions')).json());
  const row = async (id) => (await rows()).find((s) => s.id === id);
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const node = async (id) => (await state()).sessions.find((n) => n.id === id);
  const screen = async (id) => (await (await a.get(`/api/sessions/${id}/scrollback`)).json()).data || '';
  const asks = async (id) => (await screen(id)).split(ASK).length - 1;
  /** The real answer: scripts/wt-closeout.js, run as the session's agent would run it. */
  const closeout = (id, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wt-closeout.js'), ...args], {
    env: { ...process.env, WT_SESSION_ID: id, WT_SESSION_PORT: String(port), WT_HOOK_TOKEN: hookToken() }, encoding: 'utf8', windowsHide: true });
  /** A session created by POST; [person] attaches an ACTIVE viewer at once (the #351 verdict: human). */
  const open = async (label, person = false) => {
    const r = await a.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), agent: 'claude', autoCommand: LAUNCH } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    if (person) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}?token=${tok}`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ mode: 'active', browserId: `p-${label}` }));
      await sleep(300);
      const closed = new Promise((res) => ws.once('close', res));
      ws.close();
      await closed;
    }
    await until(async () => (await row(id))?.agentReady === true, `${label} ready`);
    await until(async () => (await row(id))?.spawn?.by === (person ? 'human' : 'agent'), `${label} classified`);
    return id;
  };
  /** One turn that ends reporting [wait]; the session is idle again. */
  const turn = async (id, wait, prompt = 'work') => {
    const conv = crypto.randomUUID();
    await post('/api/hook', { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt }, { 'X-WT-Session-ID': id });
    await post(`/api/session/${id}/report`, { items: [{ ref: '#1', title: 'phase 4', state: 'done' }], wait });
    await post('/api/hook', { hook_event_name: 'Stop', session_id: conv }, { 'X-WT-Session-ID': id });
    await until(async () => (await row(id))?.status === 'idle', `${id} idle`);
  };
  const DONE = { on: 'done', what: 'finished' };

  test.beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt469-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'alpha', publicUrl: url, cluster: [{ name: 'alpha', url }], leases: { authority: 'alpha' },
      checkIn: { typingQuietMin: 0.01 },
      // One "minute" is 300 ms: asked at once, closed 600 ms after a clean answer.
      supervisor: { closeout: { askAfterMin: 0, closeAfterMin: 2 } },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [tok]: { label: 'closeout-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), '{}');
    S = await startServer(dir, port, 'c4', { WT_SUPERVISOR_DISPATCHER_CMD: LAUNCH, WT_SUPERVISOR_MINUTE_MS: '300', WT_SPAWN_CLASSIFY_MS: '1500',
      WT_FCM_TEST: '1', WT_PUSH_PROVIDER: 'fcm' });
    a = await bearer(S.base, tok);
    const reg = await a.post('/api/push/devices', { data: { fcmToken: `fcm-469-${crypto.randomUUID()}`, deviceName: 'spec' } });
    expect(reg.ok(), await reg.text()).toBe(true);
  });
  test.afterAll(async () => {
    try { await a.dispose(); } catch { /* gone */ }
    try { await S.stop(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('an agent\'s done session is asked, answers clean with wt-closeout.js, and is closed: the journal says closed-out', async () => {
    const A = await open('co-agent');
    // The answer route answers for a done session only, and only with the hook token.
    await turn(A, { on: 'self', what: 'the build' });
    expect((await hookPost(`/api/session/${A}/closeout`, { state: 'clean' })).json.error).toMatch(/done first/);
    expect((await hookPost(`/api/session/${A}/closeout`, { state: 'clean' }, { 'X-WT-Hook-Token': 'nope' })).status).toBe(401);
    await turn(A, DONE);
    await until(async () => (await asks(A)) === 1, 'the close-out typed');
    const text = await screen(A);
    expect(text).toContain(`node "${path.join(ROOT, 'scripts', 'wt-closeout.js').split(path.sep).join('/')}" clean`);
    await until(async () => (await row(A))?.brief?.closeout?.askedAt, 'the ask recorded on its brief');
    // Not clean yet: the gated close refuses whatever the caller says.
    const early = await a.post(`/api/sessions/${A}/close`, { data: { closeoutAt: Date.now() } });
    expect(early.status()).toBe(409);
    expect((await early.json()).refused).toBe('not-clean');
    const r = closeout(A, 'clean');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('close-out recorded: clean');
    await until(async () => !(await row(A)), 'closed by the supervisor');
    const j = await (await a.get('/api/journal')).json();
    expect(j.events.find((e) => e.event === 'closed' && e.id === A)).toMatchObject({ why: 'closed-out', by: 'agent' });
    // Asked once: a second ask never went out before the close.
    const log = fs.readFileSync(path.join(dir, 'handoffs', 'supervisor-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(log.filter((l) => l.event === 'closeout-ask' && l.id === A)).toHaveLength(1);
    expect(log.find((l) => l.event === 'closeout-close' && l.id === A)).toBeTruthy();
  });

  let H;
  test('the owner\'s session is marked ready to close and never closed, by the rules, the gated close or the dispatcher', async () => {
    H = await open('co-owner', true);
    await turn(H, DONE);
    await until(async () => (await asks(H)) === 1, 'the owner\'s session asked too');
    expect(closeout(H, 'clean').status).toBe(0);
    await until(async () => (await state()).readyToClose.includes(H), 'ready to close');
    await sleep(3000); // well past closeAfterMin (600 ms) and several scans
    expect(await row(H)).toBeTruthy();
    expect((await node(H)).closeoutState).toEqual({ held: 'owner' });
    const at = (await row(H)).brief.closeout.at;
    const g = await a.post(`/api/sessions/${H}/close`, { data: { closeoutAt: at } });
    expect(g.status()).toBe(409);
    expect((await g.json()).refused).toBe('owner');
    const d = await a.post('/api/supervisor/close', { data: { session: H.slice(0, 8) } });
    expect(d.status()).toBe(409);
    expect((await d.json()).refused).toBe('owner');
    expect(await row(H)).toBeTruthy();
  });

  test('a blocked close-out goes to the owner with what is left; new work clears it and the next done is asked again', async () => {
    const B = await open('co-blocked');
    await turn(B, DONE);
    await until(async () => (await asks(B)) === 1, 'asked');
    expect(closeout(B, 'blocked', 'a branch to push').status).toBe(0);
    await until(async () => (await state()).needsYou.includes(B), 'Needs you');
    expect((await node(B)).closeoutState).toEqual({ needs: 'blocked', left: 'a branch to push' });
    // FCM is data-only (the text is never in the payload): the push names the session, and the
    // supervisor log names the close-out it was for.
    await until(async () => (await drain()).some((p) => p.data && p.data.kind === 'owner-wait' && p.data.sessionId === B), 'the owner pushed');
    const pushed = fs.readFileSync(path.join(dir, 'handoffs', 'supervisor-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(pushed.find((l) => l.event === 'owner-push' && l.id === B).key.startsWith(`closeout|${B}|`)).toBe(true);
    await sleep(1500);
    expect(await row(B)).toBeTruthy(); // never a forced close
    // The owner types: new work. The close-out is gone, and the next done is asked again.
    await turn(B, DONE, 'push it then');
    await until(async () => (await asks(B)) === 2, 'asked again after new work');
    expect((await state()).needsYou.includes(B)).toBe(false);
  });

  test('in recommend mode the close is a card; Approve closes it through the gated close', async () => {
    const r = await a.post('/api/supervisor/autonomy', { data: { class: 'close', mode: 'recommend' } });
    expect(r.ok(), await r.text()).toBe(true);
    const C = await open('co-card');
    await turn(C, DONE);
    await until(async () => (await asks(C)) === 1, 'asked');
    expect(closeout(C, 'clean').status).toBe(0);
    const card = await until(async () => (await state()).cards.find((k) => k.cls === 'close' && k.sessionId === C && !k.decision), 'a close card');
    await sleep(1500);
    expect(await row(C)).toBeTruthy(); // not closed on the rules' word
    expect((await state()).cards.filter((k) => k.cls === 'close' && k.sessionId === C)).toHaveLength(1); // one card, not one per scan
    const ap = await a.post(`/api/supervisor/cards/${card.id}`, { data: { decision: 'approve' } });
    expect(ap.status(), await ap.text()).toBe(200);
    expect((await ap.json()).closed).toBe(true);
    await until(async () => !(await row(C)), 'closed on Approve');
    await a.post('/api/supervisor/autonomy', { data: { class: 'close', mode: 'act' } });
  });
});
