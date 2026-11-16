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
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(13);

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
      expect(row.composerDraft.release, 'text it follows: Ctrl-C clears it too').toBe('send-or-clear');
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

  test('Esc Esc may open Rewind: a CR does not end it, the agent\'s UserPromptSubmit does', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send(ESC); await sleep(100); ws.send(ESC); // two frames, as a person presses them
      await sleep(1500);
      expect(await (await prompt(id, 'first')).json()).toEqual({ delivered: false, refused: 'draft' });
      // A CR in the picker may confirm a message INTO the box: still held.
      ws.send(CR);
      await sleep(1500);
      expect(await (await prompt(id, 'second')).json()).toEqual({ delivered: false, refused: 'draft' });
      expect((await rowOf(id)).composerDraft?.release, 'the row says it is held, and only a sent prompt ends it').toBe('send');
      // The agent reports that CR submitted a prompt: the box is empty.
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'from the picker' })).toBe(200);
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
      await sleep(1500);
      expect((await rowOf(id)).composerDraft ?? null).toBeNull();
      expect(await (await prompt(id, 'third')).json()).toEqual({ delivered: true });
    } finally { ws.close(); }
  });

  test('the restart hold does not ask a session holding a draft; it asks once the line is cleared', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    const verdictOf = async () => (await (await ctx.get('/api/maintenance/status')).json()).sessions.find((s) => s.id === id);
    try {
      ws.send('x');
      await sleep(1500); // past the (shortened) typing gate
      expect((await ctx.post('/api/maintenance/prepare', { data: { reason: 'draft spec' } })).status()).toBe(200);
      await sleep(7000); // prepare ticks at once, then every 3 s: at least three chances to ask
      expect((await verdictOf())?.promptedAt ?? null, 'not asked over the draft').toBeNull();
      expect(await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).not.toContain('[web-terminal restart]');
      ws.send(BACKSPACE);
      await until(async () => (await verdictOf())?.promptedAt, 'the question once the box is empty');
    } finally {
      ws.close();
      await ctx.delete('/api/maintenance'); // a hold left on refuses every later session in the suite
    }
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
  // --- gate round 3 -------------------------------------------------------------------------
  const draftOf = async (id) => (await rowOf(id))?.composerDraft ?? null;

  test('a permission answered: its first key goes to the selector, text typed while the tool runs is a draft', async () => {
    const id = await idleAgent();
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'lint it' })).toBe(200);
    expect(await hook(id, 'PreToolUse', { session_id: conv, tool_name: 'Bash', tool_input: { command: 'npm run lint' } })).toBe(200);
    expect(await hook(id, 'PermissionRequest', { session_id: conv, tool_name: 'Bash' })).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'waiting', 'the session to wait on the permission');
    const ws = await terminal(id);
    try {
      ws.send('1'); // the approval: no hook fires, the session stays waiting while the tool runs
      await sleep(1500);
      expect(await draftOf(id), "the answer is the selector's, not a draft").toBeNull();
      ws.send('next, fix the lint'); // the person types on while the tool runs, and leaves
      await sleep(1500);
      expect((await rowOf(id)).status).toBe('waiting');
      expect(await draftOf(id), 'text typed after the answer is a draft').toBeTruthy();
    } finally { ws.close(); }
  });

  test('each waiting period\'s first key is its answer: a second permission is answered the same way', async () => {
    const id = await idleAgent();
    const conv = crypto.randomUUID();
    const ask = async () => {
      expect(await hook(id, 'PreToolUse', { session_id: conv, tool_name: 'Bash', tool_input: { command: 'npm test' } })).toBe(200);
      expect(await hook(id, 'PermissionRequest', { session_id: conv, tool_name: 'Bash' })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'waiting', 'the session to wait on the permission');
    };
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'test it' })).toBe(200);
    await ask();
    const ws = await terminal(id);
    try {
      ws.send('1');
      await sleep(500);
      expect(await hook(id, 'PostToolUse', { session_id: conv, tool_name: 'Bash' })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'working', 'the tool to finish');
      await ask();
      ws.send('1'); // the second approval, in a new waiting period
      await sleep(1500);
      expect(await draftOf(id), 'both answers went to their selectors').toBeNull();
    } finally { ws.close(); }
  });

  test('a plain shell has no composer: a command and Enter leave no draft', async () => {
    const r = await ctx.post('/api/sessions', { data: { name: `draft-shell-${crypto.randomUUID().slice(0, 8)}` } });
    const id = (await r.json()).id;
    made.push(id);
    const ws = await terminal(id);
    try {
      ws.send(`ls${CR}`);
      await sleep(300);
      ws.send('echo half');
      await sleep(1500);
      expect(await draftOf(id), 'no agent composer, so nothing is folded').toBeNull();
    } finally { ws.close(); }
  });

  test('a prompt arriving while the agent works (a nested claude -p) does not end a picker', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send(ESC); await sleep(100); ws.send(ESC); await sleep(100); ws.send(CR); // Rewind, a confirm
      await sleep(1500);
      expect(await draftOf(id)).toBeTruthy();
      const conv = crypto.randomUUID();
      expect(await hook(id, 'PreToolUse', { session_id: conv, tool_name: 'Bash', tool_input: { command: 'claude -p x' } })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'working', 'the session to work');
      expect(await hook(id, 'UserPromptSubmit', { session_id: crypto.randomUUID(), prompt: 'nested' })).toBe(200);
      await sleep(1500);
      expect(await draftOf(id), "a submit from another process is not this composer's").toBeTruthy();
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'from the picker' })).toBe(200);
      await until(async () => (await draftOf(id)) === null, "the picker to end on the idle session's submit");
    } finally { ws.close(); }
  });

  test('/clear: its SessionStart ends the picker its CR left', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send(`/clear${CR}`); // a / line: no UserPromptSubmit follows
      await sleep(1500);
      expect(await draftOf(id)).toBeTruthy();
      expect(await hook(id, 'SessionStart', { session_id: crypto.randomUUID(), source: 'clear' })).toBe(200);
      await until(async () => (await draftOf(id)) === null, 'the picker to end on SessionStart clear');
    } finally { ws.close(); }
  });

  test('an Enter that started no turn (#179 submitUnconfirmed) leaves the words a draft', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send(`hello${CR}`); // no UserPromptSubmit follows: the worker reports it after 8 s
      await sleep(1500);
      expect(await draftOf(id), 'a submit is assumed at first').toBeNull();
      await until(async () => (await draftOf(id)) !== null, 'the unconfirmed submit to read as a draft', 20000);
      expect(await (await prompt(id, 'over it')).json()).toEqual({ delivered: false, refused: 'draft' });
      // Gate 4: the hook was only late (a slow hook spawn): the agent's report empties the box.
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'hello' })).toBe(200);
      await until(async () => (await draftOf(id)) === null, 'the late submit to end the doubt');
    } finally { ws.close(); }
  });

  test('gate 5: a late submit report never erases keys typed after the Enter', async () => {
    const id = await idleAgent();
    const ws = await terminal(id);
    try {
      ws.send(`hello${CR}`); // no UserPromptSubmit yet: the worker reports it after 8 s
      await sleep(300);
      ws.send('next thing'); // typed before that report
      await sleep(11000); // past the worker's 8 s submit check
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'hello' })).toBe(200);
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
      await sleep(1500);
      expect(await draftOf(id), 'the words typed after the Enter are still in the box').toBeTruthy();
      expect(await (await prompt(id, 'over it')).json()).toEqual({ delivered: false, refused: 'draft' });
    } finally { ws.close(); }
  });

  test('gate 4: a fresh session\'s first prompt leaves no draft (its status is the worker\'s, not unknown)', async () => {
    const r = await ctx.post('/api/sessions', { data: { name: `draft-fresh-${crypto.randomUUID().slice(0, 8)}`, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    made.push(id);
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    const ws = await terminal(id); // no hook yet: the worker reads it 'active'
    try {
      // 'active' is at the composer: an idle Ctrl-C clears there (not only after a hook's 'idle').
      ws.send('half'); await sleep(100); ws.send(CTRL_C);
      await sleep(1500);
      expect(await draftOf(id), 'Ctrl-C cleared it').toBeNull();
      ws.send(`fix the build${CR}`);
      await sleep(300);
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'fix the build' })).toBe(200);
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
      await sleep(1500);
      expect(await draftOf(id), 'one prompt, sent: nothing held').toBeNull();
      expect(await (await prompt(id, 'your wait changed')).json()).toEqual({ delivered: true });
    } finally { ws.close(); }
  });

  test('gate 4: the server\'s own prompt that started no turn in time is not a person\'s draft', async () => {
    const id = await idleAgent();
    expect(await (await prompt(id, 'are you there')).json()).toEqual({ delivered: true });
    await sleep(11000); // past the worker's 8 s submit check, with no hook
    expect(await draftOf(id), 'the words in the box are ours').toBeNull();
  });
});
