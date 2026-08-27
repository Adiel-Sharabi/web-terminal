// @ts-check
// G5: GET /api/sessions/:id/transcript — paginated, server-parsed JSONL → typed
// turns for the companion chat view. These exercise the route end-to-end: auth,
// the "no transcript" 404, the full backward-pagination flow over a stashed
// fixture transcript, skip semantics, and input validation.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { BASE, authCtx, noAuthCtx, readHookToken, claudeProjectsRoot, emptyCwd } = require('./test-helpers');
const { claudeProjectDirName } = require('../lib/transcript');

// safeTranscriptPath() only trusts a .jsonl strictly under the realpath'd Claude
// projects root (<claudeHome>/.claude/projects). Mirror server.js detectClaudeHome()
// so fixtures land under that ONE trusted root (same approach as api.spec.js's
// "Session attention" describe).
const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-transcript-fixture__');
let _n = 0;

// Build a mixed-turn transcript with a KNOWN number of conversational turns:
// user + assistant per iteration (both conversational), plus tool_result-only user
// lines and one malformed line (both skipped by the parser). Newest turn is the
// last assistant line; oldest is the first user line.
function buildFixtureLines(iterations) {
  const lines = [];
  let convo = 0;
  for (let i = 0; i < iterations; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q' + i }] }, timestamp: '2026-07-05T00:00:00Z' }));
    convo++;
    if (i % 4 === 0) {
      // tool_result-only user line → plumbing, must be skipped
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'ok' }] } }));
    }
    const blocks = [{ type: 'text', text: 'a' + i }];
    if (i % 3 === 0) blocks.push({ type: 'tool_use', name: 'Bash', input: { command: 'echo ' + i } });
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } }));
    convo++;
  }
  lines.splice(5, 0, '{ this is not valid json'); // malformed → skipped
  return { text: lines.join('\n') + '\n', convo };
}

function writeFixture(iterations) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `wt_tr_${process.pid}_${++_n}.jsonl`);
  const { text, convo } = buildFixtureLines(iterations);
  fs.writeFileSync(p, text, 'utf8');
  return { path: p, convo };
}

// Create a session, then stash a fixture transcript path onto it via an http-hook
// (UserPromptSubmit carries transcript_path; server validates + stashes it). Returns
// the session id.
async function sessionWithTranscript(ctx, fixturePath, name) {
  const id = (await (await ctx.post('/api/sessions', { data: { name } })).json()).id;
  const hr = await ctx.post('/api/hook', {
    headers: { 'X-WT-Session-ID': id },
    data: { hook_event_name: 'UserPromptSubmit', transcript_path: fixturePath, prompt: 'go' },
  });
  expect(hr.status()).toBe(200);
  return id;
}

test.describe('Session transcript (G5)', () => {
  test.afterAll(() => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

  test('requires authentication', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/sessions/whatever/transcript');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('404 when the session has no stashed/derivable transcript', async () => {
    const ctx = await authCtx();
    // #177: an EMPTY cwd of its own, never the default (%TEMP%). "No transcript"
    // has to be a property of this session, and %TEMP% is a directory the suite's
    // own Codex fixtures legitimately declare — resolution matches a rollout to a
    // session by cwd, so one left behind by an interrupted run answers here and
    // this 404 becomes a 200.
    const id = (await (await ctx.post('/api/sessions', {
      data: { name: 'Tr None', cwd: emptyCwd('tr-none') },
    })).json()).id;
    try {
      const res = await ctx.get(`/api/sessions/${id}/transcript`);
      expect(res.status()).toBe(404);
      expect((await res.json()).error).toMatch(/no transcript/i);
      // no-store applies even to the 404
      expect(res.headers()['cache-control']).toBe('no-store');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  // #42: a session whose cwd carries a special char ('_'/'.'/space) must still
  // resolve its transcript via deriveTranscriptPath. The old inline encoder only
  // mapped '\'/'/', so an underscore cwd resolved to a non-existent project dir
  // -> 404 -> Chat lens hidden. With the shared claudeProjectDirName encoder the
  // derive path finds <projects>/<encoded>/<csid>.jsonl. Fails before, passes after.
  test('#42: derives the transcript for an underscore cwd (special chars in project dir)', async () => {
    const ctx = await authCtx();
    const csid = randomUUID();
    // Real, existing cwd containing an underscore (so old vs new encoders diverge).
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wt42-'));
    const cwd = path.join(parent, 'Acme_Core'); // underscore is the discriminator
    fs.mkdirSync(cwd, { recursive: true });
    // Stash the transcript at the CORRECTLY-encoded project dir under the trusted root.
    const projDir = path.join(claudeProjectsRoot(), claudeProjectDirName(cwd));
    fs.mkdirSync(projDir, { recursive: true });
    const jsonl = path.join(projDir, csid + '.jsonl');
    fs.writeFileSync(jsonl,
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello 42' }] } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer 42' }] } }) + '\n',
      'utf8');
    // Session whose worker adopts claudeSessionId=csid from the --resume flag.
    const id = (await (await ctx.post('/api/sessions', {
      data: { name: 'Tr Underscore', cwd, autoCommand: `claude --resume ${csid}` },
    })).json()).id;
    try {
      const res = await ctx.get(`/api/sessions/${id}/transcript`);
      expect(res.status()).toBe(200); // was 404 with the lossy encoder
      const body = await res.json();
      expect(body.messages.map(m => m.text)).toEqual(['hello 42', 'answer 42']);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(parent, { recursive: true, force: true }); } catch {}
      await ctx.dispose();
    }
  });

  test('default page returns the last 50 turns, newest-last, with correct roles/toolUses', async () => {
    const ctx = await authCtx();
    const fx = writeFixture(60); // 120 conversational turns
    const id = await sessionWithTranscript(ctx, fx.path, 'Tr Default');
    try {
      const res = await ctx.get(`/api/sessions/${id}/transcript`);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('no-store');
      const body = await res.json();
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBe(50);
      expect(body.hasMore).toBe(true);
      expect(typeof body.cursor).toBe('string');
      // newest-last: the final message is the last assistant turn
      const last = body.messages[body.messages.length - 1];
      expect(last).toMatchObject({ role: 'assistant', text: 'a59' });
      // every message has a well-formed role + string text + toolUses array
      for (const m of body.messages) {
        expect(m.role === 'user' || m.role === 'assistant').toBe(true);
        expect(typeof m.text).toBe('string');
        expect(Array.isArray(m.toolUses)).toBe(true);
      }
      // an assistant tool_use turn carries a {name, inputPreview}
      const withTool = body.messages.find(m => m.toolUses.length > 0);
      expect(withTool.role).toBe('assistant');
      expect(withTool.toolUses[0]).toHaveProperty('name');
      expect(withTool.toolUses[0]).toHaveProperty('inputPreview');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('walking `before` cursors backward reaches the start (hasMore=false, cursor=null) with no loss/overlap', async () => {
    const ctx = await authCtx();
    const fx = writeFixture(60);
    const id = await sessionWithTranscript(ctx, fx.path, 'Tr Paginate');
    try {
      let before = null, all = [], pages = 0;
      for (;;) {
        const url = `/api/sessions/${id}/transcript?limit=50` + (before ? `&before=${encodeURIComponent(before)}` : '');
        const body = await (await ctx.get(url)).json();
        all = body.messages.concat(all); // prepend the older page
        pages++;
        if (!body.hasMore) { expect(body.cursor).toBeNull(); break; }
        expect(typeof body.cursor).toBe('string');
        before = body.cursor;
        expect(pages).toBeLessThan(20); // guard against a pagination loop
      }
      expect(all.length).toBe(fx.convo);                                 // every conversational turn, once
      expect(all[0]).toMatchObject({ role: 'user', text: 'q0' });        // oldest
      expect(all[all.length - 1]).toMatchObject({ role: 'assistant', text: 'a59' }); // newest
      // no duplicate texts across pages (all q/a texts are unique)
      const texts = all.map(m => m.text);
      expect(new Set(texts).size).toBe(texts.length);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('malformed and tool_result-only lines are skipped (never surface as turns)', async () => {
    const ctx = await authCtx();
    const fx = writeFixture(10); // 20 conversational turns; also has skips + malformed
    const id = await sessionWithTranscript(ctx, fx.path, 'Tr Skips');
    try {
      const body = await (await ctx.get(`/api/sessions/${id}/transcript?limit=200`)).json();
      expect(body.messages.length).toBe(fx.convo);   // exactly the conversational lines
      expect(body.hasMore).toBe(false);
      // none are tool_result plumbing (those have no text / were skipped)
      expect(body.messages.every(m => m.text.length > 0 || m.toolUses.length > 0)).toBe(true);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('a bad cursor is a 400', async () => {
    const ctx = await authCtx();
    const fx = writeFixture(5);
    const id = await sessionWithTranscript(ctx, fx.path, 'Tr BadCursor');
    try {
      const res = await ctx.get(`/api/sessions/${id}/transcript?before=not-a-valid-cursor`);
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/cursor/i);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('a bad limit is a 400', async () => {
    const ctx = await authCtx();
    const fx = writeFixture(5);
    const id = await sessionWithTranscript(ctx, fx.path, 'Tr BadLimit');
    try {
      for (const bad of ['0', '-3', 'abc', '1.5']) {
        const res = await ctx.get(`/api/sessions/${id}/transcript?limit=${bad}`);
        expect(res.status(), `limit=${bad}`).toBe(400);
      }
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  // Persistence sub-gap mitigation: with NO stashed path (as after a server
  // restart), the route derives the transcript from the session's persisted
  // claudeSessionId + cwd, then re-validates it through safeTranscriptPath. Here we
  // set claudeSessionId via a hook that carries session_id but NO transcript_path
  // (so the stash stays empty), plant the fixture where the derivation will look,
  // and confirm the GET still serves the conversation.
  test('derives the transcript from claudeSessionId + cwd when the stash is empty', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Tr Derive', cwd: os.tmpdir() } })).json()).id;
    // Read the cwd the server actually stored, so we encode the SAME project folder
    // deriveTranscriptPath() will compute from it.
    const list = await (await ctx.get('/api/sessions')).json();
    const cwd = (list.find(s => s.id === id) || {}).cwd;
    const csid = randomUUID();
    // Use the SHARED encoder, never a local copy. A hand-rolled version here only
    // replaced the separators, while claudeProjectDirName replaces EVERY
    // non-alphanumeric char — identical for a tidy path like C:\Windows\Temp, and
    // different the moment the cwd contains anything else (a CI runner's tmpdir is
    // C:\Users\RUNNER~1\AppData\Local\Temp, and the `~` is exactly where the two
    // diverged). The test then planted its fixture in a folder the server would
    // never look in, and failed as a 404 that looked like a server bug.
    const projDir = path.join(claudeProjectsRoot(), claudeProjectDirName(cwd));
    const fixturePath = path.join(projDir, csid + '.jsonl');
    try {
      // Assign claudeSessionId WITHOUT stashing a transcript path.
      const hr = await ctx.post('/api/hook', {
        headers: { 'X-WT-Session-ID': id },
        data: { hook_event_name: 'UserPromptSubmit', session_id: csid, prompt: 'go' },
      });
      expect(hr.status()).toBe(200);
      // Plant the transcript where derivation will look.
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(fixturePath, buildFixtureLines(3).text, 'utf8'); // 6 conversational turns
      const res = await ctx.get(`/api/sessions/${id}/transcript?limit=50`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.messages.length).toBe(6);
      expect(body.messages[body.messages.length - 1]).toMatchObject({ role: 'assistant', text: 'a2' });
      expect(body.hasMore).toBe(false);
    } finally {
      try { fs.unlinkSync(fixturePath); } catch {}
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('limit is honored and capped (over-200 request clamps to 200)', async () => {
    const ctx = await authCtx();
    const fx = writeFixture(120); // 240 conversational turns
    const id = await sessionWithTranscript(ctx, fx.path, 'Tr Cap');
    try {
      const small = await (await ctx.get(`/api/sessions/${id}/transcript?limit=10`)).json();
      expect(small.messages.length).toBe(10);
      const capped = await (await ctx.get(`/api/sessions/${id}/transcript?limit=9999`)).json();
      expect(capped.messages.length).toBe(200);
      expect(capped.hasMore).toBe(true);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });
});

// --- chat-mode subagent trace: /transcript stub + /subagent drill -------------
// A Task tool_use whose subagent left a transcript on disk gets a { agentType,
// description, running } stub in /transcript; /subagent/:toolUseId then pages that
// subagent's OWN transcript. These exercise both routes end-to-end against a
// planted subagents/ dir (agent-<id>.jsonl + agent-<id>.meta.json sidecar), plus
// the running flag, the unknown-id 404, and auth.
test.describe('Session subagent trace', () => {
  test.afterAll(() => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

  // Build a main transcript with ONE Task tool_use (id=taskId), optionally followed
  // by its tool_result (done=true → the subagent has finished). Plant the subagent's
  // own transcript + meta sidecar in the sibling <base>/subagents/ dir the server
  // derives via subagentDirForTranscript. Returns { path, taskId, agentId }.
  let _s = 0;
  function writeSubagentFixture({ done }) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const tag = `${process.pid}_${++_s}`;
    const taskId = `toolu_task_${tag}`;
    const agentId = `agent${tag}`; // dir-entry stem is agent-<agentId>
    const base = path.join(FIXTURE_DIR, `wt_sa_${tag}`); // <base>.jsonl + <base>/subagents/
    const mainPath = `${base}.jsonl`;

    const mainLines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Spawning a subagent.' },
        { type: 'tool_use', id: taskId, name: 'Task', input: { description: 'Investigate X', subagent_type: 'Explore', prompt: 'do it' } },
      ] } }),
    ];
    if (done) {
      mainLines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: taskId, content: 'final report' },
      ] } }));
    }
    fs.writeFileSync(mainPath, mainLines.join('\n') + '\n', 'utf8');

    const subDir = path.join(base, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const subLines = [
      JSON.stringify({ isSidechain: true, agentId, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Investigate X' }] } }),
      JSON.stringify({ isSidechain: true, agentId, type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Looking around.' },
        { type: 'tool_use', id: `toolu_bash_${tag}`, name: 'Bash', input: { command: 'grep -r foo .' } },
      ] } }),
      JSON.stringify({ isSidechain: true, agentId, type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `toolu_bash_${tag}`, content: 'foo at bar.js:12' },
      ] } }),
      JSON.stringify({ isSidechain: true, agentId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found it at bar.js:12' }] } }),
    ];
    fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), subLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'Explore', description: 'Investigate X', toolUseId: taskId, spawnDepth: 1 }), 'utf8');

    return { path: mainPath, taskId, agentId };
  }

  test('/transcript stamps a Task tool_use with a running subagent stub (no result yet)', async () => {
    const ctx = await authCtx();
    const fx = writeSubagentFixture({ done: false });
    const id = await sessionWithTranscript(ctx, fx.path, 'SA Running');
    try {
      const body = await (await ctx.get(`/api/sessions/${id}/transcript`)).json();
      const task = body.messages.flatMap(m => m.toolUses).find(t => t.id === fx.taskId);
      expect(task).toBeTruthy();
      expect(task.subagent).toEqual({ agentType: 'Explore', description: 'Investigate X', running: true });
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('/transcript marks the subagent NOT running once the Task has a tool_result', async () => {
    const ctx = await authCtx();
    const fx = writeSubagentFixture({ done: true });
    const id = await sessionWithTranscript(ctx, fx.path, 'SA Done');
    try {
      const body = await (await ctx.get(`/api/sessions/${id}/transcript`)).json();
      const task = body.messages.flatMap(m => m.toolUses).find(t => t.id === fx.taskId);
      expect(task.subagent.running).toBe(false);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('/subagent/:toolUseId pages the subagent\'s own transcript (nested tool calls)', async () => {
    const ctx = await authCtx();
    const fx = writeSubagentFixture({ done: false });
    const id = await sessionWithTranscript(ctx, fx.path, 'SA Drill');
    try {
      const res = await ctx.get(`/api/sessions/${id}/subagent/${fx.taskId}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('no-store');
      const body = await res.json();
      expect(body.agentType).toBe('Explore');
      expect(body.description).toBe('Investigate X');
      expect(body.running).toBe(true); // parent has no tool_result for the Task
      // newest-last: the final subagent turn is its conclusion
      expect(body.messages[body.messages.length - 1]).toMatchObject({ role: 'assistant', text: 'Found it at bar.js:12' });
      // the subagent's Bash tool_use is present, with its paired result
      const bash = body.messages.flatMap(m => m.toolUses).find(t => t.name === 'Bash');
      expect(bash).toBeTruthy();
      expect(bash.result).toMatch(/bar\.js:12/);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('/subagent for an unknown tool_use id is a 404', async () => {
    const ctx = await authCtx();
    const fx = writeSubagentFixture({ done: false });
    const id = await sessionWithTranscript(ctx, fx.path, 'SA 404');
    try {
      const res = await ctx.get(`/api/sessions/${id}/subagent/toolu_does_not_exist`);
      expect(res.status()).toBe(404);
      expect((await res.json()).error).toMatch(/no subagent/i);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('/subagent requires authentication', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/sessions/whatever/subagent/toolu_x');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});
