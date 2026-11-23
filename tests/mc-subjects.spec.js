// @ts-check
// #504/#505 - lib/mc-subjects.js (one work item across every session and machine, runs, the
// bucket rule), lib/mc-tree.js (the server's port of the session tree) and lib/mc-state.js
// (the stage history file). Pure, from SYNTHETIC fixtures: two fake servers' session rows,
// their closed strips and tracker details. The routes are pinned in mc-routes.spec.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const M = require('../lib/mc-subjects');
const { buildTree } = require('../lib/mc-tree');
const { createMcState } = require('../lib/mc-state');
const pj = require('../lib/projects');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** A live row as the cluster view serves it (only the fields MC reads). */
function row(server, { id = uid('live'), name = 'session', status = 'idle', reason = null, items = [], headline = null,
  reportAt = NOW - 5 * MIN, wait = null, parentId = null, replaces = [], createdAt = NOW - 60 * MIN, cwd = 'C:\\dev\\widgets', waitingFor = null } = {}) {
  return {
    id, name, status, reason, waitingFor, cwd, server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`,
    brief: { items: items.map((it) => ({ title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })), headline, reportAt, wait },
    // Every session made through POST /api/sessions has a spawn record; `createdAt: null` = one that has none.
    spawn: createdAt === null ? null : { parentId, replaces, createdAt },
  };
}
/** A closed record as GET /api/dashboard/closed serves it. */
function closedRec(server, { id = uid('gone'), name = 'done session', items = [], at = NOW - 30 * MIN, parentId = null, replaces = [] } = {}) {
  return {
    server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`, origin: null,
    rec: { id, name, at, cwd: 'C:\\dev\\widgets', headline: null,
      items: items.map((it) => ({ title: '', state: 'done', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
      ...(parentId || replaces.length ? { spawn: { parentId, replaces, createdAt: at - 60 * MIN } } : {}) },
  };
}
const meta = (key, over = {}) => ({ key, ref: key, title: `Title of ${key}`, url: `https://tracker.example.test/${encodeURIComponent(key)}`,
  state: 'open', closed: false, prs: [], fetchedAt: NOW - MIN, area: null, labels: [], adoProject: null, ...over });
const view = ({ rows = [], closed = [], metaByKey = {}, projects = [], stageStore = null, now = NOW } = {}) =>
  M.buildView({ nodes: M.sessionNodes({ rows, closed, now }), metaByKey, projects, stageStore, now, platform: 'win32' });
const memStore = () => {
  const h = new Map();
  return { h, stageHistory: (k) => h.get(k) || [], setStageHistory: (k, v) => h.set(k, v) };
};

test.describe('#504 subjects: one work item across the cluster', () => {
  test('one work item touched by sessions on two machines appears once, with both sessions', () => {
    const key = 'acme/widgets#42';
    const a = row('alpha', { name: 'alpha-fix', items: [{ ref: '#42', key, title: 'Scroll jumps' }], reason: { kind: 'external', text: 'review' }, reportAt: NOW - 10 * MIN });
    const b = row('beta', { name: 'beta-test', status: 'working', items: [{ ref: key, key }], reason: { kind: 'working', text: '' }, reportAt: NOW - 2 * MIN });
    const v = view({ rows: [a, b], metaByKey: { [key]: meta(key) } });
    expect(v.subjects).toHaveLength(1);
    const s = v.subjects[0];
    expect(s).toMatchObject({ key, title: `Title of ${key}`, url: meta(key).url, project: 'other', area: 'General', waitsOn: 'external',
      buckets: ['active', 'waitsOnOthers'], needsYou: null, runId: null, updatedAt: NOW - 2 * MIN });
    expect(s.sessions.map((x) => [x.server, x.name, x.status, x.closed])).toEqual([['beta', 'beta-test', 'working', false], ['alpha', 'alpha-fix', 'idle', false]]);
    expect(s.sessions[1]).toMatchObject({ serverUrl: null, parentId: null, closedAt: null, lastReport: { state: 'in-progress', stage: null, at: NOW - 10 * MIN }, wait: null });
    expect(s.sessions[0].serverUrl).toBe('https://beta.example.test');
  });

  test('a bug-hunter run over 5 bugs shows as one run with 5 subjects - live and finished children, on two servers', () => {
    const orc = row('alpha', { name: 'bug-hunter', headline: 'hunting 5 bugs', items: [], status: 'idle', createdAt: NOW - 90 * MIN });
    const kids = [
      row('alpha', { name: 'bug-1', parentId: orc.id, items: [{ ref: 'ado:101' }] }),
      row('beta', { name: 'bug-2', parentId: orc.id, items: [{ ref: 'ado:102' }] }),
      row('beta', { name: 'bug-3', parentId: orc.id, items: [{ ref: 'ado:103' }] }),
    ];
    const gone = [closedRec('alpha', { name: 'bug-4', parentId: orc.id, items: [{ ref: 'ado:104' }] }),
      closedRec('beta', { name: 'bug-5', parentId: orc.id, items: [{ ref: 'ado:105' }] })];
    const other = row('beta', { name: 'unrelated', items: [{ ref: 'ado:900' }] });
    const v = view({ rows: [orc, ...kids, other], closed: gone });
    expect(v.runs).toHaveLength(1);
    const r = v.runs[0];
    expect(r).toMatchObject({ id: orc.id, sessionId: orc.id, server: 'alpha', name: 'bug-hunter', startedAt: NOW - 90 * MIN, status: 'idle' });
    expect([...r.subjects].sort()).toEqual(['ado:101', 'ado:102', 'ado:103', 'ado:104', 'ado:105']);
    expect(r.children.map((c) => c.name).sort()).toEqual(['bug-1', 'bug-2', 'bug-3', 'bug-4', 'bug-5']);
    expect(r.children.find((c) => c.name === 'bug-5')).toMatchObject({ server: 'beta', status: 'closed' });
    for (const k of r.subjects) expect(v.subjects.find((s) => s.key === k).runId).toBe(orc.id);
    expect(v.subjects.find((s) => s.key === 'ado:900').runId).toBe(null);
    // A finished child is on its subject as closed, with its parent named.
    const s4 = v.subjects.find((s) => s.key === 'ado:104');
    expect(s4.sessions[0]).toMatchObject({ closed: true, status: 'closed', closedAt: NOW - 30 * MIN, parentId: orc.id });
    expect(s4.waitsOn).toBe('done');
    expect(s4.buckets).toEqual(['doneWeek']);
  });

  test('a run is one: a sub-orchestrator is inside it, and one child with one subject is no run', () => {
    const top = row('alpha', { name: 'top' });
    const mid = row('beta', { name: 'mid', parentId: top.id, items: [{ ref: 'ado:1' }] });
    const leaf = row('alpha', { name: 'leaf', parentId: mid.id, items: [{ ref: 'ado:2' }] });
    const lone = row('alpha', { name: 'lone' });
    const single = row('alpha', { name: 'single', parentId: lone.id, items: [{ ref: 'ado:3' }] });
    const v = view({ rows: [top, mid, leaf, lone, single] });
    expect(v.runs.map((r) => [r.id, [...r.subjects].sort()])).toEqual([[top.id, ['ado:1', 'ado:2']]]);
  });

  test('a parent handed off to a successor keeps its run: children that named the old id join the new one', () => {
    const old = closedRec('alpha', { name: 'orc (old)', items: [{ ref: 'ado:500' }] });
    const succ = row('alpha', { name: 'orc', replaces: [old.rec.id], createdAt: NOW - 20 * MIN });
    const k1 = row('beta', { name: 'k1', parentId: old.rec.id, items: [{ ref: 'ado:501' }] });
    const k2 = row('beta', { name: 'k2', parentId: succ.id, items: [{ ref: 'ado:502' }] });
    const v = view({ rows: [succ, k1, k2], closed: [old] });
    expect(v.runs).toHaveLength(1);
    expect(v.runs[0].id).toBe(succ.id);
    expect([...v.runs[0].subjects].sort()).toEqual(['ado:500', 'ado:501', 'ado:502']);
    expect(v.subjects.find((s) => s.key === 'ado:501').sessions[0].parentId).toBe(succ.id);
  });

  test('a run handed off and then finished stays ONE run: a closed successor holds the old id', () => {
    const p = closedRec('alpha', { name: 'orc P', at: NOW - 50 * MIN });
    const sId = uid('gone');
    const kidsP = [1, 2, 3].map((i) => closedRec('beta', { name: `kp${i}`, parentId: p.rec.id, items: [{ ref: `ado:${i}` }], at: NOW - 40 * MIN }));
    const succ = closedRec('alpha', { id: sId, name: 'orc S', replaces: [p.rec.id], at: NOW - 10 * MIN });
    const kidsS = [4, 5].map((i) => closedRec('beta', { name: `ks${i}`, parentId: sId, items: [{ ref: `ado:${i}` }], at: NOW - 15 * MIN }));
    // Listed in the closed strip's order (newest first per server), the predecessor first here on purpose.
    const v = view({ closed: [p, ...kidsP, succ, ...kidsS] });
    expect(v.runs.map((r) => [r.id, [...r.subjects].sort()])).toEqual([[sId, ['ado:1', 'ado:2', 'ado:3', 'ado:4', 'ado:5']]]);
  });

  test('a bare #N or a free-text ref joins nothing: a subject of that one session', () => {
    const a = row('alpha', { items: [{ ref: '#12', key: '#12' }, { ref: 'epic-x', key: 'epic-x' }] });
    const b = row('beta', { items: [{ ref: '#12', key: '#12' }] });
    const v = view({ rows: [a, b] });
    expect(v.subjects.map((s) => s.key).sort()).toEqual([`#12@${a.id}`, `#12@${b.id}`, `epic-x@${a.id}`].sort());
    expect(M.trackerKeys(M.sessionNodes({ rows: [a, b], closed: [], now: NOW }))).toEqual([]);
    expect(v.subjects.every((s) => s.meta === null)).toBe(true);
  });

  test('closed sessions stay for 7 days; one listed both live and closed counts once, live', () => {
    const live = row('alpha', { items: [{ ref: 'ado:7' }] });
    const dup = closedRec('alpha', { id: live.id, items: [{ ref: 'ado:7' }] });
    const old = closedRec('beta', { items: [{ ref: 'ado:8' }], at: NOW - 8 * DAY });
    const v = view({ rows: [live], closed: [dup, old] });
    expect(v.subjects.map((s) => [s.key, s.sessions.length, s.sessions[0].closed])).toEqual([['ado:7', 1, false]]);
  });
});

test.describe('#504 what a subject waits on, and the one bucket rule', () => {
  test('anyone asking you wins; the card says who, what and since when', () => {
    const k = 'ado:42';
    const ask = row('beta', { name: 'asker', items: [{ ref: k }], reason: { kind: 'you', text: 'pick a schema', since: NOW - 3 * MIN }, wait: { on: 'you', what: 'pick a schema', at: NOW - 3 * MIN } });
    const ext = row('alpha', { items: [{ ref: k }], reason: { kind: 'external', text: 'CI' } });
    const s = view({ rows: [ext, ask] }).subjects[0];
    expect(s.waitsOn).toBe('you');
    expect(s.buckets).toEqual(['active', 'needsYou']);
    expect(s.needsYou).toMatchObject({ id: `beta|${ask.id}|wait`, kind: 'wait', server: 'beta', sessionId: ask.id, sessionName: 'asker',
      subjectKey: k, what: 'pick a schema', askedAt: NOW - 3 * MIN });
    expect(s.sessions.find((x) => x.id === ask.id).wait).toEqual({ on: 'you', what: 'pick a schema' });
  });

  test('a question or permission prompt names its kind; a decision wait too', () => {
    const q = row('alpha', { status: 'waiting', waitingFor: 'question', items: [{ ref: 'ado:1' }], reason: { kind: 'you', text: 'Which file?' } });
    const d = row('alpha', { items: [{ ref: 'ado:2' }], reason: { kind: 'you', text: 'choose' }, wait: { on: 'you', what: 'choose', decision: { question: 'q', options: [] } } });
    const v = view({ rows: [q, d] });
    expect(v.subjects.find((s) => s.key === 'ado:1').needsYou.kind).toBe('question');
    expect(v.subjects.find((s) => s.key === 'ado:2').needsYou.kind).toBe('decision');
  });

  test('a peer too old to send a reason is read from its status and reported wait', () => {
    const old = { ...row('beta', { status: 'waiting', items: [{ ref: 'ado:1' }] }) };
    delete old.reason;
    const old2 = { ...row('beta', { items: [{ ref: 'ado:2' }], wait: { on: 'external', what: 'vendor' } }) };
    delete old2.reason;
    const v = view({ rows: [old, old2] });
    expect(v.subjects.find((s) => s.key === 'ado:1').waitsOn).toBe('you');
    expect(v.subjects.find((s) => s.key === 'ado:2').waitsOn).toBe('external');
  });

  test('done this week: the tracker closed it, or every session that says anything says done', () => {
    const a = row('alpha', { items: [{ ref: 'ado:1' }], reason: { kind: 'self', text: '' } });
    const b = row('alpha', { items: [{ ref: 'ado:2', state: 'done' }], reason: null });
    const c = row('alpha', { items: [{ ref: 'ado:3', state: 'done' }, { ref: 'ado:4' }], reason: { kind: 'menu' } });
    const v = view({ rows: [a, b, c], metaByKey: { 'ado:1': meta('ado:1', { closed: true, state: 'Closed' }) } });
    const by = Object.fromEntries(v.subjects.map((s) => [s.key, [s.waitsOn, s.buckets]]));
    expect(by['ado:1']).toEqual(['self', ['doneWeek']]);
    expect(by['ado:2']).toEqual(['done', ['doneWeek']]);
    expect(by['ado:3']).toEqual(['done', ['doneWeek']]);
    expect(by['ado:4']).toEqual([null, ['active']]); // parked in a menu says nothing
  });

  test('the companion fallback agrees: needsYou = waits on you, waitsOnOthers = external, doneWeek = done or closed, active = not done', () => {
    for (const waitsOn of ['you', 'external', 'self', 'done', null]) {
      for (const closed of [true, false]) {
        const b = M.bucketsOf({ waitsOn, meta: { closed } });
        expect(b.includes('needsYou')).toBe(waitsOn === 'you');
        expect(b.includes('waitsOnOthers')).toBe(waitsOn === 'external');
        expect(b.includes('doneWeek')).toBe(waitsOn === 'done' || closed);
        expect(b.includes('active')).toBe(!b.includes('doneWeek'));
      }
    }
  });

  test('project counts are the subjects\' buckets and stages: one rule, so a filter matches the number', () => {
    const projects = pj.validateProjects([{ id: 'video', name: 'Video', match: { adoProjects: ['Contoso'] },
      areas: { source: 'ado-area', map: { 'Contoso\\Video\\UI': 'GUI' } } }]).projects;
    const mk = (id, area, over = {}) => meta(id, { adoProject: 'Contoso', area, ...over });
    const rows = [
      row('alpha', { items: [{ ref: 'ado:1', stage: 'fixing' }], reason: { kind: 'you', text: 'q' } }),
      row('beta', { items: [{ ref: 'ado:2' }], reason: { kind: 'external', text: 'x' } }),
      row('beta', { items: [{ ref: 'ado:3', stage: 'pr-open' }], reason: { kind: 'self', text: '' } }),
      row('alpha', { items: [{ ref: 'ado:4' }] }),
    ];
    const metaByKey = { 'ado:1': mk('ado:1', 'Contoso\\Video\\UI\\Grid'), 'ado:2': mk('ado:2', 'Contoso\\Video\\Decoder'),
      'ado:3': mk('ado:3', 'Contoso\\Video\\UI', { prs: [{ number: 9, state: 'merged' }], closed: true }), 'ado:4': meta('ado:4') };
    const v = view({ rows, metaByKey, projects });
    const pv = pj.projectsView({ projects, sessions: [], subjects: v.subjects }, { platform: 'win32' });
    const video = pv.find((p) => p.id === 'video');
    const subs = v.subjects.filter((s) => s.project === 'video');
    for (const b of M.BUCKETS) expect(video.counts[b], b).toBe(subs.filter((s) => s.buckets.includes(b)).length);
    expect(video.counts).toMatchObject({ active: 2, needsYou: 1, waitsOnOthers: 1, doneWeek: 1 });
    expect(video.counts.stages).toEqual({ triage: 0, reproduced: 0, planned: 0, fixing: 1, 'pr-open': 0, 'in-review': 0, merged: 1, tested: 0 });
    expect(Object.keys(video.counts.stages)).toEqual(['triage', 'reproduced', 'planned', 'fixing', 'pr-open', 'in-review', 'merged', 'tested']);
    // Areas: the map's, then one the map does not name (the Area Path's last segment), then General.
    expect(video.areas.map((a) => [a.name, a.counts.active, a.counts.doneWeek])).toEqual([['GUI', 1, 1], ['Decoder', 1, 0], ['General', 0, 0]]);
    expect(pv[pv.length - 1]).toMatchObject({ id: 'other', counts: { active: 1 } });
    // The filters take the area id /api/mc/projects names, or its name.
    expect(M.filterView(v, { project: 'video', area: 'gui' }).subjects.map((s) => s.key).sort()).toEqual(['ado:1', 'ado:3']);
    expect(M.filterView(v, { project: 'video', area: 'Decoder' }).subjects.map((s) => s.key)).toEqual(['ado:2']);
    expect(M.filterView(v, { project: 'other' }).subjects.map((s) => s.key)).toEqual(['ado:4']);
  });

  test('an area id suffixed after a collision filters exactly that area', () => {
    const projects = pj.validateProjects([{ id: 'w', name: 'W', match: { adoProjects: ['Contoso'] },
      areas: { source: 'ado-area', map: { 'Contoso\\A': 'Ui', 'Contoso\\B': 'UI' } } }]).projects;
    const rows = [row('alpha', { items: [{ ref: 'ado:1' }] }), row('alpha', { items: [{ ref: 'ado:2' }] })];
    const metaByKey = { 'ado:1': meta('ado:1', { adoProject: 'Contoso', area: 'Contoso\\A' }), 'ado:2': meta('ado:2', { adoProject: 'Contoso', area: 'Contoso\\B' }) };
    const v = view({ rows, metaByKey, projects });
    const pv = pj.projectsView({ projects, sessions: [], subjects: v.subjects }, { platform: 'win32' });
    expect(pv[0].areas.map((a) => [a.id, a.name])).toEqual([['ui', 'Ui'], ['ui-x', 'UI'], ['general', 'General']]);
    expect(M.filterView(v, { area: 'ui-x' }, { projectsView: pv }).subjects.map((s) => s.key)).toEqual(['ado:2']);
    expect(M.filterView(v, { area: 'ui' }, { projectsView: pv }).subjects.map((s) => s.key)).toEqual(['ado:1']);
  });
});

test.describe('#505 a subject\'s stage', () => {
  test('a merged PR shows Merged even if the agent last said fixing; the history is stored', () => {
    const k = 'acme/widgets#42';
    const store = memStore();
    const r = row('alpha', { items: [{ ref: k, key: k, stage: 'fixing' }], reportAt: NOW - 10 * MIN });
    const v = view({ rows: [r], metaByKey: { [k]: meta(k, { prs: [{ number: 43, state: 'merged' }] }) }, stageStore: store });
    expect(v.subjects[0].stage).toMatchObject({ current: 'merged', reported: 'fixing', evidence: 'merged' });
    expect(v.subjects[0].sessions[0].lastReport.stage).toBe('fixing');
    expect(store.h.get(k).map((h) => [h.stage, h.source])).toEqual([['fixing', 'report'], ['merged', 'pr']]);
    // Later: the tracker cannot be read and the agent still says fixing - still merged.
    const v2 = view({ rows: [r], metaByKey: {}, stageStore: store, now: NOW + DAY });
    expect(v2.subjects[0].stage).toMatchObject({ current: 'merged', evidence: null });
  });

  test('a report without a stage still renders: no stage, every other field there', () => {
    const v = view({ rows: [row('alpha', { items: [{ ref: 'ado:3', title: 'Old agent' }] })], metaByKey: {} });
    const s = v.subjects[0];
    expect(s.stage).toEqual({ current: null, reported: null, evidence: null, history: [] });
    expect(s).toMatchObject({ key: 'ado:3', ref: 'ado:3', title: 'Old agent', meta: null });
    expect(s.sessions[0].lastReport).toMatchObject({ state: 'in-progress', stage: null });
  });

  test("the newest report names the reported stage; an older session's further stage still counts", () => {
    const k = 'ado:9';
    const v = view({ rows: [
      row('alpha', { items: [{ ref: k, stage: 'pr-open' }], reportAt: NOW - 20 * MIN }),
      row('beta', { items: [{ ref: k, stage: 'planned' }], reportAt: NOW - 1 * MIN }),
    ] });
    expect(v.subjects[0].stage).toMatchObject({ reported: 'planned', current: 'pr-open' });
  });
});

test.describe('#504 the tree (port of session_tree.dart)', () => {
  test('a loop or a self-parent is visited once and still has a root', () => {
    const t = buildTree([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'c' }, { id: 'd', parentId: 'a' }]);
    const roots = t.roots().map((x) => x.id);
    expect(roots).toEqual(['c', 'a']);
    expect(t.descendantsOf(t.resolve('a')).map((x) => x.id)).toEqual(['b', 'd']);
    expect(t.ancestorsOf(t.resolve('d')).map((x) => x.id)).toEqual(['a', 'b']);
    expect(t.parentOf(t.resolve('c'))).toBe(null);
  });

  test('a live session wins an id; a live successor wins its predecessor\'s id over the closed record', () => {
    const t = buildTree([{ id: 'new', replaces: ['old'] }, { id: 'old', closed: true }, { id: 'kid', parentId: 'old' }]);
    expect(t.resolve('old').id).toBe('new');
    expect(t.parentOf(t.resolve('kid')).id).toBe('new');
  });
});

test.describe('#505 the Mission Control state file', () => {
  test('written atomically, read back, a corrupt file moved aside, old subjects dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mc-state-'));
    const file = path.join(dir, 'mc-state.json');
    let t = NOW;
    const logs = [];
    const a = createMcState({ file, now: () => t, log: (m) => logs.push(m) });
    expect(a.stageHistory('ado:1')).toEqual([]);
    a.setStageHistory('ado:1', [{ stage: 'fixing', at: t, source: 'report', detail: null }], { changed: true });
    a.flush();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(createMcState({ file, now: () => t }).stageHistory('ado:1')).toHaveLength(1);
    // Not seen for longer than it keeps them: dropped at the next write.
    t += 31 * DAY;
    const b = createMcState({ file, now: () => t });
    b.setStageHistory('ado:2', [{ stage: 'triage', at: t, source: 'report', detail: null }], { changed: true });
    b.flush();
    expect(createMcState({ file, now: () => t }).stageHistory('ado:1')).toEqual([]);
    fs.writeFileSync(file, '{not json');
    const c = createMcState({ file, now: () => t, log: (m) => logs.push(m) });
    expect(c.stageHistory('ado:2')).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('mc-state.json.corrupt-'))).toBe(true);
    expect(logs.join('\n')).toContain('unreadable');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
