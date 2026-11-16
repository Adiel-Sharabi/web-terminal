// @ts-check
// #470 - supervisor phase 5 end to end, on one isolated server that is its own lease authority.
// A session's agent DIES (seen running under its PTY, then gone, no exit hook): its row says so,
// the gated prompt refuses to type into the shell left, R7 opens a case, and the dispatcher's
// `spawn` replaces it - as a card in recommend mode, performed on Approve. The server writes the
// brief, a successor starts in the same folder and is typed the replacement prompt, and once it
// starts a turn the old shell is closed; the journal and the lineage name the replacement. A
// DELIBERATE exit (SessionEnd) is never replaced and never a case. A running agent is handed off
// instead (it writes its own brief). Below the free-commit floor nothing is spawned (R8).
// What the process snapshot says is a WT_TEST lever (POST /api/test/agent-process); the rule that
// reads it is unit-tested in supervisor-phase5.spec.js. The agent is the printf "agent" the other
// supervisor specs use, never a real claude.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');
const { ROOT, sleep, until, startServer, bearer } = require('./supervisor-rig');

test.describe.serial('#470 replacement sessions', () => {
  test.setTimeout(120000);
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
  const port = 18180 + Math.floor(Math.random() * 40);
  const url = `http://127.0.0.1:${port}`;
  const tok = crypto.randomBytes(32).toString('hex');
  let dir; let S; let a;
  const config = (extra = {}) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    serverName: 'alpha', publicUrl: url, cluster: [{ name: 'alpha', url }], leases: { authority: 'alpha' },
    checkIn: { typingQuietMin: 0.01 },
    // No brain: a case the rules open waits for the verbs this spec sends.
    supervisor: { dispatcher: { enabled: false }, ...extra },
  }));
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const hook = async (id, data) => {
    const c = await pwRequest.newContext({ baseURL: url });
    const r = await c.post('/api/hook', { data, headers: { 'X-WT-Hook-Token': hookToken(), 'X-WT-Session-ID': id } });
    expect(r.status()).toBe(200);
    await c.dispose();
  };
  const report = async (id, data) => {
    const c = await pwRequest.newContext({ baseURL: url });
    const r = await c.post(`/api/session/${id}/report`, { data, headers: { 'X-WT-Hook-Token': hookToken() } });
    expect(r.status(), await r.text()).toBe(200);
    await c.dispose();
  };
  const rows = async () => (await (await a.get('/api/sessions')).json());
  const row = async (id) => (await rows()).find((s) => s.id === id);
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const inScan = async (id) => until(async () => (await state()).sessions?.some((n) => n.id === id), `${id} in the supervisor's scan`);
  const screen = async (id) => (await (await a.get(`/api/sessions/${id}/scrollback`)).json()).data || '';
  const agentProcess = async (id, found) => expect((await a.post('/api/test/agent-process', { data: { id, found } })).ok()).toBe(true);
  /** A session whose agent was SEEN running, then gone: the row's agentGone stands. */
  const dies = async (id) => {
    await agentProcess(id, true);
    expect((await row(id)).agentGone).toBeUndefined();
    await agentProcess(id, false);
    await until(async () => Number.isFinite((await row(id))?.agentGone?.seenAt), `${id} agentGone`);
  };
  const open = async (label) => {
    const r = await a.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), agent: 'claude', autoCommand: LAUNCH, spawnedBy: 'spec' } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    await until(async () => (await row(id))?.agentReady === true, `${label} ready`);
    return id;
  };

  test.beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt470-'));
    config();
    // The agent home's settings hold web-terminal's SessionEnd hook: without it no exit can be
    // told from a death, so nothing would ever read as gone.
    const home = path.join(dir, 'agent-home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'http', url: `${url}/api/hook` }] }] } }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [tok]: { label: 'replace-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), '{}');
    // One "minute" is 200 ms: R7 opens a second after the agent is gone.
    S = await startServer(dir, port, 'r5', { WT_AGENT_SETTINGS_DIR: home, WT_SUPERVISOR_MINUTE_MS: '200', WT_SPAWN_CLASSIFY_MS: '1500' });
    a = await bearer(S.base, tok);
  });
  test.afterAll(async () => {
    try { await a.dispose(); } catch { /* gone */ }
    try { await S.stop(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a dead agent: refused prompts, an R7 case, a spawn card approved, the supervisor\'s brief, a successor, the old shell closed', async () => {
    const A = await open('r7-dead');
    const conv = crypto.randomUUID();
    await hook(A, { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'work' });
    await report(A, { items: [{ ref: '#1', title: 'phase five job', state: 'in-progress' }], headline: 'half way', wait: { on: 'self', what: 'the build' } });
    await until(async () => (await row(A))?.spawn?.by === 'agent', 'classified as an agent\'s');
    await dies(A);
    expect((await row(A)).agentGone).toMatchObject({ endedAt: null });
    // The gated prompt never types into the shell the agent left.
    const p = await a.post(`/api/sessions/${A}/prompt`, { data: { text: 'hello' } });
    expect(p.status()).toBe(409);
    expect((await p.json()).refused).toBe('agent-gone');
    // R7 opens (the dispatcher is off, so it goes to the owner; the verb can still name it).
    let c;
    await until(async () => { c = ((await (await a.get('/api/supervisor/cases')).json()).cases || []).find((x) => x.rule === 'R7' && x.sessionId === A); return c; }, 'an R7 case');
    expect(c.line).toMatch(/lost its agent/);
    // Recommend mode: the verb makes a card; nothing is spawned until Approve.
    expect((await a.post('/api/supervisor/autonomy', { data: { class: 'spawn', mode: 'recommend' } })).ok()).toBe(true);
    const v = await a.post('/api/supervisor/spawn', { data: { session: A, case: c.id, note: 'the build was green; open the PR next' } });
    expect(v.status(), await v.text()).toBe(200);
    const vj = await v.json();
    expect(vj).toMatchObject({ replaced: false });
    expect(vj.card).toMatch(/^[0-9a-f]{8}$/);
    // A note asking for an owner-only action makes a card whatever the class (here: "PR").
    expect(vj.why).toMatch(/only the owner decides/);
    expect((await rows()).filter((s) => s.name === 'r7-dead (2)')).toHaveLength(0);
    const taken = ((await (await a.get(`/api/supervisor/cases/${c.id}`)).json()));
    expect(taken.takenAt || taken.case?.takenAt).toBeTruthy();
    const ap = await a.post(`/api/supervisor/cards/${vj.card}`, { data: { decision: 'approve' } });
    expect(ap.status(), await ap.text()).toBe(200);
    expect(await ap.json()).toMatchObject({ replaced: true, mode: 'dead' });
    // The supervisor's brief: the report, the note, and no conversation to resume (no transcript).
    const briefText = fs.readFileSync(path.join(dir, 'handoffs', `handoff-${A}.md`), 'utf8');
    for (const s of ['# Replacement brief: r7-dead', 'half way', '#1 phase five job: in-progress', 'Waiting on: self "the build"',
      'the build was green; open the PR next', 'starts FRESH']) expect(briefText).toContain(s);
    // The successor: same folder, the fresh launch, typed the replacement prompt once ready.
    let succ;
    await until(async () => { succ = (await rows()).find((s) => s.name === 'r7-dead (2)'); return succ; }, 'the successor');
    expect(succ.cwd).toBe((await row(A)).cwd);
    expect(succ.autoCommand).toBe(LAUNCH);
    await until(async () => (await screen(succ.id)).includes('The supervisor wrote a brief at'), 'the replacement prompt typed');
    expect(await screen(succ.id)).toContain(`handoff-${A}.md`);
    // Proven up by its first turn; then the old session (a shell) is closed, though its turn never stopped.
    await hook(succ.id, { hook_event_name: 'UserPromptSubmit', session_id: crypto.randomUUID(), prompt: 'reading the brief' });
    await until(async () => !(await row(A)), 'the old shell closed');
    const s2 = await row(succ.id);
    expect(s2.spawn.replaces).toContain(A);
    expect(s2.spawn.by).toBe('agent'); // an agent's job stays closable by R5
    const j = await (await a.get('/api/journal')).json();
    expect(j.events.find((e) => e.event === 'hand-off' && e.id === A)).toMatchObject({ to: succ.id, trigger: 'supervisor' });
    const log = fs.readFileSync(path.join(dir, 'handoffs', 'supervisor-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(log.find((l) => l.event === 'replace' && l.id === A)).toMatchObject({ mode: 'dead', resumes: false });
    expect((await a.post('/api/supervisor/autonomy', { data: { class: 'spawn', mode: 'act' } })).ok()).toBe(true);
  });

  test('a deliberate exit (SessionEnd) is never replaced, and never an R7 case', async () => {
    const D = await open('r7-exit');
    await hook(D, { hook_event_name: 'UserPromptSubmit', session_id: crypto.randomUUID(), prompt: 'work' });
    await dies(D);
    await hook(D, { hook_event_name: 'SessionEnd', session_id: crypto.randomUUID(), reason: 'prompt_input_exit' });
    await until(async () => Number.isFinite((await row(D))?.agentGone?.endedAt), 'the exit recorded');
    expect((await row(D)).agentGone.reason).toBe('prompt_input_exit');
    await inScan(D);
    const r = await a.post('/api/supervisor/spawn', { data: { session: D } });
    expect(r.status()).toBe(409);
    expect((await r.json()).refused).toBe('deliberate');
    // Well past goneMs and several scans: no case.
    await sleep(3000);
    const all = (await (await a.get('/api/supervisor/cases')).json()).cases || [];
    expect(all.filter((x) => x.sessionId === D)).toHaveLength(0);
  });

  test('a running agent is handed off by the supervisor: it writes its own brief', async () => {
    const H = await open('r7-alive');
    // One turn that ended: the hand-off's own gates (idle) hold for the supervisor too.
    const conv = crypto.randomUUID();
    await hook(H, { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'work' });
    await hook(H, { hook_event_name: 'Stop', session_id: conv });
    await until(async () => (await row(H))?.status === 'idle', 'idle');
    await inScan(H);
    // Never seen running: no wrap-up is typed into what may be a bare shell.
    const unseen = await a.post('/api/supervisor/spawn', { data: { session: H } });
    expect(unseen.status()).toBe(409);
    expect((await unseen.json()).refused).toBe('agent-unknown');
    await agentProcess(H, true);
    // Recommend mode alone (a note with no owner-only word) makes a card and starts nothing.
    expect((await a.post('/api/supervisor/autonomy', { data: { class: 'spawn', mode: 'recommend' } })).ok()).toBe(true);
    const rec = await a.post('/api/supervisor/spawn', { data: { session: H, note: 'carry on from the last report' } });
    expect(rec.status(), await rec.text()).toBe(200);
    expect(await rec.json()).toMatchObject({ replaced: false, why: 'spawn is in recommend mode' });
    expect((await row(H)).handoff?.run ?? null).toBeNull();
    expect((await a.post('/api/supervisor/autonomy', { data: { class: 'spawn', mode: 'act' } })).ok()).toBe(true);
    const r = await a.post('/api/supervisor/spawn', { data: { session: H } });
    expect(r.status(), await r.text()).toBe(200);
    expect(await r.json()).toMatchObject({ replaced: true, mode: 'handoff' });
    await until(async () => (await row(H))?.handoff?.run?.state === 'wrapping', 'the hand-off runs');
    expect((await row(H)).handoff.run.trigger).toBe('supervisor');
    await until(async () => (await screen(H)).includes('This session is being handed off'), 'the wrap-up prompt typed');
    // A second spawn while it runs is refused, by the session's own server.
    const again = await a.post('/api/supervisor/spawn', { data: { session: H } });
    expect(again.status()).toBe(409);
    expect((await again.json()).refused).toBe('in-progress');
    expect((await a.delete(`/api/sessions/${H}/handoff`)).ok()).toBe(true);
    // A person's Cancel stands for the supervisor too, until someone types.
    const declined = await a.post('/api/supervisor/spawn', { data: { session: H } });
    expect(declined.status()).toBe(409);
    expect((await declined.json()).refused).toBe('declined');
  });

  test('R8: below the free-commit floor, nothing is spawned', async () => {
    const F = await open('r8-floor');
    await agentProcess(F, true); // seen running: the capacity gate is the one that refuses
    await inScan(F);
    config({ spawn: { commitFloorGb: 1024 } });
    await sleep(5500); // the live config is re-read every 5 s
    const r = await a.post(`/api/sessions/${F}/replace`, { data: {} });
    expect(r.status()).toBe(409);
    // A Windows box reads its commit; anywhere else the reading is unknown, which refuses too.
    expect((await r.json()).refused).toMatch(/^commit-(floor|unknown)$/);
    expect((await row(F)).handoff?.run ?? null).toBeNull();
    config();
  });

  test('the routes need a login, and refuse a bad note', async () => {
    const anon = await pwRequest.newContext({ baseURL: url });
    expect((await anon.post(`/api/sessions/${crypto.randomUUID()}/replace`, { data: {} })).status()).toBe(401);
    expect((await anon.post('/api/supervisor/spawn', { data: {} })).status()).toBe(401);
    await anon.dispose();
    const any = (await rows())[0];
    const bad = await a.post(`/api/sessions/${any.id}/replace`, { data: { note: 'two\nlines' } });
    expect(bad.status()).toBe(400);
    expect((await a.post(`/api/sessions/${any.id}/replace`, { data: { fresh: 'yes' } })).status()).toBe(400);
  });
});
