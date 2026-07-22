// @ts-check
// A conversation needs an identity ON THE WIRE, or a cache has nothing to invalidate.
//
// Reported from Office: a Codex session's terminal was live ("Working…", session
// 019f8928-… in C:\dev\acme_core) while the chat lens beside it showed a conversation
// from 17h earlier. The server was serving the CURRENT rollout — verified against the
// API — so the stale copy was the client's.
//
// Cause: the companion drops its cached turns when `claudeSessionId` changes (#35,
// /clear mints a new one). For Codex that field is ALWAYS null, so when the server
// legitimately moved to a different rollout the client had no signal at all. Same
// missing fact the server itself lacked in 1.45.1, one layer up.
const { test, expect } = require('@playwright/test');
const agents = require('../lib/agents');

test.describe('conversationIdFromPath — the registry owns the derivation', () => {
  test('codex: the rollout UUID, not the ISO stamp', () => {
    // The filename is rollout-<iso>-<uuid>.jsonl and the ISO stamp is full of dashes,
    // so splitting on '-' would pick up the date. This is the same value Codex prints
    // as `Session:` in /status.
    const p = 'C:\\Users\\x\\.codex\\sessions\\2026\\07\\22\\rollout-2026-07-22T09-33-43-019f8928-94e9-7072-93d3-271f00fbaea7.jsonl';
    expect(agents.conversationIdFromPath('codex', p)).toBe('019f8928-94e9-7072-93d3-271f00fbaea7');
  });

  test('codex: forward slashes work too', () => {
    const p = '/home/x/.codex/sessions/2026/07/22/rollout-2026-07-22T09-33-43-019f8928-94e9-7072-93d3-271f00fbaea7.jsonl';
    expect(agents.conversationIdFromPath('codex', p)).toBe('019f8928-94e9-7072-93d3-271f00fbaea7');
  });

  test('claude: the basename IS the conversation id', () => {
    const p = 'C:\\Users\\x\\.claude\\projects\\C--dev-proj\\abc12345-6789-4abc-8def-000000000001.jsonl';
    expect(agents.conversationIdFromPath('claude', p)).toBe('abc12345-6789-4abc-8def-000000000001');
  });

  test('two rollouts in ONE cwd yield DIFFERENT ids', () => {
    // The whole point: cwd is not an identity. Office had seven rollouts in
    // C:\dev\acme_core, so "which conversation am I showing" cannot be answered by
    // directory — only by this id.
    const a = 'x/rollout-2026-07-22T09-33-43-019f8928-94e9-7072-93d3-271f00fbaea7.jsonl';
    const b = 'x/rollout-2026-07-21T15-45-49-019f84c8-410f-77f2-989e-d5a235e46b53.jsonl';
    const ida = agents.conversationIdFromPath('codex', a);
    const idb = agents.conversationIdFromPath('codex', b);
    expect(ida).not.toBe(idb);
    expect(ida && idb).toBeTruthy();
  });

  test('a plain shell and unknown agents have no conversation id', () => {
    expect(agents.conversationIdFromPath(null, 'x/rollout-2026-07-22T00-00-00-019f8928-94e9-7072-93d3-271f00fbaea7.jsonl')).toBeNull();
    expect(agents.conversationIdFromPath('not-an-agent', 'x/y.jsonl')).toBeNull();
  });

  test('a non-transcript path yields null rather than a bogus id', () => {
    expect(agents.conversationIdFromPath('codex', 'C:\\dev\\notes.txt')).toBeNull();
    expect(agents.conversationIdFromPath('codex', '')).toBeNull();
    expect(agents.conversationIdFromPath('claude', '')).toBeNull();
  });
});
