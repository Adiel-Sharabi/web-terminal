// @ts-check
// GET /api/sessions/:id/digest - the model-written summary of one inbox wait (#383).
//
// The suite's server runs the digest against tests/fixtures/fake-digest-cli.js (see
// playwright.config.js): the real model is never called. The fake records what it was
// run with into FAKE_DIGEST_DIR and answers as that directory's mode.json says.
//
// The rules themselves - cache, queue, timeout, parse - are pinned against the library
// in inbox-digest.spec.js. This file pins what only the ROUTE can get wrong: that it is
// behind auth, which turn it sends, and that the wait's key moves when the wait does.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authCtx, noAuthCtx, codexSessionsRoot, emptyCwd, readHookToken, BASE } = require('./test-helpers');

const DIR = process.env.FAKE_DIGEST_DIR;
const FIXTURE_DIR = path.join(codexSessionsRoot(), '2098', '03', '01');
const rollouts = [];
const made = []; // every session this file opens; closed in afterEach even when a test fails (10-session cap)

const setMode = (m) => fs.writeFileSync(path.join(DIR, 'mode.json'), JSON.stringify(m));
const runs = () => fs.readdirSync(DIR).filter((f) => f.startsWith('run-'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

test.afterEach(async () => {
  const ctx = await authCtx();
  for (const id of made.splice(0)) { try { await ctx.delete(`/api/sessions/${id}`); } catch { /* already gone */ } }
  await ctx.dispose();
});
test.beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
});
test.afterAll(() => {
  for (const p of rollouts) { try { fs.unlinkSync(p); } catch { /* best effort */ } }
  try { fs.rmdirSync(FIXTURE_DIR); } catch { /* shared with other fixtures */ }
});

const line = (type, payload, n = 0) => JSON.stringify({ timestamp: `2098-03-01T00:00:${String(n).padStart(2, '0')}.000Z`, type, payload });
const say = (role, text, n) => line('response_item', {
  type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
}, n);

/** A Codex rollout for [cwd]: a prompt, then the given lines. Returns its path. */
function writeRollout(cwd, tail) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-03-01T00-00-00-${process.pid}-${rollouts.length}.jsonl`);
  fs.writeFileSync(p, [
    line('session_meta', { id: `digest-${rollouts.length}`, cwd, cli_version: '0.144.0' }),
    say('user', 'tidy up the build folder', 1),
    ...tail,
  ].join('\n') + '\n', 'utf8');
  rollouts.push(p);
  return p;
}

async function mkSession(ctx, cwd, name = 'digest-s') {
  const r = await ctx.post('/api/sessions', { data: { name, cwd, agent: 'codex', autoCommand: '' } });
  const id = (await r.json()).id;
  made.push(id);
  return id;
}
const hookCtx = () => pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() } });

test.describe('GET /api/sessions/:id/digest', () => {
  test('is behind auth', async () => {
    // A digest is a summary of the conversation: the same trust boundary as /recap.
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/sessions/whatever/digest');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('the capability is advertised', async () => {
    const ctx = await authCtx();
    const caps = (await (await ctx.get('/api/version')).json()).capabilities || [];
    expect(caps).toContain('inbox-digest');
    await ctx.dispose();
  });

  test('an unknown session is a 404', async () => {
    const ctx = await authCtx();
    expect((await ctx.get('/api/sessions/no-such-session/digest')).status()).toBe(404);
    await ctx.dispose();
  });

  test('a plain shell has nothing to summarise: none, and no run', async () => {
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'digest-plain', autoCommand: '', cwd: emptyCwd('digest-plain') } });
    const id = (await r.json()).id;
    made.push(id);
    const res = await ctx.get(`/api/sessions/${id}/digest`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'none', waitKey: null });
    expect(runs()).toHaveLength(0);
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a tool-only turn (the agent said nothing) is none, not an invented question', async () => {
    const cwd = emptyCwd('digest-toolonly');
    writeRollout(cwd, [
      line('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"ls"}', call_id: 'c1' }, 2),
      line('response_item', { type: 'function_call_output', call_id: 'c1', output: 'a b c' }, 3),
    ]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd);
    const res = await ctx.get(`/api/sessions/${id}/digest`);
    expect(await res.json()).toEqual({ status: 'none', waitKey: null });
    expect(runs()).toHaveLength(0);
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a ready digest; the same wait again is served from cache with no second run', async () => {
    const cwd = emptyCwd('digest-ready');
    writeRollout(cwd, [say('assistant', 'Shall I delete the build folder? It is 2 GB.', 2)]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd, 'digest-ready');
    const first = await (await ctx.get(`/api/sessions/${id}/digest`)).json();
    expect(first).toMatchObject({ status: 'ready', cached: false, model: 'sonnet' });
    expect(first.waitKey).toMatch(/^[0-9a-f]{16}$/);
    expect(first.asking).toEqual(['Should the build folder be deleted?']);
    expect(first.know).toEqual(['Deleting it forces a full rebuild.']);
    const second = await (await ctx.get(`/api/sessions/${id}/digest`)).json();
    expect(second).toMatchObject({ status: 'ready', cached: true, waitKey: first.waitKey });
    expect(runs()).toHaveLength(1);
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('what the model receives: the prompt and the agent\'s turn on STDIN; no transcript text in argv; no nested-session env', async () => {
    const cwd = emptyCwd('digest-stdin');
    writeRollout(cwd, [
      say('assistant', 'The build folder holds 2 GB of stale artifacts.', 2),
      line('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"du -sh build"}', call_id: 'c1' }, 3),
      line('response_item', { type: 'function_call_output', call_id: 'c1', output: '2.0G build' }, 4),
      say('assistant', 'Shall I delete it?', 5),
    ]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd, 'digest-stdin');
    expect((await ctx.get(`/api/sessions/${id}/digest`)).status()).toBe(200);
    const [run] = runs();
    expect(run.stdin).toContain('tidy up the build folder');
    expect(run.stdin).toContain('[agent] The build folder holds 2 GB of stale artifacts.');
    expect(run.stdin).toContain('[tool] shell_command');
    expect(run.stdin).toContain('Shall I delete it?');
    expect(run.argv.join(' ')).not.toContain('build folder');
    for (const n of run.envNames) expect(n).not.toMatch(/^(CLAUDECODE|CLAUDE_CODE_|WT_SESSION_ID$|WT_HOOK_TOKEN$)/i);
    // Never a project: the child runs in the scratch directory.
    expect(path.basename(run.cwd)).toBe('digest-runs');
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('two parallel requests for one wait make ONE run', async () => {
    setMode({ mode: 'ok', delayMs: 500 });
    const cwd = emptyCwd('digest-parallel');
    writeRollout(cwd, [say('assistant', 'Which of the two?', 2)]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd);
    const [a, b] = await Promise.all([ctx.get(`/api/sessions/${id}/digest`), ctx.get(`/api/sessions/${id}/digest`)]);
    expect((await a.json()).status).toBe('ready');
    expect((await b.json()).status).toBe('ready');
    expect(runs()).toHaveLength(1);
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('the waitKey changes when the agent writes more, and a new run follows', async () => {
    const cwd = emptyCwd('digest-key');
    const p = writeRollout(cwd, [say('assistant', 'First thought.', 2)]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd);
    const a = await (await ctx.get(`/api/sessions/${id}/digest`)).json();
    fs.appendFileSync(p, say('assistant', 'Actually, a second thought.', 3) + '\n');
    const b = await (await ctx.get(`/api/sessions/${id}/digest`)).json();
    expect(b.waitKey).not.toBe(a.waitKey);
    expect(b.cached).toBe(false);
    expect(runs()).toHaveLength(2);
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('?peek=1 starts no run: missing when nothing is cached, the digest when it is', async () => {
    const cwd = emptyCwd('digest-peek');
    writeRollout(cwd, [say('assistant', 'Proceed?', 2)]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd);
    const miss = await (await ctx.get(`/api/sessions/${id}/digest?peek=1`)).json();
    expect(miss.status).toBe('missing');
    expect(miss.waitKey).toMatch(/^[0-9a-f]{16}$/);
    expect(runs()).toHaveLength(0);
    await ctx.get(`/api/sessions/${id}/digest`);
    const hit = await (await ctx.get(`/api/sessions/${id}/digest?peek=1`)).json();
    expect(hit).toMatchObject({ status: 'ready', cached: true, waitKey: miss.waitKey });
    expect(runs()).toHaveLength(1);
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a live AskUserQuestion is sent with its options, and gives the wait its own key', async () => {
    const cwd = emptyCwd('digest-askq');
    writeRollout(cwd, [say('assistant', 'I need a decision before I touch anything.', 2)]);
    const ctx = await authCtx();
    const raw = await hookCtx();
    const id = await mkSession(ctx, cwd);
    const before = await (await ctx.get(`/api/sessions/${id}/digest?peek=1`)).json();
    await raw.post('/api/hook', {
      headers: { 'X-WT-Session-ID': id },
      data: {
        hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ header: 'Folder', question: 'Delete which folder?', multiSelect: false,
          options: [{ label: 'build/', description: 'the output' }, { label: 'dist/' }] }] },
      },
    });
    const res = await (await ctx.get(`/api/sessions/${id}/digest`)).json();
    expect(res.status).toBe('ready');
    expect(res.waitKey).not.toBe(before.waitKey);
    const [run] = runs();
    expect(run.stdin).toContain('PENDING QUESTION');
    expect(run.stdin).toContain('Delete which folder?');
    expect(run.stdin).toContain('1. build/ - the output');
    expect(run.stdin).toContain('2. dist/');
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });

  test('a blocked permission is sent as the tool call still waiting for its result', async () => {
    const cwd = emptyCwd('digest-perm');
    writeRollout(cwd, [
      say('assistant', 'Cleaning up now.', 2),
      line('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"rm -rf build"}', call_id: 'p1' }, 3),
    ]);
    const ctx = await authCtx();
    const raw = await hookCtx();
    const id = await mkSession(ctx, cwd);
    await raw.post('/api/hook', {
      headers: { 'X-WT-Session-ID': id },
      data: { hook_event_name: 'PermissionRequest', tool_name: 'shell_command', tool_input: { command: 'rm -rf build' } },
    });
    await expect.poll(async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id)?.status).toBe('waiting');
    expect((await ctx.get(`/api/sessions/${id}/digest`)).status()).toBe(200);
    const [run] = runs();
    expect(run.stdin).toContain('PENDING PERMISSION');
    expect(run.stdin).toContain('Tool: shell_command');
    expect(run.stdin).toContain('rm -rf build');
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });

  test('a reply that is not JSON is a 502 failed/bad-output, never a half digest', async () => {
    setMode({ mode: 'bad' });
    const cwd = emptyCwd('digest-bad');
    writeRollout(cwd, [say('assistant', 'Which one?', 2)]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd);
    const res = await ctx.get(`/api/sessions/${id}/digest`);
    expect(res.status()).toBe(502);
    expect(await res.json()).toEqual({ status: 'failed', reason: 'bad-output' });
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });

  test('a run past the ceiling is a 502 failed/timeout', async () => {
    setMode({ mode: 'sleep', ms: 15000 });
    const cwd = emptyCwd('digest-timeout');
    writeRollout(cwd, [say('assistant', 'Which one?', 2)]);
    const ctx = await authCtx();
    const id = await mkSession(ctx, cwd);
    const res = await ctx.get(`/api/sessions/${id}/digest`);
    expect(res.status()).toBe(502);
    expect(await res.json()).toEqual({ status: 'failed', reason: 'timeout' });
    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
  });
});
