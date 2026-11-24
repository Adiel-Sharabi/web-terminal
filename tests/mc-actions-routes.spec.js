// @ts-check
// #522 - action waits on the real server: a "you" wait the person must DO is on My to-do
// (GET /api/mc/now `actions`), never in Answer now, and its Done (POST /api/mc/actions/done)
// tells the session through the gated prompt - refused on an unsent draft (#479), sent once
// the draft is gone, never twice. The rules are pinned in mc-needs.spec.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, AUTH, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
const TAG = '[web-terminal supervisor]';
// A launch that draws Claude's composer and its settle answer (#147/#404), so the session is ready.
const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
const BACKSPACE = String.fromCharCode(0x7f);
const ACTION = { on: 'you', kind: 'action', what: 'try on-duty on the new build', steps: ['Install the build', 'Start a shift'], where: 'phone' };

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
async function report(id, body) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/report`, { data: body, headers: { 'X-WT-Hook-Token': readHookToken() } });
  expect(r.status(), JSON.stringify(await r.json())).toBe(200);
  await c.dispose();
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

test.describe('#522 action waits: My to-do and Done', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];
  test.beforeEach(async () => { ctx = await authCtx(); made = []; });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
  });
  /** GET /api/mc/now until [pred] holds (the view is cached 3 s). */
  async function nowUntil(pred, what) {
    return until(async () => { const b = await (await ctx.get('/api/mc/now')).json(); return pred(b) ? b : null; }, what);
  }

  test('the Done route needs auth', async () => {
    const anon = await noAuthCtx();
    expect((await anon.post('/api/mc/actions/done', { data: { cardId: 'x' }, maxRedirects: 0 })).status()).toBe(401);
    await anon.dispose();
  });

  test('an action is on My to-do with its steps and where, never in Answer now; Done is tried, a refusal kept and said', async () => {
    const made1 = await ctx.post('/api/sessions', { data: { name: `mc-act-${Date.now()}`, autoCommand: '' } });
    const id = (await made1.json()).id;
    made.push(id);
    const other = (await (await ctx.post('/api/sessions', { data: { name: `mc-ask-${Date.now()}`, autoCommand: '' } })).json()).id;
    made.push(other);
    // #541: the action names its item (a card is never about the session's first item by default).
    await report(id, { headline: 'h', items: [{ ref: 'ado:5221', title: 'Try the build', state: 'in-progress' }], wait: { ...ACTION, ref: 'ado:5221' } });
    await report(other, { headline: 'h', wait: { on: 'you', what: 'pick a schema' } });
    const body = await nowUntil((b) => (b.actions || []).some((c) => c.sessionId === id) && b.answerNow.some((c) => c.sessionId === other), 'the two cards');
    expect(Object.keys(body).sort()).toEqual(['actions', 'answerNow', 'generatedAt', 'lines', 'moving', 'projects', 'todo']);
    expect(body.answerNow.some((c) => c.sessionId === id)).toBe(false);
    const card = body.actions.find((c) => c.sessionId === id);
    expect(card).toMatchObject({ kind: 'action', what: ACTION.what, hasQuestion: false, subjectKey: 'ado:5221', done: null,
      action: { steps: ACTION.steps, where: 'phone' }, why: { blocks: 1, text: 'blocks this session and 1 work item' } });
    expect(card.id).toMatch(new RegExp(`\\|${id}\\|action:\\d+$`));
    expect(Number.isInteger(card.rank) && card.rank >= 1).toBe(true);
    const ask = body.answerNow.find((c) => c.sessionId === other);

    // An action is never made a to-do (it is one); a question is never "done" here.
    expect((await ctx.post('/api/mc/todo', { data: { cardId: card.id } })).status()).toBe(409);
    expect((await ctx.post('/api/mc/actions/done', { data: { cardId: ask.id } })).status()).toBe(409);
    expect((await ctx.post('/api/mc/actions/done', { data: { cardId: 'alpha|nope|action:1' } })).status()).toBe(404);
    // An id that names an Object.prototype key is no record: 404, never "already".
    for (const cardId of ['constructor', '__proto__', 'toString']) {
      expect((await ctx.post('/api/mc/actions/done', { data: { cardId } })).status(), cardId).toBe(404);
    }
    expect((await ctx.post('/api/mc/actions/done', { data: {} })).status()).toBe(400);

    // Done: tried through the gated prompt (a plain shell refuses: no-agent), kept, and said.
    const r = await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } });
    expect(r.status()).toBe(200);
    expect((await r.json()).done).toEqual({ delivered: false, refused: 'no-agent', reason: 'no agent runs in it' });
    const after = await (await ctx.get('/api/mc/now')).json();
    expect(after.actions.find((c) => c.id === card.id).done).toMatchObject({ state: 'refused', refused: 'no-agent', reason: 'no agent runs in it' });
    // A refused Done may be pressed again: it is tried again.
    expect((await (await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } })).json()).done).toMatchObject({ refused: 'no-agent' });

    // Later hides it like any card.
    expect((await ctx.post('/api/mc/later', { data: { cardId: card.id, hours: 1 } })).status()).toBe(200);
    expect((await (await ctx.get('/api/mc/now')).json()).actions.some((c) => c.id === card.id)).toBe(false);
  });

  test('Done is refused on an unsent draft (#479), goes once the draft is gone, and is never sent twice', async () => {
    const cfgBefore = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
    // The typing gate counts from the last key: shorten it, so the only gate left is the draft.
    fs.writeFileSync(CFG_FILE, JSON.stringify({ ...(cfgBefore ? JSON.parse(cfgBefore) : {}), checkIn: { typingQuietMin: 0.01 } }, null, 2));
    await sleep(5500); // past LIVE_CONFIG_TTL
    let ws = null;
    try {
      const rowOf = async (sid) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === sid);
      const r0 = await ctx.post('/api/sessions', { data: { name: `mc-act-draft-${crypto.randomUUID().slice(0, 8)}`, agent: 'claude', autoCommand: LAUNCH } });
      const id = (await r0.json()).id;
      made.push(id);
      await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
      await report(id, { headline: 'h', items: [{ ref: 'ado:5222', title: 'Try the build', state: 'in-progress' }], wait: ACTION });
      const body = await nowUntil((b) => (b.actions || []).some((c) => c.sessionId === id), 'the action card');
      const card = body.actions.find((c) => c.sessionId === id);

      ws = await terminal(id);
      ws.send('half a thought');
      await sleep(1500); // past the (shortened) typing gate: only the draft is left to refuse
      const refused = await (await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } })).json();
      expect(refused.done).toEqual({ delivered: false, refused: 'draft', reason: 'it has unsent text in its prompt box' });
      expect(await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).not.toContain(TAG);

      // The person clears their line: Done goes through, once, with the fixed text.
      for (let i = 0; i < 'half a thought'.length; i++) { ws.send(BACKSPACE); await sleep(20); }
      await sleep(1500);
      // The subject screen carries the same Done record as My to-do (withDone): none yet.
      const subj = await (await ctx.get('/api/mc/subjects/ado:5222')).json();
      expect(subj.subject.needsYou).toMatchObject({ id: card.id, kind: 'action', done: { state: 'refused', refused: 'draft' } });
      // Two presses at once: ONE message (the record is on disk before any await), the other "already".
      const both = await Promise.all([0, 1].map(async () => (await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } })).json()));
      const dones = both.map((b) => b.done);
      expect(dones.filter((d) => d.delivered === true && !d.already)).toHaveLength(1);
      expect(dones.filter((d) => d.already === true)).toHaveLength(1);
      const line = `${TAG} [Mission Control] Done: ${ACTION.what}. The user did it; carry on.`;
      await until(async () => (await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).includes(line), 'the Done in the terminal');
      await sleep(1500);
      expect((await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).split(line).length - 1).toBe(1);
      // The Done ENDED the wait on the session's own server (a tagged prompt is a system turn:
      // nothing else would clear it, and the owner-wait push and the inbox would keep it).
      expect((await rowOf(id)).brief.wait).toBeNull();
      // Gone from My to-do; pressed again it is not sent again.
      expect((await (await ctx.get('/api/mc/now')).json()).actions.some((c) => c.id === card.id)).toBe(false);
      expect((await (await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } })).json()).done).toEqual({ delivered: true, already: true });
    } finally {
      if (ws) ws.close();
      fs.writeFileSync(CFG_FILE, cfgBefore === null ? '{}' : cfgBefore);
      await sleep(5500);
    }
  });

  test('a Done that cannot be recorded on disk is refused (500): nothing is sent or recorded', async () => {
    const STATE = process.env.WT_MC_STATE_FILE || path.join(__dirname, '..', 'mc-state.test.json');
    const id = (await (await ctx.post('/api/sessions', { data: { name: `mc-act-disk-${Date.now()}`, autoCommand: '' } })).json()).id;
    made.push(id);
    const aside = `${STATE}.aside-${Date.now()}`;
    let blocked = false;
    try {
      await report(id, { headline: 'h', wait: ACTION });
      const body = await nowUntil((b) => (b.actions || []).some((c) => c.sessionId === id), 'the action card');
      const card = body.actions.find((c) => c.sessionId === id);
      // A directory where the state file goes: the write (tmp + rename onto it) fails.
      if (fs.existsSync(STATE)) fs.renameSync(STATE, aside);
      fs.mkdirSync(STATE);
      blocked = true;
      const r = await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } });
      expect(r.status()).toBe(500);
      expect((await r.json()).error).toBe('could not record the Done');
      // Not recorded: the card is there as before, with no Done state.
      expect((await (await ctx.get('/api/mc/now')).json()).actions.find((c) => c.id === card.id).done).toBeNull();
      // Writable again: the Done is tried as the first time (a plain shell refuses it: no-agent), never "already".
      fs.rmdirSync(STATE);
      if (fs.existsSync(aside)) fs.renameSync(aside, STATE);
      blocked = false;
      const ok = await (await ctx.post('/api/mc/actions/done', { data: { cardId: card.id } })).json();
      expect(ok.done).toEqual({ delivered: false, refused: 'no-agent', reason: 'no agent runs in it' });
    } finally {
      if (blocked) {
        try { fs.rmdirSync(STATE); } catch { /* not there */ }
        if (fs.existsSync(aside)) fs.renameSync(aside, STATE);
      }
      try { fs.rmSync(`${STATE}.tmp`, { force: true }); } catch { /* best effort */ }
    }
  });
});
