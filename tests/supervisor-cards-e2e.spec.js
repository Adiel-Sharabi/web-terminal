// @ts-check
// #498 - supervisor cards end to end, on one isolated server that is its own lease authority:
// a card explains itself (title, what Approve does, the session's work item, a true reason);
// Edit-then-send types the owner's own text through the gated prompt; Later hides it; Tell the
// supervisor types the owner's note into the dispatcher; an Approve the session's own server
// refuses with "session not found" retires the card; and a card whose session is closed
// retires by itself once the scans prove it gone. Same rig and printf "agent" as
// supervisor-dispatcher.spec.js, never a real claude.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');
const { ROOT, sleep, until, startServer, bearer } = require('./supervisor-rig');

test.describe.serial('#498 supervisor cards explain themselves, offer more, and retire', () => {
  test.setTimeout(120000);
  const TAG = '[web-terminal supervisor]';
  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
  const port = 18220 + Math.floor(Math.random() * 40);
  const url = `http://127.0.0.1:${port}`;
  const tok = crypto.randomBytes(32).toString('hex');
  let dir; let S; let a;
  const hookToken = () => fs.readFileSync(path.join(ROOT, '.hook-token'), 'utf8').trim();
  const post = async (route, data, headers = {}) => {
    const c = await pwRequest.newContext({ baseURL: url });
    const r = await c.post(route, { data, headers: { 'X-WT-Hook-Token': hookToken(), ...headers } });
    const t = await r.text();
    await c.dispose();
    expect(r.status(), t).toBe(200);
  };
  const rows = async () => (await (await a.get('/api/sessions')).json());
  const state = async () => (await a.get('/api/supervisor/state')).json();
  const screen = async (id) => (await (await a.get(`/api/sessions/${id}/scrollback`)).json()).data || '';
  const cardOf = async (cid) => (await state()).cards.find((k) => k.id === cid);
  const decide = (cid, data) => a.post(`/api/supervisor/cards/${cid}`, { data });
  const report = async (id, wait) => {
    const conv = crypto.randomUUID();
    await post('/api/hook', { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'work' }, { 'X-WT-Session-ID': id });
    await post(`/api/session/${id}/report`, { items: [{ ref: '#7', title: 'the parser', state: 'in-progress' }], headline: 'fixing the parser', wait });
    await post('/api/hook', { hook_event_name: 'Stop', session_id: conv }, { 'X-WT-Session-ID': id });
    await until(async () => (await rows()).find((s) => s.id === id)?.status === 'idle', `${id} idle`);
  };
  /** An agent session that ran one turn reporting [wait], idle and in the supervisor's scan. */
  const turnWith = async (label, wait) => {
    const r = await a.post('/api/sessions', { data: { name: label, cwd: emptyCwd(label), agent: 'claude', autoCommand: LAUNCH } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).id;
    await until(async () => (await rows()).find((s) => s.id === id)?.agentReady === true, `${label} ready`);
    await report(id, wait);
    await until(async () => (await state()).sessions?.some((n) => n.id === id && n.headline === 'fixing the parser'), `${label} in the scan`);
    return id;
  };
  /** A card the dispatcher's verb makes: [text] mentions something only the owner decides. */
  const cardFor = async (id, text = 'merge the PR to master now') => {
    const r = await a.post('/api/supervisor/act', { data: { verb: 'lead', session: id, text } });
    expect(r.status(), await r.text()).toBe(200);
    const j = await r.json();
    expect(j.card, JSON.stringify(j)).toBeTruthy();
    return j.card;
  };
  const kill = async (id) => expect((await a.delete(`/api/sessions/${id}`)).ok()).toBe(true);

  test.beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt498-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'alpha', publicUrl: url, cluster: [{ name: 'alpha', url }], leases: { authority: 'alpha' },
      checkIn: { typingQuietMin: 0.01 }, supervisor: {},
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [tok]: { label: 'cards-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'cluster-tokens.json'), '{}');
    S = await startServer(dir, port, 'c498', { WT_SUPERVISOR_DISPATCHER_CMD: LAUNCH, WT_SUPERVISOR_MINUTE_MS: '300' });
    a = await bearer(S.base, tok);
  });
  test.afterAll(async () => {
    try { await a.dispose(); } catch { /* gone */ }
    try { await S.stop(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  let W;
  test('a card says what it proposes, what Approve does, to which work item, and a true reason', async () => {
    W = await turnWith('w498', { on: 'self', what: 'the tests' });
    const cid = await cardFor(W);
    const k = await cardOf(cid);
    expect(k).toMatchObject({ cls: 'lead', decision: null, title: 'Stand in for its lead' });
    expect(k.does).toBe(`Approve types the supervisor's message into "w498" on alpha, once it is idle with nothing typed in its box.`);
    expect(k.target).toMatchObject({ status: 'idle', headline: 'fixing the parser', items: [{ ref: '#7', title: 'the parser', state: 'in-progress' }] });
    expect(k.why).toBe('it mentions merge or push a PR ("merge"), which only the owner decides');
    // A negated mention is no request: typed at once, no card.
    await sleep(1500);
    const r = await (await a.post('/api/supervisor/act', { data: { verb: 'wake', session: W, text: 'the fix is not pushed yet; carry on with the tests' } })).json();
    expect(r.card).toBeUndefined();
    expect(r.delivered).toBe(true);
  });

  test('Edit, then send: the owner\'s own text is typed through the gated prompt, and closes the card', async () => {
    await sleep(1500); // the wake above was input: the typing quiet period
    const cid = await cardFor(W);
    expect((await decide(cid, { decision: 'send', text: 'a\nb' })).status()).toBe(400); // the gated prompt's own rule
    const r = await decide(cid, { decision: 'send', text: 'hold the merge until I look at it' });
    expect(r.status(), await r.text()).toBe(200);
    await until(async () => (await screen(W)).includes(`${TAG} hold the merge until I look at it`), 'the owner\'s text typed');
    expect(await screen(W)).not.toContain('merge the PR to master now');
    expect(await cardOf(cid)).toMatchObject({ decision: 'send', outcome: 'delivered' });
    // a decided card says so, in words
    const again = await decide(cid, { decision: 'approve' });
    expect(again.status()).toBe(409);
    expect((await again.json()).reason).toBe('This card was already answered with your own text.');
  });

  test('Later hides a card for some hours; it stays pending', async () => {
    const cid = await cardFor(W);
    expect((await decide(cid, { decision: 'later', hours: 0 })).status()).toBe(400);
    expect((await decide(cid, { decision: 'later', hours: 'x' })).status()).toBe(400);
    const r = await (await decide(cid, { decision: 'later', hours: 2 })).json();
    const k = await cardOf(cid);
    expect(k.decision).toBeNull();
    expect(k.laterUntil).toBe(r.laterUntil);
    expect(k.laterUntil - Date.now()).toBeGreaterThan(1.9 * 3600e3);
    await decide(cid, { decision: 'dismiss' });
  });

  test('Tell the supervisor: the note is typed into the dispatcher; refused in words while it is paused', async () => {
    // A case starts the dispatcher (a wait past its checkBy); its first turn must end before a prompt can reach it.
    await turnWith('w498r3', { on: 'self', what: 'the build', checkBy: 1 });
    const st = await until(async () => { const s = await state(); return s.dispatcher && s.dispatcher.id ? s : null; }, 'the dispatcher');
    const disp = st.dispatcher.id;
    await until(async () => (await rows()).some((s) => s.id === disp && s.agentReady), 'the dispatcher ready');
    await report(disp, { on: 'external', what: 'the next case' });
    const cid = await cardFor(W);
    expect((await decide(cid, { decision: 'tell' })).status()).toBe(400); // nothing to say
    await a.post('/api/supervisor/pause', { data: { paused: true } });
    const p = await decide(cid, { decision: 'tell', note: 'that merge is mine' });
    expect(p.status()).toBe(409);
    expect((await p.json()).reason).toBe('The supervisor is paused, so nothing would read the note. Nothing was sent.');
    expect((await cardOf(cid)).decision).toBeNull();
    await a.post('/api/supervisor/pause', { data: { paused: false } });
    await sleep(1500);
    const r = await decide(cid, { decision: 'tell', note: 'that merge is mine', dontAsk: true });
    expect(r.status(), await r.text()).toBe(200);
    await until(async () => (await screen(disp)).includes(`${TAG} The owner, on card ${cid} (lead for "w498"): do not ask me about cards like this again`), 'the note typed into the dispatcher');
    expect(await screen(disp)).toContain('that merge is mine');
    expect(await cardOf(cid)).toMatchObject({ decision: 'tell', outcome: 'told' });
  });

  test('an Approve refused because the session is gone retires the card, and says so in words', async () => {
    const G = await turnWith('w498gone', { on: 'self', what: 'the tests' });
    const cid = await cardFor(G);
    await kill(G);
    const r = await decide(cid, { decision: 'approve' });
    expect(r.status()).toBe(409);
    const j = await r.json();
    expect(j).toMatchObject({ delivered: false, refused: 'session not found', retired: true });
    expect(j.reason).toBe('That session no longer exists on alpha: it was closed or replaced. The card was retired.');
    expect(await cardOf(cid)).toMatchObject({ decision: 'retire', outcome: 'session gone' });
  });

  test('a card whose session was closed retires by itself, logged, once the scans prove it gone', async () => {
    const G = await turnWith('w498gone2', { on: 'self', what: 'the tests' });
    const cid = await cardFor(G);
    await kill(G);
    await until(async () => (await cardOf(cid)).decision === 'retire', 'the card retired', 20000);
    expect((await cardOf(cid)).outcome).toBe('session gone');
    const log = fs.readFileSync(path.join(dir, 'handoffs', 'supervisor-log.jsonl'), 'utf8');
    expect(log).toContain(`"event":"card-retired","cardId":"${cid}"`);
    // the record keeps a retired card apart from a dismissed one
    expect((await state()).autonomy.lead.retired).toBeGreaterThanOrEqual(2);
  });

  const caseAct = (cid, data) => a.post(`/api/supervisor/cases/${cid}`, { data });
  const caseOf = async (cid) => (await state()).cases.find((x) => x.id === cid);

  test('an escalated case says what you are asked; write, Later and a paused Tell answer it', async () => {
    const Y = await turnWith('w498you', { on: 'you', what: 'pick a name for the flag' });
    const c = await until(async () => (await state()).cases?.find((x) => x.sessionId === Y && x.rule === 'R4' && !x.resolvedAt), 'the R4 case');
    expect(c.owner).toBeNull(); // not escalated: nothing asks the owner yet
    // ...so the owner's answers are refused: the case is the supervisor's, and nothing is typed.
    for (const x of [{ action: 'write', text: 'too early' }, { action: 'later', hours: 2 }, { action: 'tell', note: 'too early' }]) {
      const early = await caseAct(c.id, x);
      expect(early.status(), x.action).toBe(409);
      expect((await early.json()).reason).toBe('The supervisor has this case, not you. Nothing was done.');
    }
    expect(await screen(Y)).not.toContain('too early');
    let r = await caseAct(c.id, { action: 'ask-owner', question: 'Which name should the flag get?' });
    expect(r.status(), await r.text()).toBe(200);
    expect((await caseOf(c.id)).owner).toMatchObject({ kind: 'question', cause: 'asked', title: 'The supervisor asks',
      ask: 'Which name should the flag get?', checking: false });
    r = await caseAct(c.id, { action: 'later', hours: 2 });
    expect(r.status()).toBe(200);
    expect((await caseOf(c.id)).laterUntil).toBe((await r.json()).laterUntil);
    await a.post('/api/supervisor/pause', { data: { paused: true } });
    r = await caseAct(c.id, { action: 'tell', note: 'call it fast-path' });
    await a.post('/api/supervisor/pause', { data: { paused: false } });
    expect(r.status()).toBe(409);
    expect((await r.json()).reason).toBe('The supervisor is paused, so nothing would read the note. Nothing was sent.');
    expect((await caseAct(c.id, { action: 'write', text: 'a\nb' })).status()).toBe(400); // the gated prompt's own rule
    await sleep(1500);
    r = await caseAct(c.id, { action: 'write', text: 'call the flag fast-path' });
    expect(r.status(), await r.text()).toBe(200);
    await until(async () => (await screen(Y)).includes(`${TAG} call the flag fast-path`), 'the owner\'s text typed');
    expect((await caseOf(c.id)).resolution).toMatchObject({ how: 'the owner wrote to the session' });
  });

  // The gate review: Tell on a card the dispatcher proposed with its question left that question
  // in front of the owner, though the note said the case was the supervisor's again.
  test('Tell on a card proposed with a question hands its case back: the note names it, the owner is no longer asked', async () => {
    const Y = await turnWith('w498ask', { on: 'you', what: 'pick a port' });
    const c = await until(async () => (await state()).cases?.find((x) => x.sessionId === Y && x.rule === 'R4' && !x.resolvedAt), 'the R4 case');
    const r = await caseAct(c.id, { action: 'ask-owner', question: 'Which port?', propose: { session: Y, text: 'use port 8080' } });
    expect(r.status(), await r.text()).toBe(200);
    const cid = (await r.json()).card;
    expect(cid).toBeTruthy();
    expect((await caseOf(c.id)).owner).toMatchObject({ kind: 'question' });
    const long = await decide(cid, { decision: 'tell', note: 'x'.repeat(600) });
    expect(long.status()).toBe(400); // never cut: refused, in words
    expect((await long.json()).reason).toMatch(/^The note is too long to send: shorten it by about \d+ characters\. Nothing was sent\.$/);
    await sleep(1500);
    const t = await decide(cid, { decision: 'tell', note: 'any free port is fine' });
    expect(t.status(), await t.text()).toBe(200);
    const disp = (await state()).dispatcher.id;
    await until(async () => (await screen(disp)).includes(`The owner, on card ${cid} (owner for "w498ask", case ${c.id}): any free port is fine`), 'the note names the case');
    const back = await caseOf(c.id);
    expect(back.escalated).toBeNull();
    expect(back.owner).toBeNull();
    expect(back.resolvedAt).toBeFalsy();
  });

  test('a case the rules escalate while the supervisor is paused is "stuck", saying what to do and why you', async () => {
    await a.post('/api/supervisor/pause', { data: { paused: true } });
    try {
      const B = await turnWith('w498stuck', { on: 'self', what: 'the deploy', checkBy: 1 });
      const c = await until(async () => (await state()).cases?.find((x) => x.sessionId === B && x.escalated), 'escalated', 20000);
      expect(c.escalated).toMatchObject({ auto: true, cause: 'blocked' });
      expect(c.owner).toMatchObject({ kind: 'stuck', cause: 'blocked', title: 'It is not moving on', checking: false,
        ask: 'Check whether it still has to wait. Write to it to carry on, or mark it as needing nothing.' });
      expect(c.owner.whyYou).toContain('it is paused');
    } finally {
      await a.post('/api/supervisor/pause', { data: { paused: false } });
    }
  });
});
