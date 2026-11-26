// #529 - the fleet usage service with its collaborators stubbed: what a pass writes and what it
// leaves alone (a rescanned session with the same summary, an inventory or settings that did not
// change, a work item already recorded), the guard when there is no Claude home, the wait for
// recovery before a machine writes its own history, and the timers. No server, no files of Claude's.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsageStore } = require('../lib/usage-store');
const { createUsageService } = require('../lib/usage-service');
const { createAgentSessionMap } = require('../lib/usage-agent-sessions');
const sync = require('../lib/usage-sync');

const dirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
test.afterAll(() => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS */ } });

const DAY = 24 * 3600e3;
const summary = (units) => ({ start: '2026-03-10T08:00:00.000Z', end: '2026-03-10T09:00:00.000Z', cwd: null, branch: null, tok: { in: 1, out: 1, cr: 0, cw: 0, cw1h: 0 }, units, models: {}, sub: { n: 0, units: 0, byType: {} }, prompts: { human: 1, auto: 0 }, wakes: { n: 0, units: 0, auto: 0 }, time: { activeMs: 1, idleMs: 0, waitYouMs: 0, waits: 0, waitsMin: [] }, compactions: 0, quality: {}, peakCtx: 1, byDay: { '2026-03-10': units }, facts: { firstClass: 'interactive', startsBugHunter: false } });

/** A service over a temp store; `script` says what the worker answers; calls are recorded. */
function rig(o = {}) {
  const dir = mk('wt-svc-');
  let clock = Date.parse('2026-03-10T12:00:00Z');
  const calls = [];
  const script = { scan: () => ({ sessions: [], left: 0, projectCache: {} }), bh: () => ({ items: [] }), inventory: () => ({ projects: [] }), ...(o.script || {}) };
  const worker = { call: async (op, req) => { calls.push(op); return script[op](req); } };
  const store = createUsageStore({ dir: path.join(dir, 'ledger'), origin: o.origin || 'Alpha', now: () => clock });
  const claudeDir = 'claudeDir' in o ? o.claudeDir : path.join(dir, 'claude');
  if (claudeDir) fs.mkdirSync(claudeDir, { recursive: true });
  const timers = [];
  const svc = createUsageService({
    store, worker, claudeDir, statePath: path.join(dir, 'state.json'), now: () => clock,
    agentSessions: createAgentSessionMap({ load: () => [], append: () => {}, now: () => clock }),
    getConfig: () => (o.configFn ? o.configFn() : o.config || null), defaultRoots: () => ['r'], readConfig: () => null, log: o.log,
    getPeers: () => o.peers || [], getJson: o.getJson || (async () => ({ status: 404, json: null })),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.cleared = true; },
  });
  return { svc, store, calls, timers, dir, claudeDir, advance: (ms) => { clock += ms; }, setSettings: (j) => fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(j)) };
}
const scanOf = (...sess) => () => ({ sessions: sess, left: 0, projectCache: {} });
const sess = (sid, units, sig = 's1') => ({ sid, sig, summary: summary(units) });

test.describe('a collection pass', () => {
  test('a session is recorded once; rescanned with the same summary it is not written again; a changed summary is', async () => {
    let cur = sess('a', 100);
    const r = rig({ script: { scan: () => ({ sessions: [cur], left: 0, projectCache: {} }) } });
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 1, written: 2 });          // the session + the settings
    expect(r.store.records('session')).toHaveLength(1);
    r.advance(3 * 3600e3);
    cur = sess('a', 100, 's2');
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 1, written: 0 });          // the same summary under a new signature
    cur = sess('a', 150, 's3');
    r.advance(3 * 3600e3);
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 1, written: 1 });
    expect(r.store.records('session')[0].units).toBe(150);
    expect(r.store.heads().Alpha).toBe(3);
  });

  test('the inventory is read once a day and written only when the project list changed', async () => {
    let projects = ['p1', 'p2'];
    const r = rig({ script: { inventory: () => ({ projects }) } });
    await r.svc.collectOnce();
    expect(r.store.records('inventory').map((x) => x.projects)).toEqual([['p1', 'p2']]);
    r.advance(1 * 3600e3);
    await r.svc.collectOnce();
    expect(r.calls.filter((c) => c === 'inventory')).toHaveLength(1);                    // not asked again within the day
    r.advance(DAY);
    await r.svc.collectOnce();
    expect(r.calls.filter((c) => c === 'inventory')).toHaveLength(2);                    // asked again...
    expect(r.store.heads().Alpha).toBe(2);                                                // ...but nothing changed: no new record (session none, settings 1, inventory 1)
    projects = ['p1', 'p2', 'p3'];
    r.advance(DAY);
    await r.svc.collectOnce();
    expect(r.store.records('inventory')[0].projects).toEqual(['p1', 'p2', 'p3']);
  });

  test('a bug-hunter item is written when it first appears and again only when it changed', async () => {
    let item = { type: 'bh-item', key: 'Alpha|bh|run|7|t', item: 7, outcome: 'open' };
    const r = rig({ script: { bh: () => ({ items: [item] }) } });
    expect(await r.svc.collectOnce()).toMatchObject({ bhItems: 1 });
    expect(await r.svc.collectOnce()).toMatchObject({ bhItems: 0 });
    item = { ...item, outcome: 'fixed-pushed' };
    expect(await r.svc.collectOnce()).toMatchObject({ bhItems: 1 });
    expect(r.store.records('bh-item')[0].outcome).toBe('fixed-pushed');
  });

  test('the settings regime is a record when it changes and not otherwise', async () => {
    const r = rig();
    r.setSettings({ autoCompactWindow: 400000, effortLevel: 'high' });
    expect(await r.svc.collectOnce()).toMatchObject({ settingsChanged: true });
    expect(await r.svc.collectOnce()).toMatchObject({ settingsChanged: false });
    r.setSettings({ autoCompactWindow: 200000, effortLevel: 'high' });
    r.advance(60e3);
    expect(await r.svc.collectOnce()).toMatchObject({ settingsChanged: true });
    expect(r.store.records('settings').map((x) => x.autoCompactWindow).sort()).toEqual([200000, 400000]);
  });

  test('with no Claude home nothing is scanned and no settings are recorded', async () => {
    const r = rig({ claudeDir: null });
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 0, settingsChanged: false });
    expect(r.calls).not.toContain('scan');
  });

  test('a failing worker is reported in the status, not thrown, and the next pass still runs', async () => {
    let boom = true;
    const r = rig({ script: { scan: () => { if (boom) throw new Error('worker died'); return { sessions: [], left: 0, projectCache: {} }; } } });
    expect(await r.svc.collectOnce()).toEqual({ error: 'worker died' });
    expect(r.svc.status().collectError).toBe('worker died');
    boom = false;
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 0 });
    expect(r.svc.status().collectError).toBeNull();
  });
});

test.describe('recovery before a machine writes its own history', () => {
  test('with peers configured and none heard from, a machine with an empty file does not collect; once one answered it does', async () => {
    const peerStore = createUsageStore({ dir: mk('wt-peer-'), origin: 'Beta' });
    peerStore.append([{ type: 'settings', key: 'Beta|settings|1', autoCompactWindow: 1 }]);
    const peer = { name: 'Beta', url: 'http://beta' };
    const down = { v: true };
    const getJson = async (_p, p) => {
      if (down.v) throw new Error('unreachable');
      const u = new URL(p, 'http://x');
      if (u.pathname === '/api/usage/heads') return { status: 200, json: sync.serveHeads(peerStore, 'Beta') };
      const r = sync.serveFeed(peerStore, Object.fromEntries(u.searchParams));
      return { status: r.status, json: r.body };
    };
    const r = rig({ peers: [peer], getJson, script: { scan: scanOf(sess('a', 5)) } });
    expect(await r.svc.collectOnce()).toEqual({ skipped: 'recovering' });
    expect(r.store.heads()).toEqual({});
    await r.svc.syncOnce();
    expect(r.svc.status().answeredEver).toBe(false);
    down.v = false;
    expect(await r.svc.syncOnce()).toMatchObject({ answered: 1, pulled: 1 });
    expect(r.store.heads()).toEqual({ Beta: 1 });
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 1 });
    expect(r.store.head('Alpha')).toBeGreaterThan(0);
  });
});

test.describe('a machine never writes while it is behind on its own history (a fork)', () => {
  /** A peer store answering like the routes do; `state.down` makes every call reject. */
  const peerRig = (peerStore, name, state) => async (_p, p) => {
    if (state.down) throw new Error('unreachable');
    const u = new URL(p, 'http://x');
    if (u.pathname === '/api/usage/heads') return { status: 200, json: sync.serveHeads(peerStore, name) };
    const r = sync.serveFeed(peerStore, Object.fromEntries(u.searchParams));
    return { status: r.status, json: r.body };
  };
  const key = (o, n) => `${o}|k${n}`;

  test('a file cut at load, peers away at boot: no collection and no classify; once the peer is back and has been copied, writing resumes after its last seq', async () => {
    // Home wrote 1..4 and Office copied them all; then Home's file got a bad line at seq 3
    const dirHome = mk('wt-fork-');
    const home = createUsageStore({ dir: dirHome, origin: 'Home' });
    home.append([1, 2, 3, 4].map((n) => ({ type: 'settings', key: key('Home', n), n })));
    const office = createUsageStore({ dir: mk('wt-fork-office-'), origin: 'Office' });
    office.appendReplica('Home', home.feed('Home', 0, 10));
    const f = path.join(dirHome, 'Home.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    lines[2] = '{ not json';
    fs.writeFileSync(f, `${lines.join('\n')}\n`);
    const state = { down: true };
    const r = rig({ origin: 'Home', peers: [{ name: 'Office', url: 'http://office' }], getJson: peerRig(office, 'Office', state), script: { scan: scanOf(sess('a', 5)) } });
    // the rig builds its own store, so rebuild the service over the damaged file
    const store = createUsageStore({ dir: dirHome, origin: 'Home' });
    expect(store.heads()).toEqual({ Home: 2 });
    expect(store.ownRepaired()).toBe(true);
    const calls = [];
    const svc = createUsageService({
      store, worker: { call: async (op) => { calls.push(op); return op === 'scan' ? scanOf(sess('a', 5))() : op === 'bh' ? { items: [] } : { projects: [] }; } },
      claudeDir: null, statePath: path.join(r.dir, 'fork-state.json'), now: () => Date.parse('2026-03-10T12:00:00Z'),
      agentSessions: createAgentSessionMap({ load: () => [], append: () => {} }), getConfig: () => null, defaultRoots: () => [], readConfig: () => null,
      getPeers: () => [{ name: 'Office', url: 'http://office' }], getJson: peerRig(office, 'Office', state),
    });
    expect(await svc.collectOnce()).toEqual({ skipped: 'recovering' });
    expect(svc.classify('newproject', 'work')).toMatchObject({ status: 503 });
    expect(store.heads()).toEqual({ Home: 2 });                                 // nothing written: no seq 3 that Office disagrees with
    await svc.syncOnce();                                                       // Office still down
    expect(await svc.collectOnce()).toEqual({ skipped: 'recovering' });
    state.down = false;
    await svc.syncOnce();                                                       // the missing 3 and 4 come back from Office
    expect(store.heads()).toEqual({ Home: 4 });
    expect(svc.classify('newproject', 'work').record.seq).toBe(5);              // after Office's last, never in its place
    expect(office.feed('Home', 0, 10).map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });

  test('a recovery pull that stopped partway leaves the machine behind: it writes nothing until a later round has caught up', async () => {
    const office = createUsageStore({ dir: mk('wt-fork-office-'), origin: 'Office' });
    const homeSrc = createUsageStore({ dir: mk('wt-fork-src-'), origin: 'Home' });
    homeSrc.append([1, 2, 3, 4, 5].map((n) => ({ type: 'settings', key: key('Home', n), n })));
    office.appendReplica('Home', homeSrc.feed('Home', 0, 10));
    let failFeed = true;
    const getJson = async (_p, p) => {
      const u = new URL(p, 'http://x');
      if (u.pathname === '/api/usage/heads') return { status: 200, json: sync.serveHeads(office, 'Office') };
      if (failFeed) throw new Error('timeout');
      const r = sync.serveFeed(office, Object.fromEntries(u.searchParams));
      return { status: r.status, json: r.body };
    };
    const r = rig({ origin: 'Home', peers: [{ name: 'Office', url: 'http://office' }], getJson, script: { scan: scanOf(sess('a', 5)) } });
    await r.svc.syncOnce();                                                     // heads answer, the feed fails: answered, but behind
    expect(r.store.head('Home')).toBe(0);
    expect(await r.svc.collectOnce()).toEqual({ skipped: 'recovering' });
    failFeed = false;
    await r.svc.syncOnce();
    expect(r.store.head('Home')).toBe(5);
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 1 });
    expect(r.store.head('Home')).toBeGreaterThan(5);
  });

  test('a fresh machine whose peers are ALL older servers (404) collects; one with an unreachable peer waits', async () => {
    const old = rig({ peers: [{ name: 'A', url: 'http://a' }, { name: 'B', url: 'http://b' }], getJson: async () => ({ status: 404, json: null }), script: { scan: scanOf(sess('a', 5)) } });
    expect(await old.svc.collectOnce()).toEqual({ skipped: 'recovering' });    // nothing is known before the first round
    await old.svc.syncOnce();
    expect(await old.svc.collectOnce()).toMatchObject({ scanned: 1 });
    const mixed = rig({ peers: [{ name: 'A', url: 'http://a' }, { name: 'B', url: 'http://b' }], getJson: async (peer) => { if (peer.name === 'B') throw new Error('unreachable'); return { status: 404, json: null }; } });
    await mixed.svc.syncOnce();
    expect(await mixed.svc.collectOnce()).toEqual({ skipped: 'recovering' });
  });
});

test.describe('the gate rests on every peer having answered, and on a high-water mark', () => {
  const peerOf = (store, name, st) => async (_p, p) => {
    if (st.down) throw new Error('unreachable');
    const u = new URL(p, 'http://x');
    if (u.pathname === '/api/usage/heads') return { status: 200, json: sync.serveHeads(store, name) };
    if (st.feedFails) throw new Error('timeout');
    const r = sync.serveFeed(store, Object.fromEntries(u.searchParams));
    return { status: r.status, json: r.body };
  };
  const seeded = (origin, n) => { const s = createUsageStore({ dir: mk('wt-peer-'), origin }); s.append(Array.from({ length: n }, (_, i) => ({ type: 'settings', key: `${origin}|k${i}` }))); return s; };

  test('a wiped machine whose first peer answers 200 WITHOUT its history, while another peer that holds it is down, does not write', async () => {
    const A = createUsageStore({ dir: mk('wt-peer-'), origin: 'PeerA' });          // answers 200, holds nothing of Home
    const homeCopy = seeded('Home', 5);
    const B = createUsageStore({ dir: mk('wt-peer-'), origin: 'PeerB' });
    B.appendReplica('Home', homeCopy.feed('Home', 0, 10));                          // the one that holds Home's 5 records
    const stA = {}; const stB = { down: true };
    const r = rig({ origin: 'Home', peers: [{ name: 'PeerA', url: 'http://a' }, { name: 'PeerB', url: 'http://b' }],
      getJson: (peer, p) => (peer.name === 'PeerA' ? peerOf(A, 'PeerA', stA) : peerOf(B, 'PeerB', stB))(peer, p), script: { scan: scanOf(sess('a', 5)) } });
    await r.svc.syncOnce();
    expect(await r.svc.collectOnce()).toEqual({ skipped: 'recovering' });
    expect(r.svc.classify('x', 'work')).toMatchObject({ status: 503 });
    stB.down = false;                                                               // B comes back: the history is pulled, then writing continues after it
    await r.svc.syncOnce();
    expect(r.store.head('Home')).toBe(5);
    expect(r.svc.classify('x', 'work').record.seq).toBe(6);
  });

  test('"behind" is a high-water mark: a round in which the peer is unreachable does not clear it', async () => {
    const office = createUsageStore({ dir: mk('wt-peer-'), origin: 'Office' });
    office.appendReplica('Home', seeded('Home', 5).feed('Home', 0, 10));
    const st = { feedFails: true };
    const r = rig({ origin: 'Home', peers: [{ name: 'Office', url: 'http://o' }], getJson: peerOf(office, 'Office', st), script: { scan: scanOf(sess('a', 5)) } });
    await r.svc.syncOnce();                                                         // heads say 5, the feed breaks
    expect(await r.svc.collectOnce()).toEqual({ skipped: 'recovering' });
    st.down = true;
    await r.svc.syncOnce();                                                         // Office unreachable now: nothing new is learned, nothing is forgotten
    expect(await r.svc.collectOnce()).toEqual({ skipped: 'recovering' });
    expect(r.svc.classify('x', 'work')).toMatchObject({ status: 503 });
    st.down = false; st.feedFails = false;
    await r.svc.syncOnce();
    expect(r.store.head('Home')).toBe(5);
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 1 });
  });

  test('a retired peer that will never answer is listed in usageLedger.ignorePeers, and a fresh machine then writes', async () => {
    const gone = { name: 'Retired', url: 'http://gone' };
    const live = createUsageStore({ dir: mk('wt-peer-'), origin: 'Live' });
    const getJson = (peer, p) => (peer.name === 'Retired' ? Promise.reject(new Error('gone')) : peerOf(live, 'Live', {})(peer, p));
    const peers = [gone, { name: 'Live', url: 'http://live' }];
    const stuck = rig({ origin: 'Home', peers, getJson, script: { scan: scanOf(sess('a', 5)) } });
    await stuck.svc.syncOnce();
    expect(await stuck.svc.collectOnce()).toEqual({ skipped: 'recovering' });
    const freed = rig({ origin: 'Home', peers, getJson, config: { ignorePeers: ['RETIRED'] }, script: { scan: scanOf(sess('a', 5)) } });
    await freed.svc.syncOnce();
    expect(await freed.svc.collectOnce()).toMatchObject({ scanned: 1 });
  });
});

test.describe('a pass that cannot be written whole', () => {
  test('one oversized record is dropped and logged; the others in the pass are still written and the pass is not retried forever', async () => {
    const big = { type: 'bh-item', key: 'Alpha|bh|run|1|t', item: 1, outcome: 'open', pad: 'x'.repeat(70 * 1024) };
    const logs = [];
    const r = rig({ script: { bh: () => ({ items: [big] }), scan: scanOf(sess('a', 5)) }, log: (m) => logs.push(m) });
    const res = await r.svc.collectOnce();
    expect(res.error).toBeUndefined();
    expect(r.store.records('session')).toHaveLength(1);
    expect(r.store.records('bh-item')).toHaveLength(0);
    expect(logs.join(' ')).toMatch(/oversized bh-item/);
    expect(await r.svc.collectOnce()).toMatchObject({ written: 0 });           // remembered: not tried and logged again
  });
  test('enabled: false, set while the server runs, stops collecting and syncing at once', async () => {
    let on = true;
    const r = rig({ configFn: () => ({ enabled: on }) });
    expect(await r.svc.collectOnce()).toMatchObject({ scanned: 0 });
    on = false;
    expect(await r.svc.collectOnce()).toEqual({ skipped: 'disabled' });
    expect(await r.svc.syncOnce()).toEqual({ skipped: 'disabled' });
  });
});

test.describe('the status answer', () => {
  test('counts the configured folders and names none, and sets only values it can use', () => {
    const r = rig({ config: { projectRoots: ['/secret/work'], bhRunDirs: ['/secret/runs', '/secret/more'], collectMin: 'soon', syncMin: 99999 } });
    const st = r.svc.status();
    expect(JSON.stringify(st)).not.toContain('secret');
    expect(st.config).toMatchObject({ projectRoots: 1, bhRunDirs: 2, collectMin: 30, syncMin: 1440, workSource: null });
  });
});

test.describe('the timers', () => {
  test('start schedules a sync and a collection; a backlog is retried in a minute, a finished pass at the configured interval; stop clears them; disabled schedules nothing', async () => {
    const r = rig({ config: { collectMin: 30, firstRunMin: 2, syncMin: 5 }, script: { scan: () => ({ sessions: [], left: 3, projectCache: {} }) } });
    r.svc.start();
    expect(r.timers.map((t) => t.ms).sort((a, b) => a - b)).toEqual([5000, 120000]);
    const collect = r.timers.find((t) => t.ms === 120000);
    await collect.fn();
    expect(r.timers.at(-1).ms).toBe(60000);                                                // left > 0: retried soon
    r.svc.stop();
    expect(r.timers.every((t) => t.cleared)).toBe(true);
    const off = rig({ config: { enabled: false } });
    off.svc.start();
    expect(off.timers).toHaveLength(0);
  });
});
