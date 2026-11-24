// @ts-check
// #540 layer 1 - no repeat check-in without a change. After a check-in is answered, the session is asked
// again only when its world moved (lib/check-in.js changeSignature: wait, items, running work, children,
// tracker) - never on the clock alone. Pure rule; each part is moved ALONE on an otherwise-perfect case, and
// the answer is which way it fell (#249's lesson: a negative that breaks two things proves neither).
const { test, expect } = require('@playwright/test');
const C = require('../lib/check-in');
const { sessionReason } = require('../lib/session-reason');

const T = 1_700_000_000_000;
const MIN = 60 * 1000;

/** A session that answered `external` to its check-in [ago] minutes ago and has been idle since: one item on a PR,
 *  one watcher running, one stopped child. Its record carries the baseline its answer left. */
function answered({ on = 'external', n = 1, ago = 61 } = {}) {
  const ended = T - ago * MIN;
  const sent = ended - 2 * MIN;
  const r = {
    id: 's1', agent: 'claude', status: 'idle', waitingFor: null, compacting: false, agentReady: true, blockedPrompt: null, inMenu: false,
    capBlocked: false, autoResumeArmed: false, usageLimit: null,
    backgroundTasks: [{ id: 'w1', kind: 'command', description: 'watch CI', startedAt: ended - 5 * MIN }],
    brief: { turnAt: sent + 1000, stoppedAt: ended, wait: { on, what: 'CI of PR 12', at: ended - 1000 },
      items: [{ ref: '#12', state: 'in-progress', stage: 'pr-open' }], handoff: null, checkInOff: false,
      checkIn: C.publicRecord({ ...C.startRecord(sent, 61, 'external', n), deliveredAt: sent + 1000, endedAt: ended, answer: { on, what: 'CI of PR 12' } }) },
  };
  const row = { ...r, reason: sessionReason(r) };
  const children = [{ id: 'c1', live: false, endedAt: ended - 30 * MIN }];
  const tracker = 'gh#12|open|false||org/repo#12:open';
  const base = C.changeSignature(row, { children, tracker });
  return { row: { ...row, brief: { ...row.brief, checkIn: { ...row.brief.checkIn, base } } }, children, tracker };
}
const ask = (s, over = {}) => C.checkInBlock(s.row, { now: T, supported: true, children: s.children, tracker: s.tracker, ...over });

test.describe('the change signature (#540)', () => {
  test('an unmoved world asks nothing; each of the five parts, moved alone, asks - and names itself', () => {
    const s = answered();
    expect(ask(s)).toBe('unchanged');
    const sig = (row, over = {}) => C.changeSignature(row, { children: s.children, tracker: s.tracker, ...over });
    const base = s.row.brief.checkIn.base;
    expect(C.changedParts(base, sig(s.row))).toEqual([]);
    const moves = {
      w: { row: { ...s.row, brief: { ...s.row.brief, wait: { ...s.row.brief.wait, what: 'CI of PR 13' } } } },
      i: { row: { ...s.row, brief: { ...s.row.brief, items: [{ ref: '#12', state: 'in-progress', stage: 'merged' }] } } },
      b: { row: { ...s.row, backgroundTasks: [{ id: 'w9', kind: 'command', description: 'watch CI', startedAt: T }] } },
      k: { row: s.row, over: { children: [{ id: 'c1', live: true, endedAt: null }] } },
      t: { row: s.row, over: { tracker: 'gh#12|closed|true||org/repo#12:merged' } },
    };
    for (const [part, m] of Object.entries(moves)) {
      expect(C.changedParts(base, sig(m.row, m.over))).toEqual([part]);
      // ...and the rule asks: the clock is due AND the world moved.
      const moved = { row: { ...m.row, brief: { ...m.row.brief, checkIn: s.row.brief.checkIn } }, children: (m.over && m.over.children) || s.children, tracker: (m.over && m.over.tracker) || s.tracker };
      expect(ask(moved)).toBeNull();
    }
  });

  test('order does not matter, the wait\'s time does not matter, a stale task is not running, and no text is kept in it', () => {
    const s = answered();
    const two = { ...s.row, brief: { ...s.row.brief, items: [{ ref: '#2', state: 'a' }, { ref: '#1', state: 'b' }] }, backgroundTasks: [{ id: 'x' }, { id: 'y' }] };
    const flip = { ...s.row, brief: { ...s.row.brief, items: [{ ref: '#1', state: 'b' }, { ref: '#2', state: 'a' }] }, backgroundTasks: [{ id: 'y' }, { id: 'x' }] };
    expect(C.changeSignature(two)).toEqual(C.changeSignature(flip));
    const reAt = { ...s.row, brief: { ...s.row.brief, wait: { ...s.row.brief.wait, at: T } } };
    expect(C.changeSignature(reAt, { children: s.children, tracker: s.tracker })).toEqual(C.changeSignature(s.row, { children: s.children, tracker: s.tracker }));
    // A task going stale is a task ending: the running set changed.
    const stale = { ...s.row, backgroundTasks: [{ ...s.row.backgroundTasks[0], stale: true }] };
    expect(C.changedParts(C.changeSignature(s.row), C.changeSignature(stale))).toEqual(['b']);
    // Hashes only: a wait's words never sit in a record.
    expect(JSON.stringify(C.changeSignature(s.row))).not.toContain('CI of PR');
    for (const v of Object.values(C.changeSignature(s.row))) expect(v).toMatch(/^[0-9a-f]{8}$/);
  });

  test('a change is something SEEN: no baseline, or no signature, is never a change', () => {
    const sig = C.changeSignature(answered().row);
    expect(C.changedParts(null, sig)).toEqual([]);
    expect(C.changedParts(sig, null)).toEqual([]);
    expect(C.changedParts(undefined, undefined)).toEqual([]);
    expect(C.changedParts({}, { w: 'x' })).toEqual(['w']);
  });
});

test.describe('the repeat is the clock AND a change (#540)', () => {
  test('the clock alone never asks; a change before the clock does not either', () => {
    const due = answered({ ago: 61 });
    expect(ask(due)).toBe('unchanged');
    // Moved, but the ladder's clock is not due (59 min): 'asked', the old once-per-period answer.
    const early = answered({ ago: 59 });
    const movedEarly = { ...early, row: { ...early.row, backgroundTasks: [] } };
    expect(ask(movedEarly)).toBe('asked');
    // Moved AND due: asked.
    expect(ask({ ...due, row: { ...due.row, backgroundTasks: [] } })).toBeNull();
    // The ladder keeps its steps after a change: the second ask waits 2 h, the third 4 h.
    const second = answered({ n: 2, ago: 119 });
    expect(ask({ ...second, row: { ...second.row, backgroundTasks: [] } })).toBe('asked');
    const second2 = answered({ n: 2, ago: 120 });
    expect(ask({ ...second2, row: { ...second2.row, backgroundTasks: [] } })).toBeNull();
  });

  test('no baseline recorded yet: the rule refuses and the pre-filter asks for the first look', () => {
    const s = answered();
    const noBase = { ...s, row: { ...s.row, brief: { ...s.row.brief, checkIn: { ...s.row.brief.checkIn, base: null } } } };
    expect(ask({ ...noBase, row: { ...noBase.row, backgroundTasks: [] } })).toBe('unchanged');
    const rec = { ...C.startRecord(T - 62 * MIN, 61, 'external'), deliveredAt: T - 61 * MIN, endedAt: T - 60 * MIN, answer: { on: 'external', what: 'x' } };
    expect(C.needsBaseline(rec)).toBe(true);
    expect(C.needsBaseline({ ...rec, answer: null })).toBe(true); // answered with no report: it may repeat as live-unreported
    // Nothing to compare for an answer that never repeats, an Esc, a check-in that never landed, or the cap.
    expect(C.needsBaseline({ ...rec, answer: { on: 'you', what: 'x' } })).toBe(false);
    expect(C.needsBaseline({ ...rec, answer: { on: 'done', what: 'x' } })).toBe(false);
    expect(C.needsBaseline({ ...rec, endedAt: null })).toBe(false);
    expect(C.needsBaseline({ ...rec, n: 4 })).toBe(false);
    expect(C.needsBaseline(null)).toBe(false);
    // Written once.
    const sig = C.changeSignature(answered().row);
    const withB = C.withBaseline(rec, sig);
    expect(withB.base).toEqual(sig);
    expect(C.needsBaseline(withB)).toBe(false);
    expect(C.withBaseline(withB, { w: 'other' }).base).toEqual(sig);
    expect(C.withBaseline(rec, null)).toBe(rec);
  });

  test('a wait on the owner or done, an Esc, and the cap never repeat, changed or not', () => {
    for (const on of ['you', 'done']) {
      const s = answered({ on, ago: 6000 });
      expect(ask({ ...s, row: { ...s.row, backgroundTasks: [] } })).toBe('asked');
    }
    const cap = answered({ n: 4, ago: 60000 });
    expect(ask({ ...cap, row: { ...cap.row, backgroundTasks: [] } })).toBe('asked');
  });

  test('fails CLOSED: a world that cannot be read is never typed into, changed or not', () => {
    const s = answered();
    const moved = { ...s, row: { ...s.row, backgroundTasks: [] } };
    expect(ask(moved)).toBeNull();
    expect(ask(moved, { liveKnown: false })).toBe('cannot-tell');
    // And an unmoved one stays quiet either way.
    expect(ask(s, { liveKnown: false })).toBe('unchanged');
    // Every earlier gate still says no first.
    expect(ask(moved, { inputAt: T - MIN })).toBe('typing');
    expect(ask(moved, { draft: true })).toBe('draft');
    expect(ask({ ...moved, row: { ...moved.row, status: 'working' } })).toBe('not-idle');
    expect(ask(moved, { cfg: C.checkInConfig({ enabled: false }) })).toBe('disabled');
  });

  test('a new turn is the change: the period is over and the next check-in is the first of a new one', () => {
    const s = answered({ ago: 61 });
    // The session woke on its own 10 min ago and went idle again: a turn after the check-in's own.
    const woke = { ...s.row, brief: { ...s.row.brief, turnAt: T - 12 * MIN, stoppedAt: T - 10 * MIN } };
    expect(C.periodOpen(woke.brief.checkIn, woke.brief.turnAt)).toBe(false);
    // Idle only 10 min: not yet a reading. At an hour of idleness it is asked, as n = 1.
    const late = { ...woke, brief: { ...woke.brief, turnAt: T - 62 * MIN, stoppedAt: T - 61 * MIN } };
    expect(C.checkInBlock(late, { now: T, supported: true, children: s.children })).toBeNull();
  });
});

test.describe('the pre-filter looks again only when worth it (#540)', () => {
  const entry = (rec) => ({ turnAt: T - 200 * MIN, stoppedAt: T - 190 * MIN, reported: { at: T - 191 * MIN, wait: { on: 'external', what: 'x', at: T - 191 * MIN } }, checkIn: rec });
  const rec = { ...C.startRecord(T - 192 * MIN, 61, 'external'), deliveredAt: T - 191 * MIN, endedAt: T - 190 * MIN + 1000, answer: { on: 'external', what: 'x' } };

  test('an answered check-in with a baseline is read at the clock, and a session found unchanged only every changeCheckMin', () => {
    const base = C.changeSignature(answered().row);
    const e = entry({ ...rec, endedAt: T - 100 * MIN, base });
    expect(C.worthReading(e, { now: T })).toBe(true);                       // 100 min since the answer: due
    expect(C.worthReading(e, { now: T - 50 * MIN })).toBe(false);           // 50 min since: not due
    const checked = (min) => entry({ ...rec, endedAt: T - 100 * MIN, base, checkedAt: T - min * MIN });
    expect(C.worthReading(checked(9), { now: T })).toBe(false);
    expect(C.worthReading(checked(11), { now: T })).toBe(true);
    expect(C.worthReading(checked(11), { now: T, cfg: C.checkInConfig({ changeCheckMin: 20 }) })).toBe(false);
    expect(C.checkInConfig({ changeCheckMin: 0 }).changeCheckMin).toBe(10);
  });
});
