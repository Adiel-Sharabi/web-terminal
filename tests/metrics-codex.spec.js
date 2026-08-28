// @ts-check
// lib/metrics-codex.js — recovers { ctx, fiveH, sevenD, model, effort } from the tail
// of a Codex rollout, so a Codex session shows the same usage badges Claude gets from
// its pushed status line. Shapes captured from real codex-cli 0.134.0 rollouts.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { parseMetricsFromTail, findUsageCapAt } = require('../lib/metrics-codex');
const { codexSessionsRoot, isFixtureRollout } = require('./test-helpers');

const line = (type, payload, timestamp = '2026-07-10T00:00:00.000Z') =>
  JSON.stringify({ timestamp, type, payload });

// Every real rollout line carries a top-level ISO `timestamp` — measured, 638 of 638
// lines across the 15 newest local rollouts, every type included. So #142's staleness
// rule compares those rather than file position, which is not a clock once server.js
// splices HEAD + TAIL. Fixtures below must therefore stamp their "later" evidence
// LATER; `line`'s default (2026-07-10) is a month before the captured cap.
const AFTER_CAP = '2026-08-09T15:05:00.000Z';

const tokenCount = (info, rateLimits, timestamp) =>
  line('event_msg', { type: 'token_count', info, rate_limits: rateLimits }, timestamp);

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

const turnContext = (model, effort, timestamp) =>
  line('turn_context', { turn_id: 't1', model, effort, cwd: 'C:/x' }, timestamp);

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

test('an over-long model label is rejected, not rendered', () => {
  // model/effort become rendered TEXT in both clients and ride to peers on
  // GET /api/cluster/sessions, so they are length-bound by the shared
  // metrics-common.label rule — the same one Claude's parser has always used.
  // The Codex side only type-checked before, which made one fact two rules.
  const text = [
    turnContext('x'.repeat(41), 'high'),
    tokenCount(usage(1000), limits(1, 1)),
  ].join('\n');
  const m = parseMetricsFromTail(text);
  expect(m.model).toBeNull();
  // A bad model must not take a good effort down with it.
  expect(m.effort).toBe('high');
});

test('a model label exactly at the cap is kept', () => {
  const text = [
    turnContext('y'.repeat(40), 'high'),
    tokenCount(usage(1000), limits(1, 1)),
  ].join('\n');
  expect(parseMetricsFromTail(text).model).toBe('y'.repeat(40));
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
  expect(m).toEqual({
    ctx: null, fiveH: null, sevenD: null, fiveHResetAt: null, sevenDResetAt: null,
    model: 'gpt-5.5', effort: 'high', capObservedAt: null,
  });
});

// ---- fiveHResetAt (issue #69 — the 5h auto-resume timer's clock) ------------
test('fiveHResetAt is the 5h window\'s resets_at, converted seconds -> ms', () => {
  // limits() (above) sets primary (5h) resets_at:1 — 1 second since epoch.
  const m = parseMetricsFromTail(tokenCount(usage(1000), limits(20, 12)));
  expect(m.fiveHResetAt).toBe(1000);
});

test('fiveHResetAt follows the window match, not primary/secondary position', () => {
  const swapped = tokenCount(usage(1000), {
    primary: { used_percent: 77, window_minutes: 10080, resets_at: 999 },
    secondary: { used_percent: 11, window_minutes: 300, resets_at: 555 },
  });
  expect(parseMetricsFromTail(swapped).fiveHResetAt).toBe(555000);
});

test('a malformed or non-positive resets_at yields null, never a garbage timestamp', () => {
  const bad = tokenCount(usage(1000), {
    primary: { used_percent: 5, window_minutes: 300, resets_at: 'soon' },
    secondary: { used_percent: 5, window_minutes: 10080, resets_at: -1 },
  });
  expect(parseMetricsFromTail(bad).fiveHResetAt).toBeNull();
});

test('absent rate_limits yields fiveHResetAt null too', () => {
  expect(parseMetricsFromTail(tokenCount(usage(1000), null)).fiveHResetAt).toBeNull();
});

test('fiveHResetAt against a REAL validated rollout sample (2026-07-10, codex 0.144.0)', () => {
  // rollout-2026-07-10T00-03-21-019f48b1-367f-7861-835c-256d175ac1d2.jsonl on this
  // machine: primary (300min) resets_at 1783645131 -> 2026-07-10T00:58:51.000Z; the
  // session_meta timestamp for that rollout is 2026-07-09T21:03:21Z, so the 5h window
  // ending ~4h later is plausible. secondary (10080min) resets_at 1784231931 ->
  // 2026-07-16T19:58:51.000Z, six days later, confirming the seconds (not ms) unit.
  const rl = {
    limit_id: 'codex',
    primary: { used_percent: 7, window_minutes: 300, resets_at: 1783645131 },
    secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1784231931 },
  };
  const m = parseMetricsFromTail(tokenCount(usage(1000), rl));
  expect(new Date(m.fiveHResetAt).toISOString()).toBe('2026-07-10T00:58:51.000Z');
});

// ---- #142: findUsageCapAt (the usage-cap error, and its staleness rule) -----
// The captured shape, Office, 2026-08-02T20:26:58.735Z (issue #142) — `error` sits
// directly on the task_complete payload, next to a null last_agent_message.
const CAP_TS = '2026-08-02T20:26:58.735Z';
const CAP_MS = Date.parse(CAP_TS);
const taskComplete = (extra, timestamp = CAP_TS) =>
  line('event_msg', { type: 'task_complete', last_agent_message: null, ...extra }, timestamp);
const capError = (timestamp = CAP_TS) => taskComplete({
  error: { message: "You've hit your usage limit. Upgrade to Pro (…) or try again at Aug 9th, 2026 3:02 PM.",
           codex_error_info: 'usage_limit_exceeded' },
}, timestamp);
const userMessage = (text, timestamp) =>
  line('response_item', { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text }] }, timestamp);

test.describe('#142 — findUsageCapAt', () => {
  test('a tail whose newest terminal event is the cap error reports it', () => {
    const text = [tokenCount(usage(1000), limits(100, 100), '2026-08-02T20:26:50.000Z'), capError()].join('\n');
    expect(findUsageCapAt(text)).toBe(CAP_MS);
  });

  test('a later turn_context retires it — the window turned over and a new turn ran', () => {
    const text = [capError(), turnContext('gpt-5.5', 'high', AFTER_CAP)].join('\n');
    expect(findUsageCapAt(text)).toBeNull();
  });

  test('a later user response_item retires it', () => {
    const text = [capError(), userMessage('try again', '2026-08-09T15:05:00.000Z')].join('\n');
    expect(findUsageCapAt(text)).toBeNull();
  });

  test('a later token_count retires it', () => {
    const text = [capError(), tokenCount(usage(500), limits(2, 3), '2026-08-09T15:05:01.000Z')].join('\n');
    expect(findUsageCapAt(text)).toBeNull();
  });

  test('a turn stamped EARLIER does not retire a cap, wherever it sits in the text', () => {
    // The distinction the positional rule could not make, and the one that matters once
    // HEAD and TAIL are spliced: the same two lines, both orders, same answer.
    const older = turnContext('gpt-5.5', 'high', '2026-08-02T20:00:00.000Z');
    expect(findUsageCapAt([older, capError()].join('\n'))).toBe(CAP_MS);
    expect(findUsageCapAt([capError(), older].join('\n'))).toBe(CAP_MS);
  });

  test('a tail with no error reports nothing', () => {
    const text = [turnContext('gpt-5.5', 'high'), tokenCount(usage(1000), limits(1, 1))].join('\n');
    expect(findUsageCapAt(text)).toBeNull();
  });

  test('a normal (non-cap) task_complete is not mistaken for one', () => {
    const text = [taskComplete({ last_agent_message: 'done' })].join('\n');
    expect(findUsageCapAt(text)).toBeNull();
  });

  test('same-turn context BEFORE the error does not falsely retire it', () => {
    // The rate-limits reading that proves the window is spent comes from the
    // token_count written immediately before the error, in the SAME failed turn. If
    // that counted as "a later turn ran", no cap would ever be reported at all — and
    // it is measured that no token_count ever FOLLOWS a task_complete (25 rollouts:
    // 23 ended the file, 2 were followed by a genuinely new turn, 0 by a token_count).
    const text = [
      turnContext('gpt-5.5', 'high', '2026-08-02T20:26:40.000Z'),
      tokenCount(usage(1000), limits(100, 100), '2026-08-02T20:26:55.000Z'),
      capError(),
    ].join('\n');
    expect(findUsageCapAt(text)).toBe(CAP_MS);
  });

  test('the OLDEST of two cap errors is correctly superseded by the newest', () => {
    const older = capError('2026-07-26T10:00:00.000Z');
    const evidence = turnContext('gpt-5.5', 'high', '2026-07-27T10:00:00.000Z');
    const newer = capError('2026-08-02T20:26:58.735Z');
    expect(findUsageCapAt([older, evidence, newer].join('\n'))).toBe(Date.parse('2026-08-02T20:26:58.735Z'));
  });

  test('empty, malformed and metric-free input yield null', () => {
    expect(findUsageCapAt('')).toBeNull();
    expect(findUsageCapAt(null)).toBeNull();
    expect(findUsageCapAt('{not json')).toBeNull();
  });

  test('parseMetricsFromTail exposes capObservedAt end-to-end, live and cleared', () => {
    const live = parseMetricsFromTail([
      tokenCount(usage(1000), limits(100, 100), '2026-08-02T20:26:50.000Z'), capError(),
    ].join('\n'));
    expect(live.capObservedAt).toBe(CAP_MS);

    const cleared = parseMetricsFromTail([capError(), turnContext('gpt-5.5', 'high', AFTER_CAP)].join('\n'));
    expect(cleared.capObservedAt).toBeNull();
  });

  test('a live cap error alone (no usable token_count/turn_context) still yields metrics, not null', () => {
    // The same philosophy as usage-limit.js's observedBlockAt: a direct observation
    // needs no percentage to corroborate it.
    const m = parseMetricsFromTail(capError());
    expect(m).not.toBeNull();
    expect(m.capObservedAt).toBe(CAP_MS);
    expect(m.fiveH).toBeNull();
    expect(m.model).toBeNull();
  });
});

// ---- against a REAL rollout on this machine ---------------------------------
// "Real" is load-bearing and was not enforced (#177). This picks the NEWEST
// rollout by mtime, and the suite's own generated fixtures — written into this
// same real tree by recap-api / agents-api / usage-rollup / metrics-codex-api /
// transcript-refresh — are always newer than anything Codex actually wrote. They
// carry no `token_count`, so `parseMetricsFromTail` returns null and this test
// failed with "a real rollout yields metrics" on every machine that had ever
// been interrupted mid-suite. Skipping the reserved fixture years keeps the
// assertion about Codex's format rather than about the last run's tidiness.
function newestRollout() {
  const root = codexSessionsRoot();
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && !isFixtureRollout(p)) {
        found.push(p);
      }
    }
  };
  walk(root);
  if (!found.length) return null;
  return found.map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
}

test('parses plausible metrics out of a real Codex rollout', () => {
  const file = newestRollout();
  // An explicit, stated skip: this asserts against whatever Codex last wrote on
  // this machine, so a box that has never run Codex has nothing to check. It is
  // a corroboration of the format, not a gate — the parser's own rules are
  // pinned by the fixture-driven tests above.
  test.skip(!file, 'no real (non-fixture) Codex rollouts on this machine');
  const m = parseMetricsFromTail(fs.readFileSync(file, 'utf8'));
  expect(m, 'a real rollout yields metrics').not.toBeNull();
  if (m.ctx !== null) {
    expect(m.ctx).toBeGreaterThanOrEqual(0);
    expect(m.ctx).toBeLessThanOrEqual(100);
  }
  for (const v of [m.fiveH, m.sevenD]) {
    if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  }
  // fiveHResetAt (#69): a real ms-epoch timestamp when present, never negative/NaN.
  if (m.fiveHResetAt !== null) {
    expect(typeof m.fiveHResetAt).toBe('number');
    expect(m.fiveHResetAt).toBeGreaterThan(0);
  }
  // The whole file contains a turn_context, so the labels must resolve.
  expect(typeof m.model === 'string' || m.model === null).toBe(true);
});

// The caller does NOT pass a tail. server.js's readTranscriptMetrics splices HEAD +
// TAIL for any rollout larger than its budget, so the OLDEST lines in the string are
// walked LAST. The first cut of findUsageCapAt let iteration order stand in for
// "newer", which is exactly wrong for that input. Found in review; the rule now
// compares the lines' own ISO timestamps instead.
test.describe('#142 — findUsageCapAt across a HEAD+TAIL splice', () => {
  const CAP_TS = '2026-08-02T20:26:58.735Z';
  const capLine = (ts) => JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: null,
      error: { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' },
    },
  });
  const turnLine = (ts) => JSON.stringify({
    timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high' },
  });
  const tokenLine = (ts) => JSON.stringify({
    timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null },
  });

  test('a cap in the HEAD, superseded by a turn in the TAIL, is NOT reported', () => {
    // Position says the cap is last; time says a turn ran three weeks later.
    const spliced = [turnLine('2026-08-20T00:00:00.000Z'), capLine('2026-07-01T00:00:00.000Z')].join('\n');
    expect(findUsageCapAt(spliced)).toBeNull();
  });

  test('...and the same pair in file order is still not reported', () => {
    const inOrder = [capLine('2026-07-01T00:00:00.000Z'), turnLine('2026-08-20T00:00:00.000Z')].join('\n');
    expect(findUsageCapAt(inOrder)).toBeNull();
  });

  test('a live cap with only OLDER turn evidence is reported', () => {
    const live = [turnLine('2026-08-02T20:00:00.000Z'), capLine(CAP_TS)].join('\n');
    expect(findUsageCapAt(live)).toBe(Date.parse(CAP_TS));
  });

  test("the same turn's own token_count, written just before the error, does not supersede it", () => {
    // The measured shape: the rate_limits line reading 100% sits immediately BEFORE the
    // task_complete that carries the error. If that counted as a later turn, no cap
    // would ever be reported at all.
    const sameTurn = [tokenLine('2026-08-02T20:26:58.000Z'), capLine(CAP_TS)].join('\n');
    expect(findUsageCapAt(sameTurn)).toBe(Date.parse(CAP_TS));
  });

  test('a line with no usable timestamp is ignored rather than trusted', () => {
    const noTs = [JSON.stringify({ type: 'turn_context', payload: { model: 'x' } }), capLine(CAP_TS)].join('\n');
    expect(findUsageCapAt(noTs)).toBe(Date.parse(CAP_TS));
  });
});
