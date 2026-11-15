// @ts-check
// #466 - supervisor phase 1, the pure rules: wait targets (lib/wait-target.js and the report
// validation that calls it), the session goal (lib/spawn-store.js), the sessions journal
// (lib/session-journal.js), the cluster work graph and its orphan rule (lib/supervisor.js),
// and the gated prompt (lib/safe-prompt.js). Every negative mutates ONE input of a case the
// positive accepts, so a refusal is proven to come from the gate it names.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const WT = require('../lib/wait-target');
const B = require('../lib/session-brief');
const { createSpawnStore, goalOf, GOAL_MAX } = require('../lib/spawn-store');
const J = require('../lib/session-journal');
const SV = require('../lib/supervisor');
const SP = require('../lib/safe-prompt');
const { classifyUserTurn, USER_KINDS, SUPERVISOR_PROMPT_TAG } = require('../lib/user-turn');

const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const MIN = 60 * 1000;

test.describe('#466 wait.target', () => {
  const v = (t) => WT.validateTarget(t, { refKey: B.refKey });

  test('every kind accepts its own shape, normalised to its own fields', () => {
    expect(v({ kind: 'lead', extra: 1 })).toEqual({ target: { kind: 'lead' } });
    expect(v({ kind: 'session', id: ID(1).toUpperCase() })).toEqual({ target: { kind: 'session', id: ID(1) } });
    expect(v({ kind: 'pr', provider: 'GitHub', repo: 'o/r', number: 12 })).toEqual({ target: { kind: 'pr', provider: 'github', repo: 'o/r', number: 12 } });
    expect(v({ kind: 'ci', provider: 'ado', repo: 'Amadeus8', pr: 9 })).toEqual({ target: { kind: 'ci', provider: 'ado', repo: 'Amadeus8', pr: 9 } });
    expect(v({ kind: 'ci', provider: 'github', repo: 'o/r', runId: '19876543210123456789' }).target.runId).toBe('19876543210123456789');
    expect(v({ kind: 'workitem', ref: 'AB#123' })).toEqual({ target: { kind: 'workitem', ref: 'ado:123' } });
    expect(v({ kind: 'workitem', ref: '#7' })).toEqual({ target: { kind: 'workitem', ref: '#7' } });
    expect(v({ kind: 'time', until: '2026-11-15T18:00:00+02:00' })).toEqual({ target: { kind: 'time', until: '2026-11-15T16:00:00.000Z' } });
    expect(v({ kind: 'child', ids: [ID(1), ID(1).toUpperCase(), ID(2)] })).toEqual({ target: { kind: 'child', ids: [ID(1), ID(2)] } });
    expect(v(undefined)).toEqual({ target: null });
    expect(v(null)).toEqual({ target: null });
  });

  test('a malformed target is refused with the right shape, never dropped', () => {
    const bad = [
      ['not an object', 'pr'],
      [{ kind: 'nope' }, 'is not one of'],
      [{ kind: 'session', id: 'abc' }, '"id" must be a session id'],
      [{ kind: 'pr', provider: 'gitlab', repo: 'o/r', number: 1 }, '"provider"'],
      [{ kind: 'pr', provider: 'github', repo: 'o r', number: 1 }, '"repo"'],
      [{ kind: 'pr', provider: 'github', repo: 'o/r', number: 0 }, '"number"'],
      [{ kind: 'pr', provider: 'github', repo: 'o/r', number: 1.5 }, '"number"'],
      [{ kind: 'ci', provider: 'github', repo: 'o/r' }, 'exactly one of'],
      [{ kind: 'ci', provider: 'github', repo: 'o/r', pr: 1, runId: '2' }, 'exactly one of'],
      [{ kind: 'ci', provider: 'github', repo: 'o/r', runId: '12a' }, '"runId"'],
      [{ kind: 'workitem', ref: 'the bug' }, '"ref"'],
      [{ kind: 'time', until: '2026-11-15' }, '"until"'],
      [{ kind: 'time', until: '2026-13-45T99:00' }, '"until"'],
      [{ kind: 'child', ids: [] }, '"ids"'],
      [{ kind: 'child', ids: new Array(11).fill(ID(1)) }, '"ids"'],
      [{ kind: 'child', ids: [ID(1), 'x'] }, 'every "ids"'],
    ];
    for (const [t, msg] of bad) {
      const r = v(t);
      expect(r.target, JSON.stringify(t)).toBeUndefined();
      expect(r.error, JSON.stringify(t)).toContain(msg);
    }
    // The error teaches the shape: the agent reads it from scripts/wt-report.js.
    expect(v({ kind: 'pr', provider: 'github', repo: 'o/r' }).error).toContain('"number":12');
  });

  test('checkBy is whole minutes, 1 to a week', () => {
    expect(WT.validateCheckBy(30)).toEqual({ checkBy: 30 });
    expect(WT.validateCheckBy(undefined)).toEqual({ checkBy: null });
    for (const bad of [0, -5, 1.5, '30', WT.CHECK_BY_MAX_MIN + 1]) expect(WT.validateCheckBy(bad).error).toContain('checkBy');
    expect(WT.validateCheckBy(WT.CHECK_BY_MAX_MIN).checkBy).toBe(WT.CHECK_BY_MAX_MIN);
  });

  test('a report carries the target and checkBy through to the brief', () => {
    const wait = { on: 'external', what: 'CI on the PR', target: { kind: 'ci', provider: 'github', repo: 'o/r', pr: 3 }, checkBy: 45 };
    const r = B.validateReport({ items: [{ ref: '#1', title: 't', state: 'in-progress' }], wait }, null);
    expect(r.report.wait).toEqual({ on: 'external', what: 'CI on the PR', target: wait.target, checkBy: 45 });
    const e = B.applyReport(B.emptyEntry(), r.report, T0);
    const brief = B.buildBrief(e, { reporting: true });
    expect(brief.wait).toEqual({ ...r.report.wait, at: T0 });
    expect(WT.dueAt(brief.wait)).toBe(T0 + 45 * MIN);
    // A wait-only report keeps the items AND carries the target.
    const p = B.validateReport({ wait: { on: 'self', what: 'x', target: { kind: 'lead' } } }, e);
    expect(p.report).toEqual({ partial: true, wait: { on: 'self', what: 'x', target: { kind: 'lead' } } });
    // No target: exactly the old shape (backward compatible).
    expect(B.validateReport({ headline: 'h', wait: { on: 'self', what: 'x' } }, null).report.wait).toEqual({ on: 'self', what: 'x' });
  });

  test('the report is refused on a bad target, and on a target for a "done" wait', () => {
    expect(B.validateReport({ headline: 'h', wait: { on: 'self', what: 'x', target: { kind: 'pr' } } }, null).error).toContain('wait.target (pr)');
    expect(B.validateReport({ headline: 'h', wait: { on: 'self', what: 'x', checkBy: 0 } }, null).error).toContain('checkBy');
    expect(B.validateReport({ headline: 'h', wait: { on: 'done', what: 'x', target: { kind: 'lead' } } }, null).error).toContain('"done" wait');
    expect(B.validateReport({ headline: 'h', wait: { on: 'done', what: 'x', checkBy: 5 } }, null).error).toContain('"done" wait');
    expect(B.validateReport({ headline: 'h', wait: { on: 'done', what: 'x' } }, null).report).toBeTruthy();
  });

  test('the route-only checks: a lead target needs a lead, and nobody waits on itself', () => {
    expect(WT.targetRefusal({ kind: 'lead' }, { selfId: ID(1), parentId: null })).toContain('no lead');
    expect(WT.targetRefusal({ kind: 'lead' }, { selfId: ID(1), parentId: ID(2) })).toBeNull();
    expect(WT.targetRefusal({ kind: 'session', id: ID(1) }, { selfId: ID(1).toUpperCase() })).toContain('itself');
    expect(WT.targetRefusal({ kind: 'session', id: ID(2) }, { selfId: ID(1) })).toBeNull();
    expect(WT.targetRefusal({ kind: 'child', ids: [ID(2), ID(1)] }, { selfId: ID(1) })).toContain('itself');
    expect(WT.targetRefusal(null, { selfId: ID(1) })).toBeNull();
  });

  test('the hook note teaches the target in one line', () => {
    const t = B.instructionText(null, 'CMD');
    expect(t).toContain('"target": {"kind": session|lead|pr|ci|workitem|time|child');
    expect(t).toContain('"checkBy"');
    expect(t.split('\n').filter((l) => l.includes('"target"'))).toHaveLength(1);
  });
});

test.describe('#466 goal', () => {
  test('goalOf refuses what it cannot keep exactly', () => {
    expect(goalOf(' fix the reaper ')).toEqual({ ok: true, goal: 'fix the reaper' });
    expect(goalOf(undefined)).toEqual({ ok: true, goal: null });
    expect(goalOf('   ')).toEqual({ ok: true, goal: null });
    expect(goalOf(5).ok).toBe(false);
    expect(goalOf('x'.repeat(GOAL_MAX)).ok).toBe(true);
    expect(goalOf('x'.repeat(GOAL_MAX + 1)).ok).toBe(false);
    expect(goalOf(`a${String.fromCodePoint(10)}b`).ok).toBe(false);
    expect(goalOf(`a${String.fromCodePoint(0x1b)}b`).ok).toBe(false);
  });

  test('the goal is written at once, rides on the row, survives a reload, passes to a successor, and goes with the session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt466-goal-'));
    const file = path.join(dir, 'spawned.json');
    let t = T0;
    const mk = () => createSpawnStore({ file, now: () => t, log: () => {} });
    try {
      const s = mk();
      s.created(ID(1), 'orchestrator', null, 'ship the journal');
      // Inside the classify window: no verdict on disk, but the goal is.
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))._goals[ID(1)].goal).toBe('ship the journal');
      expect(s.field(ID(1)).goal).toBe('ship the journal');
      // A fresh store (a restart) still knows it, though the pending verdict is gone.
      const s2 = mk();
      expect(s2.field(ID(1))).toMatchObject({ by: null, goal: 'ship the journal' });
      t += 1000;
      s2.inherit(ID(1), ID(2));
      expect(s2.field(ID(2))).toMatchObject({ goal: 'ship the journal', replaces: [ID(1)] });
      s2.forget(ID(1));
      expect(s2.field(ID(1))).toBeNull();
      expect(mk().field(ID(2)).goal).toBe('ship the journal');
      // No goal: the row is exactly what it was before #466.
      s2.created(ID(3), null, null, null);
      expect(s2.field(ID(3))).toMatchObject({ by: 'pending' });
      expect(s2.field(ID(3))).not.toHaveProperty('goal');
      // A goal kept only for a session the worker no longer lists is pruned.
      s2.prune(new Set([ID(3)]), t + 1);
      expect(mk().field(ID(2))).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test.describe('#466 the sessions journal', () => {
  test('records keep only their own, bounded fields', () => {
    const o = J.openedRecord({ id: ID(1), at: T0, via: 'api', name: 'n', cwd: 'C:\\w', agent: 'claude', spawnedBy: 'lead', parentId: ID(2).toUpperCase(), goal: 'g', replaces: [ID(3), 'bad'] });
    expect(o).toEqual({ v: 1, event: 'opened', at: T0, id: ID(1), via: 'api', name: 'n', cwd: 'C:\\w', agent: 'claude', spawnedBy: 'lead', parentId: ID(2), goal: 'g', replaces: [ID(3)] });
    expect(J.openedRecord({ id: ID(1), at: T0 })).not.toHaveProperty('replaces');
    const c = J.closedRecord({ id: ID(1), at: T0, why: 'reaped', name: 'n', by: 'agent', successorId: null,
      brief: { headline: 'h', did: 'word '.repeat(100), items: [{ ref: '#1', state: 'done', title: 'x' }], wait: { on: 'done', what: 'nothing', at: 1 } } });
    expect(c).toMatchObject({ event: 'closed', why: 'reaped', by: 'agent', headline: 'h', items: [{ ref: '#1', state: 'done' }], wait: { on: 'done', what: 'nothing' } });
    expect(c.did.length).toBeLessThanOrEqual(J.LIMITS.did);
    expect(J.closedRecord({ id: ID(1), at: T0, brief: null, by: 'robot' })).toMatchObject({ why: 'exited', by: null, items: [], wait: null });
    expect(J.handoffRecord({ id: ID(1), to: ID(2), at: T0, trigger: 'auto' })).toEqual({ v: 1, event: 'hand-off', at: T0, id: ID(1), to: ID(2), trigger: 'auto' });
  });

  test('a page never splits events of one millisecond, so "after the last at" loses none', () => {
    const ev = (n, at) => J.openedRecord({ id: ID(n), at });
    const lines = [ev(1, 10), ev(2, 20), ev(3, 20), ev(4, 30), { junk: true }, { event: 'opened', id: 'x', at: 5 }];
    const p1 = J.pageAfter(lines, -Infinity, 2);
    expect(p1.events.map((e) => e.id)).toEqual([ID(1)]);
    expect(p1.more).toBe(true);
    const p2 = J.pageAfter(lines, p1.events[p1.events.length - 1].at, 2);
    expect(p2.events.map((e) => e.id)).toEqual([ID(2), ID(3)]);
    const p3 = J.pageAfter(lines, 20, 2);
    expect(p3).toEqual({ events: [lines[3]], more: false });
    // One millisecond holding more than a page is served whole rather than looping forever.
    const same = [ev(1, 5), ev(2, 5), ev(3, 5)];
    expect(J.pageAfter(same, -Infinity, 2).events).toHaveLength(3);
  });

  test('the fold: one entry per machine and session, its whole life', () => {
    const byMachine = {
      Office: [
        J.openedRecord({ id: ID(1), at: T0, name: 'lead', goal: 'g' }),
        J.handoffRecord({ id: ID(1), to: ID(2), at: T0 + 10 }),
        J.openedRecord({ id: ID(2), at: T0 + 10, via: 'hand-off', name: 'lead (2)', replaces: [ID(1)], goal: 'g' }),
        J.closedRecord({ id: ID(1), at: T0 + 20, why: 'handed-off', brief: { headline: 'did it' } }),
      ],
      Home: [J.closedRecord({ id: ID(3), at: T0 + 5, why: 'closed', name: 'only the end was kept' })],
    };
    const f = J.foldJournal(byMachine);
    const by = Object.fromEntries(f.map((e) => [e.key, e]));
    expect(by[`Office|${ID(1)}`]).toMatchObject({ openedAt: T0, closedAt: T0 + 20, why: 'handed-off', successorId: ID(2), goal: 'g', headline: 'did it' });
    expect(by[`Office|${ID(2)}`]).toMatchObject({ openedAt: T0 + 10, closedAt: null, via: 'hand-off', replaces: [ID(1)] });
    expect(by[`Home|${ID(3)}`]).toMatchObject({ openedAt: null, closedAt: T0 + 5, name: 'only the end was kept' });
    expect(f[0].key).toBe(`Office|${ID(2)}`); // newest-opened first
  });

  test('a peer\'s line is rebuilt to what this server would have written', () => {
    const [o, c] = J.cleanEvents([
      { event: 'opened', id: ID(1).toUpperCase(), at: T0, via: 'evil', name: 'n'.repeat(5000), goal: 'g'.repeat(5000), extra: { big: true } },
      { event: 'closed', id: ID(1), at: T0 + 1, why: 'w'.repeat(99), items: [null, 'x', { ref: '#1', state: 'done', title: 't' }], wait: { on: 'you', what: 'q'.repeat(999) } },
    ]);
    expect(o).not.toHaveProperty('extra');
    expect(o).toMatchObject({ id: ID(1), via: 'api' });
    expect(o.name.length).toBe(J.LIMITS.name);
    expect(o.goal.length).toBe(J.LIMITS.goal);
    expect(c.why.length).toBe(20);
    expect(c.items).toEqual([{ ref: '#1', state: 'done' }]);
    expect(c.wait.what.length).toBe(J.LIMITS.what);
  });

  test('a lost session is written now and dated when it ended; a re-read page is merged once', () => {
    const c = J.closedRecord({ id: ID(1), at: T0, endedAt: T0 - 60 * MIN, why: 'lost' });
    expect(c).toMatchObject({ at: T0, endedAt: T0 - 60 * MIN });
    expect(J.closedRecord({ id: ID(1), at: T0, endedAt: T0 + 5 })).not.toHaveProperty('endedAt');
    expect(J.cleanEvents([c])[0].endedAt).toBe(T0 - 60 * MIN);
    expect(J.foldJournal({ M: [c] })[0].closedAt).toBe(T0 - 60 * MIN);
    const a = J.openedRecord({ id: ID(1), at: 5 }); const b = J.openedRecord({ id: ID(2), at: 5 });
    expect(J.mergeEvents([a], [a, b])).toEqual([a, b]);
  });

  test('the lead keeps a bounded window per machine', () => {
    const lines = [J.openedRecord({ id: ID(1), at: T0 - 40 * 24 * 60 * MIN }), J.openedRecord({ id: ID(2), at: T0 }), J.openedRecord({ id: ID(3), at: T0 + 1 })];
    expect(J.trimEvents(lines, T0 + 1).map((e) => e.id)).toEqual([ID(2), ID(3)]);
    expect(J.trimEvents(lines, T0 + 1, { max: 1 }).map((e) => e.id)).toEqual([ID(3)]);
  });
});

test.describe('#466 the cluster work graph and the orphan rule', () => {
  const row = (id, extra = {}) => ({ id, name: `s${id.slice(0, 8)}`, status: 'idle', agent: 'claude', clients: 0, spawn: null, brief: null, ...extra });
  const child = (id, parentId) => row(id, { spawn: { by: 'agent', parentId, replaces: [] } });
  const scan = (servers, at) => SV.buildGraph(servers, at);
  const cfg = { orphanConfirmMs: 5 * MIN };

  test('a lead found through replaces is the lead that handed off; children attach to it', () => {
    const g = scan([
      { name: 'Office', ok: true, sessions: [row(ID(2), { spawn: { parentId: null, replaces: [ID(1)] } })] },
      { name: 'Home', ok: true, sessions: [child(ID(3), ID(1)), child(ID(4), ID(2))] },
    ], T0);
    const n = Object.fromEntries(g.nodes.map((x) => [x.id, x]));
    expect(g.complete).toBe(true);
    expect(n[ID(3)].leadId).toBe(ID(2));
    expect(n[ID(4)].leadId).toBe(ID(2));
    expect(n[ID(2)].children.sort()).toEqual([ID(3), ID(4)]);
    expect(SV.noteOrphans({}, g, cfg).verdicts).toEqual({});
  });

  test('an orphan takes two complete scans at least the confirm time apart', () => {
    const servers = [{ name: 'Office', ok: true, sessions: [] }, { name: 'Home', ok: true, sessions: [child(ID(3), ID(1))] }];
    const s1 = SV.noteOrphans({}, scan(servers, T0), cfg);
    expect(s1.verdicts[ID(3)]).toEqual({ state: 'suspect', parentId: ID(1), since: T0 });
    const s2 = SV.noteOrphans(s1.sightings, scan(servers, T0 + 5 * MIN - 1), cfg);
    expect(s2.verdicts[ID(3)].state).toBe('suspect');
    const s3 = SV.noteOrphans(s2.sightings, scan(servers, T0 + 5 * MIN), cfg);
    expect(s3.verdicts[ID(3)]).toEqual({ state: 'orphan', parentId: ID(1), since: T0 });
    // The lead comes back (it was only slow to list): the sighting is cleared.
    const back = [{ name: 'Office', ok: true, sessions: [row(ID(1))] }, servers[1]];
    const s4 = SV.noteOrphans(s3.sightings, scan(back, T0 + 6 * MIN), cfg);
    expect(s4.verdicts).toEqual({});
    expect(s4.sightings).toEqual({});
  });

  test('a server that does not answer makes it unknown: it neither starts, confirms nor clears a sighting', () => {
    const home = { name: 'Home', ok: true, sessions: [child(ID(3), ID(1))] };
    const down = { name: 'Office', ok: false, reason: 'timeout', sessions: [] };
    const up = { name: 'Office', ok: true, sessions: [] };
    // Never seen on a complete scan: unknown, and nothing is recorded.
    const u0 = SV.noteOrphans({}, scan([down, home], T0), cfg);
    expect(u0.verdicts[ID(3)]).toEqual({ state: 'unknown', parentId: ID(1), since: null });
    expect(u0.sightings).toEqual({});
    // Seen once, then the scans past the confirm time are all incomplete: never an orphan.
    const s1 = SV.noteOrphans({}, scan([up, home], T0), cfg);
    const u1 = SV.noteOrphans(s1.sightings, scan([down, home], T0 + 10 * MIN), cfg);
    expect(u1.verdicts[ID(3)]).toEqual({ state: 'unknown', parentId: ID(1), since: T0 });
    expect(u1.sightings).toEqual(s1.sightings);
    // The next complete scan confirms it from the FIRST sighting.
    expect(SV.noteOrphans(u1.sightings, scan([up, home], T0 + 11 * MIN), cfg).verdicts[ID(3)].state).toBe('orphan');
    // The child's own server down: its sighting is kept, not dropped as "gone".
    const homeDown = { name: 'Home', ok: false, sessions: [] };
    expect(SV.noteOrphans(s1.sightings, scan([up, homeDown], T0 + MIN), cfg).sightings).toEqual(s1.sightings);
    // ...and dropped once every server answers without it.
    expect(SV.noteOrphans(s1.sightings, scan([up, { name: 'Home', ok: true, sessions: [] }], T0 + MIN), cfg).sightings).toEqual({});
  });

  test('a lead never seen in scope (an excluded server, a server not listed) is unknown, never an orphan', () => {
    const servers = [{ name: 'Office', ok: true, sessions: [child(ID(3), ID(1))] }];
    const s1 = SV.noteOrphans({}, scan(servers, T0), { ...cfg, known: new Set([ID(3)]) });
    expect(s1.verdicts[ID(3)]).toEqual({ state: 'unknown', parentId: ID(1), since: null, why: 'lead-never-seen' });
    expect(s1.sightings).toEqual({});
    const s2 = SV.noteOrphans(s1.sightings, scan(servers, T0 + 10 * MIN), { ...cfg, known: new Set([ID(3)]) });
    expect(s2.verdicts[ID(3)].state).toBe('unknown');
    // Seen once (it closed, and its close is in an in-scope journal): judged as before.
    const known = SV.knownIds(new Set(), scan(servers, T0), J.foldJournal({ Office: [J.closedRecord({ id: ID(1), at: T0 - 1, why: 'closed' })] }));
    expect(known.has(ID(1))).toBe(true);
    const k1 = SV.noteOrphans({}, scan(servers, T0), { ...cfg, known });
    expect(SV.noteOrphans(k1.sightings, scan(servers, T0 + 5 * MIN), { ...cfg, known }).verdicts[ID(3)].state).toBe('orphan');
    // The known set is bounded, newest kept.
    const big = SV.knownIds(new Set([ID(1), ID(2)]), scan([{ name: 'O', ok: true, sessions: [row(ID(5))] }], T0), [], 2);
    expect([...big]).toEqual([ID(2), ID(5)]);
  });

  test('a new parentId restarts the clock; no scan at all is never complete', () => {
    const s1 = SV.noteOrphans({}, scan([{ name: 'Home', ok: true, sessions: [child(ID(3), ID(1))] }], T0), cfg);
    const s2 = SV.noteOrphans(s1.sightings, scan([{ name: 'Home', ok: true, sessions: [child(ID(3), ID(9))] }], T0 + 6 * MIN), cfg);
    expect(s2.verdicts[ID(3)]).toEqual({ state: 'suspect', parentId: ID(9), since: T0 + 6 * MIN });
    expect(scan([], T0).complete).toBe(false);
  });

  test('a peer row is validated: junk is dropped, a duplicate id counted once, a bad target removed', () => {
    const g = scan([{ name: 'Home', ok: true, sessions: [
      null, { id: 'nope' }, row(ID(1)), row(ID(1), { name: 'echo' }),
      row(ID(2), { brief: { wait: { on: 'external', what: 'x', at: 1, target: { kind: 'pr' } } } }),
      row(ID(3), { brief: { wait: { on: 'external', what: 'x', at: 1, target: { kind: 'pr', provider: 'github', repo: 'o/r', number: 2 }, checkBy: 10 } } }),
    ] }], T0);
    expect(g.nodes.map((n) => n.id)).toEqual([ID(1), ID(2), ID(3)]);
    expect(g.nodes[0].name).toBe(`s${ID(1).slice(0, 8)}`);
    expect(g.nodes[1].wait).toEqual({ on: 'external', what: 'x', at: 1 });
    expect(g.nodes[2].wait.target).toEqual({ kind: 'pr', provider: 'github', repo: 'o/r', number: 2 });
    expect(g.nodes[2].wait.checkBy).toBe(10);
  });

  test('the state: needs you oldest first, ready to close, live, and history without live sessions', () => {
    const wait = (on, at) => ({ brief: { wait: { on, what: on, at } } });
    const g = scan([{ name: 'Office', ok: true, sessions: [
      row(ID(1), wait('you', 50)), row(ID(2), wait('you', 10)), row(ID(3), wait('done', 1)),
      row(ID(4), { ...wait('done', 1), clients: 1 }), row(ID(5), { status: 'working' }), child(ID(6), ID(99)),
    ] }], T0);
    const { verdicts } = SV.noteOrphans({ [ID(6)]: { parentId: ID(99), firstAt: T0 - 10 * MIN, lastAt: T0 - MIN } }, g, cfg);
    const journal = J.foldJournal({ Office: [
      J.openedRecord({ id: ID(1), at: T0 - 5, via: 'api', spawnedBy: 'lead' }),
      J.openedRecord({ id: ID(7), at: T0 - 9 }), J.closedRecord({ id: ID(7), at: T0 - 2, why: 'closed' }),
    ] });
    const st = SV.stateOf({ graph: g, verdicts, journal, cfg: { everyMs: 60000 }, now: T0 });
    expect(st.needsYou).toEqual([ID(2), ID(1)]);
    expect(st.readyToClose).toEqual([ID(3)]);
    expect(st.live.sort()).toEqual([ID(4), ID(5), ID(6)].sort());
    expect(st.orphans).toEqual([ID(6)]);
    expect(st.history.map((e) => e.id)).toEqual([ID(7)]);
    expect(st.sessions.find((n) => n.id === ID(1)).journal).toEqual({ openedAt: T0 - 5, via: 'api', spawnedBy: 'lead' });
    expect(SV.stateOf({ graph: null, cfg: { everyMs: 1 } })).toMatchObject({ at: null, complete: false, sessions: [] });
  });

  test('config: on by default, exclusions by name, a floor on the poll', () => {
    expect(SV.supervisorConfig(undefined)).toMatchObject({ enabled: true, everyMs: 60000, exclude: [] });
    expect(SV.supervisorConfig({ enabled: false }).enabled).toBe(false);
    expect(SV.supervisorConfig({ everySec: 1 }).everyMs).toBe(30000);
    const c = SV.supervisorConfig({ exclude: ['Some-MacBook.local', 5] });
    expect(SV.isExcluded('some-macbook.local', c)).toBe(true);
    expect(SV.isExcluded('Home', c)).toBe(false);
  });
});

test.describe('#466 the gated prompt', () => {
  const ok = { agent: 'claude', agentReady: true, status: 'idle', inMenu: false, blockedPrompt: null, waitingFor: null, compacting: false };
  const ctx = { brief: {}, hold: false, busy: false, inputAt: undefined, startedAt: T0 - 60 * MIN, now: T0, typingQuietMin: 10 };

  test('the body: one tagged line under 512 bytes, refused rather than cleaned', () => {
    expect(SP.promptOf({ text: ' carry on ' })).toEqual({ prompt: `${SUPERVISOR_PROMPT_TAG} carry on` });
    expect(SP.promptOf({ text: 'x', tag: 'supervisor' }).prompt).toBe(`${SUPERVISOR_PROMPT_TAG} x`);
    expect(SP.promptOf({ text: 'x', tag: 'check-in' }).error).toContain('tag');
    expect(SP.promptOf({ text: '' }).error).toContain('text');
    expect(SP.promptOf({}).error).toContain('text');
    expect(SP.promptOf([]).error).toContain('object');
    expect(SP.promptOf({ text: `a${String.fromCodePoint(13)}b` }).error).toContain('control');
    expect(SP.promptOf({ text: `a${String.fromCodePoint(10)}b` }).error).toContain('control');
    for (const cp of [0x7f, 0x85, 0x9b, 0x2028, 0x2029]) expect(SP.promptOf({ text: `a${String.fromCodePoint(cp)}b` }).error, cp.toString(16)).toContain('control');
    expect(SP.promptOf({ text: `caf${String.fromCodePoint(0xe9)}` }).prompt).toBeTruthy();
    const room = SP.PROMPT_BYTES_MAX - Buffer.byteLength(`${SUPERVISOR_PROMPT_TAG} `);
    expect(SP.promptOf({ text: 'x'.repeat(room) }).prompt).toBeTruthy();
    expect(SP.promptOf({ text: 'x'.repeat(room + 1) }).error).toContain('bytes');
  });

  test('the prompt is a SYSTEM turn, never "you typed"', () => {
    const t = classifyUserTurn(`${SUPERVISOR_PROMPT_TAG} carry on`);
    expect(t.kind).toBe(USER_KINDS.SYSTEM);
    expect(t.from).toBe('Supervisor');
  });

  test('every gate refuses on its own (one input changed from a delivered case)', () => {
    expect(SP.promptRefusal(ok, ctx)).toBeNull();
    const cases = [
      ['restart-hold', ok, { hold: true }],
      ['handoff', ok, { brief: { handoff: { state: 'wrapping' } } }],
      ['handed-off', ok, { brief: { handoff: { state: 'kept', at: T0 - 5 }, turnAt: T0 - 9 } }],
      ['busy', ok, { busy: true }],
      ['check-in', ok, { brief: { checkIn: { sentAt: T0 - 1000 } } }],
      ['no-agent', { ...ok, agent: null }, {}],
      ['not-ready', { ...ok, agentReady: false }, {}],
      ['not-idle', { ...ok, status: 'working' }, {}],
      ['blocked-prompt', { ...ok, blockedPrompt: { kind: 'folder-trust' } }, {}],
      ['menu', { ...ok, inMenu: true }, {}],
      ['waiting', { ...ok, waitingFor: { tool: 'Bash' } }, {}],
      ['compacting', { ...ok, compacting: true }, {}],
      ['capped', { ...ok, capBlocked: true }, {}],
      ['capped', { ...ok, usageLimit: { waiting: true } }, {}],
      ['typing', ok, { inputAt: T0 - 9 * MIN }],
      ['typing', ok, { startedAt: T0 - MIN }],
    ];
    for (const [why, row, over] of cases) expect(SP.promptRefusal(row, { ...ctx, ...over }), why).toBe(why);
    for (const [why] of cases) expect(SP.REASONS).toContain(why);
    // Past the quiet period, and a hand-off whose session has worked since: no block.
    expect(SP.promptRefusal(ok, { ...ctx, inputAt: T0 - 11 * MIN })).toBeNull();
    expect(SP.promptRefusal(ok, { ...ctx, brief: { checkIn: { sentAt: T0 - 1000, deliveredAt: T0 - 500 } } })).toBeNull();
    expect(SP.promptRefusal(ok, { ...ctx, brief: { handoff: { state: 'kept', at: T0 - 9 }, turnAt: T0 - 5 } })).toBeNull();
  });
});
