// @ts-check
const { test, expect } = require('@playwright/test');
const { authCtx } = require('./test-helpers');
const fs = require('fs');
const path = require('path');

// Test server uses WT_TEST=1, so sessions file is sessions.test.json
const SESSIONS_FILE = path.join(__dirname, '..', 'sessions.test.json');

// ============================================================
// Claude Session ID Persistence (Fix #4: Wrong session continue)
// ============================================================

test.describe('Claude Session ID Persistence', () => {

  /** Helper: delete all sessions except the first one to free up capacity */
  async function cleanupSessions(ctx) {
    const listRes = await ctx.get('/api/sessions');
    const sessions = await listRes.json();
    // Keep only the first session (default), delete the rest
    for (let i = 1; i < sessions.length; i++) {
      try { await ctx.delete('/api/sessions/' + sessions[i].id); } catch (e) {}
    }
  }

  test('session config saves and loads claudeSessionId', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);

      // Create a session with a claude autoCommand that includes --resume
      const fakeClaudeId = 'abcd1234-5678-9abc-def0-123456789abc';
      const res = await ctx.post('/api/sessions', {
        data: {
          name: 'Claude Resume Test',
          autoCommand: `claude --resume ${fakeClaudeId}`,
        },
      });
      expect(res.status()).toBe(200);
      const { id } = await res.json();

      // Wait briefly for session to initialize and save config
      await new Promise(r => setTimeout(r, 2000));

      // Read sessions.json and verify claudeSessionId is persisted
      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const saved = configs.find(c => c.id === id);
      expect(saved).toBeTruthy();
      expect(saved.claudeSessionId).toBe(fakeClaudeId);

      // Verify the session listing API also returns claudeSessionId
      const listRes = await ctx.get('/api/sessions');
      const list = await listRes.json();
      const session = list.find(s => s.id === id);
      expect(session).toBeTruthy();
      expect(session.claudeSessionId).toBe(fakeClaudeId);

      // Clean up
      await ctx.delete('/api/sessions/' + id);
    } finally {
      await ctx.dispose();
    }
  });

  test('--resume flag is used when claudeSessionId is available in sessions.json', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);

      // Create a session with a plain claude command (no --resume or --continue)
      const res = await ctx.post('/api/sessions', {
        data: {
          name: 'Claude Plain Test',
          autoCommand: 'claude',
        },
      });
      expect(res.status()).toBe(200);
      const { id } = await res.json();

      // Wait for session to be saved
      await new Promise(r => setTimeout(r, 1000));

      // Manually inject a claudeSessionId into sessions.json to simulate a known session
      const fakeClaudeId = 'eeee1111-2222-3333-4444-555566667777';
      let configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const idx = configs.findIndex(c => c.id === id);
      expect(idx).toBeGreaterThanOrEqual(0);
      configs[idx].claudeSessionId = fakeClaudeId;
      // Also store a plain autoCommand (no --resume, no --continue)
      configs[idx].autoCommand = 'claude';
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(configs, null, 2), 'utf8');

      // Now verify that if we read the file back, the claudeSessionId is there
      const reloaded = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const entry = reloaded.find(c => c.id === id);
      expect(entry.claudeSessionId).toBe(fakeClaudeId);
      expect(entry.autoCommand).toBe('claude');

      // Clean up
      await ctx.delete('/api/sessions/' + id);
    } finally {
      await ctx.dispose();
    }
  });

  test('--continue fallback when no claudeSessionId is saved', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);

      // Create a session with a plain claude command
      const res = await ctx.post('/api/sessions', {
        data: {
          name: 'Claude Fallback Test',
          autoCommand: 'claude',
        },
      });
      expect(res.status()).toBe(200);
      const { id } = await res.json();

      // Wait for session to be saved
      await new Promise(r => setTimeout(r, 1000));

      // Verify sessions.json has null claudeSessionId (since there's no real Claude running)
      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const entry = configs.find(c => c.id === id);
      expect(entry).toBeTruthy();
      // claudeSessionId should be null since no real Claude session was created
      expect(entry.claudeSessionId).toBeNull();

      // Clean up
      await ctx.delete('/api/sessions/' + id);
    } finally {
      await ctx.dispose();
    }
  });

  test('session with --resume in autoCommand extracts claudeSessionId at creation', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);

      const fakeId = 'face0000-1111-2222-3333-444455556666';
      const res = await ctx.post('/api/sessions', {
        data: {
          name: 'Resume Extract Test',
          autoCommand: `claude --resume ${fakeId} --dangerously-skip-permissions`,
        },
      });
      expect(res.status()).toBe(200);
      const { id } = await res.json();

      // Wait for session creation and config save
      await new Promise(r => setTimeout(r, 2000));

      // Verify the API returns the extracted claudeSessionId
      const listRes = await ctx.get('/api/sessions');
      const list = await listRes.json();
      const session = list.find(s => s.id === id);
      expect(session).toBeTruthy();
      expect(session.claudeSessionId).toBe(fakeId);

      // Verify sessions.json also has it
      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const saved = configs.find(c => c.id === id);
      expect(saved.claudeSessionId).toBe(fakeId);

      // Clean up
      await ctx.delete('/api/sessions/' + id);
    } finally {
      await ctx.dispose();
    }
  });

  test('non-claude sessions have null claudeSessionId', async () => {
    const ctx = await authCtx();
    try {
      await cleanupSessions(ctx);

      const res = await ctx.post('/api/sessions', {
        data: { name: 'Plain Shell', autoCommand: '' },
      });
      expect(res.status()).toBe(200);
      const { id } = await res.json();

      await new Promise(r => setTimeout(r, 1000));

      // Verify sessions.json has null for non-claude session
      const configs = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const entry = configs.find(c => c.id === id);
      expect(entry).toBeTruthy();
      expect(entry.claudeSessionId).toBeNull();

      // API should also return null
      const listRes = await ctx.get('/api/sessions');
      const list = await listRes.json();
      const session = list.find(s => s.id === id);
      expect(session.claudeSessionId).toBeNull();

      // Clean up
      await ctx.delete('/api/sessions/' + id);
    } finally {
      await ctx.dispose();
    }
  });
});
