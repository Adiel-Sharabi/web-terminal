// @ts-check
// #567 - GET /api/mc/board on the real server: auth, the `mc-board` capability, the shape, the candidate sources read
// from the fake tracker through the SAME client as a work item's details (GitHub issues, an ADO WIQL query, the bug
// hunter's run.json queue), a live session's item in its column, the cache (a second read asks no tracker), the
// 409 a non-authority answers. The rules are pinned in mc-board.spec.js and mc-candidates.spec.js (pure).
//
// No network: playwright.config.js points the suite server's trackers at the fake this spec serves on
// 127.0.0.1:17688 (the same port tests/mc-routes.spec.js uses; the specs run one after another).
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

const ghIssue = (n, over = {}) => ({ number: n, title: `Issue ${n}`, state: 'open', html_url: `https://github.com/acme/gadgets/issues/${n}`,
  user: { login: 'someone' }, created_at: `2026-01-${String(n % 28 + 1).padStart(2, '0')}T00:00:00Z`, labels: [], ...over });
// Refs of THIS spec are its own (acme/gadgets#42, ado:9401): the server's tracker-meta cache outlives a spec, so a ref another
// spec reads (acme/widgets#42, ado:9001) would be served from it there and never reach that spec's fake tracker.
const ado9401 = () => ({ ...fx('ado-workitem.json'), id: 9401 });
const adoWi = (id) => ({ id, fields: { 'System.Title': `Approved bug ${id}`, 'System.WorkItemType': 'Bug', 'System.State': 'Approved', 'System.TeamProject': 'Contoso',
  'System.CreatedDate': '2026-02-03T04:05:06Z', 'Microsoft.VSTS.Common.StateChangeDate': '2026-03-04T05:06:07Z', 'Microsoft.VSTS.Common.Priority': 2 } });

/** The fake tracker: every request is recorded; a route answers by method + URL prefix. */
function fakeTracker() {
  const seen = [];
  const routes = [
    ['GET', '/gh/repos/acme/own/issues?', 200, [ghIssue(1, { labels: [{ name: 'P1' }] })]],
    ['GET', '/gh/repos/acme/gadgets/issues?', 200, [ghIssue(50), ghIssue(51, { pull_request: { url: 'x' } }), ghIssue(42)]],
    ['GET', '/gh/repos/acme/broken/issues?', 500, { message: 'boom' }],
    ['GET', '/gh/repos/acme/gadgets/issues/42/timeline', 200, fx('gh-timeline.json')],
    ['GET', '/gh/repos/acme/gadgets/issues/42', 200, fx('gh-issue.json')],
    ['POST', '/ado/fakeorg/Contoso/_apis/wit/wiql', 200, { workItems: [{ id: 9302 }, { id: 9301 }] }],
    ['GET', '/ado/fakeorg/_apis/wit/workitems?ids=9302,9301&fields=', 200, { value: [adoWi(9301), adoWi(9302)] }],
    ['GET', '/ado/fakeorg/_apis/wit/workitems/9401?', 200, ado9401()],
    ['GET', '/ado/fakeorg/proj-guid/_apis/git/repositories/repo-guid/pullrequests/77?', 200, fx('ado-pr-77.json')],
    ['GET', '/ado/fakeorg/proj-guid/_apis/git/repositories/repo-guid/pullrequests/78?', 200, fx('ado-pr-78.json')],
  ];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
      const hit = routes.find(([m, p]) => m === req.method && req.url.startsWith(p));
      res.writeHead(hit ? hit[2] : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hit ? hit[3] : { message: 'Not Found' }));
    });
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

const source = (b, id) => b.candidates.find((c) => c.source.id === id);

test.describe('#567 GET /api/mc/board', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);
  const tracker = fakeTracker();
  test.beforeAll(async () => { await tracker.start(); });
  test.afterAll(async () => { await tracker.stop(); });

  test('needs auth, refresh is validated, and the capability is advertised', async () => {
    const anon = await noAuthCtx();
    expect((await anon.get('/api/mc/board', { maxRedirects: 0 })).status()).toBe(401);
    await anon.dispose();
    expect(tracker.seen.length).toBe(0);
    const ctx = await authCtx();
    expect((await (await ctx.get('/api/version')).json()).capabilities).toContain('mc-board');
    expect((await ctx.get('/api/mc/board?refresh=yes')).status()).toBe(400);
    await ctx.dispose();
  });

  test('the sources, read from their trackers: own repo, a project\'s repo and ADO project, the bug hunter\'s queue; a broken one says why', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-board-'));
    const runDir = path.join(dir, 'run1');
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ orchestratorSession: 'bug Hunter X', handsOff: [], queue: [{ item: '9401', also: [], slot: 'any', queuedAt: '2026-11-20T10:00:00Z' }], workers: [] }));
    const emptyRoot = path.join(dir, 'empty-root');
    fs.mkdirSync(emptyRoot);
    const projects = [{ id: 'w', name: 'Widgets', match: { repos: ['acme/gadgets', 'acme/broken'], adoProjects: ['Contoso'] } }];
    await withConfig({ mc: { ado: { org: 'fakeorg' }, board: { bugHunter: { runDirs: [runDir], roots: [emptyRoot] } } }, projects }, async () => {
      const ctx = await authCtx();
      const stamp = Date.now();
      const made = await ctx.post('/api/sessions', { data: { name: `mc-board-${stamp}`, autoCommand: '' } });
      expect(made.status()).toBe(200);
      const sid = (await made.json()).id;
      try {
        // A live session on a GitHub item whose pull request is open (the fake tracker: acme/gadgets#42), and one on an ADO item.
        const hook = { 'X-WT-Hook-Token': readHookToken() };
        const c = await pwRequest.newContext({ baseURL: BASE });
        expect((await c.post(`/api/session/${sid}/report`, { headers: hook, data: { items: [
          { ref: 'acme/gadgets#42', state: 'in-progress' }, { ref: 'ado:9201', state: 'in-progress', stage: 'fixing' }] } })).status()).toBe(200);
        await c.dispose();

        let b = null;
        for (let i = 0; i < 40; i++) {
          if (i) await sleep(500);
          b = await (await ctx.get('/api/mc/board')).json();
          const inProg = b.columns.find((x) => x.id === 'in-progress').cards.some((x) => x.key === 'ado:9201');
          const prs = b.columns.find((x) => x.id === 'pr-review').cards.some((x) => x.key === 'acme/gadgets#42');
          if (inProg && prs && b.candidates.every((x) => x.state !== 'loading')) break;
        }
        expect(b.columns.map((x) => x.id)).toEqual(['in-progress', 'pr-review', 'committed-merged', 'ready-for-test']);
        expect(b.complete).toBe(true);
        expect(Number.isFinite(b.generatedAt)).toBe(true);

        // Current work: the ADO item in In progress with its live session; the GitHub item with an open PR in PR / in review.
        const inProg = b.columns.find((x) => x.id === 'in-progress').cards.find((x) => x.key === 'ado:9201');
        expect(inProg).toMatchObject({ live: true, stage: 'fixing', badge: { kind: 'none' }, source: { kind: 'ado' }, sessions: [{ id: sid }] });
        const pr = b.columns.find((x) => x.id === 'pr-review').cards.find((x) => x.key === 'acme/gadgets#42');
        expect(pr).toMatchObject({ live: true, stage: 'pr-open', source: { kind: 'github', name: 'acme/gadgets' } });

        // Candidates: each source, by its kind. The item with a card (#42) is not also offered.
        expect(source(b, 'github:acme/own')).toMatchObject({ state: 'ok', source: { own: true, kind: 'github' } });
        expect(source(b, 'github:acme/own').cards.map((x) => x.key)).toEqual(['acme/own#1']);
        expect(source(b, 'github:acme/own').cards[0]).toMatchObject({ priority: 1, title: 'Issue 1', project: null });
        const w = source(b, 'github:acme/gadgets');
        expect(w).toMatchObject({ state: 'ok', source: { project: { id: 'w', name: 'Widgets' } }, hidden: 1 });
        expect(w.cards.map((x) => x.key)).toEqual(['acme/gadgets#50']); // the PR is no issue; #42 has a card
        expect(w.cards[0].project).toBe('Widgets');
        expect(source(b, 'github:acme/broken')).toMatchObject({ state: 'error', cards: [], why: 'GitHub answered HTTP 500' });
        const ado = source(b, 'ado:contoso');
        expect(ado).toMatchObject({ state: 'ok', source: { kind: 'ado', name: 'Contoso' }, total: 2 });
        expect(ado.cards.map((x) => [x.key, x.title, x.station])).toEqual([['ado:9302', 'Approved bug 9302', 'Approved'], ['ado:9301', 'Approved bug 9301', 'Approved']]);
        const bh = b.candidates.find((x) => x.source.kind === 'bug-hunter');
        expect(bh).toMatchObject({ state: 'ok', source: { id: expect.stringMatching(/^bug-hunter:[0-9a-f]{8}$/), dispatcher: true }, why: 'bug Hunter X: 1 queued, 0 running' });
        expect(bh.cards).toHaveLength(1);
        expect(bh.cards[0]).toMatchObject({ key: 'ado:9401', title: 'Decoder drops the first frame', handsOff: false, since: Date.parse('2026-11-20T10:00:00Z') });
        // Nothing a client is shown names a path.
        expect(JSON.stringify(b)).not.toContain(dir.replace(/\\/g, '\\\\'));

        // Cached: another read, and an explicit refresh right after, ask no tracker for a list again.
        const lists = () => tracker.seen.filter((s) => /\/issues\?|\/wiql/.test(s.url)).length;
        const before = lists();
        await ctx.get('/api/mc/board');
        expect((await ctx.get('/api/mc/board?refresh=1')).status()).toBe(200);
        expect(lists()).toBe(before);
        // ... and the list queries went out with the suite's own tokens, the WIQL as a POST.
        const wiql = tracker.seen.find((s) => /\/wiql/.test(s.url));
        expect(wiql.method).toBe('POST');
        expect(wiql.auth).toBe(`Basic ${Buffer.from(':suite-ado-pat').toString('base64')}`);
        expect(tracker.seen.find((s) => /acme\/own\/issues\?/.test(s.url)).auth).toBe('Bearer suite-github-token');
        // Read-only: nothing was ever written to a tracker.
        expect(tracker.seen.filter((s) => s.method !== 'GET' && !/\/wiql/.test(s.url))).toEqual([]);
      } finally {
        await ctx.delete(`/api/sessions/${sid}`).catch(() => {});
        await ctx.dispose();
      }
    });
  });

  test('no run folder: the bug hunter says "not wired yet", with why', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-board-none-'));
    await withConfig({ mc: { board: { bugHunter: { roots: [empty] } } } }, async () => {
      const ctx = await authCtx();
      const b = await (await ctx.get('/api/mc/board')).json();
      const bh = b.candidates.find((x) => x.source.kind === 'bug-hunter');
      expect(bh).toMatchObject({ state: 'not-wired', cards: [], source: { dispatcher: true } });
      expect(bh.why).toContain('its queue is not readable from this server');
      expect(JSON.stringify(bh)).not.toContain(empty.replace(/\\/g, '\\\\'));
      await ctx.dispose();
    });
  });

  test('wiring (source gate): the board reads the ONE efforts compute, behind mcRefusal, and writes nothing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/api/mc/board'"), src.indexOf("// --- API: #523 Mission Control: lines of work ---"));
    expect(route).toContain('mcRefusal(supervisorAuthority())');
    expect(route).toContain('mcEffortsFor(v, reqUser)');
    expect(route).not.toContain('buildEfforts(');
    expect(route).not.toContain('supervisorStateNow');
    expect(src.match(/mcEfforts\.buildEfforts\(/g)).toHaveLength(1);
    expect(route).not.toMatch(/app\.(post|put|patch|delete)\(/);
    // The route never touches the disk: the bug hunter's run folders are found inside the source's own (async, cached) read.
    expect(route).not.toMatch(/discoverRunDirs|readRun|\w+Sync\s*\(/);
    expect(src.slice(src.indexOf('async function mcBoardRead('), src.indexOf('const mcBoardCandidates')))
      .toMatch(/await mcBugHunter\.discoverRunDirs\(/);
    // ONE tracker client: the list reader is built from the very object the item reader is.
    expect(src).toContain('trackerMeta.createReader(mcTrackerIo)');
    expect(src).toContain('trackerMeta.createListReader(mcTrackerIo)');
    expect(src.match(/httpFetchJson\(/g)).toHaveLength(1);
  });

  test('a server that is not the authority answers 409 naming it', async () => {
    await withConfig({ cluster: [{ name: 'zeta', url: 'http://127.0.0.1:1' }], leases: { authority: 'zeta' } }, async () => {
      const ctx = await authCtx();
      const r = await ctx.get('/api/mc/board');
      expect(r.status()).toBe(409);
      expect(await r.json()).toEqual({ role: 'peer', authority: { name: 'zeta', url: 'http://127.0.0.1:1' } });
      await ctx.dispose();
    });
  });
});
