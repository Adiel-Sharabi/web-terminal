// @ts-check
// lib/lease-broker.js (#412) with fake I/O: the rules that need a broker but not two servers.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLeaseBroker } = require('../lib/lease-broker');

const fakeRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const call = async (fn, req = {}) => { const res = fakeRes(); await fn({ params: {}, body: {}, query: {}, headers: {}, ...req }, res); return res; };
const LEASE = '11111111-2222-4333-8444-555555555555';
const TABLE = 'table-alpha-1';

const sleepers = [];
test.afterAll(() => { for (const p of sleepers) { try { p.kill(); } catch { /* gone */ } } });
async function sleeper() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  sleepers.push(p);
  await new Promise((r) => setTimeout(r, 300));
  return p;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A broker on "bravo" whose authority is "alpha" (remote), with [over] replacing any dep. */
function broker(dir, over = {}) {
  const cfg = { leases: { authority: 'alpha' } };
  const b = createLeaseBroker({
    stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
    leasesConfig: () => cfg.leases,
    cluster: () => [{ name: 'alpha', url: 'http://alpha.test' }, { name: 'bravo', url: 'http://bravo.test' }, { name: 'charlie', url: 'http://charlie.test' }],
    publicUrl: () => 'http://bravo.test', serverName: () => 'bravo',
    clusterToken: () => 'tok', listLocalSessionIds: async () => [], readMachine: async () => null, protectedPids: () => [process.pid],
    fetch: async () => { throw new Error('unreachable'); },
    log: () => {}, error: () => {},
    ...over,
  });
  return { b, cfg };
}
/** alpha's answers: the lease held by bravo, until [state.ended]; then [state.endReply]. */
function alphaFetch(state) {
  return async (url) => {
    state.asked = (state.asked || 0) + 1;
    if (!url.startsWith('http://alpha.test')) return { status: 404, body: JSON.stringify({ error: 'no such lease', tableId: 'charlie-table' }) };
    if (!state.ended) return { status: 200, body: JSON.stringify({ lease: { id: LEASE, resource: 'vm:X', state: 'held', holder: { server: state.holder || 'bravo', sessionId: null } }, tableId: TABLE }) };
    return state.endReply;
  };
}

test.describe('lease broker (#412)', () => {
  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-broker-')); });
  test.afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('only a JSON 404 from the SAME table ends a recorded lease: HTML, another table, another authority all keep', async () => {
    const p = await sleeper();
    const st = {};
    const { b, cfg } = broker(dir, { fetch: alphaFetch(st) });
    const rec = await call(b.routes.record, { params: { id: LEASE }, body: { pids: [p.pid] } });
    expect(rec.code, JSON.stringify(rec.body)).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'records.json'), 'utf8'))[LEASE].tableId).toBe(TABLE);
    st.ended = true;
    // A branch without these routes: Express answers 404 in HTML.
    st.endReply = { status: 404, body: '<!DOCTYPE html><pre>Cannot GET /api/leases/x</pre>' };
    await b.sweepAll();
    expect(alive(p.pid)).toBe(true);
    // A deleted / replaced table: valid JSON, another id.
    st.endReply = { status: 404, body: JSON.stringify({ error: 'no such lease', tableId: 'a-new-table' }) };
    await b.sweepAll();
    expect(alive(p.pid)).toBe(true);
    // The authority moved in config: charlie never heard of it.
    cfg.leases = { authority: 'charlie' };
    await b.sweepAll();
    expect(alive(p.pid)).toBe(true);
    // Back to alpha, which now really says its own lease ended.
    cfg.leases = { authority: 'alpha' };
    st.endReply = { status: 404, body: JSON.stringify({ error: 'that lease has ended', tableId: TABLE, released: { why: 'released' } }) };
    await b.sweepAll();
    const end = Date.now() + 5000;
    while (alive(p.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(alive(p.pid)).toBe(false);
    expect((await call(b.routes.records)).body.records).toEqual({});
  });

  test('a call already forwarded once is never forwarded again (two configs naming each other)', async () => {
    let hops = 0;
    const brokers = {};
    const relay = async (url, opts) => {
      if (++hops > 5) throw new Error('loop');
      const target = url.startsWith('http://alpha.test') ? brokers.alpha : brokers.bravo;
      const res = await call(target.routes.list, { headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])) });
      return { status: res.code, body: JSON.stringify(res.body) };
    };
    brokers.bravo = broker(dir, { fetch: relay }).b; // bravo names alpha
    fs.mkdirSync(path.join(dir, 'a'));
    brokers.alpha = createLeaseBroker({
      stateFile: path.join(dir, 'a', 'leases.json'), recordsFile: path.join(dir, 'a', 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'bravo' }), // ...and alpha, mid-move, names bravo
      cluster: () => [{ name: 'alpha', url: 'http://alpha.test' }, { name: 'bravo', url: 'http://bravo.test' }],
      publicUrl: () => 'http://alpha.test', serverName: () => 'alpha', clusterToken: () => 'tok', fetch: relay,
      listLocalSessionIds: async () => [], readMachine: async () => null, protectedPids: () => [], log: () => {}, error: () => {},
    });
    const r = await call(brokers.bravo.routes.list);
    expect(hops).toBe(1);
    expect(r.code).toBe(508);
    expect(r.body.error).toMatch(/loop/);
  });

  test('a grant that cannot be saved is not granted', async () => {
    const solo = (stateFile) => createLeaseBroker({
      stateFile, recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'self' }), cluster: () => [], publicUrl: () => null, serverName: () => 'solo',
      clusterToken: () => null, fetch: async () => { throw new Error('unused'); }, listLocalSessionIds: async () => [], readMachine: async () => null,
      protectedPids: () => [], log: () => {}, error: () => {},
    });
    const b = solo(path.join(dir, 'no-such-dir', 'leases.json'));
    const r = await call(b.routes.create, { body: { resource: 'vm:X' } });
    expect(r.code).toBe(503);
    expect((await call(b.routes.list)).body.resources).toEqual([]);
  });

  test('an unreadable state file refuses every authority call and is left untouched', async () => {
    fs.writeFileSync(path.join(dir, 'leases.json'), '{ not json');
    const b = createLeaseBroker({
      stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'self' }), cluster: () => [], publicUrl: () => null, serverName: () => 'solo',
      clusterToken: () => null, fetch: async () => { throw new Error('unused'); }, listLocalSessionIds: async () => [], readMachine: async () => null,
      protectedPids: () => [], log: () => {}, error: () => {},
    });
    const r = await call(b.routes.create, { body: { resource: 'vm:X' } });
    expect(r.code).toBe(503);
    expect(r.body.error).toMatch(/could not be read/);
    expect(r.body.error).not.toMatch(/remove/);
    expect(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).toBe('{ not json');
  });

  test('record refuses: another machine\'s lease, an unknown worker pid, malformed cleanup roots', async () => {
    const p = await sleeper();
    const st = { holder: 'alpha' };
    const other = broker(dir, { fetch: alphaFetch(st) }).b;
    expect((await call(other.routes.record, { params: { id: LEASE }, body: { pids: [p.pid] } })).code).toBe(409);
    const noWorker = broker(dir, { fetch: alphaFetch({}), protectedPids: () => null }).b;
    const r = await call(noWorker.routes.record, { params: { id: LEASE }, body: { pids: [p.pid] } });
    expect(r.code).toBe(503);
    expect(r.body.error).toMatch(/worker/);
    const { b, cfg } = broker(dir, { fetch: alphaFetch({}) });
    cfg.leases = { authority: 'alpha', cleanupRoots: [os.tmpdir(), 'relative'] };
    expect((await call(b.routes.record, { params: { id: LEASE }, body: { paths: [path.join(os.tmpdir(), 'x')] } })).code).toBe(503);
    cfg.leases = { authority: 'alpha' }; // no roots at all: refused, never a default
    expect((await call(b.routes.record, { params: { id: LEASE }, body: { paths: [path.join(os.tmpdir(), 'x')] } })).code).toBe(400);
    expect(fs.existsSync(path.join(dir, 'records.json'))).toBe(false);
  });

  test('a server that is not the authority never sweeps a table it once owned', async () => {
    const id = '11111111-2222-4333-8444-666666666666';
    fs.writeFileSync(path.join(dir, 'leases.json'), JSON.stringify({ version: 1, tableId: 'old', released: [], leases: [{
      id, resource: 'vm:X', state: 'held', holder: { node: 'http://charlie.test', server: 'charlie', sessionId: null },
      role: null, meta: null, ttlSec: 30, heartbeatSec: 10, requestedAt: 1, grantedAt: 1, expiresAt: 2, lastHeartbeatAt: 1,
    }] }));
    const notified = [];
    const { b } = broker(dir, { fetch: async (url) => { notified.push(url); return { status: 404, body: '{}' }; } });
    await b.sweepAll();
    expect(notified.filter((u) => u.includes('released-notice'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).leases).toHaveLength(1);
  });
});
