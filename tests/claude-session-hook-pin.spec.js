// @ts-check
// Hook-reported Claude session UUID pinning.
//
// Bug: two web-terminal sessions in the same cwd, both running `claude
// --continue`, would resolve to the same Claude session UUID via filesystem-
// mtime detection (newest .jsonl in the project dir). After a server
// restart, both --resumed the same Claude session and the original was lost.
//
// Fix: Claude's hook payload carries the per-run `session_id`. We forward
// it through the hook endpoint and pin it onto the web-terminal session,
// overriding any earlier (possibly-colliding) detection guess. Because each
// concurrent `claude` process emits its own UUID in its own hooks, two
// sessions in the same cwd end up with distinct, persisted UUIDs that
// survive a restart.
const { test, expect } = require('@playwright/test');
const { authCtx } = require('./test-helpers');
const fs = require('fs');
const path = require('path');

const SESSIONS_FILE = path.join(__dirname, '..', 'sessions.test.json');

test.describe('Claude session UUID pinned from hook payload', () => {
  async function cleanupSessions(ctx) {
    const listRes = await ctx.get('/api/sessions');
    const sessions = await listRes.json();
    for (let i = 1; i < sessions.length; i++) {
      try { await ctx.delete('/api/sessions/' + sessions[i].id); } catch {}
    }
  }

  test('hook session_id is persisted to sessions.json', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);
      const res = await ctx.post('/api/sessions', {
        data: { name: 'Hook Pin Test', autoCommand: 'claude --continue' },
      });
      expect(res.status()).toBe(200);
      const { id } = await res.json();

      const claudeUuid = '11111111-2222-3333-4444-555555555555';
      const hookRes = await ctx.post(`/api/session/${id}/hook`, {
        data: { event: 'UserPromptSubmit', session_id: claudeUuid },
      });
      expect(hookRes.status()).toBe(200);

      // Give the worker a tick to persist.
      await new Promise(r => setTimeout(r, 200));

      const list = await (await ctx.get('/api/sessions')).json();
      const session = list.find(s => s.id === id);
      expect(session.claudeSessionId).toBe(claudeUuid);

      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const saved = configs.find(c => c.id === id);
      expect(saved.claudeSessionId).toBe(claudeUuid);

      await ctx.delete('/api/sessions/' + id);
    } finally { await ctx.dispose(); }
  });

  test('two sessions in the same cwd retain distinct UUIDs', async () => {
    // The original bug: filesystem-mtime detection collapses both to one UUID.
    // With hook pinning each session keeps the UUID Claude reported for it.
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);
      const sharedCwd = process.cwd();

      const a = await (await ctx.post('/api/sessions', {
        data: { name: 'Sib A', cwd: sharedCwd, autoCommand: 'claude --continue' },
      })).json();
      const b = await (await ctx.post('/api/sessions', {
        data: { name: 'Sib B', cwd: sharedCwd, autoCommand: 'claude --continue' },
      })).json();

      const uuidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const uuidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      await ctx.post(`/api/session/${a.id}/hook`, {
        data: { event: 'UserPromptSubmit', session_id: uuidA },
      });
      await ctx.post(`/api/session/${b.id}/hook`, {
        data: { event: 'UserPromptSubmit', session_id: uuidB },
      });
      await new Promise(r => setTimeout(r, 200));

      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const savedA = configs.find(c => c.id === a.id);
      const savedB = configs.find(c => c.id === b.id);
      expect(savedA.claudeSessionId).toBe(uuidA);
      expect(savedB.claudeSessionId).toBe(uuidB);
      expect(savedA.claudeSessionId).not.toBe(savedB.claudeSessionId);

      await ctx.delete('/api/sessions/' + a.id);
      await ctx.delete('/api/sessions/' + b.id);
    } finally { await ctx.dispose(); }
  });

  test('hook payload overwrites a stale claudeSessionId', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);
      const stale = 'deadbeef-0000-0000-0000-000000000000';
      const res = await ctx.post('/api/sessions', {
        data: { name: 'Overwrite Test', autoCommand: `claude --resume ${stale}` },
      });
      const { id } = await res.json();
      await new Promise(r => setTimeout(r, 500));

      // Verify the cmd-extracted UUID is in place.
      let configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      expect(configs.find(c => c.id === id).claudeSessionId).toBe(stale);

      // Hook reports a different UUID — Claude forked into a new conversation.
      const fresh = 'cafef00d-1111-2222-3333-444444444444';
      await ctx.post(`/api/session/${id}/hook`, {
        data: { event: 'UserPromptSubmit', session_id: fresh },
      });
      await new Promise(r => setTimeout(r, 200));

      configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      expect(configs.find(c => c.id === id).claudeSessionId).toBe(fresh);

      await ctx.delete('/api/sessions/' + id);
    } finally { await ctx.dispose(); }
  });

  test('worker restart turns "claude --continue" into "claude --resume <id>"', async () => {
    // The original failure: after a server restart, two same-cwd sessions
    // restored with `claude --continue` both resumed the most-recent jsonl
    // (collision). Once a hook has pinned a UUID, restore must rewrite the
    // command to `--resume <id>` so each session re-attaches to its own
    // Claude conversation. We can't exercise the cross-process restart from
    // a Playwright test, so we call the worker's own restore-cmd resolution.
    //
    // #360: this used to run a hand-copied PASTE of that rule in a child
    // process, and the paste had drifted - it still asserted the pre-#23
    // `--continue` fallback the module had dropped long before. Import the
    // module the worker imports, so the test can only ever pin the real rule.
    const { resolveRestoreRunCommand: rebuild } = require('../lib/restore-command');
    const id = 'cafef00d-1111-2222-3333-444444444444';
    const r = (autoCommand, claudeSessionId) => rebuild({ autoCommand, claudeSessionId });
    // The exact buggy input the user reported: --continue + known UUID.
    expect(r('claude --continue', id)).toBe('claude --resume cafef00d-1111-2222-3333-444444444444');
    // With --resume <stale> + a fresher known UUID, it should re-pin.
    expect(r('claude --resume deadbeef-0000-0000-0000-000000000000', id)).toBe('claude --resume cafef00d-1111-2222-3333-444444444444');
    // No UUID known: start fresh, never an implicit --continue (#23).
    expect(r('claude', null)).toBe('claude');
    // Already plain claude with UUID → just append --resume.
    expect(r('claude --dangerously-skip-permissions', id)).toBe('claude --dangerously-skip-permissions --resume cafef00d-1111-2222-3333-444444444444');
  });

  test('malformed session_id is rejected (no UUID, no overwrite)', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);
      const valid = 'feedface-0001-0002-0003-000000000004';
      const res = await ctx.post('/api/sessions', {
        data: { name: 'Reject Test', autoCommand: `claude --resume ${valid}` },
      });
      const { id } = await res.json();
      await new Promise(r => setTimeout(r, 500));

      // Garbage values must not clobber an existing UUID.
      for (const bad of ['../../etc/passwd', 'not-a-uuid', '<script>', '']) {
        const r = await ctx.post(`/api/session/${id}/hook`, {
          data: { event: 'UserPromptSubmit', session_id: bad },
        });
        expect(r.status()).toBe(200);
      }
      await new Promise(r => setTimeout(r, 200));
      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      expect(configs.find(c => c.id === id).claudeSessionId).toBe(valid);

      await ctx.delete('/api/sessions/' + id);
    } finally { await ctx.dispose(); }
  });
});
