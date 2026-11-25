// @ts-check
// #547 - a reported wait the person answered in ANOTHER session, on the real server: the parent's
// card in GET /api/mc/now says so (`maybeAnswered`, `answeredIn`) and POST /api/mc/tell tells the
// parent through the gated prompt. The rules (who counts, the fixed text, its byte cap) are pinned
// in mc-needs.spec.js; delivery to a real claude session is proven on the rig, never here: the
// sessions here are plain shells, so the gated prompt refuses (`no-agent`) and that refusal is
// what proves the message was ATTEMPTED and said so.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

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

test.describe('#547 Tell it: a wait answered in another session', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];
  test.beforeEach(async () => { ctx = await authCtx(); made = []; });
  test.afterEach(async () => {
    for (const id of made.reverse()) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
  });
  const newSession = async (name, extra = {}) => {
    const r = await ctx.post('/api/sessions', { data: { name: `${name}-${Date.now()}`, autoCommand: '', ...extra } });
    const id = (await r.json()).id;
    made.push(id);
    return id;
  };
  /** GET /api/mc/now until [pred] holds (the view is cached 3 s). */
  const nowUntil = (pred, what) => until(async () => { const b = await (await ctx.get('/api/mc/now')).json(); return pred(b) ? b : null; }, what);

  test('the route needs auth, a body and a card that is marked', async () => {
    const anon = await noAuthCtx();
    expect((await anon.post('/api/mc/tell', { data: { cardId: 'x' }, maxRedirects: 0 })).status()).toBe(401);
    await anon.dispose();
    expect((await ctx.post('/api/mc/tell', { data: {} })).status()).toBe(400);
    expect((await ctx.post('/api/mc/tell', { data: { cardId: 'alpha|nope|wait:1' } })).status()).toBe(404);
  });

  test('a prompt typed into the child after the parent\'s wait marks the parent\'s card; Tell it is attempted and its refusal said; an unmarked card is a 409', async () => {
    const parent = await newSession('mc-tell-parent');
    const child = await newSession('mc-tell-child', { parentId: parent });
    const lone = await newSession('mc-tell-lone');
    const ITEM = { ref: 'ado:5471', title: 'Route the audit port', state: 'in-progress' };
    const decision = { question: 'Release branch or master?', context: 'The child needs one.', options: [{ label: 'Release branch' }, { label: 'Master' }] };
    // A parent whose child still runs shows its ask only once its own turn has ENDED (lib/session-reason.js):
    // a turn, the report inside it, then its Stop.
    expect(await hook(parent, 'UserPromptSubmit', { prompt: 'start' })).toBe(200);
    await report(parent, { headline: 'h', items: [ITEM], wait: { on: 'you', what: 'Child question: PR route', ref: 'ado:5471', decision } });
    expect(await hook(parent, 'Stop', {})).toBe(200);
    await report(child, { headline: 'h', items: [ITEM] });
    await report(lone, { headline: 'h', items: [{ ref: 'ado:5472', title: 'Alone', state: 'in-progress' }], wait: { on: 'you', what: 'which colour?' } });
    // Before anyone typed into the child, the parent's card is plain.
    const before = await nowUntil((b) => b.answerNow.some((c) => c.sessionId === parent) && b.answerNow.some((c) => c.sessionId === lone), 'the cards');
    expect(before.answerNow.find((c) => c.sessionId === parent).answeredIn).toBeUndefined();
    // The owner answers in the child, after the wait was reported.
    await sleep(60);
    expect(await hook(child, 'UserPromptSubmit', { prompt: 'Use the release branch, as option 1' })).toBe(200);
    const after = await nowUntil((b) => (b.answerNow.find((c) => c.sessionId === parent) || {}).maybeAnswered === true, 'the mark');
    const card = after.answerNow.find((c) => c.sessionId === parent);
    expect(card).toMatchObject({ kind: 'decision', subjectKey: 'ado:5471', maybeAnswered: true, answeredIn: { sessionId: child } });
    expect(typeof card.answeredIn.at).toBe('number');
    // A card with nothing typed elsewhere is not told anything.
    const loneCard = after.answerNow.find((c) => c.sessionId === lone);
    expect(loneCard.answeredIn).toBeUndefined();
    expect((await ctx.post('/api/mc/tell', { data: { cardId: loneCard.id } })).status()).toBe(409);
    // Tell it: attempted through the gated prompt; a plain shell refuses (`no-agent`), said in words.
    const told = await ctx.post('/api/mc/tell', { data: { cardId: card.id } });
    expect(told.status()).toBe(200);
    const body = await told.json();
    expect(body).toMatchObject({ cardId: card.id, tell: { delivered: false, refused: 'no-agent', reason: expect.any(String) } });
  });
});
