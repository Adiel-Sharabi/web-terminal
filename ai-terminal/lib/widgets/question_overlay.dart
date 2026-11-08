/// Native overlay for Claude's interactive AskUserQuestion prompt (issue #19).
///
/// The prompt's structure (questions, options, multiSelect) comes from the
/// transcript via `GET /api/sessions/:id/pending-question` — not by scraping
/// the TUI — so this renders a real, selectable control. Answering drives
/// Claude's own TUI selector by forwarding absolute row digits
/// ([buildAnswerFrames]); the chosen labels are shown for confirmation before
/// sending, and the raw key strip stays available as a fallback if a prompt's
/// keybindings differ from the model here.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import 'question_answer_panel.dart';


/// One outbound frame: send [keys], then wait [delayMs] before the next frame.
class AnswerFrame {
  const AnswerFrame(this.keys, this.delayMs,
      {this.text = false, this.other = false, this.chat = false})
      : assert(!other || text, 'an Other frame carries text');

  /// The bytes to write to the PTY.
  final String keys;

  /// True for a frame carrying the user's own words (an Other answer or a note)
  /// rather than a key (#383). The session screen reads it to know that an
  /// answer which did not land may be partly typed into the terminal.
  final bool text;

  /// True for the Other free-text frame specifically, the one whose own committing
  /// `\r` follows it. [answerNeedsConfirm] reads it: see there (#383).
  final bool other;

  /// True for the frame that picks Claude's "Chat about this" row (#423). That
  /// choice REJECTS the question rather than answering it, so [answerIsVerifiable]
  /// reads it to say there is no landing to wait for: see there.
  final bool chat;

  /// How long to wait after sending, before the next frame. Frames that must
  /// land in *separate* stdin reads (question transitions, a confirming Enter)
  /// use a generous gap; absolute row-toggles that may safely coalesce use a
  /// short settle.
  final int delayMs;
}

/// Builds the frames that answer [selections] (one selected-index set per
/// question) through Claude's AskUserQuestion TUI using ABSOLUTE row digits
/// (1-based) instead of arrow navigation.
///
/// Why digits, not arrows: arrow+Enter frames merge into one stdin read on the
/// way to the PTY, and the TUI applies them in a single batched state update —
/// so `Enter` confirms the *stale* default (top) row and the wrong option is
/// picked. A digit selects an exact row regardless of ordering or coalescing.
///
/// *** The digit does not always submit — the layout decides. ***
/// When any option carries a `preview`, Claude renders the selector SIDE-BY-SIDE
/// (option list left, preview box right) and a digit becomes pure NAVIGATION:
/// it moves the highlight so you can read that option's preview, and Enter is
/// what commits. In the compact layout (no previews) the same digit selects AND
/// submits. Measured on the real TUI (claude 2.1.220, node-pty + headless VT,
/// verdict taken from the transcript's AskUserQuestion tool_result — the screen
/// cannot tell "highlighted" from "submitted"):
///
///   layout        keys    outcome
///   no preview    `3`     submitted, recorded "Fold themes into Home.md"
///   preview       `3`     highlight moved to row 3, NOTHING submitted
///   preview       `3\r`   submitted, recorded "Fold themes into Home.md"
///   no preview    `3\r`   submitted; the extra Enter lands on an empty prompt
///                         line and is a no-op
///
/// So a single question sends digit THEN Enter: correct in both layouts, and the
/// redundant Enter of the compact layout is measured harmless.
///
/// MULTI-QUESTION FOLLOWS THE SAME LAYOUT SPLIT — and the two halves need
/// OPPOSITE key sequences, which is why the layout has to be known rather than
/// guessed. [PendingQuestionItem.hasPreview] carries it (server-derived; the
/// client never re-derives it):
///
///   * COMPACT tab (`hasPreview == false`): the digit selects AND auto-advances
///     to the next tab, so a following Enter would land on the NEXT, still
///     unanswered question and commit ITS default top row — silently answering
///     something the user never saw. Send the digit alone.
///   * SIDE-BY-SIDE tab (`hasPreview == true`): the digit only moves the
///     highlight and advances nothing, so Enter is what both COMMITS the row and
///     moves to the next tab. Without it every later key piles onto tab 1.
///
/// That second case is the bug reported 2026-08-03 ("the chat lens didn't fill
/// the multiselect part at all"): a two-question prompt whose Q1 options carried
/// previews. Reproduced and fixed against the real TUI (claude 2.1.220) with
/// `scripts/rig/probe-askq-layout.js`, verdict read from the transcript's
/// `tool_result`:
///
///   shape         keys                outcome
///   preview-mq    `2,1,3,→,\r`        Q1 BLANK, nothing submitted; the trailing
///                                     Enter toggled whichever Q2 row the cursor
///                                     happened to sit on
///   preview-mq    `2,\r,1,3,→,\r`     "Pick a color"="Green",
///                                     "Pick fruits"="Apple, Cherry"
///   plain-mq      `2,1,3,→,\r`        "Pick a color"="Green",
///                                     "Pick fruits"="Apple, Cherry"
///
/// The last row is the regression guard: the compact layout still answers
/// correctly WITHOUT the extra Enter, so this must stay a branch and never
/// become an unconditional trailing Enter.
///
/// Verified against Claude's TUI:
/// - single-select: the digit lands on the exact row. Whether it ALSO submits
///   depends on the layout Claude picked — see "the digit does not always
///   submit" below — so a single question follows its digit with an Enter.
/// - multi-select (single question): each digit toggles its row; Enter does NOT
///   submit (it toggles the highlighted row), so we send Right-arrow to jump to
///   the "Submit" review then digit "1" ("Submit answers") to finalize (#39).
/// - multi-question: after every tab is answered a Submit review appears whose
///   default is "Submit answers", so a trailing `Enter` finalizes it.
/// - free-text ("Other"), COMPACT SINGLE-SELECT: the compact selector
///   renders an implied "Type something." row just after the real options (row
///   `options.length + 1`). Answering with free text is THREE separate, delayed
///   stdin writes: the row digit (consumed as the selector, NOT part of the
///   answer), the text, then Enter to submit — each in its own PTY read (a
///   text+CR burst reads as a paste, not a submit). See [otherText]. The text
///   frame is sent as a bracketed paste since #383, so a bunched delivery cannot
///   lose it.
/// - free-text ("Other"), COMPACT MULTI-SELECT (#423): the same row is a
///   checkbox and its digit only toggles it, so it is reached by CURSOR, not by
///   digit. See the multi-select branch below for the measured sequence.
///
/// [otherText] is an optional per-question free-text answer (parallel to
/// [selections]); a non-empty, non-whitespace entry routes a COMPACT question
/// through the "Other" path above instead of its numeric selection (a
/// multi-select one keeps its ticks as well). One exclusion, measured rather
/// than assumed:
///
/// - SIDE-BY-SIDE (`hasPreview`) — THE ROW DOES NOT EXIST THERE. Measured on
///   claude 2.1.237 with `probe-askq-layout.js --shape preview-single --keys
///   "4,indigo actually,CR"`: the previewed selector lists only the real options
///   ("1. Red / 2. Green / 3. Blue") and then a separator and "Chat about this"
///   — no "Type something." row at all. The screens after the digit and after
///   the text were BYTE-IDENTICAL to the first render, and the trailing CR
///   committed the still-default top row. The transcript recorded
///   `"Pick a color"="Red"`: the free text is discarded AND an option the user
///   never picked is submitted. That is the exact mirror of the note bug this
///   issue is about — `n` exists only side-by-side, "Type something." only
///   compact — and it is worse, because the answer is confidently wrong rather
///   than merely incomplete.
///
/// (MULTI-SELECT was a second exclusion until #423 re-measured it on claude
/// 2.1.319: the row's digit still only toggles its checkbox, and submitting with
/// only that ticked still records "The user did not answer the questions." — but
/// the CURSOR reaches a real inline text field. See the multi-select branch.)
///
/// MULTI-QUESTION is included since #143 measured it working — but only in the
/// compact layout, which is the only shape that was driven. The overlay hides
/// the Other row wherever the branches below will not consume it.
///
/// [noteText] (issue #64 Gap 1) is an optional per-question NOTE attached to
/// an ALREADY-chosen option — distinct from [otherText]/#36, which REPLACES
/// the numeric answer with free text. The two are never combined, and since
/// #143 the LAYOUT decides which of them can apply rather than the branch
/// order: Other exists only on a compact card, a note only on a previewed one,
/// so a card offers one affordance or the other and never both. If both are set
/// anyway (this is a public pure function), the eligible one wins.
///
/// NOTES ARE A SIDE-BY-SIDE-LAYOUT FEATURE ONLY (#143, measured against claude
/// 2.1.234). The previewed selector's footer reads
/// "Enter to select · up/down to navigate · n to add notes · Esc to cancel" and
/// honours the key; the COMPACT selector advertises no such key and ignores it
/// outright. So [noteText] is consumed only for a single, single-select question
/// whose [PendingQuestionItem.hasPreview] is true, and the overlay hides the
/// "+ Add a note" affordance everywhere else. Same lesson as the digit
/// semantics above: THE LAYOUT DECIDES WHAT THE KEY MEANS.
///
/// The sequence shipped before #143 was a GUESS, and it was wrong in BOTH
/// layouts — on a compact card it degenerated to a correct plain selection with
/// the note silently discarded, and on a previewed one it delivered the note but
/// lost the answer. The measured replacement is in the note branch below.
///
/// Pure, so the mapping is unit-testable.
List<AnswerFrame> buildAnswerFrames(
  List<PendingQuestionItem> questions,
  List<Set<int>> selections, {
  List<String?> otherText = const [],
  List<String?> noteText = const [],
}) =>
    _answerFrames(questions, selections,
        otherText: otherText, noteText: noteText);

/// Whether a question holds an answer: a pick, or free text with a word in it.
/// THE one definition, read by the card's Send gate and tab ticks and by
/// [buildChatFrames], which refuses to replay a tab that has none (#423).
bool isQuestionAnswered(Set<int> selection, String? otherText) =>
    selection.isNotEmpty || (otherText?.trim().isNotEmpty ?? false);

/// The frames that choose Claude's "Chat about this" row on tab [tab] (#423), or
/// null when they cannot be built honestly.
///
/// Chat REJECTS the question (its `tool_result` is an error); Claude replies
/// asking what to clarify and goes idle, and the picks made so far ride along
/// ("Pick a color" Answer: Green). Measured on claude 2.1.319, verdicts from the
/// transcript. The row is reached differently per LAYOUT, and the layout is per
/// question ([PendingQuestionItem.hasPreview], the only decider):
///
///   compact (single or multi-select, any tab)  the digit `options.length + 2`,
///                                              at once, no Enter
///   side-by-side (preview)                     NO digit exists: Down x
///                                              `options.length`, then Enter
///
/// The digit and the Down count are relative to the tab the TUI is ON, which is
/// always tab 0 at the start, so the picks of tabs 0..[tab]-1 are replayed first
/// (the per-question loop of [buildAnswerFrames], without the Submit-review
/// Enter), then the current tab's ticks if it is multi-select, which the TUI
/// keeps. A current single-select pick is not replayed: its digit would submit.
///
/// Null when an earlier tab has no answer. Replaying it would pick that tab's
/// default top row and send Claude an answer nobody gave, and the way past an
/// unanswered tab (Right-arrow on a single-select) was not measured. The card
/// says so instead of guessing.
List<AnswerFrame>? buildChatFrames(
  List<PendingQuestionItem> questions,
  List<Set<int>> selections,
  int tab, {
  List<String?> otherText = const [],
}) {
  if (tab < 0 || tab >= questions.length) return null;
  for (var i = 0; i < tab; i++) {
    final sel = i < selections.length ? selections[i] : const <int>{};
    final other = i < otherText.length ? otherText[i] : null;
    if (!isQuestionAnswered(sel, other)) return null;
  }
  const gap = 600;
  const settle = 250;
  final frames = _answerFrames(questions, selections,
      otherText: otherText, replayTabs: tab);
  final q = questions[tab];
  final n = q.options.length;
  if (q.multiSelect) {
    final sel = tab < selections.length ? selections[tab] : const <int>{};
    for (final i in sel.toList()..sort()) {
      frames.add(AnswerFrame('${i + 1}', settle)); // keep the ticks made here
    }
  }
  if (q.hasPreview) {
    for (var i = 0; i < n; i++) {
      frames.add(const AnswerFrame('\x1b[B', settle)); // down to "Chat about this"
    }
    frames.add(const AnswerFrame('\r', gap, chat: true));
  } else {
    frames.add(AnswerFrame('${n + 2}', gap, chat: true));
  }
  return frames;
}

/// [buildAnswerFrames]' body. [replayTabs] stops after that many tabs and adds no
/// Submit-review Enter: the replay [buildChatFrames] needs to put the TUI on tab
/// [replayTabs]. Null answers the whole prompt.
List<AnswerFrame> _answerFrames(
  List<PendingQuestionItem> questions,
  List<Set<int>> selections, {
  List<String?> otherText = const [],
  List<String?> noteText = const [],
  int? replayTabs,
}) {
  const gap = 600; // between frames that must be read separately
  const settle = 250; // between absolute toggles (safe to coalesce)
  final frames = <AnswerFrame>[];
  final multiQuestion = questions.length > 1;
  for (var qi = 0; qi < (replayTabs ?? questions.length); qi++) {
    final q = questions[qi];
    final sel = qi < selections.length ? selections[qi] : const <int>{};
    final other = qi < otherText.length ? otherText[qi]?.trim() : null;
    final note = qi < noteText.length ? noteText[qi]?.trim() : null;
    if (!q.multiSelect && !q.hasPreview && other != null && other.isNotEmpty) {
      // Free-text ("Other"): select the implied "Type something." row, type the
      // answer, submit. The three land in SEPARATE stdin reads (each carries
      // [gap]) so Claude treats the text as an answer, not a paste.
      //
      // MULTI-QUESTION IS INCLUDED (#143). It was deferred on "unverified TUI
      // tab-advance semantics"; measured on claude 2.1.234, the digit lands on
      // the row and opens a free-text editor (the footer gains "ctrl+g to edit
      // in Notepad"), and the CR below commits it AND advances the tab exactly
      // as a single-select digit does — the loop tail then contributes the one
      // Submit-review Enter. Driving 4,<text>,CR,1,RIGHT,CR against a
      // single-select + multi-select pair recorded BOTH answers intact.
      //
      // !hasPreview IS PART OF THE GATE, and it is not a precaution — it is
      // measured (claude 2.1.237, see the function doc). The side-by-side
      // selector has NO "Type something." row, so this digit moves nothing, the
      // text is swallowed and the CR commits whatever row happens to be
      // highlighted: the probe recorded "Red" for a question whose free-text
      // answer was "indigo actually". THE LAYOUT DECIDES WHETHER THE ROW EXISTS
      // AT ALL — exactly as it does for `n` in the note branch below.
      //
      // SINGLE-SELECT only: in multi-select the row's digit just toggles its
      // checkbox, so a multi-select question takes the cursor path in its own
      // branch below (#423).
      //
      // THE TEXT GOES OUT AS A BRACKETED PASTE (#383). The gaps above are made on
      // this client and are not kept end to end: a reconnect flush, the server's
      // pre-attach queue or a stalled link can deliver the frames in ONE read, and
      // then Claude's paste-burst detector absorbs a long text's CR (the question
      // stays pending) or drops the digit (the default row is recorded). Measured
      // on claude 2.1.308: bunched, a 149-byte text+CR recorded NOTHING; as a
      // bracketed paste it was recorded whole, bunched with its digit or its CR,
      // newlines and 1.2 KB included. See [_bracketOtherText] for the ESC rule.
      frames.add(AnswerFrame('${q.options.length + 1}', gap)); // "Type something."
      frames.add(AnswerFrame(_bracketOtherText(other), gap,
          text: true, other: true)); // the free-text answer
      frames.add(const AnswerFrame('\r', gap)); // submit
    } else if (!multiQuestion &&
        !q.multiSelect &&
        q.hasPreview &&
        sel.isNotEmpty &&
        note != null &&
        note.isNotEmpty) {
      // Note (#64 Gap 1) attached to the option at sel.first. Every step below
      // is MEASURED against claude 2.1.234 (#143). What this replaced was a
      // guess, and it silently discarded the note.
      //
      //   * hasPreview gates the branch because `n` is honoured ONLY in the
      //     side-by-side layout. A compact selector ignores it, so the old
      //     sequence degenerated to "down x idx, CR" — a CORRECT plain
      //     selection with the note dropped in silence, which is exactly why
      //     nothing ever looked wrong.
      //   * The default highlight IS the top row, so down x idx lands on
      //     sel.first.
      //   * ESC closes the NOTE EDITOR without cancelling the question, despite
      //     the footer reading "Esc to cancel". It is a lone 0x1b, which the
      //     worker's isEscapeKey would read as an interrupt — but that rule is
      //     gated on a `working` session and one owing an answer is `waiting`,
      //     so it is not armed here (see #55's interrupt contract).
      //   * The trailing CR then commits the highlighted option WITH the note.
      //
      // Verdicts read from the transcript, never the screen:
      //   down,n,<note>,CR      -> "=(no option selected) notes: ..." answer LOST
      //   down,CR,n,<note>,CR   -> "=Green"                           note LOST
      //   down,n,<note>,ESC,CR  -> "=Green ... notes: ..."            both OK
      final idx = sel.first;
      for (var i = 0; i < idx; i++) {
        frames.add(const AnswerFrame('\x1b[B', settle)); // down to the chosen row
      }
      frames.add(const AnswerFrame('n', gap)); // open the note editor
      frames.add(AnswerFrame(note, gap, text: true)); // the note text
      frames.add(const AnswerFrame('\x1b', gap)); // ESC — closes the EDITOR only
      frames.add(const AnswerFrame('\r', gap)); // commit the highlighted option
    } else if (q.multiSelect) {
      final rows = sel.toList()..sort();
      for (final i in rows) {
        frames.add(AnswerFrame('${i + 1}', settle)); // toggle row i
      }
      if (!q.hasPreview && other != null && other.isNotEmpty) {
        // Free text on a multi-select question (#423). Measured on claude 2.1.319,
        // verdicts from the transcript: the digit `options.length + 1` is NOT the
        // way in. It only toggles the row's checkbox and leaves the cursor on row
        // 1, so the text is swallowed, and ticking only that row records "The user
        // did not answer the questions." (as it did on 2.1.237). The CURSOR is the
        // way: Down x `options.length` lands on the row and it becomes an inline
        // field (the footer gains "ctrl+g to edit in Notepad"). Then:
        //   * typing ticks the row by itself, so no digit;
        //   * NO Enter after the text: Enter on the row UN-ticks it, and
        //     Right-arrow inside the field only moves the caret;
        //   * Down leaves the field for the unnumbered Next/Submit row;
        //   * Enter there goes to the next tab, or to Review on the last or only
        //     tab. A lone question then needs the Review "Submit answers" digit;
        //     with several, the loop's tail Enter is that submit.
        // Verified: 1,3 | Down x4 | ESC[200~hello thereESC[201~ | Down | CR | 1
        // recorded "Apple, Cherry, hello there" at gaps of 250 and 700 ms; two
        // multi-select tabs with text on both recorded both. A newline in the
        // paste is recorded as a space. The text goes out as a bracketed paste
        // (#383); bunching THESE frames is safe, bunching the tick digits above
        // is not (existing fragility, unchanged).
        for (var i = 0; i < q.options.length; i++) {
          frames.add(const AnswerFrame('\x1b[B', gap)); // cursor onto "Type something"
        }
        frames.add(AnswerFrame(_bracketOtherText(other), gap,
            text: true, other: true)); // the free text
        frames.add(const AnswerFrame('\x1b[B', gap)); // leave the field
        frames.add(const AnswerFrame('\r', gap)); // next tab, or Review
        if (!multiQuestion) {
          frames.add(const AnswerFrame('1', gap)); // Review: "Submit answers"
        }
      } else if (multiQuestion) {
        // A multi-select question inside a multi-question prompt. Advance to the
        // NEXT question tab with Right-arrow — NOT Enter. This branch used to
        // send Enter, and the else-branch below already knew why that is wrong:
        // in the multi-select selector Enter TOGGLES the highlighted row and
        // stays put, it does not move between tabs. So the trailing Enter
        // un-toggled the row the cursor sat on and never advanced; the next
        // question's digits then landed back on THIS question, and the later
        // tabs recorded nothing. Verified on the real Opus-5 TUI (claude
        // 2.1.220): after toggling, Right-arrow moves one tab right (to the next
        // question, or to the Submit review after the last one), and the single
        // Submit-review Enter added after the loop finalizes. Same key the
        // single multi-select case uses, for the same reason.
        frames.add(const AnswerFrame('\x1b[C', gap)); // → next question tab
      } else {
        // #39 — single multi-select question. Enter here does NOT submit: it
        // TOGGLES the highlighted row and stays in the selector, so the answer
        // never took. Verified on-device (2026-07-08): after toggling the
        // rows, Right-arrow jumps to the "Submit" review screen (header shows
        // "Submit →"), and digit "1" ("Submit answers", the default) finalizes.
        frames.add(const AnswerFrame('\x1b[C', gap)); // → jump to Submit review
        frames.add(const AnswerFrame('1', gap)); // "Submit answers"
      }
    } else {
      final idx = sel.isEmpty ? 0 : sel.first;
      frames.add(AnswerFrame('${idx + 1}', gap)); // land on the exact row
      if (!multiQuestion || q.hasPreview) {
        // Commit it. In the side-by-side (preview) layout the digit above only
        // MOVED the highlight, so without this the row is never chosen — the app
        // looked like it had answered while Claude sat waiting, and the question
        // had to be finished by hand in the terminal. That holds whether the
        // prompt has one question or several: in a multi-question prompt this
        // Enter both commits the row and advances to the next tab, the job the
        // digit does on its own in the compact layout.
        //
        // The exclusion is narrow and deliberate: a COMPACT tab of a
        // multi-question prompt must NOT get this Enter, because there the digit
        // already advanced and the Enter would commit the next tab's default row
        // — answering a question the user never saw. Single question, compact:
        // the digit already submitted and this Enter is a measured no-op on an
        // empty prompt line. See the layout table in the doc above.
        frames.add(const AnswerFrame('\r', gap));
      }
    }
  }
  if (multiQuestion && replayTabs == null) {
    frames.add(const AnswerFrame('\r', gap)); // Submit-review screen
  }
  return frames;
}

/// Wraps an Other answer in a bracketed paste (#383), so it survives frames that
/// reach Claude bunched in one read. A text carrying ESC is returned bare, never
/// stripped or sanitised: it may hold its own paste markers, and deleting an inner
/// `ESC[200~` reconstitutes a close — the same refusal the worker's
/// `bracketLongBody` makes. Refusing costs nothing; that text has the unbracketed
/// shape that was already working when the gaps survive.
String _bracketOtherText(String text) =>
    text.contains('\x1b') ? text : '\x1b[200~$text\x1b[201~';

/// The words inside a frame built by [_bracketOtherText]: the inverse, so the words
/// a frame carried are read back from the FRAME rather than from whatever the card
/// holds now. A bare text (one that carried ESC) is returned as it is.
String _unbracketOtherText(String keys) {
  const open = '\x1b[200~';
  const close = '\x1b[201~';
  return keys.length >= open.length + close.length &&
          keys.startsWith(open) &&
          keys.endsWith(close)
      ? keys.substring(open.length, keys.length - close.length)
      : keys;
}

/// Whether the caller should WAIT to see the question clear after [frames] go out
/// ([verifyAnswerLanded] and its resurfacing), or send them and let go (#423).
///
/// False for "Chat about this", and this one owner is read by the session screen
/// and by the sessions board and inbox alike. Chat REJECTS the question: Claude fires
/// no hook for it, and the server clears the question only once it sees the rejected
/// tool_result in the transcript (about a second; before that server fix, not until
/// Claude's Stop after the whole reply). A rejection has no landing to confirm and
/// nothing the user could retry, and a verify's resent Enter, or a "did not take"
/// that puts the card back, would type into the reply Claude is already writing.
bool answerIsVerifiable(List<AnswerFrame> frames) =>
    !frames.any((f) => f.chat);

/// True when [frames] end in a confirming Enter — multi-question (Enter
/// finalizes the Submit-review screen) and, since the preview-layout fix,
/// single-select-single too (its digit no longer submits on its own in every
/// layout, so it now ends in an explicit committing Enter). Single multi-select
/// ends in digit "1" ("Submit answers") after a Right-arrow (#39), which
/// auto-submits, so it needs no re-sent Enter — and a stray one there would
/// toggle a row. The caller uses this to decide whether to verify the Enter
/// actually landed (it can be coalesced away by cluster-path bunching) and
/// re-send it: derived from the frames, so it stays true by construction rather
/// than by a second rule kept in sync.
///
/// An Other text followed by more of the same answer never gets the re-sent Enter
/// (#383). Measured on claude 2.1.308: when the bracketed text, its CR and the NEXT
/// tab's digit and CR reach Claude in ONE read, the CR becomes a newline inside the
/// Other editor and the digit is typed after it, so the question stays pending. A
/// blind Enter would then commit "text, newline, 2" as the answer.
///
/// That is the only shape measured to go wrong, so it is the only one refused: an
/// Other text whose own CR is followed by more than the final Submit-review CR, i.e.
/// Other on a NON-last tab of a multi-question answer. A single-question Other, a
/// note (its ESC already closed the editor) and an Other on the last tab keep the
/// resend, which is their only automatic recovery. A multi-select Other (#423)
/// reads the same way, its own CR being the one after the Down that leaves the
/// field; that shape was not measured either way, so it follows the same rule
/// (on the LAST tab that makes its resend a deliberate, unmeasured loosening:
/// docs/findings/questions.md).
///
/// A "Chat about this" answer is not verified at all ([answerIsVerifiable]), so it
/// is never asked for a resend either.
bool answerNeedsConfirm(List<AnswerFrame> frames) {
  if (frames.isEmpty || frames.last.keys != '\r') return false;
  if (!answerIsVerifiable(frames)) return false;
  for (var i = 0; i < frames.length; i++) {
    if (!frames[i].other) continue;
    // The Other text's own committing CR is the first one after it; anything
    // after that besides the last frame (the Submit-review CR) belongs to a
    // later tab.
    final own = frames.indexWhere((f) => f.keys == '\r', i + 1);
    if (own >= 0 && frames.length > own + 2) return false;
  }
  return true;
}

/// Writes [frames] through [send], each followed by its own settle delay (none after
/// the last). THE one pacing loop for an answer: the session screen's overlay and the
/// sessions board (#337) both deliver through it, so a frame set built by
/// [buildAnswerFrames] lands in the same separate stdin reads whichever surface sent it.
///
/// Stops as soon as [alive] says the sender is gone, and returns false only then.
/// [send] is fire-and-forget: a sender with no connection drops the keys silently
/// and this still returns true, so the not-landed flag ([QuestionDrafts.markSent])
/// stays up for an answer that was never typed. That is the safe direction: the
/// notice costs one tap, a lost one types into a closed selector.
Future<bool> deliverAnswerFrames(
  List<AnswerFrame> frames,
  void Function(String keys) send, {
  bool Function()? alive,
}) async {
  for (var i = 0; i < frames.length; i++) {
    if (alive != null && !alive()) return false;
    send(frames[i].keys);
    if (i < frames.length - 1) {
      await Future<void>.delayed(Duration(milliseconds: frames[i].delayMs));
    }
  }
  return true;
}

/// Waits for an answered question to clear, re-sending a dropped confirming Enter
/// ONCE when [resendEnter] (see [answerNeedsConfirm]). Polls [poll] up to [attempts]
/// times, [every] apart.
///
/// Returns the question STILL pending after every attempt: the answer never took, and
/// the caller should put it back in front of the user. Returns null when it cleared or
/// was replaced by a different one ([isSame] false), and also when polling failed or
/// [alive] went false, because neither is evidence the answer was lost, and a retry on
/// no evidence types into whatever sits on the prompt line.
///
/// Why the Enter is re-sent at most once: if the selector has in fact closed, every
/// extra `\r` submits whatever sits on Claude's prompt line.
Future<PendingQuestion?> awaitAnswerLanded({
  required bool Function(PendingQuestion q) isSame,
  required bool resendEnter,
  required Future<PendingQuestion?> Function() poll,
  required void Function() resend,
  bool Function()? alive,
  int attempts = 8,
  Duration every = const Duration(milliseconds: 900),
}) async {
  PendingQuestion? stillPending;
  var resent = false;
  for (var attempt = 0; attempt < attempts; attempt++) {
    await Future<void>.delayed(every);
    if (alive != null && !alive()) return null;
    final PendingQuestion? q;
    try {
      q = await poll();
    } catch (_) {
      return null; // best-effort — don't spam Enters when polling is failing
    }
    if (alive != null && !alive()) return null;
    // Cleared, or a genuinely different prompt took its place → answer landed.
    if (q == null || !isSame(q)) return null;
    stillPending = q;
    if (resendEnter && !resent) {
      resent = true;
      resend(); // dropped confirm → resend exactly once
    }
  }
  return stillPending;
}

/// Renders the INLINE markdown an option description actually carries, as
/// [TextSpan]s (#108).
///
/// The lead-up panel got a full `MarkdownBody`; a description cannot have one,
/// and the reason is the space budget below. `MarkdownBody` is a block widget
/// with no `maxLines`, so it would silently drop the two-line clamp that
/// `kOptionRowMax = 96` was MEASURED against — one 493-character description
/// (the longest on record) would then be taller than the whole option list.
/// Spans keep `Text.rich(maxLines:, overflow: ellipsis)` working, and they are
/// also what #83 requires: never a widget in the text flow.
///
/// SCOPE IS MEASURED, not assumed. Across the 127 real `AskUserQuestion` calls
/// in this machine's transcripts (483 options, every one of them carrying a
/// description), 3.3% of descriptions contain markdown — and every occurrence
/// is an inline code span, `` `like this` ``. No headings, no lists, no links.
/// So this handles code spans and `**bold**` and deliberately stops there:
/// block syntax has never appeared, and single-asterisk italics is ambiguous
/// with the glob patterns these descriptions genuinely do contain (`*.dart`).
/// Unmatched syntax is left as literal text rather than guessed at.
List<InlineSpan> inlineMarkdownSpans(
  String text, {
  required TextStyle? base,
  required TextStyle? code,
}) {
  final spans = <InlineSpan>[];
  var last = 0;
  for (final m in _inlineMd.allMatches(text)) {
    if (m.start > last) {
      spans.add(TextSpan(text: text.substring(last, m.start), style: base));
    }
    final codeBody = m.group(1);
    spans.add(codeBody != null
        ? TextSpan(text: codeBody, style: code)
        : TextSpan(
            text: m.group(2),
            style: (base ?? const TextStyle()).copyWith(
              fontWeight: FontWeight.w700,
            ),
          ));
    last = m.end;
  }
  if (last < text.length) {
    spans.add(TextSpan(text: text.substring(last), style: base));
  }
  // A description with no markup is still exactly one span, so the caller never
  // has to special-case the common (96.7%) path.
  if (spans.isEmpty) spans.add(TextSpan(text: text, style: base));
  return spans;
}

final RegExp _inlineMd = RegExp(r'`([^`]+)`|\*\*([^*]+)\*\*');

// --- The space budget (#108) -------------------------------------------------
//
// THE OPTIONS ARE RESERVED FIRST. That inversion is the whole point.
//
// Before this, `_optionList` was the Flexible RESIDUAL: header, lead-up, tabs
// and question each took their natural or capped size, the footer took its own,
// and the options got whatever survived. So every other panel's appetite was
// charged to the one region you have to interact with, and `kAnswerFloor` —
// which only ever limited what the LEAD-UP could claim — could not stop it.
//
// Now the fixed chrome and an option floor are subtracted up front, and only
// then do the question and the lead-up divide what is left. `_optionList` stays
// Flexible, so a SHORT question still hands its surplus to the options (#94's
// "a SHORT question reserves only what it needs"); the caps below simply can no
// longer starve them.
//
// Every value MEASURED with a getRect probe at 412dp against the real card,
// never derived from padding arithmetic — and the row height moved twice while
// this was being written, which is the argument for measuring at all. An
// UNCLAMPED row with a verbose description measured 126; once descriptions clamp
// to two lines (see _optionTile) the same row measures 78. 96 is the measured 78
// plus headroom for a label that itself wraps.
const double kHeaderH = 68; // title + icon buttons
const double kFooterH = 66; // the two action buttons (nav strip is behind a toggle)
const double kTabStripH = 38; // multi-question chip strip
const double kKeysRowH = 36; // the raw-key row, two rows of keys at a phone width (#108)
const double kCtxChrome = 50; // lead-up panel margin + padding + label row
const double kOptionRowMax = 96; // label + a two-line description at 412dp
const double kOptionPeek = 16; // a deliberate half-row: "there is more below"

/// Lines of an option's `preview` block shown once that option is selected
/// (#145). The server caps a preview at 2000 characters, which is roughly 30
/// lines — taller than a phone card — so it is clamped here too, VISIBLY: the
/// ellipsis says "there is more of this in the terminal" where a silent cut
/// would let the reader believe they had seen the whole snippet.
const int kPreviewMaxLines = 14;

/// Two whole option rows plus a peek of the third. The peek matters as much as
/// the rows: it makes the cut land somewhere chosen, so a clipped list reads as
/// "scroll me" instead of as the end (the report was a row sliced mid-word).
const double kOptionFloor = 2 * kOptionRowMax + kOptionPeek; // 268

/// The least the lead-up body may take and still be worth its own 50px frame.
/// Below this the panel renders as its header row alone — collapsed, but always
/// tappable, because it is the only route back to the context.
const double kCtxMinUseful = 96;

// --- The wide layout (#108) --------------------------------------------------
//
// Everything above is a rationing scheme, and rationing is the right answer only
// where the room is actually scarce. On a desktop window the card was still
// 640x1000 with the lead-up and the options taking turns at the same height —
// competing for space that was sitting empty on either side of the dialog.
//
// So past a threshold the lead-up gets its OWN COLUMN and the competition simply
// ends: the options keep the full height of the card, and the context is read
// beside them instead of instead of them.
//
// Chosen off the AVAILABLE BOX, never off the platform. #55's warning is that
// *keyboard* behaviour must be platform-chosen because an Android IME commits
// Enter as text — it is not a licence to ask "is this Windows" about layout. A
// narrow desktop window genuinely IS the phone case and gets the phone budget;
// a tablet in landscape genuinely is not. The soft-keyboard question stays a
// platform question (see `composeUsesSoftKeyboard`), and the two are kept apart
// on purpose.
const double kWideMinWidth = 900;  // room for two columns that are both readable
const double kWideMinHeight = 560; // a wide-but-short window is still cramped
const double kWideCardMax = 1040;  // the card's width once it goes two-column
const double kWideCtxColumn = 392; // the lead-up's own column

/// The question never drops below two lines, and never grows past this.
const double kQuestionMin = 52;
const double kQuestionMax = 260;

/// The free-text drafts ("Other" answers and notes) typed into a question overlay,
/// kept by whoever OUTLIVES the overlay (#383).
///
/// An answer that did not land makes the overlay resurface as a NEW widget with
/// empty controllers, so a long dictated answer was gone and had to be retyped.
/// This holds one question's drafts, keyed by its content signature
/// (`questionSignature`): a different question starts empty, and the owner calls
/// [clear] once the question is answered.
///
/// Only WORDS are kept. Picks are never restored (one Enter on a stale pick would
/// type its digit into a selector that has already closed), and a note is shown
/// as text, never put back into the note field.
class QuestionDrafts {
  String? key;
  List<String?> other = const [];
  List<String?> note = const [];

  /// An answer carrying words was SENT for the question signed [key] and has not been
  /// seen to land. The terminal may already hold part of it (an editor with the text
  /// typed in, a highlight moved a row), so the overlay stops offering a blind Send
  /// for THAT question: a replay types `4` and the text into an editor that already
  /// holds them.
  ///
  /// Verified, never predicted: [markSent] sets it BEFORE the keys go out, so a card
  /// mounted at any point afterwards (the "A question is waiting" chip during the
  /// verify, a verify whose polls all failed) is already covered. Only [clear] drops
  /// it, and `clear()` runs only on a positive gone-or-different observation. Tied
  /// to the question's signature, not to a `toolUseId`: a hook-id -> transcript-id
  /// re-report of the SAME question is exactly when the selector may have closed,
  /// and a false notice costs one tap where a lost one types into a closed selector.
  bool notLanded = false;

  /// The words of the LAST answer sent for [key], as that answer carried them (read
  /// off its frames). It is what the notice's copy block shows, because it is what
  /// the terminal may hold, so it is NOT the live draft ([other], [note]). Every
  /// send, the deliberate "Send again anyway" included, replaces it with what was
  /// just sent.
  List<String> sentWords = const [];

  /// Whether the question signed [questionKey] is the one flagged by [markSent].
  bool flaggedFor(String questionKey) => notLanded && key == questionKey;

  /// The words the notice shows: [sentWords], untouched by whatever the card is
  /// edited or tapped into after the send.
  List<String> get words => sentWords;

  /// Called just before [frames], the answer to the question signed [answeredKey],
  /// is delivered. Flags it only if the answer carries words and these are the
  /// drafts held for that question: an answer of plain digits replays harmlessly.
  /// Each call re-takes the snapshot, so a second send shows the words it sent.
  void markSent(String answeredKey, List<AnswerFrame> frames) {
    if (key != answeredKey || !frames.any((f) => f.text)) return;
    notLanded = true;
    sentWords = [
      for (final f in frames)
        if (f.text && _unbracketOtherText(f.keys).trim().isNotEmpty)
          _unbracketOtherText(f.keys).trim(),
    ];
  }

  void clear() {
    key = null;
    other = const [];
    note = const [];
    notLanded = false;
    sentWords = const [];
  }
}


/// The answer card ([QuestionAnswerPanel]) mounted over a session's terminal: a
/// scrim, the safe area, and the card at the bottom, taking focus so hardware
/// Enter/Tab/arrows reach it (#64). [onKey] forwards the raw keys to the PTY
/// beneath (#50).
class QuestionOverlay extends StatelessWidget {
  const QuestionOverlay({
    super.key,
    required this.question,
    required this.onSend,
    required this.onDismiss,
    required this.onKey,
    this.contextText,
    this.contextLabel = 'Claude said',
    this.drafts,
    this.draftKey = '',
  });

  final PendingQuestion question;
  final QuestionDrafts? drafts;
  final String draftKey;
  final String? contextText;

  /// The heading over [contextText] ([QuestionAnswerPanel.contextLabel]).
  final String contextLabel;
  final void Function(List<AnswerFrame> frames) onSend;

  /// Hide the overlay without answering (raw key strip / terminal still works).
  final VoidCallback onDismiss;

  /// Forward a single raw key to the PTY — the manual nav fallback buttons.
  final void Function(String sequence) onKey;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: Material(
        color: Colors.black.withValues(alpha: 0.55),
        child: SafeArea(
          child: Align(
            alignment: Alignment.bottomCenter,
            child: QuestionAnswerPanel(
              question: question,
              onSend: onSend,
              onDismiss: onDismiss,
              onKey: onKey,
              contextText: contextText,
              contextLabel: contextLabel,
              drafts: drafts,
              draftKey: draftKey,
              autofocus: true,
            ),
          ),
        ),
      ),
    );
  }
}
