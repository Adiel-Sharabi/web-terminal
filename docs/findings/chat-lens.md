# The chat lens, scrollback and the companion widget layer

> **Findings archive.** Moved verbatim out of `CLAUDE.md` on 2026-09-15, when that
> file passed the 150k-char context limit. Nothing was rewritten or summarised.
>
> `CLAUDE.md` carries the **rules**; this file carries the **evidence** — measurements,
> probe recipes, refuted hypotheses and review post-mortems. Read it before reopening
> any issue it covers, and add new measurements here rather than to `CLAUDE.md`.

---

## The session recap — "my last prompt" is NOT `role === 'user'`

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

## A prompt sent WHILE THE AGENT WORKS is not a `role:user` turn (#249)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

Claude Code records a prompt submitted mid-turn as an **attachment**, never as a
user message:

```json
{"type":"attachment","timestamp":"…",
 "attachment":{"type":"queued_command","prompt":"…",
               "commandMode":"prompt","origin":{"kind":"human"},"source_uuid":"…"}}
```

`parseTranscriptTurn` read only `user`/`assistant` lines, so **the chat lens never
received the prompt at all**. The only thing showing it was the client's optimistic
`Queued` echo (#31) — and `conversation_view.dart` renders echoes after every
transcript turn *and* after the working indicator, so everything the agent produced
in reply appeared **above** it. Reported 2026-09-09 as *"the terminal took it and
responded for it, but in the chat lens it looks in a wrong order."*

**The same gap has a worse second half.** The echo reconciles by matching a turn's
`typedText` (#149); against a turn that does not exist it can never match, so once
the session leaves `working`/`waiting` the 90 s safety timeout **deletes** it and the
prompt leaves chat entirely. That is the 2026-08-16 report (*"I add prompt … I can't
see it in chat"*) arriving through a different door — #149 fixed the comparison, and
the thing being compared against was missing all along.

**MEASURED** over 972 transcripts / 641 `queued_command` records (a live corpus — it
was 973 files an hour later in review and every derived count below reproduced
exactly):

| `commandMode` / `origin.kind` | count |
|---|---|
| `task-notification` / (no origin) | 520 |
| `prompt` / `human` | 87 |
| `prompt` / `peer` | 34 |

**80 of the 87 human ones have no `role:user` turn anywhere in their session** whose
`typedText` matches. The 7 that do are coincidences (short words like `continue`,
typed again later); exactly **one** matches within six records, and reading that
session shows a genuine second send — the turn was interrupted
(`[Request interrupted by user]`) and the sentence re-typed 28 s later. Re-run over
all 54 real sessions with the fix in place: 87 turns emitted, **0 adjacent duplicate
user bubbles**.

**The fix is one branch in `lib/transcript.js`, server-side only** — the chat lens is
fixed with **no client release**, the same arrangement `typedText` itself uses, and it
**hot-reloads**. The turn is emitted at the attachment's own byte position, which is
what puts it above the reply.

*Say "the chat lens", not "both clients".* Only the companion has one — `app.html`
carries no reference to `/transcript`, `typedText` or `userKind` at all — and a first
draft of this section said "both clients" anyway. That exact phrase is already
recorded as wrong once in this file, for a different reason (#206, where the second
client was `terminal.html` and nobody had checked). **An older companion is covered
too, and by construction:** `turnMatchKey` falls back to `normEcho(turn.text)` when
`typedText` is absent, and here `text === typedText`, so the echo reconciles even on a
build predating #149.

**TWO GATES, and both are narrowings rather than sniffs.** `commandMode === 'prompt'`
excludes `task-notification`: 520 rows of plumbing (`classifyUserTurn` reads one as
`system`, so the cost is noise, not a mislabelled bubble), **34 of which restate a
notification that already arrives as a real `role:user` turn** — matched on the
shared `<task-id>`, the only sound comparison, since **not one of the 520 is
textually identical** to a user turn and a prefix match therefore answers whatever
length you pick. `origin.kind === 'human'` excludes `peer`: another agent's queued message is
wrapped in `<agent-message from="…">`, **a signature `classifyUserTurn` does not
recognise** — it classifies as `human`, so admitting one would put another agent's
words in a **"You"** bubble, which is the teammate-bubble bug this repo has already
paid for once. None of the 34 appears as a `role:user` turn either, so a queued
teammate message stays invisible in chat; that is #250, and its fix is a
signature in `lib/user-turn.js`, not a wider gate here.

**Build the turn from `attachment.prompt`, never from `rendered`.** The `rendered`
array restates the prompt inside a `<system-reminder>` telling the *agent* how the
message was delivered — wrapper text, not what the user typed, and an echo compared
against it could never match. Same trap as #149, one layer out. A queued prompt
carrying a pasted image arrives as content blocks: keep the text, drop the base64.

**Unmeasured, deliberately.** A queued **slash command** — 0 of the 87 start with
`/`, so which `commandMode` one carries is unknown; if it is not `'prompt'` it stays
as it is today. And Codex, whose rollout has no equivalent record and was not looked
at, per the standing convention that Claude's behaviour is not evidence about it.

> **The screenshot said "one bubble in the wrong place"; the transcript said "no
> bubble at all".** Both readings fit the crop, and they have different fixes — a
> client ordering change versus a server parser gap. What settled it was reading the
> actual transcript: `queue-operation enqueue`, then the attachment, then the reply,
> with no user message anywhere between. *The rollout is ground truth; the screen
> lies* — the same rule the Codex work established, applied to a screenshot.

> **MUTATE ONE GATE AT A TIME, and a negative fixture faithful to the corpus is the
> one most likely to be vacuous.** Both gate tests were confirmed red by removing
> BOTH gates together, and that proved nothing about either. The `task-notification`
> fixture is drawn from real data, where all 520 carry **no `origin`** — so the
> ORIGIN gate turns it away, and `commandMode !== 'prompt'` could be deleted with the
> whole suite still green. The fix is a second, deliberately **synthetic** fixture (a
> human `origin` on a task-notification, a shape that does not occur) whose only job
> is to fail when that one line goes. Caught in review, and it is this repo's
> "audit the negatives first" rule arriving from a new direction: the usual vacuous
> negative passes because the feature is absent, this one passes because a
> *different* guard fires first.

> **And one number in the first draft was an artifact of its own threshold.** It
> claimed 9 of the 520 task-notifications already arrive as real user turns; that 9
> came from testing whether a user turn contained the prompt's first 120 characters.
> A 60-char prefix gives 15, exact equality gives **0**, and the sound comparison —
> the `<task-id>` they share — gives **34**. A measurement whose answer moves with a
> parameter nobody chose deliberately is not a measurement. State the predicate, not
> just the count.

## Scrollback has TWO byte spaces, and they diverge at the HEAD (#167/#176/#178)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

## The chat lens's tail strip: "the last N rows" is the FURNITURE, not the screen (#194/#210)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

The strip (#194 Part 1) shows the terminal's last few non-blank rows inside the chat
lens, so a session parked on something chat has no bubble for is still visible. #179 is
why it shows the screen rather than naming the state: **not one blocked state emits a
distinguishing byte**, so a classifier for "blocked" is permanently incomplete.

**That thesis is right, and the first implementation read it too literally.** Claude ends
every composer screen with a FIXED FOOTER — the composer box's bottom border, the mode
hint, the status line, any update notice. "The last 4 non-blank rows" and "that footer"
are therefore **the same thing by construction**, whatever happened above them. So the
strip rendered four identical rows on every idle session, held ~90px of the chat view
open to do it, and was least informative in exactly the state its own gate
(`status != 'working'`) selects for. Reported from the phone as *"it always shows the
status bar… not sure how effective it is"*.

**The fix inverts what is recognised.** Recognise exactly ONE thing — the ordinary
composer — and recognise it in order to **stay quiet**. A screen without that marker near
its foot falls through to the tail as before, whether or not anyone has measured it, and
an agent declaring no marker is never gated at all. **The failure direction is showing the
terminal, never hiding it**, which is the opposite of a classifier's, so #179's argument
does not apply to it. The strip appearing now MEANS something is on screen, instead of
meaning nothing.

**Say "a screen without the marker", not "every dialog".** The set that falls through is
defined by the marker's absence, and only the screens in the table below were actually
measured for it. **The tool-approval / AskUserQuestion selector was NOT** — no capture of
one exists anywhere in this repo, and #190 established NBSP-absence for the trust dialog
only. If that selector draws the composer within the window, the strip hides on a blocked
screen. It is the least costly place for this gap to sit — a hook-driven wait already has
#79's banner and the #19/#143 question overlay, so unlike the trust dialog the session is
not invisible — but it is a gap, not a proof, and it needs a rig case before anyone claims
otherwise.

The marker is the one `lib/agents.js` already owns and #190 already measured (U+276F +
U+00A0, and the folder-trust dialog draws the same caret WITHOUT it). It is **published
on `GET /api/agents`** rather than retyped in Dart — the same arrangement the label and
the colour use, and the same rule that keeps the companion holding no agent table. One
definition now serves two jobs: the worker gates submits with it (#147), the companion
tests the rendered screen with it. **That it survives rendering was measured, not
assumed** — writing caret+NBSP into the vendored xterm and reading the row back through
`getText()` returns code units `[10095, 160]`, so caret+U+0020 still fails to match.

**MEASURED** (`scripts/rig/probe-tail-strip.js` drives the real TUI;
`tool/tail_strip_report.dart` renders each capture through the app's own xterm):

| screen | caret's distance above the last non-blank row |
|---|---|
| idle, 120 cols | **3** |
| idle, 52 cols | **4** — a phone footer is a row taller |
| slash menu, `/usa` | **9** — the BINDING case |
| slash menu, `/usage` | 14 |
| slash menu, bare `/` | 16 |
| Agent View | 20 |
| `/usage` panel | **no caret on screen at all** |
| slash menu, `/zzzq` | 2 — nothing matches, so there is NO MENU |

**The narrowed menu is what sets the ceiling, and measuring only the bare `/` would have
missed it.** Bare `/` is the menu at its TALLEST — its ~16 entries are the only reason the
caret sits far up the screen. Type a few characters, the list filters, and the caret comes
back to 9. A first cut of the constant sat at 8 and cleared that by ONE row; review caught
it, and the extra probe case is what turned an argument into a number.

So the measured bound is **[5, 8]** — at least the widest idle footer (4, plus a row for
an update notice), strictly under the narrowed menu's 9 — and `kComposerScanRows = 7` is
the balanced point inside it: three rows of headroom above, two of clearance below. The
`/zzzq` row is not a counter-example: with nothing matching, Claude draws no menu at all
and the screen IS an ordinary composer, where Enter submits normally.

**The captures are deliberately NOT checked in** — #146's rule: an Agent View frame names
every Claude session on the machine and this repo is public, and the idle frame carries a
status line naming a project and a user. Keep the numbers, drop the bytes.

**Two findings that each cost a wrong answer first, both kept because they generalise.**

1. **The rig falsified the first cut on its first run.** The scan counted rows up from the
   **bottom of the viewport**; a real idle screen puts its content in rows 0–12 of a
   30-row viewport, so the caret sat at row 9 with **seventeen blank rows beneath the
   footer** and no window size could reach it. It was a silent no-op that changed no
   behaviour at all — and **every synthetic fixture passed against it**, because none of
   them had trailing blanks. The anchor is now the last row WITH CONTENT: *a screen is not
   the same shape as a window.* Same anchor-on-content lesson as #167/#178, arriving from
   a third direction.
2. **The issue's own reasoning about the slash menu was wrong — and then the first
   measurement of it was still not enough.** The filed table predicted the menu would keep
   the composer on screen and hide the strip; measured, bare `/` pushes the caret 16 rows
   up, so the strip correctly SHOWS. All three "unmeasured" rows came back better than
   inferred. But **one sample of a variable screen is not a measurement of it**: review
   pointed out that a menu NARROWED by typing shrinks back toward the composer, and the
   follow-up probe found 9 — one row from the bound as first set. **Measure the family,
   not the specimen**, and prefer the tightest member.

**Codex is deliberately unchanged.** It declares no readiness marker (#147: an unmeasured
marker is what #143 shipped) and its composer line varies with model and effort, so it
publishes null and the strip behaves exactly as before #210 there. A screen marker for
Codex is its own separately-measured change — note it would NOT be safe to reuse
`readiness.composer` for it, because that field also gates submits.

