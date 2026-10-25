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
- `lib/notification-shape.js` — the pure rules for a Claude `Notification` hook (#194 Gap 1): `classifyNotification` (permission / idle / **benign** / **unknown** — the last two were one silent `drop`), plus the redaction and rate rule for logging an unknown one. **Instrumentation only — it deliberately changes no behaviour**: `correctStaleStatus` never times out a `waiting` session at all since #230, against 5m for a `working` one, so promoting an unrecognised notification to a permission ask on a guess would park a session on a false "waiting" INDEFINITELY - the cost of that mistake went UP when the backstop went away, which is the one place #230 makes another rule stricter rather than looser
- `app.html` — unified single-page app (terminal + sidebar + settings). Polyfills `crypto.randomUUID` for plain-HTTP contexts. `?rtt=1` enables the per-keystroke RTT overlay
- `terminal.html` — legacy terminal-only page. **No longer served** (#218): `/s/:id` redirects to `/app/:id`, because this page neither gated input at `WS_INPUT_MAX` nor could render an `inputDropped` notice
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

## Findings archive — the law is here, the evidence is in `docs/findings/`

This file is the **law**: what you must and must not do, and which module owns each
rule. The **evidence** behind each law — measurement tables, probe recipes, refuted
hypotheses, review post-mortems, superseded corrections — was moved *verbatim* to
`docs/findings/` on 2026-09-15, when this file passed the 150k-char limit and stopped
loading at all. Nothing was summarised away; it was relocated.

| file | covers |
|---|---|
| `docs/findings/input-submit.md` | #44 #55 #137 #138 #146 #147 #179 #190 #201 #204 #206 #209 #213 #218 |
| `docs/findings/agents-codex.md` | multi-agent registry, Codex empirics, hooks, OSC 9, #73 #78 #142 #191 #227 |
| `docs/findings/questions.md` | #19 #84 #143 #145 #236 #239 |
| `docs/findings/chat-lens.md` | session recap, #249 #194 #210, scrollback #167 #176 #178, #81 #83 |

**Read the covering archive file before reopening any issue it names, and add new
measurements there rather than here.** Every table in it records the agent version it
was taken against — a claude or codex release can move any of these numbers, and no
unit test catches that. A measurement kept in *this* file is a law nobody can load.

## Input & Submit Contract (issue #55) — this is law, not guidance

The sentence *"Enter doesn't run it"* has described at least four **different** bugs in
different layers. A change to input or submit is correct only if it satisfies the rules
below, and each has a test that fails without it. Evidence:
`docs/findings/input-submit.md`.

**Compose bar = the app's text box**, not the agent's own TUI prompt. **Submit = the
agent actually starts a turn** — text appearing in its prompt box is *not* submit, which
is why the only valid detector anywhere in this area is *"did a turn start"*. The
PTY/rollout is ground truth; the screen lies.

### The keyboard contract — chosen by PLATFORM, never by lens

| Platform | Enter | Ctrl+Enter | Send button |
|---|---|---|---|
| **Desktop** (hardware kbd) | **Submit** | Newline | Submit |
| **Mobile** (soft kbd) | **Newline** | (n/a) | **Submit** |

Mobile is Send-only because the **Android IME commits Enter as literal `"\n"` text, not
a key event** — a submit bound to an Enter keydown is unreliable there by construction.
The gate is `composeUsesSoftKeyboard()` (companion `compose_bar.dart`; `app.html` mirrors
it off the UA). In `app.html` the bar's **visibility** keys on `isMobile`, which ORs in
`innerWidth < 600`, so a narrow *desktop* window shows the bar and must still submit on
Enter. **Visibility is not platform — do not collapse them.** The bar is multi-line
(`minLines:1, maxLines:5`) and a soft-wrapped line contains no `\n`.

**A widget test cannot prove any of this.** Synthetic key events never traverse the OS
text-input path, so a widget test passes while the shipped app is broken. Desktop Enter
needs real injected OS keystrokes (`scripts/rig/probe-drive-windows.ps1` +
`tool/compose_probe.dart`); mobile needs a real device.

### Client-side encoding — `buildComposeSubmission` (one function per client)

1. Strip a **trailing** newline. 2. If a `\n` **remains** -> `ESC[200~` + text +
`ESC[201~` + `\r`. 3. Else -> text + `\r`. 4. Send as **ONE** frame (#44: a client that
dies mid-submit must not lose half of it).

A live `/`-line streams to the PTY as you type so the agent's slash menu narrows. That
prompt is **one line**, so `composeLiveProjection()` **drops newlines** — mirroring one
as `\r` would *submit*, which is exactly how Enter came to fire a `/`-line on mobile
while merely newlining everywhere else.

### The wire cap and the offline-buffer ceiling are ONE number (#201/#204/#206)

`WS_INPUT_MAX` (`server.js`, per frame) and the companion's `_inputBufferHardCap`
(`api_client.dart`, total) are both **256 KB in UTF-16 code units** and are equal by
construction: **nothing the offline buffer can hold within its ceiling may be refused at
the wire.** The bound that bounds memory is **`WS_MAX_PAYLOAD` (4 MiB) in `wsOptions`** —
`ws` assembles a whole message before `handleMessage` runs. It is deliberately ~5.3x the
app cap's worst-case byte width, not snug, because `ws` answers an oversize frame by
**closing the socket** rather than letting the app send its notice; the zone between the
two caps is where an accidental oversend is still reported honestly.

**Every refusal must SAY SO** — #193's principle, which three paths once broke:

- **The companion refuses at the APP cap itself** (`sendInput`, before the live/buffered
  branch), on the `inputDropped` stream, which makes `WS_MAX_PAYLOAD` unreachable from
  that client. *A refusal by the APP keeps the socket and the session; a refusal by the
  TRANSPORT costs the connection.* The comparison is `>`, matching the server's
  `msg.length > WS_INPUT_MAX` exactly — a write **at** the cap is legal on both sides.
- **`app.html` funnels every input write through `sendPtyInput`** wrapping `ws.send`.
  A funnel's whole value is that nothing goes round it, and no behavioural test can see
  that, so `tests/app-input-path.spec.js` asserts it against the **source** with an
  allowlist of the frames that are not input (`resize`, `mode`, `heartbeat`, notify ping).
  The cap is tested **before** the socket state — the refusal is a fact about the data.
  **Every caller's FRAMING is untouched:** #55/#44 make a submit one frame on purpose and
  #87's images-only submit needs its paste close and bare CR a measured gap apart, so this
  wraps a send and re-coalesces nobody.
- **`terminal.html` is NO LONGER SERVED** (#218). `/s/:id` returns a **302** to `/app/:id`
  (a 301 is cached indefinitely and would make a revert a support problem). The page keeps
  four ungated sends and cannot render an `inputDropped` notice at all; what makes that
  safe is that nothing routes to it. `tests/legacy-route-redirect.spec.js` asserts
  **against the source** that no route serves the file, because a route added next year
  would leave every behavioural test green. The redirect *adds* capability: `app.html`
  resolves a bare `/app/:id` against `/api/cluster/sessions`, so an `/s/` link reaches a
  peer session for the first time.
- **The cluster proxy reports its own refusals, once per outage, not once per keystroke.**
  The reconnect buffer **latches**, so everything after the first refusal is refused for
  the same reason; the reporting rule therefore lives with the latch in
  `lib/reconnect-buffer.js` (`decide`, `giveUp`) rather than as an `if` beside it. Two
  distinct reasons: **`buffer-full`** (no room left) and **`peer-unreachable`** (#209 —
  every write was *accepted* and the whole buffer then discarded when the peer never came
  back, ~37s of silence before `1001`). `giveUp` must tally what was **lost**, not what was
  **held** (once latched, `count` is pinned and later refusals land in no array), sets
  `latched` **unconditionally** (`close()` leaves `readyState` at CLOSING and `ws` keeps
  delivering `message`), and clears the buffer **before** the close.
- **A BACKGROUND SOCKET IS STILL A SOCKET THE SERVER REPORTS ON.** `app.html`'s background
  `onmessage` handlers stash `inputDropped` on the session's cache entry and drain it once
  on return — a notice belongs to the session it was raised on (#179). Survivable while
  every refusal fired as you typed; not survivable for one arriving 37s later.

`WS_INPUT_MAX` is a **three-copy** constant gated by `scripts/check-shared-constants.js`.
An ungated copy would decide whether the browser refuses a write itself or lets the
transport refuse it by closing the socket.

**`WT_CLUSTER_TOKENS_FILE`** exists so a regression test can write a cluster entry pointing
at a dead port. `cluster-tokens.json` holds a live bearer token for **every peer**, and a
backup/restore around the test is not enough — a suite run SIGTERM'd part-way never reaches
its restore. Redirect the path and the real file is never opened.

### Server-side delivery — the SSOT, and where the real bug lived

**Every agent TUI folds one read into a paste and swallows a trailing CR.** Codex does it
at any length (`paste_burst.rs`); **Claude does it too**, it just needs a bigger read —
measured against the real TUI, atomic `text\r` in ONE write submits at 20/40/60 chars and
**does NOT submit at 80/120**. That single fact explains the whole "sometimes Enter works"
class of report: a short test prompt submitted, and a real one was typed into the prompt
box and never sent. Claude looked exempt for months because every quick test was short.

- The **worker** owns submit timing. Clients stay unaware and unchanged.
- A frame that is **text ending in `\r`** is split: write the text now, write the lone `\r`
  after `submit.gapMs`. Input arriving in the gap **queues behind** it (order preserved).
- A **bare `\r` on a cold PTY is never split** — nothing was just written, so nothing can
  absorb it. Ordinary char-by-char shell typing is never rewritten and never delayed.
- **The gap is measured against the wire, not against the frame.** A bare `\r` written
  within `submit.gapMs` of a frame that **closed a bracketed paste** IS withheld and goes
  out alone. The burst detector reads bytes; our frame boundaries are invisible to it. This
  is the images-only submit (#87): each staged image is its own `ESC[200~<path>ESC[201~`
  frame and with no prompt text the submit behind it is a bare CR. Keep it **narrow — only
  a paste close shades a CR**; widening it to "any recent write" would delay every shell
  Enter.
- Bracketed paste does **not** exempt the CR (<=30 ms is still absorbed, >=60 ms submits).
  **Only a real temporal gap works — never "fix" a submit problem by changing the bytes.**

### A DICTATED prompt has no newline, so nothing ever bracketed it (#213)

The rule above rescues the **CR** and leaves the **BODY** to the TUI's own paste inference.
`buildComposeSubmission` picks its byte shape on exactly one predicate — **does the buffer
contain a newline** — so a pasted paragraph goes bracketed and **a dictated one does not**.
Dictation emits no line breaks. That is why the long prompts that break are always the
spoken ones: unbracketed, Claude's TUI loses the **HEAD**, cutting exactly **1024 bytes** (a
buffer boundary, reproducible), and at ~1088 loses the prompt entirely.

**The fix is `submit.bracketAbove` in the registry, applied in the worker** — one owner,
every client fixed with no client release, and it hot-reloads. Claude declares **512
BYTES** (not characters — dictated Hebrew is two bytes per character, so 512 of them land
on the cliff exactly); **Codex and plain shells declare none, and undeclared means never.**
That asymmetry is deliberate: splitting a CR is invisible to a reader that does not need
it, while `ESC[200~` is only correct for one that understands the sequence, and a shell
with bracketed paste off would take the markers as literal text.

**Refused, never sanitised.** A body carrying ESC, CR or LF is left exactly as it is — it
may already be a bracketed paste, an arrow key, or a live `/`-line's backspaces. Stripping
markers out of a body is no defence (deleting the inner `ESC[200~` from
`a ESC[2 ESC[200~ 01~ b` reconstitutes a close), and refusing costs nothing because every
such body already has a working shape.

> **This does NOT contradict "never fix a submit problem by changing the bytes."** That
> rule is about the **CR** — making Enter be Enter, where only a temporal gap works, and
> that gap is untouched here. This changes the **BODY**, and does not disguise it as
> something else: a compose submit *is* a block insert. `contains('\n')` was a proxy for
> "is this a paste", and the proxy is what was wrong.

### Interrupt (Esc) — status must go idle promptly

Claude fires **no hook** on a user interrupt (`Stop` does not run), so an interrupted
session sat on "working" until `correctStaleStatus` rescued it 5 minutes later. The
**worker writes the Esc byte itself**, so it is the one component that can know: a **lone
`0x1b`** (`isEscapeKey` — length 1, so an arrow's `ESC [ A` never counts) sent to a
**`working`** session flips it to idle at once. Gated on `working` on purpose — Esc at a
permission prompt (`waiting`) *rejects the tool* and Claude carries on. No push fires; the
user is the one who pressed Esc. A **plain shell declares `onEscape: false`**, so Esc in
vim or less is never read as "the agent stopped".

### Where it lives (no branching, ever)

`lib/agents.js` — the registry: each provider declares `submit: { gapMs, crBurstsAsPaste,
bracketAbove }`, `interrupt: { onEscape }`, `readiness`, `submitConfirm`.
`lib/submit-frames.js` / `lib/submit-confirm.js` / `lib/agent-ready.js` — the pure rules.
`pty-worker.js` — applies them where bytes meet the PTY. **An `if (agent === 'codex')` in
`server.js`, `pty-worker.js`, `app.html` or the companion means the change is in the wrong
file — add a registry field instead.**

### How to verify (no production cold-restart to test a hypothesis)

`node scripts/rig/rig.js up` runs a complete, **isolated** web-terminal (port 7999, own
worker pipe, own data dir, own config) from the working tree — it cannot touch production.
`node scripts/rig/verify-submit.js` proves a LONG prompt actually submits, end to end.
Claude echoes a submitted prompt back into its transcript, so "is the text still visible"
cannot distinguish *typed* from *submitted*.

### A spawned agent is NOT ready when its session is (#147)

Submit has a precondition the contract above assumed: **the agent has to exist.** A new
session drops the user into the chat lens seconds before `claude` boots, so a prompt sent
in that window is handed to **bash** and is gone with no error anywhere. Measured boot to
composer: **5.0s and 6.1s on the same machine** — that spread is the whole argument for a
**marker over a timer**, since a timer tuned to the fast boot eats prompts on the slow one.

The marker is a registry field (`readiness.composer`), the rule is pure
(`lib/agent-ready.js`), and `pty-worker.js` applies it. **Codex deliberately declares
none** — an unmeasured marker is what #143 shipped — and undeclared means *ready
immediately*.

- **The scan does not start until the launch command has been written.** Before that the
  PTY shows the *shell*, and `❯` is the default prompt glyph of starship, pure and several
  oh-my-posh themes.
- **A session with no `autoCommand` is never gated at all** — it is a shell until you type
  something, and gating it would block the very submit that types `claude`.
- **It can never wedge:** any hook forces it ready; a **45s fallback**
  (`WT_READY_FALLBACK_MS`) covers `command not found` or a crash on launch; a plain shell
  and every unknown agent are ready from birth; `server.js`, `POST /api/sessions` and the
  companion all read a **missing** field as ready, so an older worker never refuses a
  submit. The fallback is a **ceiling, not a detector**.
- **A restored session is NOT seeded from its scrollback.** Restore spawns a fresh shell
  and re-runs `claude --resume <id>`, which boots *slower* than a cold start; seeding from
  the old scrollback (which still holds the previous life's marker) marked every restored
  session ready at t=0 and killed the gate after every cold restart.
- **The live `/`-line is gated too**, not just submit — it writes bytes as you type, so a
  `/co` typed in the first seconds landed on bash's command line and the worker then typed
  `claude --resume …` onto the same line, running `/coclaude --resume …`.
- The client gates **submit only** — typing is untouched, the text stays in the box, and it
  is **not** auto-sent on ready, because firing a prompt somebody was still editing is its
  own way to lose their words.
- **`app.html` is gated too (#263)**, from two sources: the pushed
  `{type:'agentReady', id}` notify event (a Set — readiness only goes false -> true) and
  the sidebar row for peers, since `connectNotify` opens one socket to this host only.
  **The refusal re-reads the sidebar**, so the press that was refused is what corrects a
  stale answer, and the **Send button is deliberately NOT disabled** — a disabled button
  cannot ask for fresh data.
- **Known gap:** the latch is one-way and does not reset when the agent **exits** back to
  its shell (`/exit`, Ctrl-D, a crashed TUI). That session keeps reporting ready, so a
  later submit reaches bash. The client's Set mirrors the worker's latch, so it is wrong in
  exactly the same cases and no others; fixing it belongs in the worker, the only component
  that sees the bytes.

### The readiness marker is `❯` + U+00A0, and the bare caret was a real bug (#190)

Measured on claude 2.1.251, the composer writes the caret followed by **U+00A0 NO-BREAK
SPACE** — a 5-byte marker, well inside `lib/agent-ready.js`'s `CARRY_BYTES`. It was not a
tidy-up: **Claude's folder-trust dialog draws the same `❯` as its selection cursor**, so
the latch flipped on a session parked at a *selector*, published it ready, and cleared the
client to submit into it. Every alternative candidate died in measurement — `⏵⏵` is
mode-dependent, the `───` rule is drawn by the trust dialog too, `Try` is a rotating
placeholder, and `agents` is truncated away at 52 columns (a phone-only regression of
exactly the #146 shape).

> **Write it as escapes; keep the source ASCII-only.** A literal U+00A0 is invisible in a
> diff and is normalised to an ordinary space in transit. **And the NEGATIVE test is the
> load-bearing one:** if normalisation hits the rule and the test together, the positive
> assertion still passes — only *"must NOT match `❯` + U+0020"* goes red.
> `tests/composer-marker.spec.js` builds both characters with `String.fromCodePoint` for
> exactly this reason. A claude release that changes the glyph or the spacing needs a rig
> re-probe; no unit test can catch that.

### Claude's folder-trust dialog is a THIRD layout, and a submit there KILLS the agent (#190)

Neither #19's compact (digits) nor its side-by-side (a preview box). It is an
**unnumbered, arrow-driven list whose default row is the destructive one** (`❯ No, exit`),
so `↓` then Enter answers it. Driven, every other candidate **exited to bash** — a digit, a
bare Enter, and the reported case: **a real prompt followed by its submit CR**, where the
trailing CR confirms `No, exit` and **the agent is gone**, so the *next* prompt goes to the
shell. `--dangerously-skip-permissions` does not suppress it.

**The dialog emits NO SPACES.** Every word is positioned with CHA
(`\e[2GQuick\e[8Gsafety\e[15Gcheck:…`), so an ANSI-stripped stream reads
`Quicksafetycheck:Isthis…` and **any matcher must reconstruct columns first**. The longest
contiguous literal in the whole dialog is one word. No alt-screen and no distinguishing DEC
mode accompanies it.

**It is a dialog FAMILY, not one dialog.** A fresh cwd under a checkout that has a
`CLAUDE.md` parks on *"Allow external CLAUDE.md file imports?"* — same shape exactly
(unnumbered, `❯` then CHA, no spaces, `Enter to confirm`, a refusing default row). So
**"the tree is trusted" is NOT "no selector will block a new session"**: folder trust is
inherited by descendants, but that is trust-specific. Target the family by **shape** (`❯` +
CHA, no spaces, `Enter to confirm`), never the trust prompt alone.

> **Trust is INHERITED, which is a hard constraint on ever testing this:** an ancestor of
> the scratch parent is already trusted, so **nothing `scripts/scratch-dirs.js` creates can
> ever show the prompt** — the rig's own cwd included. A reproduction needs a cwd with no
> trusted ancestor. And `hasTrustDialogAccepted: false` does **not** mean untrusted.

**Deliberately NOT fixed:** detecting the dialog, withholding the 45s fallback, surfacing
it in the chat lens, auto-answering. #190 and #194 Part 1 both want the surfacing built
once, and the right design is **refuse-and-explain rather than delay** — a false refusal
costs a message, a false permit costs the agent.

### A CLIENT gate does not cover a WORKER-originated write (#137/#138 x #147)

The gate above lives in the client, which is right for a *prompt* — a person typed it. But
the worker writes into a PTY on its own account too. `fireAutoResume` ends in
`submitLine(s, 'continue')`, and `armAutoResumeTimer` runs on the **restore** path with
`Math.max(0, fireAt - Date.now())` — **zero** for a window that turned over while the
worker was down. So a cold restart of a capped session fired while `claude --resume <id>`
was still booting and `continue` landed on **bash**: #147 again, produced by the feature
meant to rescue the session, and the `status === 'working'` guard cannot see it because **a
booting session is not `working`.**

**Any new worker-originated write must check `session._ready`** and **defer, never skip** —
the session still needs its nudge. Check it *before* the one-shot
(`autoResumeFiredForResetAt`) is consumed, and let the retry ride `session._autoResumeTimer`
so a dead PTY or a returning user cancels it like any other armed resume.

### A detector's phrase must not be in our own source (#138)

The cap-prompt detector scans **all** agent-session PTY output and answers by **writing a
keystroke**. Its phrase was once captured verbatim into a `lib/agents.js` comment and
assembled in a test, so a Claude session that `cat`'d, grepped or diffed either file
matched, typed a stray `1` into its composer and recorded a cap block that never happened.
**A match that causes an action is not a reading; treat "our own repo prints this" as a
live input.** The rule is now structural and pure (`lib/usage-limit.js`
`matchUsageLimitPrompt`): the sentence must **start** its line as a numbered option and
have a sibling option **above or below** it. The registry declares only the sentence.

### A submit is VERIFIED, never predicted (#179) — and alt-screen is not the signal

`/usage`, a slash menu, a permission prompt, a crashed TUI back at bash: each swallows a
prompt as navigation, so the compose bar submits, nothing appears, and **the words are gone
with no error anywhere.** It is #147's failure class arriving later — *the agent is not at
its composer ANY MORE*.

**#179 proposed alt-screen (`ESC[?1049h`) as the general blocked marker. Measured, it is
WRONG: not one blocking state emits it**, Agent View included. Nothing else lines up
either — cursor-hide catches `/usage` but not the slash menu and toggles during ordinary
repaints. **So no marker is declared, deliberately.**

**The rule is inverted instead, and it is one #55 already made law: submit means a turn
actually starts.** Do not predict whether the PTY can accept a prompt — write it, then
check that it landed. `lib/submit-confirm.js` holds the pure rules, `lib/agents.js`
declares `submitConfirm: { timeoutMs }`, `pty-worker.js` arms the clock **when the submit
CR goes out** (not when the frame arrives — the CR is withheld for `submit.gapMs`) and
stops it on the first hook. **Any** hook: what is being separated is *the agent is doing
something* from *the TUI ate the keystrokes*, and that must not depend on which event a
given prompt shape happens to produce. A timeout publishes `submitUnconfirmed`, pushed and
never persisted — a one-shot fact addressed to whoever just typed.

**Every gate fails CLOSED, because a false alarm is worse than the silence it replaces** —
it would teach you to distrust the notice on the one occasion it is true. Not armed when:
the provider declares nothing (Codex, plain shells); the session has never delivered a hook
(`hookStatus`, the same proof `isClaudeSession()` uses, so a box without hooks installed is
untouched); the write came from the worker itself (no draft to give back); the session is
already **`working`** (the composer queues behind a running turn); the session is
**mid-compaction** (#129 — Claude reports *idle* part-way through a `/compact`); **Esc
arrives inside the window** (no hook fires on an interrupt and the session is still idle);
or the line **starts with `/`** (`/usage` legitimately starts no turn).

That last gate is why the line is accumulated from the **bytes written** rather than read
off the submit frame: a live `/`-line is streamed as you type, so its submit frame is a
**bare CR** carrying no text. Two details are load-bearing: **the cap keeps the HEAD**
(slicing the tail threw the leading `/` away, so a long slash command read as a prompt and
got watched), and **a paste is not typing** — its body is dropped, because #87's
images-only submit pastes a file PATH and a POSIX `/home/...` read as a slash command while
a Windows `C:\Users\...` did not.

**The clients hold the words, and they EXPIRE.** The event carries no text, so recovery is
each client's own copy — restored only into an **empty** compose bar, only for a report
stamped at or after that client's own last submit, and only inside a grace window, because
**silence is success**: the worker reports inside 8s or never, so a prompt still pending
long after that provably landed. Without the last two, a report stranded from before a
screen was open replayed against a fresh, successful prompt — banner up, words back in the
box, and the obvious next move is to send them a second time.

### Agent View (`←`) is NOT alt-screen, and it REDIRECTS your next prompt (#146)

Anthropic's fullscreen doc says agent view always renders on the alternate screen
"regardless of the `tui` setting". **On claude 2.1.250 it does not** — measured twice,
independently: entering it emits **zero** `?1049` toggles, no DECSTBM and no ED. It is an
ordinary inline render into the normal buffer, so none of the #81-class scroll-region
machinery is involved and there is no fullscreen fragment problem to fix.

**The real hazard is behavioural.** `←` on an empty prompt line backgrounds your
conversation, and the composer you then face is Agent View's **dispatch** box: a prompt
typed there starts a **new background session** instead of reaching the conversation you
were in. Worse than swallowed — the words run somewhere you did not choose, and it is
exactly what #179's verifier catches, since the dispatched session's hooks are not this
session's. The way back **is** on screen (`esc returns`), which is the part the original
report could not see at phone width.

**The rendering fault was WIDTH, and it was ours.** Claude renders perfectly for the width
it is told about (at 52 columns it truncates every row itself; nothing wraps). A viewer
NARROWER than the PTY then wraps every long line — rows clipped, sections overprinting, a
dead region below. Agent View is simply the densest full-width screen Claude draws, so it
shows the fault first; nothing about it is special.

**The PTY size was LAST-WRITER-WINS**, so a desktop relaying out stole the columns back
seconds after a phone attached. The rule is now **the smallest ACTIVE viewer wins**
(`lib/terminal-size.js`, applied in `server.js`, which owns the sockets — so it
**hot-reloads**, and the worker only ever sees a count): a terminal smaller than its viewer
only wastes space, while one larger is unreadable, and only the second loses information. A
**background socket has no vote**, so a phone in a pocket cannot hold a desktop at phone
width — that is what makes it self-healing. Two review findings worth carrying: the
negotiated size is cached **only once the worker has accepted it** (writing it
optimistically left the server believing a size a rejected resize never applied, and every
identical relayout was then swallowed by the dedupe — #146's own symptom, reintroduced by
#146's fix), and a viewer that arrives without changing the answer still gets a **nudge**
(`rows-1`, then `rows`), because `app.html`'s `nudgeRedraw` cannot work through a `min()`
that collapses both halves of its flick to the same value. `tests/terminal-size.spec.js`
asks the PTY itself with `stty size` rather than trusting the message it sent.

**Chat lens: nothing to render**, and that is a structural answer, not a deferral — Agent
View is TUI paint and writes nothing to the transcript (the same finding as #131). The only
honest route is `claude agents --json`, a separate feature.

**Agent View captures are deliberately NOT checked in:** `claude agents` lists every Claude
session on the machine by name and one-line summary, and this repo is public. Keep the
numbers, not the bytes.

### `app.html` is ONE CLASSIC SCRIPT: `window.f = () => f()` is infinite recursion

A top-level `function f(){}` in a classic script **is already `window.f`**. So the
innocent-looking line that exposes it for a test:

```js
window.showSubmitUnconfirmed = () => showSubmitUnconfirmed();   // NO
```

overwrites the global binding with the arrow, whose body then resolves to **itself**. The
first call blows the stack, the script dies where it stands, and the whole app is inert —
empty sidebar, `(no session)`, every click timing out. Write `window.f = f;`, or rely on
the declaration already being global. (A wrapper is only safe when it names something
ELSE: `window.__setAutoScroll = (v) => { autoScroll = v; }` is fine.)

**The methodology lesson is the bigger one.** This shipped past a LOCAL full-suite run
reporting *1346 passed, 0 failed*, and was caught by CI failing **73** UI specs — then
reproduced in ten seconds by loading the page in a real browser and reading `pageerror`. A
green suite is evidence, not proof: **when a change touches `app.html`, load the page and
check the console** before believing the run. `node scripts/rig/rig.js up`, then drive
`http://127.0.0.1:7999` with a standalone Playwright script on a port the suite is not
using.

## Multi-Agent Support (Claude Code + Codex)

A session knows *which* AI CLI agent it runs. `agent` is a real, persisted session field:
`'claude'`, `'codex'`, or `null` for a plain shell. **`null` is never coerced to
`'claude'`.** Evidence and the full Codex empirics: `docs/findings/agents-codex.md`.

### The rule: one registry, no branching

Everything agent-specific lives in **`lib/agents.js`** — parser, transcript root,
transcript-resolution strategy, subagent-trace support, label, colour, submit policy,
readiness, submit confirmation. **Adding a CLI agent is one parser module + one registry
entry.** If you find yourself writing `if (agent === 'codex')` in `server.js`,
`pty-worker.js`, `app.html` or the companion, you are in the wrong file — add a field to
the provider instead.

`GET /api/agents` serves the catalogue, so both clients render the picker, the per-agent
tint and (since #210) the composer marker with **no client release** when an agent is added
or renamed. The companion holds no agent table; neither does `app.html`.

An **explicit** agent is authoritative: a session declared `claude` is never served a Codex
transcript. Only a session with no recorded agent falls back to cross-provider discovery.

### Codex facts (verified empirically — do not trust the docs)

**Submit is CR, never LF — for every agent.** Both TUIs read raw mode where Enter is `\r`
(0x0D); an `\n` inserts a newline in the prompt box and submits nothing.

**Rollout transcripts** live at
`~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl` and are **not cwd-keyed** — `cwd`
appears only in the first `session_meta` line (~8 KB; a naive 4 KB read truncates it
mid-JSON). `session_id` **is** the rollout UUID. Tool calls are **one line each**,
`function_call.arguments` is a JSON **string**, `custom_tool_call_output.output` is a JSON
envelope needing unwrap, and `event_msg` lines restate `response_item` text — parse one or
every turn doubles.

> **A Codex transcript path is DISCOVERED, never derived — so it must never be cached
> forever.** Codex writes a **new rollout on every run**, and resolution is "the newest
> rollout matching this cwd", so the correct answer changes while nothing about the
> web-terminal session does. Claude is immune for two independent reasons (its path is a
> pure derivation from cwd + conversation id, *and* its hooks re-stash it); Codex has
> neither. The provider declares `transcriptPathStable` and a discovered path is re-derived
> past a **10s TTL**. **Symptom to recognise:** a live, correct terminal next to a chat lens
> showing another day is a *resolution* bug, not a rendering one — and `cwd` alone is not a
> session identity when several rollouts share a directory.

> **A conversation needs an identity ON THE WIRE, or no cache can know it is stale.** That
> one gap produced the same bug twice, at two layers: the server cached a resolved path with
> nothing to invalidate it, then the client cached the turns themselves. The id is derived
> once in the registry (`conversationIdFromPath` — Claude's is the basename, Codex's is the
> trailing UUID of `rollout-<iso>-<uuid>.jsonl`; match it as a UUID, the ISO stamp has
> dashes too) and published as **`agentSessionId`**. **Do not fold it into
> `claudeSessionId`** however tempting: `app.html` shows the Fork button on that field and
> forks with `claude --resume <id>`. **Symptom:** terminal live, chat old — check the API
> first, because it decides whether you are chasing a server bug or a client one.

**Usage metrics.** Claude *pushes* its status line to `POST /api/claude-status`; Codex
*records* the same numbers in its rollout, so a provider may expose `readMetrics(tail)` and
the server fills the identical `metrics` shape. Three traps: `total_token_usage.total_tokens`
is the session's **cumulative** spend (millions — using it reports thousands of percent), so
context occupancy is `last_token_usage.input_tokens`; `cached_input_tokens` is a **subset**
of `input_tokens`, not an addition; and the 5h/7d windows are matched by **`window_minutes`
(300 / 10080)**, never by `primary`/`secondary` order. `turn_context` (model/effort) is
written once per **user** turn, so a long agent turn buries it above the tail — the server
reads head+tail.

**The cap itself is NOT a prompt — it is a rollout error, the exact opposite of Claude
(#142).** Claude presents an *answerable selector*, which is why the registry gives it a
`usageLimitPrompt` and `pty-worker.js` answers it with a digit. Codex presents **nothing to
answer**: the turn simply ends and the rollout records `task_complete` carrying
`error.codex_error_info: "usage_limit_exceeded"`. So a `usageLimitPrompt` for Codex is not
merely unmeasured, it is **the wrong shape entirely** — a PTY-scanning matcher would wait
forever for bytes that never come. `autoResume: { arm: false }` stands: **nobody has ever
hit Codex's 5h cap on this fleet**, so #142 does not unblock by waiting, and the real
question is that **Claude's auto-resume exists because a capped Claude session sits
BLOCKED**, while a capped Codex session returns to its composer.

**Hooks DO run, and `SessionStart` is LAZY** — it fires when the first turn begins, not
when the process starts (the same laziness as the rollout file). A hook that has not fired
yet and a hook engine that never fires look identical if you never start a turn. The
feature gate is `[features] hooks = true` in `~/.codex/config.toml`; trust is a real
interactive gate that **blocks before the composer renders** and is answerable with `2` +
Enter, recorded as a `trusted_hash` that survives across sessions.

> **Probing hooks is only safe if you clean up.** An installed-but-untrusted `hooks.json`
> **blocks every new Codex session** — the same failure class as the `Update available`
> nag, and fatal for a worker-spawned PTY that has nobody to answer it. Delete the file the
> moment the probe ends and relaunch once to confirm the composer returns. Strip the
> `[hooks.state]` entries too: a stale `trusted_hash` silently pre-trusts a matching
> definition later, with nobody reviewing it.

**Status comes from OSC 9 in the PTY.** With `tui.notifications = true`,
`notification_method = "osc9"` and `notification_condition = "always"`, the Codex TUI writes
its notifications straight into the terminal — for a normal user the *weaker* channel, for
web-terminal the *stronger* one, because **`pty-worker.js` is the terminal** and already
reads every byte. `notification_condition` defaults to `unfocused` and **a PTY has no focus
state**, so without `always` nothing is emitted and the feature looks broken rather than
unconfigured; `scripts/install-codex-notify.js` writes all three keys and **a COLD restart
is required** because this is worker-side.

- **`lib/osc9-notify.js` owns only the byte rule** and buffers across chunk boundaries. A
  notification fires **exactly once**, so a sequence split across two PTY reads that is
  dropped is a status that never updates — unlike the api-error sniff next door, which gets
  away with no buffering because its phrase stays on screen and repeats.
- **What a body MEANS is a registry field** (`statusFromOutput.approvalPattern`), never a
  branch. A plain shell and every unknown agent default to **not** reading status from
  output — OSC 9 is a general terminal notification that vim or a build script can emit.
- **Applied through `handleHook`** (an approval IS a `PermissionRequest`, a finished turn IS
  a `Stop`) so it inherits the idle debounce, held-stop rule and push rather than growing a
  second status machine. That reuse passes **`hookDriven: false`**: `handleHook` sets
  `session.hookStatus`, which `isClaudeSession()` reads as proof the session is Claude, and
  that gates the API-error sniff whose recovery **types** `continue` and `/compact` into the
  PTY. Arming it on Codex would type Claude's recovery into Codex's composer.
- **OSC 9 cannot be retired on its own:** it fires on exactly two occasions, an approval and
  a finished turn, so **`working` is unreachable through it by construction**. Hooks close
  that gap. Keeping OSC 9 as a zero-install fallback is defensible; relying on it *because
  hooks don't work* is not.

**NEVER copy `~/.codex/auth.json` into a second `CODEX_HOME`.** Codex refreshes on start
and the refresh token rotates; the copy triggers "refresh token was already used", and
reuse-detection can revoke the whole token family. Use a stub provider
(`model_providers.<name>` with `base_url`, `wire_api="responses"` — `"chat"` was removed)
and no auth file.

### How to verify Codex behaviour (methods that work)

- **The rollout is ground truth; the screen lies.** Codex writes a user message to its
  rollout only when a turn actually *starts*, so scraping the TUI cannot distinguish "text
  sitting in the composer" from "submitted". Assert on the rollout.
- **Probe in an already-trusted cwd that no live session uses.** A fresh directory triggers
  the trust prompt; a probe in a live session's cwd writes a *newer* rollout and hijacks
  that session's chat lens via `findRolloutForCwd`. Clean up probe rollouts afterwards.
- **Drive the real path, not a reimplementation.** Spawn `pty-worker.js` on an isolated pipe
  and send a real `TYPE_PTY_IN` frame (see `tests/worker-submit-cr.spec.js`);
  `__testGetWrites` returns the exact bytes written to the PTY.
- **A regression test must fail without the fix.** Flip the registry flag off and confirm
  the new specs go red before believing them.
- **Trust silently overrides `approval_policy`.** A probe asking for an approval in a
  *trusted* project just runs the command and never prompts. Force it with
  `-c sandbox_mode="read-only"` and a task that writes.
- **A `-c` override in an autoCommand goes through a SHELL.** Single-quote the whole
  override: `-c 'tui.notification_method="osc9"'`.
- **Never key readiness on "esc to interrupt", or on the startup banner.** A cold TUI prints
  `esc to interrupt` while booting MCP servers, and the npm shim can print a self-update log
  and exit straight back to bash. The banner is worse: it was contiguous text in 0.144.0 and
  is **not** in 0.144.6, so it broke on a routine auto-update. Key on the composer's
  model/effort line. Codex auto-updates **mid-run** — expect the version to move under you.
- **A setup failure must ABORT, never be folded into a negative verdict.** A TOML bare key
  after a `[table]` header belongs to that table, so `model = "..."` below `[features]` made
  Codex reject the whole config and never enable the hooks gate — reported by the probe as
  "hooks don't run". And Codex refuses to create its helper binaries under `%TEMP%`; put the
  probe's `CODEX_HOME` where `scripts/scratch-dirs.js` says.

### The agent task list (#73) — the issue's premise was inverted

**Check the tool names against real data before building on an issue's description.** #73
is titled after `TodoWrite`, which appears as an actual `tool_use` **zero** times across
400 transcripts — claude-code emits `TaskCreate` / `TaskUpdate` / `TaskList`. And the hard
part is the opposite of what the issue assumed:

- **Codex is the easy one.** `update_plan` carries the WHOLE plan every call (`arguments` is
  a JSON *string* holding `plan: [{step, status}]`), so the newest one in the rollout *is*
  the current state. Read the tail; remember nothing.
- **Claude is the hard one.** `TaskCreate`/`TaskUpdate` are **deltas**, and **the task id is
  not in the tool input at all** — it exists only in the result *prose*. Reconstructing the
  list means folding **forward** from the session start, which a **backward**-paging
  transcript reader cannot do, so Claude's list is folded from the live hook stream instead.

**`TaskList`'s result is a whole-list snapshot** and Claude is explicitly told to call it
after finishing a task — that is the **repair path** that makes a fold started mid-session
safe, and why losing the state on a hot reload is tolerable. Prefer a subject already known
from `TaskCreate` over the snapshot's: the line appends ` (owner)` and real subjects end in
parentheses too. **An update for a task whose create was never seen still renders** (as
`Task #<id>`) — dropping it would hide in-progress work, the single thing the panel exists
to show.

**The fold lives in `server.js` beside `pendingQuestion`, NOT in the worker** —
deliberately, and against the #61/#65 precedent. It is *derived, repairable* state rather
than an authority: it drives no dot and fires no push, so it needs no worker protocol change
and no cold restart. If it ever gains such a job, it belongs in the worker.

### Deployment consequence

Anything touching `pty-worker.js` (including `lib/agents.js` fields the worker reads) needs
a **COLD restart** — a hot `server.js`-only reload leaves the old worker running with the
old behaviour.

## A ConPTY `term.kill()` is ALREADY graceful — `/exit` buys nothing (#191)

**`session.term.kill()` does not hard-kill THE AGENT.** With `useConptyDll: true`
(production's default), node-pty's `PtyKill` closes the pseudoconsole and then
`TerminateProcess`es **the shell**. The agent is a *child* of that shell, and Windows
`TerminateProcess` does not touch descendants — so the agent is **orphaned rather than
killed** and runs its **ordinary shutdown**. What is graceful is the agent's exit, not the
teardown: bash is killed outright with exit code 1 and gets no shutdown at all. Nothing
here needs it to.

Measured (claude 2.1.251, three arms on real PTYs): `term.kill()` and an awaited `/exit`
both flush the transcript, fire `SessionEnd` and leave `lastGracefulShutdown: true`, while
`process.kill` on the agent itself writes nothing — so **the writing is done by the agent's
own shutdown, not by the teardown ceremony around it.** `/exit` adds exactly two artifacts,
both *caused by* typing `/exit` rather than preserved by it.

**So #191's `/exit` half is refuted for the session shape measured**, and Kill stays
instant: a ceremony that buys nothing makes Kill feel broken, and a submit is not reliably
one keystroke. The *rename* half is untouched and belongs at **naming** time.

**Before reopening, read limit 4 in the archive.** The measured session was minimal — no MCP
servers, no plugins, no statusLine — and **MCP teardown is the most plausible concrete form
of the report's "work Claude is doing" at exit**, which the probe could not have seen. Start
by adding MCP servers to the isolated config and rerunning the same three arms, rather than
re-arguing the ConPTY mechanism, which is settled. The evidence is also **Claude-only while
the decision is fleet-wide** (Codex and plain shells were not measured), and killing
**mid-turn** was never measured at all.

> **A probe that spawns `claude` from inside a Claude Code session must scrub `CLAUDE*` from
> the child env** — a nested child session persists nothing, so the measurement reads as
> "unmeasurable" when it is really "not isolated". **And a liveness check on a pid you
> failed to find PASSES**, so a probe that locates the agent by name must ABORT when the pid
> is null, or every wait loop exits on its first test and prints a plausible table having
> checked nothing.

## A resume is REPORTED, never predicted — and a retry is not a rescue (#227)

Two defects, one event. Reported as *"I saw a few with auto resume label but they didn't
resume."* Evidence — including the controlled pair inside one worker process that proves it
— is in `docs/findings/agents-codex.md`.

**Defect 1 — "the user is back" is not "the block is over."** `UserPromptSubmit` cancelled
the armed resume. A submitted prompt proves the user is PRESENT; it proves nothing about the
quota, and while capped that prompt cannot run. Nothing re-armed, so **the feature was
defeated by the most natural human response to the thing it exists to fix.**

The signal is not *is the user back* but **what they asked for**, which is why the fix is
one event wide: **Esc says STOP** (and only fires from `working`), **a tool event says WORK
IS RUNNING** (which genuinely proves the cap is not in force), **only a prompt says GO.**
The re-arm sits deliberately *after* `clearObservedCapBlock` and rides `session.capBlocked`
alone — the server's live, self-expiring reading — so #138's rule that a sighting must not
outlive its window is untouched.

**Defect 2 — `armed` was a PREDICTION of the worker's decision, evaluated against a subset
of the worker's gates.** It could not see the one-shot, the worker's own
`capBlocked`/`limitPromptAt`, or a hook having cancelled the timer, so both clients went on
rendering `resumes 21:51` with nothing scheduled. The worker had published the truth since
#138 (`autoResumeArmed`) and **no production code read it.** It is now the answer whenever
the worker gives one, with **ABSENT kept apart from FALSE** so a cluster peer merely behind
falls back to the derivation rather than going dark.

> **Sharing a MODULE is not sharing an ANSWER.** Both sides imported `lib/usage-limit.js`
> and then evaluated it against **different state**. SSOT is satisfied by one *owner of the
> fact*, not one *copy of the rule*: where a fact is a live decision some process already
> made, the honest wire field is that process's report. Same shape as #179 — do not predict
> whether the PTY accepted a submit; write it and check that it landed.

**A test pinned the broken behaviour** rather than catching it: the spec's helper defaults
`capBlocked = true`, so *"a new UserPromptSubmit cancels the pending continue"* asserted the
field failure exactly. Corrected, not deleted — and **the correction must not be made by
flipping `capBlocked` to false**, because nothing arms at all in that case and the test
would pass vacuously.

> **What the re-arm TRADES AWAY.** `clampPct` **rounds**, so a window at a real 99.5%
> arrives as exactly 100 and `isCapBlocked` is true while the account is still answering. A
> question-and-answer turn with no tool call now re-arms on its `UserPromptSubmit`, `Stop`
> does not cancel, and if the status line still rounds to 100 at reset+60s, `continue` is
> typed into a session whose last prompt was already answered. The only remaining guard is
> the `status === 'working'` check at fire time. A lead for a follow-up, unmeasured beyond
> three samples: **a cap-REFUSED prompt ends in a Notification-only idle with no `Stop`; a
> prompt that RAN ends in `Stop`.**

**Noted, unfixed:** `usage-limit:` appears **zero** times in the whole worker log across
three real cap events, so #138's PTY detector that answers the cap selector has never
matched in production. Not blocking — the session recovers at the reset without it.

## AskUserQuestion — the LAYOUT decides what the keys mean (#19)

Answering Claude's question overlay drives its real TUI selector by writing keys into the
PTY, and **the same digit does three different things depending on the layout Claude
picked**. The layout is not cosmetic and it is not guessable, so it travels on the wire:
`_shapeQuestions` publishes **`hasPreview`** per question and `buildAnswerFrames` is the one
place that turns it into keys. Evidence, probe transcripts and the full key tables:
`docs/findings/questions.md`.

**The rule.** When any option of a question carries a `preview`, that question renders
**side-by-side** (options left, preview box right); otherwise **compact**. Layout is per
**QUESTION**, not per prompt.

| question | compact | side-by-side (`hasPreview`) |
|---|---|---|
| single-select, **one** question | digit submits; a trailing Enter is a measured no-op | digit only MOVES the highlight; **Enter commits** |
| single-select, **multi**-question | digit selects **and auto-advances** the tab — an extra Enter would commit the NEXT tab's default row | digit advances nothing; **Enter commits AND advances** |
| multi-select | digits toggle and stay; **Right-arrow** advances (Enter would toggle) | n/a — previews are not supported on multi-select |

So a compact tab of a multi-question prompt must get **no** Enter and a previewed one
**must**. That is a branch, never an unconditional trailing Enter.

**`hasPreview` is derived from the RAW option list — never recompute it from the shaped
one.** The shaped list can lose a preview three ways: its option had no label and was
filtered out, it fell past `PQ_MAX_OPTIONS`, or the body was a non-string/whitespace and was
never attached. Any of the three silently flips the question to the compact layout, and the
layout decides what every answer key MEANS. (This drifted once *after* the rule was written
down, which is the argument for the test, not for more prose.)

**Verify with `scripts/rig/probe-askq-layout.js`** — it spawns the real `claude` on a real
PTY and reads the verdict from the transcript's `tool_result`. **Never assert on the screen:
it cannot tell *highlighted* from *submitted*.** A **pending** question is not in the
transcript at all (the `tool_use` is written only once answered), so "nothing recorded" and
"not yet answered" look identical — assert on *which option came back*. Shapes:
`preview-mq`, `plain-mq`, `preview-single`, `plain-single`, `plain-multi`, `plain-mq2`.

### The preview BODY crosses the wire too (#145)

It used to be dropped as *"free-form, can be large, and nothing renders it"* — right for
exactly as long as nothing rendered it. `_shapeQuestions` now publishes `preview` per
option, capped at **`PQ_PREVIEW_CAP = 2000`** — its own budget, not the 800 sized for a
label, because a preview is a multi-line **block**. The overlay renders it in **monospace
and unparsed** (its markup *is* the content) on the **selected row only**, clamped to
`kPreviewMaxLines` with a visible ellipsis. Revealing it on select mirrors the TUI, where
moving the highlight swaps the box and Enter commits; a tap here likewise only moves the
selection, so reading a preview never costs you a choice.

Selecting also **scrolls that row into view** — without it the feature is invisible in the
case it was reported from, since the option list gets ~two rows on a phone and choosing the
last option opens a ~300px block entirely below the viewport. Note the font too:
`'monospace'` is an Android/fontconfig alias that resolves to **nothing** on Windows, macOS
and iOS, so the block carries a `fontFamilyFallback`.

### `n` is preview-ONLY and `Type something.` is compact-ONLY (#143)

The two free-text affordances are **mirror images**, and the overlay offers exactly the one
its layout has. **A card offers the note affordance or the `Other…` row, never both** — so
"Other wins when both are set" is not a branch-order fact; the layout decides which is
eligible at all.

- **Notes exist only side-by-side.** The compact footer reads `Enter to select · ↑/↓ to
  navigate · Esc to cancel` and `n` is a **no-op** there. #64 Gap 1 shipped a note sequence
  that was never device-verified and was wrong in *both* layouts: on a compact card
  `↓×idx, n, <note>, CR` degenerates to `↓×idx, CR` — **a correct plain selection with the
  note silently discarded.** Nothing looked broken, which is why it survived to ship.
  *Confidently wrong is worse than absent.* The working sequence is
  `↓, n, <note>, ESC, CR`: **`Esc` closes the note EDITOR without cancelling the
  question**, despite the footer reading `Esc to cancel`. It is a lone `0x1b`, which
  `isEscapeKey` would read as an interrupt — but that rule is gated on a `working` session
  and one owing an answer is `waiting`, so it is not armed here.
- **`Other` exists only compact.** Side-by-side lists only the real options and then `Chat
  about this` — **there is no `Type something.` row at all**, and the un-gated sequence does
  not merely lose the free text: the trailing CR **submits an option the user never
  picked.** Compact (single and multi-question) works: the digit opens a free-text editor
  and Enter commits it and advances the tab.
- **Multi-select holds.** The trailing row is a **checkbox** with no free-text input;
  submitting with only it checked records **`The user did not answer the questions.`** — the
  whole answer comes back null, not merely textless.

Claude also renders a **`Chat about this`** row at `options.length + 2` that the overlay does
not model at all.

### A live question was erased by the NEXT tool — a SUBAGENT's counted (#236/#239)

The clearing rule beside `pendingQuestion` in `server.js` read *"a different tool started ->
prior question resolved"*. True of a strictly **sequential** single agent; false the moment
anything runs concurrently beside it — which is the ordinary shape of a session that has
dispatched a subagent. Measured: the subagent's `Bash` cleared the main agent's question 19
ms after it was asked, and the user answered 37 s later — **37 s of a question nothing was
showing.**

**Both of the chat lens's signals die together, which is why NOTHING showed.** `waitingFor`
(#79) needs status `waiting` **and** a captured question, and the overlay's
`/pending-question` falls back to a transcript that **by design cannot hold an unanswered
question** (#19). The lone survivor was #194's terminal tail strip — the *backstop* —
reported as *"no indication, instead a last line small window"*.

**The rules now:**

1. **Only the MAIN agent's next tool resolves a question** — `!agentId` is the whole fix,
   and the discriminator was already free (`agent_id` is read in that same function for
   #61). `UserPromptSubmit`, `Stop` and the question's own `PostToolUse` stay ungated.
   Gated on the **EVENT's** agent, not the question's: *"only the agent that ASKED it may
   resolve it"* is more general and would generalise a case that has never occurred (**0 of
   775** subagent transcripts here contain an AskUserQuestion).
2. **`armIdle` refuses to idle a session with a pending question** (#239) — the funnel BOTH
   idle routes pass through, rather than a copy at the release site. When subagents are live
   an idle `Notification` is parked as `heldStop` *before* the question check, so the
   `SubagentStop` that releases it bypassed the guard entirely: **the SUBAGENT finishing
   idled a session blocked on the MAIN agent's question.** Exactly one of the two holdable
   events is dangerous — a held `Stop` is safe by accident (`server.js` classifies it as
   resolving a question and sends `questionPending:false` with it), while a `Notification`
   carries no opinion (#98's tri-state) so the flag survives the hold.

The check sits at **arm** time, not in `applyIdle`, because `applyIdle` runs the #129 compact
replay above the status flip and returning early there would skip it. The debounce window
that ordering appears to leave open **cannot happen**: `questionPending: true` is only ever
sent for `PreToolUse` + `AskUserQuestion`, and the worker's `PreToolUse` case calls
`cancelPendingIdle` — the very hook that raises the flag destroys any armed idle. *Naming a
gap is only worth doing if the gap is real; an invented one is the same defect as an
unmeasured claim, wearing humility.*

**On this path the worker needs no matching guard**, a decision rather than an omission: its
status is `questionPending ? 'waiting' : 'working'`, so the session stays `waiting` and is
spared the 5-minute clock. Since #230 a blocked-on-user session is **not timed out at all**.

## The session recap — "my last prompt" is NOT `role === 'user'`

`GET /api/sessions/:id/recap` (rules in `lib/recap.js`, pure) answers *where was I in this
one?* for a sidebar full of sessions: last prompt, the agent's latest word, the current task,
and the work done since.

**The trap:** a transcript is full of `role:user` turns the human never typed — a teammate
message, a `<task-notification>`, Stop-hook feedback, a post-compaction summary, and above
all **slash commands**. Running `/compact` writes a user turn whose text is
`<command-name>/compact</command-name>`, so in a just-compacted session — precisely when you
most need a recap — the newest user turn is that echo, and a naive reading reports *"your
last prompt was: compact"*. **Confidently wrong is worse than absent.** Genuine prompts also
arrive with `<system-reminder>` blocks stapled on, so even a real one needs its wrapper
stripped, and a turn that is *nothing but* reminders is not a prompt at all.

**`lib/user-turn.js` is the one owner of what a `role:user` turn IS** — `classifyUserTurn`
(which turns a human actually TYPED) and `typedTextOf` (the characters they typed, which the
chat lens's Queued echo matches on, #149). Its only import is the leaf `lib/ansi.js`, so
`lib/transcript.js` can use it without a require cycle. `lib/recap.js` re-exports
`classifyUserTurn` for its existing importers — **change the rule in `lib/user-turn.js`,
never there.**

**Reuse, don't re-derive:** the reply prefers an author-marked `## TL;DR` through
`lib/speech.js`'s `extractSummary` — that section exists to be exactly this. **On demand,
never on the poll** — one recap costs a transcript tail read, and doing it per row per
sidebar refresh would be a disk storm for text nobody is looking at. **Degrades, never
404s:** a plain shell has no transcript, but *"idle, in `<cwd>`, 20m ago"* still orients
you, and a 404 would make the icon look broken on exactly the rows most likely to be
clicked.

> **`classifyUserTurn` currently exists twice** — here and in the companion's
> `conversation_view.dart`, which uses it for bubble labelling. The server copy is the
> authority and recognises strictly more. Consolidating the Dart side onto a
> server-published field is a separate additive change, **not** a "keep them in sync"
> instruction.

## A prompt sent WHILE THE AGENT WORKS is not a `role:user` turn (#249)

Claude Code records a prompt submitted mid-turn as an **attachment**, never as a user
message: `{"type":"attachment","attachment":{"type":"queued_command","prompt":"…",
"commandMode":"prompt","origin":{"kind":"human"}}}`. `parseTranscriptTurn` read only
`user`/`assistant` lines, so **the chat lens never received the prompt at all** — the only
thing showing it was the client's optimistic `Queued` echo (#31), rendered *after* every
transcript turn, so everything the agent produced in reply appeared **above** it. And the
echo reconciles by matching a turn's `typedText` (#149); against a turn that does not exist
it can never match, so the 90 s safety timeout **deletes** it and the prompt leaves chat
entirely.

**The fix is one branch in `lib/transcript.js`, server-side only** — the chat lens is fixed
with **no client release** and it **hot-reloads**. The turn is emitted at the attachment's
own byte position, which is what puts it above the reply. An older companion is covered by
construction: `turnMatchKey` falls back to `normEcho(turn.text)` when `typedText` is absent,
and here `text === typedText`.

**TWO GATES, and both are narrowings rather than sniffs.** `commandMode === 'prompt'`
excludes `task-notification` (520 of 641 records — plumbing, and 34 of them restate a
notification that already arrives as a real `role:user` turn). `origin.kind === 'human'`
excludes `peer`: another agent's queued message is wrapped in `<agent-message from="…">`, **a
signature `classifyUserTurn` does not recognise** — it classifies as `human`, so admitting
one would put another agent's words in a **"You"** bubble, the teammate-bubble bug this repo
has already paid for once. A queued teammate message therefore stays invisible in chat; that
is #250, and its fix is a signature in `lib/user-turn.js`, not a wider gate here.

**Build the turn from `attachment.prompt`, never from `rendered`.** The `rendered` array
restates the prompt inside a `<system-reminder>` telling the *agent* how the message was
delivered — wrapper text, not what the user typed, and an echo compared against it could
never match. Same trap as #149, one layer out. A queued prompt carrying a pasted image
arrives as content blocks: keep the text, drop the base64.

*Say "the chat lens", not "both clients".* Only the companion has one — `app.html` carries
no reference to `/transcript`, `typedText` or `userKind` at all. That exact phrase is
recorded as wrong twice in this repo's history.

> **MUTATE ONE GATE AT A TIME, and a negative fixture faithful to the corpus is the one most
> likely to be vacuous.** Both gate tests were confirmed red by removing BOTH gates together,
> which proved nothing about either: the `task-notification` fixture is drawn from real data
> where all 520 carry **no `origin`**, so the ORIGIN gate turns it away and
> `commandMode !== 'prompt'` could be deleted with the whole suite still green. The fix is a
> second, deliberately **synthetic** fixture whose only job is to fail when that one line
> goes. The usual vacuous negative passes because the feature is absent; this one passes
> because a *different* guard fires first.

> **And state the PREDICATE, not just the count.** A first draft claimed 9 of the 520
> task-notifications already arrive as real user turns; that 9 came from testing a 120-char
> prefix. A 60-char prefix gives 15, exact equality gives **0**, and the sound comparison —
> the `<task-id>` they share — gives **34**. A measurement whose answer moves with a
> parameter nobody chose deliberately is not a measurement.

## The chat lens's tail strip shows the FURNITURE unless something else is on screen (#194/#210)

The strip shows the terminal's last few non-blank rows inside the chat lens, so a session
parked on something chat has no bubble for is still visible. #179 is why it shows the screen
rather than naming the state: **not one blocked state emits a distinguishing byte**, so a
classifier for "blocked" is permanently incomplete.

**That thesis is right, and the first implementation read it too literally.** Claude ends
every composer screen with a FIXED FOOTER, so "the last 4 non-blank rows" and "that footer"
are **the same thing by construction**, whatever happened above them. The strip rendered four
identical rows on every idle session, held ~90px of the chat view open to do it, and was
least informative in exactly the state its own gate selects for.

**The fix inverts what is recognised.** Recognise exactly ONE thing — the ordinary composer
marker (#190's caret + U+00A0, **published on `GET /api/agents`** rather than retyped in
Dart) — and recognise it in order to **stay quiet**. A screen without that marker near its
foot falls through to the tail as before, whether or not anyone has measured it. **The
failure direction is showing the terminal, never hiding it**, which is the opposite of a
classifier's, so #179's argument does not apply. The strip appearing now MEANS something is
on screen.

`kComposerScanRows = 7`, inside a measured bound of **[5, 8]**: at least the widest idle
footer (4, plus a row for an update notice), strictly under the **narrowed slash menu's 9**.
**The narrowed menu sets the ceiling, and measuring only the bare `/` would have missed
it** — bare `/` is the menu at its TALLEST (16 rows up), and typing a few characters filters
the list and brings the caret back to 9. A first cut sat at 8 and cleared that by one row.

**The anchor is the last row WITH CONTENT, not the bottom of the viewport.** A real idle
screen puts its content in rows 0–12 of a 30-row viewport, so counting up from the viewport
floor put the caret 17 blank rows out of reach — a silent no-op that changed no behaviour at
all, and **every synthetic fixture passed against it** because none had trailing blanks.
*A screen is not the same shape as a window* — the same anchor-on-content lesson as
#167/#178, from a third direction.

**Say "a screen without the marker", not "every dialog".** The **tool-approval /
AskUserQuestion selector was NOT measured** — no capture of one exists in this repo, and
#190 established NBSP-absence for the trust dialog only. If that selector draws the composer
within the window, the strip hides on a blocked screen. It is the least costly place for the
gap to sit (a hook-driven wait already has #79's banner and the #19/#143 overlay), but it is
a gap, not a proof, and it needs a rig case before anyone claims otherwise.

**Codex is deliberately unchanged** — it declares no readiness marker and its composer line
varies with model and effort, so it publishes null and the strip behaves as before #210.
A screen marker for Codex is its own separately-measured change, and it would **not** be
safe to reuse `readiness.composer` for it, because that field also gates submits.

**Captures are deliberately NOT checked in** (#146's rule): an idle frame carries a status
line naming a project and a user, and this repo is public. Keep the numbers, drop the bytes.

## Scrollback has TWO byte spaces, and they diverge at the HEAD (#167/#176/#178)

**A byte offset into a session's scrollback is not a position.** `pty-worker.js` trims the
buffer's HEAD on every PTY write (2 MB cap), so `offset 0` names a different byte on every
request while `total` sits pinned at the cap — and nothing on the wire says so. Every paging
bug in this area is that one fact, met from a different direction. The rule everywhere is:
**anchor on CONTENT, over-fetch so the anchor is inside the slice, cut where it reappears,
and STOP rather than guess** — the failure mode is less history, never history that repeats
and never a silent hole.

**And the server builds two DIFFERENT strings from that one buffer:** the WS attach replay
**truncates** the raw buffer to `scrollbackReplayLimit` and *then* sanitises, while
`GET /api/sessions/:id/scrollback` sanitises the **whole** buffer and *then* slices.
`sanitizeReplay` is length-changing **and stateful** (it tracks alt-screen from the start of
whatever string it is given), so those two orders are **not** equivalent. Measured on
escape-heavy content they share a 30947/31517 **suffix** and disagree at the **head**: the
truncated copy begins mid-stream, never sees the earlier `ESC[?1049h`, believes it is
outside alt-screen, and strips an `ESC[2J` the whole-buffer pass keeps.

**So they agree over the TAIL and disagree near the HEAD.** Any rule that lines the two up
must take its anchor from the **end of what is on screen**, never from the head of an
incoming replay — which is what `ai-terminal/lib/util/attach_overlap.dart` does (#176), and
why `tests/attach-replay-overlap.spec.js` pins the invariant **on the server**, with a 2x
margin over the companion's 4096-unit anchor. That gate is server-side on purpose:
reordering either sanitise pass is a server change, and it would otherwise surface only as
#176 coming back on a client nobody was testing.

The attach replay also carries an `ESC[?2004h` prefix when the session is in bracketed-paste
mode. That is terminal **state**, not content — it is not in the scrollback and can never
match an anchor, so a cut must preserve it rather than treat it as duplicate bytes.

`lib/scrollback-window.js` holds the pure content-anchored walk and is **served to
`app.html` at `/lib/scrollback-window.js`**, so the browser runs the same bytes
`tests/scrollback-window.spec.js` pins rather than a pasted copy. It is a port of the
companion's `ai-terminal/lib/util/scrollback_window.dart` (#167), which stays the canonical
write-up of the rule.

## The companion vendors `xterm` — do not undo it (#81)

`ai-terminal/third_party/xterm` is stock xterm 4.0.0 **plus one patch**, wired in by
`dependency_overrides`. Full write-up: `ai-terminal/third_party/xterm/README-PATCH.md`.
Every hunk is marked `WEB-TERMINAL PATCH (#81)` — **grep for it before re-vendoring or
"upgrading"**, because 4.0.0 is the latest release and a bare re-vendor silently restores the
bug.

**One defect produced two symptoms that read as unrelated bugs.** `Buffer.scrollUp`,
`scrollDown` and `deleteLines` shifted a line with `lines[to] = lines[from]`, which copies
the *reference*: the line ends up in two slots, and since `_adoptChild` unconditionally
detaches the destination's previous occupant, the next iteration detaches the line the
previous one just moved. A scroll left 27 of 30 lines **still in the array but detached from
it**. Detached lines still *paint*, but `TerminalController.selection` is null whenever
either anchor is detached — that is "text visible, nothing selects". And a later `_moveChild`
dereferences `_owner!`: an assert in debug, a **hard throw out of `Terminal.write` inside a
WebSocket listener** in release, which kills the widget subtree — that is the blank terminal.
Codex-only because those three methods are reached only inside a DECSTBM margin, and Codex
sets 12 scroll regions on startup where Claude's TUI sets none. `insertLines` right next door
already used `lines.swap` and was correct, which is how we know it was an oversight.

**Two methodological lessons, both of which cost a wrong root cause first.** (1) *A blank
lens next to a healthy chat lens is not evidence about the server* — chat is built
server-side from the rollout and never touches xterm, so the two lenses failing differently
localises the fault to the widget. (2) *Instrument, don't reason about buffer internals.* Two
confident hypotheses were wrong; a five-line `print` in `_adoptChild` named the real cause in
one run.

**Verification bar for any change here:** run upstream's own suite against pristine and
patched copies and compare (README-PATCH.md has the recipe). Both give `+108 ~2 -2`; the two
`textScaler` failures are pre-existing Flutter-SDK drift.

## Chat links are TextSpans — never a widget in the text flow (#83)

**A `MarkdownElementBuilder` can only return a Widget, and a widget cannot live inside a
paragraph.** That one API fact is the whole bug, and it is worth stating because the builder
API *looks* like the natural place to add a per-link affordance. Measured on
flutter_markdown 0.7.7+1, rendering `see LINK tail`: a custom `a` builder produces **4**
RichTexts (`"see "` | `"example"` | `" tail"` — separate render objects), native `onTapLink`
produces **2** (one paragraph).

The ancestor `SelectionArea` (#27) walks a **paragraph**, so a shattered sentence is one it
cannot drag across — which is why the symptom was *"dragging selects nothing"* rather than
the narrower "the URL isn't selectable": **the link poisons the whole sentence around it.**
The widget's own `GestureDetector` compounded it (`onLongPressStart` holds the gesture arena
for exactly the button-down a selection drag begins on), and the builder attached the tap
recognizer to the **wrong fragment** (`" tail"`), so tapping trailing prose opened the link
while the link text did nothing.

**The rule going forward:** any per-link affordance must be reachable from a `TextSpan`
recognizer or from the `SelectionArea`'s context menu — **never from a widget in the text
flow.** Reintroducing a builder to add "Copy link" silently reintroduces this bug.

**What the fix traded away, deliberately:** the per-link long-press / right-click "Open /
Copy link" menu is gone. It existed *because* links were unselectable. For a bare autolinked
URL — what an agent actually prints — the link text **is** the href, so ordinary select +
copy now yields the URL. For a labelled link the URL is no longer copyable from the UI; a tap
still opens it.

**Two traps, both of which cost a wrong answer first.** (1) **A widget test cannot see this
bug, and a *plausible* widget test can be worse than none** — the first test asserted "no
`WidgetSpan` in the span tree" and **passed against the buggy code**, because the mechanism
is paragraph fragmentation, not a `WidgetSpan`. Assert on the RichText *count* for a
sentence, and on which span carries the recognizer. (2) **Instrument, don't reason** (the #81
lesson again).

**Still not verified by an automated test:** that a real mouse drag on the shipped Windows
build highlights. Synthetic pointer events never traverse the OS input path — eight widget
tests passed against the original report. Use `scripts/rig/probe-drive-selection.ps1` with a
URL-containing fixture and **always `-ShotDuring`**: without the mid-drag screenshot,
"nothing was selected" and "nothing was rendered to select" are indistinguishable.

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
- **A route that WRITES config must first prove it could READ it** (#257, #264). A
  `config.json` that exists but will not parse throws inside the *first* branch of the
  startup load, so the `config.default.json` fallback is never reached, `config` stays `{}`
  and `PASS` lands on the `'admin'` literal — which makes `needsPasswordChange()` true on an
  **established** server and opens `POST /api/setup`. Read-mutate-write over that `{}` then
  *replaces* the file: `/api/setup` leaves `{user, password}` and the cluster is gone,
  `/api/cluster/register` leaves `{cluster:[…]}` and the **credentials** are gone, so the
  next restart boots on the default password. `readConfigResult()` separates ABSENT from
  UNREADABLE; absent still writes (a real first run, and every CI checkout), unreadable is
  refused with the file byte-identical on disk. The refusal names no server path — the log
  does, the response does not. Gated against the SOURCE, not just per route, because #264 IS
  #257 found again four weeks later on two routes no behavioural test could have covered:
  `tests/issue264-config-write-paths.spec.js` fails on any `writeConfig()` inside a route
  handler that has no `readConfigResult()` guard above it.
  - **Still open, and it is the more serious half:** whether a corrupt `config.json` should
    be allowed to drop a running server to the default password *at all*. That is a startup
    question, not a write-path one. Note `/api/setup` is **not** literally unauthenticated —
    the middleware exempts it only after a session cookie verifies, or a valid API token
    passes the `Bearer` / `?token=` branches beside it — but the corruption is what hands
    out the credentials to get in: `PASS` **and** `_USER` both fall back to `admin`, and the
    startup banner prints `Auth: admin:***`.

## Test Config
- Tests run on port 17681 with credentials: testuser / testpass:colon
- Uses Playwright for both API and browser tests
- Test config in `playwright.config.js`
- Tests backup/restore config.json but overwrite the password hash — re-apply the correct password after running tests
- **`WT_CONFIG_FILE` redirects the config path outright**, for all three supervised
  processes — `server.js`, `pty-worker.js` and `monitor.js` derive that path independently,
  so an override honoured by only some of them would not isolate a test, it would split one
  live setting across the tree. Same shape and same reason as `WT_CLUSTER_TOKENS_FILE` and
  `WT_CLAUDE_METRICS_FILE`: a test that has to
  drive a *destructive* config path needs a file of its own, and redirecting is stronger
  than backing the real one up, because an interrupted run never reaches its restore.
  `tests/issue264-config-write-paths.spec.js` needs it — `POST /api/setup` opens only on a
  server whose PASS is the default, which the suite's own server is not and must not become,
  so that half spawns an isolated `server.js` with its own config, port, pipe and data dir.
- **`config.test.json` is DELETED at the start of every run** (`playwright.config.js`, #240).
  It is gitignored, so it is per-machine state no checkout restores and `global-teardown.js`
  does not cover it — whatever the last run left was what the next one started from, forever,
  on that machine alone. Deleting puts each run in the state a fresh CI checkout is already
  proven green from. It cannot live in `global-setup.js`: Playwright runs plugin setup, where
  `webServer` lives, BEFORE globalSetup, so `server.js` would already have read the poisoned
  file — and `_refreshLiveConfig` skips a file that is missing, which would pin the stale
  values in cache for the whole run instead of clearing them.

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
