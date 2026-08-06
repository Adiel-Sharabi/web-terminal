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

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import 'compose_bar.dart' show composeUsesSoftKeyboard;

/// Forwards a raw key sequence to the PTY (#50). Carried by the overlay's
/// hardware Tab/arrow shortcuts so, while the question overlay is up, those keys
/// drive Claude's TUI in the terminal beneath instead of traversing the
/// overlay's on-screen buttons. A focused free-text ("Other") field still keeps
/// caret arrows — a focused descendant consumes them before this ancestor does.
class _ForwardKeyIntent extends Intent {
  const _ForwardKeyIntent(this.seq);
  final String seq;
}

/// Submits the current selection via hardware Enter (issue #64 Gap 2). Desktop
/// only — see [composeUsesSoftKeyboard]: on a soft keyboard, Enter is a text
/// commit, not a key event, so binding it here would never fire on mobile
/// anyway, but the platform gate makes the intent explicit and matches the
/// compose bar's own contract (#55).
class _SubmitIntent extends Intent {
  const _SubmitIntent();
}

/// One outbound frame: send [keys], then wait [delayMs] before the next frame.
class AnswerFrame {
  const AnswerFrame(this.keys, this.delayMs);

  /// The bytes to write to the PTY.
  final String keys;

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
/// - free-text ("Other"), SINGLE-SELECT single question only: Claude's selector
///   renders an implied "Type something." row just after the real options (row
///   `options.length + 1`). Answering with free text is THREE separate, delayed
///   stdin writes: the row digit (consumed as the selector, NOT part of the
///   answer), the text, then Enter to submit — each in its own PTY read (a
///   text+CR burst reads as a paste, not a submit). See [otherText].
///
/// [otherText] is an optional per-question free-text answer (parallel to
/// [selections]); a non-empty, non-whitespace entry routes a single-select
/// single question through the "Other" path above instead of its numeric
/// selection. It is consumed ONLY on that proven path. Multi-select and
/// multi-question are deferred and never consume [otherText]:
/// - multi-select: on-device, the "Type something." row is a checkbox that
///   toggles rather than opening a free-text input, so digit+text+Enter would
///   submit a checked-but-empty option and lose the text;
/// - multi-question: the tab-advance semantics of a free-text submit are
///   unverified on-device.
/// The overlay correspondingly hides the Other row unless there is exactly one,
/// non-multiSelect question.
///
/// [noteText] (issue #64 Gap 1) is an optional per-question NOTE attached to
/// an ALREADY-chosen option — distinct from [otherText]/#36, which REPLACES
/// the numeric answer with free text. Claude's TUI advertises "press n to add
/// notes"; a non-empty, non-whitespace entry, paired with a non-empty [sel],
/// routes a single-select single question through the note path below
/// instead of the plain auto-submitting digit. If [otherText] is ALSO set for
/// that question, Other wins (checked first) — the two are never combined.
/// Same deferred scope as Other: multi-select and multi-question never
/// consume [noteText].
///
/// *** The exact `n` byte sequence below is NOT YET DEVICE-VERIFIED ***
/// (unlike every other path here, which is). Claude decides when to raise
/// AskUserQuestion, so this could not be forced against the live TUI while
/// writing this: confirm on a real device before trusting it the way the
/// digit / Other / multi-select sequences are trusted. See the note branch
/// below for the reasoning behind the sequence chosen.
///
/// Pure, so the mapping is unit-testable.
List<AnswerFrame> buildAnswerFrames(
  List<PendingQuestionItem> questions,
  List<Set<int>> selections, {
  List<String?> otherText = const [],
  List<String?> noteText = const [],
}) {
  const gap = 600; // between frames that must be read separately
  const settle = 250; // between absolute toggles (safe to coalesce)
  final frames = <AnswerFrame>[];
  final multiQuestion = questions.length > 1;
  for (var qi = 0; qi < questions.length; qi++) {
    final q = questions[qi];
    final sel = qi < selections.length ? selections[qi] : const <int>{};
    final other = qi < otherText.length ? otherText[qi]?.trim() : null;
    final note = qi < noteText.length ? noteText[qi]?.trim() : null;
    if (!multiQuestion && !q.multiSelect && other != null && other.isNotEmpty) {
      // Free-text ("Other"): select the implied "Type something." row, type the
      // answer, submit. The three land in SEPARATE stdin reads (each carries
      // [gap]) so Claude treats the text as an answer, not a paste.
      // SINGLE-SELECT only: in multi-select the "Type something." row is a
      // checkbox that toggles (no free-text input), so this path is gated off
      // and the multi-select branch below ignores otherText entirely.
      frames.add(AnswerFrame('${q.options.length + 1}', gap)); // "Type something."
      frames.add(AnswerFrame(other, gap)); // the free-text answer
      frames.add(const AnswerFrame('\r', gap)); // submit
    } else if (!multiQuestion &&
        !q.multiSelect &&
        sel.isNotEmpty &&
        note != null &&
        note.isNotEmpty) {
      // Note (#64 Gap 1) attached to the option at sel.first. A single-select
      // digit submits outright in the compact layout (see the class doc above),
      // so it can't be used to land on the row first — Down-arrow presses
      // instead walk the highlight down from the TUI's assumed default top row,
      // the same relative-nav idiom #39 already uses (Right-arrow to the Submit
      // review) for "move without submitting". Each step is DEVICE-UNVERIFIED
      // (see the function doc); if verification finds a different default
      // highlight, keybinding, or that the note editor needs its own
      // confirm before the final submit, only this branch needs correcting —
      // buildAnswerFrames stays the one place the fix belongs.
      final idx = sel.first;
      for (var i = 0; i < idx; i++) {
        frames.add(const AnswerFrame('\x1b[B', settle)); // ↓ to the chosen row
      }
      frames.add(const AnswerFrame('n', gap)); // open the note editor
      frames.add(AnswerFrame(note, gap)); // the note text
      frames.add(const AnswerFrame('\r', gap)); // submit
    } else if (q.multiSelect) {
      final rows = sel.toList()..sort();
      for (final i in rows) {
        frames.add(AnswerFrame('${i + 1}', settle)); // toggle row i
      }
      if (multiQuestion) {
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
  if (multiQuestion) {
    frames.add(const AnswerFrame('\r', gap)); // Submit-review screen
  }
  return frames;
}

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
bool answerNeedsConfirm(List<AnswerFrame> frames) =>
    frames.isNotEmpty && frames.last.keys == '\r';

/// The text of the most recent non-empty assistant turn in [turns] — the
/// message that led up to the question, so it can be shown as context above the
/// overlay ("read the whole answer before the question"). Null when there's no
/// assistant prose yet. Pure, so it's unit-testable.
String? lastAssistantText(List<TranscriptTurn> turns) {
  for (var i = turns.length - 1; i >= 0; i--) {
    final t = turns[i];
    if (t.isAssistant && t.text.trim().isNotEmpty) return t.text.trim();
  }
  return null;
}

/// Vertical room the ANSWERING half of the card needs before the lead-up may
/// claim any (#94): header (~48) + footer (~122, nav strip and buttons) + three
/// option rows (~100 each, a label with a description). Measured off the real
/// card at a 412dp width; it is a floor, not a layout constant — nothing is
/// positioned from it, it only decides how much the lead-up may take.
const double kAnswerFloor = 470;

class QuestionOverlay extends StatefulWidget {
  const QuestionOverlay({
    super.key,
    required this.question,
    required this.onSend,
    required this.onDismiss,
    required this.onKey,
    this.contextText,
  });

  final PendingQuestion question;

  /// Claude's preceding message (the lead-up to the question), shown scrollable
  /// above the question so the full answer is readable before answering. Null
  /// when unavailable.
  final String? contextText;

  /// Send the built answer as timed frames (the caller honours each delay).
  final void Function(List<AnswerFrame> frames) onSend;

  /// Hide the overlay without answering (raw key strip / terminal still works).
  final VoidCallback onDismiss;

  /// Forward a single raw key to the PTY — the manual nav fallback buttons.
  final void Function(String sequence) onKey;

  @override
  State<QuestionOverlay> createState() => _QuestionOverlayState();
}

class _QuestionOverlayState extends State<QuestionOverlay> {
  int _tab = 0;
  late List<Set<int>> _selected;

  /// Per-question free-text ("Other") answer, parallel to [_selected]. `null`
  /// means Other is NOT the active choice for that tab (numeric-selection mode);
  /// a non-null value (even `''`) means Other is active, and its trimmed text is
  /// the answer. Only ever populated for single-question prompts.
  late List<String?> _otherText;

  /// Backs the single free-text field. One controller suffices because the
  /// Other row is only shown for single-question prompts (one tab).
  final TextEditingController _otherController = TextEditingController();

  /// Per-question NOTE attached to the tab's ALREADY-chosen option (#64
  /// Gap 1) — parallel to [_otherText] but NEVER conflated with it: Other
  /// (#36) REPLACES the numeric answer with free text, a note AUGMENTS it.
  /// `null` means the note field is not revealed for that tab; a non-null
  /// value (even `''`) means it is, and its trimmed text is the note. Only
  /// ever populated for single-select single-question prompts, same scope as
  /// Other.
  late List<String?> _noteText;

  /// Backs the single note field. One controller suffices — same reasoning
  /// as [_otherController].
  final TextEditingController _noteController = TextEditingController();

  /// Drives [_contextPanel]'s scroll view so a [Scrollbar] can show a thumb.
  /// Without one, a clipped lead-up reads as a COMPLETE message — the reported
  /// failure: the options were unjudgeable and nothing hinted at scrolling.
  final ScrollController _ctxScroll = ScrollController();

  /// Same job for the pinned question (#94). A question long enough to need
  /// its own scroll is rare, but a silently clipped one is the exact defect
  /// this issue is about, so it gets the same honest affordance.
  final ScrollController _qScroll = ScrollController();

  /// Whether the lead-up panel is expanded (#94). Starts open — the context is
  /// why the options mean anything, and hiding it by default would re-create
  /// "the context isn't clear". Collapsing is the user's lever to hand its
  /// whole share to the options on a small screen.
  bool _ctxExpanded = true;

  @override
  void initState() {
    super.initState();
    _selected = [for (final _ in widget.question.questions) <int>{}];
    _otherText = [for (final _ in widget.question.questions) null];
    _noteText = [for (final _ in widget.question.questions) null];
  }

  @override
  void didUpdateWidget(covariant QuestionOverlay old) {
    super.didUpdateWidget(old);
    // A different prompt arrived → reset selection, free text + active tab.
    if (old.question.toolUseId != widget.question.toolUseId) {
      _tab = 0;
      _selected = [for (final _ in widget.question.questions) <int>{}];
      _otherText = [for (final _ in widget.question.questions) null];
      _otherController.clear();
      _noteText = [for (final _ in widget.question.questions) null];
      _noteController.clear();
    }
  }

  @override
  void dispose() {
    _otherController.dispose();
    _noteController.dispose();
    _ctxScroll.dispose();
    _qScroll.dispose();
    super.dispose();
  }

  bool get _otherActive => _otherText[_tab] != null;

  bool get _noteActive => _noteText[_tab] != null;

  /// True while a multi-line free-text field (Other OR a note) is showing —
  /// SSOT for the "soft keyboard is up, give it vertical room" collapse
  /// below, which #36 originally guarded on Other alone; #64 Gap 1 adds a
  /// second field with the identical overflow problem.
  bool get _textEntryActive => _otherActive || _noteActive;

  void _toggle(PendingQuestionItem q, int i) {
    setState(() {
      // Choosing a listed option exits Other mode (mutually exclusive).
      _otherText[_tab] = null;
      final set = _selected[_tab];
      if (q.multiSelect) {
        set.contains(i) ? set.remove(i) : set.add(i);
      } else {
        set
          ..clear()
          ..add(i);
      }
    });
  }

  /// Activates the free-text ("Other") answer for the current tab: clears any
  /// numeric picks (Other is mutually exclusive) and reveals the text field.
  void _chooseOther() {
    setState(() {
      _selected[_tab].clear();
      _otherText[_tab] = _otherController.text;
    });
  }

  /// Toggles the note field for the current tab's ALREADY-selected option
  /// (#64 Gap 1). Unlike Other, a note does not touch [_selected] — it
  /// augments the numeric pick rather than replacing it, so it is never
  /// mutually exclusive with a real option (only offered once one is chosen;
  /// see the gate in [_optionList]).
  void _toggleNote() {
    setState(() {
      if (_noteActive) {
        _noteText[_tab] = null;
        _noteController.clear();
      } else {
        _noteText[_tab] = _noteController.text;
      }
    });
  }

  bool get _everyQuestionAnswered => List.generate(
        _selected.length,
        (i) =>
            _selected[i].isNotEmpty ||
            (_otherText[i]?.trim().isNotEmpty ?? false),
      ).every((answered) => answered);

  void _send() {
    widget.onSend(buildAnswerFrames(
      widget.question.questions,
      _selected,
      otherText: _otherText,
      noteText: _noteText,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final questions = widget.question.questions;
    final q = questions[_tab];

    return Positioned.fill(
      child: Material(
        color: Colors.black.withValues(alpha: 0.55),
        child: SafeArea(
          child: Align(
            alignment: Alignment.bottomCenter,
            // #50: hardware Tab/arrows drive Claude's TUI in the terminal beneath
            // (its `/status` tabs, menus, question phase) rather than traversing
            // the overlay's buttons. This Shortcuts sits below WidgetsApp, so it
            // wins over the default focus-traversal / caret shortcuts. Tab always
            // forwards; arrows forward ONLY while a free-text field (Other, or a
            // note — #64 Gap 1) is inactive — when one IS active the arrows are
            // left unmapped so the caret can move inside that field.
            //
            // #64 Gap 2: hardware Enter submits the current selection — DESKTOP
            // only, gated by the same `composeUsesSoftKeyboard` predicate the
            // compose bar uses (#55 SSOT), never reimplemented here. A soft
            // keyboard's Enter is a text COMMIT, not a key event, so this could
            // never fire on mobile anyway, but the explicit gate documents the
            // contract and keeps the two clients in lockstep if that ever
            // changes.
            child: Shortcuts(
              shortcuts: <ShortcutActivator, Intent>{
                const SingleActivator(LogicalKeyboardKey.tab):
                    const _ForwardKeyIntent('\t'),
                if (!_textEntryActive) ...const {
                  SingleActivator(LogicalKeyboardKey.arrowUp):
                      _ForwardKeyIntent('\x1b[A'),
                  SingleActivator(LogicalKeyboardKey.arrowDown):
                      _ForwardKeyIntent('\x1b[B'),
                  SingleActivator(LogicalKeyboardKey.arrowRight):
                      _ForwardKeyIntent('\x1b[C'),
                  SingleActivator(LogicalKeyboardKey.arrowLeft):
                      _ForwardKeyIntent('\x1b[D'),
                },
                if (!composeUsesSoftKeyboard(defaultTargetPlatform)) ...const {
                  SingleActivator(LogicalKeyboardKey.enter): _SubmitIntent(),
                  SingleActivator(LogicalKeyboardKey.numpadEnter):
                      _SubmitIntent(),
                },
              },
              child: Actions(
                actions: <Type, Action<Intent>>{
                  _ForwardKeyIntent: CallbackAction<_ForwardKeyIntent>(
                    onInvoke: (intent) {
                      widget.onKey(intent.seq);
                      return null;
                    },
                  ),
                  // Same completeness gate as the Send button (_footer below) —
                  // an incomplete selection is a no-op, never a partial submit.
                  _SubmitIntent: CallbackAction<_SubmitIntent>(
                    onInvoke: (intent) {
                      if (_everyQuestionAnswered) _send();
                      return null;
                    },
                  ),
                },
                // Deterministically owns focus the moment the overlay mounts
                // (#64 Gap 2), so hardware Enter/Tab/arrows reach THIS
                // Shortcuts instead of bubbling from whatever the sibling
                // ComposeBar's TextField last focused — previously Enter was
                // silently swallowed as a no-op submit of the (empty) compose
                // field underneath. Also makes #50's Tab/arrow forwarding
                // reliable without first requiring a tap inside the overlay.
                child: Focus(
                  autofocus: true,
                  child: LayoutBuilder(builder: (context, box) {
                    // Size off the space ACTUALLY available (Positioned.fill →
                    // SafeArea), never off MediaQuery: with a soft keyboard up
                    // the body shrinks while the screen height does not, so a
                    // card sized off the screen would overflow exactly when
                    // room is scarcest. 24 = this card's own vertical margin.
                    //
                    // The ceiling is 1000, not 720 (#94): a 412x915 phone offers
                    // 891 and the old cap threw away 171 of it — one whole
                    // option row plus change — on the very device with none to
                    // spare. It stays capped at all because the card is only
                    // 640 wide, and an unbounded column that narrow on a large
                    // monitor reads as a broken layout rather than a dialog.
                    final cardMax = (box.maxHeight - 24).clamp(280.0, 1000.0);
                    // The question is PINNED (below), so unlike before it is
                    // bounded rather than free to fill the option viewport.
                    // The ceiling is generous on purpose: the pinned block
                    // takes only what the text NEEDS (a bounded box around a
                    // scroll view), so a roomy cap costs a normal one-line
                    // question nothing and buys a six-line one being readable
                    // without scrolling — which is this issue's first
                    // requirement, and worth more than a third option row.
                    final qMax = (cardMax * 0.30).clamp(64.0, 260.0);
                    // The lead-up gets the SPARE room — not a fixed share.
                    //
                    // It used to take a flat 45%, which on a 720 card meant 324px
                    // for the reasoning and 198 for the answering half — less
                    // than the question text alone needed, so a phone showed the
                    // explanation and NOT ONE option (#94). A percentage cannot
                    // fix that, because the header and footer are FIXED costs:
                    // the smaller the card, the larger their share, and the more
                    // brutally any percentage split squeezes whatever is left.
                    //
                    // So the priority is stated directly instead. Everything but
                    // the lead-up has a job you cannot answer without — the
                    // question says what is being asked, the options are the
                    // answer, the footer sends it — and [kAnswerFloor] is what
                    // those need for three option rows to be reachable. The
                    // lead-up takes what remains, which is honest because it is
                    // the one panel that says so: it has a scrollbar AND an
                    // expander advertising that there is more where this came
                    // from.
                    final ctxMax =
                        (cardMax - qMax - kAnswerFloor).clamp(96.0, 300.0);
                    return Container(
                      constraints:
                          BoxConstraints(maxWidth: 640, maxHeight: cardMax),
                      margin: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.surfaceContainerHigh,
                        borderRadius: BorderRadius.circular(AppShape.large),
                        border: Border.all(
                            color: theme.colorScheme.outlineVariant),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _header(theme, questions.length),
                          // While typing a free-text ("Other") or note answer the
                          // soft keyboard is up and vertical space is scarce — the
                          // card would overflow and clip the field + Send button
                          // (the reported "can't see the input box when the
                          // keyboard is open"). The question text has already been
                          // read by then, so drop this panel to give the input
                          // room; it returns the moment Other/the note is
                          // deselected.
                          if (!_textEntryActive &&
                              (widget.contextText ?? '').trim().isNotEmpty)
                            _contextPanel(
                                theme, widget.contextText!.trim(), ctxMax),
                          if (questions.length > 1) _tabs(theme, questions),
                          // PINNED, outside the option scroll view (#94). It
                          // used to be the first child of that view, so the
                          // moment you scrolled down to reach an option the
                          // question left the screen — you could see what you
                          // were choosing between, or what you were choosing
                          // FOR, never both. That is the reported "the actual
                          // question text is sometimes missing".
                          if (q.question.isNotEmpty)
                            _questionText(theme, q.question, qMax),
                          Flexible(child: _optionList(theme, q)),
                          _footer(theme, q),
                        ],
                      ),
                    );
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// The question, pinned above the options so it is on screen for the whole
  /// time you are choosing (#94). Bounded by [maxHeight] and scrollable past
  /// it — a question long enough to need that is rare, but it must clip
  /// visibly (thumb) rather than silently, which is the lesson the lead-up
  /// panel below already carries.
  Widget _questionText(ThemeData theme, String text, double maxHeight) {
    return Container(
      constraints: BoxConstraints(maxHeight: maxHeight),
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
      alignment: Alignment.centerLeft,
      child: Scrollbar(
        controller: _qScroll,
        child: SingleChildScrollView(
          controller: _qScroll,
          primary: false,
          child: Text(text, style: theme.textTheme.bodyLarge),
        ),
      ),
    );
  }

  /// Claude's preceding message, scrollable, so the full answer is readable
  /// before answering (the question alone often carries only the tail).
  Widget _contextPanel(ThemeData theme, String text, double maxHeight) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      padding: const EdgeInsets.all(10),
      constraints: BoxConstraints(maxHeight: maxHeight),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainer,
        borderRadius: BorderRadius.circular(AppShape.medium),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // The whole label row is the collapse toggle (#94). On a phone the
          // lead-up's share is the only slack worth reclaiming, and the user is
          // the one who knows when they have finished reading it.
          InkWell(
            onTap: () => setState(() => _ctxExpanded = !_ctxExpanded),
            child: Row(
              children: [
                Icon(Icons.forum_outlined,
                    size: 13, color: theme.colorScheme.onSurfaceVariant),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    'Claude said',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                Icon(
                  _ctxExpanded ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
          if (_ctxExpanded) ...[
            const SizedBox(height: 6),
            Flexible(
              child: Scrollbar(
                controller: _ctxScroll,
                thumbVisibility: true,
                child: SingleChildScrollView(
                  controller: _ctxScroll,
                  primary: false,
                  child: Text(
                    text,
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: theme.colorScheme.onSurface),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _header(ThemeData theme, int count) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
      child: Row(
        children: [
          Icon(Icons.help_outline, size: 18, color: theme.colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              count > 1 ? 'Claude is asking ($count questions)' : 'Claude is asking',
              style: theme.textTheme.titleSmall,
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 20),
            tooltip: 'Dismiss (answer in the terminal instead)',
            onPressed: widget.onDismiss,
          ),
        ],
      ),
    );
  }

  Widget _tabs(ThemeData theme, List<PendingQuestionItem> questions) {
    return SizedBox(
      height: 38,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: questions.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, i) {
          final selected = i == _tab;
          final answered = _selected[i].isNotEmpty;
          final label = questions[i].header.isEmpty
              ? 'Q${i + 1}'
              : questions[i].header;
          return ChoiceChip(
            selected: selected,
            onSelected: (_) {
              setState(() => _tab = i);
              // The pinned question is per-TAB but its scroll position is not,
              // so a long Q1 scrolled halfway would hand Q2 the same offset and
              // open it mid-sentence. Only reachable since the question became
              // a bounded box of its own (#94).
              if (_qScroll.hasClients) _qScroll.jumpTo(0);
            },
            label: Text(answered ? '$label ✓' : label),
          );
        },
      ),
    );
  }

  Widget _optionList(ThemeData theme, PendingQuestionItem q) {
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // NOTE: the question itself is deliberately NOT here — it is pinned
          // above this scroll view (#94). Putting it back would restore the
          // bug where scrolling to an option hides what the options answer.
          for (var i = 0; i < q.options.length; i++)
            _optionTile(theme, q, i),
          // Note (#64 Gap 1): a small affordance to attach a note to the
          // option just picked above — NOT a replacement answer (that's
          // Other, directly below; see buildAnswerFrames for how the two
          // never combine). Same proven-safe gate as Other (single-select,
          // single question) PLUS "a real option is already selected" —
          // Other clears [_selected], so this naturally hides itself while
          // free-texting there.
          if (widget.question.questions.length == 1 &&
              !q.multiSelect &&
              _selected[_tab].isNotEmpty) ...[
            _noteAffordance(theme),
            if (_noteActive) _noteField(theme),
          ],
          // Free-text ("Other") answer. Offered ONLY for a single-select single
          // question — the proven path. Multi-select's "Type something." row is
          // a checkbox with no free-text input, and multi-question tab-advance
          // is unverified; both are deferred (see buildAnswerFrames).
          if (widget.question.questions.length == 1 && !q.multiSelect) ...[
            _otherTile(theme),
            if (_otherActive) _otherField(theme),
          ],
          const SizedBox(height: 4),
        ],
      ),
    );
  }

  /// The "Other…" row — same shell as [_optionTile]. Tapping it activates the
  /// free-text answer for this tab.
  Widget _otherTile(ThemeData theme) {
    final active = _otherActive;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Material(
        color: active
            ? theme.colorScheme.primaryContainer
            : theme.colorScheme.surfaceContainer,
        borderRadius: BorderRadius.circular(AppShape.medium),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppShape.medium),
          onTap: _chooseOther,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(
                  active ? Icons.radio_button_checked : Icons.edit_outlined,
                  size: 20,
                  color: active
                      ? theme.colorScheme.primary
                      : theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text('Other…', style: theme.textTheme.bodyLarge),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The revealed free-text field, styled like [_contextPanel]'s container.
  Widget _otherField(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 3, 0, 3),
      child: TextField(
        controller: _otherController,
        autofocus: true,
        minLines: 1,
        maxLines: 4,
        textInputAction: TextInputAction.send,
        style: theme.textTheme.bodyLarge,
        onChanged: (v) => setState(() => _otherText[_tab] = v),
        onSubmitted: (_) {
          if (_everyQuestionAnswered) _send();
        },
        decoration: InputDecoration(
          hintText: 'Type your answer…',
          isDense: true,
          filled: true,
          fillColor: theme.colorScheme.surfaceContainer,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppShape.medium),
            borderSide: BorderSide(color: theme.colorScheme.outlineVariant),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppShape.medium),
            borderSide: BorderSide(color: theme.colorScheme.outlineVariant),
          ),
        ),
      ),
    );
  }

  /// The "+ Add a note" affordance (#64 Gap 1) — deliberately smaller than
  /// [_otherTile]'s full option-row shell, since a note augments the option
  /// already picked above rather than offering a new answer to choose.
  /// Toggles [_noteField] below it.
  Widget _noteAffordance(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.only(left: 2, top: 2, bottom: 2),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(AppShape.medium),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppShape.medium),
          onTap: _toggleNote,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _noteActive
                      ? Icons.remove_circle_outline
                      : Icons.add_circle_outline,
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(
                  _noteActive ? 'Remove note' : 'Add a note',
                  style: theme.textTheme.labelMedium
                      ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The revealed note field — same shell as [_otherField] (#64 Gap 1 reuses
  /// #36's proven layout), backed by its OWN state ([_noteText]/
  /// [_noteController]) so it is never conflated with the Other free-text
  /// answer.
  Widget _noteField(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 3, 0, 3),
      child: TextField(
        controller: _noteController,
        autofocus: true,
        minLines: 1,
        maxLines: 4,
        textInputAction: TextInputAction.send,
        style: theme.textTheme.bodyLarge,
        onChanged: (v) => setState(() => _noteText[_tab] = v),
        onSubmitted: (_) {
          if (_everyQuestionAnswered) _send();
        },
        decoration: InputDecoration(
          hintText: 'Add a note for this option…',
          isDense: true,
          filled: true,
          fillColor: theme.colorScheme.surfaceContainer,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppShape.medium),
            borderSide: BorderSide(color: theme.colorScheme.outlineVariant),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppShape.medium),
            borderSide: BorderSide(color: theme.colorScheme.outlineVariant),
          ),
        ),
      ),
    );
  }

  Widget _optionTile(ThemeData theme, PendingQuestionItem q, int i) {
    final opt = q.options[i];
    final selected = _selected[_tab].contains(i);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Material(
        color: selected
            ? theme.colorScheme.primaryContainer
            : theme.colorScheme.surfaceContainer,
        borderRadius: BorderRadius.circular(AppShape.medium),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppShape.medium),
          onTap: () => _toggle(q, i),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  q.multiSelect
                      ? (selected
                          ? Icons.check_box
                          : Icons.check_box_outline_blank)
                      : (selected
                          ? Icons.radio_button_checked
                          : Icons.radio_button_unchecked),
                  size: 20,
                  color: selected
                      ? theme.colorScheme.primary
                      : theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(opt.label, style: theme.textTheme.bodyLarge),
                      if (opt.description.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            opt.description,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _footer(ThemeData theme, PendingQuestionItem q) {
    final canSend = _everyQuestionAnswered;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 12),
      child: Column(
        children: [
          // Manual fallback: forward the exact TUI nav keys, for a prompt whose
          // keybindings don't match the built sequence. These drive the numeric
          // selector — useless while typing a free-text ("Other") or note answer,
          // where they only steal the vertical room the input needs above the
          // keyboard, so they're hidden in that mode (you Send with the button /
          // Enter).
          if (!_textEntryActive) ...[
            // Wrap, not Row (#94): the five keys overflowed a 412dp phone by
            // 7.3px, and an overflowing Row does not shrink — it paints past
            // its bounds and the last key is unreachable, which on the widest
            // key ('Enter') is the one that matters most. A Wrap flows to a
            // second line instead, and costs nothing on a screen with room.
            Wrap(
              alignment: WrapAlignment.center,
              children: [
                _navKey(theme, Icons.keyboard_arrow_up, () => widget.onKey('\x1b[A')),
                _navKey(theme, Icons.keyboard_arrow_down, () => widget.onKey('\x1b[B')),
                _navTextKey(theme, 'Space', () => widget.onKey(' ')),
                _navTextKey(theme, 'Tab', () => widget.onKey('\t')),
                _navTextKey(theme, 'Enter', () => widget.onKey('\r')),
              ],
            ),
            const SizedBox(height: 8),
          ],
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: widget.onDismiss,
                  child: const Text('Answer in terminal'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton.icon(
                  onPressed: canSend ? _send : null,
                  icon: const Icon(Icons.send, size: 18),
                  label: Text(canSend ? 'Send answer' : 'Pick an option'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // The five keys are a FALLBACK, and on a phone they compete for the room the
  // options need, so they are sized to fit one row at 412dp rather than to look
  // generous. `tapTargetSize: shrinkWrap` is what actually buys it: Material's
  // default padded button carries a 48px tap box that no visual change touches.
  Widget _navKey(ThemeData theme, IconData icon, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: OutlinedButton(
          onPressed: onTap,
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            minimumSize: const Size(0, 36),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: Icon(icon, size: 18),
        ),
      );

  Widget _navTextKey(ThemeData theme, String label, VoidCallback onTap) =>
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: OutlinedButton(
          onPressed: onTap,
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            minimumSize: const Size(0, 36),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: Text(label),
        ),
      );
}
