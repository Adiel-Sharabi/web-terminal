// @ts-check
// #340 — hand a long session off to a fresh one. The rule is pure (lib/handoff.js).
// Pinned here: a session is offered a hand-off only when EVERY gate holds, and each
// gate is tested by breaking it ALONE on an otherwise-perfect candidate (#249's lesson:
// a negative that breaks two gates proves nothing about either). Also the prompts, the
// launch command a successor gets, the verdict an agent may post, and the timeouts.
const { test, expect } = require('@playwright/test');
const H = require('../lib/handoff');
const agents = require('../lib/agents');

const T = 1_700_000_000_000;
const MIN = 60 * 1000;
const cfg = H.handoffConfig(null);

/** A session that should be offered a hand-off: idle 30 min after a finished turn,
 *  reported waiting on a third party, 60% of a 1M window. */
function candidate() {
  return {
    agent: 'claude', status: 'idle', waitingFor: null, compacting: false, agentReady: true,
    usageLimit: null, backgroundTasks: [], reason: { kind: 'external', text: 'PR review' },
    metrics: { ctx: 60, ctxWindow: 1_000_000 },
    brief: { hidden: false, turnAt: T - 40 * MIN, stoppedAt: T - 30 * MIN,
      wait: { on: 'external', what: 'PR review', at: T - 30 * MIN }, items: [{ ref: '#1', state: 'in-progress' }], handoff: null },
  };
}
const judge = (row, over = {}) => H.handoffCandidate(row, { now: T, cfg, supported: true, ...over });

test.describe('handoffCandidate (#340)', () => {
  test('the perfect candidate is suggested, with its occupancy', () => {
    expect(judge(candidate())).toEqual({ suggest: true, why: null, ctxTokens: 600_000, run: null });
  });

  test('an agent that does not declare hand-off gets NO field at all', () => {
    expect(judge(candidate(), { supported: false })).toBeNull();
    // ...and the registry declares it for Claude only; undeclared means never.
    expect(agents.handsOff('claude')).toBe(true);
    expect(agents.handsOff('codex')).toBe(false);
    expect(agents.handsOff(null)).toBe(false);
    expect(agents.handsOff('nope')).toBe(false);
  });

  // One mutation per row, each on a fresh perfect candidate.
  const gates = [
    ['disabled by config', (r) => r, 'disabled', { cfg: H.handoffConfig({ enabled: false }) }],
    ['a run already in flight', (r) => { r.brief.handoff = { state: 'wrapping' }; }, 'in-progress'],
    ['hidden from the dashboard', (r) => { r.brief.hidden = true; }, 'hidden'],
    ['a turn is running', (r) => { r.status = 'working'; }, 'not-idle'],
    ['a permission prompt is up', (r) => { r.status = 'waiting'; }, 'not-idle'],
    ['a question is pending', (r) => { r.waitingFor = 'question'; }, 'waiting'],
    ['compacting', (r) => { r.compacting = true; }, 'compacting'],
    ['the agent is booting', (r) => { r.agentReady = false; }, 'not-ready'],
    ['sitting out a usage cap', (r) => { r.usageLimit = { waiting: true }; }, 'capped'],
    ['it will wake itself (a build)', (r) => { r.reason = { kind: 'self' }; }, 'reason-self'],
    ['it asked you for something', (r) => { r.reason = { kind: 'you' }; }, 'reason-you'],
    ['parked in a menu', (r) => { r.reason = { kind: 'menu' }; }, 'reason-menu'],
    ['stopped only 5 minutes ago', (r) => { r.brief.stoppedAt = T - 5 * MIN; }, 'recent'],
    ['never finished a turn', (r) => { r.brief.stoppedAt = null; }, 'recent'],
    ['a new turn started after the last stop', (r) => { r.brief.turnAt = T - 1 * MIN; }, 'recent'],
    ['not at a boundary', (r) => { r.brief.wait = { on: 'self' }; }, 'no-boundary'],
    ['no metrics', (r) => { r.metrics = null; }, 'no-metrics'],
    ['no window', (r) => { r.metrics = { ctx: 60, ctxWindow: null }; }, 'no-metrics'],
    ['under the threshold', (r) => { r.metrics = { ctx: 40, ctxWindow: 1_000_000 }; }, 'small'],
  ];
  for (const [name, mutate, why, over] of gates) {
    test(`not suggested when ${name}`, () => {
      const r = candidate();
      mutate(r);
      const h = judge(r, over);
      expect(h.suggest).toBe(false);
      expect(h.why).toBe(why);
    });
  }

  test('a boundary is "external", "done", or every item finished', () => {
    const r = candidate();
    r.brief.wait = { on: 'done' };
    expect(judge(r).suggest).toBe(true);
    r.brief.wait = null;
    expect(judge(r).why).toBe('no-boundary');
    r.brief.items = [{ ref: '#1', state: 'committed' }, { ref: '#2', state: 'ready-for-test' }, { ref: '#3', state: 'done' }];
    expect(judge(r).suggest).toBe(true);
    // One unfinished item breaks it; no items at all is not a boundary.
    r.brief.items.push({ ref: '#4', state: 'blocked' });
    expect(judge(r).why).toBe('no-boundary');
    r.brief.items = [];
    expect(judge(r).why).toBe('no-boundary');
  });

  test('occupancy is percent x window, never the cumulative ctxTokens', () => {
    expect(H.occupancy({ ctx: 50, ctxWindow: 1_000_000, ctxTokens: 9_999_999 })).toBe(500_000);
    expect(H.occupancy({ ctx: 50 })).toBeNull();
    // Exactly the threshold qualifies.
    const r = candidate();
    r.metrics = { ctx: 50, ctxWindow: 1_000_000 };
    expect(judge(r).suggest).toBe(true);
  });

  test('config: thresholds are live values; a bad one falls back to the default', () => {
    expect(H.handoffConfig({ ctxThreshold: 700_000, idleMin: 5 })).toMatchObject({ ctxThreshold: 700_000, idleMin: 5, enabled: true });
    expect(H.handoffConfig({ ctxThreshold: -1, idleMin: 'x' })).toMatchObject({ ctxThreshold: 500_000, idleMin: 10 });
    const r = candidate();
    expect(judge(r, { cfg: H.handoffConfig({ ctxThreshold: 700_000 }) }).why).toBe('small');
  });

  test('force may skip only the judgement gates, never the safety ones', () => {
    expect([...H.FORCEABLE_GATES].sort()).toEqual(['no-boundary', 'no-metrics', 'recent', 'small']);
    for (const g of ['not-idle', 'waiting', 'compacting', 'not-ready', 'capped', 'reason-you', 'in-progress', 'hidden']) {
      expect(H.FORCEABLE_GATES).not.toContain(g);
    }
  });
});

test.describe('prompts and launch (#340)', () => {
  test('both prompts are ONE line (a compose submit with no newline is text + CR, #55)', () => {
    const w = H.wrapUpPrompt({ briefFile: 'C:\\x\\handoffs\\handoff-a.md', scriptPath: 'C:\\x\\scripts\\wt-handoff.js' });
    const s = H.successorPrompt({ briefFile: 'C:\\x\\handoffs\\handoff-a.md', oldName: 'my "big" session' });
    for (const p of [w, s]) expect(p).not.toMatch(/[\r\n]/);
    expect(w).toContain('C:\\x\\handoffs\\handoff-a.md');
    expect(w).toContain('node "C:/x/scripts/wt-handoff.js"');
    expect(w).toContain('"canClose"');
    // GitHub comments need the owner's approval of a draft, which an unattended wrap-up
    // cannot get.
    expect(w).toMatch(/GitHub issues: post NO comment/);
    expect(s).toContain('C:\\x\\handoffs\\handoff-a.md');
    expect(s).toContain("my 'big' session");
  });

  test('a successor starts a FRESH conversation: every resume flag is removed', () => {
    const launches = (c) => agents.commandLaunches('claude', c);
    const f = (c) => H.freshLaunchCommand(c, launches, agents.handoffPolicy('claude'));
    expect(f('claude --resume 1234-abcd --dangerously-skip-permissions')).toBe('claude --dangerously-skip-permissions');
    expect(f('claude --dangerously-skip-permissions --resume=1234-abcd')).toBe('claude --dangerously-skip-permissions');
    expect(f('claude -r 1234-abcd')).toBe('claude');
    expect(f('claude --continue --model opus')).toBe('claude --model opus');
    expect(f('claude -c')).toBe('claude');
    expect(f('claude --resume 1234 --fork-session')).toBe('claude');
    // `-r` only as a whole flag: `-rf`-style clusters are not touched.
    expect(f('claude --model x -rf')).toBe('claude --model x -rf');
    // A command that does not launch the agent at all is no answer.
    expect(f('pwsh')).toBeNull();
    expect(f('')).toBeNull();
    expect(f(null)).toBeNull();
    // The grammar is the registry's: no declaration, no strip, no successor command -
    // never Claude's flags applied to another agent (Codex's `-c` is a config override).
    expect(H.freshLaunchCommand('claude -c', launches, null)).toBeNull();
    expect(agents.handoffPolicy('codex')).toBeNull();
  });

  test('successor names count up instead of stacking', () => {
    expect(H.successorName('Fix login')).toBe('Fix login (2)');
    expect(H.successorName('Fix login (2)')).toBe('Fix login (3)');
    expect(H.successorName('')).toBe('Session (2)');
  });
});

test.describe('verdict and run (#340)', () => {
  test('the verdict an agent posts', () => {
    expect(H.validateHandoffReport({ canClose: true })).toEqual({ verdict: { canClose: true, why: null } });
    expect(H.validateHandoffReport({ canClose: false, why: 'unpushed branch fix/x' }))
      .toEqual({ verdict: { canClose: false, why: 'unpushed branch fix/x' } });
    // Kept open must say why, or the board cannot tell the person what to rescue.
    expect(H.validateHandoffReport({ canClose: false }).error).toMatch(/why/);
    expect(H.validateHandoffReport({ canClose: 'yes' }).error).toMatch(/canClose/);
    expect(H.validateHandoffReport(null).error).toBeTruthy();
    expect(H.validateHandoffReport([]).error).toBeTruthy();
  });

  test('timeouts: each in-flight state is bounded, measured from its own start', () => {
    const run = H.startRun(T, '/b.md');
    expect(run.state).toBe('wrapping');
    expect(H.overrun(run, T + cfg.wrapTimeoutMs, cfg)).toBeNull();
    expect(H.overrun(run, T + cfg.wrapTimeoutMs + 1, cfg)).toBe('no-brief');
    const sp = H.transition(run, 'spawning', T + MIN);
    expect(H.overrun(sp, T + MIN + cfg.readyTimeoutMs + 1, cfg)).toBe('successor-not-ready');
    const ve = H.transition(sp, 'verifying', T + 2 * MIN, { sentAt: T + 2 * MIN });
    expect(H.overrun(ve, T + 2 * MIN + cfg.successorTimeoutMs, cfg)).toBeNull();
    expect(H.overrun(ve, T + 2 * MIN + cfg.successorTimeoutMs + 1, cfg)).toBe('successor-not-up');
    // closing and the terminal states never time out.
    expect(H.overrun(H.transition(ve, 'closing', T), T + 10 * 60 * MIN, cfg)).toBeNull();
    expect(H.overrun(H.fail(ve, 'x', T), T + 10 * 60 * MIN, cfg)).toBeNull();
  });

  test('sameRun: a stale view never matches a cancelled, replaced or advanced run', () => {
    const run = H.startRun(T, '/b.md');
    expect(H.sameRun(run, run)).toBe(true);
    expect(H.sameRun({ ...run, successorId: 'x' }, run)).toBe(true); // same run, same state
    expect(H.sameRun(null, run)).toBe(false); // cancelled
    expect(H.sameRun(H.startRun(T + 1, '/b.md'), run)).toBe(false); // a new run
    expect(H.sameRun(H.transition(run, 'spawning', T + 1), run)).toBe(false); // moved on
  });

  test('closeDecision: kill only a finished, untouched session with a clean verdict', () => {
    const verdictAt = T;
    const closing = H.transition({ ...H.startRun(T - 10 * MIN, '/b'), verdict: { canClose: true }, verdictAt }, 'closing', T + MIN);
    const idle = { status: 'idle', turnAt: T - 5 * MIN, stoppedAt: T + 30 * 1000 };
    expect(H.closeDecision(closing, idle, T + 2 * MIN, cfg)).toEqual({ action: 'kill' });
    // Each condition alone:
    expect(H.closeDecision({ ...closing, verdict: { canClose: false, why: 'x' } }, idle, T + 2 * MIN, cfg))
      .toEqual({ action: 'keep', reason: 'unsaved-work' });
    expect(H.closeDecision(closing, { ...idle, turnAt: verdictAt + 1, stoppedAt: verdictAt + 2 }, T + 2 * MIN, cfg))
      .toEqual({ action: 'keep', reason: 'in-use' });
    expect(H.closeDecision(closing, { ...idle, status: 'working' }, T + 2 * MIN, cfg)).toEqual({ action: 'wait' });
    expect(H.closeDecision(closing, { ...idle, stoppedAt: null }, T + 2 * MIN, cfg)).toEqual({ action: 'wait' });
    // The wrap-up turn itself (started before the verdict) still running: wait, then give up kept.
    const busy = { status: 'working', turnAt: T - 5 * MIN, stoppedAt: T - 6 * MIN };
    expect(H.closeDecision(closing, busy, T + MIN + cfg.closeTimeoutMs, cfg)).toEqual({ action: 'wait' });
    expect(H.closeDecision(closing, busy, T + MIN + cfg.closeTimeoutMs + 1, cfg)).toEqual({ action: 'keep', reason: 'still-busy' });
  });

  test('the published run never carries the brief path; kept says why', () => {
    const run = H.transition(H.startRun(T, 'C:/secret/b.md'), 'kept', T + 1,
      { verdict: { canClose: false, why: 'unpushed' }, successorId: 's', successorName: 'n (2)', reason: 'unsaved-work' });
    const p = H.publicRun(run);
    expect(JSON.stringify(p)).not.toContain('secret');
    expect(p).toMatchObject({ state: 'kept', reason: 'unsaved-work', keptBecause: 'unpushed', successorId: 's', successorName: 'n (2)' });
    expect(H.publicRun(null)).toBeNull();
    expect(H.isActive(p)).toBe(false);
    expect(H.isActive(H.startRun(T, 'x'))).toBe(true);
  });
});
