// @ts-check
// #467 - supervisor phase 2, the pure rules: quiet hours (lib/quiet-hours.js), the wait
// resolvers (lib/wait-target.js resolveLocal / fromLookup), the shared absence rule, R1 wake
// and R2 tell (lib/supervisor.js planActions), the owner ladder (ownerPlan), the held-push
// summary (lib/notify-push.js heldSummary) and the gated prompt's `stale` refusal. Every
// negative changes ONE input of a case the positive accepts, so a refusal is proven to come
// from the gate it names.
const { test, expect } = require('@playwright/test');
const Q = require('../lib/quiet-hours');
const WT = require('../lib/wait-target');
const SV = require('../lib/supervisor');
const SP = require('../lib/safe-prompt');
const NP = require('../lib/notify-push');
const B = require('../lib/session-brief');
const { SUPERVISOR_PROMPT_TAG } = require('../lib/user-turn');
const FIXTURE = require('./fixtures/jerusalem-holy-days-2026-2027.json');

const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const T0 = Date.UTC(2026, 10, 18, 10, 0, 0); // a Wednesday, 12:00 in Jerusalem
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const jlm = (iso) => Date.parse(iso); // fixture times carry their own offset

test.describe('#467 quiet hours', () => {
  const holyOnly = Q.quietConfig({ nights: null, marginMin: 0 });

  test('every published Jerusalem Shabbat and Yom Tov window of 2026-2027 is matched within 2.5 minutes', () => {
    expect(FIXTURE.windows.length).toBeGreaterThan(100);
    for (const w of FIXTURE.windows) {
      const c = jlm(w.candles), h = jlm(w.havdalah);
      const q = Q.quietAt(c + 30 * MIN, holyOnly);
      expect(q.quiet, w.candles).toBe(true);
      expect(Math.abs(q.since - c), `candles ${w.candles}`).toBeLessThanOrEqual(2.5 * MIN);
      expect(Math.abs(q.until - h), `havdalah ${w.havdalah}`).toBeLessThanOrEqual(2.5 * MIN);
    }
  });

  test('the hour of margin on each side, and none outside it', () => {
    const cfg = Q.quietConfig({ nights: null }); // margin 60 by default
    const w = FIXTURE.windows.find((x) => x.candles.startsWith('2026-11-20'));
    const c = jlm(w.candles), h = jlm(w.havdalah);
    expect(Q.quietAt(c - 57 * MIN, cfg).quiet).toBe(true);
    expect(Q.quietAt(c - 63 * MIN, cfg).quiet).toBe(false);
    expect(Q.quietAt(h + 57 * MIN, cfg).quiet).toBe(true);
    expect(Q.quietAt(h + 63 * MIN, cfg).quiet).toBe(false);
  });

  test('a weekday Yom Tov is quiet; the diaspora second day of Pesach and a plain weekday are not', () => {
    expect(Q.quietAt(Date.UTC(2026, 8, 21, 9), holyOnly)).toMatchObject({ quiet: true, why: ['yomtov'] }); // Yom Kippur, Monday
    expect(Q.quietAt(Date.UTC(2026, 8, 22, 9), holyOnly).quiet).toBe(false);
    expect(Q.holyDayOf(2026, 4, 3)).toBe(null); // 16 Nisan: a Yom Tov only outside Israel (a Friday)
    expect(Q.quietAt(Date.UTC(2026, 3, 3, 9), holyOnly).quiet).toBe(false);
    expect(Q.quietAt(T0, holyOnly).quiet).toBe(false);
    expect(Q.holyDayOf(2027, 3, 21)).toBe(null); // 12 Adar II, a Sunday
  });

  test('nights 22:00-08:00 Jerusalem, in winter and in summer time', () => {
    const cfg = Q.quietConfig({ holyDays: false });
    for (const [y, m, d] of [[2026, 11, 18], [2026, 7, 15]]) {
      const at = (hh, mm) => Q.zonedTime(y, m, d, hh * 60 + mm, 'Asia/Jerusalem');
      expect(Q.quietAt(at(21, 59), cfg).quiet, `${m} 21:59`).toBe(false);
      expect(Q.quietAt(at(22, 1), cfg).quiet, `${m} 22:01`).toBe(true);
      expect(Q.quietAt(at(7, 59), cfg).quiet, `${m} 07:59`).toBe(true);
      expect(Q.quietAt(at(8, 1), cfg).quiet, `${m} 08:01`).toBe(false);
      expect(Q.zonedParts(at(22, 1), 'Asia/Jerusalem')).toMatchObject({ hh: 22, mm: 1 });
    }
  });

  test('touching windows are ONE: Friday night ends when Shabbat ends, not at 08:00', () => {
    const cfg = Q.quietConfig({});
    const w = FIXTURE.windows.find((x) => x.candles.startsWith('2026-11-20'));
    const q = Q.quietAt(Q.zonedTime(2026, 11, 20, 23 * 60, 'Asia/Jerusalem'), cfg);
    expect(q.quiet).toBe(true);
    expect(Math.abs(q.until - (jlm(w.havdalah) + HOUR))).toBeLessThanOrEqual(2.5 * MIN);
    expect(q.why.sort()).toEqual(['night', 'shabbat']);
    // Rosh Hashanah (Sat-Sun 2026): one run from Friday evening to Sunday night.
    const rh = FIXTURE.windows.find((x) => x.candles.startsWith('2026-09-11'));
    const r = Q.quietAt(jlm(rh.candles) + 24 * HOUR, Q.quietConfig({ nights: null, marginMin: 0 }));
    expect(Math.abs(r.until - jlm(rh.havdalah))).toBeLessThanOrEqual(2.5 * MIN);
  });

  test('switched off, or a bad field, never throws and never silences by accident', () => {
    expect(Q.quietAt(Date.UTC(2026, 10, 21, 10), Q.quietConfig(false)).quiet).toBe(false);
    expect(Q.quietAt(Date.UTC(2026, 10, 21, 10), Q.quietConfig({ enabled: false })).quiet).toBe(false);
    const bad = Q.quietConfig({ nights: '25:00-99', timeZone: 'Not/AZone', candleMin: 'x' });
    expect(bad).toMatchObject({ nights: { from: 22 * 60, to: 8 * 60 }, timeZone: 'Asia/Jerusalem', candleMin: 40 });
  });
});

test.describe('#467 wait resolvers', () => {
  const node = (n, over = {}) => ({ id: ID(n), server: 'Home', name: `s${n}`, status: 'idle', wait: null, leadId: null, parentId: null, ...over });
  const waiter = (target, at = T0) => node(1, { wait: { on: 'external', what: 'x', at, target } });
  const ctx = (nodes, { absent = {}, verdict = null, now = T0 + MIN } = {}) => {
    const by = new Map(nodes.map((x) => [x.id, x]));
    return { find: (id) => by.get(id) || null, absence: (id) => absent[id] || 'unknown', leadVerdict: verdict, now };
  };

  test('session: done or a NEW report resolves; an older report is pending; absence follows the two-scan rule', () => {
    const t = { kind: 'session', id: ID(2) };
    const w = waiter(t);
    const res = (other, opt) => WT.resolveLocal(t, { waiter: w, ...ctx(other ? [other] : [], opt) });
    expect(res(node(2, { wait: { on: 'done', what: '', at: T0 - HOUR } }))).toMatchObject({ state: 'resolved', fact: 'session "s2" reported done' });
    expect(res(node(2, { wait: { on: 'self', what: 'ci', at: T0 + 1 } })).state).toBe('resolved');
    expect(res(node(2, { wait: { on: 'self', what: 'ci', at: T0 } })).state).toBe('pending'); // not newer than the wait
    expect(res(node(2)).state).toBe('pending');
    expect(res(null, { absent: { [ID(2)]: 'gone' } })).toMatchObject({ state: 'gone', fact: `session ${ID(2).slice(0, 8)} is gone from every machine` });
    expect(res(null, { absent: { [ID(2)]: 'suspect' } }).state).toBe('pending');
    expect(res(null).state).toBe('unknown');
  });

  test('lead: the orphan verdict decides its absence; a live lead resolves like a session', () => {
    const t = { kind: 'lead' };
    const w = { ...waiter(t), parentId: ID(9) };
    expect(WT.resolveLocal(t, { waiter: w, ...ctx([], { verdict: { state: 'orphan' } }) }).state).toBe('gone');
    expect(WT.resolveLocal(t, { waiter: w, ...ctx([], { verdict: { state: 'suspect' } }) }).state).toBe('pending');
    expect(WT.resolveLocal(t, { waiter: w, ...ctx([], { verdict: { state: 'unknown' } }) }).state).toBe('unknown');
    const live = { ...w, leadId: ID(9) };
    expect(WT.resolveLocal(t, { waiter: live, ...ctx([node(9, { wait: { on: 'done', at: T0 - 1 } })]) }).state).toBe('resolved');
    expect(WT.resolveLocal(t, { waiter: { ...waiter(t) }, ...ctx([]) }).state).toBe('unknown'); // no lead at all
  });

  test('child: resolved only when EVERY child is done or gone', () => {
    const t = { kind: 'child', ids: [ID(2), ID(3)] };
    const done2 = node(2, { wait: { on: 'done', at: T0 - 1 } });
    const r = (nodes, absent) => WT.resolveLocal(t, { waiter: waiter(t), ...ctx(nodes, { absent }) });
    expect(r([done2], { [ID(3)]: 'gone' })).toMatchObject({ state: 'resolved', fact: 'every child is finished (1 reported done, 1 gone)' });
    expect(r([done2], { [ID(3)]: 'suspect' }).state).toBe('pending');
    expect(r([done2], {}).state).toBe('unknown');
    expect(r([done2, node(3, { wait: { on: 'self', at: T0 + 5 } })], {}).state).toBe('pending'); // a new wait is not done
  });

  test('time: resolved once it has passed', () => {
    const t = { kind: 'time', until: new Date(T0 + 10 * MIN).toISOString() };
    expect(WT.resolveLocal(t, { waiter: waiter(t), ...ctx([], { now: T0 + 10 * MIN }) }).state).toBe('resolved');
    expect(WT.resolveLocal(t, { waiter: waiter(t), ...ctx([], { now: T0 + 10 * MIN - 1 }) }).state).toBe('pending');
    expect(WT.resolveLocal({ kind: 'pr', provider: 'github', repo: 'o/r', number: 1 }, { waiter: waiter(t), ...ctx([]) })).toBe(null);
  });

  test('GitHub answers: merged/closed resolve, a review AFTER the wait resolves, checks finish', () => {
    const pr = { kind: 'pr', provider: 'github', repo: 'o/r', number: 12 };
    expect(WT.fromLookup('gh-pr', { state: 'MERGED' }, { target: pr, since: T0 })).toMatchObject({ state: 'resolved', fact: 'PR o/r#12 was merged' });
    expect(WT.fromLookup('gh-pr', { state: 'CLOSED' }, { target: pr, since: T0 }).state).toBe('resolved');
    const review = (at) => ({ state: 'OPEN', reviews: [{ state: 'APPROVED', submittedAt: new Date(at).toISOString() }] });
    expect(WT.fromLookup('gh-pr', review(T0 + 1000), { target: pr, since: T0 })).toMatchObject({ state: 'resolved', fact: 'PR o/r#12 got a new review (approved)' });
    expect(WT.fromLookup('gh-pr', review(T0 - 1000), { target: pr, since: T0 }).state).toBe('pending');
    expect(WT.fromLookup('gh-pr', {}, { target: pr, since: T0 }).state).toBe('unknown');

    const ci = { kind: 'ci', provider: 'github', repo: 'o/r', pr: 12 };
    const run = (status, conclusion) => ({ __typename: 'CheckRun', status, conclusion });
    expect(WT.fromLookup('gh-checks', { statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')] }, { target: ci }).state).toBe('pending');
    expect(WT.fromLookup('gh-checks', { statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE'),
      { __typename: 'StatusContext', state: 'SUCCESS' }] }, { target: ci })).toMatchObject({ state: 'resolved', fact: 'CI on PR o/r#12 finished: 2 passed, 1 failed' });
    expect(WT.fromLookup('gh-checks', { statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }] }, { target: ci }).state).toBe('pending');
    expect(WT.fromLookup('gh-checks', { statusCheckRollup: [] }, { target: ci }).state).toBe('pending'); // CI not started
    expect(WT.fromLookup('gh-run', { status: 'completed', conclusion: 'failure' }, { target: { ...ci, pr: undefined, runId: '7' } }).fact).toBe('run o/r#7 finished: failure');
    expect(WT.fromLookup('gh-run', { status: 'in_progress' }, { target: ci }).state).toBe('pending');
  });

  test('"its state changed" needs a baseline: the first answer is pending, a different later one resolves', () => {
    const wi = { kind: 'workitem', ref: 'o/r#5' };
    const first = WT.fromLookup('gh-issue', { state: 'OPEN' }, { target: wi });
    expect(first).toEqual({ state: 'pending', fact: '', sig: 'OPEN' });
    expect(WT.fromLookup('gh-issue', { state: 'OPEN' }, { target: wi, baseline: 'OPEN' }).state).toBe('pending');
    expect(WT.fromLookup('gh-issue', { state: 'CLOSED' }, { target: wi, baseline: 'OPEN' })).toMatchObject({ state: 'resolved', fact: 'o/r#5 is now closed' });
    const adoWi = { kind: 'workitem', ref: 'ado:9' };
    expect(WT.fromLookup('ado-wi', { fields: { 'System.State': 'Committed' } }, { target: adoWi, baseline: 'In Progress' }).fact).toBe('ado:9 is now Committed');
    const adoPr = { kind: 'pr', provider: 'ado', repo: 'p/r', number: 3 };
    const votes = (v) => ({ status: 'active', reviewers: [{ id: 'a', vote: v }] });
    const base = WT.fromLookup('ado-pr', votes(0), { target: adoPr }).sig;
    expect(WT.fromLookup('ado-pr', votes(0), { target: adoPr, baseline: base }).state).toBe('pending');
    expect(WT.fromLookup('ado-pr', votes(10), { target: adoPr, baseline: base })).toMatchObject({ state: 'resolved', fact: 'PR p/r#3 got a new vote' });
    expect(WT.fromLookup('ado-pr', { status: 'completed' }, { target: adoPr }).state).toBe('resolved');
  });

  test('ADO builds: only runs queued since the wait count; a failed lookup is unknown, never gone', () => {
    const ci = { kind: 'ci', provider: 'ado', repo: 'p/r', pr: 4 };
    const b = (q, status, result) => ({ queueTime: new Date(q).toISOString(), status, result });
    expect(WT.fromLookup('ado-builds', { value: [b(T0 - HOUR, 'completed', 'succeeded')] }, { target: ci, since: T0 }).state).toBe('pending');
    expect(WT.fromLookup('ado-builds', { value: [b(T0 + MIN, 'completed', 'failed'), b(T0 + MIN, 'completed', 'succeeded')] }, { target: ci, since: T0 }))
      .toMatchObject({ state: 'resolved', fact: 'CI on PR p/r#4 finished: 1 passed, 1 failed' });
    expect(WT.fromLookup('ado-builds', { value: [b(T0 + MIN, 'inProgress', '')] }, { target: ci, since: T0 }).state).toBe('pending');
    expect(WT.fromLookup('ado-build', '<html>sign in</html>', { target: ci }).state).toBe('unknown');
    expect(WT.ghFailure('GraphQL: Could not resolve to a PullRequest with the number of 99.')).toBe('gone');
    expect(WT.ghFailure('GraphQL: Could not resolve to an Issue with the number of 99.')).toBe('gone');
    expect(WT.ghFailure("GraphQL: Could not resolve to a Repository with the name 'o/r'.")).toBe('unknown');
    expect(WT.ghFailure('error connecting to api.github.com')).toBe('unknown');
    expect(WT.ghFailure('')).toBe('unknown');
  });

  test('a bare #123 is qualified with the reporting repo, everything else is left alone', () => {
    const origin = { kind: 'github', owner: 'Own', repo: 'Rep' };
    const q = (t) => WT.qualifyTarget(t, (ref) => B.globalKey(ref, origin));
    expect(q({ kind: 'workitem', ref: '#12' })).toEqual({ kind: 'workitem', ref: 'own/rep#12' });
    expect(q({ kind: 'workitem', ref: 'ado:12' })).toEqual({ kind: 'workitem', ref: 'ado:12' });
    expect(q({ kind: 'pr', provider: 'github', repo: 'o/r', number: 1 })).toEqual({ kind: 'pr', provider: 'github', repo: 'o/r', number: 1 });
    expect(WT.qualifyTarget({ kind: 'workitem', ref: '#12' }, (ref) => B.globalKey(ref, null))).toEqual({ kind: 'workitem', ref: '#12' });
  });
});

test.describe('#467 the absence rule, shared by orphans and gone targets', () => {
  const scan = (nodes, at, complete = true) => ({ at, complete, nodes, aliases: {} });

  test('gone only after two complete scans confirmMs apart; an incomplete scan decides nothing', () => {
    const ids = [ID(5)];
    const s1 = SV.noteAbsent({}, ids, scan([], T0), { confirmMs: 5 * MIN });
    expect(s1.states[ID(5)]).toBe('suspect');
    const s2 = SV.noteAbsent(s1.sightings, ids, scan([], T0 + 5 * MIN - 1), { confirmMs: 5 * MIN });
    expect(s2.states[ID(5)]).toBe('suspect');
    const u = SV.noteAbsent(s2.sightings, ids, scan([], T0 + 9 * MIN, false), { confirmMs: 5 * MIN });
    expect(u.states[ID(5)]).toBe('unknown');
    expect(u.sightings[ID(5)]).toEqual(s2.sightings[ID(5)]); // kept, not advanced
    expect(SV.noteAbsent(u.sightings, ids, scan([], T0 + 10 * MIN), { confirmMs: 5 * MIN }).states[ID(5)]).toBe('gone');
    // Seen again: no state, and the sighting is dropped.
    const back = SV.noteAbsent(s2.sightings, ids, scan([{ id: ID(5) }], T0 + 10 * MIN), { confirmMs: 5 * MIN });
    expect(back).toEqual({ sightings: {}, states: {} });
    // A replaced id is present through its successor.
    expect(SV.noteAbsent({}, ids, { ...scan([{ id: ID(6) }], T0), aliases: { [ID(5)]: ID(6) } }).states).toEqual({});
    // Never seen in scope: unknown, never gone.
    expect(SV.noteAbsent(s2.sightings, ids, scan([], T0 + 10 * MIN), { confirmMs: 5 * MIN, known: new Set() }).states[ID(5)]).toBe('unknown');
  });
});

test.describe('#467 R1 wake and R2 tell', () => {
  const cfg = SV.supervisorConfig({});
  const timeT = { kind: 'time', until: new Date(T0).toISOString() };
  const n = (over = {}) => ({ id: ID(1), server: 'Home', name: 's1', wait: { on: 'external', what: 'the timer', at: T0 - HOUR, target: timeT }, ...over });
  const plan = (nodes, over = {}) => SV.planActions({ graph: { nodes }, verdicts: {}, resolutions: { [ID(1)]: { state: 'resolved', fact: 'the time has passed' } },
    done: new Set(), acts: {}, now: T0, cfg, ...over });

  test('a resolved or gone target wakes its session once, with the fact, and names the wait it answers', () => {
    const [a] = plan([n()]);
    expect(a).toEqual({ key: `wake|${ID(1)}|${T0 - HOUR}`, id: ID(1), server: 'Home', rule: 'R1',
      text: 'Your wait "the timer" changed: the time has passed. Carry on, or report a new wait.', expectWaitAt: T0 - HOUR });
    expect(plan([n()], { resolutions: { [ID(1)]: { state: 'gone', fact: 'x' } } })).toHaveLength(1);
    // Each gate, one at a time.
    expect(plan([n()], { done: new Set([a.key]) })).toEqual([]);
    expect(plan([n()], { resolutions: { [ID(1)]: { state: 'pending', fact: '' } } })).toEqual([]);
    expect(plan([n()], { resolutions: { [ID(1)]: { state: 'unknown', fact: '' } } })).toEqual([]);
    expect(plan([n({ wait: { ...n().wait, on: 'you' } })])).toEqual([]);
    expect(plan([n({ wait: { ...n().wait, target: undefined } })])).toEqual([]);
    expect(plan([n()], { acts: { [ID(1)]: [T0 - 10 * MIN, T0 - 20 * MIN, T0 - 30 * MIN, T0 - 40 * MIN] } })).toEqual([]);
    expect(plan([n()], { acts: { [ID(1)]: [T0 - 61 * MIN, T0 - 20 * MIN, T0 - 30 * MIN, T0 - 40 * MIN] } })).toHaveLength(1);
  });

  test('every wake prompt fits the 511-byte budget with its tag, even a long multi-byte fact', () => {
    const fact = `${String.fromCodePoint(0x05d0).repeat(400)} done`;
    const text = SV.wakeText(String.fromCodePoint(0x1f600).repeat(200), fact);
    expect(Buffer.byteLength(`${SUPERVISOR_PROMPT_TAG} ${text}`, 'utf8')).toBeLessThanOrEqual(511);
    expect(SP.promptOf({ text }).prompt).toBeTruthy();
    expect(SP.promptOf({ text: SV.orphanText(ID(3)) }).prompt).toBeTruthy();
  });

  test('an orphan is told once that its lead is gone; one whose wait names the lead is told by R1 only', () => {
    const verdicts = { [ID(1)]: { state: 'orphan', parentId: ID(9) } };
    const free = n({ wait: { on: 'external', what: 'review', at: T0 - HOUR } }); // no target: not R1's
    const [t] = plan([free], { verdicts, resolutions: {} });
    expect(t).toMatchObject({ key: `orphan|${ID(1)}|${ID(9)}`, rule: 'R2', expectWaitAt: null });
    expect(t.text).toContain(ID(9).slice(0, 8));
    expect(plan([free], { verdicts, resolutions: {}, done: new Set([t.key]) })).toEqual([]);
    expect(plan([free], { verdicts: { [ID(1)]: { state: 'suspect', parentId: ID(9) } }, resolutions: {} })).toEqual([]);
    const onLead = n({ wait: { on: 'external', what: 'lead', at: T0 - HOUR, target: { kind: 'lead' } } });
    const both = plan([onLead], { verdicts, resolutions: { [ID(1)]: { state: 'gone', fact: 'your lead is gone' } } });
    expect(both.map((x) => x.rule)).toEqual(['R1']);
    // R1 already delivered for that wait: still no R2 on top of it.
    expect(plan([onLead], { verdicts, resolutions: { [ID(1)]: { state: 'gone', fact: 'x' } }, done: new Set([both[0].key]) })).toEqual([]);
  });
});

test.describe('#467 R4 the owner ladder', () => {
  const cfg = SV.supervisorConfig({ remindEveryMin: 120 });
  const you = (n, at, source = 'reported') => ({ id: ID(n), server: 'Home', name: `s${n}`,
    wait: { on: 'you', what: `pick ${n}`, at }, reason: { kind: 'you', text: '', source } });
  const step = (nodes, ladder, now, quiet = false, complete = true) => SV.ownerPlan({ graph: { nodes, complete }, ladder, quiet, now, cfg });

  test('by day: a push when the wait starts, a reminder every 2 h, none in between', () => {
    const s1 = step([you(1, T0)], {}, T0);
    expect(s1.pushes).toEqual([{ key: `${ID(1)}|${T0}`, id: ID(1), server: 'Home', name: 's1', what: 'pick 1', n: 1 }]);
    expect(step([you(1, T0)], s1.ladder, T0 + 119 * MIN).pushes).toEqual([]);
    expect(step([you(1, T0)], s1.ladder, T0 + 120 * MIN).pushes.map((p) => p.n)).toEqual([2]);
  });

  test('an answer stops it, a new report restarts it; an approval is counted, never pushed', () => {
    const s1 = step([you(1, T0)], {}, T0);
    expect(step([], s1.ladder, T0 + MIN).ladder).toEqual({}); // a complete scan without it: gone
    expect(step([{ ...you(1, T0), wait: null, reason: { kind: 'idle', source: 'status' } }], s1.ladder, T0 + MIN).ladder).toEqual({}); // answered
    expect(step([you(1, T0 + 5 * MIN)], s1.ladder, T0 + 5 * MIN).pushes).toHaveLength(1);
    expect(step([you(2, T0, 'status')], {}, T0).pushes).toEqual([]);
    expect(SV.ownerWaitOf({ ...you(1, T0), reason: { kind: 'working', source: 'status' } })).toBe(false); // mid-turn
  });

  test('quiet hours hold what falls due; the first scan after sends ONE summary of everything waiting', () => {
    const q1 = step([you(1, T0)], {}, T0, true);
    expect(q1.pushes).toEqual([]);
    expect(q1.summary).toBe(null);
    const q2 = step([you(1, T0), you(2, T0 + HOUR)], q1.ladder, T0 + 8 * HOUR, true);
    expect(q2.pushes).toEqual([]);
    const nodes = [you(1, T0), you(2, T0 + HOUR), you(3, T0, 'status')];
    const out = step(nodes, q2.ladder, T0 + 9 * HOUR, false);
    expect(out.pushes).toEqual([]);
    expect(out.summary).toEqual({ count: 3, id: ID(1), server: 'Home', name: 's1' });
    // Sent once: the next scan neither repeats the summary nor pushes each wait.
    const after = step(nodes, out.ladder, T0 + 9 * HOUR + MIN, false);
    expect(after).toMatchObject({ pushes: [], summary: null });
    // Nothing held (a wait pushed before the night and not due): no summary at the end.
    const day = step([you(1, T0)], {}, T0);
    expect(step([you(1, T0)], day.ladder, T0 + 30 * MIN, true).ladder[`${ID(1)}|${T0}`].held).toBe(false);
    expect(step([you(1, T0)], step([you(1, T0)], day.ladder, T0 + 30 * MIN, true).ladder, T0 + 60 * MIN).summary).toBe(null);
  });
});

test.describe('#467 review fixes', () => {
  const cfg = SV.supervisorConfig({ remindEveryMin: 120 });
  const you = (n, at) => ({ id: ID(n), server: 'Home', name: `s${n}`, wait: { on: 'you', what: `pick ${n}`, at }, reason: { kind: 'you', text: '', source: 'reported' } });
  const step = (nodes, ladder, now, complete = true) => SV.ownerPlan({ graph: { nodes, complete }, ladder, quiet: false, now, cfg });

  test('R4: a wait out of sight for a scan keeps its place - no push again on its return', () => {
    const s1 = step([you(1, T0)], {}, T0);
    expect(s1.pushes).toHaveLength(1);
    // A Monitor event: the session reads working for a moment, the same wait still on it.
    const working = { ...you(1, T0), reason: { kind: 'working', source: 'status' } };
    const s2 = step([working], s1.ladder, T0 + MIN);
    expect(s2.pushes).toEqual([]);
    expect(step([you(1, T0)], s2.ladder, T0 + 2 * MIN).pushes).toEqual([]); // back, inside the interval
    // A peer missed one poll (an incomplete scan): kept too.
    const s3 = step([], s1.ladder, T0 + MIN, false);
    expect(step([you(1, T0)], s3.ladder, T0 + 2 * MIN).pushes).toEqual([]);
    // Still reminded on time.
    expect(step([you(1, T0)], s3.ladder, T0 + 120 * MIN).pushes.map((p) => p.n)).toEqual([2]);
  });

  test('a session waiting on its waiter is a mutual wait, never a wake (both would wake forever)', () => {
    const lead = { id: ID(1), server: 'Home', parentId: null, replaces: [ID(7)], wait: { on: 'external', what: 'the child', at: T0, target: { kind: 'session', id: ID(2) } } };
    const ctx = (child) => ({ waiter: lead, find: (id) => (id === ID(2) ? child : null), absence: () => 'unknown', leadVerdict: null, now: T0 + HOUR });
    const child = (target) => ({ id: ID(2), server: 'Home', parentId: ID(1), wait: { on: 'external', what: 'the lead', at: T0 + MIN, ...(target ? { target } : {}) } });
    expect(WT.resolveLocal(lead.wait.target, ctx(child(null))).state).toBe('resolved'); // a plain new report: news
    expect(WT.resolveLocal(lead.wait.target, ctx(child({ kind: 'lead' }))).state).toBe('pending');
    expect(WT.resolveLocal(lead.wait.target, ctx(child({ kind: 'session', id: ID(1) }))).state).toBe('pending');
    expect(WT.resolveLocal(lead.wait.target, ctx(child({ kind: 'session', id: ID(7) }))).state).toBe('pending'); // an old id of mine
    expect(WT.resolveLocal(lead.wait.target, ctx(child({ kind: 'session', id: ID(3) }))).state).toBe('resolved');
  });

  test('R2: an orphan that reported done is not told', () => {
    const verdicts = { [ID(1)]: { state: 'orphan', parentId: ID(9) } };
    const node = (wait) => ({ id: ID(1), server: 'Home', name: 's1', wait });
    const plan = (nodes) => SV.planActions({ graph: { nodes }, verdicts, resolutions: {}, done: new Set(), acts: {}, now: T0, cfg });
    expect(plan([node({ on: 'external', what: 'x', at: T0 - HOUR })])).toHaveLength(1);
    expect(plan([node({ on: 'done', what: '', at: T0 - HOUR })])).toEqual([]);
  });
});

test.describe('#467 held pushes and the stale gate', () => {
  test('held pushes collapse to one, of the most important kind', () => {
    expect(NP.heldSummary([])).toBe(null);
    const one = { id: ID(1), kind: 'idle', name: 'a', reason: 'finished', at: 1 };
    expect(NP.heldSummary([one])).toEqual({ kind: 'idle', id: ID(1), name: 'a', reason: 'finished' });
    const many = NP.heldSummary([one, { id: ID(2), kind: 'approval', name: 'b', reason: 'x', at: 2 }, { id: ID(3), kind: 'approval', name: 'c', reason: 'y', at: 3 }]);
    expect(many).toEqual({ kind: 'approval', id: ID(3), name: 'c', reason: '3 sessions while it was quiet: 2 need approval, 1 finished' });
    expect(NP.QUIET_HOLDABLE).not.toContain('clear');
    expect(NP.buildNtfyMessage('owner-wait', { sessionName: 's', serverName: 'Home', reason: 'Waiting on you: x' })).toMatchObject({ title: 'Home: s', priority: 4 });
  });

  test('a prompt that names the wait it answers is refused once the session reported again', () => {
    expect(SP.promptOf({ text: 'x', expectWaitAt: 5 })).toEqual({ prompt: `${SUPERVISOR_PROMPT_TAG} x`, expectWaitAt: 5 });
    expect(SP.promptOf({ text: 'x', expectWaitAt: 'soon' }).error).toContain('expectWaitAt');
    const row = { agent: 'claude', status: 'idle', agentReady: true };
    const brief = (at) => ({ reported: { wait: { on: 'self', what: 'x', at } } });
    const r = (b, expectWaitAt) => SP.promptRefusal(row, { brief: b, now: T0, startedAt: 0, inputAt: null, expectWaitAt });
    const base = r(brief(100), 100);
    expect(base).not.toBe('stale');
    expect(r(brief(101), 100)).toBe('stale');
    expect(r({}, 100)).toBe('stale');
    expect(r(brief(101), null)).toBe(base); // no expectWaitAt: the gate does not apply
    expect(SP.REASONS).toContain('stale');
  });
});
