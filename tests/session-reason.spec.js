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

  test('a running turn is working, whatever was reported', () => {
    expect(sessionReason({ status: 'working', ...reported('done') }).kind).toBe('working');
  });

  test('a live prompt beats a stale "done": mechanical wins', () => {
    const r = sessionReason({ status: 'waiting', waitingFor: 'question', ...reported('done') });
    expect(r).toMatchObject({ kind: 'you', text: 'answer a question', source: 'status' });
    expect(sessionReason({ status: 'waiting', waitingFor: 'permission' }).text).toBe('approve a tool');
  });

  test('a usage cap is self-resuming, with the time it resumes', () => {
    const r = sessionReason({ status: 'idle', usageLimit: { waiting: true, resumeAt: T + 60_000 }, ...reported('you') });
    expect(r).toMatchObject({ kind: 'self', source: 'usage-limit', until: T + 60_000 });
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
    expect(REASON_KINDS).toEqual(['working', 'you', 'self', 'external', 'done']);
  });

  test('an unknown reported kind is ignored, not invented', () => {
    expect(sessionReason({ status: 'idle', brief: { wait: { on: 'menu', what: 'x' } } })).toBeNull();
  });
});
