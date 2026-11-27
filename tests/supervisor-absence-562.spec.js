// @ts-check
// #562 - the supervisor judges a session's absence from ITS OWN server's answer, the pure
// rules (lib/supervisor.js absenceStep, noteAbsent, noteOrphans, knownIds). One peer that is down
// for days (Office-Tests on 2026-11-26) used to make every scan incomplete, so no wait target
// became gone (R1 never woke a lead whose child died) and no orphan was confirmed (R2). Sessions
// never move between servers: an id last seen on server X is judged from X's answer alone.
// Every negative changes ONE input of a case the positive accepts, so a refusal is proven to
// come from the gate it names.
const { test, expect } = require('@playwright/test');
const SV = require('../lib/supervisor');
const J = require('../lib/session-journal');
const WT = require('../lib/wait-target');

const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);
const MIN = 60 * 1000;
const CONFIRM = 5 * MIN;

const row = (id, extra = {}) => ({ id, name: `s${id.slice(0, 8)}`, status: 'idle', agent: 'claude', clients: 0, spawn: null, brief: null, ...extra });
const childOf = (id, parentId) => row(id, { spawn: { by: 'agent', parentId, replaces: [] } });
const up = (name, sessions = []) => ({ name, ok: true, sessions });
const down = (name) => ({ name, ok: false, reason: 'timeout', sessions: [] });
const scan = (servers, at) => SV.buildGraph(servers, at);
// The cluster of the incident: Home and Office answer, Office-Tests has been down for days.
const KID = ID(2);
const LEAD = ID(1);

test.describe('#562 absence is judged from the id\'s own server', () => {
  test('a session that vanished from a server that answered is gone, though another peer is down', () => {
    // KID was last seen on Home; Home answers without it, Office-Tests does not answer at all.
    const known = new Map([[KID, 'Home']]);
    const servers = [up('Home'), up('Office'), down('Office-Tests')];
    const g1 = scan(servers, T0);
    expect(g1.complete).toBe(false); // the cluster-wide flag is unchanged
    const s1 = SV.noteAbsent({}, [KID], g1, { confirmMs: CONFIRM, known });
    expect(s1.states[KID]).toBe('suspect');
    // The existing grace step is untouched: still suspect one millisecond short of confirmMs...
    const s2 = SV.noteAbsent(s1.sightings, [KID], scan(servers, T0 + CONFIRM - 1), { confirmMs: CONFIRM, known });
    expect(s2.states[KID]).toBe('suspect');
    // ...and gone at confirmMs, measured from the FIRST sighting.
    const s3 = SV.noteAbsent(s2.sightings, [KID], scan(servers, T0 + CONFIRM), { confirmMs: CONFIRM, known });
    expect(s3.states[KID]).toBe('gone');
    expect(s3.sightings[KID]).toEqual({ firstAt: T0, lastAt: T0 + CONFIRM });
  });

  test('a session last seen on the server that is DOWN stays unknown: it neither starts, confirms nor clears a sighting', () => {
    const known = new Map([[KID, 'Office-Tests']]);
    const servers = [up('Home'), up('Office'), down('Office-Tests')];
    const none = SV.noteAbsent({}, [KID], scan(servers, T0), { confirmMs: CONFIRM, known });
    expect(none).toEqual({ sightings: {}, states: { [KID]: 'unknown' } });
    const seen = { [KID]: { firstAt: T0 - 10 * MIN, lastAt: T0 - MIN } };
    const kept = SV.noteAbsent(seen, [KID], scan(servers, T0), { confirmMs: CONFIRM, known });
    expect(kept.states[KID]).toBe('unknown'); // far past confirmMs, and still not gone
    expect(kept.sightings).toEqual(seen);
    // Mutation of the ONE input: the same id, recorded on a server that answers, is gone.
    const moved = SV.noteAbsent(seen, [KID], scan(servers, T0), { confirmMs: CONFIRM, known: new Map([[KID, 'Home']]) });
    expect(moved.states[KID]).toBe('gone');
  });

  test('an id never seen in scope is unknown, whatever answered', () => {
    const servers = [up('Home'), up('Office')]; // a COMPLETE scan, even
    const known = new Map([[ID(9), 'Home']]); // some other session was seen; KID never was
    const r = SV.noteAbsent({ [KID]: { firstAt: T0 - 10 * MIN, lastAt: T0 - MIN } }, [KID], scan(servers, T0), { confirmMs: CONFIRM, known });
    expect(r.states[KID]).toBe('unknown');
  });

  test('a replaced id is present through its successor: no state, whichever server is down', () => {
    // The successor (replaces KID) lives on Home, which answers; KID itself is recorded on Home too.
    const successor = row(ID(3), { spawn: { by: 'agent', parentId: null, replaces: [KID] } });
    const g = scan([up('Home', [successor]), down('Office-Tests')], T0);
    expect(g.aliases).toEqual({ [KID]: ID(3) });
    expect(SV.noteAbsent({}, [KID], g, { confirmMs: CONFIRM, known: new Map([[KID, 'Home']]) })).toEqual({ sightings: {}, states: {} });
    // Mutation: without the alias, the same scan judges it gone-in-waiting.
    const bare = scan([up('Home'), down('Office-Tests')], T0);
    expect(SV.noteAbsent({}, [KID], bare, { confirmMs: CONFIRM, known: new Map([[KID, 'Home']]) }).states[KID]).toBe('suspect');
  });

  test('an id with no server on record falls back to the cluster-wide answer, exactly as before', () => {
    for (const known of [new Map([[KID, null]]), new Set([KID]), null]) {
      const incomplete = SV.noteAbsent({}, [KID], scan([up('Home'), down('Office-Tests')], T0), { confirmMs: CONFIRM, known });
      expect(incomplete.states[KID]).toBe('unknown');
      expect(incomplete.sightings).toEqual({});
      const complete = SV.noteAbsent({}, [KID], scan([up('Home'), up('Office-Tests')], T0), { confirmMs: CONFIRM, known });
      expect(complete.states[KID]).toBe('suspect');
    }
  });

  test('a recorded server that is not in the scan at all (left the cluster, excluded) cannot vouch', () => {
    const r = SV.noteAbsent({}, [KID], scan([up('Home'), up('Office')], T0), { confirmMs: CONFIRM, known: new Map([[KID, 'Gone-Server']]) });
    expect(r.states[KID]).toBe('unknown'); // a COMPLETE scan, yet it proves nothing about that server
    expect(SV.serverAnswered(scan([up('Home')], T0), 'Home')).toBe(true);
    expect(SV.serverAnswered(scan([down('Home')], T0), 'Home')).toBe(false);
    expect(SV.serverAnswered(scan([up('Home')], T0), 'home')).toBe(false); // names are exact
    expect(SV.serverAnswered(scan([up('Home')], T0), null)).toBe(false);
  });

  test('an orphan is confirmed from the LEAD\'s server alone: the lead killed on a healthy server, another peer down', () => {
    // The child is on Office, its lead was on Home (killed); Office-Tests is down for days.
    const known = new Map([[LEAD, 'Home'], [KID, 'Office']]);
    const servers = [up('Home'), up('Office', [childOf(KID, LEAD)]), down('Office-Tests')];
    const o1 = SV.noteOrphans({}, scan(servers, T0), { orphanConfirmMs: CONFIRM, known });
    expect(o1.verdicts[KID]).toEqual({ state: 'suspect', parentId: LEAD, since: T0 });
    const o2 = SV.noteOrphans(o1.sightings, scan(servers, T0 + CONFIRM), { orphanConfirmMs: CONFIRM, known });
    expect(o2.verdicts[KID]).toEqual({ state: 'orphan', parentId: LEAD, since: T0 });
  });

  test('a lead recorded on the server that is down is unknown, never an orphan', () => {
    const known = new Map([[LEAD, 'Office-Tests'], [KID, 'Office']]);
    const servers = [up('Home'), up('Office', [childOf(KID, LEAD)]), down('Office-Tests')];
    const seen = { [KID]: { parentId: LEAD, firstAt: T0 - 10 * MIN, lastAt: T0 - MIN } };
    const o = SV.noteOrphans(seen, scan(servers, T0), { orphanConfirmMs: CONFIRM, known });
    expect(o.verdicts[KID]).toEqual({ state: 'unknown', parentId: LEAD, since: T0 - 10 * MIN });
    expect(o.sightings).toEqual(seen);
    // The lead never seen in scope stays "lead-never-seen", before any server is asked.
    const never = SV.noteOrphans({}, scan(servers, T0), { orphanConfirmMs: CONFIRM, known: new Map([[KID, 'Office']]) });
    expect(never.verdicts[KID]).toEqual({ state: 'unknown', parentId: LEAD, since: null, why: 'lead-never-seen' });
  });

  test('R1 end to end: a lead waiting on a child that died on a healthy server is woken; one waiting on the down server\'s child is not', () => {
    const wait = (ids) => ({ on: 'external', what: 'the child', at: T0 - 30 * MIN, target: { kind: 'child', ids } });
    const mk = (id, ids) => row(id, { brief: { wait: wait(ids) } });
    const DEAD_ON_DOWN = ID(5);
    const servers = [up('Home', [mk(LEAD, [KID]), mk(ID(4), [DEAD_ON_DOWN])]), up('Office'), down('Office-Tests')];
    // KID was last seen on Office, DEAD_ON_DOWN on Office-Tests (which is not answering).
    const known = new Map([[LEAD, 'Home'], [ID(4), 'Home'], [KID, 'Office'], [DEAD_ON_DOWN, 'Office-Tests']]);
    let sightings = {};
    let plan = [];
    for (const at of [T0, T0 + CONFIRM]) {
      const g = scan(servers, at);
      const nodes = g.nodes.filter(SV.wakeable);
      const ids = nodes.flatMap((n) => n.wait.target.ids);
      const ab = SV.noteAbsent(sightings, ids, g, { confirmMs: CONFIRM, known });
      sightings = ab.sightings;
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const resolutions = {};
      for (const n of nodes) {
        resolutions[n.id] = WT.resolveLocal(n.wait.target, { waiter: n, find: (id) => byId.get(id) || null, absence: (id) => ab.states[id] || 'unknown', leadVerdict: null, now: at });
      }
      plan = SV.planActions({ graph: g, verdicts: {}, resolutions, done: new Set(), acts: {}, now: at, cfg: SV.supervisorConfig({}) });
      if (at === T0) expect(plan).toEqual([]); // grace: one scan wakes nobody
    }
    expect(plan.map((a) => ({ id: a.id, rule: a.rule }))).toEqual([{ id: LEAD, rule: 'R1' }]);
    expect(plan[0].text).toContain('every child is finished (0 reported done, 1 gone)');
  });
});

test.describe('#562 knownIds records the server each id was last seen on', () => {
  test('a live row, then a journal entry, then nothing: the id keeps the last server it was seen on', () => {
    const g1 = scan([up('Home', [row(LEAD)]), up('Office', [row(KID)])], T0);
    const k1 = SV.knownIds(new Map(), g1, []);
    expect([...k1]).toEqual([[LEAD, 'Home'], [KID, 'Office']]);
    // KID dies on Office: it is in no graph any more, but the record keeps where it was.
    const k2 = SV.knownIds(k1, scan([up('Home', [row(LEAD)]), up('Office')], T0 + MIN), []);
    expect(k2.get(KID)).toBe('Office');
  });

  test('the journal is a source: an id seen only there is recorded on the machine that wrote it', () => {
    const journal = J.foldJournal({ Office: [J.openedRecord({ id: ID(7), at: T0 - 5 }), J.closedRecord({ id: ID(8), at: T0 - 2, why: 'closed' })] });
    const k = SV.knownIds(new Map(), scan([up('Home'), up('Office')], T0), journal);
    expect(k.get(ID(7))).toBe('Office');
    expect(k.get(ID(8))).toBe('Office');
  });

  test('the live row beats an older record; a replaced id keeps its own server or has none', () => {
    const g = scan([up('Home', [row(ID(3), { spawn: { parentId: null, replaces: [KID, ID(6)] } })])], T0);
    const k = SV.knownIds(new Map([[KID, 'Office'], [ID(3), 'Elsewhere']]), g, []);
    expect(k.get(ID(3))).toBe('Home'); // seen live now
    expect(k.get(KID)).toBe('Office'); // a replaced id: its recorded server is kept, not overwritten
    expect(k.get(ID(6))).toBe(null); // a replaced id never recorded: no server, falls back
  });

  test('a bare Set from an older caller reads as ids with no server; the bound keeps the newest', () => {
    const k = SV.knownIds(new Set([ID(1), ID(2)]), scan([up('O', [row(ID(5))])], T0), [], 2);
    expect([...k.keys()]).toEqual([ID(2), ID(5)]);
    expect(k.get(ID(2))).toBe(null);
    expect(k.get(ID(5))).toBe('O');
  });
});
