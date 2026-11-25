// #531 - an Answer-now card answered where it is, inside Mission Control.
//
// "Answer" used to leave for the questions inbox. This sheet answers the same waits without
// leaving: an AskUserQuestion with the answer panel the inbox and the session screen use
// ([QuestionAnswerPanel], which builds the keys with buildAnswerFrames - the one copy of the
// rules), a decision by its options or the person's own words, a reported wait by a reply. The
// sheet decides nothing about HOW anything is written: every effect goes through
// [McAnswerPort] (the home's [McPickSender] over the existing answer paths, with the pre-write
// re-check of what the person saw), and a refusal keeps the sheet open with what was typed.
// A permission is answered on its session's own screen: the sheet says so and opens it.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart' show ApiException;
import '../../api/mc_models.dart';
import '../../api/models.dart';
import '../../theme/app_theme.dart';
import '../../widgets/question_answer_panel.dart';
import '../../widgets/question_overlay.dart' show AnswerFrame;

/// What the answer sheet may do, every one a callback so Mission Control's home gives it the
/// real writers and a test gives it fakes.
class McAnswerPort {
  const McAnswerPort({
    required this.pendingQuestion,
    required this.answerQuestion,
    required this.send,
    required this.openSession,
    this.askAbout,
  });

  /// The AskUserQuestion on the card's session's screen; null when none is pending. Throws
  /// (an [ApiException]) when it cannot be read.
  final Future<PendingQuestion?> Function(McCard card) pendingQuestion;

  /// Answers [shown] with [frames] (the panel's own); true when they went out.
  final Future<bool> Function(McCard card, PendingQuestion shown, List<AnswerFrame> frames) answerQuestion;

  /// Sends the person's words: a decision's chosen label or own words, a wait's reply. True
  /// when it went out.
  final Future<bool> Function(McCard card, String text) send;

  /// Opens the card's session.
  final void Function(McCard card) openSession;

  /// Opens the Analyst's panel for the card with its box ready; null: not offered.
  final void Function(McCard card)? askAbout;
}

class McAnswerSheet extends StatefulWidget {
  const McAnswerSheet({super.key, required this.card, required this.port});

  final McCard card;
  final McAnswerPort port;

  /// Opens the sheet as a page over the current one.
  static Future<void> open(BuildContext context, {required McCard card, required McAnswerPort port}) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => McAnswerSheet(card: card, port: port)));

  @override
  State<McAnswerSheet> createState() => _McAnswerSheetState();
}

class _McAnswerSheetState extends State<McAnswerSheet> {
  Future<PendingQuestion?>? _question;
  final TextEditingController _text = TextEditingController();
  bool _busy = false;

  McCard get _card => widget.card;

  @override
  void initState() {
    super.initState();
    if (_card.kind == 'question') _question = widget.port.pendingQuestion(_card);
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  /// Runs [send]; the sheet closes when it went out, and stays (with what was typed) when not.
  Future<void> _run(Future<bool> Function() send) async {
    if (_busy) return;
    setState(() => _busy = true);
    var ok = false;
    try {
      ok = await send();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (ok && mounted) Navigator.of(context).pop();
  }

  Future<void> _sendText() async {
    final words = _text.text.trim();
    if (words.isEmpty) return;
    await _run(() => widget.port.send(_card, words));
  }

  @override
  Widget build(BuildContext context) {
    final c = _card;
    final heading = [?c.ref, ?c.title].join('  ');
    return Scaffold(
      key: const ValueKey('mc-answer-sheet'),
      appBar: AppBar(
        title: Text(heading.isEmpty ? (c.sessionName ?? 'Answer') : heading, overflow: TextOverflow.ellipsis),
        actions: [
          if (widget.port.askAbout != null)
            TextButton.icon(
              key: const ValueKey('mc-answer-ask'),
              onPressed: () => widget.port.askAbout!(c),
              icon: const Icon(Icons.help_outline),
              label: const Text('Ask about this'),
            ),
        ],
      ),
      body: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 760), child: _body(context)),
      ),
    );
  }

  Widget _body(BuildContext context) => switch (_card.kind) {
        'question' => _questionBody(context),
        'decision' when _card.decision != null => _decisionBody(context, _card.decision!),
        'wait' || 'decision' => _waitBody(context),
        _ => _elsewhereBody(context),
      };

  /// Where the card names its session and who is asking: a line over every body.
  Widget _from(BuildContext context) {
    final muted = Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final line = _card.sessionLine;
    return line.isEmpty ? const SizedBox.shrink() : Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text(line, style: muted));
  }

  // --- an AskUserQuestion ---------------------------------------------------------------

  Widget _questionBody(BuildContext context) {
    final theme = Theme.of(context);
    return FutureBuilder<PendingQuestion?>(
      future: _question,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          final e = snap.error;
          return _notice(
            context,
            key: const ValueKey('mc-answer-error'),
            text: e is ApiException ? e.message : 'The question could not be read ($e)',
            color: theme.colorScheme.error,
            action: _openSessionButton(),
          );
        }
        final q = snap.data;
        if (q == null) {
          return _notice(
            context,
            key: const ValueKey('mc-answer-gone'),
            text: 'This question is no longer on its screen: it was answered, or the session moved on.',
            action: _openSessionButton(),
          );
        }
        return Column(children: [
          if (_busy) const LinearProgressIndicator(key: ValueKey('mc-answer-busy')),
          _from(context),
          Expanded(
            child: AbsorbPointer(
              absorbing: _busy,
              child: Align(
                alignment: Alignment.topCenter,
                child: QuestionAnswerPanel(
                  key: const ValueKey('mc-answer-panel'),
                  question: q,
                  elsewhereLabel: 'Open session',
                  onDismiss: () => widget.port.openSession(_card),
                  onSend: (frames) => unawaited(_run(() => widget.port.answerQuestion(_card, q, frames))),
                ),
              ),
            ),
          ),
        ]);
      },
    );
  }

  // --- a decision -----------------------------------------------------------------------

  Widget _decisionBody(BuildContext context, BriefDecision d) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
      if (_busy) const LinearProgressIndicator(key: ValueKey('mc-answer-busy')),
      _from(context),
      const SizedBox(height: 8),
      Text(d.question, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
      if (d.context != null) ...[const SizedBox(height: 6), Text(d.context!, style: theme.textTheme.bodyMedium)],
      const SizedBox(height: 12),
      for (var i = 0; i < d.options.length; i++)
        Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    if (d.recommended == i) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.star, size: 16, color: AppColors.favorite)),
                    Expanded(child: Text(d.options[i].label, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600))),
                  ]),
                  if (d.options[i].consequence != null) Text(d.options[i].consequence!, style: muted),
                ]),
              ),
              const SizedBox(width: 8),
              FilledButton.tonal(
                key: ValueKey('mc-answer-option-$i'),
                onPressed: _busy ? null : () => _run(() => widget.port.send(_card, d.options[i].label)),
                child: const Text('Choose'),
              ),
            ]),
          ),
        ),
      const SizedBox(height: 8),
      Text('Or in your own words', style: muted),
      _replyBox(context, hint: 'Your answer'),
    ]);
  }

  // --- a reported wait ------------------------------------------------------------------

  Widget _waitBody(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
      if (_busy) const LinearProgressIndicator(key: ValueKey('mc-answer-busy')),
      _from(context),
      const SizedBox(height: 8),
      if (_card.what != null) Text(_card.what!, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
      _replyBox(context, hint: 'Your reply'),
    ]);
  }

  Widget _replyBox(BuildContext context, {required String hint}) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            child: TextField(
              key: const ValueKey('mc-answer-text'),
              controller: _text,
              enabled: !_busy,
              minLines: 1,
              maxLines: 5,
              decoration: InputDecoration(hintText: hint),
            ),
          ),
          IconButton(
            key: const ValueKey('mc-answer-send'),
            tooltip: 'Send',
            onPressed: _busy ? null : _sendText,
            icon: const Icon(Icons.send),
          ),
        ]),
      );

  // --- not answered here ----------------------------------------------------------------

  Widget _elsewhereBody(BuildContext context) => _notice(
        context,
        key: const ValueKey('mc-answer-permission'),
        text: _card.kind == 'permission'
            ? 'A permission prompt is answered on its session\'s own screen.'
            : 'This is answered in its session.',
        action: _openSessionButton(),
      );

  Widget _openSessionButton() => FilledButton.icon(
        key: const ValueKey('mc-answer-open-session'),
        onPressed: () => widget.port.openSession(_card),
        icon: const Icon(Icons.open_in_new, size: 18),
        label: const Text('Open session'),
      );

  Widget _notice(BuildContext context, {required Key key, required String text, Color? color, required Widget action}) => Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(text, key: key, style: TextStyle(color: color)),
          const SizedBox(height: 12),
          action,
        ]),
      );
}
