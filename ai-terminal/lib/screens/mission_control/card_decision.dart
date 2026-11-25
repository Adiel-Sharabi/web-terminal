// #541 - an ask / decision card answered where it is: what its options look like on the face
// (tap one to answer) and in the expanded card (context, each option with its consequence, a
// one-line reply). Nothing here sends or decides: the card holds the state and sends through
// [McReply], the home's reply path ([McPickSender.send], the same one the reply dialog used).

import 'package:flutter/material.dart';

import '../../api/mc_models.dart';
import '../../api/models.dart' show BriefDecision, PendingQuestion, PendingQuestionItem;
import '../../theme/app_theme.dart';

/// How long a tapped option can still be taken back before it is sent.
const Duration kMcUndoWindow = Duration(seconds: 5);

/// How long after a send the card is taken to have been heard: the server drops the ask at once
/// when the session takes the reply, so a card still here this long after was not taken.
const Duration kMcSentGrace = Duration(seconds: 20);

/// Sends [text] as the reply to [card]; true when it went out (a refusal is said by the sender).
typedef McReply = Future<bool> Function(McCard card, String text);

/// Lower case, one space between words, and without the ellipsis a clipped line ends on (the
/// server cuts a wait's own line at 80 characters, so a long question arrives as its start).
String _words(String s) => s.trim().replaceAll(RegExp(r'\s+'), ' ').replaceAll(RegExp('(${String.fromCharCode(0x2026)}|\\.\\.\\.)+\$'), '').trim().toLowerCase();

/// Whether [a] and [b] put the same question: the same words, or one inside the other (a wait's
/// own line often is "Decide: the question (why)"). Empty is never the same as anything.
bool mcSameQuestion(String a, String b) {
  final x = _words(a);
  final y = _words(b);
  if (x.isEmpty || y.isEmpty) return false;
  return x == y || x.contains(y) || y.contains(x);
}

/// The card's decision question when its own line does not already say it; null when it does,
/// so the question is on the face once.
String? mcDecisionQuestionToShow(McCard c) {
  final d = c.decision;
  if (d == null) return null;
  final what = c.what;
  return what != null && mcSameQuestion(what, d.question) ? null : d.question;
}

/// #548 - the first line of a decision's context, for the card's face: what the question is about
/// and why it matters, where the person does not have to open the card to see it. The whole text
/// is in the opened card ([McCardDetail]). Null when the context says nothing.
String? mcContextLine(String? context) {
  if (context == null) return null;
  for (final line in context.split(String.fromCharCode(10))) {
    final t = line.trim();
    if (t.isNotEmpty) return t;
  }
  return null;
}

/// The options on the card's face. With [onPick] a chip answers (an [ActionChip]); [enabled] off
/// while a pick is on its way. Without it they are plain chips, as before the card could answer.
class McCardOptionChips extends StatelessWidget {
  const McCardOptionChips({super.key, required this.decision, required this.onPick, this.enabled = true});

  final BriefDecision decision;
  final void Function(String label)? onPick;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final d = decision;
    return Wrap(spacing: 6, runSpacing: 4, children: [
      for (var i = 0; i < d.options.length; i++)
        if (onPick == null)
          Chip(
            key: ValueKey('mc-card-option-$i'),
            visualDensity: VisualDensity.compact,
            avatar: d.recommended == i ? const Icon(Icons.star, size: 14, color: AppColors.favorite) : null,
            label: Text(d.options[i].label),
          )
        else
          ActionChip(
            key: ValueKey('mc-card-option-$i'),
            visualDensity: VisualDensity.compact,
            avatar: d.recommended == i ? const Icon(Icons.star, size: 14, color: AppColors.favorite) : null,
            label: Text(d.options[i].label),
            tooltip: d.options[i].consequence,
            onPressed: enabled ? () => onPick!(d.options[i].label) : null,
          ),
    ]);
  }
}

/// The expanded card's body: the decision's context, each option with its consequence (the
/// recommended one marked; a tap answers like its chip), and a one-line reply with Send. The
/// reply row exists only when the card can answer ([onSend] non-null).
class McCardDetail extends StatelessWidget {
  const McCardDetail({
    super.key,
    required this.decision,
    required this.controller,
    required this.onPick,
    required this.onSend,
    this.enabled = true,
  });

  /// Null for a possible unreported question (no options; the card's own line is the sentence).
  final BriefDecision? decision;
  final TextEditingController controller;

  /// A tap on an option; null: the card cannot answer, the rows only explain.
  final void Function(String label)? onPick;

  /// Send's action; null: no reply row.
  final VoidCallback? onSend;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall;
    final muted = small?.copyWith(color: AppColors.onSurfaceVariant);
    final d = decision;
    return Column(key: const ValueKey('mc-card-detail'), crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (d?.context != null) ...[
        const SizedBox(height: 6),
        Text(d!.context!, key: const ValueKey('mc-card-decision-context'), style: small),
      ],
      if (d != null) ...[
        const SizedBox(height: 6),
        for (var i = 0; i < d.options.length; i++)
          InkWell(
            key: ValueKey('mc-card-opt-$i'),
            borderRadius: BorderRadius.circular(6),
            onTap: onPick != null && enabled ? () => onPick!(d.options[i].label) : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 2),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(
                  width: 22,
                  child: d.recommended == i
                      ? Icon(Icons.star, key: ValueKey('mc-card-opt-star-$i'), size: 16, color: AppColors.favorite)
                      : null,
                ),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(d.options[i].label, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                    if (d.options[i].consequence != null)
                      Text(d.options[i].consequence!, key: ValueKey('mc-card-opt-consequence-$i'), style: muted),
                  ]),
                ),
              ]),
            ),
          ),
        if (onPick != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text('Tap an option to answer with it; it is sent after a few seconds unless you undo it.', style: muted),
          ),
      ],
      if (onSend != null) ...[
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: TextField(
              key: const ValueKey('mc-card-reply-field'),
              controller: controller,
              enabled: enabled,
              maxLines: 1,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => onSend!(),
              decoration: const InputDecoration(isDense: true, hintText: 'Or your own answer - typed into the session as you'),
            ),
          ),
          const SizedBox(width: 8),
          // The row rebuilds with the field: Send is off until there are words.
          ListenableBuilder(
            listenable: controller,
            builder: (context, _) => FilledButton(
              key: const ValueKey('mc-card-reply-send'),
              onPressed: enabled && controller.text.trim().isNotEmpty ? onSend : null,
              child: const Text('Send'),
            ),
          ),
        ]),
      ],
    ]);
  }
}

/// #541 - whether a pending AskUserQuestion may be answered from the card: exactly ONE question,
/// single-select, no preview (a side-by-side layout reads the keys differently) and at least two
/// options. THE rule: anything else is answered in the sheet, which has the whole panel.
bool mcSimpleQuestion(PendingQuestion q) {
  if (q.questions.length != 1) return false;
  final item = q.questions.single;
  return !item.multiSelect && !item.hasPreview && item.options.length >= 2;
}

/// The options of a simple pending question on the expanded card. A tap picks that option BY
/// INDEX - the answer's keys are built from the index ([buildAnswerFrames]), never from the label,
/// so two options that read alike can never swap. The question itself is on the card's face above.
class McQuestionOptions extends StatelessWidget {
  const McQuestionOptions({super.key, required this.item, required this.onPick, this.enabled = true});

  final PendingQuestionItem item;
  final void Function(int index) onPick;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return Column(key: const ValueKey('mc-card-qoptions'), crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (var i = 0; i < item.options.length; i++)
        InkWell(
          key: ValueKey('mc-card-qopt-$i'),
          borderRadius: BorderRadius.circular(6),
          onTap: enabled ? () => onPick(i) : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 2),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(item.options[i].label, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
              if (item.options[i].description.isNotEmpty) Text(item.options[i].description, style: muted),
            ]),
          ),
        ),
      Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text('Tap an option to answer with it; it is sent after a few seconds unless you undo it.', style: muted),
      ),
    ]);
  }
}
