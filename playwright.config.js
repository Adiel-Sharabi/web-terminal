const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  globalTeardown: path.join(__dirname, 'tests', 'global-teardown.js'),
  use: {
    baseURL: 'http://localhost:17681',
  },
  webServer: {
    command: 'node server.js',
    port: 17681,
    env: {
      ...process.env,
      WT_PORT: '17681',
      WT_USER: 'testuser',
      WT_PASS: 'testpass:colon',
      WT_CWD: process.env.TEMP || 'C:\\Windows\\Temp',
      WT_HOST: '127.0.0.1',
    },
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
