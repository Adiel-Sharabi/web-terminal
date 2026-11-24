// @ts-check
// #475 - the supervisor's dispatcher is the fleet's supervisor, not one of its sessions: the
// check-in (#443) never asks it what it waits on. The server types its cases into it and replaces
// it (#525); a check-in typed beside that would land in the middle of a case. Pinned on an isolated
// server (its own port, config and state files) with two identical sessions, each idle after a
// turn that reported a stale self-wait: the ordinary one is checked in (the control that proves the
// scan is live), the one the server records as its dispatcher is not - not a prompt typed, not a
// record kept, not even a skip logged.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { claudeProjectsRoot, emptyCwd } = require('./test-helpers');
const { ROOT, sleep, until, startServer, bearer } = require('./supervisor-rig');

test.describe.serial('#475 the dispatcher is never checked in', () => {
  test.setTimeout(120000);
  const TAG = '[web-terminal check-in]';
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
  const port = 18150 + Math.floor(Math.random() * 40);
  const tok = crypto.randomBytes(32).toString('hex');
  const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-checkin-475-fixture__');
  let dir; let S; let a;
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const post = async (route, data, headers = {}) => {
    const c = await pwRequest.newContext({ baseURL: S.base });
    const r = await c.post(route, { data, headers: { 'X-WT-Hook-Token': hookToken(), ...headers } });
    const t = await r.text();
    await c.dispose();
    expect(r.status(), t).toBe(200);
  };
  const rows = async () => (await (await a.get('/api/sessions')).json());
  const rowOf = async (id) => (await rows()).find((s) => s.id === id);
  const screen = async (id) => (await (await a.get(`/api/sessions/${id}/scrollback`)).json()).data || '';
  const logOf = (id) => {
    const f = path.join(dir, 'handoffs', 'check-in-log.jsonl');
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);
  };
  /** A ready Claude-declared session whose turn ended reporting a stale self-wait. With no transcript
   *  the check-in fails closed (live work cannot be told), so each session gets a tiny real one. */
  const endedTurn = async (name) => {
    const r = await a.post('/api/sessions', { data: { name, cwd: emptyCwd(name), agent: 'claude', autoCommand: LAUNCH } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    await until(async () => (await rowOf(id))?.agentReady === true, `${name} ready`);
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const tp = path.join(FIXTURE_DIR, `wt_checkin_475_${process.pid}_${name}.jsonl`);
    fs.writeFileSync(tp, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60000).toISOString(), message: { role: 'user', content: 'work' } }) + '\n', 'utf8');
    const conv = crypto.randomUUID();
    await post('/api/hook', { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'work', transcript_path: tp }, { 'X-WT-Session-ID': id });
    await post(`/api/session/${id}/report`, { items: [{ ref: '#1', title: 'x', state: 'in-progress' }], wait: { on: 'self', what: 'watch the CI run' } });
    await post('/api/hook', { hook_event_name: 'Stop', session_id: conv, transcript_path: tp }, { 'X-WT-Session-ID': id });
    await until(async () => (await rowOf(id))?.status === 'idle', `${name} idle`);
    return id;
  };

  test.beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt475-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'alpha', publicUrl: `http://127.0.0.1:${port}`, cluster: [], supervisor: {},
      checkIn: { typingQuietMin: 0.01 },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [tok]: { label: 'checkin-475-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), '{}');
    S = await startServer(dir, port, 'c475');
    a = await bearer(S.base, tok);
  });
  test.afterAll(async () => {
    try { await a.dispose(); } catch { /* gone */ }
    try { await S.stop(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('an ordinary stale self-wait is checked in; the same wait on the dispatcher is not', async () => {
    // The default clocks: both sessions end their turn and the dispatcher is recorded before any short
    // clock could ask either (the server re-reads config.json within 5 s, LIVE_CONFIG_TTL).
    const dispatcher = await endedTurn('disp475');
    const ordinary = await endedTurn('ord475');
    // The server's own record of who its dispatcher is (what the Supervisor's start writes), read within 2 s.
    const settings = path.join(dir, 'handoffs', 'supervisor-settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ dispatcherId: dispatcher }));
    await until(async () => (await rowOf(dispatcher))?.role === 'supervisor', 'the dispatcher role on its row');
    // Now the clocks go short: both waits are long stale. The control: the ordinary session is asked,
    // so the scan is live.
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')),
      handoff: { staleSelfMin: 0.01 }, checkIn: { afterMin: 0.01, everyMs: 300, typingQuietMin: 0.01 } }));
    await until(async () => (await screen(ordinary)).includes(TAG), 'the check-in typed into the ordinary session', 45000);
    expect(logOf(ordinary).filter((l) => l.event === 'sent')).toHaveLength(1);
    // The scan has run many times over since (every 300 ms): the dispatcher is still untouched.
    await sleep(3000);
    expect(await screen(dispatcher)).not.toContain(TAG);
    expect((await rowOf(dispatcher)).checkIn).toBeNull();
    expect(logOf(dispatcher)).toEqual([]);
  });
});
