// @ts-check
// A Codex session reports usage metrics over HTTP. Claude PUSHES its status line to
// /api/claude-status; Codex records the same numbers in its rollout, so the server
// reads them from the transcript and both agents fill the same `metrics` shape —
// which is why the clients need no change to render a Codex ctx badge.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authCtx } = require('./test-helpers');

function codexSessionsRoot() {
  let home = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg && cfg.claudeHome) home = String(cfg.claudeHome);
  } catch {}
  if (!home) home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.codex', 'sessions');
}

const FIXTURE_DIR = path.join(codexSessionsRoot(), '2098', '01', '01');
const created = [];

const line = (type, payload) => JSON.stringify({ timestamp: '2098-01-01T00:00:00.000Z', type, payload });

// A realistic rollout: session_meta head, a turn_context carrying the labels, a turn,
// and a token_count carrying usage + rate limits.
function writeRollout(cwd, { inputTokens = 64600, window = 258400, fiveH = 20, sevenD = 12 } = {}) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-01-01T00-00-00-${process.pid}-${created.length}.jsonl`);
  fs.writeFileSync(p, [
    line('session_meta', { id: 'metrics-fixture', cwd, cli_version: '0.134.0' }),
    line('turn_context', { turn_id: 't1', model: 'gpt-5.5', effort: 'high', cwd }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    line('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 9e6, total_tokens: 28774334 }, // cumulative decoy
        last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 1000, output_tokens: 10 },
        model_context_window: window,
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

test.afterAll(() => {
  for (const p of created) { try { fs.unlinkSync(p); } catch {} }
  try { fs.rmdirSync(FIXTURE_DIR); } catch {}
});

async function mkSession(ctx, body) {
  const r = await ctx.post('/api/sessions', { data: body });
  return (await r.json()).id;
}
async function sessionFromList(ctx, id, route = '/api/sessions') {
  const body = await (await ctx.get(route)).json();
  const arr = Array.isArray(body) ? body : (body.sessions || []);
  return arr.find((s) => s.id === id);
}

test.describe('Codex usage metrics', () => {
  test('a codex session reports ctx / 5h / 7d / model read from its rollout', async () => {
    const cwd = process.env.TEMP || os.tmpdir();
    writeRollout(cwd, { inputTokens: 129200, fiveH: 20, sevenD: 12 }); // exactly 50%
    const ctx = await authCtx();
    const id = await mkSession(ctx, { name: 'codex-metrics', cwd, agent: 'codex' });

    const s = await sessionFromList(ctx, id);
    expect(s.agent).toBe('codex');
    expect(s.metrics).not.toBeNull();
    expect(s.metrics.ctx).toBe(50);      // 129200 / 258400 — NOT the 9e6 cumulative decoy
    expect(s.metrics.fiveH).toBe(20);
    expect(s.metrics.sevenD).toBe(12);
    expect(s.metrics.model).toBe('gpt-5.5');
    expect(s.metrics.effort).toBe('high');

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('the cluster session list carries the same codex metrics', async () => {
    const cwd = process.env.TEMP || os.tmpdir();
    writeRollout(cwd, { inputTokens: 25840 }); // 10%
    const ctx = await authCtx();
    const id = await mkSession(ctx, { name: 'codex-metrics-cluster', cwd, agent: 'codex' });

    const s = await sessionFromList(ctx, id, '/api/cluster/sessions');
    expect(s.metrics.ctx).toBe(10);

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a plain shell session reports no metrics and triggers no transcript read', async () => {
    const ctx = await authCtx();
    const id = await mkSession(ctx, { name: 'shell-no-metrics' });
    const s = await sessionFromList(ctx, id);
    expect(s.agent).toBeNull();
    expect(s.metrics).toBeNull();
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a codex session with no rollout reports null metrics rather than erroring', async () => {
    const ctx = await authCtx();
    // A cwd with no Codex history at all.
    const cwd = path.join(process.env.TEMP || os.tmpdir(), 'wt-no-codex-history');
    fs.mkdirSync(cwd, { recursive: true });
    const id = await mkSession(ctx, { name: 'codex-no-rollout', cwd, agent: 'codex' });
    const s = await sessionFromList(ctx, id);
    expect(s.agent).toBe('codex');
    expect(s.metrics).toBeNull();
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });
});
