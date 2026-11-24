// #526 - the reply to an ask: a decision the session holds for the person and works around, or a
// question its last reply may have put that it never reported.
//
// The questions inbox lists only what a session WAITS on, and an ask's session is moving on, so
// "Answer" on an ask card opens this instead: the question as the server worded it, its context
// (why it matters, what was found), the options of its decision (a tap fills the box), and a box
// for the person's own words. Sending goes through [McPickSender]'s `ask` / `possible-ask` case -
// the existing reply path, which re-reads the session and refuses once it no longer holds it. The
// answer of an ask is typed behind the card's own prefix, which names the decision it answers.
// Nothing here decides anything.

import 'package:flutter/material.dart';

import '../../api/mc_models.dart';

class McAskReplyDialog extends StatefulWidget {
  const McAskReplyDialog({super.key, required this.card, required this.onSend});

  final McCard card;

  /// Sends [text] as the reply to [card]; true when it went out (the refusal is said by the sender).
  final Future<bool> Function(McCard card, String text) onSend;

  @override
  State<McAskReplyDialog> createState() => _McAskReplyDialogState();
}

class _McAskReplyDialogState extends State<McAskReplyDialog> {
  final TextEditingController _text = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final words = _text.text.trim();
    if (words.isEmpty || _sending) return;
    setState(() => _sending = true);
    var sent = false;
    try {
      sent = await widget.onSend(widget.card, words);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
    if (sent && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.card;
    final d = c.decision;
    final theme = Theme.of(context);
    return AlertDialog(
      title: Text(c.sessionName ?? 'Reply', overflow: TextOverflow.ellipsis),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (c.isPossibleAsk)
              Text('Its last reply may ask you this; it is on none of its lists:',
                  key: const ValueKey('mc-ask-reply-possible'), style: theme.textTheme.bodySmall),
            if (c.maybeAnswered)
              Text('You wrote to this session after it asked, so this may be answered.',
                  key: const ValueKey('mc-ask-reply-maybe'), style: theme.textTheme.bodySmall),
            Text(d?.question ?? c.what ?? '', key: const ValueKey('mc-ask-reply-question')),
            if (d?.context != null) ...[
              const SizedBox(height: 6),
              Text(d!.context!, style: theme.textTheme.bodySmall),
            ],
            if (d != null) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 4, children: [
                for (var i = 0; i < d.options.length; i++)
                  ActionChip(
                    key: ValueKey('mc-ask-reply-option-$i'),
                    avatar: d.recommended == i ? const Icon(Icons.star, size: 14) : null,
                    label: Text(d.options[i].label),
                    tooltip: d.options[i].consequence,
                    onPressed: () => setState(() => _text.text = d.options[i].label),
                  ),
              ]),
            ],
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('mc-ask-reply-field'),
              controller: _text,
              autofocus: true,
              minLines: 1,
              maxLines: 5,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(hintText: 'Your answer - typed into the session as you'),
            ),
          ]),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          key: const ValueKey('mc-ask-reply-send'),
          onPressed: _sending || _text.text.trim().isEmpty ? null : _send,
          child: const Text('Send'),
        ),
      ],
    );
  }
}
