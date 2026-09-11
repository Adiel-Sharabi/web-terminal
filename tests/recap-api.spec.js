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
const { authCtx, noAuthCtx, codexSessionsRoot, emptyCwd } = require('./test-helpers');

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

// #246: a rollout laid out to order — [prompt, N tool pairs, prompt, N tool pairs,
// ...] oldest-first — so a test can place a prompt a KNOWN number of turns back.
// Codex writes one TURN per call/output pair (`function_call_output` parses to
// null and is folded into its call), so a pair count IS a turn count here.
// [day] keeps each fixture's filename newer than the last, because a Codex
// transcript is resolved as "the newest rollout matching this cwd".
function writeSpacedPromptsRollout(cwd, day, blocks) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-01-${day}T00-00-00-${process.pid}-${created.length}.jsonl`);
  let n = 0;
  const line = (type, payload) => JSON.stringify({
    // A distinct stamp per line: the trail's whole job is showing that time
    // passed between your sends, which one shared timestamp could not.
    timestamp: `2098-01-${day}T${String(n++ % 24).padStart(2, '0')}:00:00.000Z`,
    type, payload,
  });
  const lines = [line('session_meta', { id: `spaced-${day}-uuid`, cwd, cli_version: '0.144.0' })];
  for (const b of blocks) {
    if (b.prompt) {
      lines.push(line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: b.prompt }] }));
    }
    for (let i = 0; i < (b.pairs || 0); i++) {
      const id = `${lines.length}-${i}`;
      lines.push(line('response_item', { type: 'function_call', name: 'shell_command', arguments: `{"command":"step ${i}"}`, call_id: id }));
      lines.push(line('response_item', { type: 'function_call_output', call_id: id, output: `done ${i}` }));
    }
  }
  lines.push(line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'finished' }] }));
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
    // #177: an EMPTY cwd of its own. This file writes Codex fixtures declaring
    // `cwd: %TEMP%`, which is also the default cwd of every session the suite
    // creates — so on a run that inherited a leaked fixture, THIS session (a
    // plain shell, asserting it has no conversation) was served that fixture's
    // prompt. The degrade contract can only be tested from a cwd no rollout names.
    const s = await mkSession(ctx, {
      name: 'recap-plain', autoCommand: '', cwd: emptyCwd('recap-plain'),
    });
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

  // --- #246: the trail, and the ceilings that keep it cheap ------------------
  // These three run LAST and in this order on purpose: each writes a rollout
  // whose filename is newer than the one before it, into the one cwd every
  // fixture here declares, and "newest rollout for this cwd" is how a Codex
  // transcript is resolved.

  test('lists the recent prompts, paging past the first page to reach them', async () => {
    // The newest prompt sits ~102 turns back and the oldest ~184, so page one
    // (150) holds only two of the three. A walk that still stopped on the first
    // page containing a prompt would return one entry; this returns three.
    const cwd = process.env.TEMP || os.tmpdir();
    writeSpacedPromptsRollout(cwd, '03', [
      { prompt: 'the oldest prompt', pairs: 40 },
      { prompt: 'the middle prompt', pairs: 40 },
      { prompt: 'the newest prompt', pairs: 100 },
    ]);
    const ctx = await authCtx();
    const s = await mkSession(ctx, { name: 'recap-trail', cwd, agent: 'codex' });
    const res = await ctx.get(`/api/sessions/${s.id}/recap`);
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(card.prompts.map((p) => p.text)).toEqual([
      'the newest prompt', 'the middle prompt', 'the oldest prompt',
    ]);
    // Additive: the single-prompt field a client that has not been rebuilt reads
    // is still there, and still the newest one.
    expect(card.prompt.text).toBe('the newest prompt');
    // Each entry carries its OWN stamp — the thing that makes a 13h gap legible.
    expect(new Set(card.prompts.map((p) => p.at)).size).toBe(3);
    expect(card.scan.turns).toBeGreaterThan(150); // it really did page again
    await ctx.delete(`/api/sessions/${s.id}`);
    await ctx.dispose();
  });

  test('returns FEWER prompts rather than reading more of the file', async () => {
    // THE budget guard. The second prompt sits ~413 turns back, well inside the
    // 750-turn hard budget — and the walk still stops at ~300, because once the
    // newest prompt is in hand it may spend only one more page looking for older
    // ones. K prompts must not cost K x the scan.
    const cwd = process.env.TEMP || os.tmpdir();
    writeSpacedPromptsRollout(cwd, '04', [
      { prompt: 'the far older prompt', pairs: 400 },
      { prompt: 'the newest prompt', pairs: 10 },
    ]);
    const ctx = await authCtx();
    const s = await mkSession(ctx, { name: 'recap-budget', cwd, agent: 'codex' });
    const res = await ctx.get(`/api/sessions/${s.id}/recap`);
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(card.prompts.map((p) => p.text)).toEqual(['the newest prompt']);
    expect(card.scan.turns).toBeLessThan(400); // never reached the older prompt
    expect(card.scan.exhausted).toBe(true);    // and says there is more behind it
    await ctx.delete(`/api/sessions/${s.id}`);
    await ctx.dispose();
  });

  test('a prompt past the budget is reported as STOPPED LOOKING, not as absent', async () => {
    // The decision #246 asked for. 800 tool turns and no typed prompt at all
    // exhausts the 750-turn budget, and the honest answer is not the same as a
    // plain shell's: "this session has no prompt" would be confidently wrong on
    // exactly the drifted sessions this card exists for. `scan.exhausted` is the
    // one fact a client cannot derive, so the server publishes it.
    const cwd = process.env.TEMP || os.tmpdir();
    writeSpacedPromptsRollout(cwd, '05', [{ pairs: 800 }]);
    const ctx = await authCtx();
    const s = await mkSession(ctx, { name: 'recap-exhausted', cwd, agent: 'codex' });
    const res = await ctx.get(`/api/sessions/${s.id}/recap`);
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(card.prompt).toBeNull();
    expect(card.prompts).toEqual([]);
    expect(card.scan.exhausted).toBe(true);
    expect(card.scan.turns).toBeGreaterThanOrEqual(750);
    await ctx.delete(`/api/sessions/${s.id}`);
    await ctx.dispose();
  });
});
