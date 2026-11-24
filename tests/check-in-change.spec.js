// @ts-check
// #540 layer 1 - no repeat check-in without a change. After a check-in is answered, the session is asked
// again only when its world moved (lib/check-in.js changeSignature: wait, its checkBy, items, running work,
// children, tracker, CI) - never on the clock alone. Pure rule; each part is moved ALONE on an otherwise-perfect case, and
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
  const ci = 'org/repo#12|running';
  const base = C.changeSignature(row, { children, tracker, ci, now: T });
  return { row: { ...row, brief: { ...row.brief, checkIn: { ...row.brief.checkIn, base } } }, children, tracker, ci };
}
const ask = (s, over = {}) => C.checkInBlock(s.row, { now: T, supported: true, children: s.children, tracker: s.tracker, ci: s.ci, ...over });

test.describe('the change signature (#540)', () => {
  test('an unmoved world asks nothing; each of the parts, moved alone, asks - and names itself', () => {
    const s = answered();
    expect(ask(s)).toBe('unchanged');
    const sig = (row, over = {}) => C.changeSignature(row, { children: s.children, tracker: s.tracker, ci: s.ci, now: T, ...over });
    const base = s.row.brief.checkIn.base;
    expect(C.changedParts(base, sig(s.row))).toEqual([]);
    const moves = {
      w: { row: { ...s.row, brief: { ...s.row.brief, wait: { ...s.row.brief.wait, what: 'CI of PR 13' } } } },
      i: { row: { ...s.row, brief: { ...s.row.brief, items: [{ ref: '#12', state: 'in-progress', stage: 'merged' }] } } },
      b: { row: { ...s.row, backgroundTasks: [{ id: 'w9', kind: 'command', description: 'watch CI', startedAt: T }] } },
      k: { row: s.row, over: { children: [{ id: 'c1', live: true, endedAt: null }] } },
      t: { row: s.row, over: { tracker: 'gh#12|closed|true||org/repo#12:merged' } },
      // The PR stays open and nothing else moves: CI finishing is the change a session waiting on CI wants to hear of.
      c: { row: s.row, over: { ci: 'org/repo#12|done|CI on PR org/repo#12 finished: 5 passed, 0 failed' } },
    };
    for (const [part, m] of Object.entries(moves)) {
      expect(C.changedParts(base, sig(m.row, m.over))).toEqual([part]);
      // ...and the rule asks: the clock is due AND the world moved.
      const moved = { row: { ...m.row, brief: { ...m.row.brief, checkIn: s.row.brief.checkIn } }, children: (m.over && m.over.children) || s.children,
        tracker: (m.over && m.over.tracker) || s.tracker, ci: (m.over && m.over.ci) || s.ci };
      expect(ask(moved)).toBeNull();
    }
  });

  test('order does not matter, the wait\'s time does not matter, a stale task is not running, and no text is kept in it', () => {
    const s = answered();
    const two = { ...s.row, brief: { ...s.row.brief, items: [{ ref: '#2', state: 'a' }, { ref: '#1', state: 'b' }] }, backgroundTasks: [{ id: 'x' }, { id: 'y' }] };
    const flip = { ...s.row, brief: { ...s.row.brief, items: [{ ref: '#1', state: 'b' }, { ref: '#2', state: 'a' }] }, backgroundTasks: [{ id: 'y' }, { id: 'x' }] };
    expect(C.changeSignature(two)).toEqual(C.changeSignature(flip));
    const reAt = { ...s.row, brief: { ...s.row.brief, wait: { ...s.row.brief.wait, at: T } } };
    const full = { children: s.children, tracker: s.tracker, ci: s.ci };
    expect(C.changeSignature(reAt, full)).toEqual(C.changeSignature(s.row, full));
    // A task going stale is a task ending: the running set changed.
    const stale = { ...s.row, backgroundTasks: [{ ...s.row.backgroundTasks[0], stale: true }] };
    expect(C.changedParts(C.changeSignature(s.row), C.changeSignature(stale))).toEqual(['b']);
    // Hashes only: a wait's words never sit in a record.
    expect(JSON.stringify(C.changeSignature(s.row, full))).not.toContain('CI of PR');
    for (const v of Object.values(C.changeSignature(s.row, full))) expect(v).toMatch(/^[0-9a-f]{8}$/);
  });

  test('a change is something SEEN: no baseline, or no signature, is never a change', () => {
    const sig = C.changeSignature(answered().row);
    expect(C.changedParts(null, sig)).toEqual([]);
    expect(C.changedParts(sig, null)).toEqual([]);
    expect(C.changedParts(undefined, undefined)).toEqual([]);
    expect(C.changedParts({}, { w: 'x' })).toEqual([]); // a part the baseline never saw is not a change either
    expect(C.changedParts({ w: 'y' }, { w: 'x' })).toEqual(['w']);
  });

  test('a CI that finishes with the PR still open is the change a session waiting on CI wants (the #540 review)', () => {
    // It waits {on:'external', what:'verify-ci on PR 12'}; the PR stays open, CI goes pending -> green, and nothing
    // else moves. Before #540 the #463 ladder asked it at 60 min; the signature never saw CI, so nothing did.
    const s = answered();
    expect(ask(s)).toBe('unchanged');
    expect(ask(s, { ci: 'org/repo#12|done|CI on PR org/repo#12 finished: 5 passed, 0 failed' })).toBeNull();
    // Failing is a different state of the same finish: it asks too.
    expect(ask(s, { ci: 'org/repo#12|done|CI on PR org/repo#12 finished: 4 passed, 1 failed' })).toBeNull();
    // The clock still gates it: CI finishing 20 min after the answer asks nothing yet.
    const early = answered({ ago: 20 });
    expect(ask(early, { ci: 'org/repo#12|done|x' })).toBe('asked');
  });

  test('the wait\'s target and checkBy are part of the wait; a checkBy that passes is a change', () => {
    const s = answered();
    const sig = (wait, now = T) => C.changeSignature({ ...s.row, brief: { ...s.row.brief, wait } }, { children: s.children, tracker: s.tracker, ci: s.ci, now });
    const w0 = { ...s.row.brief.wait };
    const base = sig(w0);
    expect(C.changedParts(base, sig({ ...w0, target: { kind: 'ci', provider: 'github', repo: 'o/r', pr: 12 } }))).toEqual(['w']);
    expect(C.changedParts(sig({ ...w0, target: { kind: 'pr', provider: 'github', repo: 'o/r', number: 12 } }),
      sig({ ...w0, target: { kind: 'pr', provider: 'github', repo: 'o/r', number: 13 } }))).toEqual(['w']);
    expect(C.changedParts(base, sig({ ...w0, checkBy: 90 }))).toEqual(['w', 'o']);
    // Overdue: the same wait, the same world, an hour later - only `o` moved, and the rule asks.
    const timed = { ...w0, checkBy: 120 };
    const b0 = sig(timed, T);
    expect(C.changedParts(b0, sig(timed, T + 30 * MIN))).toEqual([]);
    expect(C.changedParts(b0, sig(timed, T + 70 * MIN))).toEqual(['o']);
    const row = { ...s.row, brief: { ...s.row.brief, wait: timed, checkIn: { ...s.row.brief.checkIn, base: b0 } } };
    const o = { supported: true, children: s.children, tracker: s.tracker, ci: s.ci };
    expect(C.checkInBlock(row, { now: T, ...o })).toBe('unchanged');
    expect(C.checkInBlock(row, { now: T + 70 * MIN, ...o })).toBeNull();
    // A wait with no checkBy has no deadline to pass.
    expect(C.changedParts(base, sig(w0, T + 9999 * MIN))).toEqual([]);
  });

  test('a read that FAILED is not a change: the part is carried, and filled in when a read next works', () => {
    const s = answered();
    // The tracker times out, or answers 401: its part is null, and nothing else moved.
    expect(ask(s, { tracker: null })).toBe('unchanged');
    expect(ask(s, { ci: null })).toBe('unchanged');
    expect(ask(s, { tracker: null, ci: null })).toBe('unchanged');
    // A real change elsewhere still asks while a read is down.
    expect(ask({ ...s, row: { ...s.row, backgroundTasks: [] } }, { tracker: null, ci: null })).toBeNull();
    // A baseline taken while a read was down holds a null there; the first look that can read fills it in,
    // without calling it a change, and from then on that part counts.
    const down = C.changeSignature(s.row, { children: s.children, tracker: null, ci: s.ci, now: T });
    expect(down.t).toBeNull();
    const rec = { ...s.row.brief.checkIn, base: down };
    const up = C.changeSignature(s.row, { children: s.children, tracker: s.tracker, ci: s.ci, now: T });
    expect(C.changedParts(down, up)).toEqual([]);
    const filled = C.fillBaseline(rec, up);
    expect(filled.base.t).toBe(up.t);
    expect(C.fillBaseline(filled, { ...up, t: 'moved' })).toBe(filled);   // filled once, never moved
    expect(C.fillBaseline({ ...rec, base: null }, up).base).toBeNull();      // no baseline at all is not filled either
    expect(C.changedParts(filled.base, C.changeSignature(s.row, { children: s.children, tracker: 'gh#12|closed', ci: s.ci, now: T }))).toEqual(['t']);
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

  test('no baseline recorded yet: the pre-filter asks for the first look, within baselineWithinMin of the answer', () => {
    const rec = { ...C.startRecord(T - 62 * MIN, 61, 'external'), deliveredAt: T - 61 * MIN, endedAt: T - 60 * MIN, answer: { on: 'external', what: 'x' } };
    const at = (min) => rec.endedAt + min * MIN;
    expect(C.needsBaseline(rec, undefined, at(1))).toBe(true);
    expect(C.needsBaseline(rec, undefined, at(10))).toBe(true);
    expect(C.needsBaseline(rec, undefined, at(11))).toBe(false);   // a first look this late saw a world that may have moved
    expect(C.needsBaseline(rec)).toBe(true);                        // no clock given: the within-window rule has nothing to read
    expect(C.needsBaseline({ ...rec, answer: null }, undefined, at(1))).toBe(true); // answered with no report: it may repeat as live-unreported
    // Nothing to compare for an answer that never repeats, an Esc, a check-in that never landed, or the cap.
    expect(C.needsBaseline({ ...rec, answer: { on: 'you', what: 'x' } }, undefined, at(1))).toBe(false);
    expect(C.needsBaseline({ ...rec, answer: { on: 'done', what: 'x' } }, undefined, at(1))).toBe(false);
    expect(C.needsBaseline({ ...rec, endedAt: null }, undefined, at(1))).toBe(false);
    expect(C.needsBaseline({ ...rec, n: 4 }, undefined, at(1))).toBe(false);
    expect(C.needsBaseline(null)).toBe(false);
    // Written once.
    const sig = C.changeSignature(answered().row);
    const withB = C.withBaseline(rec, sig);
    expect(withB.base).toEqual(sig);
    expect(C.needsBaseline(withB, undefined, at(1))).toBe(false);
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

test.describe('the review of #540 (PR 542)', () => {
  test('the CI part: the open PRs of the items, read by the one reader of CI, and no state when a lookup failed', () => {
    const metas = [
      { tracker: 'github', key: 'o/r#7', fetchedAt: 1, type: 'Issue', state: 'open', repo: 'o/r',
        prs: [{ state: 'open', repo: 'o/r', number: 12 }, { state: 'merged', repo: 'o/r', number: 3 }, { state: 'open', repo: 'o/r', number: 12 }] },
      { tracker: 'github', key: 'o/r#9', fetchedAt: 1, type: 'Pull request', state: 'open', repo: 'o/r', prs: [] },  // an item that IS an open PR
      { tracker: 'ado', key: 'ado:5', fetchedAt: 1, state: 'Active', prs: [{ state: 'open', repo: 'am8', number: 40 }] },
      { tracker: 'github', key: 'o/r#1', fetchedAt: null, prs: [{ state: 'open', repo: 'o/r', number: 99 }] },       // never read: nothing known
      { tracker: 'github', key: 'o/r#2', fetchedAt: 1, type: 'Pull request', state: 'merged', repo: 'o/r', prs: [] }, // merged: the tracker part says so
    ];
    expect(C.ciTargets(metas)).toEqual([
      { kind: 'ci', provider: 'github', repo: 'o/r', pr: 12 }, { kind: 'ci', provider: 'github', repo: 'o/r', pr: 9 }, { kind: 'ci', provider: 'ado', repo: 'am8', pr: 40 }]);
    expect(C.ciTargets(metas, 2)).toHaveLength(2);
    expect(C.ciTargets([])).toEqual([]);
    expect(C.ciTargets(null)).toEqual([]);
    // What `gh pr view --json statusCheckRollup` answers (lib/wait-target.js fromLookup): running, then finished with the counts.
    const t = { kind: 'ci', provider: 'github', repo: 'o/r', pr: 12 };
    const roll = (...runs) => ({ kind: 'gh-checks', json: { statusCheckRollup: runs } });
    const run = (status, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion });
    expect(C.ciPart(t, roll(run('IN_PROGRESS'), run('COMPLETED', 'SUCCESS')))).toBe('o/r#12|running|');
    expect(C.ciPart(t, roll(run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SUCCESS')))).toBe('o/r#12|done|CI on PR o/r#12 finished: 2 passed, 0 failed');
    expect(C.ciPart(t, roll(run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE')))).toBe('o/r#12|done|CI on PR o/r#12 finished: 1 passed, 1 failed');
    // Pending -> green is a different text; a failed lookup, or an answer it cannot place, is NO text (null: carried, not a change).
    expect(C.ciPart(t, roll(run('IN_PROGRESS')))).not.toBe(C.ciPart(t, roll(run('COMPLETED', 'SUCCESS'))));
    for (const bad of [{ state: 'unknown' }, { state: 'gone' }, { kind: 'gh-checks', json: {} }, { kind: 'nonsense', json: {} }, null, undefined]) expect(C.ciPart(t, bad)).toBeNull();
  });

  test('the deploy case: an answer an older server gave has no baseline; a world that moved before the first look still asks', () => {
    // Old server answered at 10:00, the PR merged at 10:40, this server started at 10:50 and its first look is now.
    const s = answered({ ago: 50 });             // answered 50 min ago
    const rec = { ...s.row.brief.checkIn, base: null };
    const noBase = { ...s, row: { ...s.row, brief: { ...s.row.brief, checkIn: rec } } };
    const merged = { ...noBase, row: { ...noBase.row, brief: { ...noBase.row.brief, items: [{ ref: '#12', state: 'done', stage: 'merged' }] } }, tracker: 'gh#12|closed|true||org/repo#12:merged' };
    // The first look is 50 min after the answer: too late to trust a baseline, so none is recorded...
    expect(C.needsBaseline(rec, undefined, T)).toBe(false);
    // ...and 10 min later the clock is due, no baseline means changed once, and it is asked - as the old ladder did.
    const hourLater = T + 10 * MIN;
    expect(ask(noBase, { now: hourLater })).toBeNull();
    expect(ask(merged, { now: hourLater })).toBeNull();
    // Before the clock is due it is the old once-per-period answer.
    expect(ask(noBase, { now: T })).toBe('asked');
    // The check-in it gets is answered by a session whose baseline IS recorded at its first look: no second free ask.
    const next = { ...C.startRecord(hourLater, 61, 'external', 2), deliveredAt: hourLater + 1000, endedAt: hourLater + 60000, answer: { on: 'external', what: 'x' } };
    expect(C.needsBaseline(next, undefined, hourLater + 2 * 60000)).toBe(true);
  });

  test('a skip is not a check-in that was asked: it never uses the cap or doubles the wait; three skips, then a change, asks', () => {
    const s = answered({ ago: 61 });
    const o = { supported: true, children: s.children, tracker: s.tracker, ci: s.ci };
    // One real check-in (n = 1) was typed and answered; the world then moves and the pre-check says skip, three times.
    let rec = s.row.brief.checkIn;
    let now = T;
    for (let i = 0; i < 3; i += 1) {
      const moved = { ...s.row, backgroundTasks: [{ id: `w${i + 5}`, kind: 'command', description: 'watch', startedAt: now }], brief: { ...s.row.brief, checkIn: rec } };
      expect(C.checkInBlock(moved, { now, ...o })).toBeNull(); // asked: due and changed
      const skip = C.skipRecord(now, 61, 'external', rec, { verdict: 'skip', reason: 'CI pending', model: 'm', wait: moved.brief.wait,
        baseline: C.changeSignature(moved, { children: s.children, tracker: s.tracker, ci: s.ci, now }) });
      expect(skip.n).toBe(1);                                  // carried: only one check-in was ever typed
      expect(C.repeatPossible(skip)).toBe(true);
      rec = C.publicRecord(skip);
      now += 61 * MIN;                                          // one period later - not 2 h, not 4 h
    }
    // The fourth look: the world moved again after the third skip; the cap is untouched and the wait was one period.
    const last = { ...s.row, backgroundTasks: [{ id: 'w99', kind: 'command', description: 'watch', startedAt: now }], brief: { ...s.row.brief, checkIn: rec } };
    expect(C.checkInBlock(last, { now, ...o })).toBeNull();
    // A skip with nothing typed before it counts none; the first typed one after it is the first.
    const first = C.skipRecord(T, 61, 'external', null, { verdict: 'skip', reason: 'x', model: 'm', wait: s.row.brief.wait, baseline: null });
    expect(first.n).toBe(0);
    expect(C.askCount(first)).toBe(0);
    expect(C.repeatTimeDue(first, T + 60 * MIN)).toBe(true);
    expect(C.repeatTimeDue(first, T + 59 * MIN)).toBe(false);
    // The ladder for TYPED check-ins is as it was: the second waits 2 h, the third 4 h.
    const typed2 = { ...C.startRecord(T, 61, 'external', 2), deliveredAt: T, endedAt: T, answer: { on: 'external', what: 'x' } };
    expect(C.repeatTimeDue(typed2, T + 119 * MIN)).toBe(false);
    expect(C.repeatTimeDue(typed2, T + 120 * MIN)).toBe(true);
  });
});
