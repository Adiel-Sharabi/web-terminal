# Hot Reload — Design Doc

Goal: restart `web.js` (HTTP + WebSocket + auth + routes + cluster proxy) without killing PTY sessions.

## Architecture

Three processes supervised by `monitor.js`:

```
┌──────────────────────────────────────────┐
│ monitor.js (unchanged role, supervises)  │
└──────┬─────────────────────────┬─────────┘
       │ spawn                   │ spawn
       ▼                         ▼
┌──────────────┐  named pipe  ┌──────────┐
│ pty-worker.js├──────────────┤ web.js   │
│  (stateful)  │              │(stateless)│
└──────┬───────┘              └─────┬────┘
       │ PTYs                       │ HTTP/WS
       ▼                            ▼
   [node-pty]                   [browser]
```

**`pty-worker.js`** (new, rarely changes):
- Owns the `sessions` Map: PTY, scrollback buffer, status, timers
- Owns `sessions.json`, `scrollback/*.json` persistence
- Owns `claude-session-names.json`, `history.json`
- Listens on named pipe `\\.\pipe\web-terminal-pty`
- Accepts ONE client at a time (web.js); rejects others

**`web.js`** (renamed from server.js, changes often):
- HTTP routes, auth, cookies, bearer tokens
- Serves `app.html`, `sw.js`, etc.
- WebSocket `/ws/:id` — proxies to worker via IPC
- Cluster proxy `/cluster/…`
- Connects to worker's pipe on startup; retries with backoff
- On disconnect from worker: all clients disconnected, web.js exits (monitor restarts it)

**`monitor.js`** (modified):
- Spawns worker first, waits for pipe to be ready
- Spawns web.js
- Restarts either if it crashes
- Web.js restart is cheap (PTYs survive)
- Worker crash = full reload (PTYs die — no change from today)

## IPC Protocol — named pipe, length-prefixed binary framing

Each frame:
```
[4 bytes LE length][1 byte type][payload bytes]
```

Types:
- `0x00` — JSON control message (request, response, or event)
- `0x01` — PTY_OUT: `[16-byte session UUID][raw bytes]` — from worker
- `0x02` — PTY_IN: `[16-byte session UUID][raw bytes]` — from web

JSON control messages:
```json
// request:  { "id": 42, "method": "createSession", "params": {...} }
// response: { "id": 42, "result": {...} }
// error:    { "id": 42, "error": "..." }
// event:    { "event": "sessionExited", "params": {...} }  (no id)
```

### RPC methods (web → worker)
| Method | Params | Returns |
|--------|--------|---------|
| `ping` | — | `{ok:true, version}` |
| `listSessions` | — | `{sessions: [{id,name,cwd,status,...}]}` |
| `createSession` | `{cwd,name,autoCommand}` | `{id,name}` |
| `renameSession` | `{id,name}` | `{ok}` |
| `updateSession` | `{id, fields:{autoCommand?}}` | `{ok}` |
| `killSession` | `{id}` | `{ok}` |
| `attach` | `{id, scrollbackLimit}` | `{ok}` — then worker streams PTY_OUT frames for that session |
| `detach` | `{id}` | `{ok}` |
| `resize` | `{id, cols, rows}` | `{ok}` |
| `hook` | `{id, event}` | `{status}` |
| `getSession` | `{id}` | `{...}` |

### Events (worker → web)
| Event | Params |
|-------|--------|
| `sessionStatusChanged` | `{id, status}` |
| `sessionExited` | `{id, claudeSessionId?}` |
| `sessionCreated` | `{id,name,...}` |

### Data plane

When a browser WebSocket connects, web.js:
1. Sends `attach` RPC (worker replies with scrollback as PTY_OUT frames)
2. Forwards browser WS messages to worker as PTY_IN frames
3. Forwards worker PTY_OUT frames to browser WS

Multiple attachments for same session are allowed (worker keeps a set of "attached" markers; it streams each PTY_OUT to every attached web connection for that session). But since web.js is ONE process with many WS clients, web.js handles the fan-out to WS clients itself — worker just needs to know "session X is attached" for purposes of the exclusive viewer logic.

Actually, simpler: worker tracks attachment as a boolean per session; data flows to any attached state. Exclusive viewer logic (kick on new viewer) stays in web.js where browserId/mode messages arrive.

## What survives a web.js restart

| Thing | Survives? |
|-------|-----------|
| PTY process + shell state | ✅ |
| Scrollback buffer in memory | ✅ |
| Session status (active/working/idle) | ✅ |
| Claude session IDs | ✅ |
| Hook state | ✅ |
| Browser WebSocket connection | ❌ (auto-reconnects — ~1-2s blip) |
| In-flight HTTP request | ❌ |

The browser already handles WS drops with exponential backoff reconnect, and the scrollback replays from worker on reattach, so end-to-end, the user sees a brief "reconnecting" flash and then continues where they left off.

## Risk areas

1. **Named pipe backpressure** — if worker produces PTY output faster than web.js can forward to WS, need to handle. Mitigation: Node streams handle backpressure naturally.
2. **Worker startup before monitoring** — monitor must wait for pipe to be listening before starting web. Mitigation: worker writes a ready-file or signals via stdout, monitor waits.
3. **Scrollback persistence race** — worker is now the sole writer. No change from today (server.js was already sole writer).
4. **Test coverage** — need new tests: worker IPC, web-worker integration, hot reload end-to-end.
5. **Cluster proxy** — unchanged; it's in web.js. Remote cluster calls still work since web.js still handles them.
6. **Windows named pipes** — Node's `net.Server` with pipe path works on Windows. Confirmed via docs and existing examples.

## Phases (each phase: implement → test → show you → wait for approval to continue)

**Phase 1: IPC library**
- Create `lib/ipc.js` with framing encode/decode + server/client helpers
- Unit tests for framing (encode, decode, fragmented reads, large frames)
- **Deliverable:** `lib/ipc.js` + `tests/ipc.spec.js` all green

**Phase 2: Worker skeleton**
- Create `pty-worker.js` that listens on pipe, handles `ping`
- Tests: spawn worker process, connect, ping, shutdown
- **Deliverable:** `pty-worker.js` + `tests/worker-basic.spec.js` green

**Phase 3: Move session state to worker**
- Move `sessions` Map, scrollback, session CRUD methods to worker
- web.js exposes the same HTTP API but calls worker over IPC
- All existing API tests (api.spec.js) must still pass
- **Deliverable:** refactored server.js (now web.js) + updated pty-worker.js; 100 tests still pass

**Phase 4: WS data plane through worker**
- WebSocket handler in web.js uses IPC PTY_IN/OUT frames to talk to worker
- Exclusive-viewer tests must still pass
- **Deliverable:** all 100 tests pass, including exclusive-viewer, keep-sessions-open, mobile-swiftkey, mobile-resize

**Phase 5: Monitor supervises both**
- `monitor.js` starts worker first, waits for ready, then starts web.js
- Independent restart of web.js on crash; worker restart triggers full web.js restart too
- **Deliverable:** updated monitor + test that kills web.js and verifies worker keeps running

**Phase 6: Hot reload test**
- Playwright test: create session, run command, send SIGTERM to web.js, verify PTY still running in worker, restart web.js, verify browser reconnects and sees prior output
- **Deliverable:** `tests/hot-reload.spec.js` passes

**Phase 7: Ready for manual testing on this machine**
- You verify it locally on Office before merging to master
- Then decide when to deploy to other servers

## Files changed / added

| File | Change |
|------|--------|
| `lib/ipc.js` | new — framing + server/client helpers |
| `pty-worker.js` | new — PTY state owner |
| `server.js` → stays, shrinks significantly (or renamed to `web.js` — TBD) | |
| `monitor.js` | supervises 2 processes instead of 1 |
| `start-server.vbs` | unchanged (still launches monitor) |
| `tests/ipc.spec.js` | new |
| `tests/worker-basic.spec.js` | new |
| `tests/hot-reload.spec.js` | new |
| `tests/*.spec.js` (existing) | unchanged — they test web.js API, which is unchanged from the outside |

## Not doing in this pass

- Worker hot reload (if worker code changes, must restart everything — out of scope)
- Multiple-worker architecture (one worker per N sessions for scaling) — future
- Cross-machine session migration — different problem, different issue
