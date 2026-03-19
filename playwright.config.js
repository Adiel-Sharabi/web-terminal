const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:17681',
    httpCredentials: { username: 'testuser', password: 'testpass:colon' },
  },
  webServer: {
    command: 'node server.js',
    port: 17681,
    env: {
      WT_PORT: '17681',
      WT_USER: 'testuser',
      WT_PASS: 'testpass:colon',
      WT_CWD: process.env.TEMP || 'C:\\Windows\\Temp',
    },
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
