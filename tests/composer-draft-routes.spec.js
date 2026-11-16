// @ts-check
// #479 - against the real server: a person's unsent draft in the composer holds every prompt
// the server types on its own. The incident: stray keys ("  , ") left in a session's input
// box, then the supervisor's gated prompt typed `[tag] text` + CR behind them, so the agent
// received "  , [web-terminal supervisor] ..." - the person's keys sent, the tag no longer at
// the start. The rule is pinned in composer-draft.spec.js; this pins that the WS input path
// feeds it and that the gate and the row read it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, AUTH, authCtx, readHookToken } = require('./test-helpers');

const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
const TAG = '[web-terminal supervisor]';
// A launch that draws Claude's composer and its settle answer (#147/#404), so the session is ready.
const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
const BACKSPACE = String.fromCharCode(0x7f);
const CTRL_C = String.fromCharCode(3);

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
async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post('/api/hook', { data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
  await c.dispose();
  return r.status();
}
async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
/** A person's terminal: an ACTIVE socket (a background one's input is dropped by design). */
async function terminal(id) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: await rawCookie() } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ mode: 'active' }));
  await sleep(600);
  return ws;
}

test.describe('#479 an unsent draft holds the server\'s own prompts', () => {
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];
  /** @type {string|null} */
  let cfgBefore = null;
  const rowOf = async (id) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);

  test.beforeEach(async () => {
    ctx = await authCtx(); made = [];
    cfgBefore = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
    // The typing gate counts from the server's start and from the last key: shorten it, so the
    // only gate left standing is the draft (supervisor-routes.spec.js does the same).
    fs.writeFileSync(CFG_FILE, JSON.stringify({ ...(cfgBefore ? JSON.parse(cfgBefore) : {}), checkIn: { typingQuietMin: 0.01 } }, null, 2));
    await sleep(5500); // past LIVE_CONFIG_TTL
  });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
    fs.writeFileSync(CFG_FILE, cfgBefore === null ? '{}' : cfgBefore);
    await sleep(5500);
  });

  /** An agent session, ready and idle after one turn. */
  async function idleAgent() {
    const r = await ctx.post('/api/sessions', { data: { name: `draft-${crypto.randomUUID().slice(0, 8)}`, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    made.push(id);
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
    return id;
  }
  const prompt = (id, text) => ctx.post(`/api/sessions/${id}/prompt`, { data: { text } });

  test('stray keys left unsent: the gated prompt is refused "draft", and the row says a draft is waiting', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      // The incident's keys, one per frame as a terminal sends them, and no Enter.
      for (const k of [' ', ' ', ',', ' ']) { ws.send(k); await sleep(50); }
      await sleep(1500); // past the (shortened) typing gate: only the draft is left to refuse
      const r = await prompt(id, 'your wait changed');
      expect(r.status()).toBe(409);
      expect(await r.json()).toEqual({ delivered: false, refused: 'draft' });
      const row = await rowOf(id);
      expect(row.composerDraft, 'the row tells the owner a draft is waiting').toBeTruthy();
      expect(Number.isFinite(row.composerDraft.since)).toBe(true);
      // Nothing of ours reached the terminal.
      expect(await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).not.toContain(TAG);

      // The person clears their line (four Backspaces): the prompt goes through, and is ours alone.
      for (let i = 0; i < 4; i++) { ws.send(BACKSPACE); await sleep(50); }
      await sleep(1500);
      expect((await rowOf(id)).composerDraft ?? null).toBeNull();
      const d = await prompt(id, 'your wait changed');
      expect(d.status()).toBe(200);
      expect(await d.json()).toEqual({ delivered: true });
      await until(async () => (await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).includes(`${TAG} your wait changed`), 'the prompt in the terminal');
    } finally { ws.close(); }
  });

  test('Ctrl-C at an idle composer clears the draft; a submitted line leaves none', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send('half a thought');
      await sleep(1500);
      expect(await (await prompt(id, 'first')).json()).toEqual({ delivered: false, refused: 'draft' });
      ws.send(CTRL_C);
      await sleep(1500);
      expect(await (await prompt(id, 'second')).json()).toEqual({ delivered: true });
    } finally { ws.close(); }
  });

  test('the hand-off button refuses to type its wrap-up over a draft, and says why', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send('not sent yet');
      await sleep(1500);
      const r = await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } });
      expect(r.status()).toBe(409);
      expect((await r.json()).why).toBe('draft');
    } finally { ws.close(); }
  });
});
