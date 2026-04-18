const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  workers: 1,
  testIgnore: ['**/diagnostic*', '**/mobile-debug*'],
  globalTeardown: path.join(__dirname, 'tests', 'global-teardown.js'),
  use: {
    baseURL: 'http://localhost:17681',
  },
  webServer: {
    command: 'node server.js',
    port: 17681,
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
    },
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
