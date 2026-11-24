// @ts-check
// #510 - the question routes on the real server: GET /api/mc/questions/:cardId/context at each
// level, POST .../followup and POST .../suggest, with auth on each, the 400s and 404s, and the
// one promise the issue makes: NOTHING here reaches the waiting session (its terminal never
// sees a follow-up or a suggestion). The model is the suite's fake CLI
// (tests/fixtures/fake-analyst-cli.js); the rules are pinned in mc-questions.spec.js. That a
// real claude session's transcript holds only the final pick is proven on the rig.
const fs = require('fs');
const path = require('path');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

const DIR = /** @type {string} */ (process.env.FAKE_ANALYST_DIR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runs() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.startsWith('run-')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
}
function resetFake() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
}

async function report(id, body) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/report`, { data: body, headers: { 'X-WT-Hook-Token': readHookToken() } });
  expect(r.status()).toBe(200);
  await c.dispose();
}

test.describe('#510 question routes', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string} */
  let id;
  /** @type {any} */
  let card;
  const FOLLOWUP = `followup-${Date.now()} how long would the rewrite take`;
  const enc = () => encodeURIComponent(card.id);

  test.beforeAll(async () => {
    ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: `mcq-${Date.now()}` } });
    expect(r.status()).toBe(200);
    id = (await r.json()).id;
    await report(id, {
      headline: 'choosing a login fix',
      items: [{ ref: 'acme/widgets#510', title: 'Question spec item', state: 'in-progress' }],
      wait: { on: 'you', what: 'which fix', decision: { question: 'Which fix?', context: 'Two ways.', recommended: 1,
        options: [{ label: 'Ship it as is', consequence: 'quick' }, { label: 'Rewrite auth', consequence: 'a day' }] } },
    });
    for (let i = 0; i < 40 && !card; i++) {
      if (i) await sleep(300);
      const body = await (await ctx.get('/api/mc/now')).json();
      card = (body.answerNow || []).find((c) => c.sessionId === id) || null;
    }
    expect(card).toMatchObject({ kind: 'decision' });
  });
  test.afterAll(async () => {
    await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  test('every route needs auth', async () => {
    const c = await noAuthCtx();
    expect((await c.get(`/api/mc/questions/${enc()}/context`, { maxRedirects: 0 })).status()).toBe(401);
    expect((await c.post(`/api/mc/questions/${enc()}/followup`, { data: { question: 'q' } })).status()).toBe(401);
    expect((await c.post(`/api/mc/questions/${enc()}/suggest`, { data: {} })).status()).toBe(401);
    await c.dispose();
  });

  test('a bad level or body is 400, a card that does not wait is 404 - and no model runs', async () => {
    resetFake();
    expect((await ctx.get(`/api/mc/questions/${enc()}/context?level=all`)).status()).toBe(400);
    expect((await ctx.post(`/api/mc/questions/${enc()}/followup`, { data: { question: '' } })).status()).toBe(400);
    expect((await ctx.post(`/api/mc/questions/${enc()}/followup`, { data: { question: 'q', option: 7 } })).status()).toBe(400);
    const gone = encodeURIComponent('alpha|no-such-session|wait:1');
    for (const r of [await ctx.get(`/api/mc/questions/${gone}/context`), await ctx.post(`/api/mc/questions/${gone}/followup`, { data: { question: 'q' } }),
      await ctx.post(`/api/mc/questions/${gone}/suggest`, { data: {} })]) {
      expect(r.status()).toBe(404);
      expect((await r.json()).error).toBeTruthy();
    }
    expect(runs()).toEqual([]);
  });

  test('the three levels: built from data, no model run', async () => {
    resetFake();
    const ask = await ctx.get(`/api/mc/questions/${enc()}/context`);
    expect(ask.status()).toBe(200);
    expect(ask.headers()['cache-control']).toContain('no-store');
    const a = await ask.json();
    expect(a).toMatchObject({ level: 'ask', cardId: card.id, generatedAt: expect.any(Number) });
    expect(a.sections.map((s) => s.title)).toEqual(['The ask', 'Recommendation']);
    expect(a.ask.options.map((o) => o.label)).toEqual(['Ship it as is', 'Rewrite auth']);
    expect(a.ask).toMatchObject({ kind: 'decision', recommended: 1, canSuggest: true });
    const c = await (await ctx.get(`/api/mc/questions/${enc()}/context?level=context`)).json();
    expect(c.sections.map((s) => s.title)).toEqual(expect.arrayContaining(['The work item', 'What the session did', 'Why it asks', 'What each answer does']));
    expect(c.text).toContain('choosing a login fix');
    const e = await (await ctx.get(`/api/mc/questions/${enc()}/context?level=everything`)).json();
    expect(e.sections.map((s) => s.title)).toEqual(expect.arrayContaining(['Last turns', 'Links']));
    expect(e.sections.find((s) => s.title === 'Links').body).toContain(id);
    expect(runs()).toEqual([]);
  });

  test('a follow-up is answered by the Analyst about one option; the session never sees it', async () => {
    resetFake();
    const r = await ctx.post(`/api/mc/questions/${enc()}/followup`, { data: { option: 1, question: FOLLOWUP } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ option: 1, model: 'sonnet', scope: { kind: 'session', id } });
    expect(body.answer).toContain('Fake answer');
    expect(body.sources.map((s) => s.id)).not.toContain('S999');
    for (const s of body.sources.filter((x) => x.sessionId)) expect(s.sessionId).toBe(id);
    const all = runs();
    expect(all).toHaveLength(1);
    const p = all[0].stdin;
    const nonce = /=== DATA ([0-9a-f]+) BEGIN ===/.exec(p)?.[1];
    const close = p.lastIndexOf(`=== DATA ${nonce} END ===`);
    // The card's own words inside the fence; the person's words after it, the option by number.
    expect(p.indexOf('option 2: "Rewrite auth"')).toBeLessThan(close);
    expect(p.slice(close)).toContain(`About option 2 of the waiting question`);
    expect(p.slice(close)).toContain(FOLLOWUP);
    // Nothing was typed into the session: its terminal never received the follow-up.
    await sleep(500);
    const sb = await ctx.get(`/api/sessions/${id}/scrollback`);
    expect(sb.status()).toBe(200);
    expect(await sb.text()).not.toContain('how long would the rewrite take');
  });

  test('suggest: new options only (one the card offers is dropped), and whether one can be sent', async () => {
    resetFake();
    const r = await ctx.post(`/api/mc/questions/${enc()}/suggest`, { data: {} });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.options.map((o) => o.label)).toEqual(['Fake option A', 'Fake option B']);
    expect(body).toMatchObject({ canSend: true, model: 'sonnet', generatedAt: expect.any(Number) });
    expect(body.sources.map((s) => s.id)).not.toContain('S999');
    expect(runs()).toHaveLength(1);
    const sb = await ctx.get(`/api/sessions/${id}/scrollback`);
    expect(await sb.text()).not.toContain('Fake option');
  });
});
