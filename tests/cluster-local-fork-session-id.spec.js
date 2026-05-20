// @ts-check
// Regression: the fork button in the cluster sidebar only renders when a
// session carries `claudeSessionId` (app.html). _computeClusterSessions()
// preserved that field for REMOTE sessions (via {...s}) but the LOCAL-sessions
// branch built the object field-by-field and dropped it — so a server's own
// sessions never showed a fork button when viewed through its own cluster
// sidebar, only other servers' sessions did.
const { test, expect } = require('@playwright/test');
const { authCtx } = require('./test-helpers');

test.describe('cluster/sessions exposes claudeSessionId for local sessions', () => {
  test('local session in /api/cluster/sessions carries claudeSessionId from a hook', async () => {
    const ctx = await authCtx();
    let id;
    try {
      const created = await ctx.post('/api/sessions', {
        data: { name: 'Fork Field Test', autoCommand: 'claude --continue' },
      });
      expect(created.status()).toBe(200);
      id = (await created.json()).id;

      // A hook payload pins the Claude session UUID onto the session.
      const claudeUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const hookRes = await ctx.post(`/api/session/${id}/hook`, {
        data: { event: 'UserPromptSubmit', session_id: claudeUuid },
      });
      expect(hookRes.status()).toBe(200);
      await new Promise(r => setTimeout(r, 200)); // worker persist tick

      const res = await ctx.get('/api/cluster/sessions');
      expect(res.status()).toBe(200);
      const data = await res.json();
      const session = data.sessions.find(s => s.id === id);
      expect(session).toBeTruthy();
      expect(session.serverUrl).toBe(null);             // it is a local session
      expect(session.claudeSessionId).toBe(claudeUuid); // ...the fork field must survive
    } finally {
      if (id) { try { await ctx.delete('/api/sessions/' + id); } catch {} }
      await ctx.dispose();
    }
  });
});
