// Typing-probe — single-char keystrokes at poisson intervals, measures per-key RTT.
//
// env:
//   PROBE_TARGET=home|xps|office   (default: home)
//   PROBE_MODE=direct|proxy         (default: direct)
//   PROBE_DURATION_SEC=180          (default: 180)
//   PROBE_MEAN_MS=150               (default: 150 — mean inter-keystroke interval)
//
// Output:
//   - Log line per RTT > 100ms
//   - Final summary: count, p50, p90, p99, max + histogram buckets

const WebSocket = require('C:/dev/web-terminal/node_modules/ws');
const http = require('http');
const { performance } = require('perf_hooks');

const TARGETS = {
  office: { url: 'http://100.75.82.89:7784', token: 'ea23ecc31eb999971ad460593a5e5b1f9d4dab9a0da92940037262285f666bbe' },
  home:   { url: 'http://100.79.226.100:7785', token: '8727e858f500927c0dd54968a79d03247ee92aa042bf20a89ad7476f22431fa7' },
  xps:    { url: 'http://100.67.238.93:7786',  token: '4a1023df028ef87c7dc508a6d56b7729bc64b1bf40883af6ca6dbd6e9f8a18a5' },
};

const TARGET   = process.env.PROBE_TARGET   || 'home';
const MODE     = process.env.PROBE_MODE     || 'direct';
const DURATION = parseInt(process.env.PROBE_DURATION_SEC || '180') * 1000;
const MEAN_MS  = parseInt(process.env.PROBE_MEAN_MS || '150');

if (!TARGETS[TARGET]) { console.error('bad PROBE_TARGET'); process.exit(2); }

const OFFICE = TARGETS.office;
const TGT = TARGETS[TARGET];

function httpJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 10000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Poisson-ish interval generator: exponential with mean MEAN_MS, clamped 30..2*mean.
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
  return {
    n: arr.length,
    min: sorted[0].toFixed(1),
    p50: pick(0.5).toFixed(1),
    p90: pick(0.9).toFixed(1),
    p99: pick(0.99).toFixed(1),
    max: sorted[sorted.length - 1].toFixed(1),
    mean: mean.toFixed(1),
  };
}

function histogram(arr) {
  const buckets = [10, 30, 50, 100, 200, 500, 1000, 2000, 5000, Infinity];
  const labels = ['<10ms', '10-30', '30-50', '50-100', '100-200', '200-500', '500-1s', '1-2s', '2-5s', '>5s'];
  const counts = new Array(buckets.length).fill(0);
  for (const v of arr) {
    for (let i = 0; i < buckets.length; i++) {
      if (v < buckets[i]) { counts[i]++; break; }
    }
  }
  return labels.map((l, i) => `${l.padStart(7)}: ${counts[i]}`).join('\n');
}

(async () => {
  console.log(`[probe] target=${TARGET} mode=${MODE} duration=${DURATION/1000}s mean-interval=${MEAN_MS}ms`);

  // 1. Create a session on the target (local to it)
  console.log(`[setup] creating session on ${TARGET}...`);
  // Use a plain bash shell so the probe measures PTY RTT, not Claude CLI
  // startup latency. Pass ":" (bash no-op builtin) to block the server-side
  // "empty → default command" substitution and land on a ready bash prompt.
  const create = await httpJson('POST', TGT.url + '/api/sessions', TGT.token, { cwd: 'C:\\dev', name: 'typing-probe', autoCommand: ':' });
  if (create.status !== 200) { console.error('create failed:', create); process.exit(1); }
  const sid = create.body.id;
  console.log(`[setup] session ${sid}`);

  // Wait for the shell to come up
  await new Promise(r => setTimeout(r, 1500));

  // 2. Build the WS URL.
  //    direct: fetch from shadow-office /api/cluster/sessions and pull directUrl
  //    proxy: ws://office/cluster/<target-url>/ws/<sid>?token=<office-token>
  let wsUrl;
  if (MODE === 'direct') {
    if (TARGET === 'office') {
      // Office IS the cluster hub — no "direct" indirection; just WS straight in via token query.
      wsUrl = `ws://100.75.82.89:7784/ws/${sid}?token=${OFFICE.token}`;
    } else {
      const cl = await httpJson('GET', OFFICE.url + '/api/cluster/sessions', OFFICE.token);
      const ours = cl.body.sessions.find(s => s.id === sid);
      if (!ours || !ours.directUrl) { console.error('no directUrl:', ours); process.exit(1); }
      wsUrl = ours.directUrl;
    }
  } else if (MODE === 'proxy') {
    wsUrl = `ws://100.75.82.89:7784/cluster/${encodeURIComponent(TGT.url)}/ws/${sid}?token=${OFFICE.token}`;
  } else {
    console.error('bad PROBE_MODE'); process.exit(2);
  }
  console.log(`[setup] wsUrl = ${wsUrl.substring(0, 90)}...`);

  // 3. Open WS and wait for attach to settle
  const samples = [];
  const stalls = [];  // { rtt, ts }
  const startSession = Date.now();
  let round = 0;
  let currentMarker = null;
  let t0 = 0;
  let attached = false;
  let settleTimer = null;
  let finished = false;

  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });

  function finish(reason) {
    if (finished) return;
    finished = true;
    try { ws.close(); } catch {}
    console.log(`\n[probe] done (${reason}): n=${samples.length}`);
    const s = stats(samples);
    console.log('[probe] stats:', s);
    console.log('[probe] histogram:\n' + histogram(samples));
    console.log(`[probe] stalls>100ms: ${stalls.length}`);
    if (stalls.length) {
      console.log('[probe] first 10 stalls:');
      for (const st of stalls.slice(0, 10)) console.log('  ' + new Date(st.ts).toISOString() + '  rtt=' + st.rtt.toFixed(0) + 'ms');
    }
    // Clean up the session
    httpJson('DELETE', TGT.url + '/api/sessions/' + sid, TGT.token).then(() => {
      console.log('[teardown] session deleted');
      process.exit(0);
    }).catch(() => process.exit(0));
  }

  function fireKey() {
    if (finished) return;
    if (Date.now() - startSession > DURATION) { finish('duration elapsed'); return; }
    // Pick a random printable ASCII char (a-z) as the marker
    currentMarker = String.fromCharCode(97 + (round % 26));
    t0 = performance.now();
    try { ws.send(currentMarker); } catch {}
  }

  ws.on('open', () => {
    ws.send(JSON.stringify({ mode: 'active', browserId: 'typing-probe' }));
    ws.send(JSON.stringify({ resize: { cols: 120, rows: 30 } }));
    // Wait for scrollback + steady state — 2s of quiet = settled (bash prompt).
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
      const ts = Date.now();
      stalls.push({ rtt, ts });
      console.log(`[probe] RTT>100ms: ${new Date(ts).toISOString()}  rtt=${rtt.toFixed(0)}ms  round=${round}`);
    }
    currentMarker = null;
    round++;
    setTimeout(fireKey, nextDelay());
  });

  ws.on('close', (code) => { if (!finished) finish('ws closed ' + code); });
  ws.on('error', (err) => { console.error('[probe] ws error:', err.message); if (!finished) finish('ws error'); });

  // Absolute duration + 30s timeout
  setTimeout(() => { if (!finished) finish('hard timeout'); }, DURATION + 30000);
})().catch(e => { console.error(e); process.exit(1); });
