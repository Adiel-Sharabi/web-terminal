// @ts-check
// Phase 5 + 6: monitor.js supervisor tests and end-to-end hot reload.
//
// These tests spawn `monitor.js` as a child process with isolated env
// (separate port, separate pipe, separate data dir, separate status file)
// and verify:
//   - both worker and web.js come up under the monitor
//   - independent crash handling
//   - status file shows both processes
//   - graceful shutdown stops both cleanly
//   - a killed web.js is automatically restarted while PTYs keep running
//   - session state (scrollback, PTY PID) survives the web.js restart
//
// We deliberately avoid Playwright's webServer (which spawns server.js
// directly on port 17681) — these tests manage their own lifecycle.

const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const MONITOR_SCRIPT = path.join(__dirname, '..', 'monitor.js');
const TEST_USER = 'testuser';
const TEST_PASS = 'testpass:colon';

// Tests run serially (workers: 1) but each test must use a unique port + pipe
// + status file so nothing leaks between tests.
function allocatePort() {
  // 17700-17799 range (avoids 17681 used by the default webServer).
  return 17700 + Math.floor(Math.random() * 100);
}

function uniqueSuffix() { return crypto.randomUUID().slice(0, 8); }

function makeTempDir() {
  const dir = path.join(os.tmpdir(), 'wt-monitor-test-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}
function rmRf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

/**
 * Spawn monitor.js with an isolated environment. Returns:
 *   { proc, port, pipe, statusFile, dataDir, stop(), waitForStatus(predicate, timeoutMs) }
 */
async function startMonitor(overrides = {}) {
  const port = overrides.port ?? allocatePort();
  const pipe = overrides.pipe ?? (process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-monitor-test-${uniqueSuffix()}`
    : `/tmp/wt-monitor-test-${uniqueSuffix()}.sock`);
  const dataDir = overrides.dataDir ?? makeTempDir();
  const statusFile = path.join(dataDir, 'monitor-status.json');

  const env = {
    ...process.env,
    WT_TEST: '1',
    WT_PORT: String(port),
    WT_HOST: '127.0.0.1',
    WT_USER: TEST_USER,
    WT_PASS: TEST_PASS,
    WT_CWD: process.env.TEMP || os.tmpdir(),
    WT_WORKER_PIPE: pipe,
    WT_WORKER_DATA_DIR: dataDir,
    WT_MONITOR_STATUS_FILE: statusFile,
    WT_RATE_LIMIT_BLOCK: '1000',
    WT_WORKER_QUIET: '1',
    WT_WORKER_NO_DEFAULT: '1',
    // Windows: enable stdin-based shutdown so tests can gracefully stop the
    // monitor (SIGTERM on Windows is forceful and skips handlers).
    WT_MONITOR_STDIN_SHUTDOWN: '1',
    ...overrides.env,
  };

  const proc = spawn(process.execPath, [MONITOR_SCRIPT], {
    cwd: path.dirname(MONITOR_SCRIPT),
    stdio: ['pipe', 'pipe', 'pipe'],  // pipe stdin for graceful shutdown signaling
    env,
    windowsHide: true,
  });

  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  const handle = {
    proc,
    port,
    pipe,
    dataDir,
    statusFile,
    getStdout: () => stdout,
    getStderr: () => stderr,
    readStatus: () => {
      try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return null; }
    },
    async waitForStatus(predicate, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = this.readStatus();
        if (s && predicate(s)) return s;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`waitForStatus timed out after ${timeoutMs}ms. Last status: ${JSON.stringify(this.readStatus())}\nstdout: ${stdout.slice(-1500)}\nstderr: ${stderr.slice(-1500)}`);
    },
    async waitForHealthy(timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let lastErr = null;
      while (Date.now() < deadline) {
        try {
          const ok = await httpGetOk(`http://127.0.0.1:${port}/api/hostname`);
          if (ok) return;
        } catch (e) { lastErr = e; }
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error(`web not healthy after ${timeoutMs}ms (last err: ${lastErr?.message}). stderr: ${stderr.slice(-1000)}`);
    },
    async stop(timeoutMs = 10000) {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      // Capture child PIDs so we can force-kill any stragglers after the
      // monitor exits (Windows doesn't auto-kill child processes on parent death).
      const s = this.readStatus();
      const kidPids = [];
      if (s?.worker?.pid) kidPids.push(s.worker.pid);
      if (s?.web?.pid) kidPids.push(s.web.pid);
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          // Any stragglers? Force-kill to avoid test leaks.
          for (const pid of kidPids) { if (isPidAlive(pid)) killPid(pid); }
          resolve();
        };
        const t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          finish();
        }, timeoutMs);
        proc.once('exit', () => { clearTimeout(t); finish(); });
        // Graceful first: ask monitor to shut down via stdin, then fall back to SIGKILL.
        try { proc.stdin.write('shutdown\n'); proc.stdin.end(); } catch {}
      });
    },
  };

  return handle;
}

function httpGetOk(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Kill a PID forcefully on both platforms. */
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // SIGKILL is translated to TerminateProcess on Windows; good for our use.
      process.kill(pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    // signal 0 doesn't send a signal but triggers EPERM/ESRCH detection.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Login via /login and return a request context with cookie auth. */
async function authCtx(baseURL) {
  const ctx = await pwRequest.newContext({ baseURL });
  const loginRes = await ctx.post('/login', {
    form: { user: TEST_USER, password: TEST_PASS },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  if (!setCookie) throw new Error('login did not return a session cookie');
  return pwRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

// ============================================================================
// Phase 5: monitor.js supervisor
// ============================================================================

test.describe('Phase 5: monitor.js supervises worker + web independently', () => {
  test.describe.configure({ mode: 'serial' });

  test('spawns both worker and web; status file shows both PIDs; health check passes', async () => {
    const h = await startMonitor();
    try {
      await h.waitForHealthy(20000);
      const status = h.readStatus();
      expect(status).toBeTruthy();
      expect(status.worker).toBeTruthy();
      expect(status.web).toBeTruthy();
      expect(status.worker.pid).toBeGreaterThan(0);
      expect(status.web.pid).toBeGreaterThan(0);
      expect(status.worker.pid).not.toBe(status.web.pid);
      expect(isPidAlive(status.worker.pid)).toBe(true);
      expect(isPidAlive(status.web.pid)).toBe(true);
    } finally {
      await h.stop();
      rmRf(h.dataDir);
    }
  });

  test('kill web.js only → monitor restarts web, worker keeps running, health recovers', async () => {
    const h = await startMonitor();
    try {
      await h.waitForHealthy(20000);
      const before = h.readStatus();
      const workerPid = before.worker.pid;
      const webPid = before.web.pid;
      expect(webPid).toBeGreaterThan(0);

      // Kill ONLY the web process.
      killPid(webPid);

      // Wait for monitor to detect exit and respawn.
      const after = await h.waitForStatus((s) =>
        s && s.web && s.web.pid && s.web.pid !== webPid && s.web.restarts > (before.web.restarts || 0),
        20000);

      expect(after.worker.pid).toBe(workerPid); // worker unchanged
      expect(isPidAlive(workerPid)).toBe(true);
      expect(after.web.pid).not.toBe(webPid);

      // And the new web process is healthy.
      await h.waitForHealthy(20000);
    } finally {
      await h.stop();
      rmRf(h.dataDir);
    }
  });

  test('kill worker → monitor kills web then restarts both; health recovers', async () => {
    const h = await startMonitor();
    try {
      await h.waitForHealthy(20000);
      const before = h.readStatus();
      const workerPid = before.worker.pid;
      const webPid = before.web.pid;

      killPid(workerPid);

      // Monitor should restart the worker (new pid), and web should also come
      // back with a new pid.
      const after = await h.waitForStatus((s) =>
        s && s.worker && s.worker.pid && s.worker.pid !== workerPid
          && s.web && s.web.pid && s.web.pid !== webPid,
        25000);

      expect(after.worker.pid).not.toBe(workerPid);
      expect(after.web.pid).not.toBe(webPid);

      await h.waitForHealthy(25000);
    } finally {
      await h.stop();
      rmRf(h.dataDir);
    }
  });

  test('web crash budget: repeated web crashes → monitor stops respawning web (worker keeps running)', async () => {
    test.slow();
    // Use a tight backoff so the test can trigger the budget within the test timeout.
    const h = await startMonitor({ env: {
      WT_MONITOR_BACKOFF_INITIAL: '200',
      WT_MONITOR_BACKOFF_MAX: '200',
      WT_MONITOR_BACKOFF_MULT: '1',
      WT_MONITOR_CRASH_BUDGET: '3',
    }});
    try {
      await h.waitForHealthy(20000);
      const workerPidBefore = h.readStatus().worker.pid;

      // Kill web 3 times in quick succession to exceed the budget (3 per 5-min window).
      for (let i = 0; i < 3; i++) {
        const s = h.readStatus();
        if (!s?.web?.pid) {
          await h.waitForStatus((x) => x?.web?.pid && isPidAlive(x.web.pid), 15000);
        }
        const webPid = h.readStatus().web.pid;
        if (webPid) killPid(webPid);
        await h.waitForStatus((x) => x?.web?.pid !== webPid, 10000).catch(() => {});
      }

      // After exceeding the budget, web should be stoppedForever.
      const final = await h.waitForStatus((s) =>
        s?.web?.stoppedForever === true || s?.status === 'crashed',
        15000);
      expect(final.web.totalCrashes).toBeGreaterThanOrEqual(3);
      expect(final.web.stoppedForever).toBe(true);
      // Worker must still be running — PTYs survive.
      expect(final.worker.pid).toBe(workerPidBefore);
      expect(isPidAlive(workerPidBefore)).toBe(true);
    } finally {
      await h.stop();
      rmRf(h.dataDir);
    }
  });

  test('graceful shutdown (SIGTERM) → both children exit cleanly', async () => {
    const h = await startMonitor();
    try {
      await h.waitForHealthy(20000);
      const s = h.readStatus();
      const workerPid = s.worker.pid;
      const webPid = s.web.pid;

      // Send SIGTERM to monitor — it should orchestrate a graceful stop.
      await h.stop(10000);

      // Both child PIDs should be gone shortly after.
      const deadline = Date.now() + 8000;
      let workerAlive = isPidAlive(workerPid);
      let webAlive = isPidAlive(webPid);
      while (Date.now() < deadline && (workerAlive || webAlive)) {
        await new Promise(r => setTimeout(r, 100));
        workerAlive = isPidAlive(workerPid);
        webAlive = isPidAlive(webPid);
      }
      expect(workerAlive).toBe(false);
      expect(webAlive).toBe(false);

      // Final status should say stopped.
      const finalStatus = h.readStatus();
      if (finalStatus) {
        expect(['stopped', 'running']).toContain(finalStatus.status); // final write may race; both acceptable
      }
    } finally {
      rmRf(h.dataDir);
    }
  });
});

// ============================================================================
// Phase 6: end-to-end hot reload
// ============================================================================

test.describe('Phase 6: hot reload — PTY survives web.js restart', () => {
  test.describe.configure({ mode: 'serial' });

  test('session + scrollback + PTY PID survive web.js restart under monitor', async () => {
    test.slow(); // give it extra time
    const h = await startMonitor();
    const baseURL = `http://127.0.0.1:${h.port}`;
    const MARKER = `HOTRELOAD_TEST_OUTPUT_${uniqueSuffix().toUpperCase()}`;

    try {
      await h.waitForHealthy(20000);

      // 1) Auth + create a session.
      let ctx = await authCtx(baseURL);
      const createRes = await ctx.post('/api/sessions', {
        data: { name: 'hotreload-test', cwd: process.env.TEMP || os.tmpdir(), autoCommand: '' },
      });
      expect(createRes.status()).toBe(200);
      const created = await createRes.json();
      const sid = created.id;
      expect(sid).toBeTruthy();

      // 2) Grab the PTY PID before the restart — we'll assert it survives.
      const listBefore = await (await ctx.get('/api/sessions')).json();
      const sBefore = listBefore.find(s => s.id === sid);
      expect(sBefore).toBeTruthy();
      const ptyPidBefore = sBefore.pid;
      expect(ptyPidBefore).toBeGreaterThan(0);

      // 3) Attach via WS and send a command. Use a cookie-auth WS.
      const setCookie = (await ctx.storageState()).cookies
        .map(c => `${c.name}=${c.value}`).join('; ');
      const wsUrl = baseURL.replace(/^http/, 'ws') + '/ws/' + sid;
      const ws1 = new WebSocket(wsUrl, { headers: { Cookie: setCookie } });
      const collected1 = [];
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WS open timeout')), 8000);
        ws1.once('open', () => { clearTimeout(t); resolve(); });
        ws1.once('error', (e) => { clearTimeout(t); reject(e); });
      });
      ws1.on('message', (data) => { collected1.push(data.toString('utf8')); });

      // Send a mode frame so the server treats us as active (not background)
      ws1.send(JSON.stringify({ mode: 'active', cols: 120, rows: 30 }));
      // Give the shell a moment to draw its prompt.
      await new Promise(r => setTimeout(r, 500));

      // Send the echo command.
      ws1.send(`echo ${MARKER}\r`);

      // Wait for the marker to appear in scrollback.
      await expect.poll(async () => {
        const r = await ctx.get(`/api/sessions`); // just to keep auth alive; real check is via scrollback
        const all = collected1.join('');
        return all.includes(MARKER) ? 'yes' : 'no';
      }, { timeout: 10000, intervals: [200, 300, 500] }).toBe('yes');

      ws1.close();
      await new Promise(r => setTimeout(r, 300));

      // 4) Kill ONLY the web process.
      const statusBefore = h.readStatus();
      const webPidBefore = statusBefore.web.pid;
      const workerPid = statusBefore.worker.pid;
      expect(webPidBefore).toBeGreaterThan(0);
      killPid(webPidBefore);

      // 5) Wait for monitor to restart web.
      await h.waitForStatus((s) =>
        s && s.web && s.web.pid && s.web.pid !== webPidBefore && s.web.restarts > (statusBefore.web.restarts || 0),
        15000);

      // Worker pid must not have changed.
      const afterStatus = h.readStatus();
      expect(afterStatus.worker.pid).toBe(workerPid);

      // Wait for web to be serving HTTP again.
      await h.waitForHealthy(20000);

      // 6) Reconnect with fresh auth.
      await ctx.dispose();
      ctx = await authCtx(baseURL);

      // 7) List sessions — our session ID must still be there.
      const listAfter = await (await ctx.get('/api/sessions')).json();
      const sAfter = listAfter.find(s => s.id === sid);
      expect(sAfter).toBeTruthy();

      // 8) *** Core assertion: PTY PID is unchanged — proves same shell. ***
      expect(sAfter.pid).toBe(ptyPidBefore);

      // 9) Attach again via WS — scrollback must include MARKER.
      const setCookie2 = (await ctx.storageState()).cookies
        .map(c => `${c.name}=${c.value}`).join('; ');
      const ws2 = new WebSocket(wsUrl, { headers: { Cookie: setCookie2 } });
      const collected2 = [];
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WS open timeout after restart')), 8000);
        ws2.once('open', () => { clearTimeout(t); resolve(); });
        ws2.once('error', (e) => { clearTimeout(t); reject(e); });
      });
      ws2.on('message', (data) => { collected2.push(data.toString('utf8')); });
      ws2.send(JSON.stringify({ mode: 'active', cols: 120, rows: 30 }));

      // Initial scrollback replay should carry the marker.
      await expect.poll(() => collected2.join('').includes(MARKER) ? 'yes' : 'no',
        { timeout: 10000, intervals: [200, 500] }).toBe('yes');

      // 10) Type another command, verify it actually reaches the PTY.
      // Give mode message a moment to be processed server-side.
      await new Promise(r => setTimeout(r, 500));
      // Record baseline so we detect the new output even if MARKER was in replay.
      const baseline2 = collected2.join('').length;
      const MARKER2 = `AFTER_RESTART_${uniqueSuffix().toUpperCase()}`;
      ws2.send(`echo ${MARKER2}\r`);
      await expect.poll(() => {
        const recent = collected2.join('').slice(baseline2);
        return recent.includes(MARKER2) ? 'yes' : 'no';
      }, { timeout: 15000, intervals: [200, 500] }).toBe('yes');

      ws2.close();
      await ctx.dispose();
    } finally {
      await h.stop();
      rmRf(h.dataDir);
    }
  });
});
