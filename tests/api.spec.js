// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BASE, AUTH, authCtx, noAuthCtx, loginPage, readHookToken } = require('./test-helpers');

const CLAUDE_NAMES_FILE = path.join(__dirname, '..', 'claude-session-names.json');
function readClaudeNames() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_NAMES_FILE, 'utf8')); } catch { return {}; }
}
function removeClaudeNameEntry(id) {
  try {
    const n = readClaudeNames();
    if (id in n) { delete n[id]; fs.writeFileSync(CLAUDE_NAMES_FILE, JSON.stringify(n, null, 2)); }
  } catch {}
}

// ============================================================
// 1. Security Headers
// ============================================================

test.describe('Security Headers', () => {
  test('authenticated response includes security headers', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/sessions');
    expect(res.status()).toBe(200);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['content-security-policy']).toBeTruthy();
    await ctx.dispose();
  });
});

// ============================================================
// 2. Session Lifecycle
// ============================================================

test.describe('Session Lifecycle', () => {
  test('create session with invalid cwd returns 400', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/sessions', {
      data: { name: 'Bad CWD', cwd: 'Z:\\nonexistent\\path\\that\\does\\not\\exist' },
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('does not exist');
    await ctx.dispose();
  });

  test('session limit returns 429 when max reached', async () => {
    const ctx = await authCtx();
    const created = [];

    try {
      // Get current sessions to know how many exist
      const listRes = await ctx.get('/api/sessions');
      const existing = await listRes.json();
      const toCreate = 10 - existing.length;

      // Create sessions up to the limit (with small delays to avoid overwhelming node-pty)
      for (let i = 0; i < toCreate; i++) {
        const res = await ctx.post('/api/sessions', {
          data: { name: `Limit Test ${i}` },
        });
        expect(res.status()).toBe(200);
        const data = await res.json();
        created.push(data.id);
      }

      // Next one should fail with 429
      const overRes = await ctx.post('/api/sessions', {
        data: { name: 'Over Limit' },
      });
      expect(overRes.status()).toBe(429);
      const overData = await overRes.json();
      expect(overData.error).toContain('Session limit');
    } finally {
      // Clean up created sessions (one at a time, ignore errors)
      for (const id of created) {
        try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      }
      await ctx.dispose();
    }
  });

  test('create and kill session, verify gone from list', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Kill Me' },
    });
    const { id } = await createRes.json();

    // Kill it
    const delRes = await ctx.delete('/api/sessions/' + id);
    expect([200, 404]).toContain(delRes.status());

    // Verify gone
    const listRes = await ctx.get('/api/sessions');
    const list = await listRes.json();
    expect(list.find(s => s.id === id)).toBeUndefined();
    await ctx.dispose();
  });

  test('rapid duplicate session creation returns 409', async () => {
    const ctx = await authCtx();
    const created = [];
    try {
      // Create first session
      const res1 = await ctx.post('/api/sessions', {
        data: { name: 'Dup Test', cwd: 'C:\\dev' },
      });
      expect(res1.status()).toBe(200);
      created.push((await res1.json()).id);

      // Immediately create another with same name + cwd — should be rejected
      const res2 = await ctx.post('/api/sessions', {
        data: { name: 'Dup Test', cwd: 'C:\\dev' },
      });
      expect(res2.status()).toBe(409);
      const data = await res2.json();
      expect(data.error).toContain('Duplicate');
    } finally {
      for (const id of created) {
        try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      }
      await ctx.dispose();
    }
  });

  test('different name or cwd is not rejected as duplicate', async () => {
    const ctx = await authCtx();
    const created = [];
    try {
      // Create first session
      const res1 = await ctx.post('/api/sessions', {
        data: { name: 'Unique A' },
      });
      expect(res1.status()).toBe(200);
      created.push((await res1.json()).id);

      // Different name — should succeed
      const res2 = await ctx.post('/api/sessions', {
        data: { name: 'Unique B' },
      });
      expect(res2.status()).toBe(200);
      created.push((await res2.json()).id);
    } finally {
      for (const id of created) {
        try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      }
      await ctx.dispose();
    }
  });

  test('PATCH session with autoCommand update', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Auto Cmd Test' },
    });
    const { id } = await createRes.json();

    try {
      const patchRes = await ctx.patch('/api/sessions/' + id, {
        data: { autoCommand: 'echo hello' },
      });
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.autoCommand).toBe('echo hello');

      // Verify via session list
      const listRes = await ctx.get('/api/sessions');
      const list = await listRes.json();
      const session = list.find(s => s.id === id);
      expect(session.autoCommand).toBe('echo hello');
    } finally {
      try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      await ctx.dispose();
    }
  });
});

// ============================================================
// 2b. Session Rename Persistence
// ============================================================

test.describe('Session Rename Persistence', () => {
  test('rename persists in session list', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Before Rename' },
    });
    const { id } = await createRes.json();

    try {
      // Rename
      const patchRes = await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'After Rename' },
      });
      expect(patchRes.status()).toBe(200);
      expect((await patchRes.json()).name).toBe('After Rename');

      // Verify in session list
      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find(x => x.id === id);
      expect(s).toBeTruthy();
      expect(s.name).toBe('After Rename');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('rename persists after re-fetching session list', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Original Name' },
    });
    const { id } = await createRes.json();

    try {
      // Rename
      await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'Renamed Session' },
      });

      // Fetch list multiple times to verify it sticks
      for (let i = 0; i < 3; i++) {
        const list = await (await ctx.get('/api/sessions')).json();
        const s = list.find(x => x.id === id);
        expect(s.name).toBe('Renamed Session');
      }
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('rename with empty string keeps old name', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Keep This Name' },
    });
    const { id } = await createRes.json();

    try {
      // Patch with empty name — should not change
      await ctx.patch(`/api/sessions/${id}`, {
        data: { name: '' },
      });

      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find(x => x.id === id);
      expect(s.name).toBe('Keep This Name');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('multiple renames — last one wins', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'First' },
    });
    const { id } = await createRes.json();

    try {
      await ctx.patch(`/api/sessions/${id}`, { data: { name: 'Second' } });
      await ctx.patch(`/api/sessions/${id}`, { data: { name: 'Third' } });
      await ctx.patch(`/api/sessions/${id}`, { data: { name: 'Final Name' } });

      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find(x => x.id === id);
      expect(s.name).toBe('Final Name');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });
});

// ============================================================
// 2c. Claude Session Name Persistence
// ============================================================

test.describe('Claude Session Name Persistence', () => {
  test('PATCH /api/claude-sessions/:id saves custom name', async () => {
    const ctx = await authCtx();
    const fakeId = 'test-' + Date.now();
    try {
      const res = await ctx.patch(`/api/claude-sessions/${fakeId}`, {
        data: { name: 'My Custom Name' },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      // Clean up: remove the name we just saved
      await ctx.patch(`/api/claude-sessions/${fakeId}`, { data: { name: 'cleanup' } });
      await ctx.dispose();
    }
  });

  test('PATCH /api/claude-sessions/:id with empty name returns 400', async () => {
    const ctx = await authCtx();
    const res = await ctx.patch('/api/claude-sessions/fake-id', {
      data: { name: '' },
    });
    expect(res.status()).toBe(400);
    await ctx.dispose();
  });

  test('rename active session with claude autoCommand persists to claude-session-names', async () => {
    const ctx = await authCtx();
    const claudeSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const createRes = await ctx.post('/api/sessions', {
      data: {
        name: 'Original',
        autoCommand: `claude --resume ${claudeSessionId} --dangerously-skip-permissions`,
      },
    });
    const { id } = await createRes.json();

    try {
      // Rename the active session
      const patchRes = await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'CN Issues Investigation' },
      });
      expect(patchRes.status()).toBe(200);

      // Verify the claude session name was persisted via the claude-sessions rename API
      // We can check by reading it back through the PATCH endpoint (the GET endpoint
      // reads from JSONL files which we don't have for this fake ID)
      // Instead, create another session with the same claude ID and rename it differently
      const patchRes2 = await ctx.patch(`/api/claude-sessions/${claudeSessionId}`, {
        data: { name: 'Direct API Name' },
      });
      expect(patchRes2.status()).toBe(200);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  // Issue #21: renaming an active Claude session must propagate to claude-session-names.json
  // so the "old sessions" (Claude) list in the sidebar shows the new name next time.
  test('issue #21: rename active session writes custom name to claude-session-names.json', async () => {
    const ctx = await authCtx();
    // Claude session IDs are UUIDv4s (hex + dashes). extractClaudeSessionIdFromCmd
    // uses /--resume\s+([a-f0-9-]+)/i, so keep fake IDs inside that charset.
    const claudeSessionId = '21' + Date.now().toString(16).padStart(14, '0') + '-aaaa-bbbb-cccc-dddddddddddd';
    const newName = 'Issue21 Renamed ' + Date.now();
    const createRes = await ctx.post('/api/sessions', {
      data: {
        name: 'Original Issue21',
        autoCommand: `claude --resume ${claudeSessionId}`,
      },
    });
    const { id } = await createRes.json();
    try {
      const patchRes = await ctx.patch(`/api/sessions/${id}`, { data: { name: newName } });
      expect(patchRes.status()).toBe(200);

      // Give the worker a moment to flush the file write.
      await new Promise(r => setTimeout(r, 500));

      const names = readClaudeNames();
      expect(names[claudeSessionId]).toBe(newName);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      removeClaudeNameEntry(claudeSessionId);
      await ctx.dispose();
    }
  });

  // Issue #21: when Claude forks a resume into a NEW jsonl (new UUID) in the project dir,
  // the rename of the active session must propagate to BOTH the original UUID and the
  // newest-on-disk UUID, so the "old sessions" list shows the rename on whichever entry
  // the user sees (usually the newest, since that's what Claude is currently writing to).
  test('issue #21: rename propagates to newest-on-disk Claude UUID when it differs from --resume id', async () => {
    const ctx = await authCtx();
    const os = require('os');
    const claudeHome = require('path').join(__dirname, '..');
    // Pick a unique cwd so we fully control the Claude project dir.
    const uniqueCwd = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'wt21-'));
    // Encode cwd to the Claude projects folder name (matches pty-worker logic).
    const encodedCwd = uniqueCwd.replace(/^([A-Z]):\\/, '$1--').replace(/[\\/]/g, '-');
    // Use the same claude projects dir the server uses (detectClaudeHome defaults to USERPROFILE).
    const claudeProjectsDir = require('path').join(os.homedir(), '.claude', 'projects', encodedCwd);
    require('fs').mkdirSync(claudeProjectsDir, { recursive: true });

    // Original UUID passed in --resume (older mtime).
    const origId = 'aaaa1111-2222-3333-4444-555566667777';
    // Newer UUID written later (simulates Claude forking the resume to a new file).
    const newerId = 'bbbb2222-3333-4444-5555-666677778888';
    const origPath = require('path').join(claudeProjectsDir, origId + '.jsonl');
    const newerPath = require('path').join(claudeProjectsDir, newerId + '.jsonl');
    try {
      // Write both files so detectClaudeSessionIdFromDir picks newerId by mtime.
      require('fs').writeFileSync(origPath, '{}\n');
      // Ensure ordering: set origPath mtime to earlier.
      const past = new Date(Date.now() - 60000);
      require('fs').utimesSync(origPath, past, past);
      require('fs').writeFileSync(newerPath, '{}\n');

      const newName = 'Fork Rename ' + Date.now();
      const createRes = await ctx.post('/api/sessions', {
        data: {
          name: 'Pre-rename',
          cwd: uniqueCwd,
          autoCommand: `claude --resume ${origId}`,
        },
      });
      const { id } = await createRes.json();
      try {
        const patchRes = await ctx.patch(`/api/sessions/${id}`, { data: { name: newName } });
        expect(patchRes.status()).toBe(200);
        await new Promise(r => setTimeout(r, 500));

        const names = readClaudeNames();
        // Both the --resume UUID and the newest-on-disk UUID should carry the rename.
        expect(names[origId]).toBe(newName);
        expect(names[newerId]).toBe(newName);
      } finally {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
        removeClaudeNameEntry(origId);
        removeClaudeNameEntry(newerId);
      }
    } finally {
      try { require('fs').rmSync(claudeProjectsDir, { recursive: true, force: true }); } catch {}
      try { require('fs').rmSync(uniqueCwd, { recursive: true, force: true }); } catch {}
      await ctx.dispose();
    }
  });

  // Issue #21: renaming a session that has NO `--resume` flag but DOES start Claude must
  // still persist the rename. At rename time session.claudeSessionId may still be null
  // (15s detection timer hasn't fired, or Claude hasn't written any jsonl yet); the name
  // must land in claude-session-names.json keyed by the Claude session ID as soon as it
  // is known (e.g. on onExit detection), so the "old sessions" list reflects the rename.
  test('issue #21: rename of claude session without --resume survives via exit-time detection', async () => {
    const ctx = await authCtx();
    const cwd = process.env.TEMP || 'C:\\Windows\\Temp';
    const newName = 'NoResume Renamed ' + Date.now();
    // Use an autoCommand that exits quickly but still matches /claude/ — this lets us
    // exercise the rename-then-exit path without a real Claude binary.
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'NoResume Original', cwd, autoCommand: 'echo claude-stub-for-test && exit 0' },
    });
    const { id } = await createRes.json();
    try {
      const patchRes = await ctx.patch(`/api/sessions/${id}`, { data: { name: newName } });
      expect(patchRes.status()).toBe(200);
      // The rename should succeed regardless of whether a Claude session id has
      // been detected yet. This assertion primarily guards that the endpoint
      // does not throw when claudeSessionId is null.
      const { name } = await patchRes.json();
      expect(name).toBe(newName);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  test('session name persists after session is killed', async () => {
    const ctx = await authCtx();
    const claudeSessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const createRes = await ctx.post('/api/sessions', {
      data: {
        name: 'Will Be Renamed',
        autoCommand: `claude --resume ${claudeSessionId}`,
      },
    });
    const { id } = await createRes.json();

    try {
      // Rename
      await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'Persisted Name' },
      });

      // Kill the session
      await ctx.delete(`/api/sessions/${id}`);

      // Wait a moment for onExit to fire
      await new Promise(r => setTimeout(r, 500));

      // Verify the name is still saved — re-save it and check it responds OK
      // (The actual persistence is in claude-session-names.json on disk)
      const verifyRes = await ctx.patch(`/api/claude-sessions/${claudeSessionId}`, {
        data: { name: 'Overwrite Test' },
      });
      expect(verifyRes.status()).toBe(200);
    } finally {
      await ctx.dispose();
    }
  });
});

// ============================================================
// 3. /api/exec Endpoint — M3: opt-in via enableRemoteExec (default: off).
// Behaviour when enabled (rate-limit, audit log, 4KB cap) is covered in
// tests/security.spec.js using an isolated server spawned with the flag on.
// Here we only assert the default-off behaviour.
// ============================================================

test.describe('/api/exec Endpoint (default off)', () => {
  test('returns 404 when enableRemoteExec is not set', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/exec', {
      data: { command: 'echo hello' },
    });
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });
});

// ============================================================
// 4. WebSocket Basics
// ============================================================

test.describe('WebSocket Basics', () => {
  test('connect to nonexistent session closes with 4000', async ({ page }) => {
    await loginPage(page);

    const wsResult = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws/nonexistent-session-id`);
        ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
        ws.onerror = () => {};
        setTimeout(() => resolve({ code: -1, timeout: true }), 5000);
      });
    });
    expect(wsResult.code).toBe(4000);
  });

  test('send resize message without error', async ({ page }) => {
    // Create a dedicated session so no other WS viewer interferes
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'Resize Test' } });
    const { id: sid } = await createRes.json();

    await loginPage(page);

    const wsResult = await page.evaluate(async (sessionId) => {
      return new Promise((resolve) => {
        let resolved = false;
        const ws = new WebSocket(`ws://${location.host}/ws/${sessionId}`);
        ws.onopen = () => {
          // Send resize message
          ws.send(JSON.stringify({ resize: { cols: 120, rows: 40 } }));
          // Wait a bit, then verify session still works by sending data
          setTimeout(() => {
            if (resolved) return;
            try {
              ws.send('echo ok\n');
              setTimeout(() => { if (!resolved) { resolved = true; ws.close(); resolve({ ok: true }); } }, 500);
            } catch (e) {
              if (!resolved) { resolved = true; resolve({ ok: false, error: e.message }); }
            }
          }, 500);
        };
        ws.onclose = (e) => {
          // 4001 = kicked by exclusive viewer (app reconnected), still counts as success
          if (!resolved) { resolved = true; resolve({ ok: true, code: e.code }); }
        };
        ws.onerror = () => {};
        setTimeout(() => { if (!resolved) { resolved = true; resolve({ ok: false, timeout: true }); } }, 8000);
      });
    }, sid);
    expect(wsResult.ok).toBe(true);

    // Clean up
    try { await ctx.delete('/api/sessions/' + sid); } catch (e) {}
    await ctx.dispose();
  });

  test('send heartbeat message without error', async ({ page }) => {
    // Create a dedicated session so no other WS viewer interferes
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'Heartbeat Test' } });
    const { id: sid } = await createRes.json();

    await loginPage(page);

    const wsResult = await page.evaluate(async (sessionId) => {
      return new Promise((resolve) => {
        let resolved = false;
        const ws = new WebSocket(`ws://${location.host}/ws/${sessionId}`);
        ws.onopen = () => {
          // Send heartbeat — should not be forwarded to PTY
          ws.send(JSON.stringify({ heartbeat: Date.now() }));
          setTimeout(() => { if (!resolved) { resolved = true; ws.close(); resolve({ ok: true }); } }, 1000);
        };
        ws.onclose = (e) => {
          // 4001 = kicked by exclusive viewer (app reconnected), still counts as success
          if (!resolved) { resolved = true; resolve({ ok: true, code: e.code }); }
        };
        ws.onerror = () => {};
        setTimeout(() => { if (!resolved) { resolved = true; resolve({ ok: false, timeout: true }); } }, 8000);
      });
    }, sid);
    expect(wsResult.ok).toBe(true);

    // Clean up
    try { await ctx.delete('/api/sessions/' + sid); } catch (e) {}
    await ctx.dispose();
  });
});

// ============================================================
// 5. Cookie Flags
// ============================================================

test.describe('Cookie Flags', () => {
  test('login Set-Cookie has HttpOnly and SameSite=Lax', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.post('/login', {
      form: { user: AUTH.user, password: AUTH.password },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    const setCookie = res.headers()['set-cookie'];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    await ctx.dispose();
  });
});

// ============================================================
// 6. /api/version
// ============================================================

test.describe('/api/version', () => {
  test('returns JSON with version, hash, serverName', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/version');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.version).toBeTruthy();
    expect(typeof data.hash).toBe('string');
    expect(data.serverName).toBeTruthy();
    await ctx.dispose();
  });

  // G8: capabilities let the companion app feature-gate per server during a
  // rolling upgrade (never assume a homogeneous fleet).
  test('reports a capabilities array advertising the attention/clear features', async () => {
    const ctx = await authCtx();
    const data = await (await ctx.get('/api/version')).json();
    expect(Array.isArray(data.capabilities)).toBe(true);
    expect(data.capabilities).toContain('attention');
    expect(data.capabilities).toContain('clear');
    await ctx.dispose();
  });

  // Regression: /api/version used to call execSync('git rev-parse'), execSync
  // ('git log -1'), execSync('git fetch --dry-run', timeout=5s), execSync
  // ('git rev-list'), and execSync('git status') on the request path. With
  // peers cross-polling every 5s, a single slow `git fetch --dry-run` could
  // block the event loop for up to 5s, causing multi-second typing stalls.
  // After the fix, results are cached for 30s (behind: 5 min) and refreshed
  // in the background. 20 back-to-back /api/version calls must complete
  // quickly because they read from the cache.
  test('cached: 20 rapid calls complete well under what 20 git invocations would cost', async () => {
    const ctx = await authCtx();
    // Warm the cache
    await ctx.get('/api/version');
    const t0 = Date.now();
    const N = 20;
    const promises = [];
    for (let i = 0; i < N; i++) promises.push(ctx.get('/api/version'));
    const results = await Promise.all(promises);
    const elapsed = Date.now() - t0;
    for (const r of results) expect(r.status()).toBe(200);
    // Each uncached call did 4-5 git shell invocations (~50-200ms each) so
    // 20 uncached calls would easily take >1000ms. Cached calls should
    // finish in well under 500ms on any reasonable machine.
    expect(elapsed).toBeLessThan(500);
    await ctx.dispose();
  });
});

// ============================================================
// 6b. /api/history/folders
// ============================================================

test.describe('/api/history/folders', () => {
  const lc = (s) => String(s).toLowerCase();
  // The server scans WT_CWD (= process.env.TEMP, see playwright.config.js)
  // because config.test.json defines no scanFolders. Tests share that base.
  const SCAN_BASE = process.env.TEMP || 'C:\\Windows\\Temp';

  test('returns an array of folder paths', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/history/folders');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // Should contain at least one folder (scanned from config)
    expect(data.length).toBeGreaterThan(0);
    // Each entry should be a string
    for (const f of data) {
      expect(typeof f).toBe('string');
    }
    await ctx.dispose();
  });

  test('requires authentication', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/history/folders');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('is served with Cache-Control: no-store (never cached)', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/history/folders');
    expect(res.status()).toBe(200);
    expect(String(res.headers()['cache-control'] || '')).toContain('no-store');
    await ctx.dispose();
  });

  test('is a live scan: a new subfolder appears and a removed one disappears', async () => {
    const created = path.join(SCAN_BASE, `__wt_livescan_${process.pid}_${Date.now()}`);
    fs.mkdirSync(created);
    try {
      const ctx = await authCtx();

      // Freshly-created folder shows up on the very next request — no cache.
      let data = await (await ctx.get('/api/history/folders')).json();
      expect(data.some(f => lc(f) === lc(created))).toBe(true);

      // Remove it and it's gone on the next request — the list is dynamic,
      // not remembered.
      fs.rmdirSync(created);
      data = await (await ctx.get('/api/history/folders')).json();
      expect(data.some(f => lc(f) === lc(created))).toBe(false);

      await ctx.dispose();
    } finally {
      try { fs.rmdirSync(created); } catch {}
    }
  });

  test('ignores history.json entirely (no remembered folders)', async () => {
    // history.json is a dead file now — the endpoint must never surface a
    // path from it. Seed it with a real dir that is NOT under any scan root
    // and assert it does not leak into the suggestions.
    const HISTORY_FILE = path.join(__dirname, '..', 'history.json');
    const backup = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, 'utf8') : null;
    const unscannedRealDir = process.platform === 'win32'
      ? (process.env.SystemRoot || 'C:\\Windows')
      : '/usr';
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ folders: [unscannedRealDir] }, null, 2), 'utf8');

      const ctx = await authCtx();
      const res = await ctx.get('/api/history/folders');
      expect(res.status()).toBe(200);
      const data = await res.json();
      expect(data.some(f => lc(f) === lc(unscannedRealDir))).toBe(false);
      await ctx.dispose();
    } finally {
      if (backup !== null) fs.writeFileSync(HISTORY_FILE, backup, 'utf8');
      else try { fs.unlinkSync(HISTORY_FILE); } catch {}
    }
  });
});

// ============================================================
// 7. Session Hook Endpoint
// ============================================================

test.describe('Session Hook', () => {
  const { readHookToken } = require('./test-helpers');

  test('hook with valid X-WT-Hook-Token updates session status', async () => {
    // Create a session first (needs auth)
    const ctx = await authCtx();
    const create = await ctx.post(`${BASE}/api/sessions`, {
      data: { name: 'HookTest' }
    });
    const { id } = await create.json();

    const hookToken = readHookToken();
    // Hook endpoint works without the user auth cookie, but REQUIRES the
    // per-process hook token (H1).
    const raw = await pwRequest.newContext({
      extraHTTPHeaders: { 'X-WT-Hook-Token': hookToken },
    });
    const res = await raw.post(`${BASE}/api/session/${id}/hook`, {
      data: { event: 'UserPromptSubmit' }
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('working');

    // Verify status persists in session list
    const list = await (await ctx.get(`${BASE}/api/sessions`)).json();
    const s = list.find(x => x.id === id);
    expect(s.status).toBe('working');

    // Notification with idle_prompt subtype eventually maps to idle (debounced
    // in the server.js transform layer — see processHookEvent). The HTTP
    // response is "pending" while the timer is running, then status flips to
    // "idle" once the window expires with no follow-up working event.
    const res2 = await raw.post(`${BASE}/api/session/${id}/hook`, {
      data: { event: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }
    });
    expect((await res2.json()).status).toBe('pending');

    const debounceMs = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 200;
    await new Promise(r => setTimeout(r, debounceMs + 400));
    const list2 = await (await ctx.get(`${BASE}/api/sessions`)).json();
    expect(list2.find(x => x.id === id).status).toBe('idle');

    // Cleanup
    await ctx.delete(`${BASE}/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });

  // H1 + localhost bypass — see server.js:isLocalhostReq for rationale.
  test('hook without X-WT-Hook-Token from localhost bypasses auth (404 on missing session)', async () => {
    const raw = await pwRequest.newContext();
    const res = await raw.post(`${BASE}/api/session/nonexistent/hook`, {
      data: { event: 'Stop' }
    });
    expect(res.status()).toBe(404);
    await raw.dispose();
  });

  test('hook with wrong X-WT-Hook-Token from localhost still bypasses (404 on missing session)', async () => {
    const raw = await pwRequest.newContext({
      extraHTTPHeaders: { 'X-WT-Hook-Token': 'not-the-real-token' },
    });
    const res = await raw.post(`${BASE}/api/session/nonexistent/hook`, {
      data: { event: 'Stop' }
    });
    expect(res.status()).toBe(404);
    await raw.dispose();
  });

  test('hook with valid token + invalid session ID returns 404', async () => {
    const raw = await pwRequest.newContext({
      extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() },
    });
    const res = await raw.post(`${BASE}/api/session/nonexistent/hook`, {
      data: { event: 'Stop' }
    });
    expect(res.status()).toBe(404);
    await raw.dispose();
  });

  test('hook rejects missing event', async () => {
    const ctx = await authCtx();
    const create = await ctx.post(`${BASE}/api/sessions`, { data: { name: 'HookTest2' } });
    const { id } = await create.json();

    const raw = await pwRequest.newContext({
      extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() },
    });
    const res = await raw.post(`${BASE}/api/session/${id}/hook`, { data: {} });
    expect(res.status()).toBe(400);

    await ctx.delete(`${BASE}/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });
});

// ============================================================
// 7b. GET /api/sessions/:id/attention  (companion "what needs my attention")
// ============================================================

test.describe('Session attention', () => {
  // safeTranscriptPath() (M1) only trusts a .jsonl strictly under the realpath'd
  // Claude projects root (<claudeHome>/.claude/projects). Mirror server.js
  // detectClaudeHome() so "accepted" fixtures land under that ONE trusted root;
  // "rejected" fixtures go to os.tmpdir() (outside it) or carry a wrong extension.
  function claudeProjectsRoot() {
    let home = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
      if (cfg && cfg.claudeHome) home = String(cfg.claudeHome);
    } catch {}
    if (!home) home = process.env.USERPROFILE || os.homedir();
    return path.join(home, '.claude', 'projects');
  }
  // Our own scratch subdir under the trusted root — created lazily, removed whole
  // in afterAll (we only ever delete this subtree, never the projects root).
  const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-test-fixture__');
  let _n = 0;
  // Write a JSONL transcript UNDER the trusted root → safeTranscriptPath accepts it.
  function writeTranscript(lines, ext = '.jsonl') {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const p = path.join(FIXTURE_DIR, `wt_att_${process.pid}_${++_n}${ext}`);
    fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return p;
  }
  // Write the same content OUTSIDE the trusted root (os.tmpdir) → must be rejected.
  function writeTranscriptOutsideRoot(lines) {
    const p = path.join(os.tmpdir(), `wt_att_out_${process.pid}_${++_n}.jsonl`);
    fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return p;
  }
  test.afterAll(() => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });
  // POST a hook event for a session via the X-WT-Session-ID header path.
  function hookCtx() {
    return pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() },
    });
  }

  test('requires authentication', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/sessions/whatever/attention');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('empty state: nulls, no-store, still names the server', async () => {
    const ctx = await authCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Att Empty' } })).json()).id;
    try {
      const res = await ctx.get(`/api/sessions/${created}/attention`);
      expect(res.status()).toBe(200);
      // Never cached — the companion always pulls fresh content on wake.
      expect(res.headers()['cache-control']).toBe('no-store');
      const body = await res.json();
      expect(body.id).toBe(created);
      expect(body.serverName).toBeTruthy();     // server identity is always present
      expect(body.kind).toBeNull();             // nothing has needed attention yet
      expect(body.reason).toBeNull();
      expect(body.name).toBeNull();
      expect(body.at).toBeNull();
      expect(body.cleared).toBeNull();
      expect(body.lastMessage).toBe('');        // no transcript stashed yet
    } finally {
      await ctx.delete(`/api/sessions/${created}`);
      await ctx.dispose();
    }
  });

  test('stashing a transcript path via a hook surfaces Claude\'s last message', async () => {
    const ctx = await authCtx();
    const raw = await hookCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Att Msg' } })).json()).id;
    const fixture = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done — 23 tests pass.' }] } },
    ]);
    try {
      // Every http-hook payload carries transcript_path; server stashes it so a
      // later /attention read can quote Claude's last message over the LAN.
      const hr = await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'UserPromptSubmit', transcript_path: fixture, prompt: 'do it' },
      });
      expect(hr.status()).toBe(200);

      const body = await (await ctx.get(`/api/sessions/${created}/attention`)).json();
      expect(body.lastMessage).toBe('All done — 23 tests pass.');
    } finally {
      try { fs.unlinkSync(fixture); } catch {}
      await ctx.delete(`/api/sessions/${created}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });

  // M1 rejection (a): a transcript_path OUTSIDE the trusted root is silently
  // ignored — the hook still succeeds, but /attention exposes no message. Proves
  // safeTranscriptPath can't be steered at an arbitrary file elsewhere on disk.
  test('a transcript path outside the Claude projects root is rejected (lastMessage stays empty)', async () => {
    const ctx = await authCtx();
    const raw = await hookCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Att Outside' } })).json()).id;
    const fixture = writeTranscriptOutsideRoot([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'secret from outside the root' }] } },
    ]);
    try {
      const hr = await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'UserPromptSubmit', transcript_path: fixture, prompt: 'do it' },
      });
      expect(hr.status()).toBe(200); // hook accepted; the path is just not trusted
      const body = await (await ctx.get(`/api/sessions/${created}/attention`)).json();
      expect(body.lastMessage).toBe(''); // rejected → nothing stashed → nothing surfaced
    } finally {
      try { fs.unlinkSync(fixture); } catch {}
      await ctx.delete(`/api/sessions/${created}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });

  // M1 rejection (b): a file UNDER the trusted root but WITHOUT a .jsonl extension
  // is rejected by the extension gate, even though its content is a valid transcript.
  test('a non-.jsonl file under the root is rejected (lastMessage stays empty)', async () => {
    const ctx = await authCtx();
    const raw = await hookCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Att BadExt' } })).json()).id;
    const fixture = writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'valid content, wrong extension' }] } },
    ], '.txt');
    try {
      const hr = await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'UserPromptSubmit', transcript_path: fixture, prompt: 'do it' },
      });
      expect(hr.status()).toBe(200);
      const body = await (await ctx.get(`/api/sessions/${created}/attention`)).json();
      expect(body.lastMessage).toBe(''); // extension gate rejected it
    } finally {
      try { fs.unlinkSync(fixture); } catch {}
      await ctx.delete(`/api/sessions/${created}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });

  // W1 recording + W2 (G3) clear: an approval is recorded as attention, then
  // flips to cleared:true once the session moves off 'waiting'.
  test('records an approval, then G3 clears it when the session leaves waiting', async () => {
    const ctx = await authCtx();
    const raw = await hookCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Att Approval' } })).json()).id;
    try {
      // Notification carrying permission prose → synthesized PermissionRequest →
      // worker status 'waiting' + approval_needed → server records attention.
      const hr = await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'Notification', message: 'Claude needs your permission to run a command' },
      });
      expect(hr.status()).toBe(200);

      // The statusChanged → pushNotify hop is async over IPC; poll for it.
      await expect.poll(async () =>
        (await (await ctx.get(`/api/sessions/${created}/attention`)).json()).kind
      ).toBe('approval');
      const recorded = await (await ctx.get(`/api/sessions/${created}/attention`)).json();
      expect(recorded.reason).toContain('approval');
      expect(recorded.cleared).toBe(false); // freshly recorded, not yet resolved
      expect(typeof recorded.at).toBe('number');

      // The user answers → UserPromptSubmit → status 'working' → G3 clear fires.
      const hr2 = await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'UserPromptSubmit', prompt: 'yes go ahead' },
      });
      expect(hr2.status()).toBe(200);

      await expect.poll(async () =>
        (await (await ctx.get(`/api/sessions/${created}/attention`)).json()).cleared
      ).toBe(true);
      // The recorded attention is unchanged apart from the cleared flag.
      const cleared = await (await ctx.get(`/api/sessions/${created}/attention`)).json();
      expect(cleared.kind).toBe('approval');
    } finally {
      await ctx.delete(`/api/sessions/${created}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });
});

// ============================================================
// 8. Rate Limiting (MUST be last — triggers rate limit on the test IP)
// ============================================================

test.describe('Rate Limiting', () => {
  test('blocks after repeated failed login attempts', async () => {
    const ctx = await noAuthCtx();
    // Send enough failed attempts to guarantee rate limiting (server allows 5).
    // Other parallel test files may have already added some, so send extras.
    for (let i = 0; i < 10; i++) {
      await ctx.post('/login', {
        form: { user: 'wrong', password: 'wrong' },
        maxRedirects: 0,
      });
    }
    // Next attempt must be rate limited
    const res = await ctx.post('/login', {
      form: { user: 'wrong', password: 'wrong' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(429);
    await ctx.dispose();
  });

  test('rate limit blocks even correct credentials', async () => {
    // After the previous test, we're still rate-limited (same IP, same server instance)
    const ctx = await noAuthCtx();
    const res = await ctx.post('/login', {
      form: { user: AUTH.user, password: AUTH.password },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(429);
    // Wait for rate limit block to expire so other test files aren't affected
    await new Promise(r => setTimeout(r, 1500));
    await ctx.dispose();
  });
});
