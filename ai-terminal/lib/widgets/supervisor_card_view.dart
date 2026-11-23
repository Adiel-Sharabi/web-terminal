// #498 - a supervisor recommendation card that explains itself: who proposes it (the
// supervisor), what, to which session and work item, what Approve will do, and why the owner is
// asked. The raw line the supervisor would type is folded behind "details".
//
// Every sentence that says what happens comes from the server (lib/supervisor-cases.js
// cardView: `title`, `does`; the reason in `why`). The app holds no table of classes: an older
// server that sends none of it gets the card as it was (the raw text, then the reason).
import 'package:flutter/material.dart';

import '../api/models.dart' show BriefItem;
import '../api/supervisor_models.dart' show SupervisorCard, SupervisorCase, SupervisorItem;
import 'brief_item_row.dart';
import 'directional_text.dart';

/// A work item the authority's scan reported, as the row every other card draws.
BriefItem _briefItem(SupervisorItem i) => BriefItem(ref: i.ref ?? '', key: i.ref ?? '', title: i.title ?? '', state: i.state);

/// What the folded raw text is, by what Approve does with it.
String cardDetailsLabel(SupervisorCard c) => switch (c.cls) {
      'spawn' => 'The note the new session starts from',
      'close' => 'The supervisor\'s words',
      _ => 'The message it would type',
    };

/// The snack bar after a decision went through (#498). [name] is the session's.
String cardDoneText(String decision, String name, {DateTime? until}) => switch (decision) {
      'approve' => 'Approved',
      'dismiss' => 'Dismissed',
      'send' => 'Sent to $name',
      'tell' => 'Told the supervisor',
      'later' => until == null ? 'Put off' : 'Put off until ${_hm(until)}',
      _ => 'Done',
    };

/// The start of the snack bar when the server refused; its plain-words reason follows.
String cardFailText(String decision) => switch (decision) {
      'approve' => 'Not approved',
      'dismiss' => 'Not dismissed',
      'send' => 'Not sent',
      'tell' => 'Not told',
      'later' => 'Not put off',
      _ => 'Not done',
    };

String _hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// The card in the list: what is proposed, what Approve does, its work item, and the reason.
class SupervisorCardSummary extends StatelessWidget {
  const SupervisorCardSummary(this.card, {super.key});
  final SupervisorCard card;

  @override
  Widget build(BuildContext context) {
    final c = card;
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    if (c.does == null) {
      // An older server: the raw line and the reason, as before.
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text(c.text, maxLines: 3, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyLarge?.copyWith(height: 1.4)),
        if ((c.why ?? '').isNotEmpty)
          Text(c.why!, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: muted)),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      _Proposer(card: c),
      const SizedBox(height: 4),
      Text(c.does!,
          key: ValueKey('card-does-${c.id}'),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyLarge?.copyWith(height: 1.4)),
      if (c.targetItems.isNotEmpty) ...[const SizedBox(height: 6), BriefItemRow(_briefItem(c.targetItems.first))],
      if ((c.why ?? '').isNotEmpty) ...[
        const SizedBox(height: 6),
        Text('Why you are asked: ${c.why}',
            maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: muted, height: 1.35)),
      ],
    ]);
  }
}

/// The card in the focused view: everything, with the raw text under "details".
class SupervisorCardDetail extends StatelessWidget {
  const SupervisorCardDetail(this.card, {super.key});
  final SupervisorCard card;

  @override
  Widget build(BuildContext context) {
    final c = card;
    final theme = Theme.of(context);
    final body = theme.textTheme.bodyLarge?.copyWith(height: 1.45);
    if (c.does == null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        _heading(context, 'The supervisor would'),
        DirectionalText(c.text, style: theme.textTheme.titleMedium?.copyWith(height: 1.4)),
        if ((c.why ?? '').isNotEmpty) ...[_heading(context, 'Why it asks'), DirectionalText(c.why!, style: body)],
      ]);
    }
    final headline = c.targetHeadline;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      _Proposer(card: c, large: true),
      _heading(context, 'What Approve does'),
      Text(c.does!, key: ValueKey('card-detail-does-${c.id}'), style: body),
      if (c.targetItems.isNotEmpty || (headline ?? '').isNotEmpty) ...[
        _heading(context, 'The session'),
        for (final i in c.targetItems)
          Padding(padding: const EdgeInsets.only(bottom: 4), child: BriefItemRow(_briefItem(i))),
        if ((headline ?? '').isNotEmpty)
          DirectionalText(headline!, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant, height: 1.4)),
      ],
      if ((c.why ?? '').isNotEmpty) ...[_heading(context, 'Why you are asked'), DirectionalText(c.why!, style: body)],
      const SizedBox(height: 8),
      _Details(card: c),
    ]);
  }

  Widget _heading(BuildContext context, String text) => Padding(
        padding: const EdgeInsets.only(top: 14, bottom: 4),
        child: Text(text, style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );
}

/// "The supervisor proposes: <title>", the one line that says who is speaking.
class _Proposer extends StatelessWidget {
  const _Proposer({required this.card, this.large = false});
  final SupervisorCard card;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.primary;
    final style = (large ? theme.textTheme.titleMedium : theme.textTheme.labelLarge)?.copyWith(color: color);
    return Row(children: [
      Icon(Icons.support_agent, size: large ? 20 : 16, color: color),
      const SizedBox(width: 6),
      Expanded(
        child: Text('The supervisor proposes: ${card.title ?? 'an action'}',
            key: ValueKey('card-title-${card.id}'), maxLines: 2, overflow: TextOverflow.ellipsis, style: style),
      ),
    ]);
  }
}

/// The raw line, folded until asked for: selectable, whole.
class _Details extends StatelessWidget {
  const _Details({required this.card});
  final SupervisorCard card;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Theme(
      // The tile draws no dividers of its own: the card's own edges frame it.
      data: theme.copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: ValueKey('card-details-${card.id}'),
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 8),
        expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
        title: Text('Details: ${cardDetailsLabel(card).toLowerCase()}', style: theme.textTheme.labelLarge),
        children: [SelectableText(card.text, style: theme.textTheme.bodyMedium?.copyWith(height: 1.45))],
      ),
    );
  }
}

/// The snack bar after an answer to an escalated case went through (#498).
String caseDoneText(String action, String name, {DateTime? until}) => switch (action) {
      'write' => 'Sent to $name',
      'tell' => 'Told the supervisor',
      'later' => until == null ? 'Put off' : 'Put off until ${_hm(until)}',
      'resolve' => 'Closed: nothing needed',
      _ => 'Done',
    };

/// The start of the snack bar when the server refused an answer to a case.
String caseFailText(String action) => switch (action) {
      'write' => 'Not sent',
      'tell' => 'Not told',
      'later' => 'Not put off',
      'resolve' => 'Not closed',
      _ => 'Not done',
    };

/// #498 - an escalated case in the list: what it is (a question the supervisor asks, or a
/// fact the rules raised), what the owner is asked to do, and why it reached them. Every
/// sentence is the server's (lib/supervisor-cases.js caseOwnerView).
class SupervisorCaseSummary extends StatelessWidget {
  const SupervisorCaseSummary(this.supCase, {super.key});
  final SupervisorCase supCase;

  @override
  Widget build(BuildContext context) {
    final c = supCase;
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final question = c.ownerKind == 'question';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      _CaseHeading(supCase: c),
      const SizedBox(height: 4),
      Text(c.ask ?? c.line,
          key: ValueKey('case-ask-${c.id}'),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyLarge?.copyWith(height: 1.4)),
      if (!question && c.line.isNotEmpty) ...[
        const SizedBox(height: 4),
        Text('What it saw: ${c.line}', maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: muted, height: 1.35)),
      ],
      if ((c.whyYou ?? '').isNotEmpty) ...[
        const SizedBox(height: 4),
        Text('Why you are asked: ${c.whyYou}',
            maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: muted, height: 1.35)),
      ],
    ]);
  }
}

/// #498 - an escalated case in the focused view: the same, unclipped.
class SupervisorCaseDetail extends StatelessWidget {
  const SupervisorCaseDetail(this.supCase, {super.key});
  final SupervisorCase supCase;

  @override
  Widget build(BuildContext context) {
    final c = supCase;
    final theme = Theme.of(context);
    final body = theme.textTheme.bodyLarge?.copyWith(height: 1.45);
    Widget heading(String t) => Padding(
          padding: const EdgeInsets.only(top: 14, bottom: 4),
          child: Text(t, style: theme.textTheme.labelLarge?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        );
    final question = c.ownerKind == 'question';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      _CaseHeading(supCase: c, large: true),
      heading(question ? 'Its question' : 'What you can do'),
      DirectionalText(c.ask ?? c.line, key: ValueKey('case-detail-ask-${c.id}'), style: body),
      if (!question && c.line.isNotEmpty) ...[heading('What the supervisor saw'), DirectionalText(c.line, style: body)],
      if ((c.whyYou ?? '').isNotEmpty) ...[heading('Why you are asked'), DirectionalText(c.whyYou!, style: body)],
    ]);
  }
}

/// "The supervisor asks" / "Stuck: <title>", with whose session it is.
class _CaseHeading extends StatelessWidget {
  const _CaseHeading({required this.supCase, this.large = false});
  final SupervisorCase supCase;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final c = supCase;
    final theme = Theme.of(context);
    final question = c.ownerKind == 'question';
    final color = question ? theme.colorScheme.primary : theme.colorScheme.tertiary;
    final style = (large ? theme.textTheme.titleMedium : theme.textTheme.labelLarge)?.copyWith(color: color);
    final title = question ? (c.title ?? 'The supervisor asks') : 'Stuck: ${c.title ?? 'it looks stuck'}';
    return Row(children: [
      Icon(question ? Icons.support_agent : Icons.report_outlined, size: large ? 20 : 16, color: color),
      const SizedBox(width: 6),
      Expanded(child: Text(title, key: ValueKey('case-title-${c.id}'), maxLines: 2, overflow: TextOverflow.ellipsis, style: style)),
    ]);
  }
}

/// The owner's words for "Edit, then send" and "Tell the supervisor": one line (Enter sends;
/// the gated prompt takes no line breaks), with an optional checkbox. Pops
/// `({String text, bool checked})`, or null on Cancel.
class CardTextDialog extends StatefulWidget {
  const CardTextDialog({
    super.key,
    required this.title,
    required this.explain,
    required this.action,
    this.initial = '',
    this.hint,
    this.checkLabel,
    this.allowEmptyWhenChecked = false,
  });
  final String title;

  /// One sentence on what happens when sent.
  final String explain;
  final String action;
  final String initial;
  final String? hint;

  /// A checkbox under the field, when set ("Don't ask me about cards like this again").
  final String? checkLabel;

  /// Sending with an empty field is allowed once the box is ticked.
  final bool allowEmptyWhenChecked;

  @override
  State<CardTextDialog> createState() => _CardTextDialogState();
}

class _CardTextDialogState extends State<CardTextDialog> {
  late final TextEditingController _c = TextEditingController(text: widget.initial);
  bool _checked = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// The gated prompt takes one line. A pasted line break is refused and explained, never
  /// rewritten behind the owner's back.
  bool get _multiLine => _c.text.contains(RegExp(r'[\r\n]'));

  bool get _ready => !_multiLine && (_c.text.trim().isNotEmpty || (widget.allowEmptyWhenChecked && _checked));

  void _send() {
    if (!_ready) return;
    Navigator.of(context).pop((text: _c.text.trim(), checked: _checked));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 520,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(widget.explain, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('card-dialog-text'),
            controller: _c,
            autofocus: true,
            minLines: 2,
            maxLines: 6,
            maxLength: 400,
            keyboardType: TextInputType.text,
            textInputAction: TextInputAction.send,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _send(),
            decoration: InputDecoration(
              hintText: widget.hint,
              border: const OutlineInputBorder(),
              errorText: _multiLine ? 'One line only: it is typed as a single prompt. Remove the line breaks.' : null,
            ),
          ),
          if (widget.checkLabel != null)
            CheckboxListTile(
              key: const ValueKey('card-dialog-check'),
              value: _checked,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(widget.checkLabel!),
              onChanged: (v) => setState(() => _checked = v ?? false),
            ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(key: const ValueKey('card-dialog-send'), onPressed: _ready ? _send : null, child: Text(widget.action)),
      ],
    );
  }
}
