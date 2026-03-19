const fs = require('fs');
const path = require('path');

module.exports = async function globalTeardown() {
  const configPath = path.join(__dirname, '..', 'config.json');
  const backupPath = path.join(__dirname, '..', 'config.json.bak');

  // Restore original config.json from backup
  try {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, configPath);
      fs.unlinkSync(backupPath);
      console.log('[teardown] Restored config.json from backup');
    }
  } catch (e) {
    console.error('[teardown] Failed to restore config.json:', e.message);
  }

  // Clean up sessions.json that tests may have created
  const sessionsPath = path.join(__dirname, '..', 'sessions.json');
  const sessionsBackup = path.join(__dirname, '..', 'sessions.json.bak');
  try {
    if (fs.existsSync(sessionsBackup)) {
      fs.copyFileSync(sessionsBackup, sessionsPath);
      fs.unlinkSync(sessionsBackup);
    }
  } catch (e) {}
};
