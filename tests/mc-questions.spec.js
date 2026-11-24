// @ts-check
// #510 - lib/mc-questions.js: a question card at three levels (no model), what the card asks
// (decision, AskUserQuestion, a reported wait), the follow-up check, the ask block inside the
// Analyst's fence, and the suggestion parser (one-line labels, no repeats of what is offered).
// The routes are pinned in mc-questions-routes.spec.js. Fixtures are synthetic.
const { test, expect } = require('@playwright/test');
const mq = require('../lib/mc-questions');
const an = require('../lib/mc-analyst');

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const MIN = 60000;

const decisionCard = {
  id: 'alpha|s1|decision:123', kind: 'decision', server: 'alpha', serverUrl: null, sessionId: 's1', sessionName: 'fixer',
  subjectKey: 'acme/web#7', ref: 'acme/web#7', title: 'Fix login', what: 'Which fix?', askedAt: NOW - 20 * MIN,
  decision: { question: 'Which fix?', context: 'Two ways to do it.', options: [{ label: 'Patch the form', consequence: 'quick, leaves debt' }, { label: 'Rewrite auth', consequence: 'a day of work' }], recommended: 1 },
};
const row = {
  id: 's1', name: 'fixer', server: 'alpha', serverUrl: null, status: 'idle', lastActivity: NOW - 5 * MIN,
  brief: { headline: 'fixing login', reportAt: NOW - 10 * MIN, items: [{ key: 'acme/web#7', ref: 'acme/web#7', title: 'Fix login', state: 'in-progress' }],
    did: { text: 'Read the form code', at: NOW - 8 * MIN }, prompt: { text: 'fix the login bug', at: NOW - 60 * MIN }, wait: { on: 'you', what: 'Which fix?' } },
};
const meta = { key: 'acme/web#7', title: 'Fix login', type: 'Bug', state: 'open', closed: false, severity: 2, priority: null, assignee: 'dev',
  url: 'https://github.com/acme/web/issues/7', prs: [{ url: 'https://github.com/acme/web/pull/9', number: 9, repo: 'acme/web', state: 'open', draft: false }], fetchedAt: NOW - 2 * MIN };

test.describe('#510 the request', () => {
  test('level: absent is ask; only the three names', () => {
    expect(mq.levelOf(undefined)).toBe('ask');
    expect(mq.levelOf('')).toBe('ask');
    for (const l of ['ask', 'context', 'everything']) expect(mq.levelOf(l)).toBe(l);
    expect(mq.levelOf('all')).toBeNull();
    expect(mq.levelOf(['ask'])).toBeNull();
  });
  test('cardId: a non-empty string of at most 400', () => {
    expect(mq.cardIdOf('a|b|wait:1')).toBe('a|b|wait:1');
    expect(mq.cardIdOf('')).toBeNull();
    expect(mq.cardIdOf('x'.repeat(401))).toBeNull();
  });
});

test.describe('#510 what the card asks', () => {
  test('a decision: its options in order, the recommendation by index, suggestions allowed', () => {
    const a = mq.askOf(decisionCard, null);
    expect(a.options.map((o) => [o.index, o.label, o.detail, o.recommended])).toEqual([[0, 'Patch the form', 'quick, leaves debt', false], [1, 'Rewrite auth', 'a day of work', true]]);
    expect(a.recommended).toBe(1);
    expect(a.context).toBe('Two ways to do it.');
    expect(a.canSuggest).toBe(true);
  });
  test('an AskUserQuestion: options flat across questions; (Recommended) in a label; Other only for one compact question', () => {
    const card = { ...decisionCard, kind: 'question', decision: null };
    const one = { questions: [{ question: 'Pick a color', header: 'Color', multiSelect: false, hasPreview: false, options: [{ label: 'Red' }, { label: 'Blue (Recommended)', description: 'calm' }] }] };
    const a = mq.askOf(card, one);
    expect(a.options.map((o) => o.label)).toEqual(['Red', 'Blue (Recommended)']);
    expect(a.recommended).toBe(1);
    expect(a.canSuggest).toBe(true);
    // Side-by-side has no Other row; two questions need every tab answered.
    expect(mq.askOf(card, { questions: [{ ...one.questions[0], hasPreview: true }] }).canSuggest).toBe(false);
    const two = mq.askOf(card, { questions: [one.questions[0], { question: 'Size?', options: [{ label: 'S' }, { label: 'L' }] }] });
    expect(two.canSuggest).toBe(false);
    expect(two.options.map((o) => [o.index, o.question])).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
  });
  test('a reported wait: its words, no options, a reply can be suggested; a permission cannot', () => {
    const w = mq.askOf({ ...decisionCard, kind: 'wait', decision: null, what: 'try the build' }, null);
    expect(w.questions[0].text).toBe('try the build');
    expect(w.options).toEqual([]);
    expect(w.canSuggest).toBe(true);
    expect(mq.askOf({ ...decisionCard, kind: 'permission', decision: null }, null).canSuggest).toBe(false);
  });
});

test.describe('#510 context on demand', () => {
  const ask = mq.askOf(decisionCard, null);
  test('ask: the ask and the recommendation only', () => {
    const c = mq.buildContext({ card: decisionCard, level: 'ask', ask, row, meta, now: NOW });
    expect(c.sections.map((s) => s.title)).toEqual(['The ask', 'Recommendation']);
    expect(c.sections[0].body).toContain('2. Rewrite auth (recommended)');
    expect(c.sections[1].body).toBe('Option 2: Rewrite auth');
    expect(c.text).not.toContain('fixing login');
    expect(c.sources.map((s) => s.kind)).toEqual(['session']);
  });
  test('context: + the work item, what the session did, why it asks, what each answer does, the digest', () => {
    const digest = { status: 'ready', about: 'Login fails on submit', asking: ['which fix'], know: ['the form is old'] };
    const c = mq.buildContext({ card: decisionCard, level: 'context', ask, row, meta, digest, now: NOW });
    expect(c.sections.map((s) => s.title)).toEqual(['The ask', 'Recommendation', 'The work item', 'What the session did', 'Why it asks', 'What each answer does', 'Summary (inbox digest)']);
    const by = Object.fromEntries(c.sections.map((s) => [s.title, s.body]));
    expect(by['The work item']).toContain('severity 2');
    expect(by['The work item']).toContain('Pull request #9: open');
    expect(by['What the session did']).toContain('Headline: fixing login');
    expect(by['What each answer does']).toContain('1. Patch the form: quick, leaves debt');
    expect(c.sources.map((s) => s.kind)).toEqual(['session', 'workitem', 'report']);
    expect(c.text).not.toContain('https://');
  });
  test('everything: + the last turns and every link; a recap that failed says so', () => {
    const recap = { prompts: [{ text: 'fix the login bug', at: new Date(NOW - 60 * MIN).toISOString() }], reply: { text: 'Two ways: patch or rewrite', at: new Date(NOW - 9 * MIN).toISOString() }, since: { turns: 4, tools: ['Read', 'Grep'] } };
    const c = mq.buildContext({ card: decisionCard, level: 'everything', ask, row, meta, recap, now: NOW });
    const by = Object.fromEntries(c.sections.map((s) => [s.title, s.body]));
    expect(by['Last turns']).toContain('Two ways: patch or rewrite');
    expect(by['Last turns']).toContain('tools Read, Grep');
    expect(by.Links).toContain('https://github.com/acme/web/issues/7');
    expect(by.Links).toContain('https://github.com/acme/web/pull/9');
    expect(c.sources.map((s) => s.kind)).toEqual(['session', 'workitem', 'report', 'recap', 'pr']);
    const failed = mq.buildContext({ card: decisionCard, level: 'everything', ask, row, meta: null, recap: { error: 'HTTP 500' }, now: NOW });
    expect(failed.sections.find((s) => s.title === 'Last turns').body).toContain('could not be read');
    expect(failed.sections.find((s) => s.title === 'The work item').body).toContain('No tracker details are cached');
  });
  test('a card with no work item says so', () => {
    const c = mq.buildContext({ card: { ...decisionCard, ref: null, subjectKey: null }, level: 'context', ask, row: null, now: NOW });
    expect(c.sections.find((s) => s.title === 'The work item').body).toBe('This wait names no work item.');
    expect(c.sections.find((s) => s.title === 'What the session did').body).toBe('The session has not reported what it did.');
  });
});

test.describe('#510 follow-ups and suggestions', () => {
  const ask = mq.askOf(decisionCard, null);
  test('the follow-up body: a question, and an option index or null', () => {
    expect(mq.followupInput({ question: ' why? ', option: 1 }, ask)).toEqual({ ok: true, option: 1, question: 'why?' });
    expect(mq.followupInput({ question: 'why?' }, ask)).toEqual({ ok: true, option: null, question: 'why?' });
    for (const bad of [{}, { question: '' }, { question: 'x'.repeat(2001) }, { question: 'q', option: 2 }, { question: 'q', option: -1 }, { question: 'q', option: '1' }]) {
      expect(mq.followupInput(bad, ask).ok, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    expect(mq.followupInput({ question: 'q', option: 0 }, mq.askOf({ ...decisionCard, kind: 'wait', decision: null }, null)).ok).toBe(false);
  });
  test('the ask block sits inside the fence; the person\'s words after it, naming the option by number only', () => {
    const bundle = mq.withAskBlock(an.buildBundle({ rows: [row], now: NOW }), { card: decisionCard, ask, now: NOW });
    const id = bundle.askId;
    expect(bundle.sources[bundle.sources.length - 1].id).toBe(id);
    const p = mq.followupPrompt({ bundle, input: { option: 1, question: 'How long would it take?' }, scope: { kind: 'session', id: 's1' }, now: NOW, nonce: 'n0' });
    const close = p.lastIndexOf('=== DATA n0 END ===');
    expect(p.indexOf('option 2: "Rewrite auth"')).toBeGreaterThan(p.lastIndexOf('=== DATA n0 BEGIN ==='));
    expect(p.indexOf('option 2: "Rewrite auth"')).toBeLessThan(close);
    const tail = p.slice(close);
    expect(tail).toContain(`About option 2 of the waiting question [${id}]: How long would it take?`);
    expect(tail).not.toContain('Rewrite auth');
    expect(p).toContain('Nothing you say reaches the agent');
  });
  test('the suggest prompt asks for options in the reply format', () => {
    const bundle = mq.withAskBlock(an.buildBundle({ rows: [row], now: NOW }), { card: decisionCard, ask, now: NOW });
    const p = mq.suggestPrompt({ bundle, scope: { kind: 'session', id: 's1' }, now: NOW, nonce: 'n1' });
    expect(p).toContain('{"options": [{"label": string, "consequence": string}], "sources": [string]}');
    expect(p).not.toContain('{"answer": string');
  });
  test('suggestions: one-line labels, capped, nothing already offered, nothing twice, offered ids only', () => {
    const wrap = (o) => JSON.stringify({ is_error: false, result: JSON.stringify(o) });
    const nl = String.fromCodePoint(10);
    const esc = String.fromCodePoint(0x1b);
    const out = mq.parseSuggestions(wrap({ options: [
      { label: `Split${nl}it ${esc}[2J up`, consequence: 'two PRs' }, { label: 'patch the form' }, { label: 'Split it [2J up' },
      { label: '!git push --force' }, { label: '/clear' },
      { label: 'x'.repeat(200), consequence: 'y'.repeat(400) }, { label: 'Ask the owner' }, { label: 'Fifth' },
    ], sources: ['S1', 'S99'] }), ['S1', 'S2'], ['Patch the form', 'Rewrite auth']);
    expect(out && out.options.map((o) => o.label)).toEqual(['Split it [2J up', 'x'.repeat(79) + '…', 'Ask the owner', 'Fifth']);
    expect(out && out.options[0].consequence).toBe('two PRs');
    expect(out && out.options[1].consequence.length).toBe(mq.SUGGEST_CONSEQUENCE_MAX);
    expect(out && out.options[2].consequence).toBeNull();
    expect(out && out.cited).toEqual(['S1']);
    expect(mq.parseSuggestions(wrap({ options: [{ label: 'Patch the form' }] }), [], ['Patch the form'])).toBeNull();
    expect(mq.parseSuggestions(wrap({ answer: 'prose' }), [], [])).toBeNull();
    expect(mq.parseSuggestions('not json', [], [])).toBeNull();
  });
});
