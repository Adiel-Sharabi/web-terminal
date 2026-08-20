# Web Terminal — Claude Code Instructions

## Project Overview
Browser-based terminal manager with multi-server cluster support, WebSocket sessions, and PWA. Runs on Node.js + Express + node-pty.

## Pre-Commit Gates (MANDATORY)

Before EVERY commit, you MUST complete these checks in order:

### 1. Security Review
- Review all changed files for OWASP Top 10 vulnerabilities
- Check for: command injection, XSS, auth bypass, path traversal, secret exposure
- Verify no secrets (passwords, tokens, API keys) are committed
- Verify auth middleware covers all new routes
- Verify Bearer token endpoints validate tokens properly
- Check that user input is sanitized before use in shell commands, HTML, or file paths

### 2. Run Tests
```bash
npx playwright test
```
- ALL tests must pass before committing
- If tests fail, fix the issue first
- If new functionality was added, verify relevant test coverage exists

### 3. Syntax Check
```bash
node -c server.js
```

### 4. Bump Version
Bump the version of **whichever artifact the change touches** — this repo ships two, and the PR gate checks per-area:

| The change touches | Bump |
|---|---|
| anything outside `ai-terminal/` | `SERVER_VERSION` in `server.js` |
| anything under `ai-terminal/` | `version:` in `ai-terminal/pubspec.yaml` |
| both | both |

- Patch bump (1.0.x) for bug fixes
- Minor bump (1.x.0) for new features
- Major bump (x.0.0) for breaking changes

Docs- and CI-only changes still bump `SERVER_VERSION` — the gate deliberately keeps no list of "paths belonging to neither artifact", because such a list rots until it lets a real server change through unbumped. **Never bump `SERVER_VERSION` to satisfy a companion-only PR:** it publishes a server version whose server bytes are identical to the one before it, which destroys the identity the version exists to carry.

### 5. Update README.md
If new user-facing features were added, update `README.md`:
- Add to the Features list
- Add configuration docs for new settings
- Update the Architecture table if new files were created
- Keep the Multi-Server Cluster and PWA sections current

## Architecture
Three supervised Node.js processes. See `docs/ARCHITECTURE.md` for the full walkthrough.

- `monitor.js` — supervisor. Mints the IPC handshake token (`WT_IPC_TOKEN`), spawns worker + web, restarts on crash with exponential backoff, rotates logs
- `pty-worker.js` — owns all `node-pty` sessions (binary mode), scrollback buffers, session persistence, Claude hook state. Survives `server.js` restarts
- `server.js` — Express + WebSocket, auth, cluster proxy, REST API. Stateless with respect to PTYs — all session state goes through IPC
- `lib/ipc.js` — framing + named-pipe / unix-socket transport for worker <-> web IPC (JSON control + binary PTY frames), handshake auth, backpressure (`WT_IPC_MAX_INFLIGHT`)
- `lib/worker-client.js` — high-level RPC/event client used by `server.js` to talk to the worker
- `lib/cluster-token.js` — pure HMAC-SHA256 mint/verify for direct terminal mode tokens (60s TTL, signed with the shared cluster bearer token)
- `lib/agents.js` — **AI-agent provider registry. The single source of truth for anything agent-specific.** See "Multi-Agent Support" below
- `lib/transcript.js` / `lib/transcript-codex.js` — per-agent transcript parsers emitting one shared typed turn shape
- `lib/codex-sessions.js` — resolves a Codex rollout by cwd; `lib/metrics-codex.js` — parses Codex usage from its rollout; `lib/submit-frames.js` — the pure submit-CR split rule
- `lib/task-list.js` — the pure task-list rules (#73): status normalisation, the Claude delta fold, the Codex plan snapshot. See "The agent task list" below
- `lib/recap.js` — the pure session-recap rules: `classifyUserTurn` (which `role:user` turns a human actually TYPED), `condense`, `toolTally`, `summariseTasks`. Serves `GET /api/sessions/:id/recap`. See "The session recap" below
- `app.html` — unified single-page app (terminal + sidebar + settings). Polyfills `crypto.randomUUID` for plain-HTTP contexts. `?rtt=1` enables the per-keystroke RTT overlay
- `terminal.html` — legacy terminal-only page (served at `/s/:id`)
- `lobby.html` — legacy lobby page (served at `/lobby`)
- `sw.js` — service worker for PWA caching
- `tests/security.spec.js` — auth, session CRUD, XSS, config security
- `tests/cluster.spec.js` / `tests/cluster-direct-mode.spec.js` / `tests/cluster-token.spec.js` — token auth, cluster API, proxy security, direct mode
- `tests/ipc*.spec.js` + `tests/worker-*.spec.js` + `tests/hot-reload.spec.js` — IPC, worker internals, hot-reload

## Features (high-level)
- Multiple terminal sessions, in-place switching, optional instant-switch (`keepSessionsOpen`)
- Session persistence across server + worker restarts (scrollback replay, binary-safe)
- Multi-server cluster (proxy by default; `directConnect: true` enables direct-terminal mode with signed short-lived tokens)
- Hot reload: killing only `server.js` leaves PTYs running; the new `server.js` reattaches over IPC
- PWA with mobile toolbar, IME-aware input, long-press menu
- Claude Code hook integration (status dots, notifications, session browser, image paste)
- Multi-agent sessions — Claude Code or Codex behind one provider registry (see "Multi-Agent Support")
- Optional latency instrumentation: `WT_LATENCY_DEBUG=1` env (server + worker) and `?rtt=1` query (browser overlay)
- Dev tooling under `scripts/` — typing probe, WS latency harnesses (do not edit without coordinating; sanitisation workstream owns these)

## The session recap — "my last prompt" is NOT `role === 'user'`

`GET /api/sessions/:id/recap` (rules in `lib/recap.js`, pure) answers *where was I in
this one?* for a sidebar full of sessions: last prompt, the agent's latest word, the
current task, and the work done since.

**The trap, and the reason this is a module rather than three lines in `server.js`:** a
transcript is full of `role:user` turns the human never typed — a teammate message, a
`<task-notification>`, Stop-hook feedback, a post-compaction summary, and above all
**slash commands**. Running `/compact` writes a user turn whose text is
`<command-name>/compact</command-name>`, so in a just-compacted session — precisely
when you most need a recap — the newest user turn is that echo, and a naive reading
reports *"your last prompt was: compact"*. **Confidently wrong is worse than absent.**
Genuine prompts also arrive with `<system-reminder>` blocks stapled on, so even a real
one needs its wrapper stripped or the card shows injected instructions instead of your
sentence; a turn that is *nothing but* reminders is not a prompt at all.

**Reuse, don't re-derive.** The reply prefers an author-marked `## TL;DR` through
`lib/speech.js`'s `extractSummary` — that section exists to be exactly this.

**On demand, never on the poll.** One recap costs a transcript tail read; doing it per
row per sidebar refresh would be a disk storm for text nobody is looking at.

**Degrades, never 404s.** A plain shell has no transcript, but *"idle, in `<cwd>`, 20m
ago"* still orients you — and a 404 would make the icon look broken on exactly the rows
most likely to be clicked. The client always receives the full shape.

> **`classifyUserTurn` currently exists twice** — here and in the companion's
> `conversation_view.dart`, which uses it for bubble labelling. The server copy is the
> authority and recognises strictly more (slash commands, system-reminders). Two copies
> of one rule is the drift this codebase keeps paying for; consolidating the Dart side
> onto a server-published field is a separate additive change, **not** a "keep them in
> sync" instruction.

## The companion vendors `xterm` — do not undo it (#81)

`ai-terminal/third_party/xterm` is stock xterm 4.0.0 **plus one patch**, wired in by
`dependency_overrides`. Full write-up: `ai-terminal/third_party/xterm/README-PATCH.md`.
Every hunk is marked `WEB-TERMINAL PATCH (#81)` — **grep for it before re-vendoring or
"upgrading"**, because 4.0.0 is the latest release and a bare re-vendor silently
restores the bug.

**One defect produced two symptoms that read as unrelated bugs.** `Buffer.scrollUp`,
`scrollDown` and `deleteLines` shifted a line with `lines[to] = lines[from]`, which
copies the *reference*: the line ends up in two slots, and since `_adoptChild`
unconditionally detaches the destination's previous occupant, the next iteration
detaches the line the previous one just moved. So a scroll left 27 of 30 lines
**still in the array but detached from it**. Detached lines still *paint* (the painter
walks the array), but `TerminalController.selection` is null whenever either anchor is
detached — that is "text visible, nothing selects". And a later `_moveChild` calls
`_move` on such a line, dereferencing `_owner!`: in debug an
`assert(attached)`, in **release** a hard throw out of `Terminal.write` inside a
WebSocket listener, which kills the widget subtree — that is the blank terminal.

Codex-only because those three methods are reached only inside a DECSTBM margin, and
Codex sets 12 scroll regions on startup where Claude's TUI sets none. `insertLines`
right next door already used `lines.swap` and was correct, which is how we know it was
an oversight rather than a design.

**Two methodological lessons, both of which cost a wrong root cause first.** (1) *A
blank lens next to a healthy chat lens is not evidence about the server* — chat is
built server-side from the rollout and never touches xterm, so the two lenses failing
differently localises the fault to the widget. (2) *Instrument, don't reason about
buffer internals.* Two confident hypotheses (a DECSTBM sequence; `insert` overflowing a
full ring) were both wrong; a five-line `print` in `_adoptChild` named the real cause in
one run and showed the buffer was nowhere near full (`len=30 arr=5000`).

**Verification bar for any change here:** run upstream's own suite against pristine and
patched copies and compare (README-PATCH.md has the recipe). Both give `+108 ~2 -2`;
the two `textScaler` failures are pre-existing Flutter-SDK drift.

## Chat links are TextSpans — never a widget in the text flow (#83)

**A `MarkdownElementBuilder` can only return a Widget, and a widget cannot live inside
a paragraph.** That one API fact is the whole bug, and it is worth stating because the
builder API *looks* like the natural place to add a per-link affordance.

Measured on flutter_markdown 0.7.7+1, rendering the sentence `see LINK tail`
(where LINK is an ordinary markdown inline link labelled `example`):

| | RichTexts | structure |
|---|---|---|
| custom `a` builder | **4** | `"see "` \| `"example"` \| `" tail"` — separate render objects |
| native `onTapLink` | **2** | one paragraph: `[see ][example ←Tap][ tail]` |

The ancestor `SelectionArea` (#27) walks a **paragraph**, so a shattered sentence is one
it cannot drag across. That is why the symptom was *"dragging selects nothing"* rather
than the narrower "the URL itself isn't selectable" — **the link poisons the whole
sentence around it.** The widget's own `GestureDetector` compounded it: `onLongPressStart`
holds the gesture arena for exactly the button-down a selection drag begins on.

The same builder also attached the tap recognizer to the **wrong fragment** (`" tail"`),
so tapping trailing prose opened the link while the link text did nothing. Nobody had
reported that; it fell out of the instrumentation.

**Two traps, both of which cost a wrong answer first.**

1. **A widget test cannot see this bug, and a *plausible* widget test can be worse than
   none.** The first test written for the fix asserted "no `WidgetSpan` in the span tree"
   — and **passed against the buggy code**, because the mechanism is paragraph
   fragmentation, not a `WidgetSpan`. Assert on the RichText *count* for a sentence, and
   on which span carries the recognizer. Both are red against the old rendering.
2. **Instrument, don't reason** (the #81 lesson, again). Printing the real span tree in
   both configurations named the mechanism in one run, after reasoning had produced a
   confident wrong one.

**The rule going forward:** any per-link affordance must be reachable from a `TextSpan`
recognizer or from the `SelectionArea`'s context menu — **never from a widget in the text
flow**. Reintroducing a builder to add "Copy link" silently reintroduces this bug.

**What the fix traded away, deliberately:** the per-link long-press / right-click
"Open / Copy link" menu is gone. It existed *because* links were unselectable. For a bare
autolinked URL — what an agent actually prints — the link text **is** the href, so
ordinary select + copy now yields the URL. For a labelled link — one whose text differs from its
URL — the URL is no longer copyable from the UI; a tap still opens it.

**Still not verified by an automated test:** that a real mouse drag on the shipped Windows
build now highlights. Synthetic pointer events never traverse the OS input path — eight
widget tests passed against the original report. Use
`scripts/rig/probe-drive-selection.ps1` with a URL-containing fixture and **always
`-ShotDuring`**: without the mid-drag screenshot, "nothing was selected" and "nothing was
rendered to select" are indistinguishable.

## Multi-Agent Support (Claude Code + Codex)

A session knows *which* AI CLI agent it runs. `agent` is a real, persisted session field: `'claude'`, `'codex'`, or `null` for a plain shell. **`null` is never coerced to `'claude'`.**

### The rule: one registry, no branching
Everything agent-specific lives in **`lib/agents.js`** — parser, transcript root, transcript-resolution strategy, subagent-trace support, label, colour, and submit policy. **Adding a CLI agent is one parser module + one registry entry.** If you find yourself writing `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html` or the companion, you are in the wrong file — add a field to the provider instead.

`GET /api/agents` serves the catalogue, so both clients render the picker and the per-agent tint with **no client release** when an agent is added or renamed. The companion holds no agent table (`AgentCatalog`); neither does `app.html`.

An **explicit** agent is authoritative: a session declared `claude` is never served a Codex transcript. Only a session with no recorded agent falls back to cross-provider discovery.

### Codex facts (verified empirically against codex-cli 0.144.0 — do not trust the docs)

**Submit is CR, never LF — for every agent.** See "Input & Submit Contract" below: that section is the law, and it supersedes any older phrasing here. Both TUIs read raw mode where Enter is `\r` (0x0D); an `\n` inserts a newline in the prompt box and submits nothing.

**Rollout transcripts** live at `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl` and are **not cwd-keyed** — `cwd` appears only in the first `session_meta` line (which is ~8 KB; a naive 4 KB read truncates it mid-JSON). `session_id` **is** the rollout UUID.

> **A Codex transcript path is DISCOVERED, never derived — so it must never be cached forever.** Codex writes a **new rollout on every run**, and resolution is "the newest rollout matching this cwd", so the correct answer changes while nothing about the web-terminal session does. `resolveSessionTranscriptPath` stashes the resolved path and only the **hook** path re-stashed it — which Codex does not have — so the chat lens pinned whatever was newest the first time it was opened and froze. Observed on a fleet server 2026-07-21: a **2026-07-14** rollout served with seven newer ones for the same cwd on disk, the newest 25 minutes old. Claude is immune for **two** independent reasons (its path is a pure derivation from cwd + conversation id, *and* its hooks re-stash it); Codex has neither. The provider now declares `transcriptPathStable`, and a discovered path is re-derived past a 10s TTL. **Symptom to recognise:** a live, correct terminal next to a chat lens showing another day — that is a *resolution* bug, not a rendering one, and `cwd` alone is not a session identity when several rollouts share a directory.

> **A conversation needs an identity ON THE WIRE, or no cache can know it is stale.** Claude has `claudeSessionId`; a Codex conversation had **nothing**, and `cwd` is not an identity (one server ran seven rollouts in one directory). That single gap produced the same bug twice, at two layers: the **server** cached a resolved path with nothing to invalidate it (1.45.1, fixed with a TTL), and then the **client** cached the turns themselves with nothing to invalidate them (1.47.0) — a chat lens showing a 17h-old conversation beside a live terminal, with the API serving the current one correctly all along. The id is now derived once in the registry (`conversationIdFromPath`: Claude's is the basename, Codex's is the trailing UUID of `rollout-<iso>-<uuid>.jsonl` — match it as a UUID, the ISO stamp has dashes too) and published as **`agentSessionId`**. **Do not fold it into `claudeSessionId`** however tempting (it would need no client release): `app.html` shows the Fork button on that field and forks with `claude --resume <id>`. **Symptom to recognise:** terminal live, chat old — check the API first, because it decides whether you are chasing a server bug or a client one.

Tool calls are **one line each**, `function_call.arguments` is a JSON **string**, `custom_tool_call_output.output` is a JSON envelope `{output, metadata}` needing unwrap, and `event_msg` lines restate `response_item` text — parse one or every turn doubles.

**Usage metrics.** Claude *pushes* its status line to `POST /api/claude-status`; Codex *records* the same numbers in its rollout, so a provider may expose `readMetrics(tail)` and the server fills the identical `metrics` shape. Three traps: `total_token_usage.total_tokens` is the session's **cumulative** spend (millions — using it reports thousands of percent), so context occupancy is `last_token_usage.input_tokens`; `cached_input_tokens` is a **subset** of `input_tokens`, not an addition; and the 5h/7d windows are matched by **`window_minutes` (300 / 10080)**, never by `primary`/`secondary` order. `turn_context` (model/effort) is written once per **user** turn, so a long agent turn buries it above the tail — the server reads head+tail.

> ### CORRECTED 2026-08-04 — hooks DO run. `SessionStart` is LAZY.
>
> This section previously read *"Hooks DO NOT RUN on codex-cli 0.144.6"*. **That was
> wrong, and the error was in the probe, not in Codex.** Re-measured on the same
> version with `scripts/rig/probe-codex-hooks.js` (isolated `CODEX_HOME`, one marker
> file per event, written by a `.bat` before anything that could fail):
>
> | run | `SessionStart` | `UserPromptSubmit` |
> |---|---|---|
> | a prompt is submitted | **FIRED** | **FIRED** |
> | no prompt, 40s (`NO_PROMPT=1`) | never | never |
>
> **`SessionStart` does not fire when the process starts — it fires when the FIRST
> TURN BEGINS.** That is the same laziness as the rollout file, which Codex also
> creates only on the first turn, and it is why item 4 below reached the opposite
> conclusion: it asserted *"it needs no turn to have started"*, waited at the
> composer, and saw nothing. **A hook that has not fired yet and a hook engine that
> never fires look identical if you never start a turn.**
>
> **So #78 is buildable.** Both halves of its premise hold on this version.
>
> Two traps that each produced a confident WRONG answer first, kept because they
> generalise:
> * **A TOML bare key after a `[table]` header belongs to that table.** Writing
>   `model = "..."` below `[features]` made Codex read `features.model`, reject the
>   *whole* config (`invalid type: string, expected a boolean`), and therefore never
>   enable the hooks gate — reported by the probe as "hooks don't run". A probe must
>   **abort** on a config-load error, never fold it into a negative verdict.
> * **Codex refuses to create its helper binaries under `%TEMP%`.** Put the probe's
>   `CODEX_HOME` somewhere else (`scripts/scratch-dirs.js` owns the location).
>
> Everything in items 1–3 below was re-confirmed and still stands. Item 4 is the
> part that was wrong.

What was established, in order:

1. **The feature gate is real and satisfied.** `[features] hooks = true` in `~/.codex/config.toml`, whose own comment reads *"Hook engine is gated; without this hooks silently no-op."* Present on all three machines.
2. **The file IS parsed.** A user-level `~/.codex/hooks.json` in Claude Code's JSON shape is read and its definitions enumerated — Codex names them internally in **snake_case** (`pre_tool_use`, `permission_request`, `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop`), keyed `'<hooks.json path>:<event>:<group>:<index>'`.
3. **Trust is a real interactive gate, and it is answerable and PERSISTENT.** A new/changed definition makes the next launch stop *before the composer renders* on `Hooks need review — N hooks are new or changed … 1. Review hooks  2. Trust all and continue  3. Continue without trusting`. Digit `2` + Enter answers it. The answer is recorded in `config.toml` as `[hooks.state.'<key>'] trusted_hash = "sha256:…"` and **survives across sessions**: re-creating a byte-identical `hooks.json` raised no prompt at all. Changing only the command string re-prompted, so **the hash covers the command** — and with one identical command registered across ten events the ten hashes still differed, so it folds in the event/index too.
4. ~~**And yet no hook process is ever spawned.**~~ **SUPERSEDED — see the correction above.** The marker-file method was right and is still the right method; the *conclusion* was wrong because the run never started a turn, and `SessionStart` is lazy. The claim inside it — *"it needs no turn to have started"* — is the specific false assumption.

**#78's premise holds.** Hooks are a real channel on this version: richer than OSC 9 (tool names, prompts, transcript paths, session id) where OSC 9 gives only a notification string.

**Item 6 (the fate of OSC 9) is now a genuine choice, not a default.** OSC 9's structural gap stands — it fires on exactly two occasions, an approval and a finished turn, so **`working` is unreachable through it by construction**. Hooks close that gap (`UserPromptSubmit` / `PreToolUse` / `PostToolUse`). Keeping OSC 9 as a zero-install fallback is still defensible; relying on it *because hooks don't work* is not.

**One thing hooks do NOT fix:** a session that has been launched but has not yet taken a turn fires nothing at all, so first-turn status still has to come from somewhere else (or be treated as idle, which it is).

> **Probing this is only safe if you clean up.** An installed-but-untrusted `hooks.json` **blocks every new Codex session** — the same failure class as the `Update available` nag, and fatal for a worker-spawned PTY that has nobody to answer it. Delete the file the moment the probe ends and relaunch once to confirm the composer returns. Strip the `[hooks.state]` entries too: a stale `trusted_hash` silently pre-trusts a matching definition later, with nobody reviewing it.

**Why OSC 9 cannot be retired on its own (#78 item 1):** it fires on exactly two occasions — an approval and a finished turn. **There is no turn-start notification, so `working` is unreachable through it by construction.** That is a structural gap hooks would close, not a deployment bug.

> **Probing this is safe only if you clean up.** `~/.codex/hooks.json` did not exist on any machine; creating one is additive, but it **blocks new Codex sessions from that moment on**. Delete it the instant the probe ends and re-launch once to confirm the composer comes back.

**Status comes from OSC 9 in the PTY — the channel that replaces hooks.** With `tui.notifications = true`, `notification_method = "osc9"` and `notification_condition = "always"`, the Codex TUI writes its notifications straight into the terminal. For a normal user that is the *weaker* channel (it only paints in their emulator — which is why `approval-requested` on the external `notify` program is still an open upstream request: openai/codex #11808, #17716, #19921). For web-terminal it is the *stronger* one, because **`pty-worker.js` is the terminal** and already reads every byte.

- **Measured off a real PTY** (0.144.0, re-confirmed end-to-end on 0.144.6): an approval emits `ESC]9;Codex wants to edit 0 files BEL`; a finished turn emits the agent's last message the same way. The external `notify` program only ever fires `agent-turn-complete` — its payload is `{type, thread-id, turn-id, cwd, client, input-messages, last-assistant-message}`.
- **`notification_condition` defaults to `unfocused`, and a PTY has no focus state** — without `always`, nothing is emitted and the feature looks broken rather than unconfigured. `scripts/install-codex-notify.js` writes all three keys (sibling of `install-statusline.js`); **a COLD restart is required** because this is worker-side.
- **`lib/osc9-notify.js` owns only the byte rule** and buffers across chunk boundaries. A notification fires **exactly once**, so a sequence split across two PTY reads that is dropped is a status that never updates — unlike the api-error sniff next door, which gets away with no buffering because its phrase stays on screen and repeats.
- **What a body MEANS is a registry field** (`statusFromOutput.approvalPattern`), never a branch. A plain shell and every unknown agent default to **not** reading status from output — OSC 9 is a general terminal notification that vim or a build script can emit, and none of them is an agent.
- **Applied through `handleHook`** (an approval IS a `PermissionRequest`, a finished turn IS a `Stop`) so it inherits the idle debounce, held-stop rule and push rather than growing a second status machine. That reuse passes **`hookDriven: false`**: `handleHook` sets `session.hookStatus`, and `isClaudeSession()` reads that flag as proof the session is Claude, which gates the API-error sniff whose recovery **types** `continue` and `/compact` into the PTY. Arming it on Codex would type Claude's recovery into Codex's composer.
- **NOT established:** what a *declined* approval emits. A lone Esc produced no further notification, but Codex's approval UI is a select list, so Esc most likely never answered it — the rig confirmed the session correctly stays `waiting` on a question nobody answered. Note `noteInterrupt` is gated on `working` on purpose, so Esc at a permission prompt is an answer, not an interrupt.

**NEVER copy `~/.codex/auth.json` into a second `CODEX_HOME`.** Codex refreshes on start and the refresh token rotates; the copy triggers "refresh token was already used", and reuse-detection can revoke the whole token family. Use a stub provider (`model_providers.<name>` with `base_url`, `wire_api="responses"` — `"chat"` was removed) and no auth file.

### How to verify Codex behaviour (methods that work)
- **The rollout is ground truth; the screen lies.** Codex writes a user message to its rollout only when a turn actually *starts*. Scraping the TUI cannot distinguish "text sitting in the composer" from "submitted" — reading the rollout can. Assert on the rollout.
- **Probe in an already-trusted cwd that no live session uses.** A fresh directory triggers Codex's trust prompt. A probe run in a live session's cwd writes a *newer* rollout and will hijack that session's Chat lens via `findRolloutForCwd`. Clean up probe rollouts afterwards.
- **Drive the real path, not a reimplementation.** Worker behaviour is testable by spawning `pty-worker.js` on an isolated pipe and sending a real `TYPE_PTY_IN` frame (see `tests/worker-submit-cr.spec.js`); `__testGetWrites` returns the exact bytes written to the PTY.
- **A regression test must fail without the fix.** Flip the registry flag off and confirm the new specs go red before believing them.
- **Trust silently overrides `approval_policy`.** A probe asking for an approval in a *trusted* project (`c:\dev` is trusted here) just runs the command and never prompts. Force the prompt with `-c sandbox_mode="read-only"` and a task that writes — otherwise you "prove" an approval path that never ran.
- **A `-c` override in an autoCommand goes through a SHELL.** `-c tui.notification_method="osc9"` loses its quotes to bash and Codex rejects the bare TOML value at startup. Single-quote the whole override: `-c 'tui.notification_method="osc9"'`.
- **Never key readiness on "esc to interrupt", or on the startup banner.** A cold TUI prints `esc to interrupt` while booting MCP servers, and the npm shim can print a self-update log and exit straight back to bash — both false-positive, and the prompt then goes to the shell where it submits nothing. The banner is worse: `OpenAI Codex (v0.144.0)` was contiguous text in 0.144.0 and is **not** in 0.144.6, so it broke on a routine auto-update. Key on the composer's model/effort line (`gpt-5.5 high`). Codex auto-updates **mid-run** — expect the version to move under you.

### The agent task list (#73) — the issue's premise was inverted

**Check the tool names against real data before building on an issue's description.** #73 is titled after `TodoWrite`, which appears as an actual `tool_use` **zero** times across 400 transcripts — claude-code emits `TaskCreate` / `TaskUpdate` / `TaskList`. And the hard part is the opposite of what the issue assumed:

- **Codex is the easy one.** `update_plan` carries the WHOLE plan every call (`arguments` is a JSON *string* holding `plan: [{step, status}]`), so the newest one in the rollout *is* the current state. Read the tail; remember nothing.
- **Claude is the hard one.** `TaskCreate`/`TaskUpdate` are **deltas**, and **the task id is not in the tool input at all** — it exists only in the result *prose* (`"Task #7 created successfully: …"`; `TaskUpdate` does carry `taskId`, but only because the model was told the id by that prose). Reconstructing the list means folding **forward** from the session start, which a **backward**-paging transcript reader cannot do. So Claude's list is folded from the live hook stream instead.

**`TaskList`'s result is a whole-list snapshot** (`#6 [completed] subject (owner)`) and Claude is explicitly told to call it after finishing a task — that is the **repair path** that makes a fold started mid-session safe, and it is why losing the state on a hot reload is tolerable. Prefer a subject already known from `TaskCreate` over the snapshot's: the line appends ` (owner)` and real subjects end in parentheses too, so stripping it would mangle titles.

**The fold lives in `server.js` beside `pendingQuestion`, NOT in the worker** — deliberately, and against the #61/#65 precedent. It is *derived, repairable* state rather than an authority: it drives no dot and fires no push, so it needs no worker protocol change and no cold restart. If it ever gains such a job, it belongs in the worker.

**An update for a task whose create was never seen still renders** (as `Task #<id>`). Dropping it would hide in-progress work, which is the single thing the panel exists to show.

### Deployment consequence
Anything touching `pty-worker.js` (including `lib/agents.js` fields the worker reads) needs a **COLD restart** — a hot `server.js`-only reload leaves the old worker running with the old behaviour. See "Deployment & Operations".

## Input & Submit Contract (issue #55) — this is law, not guidance

The sentence *"Enter doesn't run it"* has described at least four **different** bugs in different layers. A change to input or submit is correct only if it satisfies the rules below, and each rule has a test that fails without it. Full spec: issue #55.

**Compose bar = the app's text box.** Not the agent's own TUI prompt. **Submit = the agent actually starts a turn** — text appearing in its prompt box is *not* submit.

### The keyboard contract — chosen by PLATFORM, never by lens
Chat and terminal lenses share one compose bar with one set of keys.

| Platform | Enter | Ctrl+Enter | Send button |
|---|---|---|---|
| **Desktop** (hardware kbd) | **Submit** | Newline | Submit |
| **Mobile** (soft kbd) | **Newline** | (n/a) | **Submit** |

Mobile is Send-only because the **Android IME commits Enter as literal `"\n"` *text*, not a key event** — a submit bound to an Enter *keydown* is unreliable by construction there. The gate is `composeUsesSoftKeyboard()` (companion `compose_bar.dart`; `app.html` mirrors it off the UA). In `app.html`, **visibility** of the bar is keyed on `isMobile`, which ORs in `innerWidth < 600` — so a narrow *desktop* window shows the bar and must still submit on Enter. Visibility ≠ platform; do not collapse them.

The bar is **multi-line** (`minLines:1, maxLines:5`), soft-wraps, and a wrapped line contains **no** `\n`.

**A widget test cannot prove any of this.** Synthetic key events never traverse the OS text-input path, so a widget test passes while the shipped app is broken. Desktop Enter needs real injected OS keystrokes (`scripts/rig/probe-drive-windows.ps1` + `tool/compose_probe.dart`); mobile needs a real device.

### Client-side encoding — `buildComposeSubmission` (one function per client)
1. Strip a **trailing** newline. 2. If a `\n` **remains** → `ESC[200~` + text + `ESC[201~` + `\r`. 3. Else → text + `\r`. 4. Send as **ONE** frame (#44: a client that dies mid-submit must not lose half of it).

A live `/`-line streams to the PTY as you type so the agent's slash menu narrows. That prompt is **one line**, so `composeLiveProjection()` **drops newlines** — mirroring one as `\r` would *submit*, which is exactly how Enter came to fire a `/`-line on mobile while merely newlining everywhere else.

### Server-side delivery — the SSOT, and where the real bug lived
**Every agent TUI folds one read into a paste and swallows a trailing CR.** Codex does it at any length (`paste_burst.rs`); **Claude does it too** — it just needs a bigger read to trip it. Measured against the real Claude TUI, atomic `text\r` in ONE write:

| chars | atomic `text\r` | CR split off |
|---|---|---|
| 20 / 40 / 60 | submitted | submitted |
| **80 / 120** | **NOT submitted** | submitted |

That single fact explains the whole "sometimes Enter works, sometimes it doesn't" class of report: **a short test prompt submitted, and a real one was typed into the prompt box and never sent.** Claude looked exempt for months because every quick test was short.

- The **worker** owns submit timing. Clients stay unaware and unchanged.
- A frame that is **text ending in `\r`** is split: write the text now, write the lone `\r` after `submit.gapMs`. Input arriving in the gap **queues behind** it (order preserved).
- A **bare `\r` on a cold PTY is never split** — nothing was just written, so nothing can absorb it. So ordinary char-by-char shell typing is never rewritten and never delayed.
- **The gap is measured against the wire, not against the frame.** A bare `\r` written within `submit.gapMs` of a frame that **closed a bracketed paste** IS withheld, and goes out alone after the gap. The burst detector reads bytes; our frame boundaries are invisible to it, so two frames microseconds apart are one read and fold together. This is not a hypothetical — it is the images-only submit: the compose bar sends each staged image as its own `ESC[200~<path>ESC[201~` frame, and with no prompt text the submit behind it is a bare CR. With text it was always fine (`text\r` splits), which is exactly why "attach an image and press Send" typed the image and sent no Enter while every other prompt worked. Keep it **narrow — only a paste close shades a CR**; widening it to "any recent write" would delay every shell Enter, and short non-paste reads are measured to submit fine.
- Bracketed paste does **not** exempt the CR. Measured: ≤30 ms is still absorbed, ≥60 ms submits. **Only a real temporal gap works — never "fix" a submit problem by changing the bytes.**

### Interrupt (Esc) — status must go idle promptly
Claude fires **no hook** on a user interrupt (`Stop` does not run), and worker status is otherwise hook-driven — so an interrupted session sat on "Claude is working" until `correctStaleStatus` rescued it **5 minutes** later. But the **worker writes the Esc byte itself**, so it is the one component that can know: a **lone `0x1b`** (`isEscapeKey` — length 1, so an arrow's `ESC [ A` never counts) sent to a **`working`** session flips it to idle at once. Gated on `working` on purpose: Esc at a permission prompt (`waiting`) *rejects the tool* and Claude carries on. No push fires — the user is the one who pressed Esc.

### Where it lives (no branching, ever)
`lib/agents.js` — the registry: each provider declares `submit: { gapMs, crBurstsAsPaste }` and `interrupt: { onEscape }`. A **plain shell declares `onEscape: false`**, so Esc in vim/less is never read as "the agent stopped". `lib/submit-frames.js` — the pure byte rules (`splitTrailingCr`, `isEscapeKey`). `pty-worker.js` — applies them where bytes meet the PTY. **An `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html` or the companion means the change is in the wrong file — add a registry field instead.**

### How to verify (no production cold-restart to test a hypothesis)
`node scripts/rig/rig.js up` runs a complete, **isolated** web-terminal (port 7999, own worker pipe, own data dir, own config) from the working tree — it cannot touch production. `node scripts/rig/verify-submit.js` proves a LONG prompt actually submits, end to end. **The PTY/rollout is ground truth; the screen lies** — Claude echoes a submitted prompt back into its transcript, so "is the text still visible" cannot distinguish *typed* from *submitted*. The only valid detector is **"did a turn start"**.

### A spawned agent is NOT ready when its session is (#147)

Submit has a precondition the contract above assumed: **the agent has to exist.**
A new session drops the user into the chat lens seconds before `claude` boots, and
until its composer is up the PTY is still sitting at the **shell** — so a prompt
sent in that window is handed to bash, runs as a command or does nothing, and is
gone with no error anywhere. Reported 2026-08-20 on the phone, the tablet and the
Windows desktop *at once*, which is what located it as a missing **server** signal
rather than three client bugs.

Measured with `scripts/rig/probe-claude-ready.js` against claude 2.1.237, verdict
taken from **"did a turn start"** (the screen cannot tell a typed line from a
submitted one — that is why this survived):

| | run 1 | run 2 |
|---|---|---|
| bash prompt | 3.3s | 3.3s |
| `claude` typed | 3.7s | 3.7s |
| **composer caret** | **5.0s** | **6.1s** |

`submit before the caret -> NO turn started, bash printed "command not found"`
`submit after  the caret -> a turn started`

**That 1.1s spread on ONE machine is the whole argument for a marker over a
timer.** A timer tuned to the fast boot eats prompts on the slow one; one tuned to
the slow boot makes every session feel broken.

The marker is a **registry field** (`lib/agents.js` → `readiness.composer`), the
rule is pure (`lib/agent-ready.js`), and `pty-worker.js` applies it where bytes
meet the PTY — the same shape as submit and interrupt. **Codex deliberately
declares none**: its candidate has not been measured against a real boot, and an
unmeasured marker is exactly what #143 shipped. Undeclared means *ready
immediately* — today's behaviour, unchanged.

**It can never wedge, by four independent routes**, because a session stuck on
"starting" would be worse than the bug: any hook forces it ready (an agent that
fired one is up, whatever its screen did); a restored session is seeded from its
scrollback (an agent running for hours will not reprint its marker); a plain shell
and every unknown agent are ready from birth; and both `server.js` and the
companion read a missing field as **ready**, so an older worker or an older server
never refuses a submit.

The client gates **submit only** — typing is untouched and the text stays in the
box. It is **not** auto-sent on ready, on purpose: firing a prompt somebody was
still editing is its own way to lose their words.

> **Not yet done:** `app.html` is ungated. It keeps no session-state map to hang
> `agentReady` on, and the report was companion-only — so the web client can still
> type a prompt into a booting agent.

## AskUserQuestion — the LAYOUT decides what the keys mean (#19)

Answering Claude's question overlay drives its real TUI selector by writing keys
into the PTY, and **the same digit does three different things depending on the
layout Claude picked**. The layout is not cosmetic and it is not guessable, so it
travels on the wire: `_shapeQuestions` publishes **`hasPreview`** per question and
`buildAnswerFrames` is the one place that turns it into keys.

**The rule.** When any option of a question carries a `preview`, that question
renders **side-by-side** (options left, preview box right); otherwise it renders as
a **compact** list. Layout is per **QUESTION**, not per prompt — measured against
claude 2.1.220, a previewed Q1 rendered side-by-side while the same prompt's
preview-less multi-select Q2 rendered compact.

| question | compact | side-by-side (`hasPreview`) |
|---|---|---|
| single-select, **one** question | digit submits; a trailing Enter is a measured no-op | digit only MOVES the highlight; **Enter commits** |
| single-select, **multi**-question | digit selects **and auto-advances** the tab — an extra Enter would commit the NEXT tab's default row | digit advances nothing; **Enter commits AND advances** |
| multi-select | digits toggle and stay; **Right-arrow** advances (Enter would toggle) | n/a — previews are not supported on multi-select |

So a compact tab of a multi-question prompt must get **no** Enter and a previewed
one **must**. That is a branch, never an unconditional trailing Enter — the
compact layout is measured to answer correctly without it.

**This produced a real bug twice, in the same shape.** Reported 2026-08-03: *"the
chat lens didn't fill the multiselect part at all even I see and mark it. I had to
do it on terminal."* The prompt was a previewed single-select Q1 plus a
multi-select Q2, so every key meant for Q2 landed back on Q1, Q1 submitted blank,
and the trailing Enter toggled whichever Q2 row the cursor happened to sit on.
The earlier single-question half of the same rule is #84.

**Verify with `scripts/rig/probe-askq-layout.js`** — it spawns the real `claude`
on a real PTY, drives a candidate key sequence and reads the verdict from the
transcript's `tool_result`. **Never assert on the screen: it cannot tell
*highlighted* from *submitted*.** A **pending** question is not in the transcript
at all (the `tool_use` is written only once answered), so "nothing recorded" and
"not yet answered" look identical — assert on *which option came back*. Measured:

```
preview-mq  2,1,3,→,\r     -> Q1 BLANK, nothing submitted   (the bug)
preview-mq  2,\r,1,3,→,\r  -> "Pick a color"="Green", "Pick fruits"="Apple, Cherry"
plain-mq    2,1,3,→,\r     -> "Pick a color"="Green", "Pick fruits"="Apple, Cherry"
```

The last line is the regression guard: it must keep passing **without** the extra
Enter, which is why the fix is a branch on `hasPreview` and not a blanket Enter.

The preview **body** is deliberately not forwarded — it is free-form, can be large
and nothing renders it. Only the fact that one exists crosses the wire.

## Auth System
- Cookie-based session auth (primary, for browser users)
- Bearer token auth (for cluster inter-server communication)
- Tokens stored in `api-tokens.json` (gitignored)
- Cluster remote tokens stored in `cluster-tokens.json` (gitignored)
- Each server in cluster has independent credentials

## Key Security Rules
- Never expose passwords in API responses (always mask as `***`)
- API tokens have 90-day expiry
- Rate limiting on login attempts
- All new API routes MUST be behind auth middleware
- WebSocket auth supports both cookie and query-string token
- Cluster proxy MUST validate stored token exists before forwarding
- Never pass unsanitized user input to `term.write()`, `execFile()`, or HTML

## Test Config
- Tests run on port 17681 with credentials: testuser / testpass:colon
- Uses Playwright for both API and browser tests
- Test config in `playwright.config.js`
- Tests backup/restore config.json but overwrite the password hash — re-apply the correct password after running tests

## Deployment & Operations
- Server auto-starts on boot via scheduled task or Startup shortcut — both use `wscript.exe` + `start-server.vbs` to run hidden (no console window flashing)
- **A cold restart is gated on the runtime deps loading — and that gate exists because it once turned a wedge into an outage.** `scripts/cold-restart.ps1` runs `scripts/check-deps.js` (it *loads* `node-pty` / `express` / `express-ws`, since `require.resolve` succeeds on a package whose native binding is broken) **before the first kill**, and aborts without touching anything if they fail. Rationale: a running Node process serves already-loaded modules from **memory**, so a box whose `node_modules` was destroyed hours ago still answers HTTP 200 and still streams PTYs — while a fresh worker cannot even start (`Cannot find module 'node-pty'`, exit 1), the monitor burns its 5-crash budget and exits, and `server.js` goes with it. **A wedged worker still owns live PTYs; a monitor that gave up owns nothing.** Use `scripts/cold-restart.ps1 -CheckOnly` to audit a peer's tree over `/api/exec` without disturbing it.
  - **NEVER junction or symlink `node_modules` into a git worktree.** `rmdir /s`, `Remove-Item -Recurse` and `git worktree remove --force` all **follow a directory junction and delete the target**. On 2026-07-30 a session did exactly that — `mklink /J <worktree>\node_modules C:\dev\web-terminal\node_modules`, then tore the worktree down — which gutted production (`express` gone, `node-pty` left without `package.json`/`lib`), stalling on the files the live worker held open. Give a worktree its own copy, or invoke the real path (`node ../../node_modules/@playwright/test/cli.js`). To remove an existing junction, delete the **link** with bare `cmd /c rmdir <link>` (no `/s`).
  - **Symptom to recognise:** `/login` returns 200 while everything stateful times out, `error.log` floods with `RPC listSessions timed out after 30000ms` whose *first* entry is `Failed to create session`, `worker.log` stops dead at that instant, and the worker sits at **0% CPU** with a child `OpenConsole.exe` that has no `bash.exe` sibling. That is a blocked worker event loop, not a network or auth fault. Recovery: stop the worker (that releases the lock), `npm install`, relaunch — killing the stillborn `OpenConsole.exe` does **not** help.
- **Cold-restart practice — when running a cluster, drive a server's restart from a *different* server via its `/api/exec` endpoint** (authenticated with that peer's bearer token). This isolates the kill logic from the process being killed, so a bug in the kill script can't silently leave the target offline. Do it in two phases: (1) `git fetch --all && git pull --ff-only` and verify the new `SERVER_VERSION` on disk (non-disruptive, safe to retry); (2) a detached PowerShell script that kills monitor + worker + server and relaunches `start-server.vbs`.
  - The kill filter must match `server.js` / `pty-worker.js` by their full path with `-like` (NOT `-match` — the `\p` in `pty-worker.js` is read as a malformed `\p{...}` regex Unicode class). `monitor.js` has no path in its CommandLine, so identify it by the ParentProcessId of the matched server/worker rather than by name.
  - Because the `/api/exec` request runs *inside* the server being killed, the request dies mid-response. Write the kill script to a temp file and launch it detached (`start /b powershell -WindowStyle Hidden -File ...`) so it survives the parent's death.
- **To restart manually without a driver (last resort only):**
  1. Identify the monitor and server PIDs:
     `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap"`
  2. Kill ONLY the monitor.js and server.js PIDs (do NOT use blanket `taskkill /F /IM node.exe` — it kills MCP servers, PM2, and other unrelated node processes, and may fail to kill the monitor before the new one starts):
     `powershell -NoProfile -Command "Stop-Process -Id <monitor_pid>,<server_pid> -Force"`
  3. Wait 2-3 seconds for ports to release, then start fresh:
     `wscript start-server.vbs`
- **NEVER use `taskkill /F /IM node.exe` to restart** — this is a blanket kill that races with the VBS launcher and can leave an old monitor alive while starting a new one, causing a dual-monitor crash loop (both monitors fight over port 7681, each restart spawns pty sessions that flash console windows)
- **Bash shell flag escaping:** In Git Bash, Windows flags like `/F` are interpreted as Unix paths. Use double slashes: `taskkill //F //IM node.exe`. Or use PowerShell commands instead.
- **NEVER run `node server.js` or `node monitor.js` directly** — console-subsystem executables flash windows on Windows. Always use the VBS launcher
- Session 0 (scheduled task with S4U) may have a stale PATH — if CLI tools aren't found in spawned terminals, kill node.exe and run `wscript start-server.vbs` from a user session instead
- Server listens on port 7681, config in `config.json` (gitignored password hashes)

### Windows Console Flashing Prevention
Three layers prevent console window flashing on Windows:
1. **VBS launcher** (`start-server.vbs`) — `wscript.exe` is a GUI-subsystem exe, launches node hidden (window style 0)
2. **`useConptyDll: true`** in `pty.spawn` — uses the bundled `OpenConsole.exe` instead of the system ConPTY API (which on Windows 11 delegates to Windows Terminal, causing visible flashes)
3. **`windowsHide: true`** on all `execFile`/`execSync` calls — prevents git, powershell, and other child processes from creating console windows

## Development Rules
- **Every code change must be backed by tests** — write failing tests first, then fix, then verify all tests pass
- **Never stop or restart the production server** without explicit user permission
- **All tests must pass before committing** — no exceptions
- **No secrets in commits** — passwords, tokens, API keys must never appear in tracked files
- **No personal info in tracked git** — personal data, machine-specific paths, and user-identifying info must stay out of version control

## Testing Notes
- `diagnostic.spec.js` and `mobile-debug.spec.js` require special env vars/setup and are excluded from default `npx playwright test` runs
- `diagnostic.spec.js` needs `DIAG_PASS` env var and its own config: `DIAG_PASS=yourpass npx playwright test tests/diagnostic.spec.js --config playwright.diag.config.js`
- Tests run serially (`workers: 1`) because the max session limit (10) causes flaky failures when tests create sessions in parallel
- **The suite is NOT flaky — it was a real bug, now fixed.** The server binds `127.0.0.1` while the suite addressed `localhost`, which resolves to `::1` first; the first connection of a run surfaced `ECONNREFUSED ::1:17681` on whichever spec sorted first, so a *different* spec failed each run. Everything in `tests/` and `playwright.config.js` now uses `127.0.0.1` and an explicit `url:` readiness probe. If a spec fails intermittently, look for a real cause — do not write it off as flake
- A one-off subset run (`npx playwright test a.spec.js b.spec.js`) can still hit a `webServer` startup race that the full suite does not. Confirm any single failure by re-running that spec alone before investigating it
- The `conpty_console_list_agent.js: AttachConsole failed` errors in test output are harmless node-pty warnings when killing sessions in Session 0 / test environment
- GitHub repo: `Adiel-Sharabi/web-terminal`

## Issue Workflow
When working through GitHub issues, use this process:
1. `gh issue list --state open` to check for new issues
2. Read each issue, assess clarity — comment if unclear
3. Reproduce the bug before fixing (do not fix what you can't reproduce)
4. Write tests first, then fix, then verify all tests pass
5. Use sub-agents for individual issue fixes to keep the orchestrator context clean
6. Commit and push when all tests pass

## Cluster
- `config.json` has a `cluster` array of `{name, url}` servers and a `publicUrl` for the local server
- `/api/cluster/sessions` merges local + remote sessions — must skip fetching from servers whose URL matches `publicUrl` to avoid session duplication
- Cluster auth tokens stored in `cluster-tokens.json`
- `passAllEnv` config option (default false) controls whether spawned shells get full or limited environment variables

## Engineering Standards (shared, non-negotiable)
@docs/ENGINEERING_STANDARDS.md
