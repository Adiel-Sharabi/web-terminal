# Cluster Monitor

A read-only / probe-only sidecar that runs next to `server.js`. It never
restarts the main terminal server and never modifies remote state — it
only reads logs and probes cluster peers with the tokens already present
in `cluster-tokens.json`.

## What it measures

For every peer in `config.json → cluster[]`:

| Probe | What it actually times | Why it matters |
|---|---|---|
| `tailscale ping --c 1` | ICMP-like RTT at the Tailscale layer; also reports `direct` vs `derp` relay | Tells you if the Tailscale network itself is healthy and which path it's using |
| HTTPS `GET /api/version` | Full TCP+TLS handshake + first response byte | Matches what the browser pays when it opens a cluster API call |
| WebSocket open + close | TCP+TLS+HTTP upgrade handshake | Matches what the browser pays when switching/opening a session |

For every line in `logs/server.log` + `logs/error.log` matching the
`Cluster proxy …/ws/<id>: <event>` format, it counts per-peer:

- `connected` / `reconnected`
- `remote closed (code)`
- `remote error …` (this is the one that lit up in your outage)
- `remote ping timeout` (proxy force-reconnect)
- `reconnecting in …ms (attempt N)`
- `giving up after N attempts`

All probe samples are also appended to `logs/cluster-monitor.jsonl` so
you can grep/plot them later.

## Run it (Home server)

Already started:

```
wscript start-cluster-monitor.vbs        # hidden, no console window
```

Dashboard: <http://localhost:7682>
JSON:      <http://localhost:7682/api/summary>
Events:    <http://localhost:7682/api/events?limit=200>

Stop it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object CommandLine -match 'cluster-monitor' |
  Stop-Process -Force
```

## Deploy on Adiel-Xps and Office

Copy two files into the peer's web-terminal directory:

- `cluster-monitor.js`
- `start-cluster-monitor.vbs`

Then launch it hidden on the peer:

```
wscript start-cluster-monitor.vbs
```

Each peer's dashboard will be on `http://<peer>:7682`, reachable over
Tailscale (`http://adiel-xps:7682`, `http://adiel-0ffice:7682`).

Ways to get the files across without restarting the server:

1. **Through the web-terminal itself** — open a session on each peer
   and paste the contents via the browser terminal (`cat > cluster-monitor.js`).
2. **Robocopy over Tailscale SMB** — if file sharing is enabled.
3. **Tailscale `tailscale file cp`** — one-shot file push.

No `npm install` is needed: the script uses only built-ins and the `ws`
package that the server already has installed.

## Initial findings (local Home server, first ~1 min of probes)

These are the data points already captured — they explain both symptoms
you described.

### 1. Disconnect storm to Adiel-Xps was a real connectivity outage

`logs/error.log` has 672 `Cluster proxy … remote error: connect ETIMEDOUT
100.67.238.93:443` events between 21:54:37Z and 22:14:58Z on
2026-04-18 — ~20 minutes of total unreachability on XPS's Tailscale
address, spread across two live sessions (`55c85885`, `b0fdb722`).

The proxy behaved correctly: exponential back-off, 10 attempts, give up,
client reconnects, new proxy session, repeat. That's why the browser
sees a "reconnecting…" overlay flashing in a loop — the work is all on
the Home→XPS hop, not on the browser→Home hop.

### 2. Input-hiccup cause: XPS Tailscale path is unstable even when "direct"

Four consecutive 15 s probes against `adiel-xps` (MagicDNS → LAN IP
`192.168.68.66`, reported as `direct`):

| sample | tailscale ping | HTTP TTFB | WS handshake |
|---|---|---|---|
| t+0s | **1 ms** | 854 ms | 830 ms |
| t+15s | 228 ms | 296 ms | 295 ms |
| (after probe auth fix) | | | |
| t+0s | **631 ms** | 2575 ms | 2551 ms |

1 ms → 228 ms → 631 ms on a LAN-resolved peer means the Tailscale direct
tunnel is rebuilding or flapping. Every time it flaps, in-flight PTY
bytes stall, the proxy's 20 s ping can miss a pong, and the proxy
force-reconnects. Each reconnect in turn triggers a fresh TCP + TLS
handshake — which is why a single flap costs ~1–2.5 s of visible
"frozen input."

Office, for contrast, is stable at ~22 ms Tailscale / ~350 ms HTTP TTFB
on the same probes. Its HTTP TTFB is still ~15× its ICMP RTT because
every probe re-does TCP + TLS (no HTTP keep-alive), but the values are
consistent.

### 3. HTTP/WS TTFB is consistently a big multiple of Tailscale RTT

Even on Office (22 ms ping), a cold TCP+TLS handshake is 300–1200 ms.
That's normal for one-shot HTTPS, but it means **the cost of every
reconnect is dominated by the handshake, not by the network RTT**.
Reducing reconnect frequency is worth far more than shaving RTT.

## What the monitor will confirm once it runs on all three nodes

- Whether Office and XPS see the same latency/flapping to Home and to
  each other, or only Home→XPS is bad.
- Whether `relay=direct` actually matches reality (if one side switches
  to DERP mid-stream, the `via` field will change).
- Whether the reconnect storm is symmetric (if it is, it's network; if
  only Home sees it, it's a Home-side routing issue).
- How often `remote ping timeout` fires vs `remote error` — distinguishes
  a "slow, still alive" connection from a genuinely broken one.

## Candidate fixes — do NOT apply without restart approval

From the data above, the highest-leverage changes would be:

1. **Lengthen the proxy ping grace window.** Currently ping every 20 s,
   force-reconnect if no pong in the next 20 s. A single 1-2 s network
   stall won't hurt, but a 5-10 s stall under load will. Increase to
   45-60 s grace, or count two consecutive misses.
   (`server.js:1312-1325`)
2. **Keep a warm proxy connection per peer, reuse across sessions.** The
   HTTP TTFB numbers show 300-2500 ms wasted per reconnect on handshake.
   A persistent outbound WebSocket multiplexer would amortize this.
3. **Detect DERP fallback and surface it in the UI.** Users currently
   can't tell the difference between "my connection is slow" and "the
   peer is unreachable and we're retrying." Expose the `relay` field.
4. **Client-side jitter buffer / local echo for keystrokes.** For proxied
   sessions, echo typed characters locally and reconcile with server
   output. This hides sub-second hiccups completely.

None of these are applied. They all require a server restart to take
effect, which per your instruction we are not doing.
