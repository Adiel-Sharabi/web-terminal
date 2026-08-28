# Multi-Server Cluster

Running Web Terminal on several machines and driving them from one sidebar.


1. **Set Public URL** on each server (Settings → Public URL)
2. **Add a remote server** on any one server (Settings → Cluster → Add)
3. **Login to remote** — click Login next to the server in the sidebar
4. **Done** — both servers auto-discover each other. Repeat for more servers.

Each server keeps its own credentials. Inter-server auth uses API tokens (90-day expiry). By default all traffic proxies through your connected server — no CORS issues.

## Server Load (#152)

Every server samples its own CPU utilisation and memory and shows both next to its
name in the sidebar — `CPU 18% · MEM 12.7G free of 31.7G (60%)` — so you can decide
where to start a session or which box is under load, without RDP-ing in.

**The memory reading leads with the room left, not the percentage used (#165).** A
percentage saturates exactly where the choice matters: a fleet box read `92%` while it
was effectively unusable at 0.65 GB available, and 92% → 98% is only six points while
the headroom underneath falls from 2.5 GB to 0.65 GB. The percentage is kept as
context — it is still the right reading below ~90% — but the colour keys on the
**absolute** figure (provisional: amber under 4 GB, red under 2 GB), because 98% on a
small box is unusable while 98% on a very large one still has room to work. Free
memory is `os.freemem()`, which on Windows *is* Available, so it costs nothing and
rides the same 5s sampler as CPU. A peer too old to report it falls back to the
percentage rather than showing a fabricated `0.0G free`.

Switching the load view on adds the box's **paging rate** (`paging 951/s`) — hard page
reads per second, the signal that separates 92%-and-coping from 92%-and-thrashing. It
is behind the switch because it needs a CIM counter, which is folded into the process
query that view already runs (marginal cost ~35 ms, against ~2.4 s for the same counter
queried on its own). A rate that could not be measured renders as nothing at all, never
`0/s` — zero is what a healthy box reads.

**Headroom is visible with the load view off, on both clients (#165).** The server reports
it either way — it rides the always-on 5s sampler and costs nothing — and both the web
sidebar and the companion show it regardless of the switch. That used to be a companion-only
gap: `ServerResourceLine` read exclusively from `ResourceMonitor`'s `GET /api/resources`
poll, which only runs while the load view is on, so the machine line went blank with it.

**The fix is a second, free source, not a change to what the switch gates.** The
companion talks to every server directly rather than through a merged cluster envelope
(`SessionRepository` calls each server's own `/api/sessions` and `/api/version`, never
`GET /api/cluster/sessions`), and `GET /api/version` already carries the same
`resources: _resourceSampler.read()` block the cluster merge does — for free, off the
warm sampler, at no extra endpoint. `SessionRepository` now publishes that reading into
`ResourceMonitor` (throttled to at most one `/api/version` per server every 10s, never
the process-tree query — `refresh()` is NOT a 30s thing, it is also debounced at 300ms
off every notify frame, so an unthrottled re-fetch would cost N round trips per burst and
queue the session list behind the slowest peer), and
`ServerResourceLine` reads it whenever the load view's own `GET /api/resources` report
is absent. The switch still gates exactly what it always did: paging and web-terminal's
own footprint, both of which need the per-process query below.

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
