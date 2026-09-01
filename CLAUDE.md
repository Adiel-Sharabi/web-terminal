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
- `lib/submit-confirm.js` — the pure rules for VERIFYING that a submit reached the agent (#179): the gates deciding whether a submit is watched at all, and the line tracker that tells a prompt from a slash command. Its header carries the measurement that ruled alt-screen OUT as a blocked-state marker
- `lib/terminal-size.js` — the pure shared-PTY size rule (#146/#59): one PTY, many viewers, and the SMALLEST ACTIVE viewer wins. Applied in `server.js`, which owns the sockets (the worker only ever sees a count), so it hot-reloads
- `lib/scrollback-window.js` — the pure content-anchored scrollback walk (#178). **Served to `app.html` at `/lib/scrollback-window.js`** so the browser runs the same bytes `tests/scrollback-window.spec.js` pins, rather than a pasted copy. A port of the companion's `ai-terminal/lib/util/scrollback_window.dart` (#167), which stays the canonical write-up of the rule
- `lib/task-list.js` — the pure task-list rules (#73): status normalisation, the Claude delta fold, the Codex plan snapshot. See "The agent task list" below
- `lib/user-turn.js` — **the one owner of what a `role:user` turn IS**: `classifyUserTurn` (which turns a human actually TYPED) and `typedTextOf` (the characters they typed, which the chat lens's Queued echo matches on, #149). Its only import is the leaf `lib/ansi.js`, so `lib/transcript.js` can still use it without a require cycle
- `lib/ansi.js` — **the one owner of the escape-stripping rule** (`ANSI_RE`, `stripAnsi`), imported by `lib/transcript.js` (which re-exports it for `lib/speech.js` and `lib/transcript-codex.js`) and by `lib/user-turn.js`. A leaf: it requires nothing, so it cannot reintroduce a cycle. It exists because #192 briefly added a THIRD copy that had already drifted — `[0-9;?]` params instead of ECMA-48's `[0-?]`, letting a colon-form `ESC[38:5:196m` through a strip that claimed to remove it
- `lib/recap.js` — the pure session-recap rules: `condense`, `toolTally`, `summariseTasks`, plus a re-export of `lib/user-turn.js`'s `classifyUserTurn` for its existing importers — **change the rule in `lib/user-turn.js`, never here**. Serves `GET /api/sessions/:id/recap`. See "The session recap" below
- `lib/notification-shape.js` — the pure rules for a Claude `Notification` hook (#194 Gap 1): `classifyNotification` (permission / idle / **benign** / **unknown** — the last two were one silent `drop`), plus the redaction and rate rule for logging an unknown one. **Instrumentation only — it deliberately changes no behaviour**: `correctStaleStatus` gives a `waiting` session 12h against 5m for a `working` one, so promoting an unrecognised notification to a permission ask on a guess would park a session on a false "waiting" for half a day
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

## Scrollback has TWO byte spaces, and they diverge at the HEAD (#167/#176/#178)

**A byte offset into a session's scrollback is not a position.** `pty-worker.js`
trims the buffer's HEAD on every PTY write (2 MB cap), so `offset 0` names a
different byte on every request while `total` sits pinned at the cap — and
nothing on the wire says so. Every paging bug in this area (#167 on the
companion, #178 on `app.html`) is that one fact, met from a different direction.
The rule everywhere is now: **anchor on CONTENT, over-fetch so the anchor is
inside the slice, cut where it reappears, and STOP rather than guess** — the
failure mode is less history, never history that repeats and never a silent hole.

**And the server builds two DIFFERENT strings from that one buffer:**

| | how it is built |
|---|---|
| the WS attach replay (`server.js` ~:5204) | **truncate** the raw buffer to `scrollbackReplayLimit`, **then** `sanitizeReplay` |
| `GET /api/sessions/:id/scrollback` (~:4729) | `sanitizeReplay` the **whole** buffer, **then** slice by `offset`/`limit` |

`sanitizeReplay` is length-changing **and stateful** — it tracks alt-screen from
the start of whatever string it is given — so those two orders are **not**
equivalent. Measured 2026-08-27 against a live server, comparing the two over the
same buffer:

| content | replay is an exact substring of `/scrollback` | common **suffix** run |
|---|---|---|
| plain text | **yes**, at exactly `httpLen - replayLen` | 32768 / 32768 |
| escape-heavy (DA/DSR/ED + alt-screen) | **no** | **30947 / 31517** |

The escape-heavy divergence is at the **head**, and its mechanism is exact: the
truncated copy begins mid-stream, never sees the earlier `ESC[?1049h`, believes it
is outside alt-screen, and strips an `ESC[2J` the whole-buffer pass keeps.

**So: they agree over the TAIL and disagree near the HEAD.** Any rule that has to
line the two up must take its anchor from the **end of what is on screen**, never
from the head of an incoming replay — which is exactly what
`ai-terminal/lib/util/attach_overlap.dart` does (#176), and why
`tests/attach-replay-overlap.spec.js` pins the invariant **on the server**, with a
2x margin over the companion's 4096-unit anchor. That gate is server-side on
purpose: reordering either sanitise pass is a server change, and it would
otherwise surface only as #176 coming back on a client nobody was testing.

The attach replay also carries an `ESC[?2004h` prefix when the session is in
bracketed-paste mode (`pty-worker.js`). That is terminal **state**, not content —
it is not in the scrollback and can never match an anchor, so a cut must preserve
it rather than treat it as duplicate bytes. It is why the measured replay was
32776 and not 32768.

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

**The cap itself is NOT a prompt — it is a rollout error, and that is the exact opposite of Claude (#142).** Claude presents an *answerable selector* at its cap, which is why the registry gives it a `usageLimitPrompt` and `pty-worker.js` answers it by writing a digit. Codex presents **nothing to answer**: the turn simply ends, and the rollout records an `event_msg` → `task_complete` carrying `error.codex_error_info: "usage_limit_exceeded"` with `last_agent_message: null`. Captured on a fleet server **2026-08-02** (`used_percent: 100.0`, `window_minutes: 10080`, `credits.has_credits: false`, `plan_type: "plus"`). So a `usageLimitPrompt` for Codex is not merely unmeasured — it is **the wrong shape entirely**, and a PTY-scanning matcher would wait forever for bytes that never come; the detectable signal is the rollout error, which `readMetrics` already opens the right file for. **Two limits on that capture, both load-bearing:** it is the **7-day** window (`10080`), not the 5h one, and the account also had zero credits — so it is "weekly cap + no credits", not necessarily a plain 5h cap. And **nobody has ever hit Codex's 5h cap on this fleet** — measured peaks 34% / 72% / 2% across 118 rollouts on the three machines — so #142 does not unblock by waiting, and `autoResume: { arm: false }` stands until either the 5h shape is captured or the non-blocking failure is judged not worth resuming from at all. That last point is the real question now: **Claude's auto-resume exists because a capped Claude session sits BLOCKED**, and a capped Codex session returns to its composer instead.

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

### The wire cap and the offline-buffer ceiling are ONE number (#201)

`WS_INPUT_MAX` (`server.js`, per frame) and the companion's `_inputBufferHardCap`
(`api_client.dart`, total) are both **256 KB in UTF-16 code units** and are equal by
construction: **nothing the offline buffer can hold within its ceiling may be refused at
the wire.** The `65536` that stood there until #201 was an inherited default (commit
`a96e7ba`, 2026-03-23) which also bounded no memory — `ws` assembles a whole message
before `handleMessage` runs, so the bound that bounds is **`WS_MAX_PAYLOAD` (4 MiB), now
set in `wsOptions`**. It is **16x the app cap** — about 5.3x the app cap's worst-case
byte width (256 KB x 3 = 786,432; three is the most UTF-8 bytes one BMP code unit can
take). The gap is wide rather than snug because `ws` answers an oversize frame by
**closing the socket**, not by letting the app send its `inputDropped` notice, so the
zone between the two caps is where an accidental oversend is still reported honestly.
`scripts/check-shared-constants.js` fails the build if the pair drifts.

**#204 — and every refusal now SAYS SO, which is the rule that was actually being
broken.** #193's principle is that dropped input must be visible; two paths never
honoured it, and #201 made one of them reachable.

- **The companion refuses at the APP cap itself** (`sendInput`, before the
  live/buffered branch), reporting on the same `inputDropped` stream. That makes
  `WS_MAX_PAYLOAD` **unreachable from that client** — strictly better than defending
  against it, because *a refusal by the APP keeps the socket and the session; a refusal
  by the TRANSPORT costs the connection.* The comparison is `>`, matching the server's
  `msg.length > WS_INPUT_MAX` exactly: a write **at** the cap is legal on both sides,
  and over-refusing would be the same silent loss in the other direction. One number
  serves both roles (per-frame wire cap, whole-buffer total) because the #201 invariant
  makes them one number; a second Dart constant would be a third copy of the value whose
  whole problem was that its copies looked independent.
- **`app.html` is NOT gated and still can reach that band.** It has a dozen scattered
  `ws.send(...)` sites and no single input path, so there is nowhere to put the check
  without first building one. Recorded at the `server.js` cap block, because the server
  cannot tell which client is talking to it.
- **The cluster proxy tells the browser when its reconnect buffer refuses a write** —
  the remote link is what is down, `localWs` is open throughout. **Once per outage, not
  once per keystroke:** the buffer LATCHES (#201), so everything after the first refusal
  is refused for the same reason, and a banner per character is noise that teaches you to
  ignore the one that mattered. The reporting rule therefore lives with the latch in
  `lib/reconnect-buffer.js` (`decide`) rather than as an `if` beside it.

**`WT_CLUSTER_TOKENS_FILE`** exists so that regression test can write a cluster entry
pointing at a dead port. `cluster-tokens.json` holds a live bearer token for **every peer
in the cluster**, and a backup/restore around the test is not enough — a suite run that is
SIGTERM'd part-way (what happens when the full suite outlives a 10-minute tool ceiling)
never reaches its restore. Redirect the path and the real file is never opened.

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

**The scan does not start until the launch command has been written.** Before
that the PTY is showing the *shell*, and `❯` is the default prompt glyph of
starship, pure and several oh-my-posh themes — on such a box the latch would flip
before the agent was even launched and the gate would silently no-op. A session
with **no** `autoCommand` is never gated at all: it is a shell until you type
something, and gating it would block the very submit that types `claude`.

**It can never wedge**, because a session stuck on "starting" would be worse than
the bug: any hook forces it ready; a **45s fallback** (`WT_READY_FALLBACK_MS`)
forces it if no marker ever arrives, which is the only thing that covers `claude:
command not found` or a crash on launch; a plain shell and every unknown agent are
ready from birth; and `server.js`, `POST /api/sessions` and the companion all read
a missing field as **ready**, so an older worker or an older server never refuses a
submit. The fallback is a **ceiling, not a detector** — the marker is still the
signal, and 45s sits far above the measured 5–6s boot so it cannot race a
slow-but-working start.

> **A restored session is NOT seeded from its scrollback**, and the first cut of
> this got it backwards. Restore does not reattach anything: it spawns a **fresh
> shell** and re-runs `claude --resume <id>`, which boots *slower* than a cold
> start. Seeding from the old scrollback — which still holds the previous life's
> marker — marked every restored session ready at t=0, so the gate was dead after
> every cold restart, including the one this change itself needs to deploy.

> **Two known gaps, both recorded rather than guessed at.**
>
> 1. The latch is one-way and does not reset when the agent **exits** back to its
>    shell (`/exit`, Ctrl-D, a crashed TUI). That session keeps reporting ready, so
>    a later submit reaches bash — #147 again, further along.
> 2. `❯` is also the default PS1 of starship, pure and some oh-my-posh themes.
>    Arming after the launch write stops the shell's *first* prompt from counting,
>    but not one printed straight after a launch that **failed** — there the latch
>    flips in milliseconds and never reaches the 45s fallback. **Measured
>    2026-08-20: not live on this fleet** — Git Bash's PS1 ends in `$` and a failed
>    launch prints `bash: …: command not found`.
>
> Gap 2 is **narrowed by #190** — those themes print `❯` + an ordinary U+0020,
> which the new marker rejects. **Inferred, NOT measured:** no such theme was run,
> because none is installed on this fleet. By this repo's own standard that is a
> reasoned expectation, not a captured fact. Gap 1 stands unchanged.

### The marker is `❯` + U+00A0, and the bare caret was a real bug (#190)

> **It is a dialog FAMILY, not one dialog.** Review of PR #202 measured a THIRD
> sibling while checking the marker: opening a fresh cwd under a checkout that has
> a `CLAUDE.md` parks on **"Allow external CLAUDE.md file imports?"** — the same
> shape exactly (unnumbered, `❯` then CHA, no spaces anywhere, `Enter to confirm`,
> and a **refusing default row**: "No, disable external imports"). The new marker
> correctly does not match it; **the old bare caret did**, so #202 fixes this one
> too, un-asked.
>
> **This breaks the "trust is inherited" reassurance.** Folder trust really is
> inherited — nothing under a trusted `C:/dev` raises the TRUST prompt — but that
> is trust-specific. A descendant of a trusted directory can still park on the
> imports selector. So "the tree is trusted" is **not** the same as "no selector
> will block a new session", and any test that relies on the first to mean the
> second is wrong. When #194 Part 1 builds the surfacing, target the family by
> shape (`❯` + CHA, no spaces, `Enter to confirm`), not the trust prompt alone.


The measurement the block above deferred is done (`scripts/rig/probe-trust-prompt.js`,
claude **2.1.251**). **The composer writes the caret followed by U+00A0 NO-BREAK SPACE.**
That is a 5-byte marker, well inside `lib/agent-ready.js`'s `CARRY_BYTES`, so nothing
there changes.

It was not a tidy-up. **Claude's folder-trust dialog draws the same `❯` as its selection
cursor**, so the latch flipped on a session parked at a *selector*, published it ready,
and cleared the client to submit into it.

| case | `❯` | `❯`+NBSP | `⏵⏵` | `───` | `Try` | `agents` |
|---|---|---|---|---|---|---|
| composer, 120 cols | yes | **YES** | yes | yes | yes | yes |
| composer, 52 cols | yes | **YES** | yes | yes | yes | **no** |
| composer, `--permission-mode default` / `plan` | yes | **YES** | **no** | yes | yes | yes |
| trust dialog, 120 / 52 | yes | **no** | no | yes | no | no |
| bare shell | no | **no** | no | no | no | no |

Every alternative died in that table, which is why none is declared: `⏵⏵` is
**mode-dependent** (absent in default mode; plan mode prints `⏸`), the `───` rule is
drawn by the trust dialog too, `Try` is the rotating empty-composer placeholder, and
`agents` is **truncated away at 52 columns** — a phone-only regression of exactly the
#146 shape. `effort` matched only via this fleet's own statusLine script.

**A restored session still latches**, measured rather than assumed, because the opposite
answer would have been worse than the bug: `claude --resume <id>` prints the marker
~1.1s after the launch write at both widths, confirmed through a real cold restart. A
resume against a **missing** conversation prints `No conversation found with session ID:
…` and returns to the shell with **no caret at all**, so the 45s fallback still owns
that case — unchanged in width, since the bare caret did not match there either.

> **Write it as escapes; keep the source ASCII-only.** A literal U+00A0 is invisible in
> a diff and is normalised to an ordinary space in transit — four attempts to write the
> escape form into the probe silently came back as a literal, and the marker line itself
> landed as a literal on the first edit. Nothing non-ASCII means nothing to normalise.
>
> **And the NEGATIVE test is the load-bearing one.** If normalisation hits the rule and
> a literal in the test together, the positive assertion still passes — both sides became
> ordinary spaces. Only *"must NOT match `❯` + U+0020"* goes red. Demonstrated, not
> reasoned: `tests/composer-marker.spec.js` builds both characters with
> `String.fromCodePoint` for exactly this reason. **Version drift is uncatchable by any
> unit test** — a claude release that changes the glyph or the spacing needs a rig
> re-probe.

### Claude's folder-trust dialog is a THIRD layout, and a submit there KILLS the agent (#190)

Neither #19's compact (digits) nor its side-by-side (a preview box). It is an
**unnumbered, arrow-driven list**, and **the default row is the destructive one**:

```
 Quick safety check: Is this a project you created or one you trust? …
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
```

So `↓` then Enter answers it — verdict from `hasTrustDialogAccepted` on disk plus "did a
turn start", never the screen. Driven, every other candidate **exited to bash**: a digit
(there are none to press), a bare Enter, and — the reported case — **a real prompt
followed by its submit CR**. That last one is why this is worse than #190's own premise:
the words are not merely eaten, the trailing CR confirms `No, exit` and **the agent is
gone**, so the *next* prompt goes to the shell. `--dangerously-skip-permissions` does not
suppress it.

**The dialog emits NO SPACES.** Every word is positioned with CHA — the bytes are
`\e[2GQuick\e[8Gsafety\e[15Gcheck:\e[22GIs\e[25Gthis…` — so an ANSI-stripped stream reads
`Quicksafetycheck:Isthis…` and **any matcher must reconstruct columns first**. The
longest contiguous literal in the whole dialog is one word. No alt-screen and no
distinguishing DEC mode accompany it, so #179's finding holds: there is nothing to key on
but the text.

> **Trust is INHERITED by descendants**, which is a hard constraint on ever testing this:
> an ancestor of the scratch parent is already trusted, so **nothing `scripts/scratch-dirs.js`
> creates can ever show the prompt** — the rig's own cwd included. A reproduction needs a
> cwd with no trusted ancestor. And `hasTrustDialogAccepted: false` does **not** mean
> untrusted: 18 of 87 entries were false, including directories in daily use.

**Deliberately NOT fixed here:** detecting the dialog, withholding the 45s fallback,
surfacing it in the chat lens, auto-answering. #190 and #194 Part 1 both want the
surfacing built once. The right design is **refuse-and-explain** rather than delay — a
false refusal costs a message, a false permit costs the agent.

The client gates **submit only** — typing is untouched and the text stays in the
box. It is **not** auto-sent on ready, on purpose: firing a prompt somebody was
still editing is its own way to lose their words.

The **live `/`-line is gated too**, not just submit. That path writes bytes *as
you type*, so a `/co` typed in the first seconds landed on bash's command line and
the worker then typed `claude --resume …` onto the same line — running
`/coclaude --resume …`, which starts no agent at all. Gating submit alone left a
failure worse than the one being fixed.

> **Not yet done:** `app.html` is ungated. It keeps no session-state map to hang
> `agentReady` on, and the report was companion-only — so the web client can still
> type a prompt into a booting agent.

### A CLIENT gate does not cover a WORKER-originated write (#137/#138 × #147)

The gate above lives in the client, which is right for a *prompt* — a person typed
it. But the worker writes into a PTY on its own account too, and none of those
sites consulted readiness. `fireAutoResume` (the 5h auto-resume, #137/#138) ends in
`submitLine(s, 'continue')`, and `armAutoResumeTimer` runs on the **restore** path
with `Math.max(0, fireAt - Date.now())` — **zero** for a window that turned over
while the worker was down. So a cold restart of a capped session re-armed and fired
while `claude --resume <id>` was still booting, which boots *slower* than a cold
start: `continue` landed on **bash**. That is #147 again, produced by the feature
meant to rescue the session, and the `status === 'working'` guard cannot see it —
**a booting session is not `working`.**

Neither change has this defect alone; the merge of the two creates it. **Any new
worker-originated write must check `session._ready`** and **defer**, never skip: the
window is real and the session still needs its nudge. Check it *before* the one-shot
(`autoResumeFiredForResetAt`) is consumed — `armAutoResumeTimer` refuses to re-arm on
a consumed one — and let the retry ride `session._autoResumeTimer` so a dead PTY or a
returning user cancels it like any other armed resume. The wait needs no ceiling of
its own: #147's 45s fallback is armed for **every** session at spawn.

### A detector's phrase must not be in our own source (#138)

The cap-prompt detector scans **all** agent-session PTY output and answers by
**writing a keystroke**. Its phrase was captured verbatim into a `lib/agents.js`
comment and assembled in `tests/reset-resume.spec.js` — so a Claude session working
in this checkout that `cat`'d, grepped or diffed either file matched, typed a stray
`1` into its composer and recorded a cap block that never happened. **A match that
causes an action is not a reading; treat "our own repo prints this" as a live input.**
The rule is now structural and pure (`lib/usage-limit.js` `matchUsageLimitPrompt`):
the sentence must **start** its line as a numbered option and have a sibling option
**above or below** it — above *or* below, because "stop and wait" is the last option
in a reordered render. The registry declares only the sentence.

### A submit is VERIFIED, never predicted (#179) — and alt-screen is not the signal

`/usage`, a slash menu, a permission prompt, a crashed TUI back at bash: each swallows
a prompt as navigation, so the compose bar submits, nothing appears, and **the words are
gone with no error anywhere**. It is #147's failure class arriving later — #147 solved
*"the agent is not up YET"*, this is *"the agent is not at its composer ANY MORE"*, which
`lib/agent-ready.js` already recorded as its own one-way-latch limitation.

**#179 proposed alt-screen (`ESC[?1049h`/`l`) as the general blocked marker and said, in
bold, to measure it first. Measured, it is WRONG.** Two probes on claude **2.1.250**
(`scripts/rig/probe-altscreen-block.js`, `scripts/rig/probe-blocked-markers.js`),
verdicts taken from *did a turn start* because the screen cannot tell typed from
submitted:

| state | DEC modes on entering | a submit here |
|---|---|---|
| ordinary turn (control) | none | **starts a turn** |
| `/usage` | `?25l ?25h ?25l` — cursor only | **no turn** |
| slash menu open | `?25l ?25h` | **no turn** |
| Agent View (`←`) | mouse off, `?2004l`, `?1004`, `?2031`, `?9001` | dispatches a **NEW session** |

**Not one blocking state emitted `ESC[?1049h`** — including Agent View, which the docs
and our own notes called always-fullscreen (see #146 below). Nothing else lines up
either: cursor-hide catches `/usage` but not the slash menu, and it toggles during
ordinary repaints, so keying on it would refuse legitimate submits. **So no marker is
declared, deliberately** — an unmeasured marker is what #143 shipped.

**The rule is inverted instead, and it is one #55 already made law: submit means a turn
actually starts.** Do not predict whether the PTY can accept a prompt — write it, then
check that it landed. `lib/submit-confirm.js` holds the pure rules, `lib/agents.js`
declares `submitConfirm: { timeoutMs }`, `pty-worker.js` arms the clock **when the
submit CR goes out** (not when the frame arrives — the CR is withheld for `submit.gapMs`)
and stops it on the first hook. **Any** hook: what is being separated is *the agent is
doing something* from *the TUI ate the keystrokes*, and that must not depend on which
event a given prompt shape happens to produce. A timeout publishes `submitUnconfirmed`,
pushed and never persisted — it is a one-shot fact addressed to whoever just typed.

**Every gate fails CLOSED, because a false alarm is worse than the silence it replaces**
— it would teach you to distrust the notice on the one occasion it is true. Not armed
when: the provider declares nothing (Codex, plain shells — today's behaviour exactly);
the session has never delivered a hook (`hookStatus`, the same proof `isClaudeSession()`
uses — so a box without hooks installed is untouched); the write came from the worker
itself (auto-resume's `continue`, the API-error ladder — no draft to give back); the
session is **already `working`** (the composer QUEUES behind a running turn and need not
report it for minutes); the session is **mid-compaction** (#129 measured that Claude
reports *idle* part-way through a `/compact`, so the status gate cannot see it and no
hook fires until it finishes); **Esc arrives inside the window** (Claude fires no hook on
an interrupt, and the session is still `idle` there, so the interrupt gate could not see
it either); or the line **starts with `/`** — `/usage` legitimately starts no turn, and
flagging it would fire on exactly the views the user opened on purpose.

That last one is why the line is accumulated from the bytes written rather than read off
the submit frame: a live `/`-line is streamed as you type (#55), so its submit frame is a
**bare CR** carrying no text at all. Two details of that accumulation are load-bearing,
and both were review findings: **the cap keeps the HEAD** (slicing the tail threw the
leading `/` away, so a long slash command read as a prompt and got watched), and **a
paste is not typing** — its body is dropped, because the images-only submit (#87) pastes
a file PATH, and a POSIX `/home/...` was reading as a slash command while a Windows
`C:\\Users\\...` was not. The same action, two answers, decided by the platform.

**The clients hold the words, and they EXPIRE.** The event carries no text, so recovery is
each client's own copy — restored only into an empty compose bar, only for a report
stamped at or after that client's own last submit, and only inside a grace window,
because **silence is success**: the worker reports inside 8s or never, so a prompt still
pending long after that provably landed. Without those last two, a report stranded from
before a screen was open replayed against a fresh, successful prompt — banner up, words
back in the box, and the obvious next move is to send them a second time.

### Agent View (`←`) is NOT alt-screen, and it REDIRECTS your next prompt (#146)

Anthropic's fullscreen doc says agent view always renders on the alternate screen
"regardless of the `tui` setting". **On claude 2.1.250 it does not** — measured twice,
independently: entering it emits **zero** `?1049` toggles, no DECSTBM and no ED. It is
an ordinary inline render into the normal buffer (5602 bytes at 120 columns, 3992 at 52).
So none of the #81-class scroll-region machinery is involved, and there is no fullscreen
fragment problem to fix.

**The captures are deliberately NOT checked in.** `claude agents` lists every Claude
session on the machine by name and one-line summary, so an Agent View frame from this
fleet carries real client and project names into a PUBLIC repo. Re-capture with
`scripts/rig/probe-altscreen-block.js` when it is needed; keep the numbers, not the bytes.

**The real hazard is behavioural, not visual.** `←` on an empty prompt line backgrounds
your conversation, and the composer you then face is Agent View's **dispatch** box:
measured, a prompt typed there starts a **new background session** instead of reaching
the conversation you were in. That is worse than swallowed — the words run somewhere you
did not choose. It is also exactly what #179's verifier catches, since the dispatched
session's hooks are not this session's.

The way back **is** on screen (`Your conversation moved to the background — enter opens
it · esc returns`), which is the part the original report could not see at phone width.

**The rendering fault was WIDTH, and it was ours.** Two captures settle it:

| PTY width when Agent View was entered | result |
|---|---|
| 120 cols (the worker default) | 74 lines, up to ~120 columns wide |
| 52 cols (a phone), set by a real resize first | **max line exactly 52** — Claude truncates every row itself; nothing wraps |

Claude renders perfectly for the width it is told about. A viewer NARROWER than the PTY
then wraps every long line — rows clipped at the right edge, sections overprinting, a dead
region below, which is the reported screenshot exactly. Agent View is simply the densest
full-width screen Claude draws, so it shows the fault first; nothing about it is special.

**Why the phone had the wrong width: the PTY size was LAST-WRITER-WINS.** `server.js`
applied every resize message immediately and neither it nor the worker tracked per-viewer
sizes, so a desktop relaying out (window resize, sidebar toggle, compose bar growing)
stole the columns back seconds after a phone attached. The rule is now **the smallest
ACTIVE viewer wins** (`lib/terminal-size.js`, applied in `server.js`): a terminal smaller
than its viewer only wastes space, while one larger is unreadable, and only the second
loses information. A background socket has no vote, so a phone in a pocket cannot hold a
desktop at phone width — and that is what makes it self-healing. **Server-side only, so it
hot-reloads**; the worker's `resizeSession` is unchanged.

Two review findings worth carrying. The negotiated size is cached **only once the worker
has accepted it**: writing it optimistically left the server believing a size a rejected
resize never applied, and every identical relayout afterwards was then swallowed by the
dedupe — #146's own symptom, reintroduced by #146's fix. And a viewer that arrives
without changing the answer still gets a **nudge** (`rows-1`, then `rows`), because
`app.html`'s own `nudgeRedraw` cannot work through a `min()` that collapses both halves of
its flick to the same value. `tests/terminal-size.spec.js`
asks the PTY itself with `stty size` rather than trusting the message it sent.

**Chat lens: nothing to render, and that is a structural answer, not a deferral.** Agent
View is TUI paint and writes nothing to the transcript — the same finding as #131. The
only honest route is `claude agents --json`, which is a separate feature, not a rendering
fix.

### `app.html` is ONE CLASSIC SCRIPT: `window.f = () => f()` is infinite recursion

A top-level `function f(){}` in a classic script **is already `window.f`**. So the
innocent-looking line that exposes it for a test:

```js
window.showSubmitUnconfirmed = () => showSubmitUnconfirmed();   // NO
```

overwrites the global binding with the arrow, and the arrow's body then resolves to
**itself**. The first call blows the stack, the script dies where it stands, and the
whole app is inert — empty sidebar, `(no session)`, every click timing out. Write
`window.f = f;`, or just rely on the declaration already being global. (A wrapper is
only safe when it names something ELSE: `window.__setAutoScroll = (v) => { autoScroll = v; }`
is fine.)

**The methodology lesson is the bigger one.** This shipped past a LOCAL full-suite run
that reported *1346 passed, 0 failed*, and was caught by CI failing **73** UI specs —
then reproduced in ten seconds by loading the page in a real browser and reading
`pageerror`. A green suite is evidence, not proof: when a change touches `app.html`,
**load the page and check the console** before believing the run. The rig makes that
cheap and safe — `node scripts/rig/rig.js up`, then drive `http://127.0.0.1:7999`
with a standalone Playwright script on a port the suite is not using.

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

### The preview BODY now crosses the wire too (#145)

It used to be dropped on purpose — *"free-form, can be large, and nothing renders
it"* — which was right for exactly as long as nothing rendered it. Reported
2026-08-19: a three-option prompt whose labels were `Land #182 (.debug suffix)` /
`Play closed track upload` / `Leave it` kept every package name, snippet and
blocker **inside the preview box**, so the chat lens was strictly less
informative than the terminal *on the questions that need the most reading* —
and no amount of client work could fix it, because the bytes were never sent.

`_shapeQuestions` now publishes `preview` per option, capped at
**`PQ_PREVIEW_CAP = 2000`** — its own budget, not the 800 sized for a label or a
blurb, because a preview is a multi-line **block**. The overlay renders it in
**monospace and unparsed** (its markup *is* the content) on the **selected row
only**, clamped to `kPreviewMaxLines` with a visible ellipsis. Revealing it on
select mirrors the TUI, where moving the highlight swaps the box and Enter
commits; a tap here likewise only moves the selection, so reading a preview
never costs you a choice.

**`hasPreview` is still derived from the RAW option list — never recompute it
from the shaped one.** The shaped list can lose a preview three ways: its option
had no label and was filtered out, it fell past `PQ_MAX_OPTIONS`, or the body was
a non-string/whitespace and was never attached. (Capping is **not** one of them —
`_pqCap` truncates, it cannot empty a non-empty preview.) Any of the three would
silently flip the question to the compact layout, and the layout decides what
every answer key MEANS.

The block is revealed by **selecting** its option, and selecting also **scrolls
that row into view**. Without it the feature is invisible in the case it was
reported from: the option list gets `kOptionFloor` (~two rows) on a phone, so
choosing the last option opens a ~300px block entirely below the viewport — the
radio fills and nothing else appears to happen. Note the font too: `'monospace'`
is an Android/fontconfig alias that resolves to **nothing** on Windows, macOS and
iOS, so the block carries a `fontFamilyFallback` — without it the alignment this
whole treatment exists to preserve is lost on the desktop build.

### The layout also decides whether NOTES exist at all (#143)

The same rule reaches further than the digit. **`n` ("add a note") is a
side-by-side-layout feature and does not exist in the compact one.** Measured
against claude **2.1.234**, verdicts from the transcript:

| layout | footer | `n` |
|---|---|---|
| compact | `Enter to select · ↑/↓ to navigate · Esc to cancel` | **ignored — no-op** |
| side-by-side | `… · `**`n to add notes`**` · Esc to cancel` | opens a note editor |

#64 Gap 1 shipped a note sequence that was **never device-verified** and was
wrong in *both* layouts. On a compact card `n` and the note text are simply
swallowed, so `↓×idx, n, <note>, CR` degenerates to `↓×idx, CR` — **a correct
plain selection with the note silently discarded.** Nothing looked broken, which
is exactly why it survived to ship. That is the failure mode this repo keeps
paying for: *confidently wrong is worse than absent.*

```
↓,n,<note>,CR       -> "=(no option selected) notes: …"   the ANSWER is lost
↓,CR,n,<note>,CR    -> "=Green"                           the NOTE is lost
↓,n,<note>,ESC,CR   -> "=Green … notes: …"                both  <- the rule
```

**`Esc` closes the note EDITOR without cancelling the question**, despite the
footer reading `Esc to cancel`. The whole fix rests on that. It is a lone `0x1b`,
which `isEscapeKey` would read as an interrupt — but that rule is gated on a
`working` session and one owing an answer is `waiting`, so it is not armed here.

### `Other` (free text) is a COMPACT feature — the exact mirror of notes (#143)

**`n` exists only side-by-side; `Type something.` exists only compact.** The two
free-text affordances are mirror images, and the overlay now offers exactly the
one its layout has. That symmetry is the whole rule; the three bullets below are
just what each shape measured.

- **Side-by-side — NOT OFFERED, and the reason is not caution.** Measured on
  claude **2.1.237** (`--shape preview-single --keys "4,indigo actually,CR"`):
  the previewed selector lists only the real options and then `Chat about this`
  — **there is no `Type something.` row at all**. The screens after the digit
  and after the text were **byte-identical** to the first render, and the
  trailing CR committed the still-default top row. The transcript recorded
  `"Pick a color"="Red"`. So the un-gated sequence does not merely lose the free
  text: **it submits an option the user never picked** — worse than the note bug
  this issue is named for, which at least landed the right option.
- **Compact multi-question — WORKS, deferral lifted.** The digit lands on the
  `Type something.` row and opens a free-text editor (the footer gains
  `ctrl+g to edit in Notepad`); Enter commits it **and** advances the tab, just
  like a single-select digit. `4,<text>,CR,1,→,CR` recorded both answers intact.
  The lift is **compact-only**, because compact is the only layout it was driven
  against.
- **Multi-select — HOLDS.** The trailing row is a **checkbox** (`5. [✔] Type
  something`) with no free-text input; the typed text is swallowed, and
  submitting with only it checked records **`The user did not answer the
  questions.`** — the whole answer comes back null, not merely textless.

One consequence worth stating because it reads as a bug otherwise: **a card
offers the note affordance or the `Other…` row, never both.** Notes are
previewed-only, Other is compact-only, so "Other wins when both are set" is no
longer a branch-order fact — the layout decides which one is eligible at all.

Claude also renders a **`Chat about this`** row at `options.length + 2` that the
overlay does not model at all.

Shapes for `scripts/rig/probe-askq-layout.js`: `preview-mq`, `plain-mq`,
`preview-single`, plus `plain-single`, `plain-multi` and `plain-mq2` (two
single-select tabs — the only shape that exercises `Other` on a LAST tab, since
`plain-mq`'s Q2 is multi-select) added for the above.

> **`hasPreview` was being read off the SLICED option list.** `_shapeQuestions`
> computed it from `kept` — post-`PQ_MAX_OPTIONS` — while its own comment three
> lines above named that slice as one of the three ways a preview goes missing.
> A preview carried only by an option past the cap therefore reported *compact*
> for a question Claude lays out *side-by-side*, and every answer key means
> something else across that line. Fixed to read the raw list, with the test that
> was red first. **The rule was written down and the code still drifted from it —
> which is the argument for the test, not for more prose.**

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
