# Troubleshooting & Dev Tooling

## Troubleshooting

- **`crypto.randomUUID is not a function`** — triggered when loading the app over plain HTTP on a LAN/Tailscale IP, because `window.crypto.randomUUID` is only exposed in secure contexts. The client polyfills it automatically; if you still hit this, make sure your browser has loaded the latest `app.html` (force-refresh past the service worker).
- **Dual-monitor crash loop with the console flashing** — caused by `taskkill /F /IM node.exe` races. Follow the manual-restart procedure in the [Production Setup](INSTALL.md#production-setup) section and kill the monitor + worker + server PIDs explicitly.
- **A worker-side fix was deployed and nothing changed** — a hot reload restarts only `server.js` and *deliberately* leaves `pty-worker.js` running, which is what keeps your sessions alive across an upgrade. The cost is that the two halves version independently: anything living in the worker (submit timing, agent readiness, status hooks) stays on the old code until a **cold** restart, while `/api/version`'s `version` happily reports the new server. Compare it against the `worker` field in the same response — that is the version of the worker *actually attached*, not the one on disk. If it is behind the `WORKER_VERSION` in **that same server's own** `pty-worker.js`, its worker is stale and the feature is inert there. Comparing a remote peer's `worker` against *your* checkout proves nothing: a cluster is routinely mid-upgrade, so the peer may simply be on a different commit. A missing `worker` field means the server predates 1.72.0.
- **`conpty_console_list_agent.js: AttachConsole failed`** in test output — harmless node-pty warning when killing sessions in Session 0 / test environments.
- **CLI tools missing in spawned shells after auto-start** — Session 0 scheduled tasks can have a stale PATH. Kill node and run `wscript start-server.vbs` from your logged-in user session to refresh it.

## Dev Tooling

All of these are opt-in; none run by default in production.

- **`WT_LATENCY_DEBUG=1`** — enables an event-loop lag monitor (logs every stall >50 ms) and a slow-op wrapper (logs any PTY write / frame decode / scrollback save >30 ms) in both `server.js` and `pty-worker.js`.
- **`?rtt=1` query string** — append to the app URL (e.g. `https://host/app?rtt=1`) to render a small per-keystroke round-trip-time overlay in the browser. Measures time from `keydown` to the corresponding byte echoing back from the PTY.
- **`scripts/typing-probe.js`** — headless typing probe; opens a session, types characters, records round-trip times. Useful for reproducing typing-stall bugs without a browser.
- **`scripts/latency-harness.js` / `scripts/latency-harness-v2.js`** — WebSocket round-trip measurement tools. Compare proxy vs. direct terminal mode, or two servers against each other.
- **`scripts/check-deps.js`** — loads the modules the worker and web genuinely need (`node-pty`, `express`, `express-ws`) and exits non-zero if any cannot. `scripts/cold-restart.ps1` runs it **before** killing anything and aborts on failure, because restarting a box whose `node_modules` is damaged replaces a server that is still serving from memory with a worker that cannot start at all — the monitor then burns its crash budget and exits, so a wedged box becomes a dead one. `scripts/cold-restart.ps1 -CheckOnly` runs just the check and kills nothing, which is the safe way to audit a peer over `/api/exec`.
  - **Never junction or symlink `node_modules` into a git worktree.** `rmdir /s`, `Remove-Item -Recurse` and `git worktree remove --force` all follow a directory junction and delete the *target* — this is what damaged production on 2026-07-30. Give the worktree its own copy, or invoke the real path (`node ../../node_modules/@playwright/test/cli.js`). If a junction already exists, remove the **link** first with bare `cmd /c rmdir <link>` (no `/s`).

The smoke tests (`smoke-test-hot-reload.js`, `smoke-test-longproc.js`) at the repo root exercise the monitor <-> worker <-> server hot-reload path end-to-end.
