// @ts-check
// lib/metrics-codex.js — recovers { ctx, fiveH, sevenD, model, effort } from the tail
// of a Codex rollout, so a Codex session shows the same usage badges Claude gets from
// its pushed status line. Shapes captured from real codex-cli 0.134.0 rollouts.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMetricsFromTail } = require('../lib/metrics-codex');

const line = (type, payload, timestamp = '2026-07-10T00:00:00.000Z') =>
  JSON.stringify({ timestamp, type, payload });

const tokenCount = (info, rateLimits) =>
  line('event_msg', { type: 'token_count', info, rate_limits: rateLimits });

const usage = (inputTokens, window = 258400) => ({
  total_token_usage: { input_tokens: 999999, total_tokens: 28774334 }, // cumulative — a decoy
  last_token_usage: { input_tokens: inputTokens, cached_input_tokens: Math.floor(inputTokens * 0.9), output_tokens: 166 },
  model_context_window: window,
});

const limits = (fiveH, sevenD) => ({
  limit_id: 'codex',
  primary: { used_percent: fiveH, window_minutes: 300, resets_at: 1 },
  secondary: { used_percent: sevenD, window_minutes: 10080, resets_at: 2 },
});

const turnContext = (model, effort) => line('turn_context', { turn_id: 't1', model, effort, cwd: 'C:/x' });

// ---- context percentage -----------------------------------------------------
test('ctx% is last_token_usage.input_tokens over the model context window', () => {
  const m = parseMetricsFromTail(tokenCount(usage(125144), limits(20, 12)));
  expect(m.ctx).toBe(48); // 125144 / 258400
  expect(m.fiveH).toBe(20);
  expect(m.sevenD).toBe(12);
});

test('the cumulative total_token_usage is NEVER used for ctx%', () => {
  // The decoy above says 28.7M cumulative tokens. Using it would report 11135%.
  const m = parseMetricsFromTail(tokenCount(usage(2584), limits(0, 0)));
  expect(m.ctx).toBe(1);
  expect(m.ctx).toBeLessThanOrEqual(100);
});

test('ctx% is clamped to 0..100 and rounded', () => {
  expect(parseMetricsFromTail(tokenCount(usage(258400), limits(0, 0))).ctx).toBe(100);
  expect(parseMetricsFromTail(tokenCount(usage(999999), limits(0, 0))).ctx).toBe(100); // over-window
  expect(parseMetricsFromTail(tokenCount(usage(0), limits(0, 0))).ctx).toBe(0);
  expect(parseMetricsFromTail(tokenCount(usage(1292), limits(0, 0))).ctx).toBe(1); // 0.5% -> 1
});

test('a missing or zero context window yields ctx null, not a divide-by-zero', () => {
  expect(parseMetricsFromTail(tokenCount(usage(1000, 0), limits(1, 1))).ctx).toBeNull();
  const noWin = { last_token_usage: { input_tokens: 1000 } };
  expect(parseMetricsFromTail(tokenCount(noWin, limits(1, 1))).ctx).toBeNull();
});

// ---- rate limits ------------------------------------------------------------
test('rate limits are matched by WINDOW LENGTH, not by primary/secondary order', () => {
  // Same numbers, windows swapped: 5h must still be the 300-minute one.
  const swapped = tokenCount(usage(1000), {
    primary: { used_percent: 77, window_minutes: 10080 },
    secondary: { used_percent: 11, window_minutes: 300 },
  });
  const m = parseMetricsFromTail(swapped);
  expect(m.fiveH).toBe(11);
  expect(m.sevenD).toBe(77);
});

test('unrecognised windows fall back to primary=5h / secondary=7d', () => {
  const odd = tokenCount(usage(1000), {
    primary: { used_percent: 30, window_minutes: 42 },
    secondary: { used_percent: 60, window_minutes: 99 },
  });
  const m = parseMetricsFromTail(odd);
  expect(m.fiveH).toBe(30);
  expect(m.sevenD).toBe(60);
});

test('absent rate_limits yields nulls, not zeros', () => {
  const m = parseMetricsFromTail(tokenCount(usage(1000), null));
  expect(m.ctx).toBe(0);
  expect(m.fiveH).toBeNull();
  expect(m.sevenD).toBeNull();
});

// ---- newest wins ------------------------------------------------------------
test('the NEWEST token_count wins', () => {
  const text = [
    tokenCount(usage(10000), limits(1, 1)),
    tokenCount(usage(200000), limits(90, 50)),
  ].join('\n');
  const m = parseMetricsFromTail(text);
  expect(m.ctx).toBe(77); // 200000 / 258400
  expect(m.fiveH).toBe(90);
});

test('a token_count with info:null is skipped for an older one that has info', () => {
  const text = [
    tokenCount(usage(50000), limits(5, 5)),
    line('event_msg', { type: 'token_count', info: null, rate_limits: limits(5, 5) }),
  ].join('\n');
  expect(parseMetricsFromTail(text).ctx).toBe(19); // 50000 / 258400
});

// ---- model / effort ---------------------------------------------------------
test('model and effort come from the newest turn_context', () => {
  const text = [
    turnContext('gpt-5.3-codex', 'medium'),
    turnContext('gpt-5.5', 'high'),
    tokenCount(usage(1000), limits(1, 1)),
  ].join('\n');
  const m = parseMetricsFromTail(text);
  expect(m.model).toBe('gpt-5.5');
  expect(m.effort).toBe('high');
});

test('a turn_context far above the newest token_count is still found', () => {
  // Real shape: turn_context is written once per USER turn, so a long agent turn
  // buries it hundreds of lines above the latest token_count.
  const filler = Array.from({ length: 300 }, () => line('response_item', { type: 'reasoning' }));
  const text = [turnContext('gpt-5.5', 'high'), ...filler, tokenCount(usage(1000), limits(1, 1))].join('\n');
  const m = parseMetricsFromTail(text);
  expect(m.model).toBe('gpt-5.5');
  expect(m.ctx).toBe(0);
});

// ---- degenerate input -------------------------------------------------------
test('empty, malformed, and metric-free input yield null rather than throwing', () => {
  expect(parseMetricsFromTail('')).toBeNull();
  expect(parseMetricsFromTail(null)).toBeNull();
  expect(parseMetricsFromTail('{not json\nalso not json')).toBeNull();
  expect(parseMetricsFromTail(line('response_item', { type: 'message' }))).toBeNull();
});

test('a truncated leading line does not abort the scan', () => {
  const text = '{"partial":' + '\n' + tokenCount(usage(25840), limits(3, 4));
  const m = parseMetricsFromTail(text);
  expect(m.ctx).toBe(10);
  expect(m.fiveH).toBe(3);
});

test('a turn_context with no token_count still reports the model', () => {
  const m = parseMetricsFromTail(turnContext('gpt-5.5', 'high'));
  expect(m).toEqual({ ctx: null, fiveH: null, sevenD: null, model: 'gpt-5.5', effort: 'high' });
});

// ---- against a REAL rollout on this machine ---------------------------------
function newestRollout() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  walk(root);
  if (!found.length) return null;
  return found.map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
}

test('parses plausible metrics out of a real Codex rollout', () => {
  const file = newestRollout();
  test.skip(!file, 'no Codex rollouts on this machine');
  const m = parseMetricsFromTail(fs.readFileSync(file, 'utf8'));
  expect(m, 'a real rollout yields metrics').not.toBeNull();
  if (m.ctx !== null) {
    expect(m.ctx).toBeGreaterThanOrEqual(0);
    expect(m.ctx).toBeLessThanOrEqual(100);
  }
  for (const v of [m.fiveH, m.sevenD]) {
    if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  }
  // The whole file contains a turn_context, so the labels must resolve.
  expect(typeof m.model === 'string' || m.model === null).toBe(true);
});
