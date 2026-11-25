// @ts-check
// #529 - GET /api/usage-ledger end to end: real servers, each with its OWN ledger and roll-up files
// (the suite's server reads none: under WT_TEST the route reports nothing unless a spec names the
// files). The files hold the real record shapes claude-memory's usage-monitor.js writes.
//   - behind auth like the rest of /api, advertised as a capability;
//   - the report of one machine: weekly totals, the rank, why each is big;
//   - a row links to the session where it still exists, and says nothing of one that is gone;
//   - the ledger is followed as it grows (a line appended after the first look shows up);
//   - ?cluster=1: the peers' reports merge in; a peer too old for the route is SKIPPED (named, not
//     an error), one that cannot be asked is named as unreachable, and no peer is asked to merge
//     (no loop).
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emptyCwd } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
async function until(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

/** Boot one isolated server in [dir] on [port]; [env] adds its ledger files. */
async function startServer(dir, port, label, env) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const suffix = crypto.randomUUID().slice(0, 8);
  const f = (name) => path.join(dir, name);
  const full = {
    ...process.env, WT_TEST: '1', WT_CONFIG_FILE: f('config.json'), WT_PORT: String(port), WT_HOST: '127.0.0.1',
    WT_USER: 'testuser', WT_PASS: 'testpass:colon',
    WT_SPAWN_WORKER: '1', WT_WORKER_DATA_DIR: dataDir, WT_WORKER_QUIET: '1', WT_WORKER_NO_DEFAULT: '1',
    WT_WORKER_PIPE: process.platform === 'win32' ? `\\\\.\\pipe\\wt-529-${label}-${suffix}` : `/tmp/wt-529-${label}-${suffix}.sock`,
    WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
    WT_API_TOKENS_FILE: f('api-tokens.json'), WT_CLUSTER_TOKENS_FILE: f('cluster-tokens.json'),
    WT_LEASES_FILE: f('leases.json'), WT_LEASE_RECORDS_FILE: f('lease-records.json'),
    WT_SESSION_BRIEFS_FILE: f('briefs.json'), WT_SPAWNED_SESSIONS_FILE: f('spawned.json'),
    WT_MAINTENANCE_FILE: f('maintenance.json'), WT_DEVICE_OPS_FILE: f('device-ops.jsonl'),
    WT_CLAUDE_METRICS_FILE: f('metrics.json'), WT_HANDOFF_DIR: f('handoffs'), ...env,
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: full, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try { if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    try { proc.kill(); } catch { /* gone */ }
    await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(r, 3000); } });
  };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode !== null) break;
    try {
      const probe = await pwRequest.newContext({ baseURL: base });
      const r = await probe.get('/login', { timeout: 2000 });
      await probe.dispose();
      if (r.status() < 500) return { base, stop, log: () => out };
    } catch { /* not listening yet */ }
  }
  await stop();
  throw new Error(`isolated server ${label} never answered on ${base}:\n${out.slice(0, 2000)}`);
}

const bearer = (base, token) => pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const line = (o) => `${JSON.stringify(o)}\n`;
const READS = 'cache reads (long contexts)';

/** One window line, `minAgo` minutes back. Its running day total is 0, so the day it falls on (which
 *  may be yesterday just after midnight) adds nothing to a week: the weekly totals come from the roll-up. */
const win = (machine, minAgo, windowM, kind, model, top) => ({
  at: new Date(Date.now() - minAgo * 60e3).toISOString(), machine, windowMin: 30, windowM, dayM: 0, out: 400000, cr: 50e6, cw: 2e6,
  model: { name: model, pct: 70 }, kind: { name: kind, pct: 55 }, top, alerts: [], rolledUp: 0,
});
/** A finished day, `ago` days back (>= 2 so it is a finished day in every timezone). */
const day = (machine, ago, unitsM) => ({
  day: ymd(Date.now() - ago * 864e5), machine, calls: 400, sessions: 2, unitsM, subagentUnitsM: 8.1,
  tokM: { in: 0, out: 0.4, cr: 77.3, cw: 3.3, cw1h: 0.9 }, model: { 'opus-5-5': { calls: 428, units: unitsM * 0.9 } }, cls: { human: { calls: 299, units: 8.1 } },
  wake: { n: 3, unitsM: 1.3, cwTokM: 0.6, perWakeK: 216, byCause: { human: { n: 3, units: 1.3 } } },
});

test.describe.serial('usage ledger route, one machine and a cluster (#529)', () => {
  test.setTimeout(120000);
  const portA = 18100 + Math.floor(Math.random() * 20);
  const portB = portA + 25;
  const portOld = portA + 50;
  const portDead = portA + 75;
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const urlOld = `http://127.0.0.1:${portOld}`;
  const urlDead = `http://127.0.0.1:${portDead}`;
  const tokA = crypto.randomBytes(32).toString('hex');
  const tokB = crypto.randomBytes(32).toString('hex');
  let dirA; let dirB; let A; let B; let a; let b; let old; let ledgerA; let ledgerB;
  const asked = []; // what the fake old peer was asked

  test.beforeAll(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wt529-A-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wt529-B-'));
    // A server from before #529: it has no such route, so it answers 404 (and records what it was asked).
    old = http.createServer((req, res) => { asked.push(req.url); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); });
    await new Promise((r) => old.listen(portOld, '127.0.0.1', r));
    ledgerA = path.join(dirA, 'usage-ledger.jsonl');
    ledgerB = path.join(dirB, 'usage-ledger.jsonl');
    fs.writeFileSync(ledgerA, line(win('alpha', 100, 12, READS, 'opus-5', [{ id: 'a1a1a1a1', M: 9 }, { id: 'a2a2a2a2', M: 2 }])) + line(win('alpha', 70, 4, READS, 'opus-5', [{ id: 'a1a1a1a1', M: 3 }])));
    fs.writeFileSync(path.join(dirA, 'usage-rollup.jsonl'), line(day('alpha', 2, 100)) + line(day('alpha', 3, 50)));
    fs.writeFileSync(ledgerB, line(win('bravo', 90, 20, 'cache writes (cold starts)', 'sonnet-5-5', [{ id: 'b1b1b1b1', M: 15 }])));
    fs.writeFileSync(path.join(dirB, 'usage-rollup.jsonl'), line(day('bravo', 2, 70)));
    const cluster = [{ name: 'alpha', url: urlA }, { name: 'bravo', url: urlB }, { name: 'oldie', url: urlOld }, { name: 'ghost', url: urlDead }];
    const cfg = (name, url, peers) => JSON.stringify({ serverName: name, publicUrl: url, cluster: peers });
    fs.writeFileSync(path.join(dirA, 'config.json'), cfg('alpha', urlA, cluster));
    fs.writeFileSync(path.join(dirB, 'config.json'), cfg('bravo', urlB, cluster.slice(0, 2)));
    const tokens = (t) => JSON.stringify({ [t]: { label: 'usage-spec', created: Date.now(), expires: Date.now() + 3600e3 } });
    fs.writeFileSync(path.join(dirA, 'api-tokens.json'), tokens(tokA));
    fs.writeFileSync(path.join(dirB, 'api-tokens.json'), tokens(tokB));
    const peer = (token, name) => ({ token, name, authenticated: Date.now() });
    fs.writeFileSync(path.join(dirA, 'cluster-tokens.json'), JSON.stringify({ [urlB]: peer(tokB, 'bravo'), [urlOld]: peer('x'.repeat(64), 'oldie'), [urlDead]: peer('y'.repeat(64), 'ghost') }));
    fs.writeFileSync(path.join(dirB, 'cluster-tokens.json'), JSON.stringify({ [urlA]: peer(tokA, 'alpha') }));
    [A, B] = await Promise.all([
      startServer(dirA, portA, 'a', { WT_USAGE_LEDGER_FILE: ledgerA, WT_USAGE_ROLLUP_FILE: path.join(dirA, 'usage-rollup.jsonl') }),
      startServer(dirB, portB, 'b', { WT_USAGE_LEDGER_FILE: ledgerB, WT_USAGE_ROLLUP_FILE: path.join(dirB, 'usage-rollup.jsonl') }),
    ]);
    a = await bearer(A.base, tokA);
    b = await bearer(B.base, tokB);
  });
  test.afterAll(async () => {
    for (const c of [a, b]) { try { await c.dispose(); } catch { /* gone */ } }
    for (const s of [A, B]) { try { await s.stop(); } catch { /* gone */ } }
    try { old.close(); } catch { /* gone */ }
    for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  test('it is behind auth, and the server advertises it', async () => {
    const anon = await pwRequest.newContext({ baseURL: A.base });
    const r = await anon.get('/api/usage-ledger');
    expect(r.status()).toBe(401);
    expect(await r.text()).not.toContain('a1a1a1a1');
    await anon.dispose();
    expect((await (await a.get('/api/version')).json()).capabilities).toContain('usage-ledger');
  });

  test('one machine: the weekly totals, the rank and why each session is big', async () => {
    const r = await a.get('/api/usage-ledger');
    expect(r.status()).toBe(200);
    const rep = await r.json();
    expect(rep).toMatchObject({ version: 1, machine: 'alpha', days: 7 });
    expect(rep.machines).toBeUndefined();     // no cluster merge unless asked
    expect(rep.basis).toMatchObject({ sessionsAreLowerBound: true, topPerWindow: 3 });
    expect(rep.coverage.windows).toBe(2);
    // The two finished days (100 + 50) land in their week(s); the total over the weeks is exact.
    expect(rep.weeks.reduce((n, w) => n + w.unitsM, 0)).toBe(150);
    expect(rep.sessions.map((s) => s.id)).toEqual(['a1a1a1a1', 'a2a2a2a2']);
    expect(rep.sessions[0]).toMatchObject({ unitsM: 12, windows: 2, machine: 'alpha', sessionId: null, name: null });
    expect(rep.sessions[0].why.map((w) => w.code)).toContain('context-reread');
    expect(rep.sessions[1].why[0].code).toBe('unexplained'); // it shared a window it did not dominate
  });

  test('bad query parameters are refused, naming the parameter', async () => {
    for (const q of ['days=0', 'days=36', 'weeks=abc', 'top=51']) {
      const r = await a.get(`/api/usage-ledger?${q}`);
      expect(r.status(), q).toBe(400);
      expect((await r.json()).error).toContain(q.split('=')[0]);
    }
    expect((await (await a.get('/api/usage-ledger?top=1')).json()).sessions).toHaveLength(1);
  });

  test('a check-in line links to its session while it exists and is still listed, unlinked, after it ends', async () => {
    const created = await a.post('/api/sessions', { data: { name: 'usage-spec-session', cwd: emptyCwd('usage529'), autoCommand: '' } });
    expect(created.ok(), await created.text()).toBe(true);
    const sid = (await created.json()).id;
    fs.appendFileSync(ledgerA, line({ at: new Date().toISOString(), machine: 'alpha', event: 'check-in', decision: 'woken', by: 'rule', id: sid.slice(0, 8), why: 'idle', n: 1, idleMin: 130, ctxK: 540 }));
    const find = async () => (await (await a.get('/api/usage-ledger')).json()).checkIns.sessions.find((s) => s.id === sid.slice(0, 8));
    const linked = await until(async () => { const r = await find(); return r && r.sessionId ? r : null; }, 8000);
    expect(linked).toMatchObject({ sessionId: sid, name: 'usage-spec-session', woken: 1, maxCtxK: 540, maxIdleMin: 130, machine: 'alpha' });
    expect((await a.delete(`/api/sessions/${sid}`)).ok()).toBe(true);
    const gone = await until(async () => { const r = await find(); return r && r.sessionId === null ? r : null; }, 8000);
    expect(gone).toMatchObject({ woken: 1, sessionId: null });
  });

  test('the ledger is followed as it grows: a window appended after the first look is in the next report', async () => {
    const before = await (await a.get('/api/usage-ledger')).json();
    expect(before.sessions.map((s) => s.id)).not.toContain('a3a3a3a3');
    fs.appendFileSync(ledgerA, line(win('alpha', 5, 30, READS, 'opus-5', [{ id: 'a3a3a3a3', M: 25 }])));
    const after = await until(async () => { const r = await (await a.get('/api/usage-ledger')).json(); return r.sessions.some((s) => s.id === 'a3a3a3a3') ? r : null; }, 8000);
    expect(after.sessions[0]).toMatchObject({ id: 'a3a3a3a3', unitsM: 25 });
    expect(after.coverage.windows).toBe(before.coverage.windows + 1);
  });

  test('?cluster=1: the peers\' reports merge in; a peer too old for the route is skipped, one that cannot be asked is named', async () => {
    const r = await a.get('/api/usage-ledger?cluster=1');
    expect(r.status()).toBe(200);
    const rep = await r.json();
    expect(rep.machines).toEqual(['alpha', 'bravo']);
    // Sessions of both machines rank together and keep the machine they came from.
    const rows = rep.sessions.map((s) => `${s.machine}:${s.id}`);
    expect(rows).toContain('bravo:b1b1b1b1');
    expect(rows).toContain('alpha:a1a1a1a1');
    expect(rows.indexOf('alpha:a3a3a3a3')).toBeLessThan(rows.indexOf('bravo:b1b1b1b1')); // 25M > 15M
    expect(rep.weeks.reduce((n, w) => n + w.unitsM, 0)).toBe(220); // 100 + 50 (alpha) + 70 (bravo)
    // The old peer is SKIPPED with a reason; it is not an error and not "unreachable".
    expect(rep.skipped).toEqual([{ machine: 'oldie', reason: expect.stringContaining('older version') }]);
    expect(rep.unreachable).toEqual(['ghost']);
    // No peer was asked to merge in its turn: the old peer's request carries no `cluster`.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => u.startsWith('/api/usage-ledger?') && !u.includes('cluster'))).toBe(true);
    // The same question put to the peer with ?cluster=1 does not loop back into a hang: it answers.
    const fromB = await b.get('/api/usage-ledger?cluster=1');
    expect(fromB.status()).toBe(200);
    expect((await fromB.json()).machines.sort()).toEqual(['alpha', 'bravo']);
  });
});
