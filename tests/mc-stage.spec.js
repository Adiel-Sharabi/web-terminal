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
    expect(S.evidenceStage(meta({ prs: [{ number: 7, state: 'open' }, { number: 8, state: 'merged' }] }))).toEqual({ stage: 'merged', source: 'pr', detail: 'PR #8 merged' });
    expect(S.evidenceStage(meta({ closed: true, state: 'Resolved' }))).toEqual({ stage: 'merged', source: 'tracker', detail: 'work item is Resolved' });
    expect(S.evidenceStage(meta({ prs: [{ number: 9, state: 'closed' }] }))).toBe(null); // an abandoned PR proves nothing
  });

  test('a merged PR shows merged even though the agent last said fixing', () => {
    const f = S.foldStage({ history: [], reported: 'fixing', reportedAt: T0, meta: meta({ prs: [{ number: 43, state: 'merged' }] }), now: T0 + 5 });
    expect(f.stage).toMatchObject({ current: 'merged', reported: 'fixing', evidence: 'merged' });
    expect(f.stage.history).toEqual([
      { stage: 'fixing', at: T0, source: 'report', detail: null },
      { stage: 'merged', at: T0 + 5, source: 'pr', detail: 'PR #43 merged' },
    ]);
    expect(f.changed).toBe(true);
  });

  test('a stale report never moves a stage backwards; nothing new changes nothing', () => {
    const first = S.foldStage({ history: [], reported: 'pr-open', reportedAt: T0, meta: null, now: T0 });
    const later = S.foldStage({ history: first.history, reported: 'fixing', reportedAt: T0 + 10, meta: null, now: T0 + 10 });
    expect(later.stage).toMatchObject({ current: 'pr-open', reported: 'fixing', evidence: null });
    expect(later.history).toEqual(first.history);
    expect(later.changed).toBe(false);
  });

  test('no report and no evidence: no stage at all', () => {
    expect(S.foldStage({ history: [], reported: null, meta: meta(), now: T0 }).stage).toEqual({ current: null, reported: null, evidence: null, history: [] });
  });

  test('a stored history is cleaned: unknown stages and steps back dropped', () => {
    expect(S.cleanHistory([{ stage: 'fixing', at: 1, source: 'report' }, { stage: 'nope', at: 2 }, { stage: 'triage', at: 3 }, { stage: 'merged', at: 4, source: 'pr', detail: 'x' }]))
      .toEqual([{ stage: 'fixing', at: 1, source: 'report', detail: null }, { stage: 'merged', at: 4, source: 'pr', detail: 'x' }]);
  });
});
