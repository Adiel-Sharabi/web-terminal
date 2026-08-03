// @ts-check
// GET /api/sessions/:id/recap — the sidebar's "where was I?" card.
//
// The pure rules are covered in recap.spec.js. This file pins the ENDPOINT
// contract, which has two properties that are easy to get wrong and expensive
// when they are:
//   * it is behind auth like every other session route — a recap is verbatim
//     conversation content, so an unauthenticated 200 here would leak the same
//     thing /transcript is careful not to;
//   * it DEGRADES rather than 404s. A plain shell has no transcript, but the
//     session-level card ("idle, in <cwd>, 20m ago") still orients you. Returning
//     404 there would make the icon look broken on exactly the sessions where a
//     user is most likely to click it.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authCtx, noAuthCtx } = require('./test-helpers');

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

// A real rollout shape: a human prompt, a tool call, then the agent's answer.
function writeCodexRollout(cwd) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-01-01T00-00-00-${process.pid}-${created.length}.jsonl`);
  const line = (type, payload) => JSON.stringify({ timestamp: '2098-01-01T00:00:00.000Z', type, payload });
  fs.writeFileSync(p, [
    line('session_meta', { id: 'recap-fixture-uuid', cwd, cli_version: '0.144.0' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'why is the terminal blank?' }] }),
    line('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"echo hi"}', call_id: 'r1' }),
    line('response_item', { type: 'function_call_output', call_id: 'r1', output: 'Exit code: 0' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The scroll aliased its lines.' }] }),
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
  return await r.json().catch(() => ({}));
}

// A rollout whose human prompt is buried behind a long tool-only run — the shape
// that broke the first release. [toolPairs] function_call/output pairs sit AFTER
// the prompt, so any fixed scan window smaller than the run reports "no prompt".
function writeBuriedPromptRollout(cwd, toolPairs) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-01-02T00-00-00-${process.pid}-${created.length}.jsonl`);
  const line = (type, payload) => JSON.stringify({ timestamp: '2098-01-02T00:00:00.000Z', type, payload });
  const lines = [
    line('session_meta', { id: 'buried-fixture-uuid', cwd, cli_version: '0.144.0' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the prompt buried behind a long run' }] }),
  ];
  for (let i = 0; i < toolPairs; i++) {
    lines.push(line('response_item', { type: 'function_call', name: 'shell_command', arguments: `{"command":"step ${i}"}`, call_id: `b${i}` }));
    lines.push(line('response_item', { type: 'function_call_output', call_id: `b${i}`, output: `done ${i}` }));
  }
  lines.push(line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'finished the long run' }] }));
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  created.push(p);
  return p;
}

test.describe('GET /api/sessions/:id/recap', () => {
  test('is behind auth', async () => {
    // A recap quotes the conversation verbatim. Same trust boundary as /transcript.
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/sessions/whatever/recap');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('an unknown session is a 404', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/sessions/no-such-session-id/recap');
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });

  test('a session with NO transcript still returns a usable card', async () => {
    // The degrade contract. A plain shell has nothing to parse, but name/cwd/status
    // are exactly what tells you which window this is.
    const ctx = await authCtx();
    const s = await mkSession(ctx, { name: 'recap-plain', autoCommand: '' });
    const res = await ctx.get(`/api/sessions/${s.id}/recap`);
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(card.name).toBe('recap-plain');
    expect(typeof card.cwd).toBe('string');
    expect(card.status).toBeTruthy();
    // No transcript → no conversation fields, but the shape is still complete so
    // a client never has to null-check its way through the card.
    expect(card.prompt).toBeNull();
    expect(card.reply).toBeNull();
    expect(card.since).toEqual({ turns: 0, tools: [] });
    await ctx.delete(`/api/sessions/${s.id}`);
    await ctx.dispose();
  });

  test('reads the last prompt, the reply and the work since, from a real rollout', async () => {
    const cwd = process.env.TEMP || os.tmpdir();
    writeCodexRollout(cwd);
    const ctx = await authCtx();
    const s = await mkSession(ctx, { name: 'recap-codex', cwd, agent: 'codex' });
    const res = await ctx.get(`/api/sessions/${s.id}/recap`);
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(card.agent).toBe('codex');
    expect(card.prompt.text).toBe('why is the terminal blank?');
    expect(card.reply.text).toBe('The scroll aliased its lines.');
    // Work done AFTER the prompt: the tool-call turn plus the answer.
    expect(card.since.tools).toContain('shell_command');
    await ctx.delete(`/api/sessions/${s.id}`);
    await ctx.dispose();
  });

  test('finds a prompt buried behind a long tool run (pages backward)', async () => {
    // THE regression. Measured on the live fleet 2026-08-03: 3 of 12 sessions had
    // zero user turns in their newest 80 because one tool-heavy stretch buries the
    // prompt, so the card claimed "no prompt found" for sessions that plainly had
    // one. 400 pairs is ~800 turns of plumbing after the prompt — comfortably past
    // any single window — so this fails for any fixed-window scan and passes only
    // because the endpoint pages until it finds a human turn.
    const cwd = process.env.TEMP || os.tmpdir();
    writeBuriedPromptRollout(cwd, 400);
    const ctx = await authCtx();
    const s = await mkSession(ctx, { name: 'recap-buried', cwd, agent: 'codex' });
    const res = await ctx.get(`/api/sessions/${s.id}/recap`);
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(card.prompt).not.toBeNull();
    expect(card.prompt.text).toBe('the prompt buried behind a long run');
    // And the work done since is counted across every page it walked.
    expect(card.since.turns).toBeGreaterThan(100);
    await ctx.delete(`/api/sessions/${s.id}`);
    await ctx.dispose();
  });
});
