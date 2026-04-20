// Latency harness — measures WS keystroke round-trip in proxy vs direct mode.
// Spawns probes on one session per mode, N rounds each, reports statistics.

const WebSocket = require('C:/dev/web-terminal/node_modules/ws');
const http = require('http');

const OFFICE = 'http://localhost:7784';
const HOME   = 'http://localhost:7785';
const OFFICE_TOKEN = 'ea23ecc31eb999971ad460593a5e5b1f9d4dab9a0da92940037262285f666bbe';
const HOME_TOKEN   = '8727e858f500927c0dd54968a79d03247ee92aa042bf20a89ad7476f22431fa7';

const ROUNDS = 50;
const INTER_PROBE_DELAY_MS = 30;

function httpJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
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

function stats(arr) {
  if (!arr || arr.length === 0) return { n: 0, error: 'no samples' };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return {
    n: arr.length,
    min: sorted[0].toFixed(2),
    p50: sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
    p90: sorted[Math.floor(sorted.length * 0.9)].toFixed(2),
    p99: sorted[Math.floor(sorted.length * 0.99)].toFixed(2),
    max: sorted[sorted.length - 1].toFixed(2),
    mean: mean.toFixed(2),
  };
}

async function runProbe(label, wsUrl) {
  const samples = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let attached = false;
    let settleTimer = null;
    let round = 0;
    let currentMarker = null;
    let t0 = 0;

    const tryProbe = () => {
      if (round >= ROUNDS) {
        ws.close();
        resolve({ label, samples, stats: stats(samples) });
        return;
      }
      // Use a unique single-char marker per round (cycle through a-z)
      currentMarker = String.fromCharCode(97 + (round % 26));
      t0 = performance.now();
      ws.send(currentMarker);
    };

    ws.on('open', () => {
      // Send mode:active to attach
      ws.send(JSON.stringify({ mode: 'active', browserId: 'latency-harness-' + label }));
      // Wait for 500ms of silence to consider scrollback settled
      settleTimer = setTimeout(() => { attached = true; tryProbe(); }, 500);
    });

    ws.on('message', (data) => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = setTimeout(() => { attached = true; tryProbe(); }, 500); }
      if (!attached) return;
      const str = typeof data === 'string' ? data : data.toString('utf8');
      if (currentMarker && str.includes(currentMarker)) {
        const t1 = performance.now();
        samples.push(t1 - t0);
        currentMarker = null;
        round++;
        setTimeout(tryProbe, INTER_PROBE_DELAY_MS);
      }
    });

    ws.on('error', (err) => { console.error('[' + label + '] ws error:', err.message); reject(err); });
    ws.on('close', (code, reason) => {
      console.error('[' + label + '] ws closed: code=' + code + ' reason=' + (reason?.toString() || '') + ' samples=' + samples.length);
      if (samples.length < ROUNDS) {
        resolve({ label, samples, stats: stats(samples), closed: { code, reason: reason?.toString() } });
      }
    });
    ws.on('unexpected-response', (req, res) => {
      console.error('[' + label + '] unexpected-response:', res.statusCode);
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { console.error('  body:', d.substring(0, 200)); });
    });

    // Timeout safety
    setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.close(); }, 30000);
  });
}

(async () => {
  // Create a session on shadow-home
  console.log('[setup] creating session on shadow-home…');
  const createRes = await httpJson('POST', HOME + '/api/sessions', HOME_TOKEN, { cwd: 'C:\\dev', name: 'latency-probe' });
  if (createRes.status !== 200) {
    console.error('create failed:', createRes);
    process.exit(1);
  }
  const sid = createRes.body.id;
  console.log('[setup] session id =', sid);

  // Give the session a moment to spawn and settle
  await new Promise(r => setTimeout(r, 1000));

  // Fetch cluster/sessions from shadow-office to get the directUrl
  const clusterRes = await httpJson('GET', OFFICE + '/api/cluster/sessions', OFFICE_TOKEN);
  const ours = clusterRes.body.sessions.find(s => s.id === sid);
  if (!ours || !ours.directUrl) {
    console.error('no directUrl found for our session:', ours);
    process.exit(1);
  }
  console.log('[setup] directUrl =', ours.directUrl.substring(0, 100) + '...');

  // Proxy path is /cluster/<url>/ws/<sid> on shadow-office (which forwards to shadow-home)
  const encodedHome = encodeURIComponent(HOME);
  const proxyUrl  = `ws://localhost:7784/cluster/${encodedHome}/ws/${sid}?token=${OFFICE_TOKEN}`;
  const directUrl = ours.directUrl;

  console.log('\n[run] PROXY mode (browser → office → home):');
  const proxy = await runProbe('proxy', proxyUrl);
  console.log('  stats:', proxy.stats);

  // brief pause between runs
  await new Promise(r => setTimeout(r, 500));

  console.log('\n[run] DIRECT mode (browser → home):');
  const direct = await runProbe('direct', directUrl);
  console.log('  stats:', direct.stats);

  console.log('\n=== comparison ===');
  console.log('proxy.p50  =', proxy.stats.p50, 'ms  |  direct.p50  =', direct.stats.p50, 'ms  |  delta =', (proxy.stats.p50 - direct.stats.p50).toFixed(2), 'ms');
  console.log('proxy.mean =', proxy.stats.mean, 'ms  |  direct.mean =', direct.stats.mean, 'ms  |  delta =', (proxy.stats.mean - direct.stats.mean).toFixed(2), 'ms');
  console.log('proxy.p99  =', proxy.stats.p99, 'ms  |  direct.p99  =', direct.stats.p99, 'ms  |  delta =', (proxy.stats.p99 - direct.stats.p99).toFixed(2), 'ms');

  // Cleanup — delete the probe session
  await httpJson('DELETE', HOME + '/api/sessions/' + sid, HOME_TOKEN);
  console.log('\n[teardown] session deleted');
})();
