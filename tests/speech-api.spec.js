// @ts-check
// #70 Phase 1: GET /api/sessions/:id/speech — the newest assistant PROSE turn,
// reduced server-side to a speakable utterance.
//
// The filtering rules themselves are unit-tested in speech.spec.js; this spec
// covers the ROUTE: that it is behind auth, that it 404s like its sibling when a
// session has no transcript, that it steps back over tool-only turns to find real
// prose, and — the one that matters most — that a turn made only of code yields an
// EMPTY string rather than falling back to reading the code aloud.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authCtx, noAuthCtx, emptyCwd, claudeProjectsRoot } = require('./test-helpers');

// Mirror server.js detectClaudeHome() so fixtures land under the ONE trusted
// projects root that safeTranscriptPath() will accept (same approach as
// transcript-api.spec.js).
const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-speech-fixture__');
let _n = 0;

function writeFixture(lines) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `wt_sp_${process.pid}_${++_n}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}
const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistantLine = (blocks) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const prose = (text) => assistantLine([{ type: 'text', text }]);
const toolOnly = (cmd) =>
  assistantLine([{ type: 'tool_use', id: 't' + (++_n), name: 'Bash', input: { command: cmd } }]);

// Create a session, then stash the fixture onto it through the http-hook (the
// server validates + stashes transcript_path) — the same path the real app uses.
async function sessionWithTranscript(ctx, fixturePath, name) {
  const id = (await (await ctx.post('/api/sessions', { data: { name } })).json()).id;
  const hr = await ctx.post('/api/hook', {
    headers: { 'X-WT-Session-ID': id },
    data: { hook_event_name: 'UserPromptSubmit', transcript_path: fixturePath, prompt: 'go' },
  });
  expect(hr.status()).toBe(200);
  return id;
}

test.describe('Session speech (#70)', () => {
  test.afterAll(() => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

  test('requires authentication', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/sessions/whatever/speech');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('404 when the session has no stashed/derivable transcript', async () => {
    const ctx = await authCtx();
    // #177: an EMPTY cwd of its own — see the same note in transcript-api.spec.js.
    // The default (%TEMP%) is a directory the suite's own Codex fixtures declare.
    const id = (await (await ctx.post('/api/sessions', {
      data: { name: 'Sp None', cwd: emptyCwd('sp-none') },
    })).json()).id;
    try {
      const res = await ctx.get(`/api/sessions/${id}/speech`);
      expect(res.status()).toBe(404);
      expect(res.headers()['cache-control']).toBe('no-store');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('speaks the newest assistant prose, filtered', async () => {
    const ctx = await authCtx();
    const fx = writeFixture([
      userLine('do the thing'),
      prose('An older answer.'),
      userLine('now what'),
      prose('The fix is in `lib/agents.js`.\n\n```js\nconst x = 1;\n```\n\nSee [docs](https://example.com).'),
    ]);
    const id = await sessionWithTranscript(ctx, fx, 'Sp Prose');
    try {
      const res = await ctx.get(`/api/sessions/${id}/speech`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      // Newest prose only; backticks gone, code block gone, URL gone, label kept,
      // and the path shaped to its basename so it is not spelled out letter by
      // letter ("lib slash agents dot J S").
      expect(body.text).toBe('The fix is in agents. See docs.');
      expect(res.headers()['cache-control']).toBe('no-store');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('steps back over tool-only turns to reach real prose', async () => {
    // The newest turn is very often a bare tool call; stopping there would make
    // the button say nothing for most of a working session.
    const ctx = await authCtx();
    const fx = writeFixture([
      userLine('go'),
      prose('Here is what I found.'),
      toolOnly('npm test'),
      toolOnly('git status'),
    ]);
    const id = await sessionWithTranscript(ctx, fx, 'Sp ToolOnly');
    try {
      const body = await (await ctx.get(`/api/sessions/${id}/speech`)).json();
      expect(body.text).toBe('Here is what I found.');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('a code-only answer yields an EMPTY utterance, never the code', () => {
    // Guards the one failure mode that would make the feature actively bad:
    // reading a shell command or a diff out loud.
    return (async () => {
      const ctx = await authCtx();
      const fx = writeFixture([userLine('show me'), prose('```bash\nrm -rf /tmp/x\n```')]);
      const id = await sessionWithTranscript(ctx, fx, 'Sp CodeOnly');
      try {
        const res = await ctx.get(`/api/sessions/${id}/speech`);
        expect(res.status()).toBe(200); // empty is a normal answer, not an error
        expect((await res.json()).text).toBe('');
      } finally {
        await ctx.delete(`/api/sessions/${id}`);
        await ctx.dispose();
      }
    })();
  });
});
