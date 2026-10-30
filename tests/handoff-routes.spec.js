// @ts-check
// #340 — the hand-off, end to end against the real test server and worker. The rules
// are pinned in handoff.spec.js; this pins that the server APPLIES them: the board's
// rule gates the POST, the wrap-up is typed into the old session, the verdict route
// takes the hook token and a real brief file, a successor is created in the same folder
// and proven up by its own hook, and the old session closes ONLY on a clean verdict.
// Every failure path must leave the old session alive.
//
// The "agent" here is a bash session declared `claude` whose launch prints Claude's
// composer marker (#190: U+276F then U+00A0), so the worker reads it as ready exactly
// as it reads the real TUI. Hooks, the status line and the agent's posts are driven
// through the same routes Claude itself uses.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, readHookToken } = require('./test-helpers');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HANDOFF_DIR = process.env.WT_HANDOFF_DIR || path.join(__dirname, '..', 'handoffs.test');
// printf of the marker's UTF-8 bytes, then a word that makes the registry read the
// command as launching claude (lib/agents.js programMatcher).
const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";

async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post('/api/hook', {
    data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
  await c.dispose();
  return r.status();
}

async function agentPost(id, route, body, headers = { 'X-WT-Hook-Token': readHookToken() }) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/${route}`, { data: body, headers });
  const out = { status: r.status(), json: await r.json().catch(() => ({})) };
  await c.dispose();
  return out;
}

async function rows(ctx) { return (await ctx.get('/api/sessions')).json(); }
async function rowOf(ctx, id) { return (await rows(ctx)).find((s) => s.id === id); }

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** A Claude-declared session that has finished a turn, reported waiting on a third
 *  party, and sits at 60% of a 1M window. Only the idle time is short - `force` skips
 *  that judgement gate. */
async function bigIdleSession(ctx, name) {
  const r = await ctx.post('/api/sessions', { data: { name, agent: 'claude', autoCommand: LAUNCH } });
  expect(r.status()).toBe(200);
  const id = (await r.json()).id;
  await until(async () => (await rowOf(ctx, id))?.agentReady === true, 'the old session to be ready');
  const conv = crypto.randomUUID();
  expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
  expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
  const rep = await agentPost(id, 'report', { items: [{ ref: '#1', title: 'x', state: 'in-progress' }], wait: { on: 'external', what: 'PR review' } });
  expect(rep.status).toBe(200);
  const st = await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 80 } } });
  expect(st.status()).toBe(200);
  await until(async () => (await rowOf(ctx, id))?.status === 'idle', 'the old session to go idle');
  return id;
}

function writeBrief(id, text = '# brief\nnext: wait for the PR\n') {
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  fs.writeFileSync(path.join(HANDOFF_DIR, `handoff-${id}.md`), text);
}

test.describe('#340 hand-off — server', () => {
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];

  test.beforeEach(async () => { ctx = await authCtx(); made = []; });
  test.afterEach(async () => {
    // Sessions this test made, including any successor (named "<name> (2)").
    for (const s of await rows(ctx)) {
      if (made.some((n) => s.name === n || s.name === `${n} (2)`)) await ctx.delete(`/api/sessions/${s.id}`);
    }
    await ctx.dispose();
  });

  test('the row says why not; a POST obeys the same rule; force skips only judgement', async () => {
    const name = `handoff-gate-${Date.now()}`; made.push(name);
    const id = await bigIdleSession(ctx, name);
    const h = (await rowOf(ctx, id)).handoff;
    expect(h).toMatchObject({ suggest: false, why: 'recent', ctxTokens: 800000, run: null });
    const r = await ctx.post(`/api/sessions/${id}/handoff`, { data: {} });
    expect(r.status()).toBe(409);
    expect((await r.json()).why).toBe('recent');
    // While it runs, nothing else may start one.
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(200);
    const again = await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } });
    expect(again.status()).toBe(409);
    expect((await again.json()).why).toBe('in-progress');
  });

  test('a clean verdict: successor created in the same folder, proven up, old session closed', async () => {
    const name = `handoff-ok-${Date.now()}`; made.push(name);
    const id = await bigIdleSession(ctx, name);
    const old = await rowOf(ctx, id);
    const start = await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } });
    expect(start.status()).toBe(200);
    expect((await start.json()).handoff.state).toBe('wrapping');
    expect((await rowOf(ctx, id)).handoff.run.state).toBe('wrapping');

    // The verdict route: hook token only, a brief that exists, a well-formed verdict.
    expect((await agentPost(id, 'handoff-report', { canClose: true }, {})).status).toBe(401);
    const noBrief = await agentPost(id, 'handoff-report', { canClose: true });
    expect(noBrief.status).toBe(400);
    expect(noBrief.json.error).toMatch(/write the brief/);
    writeBrief(id);
    expect((await agentPost(id, 'handoff-report', { canClose: false })).status).toBe(400); // no why
    const ok = await agentPost(id, 'handoff-report', { canClose: true, why: 'all pushed' });
    expect(ok.status).toBe(200);
    // A second verdict is refused: the run has moved on.
    expect((await agentPost(id, 'handoff-report', { canClose: true })).status).toBe(409);

    const succ = await until(async () => (await rows(ctx)).find((s) => s.name === `${name} (2)`), 'the successor');
    expect(succ.cwd).toBe(old.cwd);
    expect(succ.agent).toBe('claude');
    expect(succ.autoCommand).toBe(LAUNCH);
    await until(async () => (await rowOf(ctx, id))?.handoff?.run?.state === 'verifying', 'the successor prompt');
    expect((await rowOf(ctx, id)).handoff.run.successorId).toBe(succ.id);

    // Proven up = the successor's own agent starts a turn.
    expect(await hook(succ.id, 'UserPromptSubmit', { session_id: crypto.randomUUID(), prompt: 'read the brief' })).toBe(200);
    await until(async () => !(await rowOf(ctx, id)), 'the old session to close');
    expect(await rowOf(ctx, succ.id)).toBeTruthy();
    // Written on the worker's sessionExited event, a moment AFTER the row leaves the list:
    // read at once it raced that under full-suite load.
    const closed = await until(async () =>
      (await (await ctx.get('/api/dashboard/closed')).json()).closed.find((c) => c.id === id), 'the closed record', 15000);
    expect(closed.handedOffTo).toEqual({ id: succ.id, name: `${name} (2)` });
  });

  test('a dirty verdict: the successor starts, the old session is KEPT and says why', async () => {
    const name = `handoff-kept-${Date.now()}`; made.push(name);
    const id = await bigIdleSession(ctx, name);
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(200);
    writeBrief(id);
    expect((await agentPost(id, 'handoff-report', { canClose: false, why: 'unpushed branch fix/x' })).status).toBe(200);
    const succ = await until(async () => (await rows(ctx)).find((s) => s.name === `${name} (2)`), 'the successor');
    await until(async () => (await rowOf(ctx, id))?.handoff?.run?.state === 'verifying', 'the successor prompt');
    expect(await hook(succ.id, 'UserPromptSubmit', { session_id: crypto.randomUUID(), prompt: 'go' })).toBe(200);
    const kept = await until(async () => {
      const r = await rowOf(ctx, id);
      return r?.handoff?.run?.state === 'kept' && r.handoff.run;
    }, 'the run to end kept');
    expect(kept).toMatchObject({ reason: 'unsaved-work', keptBecause: 'unpushed branch fix/x', successorId: succ.id });
    // Dismiss clears it; the session is still there.
    expect((await ctx.delete(`/api/sessions/${id}/handoff`)).status()).toBe(200);
    expect((await rowOf(ctx, id)).handoff.run).toBeNull();
  });

  test('a session prompted AFTER its verdict is kept, never killed', async () => {
    // The verdict comes from inside the wrap-up turn; a person may type into the old
    // session while the successor boots. Killing it then would lose that turn.
    const name = `handoff-inuse-${Date.now()}`; made.push(name);
    const id = await bigIdleSession(ctx, name);
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(200);
    writeBrief(id);
    expect((await agentPost(id, 'handoff-report', { canClose: true, why: 'all pushed' })).status).toBe(200);
    expect(await hook(id, 'UserPromptSubmit', { session_id: crypto.randomUUID(), prompt: 'one more thing' })).toBe(200);
    const succ = await until(async () => (await rows(ctx)).find((s) => s.name === `${name} (2)`), 'the successor');
    await until(async () => (await rowOf(ctx, id))?.handoff?.run?.state === 'verifying', 'the successor prompt');
    expect(await hook(succ.id, 'UserPromptSubmit', { session_id: crypto.randomUUID(), prompt: 'go' })).toBe(200);
    const kept = await until(async () => {
      const r = await rowOf(ctx, id);
      return r?.handoff?.run?.state === 'kept' && r.handoff.run;
    }, 'the run to end kept');
    expect(kept.reason).toBe('in-use');
    expect(await rowOf(ctx, id)).toBeTruthy();
  });

  test('cancel before closing: the run is gone and a late verdict is refused', async () => {
    const name = `handoff-cancel-${Date.now()}`; made.push(name);
    const id = await bigIdleSession(ctx, name);
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(200);
    expect((await ctx.delete(`/api/sessions/${id}/handoff`)).status()).toBe(200);
    expect((await rowOf(ctx, id)).handoff.run).toBeNull();
    writeBrief(id);
    expect((await agentPost(id, 'handoff-report', { canClose: true })).status).toBe(409);
    expect((await ctx.delete(`/api/sessions/${id}/handoff`)).status()).toBe(404);
    expect(await rowOf(ctx, id)).toBeTruthy();
  });

  test('#345 the server starts a hand-off ON ITS OWN, and a Cancel stands until a person types again', async () => {
    // The rule is the board's; only the idle gate is shortened here, through the live
    // config the server re-reads (LIVE_CONFIG_TTL), and restored at the end.
    const cfgFile = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
    const before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    const base = before ? JSON.parse(before) : {};
    fs.writeFileSync(cfgFile, JSON.stringify({ ...base, handoff: { idleMin: 0.001, autoEveryMs: 300 } }, null, 2));
    const logFile = path.join(HANDOFF_DIR, 'handoff-log.jsonl');
    const logOf = (id) => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('\n')
      .filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);
    const name = `handoff-auto-${Date.now()}`; made.push(name);
    try {
      const id = await bigIdleSession(ctx, name);
      const run = await until(async () => (await rowOf(ctx, id))?.handoff?.run, 'an automatic start', 20000);
      expect(run).toMatchObject({ state: 'wrapping', trigger: 'auto' });
      expect(logOf(id).find((l) => l.event === 'started')).toMatchObject({ trigger: 'auto', name, ctxTokens: 800000 });

      expect((await ctx.delete(`/api/sessions/${id}/handoff`)).status()).toBe(200);
      expect(logOf(id).find((l) => l.event === 'cancelled')).toBeTruthy();
      // Several scans later it has not started again...
      await new Promise((r) => setTimeout(r, 8000));
      expect((await rowOf(ctx, id)).handoff).toMatchObject({ suggest: true, run: null });
      // ...and a person typing into the session is what lifts that (a new turn that ends
      // back at a boundary). Same session, same config: only the prompt differs.
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'carry on' })).toBe(200);
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      expect((await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 80 } } })).status()).toBe(200);
      expect((await agentPost(id, 'report', { items: [{ ref: '#1', title: 'x', state: 'in-progress' }], wait: { on: 'external', what: 'PR review' } })).status).toBe(200);
      let last;
      const again = await until(async () => { last = await rowOf(ctx, id); return last?.handoff?.run; }, 'a second automatic start', 20000)
        .catch((e) => { throw new Error(`${e.message}: ${JSON.stringify({ status: last?.status, handoff: last?.handoff, reason: last?.reason })}`); });
      expect(again).toMatchObject({ state: 'wrapping', trigger: 'auto' });
      expect(again.startedAt).toBeGreaterThan(run.startedAt);
      expect((await ctx.delete(`/api/sessions/${id}/handoff`)).status()).toBe(200);
    } finally {
      // Never delete it: a missing file is skipped by _refreshLiveConfig, which would pin
      // the short idle gate in the server's cache for the rest of the run.
      fs.writeFileSync(cfgFile, before === null ? '{}' : before);
      // ...and let the cache (LIVE_CONFIG_TTL, 5s) expire before the next test.
      await new Promise((r) => setTimeout(r, 6000));
    }
  });  test('a plain shell has no hand-off at all', async () => {
    const name = `handoff-shell-${Date.now()}`; made.push(name);
    const r = await ctx.post('/api/sessions', { data: { name } });
    const id = (await r.json()).id;
    expect((await rowOf(ctx, id)).handoff).toBeNull();
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(409);
  });

  test('starting or cancelling a hand-off needs a login; a hook token is not one', async () => {
    // The first cut registered these two above the auth middleware, beside the agent's
    // token-only routes, so anyone who could reach the port could type into a session.
    const name = `handoff-auth-${Date.now()}`; made.push(name);
    const r = await ctx.post('/api/sessions', { data: { name, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(401);
    expect((await anon.delete(`/api/sessions/${id}/handoff`)).status()).toBe(401);
    const hooky = { headers: { 'X-WT-Hook-Token': readHookToken() } };
    expect((await anon.post(`/api/sessions/${id}/handoff`, { data: { force: true }, ...hooky })).status()).toBe(401);
    await anon.dispose();
  });

  test('the capability is advertised', async () => {
    const v = await (await ctx.get('/api/version')).json();
    expect(v.capabilities).toContain('session-handoff');
  });
});

test.describe('#340 both shapers carry `handoff`', () => {
  test('it is stamped by addSessionReasons, which both shapers call', () => {
    const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function addSessionReasons'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('r.handoff = handoffLib.handoffCandidate(');
    expect((SERVER_SRC.match(/addSessionReasons\((shaped|localShaped)\)/g) || []).length).toBe(2);
  });
});
