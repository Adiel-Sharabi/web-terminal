// @ts-check
// #567 - lib/mc-candidates.js (the work board's candidate sources and their cache) and lib/mc-bughunter.js (the
// bug hunter's queue, read from its run folder). Pure but for temp folders and an injected reader and clock.
// Each gate below was mutated once to see its test fail. The route is pinned in mc-board-routes.spec.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const C = require('../lib/mc-candidates');
const BH = require('../lib/mc-bughunter');

const MIN = 60 * 1000;

test.describe('#567 board config: a typo never blanks the board', () => {
  test('defaults', () => {
    expect(C.boardConfig(null, { platform: 'win32' })).toEqual({ refreshMin: 10, perSource: 10, adoStates: ['Approved', 'Reopen'],
      adoTypes: ['Bug', 'Product Backlog Item', 'Task'], bugHunter: { runDirs: [], roots: ['C:\\temp\\bh-orch'] }, repos: [] });
    expect(C.boardConfig({}, { platform: 'linux' }).bugHunter.roots).toEqual([]); // the default run root is Windows-only
  });

  test('valid values are taken, invalid ones fall back to their default', () => {
    const c = C.boardConfig({ board: { refreshMin: 3, perSource: 5, adoStates: ['Approved', "x'] OR ['", 'Ready for test'], adoTypes: [], repos: ['a/b', 'nope', 7],
      bugHunter: { runDirs: ['D:\\runs\\a', 3, 'bad\nname'], roots: ['E:\\bh'] } } }, { platform: 'win32' });
    expect(c).toMatchObject({ refreshMin: 3, perSource: 5, adoStates: ['Approved', 'Ready for test'], adoTypes: ['Bug', 'Product Backlog Item', 'Task'], repos: ['a/b'],
      bugHunter: { runDirs: ['D:\\runs\\a'], roots: ['E:\\bh'] } });
    for (const bad of [0, 241, 1.5, '10', null]) expect(C.boardConfig({ board: { refreshMin: bad } }).refreshMin, String(bad)).toBe(10);
    for (const bad of [0, 31, 'x']) expect(C.boardConfig({ board: { perSource: bad } }).perSource, String(bad)).toBe(10);
  });
});

test.describe('#567 sources', () => {
  const board = C.boardConfig({}, { platform: 'win32' });
  const projects = [{ id: 'w', name: 'Widgets', match: { repos: ['acme/widgets'], adoProjects: ['Contoso'], paths: [] } },
    { id: 'x', name: 'Other', match: { repos: ['ACME/Widgets', 'acme/gadgets'], adoProjects: ["Bad' OR"], paths: [] } }];

  test('this server\'s own repo leads, then each project\'s repos and ADO projects, then the bug hunter', () => {
    const out = C.sourcesOf({ board, projects, ownRepo: 'me/own' });
    expect(out.map((s) => s.id)).toEqual(['github:me/own', 'github:acme/widgets', 'ado:contoso', 'github:acme/gadgets', expect.stringMatching(/^bug-hunter:[0-9a-f]{8}$/)]);
    expect(out[0]).toMatchObject({ own: true, project: null });
    expect(out[2]).toMatchObject({ kind: 'ado', adoProject: 'Contoso', states: ['Approved', 'Reopen'], project: { id: 'w', name: 'Widgets' } });
    expect(out[4]).toMatchObject({ kind: 'bug-hunter', dispatcher: true, ttlMs: C.BUG_HUNTER_TTL_MS }); // its queue moves every orchestrator tick
  });

  test('the bug hunter is ONE source however many run folders there are: its own read finds them (no disk to list the sources)', () => {
    const out = C.sourcesOf({ board: C.boardConfig({ board: { bugHunter: { runDirs: ['D:\\a', 'D:\\b'], roots: ['E:\\bh'] } } }), projects: [], ownRepo: null });
    expect(out.filter((s) => s.kind === 'bug-hunter')).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/D:|E:/); // and no path is carried by a source
  });

  test('a changed bug-hunter config is a NEW source (the cache never serves the old folders\' queue under it); the same config is the same one', () => {
    const idOf = (bugHunter) => C.sourcesOf({ board: C.boardConfig({ board: { bugHunter } }, { platform: 'linux' }), projects: [], ownRepo: null }).find((s) => s.kind === 'bug-hunter').id;
    expect(idOf({ runDirs: ['D:\\a'] })).toBe(idOf({ runDirs: ['D:\\a'] }));
    expect(idOf({ runDirs: ['D:\\a'] })).not.toBe(idOf({ runDirs: ['D:\\b'] }));
    expect(idOf({ roots: ['D:\\a'] })).not.toBe(idOf({ runDirs: ['D:\\a'] }));
  });

  test('a repo named twice is ONE source, and the project that names it keeps it; the own repo may be a project\'s', () => {
    const out = C.sourcesOf({ board, projects, ownRepo: 'acme/widgets' });
    expect(out.filter((s) => s.id === 'github:acme/widgets')).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'github:acme/widgets', own: true, project: { id: 'w', name: 'Widgets' } });
  });

  test('an ADO project name that could leave a WIQL string is never a source', () => {
    const out = C.sourcesOf({ board, projects, ownRepo: null });
    expect(out.some((s) => s.kind === 'ado' && /Bad/.test(s.name))).toBe(false);
  });

  test('what a client is shown never carries a path or a read limit', () => {
    const s = C.publicSource({ id: 'bug-hunter', kind: 'bug-hunter', name: 'Bug hunter', dir: 'D:\\x', dispatcher: true, ttlMs: 5, states: ['a'] });
    expect(s).toEqual({ id: 'bug-hunter', kind: 'bug-hunter', name: 'Bug hunter', project: null, own: false, dispatcher: true });
    expect(JSON.stringify(s)).not.toContain('ttlMs');
  });
});

test.describe('#567 the cache keeps the tracker queries cheap', () => {
  const src = (id = 's1', over = {}) => ({ id, kind: 'github', name: id, repo: 'a/b', ...over });
  /** A cache over a scripted reader and a hand-moved clock. */
  function rig(opts = {}) {
    let t = 1_000_000;
    const reads = [];
    const answers = [];
    const read = async (source) => {
      reads.push(source.id);
      const a = answers.length ? answers.shift() : { items: [{ key: `k${reads.length}` }], total: 1, more: false };
      if (typeof a === 'function') return a(source);
      if (a instanceof Error) throw a;
      return a;
    };
    const cache = C.createCandidates({ read, now: () => t, log: () => {}, ...opts });
    return { cache, reads, answers, tick: (ms) => { t += ms; } };
  }

  test('a cold read answers its list; a second poll inside the refresh time reads nothing', async () => {
    const r = rig();
    const [a] = await r.cache.snapshot([src()]);
    expect(a).toMatchObject({ state: 'ok', total: 1, items: [{ key: 'k1' }], why: null });
    expect(Number.isFinite(a.fetchedAt)).toBe(true);
    r.tick(C.DEFAULTS.refreshMin * MIN - 1);
    await r.cache.snapshot([src()]);
    expect(r.reads).toEqual(['s1']);
  });

  test('past the refresh time the old list is served NOW and one read runs behind it', async () => {
    const r = rig({ ttlMs: 10 * MIN });
    await r.cache.snapshot([src()]);
    r.tick(10 * MIN);
    let release;
    r.answers.push(() => new Promise((res) => { release = () => res({ items: [{ key: 'fresh' }], total: 1, more: false }); }));
    const polled = await Promise.race([r.cache.snapshot([src()]), new Promise((res) => setTimeout(() => res('waited for the tracker'), 300))]);
    expect(polled, 'the poll must not wait for the tracker').not.toBe('waited for the tracker');
    const [stale] = polled;
    expect(stale.items).toEqual([{ key: 'k1' }]);
    expect(r.reads).toHaveLength(2);
    await r.cache.snapshot([src()]); // a second poll shares the read in flight
    expect(r.reads).toHaveLength(2);
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.cache.snapshot([src()]))[0].items).toEqual([{ key: 'fresh' }]);
  });

  test('the refresh time is the live config\'s (a function is read at each poll)', async () => {
    let min = 10;
    const r = rig({ ttlMs: () => min * MIN });
    await r.cache.snapshot([src()]);
    r.tick(2 * MIN);
    await r.cache.snapshot([src()]);
    expect(r.reads).toHaveLength(1);
    min = 1;
    await r.cache.snapshot([src()]);
    expect(r.reads).toHaveLength(2);
  });

  test('an explicit refresh re-reads at once, but never twice within the floor', async () => {
    const r = rig();
    await r.cache.snapshot([src()]);
    r.tick(C.FORCE_MIN_MS - 1);
    await r.cache.snapshot([src()], { refresh: true });
    expect(r.reads).toHaveLength(1);
    r.tick(1);
    await r.cache.snapshot([src()], { refresh: true });
    expect(r.reads).toHaveLength(2);
  });

  test('an explicit refresh REPLIES with what it read: the new list, not the old one with the read behind it', async () => {
    const r = rig();
    await r.cache.snapshot([src()]); // k1
    r.tick(C.FORCE_MIN_MS);
    r.answers.push({ items: [{ key: 'new1' }, { key: 'new2' }], total: 2, more: false });
    const [a] = await r.cache.snapshot([src()], { refresh: true });
    expect(a).toMatchObject({ state: 'ok', total: 2, items: [{ key: 'new1' }, { key: 'new2' }] });
    // a plain poll past the refresh time is the other way round: it must not wait for the tracker
    r.tick(C.DEFAULTS.refreshMin * MIN);
    r.answers.push(() => new Promise(() => {}));
    const polled = await Promise.race([r.cache.snapshot([src()]), new Promise((res) => setTimeout(() => res('waited'), 300))]);
    expect(polled).not.toBe('waited');
    expect(polled[0].items).toEqual([{ key: 'new1' }, { key: 'new2' }]);
  });

  test('a refresh that fails replies with the old list and why, in the same answer; a slow one is bounded by the cold wait', async () => {
    const r = rig({ coldWaitMs: 30 });
    await r.cache.snapshot([src()]);
    r.tick(C.FORCE_MIN_MS);
    r.answers.push(new C.CandidateError('the tracker answered HTTP 502'));
    expect((await r.cache.snapshot([src()], { refresh: true }))[0]).toMatchObject({ state: 'stale', why: 'the tracker answered HTTP 502', items: [{ key: 'k1' }] });
    r.tick(C.FORCE_MIN_MS);
    r.answers.push(() => new Promise(() => {}));
    const t0 = Date.now();
    const [slow] = await r.cache.snapshot([src()], { refresh: true });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(slow.items).toEqual([{ key: 'k1' }]);
  });

  test('a refresh inside the floor shares the read still running; it starts none of its own', async () => {
    const r = rig();
    await r.cache.snapshot([src()]);
    r.tick(C.DEFAULTS.refreshMin * MIN); // due: a poll starts the read
    let release;
    r.answers.push(() => new Promise((res) => { release = () => res({ items: [{ key: 'shared' }], total: 1, more: false }); }));
    await r.cache.snapshot([src()]);
    expect(r.reads).toHaveLength(2);
    const waiting = r.cache.snapshot([src()], { refresh: true });
    setTimeout(() => release(), 20);
    expect((await waiting)[0].items).toEqual([{ key: 'shared' }]);
    expect(r.reads).toHaveLength(2);
  });

  test('a read that finds nothing to read answers not-wired and why; that is kept for the refresh time, not re-asked at each poll', async () => {
    const r = rig();
    r.answers.push({ notWired: 'no run.json under the run folders' });
    const [a] = await r.cache.snapshot([src('bh')]);
    expect(a).toMatchObject({ state: 'not-wired', why: 'no run.json under the run folders', items: [], claims: [] });
    expect(Number.isFinite(a.fetchedAt)).toBe(true);
    r.tick(C.DEFAULTS.refreshMin * MIN - 1);
    await r.cache.snapshot([src('bh')]);
    expect(r.reads).toEqual(['bh']);
    // when the folder appears, the next read after the refresh time is a list
    r.tick(1);
    r.answers.push({ items: [{ key: 'ado:1' }], total: 1, more: false });
    await r.cache.snapshot([src('bh')]);
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.cache.snapshot([src('bh')]))[0]).toMatchObject({ state: 'ok', items: [{ key: 'ado:1' }] });
  });

  test('`claims` (a dispatcher\'s whole queue) ride along with the list', async () => {
    const r = rig();
    r.answers.push({ items: [{ key: 'ado:1' }], claims: ['ado:1', 'ado:2', 7], total: 2, more: false });
    expect((await r.cache.snapshot([src()]))[0].claims).toEqual(['ado:1', 'ado:2']);
  });

  test('a failed read keeps the last list and says why; the poll does not hammer a failing tracker', async () => {
    const r = rig({ ttlMs: 10 * MIN });
    await r.cache.snapshot([src()]);
    r.tick(10 * MIN);
    r.answers.push(new C.CandidateError('the tracker answered HTTP 502'));
    await r.cache.snapshot([src()]); // starts the refresh that fails
    await new Promise((res) => setTimeout(res, 20));
    const [a] = await r.cache.snapshot([src()]);
    expect(a).toMatchObject({ state: 'stale', why: 'the tracker answered HTTP 502', items: [{ key: 'k1' }] });
    const before = r.reads.length;
    r.tick(C.RETRY_MS - 1);
    await r.cache.snapshot([src()]);
    expect(r.reads).toHaveLength(before);
    r.tick(1);
    await r.cache.snapshot([src()]);
    expect(r.reads).toHaveLength(before + 1);
  });

  test('no list yet and a failed read: an error with words, never an empty "ok"', async () => {
    const r = rig();
    r.answers.push(new C.CandidateError('no Azure DevOps token (ADO_PAT is not set)'));
    const [a] = await r.cache.snapshot([src()]);
    expect(a).toMatchObject({ state: 'error', why: 'no Azure DevOps token (ADO_PAT is not set)', items: [], fetchedAt: null });
  });

  test('an unexpected failure is shown generically (and logged), a tracker\'s own words are shown as they are', async () => {
    const logged = [];
    const r = rig({ log: (m) => logged.push(m) });
    r.answers.push(new Error('ECONNRESET at /secret/path'));
    const [a] = await r.cache.snapshot([src()]);
    expect(a.why).toBe('the source could not be read');
    expect(logged.join(' ')).toContain('ECONNRESET');
    const tm = require('../lib/tracker-meta');
    const r2 = rig();
    r2.answers.push(new tm.TrackerError('GitHub answered HTTP 403'));
    expect((await r2.cache.snapshot([src()]))[0].why).toBe('GitHub answered HTTP 403');
  });

  test('a source that has not answered within the cold wait is "loading", and its answer lands on a later poll', async () => {
    const r = rig({ coldWaitMs: 20 });
    let release;
    r.answers.push(() => new Promise((res) => { release = () => res({ items: [{ key: 'late' }], total: 1, more: false }); }));
    const [a] = await r.cache.snapshot([src()]);
    expect(a).toMatchObject({ state: 'loading', items: [] });
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.cache.snapshot([src()]))[0]).toMatchObject({ state: 'ok', items: [{ key: 'late' }] });
  });

  test('one slow source does not hold the others past the cold wait', async () => {
    const r = rig({ coldWaitMs: 20 });
    r.answers.push(() => new Promise(() => {})); // s1 never answers
    const out = await r.cache.snapshot([src('s1'), src('s2')]);
    expect(out.map((x) => x.state)).toEqual(['loading', 'ok']);
    expect(r.reads).toEqual(['s1', 's2']);
  });

  test('a source\'s own refresh time overrides the default (the bug hunter\'s queue moves every tick)', async () => {
    const r = rig({ ttlMs: 10 * MIN });
    const bh = src('bh', { ttlMs: C.BUG_HUNTER_TTL_MS });
    await r.cache.snapshot([bh]);
    r.tick(C.BUG_HUNTER_TTL_MS);
    await r.cache.snapshot([bh]);
    expect(r.reads).toEqual(['bh', 'bh']);
  });

  test('a source that is no longer listed is forgotten', async () => {
    const r = rig();
    await r.cache.snapshot([src('gone')]);
    await r.cache.snapshot([src('other')]);
    await r.cache.snapshot([src('gone')]);
    expect(r.reads).toEqual(['gone', 'other', 'gone']);
  });
});

test.describe('#567 the bug hunter\'s queue is read, not reimplemented', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-bh-'));
  const run = (dir, o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'run.json'), typeof o === 'string' ? o : JSON.stringify(o)); return dir; };

  test('the queue in the dispatcher\'s order; hands-off by the entry\'s item or any `also` id; workers running', async () => {
    const dir = run(path.join(tmp(), 'r1'), {
      orchestratorSession: 'bug Hunter 4', handsOff: ['102', '300'],
      queue: [{ item: '101', also: [], slot: 'any', attempts: 0, queuedAt: '2026-11-20T10:00:00Z' },
        { item: '102', also: [], slot: 'none' }, { item: '103', also: ['300'], slot: 'sandbox-1' },
        { item: 'abc' }, { item: 104, also: ['x', '105'] }, null],
      workers: [{ item: '9', state: 'running' }, { item: '8', state: 'closed' }, { item: '7', state: 'starting' }] });
    const r = await BH.readRun(dir);
    expect(r).toMatchObject({ ok: true, name: 'bug Hunter 4', running: 2 });
    expect(r.queue.map((q) => [q.id, q.key, q.handsOff])).toEqual([['101', 'ado:101', false], ['102', 'ado:102', true], ['103', 'ado:103', true], ['104', 'ado:104', false]]);
    expect(r.queue[0]).toMatchObject({ slot: 'any', queuedAt: Date.parse('2026-11-20T10:00:00Z'), also: [] });
    expect(r.queue[3].also).toEqual(['105']);
  });

  test('an unreadable or foreign run.json is "not readable" with why, never a guess', async () => {
    const base = tmp();
    expect(await BH.readRun(path.join(base, 'none'))).toMatchObject({ ok: false, why: expect.stringContaining('not readable') });
    expect(await BH.readRun(run(path.join(base, 'bad'), '{ not json'))).toMatchObject({ ok: false, why: 'run.json is not valid JSON' });
    expect(await BH.readRun(run(path.join(base, 'arr'), '[]'))).toMatchObject({ ok: true, queue: [], running: 0 }); // an array has no queue: an empty one
    expect(await BH.readRun(run(path.join(base, 'null'), 'null'))).toMatchObject({ ok: false, why: 'run.json is not a run' });
    expect(await BH.readRun(run(path.join(base, 'bom'), '\uFEFF{"queue":[{"item":"5"}]}'))).toMatchObject({ ok: true, queue: [{ id: '5' }] });
  });

  test('discovery: explicit folders always, run roots by recent run.json only, newest first', async () => {
    const base = tmp();
    const now = Date.now();
    const old = run(path.join(base, 'root', '2026-01-01'), { queue: [] });
    const fresh = run(path.join(base, 'root', '2026-11-20'), { queue: [] });
    run(path.join(base, 'root', 'no-run-json-here', 'x'), {});
    const explicit = run(path.join(base, 'explicit'), { queue: [] });
    const week = BH.ACTIVE_MS;
    fs.utimesSync(path.join(old, 'run.json'), new Date(now - 2 * week), new Date(now - 2 * week));
    fs.utimesSync(path.join(explicit, 'run.json'), new Date(now - 3 * week), new Date(now - 3 * week));
    const found = (await BH.discoverRunDirs({ dirs: [explicit], roots: [path.join(base, 'root')], now })).map((d) => d.dir);
    expect(found).toEqual([fresh, explicit]); // newest first; the old dated folder is a finished run
    expect(await BH.discoverRunDirs({ dirs: [], roots: [path.join(base, 'missing')], now })).toEqual([]);
  });

  test('a run root that is itself a run folder is found', async () => {
    const root = run(path.join(tmp(), 'bh-orch'), { queue: [] });
    expect((await BH.discoverRunDirs({ roots: [root] })).map((d) => d.dir)).toEqual([root]);
  });

  test('under a run root only the NEWEST run is a source: an orchestrator leaves one dated folder per run, and the older ones are history', async () => {
    const base = tmp();
    const now = Date.now();
    const dirs = ['2026-11-18', '2026-11-22', '2026-11-25'].map((n, i) => {
      const d = run(path.join(base, 'root', n), { queue: [{ item: String(100 + i) }] });
      const at = new Date(now - (3 - i) * 24 * 3600e3);
      fs.utimesSync(path.join(d, 'run.json'), at, at);
      return d;
    });
    const found = (await BH.discoverRunDirs({ roots: [path.join(base, 'root')], now })).map((d) => d.dir);
    expect(found).toEqual([dirs[2]]);
  });

  test('every explicit run folder counts, the newest root run joins them, and a folder named twice is listed once', async () => {
    const base = tmp();
    const now = Date.now();
    const a = run(path.join(base, 'a'), { queue: [] });
    const b = run(path.join(base, 'b'), { queue: [] });
    const r1 = run(path.join(base, 'root', 'r1'), { queue: [] });
    const r2 = run(path.join(base, 'root', 'r2'), { queue: [] });
    const set = (d, ageH) => { const at = new Date(now - ageH * 3600e3); fs.utimesSync(path.join(d, 'run.json'), at, at); };
    set(a, 5); set(b, 3); set(r1, 4); set(r2, 1);
    expect((await BH.discoverRunDirs({ dirs: [a, b, a], roots: [path.join(base, 'root')], now })).map((d) => d.dir)).toEqual([r2, b, a]);
    // the newest root run is also an explicit folder: it is still listed once
    expect((await BH.discoverRunDirs({ dirs: [r2], roots: [path.join(base, 'root')], now })).map((d) => d.dir)).toEqual([r2]);
  });

  test('no disk call blocks: discovery and reading use only the promise API (a seam without a sync call)', async () => {
    const calls = [];
    const fsx = {
      stat: async (p) => { calls.push('stat'); return { isFile: () => true, mtimeMs: /run-a/.test(p) ? 2_000 : 1_000, size: 10 }; },
      readdir: async () => { calls.push('readdir'); return [{ name: 'run-a', isDirectory: () => true }, { name: 'file.txt', isDirectory: () => false }]; },
      readFile: async () => { calls.push('readFile'); return '{"queue":[{"item":"7"}]}'; },
    };
    const found = await BH.discoverRunDirs({ roots: ['R:\\bh'], now: 2_000, fsx });
    expect(found.map((d) => /run-a/.test(d.dir))).toEqual([true]); // the newest of the root and its one folder
    expect(await BH.readRun(found[0].dir, fsx)).toMatchObject({ ok: true, queue: [{ id: '7' }] });
    expect(calls).toEqual(expect.arrayContaining(['stat', 'readdir', 'readFile']));
    // a stat that never answers holds only the caller awaiting it (the board's cold wait bounds that): no thread is blocked
    const hung = { stat: () => new Promise(() => {}), readdir: async () => [], readFile: async () => '' };
    const outcome = await Promise.race([BH.discoverRunDirs({ dirs: ['R:\\offline'], fsx: hung }), new Promise((res) => setTimeout(() => res('still waiting'), 60))]);
    expect(outcome).toBe('still waiting');
  });

  test('source gate: the module reads the disk only through the promise API (a sync call here stalls the server on an offline share)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mc-bughunter.js'), 'utf8');
    expect(src).not.toMatch(/\w+Sync\s*\(/);
    expect(src).toMatch(/fs\.promises/);
  });

  test('several runs are ONE list: an item queued in two is listed once as the newest run has it; an unreadable run adds nothing', () => {
    const q = (id, over = {}) => ({ id, key: `ado:${id}`, also: [], slot: null, queuedAt: null, handsOff: false, ...over });
    const newest = { ok: true, dir: 'n', name: 'new', running: 2, queue: [q('1', { handsOff: true, queuedAt: 50 }), q('2')] };
    const older = { ok: true, dir: 'o', name: 'old', running: 1, queue: [q('2', { queuedAt: 7 }), q('1', { queuedAt: 8 }), q('3')] };
    const m = BH.mergeRuns([newest, { ok: false, dir: 'x', why: 'gone' }, older]);
    expect(m.queue.map((x) => x.key)).toEqual(['ado:1', 'ado:2', 'ado:3']); // the newest run's order first
    expect(m.queue[0]).toMatchObject({ handsOff: true, queuedAt: 50 }); // the newest run's entry wins
    expect(m.queue[1].queuedAt).toBeNull();
    expect(m.running).toBe(3);
    expect(m.runs.map((r) => r.name)).toEqual(['new', 'old']);
    expect(BH.mergeRuns([{ ok: false, dir: 'x', why: 'w' }])).toEqual({ queue: [], running: 0, runs: [] });
    expect(BH.mergeRuns(null)).toEqual({ queue: [], running: 0, runs: [] });
  });
});
