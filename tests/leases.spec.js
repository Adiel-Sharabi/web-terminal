// @ts-check
// Unit tests for lib/leases.js (#412): the rules of the cluster lease broker - one queue per
// resource, FIFO grants, and every way a lease ends (release, TTL, lost heartbeat, the
// holder's session ending). Pure: every clock is passed in.

const { test, expect } = require('@playwright/test');
const L = require('../lib/leases');

const T0 = 10_000_000;
const SEC = 1000;
let n = 0;
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** A parsed request, the way the broker builds one. */
function req(over = {}) {
  const r = L.parseRequest({ resource: 'vm:X', ...over.body }, { holderNode: over.node === undefined ? 'self' : over.node, holderServer: over.server || 'office' });
  if (!r.ok) throw new Error(`bad fixture: ${r.error}`);
  return r.req;
}
function grant(state, over = {}, now = T0) {
  const r = L.request(state, req(over), now, ids);
  if (r.error) throw new Error(r.error);
  return r;
}

test.describe('lease requests (#412)', () => {
  test('the first request is granted, the second for the same resource is queued with its position', () => {
    let s = L.emptyState();
    const a = grant(s, { body: { holderSessionId: 'aaaaaaaa-0000-4000-8000-000000000001' } });
    s = a.state;
    expect(a.lease.state).toBe('held');
    expect(L.positionOf(s, a.lease.id)).toBe(0);
    const b = grant(s, { body: { holderSessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }, node: 'https://home.example', server: 'home' }, T0 + SEC);
    s = b.state;
    expect(b.lease.state).toBe('queued');
    expect(L.positionOf(s, b.lease.id)).toBe(1);
    // A different resource is independent.
    const c = grant(s, { body: { resource: 'vm:Y' } });
    expect(c.lease.state).toBe('held');
  });

  test('the same holder asking twice for one resource gets its existing lease back, not a second place', () => {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
    const a = grant(L.emptyState(), { body: { holderSessionId: sid } });
    const again = grant(a.state, { body: { holderSessionId: sid } }, T0 + 5 * SEC);
    expect(again.existing).toBe(true);
    expect(again.lease.id).toBe(a.lease.id);
    expect(again.state.leases).toHaveLength(1);
    // ...but the same session id on ANOTHER machine is another holder.
    const other = grant(a.state, { body: { holderSessionId: sid }, node: 'https://home.example' });
    expect(other.existing).toBe(false);
    expect(other.lease.state).toBe('queued');
  });

  test('release grants the next waiter in FIFO order', () => {
    let s = L.emptyState();
    const a = grant(s); s = a.state;
    const b = grant(s, {}, T0 + 1 * SEC); s = b.state;
    const c = grant(s, {}, T0 + 2 * SEC); s = c.state;
    const r = L.release(s, a.lease.id, 'released', T0 + 10 * SEC);
    expect(r.released.id).toBe(a.lease.id);
    expect(r.granted.map((g) => g.id)).toEqual([b.lease.id]);
    s = r.state;
    const held = s.leases.find((l) => l.id === b.lease.id);
    expect(held).toMatchObject({ state: 'held', grantedAt: T0 + 10 * SEC, expiresAt: T0 + 10 * SEC + 3600 * SEC, lastHeartbeatAt: T0 + 10 * SEC });
    expect(L.positionOf(s, c.lease.id)).toBe(1);
    // The released lease is gone from the live list and remembered, with why.
    expect(L.lookup(s, a.lease.id)).toMatchObject({ released: { id: a.lease.id, why: 'released' } });
    expect(L.release(s, a.lease.id, 'released', T0 + 11 * SEC).status).toBe(404);
  });

  test('releasing a WAITER grants nobody and leaves the holder alone', () => {
    let s = L.emptyState();
    const a = grant(s); s = a.state;
    const b = grant(s, {}, T0 + SEC); s = b.state;
    const r = L.release(s, b.lease.id, 'released', T0 + 2 * SEC);
    expect(r.granted).toEqual([]);
    expect(r.state.leases.map((l) => [l.id, l.state])).toEqual([[a.lease.id, 'held']]);
  });
});

test.describe('every way a lease ends (#412)', () => {
  test('TTL expiry releases the holder and grants the waiter; a heartbeat with ttlSec extends it', () => {
    let s = L.emptyState();
    const a = grant(s, { body: { ttlSec: 60, heartbeatSec: 0, holderSessionId: 'aaaaaaaa-0000-4000-8000-000000000001' } }); s = a.state;
    const b = grant(s, { body: { holderSessionId: 'bbbbbbbb-0000-4000-8000-000000000002' } }, T0 + SEC); s = b.state;
    // Not yet.
    expect(L.sweep(s, T0 + 59 * SEC).released).toEqual([]);
    // Extend from t+50 by 60 s -> expires at t+110.
    const hb = L.heartbeat(s, a.lease.id, T0 + 50 * SEC, 60);
    expect(hb.lease.expiresAt).toBe(T0 + 110 * SEC);
    s = hb.state;
    expect(L.sweep(s, T0 + 100 * SEC).released).toEqual([]);
    const w = L.sweep(s, T0 + 110 * SEC);
    expect(w.released.map((r) => [r.id, r.why])).toEqual([[a.lease.id, 'ttl']]);
    expect(w.granted.map((g) => g.id)).toEqual([b.lease.id]);
  });

  test('a heartbeat WITHOUT ttlSec keeps the lease alive but does not extend its TTL', () => {
    const a = grant(L.emptyState(), { body: { ttlSec: 60, heartbeatSec: 10 } });
    const hb = L.heartbeat(a.state, a.lease.id, T0 + 20 * SEC);
    expect(hb.lease.expiresAt).toBe(T0 + 60 * SEC);
    expect(hb.lease.lastHeartbeatAt).toBe(T0 + 20 * SEC);
  });

  test('missed heartbeats (3 intervals) release a holder AND drop a waiter', () => {
    let s = L.emptyState();
    const a = grant(s, { body: { heartbeatSec: 10 } }); s = a.state;
    const b = grant(s, { body: { heartbeatSec: 10 } }, T0); s = b.state;
    const c = grant(s, { body: { heartbeatSec: 10 } }, T0); s = c.state;
    // c keeps beating, a and b go silent.
    s = L.heartbeat(s, c.lease.id, T0 + 25 * SEC).state;
    expect(L.sweep(s, T0 + 30 * SEC).released).toEqual([]); // exactly 3 intervals: not yet
    const w = L.sweep(s, T0 + 31 * SEC);
    expect(w.released.map((r) => [r.id, r.why]).sort()).toEqual([[a.lease.id, 'heartbeat'], [b.lease.id, 'heartbeat']].sort());
    expect(w.granted.map((g) => g.id)).toEqual([c.lease.id]);
  });

  test('heartbeatSec 0 is never timed out by silence (its session vouches for it), only by TTL', () => {
    const a = grant(L.emptyState(), { body: { heartbeatSec: 0, ttlSec: 3600, holderSessionId: 'aaaaaaaa-0000-4000-8000-000000000001' } });
    expect(L.sweep(a.state, T0 + 3599 * SEC).released).toEqual([]);
    expect(L.sweep(a.state, T0 + 3600 * SEC).released.map((r) => r.why)).toEqual(['ttl']);
  });

  test('the holder session ending releases every lease it holds or waits for, on THAT machine only', () => {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
    let s = L.emptyState();
    const a = grant(s, { body: { holderSessionId: sid }, node: 'https://home.example' }); s = a.state;
    const b = grant(s, { body: { resource: 'vm:Y', holderSessionId: 'bbbbbbbb-0000-4000-8000-000000000002' } }); s = b.state;
    const bQueued = grant(s, { body: { resource: 'vm:Y', holderSessionId: sid }, node: 'https://home.example' }); s = bQueued.state;
    const waiter = grant(s, { body: { holderSessionId: 'cccccccc-0000-4000-8000-000000000003' } }); s = waiter.state;
    // The same id on another machine is somebody else: nothing happens.
    expect(L.holderEnded(s, 'self', sid, T0 + SEC).released).toEqual([]);
    const r = L.holderEnded(s, 'https://home.example', sid, T0 + SEC);
    expect(r.released.map((x) => [x.id, x.why]).sort()).toEqual([[a.lease.id, 'holder-ended'], [bQueued.lease.id, 'holder-ended']].sort());
    expect(r.granted.map((g) => g.id)).toEqual([waiter.lease.id]);
  });

  test('a liveness reading releases the holders it does not list - and only a READ list counts', () => {
    const alive = 'aaaaaaaa-0000-4000-8000-000000000001';
    const dead = 'dddddddd-0000-4000-8000-000000000004';
    let s = L.emptyState();
    const a = grant(s, { body: { holderSessionId: dead }, node: 'https://home.example' }); s = a.state;
    const b = grant(s, { body: { resource: 'vm:Y', holderSessionId: alive }, node: 'https://home.example' }); s = b.state;
    const w = grant(s, { body: { holderSessionId: 'cccccccc-0000-4000-8000-000000000003' } }); s = w.state;
    expect(L.liveSessionsByNode(s)).toEqual(new Map([['https://home.example', new Set([dead, alive])], ['self', new Set(['cccccccc-0000-4000-8000-000000000003'])]]));
    const r = L.liveness(s, 'https://home.example', new Set([alive]), T0 + SEC);
    expect(r.released.map((x) => [x.id, x.why])).toEqual([[a.lease.id, 'holder-ended']]);
    expect(r.granted.map((g) => g.id)).toEqual([w.lease.id]);
    // Fail CLOSED: no list (the peer did not answer) releases nobody.
    expect(L.liveness(s, 'https://home.example', null, T0 + SEC).released).toEqual([]);
    // A list read BEFORE the lease was asked for cannot know its (younger) session.
    expect(L.liveness(s, 'https://home.example', new Set([alive]), T0 + SEC, T0 - 1).released).toEqual([]);
  });

  test('resume() after the authority was down restarts every heartbeat clock (holders keep going)', () => {
    const a = grant(L.emptyState(), { body: { heartbeatSec: 10 } });
    // Ten minutes of authority downtime: inside the 1 h TTL, far past 3 x 10 s of heartbeats.
    const later = T0 + 600 * SEC;
    expect(L.sweep(a.state, later).released.map((r) => r.why)).toEqual(['heartbeat']);
    const resumed = L.resume(a.state, later);
    expect(L.sweep(resumed, later + 29 * SEC).released).toEqual([]);
  });
});

test.describe('request validation (#412)', () => {
  test('resource ids are a strict pattern of four kinds', () => {
    for (const ok of ['slot:am8-1', 'vm:AM8-SanityVM', 'controller:172.168.1.20', 'build:adiel-home', 'vm:a_b.c']) {
      expect(L.parseRequest({ resource: ok }, { holderNode: 'self' }).ok, ok).toBe(true);
    }
    for (const bad of ['', 'vm:', 'disk:C', 'vm:../x', 'vm:a b', 'vm:a/b', 'VM:x', 'vm:-x', `vm:${'a'.repeat(65)}`, 42, null, 'vm:x\n', 'vm:x;rm']) {
      expect(L.parseRequest({ resource: bad }, { holderNode: 'self' }).ok, String(bad)).toBe(false);
    }
  });

  test('ttl, heartbeat, session id, role and meta are bounded; junk is refused, never coerced', () => {
    const p = (body, node = 'self') => L.parseRequest({ resource: 'vm:X', ...body }, { holderNode: node });
    expect(p({}).req).toMatchObject({ ttlSec: 3600, heartbeatSec: 60, sessionId: null, role: null, meta: null });
    expect(p({ holderSessionId: 'AAAAAAAA-0000-4000-8000-000000000001' }).req).toMatchObject({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', heartbeatSec: 0 });
    expect(p({ ttlSec: 29 }).ok).toBe(false);
    expect(p({ ttlSec: 86401 }).ok).toBe(false);
    expect(p({ ttlSec: '60' }).ok).toBe(false);
    expect(p({ heartbeatSec: 5 }).ok).toBe(false);
    expect(p({ heartbeatSec: 0 }).ok).toBe(false); // nothing would vouch for it
    expect(p({ holderSessionId: 'nope' }).ok).toBe(false);
    expect(p({ role: 'Release!' }).ok).toBe(false);
    expect(p({ role: 'release' }).req.role).toBe('release');
    expect(p({ meta: 'x' }).ok).toBe(false);
    expect(p({ meta: { wi: 25309 } }).req.meta).toEqual({ wi: 25309 });
    expect(p({ meta: { big: 'x'.repeat(3000) } }).ok).toBe(false);
    expect(L.parseRequest(null, { holderNode: 'self' }).ok).toBe(false);
    // The holder's server name is display text from a request: no line breaks, no bidi.
    const forged = L.parseRequest({ resource: 'vm:X' }, { holderNode: 'self', holderServer: `home\n[leases] granted vm:Y${String.fromCodePoint(0x202e)}` });
    expect(forged.req.server).toBe('home[leases] granted vm:Y');
    expect(L.parseRequest({ resource: 'vm:X' }, { holderNode: 'self', holderServer: 'x'.repeat(100) }).req.server).toHaveLength(64);
  });

  test('a holder the authority cannot check must heartbeat', () => {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
    const r = L.parseRequest({ resource: 'vm:X', holderSessionId: sid }, { holderNode: null });
    expect(r.ok).toBe(true);
    expect(r.req.heartbeatSec).toBe(60);
    expect(L.parseRequest({ resource: 'vm:X', holderSessionId: sid, heartbeatSec: 0 }, { holderNode: null }).ok).toBe(false);
  });

  test('the queue and the table are bounded', () => {
    let s = L.emptyState();
    for (let i = 0; i <= L.LIMITS.maxQueue; i++) s = grant(s, {}, T0 + i).state;
    const over = L.request(s, req(), T0 + 9999, ids);
    expect(over.status).toBe(429);
  });
});

test.describe('reserved resources (#412)', () => {
  const reg = L.registryOf({ 'vm:AM8-SanityVM': { reservedFor: 'release' }, 'vm:ci-vm-1': { neverLease: true } });

  test('a resource reserved for a role is granted only to that role; a never-lease one to nobody', () => {
    expect(reg.ok).toBe(true);
    expect(L.admit('vm:AM8-SanityVM', null, reg.entries)).toMatchObject({ status: 403 });
    expect(L.admit('vm:AM8-SanityVM', 'test', reg.entries)).toMatchObject({ status: 403 });
    expect(L.admit('vm:AM8-SanityVM', 'release', reg.entries)).toBeNull();
    expect(L.admit('vm:ci-vm-1', 'release', reg.entries)).toMatchObject({ status: 403 });
    expect(L.admit('vm:other', null, reg.entries)).toBeNull();
  });

  test('a registry the server cannot read refuses every lease instead of dropping a reservation', () => {
    expect(L.registryOf(undefined)).toMatchObject({ ok: true });
    for (const bad of ['x', [], { 'vm:bad id': {} }, { 'vm:x': { reservedFor: 'Release!' } }, { 'vm:x': { neverLease: 'yes' } }, { 'vm:x': { reservedFor: 'release', typo: 1 } }]) {
      expect(L.registryOf(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

test.describe('the authority (#412)', () => {
  const cluster = [{ name: 'Office', url: 'https://office.example' }, { name: 'home', url: 'https://home.example/' }];

  test('resolved from config: self, a peer by name, the own entry by url, or refused', () => {
    expect(L.resolveAuthority(undefined, cluster, 'https://home.example', 'home')).toEqual({ mode: 'none' });
    expect(L.resolveAuthority({}, cluster, 'https://home.example', 'home')).toEqual({ mode: 'none' });
    expect(L.resolveAuthority({ authority: 'self' }, cluster, null, 'home')).toEqual({ mode: 'self' });
    expect(L.resolveAuthority({ authority: 'office' }, cluster, 'https://home.example', 'home')).toEqual({ mode: 'remote', name: 'Office', url: 'https://office.example' });
    // The same config on Office itself names Office: that is self.
    expect(L.resolveAuthority({ authority: 'office' }, cluster, 'https://office.example/', 'Office')).toEqual({ mode: 'self' });
    expect(L.resolveAuthority({ authority: 'home' }, [], null, 'HOME')).toEqual({ mode: 'self' });
    expect(L.resolveAuthority({ authority: 'nobody' }, cluster, null, 'home').mode).toBe('invalid');
    expect(L.resolveAuthority({ authority: 7 }, cluster, null, 'home').mode).toBe('invalid');
  });

  test('a forwarded holder is checkable only when its url is one of the authority\'s peers', () => {
    expect(L.holderNodeOf(undefined, cluster, 'https://office.example')).toBe('self');
    expect(L.holderNodeOf({ name: 'home', url: 'https://HOME.example' }, cluster, 'https://office.example')).toBe('https://home.example');
    expect(L.holderNodeOf({ name: 'office', url: 'https://office.example/' }, cluster, 'https://office.example')).toBe('self');
    expect(L.holderNodeOf({ name: 'evil', url: 'http://169.254.169.254' }, cluster, 'https://office.example')).toBeNull();
    expect(L.holderNodeOf('junk', cluster, null)).toBeNull();
  });
});

test.describe('state file (#412)', () => {
  test('round-trips, and a damaged file is UNREADABLE rather than an empty table', () => {
    const a = grant(L.emptyState());
    const back = L.parseState(JSON.parse(JSON.stringify(a.state)));
    expect(back).toEqual({ ok: true, state: a.state });
    for (const bad of [null, 'x', [], { version: 1 }, { version: 1, leases: 'x', released: [] }, { version: 1, leases: [{ id: 'x' }], released: [] }, { version: 2, leases: [], released: [] }]) {
      expect(L.parseState(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test('the listing says who holds what, who waits, and for how long', () => {
    let s = L.emptyState();
    s = grant(s, { body: { holderSessionId: 'aaaaaaaa-0000-4000-8000-000000000001', meta: { wi: 1 } } }).state;
    s = grant(s, { node: 'https://home.example', server: 'home' }, T0 + 10 * SEC).state;
    const out = L.listing(s, T0 + 70 * SEC);
    expect(out.resources).toHaveLength(1);
    expect(out.resources[0]).toMatchObject({
      resource: 'vm:X',
      holder: { state: 'held', heldForSec: 70, holder: { server: 'office', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }, meta: { wi: 1 } },
      queue: [{ state: 'queued', position: 1, waitingForSec: 60, holder: { server: 'home', sessionId: null } }],
    });
  });
});

test.describe('admission (#412)', () => {
  const GB = 1024 ** 3;
  const machine = { memory: { availBytes: 8 * GB }, disks: [{ root: 'C:', freeBytes: 50 * GB }, { root: 'D:', freeBytes: 5 * GB }] };

  test('needs are checked against this machine; an unknown reading refuses (fail closed)', () => {
    expect(L.parseNeeds(undefined)).toEqual({ ok: true, needs: null });
    expect(L.parseNeeds({ memGB: -1 }).ok).toBe(false);
    expect(L.parseNeeds({ memGB: 'lots' }).ok).toBe(false);
    expect(L.parseNeeds({ drive: 'C:\\' }).ok).toBe(false);
    expect(L.parseNeeds({ cpu: 4 }).ok).toBe(false);
    const n = (x) => L.parseNeeds(x).needs;
    expect(L.admission(n({ memGB: 4, diskGB: 20 }), machine, 'C:')).toEqual({ ok: true, reasons: [] });
    expect(L.admission(n({ memGB: 16 }), machine, 'C:').ok).toBe(false);
    expect(L.admission(n({ diskGB: 20, drive: 'D:' }), machine, 'C:').reasons[0]).toMatch(/D: has 5\.0 GB free, 20 needed/);
    expect(L.admission(n({ diskGB: 1, drive: 'E:' }), machine, 'C:').ok).toBe(false);
    expect(L.admission(n({ memGB: 1 }), { memory: null, disks: null }, 'C:').reasons[0]).toMatch(/unknown/);
  });
});
