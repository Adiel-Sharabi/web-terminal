// @ts-check
// #512 - Mission Control's Start work: lib/mc-start.js (the request, the started session's
// name and launch command, the machine suggestion), lib/mc-binding.js (a session bound at
// birth, and what its children inherit), the binding in lib/mc-state.js, and how a bound
// session reaches lib/mc-subjects.js. Pure, from SYNTHETIC fixtures. The routes are pinned in
// mc-routes.spec.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const S = require('../lib/mc-start');
const B = require('../lib/mc-binding');
const M = require('../lib/mc-subjects');
const { createMcState } = require('../lib/mc-state');
const { parseRef } = require('../lib/tracker-meta');
const pj = require('../lib/projects');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const PROJECTS = pj.validateProjects([
  { id: 'widgets', name: 'Widgets', match: { repos: ['acme/widgets'], paths: ['C:\\dev\\widgets', 'D:\\widgets'] } },
  { id: 'billing', name: 'Billing', match: { adoProjects: ['Contoso'], paths: ['C:\\dev\\billing'] } },
  { id: 'nofolder', name: 'No Folder', match: { repos: ['acme/nofolder'] } },
]).projects;
const parse = (body) => S.parseStart(body, { projects: PROJECTS, parseRef });

/** A node as lib/mc-subjects.js sessionNodes makes it (only the fields read here). */
function node({ id = uid('s'), items = [], parentId = null, replaces = [], closed = false, createdAt = NOW - 10 * MIN, reportAt = null, cwd = 'C:\\tmp\\elsewhere', status = 'idle' } = {}) {
  return { id, server: 'alpha', serverUrl: null, name: `session ${id.slice(0, 6)}`, status, closed, closedAt: closed ? NOW - MIN : null,
    cwd, origin: null, items, headline: null, reportAt, wait: null, reason: null, waitingFor: null, parentId, replaces, createdAt, lastActivity: NOW };
}
const binding = (over = {}) => ({ project: 'widgets', subjects: [{ key: 'acme/widgets#42', ref: '#42' }], hunt: false, server: 'alpha', at: NOW - 5 * MIN, ...over });

test.describe('#512 Start work: the request', () => {
  test('a work item in a project: a bare #N takes the project repo; the folder is its first path', () => {
    const p = parse({ project: 'widgets', subjects: ['#42', 'acme/widgets#42', 'ado:7'], server: 'alpha' });
    expect(p.error).toBeUndefined();
    expect(p.value).toMatchObject({ hunt: false, server: 'alpha', cwd: 'C:\\dev\\widgets', name: null, brief: null,
      subjects: [{ key: 'acme/widgets#42', ref: '#42' }, { key: 'ado:7', ref: 'ado:7' }] });
    expect(p.value.project.id).toBe('widgets');
  });

  test('a hunt needs no work item; without hunt at least one is required', () => {
    expect(parse({ project: 'widgets', hunt: true, server: 'alpha' }).value).toMatchObject({ hunt: true, subjects: [] });
    expect(parse({ project: 'widgets', server: 'alpha' }).error).toContain('pick at least one work item');
    expect(parse({ project: 'widgets', subjects: [], hunt: false, server: 'alpha' }).error).toContain('pick at least one');
  });

  test('refusals say why: unknown project, no folder, a ref nobody can qualify, a bad ref, no server, too long', () => {
    expect(parse({ project: 'nope', hunt: true, server: 'a' }).error).toContain('no project "nope"');
    expect(parse({ hunt: true, server: 'a' }).error).toContain('project is required');
    expect(parse({ project: 'nofolder', hunt: true, server: 'a' }).error).toContain('has no folder');
    expect(parse({ project: 'billing', subjects: ['#5'], server: 'a' }).error).toContain('names no repo');
    expect(parse({ project: 'billing', subjects: ['ado:5'], server: 'a' }).value.subjects).toEqual([{ key: 'ado:5', ref: 'ado:5' }]);
    expect(parse({ project: 'widgets', subjects: ['fix the thing'], server: 'a' }).error).toContain('not a work-item ref');
    expect(parse({ project: 'widgets', subjects: '#1', server: 'a' }).error).toContain('a list');
    expect(parse({ project: 'widgets', subjects: Array.from({ length: 11 }, (_, i) => `#${i + 1}`), server: 'a' }).error).toContain('at most 10');
    expect(parse({ project: 'widgets', hunt: true }).error).toContain('server is required');
    expect(parse({ project: 'widgets', hunt: 'yes', server: 'a' }).error).toContain('hunt must be');
    expect(parse({ project: 'widgets', hunt: true, server: 'a', name: 'x'.repeat(101) }).error).toContain('name must be');
    expect(parse({ project: 'widgets', hunt: true, server: 'a', brief: 'x'.repeat(501) }).error).toContain('brief must be');
    expect(parse(null).error).toContain('project is required');
  });
});

test.describe('#512 Start work: the session it starts', () => {
  test('name: project, ref and the tracker title; a hunt says so; an explicit name wins', () => {
    const v = parse({ project: 'widgets', subjects: ['#42', '#43'], server: 'a' }).value;
    const plan = S.startPlan(v, { titles: { 'acme/widgets#42': 'Widget list loses its scroll' } });
    expect(plan.name).toBe('Widgets #42 +1 Widget list loses its scroll');
    expect(plan.autoCommand).toBe('claude --dangerously-skip-permissions "Fix acme/widgets#42, acme/widgets#43 (Widget list loses its scroll) in project Widgets."');
    expect(plan.goal).toBe('Fix acme/widgets#42, acme/widgets#43 (Widget list loses its scroll) in project Widgets.');
    const hunt = S.startPlan(parse({ project: 'widgets', hunt: true, server: 'a', brief: 'Start with the importer' }).value, { command: 'echo' });
    expect(hunt.name).toBe('Widgets hunt');
    expect(hunt.autoCommand).toBe('echo "Bug hunt in project Widgets. Start with the importer"');
    const named = S.startPlan(parse({ project: 'widgets', hunt: true, server: 'a', name: 'My run' }).value);
    expect(named.name).toBe('My run');
  });

  test('the words the server writes lose what a shell acts on inside double quotes (project name, tracker title)', () => {
    const projects = pj.validateProjects([{ id: 'evil', name: 'Ev$il`x"!%^&|<>\\', match: { repos: ['acme/evil'], paths: ['C:\\e'] } }]).projects;
    const v = S.parseStart({ project: 'evil', subjects: ['#1'], server: 'a', brief: 'Plain words; ok?' }, { projects, parseRef }).value;
    const plan = S.startPlan(v, { titles: { 'acme/evil#1': 'T $HOME `x` "q" !! %P% ^& a | b\nc' } });
    const inside = plan.autoCommand.slice(plan.autoCommand.indexOf('"') + 1, -1);
    expect(plan.autoCommand.endsWith('"')).toBe(true);
    expect(inside).not.toMatch(/[`$"\\!%^&|<>\r\n]/);
    expect(inside.endsWith('Plain words; ok?')).toBe(true);
    // Letters in any script survive; control characters do not.
    expect(S.safeText('Fix the שלום case; ok?', 100)).toBe('Fix the שלום case; ok?');
    expect(S.safeText('a\u0000b\u001bc', 100)).toBe('a b c');
    // A cut never leaves half a surrogate pair (U+20000 is a letter outside the BMP; an
    // emoji is a symbol, not a letter, so it is dropped before any cut).
    expect(S.safeText('ab\u{1F600}cd', 100)).toBe('ab cd');
    expect(S.safeText('ab\u{20000}cd', 3)).toBe('ab');
    expect(S.safeText('ab\u{20000}cd', 4)).toBe('ab\u{20000}');
  });

  test('a brief is REFUSED, never changed: a character a shell acts on is named; one too long says by how much', () => {
    const bad = parse({ project: 'widgets', hunt: true, server: 'a', brief: 'look at C:\\dev and $env:PATH, "quote" it\nnow' });
    expect(bad.error).toContain('cannot contain');
    for (const c of ['\\', '$', '"', 'a line break or control character']) expect(bad.error).toContain(c);
    expect(parse({ project: 'widgets', hunt: true, server: 'a', brief: 'Keep  it   small' }).value.brief).toBe('Keep it small');
    // 500 characters pass the field's cap but not the launch command's room beside the task.
    const v = parse({ project: 'widgets', hunt: true, server: 'a', brief: `${'word '.repeat(99)}END` }).value;
    const plan = S.startPlan(v);
    expect(plan.error).toMatch(/^the brief is \d+ characters too long for this start/);
    expect(plan.autoCommand).toBeUndefined();
    // One that fits is delivered whole, and the command stays within the create route's 500.
    const fits = S.startPlan(parse({ project: 'widgets', hunt: true, server: 'a', brief: `${'word '.repeat(60)}END` }).value);
    expect(fits.autoCommand.endsWith('END"')).toBe(true);
    expect(fits.autoCommand.length).toBeLessThanOrEqual(500);
  });

  test('config mc.startCommand: a plain command line, else the default', () => {
    expect(S.startCommand({ startCommand: 'claude --model opus' })).toBe('claude --model opus');
    expect(S.startCommand({ startCommand: 'claude; rm -rf /' })).toBe(S.DEFAULT_START_COMMAND);
    expect(S.startCommand({ startCommand: 'claude "x"' })).toBe(S.DEFAULT_START_COMMAND);
    expect(S.startCommand(null)).toBe(S.DEFAULT_START_COMMAND);
  });
});

test.describe('#512 Start work: which machine', () => {
  const servers = [
    { name: 'alpha', url: null, online: true, needsAuth: false, resources: { cpuPct: 40 } },
    { name: 'beta', url: 'https://beta.example.test', online: true, needsAuth: false, resources: { cpuPct: 10 } },
    { name: 'gamma', url: 'https://gamma.example.test', online: true, needsAuth: false },
    { name: 'delta', url: 'https://delta.example.test', online: false },
    { name: 'eps', url: 'https://eps.example.test', online: true, needsAuth: true },
  ];
  const rows = [
    { server: 'alpha', status: 'working' }, { server: 'alpha', status: 'idle' },
    { server: 'beta', status: 'idle' }, { server: 'beta', status: 'idle' }, { server: 'beta', status: 'waiting' },
    { server: 'gamma', status: 'working' },
  ];
  const free = { held: false };

  test('the fewest WORKING sessions wins, then the fewest sessions; every machine is listed with why it cannot take one', () => {
    const v = S.machinesView({ servers, rows, holds: { alpha: free, beta: free, gamma: free } });
    expect(v.suggested).toBe('beta');
    expect(v.machines.map((m) => [m.name, m.ok, m.sessions, m.working, m.load])).toEqual([
      ['alpha', true, 2, 1, 40], ['beta', true, 3, 0, 10], ['gamma', true, 1, 1, null], ['delta', false, 0, 0, null], ['eps', false, 0, 0, null]]);
    expect(v.machines.find((m) => m.name === 'delta').why).toBe('offline');
    expect(v.machines.find((m) => m.name === 'eps').why).toContain('not signed in');
    expect(v.machines[1].url).toBe('https://beta.example.test');
  });

  test('a held machine, or one whose hold could not be read, is never suggested', () => {
    const v = S.machinesView({ servers, rows, holds: { alpha: free, beta: { held: true, reason: 'update' } } });
    expect(v.machines.find((m) => m.name === 'beta')).toMatchObject({ ok: false, why: 'restart hold: update' });
    expect(v.machines.find((m) => m.name === 'gamma')).toMatchObject({ ok: false, why: 'its restart hold could not be read' });
    expect(v.suggested).toBe('alpha');
    expect(S.machinesView({ servers, rows, holds: {} }).suggested).toBe(null);
  });

  test('a tie on sessions goes to the lower CPU, then list order', () => {
    const two = [{ name: 'a', url: null, online: true, resources: { cpuPct: 50 } }, { name: 'b', url: 'u', online: true, resources: { cpuPct: 5 } }];
    expect(S.machinesView({ servers: two, rows: [], holds: { a: free, b: free } }).suggested).toBe('b');
    const same = [{ name: 'a', url: null, online: true }, { name: 'b', url: 'u', online: true }];
    expect(S.machinesView({ servers: same, rows: [], holds: { a: free, b: free } }).suggested).toBe('a');
  });
});

test.describe('#512 a session bound at birth', () => {
  test('its subjects stand in for a report until it reports its own; its project always comes from the binding', () => {
    const a = node();
    const b = node({ items: [{ key: 'acme/widgets#7', ref: '#7', state: 'in-progress' }], reportAt: NOW - MIN });
    const out = B.applyBindings([a, b], { [a.id]: binding(), [b.id]: binding() });
    expect(out[0]).toMatchObject({ boundProject: 'widgets', items: [{ key: 'acme/widgets#42', ref: '#42', bound: true, boundAt: a.createdAt, state: null }] });
    expect(out[1].boundProject).toBe('widgets');
    expect(out[1].items).toEqual(b.items); // its own report wins
    expect(a.items).toEqual([]); // the input is not changed
  });

  test('children inherit it through spawn.parentId (any depth), a successor through spawn.replaces; strangers do not', () => {
    const lead = node();
    const child = node({ parentId: lead.id });
    const grand = node({ parentId: child.id });
    const succ = node({ replaces: [lead.id] });
    const stranger = node();
    const loop1 = node({ id: 'loop-a', parentId: 'loop-b' });
    const loop2 = node({ id: 'loop-b', parentId: 'loop-a' });
    const used = new Set();
    const out = B.applyBindings([lead, child, grand, succ, stranger, loop1, loop2], { [lead.id]: binding({ hunt: true, subjects: [] }) }, used);
    expect([...used]).toEqual([lead.id]); // the store keeps the binding alive while it is in use
    expect(out.map((x) => x.boundProject || null)).toEqual(['widgets', 'widgets', 'widgets', 'widgets', null, null, null]);
    // A hunt has no subjects: nothing stands in for a report.
    expect(out.every((x) => x.items.length === 0)).toBe(true);
    // A child of a bound "fix" lead shows under its subject from birth too.
    const kid = B.applyBindings([lead, child], { [lead.id]: binding() })[1];
    expect(kid.items.map((i) => [i.key, i.bound])).toEqual([['acme/widgets#42', true]]);
  });

  test('a stored binding is validated; old ones are pruned, newest kept', () => {
    expect(B.bindingOf({ project: 'widgets', at: 1, subjects: [{ key: 'k' }, { key: 'k' }, { nope: 1 }] })).toEqual(
      { project: 'widgets', subjects: [{ key: 'k', ref: 'k' }], hunt: false, server: null, at: 1, seenAt: 1 });
    expect(B.bindingOf({ project: 'widgets' })).toBe(null);
    expect(B.bindingOf(['x'])).toBe(null);
    const kept = B.pruneBindings({ old: { at: NOW - 9 * DAY }, a: { at: NOW - 2 }, b: { at: NOW - 1 }, c: { at: NOW - 3 } }, NOW, { max: 2 });
    expect(Object.keys(kept)).toEqual(['b', 'a']);
    // Its age is from when it was last in use, not from the start: a long run keeps it.
    expect(Object.keys(B.pruneBindings({ run: { at: NOW - 20 * DAY, seenAt: NOW - DAY } }, NOW))).toEqual(['run']);
  });

  test('the subject lists a bound session before any report, marked bound, under the project it was started for', () => {
    const lead = node({ cwd: 'C:\\tmp\\nowhere' });
    const child = node({ parentId: lead.id });
    const nodes = B.applyBindings([lead, child], { [lead.id]: binding({ project: 'billing', subjects: [{ key: 'ado:9001', ref: 'ado:9001' }] }) });
    const view = M.buildView({ nodes, projects: PROJECTS, now: NOW });
    const s = view.subjects.find((x) => x.key === 'ado:9001');
    expect(s).toBeTruthy();
    expect(s.project).toBe('billing');
    expect(s.sessions.map((x) => [x.id, x.bound, x.lastReport.state])).toEqual([[lead.id, true, null], [child.id, true, null]]);
    expect(s.sessions[0].lastReport.at).toBe(lead.createdAt);
    expect(s.updatedAt).toBe(lead.createdAt);
    // Without the binding, the same sessions are on no subject at all (the test is not vacuous).
    expect(M.buildView({ nodes: [lead, child], projects: PROJECTS, now: NOW }).subjects).toEqual([]);
    // The project view counts the bound session toward its project, not Other.
    expect(pj.projectOfSession({ cwd: lead.cwd, bound: 'billing' }, PROJECTS)).toBe('billing');
    expect(pj.projectOfSession({ cwd: lead.cwd, bound: 'gone' }, PROJECTS)).toBe('other');
  });

  test('mc-state keeps bindings under their own key, across a restart, beside the stage history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mc-bind-'));
    const file = path.join(dir, 'mc-state.json');
    try {
      const st = createMcState({ file, now: () => NOW, saveDelayMs: 1 });
      expect(st.setBinding('s1', binding())).toBe(true);
      expect(st.setBinding('s2', { project: 'x' })).toBe(false);
      st.setStageHistory('acme/widgets#42', [{ stage: 'fixing', at: NOW, source: 'report', detail: '' }], { changed: true });
      st.flush();
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(Object.keys(disk)).toEqual(['v', 'stages', 'bindings']);
      const again = createMcState({ file, now: () => NOW });
      expect(again.bindings()).toEqual({ s1: { ...binding(), seenAt: binding().at } });
      expect(again.stageHistory('acme/widgets#42')).toHaveLength(1);
      // Nine days later the binding is gone - unless it was in use meanwhile.
      expect(createMcState({ file, now: () => NOW + 9 * DAY }).bindings()).toEqual({});
      let t = NOW + 7 * DAY;
      const live = createMcState({ file, now: () => t, saveDelayMs: 1 });
      live.touchBindings(new Set(['s1', 'not-there']));
      live.flush();
      t = NOW + 9 * DAY;
      expect(Object.keys(createMcState({ file, now: () => t }).bindings())).toEqual(['s1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
