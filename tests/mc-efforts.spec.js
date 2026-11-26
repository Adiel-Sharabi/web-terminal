// @ts-check
// #561 - lib/mc-efforts.js: one EFFORT per lead session tree and the work nobody runs. Pure, from
// SYNTHETIC fixtures (two fake servers' rows, a supervisor state, check-in words). The route is
// pinned in mc-efforts-routes.spec.js. Each gate below was mutated once to see its test fail.
const { test, expect } = require('@playwright/test');
const M = require('../lib/mc-subjects');
const needs = require('../lib/mc-needs');
const E = require('../lib/mc-efforts');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** A live row as the cluster view serves it (only the fields MC reads). */
function row(server, { id = uid('live'), name = 'session', status = 'idle', reason = null, items = [], headline = null,
  reportAt = NOW - 5 * MIN, wait = null, parentId = null, replaces = [], createdAt = NOW - 60 * MIN, lastActivity = NOW - MIN,
  checkIn = undefined } = {}) {
  return {
    id, name, status, reason, cwd: 'C:\\dev\\widgets', server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`, lastActivity,
    ...(checkIn ? { checkIn } : {}),
    brief: { items: items.map((it) => ({ title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })), headline, reportAt, wait },
    spawn: { parentId, replaces, createdAt },
  };
}
const closedRec = (server, { id = uid('gone'), name = 'done session', items = [], at = NOW - 30 * MIN, parentId = null } = {}) => ({
  server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`, origin: null,
  rec: { id, name, at, cwd: 'C:\\dev\\widgets', headline: null,
    items: items.map((it) => ({ title: '', state: 'done', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
    ...(parentId ? { spawn: { parentId, replaces: [], createdAt: at - 60 * MIN } } : {}) },
});
const meta = (key, over = {}) => ({ key, ref: key, title: `Title of ${key}`, url: `https://t.example.test/${key}`, state: 'open', closed: false,
  prs: [], fetchedAt: NOW - MIN, area: null, labels: [], adoProject: null, ...over });
const WAIT = (on, what, at = NOW - 20 * MIN) => ({ on, what, at });
const ext = (what) => ({ reason: { kind: 'external', text: what, since: NOW - 20 * MIN, source: 'reported' }, wait: WAIT('external', what) });
const sup = (over = {}) => ({ enabled: true, complete: true, sessions: [], cases: [], ...over });

/** The efforts view of [rows] and [closed]. */
function efforts({ rows = [], closed = [], metaByKey = {}, supervisor = null, servers = [{ name: 'alpha', ok: true }, { name: 'beta', ok: true }], slots = {} } = {}) {
  const nodes = M.sessionNodes({ rows, closed, now: NOW });
  const v = M.buildView({ nodes, metaByKey, projects: [], now: NOW, platform: 'win32' });
  const cards = needs.pendingCards({ nodes, view: v, now: NOW });
  return E.buildEfforts({ nodes, subjects: v.subjects, cards, servers, supervisor, slots, now: NOW });
}
const item = (n) => ({ ref: `acme/widgets#${n}` });

test.describe('#561 efforts: one card per lead session tree', () => {
  test('a tree over two servers is ONE effort: the lead on alpha, its children on beta', () => {
    const lead = row('alpha', { name: 'lead', status: 'working' });
    const c1 = row('beta', { name: 'child 1', status: 'working', parentId: lead.id });
    const c2 = row('beta', { name: 'child 2', parentId: c1.id }); // a grandchild, still the same tree
    const out = efforts({ rows: [lead, c1, c2] });
    expect(out.efforts).toHaveLength(1);
    const e = out.efforts[0];
    expect(e.id).toBe(lead.id);
    expect(e.sessions.map((s) => s.name)).toEqual(['lead', 'child 1', 'child 2']);
    expect(e.sessions.map((s) => s.depth)).toEqual([0, 1, 2]);
    expect(e.machines.sort()).toEqual(['alpha', 'beta']);
  });

  test('two leads are two efforts, even on one line of work', () => {
    const a = row('alpha', { name: 'lead a', status: 'working', items: [item(1)] });
    const b = row('alpha', { name: 'lead b', status: 'working', items: [item(2)] });
    const out = efforts({ rows: [a, b] });
    expect(out.efforts.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('a closed child stays in its tree; a closed lead with a live child is still the tree\'s root', () => {
    const lead = row('alpha', { name: 'lead', status: 'working' });
    const gone = closedRec('beta', { name: 'finished child', parentId: lead.id });
    const out = efforts({ rows: [lead], closed: [gone] });
    const s = out.efforts[0].sessions.find((x) => x.name === 'finished child');
    expect(s && s.closed).toBe(true);
    // The lead closed, a child still runs: one effort, named for the lead.
    const closedLead = closedRec('alpha', { name: 'closed lead' });
    const kid = row('beta', { name: 'kid', status: 'working', parentId: closedLead.rec.id });
    const out2 = efforts({ rows: [kid], closed: [closedLead] });
    expect(out2.efforts).toHaveLength(1);
    expect(out2.efforts[0].name).toBe('closed lead');
  });

  test('a tree with no live session is no effort: its items are Not running', () => {
    const gone = closedRec('alpha', { name: 'old lead', items: [item(7)] });
    const out = efforts({ closed: [gone] });
    expect(out.efforts).toEqual([]);
    expect(out.idle.flatMap((g) => g.items.map((i) => i.key))).toEqual(['acme/widgets#7']);
  });

  test('an item an effort carries is not also Not running', () => {
    const lead = row('alpha', { status: 'working', items: [item(1), item(2)] });
    const out = efforts({ rows: [lead], closed: [closedRec('beta', { items: [item(3)] })] });
    expect(out.efforts[0].items.map((i) => i.key).sort()).toEqual(['acme/widgets#1', 'acme/widgets#2']);
    expect(out.idle.flatMap((g) => g.items.map((i) => i.key))).toEqual(['acme/widgets#3']);
  });

  test('the dispatcher is no effort', () => {
    const disp = { ...row('alpha', { name: 'supervisor', status: 'working' }), role: 'supervisor' };
    expect(efforts({ rows: [disp] }).efforts).toEqual([]);
  });
});

test.describe('#561 efforts: state and order', () => {
  test('needs you -> stuck -> moving -> waiting; ties and ages break inside a state', () => {
    const youNew = row('alpha', { name: 'asks new', reason: { kind: 'you', text: 'which one?', since: NOW - 10 * MIN, source: 'reported' }, wait: WAIT('you', 'which one?', NOW - 10 * MIN) });
    const youOld = row('alpha', { name: 'asks old', reason: { kind: 'you', text: 'ok to merge?', since: NOW - 90 * MIN, source: 'reported' }, wait: WAIT('you', 'ok to merge?', NOW - 90 * MIN) });
    const stuckNew = row('beta', { name: 'stuck new', ...ext('CI on PR 2') });
    const stuckOld = row('beta', { name: 'stuck old', ...ext('CI on PR 1') });
    const movingOld = row('alpha', { name: 'moving old', status: 'working', lastActivity: NOW - 30 * MIN });
    const movingNew = row('alpha', { name: 'moving new', status: 'working', lastActivity: NOW - MIN });
    const waitNew = row('beta', { name: 'wait new', ...ext('review') });
    const waitOld = row('beta', { name: 'wait old', reason: { kind: 'external', text: 'review', since: NOW - 300 * MIN, source: 'reported' }, wait: WAIT('external', 'review', NOW - 300 * MIN) });
    const supervisor = sup({ sessions: [
      { id: stuckOld.id, waitState: { state: 'resolved', fact: 'PR 1 merged' } }, { id: stuckNew.id, waitState: { state: 'resolved', fact: 'PR 2 merged' } },
      { id: waitOld.id, waitState: { state: 'pending' } }, { id: waitNew.id, waitState: { state: 'pending' } }] });
    // Created so the id tie-break would give the WRONG order inside each state (newest first, except moving: newest last).
    // The older suspect verdict is the one with the older wait.
    stuckOld.brief.wait.at = NOW - 120 * MIN; stuckNew.brief.wait.at = NOW - 40 * MIN;
    const out = efforts({ rows: [waitNew, movingOld, stuckNew, youNew, waitOld, movingNew, stuckOld, youOld], supervisor });
    expect(out.efforts.map((e) => `${e.state}:${e.name}`)).toEqual([
      'needs-you:asks old', 'needs-you:asks new', 'stuck:stuck old', 'stuck:stuck new',
      'moving:moving new', 'moving:moving old', 'waiting:wait old', 'waiting:wait new']);
  });

  test('a child that needs you makes the whole tree needs-you; a suspect child makes it stuck', () => {
    const lead = row('alpha', { name: 'lead', status: 'working' });
    const kid = row('beta', { name: 'kid', parentId: lead.id, reason: { kind: 'you', text: 'pick one', since: NOW - MIN, source: 'reported' }, wait: WAIT('you', 'pick one') });
    expect(efforts({ rows: [lead, kid] }).efforts[0].state).toBe('needs-you');
    expect(efforts({ rows: [lead, kid] }).efforts[0].needsYou.map((c) => c.sessionId)).toEqual([kid.id]);
    const kid2 = row('beta', { name: 'kid2', parentId: lead.id, ...ext('CI') });
    const out = efforts({ rows: [lead, kid2], supervisor: sup({ sessions: [{ id: kid2.id, waitState: { state: 'resolved', fact: 'CI went green' } }] }) });
    expect(out.efforts[0].state).toBe('stuck');
    expect(out.efforts[0].verdict).toMatchObject({ kind: 'suspect', rule: 'R1', text: 'CI went green' });
  });

  test('a card that is only a guess (a maybe-answered wait) does not make an effort needs-you', () => {
    const lead = row('alpha', { name: 'lead', status: 'working' });
    const asker = row('alpha', { name: 'asker', status: 'working', reason: { kind: 'you', text: 'ok?', since: NOW - MIN, source: 'reported' }, wait: WAIT('you', 'ok?') });
    const nodes = M.sessionNodes({ rows: [lead, asker], closed: [], now: NOW });
    const v = M.buildView({ nodes, now: NOW, platform: 'win32' });
    const cards = needs.pendingCards({ nodes, view: v, now: NOW }).map((c) => ({ ...c, maybeAnswered: true }));
    const out = E.buildEfforts({ nodes, subjects: v.subjects, cards, servers: [{ name: 'alpha', ok: true }], now: NOW });
    expect(out.efforts.map((e) => e.state)).toEqual(['moving', 'moving']);
    expect(out.efforts.find((e) => e.id === asker.id).needsYou).toHaveLength(1); // still listed
  });
});

test.describe('#561 efforts: the verdict is the supervisor\'s, read', () => {
  const waiter = () => row('alpha', { name: 'waiter', ...ext('CI on PR 941') });
  const verdictOf = (r, supervisor, over = {}) => efforts({ rows: [r], supervisor, ...over }).efforts[0];

  test('R1: resolved -> suspect (its fact), gone -> suspect, pending -> legit (the wait\'s own words), unknown -> unknown', () => {
    const r = waiter();
    const at = (state, fact) => verdictOf(r, sup({ sessions: [{ id: r.id, waitState: { state, fact } }] }));
    expect(at('resolved', 'PR 941 merged').verdict).toMatchObject({ kind: 'suspect', rule: 'R1', text: 'PR 941 merged' });
    expect(at('gone', 'PR 941 was not found').verdict).toMatchObject({ kind: 'suspect', rule: 'R1' });
    expect(at('pending', '').verdict).toMatchObject({ kind: 'legit', rule: 'R1', text: 'CI on PR 941' });
    expect(at('unknown', '').verdict).toMatchObject({ kind: 'unknown' });
    expect(at('resolved', 'PR 941 merged').state).toBe('stuck');
    expect(at('pending', '').state).toBe('waiting');
    expect(at('unknown', '').state).toBe('waiting'); // unknown proves nothing: never stuck
  });

  test('R2: an orphan is suspect; a merely suspected one (not yet confirmed) says nothing', () => {
    const r = waiter();
    expect(verdictOf(r, sup({ sessions: [{ id: r.id, orphan: { state: 'orphan', since: NOW - 30 * MIN } }] })).verdict).toMatchObject({ kind: 'suspect', rule: 'R2' });
    expect(verdictOf(r, sup({ sessions: [{ id: r.id, orphan: { state: 'suspect' } }] })).verdict).toBeNull();
  });

  test('an open case that still stands is a suspect verdict by its rule; a resolved one and R4 are not', () => {
    const r = waiter();
    const c = (rule, over = {}) => ({ id: 'c1', rule, sessionId: r.id, openedAt: NOW - 25 * MIN, resolvedAt: null, ...over });
    for (const rule of ['R3', 'R6', 'R7', 'R9']) expect(verdictOf(r, sup({ cases: [c(rule)] })).verdict, rule).toMatchObject({ kind: 'suspect', rule });
    expect(verdictOf(r, sup({ cases: [c('R6', { resolvedAt: NOW - MIN })] })).verdict).toBeNull();
    expect(verdictOf(r, sup({ cases: [c('R4')] })).verdict).toBeNull();
    expect(verdictOf(r, sup({ cases: [c('R6', { sessionId: 'someone-else' })] })).verdict).toBeNull();
  });

  test('the published check-in word: stuck / lost / interrupted are suspect, the others say nothing', () => {
    const mk = (state) => row('alpha', { name: 'w', ...ext('CI'), checkIn: { sentAt: NOW - 15 * MIN, idleMin: 45, state, answeredAt: null } });
    for (const state of ['stuck', 'lost', 'interrupted']) expect(verdictOf(mk(state), sup()).verdict, state).toMatchObject({ kind: 'suspect', rule: 'check-in' });
    for (const state of ['sent', 'answering', 'resumed', 'external', 'done', 'you', 'skipped', 'told']) expect(verdictOf(mk(state), sup()).verdict, state).toBeNull();
  });

  test('the supervisor off (or absent) -> every verdict is null; the tree still shows', () => {
    const r = waiter();
    const supervisor = { enabled: false, complete: true, sessions: [{ id: r.id, waitState: { state: 'resolved', fact: 'PR 941 merged' } }] };
    expect(verdictOf(r, supervisor).verdict).toBeNull();
    expect(verdictOf(r, null).verdict).toBeNull();
    expect(verdictOf(r, null).sessions[0].verdict).toBeNull();
    expect(verdictOf(r, null).state).toBe('waiting');
  });

  test('the oldest suspect is the effort\'s verdict; a legit lead is shown when nothing is suspect', () => {
    const lead = row('alpha', { name: 'lead', ...ext('PR review') });
    const a = row('beta', { name: 'a', parentId: lead.id, ...ext('CI a') });
    const b = row('beta', { name: 'b', parentId: lead.id, ...ext('CI b') });
    a.brief.wait.at = NOW - 10 * MIN; b.brief.wait.at = NOW - 50 * MIN;
    const out = efforts({ rows: [lead, a, b], supervisor: sup({ sessions: [
      { id: lead.id, waitState: { state: 'pending' } },
      { id: a.id, waitState: { state: 'resolved', fact: 'a is done' } }, { id: b.id, waitState: { state: 'resolved', fact: 'b is done' } }] }) });
    expect(out.efforts[0].verdict.text).toBe('b is done');
    const calm = efforts({ rows: [lead], supervisor: sup({ sessions: [{ id: lead.id, waitState: { state: 'pending' } }] }) });
    expect(calm.efforts[0].verdict).toMatchObject({ kind: 'legit', text: 'PR review' });
  });
});

test.describe('#561 efforts: fail CLOSED when a server did not answer (#562)', () => {
  const down = [{ name: 'alpha', ok: true }, { name: 'beta', ok: false }];

  test('complete is false, the servers say which, and a lead whose parent is unlisted is partial - never gone', () => {
    const orphanish = row('alpha', { name: 'child of a lead on beta', status: 'working', parentId: 'lead-on-the-down-server', ...{} });
    const out = efforts({ rows: [orphanish], servers: down });
    expect(out.complete).toBe(false);
    expect(out.servers).toEqual(down);
    expect(out.efforts[0]).toMatchObject({ partial: true, missing: ['beta'] });
    expect(out.efforts[0].state).toBe('moving');
  });

  test('with every server answering the same lead is a plain effort (its parent is simply gone)', () => {
    const lone = row('alpha', { status: 'working', parentId: 'long-closed-lead' });
    const out = efforts({ rows: [lone] });
    expect(out.complete).toBe(true);
    expect(out.efforts[0]).toMatchObject({ partial: false, missing: [] });
  });

  test('a verdict that rests on ABSENCE (R1 gone, R2 orphan) is unknown, not suspect, while the scan is incomplete', () => {
    const r = row('alpha', { name: 'w', ...ext('PR 9') });
    const gone = efforts({ rows: [r], servers: down, supervisor: sup({ complete: false, sessions: [{ id: r.id, waitState: { state: 'gone', fact: 'PR 9 was not found' } }] }) }).efforts[0];
    expect(gone.verdict.kind).toBe('unknown');
    expect(gone.state).toBe('waiting');
    const orphan = efforts({ rows: [r], servers: down, supervisor: sup({ complete: false, sessions: [{ id: r.id, orphan: { state: 'orphan' } }] }) }).efforts[0];
    expect(orphan.verdict.kind).toBe('unknown');
    expect(orphan.state).toBe('waiting');
  });

  test('machines: an unreachable one is listed, not ok, with no live count it could not know', () => {
    const out = efforts({ rows: [row('alpha', { status: 'working' })], servers: down, slots: { alpha: 10 } });
    expect(out.machines).toEqual([
      { name: 'alpha', live: 1, working: 1, slots: 10, ok: true },
      { name: 'beta', live: 0, working: 0, slots: null, ok: false }]);
  });
});

test.describe('#561 not running: one class rule, groups by line', () => {
  const sub = (over = {}) => ({ key: 'acme/widgets#1', sessions: [], buckets: ['active'], meta: null, stage: { current: null, station: null }, ...over });

  test('idleClassOf: finished / waits-test / stranded / not-started', () => {
    // finished
    expect(E.idleClassOf(sub({ meta: { closed: true } }))).toBe('finished');
    expect(E.idleClassOf(sub({ stage: { current: 'fixing', station: 'Done' } }))).toBe('finished');
    expect(E.idleClassOf(sub({ buckets: ['doneWeek'] }))).toBe('finished');
    expect(E.idleClassOf(sub({ stage: { current: 'tested', station: null } }))).toBe('finished');
    // Every session said done: finished, unless a PR is still open for review; the tracker's station outranks the report.
    expect(E.idleClassOf(sub({ buckets: ['doneWeek'], stage: { current: 'merged', station: null } }))).toBe('finished');
    expect(E.idleClassOf(sub({ buckets: ['doneWeek'], stage: { current: 'pr-open', station: null } }))).toBe('waits-test');
    expect(E.idleClassOf(sub({ buckets: ['doneWeek'], stage: { current: 'fixing', station: 'Ready for test' } }))).toBe('waits-test');
    // waits for test / review
    for (const station of ['Ready for test', 'Committed', 'Merged']) expect(E.idleClassOf(sub({ stage: { current: 'fixing', station } })), station).toBe('waits-test');
    for (const current of ['pr-open', 'in-review', 'merged']) expect(E.idleClassOf(sub({ stage: { current, station: null } })), current).toBe('waits-test');
    // stranded: someone began and nobody is on it
    expect(E.idleClassOf(sub({ stage: { current: null, station: 'In Progress' } }))).toBe('stranded');
    for (const current of ['triage', 'reproduced', 'planned', 'fixing']) expect(E.idleClassOf(sub({ stage: { current, station: null } })), current).toBe('stranded');
    expect(E.idleClassOf(sub({ sessions: [{ bound: false, lastReport: { state: 'in-progress', note: '' } }] }))).toBe('stranded');
    // not started: no stage, and no session beyond a start binding
    expect(E.idleClassOf(sub())).toBe('not-started');
    expect(E.idleClassOf(sub({ sessions: [{ bound: true, lastReport: { state: '', note: '' } }] }))).toBe('not-started');
  });

  test('items group by line; a group lists its items finished-last and groups order by their best class', () => {
    const lineA = { id: 'p/~a', name: 'Line A', project: 'p', kind: 'line', source: 'rule' };
    const lineB = { id: 'p/~b', name: 'Line B', project: 'p', kind: 'line', source: 'rule' };
    const s = (key, line, stage, updatedAt, extra = {}) => ({ key, ref: key, title: key, line, stage: { current: stage, station: null }, buckets: ['active'], meta: null, sessions: [], updatedAt, ...extra });
    const subjects = [
      s('acme/widgets#1', lineA, 'fixing', 10), s('acme/widgets#2', lineA, 'merged', 5), s('acme/widgets#3', lineA, null, 20, { buckets: ['doneWeek'] }),
      s('acme/widgets#4', lineB, null, 30, { sessions: [{ bound: true, lastReport: {} }] }), s('acme/widgets#5', null, 'pr-open', 1)];
    const out = E.buildEfforts({ nodes: [], subjects, cards: [], servers: [], now: NOW });
    // Line A holds a waits-test item (best class 0); Line B a not-started one (1); no-line pr-open is waits-test too.
    expect(out.idle.map((g) => g.line && g.line.id)).toEqual(['p/~a', null, 'p/~b']);
    expect(out.idle[0].items.map((i) => `${i.key}:${i.cls}`)).toEqual([
      'acme/widgets#2:waits-test', 'acme/widgets#1:stranded', 'acme/widgets#3:finished']);
  });

  test('station and stage come from the subject the view built (an ADO item\'s Ready for test)', () => {
    const lead = row('alpha', { status: 'working', items: [{ ref: 'ado:5001' }] });
    const closed = closedRec('beta', { items: [{ ref: 'ado:5002' }] });
    const metaByKey = { 'ado:5002': meta('ado:5002', { tracker: 'ado', state: 'Ready for test', adoProject: 'P' }) };
    const out = efforts({ rows: [lead], closed: [closed], metaByKey });
    expect(out.idle[0].items[0]).toMatchObject({ key: 'ado:5002', station: 'Ready for test', cls: 'waits-test' });
  });
});

test.describe('#561 header: live sessions out of the slots each machine has', () => {
  test('live counts exclude closed sessions and the dispatcher; slots come from the caller', () => {
    const a1 = row('alpha', { status: 'working' });
    const a2 = row('alpha', {});
    const b1 = row('beta', { status: 'working' });
    const disp = { ...row('alpha', { name: 'supervisor' }), role: 'supervisor' };
    const out = efforts({ rows: [a1, a2, b1, disp], closed: [closedRec('alpha', {})], slots: { alpha: 10, beta: 4 } });
    expect(out.machines).toEqual([
      { name: 'alpha', live: 2, working: 1, slots: 10, ok: true },
      { name: 'beta', live: 1, working: 1, slots: 4, ok: true }]);
  });
});
