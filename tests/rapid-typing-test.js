#!/usr/bin/env node
// Rapid typing latency test: simulates fast typing through cluster proxy
// Measures per-character echo latency and detects "stacking" (delayed bursts)
// Usage: node tests/rapid-typing-test.js

const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const XPS_URL = 'https://adiel-xps.braid-mintaka.ts.net';
const XPS_TOKEN = '4d2187c2156586f93165b91973e893db95403af8b0746d0db20da25b34b83d2f';
const LOCAL_URL = 'http://localhost:7681';
const LOCAL_TOKEN = 'e3728ca208ee5e5d03163ccd4b8ceaa113d75ab442ffe4023e7343e45ec9e0f2';

function fetchJSON(url, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data)); }
      });
    }).on('error', reject);
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    let scrollbackDone = false;
    ws.on('open', () => {
      // Wait a bit for scrollback to finish
      setTimeout(() => { scrollbackDone = true; resolve(ws); }, 500);
    });
    ws.on('error', reject);
    // Consume scrollback silently
    const buf = [];
    ws.on('message', d => { if (!scrollbackDone) buf.push(d); });
  });
}

// Send rapid keystrokes one at a time, measure when each echoes back
async function measureRapidTyping(ws, label, charDelay) {
  const testStr = 'the quick brown fox jumps';
  const chars = testStr.split('');
  const results = [];

  // First, send Ctrl+C and wait for clean prompt
  ws.send('\x03');
  await new Promise(r => setTimeout(r, 300));

  // Drain any pending output
  let draining = true;
  const drainHandler = () => {};
  ws.on('message', drainHandler);
  await new Promise(r => setTimeout(r, 200));
  ws.removeListener('message', drainHandler);

  console.log(`\n  [${label}] Sending "${testStr}" with ${charDelay}ms between chars...`);

  // Track all output timing
  const outputEvents = [];
  const msgHandler = (data) => {
    const str = Buffer.isBuffer(data) ? data.toString() : data;
    outputEvents.push({ time: performance.now(), data: str, len: str.length });
  };
  ws.on('message', msgHandler);

  const sendTimes = [];
  const startTime = performance.now();

  // Send characters with specified delay between each
  for (let i = 0; i < chars.length; i++) {
    sendTimes.push(performance.now());
    ws.send(chars[i]);
    if (charDelay > 0 && i < chars.length - 1) {
      await new Promise(r => setTimeout(r, charDelay));
    }
  }

  // Wait for all echoes to arrive
  await new Promise(r => setTimeout(r, 3000));
  ws.removeListener('message', msgHandler);

  const endTime = performance.now();
  const totalOutputChars = outputEvents.reduce((s, e) => s + e.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length, 0);

  // Analyze output timing - find gaps > 100ms between output events
  const gaps = [];
  for (let i = 1; i < outputEvents.length; i++) {
    const gap = outputEvents[i].time - outputEvents[i - 1].time;
    if (gap > 50) {
      gaps.push({ gap: Math.round(gap), afterEvent: i, dataLen: outputEvents[i].len });
    }
  }

  // Calculate first and last output times
  const firstOutput = outputEvents.length > 0 ? outputEvents[0].time - startTime : -1;
  const lastOutput = outputEvents.length > 0 ? outputEvents[outputEvents.length - 1].time - startTime : -1;
  const sendDuration = sendTimes[sendTimes.length - 1] - sendTimes[0];

  // Find "stacking" - output that arrives in bursts rather than smoothly
  const burstThreshold = 100; // ms
  let bursts = 0, currentBurstSize = 0;
  for (let i = 1; i < outputEvents.length; i++) {
    const gap = outputEvents[i].time - outputEvents[i - 1].time;
    if (gap < 5) {
      currentBurstSize++;
    } else {
      if (currentBurstSize > 3) bursts++;
      currentBurstSize = 0;
    }
  }
  if (currentBurstSize > 3) bursts++;

  console.log(`    Sent ${chars.length} chars in ${sendDuration.toFixed(0)}ms`);
  console.log(`    Got ${outputEvents.length} output events, ${totalOutputChars} chars`);
  console.log(`    First output: ${firstOutput.toFixed(0)}ms, Last output: ${lastOutput.toFixed(0)}ms`);
  console.log(`    Output bursts (>3 events <5ms apart): ${bursts}`);
  if (gaps.length > 0) {
    console.log(`    Gaps >50ms between outputs:`);
    for (const g of gaps.slice(0, 10)) {
      console.log(`      ${g.gap}ms gap (event #${g.afterEvent}, ${g.dataLen} bytes)`);
    }
  } else {
    console.log(`    No gaps >50ms - output was smooth`);
  }

  return { outputEvents, gaps, bursts, firstOutput, lastOutput, sendDuration, totalOutputChars };
}

// Measure raw single-char echo latency
async function measureEchoLatency(ws, label, count) {
  console.log(`\n  [${label}] Measuring single-char echo latency (${count} samples)...`);
  ws.send('\x03');
  await new Promise(r => setTimeout(r, 500));

  const latencies = [];
  for (let i = 0; i < count; i++) {
    // Drain
    const drain = d => {};
    ws.on('message', drain);
    await new Promise(r => setTimeout(r, 50));
    ws.removeListener('message', drain);

    const char = String.fromCharCode(97 + (i % 26)); // a-z
    const sendTime = performance.now();
    let resolved = false;

    const lat = await new Promise((resolve) => {
      const handler = (data) => {
        if (resolved) return;
        const str = Buffer.isBuffer(data) ? data.toString() : data;
        if (str.includes(char)) {
          resolved = true;
          ws.removeListener('message', handler);
          resolve(performance.now() - sendTime);
        }
      };
      ws.on('message', handler);
      ws.send(char);
      setTimeout(() => { resolved = true; ws.removeListener('message', handler); resolve(-1); }, 5000);
    });

    if (lat > 0) latencies.push(Math.round(lat));
    await new Promise(r => setTimeout(r, 100));
  }

  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  console.log(`    avg=${avg.toFixed(0)}ms  p50=${p50}ms  p95=${p95}ms  min=${latencies[0]}ms  max=${latencies[latencies.length-1]}ms`);
  console.log(`    raw: [${latencies.join(', ')}]`);
  return { avg, p50, p95, latencies };
}

async function main() {
  console.log('=== Rapid Typing Latency Test ===\n');

  // Get XPS sessions — prefer one with 0 clients to avoid exclusive viewer conflicts
  const sessions = await fetchJSON(`${XPS_URL}/api/sessions`, XPS_TOKEN);
  if (!sessions.length) { console.log('No sessions on XPS!'); return; }
  const free = sessions.find(s => s.clients === 0) || sessions[0];
  const sid = free.id;
  console.log(`Using XPS session: ${sid} (${free.name}, ${free.clients} clients)`);

  // Test 1: Direct to XPS (close before proxy test to avoid exclusive viewer kick)
  console.log('\n--- DIRECT to XPS ---');
  const directWs = await connectWs(`wss://adiel-xps.braid-mintaka.ts.net/ws/${sid}?token=${XPS_TOKEN}`);
  const directEcho = await measureEchoLatency(directWs, 'DIRECT', 20);
  const directFast = await measureRapidTyping(directWs, 'DIRECT 30ms/char', 30);
  const directBurst = await measureRapidTyping(directWs, 'DIRECT 0ms/char (burst)', 0);
  directWs.send('\x03');
  directWs.close();
  await new Promise(r => setTimeout(r, 500)); // let server clean up

  // Test 2: Via cluster proxy (same session, now free)
  console.log('\n--- PROXIED via local ---');
  const proxyUrl = `ws://localhost:7681/cluster/${encodeURIComponent(XPS_URL)}/ws/${sid}?token=${LOCAL_TOKEN}`;
  const proxyWs = await connectWs(proxyUrl);
  const proxyEcho = await measureEchoLatency(proxyWs, 'PROXIED', 20);
  const proxyFast = await measureRapidTyping(proxyWs, 'PROXIED 30ms/char', 30);
  const proxyBurst = await measureRapidTyping(proxyWs, 'PROXIED 0ms/char (burst)', 0);
  proxyWs.send('\x03');
  proxyWs.close();

  // Summary
  console.log('\n========================================');
  console.log('           SUMMARY');
  console.log('========================================');
  console.log(`Single-char echo:  DIRECT avg=${directEcho.avg.toFixed(0)}ms  PROXIED avg=${proxyEcho.avg.toFixed(0)}ms  overhead=${(proxyEcho.avg - directEcho.avg).toFixed(0)}ms`);
  console.log(`Rapid typing (30ms): DIRECT bursts=${directFast.bursts}  PROXIED bursts=${proxyFast.bursts}`);
  console.log(`Burst typing (0ms):  DIRECT bursts=${directBurst.bursts}  PROXIED bursts=${proxyBurst.bursts}`);
  console.log(`DIRECT gaps>50ms: ${directFast.gaps.length + directBurst.gaps.length}  PROXIED gaps>50ms: ${proxyFast.gaps.length + proxyBurst.gaps.length}`);
  console.log('========================================\n');
}

main().catch(e => { console.error(e); process.exit(1); });
