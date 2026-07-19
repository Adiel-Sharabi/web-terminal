const { defineConfig } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');

// Issue #18: test-run-scoped handshake token shared by server.js and the
// pty-worker it spawns (WT_SPAWN_WORKER=1). Unique per run so parallel/
// previous-run stragglers can't accidentally authenticate.
const TEST_IPC_TOKEN = crypto.randomBytes(32).toString('base64');

// #72 — the Claude metrics mirror. Set on process.env (not just the webServer block)
// so the spec and the server under test agree on the path without either hardcoding
// it, and so a run can never write into the production claude-metrics.json that the
// real server loads on its next restart. The short debounce lets a spec assert the
// file's content through the ordinary code path instead of waiting out 10s.
process.env.WT_CLAUDE_METRICS_FILE = path.join(__dirname, 'claude-metrics.test.json');
process.env.WT_CLAUDE_METRICS_DEBOUNCE_MS = '250';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  workers: 1,
  testIgnore: ['**/diagnostic*', '**/mobile-debug*', '**/paste-diag*'],
  globalTeardown: path.join(__dirname, 'tests', 'global-teardown.js'),
  use: {
    baseURL: 'http://127.0.0.1:17681',
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:17681/login',
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_PORT: '17681',
      WT_USER: 'testuser',
      WT_PASS: 'testpass:colon',
      WT_CWD: process.env.TEMP || 'C:\\Windows\\Temp',
      WT_HOST: '127.0.0.1',
      WT_RATE_LIMIT_BLOCK: '1000',
      // Hot-reload Phase 3+: have server.js spawn the pty-worker as a child
      // process so tests have a fully-wired server without a separate monitor.
      WT_SPAWN_WORKER: '1',
      // Use a test-specific pipe so production worker (if any) isn't disturbed.
      WT_WORKER_PIPE: process.platform === 'win32'
        ? '\\\\.\\pipe\\web-terminal-pty-test'
        : '/tmp/web-terminal-pty-test.sock',
      // Issue #18: shared handshake token for server.js <-> pty-worker IPC.
      WT_IPC_TOKEN: TEST_IPC_TOKEN,
      // Shorten the hook-event idle debounce so tests don't wait 750ms per
      // debounce assertion. server.js reads this on startup.
      WT_HOOK_STOP_DEBOUNCE_MS: '200',
      // G2 FCM transport: capture sends to an in-memory sink (no network) and
      // drive the FCM path alongside ntfy so integration tests exercise it.
      WT_FCM_TEST: '1',
      WT_PUSH_PROVIDER: 'both',
    },
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
