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
      '/api/mc/subjects', '/api/mc/subjects/ado%3A1']) {
      const r = await ctx.get(url, { maxRedirects: 0 });
      expect(r.status(), url).toBe(401);
    }
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

  test('a server that is not the authority answers 409 naming it; a bad authority is 503; meta still answers', async () => {
    await withConfig({ cluster: [{ name: 'zeta', url: 'http://127.0.0.1:1' }], leases: { authority: 'zeta' } }, async () => {
      const ctx = await authCtx();
      for (const url of ['/api/mc/projects', '/api/mc/subjects', '/api/mc/subjects/ado%3A1']) {
        const r = await ctx.get(url);
        expect(r.status(), url).toBe(409);
        expect(await r.json(), url).toEqual({ role: 'peer', authority: { name: 'zeta', url: 'http://127.0.0.1:1' } });
      }
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
