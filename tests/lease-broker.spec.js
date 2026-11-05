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

  test('a session closed by its hand-off passes its leases to the successor; a plain exit releases them', async () => {
    const A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const SUCC = 'aaaaaaaa-0000-4000-8000-000000000002';
    const B = 'aaaaaaaa-0000-4000-8000-000000000003';
    const W = 'aaaaaaaa-0000-4000-8000-000000000004';
    const b = createLeaseBroker({
      stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'self' }), cluster: () => [], publicUrl: () => null, serverName: () => 'solo',
      clusterToken: () => null, fetch: async () => { throw new Error('unused'); }, listLocalSessionIds: async () => [], readMachine: async () => null,
      protectedPids: () => [], log: () => {}, error: () => {},
    });
    expect((await call(b.routes.create, { body: { resource: 'vm:X', holderSessionId: A } })).code).toBe(200);
    expect((await call(b.routes.create, { body: { resource: 'vm:Y', holderSessionId: B } })).code).toBe(200);
    expect((await call(b.routes.create, { body: { resource: 'vm:Y', holderSessionId: W } })).body.lease.state).toBe('queued');
    const holderOf = async (res) => (await call(b.routes.list)).body.resources.find((r) => r.resource === res).holder;
    // The worker's sessionExited for a session the hand-off closed: the lease moves.
    b.onSessionExited(A, SUCC);
    expect((await holderOf('vm:X')).holder.sessionId).toBe(SUCC);
    // A plain exit ends B's lease and the next in line is granted.
    b.onSessionExited(B, null);
    expect((await holderOf('vm:Y')).holder.sessionId).toBe(W);
    // The route takes the same successor, from a holder's machine.
    const r = await call(b.routes.holderEnded, { body: { holderSessionId: SUCC, successorSessionId: A } });
    expect(r.code).toBe(200);
    expect(r.body.moved).toHaveLength(1);
    expect((await holderOf('vm:X')).holder.sessionId).toBe(A);
    expect((await call(b.routes.holderEnded, { body: { holderSessionId: A, successorSessionId: 'nope' } })).code).toBe(400);
  });

  test('a non-authority tells the authority who the successor is', async () => {
    const A = 'bbbbbbbb-0000-4000-8000-000000000001';
    const SUCC = 'bbbbbbbb-0000-4000-8000-000000000002';
    const sent = [];
    const { b } = broker(dir, { fetch: async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { status: 200, body: '{}' }; } });
    b.onSessionExited(A, SUCC);
    b.onSessionExited(SUCC, null);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.map((s) => s.url)).toEqual(['http://alpha.test/api/leases/holder-ended', 'http://alpha.test/api/leases/holder-ended']);
    expect(sent[0].body).toMatchObject({ holderSessionId: A, successorSessionId: SUCC });
    expect(sent[1].body.holderSessionId).toBe(SUCC);
    expect(sent[1].body).not.toHaveProperty('successorSessionId');
  });

  test('a record the ledger cannot save is refused, not answered as recorded', async () => {
    const p = await sleeper();
    const b = broker(dir, { fetch: alphaFetch({}), recordsFile: path.join(dir, 'no-such-dir', 'records.json') }).b;
    const r = await call(b.routes.record, { params: { id: LEASE }, body: { pids: [p.pid] } });
    expect(r.code).toBe(503);
    expect(r.body.nothingRecorded).toBe(true);
    expect((await call(b.routes.records)).body.records).toEqual({});
    // A lease that already had a record keeps it, unchanged, when a later save fails.
    const led = path.join(dir, 'led');
    fs.mkdirSync(led);
    const q = await sleeper();
    const b2 = broker(dir, { fetch: alphaFetch({}), recordsFile: path.join(led, 'records.json') }).b;
    expect((await call(b2.routes.record, { params: { id: LEASE }, body: { pids: [p.pid] } })).code).toBe(200);
    fs.rmSync(led, { recursive: true, force: true });
    expect((await call(b2.routes.record, { params: { id: LEASE }, body: { pids: [q.pid] } })).code).toBe(503);
    const kept = (await call(b2.routes.records)).body.records[LEASE];
    expect(kept.items.map((i) => i.pid)).toEqual([p.pid]);
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

// #429 - a forward that fails leaves ONE line on the forwarding server: the call, the lease or
// resource, the authority, what went wrong and how long it took. No token, no body.
test.describe('a failed lease forward is logged (#429)', () => {
  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt429-broker-')); });
  test.afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  /** bravo -> alpha with every log line captured; [fetch] is alpha's behaviour. */
  function logged(fetch, over = {}) {
    const lines = [];
    const clock = { t: 1_000_000 };
    const { b } = broker(dir, { fetch, log: (m) => lines.push(m), error: (m) => lines.push(m), now: () => clock.t, ...over });
    return { b, lines, clock };
  }
  const forwardLines = (lines) => lines.filter((l) => /forward/.test(l));

  test('a heartbeat that times out: one line naming call, lease, authority, failure and elapsed ms - and the caller still gets 503', async () => {
    const { b, lines } = logged(async () => { await new Promise((r) => setTimeout(r, 30)); throw new Error('Timeout'); });
    const r = await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ error: 'the lease authority is unreachable; no new lease can be granted', authority: 'alpha' });
    const f = forwardLines(lines);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/heartbeat/);
    expect(f[0]).toContain(LEASE.slice(0, 8));
    expect(f[0]).toMatch(/alpha/);
    expect(f[0]).toMatch(/Timeout/);
    const ms = Number((f[0].match(/(\d+) ms/) || [])[1]);
    expect(ms).toBeGreaterThanOrEqual(25);
    expect(f[0]).not.toContain('tok');
  });

  test('an acquire the authority refuses at the socket names the resource', async () => {
    const { b, lines } = logged(async () => { throw new Error('connect ECONNREFUSED 100.0.0.1:443'); });
    const r = await call(b.routes.create, { body: { resource: 'vm:Build-7' } });
    expect(r.code).toBe(503);
    const f = forwardLines(lines);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/acquire/);
    expect(f[0]).toContain('vm:Build-7');
    expect(f[0]).toContain('ECONNREFUSED');
  });

  test('an error ANSWER from the authority (or a proxy in front of it) is logged too, status passed through unchanged', async () => {
    const { b, lines } = logged(async () => ({ status: 503, body: '<html>Service Unavailable</html>' }));
    const r = await call(b.routes.release, { params: { id: LEASE }, body: {} });
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ error: 'the lease authority sent no JSON' });
    const f = forwardLines(lines);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/release/);
    expect(f[0]).toMatch(/503/);
    expect(f[0]).not.toContain('<html>');
  });

  test('a 4xx the authority ANSWERS is normal traffic, not logged; a 4xx that is not JSON is', async () => {
    const answers = [
      { status: 404, body: JSON.stringify({ error: 'that lease has ended', tableId: TABLE, released: { why: 'ttl', at: 1 } }) },
      { status: 403, body: JSON.stringify({ error: 'only the lease holder may do that' }) },
      { status: 409, body: JSON.stringify({ error: 'conflict' }) },
      { status: 400, body: JSON.stringify({ error: 'not a lease id' }) },
    ];
    let next = null;
    const { b, lines } = logged(async () => next);
    for (const a of answers) {
      next = a;
      const r = await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
      expect(r.code).toBe(a.status);
      expect(r.body).toEqual(JSON.parse(a.body));
    }
    expect(lines).toEqual([]);
    // A branch without these routes, or a proxy: Express's HTML 404 is not the authority answering.
    next = { status: 404, body: '<!DOCTYPE html><pre>Cannot POST</pre>' };
    expect((await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} })).code).toBe(404);
    const f = forwardLines(lines);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/404 with no JSON/);
  });

  test('a forward that succeeds logs nothing', async () => {
    const ok = async () => ({ status: 200, body: JSON.stringify({ lease: { id: LEASE } }) });
    const { b, lines } = logged(ok);
    expect((await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} })).code).toBe(200);
    expect((await call(b.routes.list)).code).toBe(200);
    expect(lines).toEqual([]);
  });

  test('the same failure again within a minute is counted, not repeated; the next line says how many', async () => {
    const { b, lines, clock } = logged(async () => { throw new Error('Timeout'); });
    for (let i = 0; i < 3; i++) await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    expect(forwardLines(lines)).toHaveLength(1);
    clock.t += 61 * 1000;
    await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    const f = forwardLines(lines);
    expect(f).toHaveLength(2);
    expect(f[1]).toMatch(/2 more/);
  });

  test('a second lease failing inside the window is still named by the next line', async () => {
    const L2 = '99999999-2222-4333-8444-555555555555';
    const { b, lines, clock } = logged(async () => { throw new Error('Timeout'); });
    await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    clock.t += 15 * 1000;
    await call(b.routes.heartbeat, { params: { id: L2 }, body: {} });
    expect(forwardLines(lines)).toHaveLength(1);
    clock.t += 61 * 1000;
    await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    const f = forwardLines(lines);
    expect(f).toHaveLength(2);
    expect(f[1]).toMatch(/1 more/);
    expect(f[1]).toContain(L2.slice(0, 8));
    // The same lease failing again is one subject, not a hint of others ("...").
    clock.t += 15 * 1000;
    for (let i = 0; i < 4; i++) await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    clock.t += 61 * 1000;
    await call(b.routes.heartbeat, { params: { id: LEASE }, body: {} });
    const g = forwardLines(lines);
    expect(g).toHaveLength(3);
    expect(g[2]).toContain('(+4 more like it since the last line: lease 11111111)');
  });

  test('nothing a peer or a caller controls can forge a log line', async () => {
    const LS = String.fromCodePoint(0x2028);
    const { b, lines } = logged(async () => { throw new Error('boom' + String.fromCodePoint(10) + '[leases] forged line' + LS + 'x'); });
    await call(b.routes.create, { body: { resource: 'vm:a' + String.fromCodePoint(13, 10) + 'b' } });
    const f = forwardLines(lines);
    expect(f).toHaveLength(1);
    expect(/[\r\n\u2028]/.test(f[0])).toBe(false);
  });

  test('the holder-ended notice and the liveness read on the authority log their failures too', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000001';
    // bravo (not the authority) tells alpha a session ended; alpha refuses.
    const a = logged(async () => ({ status: 503, body: JSON.stringify({ error: 'no lease authority is configured' }) }));
    a.b.onSessionExited(S, null);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.lines.filter((l) => /holder-ended/.test(l) && /503/.test(l) && l.includes(S.slice(0, 8)))).toHaveLength(1);
    // bravo AS the authority: charlie holds a lease and does not answer the liveness read.
    const lines = [];
    let peer = async () => { throw new Error('socket hang up'); };
    const { b } = broker(dir, { leasesConfig: () => ({ authority: 'self' }), fetch: (...x) => peer(...x), log: (m) => lines.push(m), error: (m) => lines.push(m) });
    expect((await call(b.routes.create, { body: { resource: 'vm:L', holderSessionId: S, holderServer: { name: 'charlie', url: 'http://charlie.test' } } })).code).toBe(200);
    lines.length = 0;
    await b.sweepAll();
    const live = lines.filter((l) => /liveness/.test(l));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatch(/charlie/);
    expect(live[0]).toMatch(/socket hang up/);
    // A JSON 4xx from the holder's machine is still a failed READ (no session list, nobody judged).
    peer = async () => ({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) });
    await b.sweepAll();
    const live2 = lines.filter((l) => /liveness/.test(l));
    expect(live2).toHaveLength(2);
    expect(live2[1]).toMatch(/401/);
  });

  test('the authority logs a 5xx it answers to a FORWARDED call; a local caller sees the error itself', async () => {
    fs.writeFileSync(path.join(dir, 'leases.json'), '{ not json');
    const lines = [];
    const b = createLeaseBroker({
      stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'self' }), cluster: () => [], publicUrl: () => null, serverName: () => 'solo',
      clusterToken: () => null, fetch: async () => { throw new Error('unused'); }, listLocalSessionIds: async () => [], readMachine: async () => null,
      protectedPids: () => [], log: (m) => lines.push(m), error: (m) => lines.push(m),
    });
    lines.length = 0; // the startup line about the unreadable file
    expect((await call(b.routes.list)).code).toBe(503);
    expect(lines).toEqual([]);
    const r = await call(b.routes.heartbeat, { params: { id: LEASE }, body: {}, headers: { 'x-wt-lease-hop': '1' } });
    expect(r.code).toBe(503);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/heartbeat/);
    expect(lines[0]).toMatch(/503/);
    expect(lines[0]).toMatch(/could not be read/);
  });
});
