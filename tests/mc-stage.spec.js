// @ts-check
// #505 - a work item's progress stage: the order (lib/mc-stage.js), the optional `stage` on a
// report (lib/session-brief.js), evidence from the tracker beating a stale report, and a
// history that never moves backwards. Pure; the subjects view that folds it is pinned in
// mc-subjects.spec.js.
const { test, expect } = require('@playwright/test');
const S = require('../lib/mc-stage');
const B = require('../lib/session-brief');

const T0 = 1_700_000_000_000;
const meta = (over = {}) => ({ key: 'acme/widgets#42', fetchedAt: T0, closed: false, state: 'open', prs: [], ...over });

test.describe('#505 the stage order and words', () => {
  test('eight stages, in order', () => {
    expect(S.STAGES).toEqual(['triage', 'reproduced', 'planned', 'fixing', 'pr-open', 'in-review', 'merged', 'tested']);
    expect(S.stageIndex('fixing')).toBeLessThan(S.stageIndex('merged'));
    expect(S.stageIndex('nope')).toBe(-1);
    expect(S.maxStage('fixing', 'merged')).toBe('merged');
    expect(S.maxStage('merged', 'fixing')).toBe('merged');
    expect(S.maxStage(null, null)).toBe(null);
  });

  test('plausible words map; a state word is not taken for a stage', () => {
    expect(S.normalizeStage(' PR Open ')).toBe('pr-open');
    expect(S.normalizeStage('repro')).toBe('reproduced');
    expect(S.normalizeStage('verified')).toBe('tested');
    expect(S.normalizeStage('in_review')).toBe('in-review');
    expect(S.normalizeStage('in-progress')).toBe(null);
    expect(S.normalizeStage('done')).toBe(null);
    expect(S.normalizeStage(3)).toBe(null);
  });
});

test.describe('#505 stage on a report', () => {
  test('optional: a report without it is valid and its brief items keep every field, stage null', () => {
    const v = B.validateReport({ items: [{ ref: '#5', title: 'Thing', state: 'in-progress' }] });
    expect(v.error).toBeUndefined();
    expect(v.report.items[0]).toEqual({ ref: '#5', title: 'Thing', state: 'in-progress', note: '' });
    const e = B.applyReport(B.emptyEntry(), v.report, T0);
    const it = B.buildBrief(e, { reporting: true }).items[0];
    expect(it).toMatchObject({ ref: '#5', key: '#5', title: 'Thing', state: 'in-progress', note: '', source: 'agent', url: null, stage: null });
  });

  test('a stage is normalised and carried to the brief item', () => {
    const v = B.validateReport({ items: [{ ref: '#5', title: 'Thing', state: 'in-progress', stage: 'Fixing' }] });
    expect(v.report.items[0].stage).toBe('fixing');
    const e = B.applyReport(B.emptyEntry(), v.report, T0);
    expect(B.buildBrief(e, { reporting: true }).items[0].stage).toBe('fixing');
  });

  test('an unknown stage is refused with the list; an empty one is no stage', () => {
    const bad = B.validateReport({ items: [{ ref: '#5', state: 'in-progress', stage: 'almost' }] });
    expect(bad.error).toContain('items[0].stage "almost" is not one of: triage, reproduced');
    expect(B.validateReport({ items: [{ ref: '#5', state: 'in-progress', stage: '' }] }).report.items[0].stage).toBeUndefined();
  });

  test('a pin never carries a stage; a pinned item shows the agent\'s', () => {
    const p = B.validatePinned([{ ref: '#5', stage: 'merged' }]);
    expect(p.pinned[0].stage).toBeUndefined();
    let e = { ...B.emptyEntry(), pinned: p.pinned };
    e = B.applyReport(e, B.validateReport({ items: [{ ref: '#5', state: 'in-progress', stage: 'pr-open' }] }).report, T0);
    const it = B.buildBrief(e, { reporting: true }).items[0];
    expect(it).toMatchObject({ source: 'pinned', stage: 'pr-open' });
  });

  test('the note names the stages in one clause and quotes a reported stage back', () => {
    const e = B.applyReport(B.emptyEntry(), B.validateReport({ items: [{ ref: '#5', title: 'T', state: 'in-progress', stage: 'planned' }] }).report, T0);
    const t = B.instructionText(e, 'CMD');
    expect(t).toContain('Optional item "stage": triage, reproduced, planned, fixing, pr-open, in-review, merged, tested.');
    expect(t).toContain('"stage":"planned"');
    expect(B.instructionText(B.applyReport(B.emptyEntry(), { items: [{ ref: '#5', title: 'T', state: 'blocked', note: '' }], headline: null }, T0), 'CMD'))
      .toContain('{"items":[{"ref":"#5","title":"T","state":"blocked"}],"headline":null}');
  });

  test('the Stop-hook block rule does not ask for a stage', () => {
    // A report with items and no stage satisfies the rule exactly as before.
    const worked = { ...B.emptyEntry(), toolsSinceReport: B.BLOCK_UNREPORTED_AFTER_TOOLS };
    expect(B.stopBlockReason(worked, {}, T0, 'CMD')).toContain('never reported'); // the control
    const e = B.applyReport(worked, B.validateReport({ items: [{ ref: '#5', state: 'in-progress' }] }).report, T0 + 100);
    expect(B.stopBlockReason(e, {}, T0 + 200, 'CMD')).toBe(null);
  });
});

test.describe('#505 evidence beats the report', () => {
  test('what the tracker proves', () => {
    expect(S.evidenceStage(null)).toBe(null);
    expect(S.evidenceStage(meta({ fetchedAt: null, closed: true }))).toBe(null); // never read: proves nothing
    expect(S.evidenceStage(meta())).toBe(null);
    expect(S.evidenceStage(meta({ prs: [{ number: 7, state: 'open', draft: true }] }))).toEqual({ stage: 'pr-open', source: 'pr', detail: 'PR #7 open (draft)' });
    expect(S.evidenceStage(meta({ prs: [{ number: 7, state: 'open', reviews: 2 }] }))).toMatchObject({ stage: 'in-review' });
    expect(S.evidenceStage(meta({ prs: [{ number: 8, state: 'merged' }] }))).toEqual({ stage: 'merged', source: 'pr', detail: 'PR #8 merged' });
    // A PR still open beside a merged one: the work goes on (phase A merged, phase B open).
    expect(S.evidenceStage(meta({ prs: [{ number: 7, state: 'open' }, { number: 8, state: 'merged' }] }))).toEqual({ stage: 'pr-open', source: 'pr', detail: 'PR #7 open' });
    // ...unless the work item itself is closed.
    expect(S.evidenceStage(meta({ closed: true, state: 'closed', prs: [{ number: 7, state: 'open' }, { number: 8, state: 'merged' }] }))).toEqual({ stage: 'merged', source: 'pr', detail: 'PR #8 merged' });
    expect(S.evidenceStage(meta({ closed: true, state: 'Resolved' }))).toEqual({ stage: 'merged', source: 'tracker', detail: 'work item is Resolved' });
    expect(S.evidenceStage(meta({ prs: [{ number: 9, state: 'closed' }] }))).toBe(null); // an abandoned PR proves nothing
    // A subject that IS a pull request: its own state; closed unmerged is abandoned, not resolved.
    const pr = (o) => meta({ type: 'Pull request', ...o });
    expect(S.evidenceStage(pr({ state: 'closed', closed: true }))).toBe(null);
    expect(S.evidenceStage(pr({ state: 'merged', closed: true }))).toMatchObject({ stage: 'merged', source: 'pr' });
    expect(S.evidenceStage(pr({ state: 'open' }))).toMatchObject({ stage: 'pr-open', source: 'pr' });
  });

  test("#561 the work item's own state proves its stage (AM8's workflow)", () => {
    // Open states that say how far the code got.
    expect(S.evidenceStage(meta({ state: 'Committed' }))).toEqual({ stage: 'pr-open', source: 'tracker', detail: 'work item is Committed (pushed, not on mainline)' });
    expect(S.evidenceStage(meta({ state: 'Parked' }))).toMatchObject({ stage: 'pr-open', source: 'tracker' });
    expect(S.evidenceStage(meta({ state: 'Merged' }))).toEqual({ stage: 'merged', source: 'tracker', detail: 'work item is Merged (on mainline)' });
    expect(S.evidenceStage(meta({ state: 'ready for test' }))).toMatchObject({ stage: 'merged', detail: 'work item is ready for test (released, on the QA desk)' });
    // Done is verified: further than a merged PR.
    expect(S.evidenceStage(meta({ state: 'Done', closed: true, prs: [{ number: 8, state: 'merged' }] }))).toEqual({ stage: 'tested', source: 'tracker', detail: 'work item is Done (verified)' });
    // States that prove nothing: not started, worked on, waiting, not reproducible, reopened.
    for (const state of ['New', 'Approved', 'In Progress', 'More info required', 'Not Reproducible', 'Reopen', 'Postponed', 'open']) {
      expect(S.evidenceStage(meta({ state }))).toBe(null);
    }
    // The furthest wins; on a tie the pull request names it.
    expect(S.evidenceStage(meta({ state: 'Committed', prs: [{ number: 7, state: 'open', reviews: 1 }] }))).toMatchObject({ stage: 'in-review', source: 'pr' });
    expect(S.evidenceStage(meta({ state: 'Committed', prs: [{ number: 7, state: 'open' }] }))).toEqual({ stage: 'pr-open', source: 'pr', detail: 'PR #7 open' });
    expect(S.evidenceStage(meta({ state: 'Ready for test', prs: [{ number: 7, state: 'open' }] }))).toMatchObject({ stage: 'merged', source: 'tracker' });
    // A closed item that was given up proves nothing by being closed - unless a PR really merged.
    expect(S.evidenceStage(meta({ state: 'Removed', closed: true }))).toBe(null);
    expect(S.evidenceStage(meta({ state: 'Removed', closed: true, prs: [{ number: 8, state: 'merged' }] }))).toMatchObject({ stage: 'merged', source: 'pr' });
    // A state name that is an inherited object key is not a state.
    expect(S.evidenceStage(meta({ state: 'constructor' }))).toBe(null);
  });

  test('#561 a state-proved stage is withdrawn when the item moves back (Ready for test -> Reopen)', () => {
    const first = S.foldStage({ history: [], reports: [], meta: meta({ state: 'Ready for test' }), now: T0 });
    expect(first.stage.current).toBe('merged');
    const back = S.foldStage({ history: first.history, reports: [], meta: meta({ state: 'Reopen' }), now: T0 + 1000 });
    expect(back.stage.current).toBe(null);
    expect(back.changed).toBe(true);
  });

  test('a merged PR shows merged even though the agent last said fixing', () => {
    const f = S.foldStage({ history: [], reports: [{ stage: 'fixing', at: T0 }], meta: meta({ prs: [{ number: 43, state: 'merged' }] }), now: T0 + 5 });
    expect(f.stage).toMatchObject({ current: 'merged', reported: 'fixing', evidence: 'merged' });
    expect(f.stage.history).toEqual([
      { stage: 'fixing', at: T0, source: 'report', detail: null },
      { stage: 'merged', at: T0 + 5, source: 'pr', detail: 'PR #43 merged' },
    ]);
    expect(f.changed).toBe(true);
  });

  test('a stale report never moves a stage backwards; nothing new changes nothing', () => {
    const first = S.foldStage({ history: [], reports: [{ stage: 'pr-open', at: T0 }], meta: null, now: T0 });
    const later = S.foldStage({ history: first.history, reports: [{ stage: 'fixing', at: T0 + 10 }], meta: meta(), now: T0 + 10 });
    expect(later.stage).toMatchObject({ current: 'pr-open', reported: 'fixing', evidence: null });
    expect(later.history).toEqual(first.history);
    expect(later.changed).toBe(false);
  });

  test('no report and no evidence: no stage at all', () => {
    expect(S.foldStage({ history: [], reports: [], meta: meta(), now: T0 }).stage).toEqual({ current: null, reported: null, evidence: null, history: [] });
  });

  test('a stage only the tracker proved is withdrawn when a fresh read no longer proves it; a reported one never is', () => {
    const closed = S.foldStage({ history: [], reports: [{ stage: 'fixing', at: T0 }], meta: meta({ closed: true, state: 'Resolved' }), now: T0 + 1 });
    expect(closed.stage.current).toBe('merged');
    // Reopened: the tracker no longer proves merged - back to what the report holds.
    const reopened = S.foldStage({ history: closed.history, reports: [{ stage: 'fixing', at: T0 }], meta: meta({ state: 'Active' }), now: T0 + 2 });
    expect(reopened.stage.current).toBe('fixing');
    expect(reopened.history.map((h) => h.stage)).toEqual(['fixing']);
    expect(reopened.changed).toBe(true);
    // A read that FAILED (error set, the old copy served) withdraws nothing.
    const failed = S.foldStage({ history: closed.history, reports: [], meta: meta({ state: 'Active', error: 'GitHub answered HTTP 500' }), now: T0 + 2 });
    expect(failed.stage.current).toBe('merged');
    // Nor does a PARTIAL read (the timeline or a linked PR could not be read: `warning`, PRs missing).
    const pr = S.foldStage({ history: [], reports: [], meta: meta({ prs: [{ number: 5, state: 'merged' }] }), now: T0 });
    const partial = S.foldStage({ history: pr.history, reports: [], meta: meta({ prs: [], warning: 'the linked pull requests could not be read' }), now: T0 + 1 });
    expect(partial.stage.current).toBe('merged');
    expect(partial.changed).toBe(false);
    // Phase A merged, then phase B's PR opens: merged is withdrawn to pr-open.
    const a = S.foldStage({ history: [], reports: [], meta: meta({ prs: [{ number: 1, state: 'merged' }] }), now: T0 });
    const b = S.foldStage({ history: a.history, reports: [], meta: meta({ prs: [{ number: 1, state: 'merged' }, { number: 2, state: 'open' }] }), now: T0 + 1 });
    expect(b.history.map((h) => [h.stage, h.source])).toEqual([['pr-open', 'pr']]);
    // A stage an agent REPORTED stays, whatever the tracker says later.
    const rep = S.foldStage({ history: [], reports: [{ stage: 'merged', at: T0 }], meta: meta(), now: T0 });
    expect(S.foldStage({ history: rep.history, reports: [], meta: meta(), now: T0 + 1 }).stage.current).toBe('merged');
  });

  test("every session's current stage is folded in; the newest names `reported`", () => {
    const f = S.foldStage({ history: [], reports: [{ stage: 'planned', at: T0 + 10 }, { stage: 'pr-open', at: T0 }], meta: null, now: T0 + 20 });
    expect(f.stage).toMatchObject({ current: 'pr-open', reported: 'planned' });
  });

  test('a stored history is cleaned: unknown stages and steps back dropped', () => {
    expect(S.cleanHistory([{ stage: 'fixing', at: 1, source: 'report' }, { stage: 'nope', at: 2 }, { stage: 'triage', at: 3 }, { stage: 'merged', at: 4, source: 'pr', detail: 'x' }]))
      .toEqual([{ stage: 'fixing', at: 1, source: 'report', detail: null }, { stage: 'merged', at: 4, source: 'pr', detail: 'x' }]);
  });
});
