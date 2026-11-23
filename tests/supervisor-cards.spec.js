// @ts-check
// #498 - supervisor cards: a card retires once its session is PROVEN gone, its reason is true,
// and it says in plain words who proposes what, to which session, and what Approve does.
// Pure: lib/supervisor-cases.js only (the end-to-end half is supervisor-cards-e2e.spec.js).
const { test, expect } = require('@playwright/test');
const cases = require('../lib/supervisor-cases');
const { buildGraph } = require('../lib/supervisor');

const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const cfg = cases.dispatcherConfig(null);

// Real card texts from the authority's log (2026-11-23), rewritten with no names, paths,
// hosts or ids. Each is a line the dispatcher wanted typed; the comment says what the old
// one-word matcher claimed about it.
const REAL = {
  // claimed "asks for merge or push a PR": it says the fix is NOT pushed
  notPushed: 'Replace "worker" (fresh): Resume from the worker\'s own hand-off. Fix abc1234 is committed locally, not pushed; start at the verifier. Report to the orchestrator.',
  // claimed "asks for something outward-facing": it says NOT to send it
  doNotSend: 'Supervisor: the go-ahead and the device test went to the owner as a card. Meanwhile you may build it locally so it is ready. Do not send it to the colleague, and make no write to a setting you have not identified, until the owner answers.',
  // claimed "asks for merge or push a PR": a pre-PR review is a review, not a PR
  prePr: 'Supervisor: your two questions went to the owner; they are his. Keep the fix where it is. Meanwhile confirm its pre-PR review line reads READY, then go on with the next item locally if you can; else park and report wait you.',
  // claimed "asks for merge or push a PR": it MENTIONS a push that already happened
  pushedOnce: 'As your stand-in lead: Stand-in lead here (your orchestrator is gone). Your item is complete: branch pushed once at abc1234. Batching into the main branch is not your step; the owner takes it from the work item. Make sure the item carries the branch, sha and notes, then report wait done and close out cleanly.',
  // claimed "asks for deleting data": "removing work items" is the owner's call it mentions
  removing: 'Supervisor: both went to the owner (a PR and removing work items are his). Keep the fix on its branch, nothing sent upstream. Meanwhile make sure the review on it reads READY, then go on locally if you can; else park and report wait you.',
  // claimed "asks for an install on a host" (first hit was "reset"): it really does ask for one
  install: 'Supervisor: no need to wait for the owner. The test phone has no lock screen and may be driven unattended: install the app there, open the dashboard and capture it. To match the other phone\'s width, set the size for the shot, then reset them.',
};

test.describe('#498 the "only the owner decides" reason is true', () => {
  test('a negated word is not a request: "not pushed", "do not send ... to"', () => {
    expect(cases.reservedMentions(REAL.notPushed)).toEqual([]);
    expect(cases.reservedMentions(REAL.doNotSend)).toEqual([]);
    expect(cases.reservedAction(REAL.notPushed)).toBeNull();
    // so a spawn whose note only says what is NOT done acts, unless spawn is in recommend mode
    expect(cases.verbDecision({ verb: 'wake', text: REAL.doNotSend, cfg }).mode).toBe('act');
  });

  test('a pre-PR review is a review, not a PR', () => {
    expect(cases.reservedMentions(REAL.prePr)).toEqual([]);
    expect(cases.verbDecision({ verb: 'wake', text: REAL.prePr, cfg }).mode).toBe('act');
  });

  test('a mention still makes a card, and the reason says MENTIONS and quotes the word', () => {
    const d = cases.verbDecision({ verb: 'lead', text: REAL.pushedOnce, cfg });
    expect(d.mode).toBe('card');
    expect(d.why).toBe('it mentions merge or push a PR ("pushed"), which only the owner decides');
    expect(d.why).not.toMatch(/asks for/);
    // every reserved thing it mentions is named, in RESERVED's order, each with its word
    expect(cases.reservedMentions(REAL.removing)).toEqual([
      { what: 'merge or push a PR', word: 'PR' }, { what: 'deleting data', word: 'removing' }]);
    expect(cases.reservedWhy(REAL.install)).toBe('it mentions deleting data ("reset") and an install on a host ("install"), which only the owner decides');
    expect(cases.reservedWhy(REAL.install, 'the note')).toMatch(/^the note mentions /);
  });

  test('a negation guards only the word right after it: the gate still fails closed', () => {
    for (const t of ['don\'t push yet, then merge it', 'not only push but merge', 'push it, not later', 'no PR needed, just push',
      'never mind that, push it', 'do not wait: delete the branch', 'without asking, install the MSI', 'it is not done; email the team']) {
      expect(cases.verbDecision({ verb: 'lead', text: t, cfg }).mode, t).toBe('card');
    }
    for (const t of ['do not push', 'never merge it yourself', 'nothing is posted', 'it was not deleted', 'don’t install anything',
      'without pushing', 'it has not been published']) {
      expect(cases.reservedMentions(t), t).toEqual([]);
    }
  });
});

test.describe('#498 a card retires once its session is proven gone', () => {
  const card = (n, over = {}) => ({ id: `cccc000${n}`, cls: 'wake', sessionId: id(n), server: 'alpha', name: `s${n}`, text: 't', at: 1, decision: null, ...over });
  const row = (n) => ({ id: id(n), name: `s${n}`, status: 'idle' });
  const servers = (alpha, beta = { name: 'beta', ok: true, sessions: [] }) => [{ name: 'alpha', ok: true, sessions: alpha }, beta];
  const CONFIRM = 1000;
  const step = (cards, srv, at, prev) => cases.cardRetirements({ cards, graph: buildGraph(srv, at), prev, confirmMs: CONFIRM });

  test('gone on two complete scans confirmMs apart: retired, "session gone"', () => {
    const cards = { a: card(1), b: card(2) };
    const s1 = step(cards, servers([row(2)]), 10000, {});
    expect(s1.retire).toEqual([]); // one scan is a suspicion, not a proof
    const s2 = step(cards, servers([row(2)]), 10000 + CONFIRM, s1.sightings);
    expect(s2.retire).toEqual([{ cardId: 'cccc0001', reason: 'session gone' }]);
  });

  test('its own server down is "cannot tell": nothing retires, the sighting is kept; another peer down proves nothing', () => {
    const cards = { a: card(1) };
    const s1 = step(cards, servers([]), 10000, {});
    // the card's OWN server down: cannot tell, and the first sighting stays as it was
    const ownDown = [{ name: 'alpha', ok: false }, { name: 'beta', ok: true, sessions: [] }];
    const s2 = step(cards, ownDown, 10000 + CONFIRM, s1.sightings);
    expect(s2.retire).toEqual([]);
    expect(s2.sightings).toEqual(s1.sightings);
    // another peer (a sleeping laptop) down while its own server answers: gone is gone
    const beta = servers([], { name: 'beta', ok: false, reason: 'timeout' });
    expect(step(cards, beta, 10000 + 2 * CONFIRM, s2.sightings).retire).toEqual([{ cardId: 'cccc0001', reason: 'session gone' }]);
    // ...but one answered scan with beta down is still only a suspicion
    expect(step(cards, beta, 10000, {}).retire).toEqual([]);
  });

  test('a replaced session retires its card at once, but only while its own server answered', () => {
    const repl = { id: id(9), name: 'new', status: 'idle', spawn: { replaces: [id(1)] } };
    expect(step({ a: card(1) }, servers([repl]), 10000, {}).retire).toEqual([{ cardId: 'cccc0001', reason: 'session replaced' }]);
    // the replacement lives elsewhere and the card's server did not answer: cannot tell
    const other = [{ name: 'alpha', ok: false }, { name: 'beta', ok: true, sessions: [repl] }];
    expect(step({ a: card(1) }, other, 10000, {}).retire).toEqual([]);
  });

  test('a live session, a decided card, an unknown server: never retired', () => {
    const cards = { a: card(1), b: card(2, { decision: 'dismiss' }), c: card(3, { server: 'gamma' }) };
    const s1 = step(cards, servers([row(1)]), 10000, {});
    const s2 = step(cards, servers([row(1)]), 10000 + CONFIRM, s1.sightings);
    expect(s2.retire).toEqual([]);
  });

  test('the fold: retired is a decision with its reason; Later hides a card until its time', () => {
    const f = cases.foldCases([
      { event: 'card', at: 1, card: card(1) }, { event: 'card', at: 1, card: card(2) }, { event: 'card', at: 1, card: card(3) },
      { event: 'retired', at: 5, cardId: 'cccc0001', reason: 'session gone' },
      { event: 'later', at: 6, cardId: 'cccc0002', until: 1000 },
    ]);
    expect(f.cards.cccc0001).toMatchObject({ decision: 'retire', outcome: 'session gone', decidedAt: 5 });
    expect(f.cards.cccc0002).toMatchObject({ decision: null, laterUntil: 1000 });
    expect(cases.ownerItems(f, 999).map((x) => x.key)).toEqual(['card|cccc0003']);
    expect(cases.ownerItems(f, 1000).map((x) => x.key)).toEqual(['card|cccc0002', 'card|cccc0003']);
    // a retired card is no dismissal: the class's record keeps them apart
    cases.foldCases([{ event: 'decided', at: 7, cardId: 'cccc0003', decision: 'send', outcome: 'delivered' }], f);
    expect(cases.autonomyRecord(cfg, f.cards).wake).toMatchObject({ approved: 0, dismissed: 0, retired: 1, edited: 1, pending: 1 });
  });
});

test.describe('#498 a card says who proposes what, to whom, and what Approve does', () => {
  test('each class names what Approve does, in plain words', () => {
    const v = (over) => cases.cardView({ id: 'cccc0001', cls: 'wake', sessionId: id(1), server: 'Office', name: 'worker', text: 'x', ...over }, null);
    expect(v({}).does).toBe(`Approve types the supervisor's message into "worker" on Office, once it is idle with nothing typed in its box.`);
    expect(v({ cls: 'close' }).does).toBe('Approve closes "worker" on Office: its work is done and its close-out is clean. Its conversation stays on disk and can be resumed.');
    expect(v({ cls: 'spawn', spawn: { fresh: true } }).does).toMatch(/^Approve starts a new session on Office in place of "worker", from a fresh start with the supervisor's note/);
    expect(v({ cls: 'spawn', spawn: { fresh: false } }).does).toMatch(/carries on its conversation/);
    expect(v({}).title).toBe('Wake it with a fact');
    expect(v({ cls: 'owner' }).title).toBe('Act on your behalf');
    expect(v({ cls: 'unknown-class' }).title).toBe('A proposal');
  });

  test('the target: its status, headline and first work items, from the session\'s live node', () => {
    const node = { id: id(1), status: 'idle', headline: 'fixing the parser', items: [{ ref: '#12', title: 'parser', state: 'in-progress' }, { ref: '#13', title: 'b', state: 'planning' }, { ref: '#14', title: 'c', state: 'done' }] };
    const k = cases.cardView({ id: 'cccc0001', cls: 'wake', sessionId: id(1), server: 'alpha', name: 'w', text: 'x' }, node);
    expect(k.target).toEqual({ status: 'idle', headline: 'fixing the parser', items: node.items.slice(0, 2) });
    expect(cases.cardView({ id: 'cccc0001', cls: 'wake', sessionId: id(1), server: 'alpha', name: 'w', text: 'x' }, null).target).toBeNull();
  });

  test('a refusal reads as plain words, never a bare code', () => {
    expect(cases.refusalText('session not found', 'Office')).toBe('That session no longer exists on Office: it was closed or replaced.');
    expect(cases.refusalText('unreachable', 'Office')).toBe('Office did not answer, so nothing was sent.');
    expect(cases.refusalText('draft')).toMatch(/unsent text in its box/);
    expect(cases.refusalText('not-idle')).toMatch(/working/);
    for (const code of ['busy', 'typing', 'capped', 'agent-gone', 'restart-hold', 'check-in', 'api-error', 'stale', 'worker-unavailable', 'no stored token', 'no-such-server', 'budget']) {
      const t = cases.refusalText(code, 'Office');
      expect(t, code).not.toBe(code);
      expect(t, code).toMatch(/\.$/);
    }
    // an unknown code is shown as itself, inside a sentence
    expect(cases.refusalText('weird-thing')).toBe('The session refused it (weird-thing).');
  });

  test('a note to the supervisor names the card it is about and fits the gated prompt', () => {
    const { TEXT_BYTES_MAX } = require('../lib/supervisor');
    const k = { id: 'cccc0001', cls: 'wake', sessionId: id(1), server: 'alpha', name: 'worker', text: 'x', why: 'it mentions deleting data ("drop"), which only the owner decides' };
    const t = cases.tellText(k, 'it is only a folder name', false);
    expect(t.text).toBe('The owner, on card cccc0001 (wake for "worker"): it is only a folder name');
    const d = cases.tellText(k, '', true).text;
    expect(d).toMatch(/^The owner, on card cccc0001 \(wake for "worker"\): do not ask me about cards like this again/);
    expect(cases.tellText(k, '', false)).toBeNull(); // nothing to say
    // A note that does not fit is refused in words, never cut: half a note is a different note.
    const long = cases.tellText(k, 'y'.repeat(2000), true);
    expect(long.text).toBeUndefined();
    expect(long.error).toMatch(/^The note is too long to send: shorten it by about \d+ characters\. Nothing was sent\.$/);
    const hebrew = cases.tellText(k, 'א'.repeat(300), false); // 2 bytes a letter: 600 bytes
    expect(hebrew.error).toBeTruthy();
    const most = cases.tellText(k, 'z'.repeat(TEXT_BYTES_MAX - Buffer.byteLength(t.text, 'utf8') + 'it is only a folder name'.length), false);
    expect(Buffer.byteLength(most.text, 'utf8')).toBe(TEXT_BYTES_MAX); // exactly full still goes
  });

  test('a note on a card the dispatcher proposed with its question names that case', () => {
    const k = { id: 'cccc0002', cls: 'owner', sessionId: id(1), server: 'alpha', name: 'worker', text: 'x', caseId: 'c1c1c1c1' };
    expect(cases.tellText(k, 'leave it', false).text).toBe('The owner, on card cccc0002 (owner for "worker", case c1c1c1c1): leave it');
  });
});

// The owner, on a rules escalation: "No question..." - it showed as "The supervisor asks: Session
// X is past its own checkBy..." with only "Open session". Real data (the authority, 14 days): 16
// rules escalations, 15 never delivered to the dispatcher (its own session busy), 12 went obsolete.
test.describe('#498 an escalation says what the owner is asked, and the supervisor looks first', () => {
  const MIN = 60 * 1000;
  const T0 = 1_800_000_000_000;
  const esc = (extra) => ({ question: 'q', at: T0, by: 'dispatcher', auto: false, cause: null, ...extra });
  const LINE = 'Session "w" is past its own checkBy (60 min) on "CI" (target ci, still unknown).';
  const kase = (extra) => ({ id: 'c1c1c1c1', rule: 'R3', sessionId: id(1), server: 'alpha', name: 'w', line: LINE,
    openedAt: T0, deliveredAt: null, takenAt: null, escalated: null, resolvedAt: null, ...extra });

  test('the cause of an escalation, also for one written before #498', () => {
    expect(cases.escalationCause(esc({}))).toBe('asked');
    expect(cases.escalationCause(esc({ auto: true, by: 'rules (dispatcher paused)' }))).toBe('blocked');
    expect(cases.escalationCause(esc({ auto: true, by: 'rules (not taken in 30 min: not-idle)' }))).toBe('untaken');
    expect(cases.escalationCause(esc({ auto: true, by: 'rules (dispatcher paused)', cause: 'untaken' }))).toBe('untaken'); // its own wins
    expect(cases.escalationCause(null)).toBeNull();
  });

  test('a case escalated only because the dispatcher never got to it is still handed over, once; no other escalation is', () => {
    const untaken = kase({ escalated: esc({ auto: true, cause: 'untaken' }) });
    expect(cases.caseDue(untaken, T0 + 20 * MIN)).toBe('deliver');
    expect(cases.caseDue({ ...untaken, deliveredAt: T0 + 10 * MIN }, T0 + 20 * MIN)).toBeNull(); // handed over: never escalated twice
    expect(cases.caseDue({ ...untaken, takenAt: T0 + 10 * MIN }, T0 + 20 * MIN)).toBeNull();
    expect(cases.caseDue(untaken, T0 + 31 * MIN)).toBeNull(); // past its second chance: the owner's
    expect(cases.caseDue(kase({ escalated: esc({ auto: true, cause: 'blocked' }) }), T0 + 90 * MIN)).toBeNull();
    expect(cases.caseDue(kase({ escalated: esc({ cause: 'asked' }) }), T0 + 90 * MIN)).toBeNull();
  });

  // The gate review: "checking" had no end. A case handed over and then ignored, or handed back
  // by the owner's Tell and ignored, or never deliverable, sat with nobody, for good.
  test('the supervisor looks first for one more window only: then the case is the owner\'s, saying why', () => {
    const MS = cases.CASE_UNTAKEN_MS;
    // never handed over (the dispatcher's session stayed busy): checking until escalation + window
    const busy = kase({ escalated: esc({ auto: true, cause: 'untaken', at: T0 }) });
    expect(cases.caseChecking(busy, T0 + MS)).toBe(true);
    expect(cases.caseChecking(busy, T0 + MS + 1)).toBe(false);
    expect(cases.caseOwnerView(busy, T0 + MS + 1)).toMatchObject({ checking: false,
      whyYou: 'The supervisor could not get to it in time (its own session stayed busy), so it is yours now.' });
    expect(cases.ownerItems({ cases: { x: busy }, cards: {} }, T0 + MS + 1).map((x) => x.key)).toEqual(['case|c1c1c1c1']);
    // handed over BEFORE it escalated, and ignored: it already had its turn - the owner's at once
    const ignored = kase({ deliveredAt: T0 - MS - 1, escalated: esc({ auto: true, cause: 'untaken', at: T0 }) });
    expect(cases.caseChecking(ignored, T0 + 1)).toBe(false);
    expect(cases.caseDue(ignored, T0 + 1)).toBeNull();
    expect(cases.caseOwnerView(ignored, T0 + 1).whyYou).toBe('The supervisor was handed it and did not act on it in time, so it is yours now.');
    // handed over on its second chance: the window runs from that hand-over
    const second = kase({ deliveredAt: T0 + 20 * MIN, escalated: esc({ auto: true, cause: 'untaken', at: T0 }) });
    expect(cases.caseChecking(second, T0 + 20 * MIN + MS)).toBe(true);
    expect(cases.caseChecking(second, T0 + 20 * MIN + MS + 1)).toBe(false);
    // the owner's Tell handed it back, and the dispatcher did not act: escalated again, the owner's
    const f = cases.foldCases([
      { event: 'open', case: kase({ id: 'e5e5e5e5' }) },
      { event: 'escalated', caseId: 'e5e5e5e5', question: 'x', by: 'rules (dispatcher paused)', auto: true, cause: 'blocked', at: T0 },
      { event: 'handed-back', caseId: 'e5e5e5e5', at: T0 + MIN },
    ]);
    const back = f.cases.e5e5e5e5;
    expect(cases.caseDue(back, T0 + MIN + MS + 1)).toBe('escalate');
    cases.foldCases([{ event: 'escalated', caseId: 'e5e5e5e5', question: 'x', by: 'rules (not taken)', auto: true, cause: 'untaken', at: T0 + MIN + MS + 1 }], f);
    expect(cases.caseChecking(back, T0 + MIN + MS + 2)).toBe(false);
    expect(cases.ownerItems(f, T0 + MIN + MS + 2).map((x) => x.key)).toEqual(['case|e5e5e5e5']);
    // a timeless call never hides a case
    expect(cases.caseChecking(busy, null)).toBe(false);
  });

  test('a new escalation is asked anew: an older Later does not hide it', () => {
    const f = cases.foldCases([
      { event: 'open', case: kase({ id: 'f6f6f6f6' }) },
      { event: 'escalated', caseId: 'f6f6f6f6', question: 'first', by: 'dispatcher', cause: 'asked', at: T0 },
      { event: 'later', caseId: 'f6f6f6f6', until: T0 + 600 * MIN },
      { event: 'escalated', caseId: 'f6f6f6f6', question: 'second', by: 'dispatcher', cause: 'asked', at: T0 + MIN },
    ]);
    expect(f.cases.f6f6f6f6.laterUntil).toBeNull();
    expect(cases.ownerItems(f, T0 + 2 * MIN).map((x) => x.what)).toEqual(['second']);
  });

  test("the owner's queue leaves out what the supervisor still looks at, and a case put off with Later", () => {
    const f = cases.foldCases([
      { event: 'open', case: kase({ id: 'a1a1a1a1' }) },
      { event: 'escalated', caseId: 'a1a1a1a1', question: 'x', by: 'rules (not taken in 30 min: typing)', auto: true, at: T0 },
      { event: 'open', case: kase({ id: 'b2b2b2b2' }) },
      { event: 'escalated', caseId: 'b2b2b2b2', question: 'x', by: 'rules (dispatcher paused)', auto: true, cause: 'blocked', at: T0 + 1 },
      { event: 'open', case: kase({ id: 'c3c3c3c3' }) },
      { event: 'escalated', caseId: 'c3c3c3c3', question: 'Which name?', by: 'dispatcher', cause: 'asked', at: T0 + 2 },
      { event: 'later', caseId: 'c3c3c3c3', until: T0 + 60 * MIN },
    ]);
    expect(cases.ownerItems(f, T0 + 5 * MIN).map((x) => x.key)).toEqual(['case|b2b2b2b2']);
    // ...and past the supervisor's window, the untaken one is the owner's too
    expect(cases.ownerItems(f, T0 + 61 * MIN).map((x) => x.key)).toEqual(['case|a1a1a1a1', 'case|b2b2b2b2', 'case|c3c3c3c3']);
  });

  test('Tell hands an escalated case back to the dispatcher: off the owner, Later cleared', () => {
    const f = cases.foldCases([
      { event: 'open', case: kase({ id: 'd4d4d4d4' }) },
      { event: 'escalated', caseId: 'd4d4d4d4', question: 'x', by: 'rules (dispatcher paused)', auto: true, cause: 'blocked', at: T0 },
      { event: 'later', caseId: 'd4d4d4d4', until: T0 + 60 * MIN },
      { event: 'handed-back', caseId: 'd4d4d4d4', at: T0 + 2 * MIN },
    ]);
    expect(f.cases.d4d4d4d4).toMatchObject({ escalated: null, deliveredAt: T0 + 2 * MIN, laterUntil: null, takenAt: null });
    expect(cases.ownerItems(f, T0 + 3 * MIN)).toEqual([]);
  });

  test('what the owner reads: a question says what is asked; a stuck case says what to do and why it reached you', () => {
    expect(cases.caseOwnerView(kase({}))).toBeNull();
    expect(cases.caseOwnerView(kase({ escalated: esc({ question: 'Merge PR 12 now?', cause: 'asked' }) })))
      .toMatchObject({ kind: 'question', title: 'The supervisor asks', ask: 'Merge PR 12 now?', checking: false });
    const blocked = cases.caseOwnerView(kase({ escalated: esc({ auto: true, by: 'rules (dispatcher capped)', question: LINE }) }));
    expect(blocked).toMatchObject({ kind: 'stuck', cause: 'blocked', title: 'It is not moving on', ask: cases.CASE_ASKS.R3, checking: false });
    expect(blocked.whyYou).toBe('The supervisor cannot look at it: it is at its usage limit, so nobody else will act on it.');
    expect(blocked.ask).not.toContain('checkBy'); // a thing to do, never the status fact
    const untaken = cases.caseOwnerView(kase({ escalated: esc({ auto: true, by: 'rules (not taken in 30 min)' }) }), T0 + MIN);
    expect(untaken).toMatchObject({ kind: 'stuck', cause: 'untaken', checking: true });
    for (const r of ['R2', 'R3', 'R4', 'R6', 'R7', 'R9']) {
      const v = cases.caseOwnerView(kase({ rule: r, escalated: esc({ auto: true, cause: 'blocked' }) }));
      expect(v.title, r).toBe(cases.CASE_TITLES[r]);
      expect(v.ask, r).toMatch(/^[A-Z].*\.$/);
    }
  });

  test("the owner's note to the dispatcher names the case and fits the gated prompt, or is refused", () => {
    const { text: t } = cases.caseTellText(kase({ name: 'w"$(x)' }), 'leave it,\nI am on it', 'wt-supervise.js', 460);
    expect(t).toBe('The owner, on case c1c1c1c1 (R3 for "w(x)"): leave it, I am on it The case is yours again. Read it: node "wt-supervise.js" case c1c1c1c1');
    expect(t).not.toContain('$(');
    // a line the note cannot rescue says so, rather than asking to shorten an empty note
    expect(cases.fitNote('h'.repeat(500), '', '', 460).error).toBe('The message about this item is too long to send, even with no note. Nothing was sent.');
    const long = cases.caseTellText(kase({}), 'leave it, I am on it '.repeat(40), 'wt-supervise.js', 460);
    expect(long.text).toBeUndefined();
    expect(long.error).toMatch(/^The note is too long to send: shorten it by about \d+ characters\. Nothing was sent\.$/);
  });
});
