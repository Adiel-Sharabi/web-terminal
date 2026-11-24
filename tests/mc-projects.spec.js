// @ts-check
// #503 - lib/projects.js: a session's project, a work item's project and area, the "Other"
// fallback, and the config validation PUT /api/config applies. Pure; the route is pinned in
// mc-routes.spec.js.
const { test, expect } = require('@playwright/test');
const pj = require('../lib/projects');

const CFG = [
  { id: 'video', name: 'Video product',
    match: { repos: ['Acme/Video'], adoProjects: ['Contoso'], paths: ['C:\\dev\\video'] },
    areas: { source: 'ado-area', map: { 'Contoso\\Video\\UI': 'GUI', 'Contoso\\Video': 'Video' } } },
  { id: 'web', name: 'Web', match: { repos: ['acme/web'], paths: ['C:/dev/web'] },
    areas: { source: 'gh-label', map: { 'area:ui': 'GUI', 'area:ai': 'AI' } } },
  { id: 'tools', name: 'Tools', match: { paths: ['C:\\dev\\tools', 'C:\\dev\\tools\\deep'] },
    areas: { source: 'path', map: { 'C:\\dev\\tools\\cli': 'CLI', 'C:\\dev\\tools': 'Misc' } } },
  { id: 'deep', name: 'Deep', match: { paths: ['C:\\dev\\tools\\deep'] } },
];
const valid = () => {
  const v = pj.validateProjects(CFG);
  if (!v.ok) throw new Error(v.error);
  return v.projects;
};
const W = { platform: 'win32' };

test.describe('#503 config validation', () => {
  test('a good list is normalised: missing match lists and areas get defaults', () => {
    const v = pj.validateProjects([{ id: 'a', name: ' A ' }]);
    expect(v).toEqual({ ok: true, projects: [{ id: 'a', name: 'A', match: { repos: [], adoProjects: [], paths: [] }, areas: { source: 'none', map: {} }, lines: [] }] });
    expect(pj.validateProjects(undefined)).toEqual({ ok: true, projects: [] });
  });

  test('every malformed shape is refused whole, with the field named', () => {
    const bad = [
      [{}, 'must be an array'],
      [[{ id: 'Upper', name: 'x' }], '.id'],
      [[{ id: 'other', name: 'x' }], 'reserved'],
      [[{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }], 'used twice'],
      [[{ id: 'a' }], '.name'],
      [[{ id: 'a', name: 'x', match: { repos: ['not-a-repo'] } }], 'match.repos[0]'],
      [[{ id: 'a', name: 'x', match: { paths: 'C:\\dev' } }], 'match.paths'],
      [[{ id: 'a', name: 'x', match: { adoProjects: [`a${String.fromCodePoint(10)}b`] } }], 'match.adoProjects[0]'],
      [[{ id: 'a', name: 'x', areas: { source: 'labels' } }], 'areas.source'],
      [[{ id: 'a', name: 'x', areas: { source: 'path', map: { 'C:\\x': '' } } }], 'areas.map'],
      [Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, name: 'x' })), 'at most 50'],
    ];
    for (const [raw, want] of bad) {
      const v = pj.validateProjects(raw);
      expect(v.ok, JSON.stringify(raw).slice(0, 80)).toBe(false);
      expect(v.error).toContain(want);
    }
  });
});

test.describe('#503 a session\'s project', () => {
  test('git origin first: a GitHub repo or an ADO project, without case', () => {
    const P = valid();
    expect(pj.projectOfSession({ cwd: 'D:\\elsewhere', origin: { kind: 'github', owner: 'acme', repo: 'VIDEO' } }, P, W)).toBe('video');
    expect(pj.projectOfSession({ cwd: 'D:\\elsewhere', origin: { kind: 'ado', org: 'o', project: 'contoso' } }, P, W)).toBe('video');
    // The origin wins over a folder that another project claims.
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools', origin: { kind: 'github', owner: 'acme', repo: 'web' } }, P, W)).toBe('web');
  });

  test('then the folder: a boundary, not a string prefix; no case on Windows; the deepest folder wins', () => {
    const P = valid();
    expect(pj.projectOfSession({ cwd: 'c:\\DEV\\Video\\src' }, P, W)).toBe('video');
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\video2' }, P, W)).toBe('other');
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\web\\app' }, P, W)).toBe('web'); // config path written with /
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools\\deep\\x' }, P, W)).toBe('tools'); // tools lists the same folder first: a tie keeps the first
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools\\deeper' }, P, W)).toBe('tools');
    // A POSIX path keeps its case.
    const posix = pj.validateProjects([{ id: 'p', name: 'P', match: { paths: ['/srv/App'] } }]).projects;
    expect(pj.projectOfSession({ cwd: '/srv/App/x' }, posix, { platform: 'linux' })).toBe('p');
    expect(pj.projectOfSession({ cwd: '/srv/app/x' }, posix, { platform: 'linux' })).toBe('other');
  });

  test('a peer session (no origin known here) is placed by the items it reported', () => {
    const P = valid();
    expect(pj.projectOfSession({ cwd: 'E:\\peer', items: [{ key: 'acme/web#3' }] }, P, W)).toBe('web');
    expect(pj.projectOfSession({ cwd: 'E:\\peer', items: [{ key: 'ado:5', url: 'https://dev.azure.com/org/Contoso/_workitems/edit/5' }] }, P, W)).toBe('video');
  });

  test('#524 a peer session\'s own folder beats a foreign item it merely mentions', () => {
    const P = valid();
    // A peer session (no origin) in the tools folder, following bare refs and one qualified
    // key of another project: it stays in its folder's project.
    const items = [{ key: '#149@s' }, { key: '#39@s' }, { key: 'acme/web#7' }];
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools\\cli', items }, P, W)).toBe('tools');
    const ado = [{ key: 'ado:5', url: 'https://dev.azure.com/org/Contoso/_workitems/edit/5' }];
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools', items: ado }, P, W)).toBe('tools');
    // In an unconfigured folder its items still place it.
    expect(pj.projectOfSession({ cwd: 'E:\\peer', items }, P, W)).toBe('web');
    // A real origin still beats the folder (and the items).
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools', origin: { kind: 'github', owner: 'acme', repo: 'video' }, items }, P, W)).toBe('video');
    // The bound project still beats all of them.
    expect(pj.projectOfSession({ cwd: 'C:\\dev\\tools', origin: { kind: 'github', owner: 'acme', repo: 'video' }, items, bound: 'deep' }, P, W)).toBe('deep');
  });

  test('anything unclaimed is "other"', () => {
    expect(pj.projectOfSession({ cwd: 'Z:\\nowhere' }, valid(), W)).toBe('other');
    expect(pj.projectOfSession({}, [], W)).toBe('other');
  });
});

test.describe('#503 a work item\'s project and area', () => {
  test('project: the repo its key names, else its ADO project, else the sessions on it, else other', () => {
    const P = valid();
    expect(pj.projectOfSubject({ key: 'acme/web#1' }, P)).toBe('web');
    expect(pj.projectOfSubject({ key: 'ado:9', meta: { adoProject: 'CONTOSO' } }, P)).toBe('video');
    expect(pj.projectOfSubject({ key: 'ado:9', meta: null, sessionProjects: ['other', 'tools', 'web', 'tools'] }, P)).toBe('tools');
    expect(pj.projectOfSubject({ key: 'zz/yy#1', sessionProjects: ['other'] }, P)).toBe('other');
  });

  test('ado-area: the longest mapped prefix at a \\ boundary, else the last segment; a bare root is General', () => {
    const video = valid()[0];
    expect(pj.areaOf(video, { meta: { area: 'Contoso\\Video\\UI\\Dialogs' } })).toBe('GUI');
    expect(pj.areaOf(video, { meta: { area: 'contoso\\video\\Decoder' } })).toBe('Video');
    expect(pj.areaOf(video, { meta: { area: 'Contoso\\Video UI' } })).toBe('Video UI'); // not under "Contoso\Video"
    expect(pj.areaOf(video, { meta: { area: 'Contoso\\Audio\\Mixer' } })).toBe('Mixer');
    expect(pj.areaOf(video, { meta: { area: 'Contoso' } })).toBe('General');
    expect(pj.areaOf(video, { meta: null })).toBe('General');
  });

  test('gh-label: the first label the map knows; path: the deepest mapped folder', () => {
    const [, web, tools] = valid();
    expect(pj.areaOf(web, { meta: { labels: ['bug', 'Area:AI', 'area:ui'] } })).toBe('AI');
    expect(pj.areaOf(web, { meta: { labels: ['bug'] } })).toBe('General');
    expect(pj.areaOf(tools, { cwd: 'C:\\dev\\tools\\cli\\src' }, W)).toBe('CLI');
    expect(pj.areaOf(tools, { cwd: 'C:\\dev\\tools\\other' }, W)).toBe('Misc');
    expect(pj.areaOf(tools, { cwd: 'D:\\x' }, W)).toBe('General');
  });
});

test.describe('#503 the projects view', () => {
  test('every configured project in order, then Other only when something landed there', () => {
    const P = valid();
    const empty = pj.projectsView({ projects: P, sessions: [] }, W);
    expect(empty.map((p) => p.id)).toEqual(['video', 'web', 'tools', 'deep']);
    const v = pj.projectsView({ projects: P, sessions: [
      { cwd: 'C:\\dev\\tools\\cli' }, { cwd: 'C:\\dev\\tools\\x' }, { cwd: 'C:\\dev\\video' }, { cwd: 'Q:\\stray' },
    ] }, W);
    expect(v.map((p) => p.id)).toEqual(['video', 'web', 'tools', 'deep', 'other']);
    const byId = Object.fromEntries(v.map((p) => [p.id, p]));
    expect(byId.video).toMatchObject({ name: 'Video product', tracker: { kind: 'github', repo: 'Acme/Video' } });
    expect(byId.video.areas.map((a) => a.name)).toEqual(['GUI', 'Video', 'General']);
    expect(byId.deep).toMatchObject({ tracker: null, areas: [{ id: 'general', name: 'General' }] });
    expect(byId.tools.counts).toEqual({ active: 0, needsYou: 0, waitsOnOthers: 0, doneWeek: 0, sessions: 2, stages: { triage: 0, reproduced: 0, planned: 0, fixing: 0, 'pr-open': 0, 'in-review': 0, merged: 0, tested: 0 } });
    // A folder-rule project counts its sessions per area.
    expect(Object.fromEntries(byId.tools.areas.map((a) => [a.name, a.counts.sessions]))).toEqual({ CLI: 1, Misc: 1, General: 0 });
    // A repo without areas works as ONE area.
    expect(byId.other).toMatchObject({ name: 'Other', tracker: null, counts: { sessions: 1 } });
    expect(byId.other.areas).toEqual([{ id: 'general', name: 'General', counts: { active: 0, needsYou: 0, waitsOnOthers: 0, doneWeek: 0, sessions: 1, stages: { triage: 0, reproduced: 0, planned: 0, fixing: 0, 'pr-open': 0, 'in-review': 0, merged: 0, tested: 0 } } }]);
  });

  test('no projects configured: everything is Other', () => {
    const v = pj.projectsView({ projects: [], sessions: [{ cwd: 'C:\\a' }] }, W);
    expect(v.map((p) => p.id)).toEqual(['other']);
  });
});
