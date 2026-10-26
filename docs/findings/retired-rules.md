# Retired rules

Rules that `CLAUDE.md` carried until 2026-10-26 and that the CODE has since overtaken —
a feature that was "deliberately not built" got built, or a gate was removed by a later
issue. Each was checked against the code, not the prose, before it was retired. The text
is kept here **verbatim** so the history is not lost; **none of it binds**. The current
rule is the line in `CLAUDE.md`.

## Test Config — "tests back up/restore config.json but overwrite the password hash — re-apply the correct password after running tests"

**Why retired:** Overtaken by code. Under `WT_TEST` all three processes resolve their config to `config.test.json` (`server.js` `CONFIG_FILE`, `pty-worker.js`), and `playwright.config.js` redirects the token, cluster-token and metrics stores too, so the suite never writes the production `config.json`. Nothing in the repo writes `config.json.bak` any more; `tests/global-teardown.js` only restores one if it happens to exist. Following this line now would have an agent "re-apply" a password hash to a production file the run never touched.

**Was in** `CLAUDE.md` § Test Config (evidence in `operations.md`). **Verbatim:**

- Tests backup/restore config.json but overwrite the password hash — re-apply the correct password after running tests

## #190 — "the folder-trust dialog is deliberately NOT detected / surfaced / auto-answered"

**Why retired:** Overtaken by code. #190 is closed and `lib/blocking-prompt.js` now DETECTS the startup selector family by shape (only while the #147 latch is unset, `detectBlockingPromptInOutput` in `pty-worker.js`), REPORTS it unconditionally (`blockedPrompt`, broadcast; a submit is refused and explained), and AUTO-ANSWERS only when `autoAnswerBlockingPrompt` is set (`AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT = false`; env `WT_AUTO_ANSWER_BLOCKING_PROMPT`). Landed in c812d53 (#256). Of the four "not built" items only "auto-answering by default" still holds, and the digest says so. The design this paragraph argued for — refuse-and-explain rather than delay — is what shipped.

**Was in** `CLAUDE.md` § Claude's folder-trust dialog is a THIRD layout, and a submit there KILLS the agent (#190) (evidence in `input-submit.md`). **Verbatim:**

**Deliberately NOT fixed:** detecting the dialog, withholding the 45s fallback, surfacing
it in the chat lens, auto-answering. #190 and #194 Part 1 both want the surfacing built
once, and the right design is **refuse-and-explain rather than delay** — a false refusal
costs a message, a false permit costs the agent.

## #146 — "the only honest route is `claude agents --json`, a separate feature"

**Why retired:** Overtaken by code: that feature exists. #366 added `lib/background-listing.js` (+ `lib/background-listing-runner.js`, the `backgroundListing` registry field), which runs the CLI listing and reduces each row to the fields a dashboard needs. The structural half ("Agent View writes nothing to the transcript") is still true and is restated in that module's header.

**Was in** `CLAUDE.md` § Agent View (`←`) is NOT alt-screen, and it REDIRECTS your next prompt (#146) (evidence in `input-submit.md`). **Verbatim:**

**Chat lens: nothing to render**, and that is a structural answer, not a deferral — Agent
View is TUI paint and writes nothing to the transcript (the same finding as #131). The only
honest route is `claude agents --json`, a separate feature.

## Session recap — "`classifyUserTurn` exists twice; consolidating the Dart side onto a server-published field is a separate change"

**Why retired:** Overtaken by code: the consolidation happened. Transcript turns now carry `userKind` on the wire (`TranscriptTurn.userKind`, `ai-terminal/lib/api/models.dart`), and `conversation_view.dart` prefers it (`userTurnKindFromWire(turn.userKind) ?? uclass.kind`), keeping its own `classifyUserTurn` only as the fallback for an older server or a Codex turn. The digest states the current shape.

**Was in** `CLAUDE.md` § The session recap — "my last prompt" is NOT `role === 'user'` (evidence in `chat-lens.md`). **Verbatim:**

> **`classifyUserTurn` currently exists twice** — here and in the companion's
> `conversation_view.dart`, which uses it for bubble labelling. The server copy is the
> authority and recognises strictly more. Consolidating the Dart side onto a
> server-published field is a separate additive change, **not** a "keep them in sync"
> instruction.

## #249 — "two gates: `commandMode === 'prompt'` AND `origin.kind === 'human'`; a queued teammate message stays invisible (#250)"

**Why retired:** Half overtaken by code. #250 is closed and the ORIGIN gate is gone: `lib/user-turn.js` now recognises the `<agent-message from=…>` / `<cross-session-message …>` wrappers (`TEAMMATE`), so the classifier decides the bubble and a teammate's queued message is shown. `lib/transcript.js` records it ("THE SECOND GATE IS GONE, AND ITS JOB MOVED RATHER THAN VANISHED (#250)… `origin.kind` is therefore READ BY NOBODY here"). The `commandMode === 'prompt'` gate still binds and is in the digest.

**Was in** `CLAUDE.md` § A prompt sent WHILE THE AGENT WORKS is not a `role:user` turn (#249) (evidence in `chat-lens.md`). **Verbatim:**

**TWO GATES, and both are narrowings rather than sniffs.** `commandMode === 'prompt'`
excludes `task-notification` (520 of 641 records — plumbing, and 34 of them restate a
notification that already arrives as a real `role:user` turn). `origin.kind === 'human'`
excludes `peer`: another agent's queued message is wrapped in `<agent-message from="…">`, **a
signature `classifyUserTurn` does not recognise** — it classifies as `human`, so admitting
one would put another agent's words in a **"You"** bubble, the teammate-bubble bug this repo
has already paid for once. A queued teammate message therefore stays invisible in chat; that
is #250, and its fix is a signature in `lib/user-turn.js`, not a wider gate here.
