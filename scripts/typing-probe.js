#!/usr/bin/env node
// Typing-probe — synthetic keystrokes at poisson-ish intervals, measures per-key RTT.
// Useful for reproducing p99 stalls and evaluating direct-terminal mode vs proxy.
//
// Required env:
//   PROBE_TARGET_URL=http://host:port    — the server that owns the session
//   PROBE_TARGET_TOKEN=<bearer>          — api-tokens.json entry on that server
// Optional env:
//   PROBE_OFFICE_URL=http://host:port    — cluster hub for proxy-mode WS and direct-URL lookup
//   PROBE_OFFICE_TOKEN=<bearer>          — required when PROBE_MODE=proxy or crossing a cluster hub
//   PROBE_MODE=direct|proxy|local        — default: local (WS straight to PROBE_TARGET_URL)
//   PROBE_DURATION_SEC=180               — default: 180
//   PROBE_MEAN_MS=150                    — mean inter-keystroke interval
//
// Output: per-RTT stall log (> 100 ms) and a final summary with histogram.

const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const TARGET_URL   = process.env.PROBE_TARGET_URL;
const TARGET_TOKEN = process.env.PROBE_TARGET_TOKEN;
const OFFICE_URL   = process.env.PROBE_OFFICE_URL;
const OFFICE_TOKEN = process.env.PROBE_OFFICE_TOKEN;
const MODE         = process.env.PROBE_MODE || 'local';
const DURATION     = parseInt(process.env.PROBE_DURATION_SEC || '180') * 1000;
const MEAN_MS      = parseInt(process.env.PROBE_MEAN_MS || '150');

if (!TARGET_URL || !TARGET_TOKEN) {
  console.error('usage: PROBE_TARGET_URL=... PROBE_TARGET_TOKEN=... [PROBE_OFFICE_URL=... PROBE_OFFICE_TOKEN=...] [PROBE_MODE=local|direct|proxy] node scripts/typing-probe.js');
  process.exit(2);
}
if ((MODE === 'direct' || MODE === 'proxy') && (!OFFICE_URL || !OFFICE_TOKEN)) {
  console.error('PROBE_MODE=direct|proxy requires PROBE_OFFICE_URL and PROBE_OFFICE_TOKEN');
  process.exit(2);
}

function httpJson(method, url, token, body) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 10000, rejectUnauthorized: false,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function nextDelay() {
  const u = Math.random();
  let d = -Math.log(1 - u) * MEAN_MS;
  if (d < 30) d = 30;
  if (d > MEAN_MS * 4) d = MEAN_MS * 4;
  return d;
}
function stats(arr) {
  if (!arr.length) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pick = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return { n: arr.length, min: sorted[0].toFixed(1), p50: pick(0.5).toFixed(1),
    p90: pick(0.9).toFixed(1), p99: pick(0.99).toFixed(1),
    max: sorted[sorted.length - 1].toFixed(1), mean: mean.toFixed(1) };
}
function histogram(arr) {
  const buckets = [10, 30, 50, 100, 200, 500, 1000, 2000, 5000, Infinity];
  const labels = ['<10ms', '10-30', '30-50', '50-100', '100-200', '200-500', '500-1s', '1-2s', '2-5s', '>5s'];
  const counts = new Array(buckets.length).fill(0);
  for (const v of arr) for (let i = 0; i < buckets.length; i++) if (v < buckets[i]) { counts[i]++; break; }
  return labels.map((l, i) => `${l.padStart(7)}: ${counts[i]}`).join('\n');
}

(async () => {
  console.log(`[probe] target=${TARGET_URL} mode=${MODE} duration=${DURATION / 1000}s mean-interval=${MEAN_MS}ms`);

  console.log('[setup] creating session...');
  const create = await httpJson('POST', TARGET_URL + '/api/sessions', TARGET_TOKEN,
    { cwd: 'C:\\dev', name: 'typing-probe', autoCommand: ':' });
  if (create.status !== 200) { console.error('create failed:', create); process.exit(1); }
  const sid = create.body.id;
  console.log(`[setup] session ${sid}`);
  await new Promise(r => setTimeout(r, 1500));

  let wsUrl;
  if (MODE === 'local') {
    const wsBase = TARGET_URL.replace(/^http/, 'ws');
    wsUrl = `${wsBase}/ws/${sid}?token=${TARGET_TOKEN}`;
  } else if (MODE === 'direct') {
    const cl = await httpJson('GET', OFFICE_URL + '/api/cluster/sessions', OFFICE_TOKEN);
    const ours = (cl.body.sessions || []).find(s => s.id === sid);
    if (!ours || !ours.directUrl) { console.error('no directUrl available — is directConnect: true on that peer?', ours); process.exit(1); }
    wsUrl = ours.directUrl;
  } else if (MODE === 'proxy') {
    const wsBase = OFFICE_URL.replace(/^http/, 'ws');
    wsUrl = `${wsBase}/cluster/${encodeURIComponent(TARGET_URL)}/ws/${sid}?token=${OFFICE_TOKEN}`;
  } else { console.error('bad PROBE_MODE'); process.exit(2); }
  console.log(`[setup] wsUrl = ${wsUrl.substring(0, 90)}...`);

  const samples = [], stalls = [];
  const startSession = Date.now();
  let round = 0, currentMarker = null, t0 = 0, attached = false, settleTimer = null, finished = false;
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });

  async function finish(reason) {
    if (finished) return;
    finished = true;
    try { ws.close(); } catch {}
    console.log(`\n[probe] done (${reason}): n=${samples.length}`);
    console.log('[probe] stats:', stats(samples));
    console.log('[probe] histogram:\n' + histogram(samples));
    console.log(`[probe] stalls>100ms: ${stalls.length}`);
    if (stalls.length) {
      console.log('[probe] first 10 stalls:');
      for (const st of stalls.slice(0, 10))
        console.log('  ' + new Date(st.ts).toISOString() + '  rtt=' + st.rtt.toFixed(0) + 'ms');
    }
    try { await httpJson('DELETE', TARGET_URL + '/api/sessions/' + sid, TARGET_TOKEN); } catch {}
    console.log('[teardown] session deleted');
    process.exit(0);
  }
  function fireKey() {
    if (finished) return;
    if (Date.now() - startSession > DURATION) return finish('duration elapsed');
    currentMarker = String.fromCharCode(97 + (round % 26));
    t0 = performance.now();
    try { ws.send(currentMarker); } catch {}
  }
  ws.on('open', () => {
    ws.send(JSON.stringify({ mode: 'active', browserId: 'typing-probe' }));
    ws.send(JSON.stringify({ resize: { cols: 120, rows: 30 } }));
    settleTimer = setTimeout(() => { attached = true; fireKey(); }, 2000);
  });
  ws.on('message', (data) => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (!attached) { settleTimer = setTimeout(() => { attached = true; fireKey(); }, 400); return; }
    if (currentMarker == null) return;
    const str = typeof data === 'string' ? data : data.toString('utf8');
    if (!str.includes(currentMarker)) return;
    const rtt = performance.now() - t0;
    samples.push(rtt);
    if (rtt > 100) {
      const ts = Date.now(); stalls.push({ rtt, ts });
      console.log(`[probe] RTT>100ms: ${new Date(ts).toISOString()}  rtt=${rtt.toFixed(0)}ms  round=${round}`);
    }
    currentMarker = null; round++;
    setTimeout(fireKey, nextDelay());
  });
  ws.on('close', (code) => { if (!finished) finish('ws closed ' + code); });
  ws.on('error', (err) => { console.error('[probe] ws error:', err.message); if (!finished) finish('ws error'); });
  setTimeout(() => { if (!finished) finish('hard timeout'); }, DURATION + 30000);
})().catch(e => { console.error(e); process.exit(1); });
