// @ts-check
// #313 — WHY a session that is not working is not working. The rule is pure
// (lib/session-reason.js); every client renders its answer and never re-derives it.
// Pinned here: the precedence (a mechanical signal always beats what an agent
// reported), stale background shells not counting as work, and "nothing known"
// staying null so a client renders exactly what it did before.
const { test, expect } = require('@playwright/test');
const { sessionReason, REASON_KINDS } = require('../lib/session-reason');

const T = 1_700_000_000_000;
const reported = (on, what = 'x') => ({ brief: { wait: { on, what, at: T } } });

test.describe('sessionReason (#313)', () => {
  test('nothing known is null: the client renders today\'s row unchanged', () => {
    expect(sessionReason({ status: 'idle' })).toBeNull();
    expect(sessionReason({ status: 'active', brief: { wait: null } })).toBeNull();
    expect(sessionReason(null)).toBeNull();
  });

  test('a running turn is working, whatever else was reported', () => {
    expect(sessionReason({ status: 'working', ...reported('done') }).kind).toBe('working');
    expect(sessionReason({ status: 'working', ...reported('self') }).kind).toBe('working');
    expect(sessionReason({ status: 'working', ...reported('external') }).kind).toBe('working');
  });

  // A turn that ended asking the user for something while a helper it started still runs:
  // the status stays `working` (the subagent idle-gate), yet the person owes an answer.
  // Measured 2026-10-13 on "OSDP SC 23651 - B": three asks sat under Working, invisible.
  // A typed prompt clears a reported wait, so a "you" that exists is the agent's latest word.
  const turn = (turnAt, on, at, stoppedAt) => ({ brief: { turnAt, stoppedAt, wait: { on, what: 'bench approval + key choice', at } } });
  test('a "you" from a turn that ENDED beats working (a helper still runs) - the asks must reach Needs you', () => {
    const r = sessionReason({ status: 'working', ...turn(T, 'you', T + 5_000, T + 6_000) });
    expect(r.kind).toBe('you');
    expect(r.text).toBe('bench approval + key choice');
    expect(r.source).toBe('reported');
  });
  // A task notification starts a turn but clears only a "self" wait (lib/session-brief.js),
  // so a "you" from an EARLIER turn survives into it. It must not outrank the running turn.
  test('a "you" from an earlier turn does not beat a running turn', () => {
    expect(sessionReason({ status: 'working', ...turn(T + 60_000, 'you', T, T + 1_000) }).kind).toBe('working');
    // While the agent's own turn still runs, the turn wins - even over this turn's "you".
    expect(sessionReason({ status: 'working', ...turn(T, 'you', T + 5_000, null) }).kind).toBe('working');
    expect(sessionReason({ status: 'working', ...turn(T, 'you', T + 5_000, T - 1) }).kind).toBe('working');
    // No turn start known (an older server's row): never let a report outrank the status.
    expect(sessionReason({ status: 'working', brief: { wait: { on: 'you', what: 'x', at: T } } }).kind).toBe('working');
  });

  test('a live prompt beats a stale "done": mechanical wins', () => {
    const r = sessionReason({ status: 'waiting', waitingFor: 'question', ...reported('done') });
    expect(r).toMatchObject({ kind: 'you', text: 'answer a question', source: 'status' });
    expect(sessionReason({ status: 'waiting', waitingFor: 'permission' }).text).toBe('approve a tool');
  });

  test('an ARMED usage cap is self-resuming, labelled with the reset', () => {
    const r = sessionReason({ status: 'idle', usageLimit: { waiting: true, armed: true, resetAt: T, resumeAt: T + 60_000 }, ...reported('you') });
    expect(r).toMatchObject({ kind: 'self', source: 'usage-limit', until: T });
  });

  test('a cap nothing will resume is NOT "running on its own": it keeps its Capped status', () => {
    expect(sessionReason({ status: 'idle', usageLimit: { waiting: true, armed: false, resetAt: T }, ...reported('done') })).toBeNull();
  });

  test('live background work is self-resuming, named and aged', () => {
    const r = sessionReason({ status: 'idle', backgroundTasks: [{ id: 'b1', description: 'Wait for PR checks', startedAt: T }], ...reported('done') });
    expect(r).toMatchObject({ kind: 'self', text: 'Wait for PR checks', since: T, source: 'background' });
    const two = sessionReason({ status: 'idle', backgroundTasks: [{ id: 'a', description: 'build' }, { id: 'b', description: 'tests' }] });
    expect(two.text).toBe('build +1');
  });

  test('a STALE shell is not work: the reported reason shows instead', () => {
    const r = sessionReason({ status: 'idle', backgroundTasks: [{ id: 'proc-1', description: 'shell command', startedAt: T, stale: true }], ...reported('done', 'pushed') });
    expect(r).toMatchObject({ kind: 'done', text: 'pushed', source: 'reported' });
  });

  test('each reported wait comes through as itself', () => {
    for (const on of ['you', 'self', 'external', 'done']) {
      expect(sessionReason({ status: 'idle', ...reported(on, 'w') })).toMatchObject({ kind: on, text: 'w', since: T });
    }
    expect(REASON_KINDS).toEqual(['working', 'you', 'menu', 'self', 'external', 'done']);
  });

  test('an unknown reported kind is ignored, not invented', () => {
    expect(sessionReason({ status: 'idle', brief: { wait: { on: 'menu', what: 'x' } } })).toBeNull();
  });
});
