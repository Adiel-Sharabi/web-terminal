#!/usr/bin/env node
// Hot-reload smoke test. Defaults to the production port 7681; override via
// WT_BASE env var (e.g. WT_BASE=http://127.0.0.1:7682 for the v2 sandbox).
// Creates a session, captures PTY PID, kills server.js, verifies monitor
// restarts it and the PTY continues to live in the worker.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const BASE = process.env.WT_BASE || 'http://127.0.0.1:7681';
const WS_BASE = BASE.replace(/^http/, 'ws');
const TOKENS_FILE = path.join(__dirname, 'api-tokens.json');
const STATUS_FILE = path.join(__dirname, 'monitor-status.json');

// --- Helpers ---------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function api(method, url, token, body) {
  const u = new URL(BASE + url);
  return request({
    method,
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
  }, body);
}

// --- Step 1: inject a test token ------------------------------------------
function injectToken() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const token = 'smoke-test-' + crypto.randomBytes(16).toString('hex');
  tokens[token] = {
    label: 'hot-reload-smoke-test',
    created: Date.now(),
    expires: Date.now() + 10 * 60 * 1000, // 10 min
  };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  return token;
}

function cleanupToken(token) {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    delete tokens[token];
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) { console.warn('cleanup: ' + e.message); }
}

function readStatus() {
  return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
}

// --- Main ------------------------------------------------------------------
async function main() {
  console.log('=== v2 Hot-Reload Smoke Test ===\n');
  console.log('Injecting test token...');
  const token = injectToken();
  let sessionId = null;

  try {
    // Step 1: create a session via REST API
    console.log('\n[1/6] Creating session...');
    const createRes = await api('POST', '/api/sessions', token, {
      name: 'smoke-test-' + Date.now(),
      cwd: process.env.TEMP || 'C:\\Windows\\Temp',
    });
    if (createRes.status !== 200) {
      throw new Error('createSession: HTTP ' + createRes.status + ' body: ' + createRes.body);
    }
    const createData = JSON.parse(createRes.body);
    sessionId = createData.id;
    console.log('    session id:', sessionId);

    // Step 2: list sessions to find the PTY pid (if exposed in /api/sessions)
    await sleep(500);
    const listRes = await api('GET', '/api/sessions', token);
    const sessions = JSON.parse(listRes.body);
    const session = sessions.find(s => s.id === sessionId);
    console.log('    session status:', session && session.status);

    // Step 3: attach via WS, send a marker command
    console.log('\n[2/6] Attaching via WebSocket + sending marker command...');
    const wsUrl = `${WS_BASE}/ws/${sessionId}?token=${token}`;
    const marker = 'HOTRELOAD_MARKER_' + Date.now();
    const wsReceived = [];

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('ws open timeout')), 5000);
    });
    ws.on('message', (data) => {
      wsReceived.push(data.toString());
    });
    // Declare active mode (keepSessionsOpen default on)
    ws.send(JSON.stringify({ mode: 'active', browserId: 'smoke-test' }));

    // Wait for shell to be ready — look for a prompt-ish character ($ or >)
    // in the stream within 8 seconds.
    let shellReady = false;
    for (let i = 0; i < 80; i++) {
      const combined = wsReceived.join('');
      if (/[$>#] *$/.test(combined.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')) ||
          combined.includes('$ ') || combined.includes('> ')) {
        shellReady = true;
        break;
      }
      await sleep(100);
    }
    if (!shellReady) {
      console.warn('    (shell prompt not detected within 8s — proceeding anyway)');
      console.warn('    last 300 bytes:', wsReceived.join('').slice(-300));
    } else {
      console.log('    ✓ shell prompt detected');
    }

    // Send a marker command (try both \r and \n endings)
    ws.send(`echo ${marker}\r\n`);
    console.log('    sent:', marker);
    // Give the shell plenty of time to echo
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      if (wsReceived.join('').includes(marker)) break;
    }

    const combined = wsReceived.join('');
    if (!combined.includes(marker)) {
      throw new Error('Marker not found in WS output. Got last 500 bytes: ' + combined.slice(-500));
    }
    console.log('    ✓ marker received in WS output');

    ws.close();

    // Step 5: capture PTY PID before restart (from monitor-status or workerClient)
    console.log('\n[3/6] Reading worker + web PIDs from monitor-status.json...');
    const status = readStatus();
    const workerPid = status.worker.pid;
    const webPidBefore = status.web.pid;
    console.log('    worker PID:', workerPid);
    console.log('    web    PID:', webPidBefore);

    // Step 6: KILL ONLY web.js — worker must stay alive
    console.log('\n[4/6] Killing web.js (' + webPidBefore + ')...');
    process.kill(webPidBefore, 'SIGKILL');
    await sleep(3000); // wait for monitor to spawn replacement

    // Step 7: verify web.js has a NEW PID and worker is unchanged
    console.log('\n[5/6] Verifying monitor restarted web, worker survived...');
    let status2 = readStatus();
    let attempts = 0;
    while (status2.web.pid === webPidBefore && attempts < 10) {
      await sleep(500);
      status2 = readStatus();
      attempts++;
    }
    if (status2.worker.pid !== workerPid) {
      throw new Error('FAIL: worker PID changed! before=' + workerPid + ' after=' + status2.worker.pid);
    }
    if (status2.web.pid === webPidBefore) {
      throw new Error('FAIL: web.js not restarted, still PID ' + webPidBefore);
    }
    console.log('    ✓ worker PID unchanged:', workerPid);
    console.log('    ✓ web PID changed:', webPidBefore, '→', status2.web.pid);

    // Step 8: wait for new web to be listening again
    console.log('\n[6/6] Reconnecting + verifying session survived...');
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        const r = await api('GET', '/api/sessions', token);
        if (r.status === 200) { ready = true; break; }
      } catch (e) {}
      await sleep(500);
    }
    if (!ready) throw new Error('new web.js never became ready');

    const listAfterRes = await api('GET', '/api/sessions', token);
    const sessionsAfter = JSON.parse(listAfterRes.body);
    const sessionAfter = sessionsAfter.find(s => s.id === sessionId);
    if (!sessionAfter) throw new Error('session disappeared! was ' + sessionId);
    console.log('    ✓ session still present:', sessionId);

    // Reattach via new WS, verify marker is still in scrollback
    const ws2 = new WebSocket(`${WS_BASE}/ws/${sessionId}?token=${token}`);
    const ws2Received = [];
    await new Promise((resolve, reject) => {
      ws2.once('open', resolve);
      ws2.once('error', reject);
      setTimeout(() => reject(new Error('ws2 open timeout')), 5000);
    });
    ws2.on('message', d => ws2Received.push(d.toString()));
    ws2.send(JSON.stringify({ mode: 'active', browserId: 'smoke-test-2' }));
    await sleep(1500);
    const combined2 = ws2Received.join('');
    if (!combined2.includes(marker)) {
      throw new Error('Marker lost after restart! got: ' + combined2.slice(-500));
    }
    console.log('    ✓ marker "' + marker + '" still in scrollback after restart');

    // Also run a new command on the same session to prove PTY still works
    const marker2 = 'HOTRELOAD_POSTRESTART_' + Date.now();
    ws2.send(`echo ${marker2}\r`);
    await sleep(1500);
    const combined3 = ws2Received.join('');
    if (!combined3.includes(marker2)) {
      throw new Error('Post-restart command did not echo. Got: ' + combined3.slice(-500));
    }
    console.log('    ✓ new command works after restart: ' + marker2);

    ws2.close();
    console.log('\n=== PASS ===');
    console.log('Hot reload verified: PTY survived web.js restart, scrollback intact, I/O works.');
  } finally {
    // Clean up: delete the test session + revoke token
    if (sessionId) {
      try { await api('DELETE', '/api/sessions/' + sessionId, token); } catch {}
    }
    cleanupToken(token);
  }
}

main().catch(e => {
  console.error('\n=== FAIL ===');
  console.error(e.stack || e.message);
  process.exit(1);
});
