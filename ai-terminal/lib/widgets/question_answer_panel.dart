/// The answer card for Claude's AskUserQuestion prompt (#19), without the overlay
/// around it (#383).
///
/// [QuestionOverlay] mounts it over a session's terminal; a screen with no terminal
/// beneath it (the questions inbox) mounts it on its own. Either way the answer is
/// built by [buildAnswerFrames], the one copy of the key rules, and leaves through
/// [QuestionAnswerPanel.onSend].
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../api/models.dart';
import '../theme/app_theme.dart';
import 'compose_bar.dart' show composeUsesSoftKeyboard;
import 'conversation_view.dart' show markdownStyle, openChatLink;
import 'question_overlay.dart';

/// Forwards a raw key sequence to the PTY (#50). Carried by the panel's
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

/// Whether one press of an option IS the whole answer to [q]: one question, one
/// choice (#337). Several questions, or several choices, need the full card. The
/// sessions board offers its one-press option buttons only here.
bool quickAnswerable(PendingQuestion q) =>
    q.questions.length == 1 && !q.questions.first.multiSelect;

class QuestionAnswerPanel extends StatefulWidget {
  const QuestionAnswerPanel({
    super.key,
    required this.question,
    required this.onSend,
    required this.onDismiss,
    this.onKey,
    this.contextText,
    this.drafts,
    this.draftKey = '',
    this.elsewhereLabel = 'Answer in terminal',
    this.autofocus = false,
  });

  final PendingQuestion question;

  /// Where the typed Other/note text survives a resurfacing (#383), keyed by
  /// [draftKey]. Null keeps the old behaviour (nothing outlives the panel).
  final QuestionDrafts? drafts;
  final String draftKey;

  /// Claude's preceding message (the lead-up to the question), shown scrollable
  /// above the question so the full answer is readable before answering. Null
  /// when unavailable.
  final String? contextText;

  /// Send the built answer as timed frames (the caller honours each delay).
  final void Function(List<AnswerFrame> frames) onSend;

  /// Leave the card without answering, to answer somewhere else ([elsewhereLabel]).
  final VoidCallback onDismiss;

  /// Forward a single raw key to the PTY — the manual nav fallback buttons and the
  /// hardware Tab/arrow forwarding. Null when there is no terminal beneath the card:
  /// the raw-key toggle is then hidden, because blind keys are not offered.
  final void Function(String sequence)? onKey;

  /// The label of the button that dismisses the card: where the question can be
  /// answered instead ("Answer in terminal", "Open session").
  final String elsewhereLabel;

  /// Take focus when mounted, so hardware Enter/Tab/arrows reach the card (#64).
  final bool autofocus;

  @override
  State<QuestionAnswerPanel> createState() => _QuestionAnswerPanelState();
}

class _QuestionAnswerPanelState extends State<QuestionAnswerPanel> {
  int _tab = 0;
  late List<Set<int>> _selected;

  /// One stable key per (tab, option) so a revealed preview can be scrolled into
  /// view (#145 — see [_revealPreview]). Keyed by tab as well as index because
  /// the tabs share one scroll view and index 0 is a different row on each.
  /// Created lazily and kept for the life of the overlay: a GlobalKey has to be
  /// the SAME object across rebuilds or the element it names is torn down.
  final Map<String, GlobalKey> _optionKeys = {};

  GlobalKey _optionKey(int i) =>
      _optionKeys.putIfAbsent('$_tab:$i', () => GlobalKey());

  /// Per-question free-text ("Other") answer, parallel to [_selected]. `null`
  /// means Other is NOT the active choice for that tab (numeric-selection mode);
  /// a non-null value (even `''`) means Other is active, and its trimmed text is
  /// the answer. Populated per QUESTION: #143 opened the Other row on every
  /// COMPACT tab, so a multi-question prompt can carry an independent
  /// free-text answer on each of them.
  late List<String?> _otherText;

  /// Backs the free-text field — ONE CONTROLLER PER QUESTION, parallel to
  /// [_otherText] (#164).
  ///
  /// A single shared controller was right only while Other was
  /// single-question-only. Once #143 offered the row on every compact tab, the
  /// second tab opened already holding the first tab's characters and
  /// [_chooseOther] copied them into that tab's answer — so two questions
  /// could not take two different free-text answers at all, and the prompt had
  /// to be answered in the terminal instead. A controller owns the text AND
  /// the caret, so per-tab controllers are also what makes leaving a tab and
  /// returning restore exactly what was typed there.
  late List<TextEditingController> _otherControllers;

  /// Per-question NOTE attached to the tab's ALREADY-chosen option (#64
  /// Gap 1) — parallel to [_otherText] but NEVER conflated with it: Other
  /// (#36) REPLACES the numeric answer with free text, a note AUGMENTS it.
  /// `null` means the note field is not revealed for that tab; a non-null
  /// value (even `''`) means it is, and its trimmed text is the note. Only
  /// ever populated for single-select single-question PREVIEWED prompts — the
  /// only layout whose selector has a notes feature at all (#143). That is a
  /// narrower scope than Other's, not the same one.
  late List<String?> _noteText;

  /// Backs the note field — one controller per question, for the same reason
  /// as [_otherControllers] (#164). Notes are still gated to single-question
  /// prompts, so the shared controller was not reachable here yet; it is
  /// corrected in the same pass rather than left as the next report.
  late List<TextEditingController> _noteControllers;

  /// The notes typed before this overlay was rebuilt, per tab (#383). Never put back
  /// into [_noteText] (a note needs its option picked and nothing is picked again):
  /// they survive only as words, in [QuestionDrafts.words]' block and in the saved
  /// drafts.
  late List<String?> _keptNotes;

  /// Drives [_contextPanel]'s scroll view so a [Scrollbar] can show a thumb.
  /// Without one, a clipped lead-up reads as a COMPLETE message — the reported
  /// failure: the options were unjudgeable and nothing hinted at scrolling.
  final ScrollController _ctxScroll = ScrollController();

  /// Same job for the pinned question (#94). A question long enough to need
  /// its own scroll is rare, but a silently clipped one is the exact defect
  /// this issue is about, so it gets the same honest affordance.
  final ScrollController _qScroll = ScrollController();

  /// Drives the option list's own [Scrollbar] (#108) — the one scroller in the
  /// card that had no thumb, and the region the report was about.
  final ScrollController _optScroll = ScrollController();

  /// The user's EXPLICIT choice about the lead-up panel, or null for "decide
  /// from the room available" (#94, reworked for #108).
  ///
  /// It was a plain `bool = true`, which forced the panel open on a card with
  /// no room for it. Tri-state instead, because the two facts are different: on
  /// a roomy card the context is why the options mean anything and must be open
  /// by default; on a cramped one it must yield, or it takes the room the
  /// options need and you get a single clipped row. A tap still wins either way
  /// — an explicit request outranks the budget, because the user can see what
  /// they are trading.
  bool? _ctxExpandedOverride;

  /// Whether the raw-key fallback row is revealed (#108). Hidden by default.
  ///
  /// It is a FALLBACK — for a prompt whose keybindings don't match the built
  /// sequence — but it was charging every card a permanent row for that rare
  /// case, and the card pays for it out of the option list. Six keys at a phone
  /// width wrap to two rows, which measured 36px straight off the options; the
  /// answer is not to shave the buttons but to stop billing everyone.
  bool _keysShown = false;

  /// One empty [TextEditingController] per question in the CURRENT prompt.
  List<TextEditingController> _freshControllers() =>
      [for (final _ in widget.question.questions) TextEditingController()];

  static void _disposeAll(Iterable<TextEditingController> cs) {
    for (final c in cs) {
      c.dispose();
    }
  }

  @override
  void initState() {
    super.initState();
    _selected = [for (final _ in widget.question.questions) <int>{}];
    _otherText = [for (final _ in widget.question.questions) null];
    _noteText = [for (final _ in widget.question.questions) null];
    _keptNotes = [for (final _ in widget.question.questions) null];
    _otherControllers = _freshControllers();
    _noteControllers = _freshControllers();
    _restoreDrafts();
  }

  /// Puts back what was typed for THIS question before the overlay was rebuilt
  /// (#383): the Other text, which implies its own row so it needs no pick. Nothing
  /// else comes back as input: a pick or a note restored here would make the card a
  /// ready-to-send answer that can replay into a selector that has already closed.
  /// A note is kept as text only ([_keptNotes]). A draft kept for another question,
  /// or for a prompt with a different number of tabs, is ignored.
  void _restoreDrafts() {
    final d = widget.drafts;
    final n = widget.question.questions.length;
    if (d == null || d.key != widget.draftKey || d.other.length != n) return;
    for (var i = 0; i < n; i++) {
      final o = d.other[i];
      if (o != null) {
        _otherText[i] = o;
        _otherControllers[i].text = o;
      }
      _keptNotes[i] = i < d.note.length ? d.note[i] : null;
    }
  }

  /// Mirrors the typed text into [QuestionAnswerPanel.drafts]. Called at every change
  /// rather than at dispose, so the owner's `clear()` on a landed answer cannot be
  /// undone by the overlay unmounting afterwards.
  void _saveDrafts() {
    final d = widget.drafts;
    if (d == null) return;
    // Another question's flag and sent words must not follow the draft over to this
    // one. The LIVE draft below is saved on every edit, flagged or not: the sent
    // words are a separate snapshot ([QuestionDrafts.sentWords]).
    if (d.key != widget.draftKey) {
      d.notLanded = false;
      d.sentWords = const [];
    }
    d
      ..key = widget.draftKey
      ..other = List.of(_otherText)
      ..note = [
        for (var i = 0; i < _noteText.length; i++) _noteText[i] ?? _keptNotes[i]
      ];
  }

  @override
  void didUpdateWidget(covariant QuestionAnswerPanel old) {
    super.didUpdateWidget(old);
    // A different prompt arrived → reset selection, free text + active tab.
    //
    // The question COUNT is checked as well (#164): every per-question list
    // here is indexed by tab, so one that did not grow with the prompt would
    // index past its end.
    if (old.question.toolUseId != widget.question.toolUseId ||
        widget.question.questions.length != _selected.length) {
      _tab = 0;
      _selected = [for (final _ in widget.question.questions) <int>{}];
      _otherText = [for (final _ in widget.question.questions) null];
      _noteText = [for (final _ in widget.question.questions) null];
      _keptNotes = [for (final _ in widget.question.questions) null];
      // Swap the lists now, drop the old controllers at the END of this frame:
      // the fields they back are still mounted until the rebuild this update
      // schedules tears them down, and a controller disposed out from under a
      // live EditableText is a crash, not a leak.
      final stale = [..._otherControllers, ..._noteControllers];
      _otherControllers = _freshControllers();
      _noteControllers = _freshControllers();
      WidgetsBinding.instance
          .addPostFrameCallback((_) => _disposeAll(stale));
      // A NEW prompt gets its lead-up back (#94). Collapsing is a per-question
      // decision — "I have read this one" — not a standing preference, and
      // carrying it over would open the next question with its context hidden,
      // which is precisely the "the context isn't clear" report this change
      // exists to fix.
      _ctxExpandedOverride = null;
      if (_qScroll.hasClients) _qScroll.jumpTo(0);
      // The SAME question re-reported under a new toolUseId (hook id -> transcript
      // id) is not a new prompt: put its drafts back instead of wiping them (#383).
      // A different question has a different key and is left empty. The "did not
      // land" notice is tied to that same key ([QuestionDrafts.flaggedFor]), so it
      // follows the question and not the id.
      _restoreDrafts();
    }
  }

  @override
  void dispose() {
    _disposeAll(_otherControllers);
    _disposeAll(_noteControllers);
    _ctxScroll.dispose();
    _qScroll.dispose();
    _optScroll.dispose();
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
      _saveDrafts();
    });
    _revealPreview(q, i);
  }

  /// Scroll a just-selected option's `preview` block into view (#145).
  ///
  /// Selecting is what reveals a preview, and the block is far taller than the
  /// row that opened it. On a phone the option list gets `kOptionFloor` — about
  /// two rows — so choosing the LAST option opens a ~300px block entirely below
  /// the viewport: the radio fills, nothing else changes, and the preview this
  /// feature exists to show is invisible on exactly the narrow screen it was
  /// reported from.
  ///
  /// Deliberately narrow. It fires only for an option that actually HAS a
  /// preview, so no preview-less question changes behaviour and #94's
  /// "options are reachable without scrolling" budget is untouched.
  ///
  /// Deferred to the next frame because the block does not exist until the
  /// rebuild that `setState` above schedules — and RE-CHECKED there, because
  /// between scheduling and running, the overlay can be dismissed or the tab
  /// switched (#111: a deferred scroll that does not re-check moves the wrong
  /// thing, or a thing that is gone).
  void _revealPreview(PendingQuestionItem q, int i) {
    if (i < 0 || i >= q.options.length) return;
    if (q.options[i].preview.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (!_selected[_tab].contains(i)) return;
      final ctx = _optionKey(i).currentContext;
      if (ctx == null) return;
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        // Bring the BOTTOM of the tile up: the preview hangs below the label,
        // so aligning the top would scroll the block itself back out of sight.
        alignment: 1.0,
      );
    });
  }

  /// Activates the free-text ("Other") answer for the current tab: clears any
  /// numeric picks (Other is mutually exclusive) and reveals the text field.
  ///
  /// The seed is THIS tab's own controller (#164) — empty on a tab that has
  /// never been free-texted, and whatever was typed here before on one that
  /// was. It is never another tab's text.
  void _chooseOther() {
    setState(() {
      _selected[_tab].clear();
      _otherText[_tab] = _otherControllers[_tab].text;
      _saveDrafts();
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
        _noteControllers[_tab].clear();
      } else {
        _noteText[_tab] = _noteControllers[_tab].text;
      }
      _saveDrafts();
    });
  }

  /// Whether question [i] has an answer — the ONE definition of "answered",
  /// read by the Send gate below AND by the tab chip's tick (#164).
  ///
  /// The chip read [_selected] alone, so a tab answered by free text reported
  /// itself unanswered while Send said the prompt was ready. Two readouts of
  /// one fact is the drift this repo keeps paying for; there is now one.
  bool _isAnswered(int i) =>
      _selected[i].isNotEmpty || (_otherText[i]?.trim().isNotEmpty ?? false);

  bool get _everyQuestionAnswered =>
      List.generate(_selected.length, _isAnswered)
          .every((answered) => answered);

  /// THE one way an answer leaves this card: the button, hardware Enter and a soft
  /// keyboard's Send action (`onSubmitted`) all come through here, so no trigger can
  /// bypass the completeness or the partly-typed gate (#383). Only the explicit
  /// "Send again anyway" button passes [deliberate]: a keystroke, on any platform,
  /// must not replay words the terminal may already hold.
  void _trySend({bool deliberate = false}) {
    if (!_everyQuestionAnswered) return;
    if (_partlyTyped && !deliberate) return;
    _send();
  }

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

    final onKey = widget.onKey;

    // #50: hardware Tab/arrows drive Claude's TUI in the terminal beneath
    // (its `/status` tabs, menus, question phase) rather than traversing
    // the overlay's buttons. This Shortcuts sits below WidgetsApp, so it
    // wins over the default focus-traversal / caret shortcuts. Tab always
    // forwards; arrows forward ONLY while a free-text field (Other, or a
    // note — #64 Gap 1) is inactive — when one IS active the arrows are
    // left unmapped so the caret can move inside that field. With no
    // terminal beneath ([QuestionAnswerPanel.onKey] null) nothing forwards,
    // and Tab and the arrows keep their ordinary meaning.
    //
    // #64 Gap 2: hardware Enter submits the current selection — DESKTOP
    // only, gated by the same `composeUsesSoftKeyboard` predicate the
    // compose bar uses (#55 SSOT), never reimplemented here. A soft
    // keyboard's Enter is a text COMMIT, not a key event, so this could
    // never fire on mobile anyway, but the explicit gate documents the
    // contract and keeps the two clients in lockstep if that ever
    // changes.
    //
    // Both live HERE rather than in [QuestionOverlay] (#383): the arrow gate
    // reads this card's text-entry state, and the Enter shortcut must sit
    // above the focus node below for its key events to bubble through it.
    return Shortcuts(
      shortcuts: <ShortcutActivator, Intent>{
        if (onKey != null)
          const SingleActivator(LogicalKeyboardKey.tab):
              const _ForwardKeyIntent('\t'),
        if (onKey != null && !_textEntryActive) ...const {
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
              onKey?.call(intent.seq);
              return null;
            },
          ),
          // Same completeness gate as the Send button (_footer below) —
          // an incomplete selection is a no-op, never a partial submit.
          // And, like the button, never a blind replay once the terminal
          // may hold part of the answer (#383): that takes a deliberate tap.
          _SubmitIntent: CallbackAction<_SubmitIntent>(
            onInvoke: (intent) {
              _trySend();
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
          autofocus: widget.autofocus,
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
            // Two columns, or one? Decided by the room actually on offer
            // (#108) — see kWideMinWidth. Everything below still runs in
            // BOTH shapes; `wide` only decides whether the lead-up is
            // charged to the same height budget as the options.
            final wide = box.maxWidth >= kWideMinWidth &&
                box.maxHeight >= kWideMinHeight;
            final cardMax = (box.maxHeight - 24)
                .clamp(280.0, wide ? 1400.0 : 1000.0);
            //
            // *** Options are RESERVED, not residual. ***
            // Subtract the fixed chrome and an option floor FIRST; only
            // then do the question and the lead-up divide what is left.
            // Previously the options were the Flexible residual, so
            // every other panel's appetite was charged to the one region
            // you must interact with — measured at the real mount on a
            // 412x915 phone, a 206px option viewport showing ONE row
            // with the second sliced through its description.
            final hasContext =
                (widget.contextText ?? '').trim().isNotEmpty;
            // In the wide shape the lead-up is beside the options, not
            // above them, so it is not part of this subtraction at all.
            final fixed = kHeaderH +
                kFooterH +
                (questions.length > 1 ? kTabStripH : 0);
            final shared = cardMax - fixed - kOptionFloor;
            // The question is served next and always keeps two lines. It
            // is PINNED (below) and bounded rather than free to fill the
            // option viewport, and the pinned block takes only what the
            // text NEEDS, so a generous cap costs a one-line question
            // nothing while letting a six-line one be read without
            // scrolling.
            final qMax = shared.clamp(kQuestionMin, kQuestionMax);
            // The lead-up takes the remainder — and COLLAPSES rather
            // than showing a slit. It is the one panel that can honestly
            // say "there is more": it has a scrollbar AND an expander.
            final ctxRoom = shared - qMax - kCtxChrome;
            final ctxSpare =
                ctxRoom >= kCtxMinUseful ? ctxRoom.clamp(0.0, kCtxMax) : 0.0;
            // Open by default only when the panel can show enough to be
            // worth its frame. Null means "decide from the room".
            final expanded =
                _ctxExpandedOverride ?? (ctxSpare >= kCtxMinUseful);
            // The lead-up's own column runs the full height between the
            // header and the footer, so it needs no share of `shared`.
            final ctxColumnH =
                (cardMax - kHeaderH - kFooterH - kCtxChrome)
                    .clamp(kCtxMinUseful, 4000.0);
            // Dropping the lead-up while a text field has focus buys room
            // back from a SOFT keyboard. That is a platform fact, not a
            // size one — a hardware keyboard costs no height, so on
            // desktop the context stays put while you type "Other".
            final hideCtxForTyping =
                _textEntryActive &&
                    composeUsesSoftKeyboard(defaultTargetPlatform);
            return Container(
              constraints: BoxConstraints(
                  maxWidth: wide ? kWideCardMax : 640,
                  maxHeight: cardMax),
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
                  if (!wide && !hideCtxForTyping && hasContext)
                    _contextPanel(
                      theme,
                      widget.contextText!.trim(),
                      // An explicit tap gets a real share even on a
                      // cramped card — the budget decides the DEFAULT,
                      // never what the user is allowed to read.
                      expanded
                          ? (ctxSpare >= kCtxMinUseful
                              ? ctxSpare
                              : (cardMax * 0.35).clamp(
                                  kCtxMinUseful, 300.0))
                          : 0.0,
                      expanded,
                    ),
                  // The question and its options, and — only in the wide
                  // shape — the lead-up standing beside them rather than
                  // above them.
                  Flexible(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (wide && !hideCtxForTyping && hasContext)
                          SizedBox(
                            width: kWideCtxColumn,
                            // Always expanded here: it is not borrowing
                            // from anyone, so there is nothing to decide.
                            child: _contextPanel(
                                theme,
                                widget.contextText!.trim(),
                                ctxColumnH,
                                true),
                          ),
                        Expanded(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (questions.length > 1)
                                _tabs(theme, questions),
                              // PINNED, outside the option scroll view
                              // (#94). It used to be the first child of
                              // that view, so the moment you scrolled
                              // down to reach an option the question left
                              // the screen — you could see what you were
                              // choosing between, or what you were
                              // choosing FOR, never both. That is the
                              // reported "the actual question text is
                              // sometimes missing".
                              if (q.question.isNotEmpty)
                                _questionText(theme, q.question, qMax),
                              Flexible(child: _optionList(theme, q)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  _footer(theme, q),
                ],
              ),
            );
          }),
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
    // NO `alignment:` here. Setting one wraps the child in an Align, which
    // does NOT shrink-wrap under bounded constraints — it expands to
    // constraints.biggest. Measured: a one-line question (24px of text) took a
    // 260px block, handing the options 236px of dead space in the ordinary
    // case this whole change exists to protect. Without it the Container sizes
    // to the child, so [maxHeight] is a ceiling rather than a height.
    return Container(
      constraints: BoxConstraints(maxHeight: maxHeight),
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
      child: Scrollbar(
        controller: _qScroll,
        thumbVisibility: true,
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
  Widget _contextPanel(
      ThemeData theme, String text, double maxHeight, bool expanded) {
    // [maxHeight] bounds the BODY, never the panel. Constraining the whole
    // Container collapsed the HEADER with it: at maxHeight 0 the "Claude said"
    // row became zero-height, so the chevron could not be tapped and the toggle
    // was one-way — and on a card that auto-collapses, the lead-up would have
    // been unreachable entirely, which is worse than the crowding this fixes.
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      padding: const EdgeInsets.all(10),
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
            onTap: () => setState(() => _ctxExpandedOverride = !expanded),
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
                  expanded ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
          if (expanded) ...[
            const SizedBox(height: 6),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: maxHeight),
              child: Scrollbar(
                controller: _ctxScroll,
                thumbVisibility: true,
                child: SingleChildScrollView(
                  controller: _ctxScroll,
                  primary: false,
                  // #108 — RENDERED, not raw. This was a plain Text, so the
                  // agent's own formatting arrived as literal syntax: a
                  // screenshot showed `**6 approved and marked Committed, 1
                  // rejected.**`, a literal `## Branch pushed`, and backticked
                  // refs still wearing their backticks. The one block you must
                  // read carefully to judge the options was the only place in
                  // the app where formatting was stripped.
                  //
                  // Reuses the chat lens's sheet (`markdownStyle`) rather than a
                  // second one, so bold and headings cannot drift between the
                  // two places the same prose is shown.
                  //
                  // `onTapLink` is the native path and is NOT interchangeable
                  // with a custom `a` builder: a builder returns a WIDGET, which
                  // shatters the paragraph into separate RichTexts and breaks
                  // selection across any sentence containing a link (#83).
                  child: MarkdownBody(
                    data: text,
                    selectable: false,
                    fitContent: true,
                    extensionSet: md.ExtensionSet.gitHubWeb,
                    onTapLink: (_, href, _) => openChatLink(href),
                    styleSheet: markdownStyle(
                      theme,
                      theme.textTheme.bodyMedium
                          ?.copyWith(color: theme.colorScheme.onSurface),
                      theme.textTheme.bodySmall,
                    ),
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
          // Raw keys need a terminal to go to (#383): with none, no toggle.
          if (widget.onKey != null)
            IconButton(
              icon: Icon(
                _keysShown ? Icons.keyboard_hide_outlined : Icons.keyboard_outlined,
                size: 20,
              ),
              tooltip: _keysShown ? 'Hide raw keys' : 'Show raw keys',
              onPressed: () => setState(() => _keysShown = !_keysShown),
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
          final answered = _isAnswered(i);
          final label = questions[i].header.isEmpty
              ? 'Q${i + 1}'
              : questions[i].header;
          return ChoiceChip(
            selected: selected,
            onSelected: (_) {
              // Switching tabs saves and loads nothing: since #164 the free
              // text lives in that tab's OWN controller, so the field simply
              // rebinds and shows this question's text — or none. Focus
              // follows only when the destination tab already has Other open,
              // which is what the field's `autofocus` already does; a tab you
              // are merely browsing never raises the keyboard.
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
    // The option list was the ONE scroller in this card with no thumb — the
    // question (#94) and the lead-up both got one, and this is the region the
    // report was actually about. A row cut by the viewport with nothing
    // advertising the scroll reads as the end of the list.
    //
    // Stays a SingleChildScrollView on purpose: the #94 tests resolve the
    // option viewport with `find.ancestor(..., matching: find.byType(
    // SingleChildScrollView))`, so a ListView would silently break the one
    // assertion that proves the options are reachable.
    return Scrollbar(
      controller: _optScroll,
      thumbVisibility: true,
      child: SingleChildScrollView(
      controller: _optScroll,
      primary: false,
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
          // option just picked above — NOT a replacement answer (that's Other,
          // below; see buildAnswerFrames for how the two never combine). Gated
          // on single-select + single question, PLUS "a real option is already
          // selected".
          //
          // AND on hasPreview (#143): the compact selector has no notes feature
          // at all, so offering the affordance there promised something the TUI
          // cannot receive and the typed note was silently thrown away. Since
          // Other is gated the OTHER way (compact only), the two never appear on
          // one card — so the note cannot be open while free-texting in Other,
          // and it no longer relies on Other clearing [_selected] to hide.
          if (widget.question.questions.length == 1 &&
              !q.multiSelect &&
              q.hasPreview &&
              _selected[_tab].isNotEmpty) ...[
            _noteAffordance(theme),
            if (_noteActive) _noteField(theme),
          ],
          // Free-text ("Other") answer. Offered for a COMPACT single-select
          // question, multi-question included since #143 measured the
          // tab-advance working there.
          //
          // Two exclusions, and they are the mirror image of the note gate
          // above — this card offers exactly what the layout it mirrors offers.
          // Side-by-side (hasPreview): that selector renders NO "Type
          // something." row, so the digit moves nothing, the text is swallowed
          // and the trailing CR commits whatever row is highlighted — measured
          // recording "Red" for a free-text answer of "indigo actually".
          // Multi-select: its "Type something." row is a checkbox with no
          // free-text input. See buildAnswerFrames for both measurements.
          if (!q.multiSelect && !q.hasPreview) ...[
            _otherTile(theme),
            if (_otherActive) _otherField(theme),
          ],
          const SizedBox(height: 4),
        ],
      ),
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
        controller: _otherControllers[_tab],
        autofocus: true,
        minLines: 1,
        maxLines: 4,
        textInputAction: TextInputAction.send,
        style: theme.textTheme.bodyLarge,
        onChanged: (v) => setState(() {
          _otherText[_tab] = v;
          _saveDrafts();
        }),
        onSubmitted: (_) {
          _trySend();
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
  /// [_noteControllers]) so it is never conflated with the Other free-text
  /// answer.
  Widget _noteField(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 3, 0, 3),
      child: TextField(
        controller: _noteControllers[_tab],
        autofocus: true,
        minLines: 1,
        maxLines: 4,
        textInputAction: TextInputAction.send,
        style: theme.textTheme.bodyLarge,
        onChanged: (v) => setState(() {
          _noteText[_tab] = v;
          _saveDrafts();
        }),
        onSubmitted: (_) {
          _trySend();
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
      // Named so _revealPreview can scroll this exact row into view once
      // selecting it opens a preview taller than the row itself (#145).
      key: _optionKey(i),
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
                          child: Text.rich(
                            // #108 — RENDERED inline markdown, not raw. A
                            // description reading `ACS.Server.exe --out <path>`
                            // showed its backticks, the same defect the lead-up
                            // panel had. Spans rather than a MarkdownBody so the
                            // clamp below survives (see inlineMarkdownSpans).
                            TextSpan(
                              children: inlineMarkdownSpans(
                                opt.description,
                                base: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                                code: theme.textTheme.bodySmall?.copyWith(
                                  fontFamily: 'monospace',
                                  color: theme.colorScheme.onSurfaceVariant,
                                  backgroundColor:
                                      theme.colorScheme.surfaceContainerHighest,
                                ),
                              ),
                            ),
                            // Two lines until chosen, then the whole thing
                            // (#108). One verbose option could otherwise be
                            // taller than the entire viewport and push every
                            // other choice off screen.
                            //
                            // Expand ON SELECT rather than behind a per-row
                            // chevron: selecting is exactly when you want the
                            // detail, a second tap target inside the row would
                            // compete with _toggle (and with the checkbox in
                            // multi-select), and this costs nothing when space
                            // is scarce.
                            //
                            // Honest limit: ellipsis breaks at a grapheme, so it
                            // can still end mid-word — what it never does is end
                            // SILENTLY, which is what the report was.
                            maxLines: selected ? null : 2,
                            overflow: selected ? null : TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      // #145 — the preview BLOCK, on the selected row only.
                      //
                      // This mirrors what Claude's own side-by-side layout does:
                      // moving the highlight is what swaps the preview box, and
                      // nothing is committed until Enter. Here a tap only moves
                      // the selection too (Send commits), so reading a preview
                      // stays free and reversible — you are not made to choose
                      // an option in order to find out what it means.
                      //
                      // Monospace and unrendered: a preview is a snippet, a diff
                      // or a mock-up whose ALIGNMENT is the content. Running it
                      // through the markdown spans the description uses would
                      // eat the backticks and asterisks that a code block is
                      // made of.
                      if (selected && opt.preview.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Container(
                            width: double.infinity,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 8,
                            ),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.surfaceContainerHighest,
                              borderRadius: BorderRadius.circular(
                                AppShape.small,
                              ),
                              border: Border.all(
                                color: theme.colorScheme.outlineVariant,
                              ),
                            ),
                            child: Text(
                              opt.preview,
                              maxLines: kPreviewMaxLines,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                // 'monospace' is an Android/fontconfig alias and
                                // resolves to NOTHING on Windows, macOS and iOS,
                                // where Flutter then falls back to a proportional
                                // face — which would defeat the entire reason this
                                // block is unparsed. The fallback list is what
                                // makes the alignment claim true off Android.
                                fontFamily: 'monospace',
                                fontFamilyFallback: const [
                                  'Consolas',
                                  'Menlo',
                                  'DejaVu Sans Mono',
                                  'Courier New',
                                ],
                                height: 1.35,
                                color: theme.colorScheme.onSurface,
                              ),
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

  /// The answer carrying words was sent and has not been seen to land (#383): see
  /// [QuestionDrafts.notLanded].
  bool get _partlyTyped =>
      widget.drafts?.flaggedFor(widget.draftKey) ?? false;

  /// Shown instead of an inviting Send once [_partlyTyped]. The words stay visible
  /// and selectable here whichever tab is open, so they can be copied out, exactly
  /// as they were sent ([QuestionDrafts.words]).
  Widget _partlyTypedNotice(ThemeData theme) {
    final words = widget.drafts?.words ?? const <String>[];
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(AppShape.medium),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'This answer did not land and may be partly typed in the terminal. '
            'Open the session there to finish it, or send it again anyway.',
            style: theme.textTheme.bodySmall,
          ),
          if (words.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 56),
              child: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: SelectableText(
                    words.join('\n'),
                    key: const ValueKey('partly-typed-words'),
                    style: theme.textTheme.bodySmall?.copyWith(
                      // 'monospace' resolves to nothing off Android (#145).
                      fontFamily: 'monospace',
                      fontFamilyFallback: const [
                        'Consolas',
                        'Menlo',
                        'DejaVu Sans Mono',
                        'Courier New',
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
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
          // Revealed from the header's keyboard toggle (#108), not always on.
          if (!_textEntryActive && _keysShown && widget.onKey != null) ...[
            // Wrap, not Row (#94): the keys overflowed a 412dp phone by
            // 7.3px, and an overflowing Row does not shrink — it paints past
            // its bounds and the last key is unreachable, which on the widest
            // key ('Enter') is the one that matters most. A Wrap flows to a
            // second line instead, and costs nothing on a screen with room.
            Wrap(
              alignment: WrapAlignment.center,
              children: [
                _navKey(theme, Icons.keyboard_arrow_up, () => widget.onKey!('\x1b[A')),
                _navKey(theme, Icons.keyboard_arrow_down, () => widget.onKey!('\x1b[B')),
                _navTextKey(theme, 'Space', () => widget.onKey!(' ')),
                _navTextKey(theme, 'Tab', () => widget.onKey!('\t')),
                _navTextKey(theme, 'Enter', () => widget.onKey!('\r')),
                // Esc joined this row when the overlay moved to cover the whole
                // body (#108). TerminalKeyStrip offers Esc, Ctrl, Alt, / and |;
                // of those Esc is the one that means something AT a prompt — it
                // rejects the tool and lets the agent carry on — so it is the
                // only one that has to survive being covered. The rest are for
                // typing at a shell, which is not what this card is for, and
                // "Answer in terminal" brings the whole strip back anyway.
                _navTextKey(theme, 'Esc', () => widget.onKey!('\x1b')),
              ],
            ),
            const SizedBox(height: 8),
          ],
          if (_partlyTyped) ...[
            _partlyTypedNotice(theme),
            const SizedBox(height: 8),
          ],
          Row(
            children: [
              Expanded(
                // After an answer with words did not land, finishing it in the
                // terminal is the default action and a replay is the deliberate one.
                child: _partlyTyped
                    ? FilledButton(
                        onPressed: widget.onDismiss,
                        child: Text(widget.elsewhereLabel),
                      )
                    : OutlinedButton(
                        onPressed: widget.onDismiss,
                        child: Text(widget.elsewhereLabel),
                      ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _partlyTyped
                    ? OutlinedButton.icon(
                        onPressed:
                            canSend ? () => _trySend(deliberate: true) : null,
                        icon: const Icon(Icons.send, size: 18),
                        label: Text(canSend ? 'Send again anyway' : 'Pick an option'),
                      )
                    : FilledButton.icon(
                        onPressed: canSend ? _trySend : null,
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
