# Multi-Server Cluster

Running Web Terminal on several machines and driving them from one sidebar.


1. **Set Public URL** on each server (Settings → Public URL)
2. **Add a remote server** on any one server (Settings → Cluster → Add)
3. **Login to remote** — click Login next to the server in the sidebar
4. **Done** — both servers auto-discover each other. Repeat for more servers.

Each server keeps its own credentials. Inter-server auth uses API tokens (90-day expiry). By default all traffic proxies through your connected server — no CORS issues.

## Server Load (#152)

Every server samples its own CPU utilisation and memory and shows both next to its
name in the sidebar — `CPU 18% · MEM 62% (39.5G/63.8G)` — so you can decide where to
start a session or which box is under load, without RDP-ing in.

CPU is a rolling average over a 5-second window, computed from the delta between two
`os.cpus()` tick samples (a single instantaneous read would be noise, and Windows'
`os.loadavg()` always reports `0` so it isn't used). A peer that is too old to report
this, or one that times out during the sidebar's cluster fetch, shows nothing for that
server — never a fabricated `0%`, which would otherwise steer you toward a server that
simply didn't answer in time.

This is the per-server slice only. Per-session CPU/RAM attribution and web-terminal's
own aggregate footprint (`monitor.js` + `pty-worker.js` + `server.js` and their PTY
children) are tracked separately and not shown yet.

## Direct Terminal Mode (Optional)

Set `"directConnect": true` on a peer entry in `cluster` to skip the local server's proxy hop for that peer's sessions. The browser WebSocket connects straight to the peer using a short-lived (60 s) HMAC-signed token minted by your local server. Saves one network hop of latency when your browser already has direct network reachability to the peer.

```json
"cluster": [
  { "name": "Home", "url": "https://home.example:7681", "directConnect": true },
  { "name": "XPS",  "url": "https://xps.example:7681" }
]
```

The signing key is the bearer token you already share with the peer (stored in `cluster-tokens.json` locally and `api-tokens.json` on the peer). Disabled by default; the legacy proxy path is always available as fallback.
