# Input & Submit — measurements and history

> **Findings archive.** Moved verbatim out of `CLAUDE.md` on 2026-09-15, when that
> file passed the 150k-char context limit. Nothing was rewritten or summarised.
>
> `CLAUDE.md` carries the **rules**; this file carries the **evidence** — measurements,
> probe recipes, refuted hypotheses and review post-mortems. Read it before reopening
> any issue it covers, and add new measurements here rather than to `CLAUDE.md`.

---

## Input & Submit Contract (issue #55) — this is law, not guidance

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

The sentence *"Enter doesn't run it"* has described at least four **different** bugs in
different layers. A change to input or submit is correct only if it satisfies the rules
below, and each has a test that fails without it. Evidence:
`docs/findings/input-submit.md`.

**Compose bar = the app's text box**, not the agent's own TUI prompt. **Submit = the
agent actually starts a turn** — text appearing in its prompt box is *not* submit, which
is why the only valid detector anywhere in this area is *"did a turn start"*. The
PTY/rollout is ground truth; the screen lies.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

The sentence *"Enter doesn't run it"* has described at least four **different** bugs in different layers. A change to input or submit is correct only if it satisfies the rules below, and each rule has a test that fails without it. Full spec: issue #55.

**Compose bar = the app's text box.** Not the agent's own TUI prompt. **Submit = the agent actually starts a turn** — text appearing in its prompt box is *not* submit.

### The keyboard contract — chosen by PLATFORM, never by lens

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

Mobile is Send-only because the **Android IME commits Enter as literal `"\n"` text, not
a key event** — a submit bound to an Enter keydown is unreliable there by construction.
The gate is `composeUsesSoftKeyboard()` (companion `compose_bar.dart`; `app.html` mirrors
it off the UA). In `app.html` the bar's **visibility** keys on `isMobile`, which ORs in
`innerWidth < 600`, so a narrow *desktop* window shows the bar and must still submit on
Enter. **Visibility is not platform — do not collapse them.** The bar is multi-line
(`minLines:1, maxLines:5`) and a soft-wrapped line contains no `\n`.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

Chat and terminal lenses share one compose bar with one set of keys.

| Platform | Enter | Ctrl+Enter | Send button |
|---|---|---|---|
| **Desktop** (hardware kbd) | **Submit** | Newline | Submit |
| **Mobile** (soft kbd) | **Newline** | (n/a) | **Submit** |

Mobile is Send-only because the **Android IME commits Enter as literal `"\n"` *text*, not a key event** — a submit bound to an Enter *keydown* is unreliable by construction there. The gate is `composeUsesSoftKeyboard()` (companion `compose_bar.dart`; `app.html` mirrors it off the UA). In `app.html`, **visibility** of the bar is keyed on `isMobile`, which ORs in `innerWidth < 600` — so a narrow *desktop* window shows the bar and must still submit on Enter. Visibility ≠ platform; do not collapse them.

The bar is **multi-line** (`minLines:1, maxLines:5`), soft-wraps, and a wrapped line contains **no** `\n`.

**A widget test cannot prove any of this.** Synthetic key events never traverse the OS text-input path, so a widget test passes while the shipped app is broken. Desktop Enter needs real injected OS keystrokes (`scripts/rig/probe-drive-windows.ps1` + `tool/compose_probe.dart`); mobile needs a real device.

### Client-side encoding — `buildComposeSubmission` (one function per client)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

1. Strip a **trailing** newline. 2. If a `\n` **remains** -> `ESC[200~` + text +
`ESC[201~` + `\r`. 3. Else -> text + `\r`. 4. Send as **ONE** frame (#44: a client that
dies mid-submit must not lose half of it).

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

1. Strip a **trailing** newline. 2. If a `\n` **remains** → `ESC[200~` + text + `ESC[201~` + `\r`. 3. Else → text + `\r`. 4. Send as **ONE** frame (#44: a client that dies mid-submit must not lose half of it).

A live `/`-line streams to the PTY as you type so the agent's slash menu narrows. That prompt is **one line**, so `composeLiveProjection()` **drops newlines** — mirroring one as `\r` would *submit*, which is exactly how Enter came to fire a `/`-line on mobile while merely newlining everywhere else.

### The wire cap and the offline-buffer ceiling are ONE number (#201)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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
- **`app.html` is gated too now (#206)** — and the reason it was not is worth keeping,
  because **half the premise was stale.**
  - **But "both clients" was wrong, and briefly stood in this file as a claim.** There
    was a THIRD page, and it was the worst off of the three: **`terminal.html`**, the
    legacy terminal-only view served at `/s/:id` and linked from `lobby.html`. (That link
    still exists and still points at `/s/`; it simply lands on the redirect now.) Four
    ungated input sends (a Ctrl+V paste among them) **and** it discarded the server's own
    `inputDropped` frame — there is no notice UI in that file to render one in. So there:
    a >256 KB paste was refused by the server and reported to nobody, and a >4 MiB paste
    closed the socket with nobody told why. The value of a record like this one is that it
    is accurate, and the previous sentence here was the second comment in two PRs to claim
    a convenient thing nobody had checked.
  - **#218 closed it by UNSERVING the page, not by gating it.** `/s/:id` now redirects to
    `/app/:id` (302 — a 301 is cached indefinitely and would make a revert a support
    problem). The page keeps its four ungated sends; what makes that safe is that nothing
    routes to it, which is why `check-shared-constants.js` still gates **three** copies of
    `WS_INPUT_MAX` and not four, and why `tests/legacy-route-redirect.spec.js` asserts
    **against the source** that no route serves the file — a route added next year would
    leave every behavioural test in the repo green.
  - **And the issue's own caveat was BACKWARDS, which is why it was worth checking rather
    than believing.** #218 warned that a redirect might drop the CLUSTER case, since
    `terminal.html` "builds its own WebSocket URL". It has **no cluster code at all** —
    its socket is always `location.host` + `/ws/<id>` — and the old route gated on a
    `getSession` RPC answered by the **local** worker only, so a peer-hosted id threw and
    bounced the user to `/`. `app.html` resolves the same bare `/app/:id` against
    `/api/cluster/sessions` and opens the peer through the `/cluster/:serverUrl/ws/:id`
    proxy. So the redirect **adds** capability: an `/s/` link reaches a peer session for
    the first time. *A caveat is a hypothesis; this one cost one grep to falsify.*
  This bullet used to say the file had "no single input path"; in fact `sendInput` had
  been the coalescing path for typing and for the compose bar all along, and exactly
  **four** sites wrote past it to `ws.send` — the image-path paste, the mobile toolbar
  key, the long-press Paste action, the tap-to-move arrow repeat. So the fix is a
  **funnel** (`sendPtyInput` wrapping `ws.send`), not the new mechanism the issue
  budgeted for. *Check the claim before you cost the work.*
  - The cap is tested **before** the socket state: the refusal is a fact about the data,
    and a notice that appeared only when a socket happened to be open would be the
    flakiest possible affordance.
  - **Every caller's FRAMING is untouched.** #55/#44 make a submit one frame on purpose,
    and #87's images-only submit needs its paste close and its bare CR to reach the wire
    as separate writes a measured gap apart. This wraps a send; it re-coalesces nobody.
  - **A funnel's whole value is that nothing goes round it**, and no behavioural test can
    see that — a `ws.send` added next year would leave every other test in the repo
    green. `tests/app-input-path.spec.js` therefore asserts it against the **source**,
    with an allowlist of the frames that are not input (`resize`, `mode`, `heartbeat`,
    the notify ping), as well as driving the cap end to end.
  - `WS_INPUT_MAX` is now a **third** site in `scripts/check-shared-constants.js`. An
    ungated copy would decide whether the browser refuses a write itself or lets the
    **transport** refuse it — and the transport refuses by closing the socket.
- **The cluster proxy tells the browser when its reconnect buffer refuses a write** —
  the remote link is what is down, `localWs` is open throughout. **Once per outage, not
  once per keystroke:** the buffer LATCHES (#201), so everything after the first refusal
  is refused for the same reason, and a banner per character is noise that teaches you to
  ignore the one that mattered. The reporting rule therefore lives with the latch in
  `lib/reconnect-buffer.js` (`decide`) rather than as an `if` beside it.
- **And #209 is the OPPOSITE case on that same path, which was silent for longer.**
  There the buffer is full and says no; here every write is *accepted* and the whole
  buffer is then discarded because the peer never came back — so nothing was ever
  refused and there was no signal at all, just `1001 Remote unreachable` about **37s**
  (500ms/1s/2s/4s/5s-capped x 10) after typing into a session that looked merely laggy.
  `attemptReconnect` now sends one notice naming the total before the close, under a
  third `reason` — **`'peer-unreachable'`, not `'buffer-full'`**, which means *there was
  no room left* and is exactly what did not happen. The buffer is cleared **before** the
  close, which makes a second report impossible by construction — defensively: nothing
  re-enters that branch today, and saying otherwise would be a comment claiming a
  measured path. The send-then-close ordering, by contrast, IS asserted, from inside the
  close handler rather than assumed of `ws`.
- **Three things review caught in that fix, each a rule rather than a patch — and all
  three of the give-up's decisions ended up in `lib/reconnect-buffer.js` as `giveUp`,
  beside `decide`, for the reason stated one bullet up.** Left at the call site they had
  already become two loose counters and an assignment: exactly the `if` this module was
  extracted to prevent. `giveUp` also makes them testable with no socket and no 37
  seconds.
  (1) **"What was lost" is not "what was held."** Once the buffer latches, `count` is
  pinned at 100 and every later refusal lands in no array — so the give-up must add a
  tally kept beside the latch, or it tells someone who typed 105 things that it lost
  100, *with a precise figure*. The earlier `buffer-full` notice does **not** cover the
  remainder: both render into the same element, so the second **replaces** the first.
  (2) **`next.latched` is true unconditionally**, because `close()` leaves `readyState`
  at CLOSING and `ws` keeps delivering `message` — otherwise a write in that gap is
  admitted to a buffer that can never be flushed. An empty buffer has the same window,
  so the latch cannot hang off "something was lost". **This is the half no integration
  test can reach** — it guards a window inside a closing socket, where by construction
  no notice could be sent to observe it — which is the argument for the rule living in
  a pure module at all: *the rule is testable even where the race is not.*
  (3) **A BACKGROUND SOCKET IS STILL A SOCKET THE SERVER REPORTS ON.** `app.html`'s two
  background `onmessage` handlers listed `inputDropped` in their *ignore* set. That was
  survivable while every refusal fired *as you typed* — you are still on that session
  when it lands — and is not survivable for a notice that arrives **37s later**, by
  which time you have very likely switched away. They now stash it on the session's
  cache entry, drained once on return (a notice belongs to the session it was raised on,
  #179's rule). With `keepSessionsOpen` off there is no background socket at all, so
  there is nothing to stash.

**`WT_CLUSTER_TOKENS_FILE`** exists so that regression test can write a cluster entry
pointing at a dead port. `cluster-tokens.json` holds a live bearer token for **every peer
in the cluster**, and a backup/restore around the test is not enough — a suite run that is
SIGTERM'd part-way (what happens when the full suite outlives a 10-minute tool ceiling)
never reaches its restore. Redirect the path and the real file is never opened.

### Server-side delivery — the SSOT, and where the real bug lived

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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


### A DICTATED prompt has no newline, so nothing ever bracketed it (#213)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

The rule above rescues the **CR**. It leaves the **BODY** to the TUI's own paste inference,
and for one shape of prompt that inference loses the text. `buildComposeSubmission` picks
its byte shape on exactly one predicate — **does the buffer contain a newline** — so a
pasted paragraph goes bracketed and **a dictated one does not**. Dictation emits no line
breaks at all. That is the whole mechanism, and it is why the long prompts that break are
always the spoken ones.

**Measured** (`scripts/rig/probe-paste-single-line.js`, claude 2.1.251, verdict from the
**transcript** — a composer scrolls, so its screen shows a tail whether or not the head
arrived, which is exactly why this survived so long):

| chars | unbracketed (what a dictated prompt sends) | bracketed |
|---|---|---|
| 288 / 488 / 988 | whole | — |
| 588 | whole once, **NOT SUBMITTED** once | whole |
| 1088 | **no turn** — nothing survived to start one | — |
| 1588 | **HEAD CUT of exactly 1024**, twice | whole |
| 2588 | — | whole |

**1024 is a buffer boundary, not a timing artifact**: at 1588 the survivor is the last 564
characters and begins **mid-token at offset 1024**, reproducibly. And it is the **HEAD**
that goes — the shape of #89 (1582 sent, the last 666 received), whose root cause was
never pinned and now is.

**Three probes existed and each covered a different cell.** `verify-long-prompt.js`:
unbracketed 1582 → a plain **shell**, intact. `probe-paste-truncation.js`: bracketed → a
shell, intact to 32 KB. `probe-paste-claude.js`: bracketed → **real Claude**, intact to
41,899. Nobody had put **unbracketed into a real agent**. The first of those matters
twice: it already carries this exact shape at this exact size through the whole
HTTP → WS → server → worker → PTY path intact, so **the transport is exonerated by
measurement, not by argument** — and that is why #193's fleet-wide hunt found nothing. It
measured a *pasted paragraph*, which has newlines.

**The fix is `submit.bracketAbove` in the registry, applied in the worker** — one owner,
every client fixed with no client release, `app.html` included. Claude declares **512 BYTES** (not characters — dictated
Hebrew is two bytes a character, so 512 of them land on the cliff exactly):
under the 1024 cliff *and* under 588, where the submit was lost on one run of two, so the
threshold sits below the flakiness rather than below the cliff. Codex and plain shells
declare **none**, and undeclared means never — today's bytes exactly. That asymmetry is
deliberate: splitting a CR is invisible to a reader that does not need it, while
`ESC[200~` is only correct for one that understands the sequence, and a shell with
bracketed paste off would take the markers as literal text.

> **This does NOT contradict "never fix a submit problem by changing the bytes."** That
> rule is about the **CR** — about making Enter be Enter, where only a temporal gap works,
> and the gap is kept here untouched. This changes the **BODY**, and it does not disguise
> it as something else: a compose submit *is* a block insert, so the frame is being
> labelled as what it already was. `contains('\n')` was a proxy for "is this a paste", and
> the proxy is what was wrong.

**Refused, never sanitised.** A body carrying ESC, CR or LF is left exactly as it is —
it may already be a bracketed paste, an arrow key, or a live `/`-line's backspaces.
`_pasteInner`'s lesson is that stripping markers out of a body is no defence (deleting the
inner `ESC[200~` from `a ESC[2 ESC[200~ 01~ b` reconstitutes a close), and refusing costs
nothing because every such body already has a working shape.

**Codex is deliberately unmeasured**, the same convention `readiness` follows: its
paste-burst handling is its own (`paste_burst.rs`), so Claude's cliff is not evidence
about it in either direction. And the threshold is measured against **one claude version**
— a release that changes its paste inference needs a rig re-probe, which no unit test can
catch.

### Interrupt (Esc) — status must go idle promptly

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

Claude fires **no hook** on a user interrupt (`Stop` does not run), so an interrupted
session sat on "working" until `correctStaleStatus` rescued it 5 minutes later. The
**worker writes the Esc byte itself**, so it is the one component that can know: a **lone
`0x1b`** (`isEscapeKey` — length 1, so an arrow's `ESC [ A` never counts) sent to a
**`working`** session flips it to idle at once. Gated on `working` on purpose — Esc at a
permission prompt (`waiting`) *rejects the tool* and Claude carries on. No push fires; the
user is the one who pressed Esc. A **plain shell declares `onEscape: false`**, so Esc in
vim or less is never read as "the agent stopped".

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

Claude fires **no hook** on a user interrupt (`Stop` does not run), and worker status is otherwise hook-driven — so an interrupted session sat on "Claude is working" until `correctStaleStatus` rescued it **5 minutes** later. But the **worker writes the Esc byte itself**, so it is the one component that can know: a **lone `0x1b`** (`isEscapeKey` — length 1, so an arrow's `ESC [ A` never counts) sent to a **`working`** session flips it to idle at once. Gated on `working` on purpose: Esc at a permission prompt (`waiting`) *rejects the tool* and Claude carries on. No push fires — the user is the one who pressed Esc.

### Where it lives (no branching, ever)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

`lib/agents.js` — the registry: each provider declares `submit: { gapMs, crBurstsAsPaste,
bracketAbove }`, `interrupt: { onEscape }`, `readiness`, `submitConfirm`.
`lib/submit-frames.js` / `lib/submit-confirm.js` / `lib/agent-ready.js` — the pure rules.
`pty-worker.js` — applies them where bytes meet the PTY. **An `if (agent === 'codex')` in
`server.js`, `pty-worker.js`, `app.html` or the companion means the change is in the wrong
file — add a registry field instead.**

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

`lib/agents.js` — the registry: each provider declares `submit: { gapMs, crBurstsAsPaste }` and `interrupt: { onEscape }`. A **plain shell declares `onEscape: false`**, so Esc in vim/less is never read as "the agent stopped". `lib/submit-frames.js` — the pure byte rules (`splitTrailingCr`, `isEscapeKey`). `pty-worker.js` — applies them where bytes meet the PTY. **An `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html` or the companion means the change is in the wrong file — add a registry field instead.**

### How to verify (no production cold-restart to test a hypothesis)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

`node scripts/rig/rig.js up` runs a complete, **isolated** web-terminal (port 7999, own
worker pipe, own data dir, own config) from the working tree — it cannot touch production.
`node scripts/rig/verify-submit.js` proves a LONG prompt actually submits, end to end.
Claude echoes a submitted prompt back into its transcript, so "is the text still visible"
cannot distinguish *typed* from *submitted*.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

`node scripts/rig/rig.js up` runs a complete, **isolated** web-terminal (port 7999, own worker pipe, own data dir, own config) from the working tree — it cannot touch production. `node scripts/rig/verify-submit.js` proves a LONG prompt actually submits, end to end. **The PTY/rollout is ground truth; the screen lies** — Claude echoes a submitted prompt back into its transcript, so "is the text still visible" cannot distinguish *typed* from *submitted*. The only valid detector is **"did a turn start"**.

### A spawned agent is NOT ready when its session is (#147)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

> **DONE (#263) — and the deferral's stated reason was false by the time it was
> written.** This read *"`app.html` is ungated. It keeps no session-state map to hang
> `agentReady` on"*; `renderComposeCommands` had been doing exactly that lookup since
> #188, cluster-safe (matching on server as well as id, #180), to grey out the quick-
> commands button. So the web client correctly refused to fire a *slash command* into a
> booting agent and cheerfully submitted a *prompt* into one. **Check the claim before
> you cost the work** — the same lesson as #206's "no single input path", which was also
> a budget written from a premise nobody had re-read.
>
> **Two sources, because the sidebar payload alone would WEDGE.** Nothing refreshes it
> on a timer — it is event-driven — so `agentReady:false` could outlive the boot it
> describes. The server already PUSHES `{type:'agentReady', id}` on the notify socket
> (that push exists because "a poll interval here is a submit that stays refused for no
> reason"), and readiness only ever goes false → true, so the live half is a Set. The
> push reaches **local sessions only** — `connectNotify` opens one socket, to this host,
> and a peer's worker events never cross the cluster proxy — so a peer falls back to the
> row, and **the refusal re-reads the sidebar**: the press that was refused is what
> corrects a stale answer, which is this repo's *verify, don't predict* rule (#179)
> arriving on the client.
>
> **The Send button is deliberately NOT disabled**, which is where this parts company
> with the companion's `_canSend`. The companion holds a live per-session state stream;
> here the negative can come from a payload with nothing scheduled to refresh it, and a
> **disabled button cannot ask for fresh data** — the press is what triggers the re-read.
> Disabling it would turn a stale `false` into a compose bar that is permanently dead,
> which is worse than the bug being fixed.
>
> **The client's latch inherits gap 1 above and cannot be worse than it.** The worker's
> latch is one-way and does not reset when an agent exits back to its shell, so a client
> Set that mirrors it is wrong in exactly the same cases and no others — an agent that
> `/exit`s leaves both believing it is up. Fixing that belongs in the worker, which is the
> only component that sees the bytes; nothing here should try to guess it independently.

### A CLIENT gate does not cover a WORKER-originated write (#137/#138 × #147)

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

The cap-prompt detector scans **all** agent-session PTY output and answers by **writing a
keystroke**. Its phrase was once captured verbatim into a `lib/agents.js` comment and
assembled in a test, so a Claude session that `cat`'d, grepped or diffed either file
matched, typed a stray `1` into its composer and recorded a cap block that never happened.
**A match that causes an action is not a reading; treat "our own repo prints this" as a
live input.** The rule is now structural and pure (`lib/usage-limit.js`
`matchUsageLimitPrompt`): the sentence must **start** its line as a numbered option and
have a sibling option **above or below** it. The registry declares only the sentence.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

**Agent View captures are deliberately NOT checked in:** `claude agents` lists every Claude
session on the machine by name and one-line summary, and this repo is public. Keep the
numbers, not the bytes.

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

**Law, as `CLAUDE.md` stated it until 2026-10-26** — moved here verbatim when `CLAUDE.md` became a one-line-per-rule digest. Frozen history: the digest line in `CLAUDE.md` is the only current law.

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

*(End of the moved law text. The evidence below was written earlier; where the two disagree, re-measure rather than pick one.)*

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

