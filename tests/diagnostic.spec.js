// @ts-check
// Web Terminal Performance Diagnostic Suite
// Runs against the LIVE server — no restart, no side effects on existing sessions.
//
// Usage:
//   DIAG_PASS=yourpassword npx playwright test tests/diagnostic.spec.js --config playwright.diag.config.js --reporter=list
//
// Optional env vars:
//   DIAG_URL   — server URL (default: http://localhost:7681)
//   DIAG_USER  — username   (default: admin)
//   DIAG_PASS  — password   (REQUIRED)
//   DIAG_LAG_DURATION — event-loop monitor duration in ms (default: 65000)

const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.env.DIAG_URL || 'http://localhost:7681';
const CREDS = { user: process.env.DIAG_USER || 'admin', password: process.env.DIAG_PASS };
const LAG_DURATION = parseInt(process.env.DIAG_LAG_DURATION) || 65000;

// ─── Helpers ─────────────────────────────────────────────────
let _authCookie = null;

async function getAuthCookie() {
  if (_authCookie) return _authCookie;
  if (!CREDS.password) {
    throw new Error(
      'DIAG_PASS env var is required.\n' +
      'Usage: DIAG_PASS=yourpassword npx playwright test tests/diagnostic.spec.js --config playwright.diag.config.js --reporter=list'
    );
  }
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.post('/login', {
    form: CREDS,
    maxRedirects: 0,
  });
  expect(res.status(), `Login failed (status ${res.status()}) — check DIAG_USER/DIAG_PASS`).toBe(302);
  _authCookie = res.headers()['set-cookie'].split(';')[0];
  await ctx.dispose();
  return _authCookie;
}

async function apiCtx() {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Cookie: await getAuthCookie() },
  });
}

async function loginPage(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', CREDS.user);
  await page.fill('input[name="password"]', CREDS.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 10000 });
}

function calcStats(arr) {
  if (!arr.length) return { min: 0, max: 0, avg: 0, p95: 0, p99: 0, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return {
    min: Math.round(s[0]),
    max: Math.round(s[s.length - 1]),
    avg: Math.round(s.reduce((a, b) => a + b) / s.length),
    p95: Math.round(s[Math.floor(s.length * 0.95)]),
    p99: Math.round(s[Math.floor(s.length * 0.99)] || s[s.length - 1]),
    n: s.length,
  };
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

// ─── Report accumulator (persists across serial tests) ───────
const report = {
  timestamp: new Date().toISOString(),
  server: BASE,
  phases: {},
  findings: [],
};

// ─── Tests ───────────────────────────────────────────────────
test.describe.serial('Web Terminal Performance Diagnostics', () => {

  // ═══════════════════════════════════════════════════════════
  // Phase 1: API Response Times
  // ═══════════════════════════════════════════════════════════
  test('Phase 1: API Response Times', async () => {
    test.setTimeout(180000);
    const ctx = await apiCtx();
    // Fast endpoints get more samples; slow ones (cluster, version) get fewer
    const endpoints = [
      { path: '/api/hostname',          samples: 10 },
      { path: '/api/sessions',          samples: 10 },
      { path: '/api/config',            samples: 10 },
      { path: '/api/cluster/sessions',  samples: 3 },  // each call waits for cluster timeouts
      { path: '/api/version',           samples: 3 },  // execSync git commands incl. network
    ];
    const results = {};

    for (const ep of endpoints) {
      const times = [];
      for (let i = 0; i < ep.samples; i++) {
        const t0 = Date.now();
        try { await ctx.get(ep.path, { timeout: 15000 }); } catch (e) { /* timeout or network error */ }
        times.push(Date.now() - t0);
      }
      results[ep.path] = calcStats(times);
    }

    report.phases.apiTiming = results;

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          Phase 1: API Response Times (ms)                   ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`  ${pad('Endpoint', 28)} ${rpad('Avg', 6)} ${rpad('P95', 6)} ${rpad('P99', 6)} ${rpad('Max', 6)}  Flag`);
    console.log('  ' + '-'.repeat(62));
    for (const [ep, s] of Object.entries(results)) {
      let flag = '';
      if (s.max > 500) { flag = '!! BLOCKING'; report.findings.push(`${ep}: max ${s.max}ms — likely event loop block`); }
      else if (s.max > 100) { flag = '! slow'; report.findings.push(`${ep}: max ${s.max}ms`); }
      console.log(`  ${pad(ep, 28)} ${rpad(s.avg, 6)} ${rpad(s.p95, 6)} ${rpad(s.p99, 6)} ${rpad(s.max, 6)}  ${flag}`);
    }

    await ctx.dispose();
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 2: Session Inventory & Scrollback Sizes
  // ═══════════════════════════════════════════════════════════
  test('Phase 2: Session Inventory & Scrollback', async ({ page }) => {
    test.setTimeout(120000); // remote WS connections may be slow
    await loginPage(page);
    const ctx = await apiCtx();

    // Fetch cluster sessions (local + remote)
    const clusterRes = await ctx.get('/api/cluster/sessions');
    const clusterData = await clusterRes.json();
    const allSessions = clusterData.sessions || [];
    const localSessions = allSessions.filter(s => !s.serverUrl);
    const remoteSessions = allSessions.filter(s => s.serverUrl);

    // ── Local sessions: connect WS in parallel, measure scrollback ──
    const localWs = localSessions.length > 0 ? await page.evaluate(async (sessions) => {
      return Promise.all(sessions.map(s => new Promise(resolve => {
        let resolved = false;
        const t0 = performance.now();
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/${s.id}`);
        let firstMsgMs = 0, scrollbackBytes = 0, totalBytes = 0, msgs = 0;

        function done() {
          if (resolved) return;
          resolved = true;
          try { ws.close(); } catch (e) {}
          resolve({
            id: s.id, name: s.name, status: s.status, clients: s.clients,
            connectMs: Math.round(firstMsgMs), scrollbackBytes, totalBytes, msgs
          });
        }

        ws.onopen = () => { setTimeout(done, 2000); };
        ws.onmessage = e => {
          const len = typeof e.data === 'string' ? e.data.length : (e.data.byteLength || 0);
          if (msgs === 0) { scrollbackBytes = len; firstMsgMs = performance.now() - t0; }
          totalBytes += len; msgs++;
        };
        ws.onerror = () => {
          if (resolved) return;
          resolved = true;
          resolve({ id: s.id, name: s.name, error: 'connect failed' });
        };
        setTimeout(done, 10000); // safety
      })));
    }, localSessions) : [];

    // ── Remote sessions: connect via cluster WS proxy ──
    const remoteWs = remoteSessions.length > 0 ? await page.evaluate(async (sessions) => {
      return Promise.all(sessions.map(s => new Promise(resolve => {
        let resolved = false;
        const t0 = performance.now();
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = `/cluster/${encodeURIComponent(s.serverUrl)}/ws/${s.id}`;
        const ws = new WebSocket(`${proto}//${location.host}${wsPath}`);
        let firstMsgMs = 0, scrollbackBytes = 0, totalBytes = 0, msgs = 0;

        function done() {
          if (resolved) return;
          resolved = true;
          try { ws.close(); } catch (e) {}
          resolve({
            id: s.id, name: s.name, server: s.server, serverUrl: s.serverUrl,
            status: s.status,
            connectMs: Math.round(firstMsgMs), scrollbackBytes, totalBytes, msgs
          });
        }

        ws.onopen = () => { setTimeout(done, 3000); };
        ws.onmessage = e => {
          const len = typeof e.data === 'string' ? e.data.length : (e.data.byteLength || 0);
          if (msgs === 0) { scrollbackBytes = len; firstMsgMs = performance.now() - t0; }
          totalBytes += len; msgs++;
        };
        ws.onerror = () => {
          if (resolved) return;
          resolved = true;
          resolve({ id: s.id, name: s.name, server: s.server, error: 'connect failed' });
        };
        setTimeout(done, 15000);
      })));
    }, remoteSessions) : [];

    report.phases.sessions = { local: localWs, remote: remoteWs, servers: clusterData.servers || [] };

    // ── Print local sessions ──
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          Phase 2: Session Inventory                         ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`\n  Local Sessions (${localSessions.length}):`);
    console.log(`  ${pad('Name', 28)} ${pad('Scrollback', 11)} ${pad('Total', 11)} ${rpad('WS ms', 6)} ${pad('Status', 8)} ${pad('V', 3)}`);
    console.log('  ' + '-'.repeat(72));
    for (const r of localWs) {
      if (r.error) { console.log(`  ${pad(r.name, 28)} ERROR: ${r.error}`); continue; }
      let flag = '';
      if (r.scrollbackBytes > 1048576) {
        flag = ' (!)';
        report.findings.push(`Session "${r.name}": scrollback ${fmtBytes(r.scrollbackBytes)}`);
      }
      console.log(`  ${pad(r.name, 28)} ${pad(fmtBytes(r.scrollbackBytes) + flag, 11)} ${pad(fmtBytes(r.totalBytes), 11)} ${rpad(r.connectMs, 6)} ${pad(r.status, 8)} ${pad(r.clients, 3)}`);
    }

    // ── Print remote sessions ──
    if (remoteWs.length) {
      console.log(`\n  Remote Sessions (${remoteWs.length}):`);
      console.log(`  ${pad('Server', 12)} ${pad('Name', 24)} ${pad('Scrollback', 11)} ${rpad('WS ms', 6)} ${pad('Status', 8)}`);
      console.log('  ' + '-'.repeat(68));
      for (const r of remoteWs) {
        if (r.error) { console.log(`  ${pad(r.server || '?', 12)} ${pad(r.name, 24)} ERROR: ${r.error}`); continue; }
        let flag = '';
        if (r.scrollbackBytes > 1048576) { flag = ' (!)'; report.findings.push(`Remote "${r.name}" [${r.server}]: scrollback ${fmtBytes(r.scrollbackBytes)}`); }
        console.log(`  ${pad(r.server, 12)} ${pad(r.name, 24)} ${pad(fmtBytes(r.scrollbackBytes) + flag, 11)} ${rpad(r.connectMs, 6)} ${pad(r.status, 8)}`);
      }
    }

    // ── Print cluster server status ──
    if (clusterData.servers && clusterData.servers.length) {
      console.log(`\n  Cluster Servers:`);
      for (const srv of clusterData.servers) {
        const st = srv.online ? (srv.needsAuth ? '! NEEDS AUTH' : 'online') : 'OFFLINE';
        console.log(`    ${pad(srv.name, 16)} ${st}${srv.url ? '  ' + srv.url : ''}`);
        if (!srv.online && srv.url) report.findings.push(`Cluster server "${srv.name}" is offline`);
      }
    }

    await ctx.dispose();
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 3: Event Loop Lag Detection
  // Monitors for 65+ seconds to catch at least one
  // saveAllScrollback() cycle (fires every 30s).
  // ═══════════════════════════════════════════════════════════
  test('Phase 3: Event Loop Lag Monitor', async () => {
    test.setTimeout(LAG_DURATION + 30000);
    const ctx = await apiCtx();
    const INTERVAL = 200; // ms between pings
    const SPIKE_THRESHOLD = 50; // ms
    const samples = [];
    const t0 = Date.now();

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          Phase 3: Event Loop Lag Monitor                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`  Pinging /api/hostname every ${INTERVAL}ms for ${LAG_DURATION / 1000}s...`);

    while (Date.now() - t0 < LAG_DURATION) {
      const pingStart = Date.now();
      try { await ctx.get('/api/hostname'); } catch (e) { /* network error */ }
      const latency = Date.now() - pingStart;
      samples.push({ offset: Date.now() - t0, latency });
      const wait = Math.max(0, INTERVAL - latency);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }

    const latencies = samples.map(s => s.latency);
    const lagStats = calcStats(latencies);
    const spikes = samples.filter(s => s.latency > SPIKE_THRESHOLD);

    // Detect ~30-second periodicity in spikes
    const spikeOffsets = spikes.map(s => s.offset);
    let has30sPattern = false;
    for (let i = 0; i < spikeOffsets.length && !has30sPattern; i++) {
      for (let j = i + 1; j < spikeOffsets.length; j++) {
        const diff = Math.abs(spikeOffsets[j] - spikeOffsets[i]);
        if (diff > 27000 && diff < 33000) { has30sPattern = true; break; }
      }
    }

    // Detect clusters of spikes (burst of high latency = long block)
    const spikeClusters = [];
    let clusterStart = null;
    for (let i = 0; i < spikes.length; i++) {
      if (!clusterStart) clusterStart = spikes[i];
      const next = spikes[i + 1];
      if (!next || next.offset - spikes[i].offset > 2000) {
        const clusterSpikes = spikes.filter(s => s.offset >= clusterStart.offset && s.offset <= spikes[i].offset);
        const peak = Math.max(...clusterSpikes.map(s => s.latency));
        const duration = spikes[i].offset - clusterStart.offset + spikes[i].latency;
        spikeClusters.push({
          offsetSec: (clusterStart.offset / 1000).toFixed(1),
          peakMs: peak,
          durationMs: Math.round(duration),
          count: clusterSpikes.length,
        });
        clusterStart = null;
      }
    }

    report.phases.eventLoopLag = { stats: lagStats, spikes, spikeClusters, has30sPattern, totalSamples: samples.length };

    console.log(`\n  Samples: ${samples.length} | Avg: ${lagStats.avg}ms | P95: ${lagStats.p95}ms | P99: ${lagStats.p99}ms | Max: ${lagStats.max}ms`);

    if (spikes.length) {
      console.log(`\n  Spikes (>${SPIKE_THRESHOLD}ms): ${spikes.length}`);
      if (spikeClusters.length) {
        console.log(`  Spike clusters:`);
        for (const c of spikeClusters) {
          console.log(`    [+${c.offsetSec}s] peak ${c.peakMs}ms, ~${c.durationMs}ms total, ${c.count} sample(s)`);
        }
      }
      console.log(`\n  Individual spikes (first 20):`);
      for (const s of spikes.slice(0, 20)) {
        const sec = (s.offset / 1000).toFixed(1);
        // Check if this spike is near a 30-second boundary (relative to any earlier spike)
        const near30 = spikeOffsets.some(o => o !== s.offset && Math.abs(Math.abs(o - s.offset) - 30000) < 3000);
        console.log(`    [+${pad(sec + 's', 7)}] ${rpad(s.latency, 5)}ms${near30 ? '  <-- ~30s from another spike' : ''}`);
      }

      if (has30sPattern) {
        console.log('\n  >> PATTERN: Spikes occur ~30s apart — consistent with saveAllScrollback() blocking');
        report.findings.push('Event loop spikes at ~30s intervals — saveAllScrollback() is likely blocking');
      }
    } else {
      console.log('  No spikes detected (all responses < 50ms). Event loop appears healthy.');
    }

    await ctx.dispose();
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 4: Typing Roundtrip Latency
  // Creates a temporary session, sends keystrokes, measures echo.
  // ═══════════════════════════════════════════════════════════
  test('Phase 4: Typing Roundtrip', async ({ page }) => {
    await loginPage(page);
    const ctx = await apiCtx();

    // Create a temporary session for typing tests
    const createRes = await ctx.post('/api/sessions', { data: { name: '__diag_roundtrip__' } });
    expect(createRes.status()).toBe(200);
    const { id: tempId } = await createRes.json();

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          Phase 4: Typing Roundtrip                          ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`  Temp session: ${tempId}`);

    try {
      // Wait for shell to be ready
      await new Promise(r => setTimeout(r, 2500));

      const roundtrips = await page.evaluate(async ({ sid, count }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return new Promise(resolve => {
          const ws = new WebSocket(`${proto}//${location.host}/ws/${sid}`);
          const results = [];
          let idx = 0, marker = null, sendTime = 0, buf = '', phase = 'wait';

          ws.onopen = () => {
            // Wait for scrollback/prompt to arrive, then start testing
            setTimeout(() => { phase = 'test'; next(); }, 2500);
          };

          ws.onmessage = e => {
            if (phase !== 'test' || !marker) return;
            buf += e.data;
            // The marker appears twice: once in the echoed command, once in the output
            const i1 = buf.indexOf(marker);
            const i2 = i1 >= 0 ? buf.indexOf(marker, i1 + marker.length) : -1;
            if (i2 >= 0) {
              results.push(Math.round(performance.now() - sendTime));
              idx++;
              buf = '';
              marker = null;
              if (idx >= count) { ws.close(); resolve(results); }
              else setTimeout(next, 150);
            }
          };

          function next() {
            marker = `_DG${idx}x${Date.now()}_`;
            buf = '';
            sendTime = performance.now();
            ws.send(`echo ${marker}\n`);
          }

          ws.onerror = () => resolve(results);
          // Safety: give up after 45 seconds
          setTimeout(() => { try { ws.close(); } catch (e) {} resolve(results); }, 45000);
        });
      }, { sid: tempId, count: 10 });

      if (roundtrips.length === 0) {
        console.log('  WARNING: No roundtrip samples collected (shell may not have been ready)');
        report.findings.push('Typing roundtrip: 0 samples collected');
      } else {
        const rtStats = calcStats(roundtrips);
        report.phases.typingRoundtrip = { stats: rtStats, samples: roundtrips };
        console.log(`  Samples: ${roundtrips.length} | Avg: ${rtStats.avg}ms | P95: ${rtStats.p95}ms | Max: ${rtStats.max}ms`);
        console.log(`  Individual: [${roundtrips.join(', ')}]`);
        if (rtStats.max > 200) report.findings.push(`Typing roundtrip spikes: max ${rtStats.max}ms`);
        if (rtStats.avg > 50) report.findings.push(`Typing roundtrip high average: ${rtStats.avg}ms`);
      }
    } finally {
      // Always clean up the temp session
      try { await ctx.delete('/api/sessions/' + tempId); } catch (e) {}
      console.log('  Temp session cleaned up.');
    }

    await ctx.dispose();
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 5: Session Switch (end-to-end in real UI)
  // Uses the app's actual switchSession() and measures from
  // click to first keystroke echo — the true user experience.
  // ═══════════════════════════════════════════════════════════
  test('Phase 5: Session Switch End-to-End', async ({ page }) => {
    test.setTimeout(120000);
    await loginPage(page);
    // Don't use networkidle — sidebar polls /api/cluster/sessions every 5s (never idle)
    await page.waitForSelector('.xterm', { timeout: 15000 });

    // Get all sessions via API
    const ctx = await apiCtx();
    const clusterRes = await ctx.get('/api/cluster/sessions');
    const clusterData = await clusterRes.json();
    const allSessions = clusterData.sessions || [];
    await ctx.dispose();

    if (allSessions.length < 2) {
      console.log('  Skipping: need at least 2 sessions to test switching.');
      return;
    }

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          Phase 5: Session Switch (end-to-end)               ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');

    // First, connect to the first session so we have a baseline
    await page.evaluate(async (s) => {
      window.__diagSwitchSession(s.id, s.serverUrl || undefined);
    }, allSessions[0]).catch(() => {});

    // Wait for initial session to be ready — need switchSession to be available
    // The app exposes switchSession in its closure. We need to hook into it.
    // Instead, we'll drive it through the sidebar click flow.

    // Open sidebar
    const sidebarOpen = await page.evaluate(() => {
      return document.getElementById('sidebar').classList.contains('open');
    });
    if (!sidebarOpen) {
      await page.click('.tb-btn');
      await page.waitForSelector('#sidebar.open');
    }
    await page.waitForSelector('.sb-item', { timeout: 10000 });

    // Collect all sidebar items
    const sidebarItems = await page.evaluate(() => {
      const items = document.querySelectorAll('.sb-item');
      return Array.from(items).map(el => ({
        name: el.querySelector('.sb-name')?.textContent || '?',
        isCurrent: el.classList.contains('current'),
      }));
    });

    const switchResults = [];

    // Switch to each non-current session and measure true end-to-end time:
    //   click → term.clear/reset → WS open → scrollback arrives → xterm renders → ready
    // We detect readiness by waiting for the terminal viewport to show NEW content
    // (not just the clear/reset which makes it blank).
    for (let i = 0; i < sidebarItems.length; i++) {
      const result = await page.evaluate(async (idx) => {
        return new Promise(resolve => {
          const items = document.querySelectorAll('.sb-item');
          const item = items[idx];
          if (!item) { resolve({ error: 'no item' }); return; }

          const name = item.querySelector('.sb-name')?.textContent || '?';
          const wasCurrent = item.classList.contains('current');
          if (wasCurrent) { resolve({ name, wasCurrent: true, switchMs: 0 }); return; }

          // Snapshot current terminal content before switch
          const viewport = document.querySelector('.xterm-rows');
          const beforeText = viewport ? viewport.textContent : '';

          const t0 = performance.now();

          // Click triggers switchSession → clear → reset → connect → scrollback → render
          item.click();

          // Poll for NEW content in the terminal viewport.
          // After clear/reset, viewport becomes empty. When scrollback renders, it fills up.
          // We wait for: (a) content changed from before, AND (b) viewport is non-empty.
          let blankSeen = false;
          const poll = setInterval(() => {
            const currentText = viewport ? viewport.textContent.trim() : '';

            // Phase 1: detect the blank state (after clear/reset)
            if (!blankSeen && currentText.length < 5) {
              blankSeen = true;
              return; // wait for new content
            }

            // Phase 2: after blank, detect new content (scrollback rendered)
            if (blankSeen && currentText.length > 10) {
              clearInterval(poll);
              // Wait one more animation frame for rendering to complete
              requestAnimationFrame(() => {
                resolve({
                  name,
                  switchMs: Math.round(performance.now() - t0),
                  contentLen: currentText.length,
                });
              });
            }
          }, 10); // check every 10ms

          // Safety timeout
          setTimeout(() => {
            clearInterval(poll);
            const currentText = viewport ? viewport.textContent.trim() : '';
            resolve({
              name,
              switchMs: Math.round(performance.now() - t0),
              timedOut: true,
              contentLen: currentText.length,
            });
          }, 15000);
        });
      }, i);

      switchResults.push(result);

      // Brief pause between switches to let things settle
      if (!result.wasCurrent) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    report.phases.sessionSwitch = switchResults;

    console.log(`  ${pad('Session', 28)} ${rpad('Switch ms', 10)} Notes`);
    console.log('  ' + '-'.repeat(55));
    for (const r of switchResults) {
      if (r.error) { console.log(`  ${pad(r.name || '?', 28)} ERROR`); continue; }
      let note = '';
      if (r.wasCurrent) note = '(already active, skipped)';
      else if (r.timedOut) { note = '!! TIMED OUT'; report.findings.push(`Session switch "${r.name}": timed out`); }
      else if (r.switchMs > 2000) { note = '!! VERY SLOW'; report.findings.push(`Session switch "${r.name}": ${r.switchMs}ms`); }
      else if (r.switchMs > 500) { note = '! slow'; }
      console.log(`  ${pad(r.name, 28)} ${rpad(r.switchMs, 10)} ${note}`);
    }

    const switchTimes = switchResults.filter(r => !r.wasCurrent && !r.error && !r.timedOut).map(r => r.switchMs);
    if (switchTimes.length) {
      const st = calcStats(switchTimes);
      console.log(`\n  Stats: Avg: ${st.avg}ms | P95: ${st.p95}ms | Max: ${st.max}ms`);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 6: Summary Report
  // ═══════════════════════════════════════════════════════════
  test('Phase 6: Summary & Report', async () => {
    const reportPath = path.join(__dirname, 'diagnostic-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          DIAGNOSTIC SUMMARY                                 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');

    if (report.findings.length === 0) {
      console.log('  No significant issues detected.');
    } else {
      console.log(`  ${report.findings.length} finding(s):\n`);
      for (let i = 0; i < report.findings.length; i++) {
        console.log(`  ${i + 1}. ${report.findings[i]}`);
      }
    }

    // Quick interpretation
    console.log('\n  ── Interpretation Guide ──');
    const lag = report.phases.eventLoopLag;
    if (lag) {
      if (lag.has30sPattern) {
        console.log('  * 30s spike pattern = saveAllScrollback() blocks the event loop.');
        console.log('    Every 30s the server JSON-serializes + writes ALL session scrollback');
        console.log('    synchronously. With large scrollbacks, this freezes everything.');
      }
      if (lag.stats.max > 500) {
        console.log(`  * Max lag ${lag.stats.max}ms = the server is completely unresponsive for ~${(lag.stats.max / 1000).toFixed(1)}s`);
        console.log('    During this time: typing freezes, no WS messages, no API responses.');
      }
    }
    const api = report.phases.apiTiming;
    if (api && api['/api/version'] && api['/api/version'].max > 500) {
      console.log('  * /api/version is slow = execSync git commands (incl. network fetch)');
      console.log('    block the event loop for up to 5 seconds.');
    }
    const sessions = report.phases.sessions;
    if (sessions) {
      const bigScrollback = [...(sessions.local || []), ...(sessions.remote || [])]
        .filter(s => s.scrollbackBytes > 500000);
      if (bigScrollback.length) {
        console.log(`  * ${bigScrollback.length} session(s) with >500KB scrollback.`);
        console.log('    Large scrollback = slower session switching (join + send on every connect)');
        console.log('    and longer saveAllScrollback() freezes.');
      }
    }

    console.log(`\n  Full JSON report: ${reportPath}`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
  });
});
