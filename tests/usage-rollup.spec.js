// @ts-check
// #56 — the 5h / 7d capacity windows are ACCOUNT-wide, not per-session.
//
// Every session on a server reports the same pair of numbers (same account), so they are
// rolled up ONCE, SERVER-SIDE, onto the server entry of /api/cluster/sessions — one field,
// two renderers. These specs pin the contract the sidebars read:
//   * the roll-up appears after a report lands, per AGENT (Claude and Codex bill separate
//     quotas and are never merged into one number);
//   * a report older than the metrics TTL is not exposed at all — unknown renders as
//     NOTHING, never as 0%;
//   * a server with nothing to report carries no `usage` block (not a block full of zeros);
//   * it is behind auth like the rest of the cluster API.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BASE, authCtx, noAuthCtx, loginPage, codexSessionsRoot } = require('./test-helpers');
const { rollUpUsage, METRICS_TTL_MS, CLOCK_SKEW_TOLERANCE_MS } = require('../lib/usage-rollup');

// ============================================================
// The rule itself (pure) — lib/usage-rollup.js
// ============================================================
test.describe('usage roll-up (pure)', () => {
  const fresh = (over = {}) => ({ metrics: { agent: 'claude', fiveH: 42, sevenD: 18, ts: Date.now(), ...over } });

  test('rolls the freshest report per agent up onto one block', () => {
    const now = Date.now();
    const u = rollUpUsage([
      fresh({ fiveH: 10, sevenD: 5, ts: now - 60000 }),
      fresh({ fiveH: 42, sevenD: 18, ts: now }),      // newer → wins
      fresh({ fiveH: 30, sevenD: 9, ts: now - 30000 }),
    ], { now });
    expect(u.claude).toEqual({ fiveH: 42, sevenD: 18, ts: now });
  });

  test('claude and codex are never conflated into one number', () => {
    const now = Date.now();
    const u = rollUpUsage([
      { metrics: { agent: 'claude', fiveH: 42, sevenD: 18, ts: now } },
      { metrics: { agent: 'codex', fiveH: 9, sevenD: 3, ts: now } },
    ], { now });
    expect(Object.keys(u).sort()).toEqual(['claude', 'codex']);
    expect(u.claude.fiveH).toBe(42);
    expect(u.codex.fiveH).toBe(9);
  });

  test('only the agents actually present on the server are reported', () => {
    const now = Date.now();
    const u = rollUpUsage([{ metrics: { agent: 'claude', fiveH: 42, sevenD: 18, ts: now } }], { now });
    expect(u.codex).toBeUndefined();
  });

  test('a report older than the TTL is dropped — and dropping the last one yields null', () => {
    const now = Date.now();
    const stale = { metrics: { agent: 'claude', fiveH: 42, sevenD: 18, ts: now - METRICS_TTL_MS - 1000 } };
    expect(rollUpUsage([stale], { now })).toBeNull();
    // Still inside the TTL → still trusted (metrics are frozen-while-idle by design).
    const idle = { metrics: { agent: 'claude', fiveH: 42, sevenD: 18, ts: now - METRICS_TTL_MS + 60000 } };
    expect(rollUpUsage([idle], { now }).claude.fiveH).toBe(42);
  });

  test('a stale report never masks a fresh one from the same agent', () => {
    const now = Date.now();
    const u = rollUpUsage([
      { metrics: { agent: 'claude', fiveH: 99, sevenD: 99, ts: now - METRICS_TTL_MS - 1 } },
      { metrics: { agent: 'claude', fiveH: 7, sevenD: 2, ts: now - 5000 } },
    ], { now });
    expect(u.claude.fiveH).toBe(7);
  });

  test('a ts far in the future is bogus — dropped like any other unknown, not shown as 0%', () => {
    const now = Date.now();
    const bogusFuture = { metrics: { agent: 'claude', fiveH: 77, sevenD: 66, ts: now + METRICS_TTL_MS } };
    expect(rollUpUsage([bogusFuture], { now })).toBeNull();
  });

  test('a bogus future ts never beats a genuinely fresh report under "freshest wins"', () => {
    const now = Date.now();
    const u = rollUpUsage([
      { metrics: { agent: 'claude', fiveH: 42, sevenD: 18, ts: now } },                    // genuine
      { metrics: { agent: 'claude', fiveH: 99, sevenD: 99, ts: now + 10 * 60 * 1000 } },   // skewed/bogus clock, "wins" on raw ts
    ], { now });
    // Without the future-side gate, the bogus ts (being the largest) would win "freshest wins"
    // and permanently mask the real report. It must be treated as unknown instead.
    expect(u.claude).toEqual({ fiveH: 42, sevenD: 18, ts: now });
  });

  test('a ts within the clock-skew tolerance is still trusted — real peers drift by seconds', () => {
    const now = Date.now();
    const slightlyAhead = { metrics: { agent: 'claude', fiveH: 55, sevenD: 20, ts: now + CLOCK_SKEW_TOLERANCE_MS - 1 } };
    expect(rollUpUsage([slightlyAhead], { now }).claude.fiveH).toBe(55);

    const justOverTolerance = { metrics: { agent: 'claude', fiveH: 55, sevenD: 20, ts: now + CLOCK_SKEW_TOLERANCE_MS + 1 } };
    expect(rollUpUsage([justOverTolerance], { now })).toBeNull();
  });

  test('unknown is nothing, never 0%', () => {
    const now = Date.now();
    expect(rollUpUsage([], { now })).toBeNull();
    expect(rollUpUsage([{ metrics: null }], { now })).toBeNull();
    expect(rollUpUsage([{}], { now })).toBeNull();
    // No ts → freshness unknowable → not reportable.
    expect(rollUpUsage([{ metrics: { agent: 'claude', fiveH: 42, sevenD: 18 } }], { now })).toBeNull();
    // A ctx-only report (Claude posts one with a blank rate limit) says nothing about quota.
    expect(rollUpUsage([{ metrics: { agent: 'claude', ctx: 30, fiveH: null, sevenD: null, ts: now } }], { now })).toBeNull();
    // An unattributed report cannot be charged to any account's quota.
    expect(rollUpUsage([{ metrics: { fiveH: 42, sevenD: 18, ts: now } }], { now })).toBeNull();
  });

  test('one window present and the other absent still reports — the absent one stays null', () => {
    const now = Date.now();
    const u = rollUpUsage([{ metrics: { agent: 'claude', fiveH: 42, sevenD: null, ts: now } }], { now });
    expect(u.claude).toEqual({ fiveH: 42, sevenD: null, ts: now });
  });

  test('a hostile agent id from a peer cannot become a key', () => {
    const now = Date.now();
    const bad = ['__proto__', 'constructor', '<img src=x onerror=alert(1)>', 'a'.repeat(40), '', 'x y'];
    for (const agent of bad) {
      expect(rollUpUsage([{ metrics: { agent, fiveH: 42, sevenD: 18, ts: now } }], { now })).toBeNull();
    }
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });

  test('percentages from a peer are clamped and rounded, non-numbers are absent', () => {
    const now = Date.now();
    const u = rollUpUsage([{ metrics: { agent: 'codex', fiveH: 142.6, sevenD: -3, ts: now } }], { now });
    expect(u.codex.fiveH).toBe(100);
    expect(u.codex.sevenD).toBe(0); // -3 clamps to 0 — it IS a report, just a bad one
    expect(rollUpUsage([{ metrics: { agent: 'codex', fiveH: '80', sevenD: NaN, ts: now } }], { now })).toBeNull();
  });
});

// ============================================================
// The wire contract — GET /api/cluster/sessions
// ============================================================

// A Codex rollout fixture: Codex RECORDS its usage (Claude pushes it), so the file's own
// mtime is the freshness signal — which is what lets the stale case be driven for real.
const FIXTURE_DIR = path.join(codexSessionsRoot(), '2098', '01', '02');
const created = [];
const line = (type, payload) => JSON.stringify({ timestamp: '2098-01-02T00:00:00.000Z', type, payload });

function writeRollout(cwd, { fiveH, sevenD }) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-01-02T00-00-00-${process.pid}-${created.length}.jsonl`);
  fs.writeFileSync(p, [
    line('session_meta', { id: 'usage-fixture', cwd, cli_version: '0.144.0' }),
    line('turn_context', { turn_id: 't1', model: 'gpt-5.5', effort: 'high', cwd }),
    line('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 9e6, total_tokens: 28774334 },
        last_token_usage: { input_tokens: 25840, cached_input_tokens: 100, output_tokens: 10 },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: fiveH, window_minutes: 300, resets_at: 1 },
        secondary: { used_percent: sevenD, window_minutes: 10080, resets_at: 2 },
      },
    }),
  ].join('\n') + '\n', 'utf8');
  created.push(p);
  return p;
}

// A unique cwd per fixture so findRolloutForCwd can only ever match OUR rollout.
function freshCwd(tag) {
  const cwd = path.join(process.env.TEMP || os.tmpdir(), `wt-usage-${tag}-${process.pid}`);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

test.afterAll(() => {
  for (const p of created) { try { fs.unlinkSync(p); } catch {} }
  try { fs.rmdirSync(FIXTURE_DIR); } catch {}
});

const localServer = (payload) => payload.servers.find((s) => !s.url);
const CLUSTER_TTL_MS = 1700; // /api/cluster/sessions is coalesced for 1500ms

test.describe('per-server usage on /api/cluster/sessions', () => {
  test('a server with no report carries no usage block — not a block of zeros', async () => {
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'usage-none', cwd: freshCwd('none') } });
    const id = (await r.json()).id;

    const payload = await (await ctx.get('/api/cluster/sessions')).json();
    const me = localServer(payload);
    expect(me).toBeTruthy();
    // Nothing reported → the key is absent. It must never appear as {fiveH: 0, sevenD: 0}.
    expect(me.usage === undefined || me.usage.claude === undefined).toBeTruthy();

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a claude-status push rolls up onto the SERVER row, with its timestamp', async () => {
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'usage-claude', cwd: freshCwd('claude'), agent: 'claude' } });
    const id = (await r.json()).id;

    // Pin the Claude conversation id (the metrics key) via a hook, then push a status line.
    const uuid = '56565656-0000-0000-0000-000000000001';
    await ctx.post(`/api/session/${id}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });
    await new Promise((res) => setTimeout(res, 200)); // let the worker persist the uuid
    const before = Date.now();
    const push = await ctx.post('/api/claude-status', { data: { session_id: uuid, ctx: 30, five: 42, seven: 18 } });
    expect(push.ok()).toBeTruthy();

    const payload = await (await ctx.get('/api/cluster/sessions')).json();
    const me = localServer(payload);
    expect(me.usage).toBeTruthy();
    expect(me.usage.claude.fiveH).toBe(42);
    expect(me.usage.claude.sevenD).toBe(18);
    expect(me.usage.claude.ts).toBeGreaterThanOrEqual(before);

    // The per-session metrics now carry the two facts the roll-up is built from: WHOSE
    // quota (source, not the session's declared agent) and WHEN it landed. getStatusMetrics
    // used to drop `ts` entirely.
    const s = payload.sessions.find((x) => x.id === id);
    expect(s.metrics.agent).toBe('claude');
    expect(s.metrics.ts).toBeGreaterThanOrEqual(before);
    expect(s.metrics.ctx).toBe(30); // ctx stays per-session

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('claude and codex quotas sit side by side and are never merged', async () => {
    const ctx = await authCtx();
    const codexCwd = freshCwd('codex-pair');
    writeRollout(codexCwd, { fiveH: 9, sevenD: 3 });

    const cid = (await (await ctx.post('/api/sessions', { data: { name: 'usage-codex', cwd: codexCwd, agent: 'codex' } })).json()).id;
    const kid = (await (await ctx.post('/api/sessions', { data: { name: 'usage-claude2', cwd: freshCwd('claude2'), agent: 'claude' } })).json()).id;

    const uuid = '56565656-0000-0000-0000-000000000002';
    await ctx.post(`/api/session/${kid}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });
    await new Promise((res) => setTimeout(res, 200));
    await ctx.post('/api/claude-status', { data: { session_id: uuid, ctx: 30, five: 42, seven: 18 } });

    const me = localServer(await (await ctx.get('/api/cluster/sessions')).json());
    expect(me.usage.claude).toMatchObject({ fiveH: 42, sevenD: 18 });
    expect(me.usage.codex).toMatchObject({ fiveH: 9, sevenD: 3 });   // read from the rollout
    expect(me.usage.claude.fiveH).not.toBe(me.usage.codex.fiveH);    // two accounts, two numbers

    await ctx.delete(`/api/sessions/${cid}`);
    await ctx.delete(`/api/sessions/${kid}`);
    await ctx.dispose();
  });

  test('a report older than the TTL is not exposed, even though the session still has metrics', async () => {
    const ctx = await authCtx();
    const cwd = freshCwd('codex-stale');
    const rollout = writeRollout(cwd, { fiveH: 55, sevenD: 22 });
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'usage-stale', cwd, agent: 'codex' } })).json()).id;

    // Fresh first: the numbers are there and the transcript path is now resolved+cached.
    let me = localServer(await (await ctx.get('/api/cluster/sessions')).json());
    expect(me.usage.codex).toMatchObject({ fiveH: 55, sevenD: 22 });

    // A recorded metric is exactly as fresh as its transcript's last write. Age it past the
    // TTL — nothing about the numbers changes, only how old the report is.
    const aged = new Date(Date.now() - METRICS_TTL_MS - 60000);
    fs.utimesSync(rollout, aged, aged);
    await new Promise((res) => setTimeout(res, CLUSTER_TTL_MS)); // the payload is coalesced

    const payload = await (await ctx.get('/api/cluster/sessions')).json();
    me = localServer(payload);
    expect(me.usage === undefined || me.usage.codex === undefined).toBeTruthy(); // stale → nothing
    // The session-level metrics are untouched — staleness is a roll-up rule, not a rewrite
    // of the session payload, and the numbers still carry their (old) timestamp.
    const s = payload.sessions.find((x) => x.id === id);
    expect(s.metrics.fiveH).toBe(55);
    expect(s.metrics.agent).toBe('codex');
    expect(Date.now() - s.metrics.ts).toBeGreaterThan(METRICS_TTL_MS);

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('usage is behind auth like the rest of the cluster API', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/cluster/sessions');
    expect(res.status()).toBe(401);
    expect(await res.text()).not.toContain('usage');
    await ctx.dispose();
  });
});

// ============================================================
// The renderer — the web sidebar's SERVER header row (app.html)
// ============================================================
test.describe('Sidebar UI: server-row usage', () => {
  test('the server header shows the account windows + when they were last reported', async ({ page }) => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'UI Usage', cwd: freshCwd('ui'), agent: 'claude' } })).json()).id;
    const uuid = '56565656-0000-0000-0000-000000000003';
    await ctx.post(`/api/session/${id}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });
    await new Promise((res) => setTimeout(res, 200));
    await ctx.post('/api/claude-status', { data: { session_id: uuid, ctx: 30, five: 42, seven: 18 } });

    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await loginPage(page);
      await page.goto(BASE + '/');
      const usage = page.locator('.sb-server .srv-usage');
      await expect(usage).toHaveCount(1, { timeout: 5000 });   // ONCE on the server row…
      await expect(usage).toContainText('Claude Code');        // …attributed to its agent…
      await expect(usage).toContainText('5h 42%');
      await expect(usage).toContainText('7d 18%');
      await expect(usage.locator('.u-age')).toContainText('ago'); // …with its last-updated

      // And NOT repeated on the session row — ctx% is the only per-session number.
      const row = page.locator(`.sb-item[data-session-id="${id}"]`);
      await expect(row).toBeVisible();
      await expect(row).not.toContainText('5h');
      await expect(row.locator('.sb-ctx')).toHaveText('30%');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });
});
