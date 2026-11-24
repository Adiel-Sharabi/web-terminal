// @ts-check
// #525 - the supervisor's dispatcher runs Sonnet and keeps its context short. The rules, pure:
// the dispatcher's command names a model (Sonnet unless the config's own command names one),
// and the #393 hand-off takes the dispatcher on its own terms - a lower context point, and
// "between cases" read from the case log rather than from a report it never makes. Applied
// end to end in supervisor-dispatcher-recycle.spec.js.
const { test, expect } = require('@playwright/test');
const cases = require('../lib/supervisor-cases');
const H = require('../lib/handoff');
const { contextBudget } = require('../lib/context-budget');

const T = 1_700_000_000_000;
const MIN = 60 * 1000;

test.describe('#525 the dispatcher runs Sonnet', () => {
  test('the default command runs Sonnet', () => {
    const d = cases.dispatcherConfig(null);
    expect(d.autoCommand).toBe('claude --dangerously-skip-permissions --model sonnet');
    expect(d.model).toBe('sonnet');
  });

  test('a configured command that names no model gets Sonnet too; one that names a model keeps it', () => {
    expect(cases.dispatcherConfig({ dispatcher: { autoCommand: 'claude --verbose' } }).autoCommand).toBe('claude --verbose --model sonnet');
    expect(cases.dispatcherConfig({ dispatcher: { autoCommand: 'claude --model opus' } }).autoCommand).toBe('claude --model opus');
    expect(cases.dispatcherConfig({ dispatcher: { autoCommand: 'claude --model=haiku --verbose' } }).autoCommand).toBe('claude --model=haiku --verbose');
    // A flag that only starts with --model is not one.
    expect(cases.dispatcherConfig({ dispatcher: { autoCommand: 'claude --models-dir x' } }).autoCommand).toBe('claude --models-dir x --model sonnet');
  });

  test('dispatcher.model picks another model; "" or false runs the command as written; a bad name is never typed', () => {
    expect(cases.dispatcherConfig({ dispatcher: { model: 'opus' } }).autoCommand).toBe('claude --dangerously-skip-permissions --model opus');
    expect(cases.dispatcherConfig({ dispatcher: { model: 'claude-sonnet-5-5' } }).autoCommand).toMatch(/ --model claude-sonnet-5-5$/);
    expect(cases.dispatcherConfig({ dispatcher: { model: '' } }).autoCommand).toBe('claude --dangerously-skip-permissions');
    expect(cases.dispatcherConfig({ dispatcher: { model: false } }).autoCommand).toBe('claude --dangerously-skip-permissions');
    for (const bad of ['opus; rm -rf /', 'a b', '"x"', '$(id)', '--print', '-x', 7]) {
      const d = cases.dispatcherConfig({ dispatcher: { model: bad } });
      expect(d.autoCommand).toBe('claude --dangerously-skip-permissions --model sonnet');
      expect(d.modelRefused).toBe(String(bad)); // said, not swallowed (logged at the start)
    }
    expect(cases.dispatcherConfig(null).modelRefused).toBeNull();
    expect(cases.dispatcherConfig({ dispatcher: { model: 'opus' } }).modelRefused).toBeNull();
  });
});

test.describe('#525 the dispatcher hands off between cases', () => {
  const c = (over) => ({ id: 'aaaaaaaa', rule: 'R3', openedAt: T - 60 * MIN, deliveredAt: null, takenAt: null, escalated: null, resolvedAt: null, ...over });
  const st = (...list) => ({ cases: Object.fromEntries(list.map((x) => [x.id, x])) });

  const inHand = (x, now = T) => cases.caseInHand(st(x), now);
  const untaken = (at) => ({ at, by: 'rules (not taken in 30 min)', auto: true, cause: 'untaken' });

  test('a case is in hand once handed over or taken, until resolved or the owner holds it', () => {
    expect(cases.caseInHand(st(), T)).toBeNull();
    expect(inHand(c({}))).toBeNull(); // opened, never handed over: not in hand
    expect(inHand(c({ deliveredAt: T - 5 * MIN }))).toBe('aaaaaaaa');
    expect(inHand(c({ deliveredAt: T - 5 * MIN, takenAt: T - 4 * MIN }))).toBe('aaaaaaaa');
    expect(inHand(c({ deliveredAt: T - 5 * MIN, takenAt: T - 4 * MIN, resolvedAt: T - MIN }))).toBeNull();
    // Escalated after the dispatcher last had it: the owner holds it.
    expect(inHand(c({ deliveredAt: T - 20 * MIN, escalated: { at: T - 5 * MIN, cause: 'asked' } }))).toBeNull();
    expect(inHand(c({ escalated: untaken(T - 5 * MIN) }))).toBeNull();
    // An escalation of unknown time is the owner's (never guessed to be older).
    expect(inHand(c({ deliveredAt: T - 5 * MIN, escalated: { at: null } }))).toBeNull();
  });

  test('#498 second look: in hand only while the dispatcher still looks at it', () => {
    // Escalated untaken (never handed over), then handed over on its second look.
    const second = c({ escalated: untaken(T - 10 * MIN), deliveredAt: T - 5 * MIN });
    expect(inHand(second)).toBe('aaaaaaaa');
    expect(cases.caseDue(second, T + 31 * MIN)).toBeNull(); // never escalated again...
    expect(inHand(second, T + 31 * MIN)).toBeNull(); // ...so past its window it is the owner's
    // Escalated because the dispatcher ASKED the owner: the owner's, whatever came before.
    expect(inHand(c({ takenAt: T - 4 * MIN, escalated: { at: T - 3 * MIN, cause: 'asked' } }))).toBeNull();
  });

  test('a case taken and left open holds the dispatcher only for the untaken window, never for ever', () => {
    const left = c({ deliveredAt: T - 50 * MIN, takenAt: T - 29 * MIN });
    expect(inHand(left)).toBe('aaaaaaaa');
    expect(inHand(left, T + 2 * MIN)).toBeNull(); // 31 min since it last had it
    expect(cases.caseInHand(st(left), NaN)).toBeNull(); // no clock: nothing is "recent"
  });

  test('its terms: the configured context point, and the case in hand as the gate', () => {
    expect(cases.DISPATCHER_HANDOFF_TOKENS).toBe(100000);
    const cfg = cases.dispatcherConfig(null);
    expect(cases.dispatcherHandoffTerms(cfg, st(), T)).toEqual({ ctxThreshold: 100000, block: null });
    expect(cases.dispatcherHandoffTerms(cfg, st(c({ deliveredAt: T })), T)).toEqual({ ctxThreshold: 100000, block: 'case-in-hand' });
    expect(cases.dispatcherConfig({ dispatcher: { handoffTokens: 150000 } }).handoffTokens).toBe(150000);
    expect(cases.dispatcherConfig({ dispatcher: { handoffTokens: 5 } }).handoffTokens).toBe(50000);
    expect(cases.dispatcherConfig({ dispatcher: { handoffTokens: 'x' } }).handoffTokens).toBe(100000);
  });

  // The live dispatcher: idle 30 min, no report at all (it reports nothing between cases),
  // 26% of a 1M window under a 400k auto-compact window: 260k, short of the 300k #393 point.
  const BUDGET = contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: 400_000 });
  const dispatcherRow = (pct = 26) => ({
    agent: 'claude', status: 'idle', waitingFor: null, compacting: false, agentReady: true,
    usageLimit: null, backgroundTasks: [], reason: null,
    metrics: { ctx: pct, ctxWindow: 1_000_000, budget: BUDGET },
    brief: { hidden: false, turnAt: T - 40 * MIN, stoppedAt: T - 30 * MIN, handoff: null },
  });
  const judge = (row, terms) => H.handoffCandidate(row, { now: T, cfg: H.handoffConfig(null), supported: true, terms });
  const free = { ctxThreshold: 100000, block: null };

  test('the generic rule never offers it (no report = no boundary); its own terms do, between cases', () => {
    expect(judge(dispatcherRow(), null)).toMatchObject({ suggest: false, why: 'no-boundary' });
    expect(judge(dispatcherRow(), free)).toMatchObject({ suggest: true, why: null, ctxTokens: 260000 });
    expect(judge(dispatcherRow(), { ctxThreshold: 100000, block: 'case-in-hand' })).toMatchObject({ suggest: false, why: 'case-in-hand' });
  });

  test('its lower point applies; it never raises the session budget', () => {
    expect(judge(dispatcherRow(9), free)).toMatchObject({ suggest: false, why: 'small' }); // 90k < 100k
    expect(judge(dispatcherRow(11), free)).toMatchObject({ suggest: true }); // 110k
    // A term above the budget's 300k still hands off at 300k.
    expect(judge(dispatcherRow(31), { ctxThreshold: 500000, block: null })).toMatchObject({ suggest: true });
    expect(judge(dispatcherRow(29), { ctxThreshold: 500000, block: null })).toMatchObject({ suggest: false, why: 'small' });
  });

  test('its terms skip no safety gate, and a case in hand is not forceable', () => {
    const busy = { ...dispatcherRow(), status: 'working' };
    expect(judge(busy, free).why).toBe('not-idle');
    expect(judge({ ...dispatcherRow(), waitingFor: { tool: 'AskUserQuestion' } }, free).why).toBe('waiting');
    const recent = dispatcherRow();
    recent.brief = { ...recent.brief, stoppedAt: T - MIN };
    expect(judge(recent, free).why).toBe('recent');
    expect(H.FORCEABLE_GATES).not.toContain('case-in-hand');
  });
});
