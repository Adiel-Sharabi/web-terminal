// #510 - a question card, read before it is answered: three levels of context, a follow-up
// about any option (answered by the Analyst, under that option), options the Analyst
// suggests, and the options compared side by side.
//
// Every word here comes from the server ([McQuestionDesk]); the panel decides nothing. Only
// "Send as answer" on a suggestion reaches the waiting session, through [McPickSender] (the
// existing answer paths), after the person confirms. The card's own options are answered
// where they always were: "Answer" opens the questions inbox.

import 'package:flutter/material.dart';

import '../../api/mc_ask_models.dart';
import '../../api/mc_models.dart';
import '../../services/mc_analyst.dart';
import '../../services/mc_question_desk.dart';
import '../../theme/app_theme.dart';

/// What a question card needs to open its panel; placed by Mission Control's home above
/// every screen that shows an [McCard] (Now, a subject). Absent: no panel is offered.
class McQuestionScope extends InheritedWidget {
  const McQuestionScope({super.key, required this.analyst, required this.onSend, required this.onAnswer, required super.child});

  final McAnalyst analyst;

  /// Sends the person's final pick as the card's answer ([shown]: the ask the panel showed, which
  /// must still be the one asked); true when it went out.
  final Future<bool> Function(McCard card, String text, McQuestionAsk? shown) onSend;

  /// Opens the card's question where it is answered (the inbox).
  final void Function(McCard card) onAnswer;

  static McQuestionScope? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<McQuestionScope>();

  /// Opens [card]'s panel as a page over the current one.
  void open(BuildContext context, McCard card) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => McQuestionPanel(card: card, analyst: analyst, onSend: onSend, onAnswer: () => onAnswer(card)),
    ));
  }

  @override
  bool updateShouldNotify(McQuestionScope old) => old.analyst != analyst || old.onSend != onSend || old.onAnswer != onAnswer;
}

class McQuestionPanel extends StatefulWidget {
  const McQuestionPanel({super.key, required this.card, required this.analyst, required this.onSend, this.onAnswer, this.desk});

  final McCard card;
  final McAnalyst analyst;
  final Future<bool> Function(McCard card, String text, McQuestionAsk? shown) onSend;
  final VoidCallback? onAnswer;

  /// Injectable for tests.
  final McQuestionDesk? desk;

  @override
  State<McQuestionPanel> createState() => _McQuestionPanelState();
}

class _McQuestionPanelState extends State<McQuestionPanel> {
  late final McQuestionDesk _desk = widget.desk ?? McQuestionDesk(analyst: widget.analyst, cardId: widget.card.id);

  /// The option whose follow-up box is open (-1: none; null key: the whole question).
  int? _asking = -1;
  final TextEditingController _followup = TextEditingController();
  bool _compare = false;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _desk.show('ask');
  }

  @override
  void dispose() {
    if (widget.desk == null) _desk.dispose();
    _followup.dispose();
    super.dispose();
  }

  Future<void> _send(McSuggestion s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Send this answer?'),
        content: Text('"${s.label}" goes to ${widget.card.sessionName ?? 'the session'} as your answer.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          FilledButton(key: const ValueKey('mcq-send-confirm'), onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Send')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _sending = true);
    var sent = false;
    try {
      sent = await widget.onSend(widget.card, s.label, _desk.ask);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
    if (sent && mounted) Navigator.of(context).pop();
  }

  void _ask(int? option) {
    final q = _followup.text;
    // One follow-up at a time: while one runs, the words stay in the box.
    if (q.trim().isEmpty || _desk.followupBusy) return;
    _followup.clear();
    _desk.followup(option, q);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.card;
    final heading = [?c.ref, ?c.title].join('  ');
    return Scaffold(
      appBar: AppBar(
        title: Text(heading.isEmpty ? (c.sessionName ?? 'Question') : heading, overflow: TextOverflow.ellipsis),
        actions: [
          if (widget.onAnswer != null && c.answerable)
            TextButton.icon(
              key: const ValueKey('mcq-answer'),
              onPressed: () {
                Navigator.of(context).pop();
                widget.onAnswer!();
              },
              icon: const Icon(Icons.reply),
              label: const Text('Answer'),
            ),
        ],
      ),
      body: ListenableBuilder(
        listenable: _desk,
        builder: (context, _) => ListView(
          key: const ValueKey('mcq-list'),
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 32),
          children: [
            _levels(),
            const SizedBox(height: 8),
            ..._contextView(),
            const Divider(height: 24),
            ..._optionsView(),
            const Divider(height: 24),
            ..._suggestView(),
          ],
        ),
      ),
    );
  }

  Widget _levels() => SegmentedButton<String>(
        key: const ValueKey('mcq-levels'),
        segments: [for (final (id, label) in kMcContextLevels) ButtonSegment(value: id, label: Text(label, key: ValueKey('mcq-level-$id')))],
        selected: {_desk.level},
        onSelectionChanged: (s) => _desk.show(s.first),
      );

  List<Widget> _contextView() {
    final theme = Theme.of(context);
    final ctx = _desk.context;
    if (_desk.loading && ctx == null) return const [Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()))];
    if (_desk.contextError != null) {
      return [Text(_desk.contextError!, key: const ValueKey('mcq-context-error'), style: TextStyle(color: theme.colorScheme.error))];
    }
    if (ctx == null) return const [];
    return [
      for (final s in ctx.sections)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(s.title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 2),
            SelectableText(s.body, key: ValueKey('mcq-section-${s.title}')),
          ]),
        ),
    ];
  }

  List<Widget> _optionsView() {
    final theme = Theme.of(context);
    final ask = _desk.ask;
    if (ask == null) return const [];
    final options = ask.options;
    return [
      Row(children: [
        Expanded(child: Text('Options', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
        if (options.length > 1)
          TextButton.icon(
            key: const ValueKey('mcq-compare'),
            onPressed: () => setState(() => _compare = !_compare),
            icon: Icon(_compare ? Icons.view_agenda_outlined : Icons.compare_arrows),
            label: Text(_compare ? 'List' : 'Compare'),
          ),
      ]),
      if (options.isEmpty) ...[
        Text('No options: the session waits for your words.', style: theme.textTheme.bodySmall),
        _followupBlock(null, 'Ask about this'),
      ] else if (_compare)
        _compareTable(options)
      else
        for (final o in options) _optionTile(o),
    ];
  }

  Widget _optionTile(McAskOption o) {
    final theme = Theme.of(context);
    return Card(
      key: ValueKey('mcq-option-${o.index}'),
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            if (o.recommended) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.star, size: 16, color: AppColors.favorite)),
            Expanded(child: Text('${o.index + 1}. ${o.label}', style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600))),
          ]),
          if (o.detail != null) Text(o.detail!, style: theme.textTheme.bodySmall),
          _followupBlock(o.index, 'Ask about this option'),
        ]),
      ),
    );
  }

  /// The follow-ups about [option] and, when open, the box to ask one.
  Widget _followupBlock(int? option, String label) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final keyPart = option?.toString() ?? 'all';
    final open = _asking == option;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final f in _desk.followupsFor(option))
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('You: ${f.question}', style: muted),
            if (f.pending)
              const Padding(padding: EdgeInsets.all(4), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)))
            else if (f.error != null)
              Text(f.error!, style: TextStyle(color: theme.colorScheme.error))
            else
              SelectableText(f.answer!.answer, key: ValueKey('mcq-followup-answer-$keyPart')),
          ]),
        ),
      if (open)
        Row(children: [
          Expanded(
            child: TextField(
              key: ValueKey('mcq-followup-field-$keyPart'),
              controller: _followup,
              autofocus: true,
              maxLength: 2000,
              decoration: const InputDecoration(hintText: 'Your question - the session does not see it', counterText: ''),
              onSubmitted: (_) => _ask(option),
            ),
          ),
          IconButton(
            key: ValueKey('mcq-followup-send-$keyPart'),
            tooltip: 'Ask the Analyst',
            onPressed: _desk.followupBusy ? null : () => _ask(option),
            icon: const Icon(Icons.send),
          ),
        ])
      else
        TextButton(
          key: ValueKey('mcq-followup-open-$keyPart'),
          onPressed: () => setState(() {
            _asking = option;
            _followup.clear();
          }),
          child: Text(label),
        ),
    ]);
  }

  /// The options side by side: what each does, and the newest follow-up answer about it.
  Widget _compareTable(List<McAskOption> options) {
    final theme = Theme.of(context);
    final suggested = _desk.suggestions?.options ?? const <McSuggestion>[];
    TableRow row(List<String> cells, {bool head = false}) => TableRow(
          decoration: head ? BoxDecoration(color: theme.colorScheme.surfaceContainerHighest) : null,
          children: [
            for (final t in cells)
              Padding(
                padding: const EdgeInsets.all(6),
                child: Text(t, style: head ? theme.textTheme.labelLarge : theme.textTheme.bodySmall),
              ),
          ],
        );
    String lastAnswer(int i) {
      final done = _desk.followupsFor(i).where((f) => f.answer != null).toList();
      return done.isEmpty ? '-' : done.last.answer!.answer;
    }

    return SingleChildScrollView(
      key: const ValueKey('mcq-compare-table'),
      scrollDirection: Axis.horizontal,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minWidth: 560, maxWidth: 900),
        child: Table(
          border: TableBorder.all(color: AppColors.outline.withValues(alpha: 0.5)),
          columnWidths: const {0: FlexColumnWidth(2), 1: FlexColumnWidth(3), 2: FlexColumnWidth(3)},
          children: [
            row(['Option', 'What it does', 'What the Analyst said'], head: true),
            for (final o in options) row(['${o.index + 1}. ${o.label}${o.recommended ? ' (recommended)' : ''}', o.detail ?? 'not said', lastAnswer(o.index)]),
            for (final s in suggested) row(['Suggested: ${s.label}', s.consequence ?? 'not said', '-']),
          ],
        ),
      ),
    );
  }

  List<Widget> _suggestView() {
    final theme = Theme.of(context);
    final ask = _desk.ask;
    final sug = _desk.suggestions;
    final canSend = (sug?.canSend ?? ask?.canSuggest ?? false) && widget.card.kind != 'permission';
    return [
      Row(children: [
        Expanded(child: Text('More options', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
        TextButton.icon(
          key: const ValueKey('mcq-suggest'),
          onPressed: _desk.suggesting ? null : _desk.suggest,
          icon: _desk.suggesting
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.lightbulb_outline),
          label: Text(sug == null ? 'Suggest more options' : 'Suggest again'),
        ),
      ]),
      if (_desk.suggestError != null) Text(_desk.suggestError!, key: const ValueKey('mcq-suggest-error'), style: TextStyle(color: theme.colorScheme.error)),
      if (sug != null && !canSend)
        Text('This question takes only its own options here: open it to answer.', key: const ValueKey('mcq-cannot-send'), style: theme.textTheme.bodySmall),
      for (final (i, s) in (sug?.options ?? const <McSuggestion>[]).indexed)
        Card(
          key: ValueKey('mcq-suggestion-$i'),
          margin: const EdgeInsets.only(bottom: 8),
          child: ListTile(
            title: Text(s.label),
            subtitle: s.consequence == null ? null : Text(s.consequence!),
            trailing: canSend
                ? FilledButton.tonal(
                    key: ValueKey('mcq-send-$i'),
                    onPressed: _sending ? null : () => _send(s),
                    child: const Text('Send as answer'),
                  )
                : null,
          ),
        ),
    ];
  }
}
