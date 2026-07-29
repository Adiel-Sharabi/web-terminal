<p align="center">
  <img src="icon.svg" width="80" alt="Web Terminal">
</p>

<h1 align="center">Web Terminal</h1>

<p align="center">
  Browser-based terminal manager for Windows.<br>
  Run, monitor, and control multiple CLI sessions from any device.
</p>

<p align="center">
  <strong>Built for <a href="https://claude.ai/claude-code">Claude Code</a></strong> &mdash; but works with any CLI tool.
  <br>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
</p>

---

> **Platform note:** Web Terminal is designed for Windows, where browser-based terminal solutions are scarce. Linux and macOS users have excellent alternatives like [ttyd](https://github.com/tsl0922/ttyd), [gotty](https://github.com/sorenisanerd/gotty), and [code-server](https://github.com/coder/code-server).

## Why?

Running Claude Code (or any long-running CLI) on a remote Windows machine? You need to:

- Check on it from your phone while away from the desk
- Run multiple sessions across multiple machines
- Get notified when something needs your attention
- Resume conversations without SSH or RDP

Web Terminal solves all of this, running as a single `node monitor.js` on each host.

## Features

### Terminal & Sessions
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **In-place switching** — switch between sessions without page reload
- **Instant switching** — optional `keepSessionsOpen` mode keeps background WebSocket connections to all sessions, caches scrollback in memory, and switches instantly without re-downloading data
- **Session persistence** — sessions survive server restarts with scrollback replay
- **Lazy scrollback** — initial attach replays a small chunk (default 32 KB) for fast first paint; scrolling xterm to the top fetches older bytes on demand from `/api/sessions/:id/scrollback`, up to the worker's stored history
- **Auto-command** — startup command per session, waits for shell prompt before executing
- **Fork session** — duplicate a Claude session with `--fork-session` from the sidebar
- **Exclusive viewer** — one device per session prevents display corruption from mixed screen sizes
- **Drag-reorder sessions** — drag a session row in the sidebar to change its order within the same server (cross-server reorder is disallowed). Order persists on disk and survives restarts
- **Collapsible server groups** — click a server header in the sidebar to fold its session list away. State is per-browser (localStorage) and persists across reloads
- **Favorite sessions (server-side, shared by every client)** — click the star on any session row to pin it to a **Favorites** group at the top of the sidebar, spanning all servers. Each favorite is badged with the server it lives on (Home / Office / …) so you always know where it is. The pin and its position are a **property of the session**, stored on the server that owns it (`favorites.json`, `GET`/`PATCH /api/sessions/:id/favorite`, surfaced as `favorite` + `favoriteRank` on the session lists) — there is no per-device list, so **every client that reads the server's answer shows the same pinned group**. **Reorderable** — drag to reorder on desktop, or long-press then drag on mobile; the new order is written back as ranks. A new pin's rank is a **wall-clock timestamp assigned by the owning server**, so pins are globally ordered with no coordination and a pin made while a peer is offline cannot collide with a rank that peer already holds; a drag *permutes* the ranks the group already holds rather than renumbering to 0,1,2, which would jump the whole visible group ahead of an offline peer's pins. The group's order is derived by sorting the union of every server's favorites by (rank, id), so an offline server simply contributes nothing (its pins survive on it and reappear when it does). Collapsible and click-to-switch like any session row.
  - **Mixed fleet (the normal state — servers upgrade one box at a time):** a peer must itself be on **1.37.0 or newer** for its sessions' stars to sync. Each server advertises the **`favorites-sync`** capability on `GET /api/version`, and `/api/cluster/sessions` carries every peer's capability list on its `servers[]` entries — so the client greys the star out (with a "needs a web-terminal upgrade" tooltip) on sessions owned by a server that can't take the write, instead of firing a `PATCH` that 404s and letting the star snap back with no explanation.
  - **Migration from the old per-browser list is one-shot:** the pre-1.37.0 `localStorage['wt.favorites']` array is read **once**, pushed up to the servers that own those sessions (preserving its order), and then **deleted unconditionally** — it must never survive as a second source of truth, or it would re-push `favorite: true` on every load and resurrect a pin you later unstarred on another device. Anything it couldn't push (the owning server is offline, or too old to have the route) is reported once in a message: **star those sessions again**.

### Multi-Server Cluster
- **Unified dashboard** — see and manage sessions across all servers in one sidebar
- **Auto-sync** — authenticate once and both servers discover each other automatically
- **Cluster proxy** — all remote traffic routed through your connected server (no CORS)
- **Direct terminal mode** (opt-in) — for peers flagged `directConnect: true`, the browser's terminal WebSocket connects straight to the peer using a short-lived HMAC-signed token, skipping the proxy hop. Roughly 14x faster at p50 when your browser is closer to the target server than to the server you logged in through
- **API tokens** — inter-server auth with 90-day expiry
- **Remote exec** — run commands on any server via `/api/exec`

### AI Agent Integration (Claude Code + Codex)
- **Multi-agent sessions** — a session knows *which* AI CLI agent it runs. Pick it in the new-session form ("AI agent": Auto / Claude Code / Codex) or let the server infer it from the launch command; a plain shell has no agent and is never mislabelled. Each row is tinted with its agent's colour. The agent is persisted on the session (`sessions.json`) and returned as `agent` on `/api/sessions`, `/api/cluster/sessions` and the transcript response (`null` = plain shell). An **explicit** choice is authoritative — a session declared Claude is never served a Codex transcript; only a session with no recorded agent falls back to cross-provider discovery.
- **One provider registry** — everything agent-specific (transcript parser, transcript root, how a transcript is located, subagent-trace support, label + colour) lives in `lib/agents.js`. **Adding another CLI agent is one parser module + one registry entry** — no branching in `server.js`, `pty-worker.js`, or either client. `GET /api/agents` serves the catalogue, so the web + companion pickers and the per-agent tint pick up a new agent with no client release.
- **Codex usage badges** — a Codex session shows the same context-window % and rate-limit chips a Claude session does. Claude *pushes* its status line to `POST /api/claude-status`; Codex *records* the same numbers in its rollout every turn, so a provider can expose `readMetrics(tail)` and the server fills the identical `metrics: { ctx, fiveH, sevenD, model, effort }` shape by reading the transcript — no extra process, no client change. Two traps the parser avoids: `total_token_usage.total_tokens` is the session's *cumulative* spend (millions of tokens on a long session), so context occupancy is `last_token_usage.input_tokens`; and the 5h/7d windows are matched by `window_minutes` (300 / 10080), never by `primary`/`secondary` order. Reads are memoised on the rollout's `(size, mtime)`, so sidebar polling costs one `stat`; a plain shell never touches the disk. Note the Codex windows are your ChatGPT/Codex plan limits, not Claude's.
- **Codex session status, without hooks** — a Codex session used to sit on `active` forever: no status dot, no attention record, no push, while Claude got all three. Codex *has* hooks, but they are unusable unattended — only `managed` hooks run (user-level and `-c`-injected ones load as `trust=untrusted` and never fire), trust is bound to a **sha256 of the hook definition** so changing the command re-prompts on every machine, and `codex exec` runs no hooks at all. The way out is a channel most users can't exploit: with `tui.notifications`, `notification_method = "osc9"` and `notification_condition = "always"`, the Codex TUI writes its notifications **into the terminal** as OSC 9. For a normal user that's the *weaker* channel — it only paints in their emulator, which is why getting approval events onto the external `notify` program is still an open upstream request — but **web-terminal is the terminal**: `pty-worker.js` already reads every byte, so the event everyone else is asking for is simply already there. Measured off a real PTY, an approval emits `ESC]9;Codex wants to edit 0 files BEL` and a finished turn emits the agent's last message; `waiting` is the status that actually matters, since it drives the red dot and the phone push. Run `node scripts/install-codex-notify.js` once per machine — `notification_condition` defaults to `unfocused` and a PTY has no focus state, so without `always` nothing is emitted and the feature looks broken rather than unconfigured. Worker-side, so it needs a **cold restart**. Only an agent that *declares* the channel is scanned: a plain shell that prints an OSC 9 (vim, a build script) can never move a dot.
- **Agent-aware prompt submit** — sending a prompt from chat (or typing and hitting Enter in one burst) reaches the worker as a single frame ending in `\r`. **Every agent TUI folds one read into a paste and swallows that trailing `\r`**, turning it into a newline in the composer: the prompt is typed but never sent. Codex does it at any length; Claude needs a bigger read to trip it — measured against the real TUI with an atomic `text\r`, prompts of 20/40/60 chars submitted but **80 and 120 did not**, which is why a short test prompt always "worked" and a real one silently parked. Each provider declares `submit: { gapMs, crBurstsAsPaste }` in `lib/agents.js`, and `pty-worker.js` — the one place that knows both the agent and the raw bytes — withholds the trailing CR of any frame that is text ending in `\r`, writes it alone `gapMs` later, and queues anything arriving in between so input order holds. Ordinary char-by-char shell typing is untouched (it sends a *lone* CR, which is never split). Bracketed paste does not exempt the CR — only a real temporal gap works. Clients send the same bytes as before, so web, companion and any future client are fixed at once with no release.
- **Interrupt (Esc) clears "working"** — Claude fires no hook when you interrupt a turn, and session status is otherwise hook-driven, so an interrupted session used to sit on *"Claude is working"* until a 5-minute stale-correction rescued it. The worker writes the Esc byte itself, so it now reads a **lone `0x1b`** sent to a *working* session as "the turn is over" and reports idle immediately (an arrow key's `ESC [ A` is not a lone Esc, so it never counts). Esc at a permission prompt still means *reject* and is left alone, and a plain shell never opts in — Esc in vim or `less` is not "the agent stopped". Verified against the real TUI: a running turn emits ~900 bytes/2s, and after a lone Esc it emits **zero**.
- **Codex transcripts** — the chat view renders Codex conversations exactly like Claude's. `lib/transcript-codex.js` parses Codex's rollout JSONL into the same typed turn shape (`shell_command`, `apply_patch` and `web_search` become rich tool cards, paired with their output). Codex keys rollouts by date + uuid rather than by cwd, so `lib/codex-sessions.js` finds a session's rollout by reading each candidate's `session_meta` head line, newest-first and bounded. One backward paginator, one cursor codec and one set of size caps serve every agent.
- **Session intelligence** — real-time status tracking via Claude Code hooks: Working (orange), Idle (green), Waiting for input (red)
- **Rich tool cards in chat** — the companion app's chat view reflects what the terminal shows: shells (Bash command + output), subagents (Task description / subagent type + its report), and file ops (Read/Edit/Write with a diff), each a compact card that expands to the detail. `GET /api/sessions/:id/transcript` exposes, per `tool_use`, its `id`, a per-field-capped structured `input`, and the paired tool_result `result` (output); `lib/transcript.js` pairs results to their tool call by id. Backward-compatible (`name`/`inputPreview` unchanged)
- **Drill into a running subagent (chat-mode parity with the terminal's subagent panel)** — a `Task` tool card that spawned a subagent shows a live **running dot** and taps to expand into the subagent's *own* nested tool calls (Bash/Read/Edit…), lazily loaded and re-polled every 4s while it runs, so you can watch it work — the chat-native equivalent of the terminal's arrow-navigable subagent view. A nested `Task` keeps its own panel, so you can drill to any depth. Powered by two additions: `/api/sessions/:id/transcript` now stamps each `Task` tool_use that left a subagent transcript on disk with a `{ agentType, description, running }` stub (linked via the `agent-*.meta.json` sidecar's `toolUseId`), and `GET /api/sessions/:id/subagent/:toolUseId` pages that subagent's own transcript with the *same* backward-cursor parser (the sidechain `.jsonl` shares the main turn shape — one parser). Advertised via the `subagent-trace` capability; additive + backward-compatible
- **Pinned subagent strip (chat)** — a session's subagents stay reachable however far the transcript scrolls: a slim strip of chips pinned above the chat, one per `Task` subagent, each with a live running/finished dot. Tapping opens that subagent's drill-in in a focused sheet that reuses the **same** `GET /api/sessions/:id/subagent/:toolUseId` paging path as the inline card (one fetch path, not a second). The strip hides entirely when a session has no subagents. The subagent transcript is **read-only** — Claude subagents run autonomously and there is no channel to inject input into a specific one — but the sheet carries a **"Message session"** input so you can type from the subagent view exactly as the terminal lens lets you while a subagent runs: it routes to the session (the main agent's PTY) through the **same** `buildComposeSubmission` submit path the compose bar uses (no parallel path, no fictional per-subagent channel), then closes so the prompt's echo and reply land back in the chat (#62). Companion-only (the web app has no chat lens)
- **The companion's session controls live in a meta bar, not the app bar (#74)** — `AppBar` lays its `actions` out at their intrinsic width **first** and hands the title whatever is left, so the title was the only flexible child and absorbed every control's shortfall. On a phone that collapsed a session name to `● Lo…` — two characters — and each control added over time (the lens toggle, then #40's chrome, then #70's speaker) made it quietly worse. Rationing the remaining pixels only redistributes the shortage, so instead the app bar now carries **only the session's identity** (status dot + title, `Expanded`) plus the overflow, and every session-level control — lens toggle, read-aloud, detach, server chip — moved down into `SessionMetaBar` alongside the cwd and the ctx/5h/7d badges. There the flexible child is the **cwd**, which can shrink harmlessly, so a control added later can no longer reach the title at all. Two things fall out of the move: the badges and cwd now render in the **terminal lens too** (they lived inside the chat lens before, so a terminal session showed neither), and the transcript-derived ctx estimate — which only the chat lens can compute — is lifted to the bar through a `ValueNotifier` rather than dropped
- **Copy a session's working directory from the companion (#77)** — the cwd chip shows the folder *name*, because spelling the path out is exactly what would re-break the width budget above. That left the path on no screen and no clipboard: a plain `Text` with no gesture, which is why this one label refused to select while the chat text around it selected fine. **Long-press (touch) or right-click (desktop) copies the full path**, confirmed by a one-second "Path copied". The gesture pair, the menu and the confirmation are lifted from the chat link's copy menu rather than invented, so copying a path is the same gesture as copying a link instead of a second vocabulary to learn
- **Read the last answer aloud (#70 Phase 1)** — a speaker button in the web app's toolbar speaks the agent's most recent **answer**, filtered. The value of a voice feature is entirely in what it refuses to say: read verbatim, a turn becomes diffs, markdown table pipes and URLs spelled out character by character. `lib/speech.js` is the single place that decides — **pure and agent-agnostic**, consuming the typed turn `lib/transcript.js` already produces (prose separated from tool calls and tool results), so Codex is supported with **no branching**. It drops fenced code blocks, tables, horizontal rules, URLs and emoji; keeps link labels and inline-code *content* (dropping the span would gut the sentence — "the fix is in at line 42"); maps `_` to a space so `some_var` is not fused into "somevar"; and caps the utterance at 4 sentences / 700 chars. `GET /api/sessions/:id/speech` reuses the **same** transcript trust chain as `/transcript` (no new read surface) and steps back over tool-only turns to find real prose. An **empty** utterance is a normal answer — "the last turns were tool calls or pure code" — and the client stays **silent**, never falling back to raw text. Speech is rendered by the **browser's own** `SpeechSynthesis`: nothing to install, and no audio or transcript text leaves the machine. The button hides entirely where the browser has no speech support, and a second press stops playback
  - **It prefers a summary when the answer marks one.** Capping at the first N sentences is a *length* rule, not an *importance* rule — an answer whose point lands in its last paragraph was never heard. So when a turn ends with a `TL;DR` / `Summary` / `Bottom line` section (heading form or inline `**TL;DR:** …`; the last one wins, and it ends at the next heading) **only that** is spoken. Nothing is mandated: with no such section it falls back to first-N exactly as before. This is deliberately a *readable* convention rather than a marker only the TTS understands — a TL;DR earns its keep whether or not anyone presses play. To get one written for you, ask for it in `CLAUDE.md`; the ladder also picks up summaries you write by hand
  - **Identifiers are shaped for the ear.** Our vocabulary is the worst case for a speech engine: `lib/agents.js` read literally is "lib slash agents dot J S". A path collapses to its basename with the extension dropped (→ "agents"), hyphens become spaces (`pty-worker.js` → "pty worker"), and camelCase is split (`buildComposeSubmission` → "build Compose Submission"). Each rule is gated so ordinary English is untouched. Precision is traded for listenability **on purpose** — the screen still shows the exact path; the ear needs the name
  - **Pace and voice are settings, not constants.** The web app's settings panel has a read-aloud voice picker (populated from the browser's own voices) and a speed slider with a Preview button; the companion has the matching speed slider. Voice *quality* on Android is an OS choice — Settings › General management › Text-to-speech — and switching from the vendor default to Google's engine is usually a bigger improvement than any app-side tuning
  - **On the companion (Android)** the same button sits in the session app bar and speaks through **Android's own `TextToSpeech`**, reached by a hand-rolled `wt/speech` MethodChannel in `MainActivity.kt`. It deliberately does **not** use the `flutter_tts` package: that package was removed from this project once already because its **Windows** build needs `nuget.exe`, and the companion still ships a Windows desktop build — Kotlin under `android/` cannot break it, a plugin would. The control is Android-only and absent elsewhere rather than present-but-broken. Speech is the phone's own offline engine; no audio and no transcript text leaves the device
- **Background work is shown next to the dot, never inside it** — a session that had launched a build looked *idle*. The status dot tracks the **agent's turn**, not the work in the session: Claude's `run_in_background` returns the instant the command is *launched*, so `PostToolUse` fires at once, the turn ends, `Stop` flips the session to idle — and the dot is green while the build runs underneath. Nothing was aware of work that outlives a turn; `pty-worker.js` even says as much ("a session running a build / background process … fires NO Claude hook"), but the only response to that had been to *stop the stale timer*, never to **show** it. The dot is deliberately left alone — the agent really is idle — and the running commands ride beside it as their own field, so a session can honestly be *idle **and** building*. Derived from the transcript, which records both ends (the launch's id, and a `<task-notification>` carrying that id when it finishes), so **running = launched − finished** with no new hook and **no cold restart**: `lib/background-tasks.js` owns the rule, and `backgroundTasksInTranscript` in `lib/agents.js` gates who is scanned, so a plain shell and Codex cost exactly zero disk. Served as `backgroundTasks: [{id, description, startedAt}]` on each `/api/sessions` entry, rendered as a spinning amber chip in the web sidebar and the companion's session card. One trap is worth knowing, because it was caught only against a live 4.5 MB transcript: matching the launch *sentence* alone reported twelve long-finished builds as running, since a session that greps its own transcripts records `"Command running in background with ID: …"` as ordinary tool output — a launch counts **only** when the result pairs back to a `run_in_background` Bash `tool_use`, which quoted text never does.
- **Status-line metrics** — the companion app's chat view mirrors the Claude Code status line: context-window %, and the 5-hour / 7-day rate-limit usage %. Claude Code pipes its `statusLine` command a JSON payload; `scripts/wt-push-status.sh` forwards it **verbatim** to `POST /api/claude-status` (localhost-only, throttled ~5s, safe-fail) and `lib/metrics-claude.js` is the single place that decides what it means. The server exposes `metrics: { ctx, ctxWindow, ctxTokens, fiveH, sevenD, fiveHResetAt, model, effort, ts, agent }` on each `/api/sessions` entry (capability `status-metrics`).
  - **`ctxWindow` is served, never assumed** (#71). It comes from the payload's `context_window_size` — 200 000 normally, 1 000 000 on an extended-context session. Clients render the percentage against *that*; a hardcoded 200 000 pinned every 1M session's badge at `~100%`. Extended context is detected by this field, never by looking for a `[1m]` marker on the model name.
  - **The model and effort are shown, not just stored.** Both clients render `model · effort` (`Opus 4.8 · high`) beside the ctx badge — the web sidebar row, and the companion's meta bar — so a glance answers *which* model the session is talking to, not only how hard it is thinking. It is **agent-neutral by construction**: the server fills the same two fields for every provider (Claude from its payload's `model.display_name`, Codex from its rollout's `turn_context`), so the clients read one field and never ask which agent it is, and a newly-registered agent needs no client release. Either half may be absent, so the label is whichever parts exist; absent entirely means **no chip**, never an empty one. The badge is deliberately quiet — it is a *stable* property, unlike the volatile percentages next to it — and it ellipsizes (web) so a long display name can never push a live percentage out of the row. Note a client-side gate had to go with it: a report carrying **only** the stable fields (`model`, `effort`, `ctxWindow`) — which is exactly what a status line pushed before the session's first API call, or in the gap right after `/compact`, looks like — used to be discarded for having no number in it, blanking the model on precisely the fresh sessions where it is least obvious.
  - **The metrics survive a restart** (#72). They are mirrored to `claude-metrics.json` (gitignored, debounced write + flush on shutdown). In-memory alone only ever worked for an *active* session; an idle one never reposts, so a restart blanked it permanently. Past the 4h TTL the *account* windows (5h/7d) go `null` — unknown renders as nothing, never `0%` — while `ctx` survives, because a session's context cannot change while it is idle.
  - **Install the pusher per machine:** `node scripts/install-statusline.js` (sibling of `fix-hooks.js`; patches only the push block in `~/.claude/claude-status.sh` and leaves your own rendering alone). **Deploy the server first** — it reads both the raw payload and the older flat push, but an *older* server reads a raw payload as four absent numbers. The endpoint advertises `accepts: 'raw'` and the installer refuses without it, so the order is enforced rather than remembered
- **Account capacity on the server row** — the 5h and 7d windows are **account-wide, not per-session**: every session on a server shares them, so they render **once**, on the sidebar's server header (`Claude Code 5h 42% · 7d 18% — 3m ago`), while `ctx%` stays on each session row where it belongs. The roll-up is computed **server-side** (`lib/usage-rollup.js`, one field: `usage` on each entry of `servers[]` in `GET /api/cluster/sessions`) — never a max()/freshest-of picked independently by each client. It is **per agent**: Claude and Codex bill separate quotas and are never merged into one number, and a server reports only the agents that actually reported on it. Each report carries `ts` (a push's arrival time; for an agent that *records* its usage, the transcript's mtime), and a report older than the 4h metrics TTL is **not shown at all** — unknown renders as nothing, never as `0%`. A peer reports its raw numbers on its own `/api/sessions`; the same one rule rolls them up for local and remote alike, so no extra fan-out call is made
- **API-error auto-recovery** — detects `API Error: …` (including rate-limit / "temporarily limiting requests") in a Claude session's output, flags the session with a **pulsing red** highlight in the sidebar and fires a notification so you know to pay attention. On a transient/overload error (529, 500, rate-limit, timeouts, etc.) it auto-recovers: sends `continue` twice, then `/compact` and replays your last prompt — up to 3 attempts per error, then leaves it highlighted for you. Submissions are sent as a real carriage-return Enter so Claude's TUI actually receives them. Toggle with `autoContinueOnApiError` (Settings → "Auto-recover from Claude API errors", default on). Non-transient errors (400/401) only highlight + notify.
- **Smart notifications** — urgent alerts for permission prompts (always shown), quiet notifications for idle sessions (background only)
- **Phone push (ntfy)** — get pushed to your phone even when the app is closed. Tap the 🔔 bell on a session row to open a picker and set that session's level: **off**, **important** (default — Claude needs approval + a *stuck* API error that didn't auto-recover), or **all** (+ finished/idle once it settles). Anti-flood by design: API-error pushes only fire if the error persists ~25s, idle only after ~2 min settled, approvals are debounced. Each push leads with **which server + which session**, quotes **Claude's last message** (pulled from the session transcript, so you see *what* it said/asked, not just that it wants attention), and taps through to it. Configure per server in `config.json` under `ntfy` (`{ enabled, server, topic }`); subscribe the [ntfy](https://ntfy.sh) app to the topic. `POST /api/notify-test` sends a probe. Levels persist server-side in `notify-prefs.json` (gitignored) — no worker restart to change
- **Mute button** — toggle notifications while keeping sidebar status dots live
- **Claude sessions browser** — scan, resume, and transfer Claude Code conversations across servers
- **Session names** — auto-extracted from Claude conversation titles, synced via `/rename` on sidebar rename
- **Clipboard image paste** — Alt+V to paste images directly into Claude Code
- **Drag-and-drop images** — drop an image file on the terminal to upload it (same path as Alt+V)
- **Peer relay** — two agents running side-by-side (e.g. Claude + Codex) can ask each other for a second opinion via a localhost-only message bus at `/api/relay/{send,recv,status}`. Supports batched messages (`more:true` buffers, `more:false` flushes so the peer answers once). Hard rate limits (default: 6 turns per conversation, 50 messages per day, 16 KB per message — overridable via `WT_RELAY_*` env vars) stop runaway loops from burning the token budget overnight. Contract for both agents lives in [PEER_PROTOCOL.md](PEER_PROTOCOL.md).

### Mobile & PWA
- **Progressive Web App** — install as standalone app; name reflects server name
- **Compose input bar** — on mobile, type into a normal text field with full native keyboard behaviour (autocomplete, swipe, predictive text), then **Send** to flush the whole buffer to the terminal. Sidesteps the duplication / lag / broken autocomplete that comes from streaming every keystroke of a composition-oriented mobile keyboard into a terminal. The Enter contract is chosen by **platform, never by lens**: on a soft keyboard **Enter inserts a newline** and **Send** is the only submit (Android's IME commits Enter as literal `"\n"` *text* rather than a key event, so a submit bound to it is unreliable by construction); with a hardware keyboard **Enter submits** and **Ctrl+Enter** inserts a newline. Multi-line buffers are sent as a bracketed paste. ↑/↓ on the touch toolbar walk send-history, ←/→ move the caret. A line starting with `/` streams live so Claude's own slash-command menu renders and narrows as you type — newlines are dropped from that live mirror, since the agent's prompt is one line and a mirrored newline would *submit* it.
- **Compose / Raw toggle** — a button in the touch toolbar switches between compose mode (default on mobile) and raw per-keystroke passthrough for full-screen TUIs (vim, htop, less). The choice persists per browser.
- **Touch toolbar** — compose/raw toggle, Esc, Ctrl, Alt, Shift (sticky), Tab, arrows, plus `/`, `|`, `-`, `~`
- **Long-press context menu** — Copy, Paste, Paste Image, Select, Select All
- **Drag-to-select** — character count shown, floating Copy/Done bar
- **IME deduplication & autocorrect** — in raw mode, handles Android keyboard (SwiftKey, Gboard) composition re-sends without duplication; autocorrect changes are transparently applied via backspace rewrite so the corrected word reaches the shell once
- **Instant reconnect on app-switch** — a backgrounded mobile browser/PWA is suspended by the OS (timers freeze, the WebSocket is dropped), so returning to the app used to mean waiting out a stale exponential-backoff timer. The terminal now reconnects the moment the page returns to the foreground (`visibilitychange` / `pageshow` / `focus` / `online`), so switching back feels seamless. A still-open socket is just kept warm rather than needlessly torn down
- **Responsive layout** — adapts to phone, tablet, and desktop

### Security
- **Scrypt password hashing** with timing-safe comparison
- **Rate limiting** — 5 failed logins per minute, 5-minute lockout
- **CSP headers** — Content-Security-Policy, X-Frame-Options, X-Content-Type-Options
- **Cookie + token auth** — HttpOnly SameSite=Lax cookies (90-day) with server-side expiry enforcement, Bearer tokens for API/cluster
- **Path traversal protection** on all file operations
- **Input length limits** on all user-facing inputs
- **Authenticated worker IPC** — named-pipe / unix-socket between `server.js` and `pty-worker.js` is gated by a per-process handshake token generated by `monitor.js` and shared via `WT_IPC_TOKEN` env var; unix socket is `chmod 0600` to the owning uid
- **Signed direct-terminal tokens** — when direct terminal mode is enabled, the browser receives a per-session HMAC-SHA256 token with a 60s TTL, bound to the session id and the authenticated user. The HMAC key is the bearer token already shared between the cluster peers — no new secret distribution
- **`/api/exec` is opt-in** — remote command execution is disabled by default. Set `"enableRemoteExec": true` in `config.json` to enable it. Enabling it gives any holder of a valid bearer token the ability to run arbitrary shell commands on the server — treat it like SSH. When enabled, calls are rate-limited to 30/min/token and audited to `logs/exec-audit.log` (timestamp, token label, command SHA-256, client IP, exit code, duration). When disabled, the route returns 404.

### Performance
- **Binary PTY data plane** — node-pty is bound in binary mode end-to-end; scrollback is stored and replayed as `Buffer` chunks, so TUI apps that emit non-UTF8 byte sequences render correctly
- **Chunk-list scrollback** — scrollback is kept as a list of buffers and concatenated once per read; no O(n) re-alloc on every PTY frame
- **Chunk-list frame decoder** — the IPC decoder accumulates bytes as a chunk list and only concatenates when it has a full frame, avoiding the O(n^2) `Buffer.concat` cost on multi-MB bursts (~13x faster in our benchmarks)
- **Cached UUID bytes** — per-session id bytes are cached for PTY frame encoding instead of re-parsed on every write
- **Dirty-flag scrollback save** — the 30s periodic scrollback writer skips unchanged sessions; it is also async and yields the event loop between sessions
- **O(1) session id lookup** — session objects carry their id directly; no linear scan on every frame
- **Claude session-id cache** — per-cwd mtime cache keeps Claude Code hook events O(1)
- **Cached git version info** — `/api/version` does not fork `git fetch` per request; p99 typing stalls dropped from ~12s to <400ms

### Operations
- **Server monitor** (`monitor.js`) — supervises `pty-worker` + `server.js` as separate children, auto-restart with exponential backoff, crash budget, log rotation, health checks
- **Hot reload** — web layer (HTTP/WS) can be restarted without losing PTY sessions. The worker owns session state over a named pipe; killing `server.js` leaves shells running and reattaches on restart
- **IPC backpressure** — the worker drops PTY output frames to a slow connection instead of OOMing; a hard-cap (`WT_IPC_MAX_INFLIGHT`) closes the socket if the queue blows past the limit
- **Live config** — most settings apply immediately without restart
- **Tailscale ready** — HTTPS with real TLS certificates over your private mesh VPN

## Quick Start

**Requirements**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win)

```bash
git clone https://github.com/Adiel-Sharabi/web-agent-terminal.git
cd web-agent-terminal
npm install
node monitor.js
```

Open http://localhost:7681 — default login is `admin` / `admin`. You'll be prompted to change the password on first login.

### Production Setup

Use the monitor for crash recovery and logging:

```bash
node monitor.js          # recommended — auto-restart, logs, health checks
node server.js           # direct — no crash recovery
```

> **Important:** Do not run both `monitor.js` and `server.js` at the same time. `monitor.js` spawns `server.js` as a child process — running `server.js` separately will cause a port conflict and rapid console window flashing on Windows. If the port is already in use, the server exits with code 2 and the monitor stops gracefully.

For auto-start on Windows boot:

```powershell
# Option 1: Scheduled task (run as Administrator) — starts on boot even without login
powershell -ExecutionPolicy Bypass -File register-task.ps1

# Option 2: Startup shortcut — starts when user logs in
powershell -ExecutionPolicy Bypass -File create-startup.ps1
```

Both options use `wscript.exe` with `start-server.vbs` to launch the server hidden — no console window flashing.

To restart the server manually (without flashing), identify and kill only the monitor + worker + `server.js` PIDs — do not blanket-kill node.exe, that races with the VBS launcher and can leave a dual-monitor crash loop:

```powershell
# 1. List node processes and find the monitor.js, pty-worker.js, server.js PIDs
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap

# 2. Kill only those PIDs
Stop-Process -Id <monitor_pid>,<worker_pid>,<server_pid> -Force

# 3. Wait 2-3 seconds for ports to release, then start fresh
wscript start-server.vbs
```

For a quicker lifecycle without restarting the worker, you can kill just `server.js`. The monitor will respawn the web layer and the PTY sessions keep running — browsers reattach and replay scrollback automatically.

> **Never run `node server.js` or `node monitor.js` directly on Windows** — they are console applications and will flash terminal windows. Always use the VBS launcher.

**How flashing is prevented** (three layers):
1. **VBS launcher** — `wscript.exe` is a GUI-subsystem executable, so launching node through it creates no visible console window
2. **`useConptyDll: true`** — terminal sessions use the bundled `OpenConsole.exe` instead of the system ConPTY API, which on Windows 11 delegates to Windows Terminal and causes visible flashes
3. **`windowsHide: true`** — all child process calls (git, powershell, etc.) use this flag to suppress console windows

### Automated Install

```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File install.ps1
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Port` | 7681 | HTTP port |
| `-User` | admin | Login username |
| `-Password` | admin | Login password |
| `-Shell` | Git Bash | Shell executable |
| `-DefaultCwd` | C:\dev | Default working directory |
| `-SkipTailscale` | false | Skip Tailscale configuration |

## Configuration

Use the in-app Settings panel (gear icon in sidebar footer). Most changes apply instantly — only port, host, and shell need a restart.

Config is stored in `config.json` (gitignored):

| Key | Live Reload | Description |
|-----|:-----------:|-------------|
| `port` | No | HTTP port (default 7681) |
| `host` | No | Bind address (`0.0.0.0` for all interfaces, `127.0.0.1` for local) |
| `shell` | No | Shell path (Git Bash, PowerShell, cmd) |
| `user` / `password` | Yes | Login credentials (password auto-hashed on startup) |
| `serverName` | Yes | Display name for this server |
| `defaultCwd` | Yes | Default working directory for new sessions. Both clients pre-fill the folder field with a **trailing separator** (`C:\dev\`) so a subfolder can be typed straight onto the end; the server strips it again on create (`lib/cwd.js`), because `claudeProjectDirName` gives every non-alphanumeric char its own dash and a trailing one would name a project directory Claude never created — losing the chat transcript while the session itself looks fine |
| `scanFolders` | Yes | Directories to scan for folder autocomplete |
| `defaultCommand` | Yes | Pre-filled auto-command for new sessions |
| `scrollbackReplayLimit` | Yes | Bytes replayed on initial attach (default 32 KB). Older history is fetched on demand when xterm scrolls to the top. |
| `publicUrl` | Yes | This server's URL for cluster auto-sync |
| `cluster` | Yes | Remote servers list `[{name, url, directConnect?}]`. Set `directConnect: true` on a peer to enable direct-terminal mode (browser WS skips the local proxy hop for that peer's sessions). |
| `claudeHome` | Yes | User profile path for Claude session files (auto-detected if empty) |
| `openInNewTab` | Yes | Whether new sessions open in a new browser tab |
| `keepSessionsOpen` | Yes | Keep background WebSocket connections to all sessions for instant switching (default false) |
| `autoContinueOnApiError` | Yes | Auto-recover from transient Claude API errors: `continue` ×2, then `/compact` + replay your last prompt (up to 3 attempts per error). Default **true**. Highlight + notify happen regardless of this setting. Override per-process with the `WT_AUTO_CONTINUE_API_ERROR` env var (`0`/`1`). |
| `autoResumeOnReset` | Yes | Auto-resume a session ~1 minute after its account's 5-hour usage-limit window resets, by sending `continue` (issue #69). Default **false** (opt-in) — the reset time is only known for Codex today (read from its rollout); Claude's status push has no reset timestamp yet, so Claude sessions never arm regardless of this setting. Override per-process with the `WT_AUTO_RESUME_ON_RESET` env var (`0`/`1`). |
| `passAllEnv` | Yes | Pass the full parent environment to spawned shells (default false — a limited set of variables is forwarded) |
| `exclusiveViewer` | Yes | Restore single-owner session takeover: opening a session on a second device force-disconnects the first (old behavior). Default **false** — multiple devices now share one PTY (shared input/output), so phone + desktop can view/drive the same session at once. |

### Environment Variables

A few knobs are set via environment variables rather than `config.json`. Put them in `start-server.vbs` (or your service wrapper) so the monitor inherits them.

| Variable | Default | Description |
|----------|---------|-------------|
| `WT_IPC_TOKEN` | auto-generated by `monitor.js` | Shared secret used for the handshake on the worker <-> web named pipe. Normally you don't set this — the monitor mints a fresh 32-byte token per process tree and passes it to both children. Set it yourself only if you run `pty-worker.js` and `server.js` without the monitor |
| `WT_IPC_MAX_INFLIGHT` | `52428800` (50 MB) | Hard cap on bytes queued on a single IPC connection. If a slow browser pushes the queue past this, the worker destroys the socket rather than OOM |
| `WT_LATENCY_DEBUG` | unset | Set to `1` to enable event-loop-lag monitoring and slow-op logging in `server.js` and `pty-worker.js`. Useful for diagnosing typing stalls — see the Dev Tooling section below |

## Multi-Server Cluster

1. **Set Public URL** on each server (Settings → Public URL)
2. **Add a remote server** on any one server (Settings → Cluster → Add)
3. **Login to remote** — click Login next to the server in the sidebar
4. **Done** — both servers auto-discover each other. Repeat for more servers.

Each server keeps its own credentials. Inter-server auth uses API tokens (90-day expiry). By default all traffic proxies through your connected server — no CORS issues.

### Direct Terminal Mode (Optional)

Set `"directConnect": true` on a peer entry in `cluster` to skip the local server's proxy hop for that peer's sessions. The browser WebSocket connects straight to the peer using a short-lived (60 s) HMAC-signed token minted by your local server. Saves one network hop of latency when your browser already has direct network reachability to the peer.

```json
"cluster": [
  { "name": "Home", "url": "https://home.example:7681", "directConnect": true },
  { "name": "XPS",  "url": "https://xps.example:7681" }
]
```

The signing key is the bearer token you already share with the peer (stored in `cluster-tokens.json` locally and `api-tokens.json` on the peer). Disabled by default; the legacy proxy path is always available as fallback.

## Claude Code Hooks Setup

For real-time session status (Working/Idle/Waiting), configure Claude Code hooks. Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "SubagentStart": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PreToolUse": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "Notification": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "SubagentStop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PreCompact": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}]
  }
}
```

The HTTP hook type sends requests directly — no subprocess, no console window flash on Windows. Sessions started outside the web terminal (regular CLI) don't have `WT_HOOK_TOKEN` set, so their hook requests are rejected with 401 (harmless — status just doesn't update for non-web sessions). The token is auto-generated per install into `.hook-token` (chmod 0600 on unix) and exposed to spawned shells via the `WT_HOOK_TOKEN` env var.

`PreToolUse` / `PostToolUse` are required — they fire on every tool call and act as a heartbeat that keeps the status dot showing **Working** during long Claude turns. Without them, the worker's stale-status guard (5-min timeout) flips long-running sessions to **Idle** even while Claude is actively working. `SubagentStart` is needed for the same reason during subagent runs, and `SubagentStop` must be configured alongside it — the two are counted as a pair to decide whether a stopped main agent actually means the session is done (see below).

### Hook event transform

Claude's raw hook stream produces noisy status (every `Notification` subtype shares one event name; `Stop` fires between agentic turns even when the next turn starts a few ms later; `Stop` inside a subagent is auto-converted to `SubagentStop`). `server.js` reshapes the events before they hit the worker:

- `Notification` is demuxed by payload (`notification_type` / `message`): permission prompts → **Waiting**, idle prompts → **Idle**, others → dropped.
- `Stop` and idle Notification are debounced (~750ms, override with `WT_HOOK_STOP_DEBOUNCE_MS`). Any working event arriving in the window cancels the idle transition, eliminating the "flash of stopped" between agentic turns. The debounce runs **in the worker**, which owns session status — it used to run here in `server.js`, but this layer cannot tell a subagent's `PreToolUse` from the main agent's (both post under the same session id), so it cancelled the parent's genuine `Stop` whenever a background subagent called a tool (#61).
- `SubagentStop` is forwarded to the worker, which tracks the **set of `agent_id`s** in flight (`SubagentStart` adds, `SubagentStop` removes). While that set is non-empty, a `Stop` from the **main** agent does not mark the session Idle and fires no "Claude is done" push — the turn isn't over, background subagents are still running. The last `SubagentStop` releases the held stop (Idle, one notification). A new user prompt, an Esc interrupt, or the 5-min stale-status guard all reset it, so a subagent that dies without reporting can't pin a session Working forever.

**The payload says who fired the event** (measured against the real hook stream, not the docs): every event raised *inside* a subagent carries **`agent_id`** (and `agent_type`) — `SubagentStart`, `SubagentStop`, and the subagent's own `PreToolUse`/`PostToolUse`. No main-agent event carries it, not even the `PreToolUse`/`PostToolUse` of the `Agent` tool call that *launches* the subagent. That distinction is the whole fix: a subagent's tool call must never be read as "the main agent is still working", and a main-agent event must invalidate a held stop. A backgrounded Task returns its `PostToolUse` to the parent immediately and the parent's `Stop` lands **seconds before** the subagent's `SubagentStop`:

```
PreToolUse(Agent) [main] → SubagentStart [sub] → PostToolUse(Agent) [main]
  → Stop [main]  … 13s …  → SubagentStop [sub]
```

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/download) creates a secure mesh VPN across your devices.

On each server (one-time):
```powershell
tailscale serve --https=443 localhost:7681
```

Then access from any device on your tailnet: `https://server-name.tailnet.ts.net`

## Architecture

```
Phone/Tablet ──> Tailscale VPN ──> Web Terminal (Node.js) ──> Shell ──> Claude Code
                                        |
PC Browser ────> localhost:7681 ────────┘
                                        |
                          ┌─────────────┘
                          v
                   Remote Servers (cluster proxy via Tailscale)
```

| File | Purpose |
|------|---------|
| `monitor.js` | Process manager — supervises `pty-worker.js` + `server.js` as independent children, mints the IPC handshake token, auto-restart with backoff, log rotation, crash diagnostics |
| `pty-worker.js` | PTY owner — node-pty sessions (binary mode), scrollback, session persistence; survives `server.js` restarts |
| `server.js` | Express + WebSocket server, auth, cluster proxy, hooks — stateless; delegates PTY state to the worker over IPC |
| `lib/ipc.js` | Framing + named-pipe / unix-socket server and client for worker <-> web IPC (JSON control + binary PTY frames), with handshake auth and backpressure |
| `lib/worker-client.js` | High-level RPC/event client used by `server.js` to talk to the worker |
| `lib/agents.js` | AI-agent provider registry — the ONE place that knows anything agent-specific (parser, transcript root + resolution strategy, subagent-trace support, label/colour, submit policy). Add a CLI agent here, nowhere else |
| `lib/submit-frames.js` | Pure rules for the two turn-lifecycle keys on the PTY input path: `splitTrailingCr` (hold the submit CR back so a TUI that folds a read into a paste sees Enter, not a newline) and `isEscapeKey` (a *lone* `0x1b` is the interrupt; `ESC [ A` is an arrow) |
| `lib/osc9-notify.js` | Pure extraction of OSC 9 notification bodies from a PTY stream, buffered across chunk boundaries. How a Codex session reports its status without usable hooks — see "Codex session status" below. What a body *means* is a registry field, not here |
| `scripts/install-codex-notify.js` | Writes the three `[tui]` keys that turn that channel on, per machine (sibling of `install-statusline.js`). `--check` reports without changing anything |
| `lib/usage-rollup.js` | Pure rule that turns per-session metric reports into the per-server `usage` block: the 5h/7d windows are account-wide, so they roll up **once per agent** (never merged across agents), freshest report wins, and anything past the metrics TTL is dropped rather than shown as `0%` |
| `lib/transcript-codex.js` | Parses Codex CLI rollout JSONL into the same typed turn shape as the Claude parser |
| `lib/codex-sessions.js` | Finds a Codex rollout for a cwd (Codex keys rollouts by date+uuid, so the cwd is read from each file's `session_meta` head line) |
| `lib/cluster-token.js` | HMAC-SHA256 mint/verify for the short-lived tokens used by direct terminal mode |
| `lib/git-safe.js` | Hardened runner for the version/update-check git calls — disables credential prompts (`credential.interactive=false`, `GIT_TERMINAL_PROMPT=0`) and tree-kills on timeout so a broken HTTPS remote can't hang `git-credential-manager` and leak process trees |
| `app.html` | Unified single-page app (terminal + sidebar + settings) |
| `sw.js` | Service worker for PWA caching |
| `lobby.html` | Multi-server lobby page |
| `terminal.html` | Legacy standalone terminal page |
| `claude-hook.sh` | Claude Code hook script (bash, for non-Windows) |
| `claude-hook.js` | Claude Code hook script (Node.js, for Windows) |
| `scripts/` | Developer tooling — typing-RTT probe, WS latency harnesses, etc. (see Dev Tooling) |
| `tests/` | Playwright tests (security, cluster, IPC, worker, hot-reload, exclusive viewer) |
| `ai-terminal/` | **AiTerminal** — the native Flutter client (Android + Windows) for this server: chat/terminal lenses, session browser, FCM push, and the interactive-question overlay. Talks to the same REST/WebSocket API; built with `flutter` (see `ai-terminal/WINDOWS-BUILD.md`). Its own Dart tests run via `flutter test`, separate from the Playwright suite |

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed technical walkthrough.

## Dev Tooling

All of these are opt-in; none run by default in production.

- **`WT_LATENCY_DEBUG=1`** — enables an event-loop lag monitor (logs every stall >50 ms) and a slow-op wrapper (logs any PTY write / frame decode / scrollback save >30 ms) in both `server.js` and `pty-worker.js`.
- **`?rtt=1` query string** — append to the app URL (e.g. `https://host/app?rtt=1`) to render a small per-keystroke round-trip-time overlay in the browser. Measures time from `keydown` to the corresponding byte echoing back from the PTY.
- **`scripts/typing-probe.js`** — headless typing probe; opens a session, types characters, records round-trip times. Useful for reproducing typing-stall bugs without a browser.
- **`scripts/latency-harness.js` / `scripts/latency-harness-v2.js`** — WebSocket round-trip measurement tools. Compare proxy vs. direct terminal mode, or two servers against each other.

The smoke tests (`smoke-test-hot-reload.js`, `smoke-test-longproc.js`) at the repo root exercise the monitor <-> worker <-> server hot-reload path end-to-end.

## Troubleshooting

- **`crypto.randomUUID is not a function`** — triggered when loading the app over plain HTTP on a LAN/Tailscale IP, because `window.crypto.randomUUID` is only exposed in secure contexts. The client polyfills it automatically; if you still hit this, make sure your browser has loaded the latest `app.html` (force-refresh past the service worker).
- **Dual-monitor crash loop with the console flashing** — caused by `taskkill /F /IM node.exe` races. Follow the manual-restart procedure in the [Production Setup](#production-setup) section and kill the monitor + worker + server PIDs explicitly.
- **`conpty_console_list_agent.js: AttachConsole failed`** in test output — harmless node-pty warning when killing sessions in Session 0 / test environments.
- **CLI tools missing in spawned shells after auto-start** — Session 0 scheduled tasks can have a stale PATH. Kill node and run `wscript start-server.vbs` from your logged-in user session to refresh it.

## Update

```bash
cd web-agent-terminal
git pull
npm install --production
# Restart via Settings button, or:
# node monitor.js (if using monitor)
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

## License

MIT
