# Multi-agent, Codex, kill/exit and auto-resume — measurements and history

> **Findings archive.** Moved verbatim out of `CLAUDE.md` on 2026-09-15, when that
> file passed the 150k-char context limit. Nothing was rewritten or summarised.
>
> `CLAUDE.md` carries the **rules**; this file carries the **evidence** — measurements,
> probe recipes, refuted hypotheses and review post-mortems. Read it before reopening
> any issue it covers, and add new measurements here rather than to `CLAUDE.md`.

---

## Multi-Agent Support (Claude Code + Codex)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

A session knows *which* AI CLI agent it runs. `agent` is a real, persisted session field:
`'claude'`, `'codex'`, or `null` for a plain shell. **`null` is never coerced to
`'claude'`.** Evidence and the full Codex empirics: `docs/findings/agents-codex.md`.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

A session knows *which* AI CLI agent it runs. `agent` is a real, persisted session field: `'claude'`, `'codex'`, or `null` for a plain shell. **`null` is never coerced to `'claude'`.**

### The rule: one registry, no branching

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

Everything agent-specific lives in **`lib/agents.js`** — parser, transcript root,
transcript-resolution strategy, subagent-trace support, label, colour, submit policy,
readiness, submit confirmation. **Adding a CLI agent is one parser module + one registry
entry.** If you find yourself writing `if (agent === 'codex')` in `server.js`,
`pty-worker.js`, `app.html` or the companion, you are in the wrong file — add a field to
the provider instead.

`GET /api/agents` serves the catalogue, so both clients render the picker, the per-agent
tint and (since #210) the composer marker with **no client release** when an agent is added
or renamed. The companion holds no agent table; neither does `app.html`.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

Everything agent-specific lives in **`lib/agents.js`** — parser, transcript root, transcript-resolution strategy, subagent-trace support, label, colour, and submit policy. **Adding a CLI agent is one parser module + one registry entry.** If you find yourself writing `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html` or the companion, you are in the wrong file — add a field to the provider instead.

`GET /api/agents` serves the catalogue, so both clients render the picker and the per-agent tint with **no client release** when an agent is added or renamed. The companion holds no agent table (`AgentCatalog`); neither does `app.html`.

An **explicit** agent is authoritative: a session declared `claude` is never served a Codex transcript. Only a session with no recorded agent falls back to cross-provider discovery.

### Codex facts (verified empirically against codex-cli 0.144.0 — do not trust the docs)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Status comes from OSC 9 in the PTY — the channel that replaces hooks.** With `tui.notifications = true`, `notification_method = "osc9"` and `notification_condition = "always"`, the Codex TUI writes its notifications straight into the terminal. For a normal user that is the *weaker* channel (it only paints in their emulator — which is why `approval-requested` on the external `notify` program is still an open upstream request: openai/codex #11808, #17716, #19921). For web-terminal it is the *stronger* one, because **`pty-worker.js` is the terminal** and already reads every byte.

- **Measured off a real PTY** (0.144.0, re-confirmed end-to-end on 0.144.6): an approval emits `ESC]9;Codex wants to edit 0 files BEL`; a finished turn emits the agent's last message the same way. The external `notify` program only ever fires `agent-turn-complete` — its payload is `{type, thread-id, turn-id, cwd, client, input-messages, last-assistant-message}`.
- **`notification_condition` defaults to `unfocused`, and a PTY has no focus state** — without `always`, nothing is emitted and the feature looks broken rather than unconfigured. `scripts/install-codex-notify.js` writes all three keys (sibling of `install-statusline.js`); **a COLD restart is required** because this is worker-side.
- **`lib/osc9-notify.js` owns only the byte rule** and buffers across chunk boundaries. A notification fires **exactly once**, so a sequence split across two PTY reads that is dropped is a status that never updates — unlike the api-error sniff next door, which gets away with no buffering because its phrase stays on screen and repeats.
- **What a body MEANS is a registry field** (`statusFromOutput.approvalPattern`), never a branch. A plain shell and every unknown agent default to **not** reading status from output — OSC 9 is a general terminal notification that vim or a build script can emit, and none of them is an agent.
- **Applied through `handleHook`** (an approval IS a `PermissionRequest`, a finished turn IS a `Stop`) so it inherits the idle debounce, held-stop rule and push rather than growing a second status machine. That reuse passes **`hookDriven: false`**: `handleHook` sets `session.hookStatus`, and `isClaudeSession()` reads that flag as proof the session is Claude, which gates the API-error sniff whose recovery **types** `continue` and `/compact` into the PTY. Arming it on Codex would type Claude's recovery into Codex's composer.
- **NOT established:** what a *declined* approval emits. A lone Esc produced no further notification, but Codex's approval UI is a select list, so Esc most likely never answered it — the rig confirmed the session correctly stays `waiting` on a question nobody answered. Note `noteInterrupt` is gated on `working` on purpose, so Esc at a permission prompt is an answer, not an interrupt.

**NEVER copy `~/.codex/auth.json` into a second `CODEX_HOME`.** Codex refreshes on start and the refresh token rotates; the copy triggers "refresh token was already used", and reuse-detection can revoke the whole token family. Use a stub provider (`model_providers.<name>` with `base_url`, `wire_api="responses"` — `"chat"` was removed) and no auth file.

### How to verify Codex behaviour (methods that work)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

- **The rollout is ground truth; the screen lies.** Codex writes a user message to its rollout only when a turn actually *starts*. Scraping the TUI cannot distinguish "text sitting in the composer" from "submitted" — reading the rollout can. Assert on the rollout.
- **Probe in an already-trusted cwd that no live session uses.** A fresh directory triggers Codex's trust prompt. A probe run in a live session's cwd writes a *newer* rollout and will hijack that session's Chat lens via `findRolloutForCwd`. Clean up probe rollouts afterwards.
- **Drive the real path, not a reimplementation.** Worker behaviour is testable by spawning `pty-worker.js` on an isolated pipe and sending a real `TYPE_PTY_IN` frame (see `tests/worker-submit-cr.spec.js`); `__testGetWrites` returns the exact bytes written to the PTY.
- **A regression test must fail without the fix.** Flip the registry flag off and confirm the new specs go red before believing them.
- **Trust silently overrides `approval_policy`.** A probe asking for an approval in a *trusted* project (`c:\dev` is trusted here) just runs the command and never prompts. Force the prompt with `-c sandbox_mode="read-only"` and a task that writes — otherwise you "prove" an approval path that never ran.
- **A `-c` override in an autoCommand goes through a SHELL.** `-c tui.notification_method="osc9"` loses its quotes to bash and Codex rejects the bare TOML value at startup. Single-quote the whole override: `-c 'tui.notification_method="osc9"'`.
- **Never key readiness on "esc to interrupt", or on the startup banner.** A cold TUI prints `esc to interrupt` while booting MCP servers, and the npm shim can print a self-update log and exit straight back to bash — both false-positive, and the prompt then goes to the shell where it submits nothing. The banner is worse: `OpenAI Codex (v0.144.0)` was contiguous text in 0.144.0 and is **not** in 0.144.6, so it broke on a routine auto-update. Key on the composer's model/effort line (`gpt-5.5 high`). Codex auto-updates **mid-run** — expect the version to move under you.

### The agent task list (#73) — the issue's premise was inverted

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

**Check the tool names against real data before building on an issue's description.** #73 is titled after `TodoWrite`, which appears as an actual `tool_use` **zero** times across 400 transcripts — claude-code emits `TaskCreate` / `TaskUpdate` / `TaskList`. And the hard part is the opposite of what the issue assumed:

- **Codex is the easy one.** `update_plan` carries the WHOLE plan every call (`arguments` is a JSON *string* holding `plan: [{step, status}]`), so the newest one in the rollout *is* the current state. Read the tail; remember nothing.
- **Claude is the hard one.** `TaskCreate`/`TaskUpdate` are **deltas**, and **the task id is not in the tool input at all** — it exists only in the result *prose* (`"Task #7 created successfully: …"`; `TaskUpdate` does carry `taskId`, but only because the model was told the id by that prose). Reconstructing the list means folding **forward** from the session start, which a **backward**-paging transcript reader cannot do. So Claude's list is folded from the live hook stream instead.

**`TaskList`'s result is a whole-list snapshot** (`#6 [completed] subject (owner)`) and Claude is explicitly told to call it after finishing a task — that is the **repair path** that makes a fold started mid-session safe, and it is why losing the state on a hot reload is tolerable. Prefer a subject already known from `TaskCreate` over the snapshot's: the line appends ` (owner)` and real subjects end in parentheses too, so stripping it would mangle titles.

**The fold lives in `server.js` beside `pendingQuestion`, NOT in the worker** — deliberately, and against the #61/#65 precedent. It is *derived, repairable* state rather than an authority: it drives no dot and fires no push, so it needs no worker protocol change and no cold restart. If it ever gains such a job, it belongs in the worker.

**An update for a task whose create was never seen still renders** (as `Task #<id>`). Dropping it would hide in-progress work, which is the single thing the panel exists to show.

### Deployment consequence
Anything touching `pty-worker.js` (including `lib/agents.js` fields the worker reads) needs a **COLD restart** — a hot `server.js`-only reload leaves the old worker running with the old behaviour. See "Deployment & Operations".

## A ConPTY `term.kill()` is ALREADY graceful — `/exit` buys nothing (#191)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

**`session.term.kill()` in `pty-worker.js` does not hard-kill THE AGENT.** With
`useConptyDll: true` — production's default, and `config.json` does not override it —
node-pty's JS path is `this._inSocket.destroy(); this._ptyNative.kill(pty, true)`
(`windowsPtyAgent.js:133-161`), and the console-process-list walk that `process.kill`s
every pid really is the *other* JS branch (`!useConptyDll`, `:162-179`) — and that walk
*includes the agent*, which is why a deployment there is expected to behave like arm C.
So **the kill leaves the agent alive — only the shell is terminated** — and it runs its
**ordinary shutdown**, which is why today's "hard kill" already ends with
`lastGracefulShutdown: true`.

The wording is deliberate: *"the agent sees its console close and…"* names **one of two
indistinguishable causes** and stood here until review. The console close and the shell's
death happen microseconds apart inside one native call, so the agent loses its console and
its parent at the same instant and nothing measured says which triggered the exit.

> **But "it only closes the pseudoconsole" is WRONG, and this file said so until a review
> read one layer further down.** `PtyKill` in node-pty's own
> `src/win/conpty.cc:534-568` calls `ConptyClosePseudoConsole(handle->hpc)` and **then**,
> *only* in the `useConptyDll` branch, `TerminateProcess(handle->hShell, 1)`. `hShell` is
> the process node-pty `CreateProcess`'d (`:442`) — **the shell**. So production's path
> closes the pseudoconsole *and* hard-terminates bash, which is the exact inverse of the
> impression the sentence above gave on its own.
>
> **The conclusion survives and is better explained for it.** The agent is a *child* of
> that shell, and Windows `TerminateProcess` does not touch descendants — so the agent is
> never terminated. It is orphaned rather than killed, and exits on its own, which
> is a more specific account of the ~870 ms than "the console closed" and also explains
> why no shell lingers. **What is graceful is the agent's exit, not the teardown**: the
> shell is killed outright with exit code 1 and gets no shutdown at all. Nothing here
> needs it to.
>
> **The methodological lesson is the one this repo keeps re-learning.** The original claim
> was read off `windowsPtyAgent.js` — where the branch names really do say what it said —
> and stopped there. The JS layer's vocabulary was mistaken for the behaviour. *Read to
> the layer that acts*, the same rule as "the rollout is ground truth; the screen lies".

**MEASURED** (`scripts/rig/probe-exit-flush.js`, claude 2.1.251, 2026-08-31), invoked
`--arms ABC --dwell 20000` — **neither is the default** (`--arms AB`, `--dwell 0`), so the
control arm is off unless you ask for it and a rerun that omits these does not reproduce
the table. Three arms, each a real PTY spawned production-shaped, gated on the #190
composer marker, one completed turn, 20s dwell, then ended:

| | A `term.kill()` (today) | B `/exit` awaited | C `process.kill` (control) |
|---|---|---|---|
| transcript lines at teardown | +4 | +5 | **0** |
| `lastGracefulShutdown` | false -> **true** | false -> **true** | stays **false** |
| `SessionEnd` hook | **fired** | **fired** | not fired |
| `.claude.json` | 29 project keys | the same 29 | **byte-identical** |
| time for the agent to go | ~870 ms | ~1030 ms | ~15 ms |

*Two rows are weaker than they look, and knowing which matters if you rerun this.* The
`29` is a hand tally of key-diff rows — no code path emits a count. And **`byte-identical`
is printed off an empty KEY diff, not a byte comparison**; the claim happens to be true
because the tree sha1 corroborates it independently, but the line asserting it could not
establish it. Likewise `{"display":"/exit"}` was read out of `history.jsonl` directly —
`diffTrees` prints paths and sizes, with content previews for the transcript alone.

**Arm C is the control that proves the mechanism — and what separates it from A is WHICH
PROCESS is terminated, not whether one is.** Both arms hard-terminate something: A
terminates the *shell* (see the correction above), C terminates the ***agent itself***
(`process.kill(R.claudePid)`, on a pid the probe discovered by walking down from one it
spawned). A `TerminateProcess`d agent writes none of the four lines, fires no `SessionEnd`
and leaves `.claude.json` byte-identical — so **the writing is done by the agent's own
shutdown, not by the teardown ceremony around it**, and that shutdown is reachable
precisely because A leaves the agent alive to run it. Stated as
"terminate versus no terminate" — as this section did at first — the control would prove
nothing, because A terminates too.
A and B differ by **two artifacts in two different files** — which is one transcript line
(the table's +4 against +5) plus one `history.jsonl` entry, not "two lines" as this said
until review noticed it contradicted the table one paragraph above. **Both are caused BY
typing `/exit`, not preserved by it**: a `file-history-snapshot` with
`trackedFileBackups:{}` (an empty message boundary for the `/exit` input) and a
`history.jsonl` entry reading `{"display":"/exit"}` — your own keystroke. The `cost-state` roll-up and the whole `last*` block in `.claude.json`
(`lastSessionId`, `lastCost`, `lastModelUsage`) — the state the graceful path was expected
to own — have **the same keys written by the hard kill**. *Keys, not values*: two different
sessions cannot have equal `lastSessionId` or `lastCost`, so "written identically" — which
stood here at first — invites a comparison the measurement never made and could not make.

**So #191's `/exit` half is refuted for the session shape measured.** A ceremony that buys
nothing makes Kill feel broken, and a submit is not reliably one keystroke (one run needed
a second CR after 8s). The *rename* half is untouched by this and belongs at **naming**
time, not at kill time, so Kill stays instant. Read limit 4 below before treating the
refutation as reaching a fully-loaded session — it does not.

**Limits, stated rather than glossed — and the last one is the one that could reopen this.**

1. **It is a property of the ConPTY-close path, not of Windows.** node-pty's other branch
   `process.kill`s the whole **console process list**, which contains the agent, so such a
   deployment behaves like arm C and loses all four lines — not on this fleet, and
   unmeasured.
2. **Killing MID-TURN was never measured.** Every arm killed an idle session after a
   completed turn.
3. **The evidence is Claude-only; the decision is fleet-wide.** Kill stays instant for
   Codex sessions and plain shells too, and neither was measured. Same convention as
   `readiness` and `submit.bracketAbove`: Claude's behaviour is not evidence about Codex
   in either direction.
4. **THE MEASURED SESSION WAS MINIMAL, AND THAT IS THE GAP THAT MATTERS.** No MCP servers,
   no plugins, no statusLine, `autoCompactEnabled: false`. A real session on this fleet
   runs several MCP servers — and **MCP teardown is the most plausible concrete form of
   the report's "work Claude is doing" at exit**, which is the thing `/exit` was proposed
   to protect. *This probe could not have seen it.* So the refutation is sound for the
   session shape it measured and does **not** reach a fully-loaded one. Anyone reopening
   #191 should start here: add MCP servers to the isolated config and rerun the same three
   arms, rather than re-arguing the ConPTY mechanism, which is now settled.

**A fifth limit, added when the mechanism was corrected.** *Which* event makes the agent
exit is **not** measured. Two candidates arrive microseconds apart inside one native call —
its console closes, and its parent dies — so "orphaned by the closing pseudoconsole" is
inference from arm C plus the process tree (`TerminateProcess` spares descendants), not a
captured sequence. What IS earned is the weaker and sufficient claim: **the agent is left
alive and runs its ordinary shutdown.**

Two readings are closed rather than left open. The flush cannot pre-date the kill: the
BEFORE snapshot is taken *after* the dwell and *before* the end-action, so anything written
earlier is already in the baseline and the +4 is measured strictly across the teardown. And
it cannot be the terminate itself, on two independent grounds — the terminate targets bash,
and arm C shows that terminating the agent writes nothing.

> **The isolating experiment is CHEAP, and this limit first claimed the opposite.** It said
> a fourth arm "would need … the native call directly, which node-pty's API does not
> expose". Wrong, and review answered it in one line: `process.kill(shellPid)` alone, with
> no `term.kill()` — the same shape as arm C — kills the parent without closing the
> console and separates the two causes. So the arm is **unrun, not impossible**. Recorded
> because it is the same error as the one being corrected on the line above: *a claim about
> what cannot be done, made without checking.*

Nothing in this repo depends on telling the two apart — either way the agent flushes and
`/exit` adds nothing — which is why the arm is named here rather than run.

> **A liveness check on a pid you failed to find PASSES.** The probe locates the agent
> process by NAME under the shell it spawned, so an install running it under a shim (an
> npm wrapper is `node.exe`) leaves the pid null — and `alive(null)` is false, so every
> wait loop exits on its first test. Arm A's wait, which exists to prove the hard kill
> reaches the agent, would report *"agent died 0ms after it"* having checked nothing; arm
> B's await would return instantly and let `term.kill()` fire straight after, so **B
> silently degenerates into A** — the exact #191 trap the probe was written to avoid,
> reproduced by the probe. Both failures print a plausible table and no error. It now
> aborts instead. Same lesson as the Codex TOML probe below: **a setup failure must abort,
> never be folded into a verdict.** (The recorded runs above were not affected — a null
> pid yields ~0ms in both arms, and they measured ~870ms and ~1030ms.)
>
> **A probe that spawns `claude` from inside a Claude Code session must scrub `CLAUDE*`
> from the child env.** The first four runs wrote **no transcript at all**, in both arms,
> because the probe inherited `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ID`,
> `CLAUDECODE=1` and `CLAUDE_CODE_MESSAGING_SOCKET` (a named pipe into the PARENT) — **a
> nested child session persists nothing**, so the measurement reads as "unmeasurable" when
> it is really "not isolated". Sibling of the `CODEX_HOME` rule under Codex above.
>
> *The inventory is measured; the CAUSE is inferred.* All four names were confirmed present
> in a real session's environment, and scrubbing them fixed it — but the probe scrubs three
> whole prefixes unconditionally with no flag to disable, so it can say neither **which**
> variable mattered nor that "a nested child session persists nothing" is the mechanism.
> Scrub all of them anyway; just do not cite this as evidence for the mechanism.
>
> **A guard must hash the file the ACTOR CAN WRITE.** Copying `.credentials.json` into the
> isolated `CLAUDE_CONFIG_DIR` is the probe's one break in isolation, and the safety net
> described for it — *"re-checks the original file's hash afterwards and SHOUTS if it
> moved"* — hashed `~/.claude/.credentials.json`. **The child runs with
> `CLAUDE_CONFIG_DIR` pointed elsewhere and never opens that file**, so it is unchanged by
> construction and the check printed `unchanged: true` in precisely the scenario it existed
> to catch. The file that shows a rotation is the **copy** — which was being shredded a few
> lines earlier, destroying the evidence unread on every normal run. What actually makes a
> refresh impossible is the `--min-token-life` refusal; the hash check was a second line of
> defence that was never in the line of fire. It now hashes each copy at creation and
> compares just before the shred, and the original is checked separately for the different
> thing it does show (the HOST refreshing mid-run). **Generalises past credentials: name
> the writer before choosing what to watch** — the same error as asserting on the screen
> when the rollout is ground truth.

## A resume is REPORTED, never predicted — and a retry is not a rescue (#227)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

Two defects, one event, and the second is why the first ran unnoticed for a night.
Reported as *"I saw a few with auto resume label but they didn't resume."*

**The evidence is a controlled pair inside ONE worker process** — two sessions, the same
build, and the **same reset minute**, differing — in the only way that can reach the
timer — in whether a prompt was submitted after it armed:

| 2026-09-04, reset 08:51:00 | armed | retry after arming | at the reset |
|---|---|---|---|
| session A | 07:35:07 | **yes**, 07:46:13 | **no log line of any kind** |
| session B | 08:20:05 | **no** | **fired 08:51:00.020**, `idle -> working` 236 ms later |

Session B is the control: it proves the write reaches the composer and starts a real
turn, so nothing about readiness, the selector or the byte shape is implicated.

> **The first version of this section used a WEAKER pair and asserted something false
> about it** — 2026-08-31 against 2026-09-03, described as "same worker process, no
> restart across either window". There *was* a restart between them (07:39:17 on
> 09-03, the #213 deploy, which touched `pty-worker.js`), so those two windows ran
> different builds, and one of the "same three sessions" had exited and was not
> restored. The claim was contradicted by a fact already in hand: the worker PID's
> start time *was* that restart, read as "the worker is fresh" and then forgotten one
> paragraph later. Found in review. **The replacement is stronger, not a retreat** —
> same process, same build, same reset instant, one difference that can reach the timer — which is the lesson:
> when a controlled comparison turns out to be confounded, look for the better
> comparison in the same data before defending the first one.

**Fire-time refusals log a reason** — `no longer cap-blocked`, `is working`,
`still starting` — which is what makes total silence mean the timer was **destroyed**
rather than declined. Two returns in `fireAutoResume` are nevertheless SILENT
(`if (!s) return` and the `autoResumeOnResetEnabled() || fiveHResetAt !== resetAt`
re-check), so the inference needs them excluded rather than ignored: the session was
alive and hooking hours later, and session B fired **at the same instant** — both
timers were armed for 08:51:00.000 and B went out 20 ms into it, a window no config flip
fits inside. **Push-time cancels are silent too** (`armAutoResumeTimer`
returns early without logging, and `setFiveHResetAt` pushes are not logged at all), so
"the only variable was the retry" rests on the log **plus** the reported badge still
reading `resumes` — a `capBlocked:false` or `enabled:false` push would have changed it
to nothing or to `on hold`.

**Defect 1 — "the user is back" is not "the block is over."** `UserPromptSubmit`
cancelled the armed resume. A submitted prompt proves the user is PRESENT; it proves
nothing about the quota, and while capped that prompt cannot run. Nothing re-armed:
`armAutoResumeTimer` is re-entered only on a **changed** `setFiveHResetAt` (or on
restore, or on the PTY cap detector — neither of which was going to happen here), and
`_pushResetState` de-dupes on exactly the three fields that had not changed. **So the
feature was defeated by the most natural human response to the thing it exists to fix.**

The signal is not *is the user back* but **what they asked for**, which is why the fix
is one event wide and the rest of the block is untouched: **Esc says STOP** (and only
fires from `working`, so a turn really was running), **a tool event says WORK IS
RUNNING** (which genuinely proves the cap is not in force), **only a prompt says GO**.
The re-arm sits deliberately *after* `clearObservedCapBlock` and rides
`session.capBlocked` alone — the server's live, self-expiring metrics reading — so
#138's rule that a sighting must not outlive its window is untouched, and it never
resurrects an observation the user has just answered.

**Defect 2 — `armed` was a PREDICTION of the worker's decision, evaluated against a
subset of the worker's gates.** It could not see the one-shot, the worker's own
`capBlocked`/`limitPromptAt`, or a hook having cancelled the timer — so both clients
went on rendering `resumes 21:51` from the 19:27 cancel until that moment passed, with
nothing scheduled for any of it. (That interval is derived from the cancel and the
promised time; what is *measured* is that no timer existed.) The worker had
published the truth since #138 (`autoResumeArmed: !!s._autoResumeTimer`) and **no
production code read it** — `server.js` had zero hits. (The worker's own tests did read
it, six times; an earlier draft of this section said "one grep hit repo-wide", which was
a scoped grep over the production files reported as if it had covered the repo.) It is now the answer whenever the worker gives
one, with **ABSENT kept apart from FALSE** so a cluster peer merely behind falls back to
the derivation rather than going dark.

> **Sharing a MODULE is not sharing an ANSWER.** The comment above the call site read
> *"one server-side derivation, shared with the worker's arming gate, so the badge can
> never claim something the timer disagrees with"* — and it was false the whole time.
> Both sides imported `lib/usage-limit.js` and then evaluated it against **different
> state**. SSOT is satisfied by one *owner of the fact*, not by one *copy of the rule*:
> where a fact is a live decision some process already made, the honest wire field is
> that process's report, and re-deriving it beside the authority is how the two came
> apart silently. Same shape as #179 — *do not predict whether the PTY accepted a
> submit; write it and check that it landed.*

**A test pinned the broken behaviour** rather than catching it — the spec's helper
defaults `capBlocked = true`, so *"a new UserPromptSubmit cancels the pending continue"*
asserted the cancel winning for a session that was still capped, i.e. the field failure
exactly. Corrected, not deleted. (Its Esc sibling reads the same way at a glance and is
**not** the same case: Esc's cancel is still right, so exactly one test changed.) **And the correction must not be made by flipping
`capBlocked` to false**: nothing arms at all in that case, so the test would pass
vacuously — the same trap as #221's dead assertion, reached from the other side.

> **What the re-arm TRADES AWAY, found in review and named rather than discovered
> later.** `clampPct` **rounds**, so a window at a real 99.5% arrives as exactly 100 and
> `isCapBlocked` is true while the account is still answering. Before this change, any
> prompt after arming disarmed the timer for good — so a prompt that actually RAN could
> never be followed by an unwanted `continue`. Now a question-and-answer turn with no
> tool call re-arms on its `UserPromptSubmit`, `Stop` does not cancel, and if the status
> line still rounds to 100 at reset+60s, `continue` is typed into a session whose last
> prompt was already answered — the exact harm #138's header exists to prevent. The only
> remaining guard is the `status === 'working'` check at fire time.
>
> The log offers a discriminator for a follow-up, and it is worth writing down because
> it is not obvious: **a cap-REFUSED prompt ends in a Notification-only idle with no
> `Stop`; a prompt that RAN ends in `Stop`.** Three samples, unmeasured beyond that — so
> it is a lead, not a rule, and gating the re-arm on it needs its own measurement.

> **One gap the fix does not close, named rather than glossed.** A retry leaves the
> session `working`, and `fireAutoResume` consumes the one-shot *before* its
> `status === 'working'` check — so a session still marked working at the reset burns
> the window and skips. Pre-existing (#138 chose "consumed whether or not we act"), and
> narrow in practice: the measured session fell back to idle 62 s after the retry
> against a 2.5-hour wait, and `correctStaleStatus` rescues a stale `working` after five
> minutes. It is a real edge, not a hypothetical, and it belongs to the
> one-shot's ordering rather than to this fix.

**Noted, unfixed:** `usage-limit:` appears **zero** times in the whole worker log across
three real cap events, so #138's PTY detector that answers the cap selector with *stop
and wait* has never matched in production. Not blocking — the session-B control (and
the three 2026-08-31 fires) shows the session recovers at the reset without it — so it is a separate measurement question, not
a guess to fold in here.


## Live work is every waker, not just background shells (#443 milestone 1)

**Premise checked against real transcripts** (XPS, claude 2.1.319, 2026-11-09; numbers only, no content kept). `lib/background-tasks.js` knew one kind of live work, a `run_in_background` Bash. #437's stale-self rule and the #313 reason row read that list, so a `wait: self` kept alive by anything else read as stale.

Measured launch and end lines, per kind (159 main transcripts, last 30 days):
- **Async subagent:** the RESULT carries `toolUseResult { isAsync: true, agentId }` and the text "Async agent launched successfully ... agentId: <id>". 289 of 452 async launches had **no** `run_in_background` in their input (the harness backgrounds them), so the input is not the signal. Its end is a `<task-notification>` under the agentId, and every one measured carried `<status>` (completed). `SendMessage` to a finished agent returns `toolUseResult.resumedAgentId` (sometimes also `revivedAgentId`) and the agent runs again, so "ended" is ordered: the latest of resume and finish wins.
- **Monitor:** `toolUseResult { taskId, timeoutMs, persistent }`. Its notifications are EVENTS with tags `task-id, summary, event` and **no** `<status>` (181 measured); the "any notification ends it" rule for commands would drop a monitor at its first event. Ends seen: `TaskStop {task_id}`, and the notice `[Monitor expired after 30m ...]`; a source-ended notice was not observed, so a `<status>` tag and the `timeoutMs` clock are the other ends.
- **ScheduleWakeup:** `toolUseResult { scheduledFor (ms), clampedDelaySeconds, wasClamped }`; one pending wake per session. `stop: true` cancelling it is taken from the tool's schema - **no stop call was observed** in the corpus (inputs seen: delaySeconds, prompt, reason, noop; `noop: true` calls still return scheduledFor and are counted live). Duplicate lines without a timestamp occur (replays), so order needs a timestamp.
- **CronCreate:** `toolUseResult { id, humanSchedule, recurring, durable, nextFireAt }`; text says "Session-only ... Auto-expires after 7 days". Each fire is a `system` line, `subtype: scheduled_task_fire`, carrying `taskId` and `cron` (and on /loop jobs `cronKind: 'loop'`). `CronDelete {id}` ends it.
- **Child session:** not in the transcript at all; #374 `spawn.parentId` on the session list.

**A fixed tail is not enough.** For every waker, the byte distance from its launch to the line before it fired (that is, the state of the transcript at the moment the session went quiet): launch more than 256 KB back for 126/553 subagent finishes (23%), 120/269 monitor events (45%), 30/37 cron fires (81%); 1 MB still missed 4-11%. Distance p50 92 KB, p90 826 KB, p99 2.8 MB. Hence the incremental read in `readBackgroundTasks` (2 MB first read, then appended bytes only, with a guard that restarts the scan if the file was rewritten).

**Trade-off chosen: err toward "live".** A self-wait called stale is prompted (#443 milestone 2) and taken by the auto hand-off, so a false "nothing live" costs a full-context turn; a false "live" only delays a check-in. Known gaps: (1) everything except children lives inside the Claude process, and a restart kills it without writing an end - it reads live until its own bound (`until` for monitor, wake-up and cron, and the 6 h age backstop for commands and agents). A recurring cron is bounded by its last sign of life + 6 h (each fire writes a line), not by its 7-day expiry alone: the final review found 5 of 5 recurring jobs in the local corpus still "live" by the 7-day rule 3 weeks after their transcripts went silent. The spawn reaper and the #359 restart hold read the list UNAGED, so for them a dead agent or persistent monitor holds the session until the server restarts (as a stranded command already did; the hold only asks); (2) a child opened on another cluster machine is not seen; (3) a persistent monitor has no clock and ages out at 6 h. Also: live work now outlasts a turn by hours (children, crons), so on an idle row an ask (`wait: you`) from the latest ENDED turn beats it in lib/session-reason.js, as it already did on a `working` row; otherwise a parent asking the person while its children ran showed "self" and the ask vanished from the board.

## The check-in on a stale self-wait (#443 milestone 2)

**Rule** (`lib/check-in.js`, server-only): a Claude session whose reported `wait: self` has nothing alive behind it (`isStaleSelf`, the ONE predicate, now meaning "nothing can wake it" since milestone 1) is typed ONE tagged prompt (`[web-terminal check-in]`, a SYSTEM turn named Check-in in `lib/user-turn.js`, at most 511 bytes so Claude never brackets it, #213) `afterMin` after it went stale. The answer is STATE: the wait reported inside the check-in's own turn, read at that turn's Stop (`noteHook`). Published as `checkIn.state`: sent, lost (no turn within 3 min), answering, interrupted (delivered, idle again for 30 s with no Stop: an Esc, which fires no hook), done, you, external, resumed (self + a live waker now), stuck (self again with nothing alive, or no report).

**Baseline, before** (the issue's transcript scan, 2026-11-09, 1,881 main transcripts on Home/Office/XPS, Sept-Nov; turns whose last report was `wait: self` followed by >= 60 min idle): 121 (58%) woke by a task notification (idle p50 73-93 min, p90 158-346 min, max 943 min); 59 (28%) by the owner typing, at least 23 of them explicit nudges after a median 155-361 min; 21 (10%) never woke; 7 by a slash command. Separately 219 turns reported `done` and sat >= 60 min. **After** is measured from `handoffs/check-in-log.jsonl` (one `sent` and one `answered` line per check-in, with the answer): count `answer` by value per machine after a week of use.

**Threshold chosen: `afterMin` 60, so the first check-in comes at 90 min idle** (with `staleSelfMin` 30). The legitimate multi-hour waits (the 58%) were subagents, monitors, wake-ups, crons and children, which milestone 1 now counts as live, so they never reach the predicate; a stale-self has nothing that can wake it and every minute idle is lost. Against asking at once: each check-in re-reads the whole context (~350k tokens on a big session), liveness still has a blind spot that errs toward "stale" (a child on another cluster machine), and the auto hand-off takes a BIG stale session at `staleSelfMin` first, so the check-in comes after it, not in its way. 90 min still beats the owner's median nudge (2.6-6 h). Configurable: `checkIn.afterMin`.

**Timer in the server, not the worker** (beside the hand-off scan, never running alongside it; one check-in per scan, `everyMs` 60 s). It types through `typePrompt` like the hand-off and the restart hold, so it needs no worker change and no cold restart. "Defer, never skip": every gate is re-read by the next scan and nothing is recorded until the prompt is typed; the session is re-read (`getSession`) immediately before typing, and a turn that started during the awaits cancels it.

**Gates** (each mutated alone in `tests/check-in.spec.js`, the descendant walk in `tests/check-in-routes.spec.js`; 48 mutations, all killed): fleet off (`checkIn.enabled: false`), session off (`checkInOff`), agent undeclared (registry `checkIn`, Claude only), restart hold, hand-off in flight, a hand-off that ended kept with no turn since (a successor holds the work), or failed (its wrap-up either started a turn - the session was told to stop - or may sit unsubmitted in the composer after a lost CR, where the check-in's CR would submit both as one prompt); only a failed run whose write the worker link refused (`typed: false`) blocks nothing, and a run or brief missing its time blocks, not idle, a pending question or permission, compacting, not ready or behind a startup selector, in a menu, cap-blocked / auto-resume armed / a cap in force, an API error (the worker's auto-continue owns it), already asked this idle period, someone typed in the last `typingQuietMin` (10) minutes - counted from the server's start at least, since keystrokes are remembered in memory only and a draft typed just before a hot reload would otherwise be submitted with the check-in - live work that CANNOT BE READ, for the session or any child session (no transcript path, a failed read, no process snapshot yet: the badge readers turn those into "nothing running", which before a write would fail open), not a stale self-wait (you/external/done, live work), not stale long enough. While a check-in is typed but not yet delivered (`inFlight`, up to 3 min) the hand-off scan and the restart hold do not type into that session; a send the worker link refused is undone, not consumed. The scan pre-filters on the raw brief (`worthReading`: a self-wait, not asked, past the threshold) before reading a full row. The session's own `wait.what` is quoted into the prompt with every C0/DEL/C1 character made a space (it reaches the PTY as keystrokes).

**Once per idle period**: the period ends only when a turn starts AFTER the check-in's own turn (a person, a task notification, a wake-up). The check-in's turn does not end it, so a session that answers "self" again with nothing alive is shown `stuck` and is never asked twice.

**Not covered, on purpose**: "idle after a turn that reported no wait at all". No data separates a finished session that did not report from one that stopped mid-plan, and a check-in there would cost a full-context turn on every session that simply ended without a report; the 219 `done`-and-idle turns show finished sessions are common. ETA-aware waits ("result due 11:15") are not parsed: a wake-up's own `until` already covers the measurable case. Known limits: a `lost` check-in (its CR never submitted) may leave its text in the composer, where the owner's next prompt would be appended to it - the same exposure every server-typed prompt (hand-off, restart hold) has through `typePrompt`; the per-session switch is API-only (`PATCH /api/sessions/:id/brief {checkInOff}`), with no companion control yet.

**Rig proof, real claude 2.1.319, XPS, 2026-11-09** (`scripts/rig/verify-check-in.js`, clocks shortened: stale 30 s, asked 30 s later, typing gate 12 s). A (reported self, nothing running): ONE check-in at 61 s idle; claude answered "Nothing was running, so I marked the dashboard as done" and reported `wait: done` 11 s after the send; the row read `checkIn.state: done`; the transcript holds the check-in as `userKind: system`, and `/recap`'s prompt is still the owner's. 60 s more of 5-s scans: still one `sent` line. B (reported self beside a live `sleep 900` background shell): reason `self` from `background`, no check-in, `checkIn: null`. The first run sent nothing for 5 min: the probe types its prompt over the WS socket, which is a person typing to the 10-min gate - the gate working, not a defect.

## A live waker is not proof it will fire: two readings that ask anyway (#456)

**What happened, night of 2026-11-09/10** (server 1.102.3, Claude Code 2.1.319, all three machines): the check-in log stayed empty everywhere, yet one lead session was stuck twice and the owner nudged it by hand both times, 3.4 h ("Where are we with this?") and 7.5 h ("News?"). Same shape both times: the lead reported `wait: self` on its child sessions; every child had finished and reported `external` naming the lead ("lead starts the next step", "lead picks up the handoff"); the lead's waker was a background command (`node monitor.js | grep -v ... | grep -m1 ...`) whose filter swallowed every event. A deadlock: each side waited on the other. The children were already not live (`addChildWork`), but the blind watcher was live work, and `isStaleSelf` is false while ANY live entry exists. Every other idle session that night was waiting on the owner or someone else, was done, or was woken by its own task-notifications (a transcript scan of every main-agent gap >= 60 min that began after 16:00Z, joined to the servers' own session lists).

**Change (owner's call, 2026-11-10): two more readings, check-in only** (`checkInReading`; the auto hand-off keeps `isStaleSelf` alone, since a wrong hand-off costs far more than a question):
- `children-parked`: a reported self-wait, at least one direct child session, and none of them live by the SAME rule addChildWork applies (`childVerdicts`, factored out of it so the board and the check-in cannot disagree), with every child's turn end known (unknown fails closed). Asked once the last child stopped and the lead itself have both been idle `staleSelfMin + afterMin` (90 min). The lead's own watchers are ignored: nothing is left to report to it. That night: about 02:46Z instead of the 05:30Z nudge, and about 19:52Z instead of the 21:46Z one. Known costs, accepted: children left over from an EARLIER phase also count, so a lead that has moved on to waiting for CI through its own Monitor is asked at 90 min (one turn; a rule on the report's time would miss the incident's own shape, where the lead reported after its children ended); and only this server's children are seen (the addChildWork gap), so a lead whose other children run on a peer is asked too - the prompt says "on this machine".
- `long-self` (backstop): a reported self-wait idle `withLiveWorkMin` (default 180 min, owner's choice) is asked whatever is listed as running. It covers a blind watcher with no children. Cost: legitimate waits reach p90 2.6-5.8 h (the #443 baseline), so some are asked; that is one turn, and the right answer is "self" again (shown `resumed` while the waker is live).

Each reading has its own prompt words (never "nothing is running" when something is listed), stays under 512 bytes, and is recorded on the check-in (`why`) and in `check-in-log.jsonl`, so "how many were really stuck" can be split by reading. Pinned by `tests/check-in.spec.js` (10 mutations of the new gates, all killed) and `tests/check-in-routes.spec.js` (a real worker: a lead with a live Monitor and a working child is not asked; the child stops on `external` and the lead is; a live Monitor is asked past the backstop; both fail with the readings removed).

## Ask at an idle hour: every self-wait, and external waits too (#458)

**Change (owner's call, 2026-11-10, server 1.104.0):** "every session that has no activity for about one hour is a legitimate candidate" - a session that finished answers so, one that did not wakes up. Narrowed by what the session last reported, because asking only helps where the session itself might be stuck:
- `self`: asked at 60 min idle in every reading. `afterMin` 60 -> 30 (stale-self and children-parked at `staleSelfMin + afterMin` = 60) and `withLiveWorkMin` 180 -> 60. With the backstop at the same hour, every reported self-wait is asked at an idle hour; the readings now only choose the words (and children-parked still needs its children stopped an hour).
- `external` (new reading, `externalMin` default 60): what it waited for (CI, a PR, another session) may have come without waking it. Its live work and children do not matter. Its own words: if it arrived, pick the work back up; if still pending, report `external`.
- **Never** `you` (only the owner can unblock it, and the check-in's reply would push the question it asked out of view - the inbox and read-aloud would show "still waiting"), `done` (nothing pending), no report, or a pending question/permission (the `waiting` gate).

**Cost accepted:** after an idle hour the prompt cache is cold, so each check-in is a full-context turn, once per idle period. Legitimate long waits (a 30-45 min pipeline, a long run under a Monitor, a review by someone else) now get one question and answer `self`/`external`. A child session waiting on its own lead (`external`) is asked too and will answer `external` - one turn per idle period; the lead is the one that matters and is asked by its own reading. Measure from `check-in-log.jsonl` (`why`, `answer`) before moving a clock again. A check-in's reply is output, so an agent-started session's #351 idle close comes about an hour later.

**From the gate review:** an external wait is NOT aged to the latest turn (a task notification ends only a self-wait, so it can stand across turns that woke the session) - deliberately, it is still the session's claim and asking is the point; so its words never say "nothing has woken you". An external check-in that gets no report reads `external` (the standing wait), not `stuck` ("still nothing running" is a self-wait's words); the published record carries `why` for that. With the backstop at the same hour, raising `afterMin` alone delays nothing - raise `withLiveWorkMin` with it.

Pinned by `tests/check-in.spec.js` (6 mutations: no external reading, pre-filter self-only, external ignoring its clock, external also taking `you`, the old defaults, the external words dropped - all killed) and `tests/check-in-routes.spec.js` (a real worker: an external wait is asked in its own words and logged `why: external`; sessions waiting on you and done in the same server are never asked).

## A turn an API error cut is retried, and asked if nothing retried it (#461)

**Measured (2026-11-12/13, claude 2.1.32x):** a child session's turn ended with `API Error: Connection lost mid-response. The response above may be incomplete.` The worker logged it `non-transient`, so the auto-continue ladder never ran; Claude fired no `Stop` (the worker went idle on the `Notification` a minute later), so the session reported no wait; and `checkInBlock` refused every session with `apiError` ("its own owner"). It slept 26 h until a person typed `continue`, which resumed it at once. Its lead was waiting on the owner (`you`), which is never asked by design (#458), so nothing in the family could wake it.

**Scale:** three weeks of worker logs on the two machines behind the same ISP path (see the NAT-timeout finding: idle TCP reaped at ~60 s) hold 37 `non-transient` lines, every one a transport failure: `Connection lost mid-response` (13), `Can't reach the API server` (14, one rendered with no spaces), `Connection closed mid-response` (4), `Server error mid-response` (2), `Unable to connect to API` (2), `Response stalled mid-stream` (1), `API returned an empty or malformed response` (1). The machine on a clean network logged none.

**Fix, two layers:**
- `lib/api-error.js` owns `isTransientApiError` (moved out of `pty-worker.js`) and now calls those transport phrasings transient, so the worker's ladder sends `continue` within seconds. Still non-transient: a 4xx other than 408/409/425/429 (a 403 block page, 401, 400) and an unreadable image - retrying fails the same way. Needs a cold restart (the worker requires it).
- The check-in reading `api-error` (`apiErrorMin`, default 60): an idle session whose turn the error CUT (a turn began, no Stop since, the error seen during that turn) and whose error has stood an hour is asked once per idle period, in its own words (the error line; "nothing retried it"). The worker publishes `apiErrorAt` (its own `lastApiErrorAt`, null once cleared); a row without it fails closed to the old block. A turn that ended normally after printing the phrase (a session echoing "API Error" - this one did, while being investigated) is never asked, nor is an error older than the current turn. Its idle clock is the error, since the turn has no end.

**Not done:** Claude Code now has a `StopFailure` hook (the turn ended on an API error, with `error` and `error_details`) that web-terminal does not install. It would give the brief a real turn end and flip the worker idle at once instead of on the `Notification` a minute later.

Pinned by `tests/api-error-detect.spec.js` (the real lines both ways; a real worker: a cut connection is transient, auto-continues and publishes `apiErrorAt`, cleared with the error) and `tests/check-in.spec.js` (6 mutations killed: each new transient phrase family dropped, the block kept unconditional, the cut check, the turn-order check, the pre-filter).
