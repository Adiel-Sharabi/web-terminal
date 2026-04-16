#!/usr/bin/env node
// Latency comparison test: Direct-to-XPS vs Proxied-through-local cluster WebSocket
// Usage: node tests/latency-test.js

const WebSocket = require('ws');
const https = require('https');
const http = require('http');

// --- Configuration ---
const XPS_URL = 'https://adiel-xps.braid-mintaka.ts.net';
const XPS_TOKEN = '4d2187c2156586f93165b91973e893db95403af8b0746d0db20da25b34b83d2f';
const LOCAL_URL = 'http://localhost:7681';
// Local API token (from api-tokens.json — pick the first cluster-labeled one)
const LOCAL_TOKEN = 'e3728ca208ee5e5d03163ccd4b8ceaa113d75ab442ffe4023e7343e45ec9e0f2';

const ITERATIONS = 10;
const TIMEOUT_MS = 10000;

// --- Helpers ---

function fetchJSON(url, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connect timed out'));
    }, TIMEOUT_MS);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Wait for output containing a marker string. Returns time elapsed (ms) from start. */
function waitForMarker(ws, marker, startTime) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      reject(new Error(`Timed out waiting for marker: ${marker}`));
    }, TIMEOUT_MS);

    const handler = (data) => {
      const text = data.toString();
      if (text.includes(marker)) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(Date.now() - startTime);
      }
    };
    ws.on('message', handler);
  });
}

/** Drain any pending output for a short period */
function drain(ws, ms = 300) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Just let messages flow through existing listeners
    const noop = () => {};
    ws.on('message', noop);
    setTimeout(() => { ws.removeListener('message', noop); clearTimeout(timer); resolve(); }, ms);
  });
}

/** Send a command and measure round-trip to see output marker */
async function measureCommandLatency(ws, iteration) {
  const marker = `__LATENCY_${Date.now()}_${iteration}__`;
  const cmd = `echo ${marker}\n`;

  // Drain any pending output first
  await drain(ws, 200);

  const start = Date.now();
  const promise = waitForMarker(ws, marker, start);
  ws.send(cmd);
  return promise;
}

function stats(values) {
  if (values.length === 0) return { avg: NaN, p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  return {
    avg: avg.toFixed(1),
    p50: p50.toFixed(1),
    p95: p95.toFixed(1),
    p99: p99.toFixed(1),
    min: sorted[0].toFixed(1),
    max: sorted[sorted.length - 1].toFixed(1),
  };
}

function printStats(label, values) {
  const s = stats(values);
  console.log(`  ${label}:`);
  console.log(`    avg=${s.avg}ms  p50=${s.p50}ms  p95=${s.p95}ms  p99=${s.p99}ms  min=${s.min}ms  max=${s.max}ms`);
  console.log(`    raw: [${values.map(v => v.toFixed(1)).join(', ')}]`);
}

// --- Main ---

async function main() {
  console.log('=== WebSocket Latency Test ===');
  console.log(`XPS:   ${XPS_URL}`);
  console.log(`Local: ${LOCAL_URL}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log('');

  // 1. Find a session on XPS
  console.log('Fetching sessions from XPS...');
  let xpsSessions;
  try {
    xpsSessions = await fetchJSON(`${XPS_URL}/api/sessions`, XPS_TOKEN);
  } catch (e) {
    console.error(`Failed to fetch XPS sessions: ${e.message}`);
    process.exit(1);
  }

  if (!xpsSessions.length) {
    console.error('No sessions found on XPS. Please create at least one session.');
    process.exit(1);
  }

  // Pick the first running session (prefer one with a shell)
  const session = xpsSessions[0];
  console.log(`Using session: ${session.id} (name: ${session.name || 'unnamed'}, shell: ${session.shell || 'unknown'})`);
  console.log('');

  // 2. Connect DIRECT to XPS
  const directWsUrl = `${XPS_URL.replace(/^http/, 'ws')}/ws/${session.id}?token=${XPS_TOKEN}`;
  console.log('Connecting directly to XPS WebSocket...');
  let directWs;
  try {
    directWs = await connectWs(directWsUrl);
    console.log('  Connected!');
  } catch (e) {
    console.error(`  Direct connection failed: ${e.message}`);
    process.exit(1);
  }

  // Drain initial scrollback
  await drain(directWs, 1000);

  // 3. Measure direct latency
  console.log(`\nMeasuring DIRECT latency (${ITERATIONS} iterations)...`);
  const directLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const latency = await measureCommandLatency(directWs, i);
      directLatencies.push(latency);
      process.stdout.write(`  #${i + 1}: ${latency.toFixed(1)}ms\n`);
    } catch (e) {
      console.log(`  #${i + 1}: FAILED (${e.message})`);
    }
  }

  directWs.close();

  // 4. Connect via LOCAL PROXY to XPS session
  const encodedXpsUrl = encodeURIComponent(XPS_URL);
  const proxyWsUrl = `ws://localhost:7681/cluster/${encodedXpsUrl}/ws/${session.id}?token=${LOCAL_TOKEN}`;
  console.log('\nConnecting via local cluster proxy...');
  let proxyWs;
  try {
    proxyWs = await connectWs(proxyWsUrl);
    console.log('  Connected!');
  } catch (e) {
    console.error(`  Proxy connection failed: ${e.message}`);
    console.error('  Make sure the local server is running on port 7681');
    console.error('  and has a valid cluster token for XPS');
    process.exit(1);
  }

  // Drain initial scrollback
  await drain(proxyWs, 1000);

  // 5. Measure proxied latency
  console.log(`\nMeasuring PROXIED latency (${ITERATIONS} iterations)...`);
  const proxyLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const latency = await measureCommandLatency(proxyWs, i);
      proxyLatencies.push(latency);
      process.stdout.write(`  #${i + 1}: ${latency.toFixed(1)}ms\n`);
    } catch (e) {
      console.log(`  #${i + 1}: FAILED (${e.message})`);
    }
  }

  proxyWs.close();

  // 6. Measure raw WebSocket round-trip (connect + first message)
  console.log('\n--- Raw WebSocket Connect Latency ---');

  // Direct connect timing
  const directConnectTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const ws = await connectWs(directWsUrl);
      const elapsed = Date.now() - start;
      directConnectTimes.push(elapsed);
      ws.close();
      process.stdout.write(`  Direct connect #${i + 1}: ${elapsed}ms\n`);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log(`  Direct connect #${i + 1}: FAILED (${e.message})`);
    }
  }

  // Proxy connect timing
  const proxyConnectTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const ws = await connectWs(proxyWsUrl);
      const elapsed = Date.now() - start;
      proxyConnectTimes.push(elapsed);
      ws.close();
      process.stdout.write(`  Proxy connect #${i + 1}: ${elapsed}ms\n`);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log(`  Proxy connect #${i + 1}: FAILED (${e.message})`);
    }
  }

  // 7. Report
  console.log('\n========================================');
  console.log('           RESULTS SUMMARY');
  console.log('========================================\n');

  console.log('Command echo round-trip (echo MARKER -> see MARKER in output):');
  if (directLatencies.length) printStats('DIRECT to XPS', directLatencies);
  if (proxyLatencies.length) printStats('PROXIED via local', proxyLatencies);

  if (directLatencies.length && proxyLatencies.length) {
    const avgDirect = directLatencies.reduce((a, b) => a + b, 0) / directLatencies.length;
    const avgProxy = proxyLatencies.reduce((a, b) => a + b, 0) / proxyLatencies.length;
    const overhead = avgProxy - avgDirect;
    const pct = ((overhead / avgDirect) * 100).toFixed(1);
    console.log(`\n  Proxy overhead: ${overhead.toFixed(1)}ms avg (${pct}% increase)`);
  }

  console.log('\nWebSocket connect time (5 samples):');
  if (directConnectTimes.length) printStats('DIRECT connect', directConnectTimes);
  if (proxyConnectTimes.length) printStats('PROXY connect', proxyConnectTimes);

  console.log('\n========================================');
  console.log('Done.');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
