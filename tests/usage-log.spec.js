// #425 - usage logging: hand-off skip reasons, real session cost, viewer time per device,
// and the phone usage snapshot. The server writes the first three for its owner to read
// (never into an agent's context); the snapshot is a script. Pure rules are pinned first;
// then each server-side log is proven end to end against the real test server.
const { test, expect, request: pwRequest } = require('@playwright/test');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BASE, AUTH, authCtx, emptyCwd, readHookToken } = require('./test-helpers');
const usageLog = require('../lib/usage-log');
const snap = require('../scripts/phone-usage-snapshot');

const linesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

test.describe('#425 skip rate limit', () => {
  const T = 1_000_000_000;
  test('the first skip logs; the same reason waits 15 minutes; a changed reason logs at once', () => {
    expect(usageLog.shouldLogSkip(undefined, 'recent', T)).toBe(true);
    const prev = { reason: 'recent', at: T };
    expect(usageLog.shouldLogSkip(prev, 'recent', T + 14 * 60e3)).toBe(false);
    expect(usageLog.shouldLogSkip(prev, 'recent', T + 15 * 60e3)).toBe(true);
    expect(usageLog.shouldLogSkip(prev, 'small', T + 1e3)).toBe(true);
  });
  test('a skip line carries the reason and the numbers, nothing else', () => {
    const r = usageLog.skipRecord({ id: 'i', name: 'n', agent: 'claude', reason: 'no-boundary', source: 'handoffCandidate', ctxTokens: 7, status: 'idle' }, T);
    expect(r).toEqual({ t: new Date(T).toISOString(), event: 'skipped', id: 'i', name: 'n', agent: 'claude', reason: 'no-boundary', source: 'handoffCandidate', status: 'idle', ctxTokens: 7 });
    expect(usageLog.skipRecord({ id: 'i', reason: 'x', source: 's' }, T).ctxTokens).toBeNull();
  });
});

test.describe('#425 cost sampling', () => {
  test('costFields copies primitives as given and nothing else', () => {
    expect(usageLog.costFields({ cost: { total_cost_usd: 1.5, total_duration_ms: 9, nested: { a: 1 }, list: [1], note: 'x' } }))
      .toEqual({ total_cost_usd: 1.5, total_duration_ms: 9, note: 'x' });
    expect(usageLog.costFields({})).toBeNull();
    expect(usageLog.costFields({ cost: {} })).toBeNull();
    expect(usageLog.costFields({ cost: [1] })).toBeNull();
    expect(usageLog.costFields({ cost: { total_cost_usd: Infinity } })).toBeNull();
  });
  test('first sample logs, then every 5 minutes or on a 0.25 USD step; no cost never logs', () => {
    const T = 5_000_000;
    const c = (usd) => ({ total_cost_usd: usd });
    expect(usageLog.shouldLogCost(undefined, c(1), T)).toBe(true);
    expect(usageLog.shouldLogCost({ at: T, usd: 1 }, c(1.1), T + 60e3)).toBe(false);
    expect(usageLog.shouldLogCost({ at: T, usd: 1 }, c(1.25), T + 60e3)).toBe(true);
    expect(usageLog.shouldLogCost({ at: T, usd: 1 }, c(1.01), T + 5 * 60e3)).toBe(true);
    expect(usageLog.shouldLogCost(undefined, null, T)).toBe(false);
  });
  test('costRecord names the model id and the context numbers', () => {
    const r = usageLog.costRecord({ id: 'w', agentSessionId: 'a', cost: { total_cost_usd: 2 }, parsed: { ctxTokens: 10, ctxWindow: 200 }, body: { model: { id: 'claude-x', display_name: 'X' } } }, 0);
    expect(r).toMatchObject({ id: 'w', agentSessionId: 'a', model: 'claude-x', cost: { total_cost_usd: 2 }, ctxTokens: 10, ctxWindow: 200 });
  });
});

test.describe('#425 bounded append', () => {
  test('rolls over to <file>.1 past the cap and never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-usage-'));
    const file = path.join(dir, 'sub', 'x.jsonl');
    try {
      for (let i = 0; i < 6; i++) { usageLog.appendRecord(file, { i, pad: 'x'.repeat(40) }, 200); await sleep(50); }
      await until(() => fs.existsSync(`${file}.1`) && linesOf(file).length > 0, 'a rollover');
      await sleep(100);
      const all = [...linesOf(`${file}.1`), ...linesOf(file)];
      expect(all.map((r) => r.i)).toEqual([...Array(6).keys()].slice(-all.length));
      expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
      fs.writeFileSync(path.join(dir, 'blocker'), '');
      expect(() => usageLog.appendRecord(path.join(dir, 'blocker', 'a.jsonl'), { a: 1 })).not.toThrow(); // a file used as a directory
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test.describe('#425 viewer lines', () => {
  test('a view line has the event, session, mode, client and server - no content', () => {
    expect(usageLog.viewRecord('detach', { id: 's', mode: 'active', src: '192.0.2.1', server: 'srv', ms: 5 }, 0))
      .toEqual({ t: new Date(0).toISOString(), event: 'detach', id: 's', mode: 'active', src: '192.0.2.1', server: 'srv', ms: 5 });
    expect(usageLog.viewRecord('attach', { id: 's', mode: 'background', src: 'local', server: 'srv' }, 0)).not.toHaveProperty('ms');
  });
});

const DUMP = [
  '  Last 24 hour events (timeRange="11/4/2026, 14:35 – 11/5/2026, 14:35" )',
  '    time="2026-11-05 12:37:47" type=ACTIVITY_RESUMED package=com.example.other',
  '  In-memory daily stats',
  '  timeRange="11/5/2026, 00:13 – 14:35" ',
  '    packages',
  '      package=com.example.idle totalTimeUsed="00:00" lastTimeUsed="1970-01-01 02:00:00" totalTimeVisible="00:00" appLaunchCount=0',
  '      package=com.example.app totalTimeUsed="30:45" lastTimeUsed="2026-11-05 12:48:56" totalTimeVisible="1:02:03" lastTimeVisible="x" appLaunchCount=10 ',
  '    event aggregations',
  '      screen-interactive: 45x for "4:22:48" (now running, started at )',
  '  In-memory weekly stats',
  '  timeRange="10/30/2026, 00:10 – 11/5/2026, 14:35" ',
  '      package=com.example.app totalTimeUsed="99:59" totalTimeVisible="99:59" appLaunchCount=99',
  '      screen-interactive: 482x for "32:38:38"',
].join('\n');

test.describe('#425 phone usage snapshot', () => {
  test('durations: mm:ss and h:mm:ss', () => {
    expect(snap.parseDuration('30:45')).toBe(1845000);
    expect(snap.parseDuration('4:22:48')).toBe(15768000);
    expect(snap.parseDuration('00:00')).toBe(0);
    expect(snap.parseDuration('soon')).toBeNull();
  });
  test('the day is read against the device date, M/D or D/M, else refused', () => {
    expect(snap.dayOfRange('11/5/2026, 00:13 – 14:35', '2026-11-05')).toBe('2026-11-05');
    expect(snap.dayOfRange('5/11/2026, 00:13', '2026-11-05')).toBe('2026-11-05');
    expect(snap.dayOfRange('11/5/2026, 00:13', '2026-11-06')).toBeNull();
    expect(snap.dayOfRange('nonsense', '2026-11-05')).toBeNull();
  });
  test('only the DAILY block counts, and only the named package', () => {
    expect(snap.parseUsageStats(DUMP, 'com.example.app', '2026-11-05')).toEqual({
      day: '2026-11-05', package: 'com.example.app', usedMs: 1845000, visibleMs: 3723000, launches: 10, screenOnMs: 15768000 });
  });
  test('it refuses instead of writing a guessed zero', () => {
    expect(() => snap.parseUsageStats(DUMP, 'com.example.absent', '2026-11-05')).toThrow(/no usage entry/);
    expect(() => snap.parseUsageStats('nothing', 'com.example.app', '2026-11-05')).toThrow(/daily stats/);
    expect(() => snap.parseUsageStats(DUMP, 'com.example.app', '2026-11-09')).toThrow(/device date/);
    expect(() => snap.parseUsageStats(DUMP.replace('"1:02:03"', '"??"'), 'com.example.app', '2026-11-05')).toThrow(/durations/);
  });
  test('upsert replaces the same device, day and package and keeps the rest', () => {
    const a = { device: 'd', day: '2026-11-05', package: 'p', usedMs: 1 };
    const other = JSON.stringify({ device: 'd', day: '2026-11-04', package: 'p', usedMs: 9 });
    const first = snap.upsertLines([other], a);
    const again = snap.upsertLines(first, { ...a, usedMs: 2 });
    expect(again.map((l) => JSON.parse(l).usedMs)).toEqual([9, 2]);
    expect(snap.upsertLines(['not json'], a)).toHaveLength(2);
  });
  test('the default package is the companion applicationId', () => {
    expect(snap.defaultPackage()).toMatch(/^[a-z][\w.]+$/i);
  });
  test('an unreachable adb aborts with a message and writes nothing', async () => {
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-phone-'));
    const out = path.join(dir, 'p.jsonl');
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'phone-usage-snapshot.js'),
        '--device', '192.0.2.1:5555', '--adb', path.join(dir, 'no-such-adb'), '--out', out], { encoding: 'utf8', windowsHide: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('phone-usage-snapshot:');
      expect(fs.existsSync(out)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test.describe('#425 server logs', () => {
  test.setTimeout(120000);

  test('attach, a real mode switch and detach are logged with the forwarded client and no content', async () => {
    const file = process.env.WT_DEVICE_VIEWS_FILE;
    expect(file, 'playwright.config.js must redirect the device-views log').toBeTruthy();
    const ctx = await authCtx();
    let id;
    try {
      id = (await (await ctx.post('/api/sessions', { data: { name: 'views-425', cwd: emptyCwd('views-425') } })).json()).id;
      const login = await fetch(`${BASE}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }), redirect: 'manual' });
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie, 'x-forwarded-for': '203.0.113.9' } });
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ mode: 'background', browserId: 'v425' })); // no change: not a line
      ws.send(JSON.stringify({ mode: 'active', browserId: 'v425' }));
      ws.send('secret-425-keystrokes');
      const mine = () => linesOf(file).filter((l) => l.id === id);
      await until(() => mine().some((l) => l.event === 'mode'), 'the mode line');
      ws.send(JSON.stringify({ mode: 'background', browserId: 'v425' }));
      await until(() => mine().filter((l) => l.event === 'mode').length === 2, 'the second mode line');
      ws.close();
      await until(() => mine().some((l) => l.event === 'detach'), 'the detach line');
      const got = mine();
      expect(got.map((l) => `${l.event}:${l.mode}`)).toEqual(['attach:background', 'mode:active', 'mode:background', 'detach:background']);
      for (const l of got) {
        expect(l.src).toBe('203.0.113.9');
        expect(typeof l.server).toBe('string');
        expect(Number.isNaN(Date.parse(l.t))).toBe(false);
      }
      expect(Number.isFinite(got[3].ms)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('secret-425');
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('a statusLine post writes one cost line; a repeat is held back; a big step writes another', async () => {
    const file = process.env.WT_SESSION_COST_FILE;
    expect(file, 'playwright.config.js must redirect the session-cost log').toBeTruthy();
    const ctx = await authCtx();
    let id;
    try {
      id = (await (await ctx.post('/api/sessions', { data: { name: 'cost-425', cwd: emptyCwd('cost-425') } })).json()).id;
      const conv = crypto.randomUUID();
      const hook = await pwRequest.newContext({ baseURL: BASE });
      const h = await hook.post('/api/hook', { data: { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'secret-425-prompt' },
        headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
      expect(h.status()).toBe(200);
      await hook.dispose();
      const post = async (usd) => (await ctx.post('/api/claude-status', { data: {
        session_id: conv, model: { id: 'claude-test-425', display_name: 'T' }, cost: { total_cost_usd: usd, total_duration_ms: 1234 },
        context_window: { context_window_size: 200000, total_input_tokens: 4321, used_percentage: 2 } } })).status();
      const mine = () => linesOf(file).filter((l) => l.agentSessionId === conv);
      expect(await post(1.0)).toBe(200);
      await until(() => mine().length === 1, 'the first cost line');
      expect(await post(1.05)).toBe(200);
      await sleep(600);
      expect(mine()).toHaveLength(1);
      expect(await post(1.5)).toBe(200);
      await until(() => mine().length === 2, 'the stepped cost line');
      expect(mine()[1]).toMatchObject({ id, model: 'claude-test-425', cost: { total_cost_usd: 1.5, total_duration_ms: 1234 }, ctxTokens: 4321, ctxWindow: 200000 });
      expect(fs.readFileSync(file, 'utf8')).not.toContain('secret-425');
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('an idle Claude session the scan passes over is logged with the gate that said no, once', async () => {
    const file = process.env.WT_HANDOFF_SKIPS_FILE;
    expect(file, 'playwright.config.js must redirect the hand-off skips log').toBeTruthy();
    const cfgFile = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
    const before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    fs.writeFileSync(cfgFile, JSON.stringify({ ...(before ? JSON.parse(before) : {}), handoff: { autoEveryMs: 300 } }, null, 2));
    const ctx = await authCtx();
    const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
    let id;
    try {
      const r = await ctx.post('/api/sessions', { data: { name: 'skip-425', agent: 'claude', autoCommand: LAUNCH } });
      id = (await r.json()).id;
      const rowOf = async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
      await until(async () => (await rowOf())?.agentReady === true, 'the session to be ready');
      const conv = crypto.randomUUID();
      const hook = await pwRequest.newContext({ baseURL: BASE });
      const send = (event) => hook.post('/api/hook', { data: { hook_event_name: event, session_id: conv, prompt: 'work' },
        headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
      expect((await send('UserPromptSubmit')).status()).toBe(200);
      expect((await send('Stop')).status()).toBe(200);
      await hook.dispose();
      expect((await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 80 } } })).status()).toBe(200);
      await until(async () => (await rowOf())?.status === 'idle', 'the session to go idle');
      // The reason is the one the board shows for the same session (handoffCandidate's own answer).
      const why = (await rowOf()).handoff.why;
      expect(why).toBeTruthy();
      const mine = () => linesOf(file).filter((l) => l.id === id && l.source === 'handoffCandidate');
      const line = await until(() => mine()[0], 'a skip line', 30000);
      expect(line).toMatchObject({ event: 'skipped', reason: why, agent: 'claude', status: 'idle', ctxTokens: 800000 });
      await sleep(3000); // ten more scans: the same reason is not written again
      expect(mine().filter((l) => l.reason === why)).toHaveLength(1);
    } finally {
      if (before === null) { try { fs.unlinkSync(cfgFile); } catch {} } else fs.writeFileSync(cfgFile, before);
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });
});
