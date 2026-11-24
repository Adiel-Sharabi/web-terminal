// @ts-check
// #526 - the backstop for a question a session wrote in its reply but did not report
// (lib/unreported-ask.js, lib/session-brief.js applyPossibleAsk, lib/mc-needs.js). Pure.
//
// The sentences below are SYNTHETIC, written in the shapes real replies used (the real ones
// name sessions and projects and stay out of the repo); the numbers on real replies are in the PR.
const { test, expect } = require('@playwright/test');
const U = require('../lib/unreported-ask');
const B = require('../lib/session-brief');
const M = require('../lib/mc-subjects');
const N = require('../lib/mc-needs');
const Q = require('../lib/mc-questions');

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const NOW = T0 + 60 * MIN;
const tldr = (s) => `Did a lot of work, details above.\n\n## TL;DR\n${s}`;

test.describe('#526 the rule: does the END of a reply ask the owner for something?', () => {
  const ASKS = [
    ['a count of questions still waiting', tldr('The fix is merged. Three earlier questions still need your answer: the flag name, the rollout order and the alert owner.')],
    ['a question left for the owner', tldr('I changed no code and left the owner one question about tagging the item.')],
    ['a question in the TL;DR', tldr('The check is in. Should it skip the update or block it when the client has no signature?')],
    ['a question closing a reply with no TL;DR', 'The patch is in your Downloads folder as a ZIP.\n\nAfter installing it, re-download the cards.\n\nCan I commit and push the fix branch so it is not lost again?'],
    ['one decision for the owner', tldr('The one decision for the owner is whether to grant the agent access to the backup folder.')],
    ['held until an answer', tldr('The fix stays local until the owner answers.')],
    ['its question is with someone', tldr('Its question is with the owner, so the item stays open.')],
    ['a please-confirm', tldr('Built. Please confirm the port before I continue.')],
    ['tell me if', tldr('Tell me if you want that or want to keep the account.')],
    ['your call', tldr('Both work; it is your call which ships first.')],
    ['needs a decision', tldr('The branch needs someone to decide whether to push it.')],
    ['decisions waiting on you', tldr('Two decisions are waiting for you in the inbox.')],
  ];
  for (const [name, reply] of ASKS) {
    test(`asks: ${name}`, () => {
      const q = U.findUnreportedAsk(reply);
      expect(q, reply).toBeTruthy();
      // It quotes ONE sentence of the end, never the whole reply.
      expect(q.length).toBeLessThanOrEqual(U.QUOTE_MAX);
      expect(reply).toContain(q.replace(/…$/, ''));
    });
  }

  const QUIET = [
    ['a plain result', tldr('Built and tested; every spec passes.')],
    ['an offer the owner can ignore', tldr('Merged. Want me to also run the full suite?')],
    ['an offer in other words', tldr('Merged. I can also add a test if you like me to.')],
    ['nothing needs the owner', tldr('Deployed. Nothing needs your input right now.')],
    ['no open questions', tldr('Done. No open questions remain.')],
    ['a question in the body the TL;DR does not repeat', 'Why did it fail? Because the cache was cold.\n\nI fixed that.\n\n## TL;DR\nIt failed on a cold cache and is fixed.'],
    ['a question inside a code fence', tldr('Run it.\n```\nwhy is this null?\n```\nAll green.')],
    ['a question quoted from inline code', tldr('The log said `did you mean x?` and it was ignored.')],
    ['a question for a third party, not the owner', tldr('The spec marks that rule as a question for management.')],
    ['a gate waiting on a tool', tldr('The review is running and the push waits until it approves.')],
    ['an empty reply', ''],
  ];
  for (const [name, reply] of QUIET) {
    test(`quiet: ${name}`, () => {
      expect(U.findUnreportedAsk(reply), reply).toBeNull();
    });
  }

  test('only the END is read: the TL;DR, else the last paragraph', () => {
    expect(U.tailOf('body\n\n## TL;DR\nthe summary')).toBe('the summary');
    expect(U.tailOf('first paragraph\n\nlast paragraph')).toBe('last paragraph');
    expect(U.tailOf('a\r\n\r\nb\r\n')).toBe('b');
    expect(U.tailOf('')).toBe('');
    // The last summary heading wins when a reply quotes an earlier one.
    expect(U.tailOf('## TL;DR\nold\n\n## TL;DR\nnew')).toBe('new');
  });

  test('a long quoted sentence is cut at a word, never mid-word', () => {
    const q = U.findUnreportedAsk(tldr(`Which of these ${'wonderful '.repeat(60)}options do you want?`));
    expect(q.length).toBeLessThanOrEqual(U.QUOTE_MAX);
    expect(q.endsWith('…')).toBe(true);
    expect(q).toMatch(/ wonderful…$/);
  });
});

test.describe('#526 is the sentence already on the board?', () => {
  const asks = [{ question: 'Which database should the migration use?', context: 'sqlite is simpler, postgres scales', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
  test('covered by an ask about the same thing, by a `you` wait, and not by an unrelated one', () => {
    expect(U.coveredBy('Which database should the migration use?', asks, null)).toBe(true);
    expect(U.coveredBy('Should I pick sqlite or postgres for the migration database?', asks, null)).toBe(true);
    expect(U.coveredBy('Can I rename the release flag?', asks, null)).toBe(false);
    expect(U.coveredBy('Can I rename the release flag?', [], null)).toBe(false);
    const wait = { on: 'you', what: 'say go to rename the release flag' };
    expect(U.coveredBy('Can I rename the release flag?', [], wait)).toBe(true);
    // A wait on something else says nothing about this sentence.
    expect(U.coveredBy('Can I rename the release flag?', [], { on: 'external', what: 'rename the release flag' })).toBe(false);
    expect(U.coveredBy('', asks, null)).toBe(false);
  });

  // The same question in another tense or number is the same question: the sentence a reply
  // ends on rarely repeats the ask's words letter for letter ("remove" / "removed", "releases").
  test('an inflected form of the ask\'s words still covers it; a different topic does not', () => {
    const a = [{ question: 'Remove the old endpoint, or keep it for a release?', context: 'clients may still call it', options: [{ label: 'remove' }, { label: 'keep' }] }];
    expect(U.coveredBy('Should the old endpoint be removed or kept for a release?', a, null)).toBe(true);
    expect(U.coveredBy('Should the old endpoints be removed in the next releases?', a, null)).toBe(true);
    expect(U.coveredBy('Should the retry limit be raised to five attempts?', a, null)).toBe(false);
  });
});

test.describe('#526 the brief carries a possible unreported question until it is on the board or answered', () => {
  const reported = (body = {}) => B.applyReport(B.emptyEntry(), { items: [{ ref: 'ado:7', title: 'Seven', state: 'in-progress' }], headline: 'h', wait: null, ...body }, T0);
  const asked = 'Can I rename the release flag?';

  test('a reply that asks sets it; a later reply that asks nothing clears it; reporting off hides it', () => {
    let e = reported();
    e = B.applyPossibleAsk(e, tldr(asked), T0 + MIN);
    expect(B.buildBrief(e, { reporting: true }).possibleAsk).toEqual({ text: asked, at: T0 + MIN });
    expect(B.buildBrief(e, { reporting: false }).possibleAsk).toBeNull();
    expect(B.buildBrief(B.emptyEntry(), { reporting: true }).possibleAsk).toBeNull();
    // The same question asked again keeps the time it was first seen: it is one card.
    const again = B.applyPossibleAsk(e, tldr(asked), T0 + 5 * MIN);
    expect(B.buildBrief(again, { reporting: true }).possibleAsk.at).toBe(T0 + MIN);
    // Another reply, with nothing asked.
    e = B.applyPossibleAsk(e, tldr('All done.'), T0 + 6 * MIN);
    expect(B.buildBrief(e, { reporting: true }).possibleAsk).toBeNull();
    expect(e.possibleAsk).toBeUndefined();
  });

  test('an ask or a `you` wait that covers it takes its place - at once, and for good', () => {
    let e = B.applyPossibleAsk(reported(), tldr(asked), T0 + MIN);
    expect(B.buildBrief(e, { reporting: true }).possibleAsk).not.toBeNull();
    // Reported as an ask afterwards: the card for the ask is the one that shows.
    e = B.applyReport(e, B.validateReport({ asks: [{ question: 'Rename the release flag?', context: 'the old name is confusing', options: [{ label: 'rename' }, { label: 'keep' }] }] }, e).report, T0 + 2 * MIN);
    expect(B.buildBrief(e, { reporting: true }).possibleAsk).toBeNull();
    // Reported as a `you` wait.
    const w = B.applyReport(B.applyPossibleAsk(reported(), tldr(asked), T0 + MIN),
      B.validateReport({ wait: { on: 'you', what: 'rename the release flag?' } }, reported()).report, T0 + 2 * MIN);
    expect(B.buildBrief(w, { reporting: true }).possibleAsk).toBeNull();
    // A wait on something else, or a report that says nothing about it, leaves it.
    const x = B.applyReport(B.applyPossibleAsk(reported(), tldr(asked), T0 + MIN),
      B.validateReport({ wait: { on: 'external', what: 'CI' } }, reported()).report, T0 + 2 * MIN);
    expect(B.buildBrief(x, { reporting: true }).possibleAsk).not.toBeNull();
  });

  test('the owner typing into the session ends it; a turn nobody typed does not', () => {
    let e = B.applyPossibleAsk(reported(), tldr(asked), T0 + MIN);
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: '<task-notification><task-id>x</task-id></task-notification>' }, T0 + 2 * MIN);
    expect(B.buildBrief(e, { reporting: true }).possibleAsk).not.toBeNull();
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: 'yes, rename it' }, T0 + 3 * MIN);
    expect(B.buildBrief(e, { reporting: true }).possibleAsk).toBeNull();
  });

  test('a reply read for a session that is not reporting, or that has no report at all, sets nothing', () => {
    expect(B.applyPossibleAsk(B.emptyEntry(), tldr(asked), T0)).toEqual(B.emptyEntry());
  });
});

test.describe('#526 a possible unreported question as an Answer-now card', () => {
  function row(server, { id = 'u-0000-4000-8000-000000000001', name = 'lead', status = 'idle', reason = { kind: 'done', text: '' }, wait = null, asks = [], possibleAsk = null } = {}) {
    return {
      id, name, status, reason, waitingFor: null, cwd: 'C:\\dev\\widgets', server, serverUrl: null, lastActivity: NOW - 10 * MIN,
      brief: { items: [{ ref: 'ado:7', key: 'ado:7', title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null }],
        headline: null, reportAt: NOW - 30 * MIN, wait, asks, possibleAsk, turnAt: NOW - 40 * MIN },
      spawn: { parentId: null, replaces: [], createdAt: NOW - 120 * MIN },
    };
  }
  function nowOf(rows, opts = {}) {
    const nodes = M.sessionNodes({ rows, closed: [], now: NOW });
    const view = M.buildView({ nodes, metaByKey: {}, projects: [], now: NOW, platform: 'win32' });
    return N.buildNow({ nodes, view, todos: opts.todos || [], later: opts.later || {}, now: NOW });
  }
  const quote = 'Three earlier questions still need your answer.';
  const ask = { id: B.askDigest('open one'), question: 'open one', context: 'c', options: [{ label: 'A' }, { label: 'B' }], at: NOW - 5 * MIN, maybeAnswered: false };

  test('it quotes the sentence, points at the session, holds nothing up, and ranks after every real ask', () => {
    const s = row('alpha', { possibleAsk: { text: quote, at: NOW - 15 * MIN }, asks: [ask] });
    const w = row('beta', { id: 'w-0000-4000-8000-000000000002', name: 'blocked', reason: { kind: 'you', text: 'go' }, wait: { on: 'you', what: 'go', at: NOW - MIN } });
    const v = nowOf([s, w]);
    expect(v.answerNow.map((c) => c.kind)).toEqual(['wait', 'ask', 'possible-ask']);
    const c = v.answerNow[2];
    expect(c).toMatchObject({ kind: 'possible-ask', what: quote, blocking: false, sessionName: 'lead', server: 'alpha', sessionId: s.id, replyPrefix: null, decision: null, askedAt: NOW - 15 * MIN });
    expect(c.id).toBe(`alpha|${s.id}|possible:${NOW - 15 * MIN}`);
    expect(c.why.text).toContain('may ask');
    expect(c.why.blocks).toBe(0);
  });

  test('a to-do on it sends the session nothing; the card is the same one on the next read', () => {
    const s = row('alpha', { possibleAsk: { text: quote, at: NOW - 15 * MIN } });
    const [c] = nowOf([s]).answerNow;
    expect(nowOf([row('alpha', { id: s.id, possibleAsk: { text: quote, at: NOW - 15 * MIN } })]).answerNow[0].id).toBe(c.id);
    const t = N.newTodo(c, { id: 't1', text: null, now: NOW });
    expect(t.park).toMatchObject({ state: 'none', why: 'not-blocking' });
    expect(nowOf([s], { todos: [t] }).answerNow).toEqual([]);
  });

  test('a peer that sends none, a closed session and a malformed one give no card', () => {
    const old = row('alpha');
    delete old.brief.possibleAsk;
    expect(nowOf([old]).answerNow).toEqual([]);
    expect(nowOf([row('alpha', { possibleAsk: { text: '', at: NOW } })]).answerNow).toEqual([]);
    expect(nowOf([row('alpha', { possibleAsk: 'str' })]).answerNow).toEqual([]);
  });

  test('its context is its words, answered by a reply', () => {
    const c = Q.askOf({ kind: 'possible-ask', what: quote }, null);
    expect(c).toMatchObject({ kind: 'possible-ask', canSuggest: true, options: [] });
    expect(c.questions[0].text).toBe(quote);
  });
});
