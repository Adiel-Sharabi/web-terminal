// @ts-check
// #502/#503 - the Mission Control routes on the real server: GET /api/work-items/:ref/meta,
// GET /api/work-items/meta?refs=, GET /api/mc/projects, the `projects` config key, auth on
// each, and the 409 a non-authority answers. The rules themselves are pinned in
// mc-tracker-meta.spec.js and mc-projects.spec.js.
//
// No network: playwright.config.js points the suite server's trackers at the fake this spec
// serves on 127.0.0.1:17688 (WT_MC_GITHUB_API / WT_MC_ADO_URL) with the suite's own tokens.
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
const FIX = path.join(__dirname, 'fixtures', 'mc-tracker');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVE_CONFIG_MS = 5600; // server.js re-reads config.json at most every 5 s

/** The fake tracker. Records every request (path + auth header) it was asked. */
function fakeTracker() {
  const seen = [];
  const routes = {
    '/gh/repos/acme/widgets/issues/42': [200, fx('gh-issue.json')],
    '/gh/repos/acme/widgets/issues/42/timeline?per_page=100&page=1': [200, fx('gh-timeline.json')],
    '/gh/repos/acme/widgets/issues/99': [500, { message: 'boom' }],
    '/ado/fakeorg/_apis/wit/workitems/9001?$expand=relations&api-version=7.1': [200, fx('ado-workitem.json')],
    '/ado/fakeorg/proj-guid/_apis/git/repositories/repo-guid/pullrequests/77?api-version=7.1': [200, fx('ado-pr-77.json')],
    '/ado/fakeorg/proj-guid/_apis/git/repositories/repo-guid/pullrequests/78?api-version=7.1': [200, fx('ado-pr-78.json')],
  };
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    const hit = routes[req.url];
    res.writeHead(hit ? hit[0] : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hit ? hit[1] : { message: 'Not Found' }));
  });
  return { seen, start: () => new Promise((r, j) => { server.once('error', j); server.listen(17688, '127.0.0.1', r); }), stop: () => new Promise((r) => server.close(r)) };
}

/** Write config.test.json (merged over what is there) and wait for the server to read it. */
async function withConfig(patch, fn) {
  const before = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
  fs.writeFileSync(CFG_FILE, JSON.stringify({ ...(before ? JSON.parse(before) : {}), ...patch }, null, 2));
  await sleep(LIVE_CONFIG_MS);
  try { await fn(); } finally {
    if (before === null) fs.unlinkSync(CFG_FILE); else fs.writeFileSync(CFG_FILE, before);
    await sleep(LIVE_CONFIG_MS);
  }
}

test.describe('#502/#503 Mission Control routes', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90000);
  const tracker = fakeTracker();
  test.beforeAll(async () => { await tracker.start(); });
  test.afterAll(async () => { await tracker.stop(); });

  test('every new route needs auth', async () => {
    const ctx = await noAuthCtx();
    for (const url of ['/api/work-items/acme%2Fwidgets%2342/meta', '/api/work-items/meta?refs=ado%3A1', '/api/mc/projects',
      '/api/mc/subjects', '/api/mc/subjects/ado%3A1', '/api/mc/machines', '/api/mc/lines']) {
      const r = await ctx.get(url, { maxRedirects: 0 });
      expect(r.status(), url).toBe(401);
    }
    expect((await ctx.post('/api/mc/start', { data: { project: 'x', hunt: true, server: 'x' }, maxRedirects: 0 })).status()).toBe(401);
    expect((await ctx.post('/api/mc/lines/move', { data: { subject: 'ado:1', name: 'x' }, maxRedirects: 0 })).status()).toBe(401);
    await ctx.dispose();
    expect(tracker.seen.length).toBe(0);
  });

  test('meta: a GitHub issue and an ADO bug, from the tracker, with the suite\'s own tokens', async () => {
    await withConfig({ mc: { ado: { org: 'fakeorg' } } }, async () => {
      const ctx = await authCtx();
      const gh = await ctx.get(`/api/work-items/${encodeURIComponent('acme/widgets#42')}/meta`);
      expect(gh.status()).toBe(200);
      const g = await gh.json();
      expect(g).toMatchObject({ key: 'acme/widgets#42', tracker: 'github', title: 'Widget list loses its scroll position',
        type: 'Issue', state: 'open', closed: false, severity: 2, priority: 1, assignee: 'dev-b', error: null, staleSince: null });
      expect(g.prs.map((p) => [p.number, p.state])).toEqual([[43, 'merged'], [44, 'open']]);
      expect(Number.isFinite(g.fetchedAt) && Number.isFinite(g.generatedAt)).toBe(true);

      // The batch form: a bare #N qualified by repo=, an ADO item, a tracker error and a
      // duplicate - one entry per key, the error one still answered (title null, error set).
      const refs = ['#42', 'ado:9001', 'acme/widgets#99', 'Acme/Widgets#42'].map(encodeURIComponent).join(',');
      const b = await ctx.get(`/api/work-items/meta?repo=acme/widgets&refs=${refs}`);
      expect(b.status()).toBe(200);
      const { items, generatedAt } = await b.json();
      expect(Number.isFinite(generatedAt)).toBe(true);
      expect(Object.keys(items).sort()).toEqual(['acme/widgets#42', 'acme/widgets#99', 'ado:9001']);
      expect(items['ado:9001']).toMatchObject({ tracker: 'ado', title: 'Decoder drops the first frame', type: 'Bug', state: 'Resolved',
        closed: true, severity: 2, priority: 1, area: 'Contoso\\Video\\Decoder', labels: ['regression', 'video'], adoProject: 'Contoso', error: null });
      expect(items['ado:9001'].prs.map((p) => [p.number, p.state, p.draft])).toEqual([[77, 'merged', false], [78, 'open', true]]);
      expect(items['acme/widgets#99']).toMatchObject({ title: null, error: 'GitHub answered HTTP 500', fetchedAt: null });
      await ctx.dispose();
    });
    // Tokens: the suite's, never a real one; each tracker got only its own.
    const ghAuth = new Set(tracker.seen.filter((s) => s.url.startsWith('/gh/')).map((s) => s.auth));
    const adoAuth = new Set(tracker.seen.filter((s) => s.url.startsWith('/ado/')).map((s) => s.auth));
    expect([...ghAuth]).toEqual(['Bearer suite-github-token']);
    expect([...adoAuth]).toEqual([`Basic ${Buffer.from(':suite-ado-pat').toString('base64')}`]);
  });

  test('meta: a fresh copy is served from the cache without asking the tracker again', async () => {
    const ctx = await authCtx();
    const before = tracker.seen.length;
    const r = await ctx.get(`/api/work-items/${encodeURIComponent('acme/widgets#42')}/meta`);
    expect((await r.json()).title).toBe('Widget list loses its scroll position');
    expect(tracker.seen.length).toBe(before);
    await ctx.dispose();
  });

  test('meta: bad refs are refused with the reason; the batch route is not read as a ref', async () => {
    const ctx = await authCtx();
    for (const [url, want] of [
      ['/api/work-items/hello/meta', 'not a work-item ref'],
      [`/api/work-items/${encodeURIComponent('#42')}/meta`, 'names no repo'],
      [`/api/work-items/${encodeURIComponent('#42')}/meta?repo=bad`, 'not a work-item ref'],
      ['/api/work-items/meta', 'refs is required'],
      [`/api/work-items/meta?refs=${encodeURIComponent('ado:1,nope')}`, 'not a work-item ref: nope'],
      ['/api/work-items/meta?repo=bad&refs=ado%3A1', 'repo must be owner/repo'],
      [`/api/work-items/meta?refs=${Array.from({ length: 51 }, (_, i) => `ado:${i + 1}`).join(',')}`, 'at most 50'],
    ]) {
      const r = await ctx.get(url);
      expect(r.status(), url).toBe(400);
      expect((await r.json()).error, url).toContain(want);
    }
    // A bare #N in a batch without repo= is answered per item, never read.
    const r = await ctx.get(`/api/work-items/meta?refs=${encodeURIComponent('#7')}`);
    expect((await r.json()).items['#7']).toMatchObject({ title: null, error: expect.stringContaining('names no repo') });
    await ctx.dispose();
  });

  test('projects: the config key is validated, refused whole, and the view groups sessions with Other last', async () => {
    const ctx = await authCtx();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mc-proj-'));
    const cli = path.join(dir, 'cli');
    fs.mkdirSync(cli);
    const before = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
    const made = [];
    try {
      const bad = await ctx.put('/api/config', { data: { projects: [{ id: 'other', name: 'x' }] } });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).error).toContain('reserved');
      expect(fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null).toBe(before);

      const projects = [{ id: 'tools', name: 'Tools', match: { paths: [dir.toUpperCase()] }, areas: { source: 'path', map: { [cli]: 'CLI' } } }];
      const ok = await ctx.put('/api/config', { data: { projects } });
      expect(ok.status()).toBe(200);
      expect(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).projects[0]).toMatchObject({ id: 'tools', areas: { source: 'path' } });

      for (const cwd of [cli, os.tmpdir()]) {
        const r = await ctx.post('/api/sessions', { data: { name: `mc-proj-${made.length}`, cwd, autoCommand: '' } });
        expect(r.status()).toBe(200);
        made.push((await r.json()).id);
      }
      let view = null;
      for (let i = 0; i < 40; i++) {
        view = await (await ctx.get('/api/mc/projects')).json();
        const tools = view.projects && view.projects.find((p) => p.id === 'tools');
        if (tools && tools.counts.sessions === 1) break;
        await sleep(300);
      }
      expect(Number.isFinite(view.generatedAt)).toBe(true);
      const ids = view.projects.map((p) => p.id);
      expect(ids[0]).toBe('tools');
      expect(ids[ids.length - 1]).toBe('other'); // the tmpdir session (and any other) is in Other, last
      const tools = view.projects[0];
      expect(tools).toMatchObject({ name: 'Tools', tracker: null, counts: { sessions: 1, active: 0, needsYou: 0, waitsOnOthers: 0, doneWeek: 0 } });
      expect(tools.areas.map((a) => [a.name, a.counts.sessions])).toEqual([['CLI', 1], ['General', 0]]);
    } finally {
      for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      if (before === null) { if (fs.existsSync(CFG_FILE)) fs.unlinkSync(CFG_FILE); } else fs.writeFileSync(CFG_FILE, before);
      // A just-closed session's shell can still hold its folder; the OS temp cleanup gets it then.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* held */ }
      await ctx.dispose();
    }
  });

  test('subjects (#504/#505): a reported item becomes a subject with its stage from the tracker, and stays once its session closes', async () => {
    const ctx = await authCtx();
    const key = 'acme/widgets#42';
    const made = await ctx.post('/api/sessions', { data: { name: `mc-subject-${Date.now()}`, autoCommand: '' } });
    expect(made.status()).toBe(200);
    const id = (await made.json()).id;
    let closed = false;
    try {
      // The agent says fixing; the fake tracker says PR #43 is merged and PR #44 still open, so the
      // work goes on at pr-open (lib/mc-stage.js; merged-only is pinned in mc-stage.spec.js).
      const c = await pwRequest.newContext({ baseURL: BASE });
      const rep = await c.post(`/api/session/${id}/report`, { data: { items: [{ ref: key, title: 'Scroll', state: 'in-progress', stage: 'fixing' }] },
        headers: { 'X-WT-Hook-Token': readHookToken() } });
      expect(rep.status()).toBe(200);
      expect((await rep.json()).brief.items[0]).toMatchObject({ key, stage: 'fixing' });
      await c.dispose();

      let body = null;
      let s = null;
      for (let i = 0; i < 40 && !(s && s.stage.current === 'pr-open'); i++) {
        if (i) await sleep(300);
        body = await (await ctx.get('/api/mc/subjects')).json();
        s = body.subjects && body.subjects.find((x) => x.key === key);
      }
      expect(body.stages).toEqual(['triage', 'reproduced', 'planned', 'fixing', 'pr-open', 'in-review', 'merged', 'tested']);
      expect(body.servers[0]).toMatchObject({ ok: true });
      expect(Number.isFinite(body.generatedAt)).toBe(true);
      expect(s).toMatchObject({ key, title: 'Widget list loses its scroll position', project: 'other', area: 'General',
        stage: { current: 'pr-open', reported: 'fixing', evidence: 'pr-open' } });
      expect(s.buckets).toContain('active');
      expect(s.sessions.map((x) => [x.id, x.closed])).toEqual([[id, false]]);

      // One subject by its key, in any spelling of the ref; unknown is 404; a bad filter 400.
      const one = await ctx.get(`/api/mc/subjects/${encodeURIComponent('Acme/Widgets#42')}`);
      expect(one.status()).toBe(200);
      expect((await one.json()).subject.key).toBe(key);
      expect((await ctx.get(`/api/mc/subjects/${encodeURIComponent('ado:987654')}`)).status()).toBe(404);
      expect((await ctx.get('/api/mc/subjects?project=a&project=b')).status()).toBe(400);
      expect((await (await ctx.get('/api/mc/subjects?project=nope')).json()).subjects).toEqual([]);

      // The projects view counts it from the same rule, stages included.
      const pv = await (await ctx.get('/api/mc/projects')).json();
      const other = pv.projects.find((p) => p.id === 'other');
      expect(other.counts.stages['pr-open']).toBeGreaterThanOrEqual(1);
      expect(Object.keys(other.counts.stages)).toEqual(body.stages);

      // Closed: still on the subject (the closed strip keeps it a week), as closed.
      expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(200);
      closed = true;
      let ref = null;
      for (let i = 0; i < 40 && !(ref && ref.closed); i++) {
        await sleep(300);
        const b2 = await (await ctx.get('/api/mc/subjects')).json();
        const s2 = b2.subjects.find((x) => x.key === key);
        ref = s2 && s2.sessions.find((x) => x.id === id);
      }
      expect(ref).toMatchObject({ id, closed: true, status: 'closed' });
      expect(Number.isFinite(ref.closedAt)).toBe(true);
    } finally {
      if (!closed) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });

  test('a wait that names no item shows once (#546): the subjects carry none of it, /api/mc/subjects carries it once, the line counts it once', async () => {
    const ctx = await authCtx();
    const stamp = Date.now();
    const lineName = `wait-line-${stamp}`;
    const keys = ['ado:9101', 'ado:9102', 'ado:9103'];
    const made = await ctx.post('/api/sessions', { data: { name: `mc-wait-${stamp}`, autoCommand: '' } });
    expect(made.status()).toBe(200);
    const id = (await made.json()).id;
    try {
      const c = await pwRequest.newContext({ baseURL: BASE });
      const rep = await c.post(`/api/session/${id}/report`, { headers: { 'X-WT-Hook-Token': readHookToken() }, data: {
        items: keys.map((k) => ({ ref: k, state: 'in-progress', stage: 'fixing' })), line: lineName,
        wait: { on: 'you', what: 'OK for one re-run?' } } });
      expect(rep.status()).toBe(200);
      await c.dispose();
      let body = null;
      for (let i = 0; i < 40; i++) {
        if (i) await sleep(300);
        body = await (await ctx.get(`/api/mc/subjects?line=${encodeURIComponent(`other/~wait-line-${stamp}`)}`)).json();
        if (body.waits && body.waits.length) break;
      }
      expect(body.subjects.map((x) => x.key).sort()).toEqual(keys);
      for (const x of body.subjects) { expect(x.needsYou, x.key).toBeNull(); expect(x.waitsOn, x.key).not.toBe('you'); }
      expect(body.waits).toHaveLength(1);
      expect(body.waits[0].card).toMatchObject({ kind: 'wait', sessionId: id, what: 'OK for one re-run?', subjectKey: null });
      expect(body.waits[0].subjects.slice().sort()).toEqual(keys);
      const lines = await (await ctx.get('/api/mc/lines')).json();
      const line = lines.lines.find((l) => l.id === `other/~wait-line-${stamp}`);
      expect(line.counts).toMatchObject({ needsYou: 1, active: 3 });
    } finally {
      await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });

  test('lines (#523): a reported line groups the item; Move to line wins and null hands it back; a closed session keeps its line', async () => {
    const ctx = await authCtx();
    const key = 'ado:9001';
    const made = await ctx.post('/api/sessions', { data: { name: `mc-line-${Date.now()}`, autoCommand: '' } });
    expect(made.status()).toBe(200);
    const id = (await made.json()).id;
    let closed = false;
    const subjectOf = async () => {
      const b = await (await ctx.get('/api/mc/subjects')).json();
      return b.subjects && b.subjects.find((x) => x.key === key);
    };
    try {
      const c = await pwRequest.newContext({ baseURL: BASE });
      const bad = await c.post(`/api/session/${id}/report`, { data: { items: [{ ref: key, state: 'in-progress' }], line: 7 },
        headers: { 'X-WT-Hook-Token': readHookToken() } });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).error).toContain('"line"');
      const rep = await c.post(`/api/session/${id}/report`, { data: { items: [{ ref: key, state: 'in-progress' }], line: 'Docket fixes' },
        headers: { 'X-WT-Hook-Token': readHookToken() } });
      expect(rep.status()).toBe(200);
      expect((await rep.json()).brief.line).toBe('Docket fixes');
      await c.dispose();

      let s = null;
      for (let i = 0; i < 40 && !(s && s.line && s.line.name === 'Docket fixes'); i++) { if (i) await sleep(300); s = await subjectOf(); }
      expect(s.line).toEqual({ id: 'other/~docket-fixes', name: 'Docket fixes', project: 'other', kind: 'named', source: 'session' });

      const lv = await (await ctx.get('/api/mc/lines')).json();
      const row = lv.lines.find((l) => l.id === 'other/~docket-fixes');
      expect(row).toMatchObject({ name: 'Docket fixes', kind: 'named', project: 'other', projectName: 'Other', subjects: [key] });
      // The fake tracker's 9001 is closed: done this week, one live session on the line.
      expect(row.counts).toMatchObject({ active: 0, doneWeek: 1, sessions: 1 });
      expect(Array.isArray(lv.configured)).toBe(true);
      expect((await (await ctx.get(`/api/mc/subjects?line=${encodeURIComponent('other/~docket-fixes')}`)).json()).subjects.map((x) => x.key)).toEqual([key]);
      expect((await (await ctx.get('/api/mc/subjects?line=nope')).json()).subjects).toEqual([]);
      expect((await (await ctx.get('/api/mc/now')).json()).lines.some((l) => l.id === 'other/~docket-fixes')).toBe(true);

      // Move to line: a new line by name wins over the session's own; null hands it back.
      const mv = await ctx.post('/api/mc/lines/move', { data: { subject: 'AB#9001', name: 'UI' } });
      expect(mv.status()).toBe(200);
      expect(await mv.json()).toMatchObject({ subject: key, line: { id: 'other/~ui', name: 'UI', source: 'override' } });
      expect((await subjectOf()).line.id).toBe('other/~ui');
      expect((await ctx.post('/api/mc/lines/move', { data: { subject: key, line: 'nope' } })).status()).toBe(400);
      expect((await ctx.post('/api/mc/lines/move', { data: { subject: key } })).status()).toBe(400);
      expect((await ctx.post('/api/mc/lines/move', { data: { subject: 'ado:987654', name: 'UI' } })).status()).toBe(404);
      const back = await ctx.post('/api/mc/lines/move', { data: { subject: key, line: null } });
      expect(back.status()).toBe(200);
      expect((await back.json()).line).toMatchObject({ id: 'other/~docket-fixes', source: 'session' });

      // Closed: the record keeps the reported line, so the item stays on it.
      expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(200);
      closed = true;
      let ref = null;
      for (let i = 0; i < 40 && !(ref && ref.closed); i++) {
        await sleep(300);
        s = await subjectOf();
        ref = s && s.sessions.find((x) => x.id === id);
      }
      expect(ref).toMatchObject({ closed: true });
      expect(s.line).toMatchObject({ id: 'other/~docket-fixes', source: 'session' });
    } finally {
      if (!closed) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });

  test('a closed session keeps who opened it (#504): its record carries spawn.parentId, read before the spawn store forgets', async () => {
    const ctx = await authCtx();
    const made = [];
    try {
      const p = await ctx.post('/api/sessions', { data: { name: `mc-parent-${Date.now()}`, autoCommand: '' } });
      expect(p.status()).toBe(200);
      const parentId = (await p.json()).id;
      made.push(parentId);
      const c = await ctx.post('/api/sessions', { data: { name: `mc-child-${Date.now()}`, autoCommand: '', parentId } });
      expect(c.status()).toBe(200);
      const childId = (await c.json()).id;
      // The child must have a brief entry for the closed strip to record it.
      const h = await pwRequest.newContext({ baseURL: BASE });
      expect((await h.post(`/api/session/${childId}/report`, { data: { items: [{ ref: 'ado:4242', state: 'done' }] },
        headers: { 'X-WT-Hook-Token': readHookToken() } })).status()).toBe(200);
      await h.dispose();
      expect((await ctx.delete(`/api/sessions/${childId}`)).status()).toBe(200);
      let rec = null;
      for (let i = 0; i < 40 && !rec; i++) {
        await sleep(250);
        rec = ((await (await ctx.get('/api/dashboard/closed')).json()).closed || []).find((x) => x.id === childId);
      }
      expect(rec).toBeTruthy();
      expect(rec.spawn).toMatchObject({ parentId, replaces: [] });
      expect(Number.isFinite(rec.spawn.createdAt)).toBe(true);
    } finally {
      for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });

  test('start work (#512): the suggested machine, a session started there and bound at birth, its child, then its own report', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mc-start-'));
    const projects = [
      { id: 'widgets', name: 'Widgets', match: { repos: ['acme/widgets'], paths: [dir] } },
      { id: 'nofolder', name: 'No Folder', match: { repos: ['acme/nofolder'] } },
    ];
    // `echo` stands in for the agent: the suite never launches one.
    await withConfig({ projects, mc: { ado: { org: 'fakeorg' }, startCommand: 'echo' } }, async () => {
      const ctx = await authCtx();
      const made = [];
      try {
        const m = await ctx.get('/api/mc/machines');
        expect(m.status()).toBe(200);
        const mv = await m.json();
        expect(mv.machines[0]).toMatchObject({ url: null, ok: true, why: null });
        expect(Number.isInteger(mv.machines[0].sessions) && Number.isInteger(mv.machines[0].working)).toBe(true);
        expect(mv.suggested).toBe(mv.machines[0].name);
        const here = mv.suggested;

        // Refusals say why, and create nothing.
        for (const [body, words] of [[{ project: 'widgets', hunt: true, server: here, brief: 'use $HOME' }, 'cannot contain $'],[{ project: 'nope', hunt: true, server: here }, 'no project'],
          [{ project: 'nofolder', hunt: true, server: here }, 'has no folder'],
          [{ project: 'widgets', server: here }, 'pick at least one'],
          [{ project: 'widgets', hunt: true, server: 'no-such-box' }, 'no machine named']]) {
          const r = await ctx.post('/api/mc/start', { data: body });
          expect(r.status(), words).toBe(400);
          expect((await r.json()).error, words).toContain(words);
        }

        // The tracker title is in the cache, so the name and brief carry it whatever the timing.
        expect((await ctx.get(`/api/work-items/${encodeURIComponent('acme/widgets#42')}/meta`)).status()).toBe(200);
        const st = await ctx.post('/api/mc/start', { data: { project: 'widgets', subjects: ['#42'], hunt: false, server: here, brief: 'Keep the scroll; small' } });
        expect(st.status()).toBe(200);
        const started = await st.json();
        made.push(started.sessionId);
        expect(started).toMatchObject({ server: here, serverUrl: null, project: 'widgets', subjects: ['acme/widgets#42'], hunt: false });
        expect(started.name.startsWith('Widgets #42')).toBe(true);

        // Created through the ordinary path: in the project folder, its launch command carrying the brief.
        const row = (await (await ctx.get('/api/sessions')).json()).find((x) => x.id === started.sessionId);
        expect(row).toBeTruthy();
        expect(path.resolve(row.cwd).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
        expect(row.autoCommand).toBe('echo "Fix acme/widgets#42 (Widget list loses its scroll position) in project Widgets. Keep the scroll; small"');

        // The subject lists it at once - no report was made - as bound, in its project.
        const s1 = (await (await ctx.get('/api/mc/subjects?project=widgets')).json()).subjects.find((x) => x.key === 'acme/widgets#42');
        expect(s1).toBeTruthy();
        expect(s1.project).toBe('widgets');
        const ref1 = s1.sessions.find((x) => x.id === started.sessionId);
        expect(ref1).toMatchObject({ bound: true, closed: false, lastReport: { state: null } });
        const pv = (await (await ctx.get('/api/mc/projects')).json()).projects.find((p) => p.id === 'widgets');
        expect(pv.counts.sessions).toBeGreaterThanOrEqual(1);

        // A child the lead starts inherits the binding.
        const c = await ctx.post('/api/sessions', { data: { name: `mc-start-child-${Date.now()}`, autoCommand: '', parentId: started.sessionId } });
        expect(c.status()).toBe(200);
        const childId = (await c.json()).id;
        made.push(childId);
        let s2 = null;
        for (let i = 0; i < 20 && !(s2 && s2.sessions.some((x) => x.id === childId)); i++) {
          if (i) await sleep(300);
          s2 = (await (await ctx.get('/api/mc/subjects/acme%2Fwidgets%2342')).json()).subject;
        }
        expect(s2.sessions.find((x) => x.id === childId)).toMatchObject({ bound: true, parentId: started.sessionId });

        // The lead reports its own item: that wins over the binding.
        const h = await pwRequest.newContext({ baseURL: BASE });
        expect((await h.post(`/api/session/${started.sessionId}/report`, { data: { items: [{ ref: 'ado:9001', state: 'in-progress' }] },
          headers: { 'X-WT-Hook-Token': readHookToken() } })).status()).toBe(200);
        await h.dispose();
        let s3 = null;
        for (let i = 0; i < 20 && !(s3 && !s3.sessions.some((x) => x.id === started.sessionId)); i++) {
          await sleep(300);
          s3 = (await (await ctx.get('/api/mc/subjects/acme%2Fwidgets%2342')).json()).subject;
        }
        // (The subjects test above left its own closed session on this item too.)
        expect(s3.sessions.map((x) => x.id)).toContain(childId);
        expect(s3.sessions.map((x) => x.id)).not.toContain(started.sessionId);
        const ado = (await (await ctx.get('/api/mc/subjects/ado%3A9001')).json()).subject;
        expect(ado.sessions.find((x) => x.id === started.sessionId)).toMatchObject({ bound: false, lastReport: { state: 'in-progress' } });
        expect(ado.project).toBe('widgets'); // the project still comes from the binding
      } finally {
        for (const id of made.reverse()) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
        await ctx.dispose();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a closing shell can still hold it */ }
      }
    });
  });

  test('start work on a PEER (#512): forwarded to its POST /api/sessions with the stored token; its refusals mapped; its hold read', async () => {
    const PEER = 'http://127.0.0.1:17689';
    const TOKEN = 'mc512-fake-peer-token';
    const peer = { seen: [], made: [], next: 'ok', hold: null };
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
        if (req.method === 'POST' && req.url === '/api/sessions') {
          peer.seen.push({ auth: req.headers.authorization || null, body: JSON.parse(body || '{}') });
          if (peer.next === 'refuse') return send(400, { error: 'Folder does not exist: X' });
          if (peer.next === 'unauth') return send(401, { error: 'Unauthorized' });
          if (peer.next === 'held') return send(503, { error: 'Restart hold on this machine (update)' });
          const id = `0000512${peer.made.length}-0000-4000-8000-000000000000`;
          const j = JSON.parse(body);
          peer.made.push({ id, name: j.name, cwd: j.cwd, status: 'idle', lastActivity: Date.now() });
          return send(200, { id, name: j.name, agent: null, agentReady: true });
        }
        if (req.url === '/api/sessions') return send(200, peer.made);
        if (req.url === '/api/version') return send(200, { version: '0.0.0', hash: 'fake', capabilities: [] });
        if (req.url === '/api/maintenance/status') return send(200, { hold: peer.hold, safeToRestart: null, sessions: [] });
        if (req.url === '/api/dashboard/closed') return send(200, { closed: [] });
        return send(404, { error: 'Not found' });
      });
    });
    await new Promise((r, j) => { fake.once('error', j); fake.listen(17689, '127.0.0.1', r); });
    const TOK_FILE = process.env.WT_CLUSTER_TOKENS_FILE || path.join(__dirname, '..', 'cluster-tokens.test.json');
    let tokens = {};
    try { tokens = JSON.parse(fs.readFileSync(TOK_FILE, 'utf8')); } catch { /* first to need it */ }
    tokens[PEER] = { token: TOKEN, name: 'fakepeer', authenticated: Date.now() };
    fs.writeFileSync(TOK_FILE, JSON.stringify(tokens, null, 2));
    const dir = 'C:\\peer\\widgets'; // a folder on the PEER: never checked here
    try {
      await withConfig({ projects: [{ id: 'widgets', name: 'Widgets', match: { repos: ['acme/widgets'], paths: [dir] } }],
        mc: { ado: { org: 'fakeorg' }, startCommand: 'echo' }, cluster: [{ name: 'fakepeer', url: PEER }] }, async () => {
        const ctx = await authCtx();
        try {
          const mv = await (await ctx.get('/api/mc/machines')).json();
          expect(mv.machines.find((m) => m.name === 'fakepeer')).toMatchObject({ url: PEER, ok: true, why: null, sessions: 0 });
          peer.hold = { reason: 'update', startedAt: Date.now() };
          const held = (await (await ctx.get('/api/mc/machines')).json()).machines.find((m) => m.name === 'fakepeer');
          expect(held).toMatchObject({ ok: false, why: 'restart hold: update' });
          peer.hold = null;

          const st = await ctx.post('/api/mc/start', { data: { project: 'widgets', subjects: ['#42'], server: 'fakepeer' } });
          expect(st.status(), await st.text()).toBe(200);
          const started = await st.json();
          expect(started).toMatchObject({ server: 'fakepeer', serverUrl: PEER, sessionId: peer.made[0].id });
          expect(peer.seen[0].auth).toBe(`Bearer ${TOKEN}`);
          expect(peer.seen[0].body).toMatchObject({ cwd: dir });
          expect(peer.seen[0].body.autoCommand.startsWith('echo "Fix acme/widgets#42')).toBe(true);

          // Bound on the authority: the peer's session is on its subject before any report.
          let ref = null;
          for (let i = 0; i < 20 && !ref; i++) {
            if (i) await sleep(300);
            const sj = (await (await ctx.get('/api/mc/subjects/acme%2Fwidgets%2342')).json()).subject;
            ref = sj && sj.sessions.find((x) => x.id === started.sessionId);
          }
          expect(ref).toMatchObject({ server: 'fakepeer', serverUrl: PEER, bound: true });

          // A peer's refusal keeps its code; its 401 (our token) is a 502, never the caller's 401.
          for (const [next, code, words] of [['refuse', 400, 'fakepeer: Folder does not exist'], ['unauth', 502, 'fakepeer: Unauthorized'],
            ['held', 503, 'fakepeer: Restart hold']]) {
            peer.next = next;
            const r = await ctx.post('/api/mc/start', { data: { project: 'widgets', subjects: ['#42'], server: 'fakepeer' } });
            expect(r.status(), next).toBe(code);
            expect((await r.json()).error, next).toContain(words);
          }
          // A brief a shell would act on is refused before the peer is asked.
          const before = peer.seen.length;
          const bad = await ctx.post('/api/mc/start', { data: { project: 'widgets', hunt: true, server: 'fakepeer', brief: 'a `b`' } });
          expect(bad.status()).toBe(400);
          expect(peer.seen.length).toBe(before);
        } finally {
          await ctx.dispose();
        }
      });
    } finally {
      await new Promise((r) => fake.close(r));
      try {
        const t = JSON.parse(fs.readFileSync(TOK_FILE, 'utf8'));
        delete t[PEER];
        fs.writeFileSync(TOK_FILE, JSON.stringify(t, null, 2));
      } catch { /* disposable */ }
    }
  });

  test('a server that is not the authority answers 409 naming it; a bad authority is 503; meta still answers', async () => {
    await withConfig({ cluster: [{ name: 'zeta', url: 'http://127.0.0.1:1' }], leases: { authority: 'zeta' } }, async () => {
      const ctx = await authCtx();
      for (const url of ['/api/mc/projects', '/api/mc/subjects', '/api/mc/subjects/ado%3A1', '/api/mc/machines']) {
        const r = await ctx.get(url);
        expect(r.status(), url).toBe(409);
        expect(await r.json(), url).toEqual({ role: 'peer', authority: { name: 'zeta', url: 'http://127.0.0.1:1' } });
      }
      // #506 - and so does every Answer now / My to-do route, reads and writes alike.
      expect((await ctx.get('/api/mc/now')).status()).toBe(409);
      for (const url of ['/api/mc/todo', '/api/mc/todo/t-0123456789abcdef', '/api/mc/later']) {
        expect((await ctx.post(url, { data: { cardId: 'x', hours: 1, action: 'done' } })).status(), url).toBe(409);
      }
      // #512 - a start is refused the same way, before anything is created.
      const st = await ctx.post('/api/mc/start', { data: { project: 'x', hunt: true, server: 'x' } });
      expect(st.status()).toBe(409);
      expect((await st.json()).authority.name).toBe('zeta');
      const m = await ctx.get(`/api/work-items/${encodeURIComponent('acme/widgets#42')}/meta`);
      expect(m.status()).toBe(200);
      await ctx.dispose();
    });
    await withConfig({ leases: { authority: 'nobody-we-know' } }, async () => {
      const ctx = await authCtx();
      const r = await ctx.get('/api/mc/projects');
      expect(r.status()).toBe(503);
      expect((await r.json()).error).toContain('nobody-we-know');
      await ctx.dispose();
    });
  });
});
