// @ts-check
// #502 - lib/tracker-meta.js: a work item's details from GitHub and Azure DevOps, cached.
// Pure: synthetic fixtures (tests/fixtures/mc-tracker/), an injected fetcher and a fake clock.
// Nothing here touches the network. The routes are pinned in mc-routes.spec.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const tm = require('../lib/tracker-meta');

const FIX = path.join(__dirname, 'fixtures', 'mc-tracker');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const tmpFile = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mc-meta-')), n);
const hdrs = (o = {}) => ({ get: (k) => (o[k.toLowerCase()] === undefined ? null : o[k.toLowerCase()]) });

/** A fetcher answering from a route table: url substring -> {status, json} (or a function). */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, headers) => {
    calls.push({ url, headers });
    for (const [k, v] of Object.entries(table)) {
      if (url.includes(k)) {
        const r = typeof v === 'function' ? v(url, headers) : v;
        return { status: r.status, json: r.json === undefined ? null : r.json, headers: hdrs(r.headers) };
      }
    }
    return { status: 404, json: null, headers: hdrs() };
  };
  fn.calls = calls;
  return fn;
}
const ghTable = () => ({
  '/repos/acme/widgets/issues/42/timeline': { status: 200, json: fx('gh-timeline.json') },
  '/repos/acme/widgets/issues/42': { status: 200, json: fx('gh-issue.json') },
});
const adoTable = () => ({
  '/_apis/wit/workitems/9001': { status: 200, json: fx('ado-workitem.json') },
  '/pullrequests/77': { status: 200, json: fx('ado-pr-77.json') },
  '/pullrequests/78': { status: 200, json: fx('ado-pr-78.json') },
});

test.describe('#502 refs', () => {
  test('a ref parses to its global key; a bare #N is qualified only by an explicit repo', () => {
    expect(tm.parseRef('ado:9001')).toMatchObject({ key: 'ado:9001', tracker: 'ado', id: 9001 });
    expect(tm.parseRef('AB#9001')).toMatchObject({ key: 'ado:9001', tracker: 'ado' });
    expect(tm.parseRef('Acme/Widgets#42')).toMatchObject({ key: 'acme/widgets#42', tracker: 'github', owner: 'acme', repo: 'widgets', number: 42 });
    expect(tm.parseRef('#42', { repo: 'Acme/Widgets' })).toMatchObject({ key: 'acme/widgets#42', tracker: 'github' });
    expect(tm.parseRef('#42')).toMatchObject({ key: '#42', unqualified: true });
    for (const bad of ['', 'hello', '42abc', 'a/b/c#1']) expect(tm.parseRef(bad), bad).toBeNull();
    expect(tm.parseRef('#42', { repo: 'not a repo' })).toBeNull();
    // A dot segment would walk the tracker API path (/repos/../x): never a ref.
    for (const dots of ['../widgets#1', 'acme/..#1', './x#1']) expect(tm.parseRef(dots), dots).toBeNull();
    expect(tm.parseRef('#1', { repo: '../x' })).toBeNull();
  });
});

test.describe('#502 parsing - GitHub', () => {
  test('an issue and its timeline give every field; labels carry severity and priority', async () => {
    const fetchJson = fakeFetch(ghTable());
    const m = await tm.readGithub(tm.parseRef('acme/widgets#42'), { fetchJson, apiBase: 'https://gh.test', token: null });
    expect(m).toMatchObject({
      url: 'https://github.com/acme/widgets/issues/42', title: 'Widget list loses its scroll position', type: 'Issue',
      state: 'open', closed: false, severity: 2, severityText: 'severity:2', priority: 1,
      createdBy: 'reporter-a', createdAt: Date.parse('2026-01-02T03:04:05Z'), assignee: 'dev-b',
      area: null, labels: ['bug', 'severity:2', 'P1', 'area/ui'], repo: 'acme/widgets', warning: null,
    });
    // Only PULL REQUESTS from the timeline, each with its own state; an issue reference is not one.
    expect(m.prs).toEqual([
      { url: 'https://github.com/acme/widgets/pull/43', number: 43, repo: 'acme/widgets', state: 'merged', draft: false },
      { url: 'https://github.com/acme/widgets/pull/44', number: 44, repo: 'acme/widgets', state: 'open', draft: true },
    ]);
    expect(fetchJson.calls.every((c) => !c.headers.Authorization)).toBe(true);
  });

  test('a closed issue is closed; a PR ref is a Pull request; a GitHub issue type wins', () => {
    const base = fx('gh-issue.json');
    expect(tm.parseGithubIssue({ ...base, state: 'closed' }, [])).toMatchObject({ state: 'closed', closed: true });
    expect(tm.parseGithubIssue({ ...base, pull_request: { merged_at: '2026-01-01T00:00:00Z' }, state: 'closed' }, []))
      .toMatchObject({ type: 'Pull request', state: 'merged', closed: true });
    expect(tm.parseGithubIssue({ ...base, type: { name: 'Bug' } }, [])).toMatchObject({ type: 'Bug' });
    expect(tm.parseGithubIssue({ ...base, labels: [] }, [])).toMatchObject({ severity: null, priority: null, labels: [] });
    // A link the tracker gave is kept only when it is https: a client opens it.
    expect(tm.parseGithubIssue({ ...base, html_url: 'javascript:alert(1)' }, []).url).toBeNull();
  });

  test('severity and priority label forms', () => {
    expect(tm.ghSeverity(['sev1'])).toEqual({ severity: 1, severityText: 'sev1' });
    expect(tm.ghSeverity(['severity/high'])).toEqual({ severity: 2, severityText: 'severity/high' });
    expect(tm.ghSeverity(['severe-weather'])).toEqual({ severity: null, severityText: null });
    expect(tm.ghPriority(['priority:2'])).toBe(2);
    expect(tm.ghPriority(['priority/P0'])).toBe(0);
    expect(tm.ghPriority(['P12'])).toBeNull();
  });

  test('a rejected token is retried anonymously, and the answer says so', async () => {
    const t = ghTable();
    const fetchJson = fakeFetch({
      '/repos/acme/widgets/issues/42/timeline': t['/repos/acme/widgets/issues/42/timeline'],
      '/repos/acme/widgets/issues/42': (url, h) => (h.Authorization ? { status: 401 } : t['/repos/acme/widgets/issues/42']),
    });
    const m = await tm.readGithub(tm.parseRef('acme/widgets#42'), { fetchJson, apiBase: 'https://gh.test', token: 'bad' });
    expect(m.title).toBe('Widget list loses its scroll position');
    expect(m.warning).toContain('rejected');
    expect(fetchJson.calls[0].headers.Authorization).toBe('Bearer bad');
    expect(fetchJson.calls.slice(1).every((c) => !c.headers.Authorization)).toBe(true);
  });

  test('a rejected token on a repo anonymous cannot read says the TOKEN is the cause', async () => {
    const fetchJson = fakeFetch({ '/repos/acme/private/issues/1': (url, h) => (h.Authorization ? { status: 401 } : { status: 404 }) });
    await expect(tm.readGithub(tm.parseRef('acme/private#1'), { fetchJson, apiBase: 'https://gh.test', token: 'expired' }))
      .rejects.toThrow(/^GitHub rejected the token \(HTTP 401\); without it: not found in GitHub/);
  });

  test('a GitHub redirect is a moved issue, never a token problem; an ADO redirect is', async () => {
    const moved = async () => ({ status: 301, json: null, headers: hdrs() });
    await expect(tm.readGithub(tm.parseRef('acme/widgets#42'), { fetchJson: moved, apiBase: 'x', token: 't' })).rejects.toThrow(/^moved in GitHub \(HTTP 301\)/);
    await expect(tm.readAdo(tm.parseRef('ado:1'), { fetchJson: moved, adoBase: 'x', org: 'o', pat: 'p' })).rejects.toThrow(/rejected the token \(HTTP 301\)/);
  });

  test('the timeline is read page by page; a PR past the first page is found; a capped read says so', async () => {
    const filler = (n) => Array.from({ length: n }, () => ({ event: 'commented' }));
    const late = fx('gh-timeline.json').filter((e) => e.event === 'cross-referenced').slice(0, 1);
    const pages = { 1: filler(100), 2: [...filler(40), ...late] };
    const fetchJson = fakeFetch({
      '/timeline': (url) => ({ status: 200, json: pages[Number(/[?&]page=(\d+)/.exec(url)[1])] || [] }),
      '/repos/acme/widgets/issues/42': { status: 200, json: fx('gh-issue.json') },
    });
    const m = await tm.readGithub(tm.parseRef('acme/widgets#42'), { fetchJson, apiBase: 'https://gh.test', token: null });
    expect(m.prs.map((p) => p.number)).toEqual([43]);
    expect(m.warning).toBeNull();
    expect(fetchJson.calls.filter((c) => c.url.includes('/timeline')).length).toBe(2);
    // Every page full: stop at the cap and say what was not read.
    const full = fakeFetch({
      '/timeline': () => ({ status: 200, json: filler(100) }),
      '/repos/acme/widgets/issues/42': { status: 200, json: fx('gh-issue.json') },
    });
    const c = await tm.readGithub(tm.parseRef('acme/widgets#42'), { fetchJson: full, apiBase: 'https://gh.test', token: null });
    expect(full.calls.filter((x) => x.url.includes('/timeline')).length).toBe(tm.TIMELINE_PAGES);
    expect(c.warning).toContain(`first ${tm.TIMELINE_PAGES * 100} timeline events`);
  });

  test('more than 10 linked PRs keeps the NEWEST 10 (the timeline is oldest first)', () => {
    const ev = (n) => ({ event: 'cross-referenced', source: { issue: { number: n, state: 'open', pull_request: {}, repository: { full_name: 'a/b' } } } });
    expect(tm.githubPrsFromTimeline(Array.from({ length: 12 }, (_, i) => ev(i + 1))).map((p) => p.number)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('a rate limit, a 404 and an unreachable host each throw their own message', async () => {
    const r = tm.parseRef('acme/widgets#42');
    const run = (res) => tm.readGithub(r, { fetchJson: async () => res, apiBase: 'https://gh.test', token: null });
    await expect(run({ status: 403, json: null, headers: hdrs({ 'x-ratelimit-remaining': '0' }) })).rejects.toThrow(/rate limit/);
    await expect(run({ status: 404, json: null, headers: hdrs() })).rejects.toThrow(/not found in GitHub/);
    await expect(run({ status: 0, json: null, headers: null, reason: 'ECONNREFUSED' })).rejects.toThrow(/unreachable: ECONNREFUSED/);
  });
});

test.describe('#502 parsing - Azure DevOps', () => {
  test('a work item and its linked PRs give every field', async () => {
    const fetchJson = fakeFetch(adoTable());
    const m = await tm.readAdo(tm.parseRef('ado:9001'), { fetchJson, adoBase: 'https://ado.test', org: 'fakeorg', pat: 'p' });
    expect(m).toMatchObject({
      url: 'https://dev.azure.com/fakeorg/Contoso/_workitems/edit/9001', title: 'Decoder drops the first frame', type: 'Bug',
      state: 'Resolved', closed: true, severity: 2, severityText: '2 - High', priority: 1,
      createdBy: 'Reporter A', createdAt: Date.parse('2026-02-03T04:05:06.07Z'), assignee: 'Dev B',
      area: 'Contoso\\Video\\Decoder', labels: ['regression', 'video'], adoProject: 'Contoso', warning: null,
    });
    expect(m.prs).toEqual([
      { url: 'https://dev.azure.com/fakeorg/Contoso/_git/decoder/pullrequest/77', number: 77, repo: 'decoder', state: 'merged', draft: false },
      { url: 'https://dev.azure.com/fakeorg/Contoso/_git/decoder/pullrequest/78', number: 78, repo: 'decoder', state: 'open', draft: true },
    ]);
    // ONE work-item call with relations, then one call per PR - a commit link is not a PR.
    expect(fetchJson.calls.map((c) => c.url.replace('https://ado.test', ''))).toEqual([
      '/fakeorg/_apis/wit/workitems/9001?$expand=relations&api-version=7.1',
      '/fakeorg/proj-guid/_apis/git/repositories/repo-guid/pullrequests/77?api-version=7.1',
      '/fakeorg/proj-guid/_apis/git/repositories/repo-guid/pullrequests/78?api-version=7.1',
    ]);
    expect(fetchJson.calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(':p').toString('base64')}`);
  });

  test('#523 the parent: the ADO hierarchy link; the GitHub sub-issue parent, else a leading "Part of #N"', () => {
    const wi = fx('ado-workitem.json');
    expect(tm.parseAdoWorkItem(wi).parent).toEqual({ key: 'ado:9000', ref: 'ado:9000' });
    expect(tm.parseAdoWorkItem({ ...wi, relations: wi.relations.filter((r) => r.rel !== 'System.LinkTypes.Hierarchy-Reverse') }).parent).toBeNull();
    // A link to another organisation's host or a non-number id names nothing.
    expect(tm.parseAdoWorkItem({ ...wi, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://x.test/_apis/wit/workItems/abc' }] }).parent).toBeNull();
    const gh = { ...fx('gh-issue.json'), repository_url: 'https://api.github.com/repos/Acme/Widgets' };
    expect(tm.parseGithubIssue({ ...gh, body: 'no parent here' }, []).parent).toBeNull();
    expect(tm.parseGithubIssue({ ...gh, parent_issue_url: 'https://api.github.com/repos/acme/other/issues/7', body: 'Part of #9.' }, []).parent)
      .toEqual({ key: 'acme/other#7', ref: 'acme/other#7' });
    expect(tm.parseGithubIssue({ ...gh, body: `${String.fromCodePoint(13, 10)}Part of #501. Builds on #492.` }, []).parent).toEqual({ key: 'acme/widgets#501', ref: 'acme/widgets#501' });
    expect(tm.parseGithubIssue({ ...gh, body: 'Part of other-org/tools#12' }, []).parent).toEqual({ key: 'other-org/tools#12', ref: 'other-org/tools#12' });
    // Only the FIRST line counts: a mention further down is prose, not a parent.
    expect(tm.parseGithubIssue({ ...gh, body: `Summary.${String.fromCodePoint(10)}Part of #501` }, []).parent).toBeNull();
    expect(tm.blankMeta(tm.parseRef('ado:1')).parent).toBeNull();
  });

  test('closed is Closed/Done/Removed/Resolved only; a PR that cannot be read is kept, unknown', async () => {
    const wi = fx('ado-workitem.json');
    for (const [state, closed] of [['Done', true], ['Removed', true], ['closed', true], ['Active', false], ['Ready for test', false]]) {
      expect(tm.parseAdoWorkItem({ ...wi, fields: { ...wi.fields, 'System.State': state } }).closed, state).toBe(closed);
    }
    const t = adoTable();
    delete t['/pullrequests/78'];
    const m = await tm.readAdo(tm.parseRef('ado:9001'), { fetchJson: fakeFetch(t), adoBase: 'https://ado.test', org: 'fakeorg', pat: 'p' });
    expect(m.prs[1]).toEqual({ url: null, number: 78, repo: null, state: null, draft: false });
    expect(m.warning).toContain('1 linked pull request');
  });

  test('no org, no token, a sign-in redirect: each refused with its reason', async () => {
    const r = tm.parseRef('ado:9001');
    const f = fakeFetch(adoTable());
    await expect(tm.readAdo(r, { fetchJson: f, adoBase: 'x', org: null, pat: 'p' })).rejects.toThrow(/organization/);
    await expect(tm.readAdo(r, { fetchJson: f, adoBase: 'x', org: 'o', pat: null })).rejects.toThrow(/ADO_PAT/);
    await expect(tm.readAdo(r, { fetchJson: async () => ({ status: 203, json: null, headers: hdrs() }), adoBase: 'x', org: 'o', pat: 'p' }))
      .rejects.toThrow(/rejected the token/);
    expect(f.calls.length).toBe(0);
  });
});

test.describe('#502 cache', () => {
  /** A cache over a scripted reader, a fake clock and a temp file. */
  function rig({ file = tmpFile('cache.json') } = {}) {
    let clock = 1_000_000;
    const answers = [];
    const reads = [];
    const read = async (r) => {
      reads.push(r.key);
      const a = answers.length > 1 ? answers.shift() : answers[0];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a() : a;
    };
    const store = tm.createMetaStore({ file, log: () => {} });
    const meta = tm.createTrackerMeta({ store, read, now: () => clock, log: () => {} });
    return { meta, store, file, reads, answers, tick: (ms) => { clock += ms; }, now: () => clock };
  }
  const R = () => tm.parseRef('acme/widgets#42');
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('fresh for 10 minutes; then served stale at once while ONE refresh runs', async () => {
    const c = rig();
    c.answers.push({ title: 'v1' });
    const a = await c.meta.get(R());
    expect(a).toMatchObject({ key: 'acme/widgets#42', title: 'v1', fetchedAt: c.now(), staleSince: null, error: null });
    c.tick(tm.FRESH_MS - 1);
    expect((await c.meta.get(R())).title).toBe('v1');
    expect(c.reads.length).toBe(1);
    c.tick(1);
    c.answers.splice(0, 1, { title: 'v2' });
    const fetchedAt = a.fetchedAt;
    const [s1, s2] = await Promise.all([c.meta.get(R()), c.meta.get(R())]);
    expect(s1).toMatchObject({ title: 'v1', staleSince: fetchedAt + tm.FRESH_MS, error: null });
    expect(s2.title).toBe('v1');
    await flush();
    expect(c.reads.length).toBe(2); // the two stale reads shared one refresh
    expect(await c.meta.get(R())).toMatchObject({ title: 'v2', staleSince: null, fetchedAt: c.now() });
  });

  test('a failed refresh serves the last copy with error + staleSince, and waits before asking again', async () => {
    const c = rig();
    c.answers.push({ title: 'v1' });
    await c.meta.get(R());
    c.tick(tm.FRESH_MS + 5);
    c.answers.splice(0, 1, new tm.TrackerError('GitHub answered HTTP 502'));
    await c.meta.get(R());
    await flush();
    const e = await c.meta.get(R());
    expect(e).toMatchObject({ title: 'v1', error: 'GitHub answered HTTP 502' });
    expect(e.staleSince).toBe(e.fetchedAt + tm.FRESH_MS);
    expect(c.reads.length).toBe(2);
    c.tick(tm.RETRY_MS - 1);
    await c.meta.get(R());
    await flush();
    expect(c.reads.length).toBe(2); // backing off
    c.tick(1);
    c.answers.splice(0, 1, { title: 'v3' });
    await c.meta.get(R());
    await flush();
    expect(await c.meta.get(R())).toMatchObject({ title: 'v3', error: null, staleSince: null });
  });

  test('no copy at all: title null and the error set - never a throw, never a blank', async () => {
    const c = rig();
    c.answers.push(new tm.TrackerError('not found in GitHub (HTTP 404)'));
    const m = await c.meta.get(R());
    expect(m).toMatchObject({ key: 'acme/widgets#42', tracker: 'github', url: 'https://github.com/acme/widgets/issues/42',
      title: null, error: 'not found in GitHub (HTTP 404)', fetchedAt: null, staleSince: null, labels: [], prs: [] });
    // Every contract field is present, even when nothing is known.
    for (const k of ['type', 'state', 'closed', 'severity', 'priority', 'createdBy', 'createdAt', 'assignee', 'area']) expect(m).toHaveProperty(k, null);
    // A non-tracker failure is not shown verbatim (it could carry internals).
    const d = rig();
    d.answers.push(new Error('socket hang up at 10.1.2.3'));
    expect((await d.meta.get(R())).error).toBe('the tracker could not be read');
  });

  test('a bare #N is answered with an error and never read', async () => {
    const c = rig();
    c.answers.push({ title: 'x' });
    const m = await c.meta.get(tm.parseRef('#42'));
    expect(m.error).toContain('names no repo');
    expect(c.reads.length).toBe(0);
  });

  test('persisted: a restart serves the cached copy without asking the tracker', async () => {
    const c = rig();
    c.answers.push({ title: 'v1', labels: ['bug'] });
    await c.meta.get(R());
    c.store.flush();
    const d = rig({ file: c.file });
    d.answers.push({ title: 'never read' });
    // The new rig's clock starts where the first one did, so the copy is still fresh.
    expect(await d.meta.get(R())).toMatchObject({ title: 'v1', labels: ['bug'] });
    expect(d.reads.length).toBe(0);
  });

  test('a corrupt cache file is moved aside, not overwritten blind', async () => {
    const file = tmpFile('cache.json');
    fs.writeFileSync(file, '{not json');
    const c = rig({ file });
    c.answers.push({ title: 'v1' });
    await c.meta.get(R());
    const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('cache.json.corrupt-'));
    expect(aside.length).toBe(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8')).toBe('{not json');
  });

  test('every read shares ONE limit: 20 stale refs never put more than 6 reads in flight', async () => {
    let clock = 0, live = 0, peak = 0, held = [];
    const read = () => new Promise((res) => { live += 1; peak = Math.max(peak, live); held.push(() => { live -= 1; res({ title: 't' }); }); });
    const store = tm.createMetaStore({ file: tmpFile('cache.json'), log: () => {} });
    const meta = tm.createTrackerMeta({ store, read, now: () => clock, log: () => {} });
    const refs = Array.from({ length: 20 }, (_, i) => tm.parseRef(`acme/widgets#${i + 1}`));
    for (const r of refs) store.set(r.key, { meta: { title: 'old' }, fetchedAt: 0, error: null, errorAt: null, readAt: 0 });
    clock = tm.FRESH_MS + 1;
    const out = await meta.getMany(refs); // stale: answered at once, 20 refreshes queued behind
    expect(out.every((m) => m.title === 'old')).toBe(true);
    // Release whatever is in flight, round by round, until nothing more starts.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 0));
      expect(peak).toBeLessThanOrEqual(tm.READ_CONCURRENCY);
      const now = held; held = []; now.forEach((f) => f());
      if (!now.length) break;
    }
    expect(live).toBe(0);
    expect(peak).toBe(tm.READ_CONCURRENCY);
    expect((await meta.get(refs[19])).title).toBe('t');
  });

  test('no copy and a failed read: the tracker is not asked again inside the back-off', async () => {
    const c = rig();
    c.answers.push(new tm.TrackerError('GitHub answered HTTP 502'));
    await c.meta.get(R());
    c.tick(tm.RETRY_MS - 1);
    expect((await c.meta.get(R())).error).toBe('GitHub answered HTTP 502');
    expect(c.reads.length).toBe(1);
    c.tick(1);
    await c.meta.get(R());
    expect(c.reads.length).toBe(2);
  });

  test('a batch reads each ref once and keeps the order', async () => {
    const c = rig();
    c.answers.push(() => ({ title: 't' }));
    const refs = ['acme/widgets#1', 'acme/widgets#2', 'ado:5'].map((x) => tm.parseRef(x));
    const out = await c.meta.getMany(refs);
    expect(out.map((m) => m.key)).toEqual(['acme/widgets#1', 'acme/widgets#2', 'ado:5']);
    expect(c.reads.sort()).toEqual(['acme/widgets#1', 'acme/widgets#2', 'ado:5']);
  });
});
