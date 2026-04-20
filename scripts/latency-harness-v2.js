// Latency harness v2 — shadows on real remote machines (tailscale network).
// Usage: node .tmp-latency-harness-v2.js <harness-location>
//   harness-location: 'office' (default), 'home', or 'xps'
// The harness always targets a session on home-shadow (remote from office, local to home).
// Proxy path: harness → office-shadow → home-shadow
// Direct path: harness → home-shadow

const WebSocket = require('C:/dev/web-terminal/node_modules/ws');
const http = require('http');

const OFFICE = 'http://100.75.82.89:7784';
const HOME   = 'http://100.79.226.100:7785';
const XPS    = 'http://100.67.238.93:7786';
const OFFICE_TOKEN = 'ea23ecc31eb999971ad460593a5e5b1f9d4dab9a0da92940037262285f666bbe';
const HOME_TOKEN   = '8727e858f500927c0dd54968a79d03247ee92aa042bf20a89ad7476f22431fa7';

const HARNESS_LOC = process.argv[2] || 'office';
const ROUNDS = 50;
const INTER_PROBE_DELAY_MS = 30;

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
      currentMarker = String.fromCharCode(97 + (round % 26));
      t0 = performance.now();
      ws.send(currentMarker);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ mode: 'active', browserId: 'latency-harness-' + label }));
      settleTimer = setTimeout(() => { attached = true; tryProbe(); }, 800);
    });

    ws.on('message', (data) => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = setTimeout(() => { attached = true; tryProbe(); }, 800); }
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
      if (samples.length < ROUNDS) {
        console.error('[' + label + '] closed early code=' + code + ' reason=' + (reason?.toString() || '') + ' samples=' + samples.length);
        resolve({ label, samples, stats: stats(samples), closed: { code } });
      }
    });

    setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.close(); }, 60000);
  });
}

(async () => {
  console.log('[harness] location=' + HARNESS_LOC);
  console.log('[setup] creating session on home shadow (remote)…');
  const createRes = await httpJson('POST', HOME + '/api/sessions', HOME_TOKEN, { cwd: 'C:\\dev', name: 'latency-probe-v2' });
  if (createRes.status !== 200) { console.error('create failed:', createRes); process.exit(1); }
  const sid = createRes.body.id;
  console.log('[setup] session id =', sid);
  await new Promise(r => setTimeout(r, 1500));

  // Fetch directUrl from shadow-office
  const clusterRes = await httpJson('GET', OFFICE + '/api/cluster/sessions', OFFICE_TOKEN);
  const ours = clusterRes.body.sessions.find(s => s.id === sid);
  if (!ours || !ours.directUrl) { console.error('no directUrl:', ours); process.exit(1); }
  console.log('[setup] directUrl =', ours.directUrl.substring(0, 90) + '...');

  const proxyUrl  = `ws://100.75.82.89:7784/cluster/${encodeURIComponent(HOME)}/ws/${sid}?token=${OFFICE_TOKEN}`;
  const directUrl = ours.directUrl;

  // Warm up: tiny TCP preconnect to both to avoid first-round DNS/TCP skew
  await new Promise(r => setTimeout(r, 500));

  console.log('\n[run] PROXY mode (harness → office-shadow → home-shadow over tailscale):');
  const proxy = await runProbe('proxy', proxyUrl);
  console.log('  stats:', proxy.stats);

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[run] DIRECT mode (harness → home-shadow over tailscale):');
  const direct = await runProbe('direct', directUrl);
  console.log('  stats:', direct.stats);

  console.log('\n=== comparison (harness at ' + HARNESS_LOC + ') ===');
  const ppx = proxy.stats, drx = direct.stats;
  if (ppx.p50 && drx.p50) {
    console.log('proxy.p50  =', ppx.p50, 'ms  |  direct.p50  =', drx.p50, 'ms  |  delta =', (parseFloat(ppx.p50) - parseFloat(drx.p50)).toFixed(2), 'ms');
    console.log('proxy.mean =', ppx.mean, 'ms  |  direct.mean =', drx.mean, 'ms  |  delta =', (parseFloat(ppx.mean) - parseFloat(drx.mean)).toFixed(2), 'ms');
    console.log('proxy.p99  =', ppx.p99, 'ms  |  direct.p99  =', drx.p99, 'ms  |  delta =', (parseFloat(ppx.p99) - parseFloat(drx.p99)).toFixed(2), 'ms');
  }

  await httpJson('DELETE', HOME + '/api/sessions/' + sid, HOME_TOKEN);
  console.log('\n[teardown] session deleted');
})();
