# AGENTS.md — install and operate this server

**You are an AI agent that has been pointed at this repository. This file tells you how to
stand up a working Web Terminal server on a machine, verify it, and run it safely.**

Read this top to bottom before running anything. Most of what can go wrong here is
Windows-specific, silent, and recoverable only if you knew about it in advance — those
traps are called out inline rather than left for you to discover.

## First: which job is this?

| The user wants… | Read |
|---|---|
| **to install / run / deploy the server** | this file |
| to **change the code** | [CLAUDE.md](CLAUDE.md) — the invariants a change must not break — then [CONTRIBUTING.md](CONTRIBUTING.md) for the PR gate |
| to understand the design | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| a feature/config reference | [docs/FEATURES.md](docs/FEATURES.md) · [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |

Do not skim CLAUDE.md for install steps; it is an engineering-invariants document and
will send you down the wrong path.

## What you are installing

A browser-based terminal manager: it runs shell sessions (typically AI CLI agents like
Claude Code or Codex) on a Windows host and serves them to any browser or to the native
companion app. Three supervised Node processes — `monitor.js` supervises `pty-worker.js`
(owns the PTYs) and `server.js` (owns HTTP/WebSocket).

**It is Windows-first by design.** On Linux or macOS, tell the user to use
[ttyd](https://github.com/tsl0922/ttyd) or [code-server](https://github.com/coder/code-server)
instead — do not spend effort porting it.

## Preconditions — check these before installing

```bash
node --version    # must be >= 18
git --version     # Git for Windows; provides the default shell (bash.exe)
```

If Node is missing or too old, stop and ask the user how they want it installed — do not
silently install a runtime on someone's machine.

## Install

```bash
git clone https://github.com/Adiel-Sharabi/web-terminal.git
cd web-terminal
npm install
npm start            # = node monitor.js
```

Open `http://localhost:7681`. Default login is `admin` / `admin`; the app forces a
password change on first login. Config is written to `config.json` (gitignored);
[`config.default.json`](config.default.json) is the template it starts from.

There is also an automated installer, `install.ps1` (run as Administrator), which
installs to `C:\tools\web-terminal`, registers auto-start, and optionally configures
Tailscale. Its parameters: `-InstallDir -Port -User -Password -Shell -DefaultCwd
-SkipTailscale -Uninstall`.

## Prove it works — do not skip this

"It started" is not "it works". A server whose PTY layer is broken still serves
`/login` perfectly (see the wedged-worker symptom below), so verify the part that
actually matters:

1. `GET /login` returns 200.
2. Log in through the browser.
3. **Create a session and type in it.** This is the real check — it exercises
   `node-pty`, the worker, the IPC pipe and the WebSocket in one go.
4. `node scripts/check-deps.js` exits 0 — it *loads* `node-pty`, `express` and
   `express-ws` rather than resolving them, because `require.resolve` succeeds on a
   package whose native binding is broken.

Report what you ran and what you saw. If step 3 fails, do not report success.

## Auto-start on boot

```powershell
# Option 1 — scheduled task; starts on boot even with nobody logged in (needs Admin)
powershell -ExecutionPolicy Bypass -File register-task.ps1

# Option 2 — Startup shortcut; starts at user login
powershell -ExecutionPolicy Bypass -File create-startup.ps1
```

Both launch through `wscript.exe` + `start-server.vbs`, which is what keeps console
windows from flashing. See the hard rules below — this is not optional styling.

## Configure

Prefer the in-app Settings panel (gear icon, sidebar footer); most keys apply live. The
full key-by-key table is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Only
`port`, `host` and `shell` need a restart.

## Optional integrations

Install these only if the user wants the corresponding feature.

| Command | What it enables | Restart needed |
|---|---|---|
| `node fix-hooks.js` | Claude Code status dots (Working/Idle/Waiting), notifications, session browser | none |
| `node scripts/install-statusline.js` | Claude context-window % and 5h/7d rate-limit badges | none |
| `node scripts/install-codex-notify.js` | Codex session status (it has no usable hooks; status arrives as OSC 9 in the PTY) | **COLD** |

Three traps, each of which has silently cost a working feature:

- **`fix-hooks.js` REPLACES `~/.claude/settings.json`'s entire `hooks` key.** If the user
  has their own hooks, merge rather than run it blind. It installs all eight events, and
  the set is not à la carte: `PreToolUse`/`PostToolUse` are the heartbeat that keeps a
  busy session from being flipped to Idle by the 5-minute stale guard, and
  `SubagentStart` without `SubagentStop` is **worse than neither** — the in-flight count
  only grows, so the main agent's `Stop` is held forever and the session never reports
  idle.
- **`install-statusline.js` requires the server to be deployed FIRST.** The endpoint
  advertises `accepts: 'raw'` and the installer refuses without it, so the ordering is
  enforced rather than remembered.
- **`install-codex-notify.js` is worker-side and needs a cold restart.** Also note an
  unconfigured box is *silent*, not noisy — the feature looks broken rather than
  unconfigured. Both installers take `--check` to report without changing anything.

For the multi-server cluster and the Android/Windows companion app, see
[docs/CLUSTER.md](docs/CLUSTER.md) and
[docs/COMPANION.md](docs/COMPANION.md).

## Restarting — pick the right one

**This is the highest-stakes routine decision you will make here**, because a cold
restart kills every live PTY (destroying running work in every session on the box) and a
hot reload does not.

```bash
git diff --name-only <old-hash>..HEAD | grep -E 'pty-worker|^lib/'
```

- **Empty → hot reload.** `powershell -File scripts/hot-reload.ps1`. Restarts only
  `server.js`; the worker keeps every PTY alive and the new web layer reattaches over
  IPC. Browsers reconnect and replay scrollback on their own.
- **Non-empty → cold restart required**, but confirm it: does `pty-worker.js` actually
  `require` the changed module, and did a field it reads move? If not, hot is still
  correct.

**Always ask the user before a cold restart.** "Deploy the latest" does not authorise
destroying their running sessions.

`scripts/cold-restart.ps1` is the safe path — it runs `check-deps.js` **before the first
kill** and aborts untouched if the dependencies fail to load. That gate exists because a
running Node process serves already-loaded modules from **memory**: a box whose
`node_modules` was destroyed hours ago still answers HTTP 200 and still streams PTYs,
while a fresh worker cannot start at all. Restarting it converts a degraded box into a
dead one. `-CheckOnly` audits without touching anything.

## Hard rules — violating these breaks the host, not just the app

- **Never `taskkill /F /IM node.exe`.** It kills unrelated Node processes (MCP servers,
  PM2) and races the VBS launcher, leaving two monitors fighting over port 7681 in a
  crash loop that spawns visible console windows.
- **Never run `node server.js` and `node monitor.js` at the same time.** The monitor
  spawns `server.js` as a child; running both means a port conflict.
- **For production, never launch node directly** — always `wscript start-server.vbs`.
  Node is a console-subsystem executable and will flash terminal windows. `node monitor.js`
  in a terminal is fine during development.
- **Never junction or symlink `node_modules` into a git worktree.** `rmdir /s`,
  `Remove-Item -Recurse` and `git worktree remove --force` all follow a directory
  junction and delete the **target**. This has already destroyed a production install.
  Give the worktree its own copy. To remove an existing junction, delete the *link* with
  bare `cmd /c rmdir <link>` — no `/s`.
- **Never restart or stop a server you were not asked to touch**, and never commit,
  push, or force-push without being asked.

## Troubleshooting, by symptom

| Symptom | Cause | Fix |
|---|---|---|
| `/login` returns 200 but everything stateful times out; `error.log` floods with `RPC listSessions timed out after 30000ms`; `worker.log` stops dead; worker at 0% CPU with a childless `OpenConsole.exe` | Blocked worker event loop — usually a damaged `node_modules`. Not a network or auth fault | Stop the worker (releases the lock), `npm install`, relaunch. Killing the stray `OpenConsole.exe` does **not** help |
| `crypto.randomUUID is not a function` | Served over plain HTTP on a LAN/VPN IP; that API is secure-context only | The client polyfills it — force-refresh past the service worker |
| Console windows flashing, monitor restart loop | A blanket `taskkill` raced the launcher; two monitors are alive | Kill the monitor + worker + `server.js` PIDs explicitly, wait 2–3s, `wscript start-server.vbs` |
| CLI tools missing inside spawned shells after auto-start | Session-0 scheduled task has a stale PATH | Relaunch from a logged-in user session |
| `conpty_console_list_agent.js: AttachConsole failed` in test output | Harmless node-pty warning | Ignore |

To identify processes without guessing:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap
```

Match `server.js` / `pty-worker.js` by **full path with `-like`**, never `-match` — the
`\p` in `pty-worker.js` is parsed as a malformed `\p{...}` regex class. `monitor.js` has
no path in its CommandLine, so find it by the ParentProcessId of the matched children.

## Running the tests

```bash
npx playwright test      # full suite, serial, on port 17681
npx eslint .             # must report 0 errors (warnings are tolerated)
npm run syntax-check
```

The suite starts its own server and sets `WT_TEST=1`, which routes config to
`config.test.json` — **your production `config.json` is never touched.** The companion
app's Dart tests are separate: `cd ai-terminal && flutter test`.

## Reporting back

State what you installed, what you ran, and what you observed — specifically whether you
created a session and typed in it. If any step failed, say so with the actual output. Do
not report "installed and working" on the strength of a 200 from `/login`.
