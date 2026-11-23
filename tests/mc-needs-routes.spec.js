// @ts-check
// #506 - the Answer now / My to-do routes on the real server: GET /api/mc/now, POST
// /api/mc/todo, POST /api/mc/todo/:id and POST /api/mc/later, with auth on each. The rules
// (rank, why, which cards, what each action may do) are pinned in mc-needs.spec.js.
//
// The session here is a plain shell, so the gated prompt refuses the park message
// (`no-agent`): that is what lets this spec prove the message is ATTEMPTED once, recorded,
// and never sent again by itself. Delivery to a real claude session (ONE user turn in its
// transcript) is proven on the rig (scripts/rig), never here.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function report(id, body) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/report`, { data: body, headers: { 'X-WT-Hook-Token': readHookToken() } });
  expect(r.status()).toBe(200);
  await c.dispose();
}

/** GET /api/mc/now until [pred] holds (the view is cached 3 s). */
async function nowUntil(ctx, pred) {
  let body = null;
  for (let i = 0; i < 40; i++) {
    if (i) await sleep(300);
    const r = await ctx.get('/api/mc/now');
    expect(r.status()).toBe(200);
    body = await r.json();
    if (pred(body)) return body;
  }
  return body;
}

test.describe('#506 Answer now / My to-do routes', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90000);

  test('every new route needs auth', async () => {
    const ctx = await noAuthCtx();
    expect((await ctx.get('/api/mc/now', { maxRedirects: 0 })).status()).toBe(401);
    for (const url of ['/api/mc/todo', '/api/mc/todo/t-0123456789abcdef', '/api/mc/later']) {
      expect((await ctx.post(url, { data: {}, maxRedirects: 0 })).status(), url).toBe(401);
    }
    await ctx.dispose();
  });

  test('a reported wait is an Answer-now card; To my to-do moves it, the park is tried ONCE; done, reopen, back, later', async () => {
    const ctx = await authCtx();
    const made = await ctx.post('/api/sessions', { data: { name: `mc-needs-${Date.now()}`, autoCommand: '' } });
    expect(made.status()).toBe(200);
    const id = (await made.json()).id;
    try {
      await report(id, { headline: 'h', items: [{ ref: 'ado:4711', title: 'Try the build', state: 'in-progress' }], wait: { on: 'you', what: 'try the build on the desk' } });
      let body = await nowUntil(ctx, (b) => b.answerNow.some((c) => c.sessionId === id));
      expect(Object.keys(body).sort()).toEqual(['answerNow', 'generatedAt', 'moving', 'projects', 'todo']);
      const card = body.answerNow.find((c) => c.sessionId === id);
      expect(card).toMatchObject({ kind: 'wait', subjectKey: 'ado:4711', what: 'try the build on the desk', hasQuestion: false, decision: null,
        why: { blocks: 1, subjects: ['ado:4711'], text: 'blocks this session and 1 work item' } });
      expect(card.id).toMatch(new RegExp(`\\|${id}\\|wait:\\d+$`));
      expect(Number.isInteger(card.rank) && card.rank >= 1).toBe(true);
      expect(Number.isFinite(body.moving.total)).toBe(true);

      // Bad input is refused with the reason; a card that is not pending is 404.
      expect((await ctx.post('/api/mc/todo', { data: { cardId: '' } })).status()).toBe(400);
      expect((await ctx.post('/api/mc/todo', { data: { cardId: 'alpha|nope|wait:1' } })).status()).toBe(404);
      expect((await ctx.post('/api/mc/later', { data: { cardId: card.id, hours: 0 } })).status()).toBe(400);
      expect((await ctx.post('/api/mc/later', { data: { cardId: 'alpha|nope|wait:1', hours: 1 } })).status()).toBe(404);
      expect((await ctx.post('/api/mc/todo/t-0123456789abcdef', { data: { action: 'done' } })).status()).toBe(404);
      expect((await ctx.post('/api/mc/todo/not-an-id', { data: { action: 'done' } })).status()).toBe(404);

      // To my to-do: recorded, and the park message tried (a plain shell refuses it: no-agent).
      const first = await ctx.post('/api/mc/todo', { data: { cardId: card.id, text: 'try it at the desk' } });
      expect(first.status()).toBe(200);
      const f = await first.json();
      expect(f.parked).toEqual({ delivered: false, refused: 'no-agent', reason: 'no agent runs in it' });
      expect(f.todo).toMatchObject({ cardId: card.id, ref: 'ado:4711', text: 'try it at the desk', sessionId: id, doneAt: null,
        park: { state: 'refused', refused: 'no-agent' } });
      const todoId = f.todo.id;
      expect(todoId).toMatch(/^t-[0-9a-f]{16}$/);

      // Pressed again: the same to-do, and nothing sent again (its park time is unchanged).
      await sleep(20);
      const again = await (await ctx.post('/api/mc/todo', { data: { cardId: card.id } })).json();
      expect(again.todo.id).toBe(todoId);
      expect(again.parked).toMatchObject({ already: true, refused: 'no-agent' });
      expect(again.todo.park.at).toBe(f.todo.park.at);

      // It left Answer now and is on My to-do.
      body = await (await ctx.get('/api/mc/now')).json();
      expect(body.answerNow.some((c) => c.id === card.id)).toBe(false);
      expect(body.todo.map((t) => t.id)).toContain(todoId);

      // A refused park is retried only when the person asks.
      const retry = await (await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'park' } })).json();
      expect(retry.parked).toMatchObject({ delivered: false, refused: 'no-agent' });
      expect(retry.todo.park.at).toBeGreaterThan(f.todo.park.at);

      // Done, reopen; an unknown action is 400.
      expect((await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'nope' } })).status()).toBe(400);
      expect((await (await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'done' } })).json()).todo.doneAt).toBeGreaterThan(0);
      expect((await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'done' } })).status()).toBe(409);
      expect((await (await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'reopen' } })).json()).todo.doneAt).toBe(null);

      // Back to Answer now: the card is there again; moving it once more sends nothing new.
      expect((await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'back' } })).status()).toBe(200);
      body = await (await ctx.get('/api/mc/now')).json();
      expect(body.answerNow.some((c) => c.id === card.id)).toBe(true);
      expect(body.todo.some((t) => t.id === todoId)).toBe(false);
      const third = await (await ctx.post('/api/mc/todo', { data: { cardId: card.id } })).json();
      expect(third.todo.id).toBe(todoId);
      expect(third.parked.already).toBe(true);
      expect(third.todo.park.at).toBe(retry.todo.park.at);
      expect((await ctx.post(`/api/mc/todo/${todoId}`, { data: { action: 'back' } })).status()).toBe(200);

      // Later: hidden for the hours asked.
      const later = await ctx.post('/api/mc/later', { data: { cardId: card.id, hours: 2 } });
      expect(later.status()).toBe(200);
      const l = await later.json();
      expect(l.until - l.generatedAt).toBe(2 * 60 * 60 * 1000);
      body = await (await ctx.get('/api/mc/now')).json();
      expect(body.answerNow.some((c) => c.id === card.id)).toBe(false);
      expect(body.todo.some((t) => t.id === todoId)).toBe(false);

      // A new wait of the same session is a new card: neither the later nor the old to-do hides it.
      await report(id, { headline: 'h', wait: { on: 'you', what: 'and now this' } });
      body = await nowUntil(ctx, (b) => b.answerNow.some((c) => c.sessionId === id && c.what === 'and now this'));
      expect(body.answerNow.find((c) => c.sessionId === id).id).not.toBe(card.id);
    } finally {
      await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });
});
