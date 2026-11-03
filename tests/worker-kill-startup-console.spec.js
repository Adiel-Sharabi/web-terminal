// @ts-check
// A session killed while ConPTY is still starting must not leave its console behind.
//
// Every PTY session is one OpenConsole.exe (a child of the worker). Git for Windows' MSYS
// runtime allows 32 consoles machine-wide; past that bash dies at start with "console
// device allocation failure - too many consoles in use". node-pty closes a pseudoconsole
// killed BEFORE its shell has drawn anything without that console process going away: it
// then lives as long as the worker. Measured 2026-11-03 on Home: 8 sessions created and
// killed at once left up to 3 consoles held 6 s later, and a full suite run (whose server
// kills many young sessions) stranded ~20 and broke the next run. `killTerm` in
// pty-worker.js defers the OS kill of a session that has not printed yet.
const { test, expect } = require('@playwright/test');
const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { connectClient, rpc, stopWorker } = require('./worker-ipc');
const { killAllSessions } = require('./worker-kill');

test.skip(process.platform !== 'win32', 'ConPTY consoles exist on Windows only');

const ROUNDS = 8;
const PER_ROUND = 8;

/** How many OpenConsole.exe processes have [pid] as their parent. */
function consolesOf(pid) {
  const ps = `(Get-CimInstance Win32_Process -Filter "Name='OpenConsole.exe' AND ParentProcessId=${pid}" | Measure-Object).Count`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, out) => {
      if (err) return reject(err);
      resolve(parseInt(String(out).trim(), 10));
    });
  });
}

test('sessions killed while ConPTY starts leave no console held by the live worker', async () => {
  test.setTimeout(90000);
  const pipe = ['', '', '.', 'pipe', 'wt-kill-startup-' + crypto.randomUUID()].join(String.fromCharCode(92));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-kill-startup-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env, WT_TEST: '1', WT_WORKER_PIPE: pipe, WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1', WT_WORKER_NO_DEFAULT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  proc.stdout.resume();
  proc.stderr.resume();
  try {
    const client = await connectClient(pipe);
    for (let round = 0; round < ROUNDS; round++) {
      const ids = [];
      for (let i = 0; i < PER_ROUND; i++) {
        const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: `k${round}-${i}`, autoCommand: '' });
        ids.push(id);
      }
      await killAllSessions(client, ids, { worker: { proc } });   // at once: every one is still starting
    }
    // The kill defers at most KILL_STARTUP_CAP_MS (2 s), then the console needs a moment to go.
    await expect.poll(() => consolesOf(proc.pid), {
      timeout: 15000, intervals: [500, 1000, 2000],
      message: 'OpenConsole.exe children of the worker after every session was killed',
    }).toBe(0);
    // And it STAYS gone: a console that appeared late would show here.
    await new Promise((r) => setTimeout(r, 3000));
    expect(await consolesOf(proc.pid)).toBe(0);
    await client.close();
  } finally {
    await stopWorker(proc);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
