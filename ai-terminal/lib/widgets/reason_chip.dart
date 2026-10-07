/// `ReasonChip` — WHY a session that is not working is not working (#313).
///
/// The server decides the reason (`lib/session-reason.js`) and publishes it on every
/// session row; this widget only draws it, matching `app.html`'s `reasonChipHtml`:
/// a filled attention chip for "your move", blue for "running on its own", an
/// outline for "blocked on others", a muted word for "done". No reason, or a running
/// turn, draws nothing, so a row looks exactly as it did before.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';

/// A duration as a short age: 45s, 12m, 3h, 14d.
String durShort(int ms) {
  final s = ms < 0 ? 0 : ms ~/ 1000;
  if (s < 60) return '${s}s';
  if (s < 3600) return '${s ~/ 60}m';
  if (s < 86400) return '${s ~/ 3600}h';
  return '${s ~/ 86400}d';
}

/// The chip's words for [r], or '' when it draws nothing.
String reasonLabel(SessionReason? r, {DateTime? now}) {
  if (r == null) return '';
  final nowMs = (now ?? DateTime.now()).millisecondsSinceEpoch;
  switch (r.kind) {
    case 'you':
      return r.text.isEmpty ? 'Your move' : 'You: ${r.text}';
    case 'self':
      if (r.source == 'usage-limit') {
        final until = r.until;
        if (until == null) return 'Usage cap';
        final t = DateTime.fromMillisecondsSinceEpoch(until);
        return 'Cap resets · ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
      }
      final what = r.text.isEmpty ? 'On its own' : r.text;
      return r.since == null ? what : '$what · ${durShort(nowMs - r.since!)}';
    case 'external':
      return r.text.isEmpty ? 'Blocked on others' : 'Blocked: ${r.text}';
    case 'done':
      return 'Done';
  }
  return '';
}

/// Whether [r] draws a chip at all (a running turn keeps "Working").
bool hasReasonChip(SessionReason? r) => r != null && r.kind != 'working';

class ReasonChip extends StatelessWidget {
  const ReasonChip({super.key, required this.reason});

  final SessionReason reason;

  static const _self = StatusColor.capped; // "resumes by itself", like a cap
  static const _external = Color(0xFFA0AEC8);
  static const _done = Color(0xFF7C879E);

  @override
  Widget build(BuildContext context) {
    final label = reasonLabel(reason);
    if (label.isEmpty) return const SizedBox.shrink();
    final (IconData icon, Color fg, Color? bg, Color? border) = switch (reason.kind) {
      'you' => (Icons.back_hand_outlined, Colors.white, StatusColor.waiting, null),
      'self' => (Icons.hourglass_top, _self, _self.withValues(alpha: 0.14), null),
      'external' => (Icons.group_outlined, _external, null, _external),
      _ => (Icons.check, _done, null, null),
    };
    final full = reason.kind == 'done' && reason.text.isNotEmpty ? 'Done: ${reason.text}' : label;
    return Tooltip(
      message: full,
      child: Container(
        key: ValueKey('reason-${reason.kind}'),
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(AppShape.small),
          border: border == null ? null : Border.all(color: border),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 11, color: fg),
          const SizedBox(width: 3),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600),
            ),
          ),
        ]),
      ),
    );
  }
}
