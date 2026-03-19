const { defineConfig } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Backup config.json before tests, restore after
const configPath = path.join(__dirname, 'config.json');
const backupPath = path.join(__dirname, 'config.json.bak');

// Save backup when config loads
try {
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, backupPath);
  }
} catch (e) {}

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  globalTeardown: path.join(__dirname, 'tests', 'global-teardown.js'),
  use: {
    baseURL: 'http://localhost:17681',
    httpCredentials: { username: 'testuser', password: 'testpass:colon' },
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
    },
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
