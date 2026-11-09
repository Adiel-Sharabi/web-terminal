# AskUserQuestion — layout, keys, notes and free text

> **Findings archive.** Moved verbatim out of `CLAUDE.md` on 2026-09-15, when that
> file passed the 150k-char context limit. Nothing was rewritten or summarised.
>
> `CLAUDE.md` carries the **rules**; this file carries the **evidence** — measurements,
> probe recipes, refuted hypotheses and review post-mortems. Read it before reopening
> any issue it covers, and add new measurements here rather than to `CLAUDE.md`.

---

## AskUserQuestion — the LAYOUT decides what the keys mean (#19)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

Answering Claude's question overlay drives its real TUI selector by writing keys into the
PTY, and **the same digit does three different things depending on the layout Claude
picked**. The layout is not cosmetic and it is not guessable, so it travels on the wire:
`_shapeQuestions` publishes **`hasPreview`** per question and `buildAnswerFrames` is the one
place that turns it into keys. Evidence, probe transcripts and the full key tables:
`docs/findings/questions.md`.

**The rule.** When any option of a question carries a `preview`, that question renders
**side-by-side** (options left, preview box right); otherwise **compact**. Layout is per
**QUESTION**, not per prompt.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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
- **Multi-select — DID HOLD on 2.1.237/2.1.234, LIFTED on 2.1.319 (#423,
  2026-11-07).** See "Multi-select free text and Chat about this" below: the
  *digit* still only toggles the checkbox, but the *cursor* reaches a real inline
  field.

One consequence worth stating because it reads as a bug otherwise: **a card
offers the note affordance or the `Other…` row, never both.** Notes are
previewed-only, Other is compact-only, so "Other wins when both are set" is no
longer a branch-order fact — the layout decides which one is eligible at all.

### Multi-select free text and `Chat about this` (#423, claude 2.1.319, 2026-11-07)

Re-measured on the isolated rig, every verdict read from the transcript's
`tool_result`. The 2.1.237 "HOLDS" bullet above no longer describes the TUI; a
number here holds only for the agent version recorded.

**Rows the terminal draws.** Multi-select (single question, or any tab):
`1..n [ ] option`, `n+1 [ ] Type something`, an unnumbered nav row (**Next** on a
non-last tab, **Submit** on the last or only tab), a separator, `n+2 Chat about
this`. Compact single-select (one or many questions): `1..n`, `n+1 Type
something.`, separator, `n+2 Chat about this`. Side-by-side: `1..n`, separator,
an **unnumbered** `Chat about this`; no `Type something` row and no digit.

**Multi-select free text WORKS, by cursor, not by digit.** The digit `n+1` only
toggles the checkbox and leaves the cursor on row 1, so typed text is swallowed,
and ticking it that way records `The user did not answer the questions.` (as on
2.1.237). `Down` x n moves the cursor onto the row and it becomes an inline field
(the footer gains `ctrl+g to edit in Notepad`). **Typing ticks it by itself.
`Enter` on the row UN-ticks it. `Right-arrow` inside the field moves the caret.**
`Down` (or `Tab`) leaves the field onto the unnumbered Next/Submit row; `CR` there
goes to the next tab, or to Review on the last tab, where `1` or `CR` submits.
Verified: `1,3 | Down x4 | ESC[200~hello thereESC[201~ | Down | CR | 1` recorded
`"Pick fruits"="Apple, Cherry, hello there"` at gaps of 250 and 700 ms. Two
multi-select tabs with text on both recorded `"Apple, note A"`, `"note B"`. Text
on the last tab of `plain-mq` recorded `"hello there"`. A newline in the paste is
recorded as a space. Bunching the text sequence is safe; bunching the tick digits
loses them (also true of the existing non-text path, unchanged).
`buildAnswerFrames` therefore emits ticks, `Down` x n, bracketed text, `Down`,
`CR`, and `1` only for a single question (a several-question prompt's loop tail
already adds the Review `CR`). **Never the digit `n+1`, never a `CR` or
`Right-arrow` after the text.** The card offers `Other…` on every `!hasPreview`
question and, in multi-select, combines it with the ticks.

**`Chat about this` REJECTS the call** (`tool_result` is an error). Compact
layouts number it `n+2` and the digit chooses it at once (plain-single n=3 -> 5;
plain-multi n=4 -> 6; plain-mq Q1 -> 5, Q2 multi -> 6). Side-by-side numbers
nothing: `Down` x n then `CR` (preview-single and preview-mq Q1, n=3). Picks
already made ride along (`"Pick a color"` Answer: Green). The digit is relative
to the tab the TUI is ON, so `buildChatFrames` replays the earlier tabs' picks
first (and the current multi-select tab's ticks). Hooks: `UserPromptSubmit`,
`PreToolUse`, then `Stop` about 1.9 s later on the rig; **no** `PostToolUse` and no
`PostToolUseFailure`. Claude then asks what to clarify and goes idle. Two
consequences in the app, both because nothing ever lands: the card is hidden by
the host on send (the user then types in the chat bar), and **a Chat send is
fire-and-forget** - never verified, never resent, never resurfaced.
`answerIsVerifiable` (frames carrying the Chat flag are not) is the ONE predicate,
read by the session screen and by the sessions board/inbox (`NeedsYouActions.answer`,
which says "Sent Chat about this", settles it as `AnswerSettled.chatSent` so the
inbox focus card moves on instead of staying live, and words the card's answering
line for a Chat via `answeringNote`).

**The server clears a rejected question from the TRANSCRIPT (measured 2026-11-08,
claude 2.1.319, isolated rig, 6 runs).** `PreToolUse(AskUserQuestion)` carries
`tool_use_id` (and `transcript_path`), equal to the transcript tool_use id 6/6. The
rejected `tool_result` (`is_error: true`, `toolDenialKind: "user-rejected"`) is in the
transcript JSONL within ~10 ms of the key; `Stop` comes 27-38 s later on a real reply,
and in a text-only reply `Stop` is the FIRST hook after the key (it carries no
tool_use_id). An ordinary answer's `PostToolUse` carries tool_use_id. So before the
fix `pendingQuestion` stood for the whole reply: the inbox focus card, the board and
any freshly opened session screen offered the question, and a press typed keys into a
working Claude (the session screen's own client-side hold covered only the screen that
sent it, and is gone now).

The fix (`server.js` `checkPendingQuestion`, the one owner): the PreToolUse's real id
(validated `^[A-Za-z0-9_-]{1,128}$`) and the session's stashed transcript path (already
through `safeTranscriptPath`) are kept beside the question; when a `tool_result` for
THAT id is in the transcript tail (`resolvedIdsTail`) the question is cleared through
`processHookEvent` as the `PostToolUse` Claude did not send - the same clear and the
same worker signal an ordinary answer produces (`questionPending: false`, status
`working`, since Claude is replying). Matched by id only, never by text: an identical
re-ask is not cleared by the old result. Checked on a 1 s timer while a question is
pending (one `stat` while the file has not moved; stopped on any clear, on session
exit, and by itself when the question it watches is replaced) and at every read:
`/pending-question`, the digest, and the rows' `waitingFor` (a row whose worker status
was read before that same call cleared it reports `waitingFor: null`, not
`permission`). No real id or no transcript path: exactly the old behaviour.
`pty-worker.js` is unchanged (hot reload). Pinned by
`tests/issue423-rejected-question-clears.spec.js`, every gate mutation-checked.

**`Esc` on the question ends the turn, and now reads idle (#441, measured 2026-11-09,
claude 2.1.319, isolated rig).** `probe-askq-layout.js --hooks` registers http hooks for
the run alone and stamps each event against the keys. 3 Esc runs (`plain-single`,
`preview-single`, `plain-multi`): after the Esc **no hook at all**, not even the idle
Notification (watched 57-75 s). The result line is `is_error` with
`toolDenialKind: "user-rejected"` (the same as Chat) and **`toolUseResult: "User rejected
tool use"`**; its text says "STOP what you are doing and wait for the user"; ~8 ms later
a user line `[Request interrupted by user for tool use]`, then `system/turn_duration`.
5 Chat runs (`plain-single` digit 5; `preview-single` reached by a digit + `Down` or by
`Down` x n, then `CR`): `toolUseResult` is a string starting `Error: The user doesn't want
to proceed`, the text says "the user said: The user wants to clarify these questions",
Claude replies, `Stop` 2.2-2.6 s after the key, and (in the one run watched that long) the
idle Notification 60 s after the Stop. So between #423 and #441 an Esc read
`working` until the 5-minute stale rule. Now `checkPendingQuestion` reads the result
line's own `toolUseResult` (`transcript.toolResultOutcome`; the field, not the interrupt
line 8 ms later, so there is no window between two writes) and clears a plain rejection as
the `PostToolUse` AND the `Stop` Claude did not send: the PostToolUse leaves `waiting` at
once (a `Stop` alone holds `waiting` through the worker's 750 ms idle debounce, and with no
question a `waiting` row is published as a permission prompt), the `Stop` idles it through
the same funnel as a real one. Consequences of that funnel, accepted: the worker's
`lastTurnEndAt` is stamped (the turn did end), and an `all`-level session gets the "Claude
stopped" push (the default level `important` does not). The brief is not folded (as for a
worker-detected Esc interrupt). Server-only; `pty-worker.js` unchanged. The worker does
load `lib/transcript.js`, but this change only adds an export the worker never calls, so a
hot reload is enough.

**The row poll that clears it now reads the new status (#441).** `/api/sessions` and the
cluster merge's local branch settle every watched question (`settlePendingQuestions`)
before asking the worker for statuses, as `/digest` already did for one session; before,
the poll that cleared it returned `status: waiting, waitingFor: null`. **A failed tail read
is no longer cached (#441):** the size and mtime are remembered only after the read
succeeds (`transcriptTailText` throws instead of returning nothing), so a read that hit
`EBUSY` is retried on the next tick rather than at the next write. Pinned by
`tests/issue441-question-followups.spec.js`.

**The cursor moves are already start-independent (#441, measured 2026-11-09, claude
2.1.319) - no code change.** The concern was that a user who moved the cursor in the
terminal first would make the relative moves overshoot. Measured, per-key screens and
transcript verdicts:
- **Side-by-side Chat (`Down` x n, `CR`):** `Chat about this` is the LAST row and `Down`
  CLAMPS there (a `Down` on it stays). From row 2: `Down`, then the app's `Down` x3, `CR`
  recorded the Chat rejection (`preview-single`; the same on `preview-mq` Q1). The digit
  form also works (`Down`, `3`, `Down`, `CR` and from Chat itself `Down` x3, `3`, `Down`,
  `CR`: both Chat - a side-by-side digit only moves), but it is not needed.
- **Multi-select `Other`:** the text goes out as a bracketed PASTE (#383), and a paste
  lands in the `Type something` field from ANY row: with the cursor on row 3, on Submit and
  on Chat, `paste, Down, CR, 1` recorded `"Pick fruits"="hello there"` each time, and the
  app's own frames after a move to row 3 (`Down` x2, `1`, `3`, `Down` x4, paste, `Down`,
  `CR`, `1`) recorded `"Apple, Cherry, hello there"`. TYPED text is different and is what
  the concern assumed: plain `hello` on row 3, Submit or Chat is swallowed (verdicts: none,
  and Chat twice, since the following `CR` landed on Chat). So the paste, not the `Down`
  count, is what makes it land - keep it a paste.
- Measured on the way, for whoever needs an absolute move later: in multi-select `Down`
  clamps on Chat; `Up` from Chat goes Submit, then `Type something`; `Up` from row 1 WRAPS
  to `Type something`; a digit ticks without moving the cursor. `Down` x (n+2), `Up` x2
  lands on the field from any row (verified on `plain-multi` from rows 1 and 3, `plain-mq`
  Q2 and both tabs of the new `plain-mq-multi2` shape, all recorded intact) - unused,
  because the paste already does it.

**Notes lost on Chat (#441 item 3) - FALSE PREMISE, no change.** Notes exist only on a
ONE-question prompt: the card offers the affordance only when
`questions.length == 1` (`question_answer_panel.dart`), and `buildAnswerFrames` consumes a
note only when `!multiQuestion`. `buildChatFrames` replays earlier tabs only when the Chat
is on tab 1 or later, i.e. on a prompt of two or more questions, where no note can exist.
Carrying `noteText` into the replay would change no byte. (A note on the CURRENT tab of a
single side-by-side question is dropped with its pick: #423's choice not to replay a
current single-select pick; carrying both would be a new, unmeasured sequence.)

**Also measured, not changed:** `pty-worker.js`'s `noteInterrupt` comment says Esc at a
permission prompt "REJECTS the tool and Claude carries on". For AskUserQuestion it does
not carry on (above); a Bash permission prompt was not measured. The `waiting` gate there
stays right for another reason: the note sequence's own `ESC` must not read as an
interrupt.

**A deliberate, UNMEASURED loosening:** the re-sent Enter now goes out for a
multi-select `Other` on the LAST tab of a several-question prompt (text, `Down`,
`CR`, Review `CR`); the old gate (`frames.length > i + 3`, counted from the text
frame) refused it because of the extra `Down`, the new one counts from the `CR` that
commits the Other. Risk: a lost `Down` lets the resent `CR` land in the field and
UN-tick `Other`. Not seen, not measured.

**Design choices that are the app's, not the TUI's.** Chat is refused (greyed,
tooltip says why) while an earlier tab is unanswered: replaying it would pick that
tab's top row and send Claude an answer nobody gave, and the way past an
unanswered single-select tab was not measured. It lives in the card header, not
as a row in the option list: a list row is charged to the options' natural
height, which on a phone comes out of the lead-up, and measurably collapsed it
and overflowed the card by 2 px in the #94 height tests.

**Not measured:** `Esc` inside the field; returning to a tab already left; a
resent card onto a TUI that has already advanced (#383); `Right-arrow` as a way
past an unanswered single-select tab.

**Chat from tab 2 (measured 2026-11-07, claude 2.1.319, #423): PASS in all four
layout pairs**, with exactly `buildChatFrames`' output and tab 1 answered `Green`
each time. The `tool_result` is the rejection ("The user wants to clarify these
questions"), Q1 `Answer: Green`, Q2 `(No answer provided)`. side-by-side then
compact-multi: `2, CR, 6`; side-by-side then side-by-side: `2, CR, Down x3, CR`;
compact then side-by-side: `2, Down x3, CR`; side-by-side then compact: `2, CR, 5`.

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

### A live question was erased by the NEXT tool — a SUBAGENT's counted (#236)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

The clearing rule beside `pendingQuestion` in `server.js` read *"a different tool started ->
prior question resolved"*. True of a strictly **sequential** single agent; false the moment
anything runs concurrently beside it — which is the ordinary shape of a session that has
dispatched a subagent. Measured: the subagent's `Bash` cleared the main agent's question 19
ms after it was asked, and the user answered 37 s later — **37 s of a question nothing was
showing.**

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

The clearing rule beside `pendingQuestion` in `server.js` read *"a different tool
started → prior question resolved"*. True of a strictly **sequential** single agent;
false the moment anything runs concurrently beside it — which is the ordinary shape of a
session that has dispatched a subagent.

**MEASURED** on the Home machine 2026-09-07 from this repo's own session, reading the main
transcript and the subagent's (`<session>/subagents/agent-*.jsonl`, `isSidechain`) beside
`logs/worker.log`:

| | |
|---|---|
| 09:48:12.687 | the main agent dispatches a subagent (`Agent`) |
| 09:48:20.539 | the main agent asks **AskUserQuestion** → `working -> waiting` |
| **09:48:25.527** | **the SUBAGENT runs `Bash`** → `waiting -> working`, 19 ms later |
| 09:49:02.107 | the user answers — 37 s of a question nothing was showing |

**Nothing ran in the main transcript in that window**, so the clearing `PreToolUse` was
provably the subagent's — and a subagent's hooks carry `agent_id` (#61). The log alone
could not have said that: it names the event, not whose it was.

**The REPORTED incident, on the Office machine twelve minutes earlier, has the same log shape and
is not proven to be the same cause** — its hook body was never captured, and the question
sat unanswered there for ten further minutes. What bounds the alternative is measured, on
the Home machine: of 923 transcripts, **93 of the 94** assistant messages that issue an
`AskUserQuestion` issue it **alone**. The one exception is a `[Bash, AskUserQuestion]`
batch whose `Bash` was emitted at 11:31:41.142 and had **returned** by 11:31:41.334 —
2.1 s before the question block existed at 11:31:43.453 — so it ran serially and no
`PreToolUse` of its could follow the question. Office's own `subagents/` directory would
settle Office outright, and is cheaper than closing the gap below.

> **The first cut of that measurement said "never batched", and it was an artifact of the
> transcript format.** Claude Code writes **each content block on its own JSONL line**, so
> grouping by line reports zero batching *everywhere* — and the positive control gives it
> away at once: grouped by `message.id`, **4,755 of 40,024** tool-using messages are
> batched. The same case also disproves the reason that was offered with it: a turn is
> **not** suspended while a tool call is outstanding, since that `Bash` ran while its
> message was still streaming. What remains unmeasured is a question-FIRST batch
> (`[AskUserQuestion, X]`, **0 of 94** observed): whether the executor starts `X` before
> the question resolves is **inferred** from Claude Code's serial handling of tools that
> are not concurrency-safe, not measured. *Count what the format actually groups, and run
> the positive control* — the same lesson as the negative-sweep rule.

**Both of the chat lens's signals die together, which is why NOTHING showed.**
`waitingFor` (#79) needs status `waiting` **and** a captured question, and the overlay's
`/pending-question` falls back to a transcript that **by design cannot hold an unanswered
question** (#19). The lone survivor was #194's terminal tail strip — the *backstop* —
reported as *"no indication, instead a last line small window"*.

**The rule now: only the MAIN agent's next tool resolves a question** — `!agentId` is the
whole fix, and the discriminator was already free: `agent_id` is read in that same function
for #61, twenty lines below the branch that needed it. `UserPromptSubmit`, `Stop` and the
question's own `PostToolUse` stay ungated.

**Gated on the EVENT's agent, not on the question's**, which is the narrower of the two
rules on offer. *"Only the agent that ASKED it may resolve it"* is more general and would
generalise a case that has never occurred: **0 of 775** subagent transcripts here contain an
AskUserQuestion. If one ever does, the only thing that stops resolving it is its **own
sibling tool calls** — its `PostToolUse` still answers it, and so do the main agent's next
tool, `UserPromptSubmit` and `Stop`. Only a *lost* `PostToolUse` (a hot reload in the
window) leaves it standing until the turn's `Stop`: one event later, in the direction that
SHOWS a question rather than hides one.

**On THIS path the worker needs no matching guard, and that is a decision rather than an
omission.** Its status is `questionPending ? 'waiting' : 'working'`, so #98's tri-state leaves the
flag alone, the session stays `waiting`, and it is spared the **5-minute** clock that had
been demoting it to idle while the prompt was still on screen. Since #230 a blocked-on-user
session is not timed out at ALL, so there is no longer a second, longer clock behind it.

**A held idle `Notification` is a SECOND path to the same symptom, and #238 deliberately
did not touch it — FIXED SEPARATELY IN #239.** When subagents are live the idle event is
parked as `heldStop` *before* that question check, and the `SubagentStop` that releases it
hands it to `armIdle`, which had no question check on any path. So the guard was bypassed
by the ordinary shape of a session that had dispatched a subagent, and the SUBAGENT
finishing idled a session blocked on the MAIN agent's question. The refusal now lives in
`armIdle` — the funnel BOTH idle routes pass through — rather than being copied to the
release site.

**Exactly one of the two holdable events is dangerous, and it is the more frequent kind of
block.** A held `Stop` is safe BY ACCIDENT: `server.js` classifies it as an event that
RESOLVES a question and sends `questionPending:false` with it, so the flag is already clear
on release. A `Notification` carries no opinion at all (#98's tri-state), so the flag
survives the hold. The precondition is routine rather than exotic — `Notification held`
appears **365** times in the Home machine's worker log since #61's hold shipped, `Stop held`
another 771; what was unobserved is only the coincidence with a live question.

> **WHY THE CHECK SITS AT ARM TIME, and a gap that turned out not to exist.** Putting it in
> `applyIdle` would also catch a question arriving during the 750 ms debounce, but `applyIdle`
> runs the #129 compact replay ABOVE the status flip, so returning early there would skip it.
> The first draft of this note offered that debounce window as a **known gap**; review traced
> it and it **cannot happen** — `questionPending: true` is only ever sent for `PreToolUse` +
> `AskUserQuestion`, and the worker's `PreToolUse` case calls `cancelPendingIdle`, so the very
> hook that raises the flag destroys any armed idle. *Naming a gap is only worth doing if the
> gap is real; an invented one is the same defect as an unmeasured claim, wearing humility.*

> **The second regression test's first draft asserted the WRONG thing**, which is worth
> keeping because it is a fact about #61 rather than about #239. Answering the question
> BEFORE the `SubagentStop` leaves the session `working`, and correctly so: a main-agent
> `PostToolUse` drops the held event outright, because a parent that picked its turn back
> up must not be handed a stale "done" when its subagent exits. The honest shape is to let
> the release be REFUSED first, then answer, then send a fresh idle.

**Not #230**, whose *correctly*-set `waiting` was retracted by that same corrector at 12h -
same symptom, opposite end of the timescale: this one lasted 6.1 s on Office, 5.0 s on Home.
#230 has since removed that horizon entirely (measured wrong 71 times out of 72).

