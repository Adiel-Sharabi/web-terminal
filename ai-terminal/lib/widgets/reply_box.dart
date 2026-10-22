import 'package:flutter/material.dart';

/// The reply under a "waiting on you" card (#337). Sends through [onSend], which
/// submits exactly as the compose bar does. One line by default; [multiline] gives a
/// box that grows, where Enter is a newline and the button sends.
class ReplyBox extends StatefulWidget {
  const ReplyBox({
    super.key,
    required this.controller,
    required this.name,
    required this.ready,
    required this.busy,
    required this.onSend,
    this.multiline = false,
  });
  final TextEditingController controller;
  final String name;
  final bool ready;
  final bool busy;
  final Future<bool> Function(String text) onSend;
  final bool multiline;

  @override
  State<ReplyBox> createState() => _ReplyBoxState();
}

final ButtonStyle _smallFilled = FilledButton.styleFrom(
  visualDensity: VisualDensity.compact,
  padding: const EdgeInsets.symmetric(horizontal: 12),
  minimumSize: const Size(0, 30),
  textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
);

class _ReplyBoxState extends State<ReplyBox> {
  TextEditingController get _text => widget.controller;

  Future<void> _send() async {
    final t = _text.text;
    if (t.trim().isEmpty || widget.busy || !widget.ready) return;
    // The words stay in the box until they are DELIVERED to an attached session; if
    // the agent then does not take them, the board puts them back (#179).
    if (await widget.onSend(t) && mounted && _text.text == t) _text.clear();
  }

  @override
  Widget build(BuildContext context) {
    final canSend = widget.ready && !widget.busy;
    final multiline = widget.multiline;
    return Row(crossAxisAlignment: multiline ? CrossAxisAlignment.end : CrossAxisAlignment.center, children: [
      Expanded(
        child: TextField(
          key: const ValueKey('board-reply-field'),
          controller: _text,
          minLines: 1,
          maxLines: multiline ? 6 : 1,
          keyboardType: multiline ? TextInputType.multiline : null,
          textInputAction: multiline ? TextInputAction.newline : TextInputAction.send,
          onSubmitted: multiline ? null : (_) => _send(),
          style: const TextStyle(fontSize: 13),
          decoration: InputDecoration(
            isDense: true,
            hintText: widget.ready ? 'Reply to this session…' : 'Starting the agent…',
            border: const OutlineInputBorder(),
            contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          ),
        ),
      ),
      const SizedBox(width: 6),
      Tooltip(
        message: widget.ready ? 'Send to ${widget.name}' : 'Starting the agent',
        child: FilledButton(
          key: const ValueKey('board-reply-send'),
          style: _smallFilled,
          onPressed: canSend ? _send : null,
          child: const Text('Send'),
        ),
      ),
    ]);
  }
}
