// @ts-check
// #523 - lib/mc-lines.js: lines of work. Which line a work item is on (first match wins:
// a Move-to-line override, then the line of the session or the run that started it, then the
// project's config rules, then its tracker parent Feature/Epic, else its own line - never a
// catch-all), and the lines view the top of Mission Control renders. Pure, from SYNTHETIC
// fixtures; the routes are pinned in mc-routes.spec.js.
const { test, expect } = require('@playwright/test');
const M = require('../lib/mc-subjects');
const L = require('../lib/mc-lines');
const pj = require('../lib/projects');
const { applyBindings } = require('../lib/mc-binding');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function row(server, { id = uid('live'), name = 'session', status = 'idle', reason = null, items = [], line = undefined,
  reportAt = NOW - 5 * MIN, parentId = null, replaces = [], createdAt = NOW - 60 * MIN, cwd = 'C:\\dev\\video' } = {}) {
  return {
    id, name, status, reason, waitingFor: null, cwd, server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`,
    brief: { items: items.map((it) => ({ title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
      headline: null, reportAt, wait: null, ...(line !== undefined ? { line } : {}) },
    spawn: { parentId, replaces, createdAt },
  };
}
function closedRec(server, { id = uid('gone'), name = 'done session', items = [], at = NOW - 30 * MIN, parentId = null, line = undefined } = {}) {
  return {
    server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`, origin: null,
    rec: { id, name, at, cwd: 'C:\\dev\\video', headline: null, ...(line !== undefined ? { line } : {}),
      items: items.map((it) => ({ title: '', state: 'done', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
      ...(parentId ? { spawn: { parentId, replaces: [], createdAt: at - 60 * MIN } } : {}) },
  };
}
const meta = (key, over = {}) => ({ key, ref: key, title: `Title of ${key}`, url: null, type: 'Bug', state: 'Active', closed: false,
  prs: [], fetchedAt: NOW - MIN, area: 'Contoso', labels: [], adoProject: 'Contoso', parent: null, ...over });

const CFG = [
  { id: 'video', name: 'Video', match: { adoProjects: ['Contoso'], paths: ['C:\\dev\\video'] },
    lines: [
      { id: 'hunt', name: 'Bug hunter', match: { sessionNames: ['bh orchestrator*', 'BH worker*'], tags: ['bug-hunter'] } },
      { id: 'health', name: 'Health', match: { titlePrefixes: ['[Health'], tags: ['health', 'health-report'] } },
      { id: 'cut', name: 'Release cut', match: { items: ['ado:57', 'AB#62'] } },
    ] },
  { id: 'web', name: 'Web', match: { repos: ['acme/web'], paths: ['C:\\dev\\web'] },
    lines: [{ id: 'mc', name: 'Mission Control', match: { items: ['#501'] } }] },
];
const projects = () => {
  const v = pj.validateProjects(CFG);
  if (!v.ok) throw new Error(v.error);
  return v.projects;
};
const view = ({ rows = [], closed = [], metaByKey = {}, lineOverrides = undefined, bindings = null } = {}) => {
  let nodes = M.sessionNodes({ rows, closed, now: NOW });
  if (bindings) nodes = applyBindings(nodes, bindings);
  return M.buildView({ nodes, metaByKey, projects: projects(), lineOverrides, now: NOW, platform: 'win32' });
};
const lineOf = (v, key) => v.subjects.find((s) => s.key === key).line;

test.describe('#523 config: projects[].lines', () => {
  test('lines are validated with the project and normalised; absent means none', () => {
    const p = projects();
    expect(p[0].lines[0]).toEqual({ id: 'hunt', name: 'Bug hunter',
      match: { items: [], tags: ['bug-hunter'], titlePrefixes: [], sessionNames: ['bh orchestrator*', 'BH worker*'] } });
    // A bare #N names the project's first repo; AB#62 is an ADO item: keys, as subjects carry them.
    expect(p[0].lines[2].match.items).toEqual(['ado:57', 'ado:62']);
    expect(p[1].lines[0].match.items).toEqual(['acme/web#501']);
    expect(pj.validateProjects([{ id: 'a', name: 'A' }]).projects[0].lines).toEqual([]);
  });

  test('a malformed line is refused whole, naming the field', () => {
    const bad = (lines, re) => {
      const v = pj.validateProjects([{ id: 'a', name: 'A', match: { repos: ['acme/a'] }, lines }]);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(re);
    };
    bad('x', /projects\[0\]\.lines must be an array/);
    bad([{ id: 'Bad Id', name: 'x' }], /lines\[0\]\.id/);
    bad([{ id: 'x', name: 'x' }, { id: 'x', name: 'y' }], /lines\[1\]\.id "x" is used twice/);
    bad([{ id: 'x' }], /lines\[0\]\.name is required/);
    bad([{ id: 'x', name: 'x', match: { tags: 'health' } }], /lines\[0\]\.match\.tags must be an array/);
    bad([{ id: 'x', name: 'x', match: { items: ['not a ref'] } }], /lines\[0\]\.match\.items\[0\]/);
    bad([{ id: 'x', name: 'x', match: { sessionNames: [`a${String.fromCodePoint(7)}b`] } }], /lines\[0\]\.match\.sessionNames\[0\]/);
    // A bare #N in a project with no repo names nothing.
    const v = pj.validateProjects([{ id: 'a', name: 'A', lines: [{ id: 'x', name: 'x', match: { items: ['#5'] } }] }]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/lines\[0\]\.match\.items\[0\].*no repo/);
  });

  test('a session-name pattern is a whole-name glob, no case; * is the only wildcard', () => {
    expect(L.globMatch('BH worker*', 'bh WORKER #3')).toBe(true);
    expect(L.globMatch('BH worker*', 'old BH worker #3')).toBe(false);
    expect(L.globMatch('*docket*', 'Fix the Docket list')).toBe(true);
    expect(L.globMatch('a.b', 'axb')).toBe(false); // a regex character is literal
    expect(L.globMatch('cnt32-vm-am8', 'cnt32-vm-am8')).toBe(true);
  });
});

test.describe('#523 which line a work item is on (first match wins)', () => {
  test('1. the run that started it: a bug-hunter orchestrator\'s workers inherit its line, over every rule below', () => {
    const orch = row('alpha', { name: 'bh orchestrator round 2', status: 'working', reason: { kind: 'working' } });
    // Worker names match no rule; one worker's bug is TAGGED health (rule 2) and one has a parent (rule 3).
    const w1 = row('beta', { name: 'worker one', parentId: orch.id, items: [{ ref: 'ado:101' }] });
    const w2 = row('beta', { name: 'worker two', parentId: orch.id, items: [{ ref: 'ado:102' }] });
    const w3 = closedRec('alpha', { name: 'worker three', parentId: orch.id, items: [{ ref: 'ado:103' }] });
    const v = view({ rows: [orch, w1, w2], closed: [w3], metaByKey: {
      'ado:101': meta('ado:101'), 'ado:102': meta('ado:102', { labels: ['health'] }),
      'ado:103': meta('ado:103', { parent: { key: 'ado:900', ref: 'ado:900' } }), 'ado:900': meta('ado:900', { type: 'Feature' }) } });
    for (const k of ['ado:101', 'ado:102', 'ado:103']) expect(lineOf(v, k), k).toEqual({ id: 'video/hunt', name: 'Bug hunter', project: 'video', kind: 'config', source: 'session' });
  });

  test('1. a session that REPORTS its line puts its items there, by name (no case) or as a line of that name', () => {
    const a = row('alpha', { name: 'x', line: 'BUG HUNTER', items: [{ ref: 'ado:111', title: '[Health daily] disk' }] });
    const b = row('alpha', { name: 'Docket', line: 'Docket fixes', items: [{ ref: 'ado:112' }] });
    const v = view({ rows: [a, b], metaByKey: { 'ado:111': meta('ado:111', { title: '[Health daily] disk' }), 'ado:112': meta('ado:112') } });
    expect(lineOf(v, 'ado:111')).toMatchObject({ id: 'video/hunt', source: 'session' }); // over the Health title rule
    expect(lineOf(v, 'ado:112')).toEqual({ id: 'video/~docket-fixes', name: 'Docket fixes', project: 'video', kind: 'named', source: 'session' });
  });

  test('1. Start work\'s line is the session\'s line, and its children inherit it', () => {
    const lead = row('alpha', { id: uid('lead'), name: 'lead', items: [] });
    const kid = row('alpha', { name: 'kid', parentId: lead.id, items: [{ ref: 'ado:121' }] });
    const v = view({ rows: [lead, kid], metaByKey: { 'ado:121': meta('ado:121', { labels: ['health'] }) },
      bindings: { [lead.id]: { project: 'video', subjects: [], hunt: true, line: { name: 'Bug hunter' }, server: null, at: NOW - 60 * MIN } } });
    expect(lineOf(v, 'ado:121')).toMatchObject({ id: 'video/hunt', source: 'session' });
  });

  test('2. config rules: tags, title prefixes, session names and listed items - in line order', () => {
    const a = row('alpha', { name: 'health check', items: [{ ref: 'ado:201' }] });
    const b = row('alpha', { name: 'something', items: [{ ref: 'ado:202' }] });
    const c = row('alpha', { name: 'BH worker #4', items: [{ ref: 'ado:203' }] });
    const d = row('alpha', { name: 'cutter', items: [{ ref: 'ado:57' }] });
    const e = row('alpha', { name: 'tagged both', items: [{ ref: 'ado:205' }] });
    const v = view({ rows: [a, b, c, d, e], metaByKey: {
      'ado:201': meta('ado:201', { labels: ['Health-Report'] }), 'ado:202': meta('ado:202', { title: '[Health fault] fan' }),
      'ado:203': meta('ado:203'), 'ado:57': meta('ado:57', { parent: { key: 'ado:900', ref: 'ado:900' } }),
      'ado:205': meta('ado:205', { labels: ['health', 'bug-hunter'] }), 'ado:900': meta('ado:900', { type: 'Epic' }) } });
    expect(lineOf(v, 'ado:201')).toMatchObject({ id: 'video/health', source: 'rule' });
    expect(lineOf(v, 'ado:202')).toMatchObject({ id: 'video/health', source: 'rule' });
    expect(lineOf(v, 'ado:203')).toMatchObject({ id: 'video/hunt', source: 'rule' }); // its OWN session's name
    expect(lineOf(v, 'ado:57')).toMatchObject({ id: 'video/cut', source: 'rule' }); // over its Epic parent
    expect(lineOf(v, 'ado:205')).toMatchObject({ id: 'video/hunt' }); // the first line that matches
  });

  test('2. a project\'s rules apply only to its own work items', () => {
    const a = row('alpha', { name: 'web thing', cwd: 'C:\\dev\\web', items: [{ ref: 'acme/web#7' }] });
    const v = view({ rows: [a], metaByKey: { 'acme/web#7': meta('acme/web#7', { title: '[Health] web', adoProject: null, area: null }) } });
    expect(lineOf(v, 'acme/web#7')).toMatchObject({ id: 'item:acme/web#7', kind: 'item', source: 'own' });
  });

  test('3. the tracker parent: the nearest Feature/Epic up the chain, else the direct parent; a rule on the parent names its line', () => {
    const rows = ['ado:301', 'ado:302', 'ado:303'].map((ref) => row('alpha', { name: `s ${ref}`, items: [{ ref }] }));
    const v = view({ rows, metaByKey: {
      'ado:301': meta('ado:301', { parent: { key: 'ado:910', ref: 'ado:910' } }),
      'ado:910': meta('ado:910', { type: 'Product Backlog Item', parent: { key: 'ado:920', ref: 'ado:920' } }),
      'ado:920': meta('ado:920', { type: 'Feature', title: 'SSCP rollout' }),
      'ado:302': meta('ado:302', { parent: { key: 'ado:930', ref: 'ado:930' } }),
      'ado:930': meta('ado:930', { type: 'Task', title: 'Some task', parent: { key: 'ado:931', ref: 'ado:931' } }), // 931 not read yet
      'ado:303': meta('ado:303', { parent: { key: 'ado:940', ref: 'ado:940' } }),
      'ado:940': meta('ado:940', { type: 'Feature', title: '[Health] nightly' }) } });
    expect(lineOf(v, 'ado:301')).toEqual({ id: 'parent:ado:920', name: 'SSCP rollout', project: 'video', kind: 'parent', source: 'parent' });
    expect(lineOf(v, 'ado:302')).toMatchObject({ id: 'parent:ado:930', name: 'Some task', source: 'parent' });
    expect(lineOf(v, 'ado:303')).toMatchObject({ id: 'video/health', source: 'parent' });
  });

  test('3. a parent never read yet is still a line, named by its ref', () => {
    const v = view({ rows: [row('alpha', { items: [{ ref: 'ado:311' }] })], metaByKey: { 'ado:311': meta('ado:311', { parent: { key: 'ado:950', ref: 'ado:950' } }) } });
    expect(lineOf(v, 'ado:311')).toMatchObject({ id: 'parent:ado:950', name: 'ado:950' });
  });

  test('4. otherwise its own line - named after its run, else the work item - never a catch-all', () => {
    const lead = row('alpha', { name: 'night run', status: 'working', reason: { kind: 'working' } });
    const k1 = row('alpha', { parentId: lead.id, items: [{ ref: 'ado:401' }] });
    const k2 = row('alpha', { parentId: lead.id, items: [{ ref: 'ado:402' }] });
    const lone = row('alpha', { items: [{ ref: 'ado:403', title: 'Lone bug' }] });
    const free = row('alpha', { items: [{ ref: 'not-a-tracker-ref', title: 'free text' }] });
    const v = view({ rows: [lead, k1, k2, lone, free], metaByKey: { 'ado:401': meta('ado:401'), 'ado:402': meta('ado:402'), 'ado:403': meta('ado:403', { title: 'Lone bug' }) } });
    expect(lineOf(v, 'ado:401')).toEqual({ id: `run:${lead.id}`, name: 'night run', project: 'video', kind: 'run', source: 'own' });
    expect(lineOf(v, 'ado:402').id).toBe(`run:${lead.id}`);
    expect(lineOf(v, 'ado:403')).toEqual({ id: 'item:ado:403', name: 'Lone bug', project: 'video', kind: 'item', source: 'own' });
    const freeKey = v.subjects.find((s) => s.title === 'free text').key;
    expect(lineOf(v, freeKey)).toMatchObject({ id: `item:${freeKey}`, kind: 'item' });
    for (const s of v.subjects) expect(s.line.name).not.toMatch(/^general$/i);
  });

  test('0. a Move-to-line override wins over every rule; a line that is gone keeps its stored name', () => {
    const orch = row('alpha', { name: 'bh orchestrator', status: 'working' });
    const w = row('alpha', { name: 'w', parentId: orch.id, items: [{ ref: 'ado:501' }] });
    const x = row('alpha', { name: 'x', line: 'Health', items: [{ ref: 'ado:502' }] });
    const y = row('alpha', { name: 'y', items: [{ ref: 'ado:503' }] });
    const v = view({ rows: [orch, w, x, y], metaByKey: { 'ado:501': meta('ado:501'), 'ado:502': meta('ado:502'), 'ado:503': meta('ado:503') },
      lineOverrides: {
        'ado:501': { line: { id: 'video/health', name: 'Health' }, at: NOW - MIN },
        'ado:502': { line: { id: 'run:gone-run', name: 'Old night run' }, at: NOW - MIN },
        'ado:503': { line: { name: 'UI' }, at: NOW - MIN },
      } });
    expect(lineOf(v, 'ado:501')).toEqual({ id: 'video/health', name: 'Health', project: 'video', kind: 'config', source: 'override' });
    expect(lineOf(v, 'ado:502')).toEqual({ id: 'run:gone-run', name: 'Old night run', project: 'video', kind: 'run', source: 'override' });
    expect(lineOf(v, 'ado:503')).toEqual({ id: 'video/~ui', name: 'UI', project: 'video', kind: 'named', source: 'override' });
  });

  test('back-compat: every #504 field is still there; no overrides given = none', () => {
    const v = view({ rows: [row('alpha', { items: [{ ref: 'ado:601' }] })], metaByKey: { 'ado:601': meta('ado:601') } });
    const s = v.subjects[0];
    for (const f of ['key', 'ref', 'url', 'title', 'project', 'area', 'meta', 'stage', 'sessions', 'needsYou', 'waitsOn', 'buckets', 'runId', 'updatedAt']) {
      expect(s, f).toHaveProperty(f);
    }
    expect(s.area).toBe('General');
    expect(s.line.id).toBe('item:ado:601');
  });
});

test.describe('#523 the lines view', () => {
  test('one row per line: counts, stage bar, sessions, machines and the project as a label; busiest first', () => {
    const orch = row('alpha', { name: 'bh orchestrator', status: 'working', reason: { kind: 'working' } });
    const w1 = row('beta', { name: 'w1', parentId: orch.id, status: 'waiting', reason: { kind: 'you', text: 'pick one' }, items: [{ ref: 'ado:701', stage: 'fixing' }] });
    const w2 = row('gamma', { name: 'w2', parentId: orch.id, reportAt: NOW - 2 * MIN, items: [{ ref: 'ado:702', stage: 'pr-open' }] });
    const h = row('alpha', { name: 'h', items: [{ ref: 'ado:703', title: '[Health] disk' }] });
    const done = closedRec('alpha', { name: 'd', items: [{ ref: 'ado:704' }] });
    const v = view({ rows: [orch, w1, w2, h], closed: [done], metaByKey: {
      'ado:701': meta('ado:701'), 'ado:702': meta('ado:702'), 'ado:703': meta('ado:703', { title: '[Health] disk' }), 'ado:704': meta('ado:704') } });
    const lines = L.linesView({ subjects: v.subjects, projects: projects() });
    expect(lines.map((x) => x.id)).toEqual(['video/hunt', 'video/health', 'item:ado:704']);
    const hunt = lines[0];
    expect(hunt).toMatchObject({ id: 'video/hunt', name: 'Bug hunter', kind: 'config', project: 'video', projectName: 'Video',
      subjects: ['ado:702', 'ado:701'], machines: ['beta', 'gamma'] });
    expect(hunt.counts).toMatchObject({ active: 2, needsYou: 1, waitsOnOthers: 0, doneWeek: 0, sessions: 2 });
    expect(hunt.counts.stages).toMatchObject({ fixing: 1, 'pr-open': 1, merged: 0 });
    expect(lines[2].counts).toMatchObject({ active: 0, doneWeek: 1, sessions: 0 });
    expect(lines[2].machines).toEqual([]);
    // Every configured line, for the pickers (Move to line, Start work), subjects or not.
    expect(L.configuredLines(projects()).map((x) => x.id)).toEqual(['video/hunt', 'video/health', 'video/cut', 'web/mc']);
  });

  test('?line= keeps that line\'s subjects and their runs; ?project= on lines keeps that project\'s', () => {
    const orch = row('alpha', { name: 'bh orchestrator' });
    const w1 = row('alpha', { parentId: orch.id, items: [{ ref: 'ado:801' }] });
    const w2 = row('alpha', { parentId: orch.id, items: [{ ref: 'ado:802' }] });
    const web = row('alpha', { cwd: 'C:\\dev\\web', items: [{ ref: 'acme/web#501' }] });
    const v = view({ rows: [orch, w1, w2, web], metaByKey: { 'ado:801': meta('ado:801'), 'ado:802': meta('ado:802'),
      'acme/web#501': meta('acme/web#501', { adoProject: null, area: null }) } });
    const f = M.filterView(v, { line: 'video/hunt' });
    expect(f.subjects.map((s) => s.key).sort()).toEqual(['ado:801', 'ado:802']);
    expect(f.runs.map((r) => r.id)).toEqual([orch.id]);
    expect(M.filterView(v, { line: 'nope' }).subjects).toEqual([]);
    const lines = L.linesView({ subjects: v.subjects, projects: projects() });
    expect(L.filterLines(lines, { project: 'web' }).map((x) => x.id)).toEqual(['web/mc']);
  });
});

test.describe('#523 Move to line: the target', () => {
  test('a target is an existing line id or a new name; anything else is refused in words', () => {
    const p = projects();
    const known = [{ id: 'parent:ado:920', name: 'SSCP rollout', project: 'video', kind: 'parent' }];
    expect(L.moveTarget({ line: 'video/health' }, { projects: p, lines: known })).toEqual({ ok: true, line: { id: 'video/health', name: 'Health' } });
    expect(L.moveTarget({ line: 'parent:ado:920' }, { projects: p, lines: known })).toEqual({ ok: true, line: { id: 'parent:ado:920', name: 'SSCP rollout' } });
    expect(L.moveTarget({ name: '  UI  ' }, { projects: p, lines: known })).toEqual({ ok: true, line: { name: 'UI' } });
    expect(L.moveTarget({ line: null }, { projects: p, lines: known })).toEqual({ ok: true, line: null });
    for (const body of [{}, { line: 'nope' }, { name: '' }, { name: 'x'.repeat(81) }, { name: 'a\nb' }, { line: 'video/health', name: 'x' }, { line: 5 }]) {
      const r = L.moveTarget(body, { projects: p, lines: known });
      expect(r.ok, JSON.stringify(body)).toBe(false);
      expect(typeof r.error).toBe('string');
    }
  });
});
