// @ts-check
// A DISCOVERED transcript path must not be cached forever.
//
// The bug, observed on the Office server 2026-07-21: a Codex session's chat lens served
// a rollout from 2026-07-14 while SEVEN newer rollouts for the same cwd sat on disk. The
// terminal was live and correct the whole time, which is what made it read as a render
// bug rather than a resolution one.
//
// Cause: resolveSessionTranscriptPath stashed the resolved path in _notifyState and only
// the HOOK path ever re-stashed it. Claude survives that because its path is a pure
// derivation from (cwd, conversation id) AND its hooks refresh it. Codex has neither: it
// writes a NEW rollout every run, and resolution is "the newest rollout matching this
// cwd" — so the right answer changes while nothing about the session does. Whatever was
// newest the first time the chat was opened got pinned for the life of the process.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authCtx, codexSessionsRoot } = require('./test-helpers');


const FIXTURE_DIR = path.join(codexSessionsRoot(), '2097', '02', '02');
const created = [];
const line = (type, payload) => JSON.stringify({ timestamp: '2097-02-02T00:00:00.000Z', type, payload });

// `mtimeMs` is what findRolloutForCwd sorts on, so it is set explicitly rather than
// left to whatever order the filesystem happens to report.
function writeRollout(cwd, assistantText, mtimeMs) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2097-02-02T00-00-00-${process.pid}-${created.length}.jsonl`);
  fs.writeFileSync(p, [
    line('session_meta', { id: `refresh-${created.length}`, cwd, cli_version: '0.144.6' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }] }),
  ].join('\n') + '\n', 'utf8');
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
  created.push(p);
  return p;
}

const textOf = (messages) => messages
  .map((m) => (m.text || m.content || '')).join(' ');

test.afterAll(() => {
  for (const p of created) { try { fs.unlinkSync(p); } catch {} }
  try { fs.rmdirSync(FIXTURE_DIR); } catch {}
});

test('a Codex session picks up a newer rollout instead of serving the pinned one', async () => {
  // A cwd of its own, so nothing else on this machine can match it.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-refresh-'));
  const ctx = await authCtx();

  // The rollout that exists when the chat is first opened — the "2026-07-14" of the
  // real report.
  writeRollout(cwd, 'ANSWER_FROM_THE_OLD_ROLLOUT', Date.now() - 7 * 24 * 3600 * 1000);
  const id = await mkSession(ctx, { name: 'codex-refresh', cwd, agent: 'codex' });

  const first = await (await ctx.get(`/api/sessions/${id}/transcript`)).json();
  expect(textOf(first.messages)).toContain('ANSWER_FROM_THE_OLD_ROLLOUT');

  // Codex starts a new run: a NEWER rollout for the SAME cwd. Nothing about the
  // web-terminal session changed, which is exactly why nothing invalidated the stash.
  writeRollout(cwd, 'ANSWER_FROM_THE_NEW_ROLLOUT', Date.now());

  // Past the discovered-path TTL.
  await new Promise((r) => setTimeout(r, 11000));

  const second = await (await ctx.get(`/api/sessions/${id}/transcript`)).json();
  const text = textOf(second.messages);
  expect(text, 'the chat lens must follow the newest rollout for the cwd').toContain('ANSWER_FROM_THE_NEW_ROLLOUT');
  expect(text).not.toContain('ANSWER_FROM_THE_OLD_ROLLOUT');

  await ctx.delete(`/api/sessions/${id}`);
  await ctx.dispose();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
});

test('the registry, not the server, decides whether a path may be cached', async () => {
  // The distinction is a provider fact: Claude's path is a derivation (cacheable),
  // Codex's is a discovery (not). Unknown/absent agents default to stable so no
  // existing behaviour changes.
  const agents = require('../lib/agents');
  expect(agents.transcriptPathIsStable('claude')).toBe(true);
  expect(agents.transcriptPathIsStable('codex')).toBe(false);
  expect(agents.transcriptPathIsStable(null)).toBe(true);
  expect(agents.transcriptPathIsStable('not-an-agent')).toBe(true);
});

async function mkSession(ctx, body) {
  const r = await ctx.post('/api/sessions', { data: body });
  return (await r.json()).id;
}

test('a Codex session reports its rollout UUID as agentSessionId', async () => {
  // The wire-level half of the fix: without this field a client caching the transcript
  // has nothing to compare, which is how the companion kept showing a 17h-old
  // conversation beside a live terminal.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-convid-'));
  const ctx = await authCtx();
  const uuid = '019f8928-94e9-7072-93d3-271f00fbaea7';
  const p = path.join(FIXTURE_DIR, `rollout-2097-02-02T00-00-00-${uuid}.jsonl`);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(p, [
    line('session_meta', { id: uuid, cwd, cli_version: '0.144.6' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }),
  ].join('\n') + '\n', 'utf8');
  created.push(p);

  const id = await mkSession(ctx, { name: 'codex-convid', cwd, agent: 'codex' });
  const list = await (await ctx.get('/api/sessions')).json();
  const arr = Array.isArray(list) ? list : (list.sessions || []);
  const s = arr.find((x) => x.id === id);

  expect(s.agentSessionId).toBe(uuid);
  // NOT folded into claudeSessionId: app.html shows the Fork button on that field and
  // forks with `claude --resume <id>`, which cannot work for a Codex conversation.
  expect(s.claudeSessionId == null).toBeTruthy();

  await ctx.delete(`/api/sessions/${id}`);
  await ctx.dispose();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
});

test('a plain shell reports no conversation id', async () => {
  const ctx = await authCtx();
  const id = await mkSession(ctx, { name: 'shell-convid', cwd: os.tmpdir() });
  const list = await (await ctx.get('/api/sessions')).json();
  const arr = Array.isArray(list) ? list : (list.sessions || []);
  expect(arr.find((x) => x.id === id).agentSessionId == null).toBeTruthy();
  await ctx.delete(`/api/sessions/${id}`);
  await ctx.dispose();
});
