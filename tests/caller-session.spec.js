// #377 - an agent that opens a session and names no parent is traced to the session it
// runs in, through the process on the other end of the request. The rules (netstat line,
// ancestor walk, pid -> session) are pure and pinned here; the last test drives the real
// thing: curl, typed into a real PTY session, opens a session and must come out as its
// child without ever saying so.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, AUTH } = require('./test-helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/caller-session');
const { createSpawnStore } = require('../lib/spawn-store');

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:7681           0.0.0.0:0              LISTENING       100',
  '  TCP    127.0.0.1:7681         127.0.0.1:50001        ESTABLISHED     100',
  '  TCP    127.0.0.1:50001        127.0.0.1:7681         ESTABLISHED     4242',
  '  TCP    127.0.0.1:50002        127.0.0.1:7681         TIME_WAIT       0',
  '  TCP    [::1]:50003            [::1]:7681             ESTABLISHED     5353',
  '  TCP    192.0.2.10:50004       198.51.100.20:7681    ESTABLISHED     6464',
  '  TCP    127.0.0.1:50005        127.0.0.1:7681         HERGESTELLT     7575',
  '  UDP    127.0.0.1:50006        *:*                                    8686',
].join('\r\n');

test.describe('#377 netstatOwner - the process on the CLIENT end', () => {
  test('finds the client end, not the server end of the same connection', () => {
    expect(C.netstatOwner(NETSTAT, 50001, 7681)).toBe(4242);
  });
  test('IPv6 loopback too (listed now that the IPv4-only `-p TCP` filter is gone)', () => {
    expect(C.netstatOwner(NETSTAT, 50003, 7681)).toBe(5353);
  });
  test('the state word is never read - Windows translates it (German: HERGESTELLT)', () => {
    expect(C.netstatOwner(NETSTAT, 50005, 7681)).toBe(7575);
  });
  test('only a loopback-to-loopback connection: the same ports to another machine do not count', () => {
    expect(C.netstatOwner(NETSTAT, 50004, 7681)).toBeNull();
  });
  test('a closed connection, another port, or nothing at all is no owner', () => {
    expect(C.netstatOwner(NETSTAT, 50002, 7681)).toBeNull();
    expect(C.netstatOwner(NETSTAT, 50001, 9999)).toBeNull();
    expect(C.netstatOwner('', 50001, 7681)).toBeNull();
  });
});

test.describe('#377 chainFrom - the caller and its ancestors', () => {
  const p = (pid, ppid, startMs) => ({ pid, ppid, startMs, name: 'x' });

  test('walks up to the root, caller first', () => {
    const procs = [p(1, 0, 100), p(2, 1, 200), p(3, 2, 300), p(4, 3, 400)];
    expect(C.chainFrom(4, procs)).toEqual([4, 3, 2, 1]);
  });

  test('stops at a "parent" that started after its child - a reused pid, not a parent', () => {
    // 7 is the session shell; 9 inherited a DEAD parent's pid 8, now reused by an
    // unrelated process born later that happens to hang under the session.
    const procs = [p(7, 0, 100), p(8, 7, 900), p(9, 8, 500)];
    expect(C.chainFrom(9, procs)).toEqual([9]);
  });

  test('a loop or an unknown pid ends the walk; depth is capped', () => {
    expect(C.chainFrom(1, [p(1, 2, 100), p(2, 1, 100)])).toEqual([1, 2]);
    expect(C.chainFrom(5, [p(1, 0, 1)])).toEqual([]);
    const deep = Array.from({ length: 40 }, (_, i) => p(i + 1, i, 1));
    expect(C.chainFrom(40, deep)).toHaveLength(C.MAX_DEPTH);
  });
});

test.describe('#377 sessionInChain + callerSession', () => {
  const sessions = [{ id: 'sess-a', pid: 3 }, { id: 'sess-b', pid: 1 }, { id: 'no-pid' }];

  test('the NEAREST session on the chain wins', () => {
    expect(C.sessionInChain([4, 3, 2, 1], sessions)).toBe('sess-a');
    expect(C.sessionInChain([9, 8], sessions)).toBeNull();
  });

  test.afterEach(() => C._setIoForTests(null));

  test('a loopback request is traced; the snapshot asked for is a fresh one', async () => {
    const asked = [];
    C._setIoForTests({
      netstat: async () => NETSTAT,
      snapshot: async (opts) => { asked.push(opts); return [{ pid: 4242, ppid: 3, startMs: 5 }, { pid: 3, ppid: 0, startMs: 1 }]; },
    });
    const id = await C.callerSession({ remoteAddress: '127.0.0.1', remotePort: 50001, localPort: 7681 }, sessions);
    expect(id).toBe('sess-a');
    expect(asked).toEqual([{ maxAgeMs: 0 }]);
  });

  test('a snapshot that predates the caller is retried once', async () => {
    let n = 0;
    C._setIoForTests({
      netstat: async () => NETSTAT,
      snapshot: async () => (++n === 1 ? [{ pid: 3, ppid: 0, startMs: 1 }] : [{ pid: 4242, ppid: 3, startMs: 5 }, { pid: 3, ppid: 0, startMs: 1 }]),
    });
    expect(await C.callerSession({ remoteAddress: '::ffff:127.0.0.1', remotePort: 50001, localPort: 7681 }, sessions)).toBe('sess-a');
    expect(n).toBe(2);
  });

  test('a remote caller is never traced, and nothing is queried for it', async () => {
    let called = false;
    C._setIoForTests({ netstat: async () => { called = true; return NETSTAT; }, snapshot: async () => [] });
    expect(await C.callerSession({ remoteAddress: '198.51.100.20', remotePort: 50001, localPort: 7681 }, sessions)).toBeNull();
    expect(called).toBe(false);
  });

  test('a failing query is no parent, never an error', async () => {
    C._setIoForTests({ netstat: async () => { throw new Error('boom'); }, snapshot: async () => [] });
    expect(await C.callerSession({ remoteAddress: '127.0.0.1', remotePort: 50001, localPort: 7681 }, sessions)).toBeNull();
  });
});

test.describe('#377 spawn-store setParent - a traced parent joins the record later', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const P = '22222222-2222-4222-8222-222222222222';
  const Q = '33333333-3333-4333-8333-333333333333';
  let file;
  test.beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-377-')), 'spawned.json'); });

  test('fills an empty parent on a pending record, and the row shows it', () => {
    const st = createSpawnStore({ file, log: () => {} });
    st.created(A, 'bh lead', null);
    expect(st.setParent(A, P.toUpperCase())).toBe(true);
    expect(st.field(A)).toMatchObject({ spawnedBy: 'bh lead', parentId: P });
  });

  test('never replaces a parent the caller named, or one already set', () => {
    const st = createSpawnStore({ file, log: () => {} });
    st.created(A, 'x', P);
    expect(st.setParent(A, Q)).toBe(false);
    expect(st.field(A).parentId).toBe(P);
  });

  test('a decided (on-disk) record is filled too, and it survives a reload', () => {
    let t = 1_000_000;
    const now = () => t;
    const st = createSpawnStore({ file, classifyMs: 10, now, log: () => {} });
    st.created(A, 'x', null);
    t += 1000;
    expect(st.metaOf(A).by).toBe('agent');
    expect(st.setParent(A, P)).toBe(true);
    expect(createSpawnStore({ file, classifyMs: 10, now, log: () => {} }).field(A).parentId).toBe(P);
  });

  test('junk, itself, or an unknown session is refused', () => {
    const st = createSpawnStore({ file, log: () => {} });
    st.created(A, 'x', null);
    expect(st.setParent(A, 'not-an-id')).toBe(false);
    expect(st.setParent(A, A)).toBe(false);
    expect(st.setParent(Q, P)).toBe(false);
    expect(st.field(A).parentId).toBeNull();
  });
});

test.describe('#377 against the real server', () => {
  test.skip(process.platform !== 'win32', 'the trace reads Windows netstat and process tables');
  test.setTimeout(90000);

  test('curl run INSIDE a session opens one with spawnedBy and no parentId -> it is that session\'s child', async () => {
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    expect(cookie).toMatch(/=/);
    const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: cookie, Connection: 'close' } });
    const made = [];
    try {
      // Typed into a session's own shell, so the request comes from a process INSIDE it.
      // One curl per session: autoCommand is capped at 500 characters, and a cut command
      // leaves an open quote that bash waits on forever.
      const curl = (body) => `curl.exe -s -o /dev/null -X POST -H 'Cookie: ${cookie}' -H 'Content-Type: application/json' --data '${JSON.stringify(body)}' ${BASE}/api/sessions`;
      const openFrom = async (body, done = (r) => !!r.spawn) => {
        const cmd = curl(body);
        expect(cmd.length).toBeLessThanOrEqual(500);
        const tr = await ctx.post('/api/sessions', { data: { name: `pt-tracer-${Date.now()}`, autoCommand: cmd } });
        expect(tr.status()).toBe(200);
        const tracer = (await tr.json()).id;
        made.push(tracer);
        let row = null;
        // The row is listed as soon as the worker has it; its spawn record follows, and a
        // traced parent joins that record when the trace answers (~0.5s later).
        for (let i = 0; i < 60 && !(row && done(row)); i++) {
          row = (await (await ctx.get('/api/sessions')).json()).find((s) => s.name === body.name) || null;
          if (!(row && done(row))) await new Promise((r) => setTimeout(r, 500));
        }
        expect(row, `the session the curl asked for (${body.name}) was created`).not.toBeNull();
        made.push(row.id);
        return { tracer, row };
      };

      const { tracer, row: child } = await openFrom(
        { name: `pt-traced-${Date.now()}`, spawnedBy: 'pt-tracer' },
        (r) => !!(r.spawn && r.spawn.parentId),
      );
      expect(child.spawn).toMatchObject({ spawnedBy: 'pt-tracer', parentId: tracer });

      // Without `spawnedBy` nothing is traced: only an agent that says who it is gets a parent.
      const { row: plain } = await openFrom({ name: `pt-plain-${Date.now()}` });
      // Give a (wrongly) started trace time to land before asserting there is none.
      await new Promise((r) => setTimeout(r, C.TRACE_WAIT_MS + 1000));
      const again = (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === plain.id);
      expect(again.spawn.parentId).toBeNull();
    } finally {
      for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });
});
