#!/usr/bin/env node
// Long-process hot-reload test: starts a continuous ping in a session, kills
// server.js, reconnects, and verifies new ping lines keep arriving on the same
// PTY after the restart. Defaults to port 7681; override with WT_BASE.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const BASE = process.env.WT_BASE || 'http://127.0.0.1:7681';
const WS_BASE = BASE.replace(/^http/, 'ws');
const TOKENS_FILE = path.join(__dirname, 'api-tokens.json');
const STATUS_FILE = path.join(__dirname, 'monitor-status.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
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

function injectToken() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const token = 'longproc-' + crypto.randomBytes(16).toString('hex');
  tokens[token] = { label: 'longproc-test', created: Date.now(), expires: Date.now() + 10 * 60 * 1000 };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  return token;
}
function cleanupToken(token) {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    delete tokens[token];
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch {}
}
const readStatus = () => JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));

function countReplies(s) {
  return (s.match(/Reply from /gi) || []).length;
}

async function main() {
  console.log('=== v2 Long-Process Hot-Reload Test ===\n');
  const token = injectToken();
  let sessionId = null;
  try {
    console.log('[1/5] Creating session...');
    const r = await api('POST', '/api/sessions', token, { name: 'longproc-' + Date.now() });
    if (r.status !== 200) throw new Error('create: ' + r.status + ' ' + r.body);
    sessionId = JSON.parse(r.body).id;
    console.log('    session:', sessionId);

    console.log('\n[2/5] Attaching WS + starting long ping (30 packets, 1/sec)...');
    const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}?token=${token}`);
    const buf1 = [];
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', d => buf1.push(d.toString()));
    ws.send(JSON.stringify({ mode: 'active', browserId: 'longproc' }));

    // Wait for shell to be ready
    await sleep(2500);
    console.log('    pre-command buffer tail:', JSON.stringify(buf1.join('').slice(-120)));

    // Start ping - 30 pings to localhost = ~30 seconds
    ws.send('ping -n 30 127.0.0.1\r\n');

    // Let ~3 replies land
    let pre = 0;
    for (let i = 0; i < 60; i++) {
      pre = countReplies(buf1.join(''));
      if (pre >= 3) break;
      await sleep(250);
    }
    console.log('    replies before restart:', pre);
    if (pre < 2) {
      console.log('    buffer tail:', JSON.stringify(buf1.join('').slice(-400)));
      throw new Error('ping did not start producing output');
    }

    const status = readStatus();
    const workerPid = status.worker.pid;
    const webPidBefore = status.web.pid;
    console.log('    worker PID:', workerPid, ' web PID:', webPidBefore);

    console.log('\n[3/5] Killing web.js (worker + ping must survive)...');
    ws.close();
    process.kill(webPidBefore, 'SIGKILL');

    // Wait for monitor to restart web
    let status2, attempts = 0;
    do {
      await sleep(500);
      status2 = readStatus();
      attempts++;
    } while ((status2.web.pid === webPidBefore || status2.web.pid == null) && attempts < 20);
    if (status2.worker.pid !== workerPid) throw new Error('worker PID changed!');
    console.log('    ✓ worker unchanged:', workerPid, ' web:', webPidBefore, '→', status2.web.pid);

    // Wait for API ready
    console.log('\n[4/5] Waiting for new web.js to accept requests...');
    for (let i = 0; i < 20; i++) {
      try {
        const r = await api('GET', '/api/sessions', token);
        if (r.status === 200) break;
      } catch {}
      await sleep(500);
    }

    console.log('\n[5/5] Reconnecting + counting new ping replies after restart...');
    const ws2 = new WebSocket(`${WS_BASE}/ws/${sessionId}?token=${token}`);
    const buf2 = [];
    await new Promise((res, rej) => { ws2.once('open', res); ws2.once('error', rej); });
    ws2.on('message', d => buf2.push(d.toString()));
    ws2.send(JSON.stringify({ mode: 'active', browserId: 'longproc-2' }));

    // Scrollback should contain pre-restart replies
    await sleep(500);
    const scrollbackReplies = countReplies(buf2.join(''));
    console.log('    replies visible in scrollback on reattach:', scrollbackReplies);

    // Watch for *new* replies arriving after reattach
    const start = buf2.length;
    let postNew = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const delta = buf2.slice(start).join('');
      postNew = countReplies(delta);
      if (postNew >= 3) break;
    }
    console.log('    NEW replies received after restart:', postNew);

    if (postNew < 2) {
      throw new Error('FAIL: ping process did not keep streaming after restart');
    }
    ws2.close();
    console.log('\n=== PASS ===');
    console.log('Long process (ping) survived web.js restart and kept streaming output.');
  } finally {
    if (sessionId) { try { await api('DELETE', '/api/sessions/' + sessionId, token); } catch {} }
    cleanupToken(token);
  }
}

main().catch(e => { console.error('\n=== FAIL ===\n' + (e.stack || e.message)); process.exit(1); });
