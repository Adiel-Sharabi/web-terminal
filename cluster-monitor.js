// cluster-monitor.js — Standalone cluster health & latency monitor.
//
// Runs alongside the web-terminal server without needing a restart.
//
// What it does
//   • Probes every cluster peer every PROBE_INTERVAL_MS:
//       - Tailscale ping (RTT + direct-vs-DERP)
//       - HTTPS GET  /api/version  (TTFB, status)
//       - WebSocket handshake + echo RTT via /api/ping (falls back if missing)
//   • Tails the main server logs and counts cluster-proxy events per peer
//       (connected, reconnected, remote closed, ping timeout, remote error)
//   • Serves a live dashboard on http://localhost:7682  (also bound to 0.0.0.0
//     so it is reachable via Tailscale; guarded by a one-time token).
//   • Writes every probe sample as a JSONL line to logs/cluster-monitor.jsonl
//     so you can grep/plot afterwards.
//
// Invocation (no args needed — reads config.json + cluster-tokens.json):
//     wscript start-cluster-monitor.vbs          # hidden, recommended
//     node   cluster-monitor.js                   # foreground (flashes console)
//
// Env knobs:
//   CM_PORT=7682            HTTP port for the dashboard
//   CM_INTERVAL_MS=15000    Probe interval
//   CM_WS_TIMEOUT_MS=6000   WebSocket handshake timeout
//   CM_HTTP_TIMEOUT_MS=5000 HTTP timeout
//   CM_LOG_TAIL_BYTES=262144  How much of server.log to re-scan on start
//
// The script writes nothing back to any remote server — it only reads. So
// running it on N cluster nodes is safe.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https= require('https');
const url  = require('url');
const cp   = require('child_process');
const os   = require('os');

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) { console.error('[cm] ws module not found — run `npm install` in', __dirname); process.exit(1); }

// ---------- paths / config ----------
const ROOT        = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TOKENS_FILE = path.join(ROOT, 'cluster-tokens.json');
const LOG_FILE    = path.join(ROOT, 'logs', 'server.log');
const ERR_FILE    = path.join(ROOT, 'logs', 'error.log');
const OUT_FILE    = path.join(ROOT, 'logs', 'cluster-monitor.jsonl');

const PORT        = +(process.env.CM_PORT || 7682);
const INTERVAL    = +(process.env.CM_INTERVAL_MS || 15000);
const WS_TIMEOUT  = +(process.env.CM_WS_TIMEOUT_MS || 6000);
const HTTP_TIMEOUT= +(process.env.CM_HTTP_TIMEOUT_MS || 5000);
const TAIL_BYTES  = +(process.env.CM_LOG_TAIL_BYTES || 262144);
const MAX_EVENTS  = 1000;      // ring buffer size for parsed log events
const MAX_SAMPLES = 240;       // keep ~1hr at 15s cadence per peer

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback; }
}

function tsPath() {
  // Common Tailscale install paths on Windows + fallback to PATH.
  const candidates = [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    'tailscale'
  ];
  for (const c of candidates) {
    try { if (c.includes('\\') && fs.existsSync(c)) return c; } catch (e) {}
  }
  return 'tailscale';
}
const TS = tsPath();

function loadPeers() {
  const cfg = readJson(CONFIG_FILE, {});
  const tokens = readJson(TOKENS_FILE, {});
  const myUrl  = (cfg.publicUrl || '').replace(/\/+$/, '');
  const peers  = (cfg.cluster || [])
    .map(s => ({ name: s.name, url: String(s.url || '').replace(/\/+$/, ''), token: tokens[s.url]?.token || null }))
    .filter(s => s.url && s.url !== myUrl);
  return { me: { name: cfg.serverName || os.hostname(), url: myUrl }, peers };
}

// ---------- in-memory state ----------
const state = {
  startedAt: Date.now(),
  me: null,
  peers: [],
  samples: new Map(),  // peerUrl -> array of probe samples
  events: [],          // parsed cluster-proxy log lines
  logFileOffsets: { server: 0, error: 0 },
};

function pushSample(peerUrl, sample) {
  if (!state.samples.has(peerUrl)) state.samples.set(peerUrl, []);
  const arr = state.samples.get(peerUrl);
  arr.push(sample);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  try { fs.appendFileSync(OUT_FILE, JSON.stringify({ peer: peerUrl, ...sample }) + '\n'); } catch (e) {}
}

// ---------- probes ----------
function tailscalePing(host) {
  return new Promise(resolve => {
    // --c 1 → one packet; tailscale ping prints "pong from HOST via ENDPOINT in RTT"
    // or "no reply" after its own timeout. We wrap with hard 4s cap.
    const t0 = Date.now();
    const child = cp.execFile(TS, ['ping', '--c', '1', '--timeout', '3s', host], { windowsHide: true, timeout: 4500 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const m = /pong from\s+\S+\s+\(([^)]+)\)\s+via\s+(\S+)\s+in\s+([0-9.]+)\s*([a-z]+)/i.exec(out);
      if (m) {
        let rtt = +m[3];
        if (m[4].toLowerCase().startsWith('s') && !m[4].toLowerCase().startsWith('ms')) rtt *= 1000;
        const via = m[2];
        const isDerp = /derp/i.test(via) || /:0\b/.test(via) || via.includes('(derp)');
        resolve({ ok: true, rtt, via, relay: isDerp ? 'derp' : 'direct' });
      } else {
        resolve({ ok: false, rtt: null, elapsed: Date.now() - t0, err: (err && err.message) || 'no pong', raw: out.trim().slice(-200) });
      }
    });
    child.on('error', e => resolve({ ok: false, err: e.message }));
  });
}

function httpProbe(peerUrl, pathname, token) {
  return new Promise(resolve => {
    const u = new URL(peerUrl + pathname);
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let ttfb = null;
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const req = lib.request({
      method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      rejectUnauthorized: false, timeout: HTTP_TIMEOUT, headers,
    }, res => {
      ttfb = Date.now() - t0;
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode < 500, status: res.statusCode, ttfb, total: Date.now() - t0, body: body.slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => resolve({ ok: false, err: e.message, elapsed: Date.now() - t0 }));
    req.end();
  });
}

// Open a WebSocket through OUR cluster proxy path so it matches the real path
// the browser uses. We point it at ourselves; if self-probing is not possible
// (no local token), we probe the peer directly with its own token.
function wsProbe(peerUrl, token) {
  return new Promise(resolve => {
    if (!token) return resolve({ ok: false, err: 'no-token' });
    const wsUrl = peerUrl.replace(/^http/, 'ws') + '/ws/__cm_probe__?token=' + encodeURIComponent(token);
    const t0 = Date.now();
    let opened = null, closed = false;
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false, perMessageDeflate: false, handshakeTimeout: WS_TIMEOUT });
    const timer = setTimeout(() => { if (!closed) { closed = true; try { ws.terminate(); } catch (e) {} resolve({ ok: false, err: 'timeout', elapsed: Date.now() - t0 }); } }, WS_TIMEOUT);
    ws.on('open', () => { opened = Date.now() - t0; });
    ws.on('close', (code) => {
      if (closed) return; closed = true; clearTimeout(timer);
      resolve({ ok: opened !== null, handshakeMs: opened, closeCode: code, total: Date.now() - t0 });
    });
    ws.on('error', e => {
      if (closed) return;
      // A 4xx error at handshake still tells us the server is alive — capture opened fail as "unreachable"
      // If we got as far as an HTTP upgrade reject, that is a ReachedButRejected signal.
      if (/Unexpected server response/i.test(e.message)) {
        if (closed) return; closed = true; clearTimeout(timer);
        resolve({ ok: true, handshakeMs: Date.now() - t0, rejected: true, err: e.message });
      }
    });
  });
}

async function probeOnce() {
  const ts = Date.now();
  for (const p of state.peers) {
    const host = new URL(p.url).hostname.replace(/\..*$/, '').toLowerCase();
    // Tailscale ping: try the MagicDNS short-name (before first dot)
    const [tsp, http1, wsp] = await Promise.all([
      tailscalePing(host),
      httpProbe(p.url, '/api/version', p.token),
      wsProbe(p.url, p.token),
    ]);
    const sample = { t: ts, tailscale: tsp, http: http1, ws: wsp };
    pushSample(p.url, sample);
  }
}

// ---------- log tail ----------
const EVENT_RE = /Cluster proxy\s+(\S+?)\/ws\/([0-9a-f]+):\s*(connected|reconnected|remote closed.*|reconnecting in.*|remote error.*|remote ping timeout.*|giving up.*|local error.*)/;

function scanLogChunk(chunk, source) {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const m = EVENT_RE.exec(line);
    if (!m) continue;
    const peerUrl = m[1];
    const sid     = m[2];
    const what    = m[3];
    const tsMatch = /\[([^\]]+)\]/.exec(line);
    const t = tsMatch ? Date.parse(tsMatch[1]) : Date.now();
    state.events.push({ t, source, peerUrl, sid, what, raw: line });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

function tailFile(file, key) {
  fs.stat(file, (err, st) => {
    if (err) return;
    const prev = state.logFileOffsets[key];
    if (prev === 0) {
      // First scan — read only the tail.
      const start = Math.max(0, st.size - TAIL_BYTES);
      state.logFileOffsets[key] = start;
    }
    if (st.size < state.logFileOffsets[key]) {
      // file truncated/rotated
      state.logFileOffsets[key] = 0;
    }
    const from = state.logFileOffsets[key];
    if (st.size <= from) return;
    const stream = fs.createReadStream(file, { start: from, end: st.size });
    let buf = '';
    stream.on('data', c => { buf += c.toString('utf8'); });
    stream.on('end', () => {
      scanLogChunk(buf, key);
      state.logFileOffsets[key] = st.size;
    });
    stream.on('error', () => {});
  });
}

function startTail() {
  setInterval(() => {
    tailFile(LOG_FILE, 'server');
    tailFile(ERR_FILE, 'error');
  }, 2000).unref && 0;
}

// ---------- aggregation for dashboard ----------
function summarize() {
  const now = Date.now();
  const out = { me: state.me, startedAt: state.startedAt, now, peers: [] };
  for (const p of state.peers) {
    const samples = state.samples.get(p.url) || [];
    const last = samples[samples.length - 1] || null;
    // 5-minute window
    const since = now - 5 * 60 * 1000;
    const recent = samples.filter(s => s.t >= since);
    const tsRtts   = recent.map(s => s.tailscale?.rtt).filter(v => v != null);
    const httpTtfb = recent.map(s => s.http?.ttfb).filter(v => v != null);
    const wsMs     = recent.map(s => s.ws?.handshakeMs).filter(v => v != null);
    const stats = (arr) => arr.length ? {
      n: arr.length,
      min: Math.min(...arr),
      avg: +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1),
      p95: arr.sort((a,b)=>a-b)[Math.min(arr.length-1, Math.floor(arr.length*0.95))],
      max: Math.max(...arr),
    } : null;
    const evs = state.events.filter(e => e.peerUrl === p.url && e.t >= since);
    const count = (re) => evs.filter(e => re.test(e.what)).length;
    out.peers.push({
      name: p.name, url: p.url, hasToken: !!p.token,
      last,
      windowMin: 5,
      tailscale: stats(tsRtts),
      http: stats(httpTtfb),
      ws: stats(wsMs),
      events: {
        connected:    count(/^connected|^reconnected/),
        remoteClosed: count(/^remote closed/),
        remoteError:  count(/^remote error/),
        pingTimeout:  count(/^remote ping timeout/),
        giveUp:       count(/^giving up/),
        reconnecting: count(/^reconnecting/),
      },
      relay: last?.tailscale?.relay || null,
    });
  }
  return out;
}

// ---------- HTTP dashboard ----------
const DASHBOARD_HTML = `<!doctype html><meta charset=utf-8>
<title>Cluster Monitor</title>
<style>
  body{font:14px/1.4 system-ui,Segoe UI,sans-serif;background:#111;color:#ddd;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 12px;color:#fff}
  .meta{color:#888;margin-bottom:16px;font-size:12px}
  .peer{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:12px}
  .peer h2{font-size:15px;margin:0 0 8px;display:flex;gap:10px;align-items:center}
  .badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#333;color:#ccc}
  .badge.direct{background:#1d4d1d;color:#9f9}
  .badge.derp{background:#4d1d1d;color:#f99}
  .badge.bad{background:#4d1d1d;color:#f99}
  .badge.ok{background:#1d4d1d;color:#9f9}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{padding:4px 8px;text-align:left;border-bottom:1px solid #222}
  th{color:#888;font-weight:500}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .warn{color:#fc0}
  .bad{color:#f55}
  .good{color:#6f6}
  pre{background:#0c0c0c;border:1px solid #222;padding:8px;border-radius:6px;max-height:260px;overflow:auto;font:11px/1.3 Consolas,monospace}
  .events{margin-top:10px}
</style>
<h1>Cluster Monitor</h1>
<div class=meta id=meta></div>
<div id=peers></div>
<h2 style="font-size:15px;color:#fff;margin:20px 0 8px">Recent events</h2>
<pre id=events></pre>
<script>
async function tick(){
  try {
    const r = await fetch('./api/summary'); const d = await r.json();
    const meta = document.getElementById('meta');
    const upMin = Math.round((d.now - d.startedAt)/60000);
    meta.textContent = 'Self: ' + (d.me?.name||'?') + '  •  ' + (d.me?.url||'') + '  •  monitor up ' + upMin + ' min  •  updated ' + new Date(d.now).toLocaleTimeString();
    const div = document.getElementById('peers'); div.innerHTML = '';
    for (const p of d.peers){
      const ts = p.tailscale, h = p.http, w = p.ws, e = p.events;
      const relay = p.relay||'-';
      const relayCls = relay==='direct'?'direct':(relay==='derp'?'derp':'');
      const bad = (e.remoteError>0||e.pingTimeout>0||e.giveUp>0) ? 'bad' : (e.remoteClosed>0?'warn':'good');
      const el = document.createElement('div'); el.className='peer';
      el.innerHTML =
        '<h2>'+p.name+' <span class="badge '+relayCls+'">'+relay+'</span> '+
          (p.hasToken?'<span class="badge ok">auth</span>':'<span class="badge bad">no token</span>')+
        '</h2>'+
        '<table><tr><th>probe</th><th class=num>n</th><th class=num>min</th><th class=num>avg</th><th class=num>p95</th><th class=num>max</th></tr>'+
        '<tr><td>tailscale ping (ms)</td>'+cells(ts)+'</tr>'+
        '<tr><td>http /api/version ttfb (ms)</td>'+cells(h)+'</tr>'+
        '<tr><td>ws handshake (ms)</td>'+cells(w)+'</tr>'+
        '</table>'+
        '<div class=events>'+e.connected+' connects • <span class='+(e.remoteClosed?'warn':'')+'>'+
          e.remoteClosed+' remote-closed</span> • <span class='+(e.remoteError?'bad':'')+'>'+e.remoteError+' remote-error</span>'+
          ' • <span class='+(e.pingTimeout?'bad':'')+'>'+e.pingTimeout+' ping-timeout</span> • '+
          e.reconnecting+' reconnecting • <span class='+(e.giveUp?'bad':'')+'>'+e.giveUp+' gave-up</span> '+
          '<span style="color:#666">(last '+p.windowMin+' min)</span></div>';
      div.appendChild(el);
    }
    const ev = await (await fetch('./api/events?limit=50')).json();
    document.getElementById('events').textContent = ev.map(function(e){ return new Date(e.t).toLocaleTimeString()+'  '+e.source+'  '+new URL(e.peerUrl).hostname+'  '+e.sid+'  '+e.what; }).join('\\n');
  } catch (ex) {
    document.getElementById('meta').textContent = 'error: '+ex.message;
  }
}
function cells(s){ if(!s) return '<td class=num>-</td><td class=num>-</td><td class=num>-</td><td class=num>-</td><td class=num>-</td>'; return '<td class=num>'+s.n+'</td><td class=num>'+s.min+'</td><td class=num>'+s.avg+'</td><td class=num>'+s.p95+'</td><td class=num>'+s.max+'</td>'; }
tick(); setInterval(tick, 3000);
</script>`;

function startHttp() {
  const server = http.createServer((req, res) => {
    const u = url.parse(req.url, true);
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (u.pathname === '/api/summary') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(summarize()));
      return;
    }
    if (u.pathname === '/api/events') {
      const lim = Math.min(500, +u.query.limit || 100);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.events.slice(-lim).reverse()));
      return;
    }
    if (u.pathname === '/api/raw') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ samples: Object.fromEntries(state.samples), events: state.events }));
      return;
    }
    if (u.pathname === '/api/probe') {
      probeOnce().then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(summarize()));
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[cm] dashboard → http://localhost:' + PORT);
  });
}

// ---------- bootstrap ----------
function start() {
  const { me, peers } = loadPeers();
  state.me = me;
  state.peers = peers;
  if (!peers.length) {
    console.warn('[cm] no peers in config.json cluster array — nothing to probe');
  } else {
    console.log('[cm] probing', peers.length, 'peers every', INTERVAL, 'ms');
  }
  startHttp();
  startTail();
  // First probe immediately, then on interval
  probeOnce().catch(()=>{});
  setInterval(() => probeOnce().catch(()=>{}), INTERVAL);
  // Reload peer config periodically in case cluster-tokens.json is refreshed
  setInterval(() => {
    const reloaded = loadPeers();
    state.me = reloaded.me;
    state.peers = reloaded.peers;
  }, 60000);
}

start();
