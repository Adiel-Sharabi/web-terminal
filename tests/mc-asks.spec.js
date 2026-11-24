// @ts-check
// #526 - the decisions a session holds for the owner without stopping for them ("asks"): the
// report field and the list it keeps across turns (lib/session-brief.js), how an answer ends
// one, the Answer-now cards they become (lib/mc-subjects.js askCard, lib/mc-needs.js), and the
// note that teaches the agent to report them. Pure, from SYNTHETIC rows. The routes read the
// same functions (mc-needs-routes).
const { test, expect } = require('@playwright/test');
const B = require('../lib/session-brief');
const M = require('../lib/mc-subjects');
const N = require('../lib/mc-needs');
const Q = require('../lib/mc-questions');

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const NOW = T0 + 60 * MIN;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const report = (e, body, at) => {
  const v = B.validateReport(body, e);
  if (v.error) throw new Error(v.error);
  return B.applyReport(e, v.report, at);
};
/** An entry that has reported its work, as a session does before anything else. */
const reported = (body = {}, at = T0) => report(B.emptyEntry(), { items: [{ ref: 'ado:7', title: 'Seven', state: 'in-progress' }], ...body }, at);
const ITEM = { items: [{ ref: 'ado:7', state: 'in-progress' }] };
/** One decision as a session reports it: every ask carries its context and its options. */
const A = (question, extra = {}) => ({ question, context: `why ${question}`, options: [{ label: 'yes' }, { label: 'no', consequence: 'slower' }], ...extra });
const questions = (e) => (e.reported.asks || []).map((a) => a.question);

test.describe('#526 the `asks` report field: a standing list of decisions', () => {
  test('a report carries up to 5 asks; each needs a question, its context and 2-4 options', () => {
    const v = B.validateReport({ headline: 'h', asks: [A('x'.repeat(900), { recommended: 1 }), A('pick a schema')] });
    expect(v.error).toBeUndefined();
    expect(v.report.asks).toHaveLength(2);
    expect(v.report.asks[0].question.length).toBeLessThanOrEqual(B.LIMITS.decisionQuestion);
    expect(v.report.asks[0]).toMatchObject({ context: expect.any(String), recommended: 1 });
    expect(v.report.asks[1]).toEqual({ question: 'pick a schema', context: 'why pick a schema', options: [{ label: 'yes' }, { label: 'no', consequence: 'slower' }] });
    expect(B.LIMITS.asks).toBe(5);
    const six = Array.from({ length: 6 }, (_, i) => A(`q${i}`));
    expect(B.validateReport({ headline: 'h', asks: six }).error).toContain('at most 5');
  });

  test('a bad shape is refused with the right one, naming the ask', () => {
    const err = (asks) => B.validateReport({ headline: 'h', asks }).error;
    expect(err('why')).toContain('"asks" must be an array');
    expect(err(['why'])).toContain('asks[0]');
    expect(err([{ ...A('ok'), question: '  ' }])).toContain('asks[0]');
    expect(err([A('ok'), { question: 'pick', options: [{ label: 'a' }, { label: 'b' }] }])).toContain('asks[1] needs a "context"');
    expect(err([{ question: 'pick', context: '   ', options: [{ label: 'a' }, { label: 'b' }] }])).toContain('"context"');
    const one = err([A('ok'), { question: 'pick', context: 'c', options: [{ label: 'only' }] }]);
    expect(one).toContain('asks[1]');
    expect(one).toContain('options');
    // The wait's own shape is quoted back, and the older `what` form names what to change.
    expect(one).toContain('"recommended"');
    expect(err([{ what: 'which schema?' }])).toContain('"question"');
    // A pick is typed back into the session: no control characters in any text.
    expect(err([A('ok\u001b[31m')])).toContain('control characters');
  });

  test('two asks of the same question are one', () => {
    const v = B.validateReport({ headline: 'h', asks: [A('Which DB?'), A(' which   db? '), A('Which cloud?')] });
    expect(v.report.asks.map((a) => a.question)).toEqual(['Which DB?', 'Which cloud?']);
  });

  test('replace / keep / clear - and a done, self or external report never clears the list', () => {
    let e = reported({ asks: [A('one'), A('two')] });
    expect(questions(e)).toEqual(['one', 'two']);
    // A report that names asks REPLACES the list; one that leaves an ask out drops it.
    e = report(e, { ...ITEM, asks: [A('three'), A('one')] }, T0 + MIN);
    expect(questions(e)).toEqual(['three', 'one']);
    // One without `asks` KEEPS it, whatever its wait: external, self, done, a wait-only report.
    for (const wait of [{ on: 'external', what: 'CI' }, { on: 'self', what: 'build' }, { on: 'done', what: '' }]) {
      e = report(e, { ...ITEM, wait }, T0 + 2 * MIN);
      expect(questions(e)).toEqual(['three', 'one']);
    }
    e = report(e, { wait: { on: 'done', what: '' } }, T0 + 3 * MIN);
    expect(questions(e)).toEqual(['three', 'one']);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => a.question)).toEqual(['three', 'one']);
    // `"asks": []` clears it.
    e = report(e, { ...ITEM, asks: [] }, T0 + 4 * MIN);
    expect(e.reported.asks || []).toEqual([]);
    expect(B.buildBrief(e, { reporting: true }).asks).toEqual([]);
  });

  test('asks alone update an earlier report (keeping the wait), and need one', () => {
    const body = { asks: [A('which schema?')] };
    expect(B.validateReport(body, null).error).toContain('first');
    let e = reported({ wait: { on: 'external', what: 'the rig' } });
    const v = B.validateReport(body, e);
    expect(v.report.partial).toBe(true);
    e = B.applyReport(e, v.report, T0 + MIN);
    expect(e.reported.wait).toMatchObject({ on: 'external', what: 'the rig' });
    expect(e.reported.items.map((i) => i.ref)).toEqual(['ado:7']);
    expect(questions(e)).toEqual(['which schema?']);
    // ...and `[]` alone clears them.
    e = report(e, { asks: [] }, T0 + 2 * MIN);
    expect(B.buildBrief(e, { reporting: true }).asks).toEqual([]);
    expect(e.reported.wait.what).toBe('the rig');
  });

  test('an ask keeps the time it was FIRST reported while it is still asked', () => {
    let e = reported({ asks: [A('one'), A('two')] }, T0);
    e = report(e, { ...ITEM, asks: [A('Two'), A('three')] }, T0 + 5 * MIN);
    const at = Object.fromEntries(e.reported.asks.map((a) => [a.question, a.at]));
    expect(at).toEqual({ Two: T0, three: T0 + 5 * MIN });
  });

  test('the brief publishes each ask whole, with an id the card and the answer share', () => {
    const e = reported({ asks: [A('one', { recommended: 0 })] });
    const [a] = B.buildBrief(e, { reporting: true }).asks;
    expect(a).toEqual({ id: B.askDigest('one'), question: 'one', context: 'why one', options: [{ label: 'yes' }, { label: 'no', consequence: 'slower' }],
      recommended: 0, at: T0, maybeAnswered: false });
    expect(B.askDigest('one')).toMatch(/^[0-9a-f]{8}$/);
    expect(B.askDigest(' ONE ')).toBe(B.askDigest('one'));
    expect(B.askDigest('two')).not.toBe(B.askDigest('one'));
    expect(B.buildBrief(e, { reporting: false }).asks).toEqual([]);
    expect(B.buildBrief(B.emptyEntry(), { reporting: true }).asks).toEqual([]);
  });
});

test.describe('#526 what ends an ask: the owner\'s answer from its card, never a guess', () => {
  const standing = () => reported({ asks: [A('one'), A('two'), A('three')], wait: { on: 'external', what: 'CI' } });
  const typed = (e, prompt, at) => B.foldHook(e, 'UserPromptSubmit', { prompt }, at);

  test('the answer typed from a card names its ask: the prefix is built by the server and read back from the typed text', () => {
    const prefix = B.askReplyPrefix(A('Which DB?'));
    expect(prefix).toBe(`Answer to "Which DB?" [ask:${B.askDigest('Which DB?')}]: `);
    expect(B.askAnswered(`${prefix}sqlite`)).toBe(B.askDigest('Which DB?'));
    // A long question is quoted shortened; the digest is of the WHOLE question, so it still names it.
    const long = A(`Which of the ${'very '.repeat(60)}long ways?`);
    const lp = B.askReplyPrefix(long);
    expect(lp.length).toBeLessThan(160);
    expect(B.askAnswered(`${lp}the second`)).toBe(B.askDigest(long.question));
    // Only a prompt that BEGINS with it names an ask: the words quoted mid-text, or nothing, name none.
    expect(B.askAnswered(`I said: ${prefix}sqlite`)).toBeNull();
    expect(B.askAnswered('use sqlite')).toBeNull();
    expect(B.askAnswered(`Answer to "x" [ask:zzzzzzzz]: no`)).toBeNull();
    expect(B.askAnswered(undefined)).toBeNull();
    // A question that quotes its own words still parses.
    const quoted = A('Is "fast" better than "safe"?');
    expect(B.askAnswered(`${B.askReplyPrefix(quoted)}safe`)).toBe(B.askDigest(quoted.question));
  });

  test('a typed prompt with no ask named marks every ask "maybe answered"; none is dropped', () => {
    let e = standing();
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: '<task-notification><task-id>x</task-id></task-notification>' }, T0 + MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => a.maybeAnswered)).toEqual([false, false, false]);
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: '<system-reminder>only a reminder</system-reminder>' }, T0 + 2 * MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => a.maybeAnswered)).toEqual([false, false, false]);
    e = typed(e, 'use sqlite', T0 + 3 * MIN);
    const asks = B.buildBrief(e, { reporting: true }).asks;
    expect(asks.map((a) => [a.question, a.maybeAnswered])).toEqual([['one', true], ['two', true], ['three', true]]);
    // The rest of the report stands - and a typed prompt still ends the wait it answered.
    expect(e.reported.items.map((i) => i.ref)).toEqual(['ado:7']);
    expect(e.reported.wait).toBeNull();
  });

  test('a card\'s answer clears exactly that ask: the others stand, unmarked, and so does the wait', () => {
    let e = standing();
    e = typed(e, `${B.askReplyPrefix(A('two'))}go with B`, T0 + MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => [a.question, a.maybeAnswered])).toEqual([['one', false], ['three', false]]);
    expect(e.reported.wait).toMatchObject({ on: 'external', what: 'CI' });
    e = typed(e, `${B.askReplyPrefix(A('one'))}A`, T0 + 2 * MIN);
    e = typed(e, `${B.askReplyPrefix(A('three'))}A`, T0 + 3 * MIN);
    expect(B.buildBrief(e, { reporting: true }).asks).toEqual([]);
    expect(e.reported.asks).toBeUndefined();
  });

  test('the line of work a report carries survives a card answer, a mark and a report of asks alone (#523 with #526)', () => {
    let e = reported({ line: 'Bug hunter', asks: [A('one'), A('two')] });
    expect(e.reported.line).toBe('Bug hunter');
    e = typed(e, `${B.askReplyPrefix(A('one'))}A`, T0 + MIN);
    expect(e.reported).toMatchObject({ line: 'Bug hunter' });
    e = typed(e, 'something else', T0 + 2 * MIN); // marks the rest
    expect(e.reported).toMatchObject({ line: 'Bug hunter' });
    e = report(e, { asks: [A('two'), A('three')] }, T0 + 3 * MIN); // asks alone
    expect(e.reported.line).toBe('Bug hunter');
    expect(questions(e)).toEqual(['two', 'three']);
  });

  test('an answer to an ask that no longer stands changes nothing; a prompt after a marking still marks the rest', () => {
    let e = standing();
    e = typed(e, `${B.askReplyPrefix(A('gone'))}ok`, T0 + MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => a.maybeAnswered)).toEqual([false, false, false]);
    expect(e.reported.wait).not.toBeNull();
    e = typed(e, 'something else', T0 + 2 * MIN);
    e = typed(e, `${B.askReplyPrefix(A('one'))}A`, T0 + 3 * MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => [a.question, a.maybeAnswered])).toEqual([['two', true], ['three', true]]);
  });

  test('the session re-reports after reading: an ask it keeps is open again, one it leaves out is gone', () => {
    let e = standing();
    e = typed(e, 'use sqlite', T0 + MIN);
    e = report(e, { ...ITEM, asks: [A('two'), A('four')] }, T0 + 2 * MIN);
    const asks = B.buildBrief(e, { reporting: true }).asks;
    expect(asks.map((a) => [a.question, a.maybeAnswered, a.at])).toEqual([['two', false, T0], ['four', false, T0 + 2 * MIN]]);
  });

  test('a report without `asks` keeps the marks (done never un-marks or clears)', () => {
    let e = standing();
    e = typed(e, 'use sqlite', T0 + MIN);
    e = report(e, { ...ITEM, wait: { on: 'done', what: '' } }, T0 + 2 * MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => a.maybeAnswered)).toEqual([true, true, true]);
  });

  test('a typed prompt with no report of asks still marks them when the session reported no wait', () => {
    let e = reported({ asks: [A('one')] });
    expect(e.reported.wait).toBeNull();
    e = typed(e, 'go', T0 + MIN);
    expect(B.buildBrief(e, { reporting: true }).asks.map((a) => a.maybeAnswered)).toEqual([true]);
  });
});

test.describe('#526 the dashboard hook note teaches `asks`', () => {
  test('it teaches the standing list (context and options), says done never clears it, and keeps a blocking question a `you` wait', () => {
    const t = B.instructionText(null, 'CMD');
    expect(t).toContain('"asks"');
    expect(t).toContain('"context"');
    expect(t).toContain('complete');
    expect(t).toContain('work around');
    expect(t).toContain('done');
    expect(t).toContain('maybeAnswered');
    expect(t).toContain('Answer to');
    expect(t).toContain('you cannot continue without');
    // Short: the note rides on every prompt.
    expect(t.split('\n').length).toBeLessThanOrEqual(12);
  });

  test('the current report quoted back carries the open asks (data), with the ones a typed prompt may have answered', () => {
    let e = reported({ asks: [A('which schema?'), A('rename it?')] });
    expect(B.instructionText(e, 'CMD')).toContain('"asks":[{"question":"which schema?"},{"question":"rename it?"}]');
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: 'use sqlite' }, T0 + MIN);
    expect(B.instructionText(e, 'CMD')).toContain('"asks":[{"question":"which schema?","maybeAnswered":true},{"question":"rename it?","maybeAnswered":true}]');
    // (the note's own teaching line spells it `"asks": [`, with a space; the quoted report has none.)
    expect(B.instructionText(reported(), 'CMD')).not.toContain('"asks":[');
  });
});

// --- the cards -----------------------------------------------------------------------------

/** A live row as the cluster view serves it (only the fields MC reads). */
function row(server, { id = uid('live'), name = 'session', status = 'idle', reason = null, items = [], wait = null, asks = [], possibleAsk = null, parentId = null } = {}) {
  return {
    id, name, status, reason, waitingFor: null, cwd: 'C:\\dev\\widgets', server, serverUrl: null, lastActivity: NOW - 10 * MIN,
    brief: { items: items.map((it) => ({ title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
      headline: null, reportAt: NOW - 30 * MIN, wait, asks, possibleAsk, turnAt: NOW - 40 * MIN },
    spawn: { parentId, replaces: [], createdAt: NOW - 2 * 60 * MIN },
  };
}
/** An ask as the brief publishes it. */
const ask = (question, agoMin = 20, extra = {}) => ({ id: B.askDigest(question), question, context: `why ${question}`,
  options: [{ label: 'A' }, { label: 'B', consequence: 'slower' }], at: NOW - agoMin * MIN, maybeAnswered: false, ...extra });
function nowOf(rows, { todos = [], later = {}, metaByKey = {} } = {}) {
  const nodes = M.sessionNodes({ rows, closed: [], now: NOW });
  const view = M.buildView({ nodes, metaByKey, projects: [], now: NOW, platform: 'win32' });
  return N.buildNow({ nodes, view, todos, later, now: NOW });
}

test.describe('#526 asks as Answer-now cards, one per decision', () => {
  test('an `external` wait plus 3 asks gives 3 cards, ranked after a `you` wait', () => {
    const lead = row('alpha', { name: 'lead', items: [{ ref: 'ado:7' }],
      reason: { kind: 'external', text: 'its child on another machine' }, wait: { on: 'external', what: 'child', at: NOW - 30 * MIN },
      asks: [ask('which DB?', 50), ask('ship the migration?', 20), ask('rename the flag?', 5)] });
    const you = row('beta', { name: 'blocked', items: [{ ref: 'ado:9' }],
      reason: { kind: 'you', text: 'say go', since: NOW - 3 * MIN }, wait: { on: 'you', what: 'say go', at: NOW - 3 * MIN } });
    const v = nowOf([lead, you]);
    expect(v.answerNow.map((c) => [c.kind, c.sessionName, c.what])).toEqual([
      ['wait', 'blocked', 'say go'],
      ['ask', 'lead', 'which DB?'], ['ask', 'lead', 'ship the migration?'], ['ask', 'lead', 'rename the flag?'],
    ]);
    expect(v.answerNow.map((c) => c.rank)).toEqual([1, 2, 3, 4]);
    const asks = v.answerNow.slice(1);
    expect(new Set(asks.map((c) => c.id)).size).toBe(3);
    // Each says it does not hold the session up, and that the session is still moving.
    for (const c of asks) {
      expect(c).toMatchObject({ blocking: false, hasQuestion: false, maybeAnswered: false, subjectKey: 'ado:7', server: 'alpha', sessionId: lead.id });
      expect(c.why).toMatchObject({ blocks: 0, blockedSessions: [], subjects: [] });
      expect(c.why.text).toContain('does not hold it up');
    }
    // Oldest first among asks.
    expect(asks.map((c) => c.why.ageMin)).toEqual([50, 20, 5]);
    expect(v.answerNow[0].blocking).toBe(true);
  });

  test('a `you` wait outranks an ask however much the ask is worth', () => {
    const asker = row('alpha', { name: 'a', items: [{ ref: 'ado:1' }, { ref: 'ado:2' }, { ref: 'ado:3' }], asks: [ask('big?', 600)],
      reason: { kind: 'working', text: '' }, status: 'working' });
    const waiter = row('alpha', { name: 'w', reason: { kind: 'you', text: 'go?' }, wait: { on: 'you', what: 'go?', at: NOW - MIN } });
    const meta = { 'ado:1': { key: 'ado:1', severity: 1, title: 't' } };
    expect(nowOf([asker, waiter], { metaByKey: meta }).answerNow.map((c) => c.kind)).toEqual(['wait', 'ask']);
  });

  test('an ask is a card of its own beside the session\'s `you` wait, and says what the session is doing', () => {
    const s = row('alpha', { name: 's', status: 'working', reason: { kind: 'working', text: '' }, asks: [ask('colour?')] });
    const x = row('alpha', { name: 'x', reason: { kind: 'you', text: 'go' }, wait: { on: 'you', what: 'go', at: NOW - MIN }, asks: [ask('also this?')] });
    const idle = row('alpha', { name: 'i', reason: { kind: 'done', text: '' }, asks: [ask('one more?')] });
    const v = nowOf([s, x, idle]);
    const by = (name, kind) => v.answerNow.find((c) => c.sessionName === name && c.kind === kind);
    expect(by('s', 'ask').why.text).toContain('still working');
    expect(by('x', 'wait')).toBeTruthy();
    expect(by('x', 'ask').why.text).toContain('also waits on you');
    expect(by('i', 'ask').why.text).toContain('idle');
  });

  test('a session that reported done still shows its open decisions', () => {
    const done = row('alpha', { name: 'lead', reason: { kind: 'done', text: '' }, wait: { on: 'done', what: '', at: NOW - 5 * MIN },
      asks: [ask('keep the old API?', 40), ask('drop the flag?', 30)] });
    const v = nowOf([done]);
    expect(v.answerNow.map((c) => [c.kind, c.what])).toEqual([['ask', 'keep the old API?'], ['ask', 'drop the flag?']]);
    expect(v.answerNow[0].why.text).toContain('idle');
  });

  test('a session with only asks is still moving on its own', () => {
    const s = row('alpha', { status: 'working', reason: { kind: 'working', text: '' }, asks: [ask('a?'), ask('b?')] });
    const w = row('alpha', { reason: { kind: 'you', text: 'go' }, wait: { on: 'you', what: 'go', at: NOW - MIN } });
    expect(nowOf([s, w]).moving).toEqual({ working: 1, idle: 0, total: 1 });
  });

  test('the card carries its decision whole (question, context, options), the answer prefix and the id that survives a re-report', () => {
    const s = row('alpha', { reason: { kind: 'external', text: 'x' }, asks: [ask('pick', 10, { recommended: 1 })] });
    const [c] = nowOf([s]).answerNow;
    expect(c.what).toBe('pick');
    expect(c.decision).toEqual({ question: 'pick', context: 'why pick', options: [{ label: 'A' }, { label: 'B', consequence: 'slower' }], recommended: 1 });
    expect(c.askedAt).toBe(NOW - 10 * MIN);
    expect(c.askId).toBe(B.askDigest('pick'));
    expect(c.replyPrefix).toBe(B.askReplyPrefix({ question: 'pick' }));
    expect(c.id).toMatch(new RegExp(`^alpha\\|${s.id}\\|ask:${NOW - 10 * MIN}\\.[0-9a-f]{8}$`));
    // The same ask re-reported (same words, its first time kept) is the same card.
    const again = row('alpha', { id: s.id, reason: { kind: 'external', text: 'x' }, asks: [ask('PICK', 10)] });
    expect(nowOf([again]).answerNow[0].id).toBe(c.id);
    // A different ask is another card.
    const other = row('alpha', { id: s.id, reason: { kind: 'external', text: 'x' }, asks: [ask('pick two', 10)] });
    expect(nowOf([other]).answerNow[0].id).not.toBe(c.id);
  });

  test('an ask a typed prompt may have answered is dimmed and ranks after the open ones', () => {
    const s = row('alpha', { reason: { kind: 'external', text: 'x' },
      asks: [ask('old and maybe answered', 90, { maybeAnswered: true }), ask('newer and open', 10)] });
    const v = nowOf([s]);
    expect(v.answerNow.map((c) => [c.what, c.maybeAnswered])).toEqual([['newer and open', false], ['old and maybe answered', true]]);
    expect(v.answerNow[1].why.text).toContain('may be answered');
    expect(v.answerNow[1].why.text).toContain('does not hold it up');
  });

  test('a decision the session also holds as its `you` wait is one card, not two', () => {
    const decision = { question: 'Which DB should it use?', context: 'c', options: [{ label: 'A' }, { label: 'B' }] };
    const s = row('alpha', { reason: { kind: 'you', text: 'Which DB should it use?' }, wait: { on: 'you', what: 'Which DB should it use?', decision, at: NOW - MIN },
      asks: [ask('Which DB should it use?'), ask('Another thing?')] });
    expect(nowOf([s]).answerNow.map((c) => [c.kind, c.what])).toEqual([['decision', 'Which DB should it use?'], ['ask', 'Another thing?']]);
  });

  test('the `you` wait takes its decision only while its own card is shown: a working session, or a prompt on screen, leaves the ask a card of its own', () => {
    const decision = { question: 'Which DB should it use?', context: 'c', options: [{ label: 'A' }, { label: 'B' }] };
    const waitOf = () => ({ on: 'you', what: 'Which DB should it use?', decision, at: NOW - MIN });
    const kinds = (r) => nowOf([r]).answerNow.map((c) => c.kind);
    // shown: one card (the wait's), as before
    expect(kinds(row('alpha', { reason: { kind: 'you', text: 'x' }, wait: waitOf(), asks: [ask('Which DB should it use?')] }))).toEqual(['decision']);
    // a task notification started a turn: the reported wait shows no card now, so the ask is the one card
    expect(kinds(row('alpha', { status: 'working', reason: { kind: 'working', text: '' }, wait: waitOf(), asks: [ask('Which DB should it use?')] }))).toEqual(['ask']);
    // a permission prompt is on screen: that card is the prompt, not the reported decision
    const onScreen = row('alpha', { reason: { kind: 'you', text: 'Bash' }, wait: waitOf(), asks: [ask('Which DB should it use?')] });
    onScreen.waitingFor = 'permission';
    expect(kinds(onScreen).sort()).toEqual(['ask', 'permission']);
  });

  test('a peer\'s ask with a control character in any of its words is dropped (its reply prefix is typed into a session); caps apply as at home', () => {
    const esc = String.fromCharCode(27);
    const rows = [row('gamma', { reason: { kind: 'external', text: 'x' }, asks: [
      ask('bad question' + esc + '[2J'), ask('bad option', 20, { options: [{ label: 'A' + esc }, { label: 'B' }] }),
      ask('bad context', 20, { context: 'why' + esc }), ask('good one'),
      ask('x'.repeat(900), 20, { context: 'c'.repeat(5000), options: [{ label: 'L'.repeat(400) }, { label: 'B', consequence: 'k'.repeat(900) }] })] })];
    const out = nowOf(rows).answerNow;
    expect(out.map((c) => c.what.slice(0, 9)).sort()).toEqual(['good one', 'xxxxxxxxx']);
    const big = out.find((c) => c.what.startsWith('xxx'));
    expect(big.what.length).toBeLessThanOrEqual(B.LIMITS.decisionQuestion);
    expect(big.decision.context.length).toBeLessThanOrEqual(B.LIMITS.decisionContext);
    expect(big.decision.options[0].label.length).toBeLessThanOrEqual(B.LIMITS.decisionLabel);
    expect(big.decision.options[1].consequence.length).toBeLessThanOrEqual(B.LIMITS.decisionConsequence);
  });

  test('a to-do or a "later" hides one ask, not its siblings; a to-do on an ask sends the session nothing', () => {
    const s = row('alpha', { reason: { kind: 'external', text: 'x' }, asks: [ask('one', 30), ask('two', 20), ask('three', 10)] });
    const [first, second] = nowOf([s]).answerNow;
    expect(second.what).toBe('two');
    const t = N.newTodo(first, { id: 't1', text: null, now: NOW });
    expect(t.park).toMatchObject({ state: 'none', why: 'not-blocking' });
    expect(t.park.body).toBeUndefined();
    expect(N.publicTodo(t).park).toMatchObject({ state: 'none', refused: 'not-blocking' });
    expect(N.publicTodo(t).park.reason).toContain('not waiting on this');
    expect(nowOf([s], { todos: [t] }).answerNow.map((c) => c.what)).toEqual(['two', 'three']);
    expect(nowOf([s], { later: { [second.id]: { until: NOW + 60 * MIN } } }).answerNow.map((c) => c.what)).toEqual(['one', 'three']);
    // A retry of the park is refused in the same words, never sent.
    expect(N.applyAction(t, 'park', NOW)).toMatchObject({ status: 409 });
    expect(N.applyAction(t, 'park', NOW).error).toContain('not waiting on this');
  });

  test('a closed session, and a peer that sends no asks, give no ask cards; a peer\'s bad rows are dropped', () => {
    const live = row('alpha', { reason: { kind: 'external', text: 'x' }, asks: [ask('one')] });
    const closed = { server: 'alpha', serverUrl: null, rec: { id: uid('closed'), name: 'gone', at: NOW - MIN, items: [], headline: null, asks: [ask('stale')] } };
    const nodes = M.sessionNodes({ rows: [live], closed: [closed], now: NOW });
    expect(nodes.find((x) => x.closed).asks).toEqual([]);
    const old = row('beta', { reason: { kind: 'external', text: 'x' } });
    delete old.brief.asks;
    expect(nowOf([old]).answerNow).toEqual([]);
    const junk = row('gamma', { reason: { kind: 'external', text: 'x' }, asks: [{ what: 'old shape' }, { question: 'no options', context: 'c' }, 'str', null, ask('fine')] });
    expect(nowOf([junk]).answerNow.map((c) => c.what)).toEqual(['fine']);
  });

  test('end to end: an ask stays until the owner answers it from its card; a typed prompt only dims it', () => {
    let e = reported({ asks: [A('which DB?'), A('rename the flag?')], wait: { on: 'external', what: 'CI' } }, NOW - 20 * MIN);
    const rowOf = (entry) => {
      const brief = B.buildBrief(entry, { reporting: true });
      return row('alpha', { id: 'e2e-0000-4000-8000-000000000001', name: 'lead', reason: { kind: 'external', text: 'CI' },
        items: brief.items, wait: brief.wait, asks: brief.asks });
    };
    let cards = nowOf([rowOf(e)]).answerNow;
    // Asked together, so equally old: their order is the id's, which says nothing here.
    const byWhat = (list) => list.map((c) => [c.kind, c.what, c.maybeAnswered]).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    expect(byWhat(cards)).toEqual([['ask', 'rename the flag?', false], ['ask', 'which DB?', false]]);
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: 'use sqlite' }, NOW - 5 * MIN);
    cards = nowOf([rowOf(e)]).answerNow;
    expect(byWhat(cards)).toEqual([['ask', 'rename the flag?', true], ['ask', 'which DB?', true]]);
    // The owner answers one from its card: the card's own prefix is what gets typed.
    const db = cards.find((c) => c.what === 'which DB?');
    e = B.foldHook(e, 'UserPromptSubmit', { prompt: `${db.replyPrefix}sqlite` }, NOW - 4 * MIN);
    expect(nowOf([rowOf(e)]).answerNow.map((c) => [c.what, c.maybeAnswered])).toEqual([['rename the flag?', true]]);
  });

  test('the context of an ask card: a decision, answered by a reply with any words', () => {
    const decision = { question: 'Which?', context: 'because', options: [{ label: 'A' }, { label: 'B', consequence: 'slower' }], recommended: 1 };
    const c = Q.askOf({ kind: 'ask', what: 'Which?', decision }, null);
    expect(c).toMatchObject({ kind: 'ask', recommended: 1, canSuggest: true, context: 'because' });
    expect(c.options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(c.questions[0].text).toBe('Which?');
  });
});
