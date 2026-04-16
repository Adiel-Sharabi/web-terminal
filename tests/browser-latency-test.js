#!/usr/bin/env node
// Browser-based typing latency test against production server
// Connects to a remote XPS session via cluster proxy in a real browser
// Usage: node tests/browser-latency-test.js

const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:7681';
const XPS_URL = 'https://adiel-xps.braid-mintaka.ts.net';

// Generate a valid session cookie using the server's secret
function makeSessionCookie() {
  const secretFile = path.join(__dirname, '..', '.session-secret');
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const payload = `admin:${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

async function main() {
  const cookie = makeSessionCookie();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // Inject session cookie
  await context.addCookies([{
    name: 'wt_session',
    value: cookie,
    domain: 'localhost',
    path: '/',
  }]);

  const page = await context.newPage();
  page.on('console', m => { if (!m.text().includes('DevTools')) console.log('  BROWSER:', m.text()); });
  console.log('Loading app with session cookie...');
  await page.goto(BASE);
  console.log('App loaded.');

  // Wait for app to load and terminal to appear
  await page.waitForSelector('.xterm-screen', { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Get XPS sessions via API
  const http = require('http');
  const LOCAL_TOKEN = 'e3728ca208ee5e5d03163ccd4b8ceaa113d75ab442ffe4023e7343e45ec9e0f2';
  const xpsSessions = await new Promise((resolve, reject) => {
    http.get(`${BASE}/api/cluster/sessions`, {
      headers: { 'Authorization': `Bearer ${LOCAL_TOKEN}` }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const resp = JSON.parse(data);
        const all = resp.sessions || resp;
        resolve(all.filter(s => s.serverUrl && s.serverUrl.includes('xps')));
      });
    }).on('error', reject);
  });

  console.log(`Found ${xpsSessions.length} XPS sessions:`);
  xpsSessions.forEach(s => console.log(`  ${s.name} (${s.status}, ${s.clients} clients) id=${s.id}`));

  const target = xpsSessions.find(s => s.clients === 0) || xpsSessions[0];
  if (!target) {
    console.log('No XPS sessions found!');
    await browser.close();
    return;
  }
  console.log(`\nConnecting to: ${target.name} (${target.id})`);

  // Switch to XPS session — call switchSession and wait for WS to open with correct serverUrl
  await page.evaluate(({ id, serverUrl }) => {
    switchSession(id, serverUrl);
  }, { id: target.id, serverUrl: target.serverUrl });

  // Wait for WS to connect through cluster proxy
  await page.waitForFunction(() => ws && ws.readyState === 1 && sessionServerUrl, { timeout: 10000 });
  await page.waitForTimeout(500);

  const connState = await page.evaluate(() => ({
    sessionId, sessionServerUrl, wsUrl: ws?.url
  }));
  console.log(`Connected via proxy: ${connState.wsUrl}`);

  // Inject timing instrumentation AFTER WS is connected
  await page.evaluate(() => {
    window._latencyLog = [];
    window._outputLog = [];

    // Listen for WS messages from server (output arriving)
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && !e.data.startsWith('{')) {
        window._outputLog.push({ time: performance.now(), len: e.data.length, sample: e.data.substring(0, 20) });
      }
    });
  });

  // Focus the terminal and send Ctrl+C to get a clean prompt
  await page.click('.xterm-screen');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(500);

  // Clear logs after setup
  await page.evaluate(() => { window._latencyLog = []; window._outputLog = []; });

  async function runTypingTest(label, text, delayMin, delayMax) {
    console.log(`\n--- ${label} ---`);
    await page.evaluate(() => { window._outputLog = []; window._testStart = performance.now(); });

    // Record browser-side keypress timestamps too
    await page.evaluate(() => {
      window._keypressLog = [];
      document.addEventListener('keydown', (e) => {
        if (e.key.length === 1) window._keypressLog.push({ key: e.key, time: performance.now() });
      }, { capture: true });
    });

    for (const char of text) {
      await page.keyboard.press(char === ' ' ? 'Space' : char);
      if (delayMax > 0) await page.waitForTimeout(delayMin + Math.random() * (delayMax - delayMin));
    }
    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => ({
      keys: window._keypressLog.slice(),
      outputs: window._outputLog.slice(),
      testStart: window._testStart,
    }));

    analyzeResults(label, data);

    // Remove keydown listener and cancel
    await page.evaluate(() => { window._keypressLog = []; });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);
  }

  // Test 1: Normal typing
  await runTypingTest('Normal typing (~80ms/char)', 'echo hello world', 60, 100);

  // Test 2: Fast typing
  await runTypingTest('Fast typing (~30ms/char)', 'the quick brown fox', 20, 40);

  // Test 3: Burst typing
  await runTypingTest('Burst typing (no delay)', 'abcdefghijklmnopqrstuvwx', 0, 0);

  // Test 4: Consistency - 3 burst runs
  console.log('\n--- Burst consistency (3 runs) ---');
  for (let run = 0; run < 3; run++) {
    await runTypingTest(`  Burst #${run + 1}`, 'run' + run + 'abcdefghijklmno', 0, 0);
  }

  await browser.close();
  console.log('\nDone.');
}

function analyzeResults(label, data) {
  const { keys, outputs } = data;
  if (!keys || !keys.length) {
    console.log(`  ${label}: No keypress data captured`);
    return;
  }
  if (!outputs || !outputs.length) {
    console.log(`  ${label}: ${keys.length} keys pressed but NO output received — possible connection issue`);
    return;
  }

  const firstKey = keys[0].time;
  const lastKey = keys[keys.length - 1].time;
  const firstOutput = outputs[0].time;
  const lastOutput = outputs[outputs.length - 1].time;

  // Per-keystroke latency: for each keypress, find the next output event after it
  const latencies = [];
  let oi = 0;
  for (const key of keys) {
    while (oi < outputs.length && outputs[oi].time <= key.time) oi++;
    if (oi < outputs.length) {
      latencies.push(Math.round(outputs[oi].time - key.time));
    }
  }

  // Output gaps (hiccups — periods where no data arrived)
  const gaps = [];
  for (let i = 1; i < outputs.length; i++) {
    const gap = outputs[i].time - outputs[i - 1].time;
    if (gap > 100) gaps.push(Math.round(gap));
  }

  // Stats
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? (sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(0) : '?';
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? '?';
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? '?';
  const min = sorted[0] ?? '?';
  const max = sorted[sorted.length - 1] ?? '?';

  // Total time from first keypress to last output
  const totalTime = lastOutput - firstKey;

  console.log(`  ${label}:`);
  console.log(`    Keys: ${keys.length}  Output events: ${outputs.length}  Total: ${totalTime.toFixed(0)}ms`);
  console.log(`    Key→screen: avg=${avg}ms  p50=${p50}ms  p95=${p95}ms  min=${min}ms  max=${max}ms`);
  if (gaps.length) {
    console.log(`    Hiccups (>100ms gap): ${gaps.length} → [${gaps.join(', ')}]ms`);
  } else {
    console.log(`    Hiccups: none — output was smooth`);
  }
  console.log(`    Latencies: [${sorted.join(', ')}]`);
}

main().catch(e => { console.error(e); process.exit(1); });
