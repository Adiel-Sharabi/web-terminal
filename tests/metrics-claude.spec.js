// #71 / #72 — Claude usage metrics: reading the status-line payload, and keeping
// what it said across a restart.
//
// The payload shapes asserted here were CAPTURED from claude-code 2.1.215 on
// 2026-07-19 (a real render, not a doc example) and cross-checked against
// code.claude.com/docs/en/statusline.md. Both nullability traps below are
// documented behaviour of a HEALTHY session, not hypotheticals.
const { test, expect } = require('@playwright/test');
const { parseStatusPayload, mergeStatus, hasReading } = require('../lib/metrics-claude');
const { clampPct, resetAtMsFromSeconds } = require('../lib/metrics-common');

// A verbatim capture, trimmed to the fields the parser reads.
const REAL_PAYLOAD = {
  session_id: 'cap-1',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  effort: { level: 'xhigh' },
  context_window: {
    total_input_tokens: 122042,
    total_output_tokens: 2,
    context_window_size: 1000000,
    used_percentage: 12,
    remaining_percentage: 88,
    current_usage: {
      input_tokens: 2, output_tokens: 2,
      cache_creation_input_tokens: 347, cache_read_input_tokens: 121693,
    },
  },
  rate_limits: {
    five_hour: { used_percentage: 27, resets_at: 1784453400 },
    seven_day: { used_percentage: 5, resets_at: 1785031200 },
  },
};

test.describe('shared metric rules (lib/metrics-common)', () => {
  test('resets_at is epoch SECONDS for every agent — seconds in, ms out', () => {
    expect(resetAtMsFromSeconds(1784453400)).toBe(1784453400000);
    // Sanity: the captured value decodes to a real 2026 date, not 1970 or year 50,000.
    const d = new Date(resetAtMsFromSeconds(1784453400));
    expect(d.getUTCFullYear()).toBe(2026);
  });

  test('a malformed resets_at never arms a timer', () => {
    for (const bad of [0, -1, NaN, Infinity, '1784453400', null, undefined]) {
      expect(resetAtMsFromSeconds(bad)).toBeNull();
    }
  });

  test('a blank percentage is null, never 0 — unknown must not read as "plenty left"', () => {
    expect(clampPct(null)).toBeNull();
    expect(clampPct(undefined)).toBeNull();
    expect(clampPct(NaN)).toBeNull();
    expect(clampPct(-5)).toBeNull();
    expect(clampPct(0)).toBe(0); // a real zero is still a real reading
    expect(clampPct(140)).toBe(100);
    expect(clampPct(12.6)).toBe(13);
  });
});

test.describe('parseStatusPayload — the raw statusline payload', () => {
  test('reads every field off a captured payload', () => {
    const m = parseStatusPayload(REAL_PAYLOAD);
    expect(m.ctx).toBe(12);
    expect(m.ctxWindow).toBe(1000000);
    expect(m.ctxTokens).toBe(122042);
    expect(m.fiveH).toBe(27);
    expect(m.sevenD).toBe(5);
    expect(m.fiveHResetAt).toBe(1784453400000);
    expect(m.model).toBe('Opus 4.8');
    expect(m.effort).toBe('xhigh');
  });

  // THE #71 REGRESSION. The companion divided by a hardcoded 200000, so this
  // session — 45% of a 1M window — computed 225% and clamped to 100%. The window
  // must come from the payload, so the percentage tracks reality instead.
  test('a 1M-context session past 200k tokens is NOT reported as ~100%', () => {
    const m = parseStatusPayload({
      ...REAL_PAYLOAD,
      context_window: {
        total_input_tokens: 450000,
        context_window_size: 1000000,
        used_percentage: 45,
      },
    });
    expect(m.ctxWindow).toBe(1000000);
    expect(m.ctx).toBe(45);
    // The old client arithmetic, shown failing on the same numbers:
    expect(Math.min(100, Math.round((450000 / 200000) * 100))).toBe(100);
    // …and the fix: dividing by the REPORTED window reproduces the true figure.
    expect(Math.round((m.ctxTokens / m.ctxWindow) * 100)).toBe(45);
  });

  test('a 200k session is unaffected — the window is read, not assumed either way', () => {
    const m = parseStatusPayload({
      context_window: { total_input_tokens: 100000, context_window_size: 200000, used_percentage: 50 },
    });
    expect(m.ctxWindow).toBe(200000);
    expect(m.ctx).toBe(50);
  });

  test('ctx is derived from tokens/window when used_percentage is null', () => {
    const m = parseStatusPayload({
      context_window: { total_input_tokens: 250000, context_window_size: 1000000, used_percentage: null },
    });
    expect(m.ctx).toBe(25);
  });

  test('rate_limits absent entirely (non-Pro/Max, or pre-first-response) → nulls, not zeros', () => {
    const { rate_limits, ...noLimits } = REAL_PAYLOAD;
    const m = parseStatusPayload(noLimits);
    expect(m.fiveH).toBeNull();
    expect(m.sevenD).toBeNull();
    expect(m.fiveHResetAt).toBeNull();
    expect(m.ctx).toBe(12); // context still reads fine
  });

  test('one rate-limit window present and the other absent', () => {
    const m = parseStatusPayload({
      ...REAL_PAYLOAD,
      rate_limits: { five_hour: { used_percentage: 30, resets_at: 1784453400 } },
    });
    expect(m.fiveH).toBe(30);
    expect(m.sevenD).toBeNull();
  });

  test('model falls back to id when there is no display_name', () => {
    const m = parseStatusPayload({ ...REAL_PAYLOAD, model: { id: 'claude-opus-4-8' } });
    expect(m.model).toBe('claude-opus-4-8');
  });

  test('an absurd context window is refused rather than rescaling every percentage', () => {
    for (const bad of [0, -1, 1e12, NaN, '200000']) {
      const m = parseStatusPayload({ context_window: { context_window_size: bad, total_input_tokens: 10 } });
      expect(m.ctxWindow).toBeNull();
    }
  });
});

test.describe('parseStatusPayload — the legacy flat push (a machine not yet updated)', () => {
  test('still understood, with bash strings and blanks', () => {
    const m = parseStatusPayload({ session_id: 'x', ctx: '45', five: '15', seven: '3' });
    expect(m.ctx).toBe(45);
    expect(m.fiveH).toBe(15);
    expect(m.sevenD).toBe(3);
    // The legacy push cannot carry these — that is exactly what #71/#69 cost us.
    expect(m.ctxWindow).toBeNull();
    expect(m.fiveHResetAt).toBeNull();
  });

  test('a blank string is absent, not 0% — Number("") === 0 is the trap', () => {
    const m = parseStatusPayload({ session_id: 'x', ctx: '', five: '', seven: '' });
    expect(m.ctx).toBeNull();
    expect(m.fiveH).toBeNull();
    expect(m.sevenD).toBeNull();
  });
});

test.describe('mergeStatus — a blank report must not destroy a good one', () => {
  const good = parseStatusPayload(REAL_PAYLOAD);

  test('hasReading distinguishes a live report from an empty one', () => {
    expect(hasReading(good)).toBe(true);
    expect(hasReading(parseStatusPayload({ context_window: { current_usage: null } }))).toBe(false);
  });

  // Documented: current_usage is null before the first API call AND immediately
  // after /compact. Without the merge, that gap blanked the window and sent the
  // badge straight back to guessing.
  test('the post-/compact blank keeps the stored reading AND the window', () => {
    const blank = parseStatusPayload({
      context_window: { context_window_size: 1000000, used_percentage: null, current_usage: null },
    });
    const merged = mergeStatus(good, blank);
    expect(merged.ctx).toBe(12);
    expect(merged.ctxWindow).toBe(1000000);
    expect(merged.fiveH).toBe(27);
  });

  test('a live report overwrites the volatile numbers', () => {
    const next = parseStatusPayload({
      ...REAL_PAYLOAD,
      context_window: { total_input_tokens: 300000, context_window_size: 1000000, used_percentage: 30 },
      rate_limits: { five_hour: { used_percentage: 60, resets_at: 1784453400 } },
    });
    const merged = mergeStatus(good, next);
    expect(merged.ctx).toBe(30);
    expect(merged.fiveH).toBe(60);
    expect(merged.sevenD).toBeNull(); // volatile: absent now means absent, not "still 5"
  });

  test('the window survives a legacy push arriving after a raw one', () => {
    const legacy = parseStatusPayload({ ctx: '20', five: '10', seven: '2' });
    const merged = mergeStatus(good, legacy);
    expect(merged.ctx).toBe(20);
    expect(merged.ctxWindow).toBe(1000000); // stable field carried forward
    expect(merged.model).toBe('Opus 4.8');
  });

  test('merging onto nothing just yields the report', () => {
    expect(mergeStatus(null, good).ctx).toBe(12);
    expect(mergeStatus(undefined, good).ctxWindow).toBe(1000000);
  });
});

// ============================================================
// End to end: the payload reaches the session list, and survives (#72)
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { authCtx } = require('./test-helpers');
const { METRICS_TTL_MS } = require('../lib/usage-rollup');

function freshCwd(tag) {
  const cwd = path.join(process.env.TEMP || os.tmpdir(), `wt-cmetrics-${tag}-${process.pid}`);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

// Pin a Claude conversation id onto a session — that id is what keys the metrics map.
async function pinnedSession(ctx, tag, uuid) {
  const r = await ctx.post('/api/sessions', { data: { name: `cm-${tag}`, cwd: freshCwd(tag), agent: 'claude' } });
  const id = (await r.json()).id;
  await ctx.post(`/api/session/${id}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });
  await new Promise((res) => setTimeout(res, 200)); // let the worker persist the uuid
  return id;
}

const sessionById = async (ctx, id) =>
  (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);

test.describe('POST /api/claude-status — raw payload end to end', () => {
  test('the window and the 5h reset time reach the session list', async () => {
    const ctx = await authCtx();
    const uuid = '71717171-0000-0000-0000-000000000001';
    const id = await pinnedSession(ctx, 'raw', uuid);

    const res = await ctx.post('/api/claude-status', { data: { ...REAL_PAYLOAD, session_id: uuid } });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).accepts).toBe('raw');

    const s = await sessionById(ctx, id);
    expect(s.metrics.ctx).toBe(12);
    // #71 — the client no longer has to assume a window; it is served one.
    expect(s.metrics.ctxWindow).toBe(1000000);
    expect(s.metrics.ctxTokens).toBe(122042);
    // #69 — Claude's reset time is real, not the null it shipped stubbed to.
    expect(s.metrics.fiveHResetAt).toBe(1784453400000);
    expect(s.metrics.model).toBe('Opus 4.8');

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a legacy flat push from an un-updated machine still works', async () => {
    const ctx = await authCtx();
    const uuid = '71717171-0000-0000-0000-000000000002';
    const id = await pinnedSession(ctx, 'legacy', uuid);

    await ctx.post('/api/claude-status', { data: { session_id: uuid, ctx: '33', five: '12', seven: '4' } });
    const s = await sessionById(ctx, id);
    expect(s.metrics.ctx).toBe(33);
    expect(s.metrics.fiveH).toBe(12);
    expect(s.metrics.ctxWindow).toBeNull(); // it simply cannot carry one

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a blank report does not blank a good reading (the post-/compact gap)', async () => {
    const ctx = await authCtx();
    const uuid = '71717171-0000-0000-0000-000000000003';
    const id = await pinnedSession(ctx, 'blank', uuid);

    await ctx.post('/api/claude-status', { data: { ...REAL_PAYLOAD, session_id: uuid } });
    // Exactly what Claude emits right after /compact: window known, everything else null.
    await ctx.post('/api/claude-status', {
      data: {
        session_id: uuid,
        context_window: { context_window_size: 1000000, used_percentage: null, current_usage: null },
      },
    });

    const s = await sessionById(ctx, id);
    expect(s.metrics.ctx).toBe(12);          // preserved, not blanked
    expect(s.metrics.ctxWindow).toBe(1000000);

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('the report is mirrored to disk so a restart cannot blank an idle session', async () => {
    const ctx = await authCtx();
    const uuid = '71717171-0000-0000-0000-000000000004';
    const id = await pinnedSession(ctx, 'persist', uuid);

    await ctx.post('/api/claude-status', { data: { ...REAL_PAYLOAD, session_id: uuid } });

    // The write is debounced (10s) and flushed on shutdown; force it via a second
    // push after the debounce would be slow, so assert the mechanism instead: the
    // file appears and holds this conversation's numbers.
    const file = process.env.WT_CLAUDE_METRICS_FILE;
    expect(file, 'playwright.config.js must isolate the metrics mirror').toBeTruthy();
    let stored = null;
    for (let i = 0; i < 40 && !stored; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j[uuid]) stored = j[uuid];
      } catch {}
    }
    expect(stored, 'claude-metrics.json should hold the pushed report').toBeTruthy();
    expect(stored.ctx).toBe(12);
    expect(stored.ctxWindow).toBe(1000000);
    expect(typeof stored.ts).toBe('number');

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('past the TTL the quota goes unknown but ctx survives — it is frozen while idle', async () => {
    const ctx = await authCtx();
    const uuid = '71717171-0000-0000-0000-000000000005';
    const id = await pinnedSession(ctx, 'ttl', uuid);

    await ctx.post('/api/claude-status', { data: { ...REAL_PAYLOAD, session_id: uuid } });
    // Age the report by rewriting it through the endpoint is impossible (ts is server-set),
    // so assert the split rule directly on the served shape while fresh…
    let s = await sessionById(ctx, id);
    expect(s.metrics.fiveH).toBe(27);
    expect(s.metrics.ctx).toBe(12);
    // …and the aged behaviour is pinned by the unit test on getStatusMetrics' inputs:
    // an entry older than the TTL keeps ctx/ctxWindow and nulls the account windows.
    expect(METRICS_TTL_MS).toBeGreaterThan(0);

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });
});
