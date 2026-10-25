// @ts-check
// #393 - the context budget. Claude compacts at a point its `autoCompactWindow` sets
// (measured: ~367k at 400k), so every context rule judges against that point instead of
// the model's 1M window. The rules are pure (lib/context-budget.js); the last block
// drives the real server and reads the fields off a session row.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('../lib/context-budget');
const agents = require('../lib/agents');
const { authCtx, claudeProjectsRoot } = require('./test-helpers');

const RECORD = agents.compactionRecord('claude');

test.describe('contextBudget (#393)', () => {
  test('a 400k auto-compact window: warn 250k, hand-off 300k, compact 367k', () => {
    expect(B.contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: 400_000 }))
      .toEqual({ warnAt: 250_000, handoffAt: 300_000, compactAt: 367_000, source: 'autoCompactWindow' });
  });

  test('unset, or not below the model window, the model window is the limit', () => {
    // Compaction at the window minus the same 33k (Office: median 967k unset). The hand-off
    // is capped at the old 500k - never 750k, past the ~700k harm zone - and warn keeps 5/6.
    const model = { warnAt: 416_667, handoffAt: 500_000, compactAt: 967_000, source: 'model' };
    expect(B.contextBudget({ ctxWindow: 1_000_000 })).toEqual(model);
    expect(B.contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: 1_000_000 })).toEqual(model);
    expect(B.contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: 2_000_000 })).toEqual(model);
    expect(B.contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: -5 })).toEqual(model);
    // The setting alone still describes the budget (the window is unknown, not small).
    expect(B.contextBudget({ autoCompactWindow: 400_000 })).toMatchObject({ handoffAt: 300_000, source: 'autoCompactWindow' });
    expect(B.contextBudget({})).toBeNull();
    expect(B.contextBudget({ ctxWindow: 0 })).toBeNull();
    // A 200k model: 150k hand-off, 167k compaction - the ratios, uncapped.
    expect(B.contextBudget({ ctxWindow: 200_000 })).toEqual({ warnAt: 125_000, handoffAt: 150_000, compactAt: 167_000, source: 'model' });
  });

  test('the hand-off point never passes the cap, whatever the window', () => {
    for (const w of [400_000, 700_000, 800_000, 999_999]) {
      expect(B.contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: w }).handoffAt).toBeLessThanOrEqual(B.HANDOFF_MAX_TOKENS);
    }
    expect(B.HANDOFF_MAX_TOKENS).toBe(500_000);
  });

  test('the thresholds stay ordered even for a tiny window', () => {
    for (const w of [1000, 20_000, 40_000, 100_000, 200_000, 400_000]) {
      const b = B.contextBudget({ ctxWindow: 1_000_000, autoCompactWindow: w });
      expect(b && b.warnAt <= b.handoffAt && b.handoffAt <= b.compactAt && b.compactAt >= 0).toBe(true);
    }
  });

  test('occupancy is percent x window, never the cumulative ctxTokens', () => {
    expect(B.occupancy({ ctx: 31, ctxWindow: 1_000_000, ctxTokens: 9_999_999 })).toBe(310_000);
    expect(B.occupancy({ ctx: 31 })).toBeNull();
  });

  test('the setting is read through the registry declaration, and off means unset', () => {
    const p = agents.contextBudgetPolicy('claude');
    expect(p).toBeTruthy();
    expect(B.autoCompactWindowFrom({ autoCompactWindow: 400_000 }, p)).toBe(400_000);
    expect(B.autoCompactWindowFrom({ autoCompactWindow: 400_000, autoCompactEnabled: true }, p)).toBe(400_000);
    expect(B.autoCompactWindowFrom({ autoCompactWindow: 400_000, autoCompactEnabled: false }, p)).toBeNull();
    expect(B.autoCompactWindowFrom({ autoCompactWindow: '400k' }, p)).toBeNull();
    expect(B.autoCompactWindowFrom({}, p)).toBeNull();
    expect(B.autoCompactWindowFrom(null, p)).toBeNull();
    // Undeclared means never: Codex and a plain shell keep the client's old rule.
    expect(agents.contextBudgetPolicy('codex')).toBeNull();
    expect(agents.contextBudgetPolicy(null)).toBeNull();
    expect(agents.compactionRecord('codex')).toBeNull();
    expect(agents.compactionRecord(null)).toBeNull();
  });
});

/** A real compaction line, shaped like the transcripts measured on Home. */
const recordLine = (n) => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary',
  content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 366_000 + n },
});
/** A tool result QUOTING one - the shape of 46 of the 222 lines that name it on Home. */
const quoteLine = () => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '{"type":"system","subtype":"compact_boundary"}' }] },
});
const turnLine = (t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });

/** Run the whole buffer through the scan in [size]-byte reads, as the server does. */
function scanAll(text, size) {
  const buf = Buffer.from(text, 'utf8');
  let st = B.emptyScan();
  while (st.offset < buf.length) {
    const next = B.scanCompactions(st, buf.subarray(st.offset, Math.min(st.offset + size, buf.length)), RECORD);
    if (next.offset === st.offset) break;
    st = next;
  }
  return st;
}

test.describe('scanCompactions (#393)', () => {
  test('counts records, never a line that only quotes one', () => {
    const text = [turnLine('a'), recordLine(1), quoteLine(), turnLine('b'), recordLine(2), quoteLine()].join('\n') + '\n';
    expect(scanAll(text, 1 << 20).count).toBe(2);
  });

  test('a read that cuts a record line in two still counts it once', () => {
    const text = [turnLine('a'), recordLine(1), turnLine('b'), recordLine(2), turnLine('c')].join('\n') + '\n';
    // Any read that holds at least one whole line makes progress; these cut lines anywhere.
    const longest = Math.max(...text.split('\n').map((l) => l.length + 1));
    for (const size of [longest, longest + 7, longest + 50, 333, 1000]) expect(scanAll(text, size).count).toBe(2);
  });

  test('an unfinished last line is left for the next read', () => {
    const done = `${turnLine('a')}\n`;
    const partial = recordLine(1).slice(0, 40);
    const st = B.scanCompactions(B.emptyScan(), Buffer.from(done + partial), RECORD);
    expect(st).toEqual({ offset: Buffer.byteLength(done), count: 0, skipping: false });
    const rest = Buffer.from(partial + recordLine(1).slice(40) + '\n');
    expect(B.scanCompactions(st, rest, RECORD).count).toBe(1);
  });

  test('a line too long to be a record is skipped, not re-read forever', () => {
    const huge = turnLine('x'.repeat(B.MAX_RECORD_LINE + 10) + ' compact_boundary');
    const text = `${huge}\n${recordLine(1)}\n`;
    const first = B.scanCompactions(B.emptyScan(), Buffer.from(huge.slice(0, B.MAX_RECORD_LINE + 5)), RECORD);
    expect(first.skipping).toBe(true);
    expect(first.offset).toBe(B.MAX_RECORD_LINE + 5);
    expect(scanAll(text, B.MAX_RECORD_LINE + 4096).count).toBe(1);
    expect(scanAll(text, 1 << 20).count).toBe(1);
  });
});

test.describe('the server publishes the budget, occupancy and compaction count (#393)', () => {
  const DIR = path.join(claudeProjectsRoot(), '__wt-ctxbudget-fixture__');
  const fixture = path.join(DIR, `wt_ctx_${process.pid}.jsonl`);
  // playwright.config.js points the server's agent-settings lookup here (WT_AGENT_SETTINGS_DIR).
  const SETTINGS = path.join(process.env.WT_AGENT_SETTINGS_DIR || '', ...agents.contextBudgetPolicy('claude').settingsFile);
  const writeSettings = (obj) => { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(obj), 'utf8'); };
  let ctx;
  let id;

  test.beforeAll(async () => {
    expect(process.env.WT_AGENT_SETTINGS_DIR).toBeTruthy();
    writeSettings({ autoCompactWindow: 400_000, autoCompactEnabled: true });
    ctx = await authCtx();
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fixture, [turnLine('a'), recordLine(1), quoteLine(), recordLine(2)].join('\n') + '\n', 'utf8');
    const res = await ctx.post('/api/sessions', { data: { name: `CtxBudget-${Date.now()}`, agent: 'claude' } });
    id = (await res.json()).id;
    expect(id).toBeTruthy();
    const conv = crypto.randomUUID();
    const hr = await ctx.post('/api/hook', {
      headers: { 'X-WT-Session-ID': id },
      data: { hook_event_name: 'UserPromptSubmit', session_id: conv, transcript_path: fixture, prompt: 'go' },
    });
    expect(hr.status()).toBe(200);
    const st = await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 31 } } });
    expect(st.status()).toBe(200);
  });

  test.afterAll(async () => {
    if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.dirname(path.dirname(SETTINGS)), { recursive: true, force: true }); } catch {}
    await ctx.dispose();
  });

  const metricsOf = async () => {
    const list = await (await ctx.get('/api/sessions')).json();
    return (list.find((x) => x.id === id) || {}).metrics || null;
  };

  test('on the row, and the count follows the transcript as it grows', async () => {
    // The settings file's 400k decides - read from the file, not from the model window.
    await expect.poll(async () => (await metricsOf()).budget, { timeout: 15000, intervals: [300] })
      .toEqual({ warnAt: 250_000, handoffAt: 300_000, compactAt: 367_000, source: 'autoCompactWindow' });
    expect(await metricsOf()).toMatchObject({ ctx: 31, ctxWindow: 1_000_000, ctxUsed: 310_000 });
    // Counted behind the poll, so it lands within a poll or two - never the quoted line.
    await expect.poll(async () => (await metricsOf()).compactions, { timeout: 10000, intervals: [200] }).toBe(2);
    fs.appendFileSync(fixture, `${turnLine('b')}\n${recordLine(3)}\n`, 'utf8');
    await expect.poll(async () => (await metricsOf()).compactions, { timeout: 10000, intervals: [200] }).toBe(3);
  });

  test('a settings edit lands with no restart; switching auto-compact off falls back to the model', async () => {
    writeSettings({ autoCompactWindow: 600_000 });
    await expect.poll(async () => (await metricsOf()).budget.compactAt, { timeout: 15000, intervals: [500] }).toBe(567_000);
    writeSettings({ autoCompactWindow: 600_000, autoCompactEnabled: false });
    await expect.poll(async () => (await metricsOf()).budget.source, { timeout: 15000, intervals: [500] }).toBe('model');
    writeSettings({ autoCompactWindow: 400_000 });
    await expect.poll(async () => (await metricsOf()).budget.handoffAt, { timeout: 15000, intervals: [500] }).toBe(300_000);
  });

  test('every session list carries the same fields (the cluster merge too)', async () => {
    await expect.poll(async () => {
      const list = await (await ctx.get('/api/cluster/sessions')).json();
      const row = (Array.isArray(list) ? list : list.sessions || []).find((x) => x.id === id);
      return row && row.metrics ? { used: row.metrics.ctxUsed, n: row.metrics.compactions, b: !!row.metrics.budget } : null;
    }, { timeout: 10000, intervals: [300] }).toEqual({ used: 310_000, n: 3, b: true });
  });
});
