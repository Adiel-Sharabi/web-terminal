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
const call = async (fn, req = {}) => { const res = fakeRes(); await fn({ params: {}, body: {}, query: {}, ...req }, res); return res; };

const sleepers = [];
test.afterAll(() => { for (const p of sleepers) { try { p.kill(); } catch { /* gone */ } } });

function broker(dir, over = {}) {
  const cfg = { leases: { authority: 'alpha' } };
  const b = createLeaseBroker({
    stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
    leasesConfig: () => cfg.leases,
    cluster: () => [{ name: 'alpha', url: 'http://alpha.test' }, { name: 'charlie', url: 'http://charlie.test' }],
    publicUrl: () => 'http://bravo.test', serverName: () => 'bravo',
    clusterToken: () => 'tok', listLocalSessionIds: async () => [], readMachine: async () => null, protectedPids: () => [process.pid],
    log: () => {}, error: () => {},
    ...over,
  });
  return { b, cfg };
}

test.describe('lease broker (#412)', () => {
  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-broker-')); });
  test.afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('a ledger entry is reconciled only against the authority it was recorded with', async () => {
    const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    sleepers.push(p);
    await new Promise((r) => setTimeout(r, 300));
    const id = '11111111-2222-4333-8444-555555555555';
    const asked = [];
    const { b, cfg } = broker(dir, {
      fetch: async (url) => {
        asked.push(url);
        if (url.startsWith('http://alpha.test')) return { status: 200, body: JSON.stringify({ lease: { id, resource: 'vm:X', state: 'held' } }) };
        return { status: 404, body: JSON.stringify({ error: 'no such lease' }) }; // charlie never heard of it
      },
    });
    const rec = await call(b.routes.record, { params: { id }, body: { pids: [p.pid] } });
    expect(rec.code, JSON.stringify(rec.body)).toBe(200);
    // The config moves the authority to charlie, which answers 404 for every old lease.
    cfg.leases = { authority: 'charlie' };
    await b.sweepAll();
    expect(asked.some((u) => u.startsWith('http://charlie.test'))).toBe(false);
    let alive = true; try { process.kill(p.pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    const list = await call(b.routes.records);
    expect(Object.keys(list.body.records)).toEqual([id]);
    expect(list.body.records[id].authority).toBe('alpha');
  });

  test('an unreadable state file refuses every authority call; an absent one is a fresh table', async () => {
    fs.writeFileSync(path.join(dir, 'leases.json'), '{ not json');
    const self = createLeaseBroker({
      stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'self' }), cluster: () => [], publicUrl: () => null, serverName: () => 'solo',
      clusterToken: () => null, fetch: async () => { throw new Error('unused'); }, listLocalSessionIds: async () => [], readMachine: async () => null,
      protectedPids: () => [], log: () => {}, error: () => {},
    });
    const r = await call(self.routes.create, { body: { resource: 'vm:X' } });
    expect(r.code).toBe(503);
    expect(r.body.error).toMatch(/could not be read/);
    expect(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).toBe('{ not json'); // untouched
    fs.unlinkSync(path.join(dir, 'leases.json'));
    const fresh = createLeaseBroker({
      stateFile: path.join(dir, 'leases.json'), recordsFile: path.join(dir, 'records.json'), checkoutDir: path.join(__dirname, '..'),
      leasesConfig: () => ({ authority: 'self' }), cluster: () => [], publicUrl: () => null, serverName: () => 'solo',
      clusterToken: () => null, fetch: async () => { throw new Error('unused'); }, listLocalSessionIds: async () => [], readMachine: async () => null,
      protectedPids: () => [], log: () => {}, error: () => {},
    });
    const ok = await call(fresh.routes.create, { body: { resource: 'vm:X' } });
    expect(ok.code).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).leases).toHaveLength(1);
  });

  test('a server that is not the authority never sweeps a table it once owned', async () => {
    // An old table where vm:X's lease is long past its TTL.
    const id = '11111111-2222-4333-8444-666666666666';
    fs.writeFileSync(path.join(dir, 'leases.json'), JSON.stringify({ version: 1, released: [], leases: [{
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
