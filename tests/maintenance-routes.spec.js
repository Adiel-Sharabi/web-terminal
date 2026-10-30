// @ts-check
// #359 - the restart hold, end to end against the real test server and worker. The rules
// are pinned in maintenance.spec.js; this pins that the server APPLIES them: prepare
// tells the agent session through its PTY and leaves a plain shell alone, the verdict
// follows the hooks rather than anything the agent wrote, new sessions are refused while
// the hold is on, and cancelling it lifts the refusal.
//
// The "agent" is a bash session declared `claude` whose launch prints Claude's composer
// marker (#190), as in handoff-routes.spec.js.
const crypto = require('crypto');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, readHookToken } = require('./test-helpers');

const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
const TAG = '[web-terminal restart]';

async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post('/api/hook', {
    data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
  await c.dispose();
  return r.status();
}

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

test.describe('#359 restart hold - server', () => {
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];

  const rowOf = async (id) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
  const status = async () => (await ctx.get('/api/maintenance/status')).json();
  const verdictOf = async (id) => (await status()).sessions.find((s) => s.id === id);
  async function make(name, data) {
    const r = await ctx.post('/api/sessions', { data: { name, ...data } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    made.push(id);
    return id;
  }

  test.beforeEach(async () => {
    ctx = await authCtx(); made = [];
    await ctx.delete('/api/maintenance');
  });
  test.afterEach(async () => {
    // ALWAYS lift the hold first: one left on refuses every session the rest of the suite creates.
    await ctx.delete('/api/maintenance');
    for (const id of made) await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('no hold: status says so, and sessions are created as usual', async () => {
    expect(await status()).toMatchObject({ hold: null, safeToRestart: null, sessions: [] });
  });

  test('prepare tells the agent, not the shell; the verdict follows the MAIN Stop; new sessions are refused', async () => {
    const agent = await make(`maint-agent-${Date.now()}`, { agent: 'claude', autoCommand: LAUNCH });
    const shell = await make(`maint-shell-${Date.now()}`, { autoCommand: '' });
    await until(async () => (await rowOf(agent))?.agentReady === true, 'the agent to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(agent, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(agent))?.status === 'idle', 'the agent to go idle');

    const p = await ctx.post('/api/maintenance/prepare', { data: { reason: 'spec restart' } });
    expect(p.status()).toBe(200);
    const body = await p.json();
    expect(body.hold).toMatchObject({ reason: 'spec restart' });
    expect(body.safeToRestart).toBe(false);

    // The agent was told through its PTY; the plain shell never is.
    await until(async () => (await verdictOf(agent))?.promptedAt, 'the wrap-up prompt to be delivered');
    await until(async () => {
      const sb = await (await ctx.get(`/api/sessions/${agent}/scrollback`)).text();
      return sb.includes(TAG);
    }, 'the prompt in the agent\'s terminal');
    expect((await verdictOf(shell)).promptedAt).toBeNull();
    // Typed is not delivered: until the agent's own UserPromptSubmit carries it, it may not have landed.
    expect(await verdictOf(agent)).toMatchObject({ state: 'answering', why: 'prompt typed; waiting for the agent to take it' });

    // A second prepare does not start a second hold.
    expect((await ctx.post('/api/maintenance/prepare', { data: { reason: 'again' } })).status()).toBe(409);

    // Nothing new starts while the hold is on - unless forced.
    const refused = await ctx.post('/api/sessions', { data: { name: `maint-late-${Date.now()}` } });
    expect(refused.status()).toBe(503);
    expect((await refused.json()).restartHold).toMatchObject({ reason: 'spec restart' });
    const forced = await make(`maint-forced-${Date.now()}`, { force: true });
    // Forced through the hold: tracked, so it is told and judged like the rest.
    expect((await verdictOf(forced)).untracked).toBe(false);

    // A hand-off would boot a successor: refused too.
    const h = await ctx.post(`/api/sessions/${agent}/handoff`, { data: { force: true } });
    expect(h.status()).toBe(409);
    expect((await h.json()).why).toBe('restart-hold');

    // A Stop before delivery answers nothing; the tagged UserPromptSubmit is delivery.
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    expect((await verdictOf(agent)).answeredAt).toBeNull();
    expect(await hook(agent, 'UserPromptSubmit', { session_id: conv, prompt: `${TAG} wrap up` })).toBe(200);
    await until(async () => (await verdictOf(agent))?.deliveredAt, 'the prompt to count as delivered');
    // A SUBAGENT's Stop is not the answer; the main agent's is.
    expect(await hook(agent, 'Stop', { session_id: conv, agent_id: 'sub-1' })).toBe(200);
    expect((await verdictOf(agent)).answeredAt).toBeNull();
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await verdictOf(agent))?.answeredAt, 'the main Stop to answer');
    // Turn over but it never SAID yes (#407): silence is not agreement.
    await until(async () => (await verdictOf(agent))?.state === 'answering' && (await verdictOf(agent)).why.includes('has not answered'), 'silence to read as not answered');
    expect((await ctx.post('/api/maintenance/answer', { data: { sessionId: agent, answer: 'yes' } })).status()).toBe(200);
    // Said yes, turn over and nothing running under it: ready (the process read may need a pass).
    await until(async () => (await verdictOf(agent))?.state === 'ready', 'the agent to be ready to restart');
    await until(async () => (await verdictOf(shell))?.state === 'ready', 'the idle shell to be ready');

    // Cancel lifts the refusal.
    expect(await (await ctx.delete('/api/maintenance')).json()).toMatchObject({ ok: true, cancelled: true });
    expect((await status()).hold).toBeNull();
    await make(`maint-after-${Date.now()}`, {});
    // The session it had asked is told the restart is off.
    await until(async () => (await (await ctx.get(`/api/sessions/${agent}/scrollback`)).text()).includes('is called off'), 'the called-off notice');
  });

  test('a WORKING session is not told until its turn ends - never queued behind it', async () => {
    const agent = await make(`maint-busy-${Date.now()}`, { agent: 'claude', autoCommand: LAUNCH });
    await until(async () => (await rowOf(agent))?.agentReady === true, 'the agent to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(agent, 'UserPromptSubmit', { session_id: conv, prompt: 'long job' })).toBe(200);
    await until(async () => (await rowOf(agent))?.status === 'working', 'the agent to be working');
    expect((await ctx.post('/api/maintenance/prepare', { data: { reason: 'busy spec' } })).status()).toBe(200);
    // Several ticks pass; it stays untold while it works.
    await new Promise((r) => setTimeout(r, 7000));
    expect(await verdictOf(agent)).toMatchObject({ state: 'working', promptedAt: null });
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await verdictOf(agent))?.promptedAt, 'the prompt once the turn ended');
  });

  test('after the restart: the hold clears itself and the told session hears the machine is back', async () => {
    const agent = await make(`maint-back-${Date.now()}`, { agent: 'claude', autoCommand: LAUNCH });
    await until(async () => (await rowOf(agent))?.agentReady === true, 'the agent to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(agent, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(agent))?.status === 'idle', 'the agent to go idle');
    // What a cold restart leaves behind: a hold that told this session, recorded against a
    // process it no longer runs in. bootAt null leaves only the process signal to decide.
    const hold = {
      reason: 'back spec', startedAt: Date.now() - 60000, bootAt: null,
      sessions: { [agent]: { name: 'x', pid: 1, agent: 'claude', promptedAt: Date.now() - 50000, deliveredAt: null, answeredAt: null, tries: 1 } },
    };
    expect((await ctx.post('/api/test/maintenance-state', { data: { hold } })).status()).toBe(200);
    await until(async () => (await status()).hold === null, 'the hold to clear itself');
    await until(async () => {
      const sb = await (await ctx.get(`/api/sessions/${agent}/scrollback`)).text();
      return sb.includes('The machine is back');
    }, 'the back notice in the agent\'s terminal');
    await until(async () => (await status()).back === null, 'the back list to empty');
    // Nothing is refused any more.
    await make(`maint-back-after-${Date.now()}`, {});
  });

  test('a hold whose sessions all still run in their own processes is NOT a restart (hot reload)', async () => {
    const shell = await make(`maint-hot-${Date.now()}`, { autoCommand: '' });
    expect((await ctx.post('/api/maintenance/prepare', { data: { reason: 'hot spec' } })).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 4000));
    const s = await status();
    expect(s.hold).toMatchObject({ reason: 'hot spec' });
    expect(s.sessions.find((v) => v.id === shell)).toBeTruthy();
  });

  /** An agent session idle at its composer, with a finished turn behind it. */
  async function idleAgent(tag) {
    const agent = await make(`maint-${tag}-${Date.now()}`, { agent: 'claude', autoCommand: LAUNCH });
    await until(async () => (await rowOf(agent))?.agentReady === true, 'the agent to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(agent, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(agent))?.status === 'idle', 'the agent to go idle');
    return { agent, conv };
  }
  const answer = (data) => ctx.post('/api/maintenance/answer', { data });
  const scrollbackOf = async (id) => (await ctx.get(`/api/sessions/${id}/scrollback`)).text();

  test('#407: the answer route - strict input, and each answer drives the verdict (silence never agrees)', async () => {
    // Behind auth like its siblings (a route above the auth middleware would be PUBLIC).
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.post('/api/maintenance/answer', { data: { sessionId: 'x', answer: 'yes' } })).status()).toBe(401);
    await anon.dispose();
    // No hold: nothing to answer.
    expect((await answer({ sessionId: crypto.randomUUID(), answer: 'yes' })).status()).toBe(409);

    const { agent, conv } = await idleAgent('ans');
    const shell = await make(`maint-ans-shell-${Date.now()}`, { autoCommand: '' });
    expect((await ctx.post('/api/maintenance/prepare', { data: { reason: 'answer spec' } })).status()).toBe(200);
    await until(async () => (await verdictOf(agent))?.promptedAt, 'the question to be typed');
    const sb = await until(async () => { const t = await scrollbackOf(agent); return t.includes(TAG) ? t : null; }, 'the question in the terminal');
    expect(sb).toContain('A question, not an order');
    // Strict: an enum, a number for minutes, text for the reason, a tracked and asked session.
    expect((await answer({ sessionId: agent, answer: 'maybe' })).status()).toBe(400);
    expect((await answer({ sessionId: agent, answer: 'later', minutes: 'soon' })).status()).toBe(400);
    expect((await answer({ sessionId: agent, answer: 'no', reason: { a: 1 } })).status()).toBe(400);
    expect((await answer({ answer: 'yes' })).status()).toBe(400);
    expect((await answer({ sessionId: crypto.randomUUID(), answer: 'yes' })).status()).toBe(404);
    expect((await answer({ sessionId: shell, answer: 'yes' })).status()).toBe(409); // a shell is never asked
    expect((await verdictOf(agent)).answer).toBeNull();

    // The turn the question started ends WITHOUT an answer: not ready, and it says why.
    expect(await hook(agent, 'UserPromptSubmit', { session_id: conv, prompt: `${TAG} question` })).toBe(200);
    expect(await hook(agent, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await verdictOf(agent))?.answeredAt, 'the turn to end');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await verdictOf(agent)).toMatchObject({ state: 'answering', why: 'told; has not answered (yes, no or later)' });
    expect((await status()).safeToRestart).toBe(false);

    // no -> declined, with its reason, and the hold is not safe.
    expect(await (await answer({ sessionId: agent, answer: 'no', reason: 'mid long build' })).json()).toMatchObject({ ok: true, answer: 'no' });
    expect(await verdictOf(agent)).toMatchObject({ state: 'declined', answer: 'no', answerReason: 'mid long build' });
    expect((await verdictOf(agent)).why).toContain('mid long build');
    await until(async () => (await verdictOf(shell))?.state === 'ready', 'the idle shell to be ready');
    expect((await status()).safeToRestart).toBe(false);

    // later -> deferred, clamped to a sane number of minutes.
    expect(await (await answer({ sessionId: agent, answer: 'later', minutes: 1 })).json()).toMatchObject({ ok: true, answer: 'later', minutes: 5 });
    expect(await verdictOf(agent)).toMatchObject({ state: 'deferred', answer: 'later' });
    expect((await status()).safeToRestart).toBe(false);

    // yes, with its turn over and nothing running -> ready, and the hold is safe.
    expect((await answer({ sessionId: agent, answer: 'yes' })).status()).toBe(200);
    await until(async () => (await verdictOf(agent))?.state === 'ready', 'yes to make the agent ready');
    expect((await status()).safeToRestart).toBe(true);

    // The CLI reports the same answer with the session's own $WT_SESSION_ID.
    const { spawnSync } = require('child_process');
    const path = require('path');
    expect((await ctx.post('/api/cluster/client-token', { data: { label: 'maint-answer-cli-spec' } })).status()).toBe(200);
    const cli = (env, ...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'wt-maintenance.js'), ...a], {
      encoding: 'utf8', env: { ...process.env, WT_SESSION_PORT: new URL(BASE).port, ...env },
    });
    let r = cli({ WT_SESSION_ID: agent }, 'answer', 'no', '--reason', 'cli says no');
    expect(r.status, r.stderr).toBe(0);
    expect(await verdictOf(agent)).toMatchObject({ state: 'declined', answerReason: 'cli says no' });
    r = cli({ WT_SESSION_ID: agent }, 'answer', 'later', '--minutes', '45');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('45 min');
    expect(cli({ WT_SESSION_ID: '' }, 'answer', 'yes').status).toBe(2); // not inside a session
    expect(cli({ WT_SESSION_ID: agent }, 'answer', 'maybe').status).toBe(2);
    const text = cli({ WT_SESSION_ID: agent }, 'status');
    expect(text.stdout).toContain('answered later');
  });

  test('#407: a "later" whose time is up is asked again once the session is idle', async () => {
    const { agent } = await idleAgent('reask');
    const now = Date.now();
    const hold = {
      reason: 'reask spec', startedAt: Date.now() - 1000, bootAt: null,
      sessions: { [agent]: { name: 'x', pid: null, agent: 'claude', promptedAt: now - 60000, deliveredAt: now - 59000, answeredAt: now - 58000, tries: 1, asks: 1, answer: 'later', answerAt: now - 57000, until: now - 1000 } },
    };
    expect((await ctx.post('/api/test/maintenance-state', { data: { hold } })).status()).toBe(200);
    await until(async () => { const v = await verdictOf(agent); return v?.promptedAt > now && v.answer === null; }, 'the session to be asked again');
    expect(await verdictOf(agent)).toMatchObject({ state: 'answering', answer: null, answeredAt: null });
    await until(async () => (await scrollbackOf(agent)).includes('A question, not an order'), 'the second question in the terminal');
  });

  test('#407: a "later" that is not due yet is NOT asked again', async () => {
    const { agent } = await idleAgent('notyet');
    const now = Date.now();
    const hold = {
      reason: 'notyet spec', startedAt: Date.now() - 1000, bootAt: null,
      sessions: { [agent]: { name: 'x', pid: null, agent: 'claude', promptedAt: now - 60000, deliveredAt: now - 59000, answeredAt: now - 58000, tries: 1, asks: 1, answer: 'later', answerAt: now - 57000, until: now + 3600000 } },
    };
    expect((await ctx.post('/api/test/maintenance-state', { data: { hold } })).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 7000));
    expect(await verdictOf(agent)).toMatchObject({ state: 'deferred', promptedAt: now - 60000 });
    expect(await scrollbackOf(agent)).not.toContain('A question, not an order');
  });

  test('#407: cancel tells every session the hold had asked that the restart is off - when it is idle', async () => {
    const { agent } = await idleAgent('off-idle');
    const busy = await make(`maint-off-busy-${Date.now()}`, { agent: 'claude', autoCommand: LAUNCH });
    await until(async () => (await rowOf(busy))?.agentReady === true, 'the busy agent to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(busy, 'UserPromptSubmit', { session_id: conv, prompt: 'long job' })).toBe(200);
    await until(async () => (await rowOf(busy))?.status === 'working', 'the agent to be working');
    const never = await make(`maint-off-never-${Date.now()}`, { agent: 'claude', autoCommand: LAUNCH });
    await until(async () => (await rowOf(never))?.agentReady === true, 'the third agent to be ready');
    const now = Date.now();
    const entry = (over = {}) => ({ name: 'x', pid: null, agent: 'claude', promptedAt: now - 5000, deliveredAt: null, answeredAt: null, tries: 1, asks: 1, answer: null, ...over });
    const hold = {
      reason: 'off spec', startedAt: Date.now() - 1000, bootAt: null,
      sessions: { [agent]: entry({ answer: 'no' }), [busy]: entry(), [never]: entry({ promptedAt: null, tries: 0 }) },
    };
    expect((await ctx.post('/api/test/maintenance-state', { data: { hold } })).status()).toBe(200);
    expect(await (await ctx.delete('/api/maintenance')).json()).toMatchObject({ ok: true, cancelled: true });
    // The idle session hears it; the working one is not interrupted...
    await until(async () => (await scrollbackOf(agent)).includes('is called off'), 'the called-off notice in the idle session');
    await new Promise((r) => setTimeout(r, 4000));
    expect(await scrollbackOf(busy)).not.toContain('is called off');
    // ...but gets it as soon as its turn ends. The session the hold never asked hears nothing.
    expect(await hook(busy, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await scrollbackOf(busy)).includes('is called off'), 'the called-off notice once the turn ended');
    expect(await scrollbackOf(never)).not.toContain('is called off');
    expect(await scrollbackOf(agent)).not.toContain('The machine is back');
  });

  test('#406: a hold over NO sessions clears when it was made against another worker, and stays against this one', async () => {
    // What a cold restart leaves behind on an empty machine: a hold recorded against a
    // worker that is not the one answering now. No session can vote, bootAt is null.
    const old = { reason: 'empty spec', startedAt: Date.now() - 60000, bootAt: null, worker: { pid: 1, startedAt: 1 }, sessions: {} };
    expect((await ctx.post('/api/test/maintenance-state', { data: { hold: old } })).status()).toBe(200);
    await until(async () => (await status()).hold === null, 'the hold of another worker to clear itself');
    // A hold made now by prepare records THIS worker: ticks and status reads leave it alone.
    expect((await ctx.post('/api/maintenance/prepare', { data: { reason: 'same worker spec' } })).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 7000));
    expect((await status()).hold).toMatchObject({ reason: 'same worker spec' });
  });

  test('the CLI drives the same routes, and its exit code is the answer', async () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    // The CLI authenticates to the local server with a token from its api-tokens file -
    // the suite's own store (WT_API_TOKENS_FILE), so mint one there.
    expect((await ctx.post('/api/cluster/client-token', { data: { label: 'maint-cli-spec' } })).status()).toBe(200);
    const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'wt-maintenance.js'), ...a], {
      encoding: 'utf8', env: { ...process.env, WT_SESSION_PORT: new URL(BASE).port },
    });
    let r = cli('status');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('no restart hold');
    expect(cli('prepare').status).toBe(2); // a reason is required
    r = cli('prepare', 'cli', 'spec');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('restart hold "cli spec"');
    r = cli('status', '--json');
    expect([0, 1]).toContain(r.status);
    expect(JSON.parse(r.stdout).hold.reason).toBe('cli spec');
    r = cli('cancel');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('restart hold cancelled');
    expect((await status()).hold).toBeNull();
  });

  test('the routes are behind auth', async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.get('/api/maintenance/status')).status()).toBe(401);
    expect((await anon.post('/api/maintenance/prepare', { data: { reason: 'x' } })).status()).toBe(401);
    expect((await anon.delete('/api/maintenance')).status()).toBe(401);
    await anon.dispose();
  });
});
