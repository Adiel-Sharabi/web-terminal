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
import '../theme/app_theme.dart';

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
/// Verified against Claude's TUI:
/// - single-select: the digit selects AND submits, advancing to the next tab.
/// - multi-select: each digit toggles its row; a trailing `Enter` confirms.
/// - multi-question: after every tab is answered a Submit review appears whose
///   default is "Submit answers", so a trailing `Enter` finalizes it.
///
/// Pure, so the mapping is unit-testable.
List<AnswerFrame> buildAnswerFrames(
  List<PendingQuestionItem> questions,
  List<Set<int>> selections,
) {
  const gap = 600; // between frames that must be read separately
  const settle = 250; // between absolute toggles (safe to coalesce)
  final frames = <AnswerFrame>[];
  final multiQuestion = questions.length > 1;
  for (var qi = 0; qi < questions.length; qi++) {
    final q = questions[qi];
    final sel = qi < selections.length ? selections[qi] : const <int>{};
    if (q.multiSelect) {
      final rows = sel.toList()..sort();
      for (final i in rows) {
        frames.add(AnswerFrame('${i + 1}', settle)); // toggle row i
      }
      frames.add(const AnswerFrame('\r', gap)); // confirm this tab
    } else {
      final idx = sel.isEmpty ? 0 : sel.first;
      frames.add(AnswerFrame('${idx + 1}', gap)); // select + submit/advance
    }
  }
  if (multiQuestion) {
    frames.add(const AnswerFrame('\r', gap)); // Submit-review screen
  }
  return frames;
}

/// True when [frames] end in a confirming Enter — i.e. multi-select (digits
/// toggle, Enter confirms) or multi-question (Enter finalizes the Submit-review
/// screen). Single-select-single ends in its own auto-submitting digit and
/// needs no confirm. The caller uses this to decide whether to verify the Enter
/// actually landed (it can be coalesced away by cluster-path bunching) and
/// re-send it.
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

  @override
  void initState() {
    super.initState();
    _selected = [for (final _ in widget.question.questions) <int>{}];
  }

  @override
  void didUpdateWidget(covariant QuestionOverlay old) {
    super.didUpdateWidget(old);
    // A different prompt arrived → reset selection + active tab.
    if (old.question.toolUseId != widget.question.toolUseId) {
      _tab = 0;
      _selected = [for (final _ in widget.question.questions) <int>{}];
    }
  }

  void _toggle(PendingQuestionItem q, int i) {
    setState(() {
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

  bool get _everyQuestionAnswered =>
      _selected.every((s) => s.isNotEmpty);

  void _send() {
    widget.onSend(buildAnswerFrames(widget.question.questions, _selected));
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
            child: Container(
              constraints: const BoxConstraints(maxWidth: 640, maxHeight: 520),
              margin: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(AppShape.large),
                border: Border.all(color: theme.colorScheme.outlineVariant),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _header(theme, questions.length),
                  if ((widget.contextText ?? '').trim().isNotEmpty)
                    _contextPanel(theme, widget.contextText!.trim()),
                  if (questions.length > 1) _tabs(theme, questions),
                  Flexible(child: _optionList(theme, q)),
                  _footer(theme, q),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Claude's preceding message, scrollable, so the full answer is readable
  /// before answering (the question alone often carries only the tail).
  Widget _contextPanel(ThemeData theme, String text) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      padding: const EdgeInsets.all(10),
      constraints: const BoxConstraints(maxHeight: 160),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainer,
        borderRadius: BorderRadius.circular(AppShape.medium),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.forum_outlined,
                  size: 13, color: theme.colorScheme.onSurfaceVariant),
              const SizedBox(width: 5),
              Text(
                'Claude said',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Flexible(
            child: SingleChildScrollView(
              child: Text(
                text,
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.onSurface),
              ),
            ),
          ),
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
            onSelected: (_) => setState(() => _tab = i),
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
          if (q.question.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 2, 4, 8),
              child: Text(q.question, style: theme.textTheme.bodyLarge),
            ),
          for (var i = 0; i < q.options.length; i++)
            _optionTile(theme, q, i),
          const SizedBox(height: 4),
        ],
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
          // keybindings don't match the built sequence.
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _navKey(theme, Icons.keyboard_arrow_up, () => widget.onKey('\x1b[A')),
              _navKey(theme, Icons.keyboard_arrow_down, () => widget.onKey('\x1b[B')),
              _navTextKey(theme, 'Space', () => widget.onKey(' ')),
              _navTextKey(theme, 'Tab', () => widget.onKey('\t')),
              _navTextKey(theme, 'Enter', () => widget.onKey('\r')),
            ],
          ),
          const SizedBox(height: 8),
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

  Widget _navKey(ThemeData theme, IconData icon, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3),
        child: OutlinedButton(
          onPressed: onTap,
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            minimumSize: const Size(0, 36),
          ),
          child: Icon(icon, size: 18),
        ),
      );

  Widget _navTextKey(ThemeData theme, String label, VoidCallback onTap) =>
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3),
        child: OutlinedButton(
          onPressed: onTap,
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            minimumSize: const Size(0, 36),
          ),
          child: Text(label),
        ),
      );
}
