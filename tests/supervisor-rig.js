// @ts-check
// An isolated web-terminal server for the supervisor specs (#466, #467, #468): its own config,
// tokens, worker pipe and state files, never the suite server's or production's. Shared by
// supervisor-cluster.spec.js and supervisor-dispatcher.spec.js.
const { request: pwRequest } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIRM_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

/** Boot one isolated server in [dir] on [port]. Files and tokens are set up by the caller. */
async function startServer(dir, port, label, extraEnv = {}) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const suffix = crypto.randomUUID().slice(0, 8);
  const f = (name) => path.join(dir, name);
  const env = {
    ...process.env, WT_TEST: '1', WT_CONFIG_FILE: f('config.json'), WT_PORT: String(port), WT_HOST: '127.0.0.1',
    WT_USER: 'testuser', WT_PASS: 'testpass:colon',
    WT_SPAWN_WORKER: '1', WT_WORKER_DATA_DIR: dataDir, WT_WORKER_QUIET: '1', WT_WORKER_NO_DEFAULT: '1',
    WT_WORKER_PIPE: process.platform === 'win32' ? `\\\\.\\pipe\\wt-466-${label}-${suffix}` : `/tmp/wt-466-${label}-${suffix}.sock`,
    WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
    // Every state file of its own: never the suite server's, never production's.
    WT_API_TOKENS_FILE: f('api-tokens.json'), WT_CLUSTER_TOKENS_FILE: f('cluster-tokens.json'),
    WT_LEASES_FILE: f('leases.json'), WT_LEASE_RECORDS_FILE: f('lease-records.json'),
    WT_SESSION_BRIEFS_FILE: f('briefs.json'), WT_SPAWNED_SESSIONS_FILE: f('spawned.json'),
    WT_MAINTENANCE_FILE: f('maintenance.json'), WT_DEVICE_OPS_FILE: f('device-ops.jsonl'),
    WT_CLAUDE_METRICS_FILE: f('metrics.json'), WT_HANDOFF_DIR: f('handoffs'),
    WT_WORK_ITEMS_LOG_FILE: f('work-items.jsonl'), WT_SESSIONS_JOURNAL_FILE: f('sessions-journal.jsonl'),
    WT_PUSH_DEVICES_FILE: f('push-devices.json'),
    WT_SUPERVISOR_EVERY_MS: '1000', WT_SUPERVISOR_ORPHAN_CONFIRM_MS: String(CONFIRM_MS),
    // #467: quiet hours pinned off (a run at night must not hold pushes); a spec flips them.
    WT_QUIET_FORCE: '0',
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    // The tree, by the pid this function recorded: the server owns a worker that outlives it.
    try { if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    try { proc.kill(); } catch { /* gone */ }
    await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(r, 3000); } });
  };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (proc.exitCode !== null) break;
    try {
      const probe = await pwRequest.newContext({ baseURL: base });
      const r = await probe.get('/login', { timeout: 2000 });
      await probe.dispose();
      if (r.status() < 500) return { base, stop, log: () => out };
    } catch { /* not listening yet */ }
  }
  await stop();
  throw new Error(`isolated server ${label} never answered on ${base}:\n${out.slice(0, 2000)}`);
}

const bearer = (base, token) => pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

module.exports = { ROOT, CONFIRM_MS, sleep, until, startServer, bearer };
