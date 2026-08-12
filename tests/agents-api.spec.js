// @ts-check
// The agent-aware session API: GET /api/agents (the picker catalogue), the `agent`
// field on session create + list, and the rule that an EXPLICIT agent is authoritative
// (never silently served another provider's transcript).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authCtx, noAuthCtx } = require('./test-helpers');
const { AGENT_IDS, DEFAULT_AGENT } = require('../lib/agents');

// Codex rollouts live under <home>/.codex/sessions/YYYY/MM/DD/. Mirror server.js's
// home detection so a fixture lands inside the ONE trusted root.
function codexSessionsRoot() {
  let home = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg && cfg.claudeHome) home = String(cfg.claudeHome);
  } catch {}
  if (!home) home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.codex', 'sessions');
}

const FIXTURE_DIR = path.join(codexSessionsRoot(), '2099', '01', '01');
const created = [];

// A minimal but real Codex rollout: session_meta head + a turn + a tool call/result.
function writeCodexRollout(cwd) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2099-01-01T00-00-00-${process.pid}-${created.length}.jsonl`);
  const line = (type, payload) => JSON.stringify({ timestamp: '2099-01-01T00:00:00.000Z', type, payload });
  fs.writeFileSync(p, [
    line('session_meta', { id: 'fixture-uuid', cwd, cli_version: '0.134.0' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] }),
    line('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"echo hi"}', call_id: 'c1' }),
    line('response_item', { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 0' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }),
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
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}
async function sessionFromList(ctx, id) {
  const list = await (await ctx.get('/api/sessions')).json();
  const arr = Array.isArray(list) ? list : (list.sessions || []);
  return arr.find((s) => s.id === id);
}

test.describe('Agent catalogue', () => {
  test('GET /api/agents requires authentication', async () => {
    const ctx = await noAuthCtx();
    expect((await ctx.get('/api/agents')).status()).toBe(401);
    await ctx.dispose();
  });

  test('GET /api/agents lists every provider with a label and colour', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/agents');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.default).toBe(DEFAULT_AGENT);
    expect(body.agents.map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const a of body.agents) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    await ctx.dispose();
  });
});

test.describe('Agent-aware sessions', () => {
  test('an unknown agent is rejected at create, never persisted', async () => {
    const ctx = await authCtx();
    const { status, body } = await mkSession(ctx, { name: 'bogus-agent', agent: 'skynet' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown agent/i);
    await ctx.dispose();
  });

  test('an explicit agent is persisted and reported on the session', async () => {
    const ctx = await authCtx();
    const { status, body } = await mkSession(ctx, { name: 'explicit-codex', agent: 'codex' });
    expect(status).toBe(200);
    expect(body.agent).toBe('codex');
    const s = await sessionFromList(ctx, body.id);
    expect(s.agent).toBe('codex');
    await ctx.delete(`/api/sessions/${body.id}`);
    await ctx.dispose();
  });

  // #119: the create RESPONSE is what the companion builds the session it opens
  // from, and its Chat lens is gated on this field. Echoing only the explicit pick
  // meant every Auto-created agent session opened with no chat controls until a
  // re-select re-read it from the list — so create must answer what list answers.
  test('create reports the INFERRED agent, matching what the list reports', async () => {
    const ctx = await authCtx();
    const { status, body } = await mkSession(ctx, { name: 'inferred-claude', autoCommand: 'claude --resume abc' });
    expect(status).toBe(200);
    expect(body.agent).toBe('claude');
    const s = await sessionFromList(ctx, body.id);
    expect(body.agent).toBe(s.agent);
    await ctx.delete(`/api/sessions/${body.id}`);
    await ctx.dispose();
  });

  test('create reports agent null for a plain shell — inference is not a coercion', async () => {
    const ctx = await authCtx();
    const { body } = await mkSession(ctx, { name: 'inferred-shell', autoCommand: 'pwsh -NoLogo' });
    expect(body.agent).toBeNull();
    const s = await sessionFromList(ctx, body.id);
    expect(s.agent).toBeNull();
    await ctx.delete(`/api/sessions/${body.id}`);
    await ctx.dispose();
  });

  test('a plain shell session reports agent null — not mislabelled as claude', async () => {
    const ctx = await authCtx();
    const { body } = await mkSession(ctx, { name: 'plain-shell', autoCommand: '' });
    const s = await sessionFromList(ctx, body.id);
    expect(s.agent).toBeNull();
    await ctx.delete(`/api/sessions/${body.id}`);
    await ctx.dispose();
  });

  test('a session in a cwd with Codex history serves that rollout, tagged agent=codex', async () => {
    const cwd = process.env.TEMP || os.tmpdir();
    writeCodexRollout(cwd);
    const ctx = await authCtx();
    const { body } = await mkSession(ctx, { name: 'codex-transcript', cwd, agent: 'codex' });
    const res = await ctx.get(`/api/sessions/${body.id}/transcript?limit=10`);
    expect(res.status()).toBe(200);
    const page = await res.json();
    expect(page.agent).toBe('codex');
    const texts = page.messages.map((m) => m.text);
    expect(texts).toContain('hello codex');
    expect(texts).toContain('done');
    // The tool call is paired with its output across lines by call_id.
    const tools = page.messages.flatMap((m) => m.toolUses || []);
    expect(tools.map((t) => t.name)).toContain('shell_command');
    expect(tools.find((t) => t.name === 'shell_command').result).toContain('Exit code: 0');
    await ctx.delete(`/api/sessions/${body.id}`);
    await ctx.dispose();
  });

  test('an explicit claude session never falls through to a codex transcript', async () => {
    const cwd = process.env.TEMP || os.tmpdir();
    writeCodexRollout(cwd); // codex COULD resolve this cwd...
    const ctx = await authCtx();
    const { body } = await mkSession(ctx, { name: 'explicit-claude', cwd, agent: 'claude' });
    // ...but the session declares itself Claude, which has no transcript here.
    const res = await ctx.get(`/api/sessions/${body.id}/transcript`);
    expect(res.status()).toBe(404);
    await ctx.delete(`/api/sessions/${body.id}`);
    await ctx.dispose();
  });
});
