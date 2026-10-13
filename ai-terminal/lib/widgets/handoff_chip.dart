/// The hand-off chips (#340): what a run of "hand this long session off to a fresh
/// one" is doing, and how big the session is that can be handed off.
///
/// The server decides every part of it - whether a session is a candidate, the run's
/// state, why it ended - and publishes it as `handoff` on each session row; this
/// file only turns those words into plain English, the way `reason_chip.dart` does
/// for `reason`. The labels are pure functions so a test pins them without a widget.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import 'format_utils.dart';
import 'reason_chip.dart' show durShort;

/// Why a run failed, in words. The server's failure codes; one it has not met yet is
/// shown as the server sent it, never swallowed.
String handoffFailureText(String? code) {
  if (code == null || code.isEmpty) return 'it did not say why';
  return switch (code) {
    'no-brief' => 'It never wrote its brief',
    'no-slot' => 'No free session slot on this server',
    'no-launch-command' => 'Could not work out how to start the new session',
    'successor-not-ready' => 'The new session never became ready',
    'successor-not-up' => 'The new session did not start in time',
    'successor-gone' => 'The new session was closed',
    'successor-create-failed' => 'The new session could not be created',
    _ => code,
  };
}

/// The chip's words for [run]. An in-flight run carries how long it has been going,
/// because wrapping alone can take a quarter of an hour.
String handoffRunLabel(HandoffRun run, {DateTime? now}) {
  final nowMs = (now ?? DateTime.now()).millisecondsSinceEpoch;
  final age = run.startedAt == null ? '' : ' · ${durShort(nowMs - run.startedAt!)}';
  final name = run.successorName;
  switch (run.state) {
    case 'wrapping':
      return 'Handing off: writing its brief…$age';
    case 'spawning':
      return 'Handing off: starting the new session…$age';
    case 'verifying':
      return name == null
          ? 'Handing off: checking the new session came up…$age'
          : 'Handing off: checking "$name" came up…$age';
    case 'closing':
      return 'Handing off: closing this one when its turn ends…$age';
    case 'kept':
      // `keptBecause` is the agent's own line about what would have been lost: verbatim.
      final why = run.keptBecause ?? switch (run.reason) {
        'unsaved-work' => 'it has unsaved work',
        'in-use' => 'it started a new turn',
        'still-busy' => 'it was still busy',
        _ => run.reason,
      };
      return why == null
          ? 'Handed off, but this session was kept'
          : 'Handed off, but this session was kept: $why';
    case 'failed':
      return 'Hand-off did not finish: ${handoffFailureText(run.reason)}';
  }
  return '';
}

/// A run's state as a chip. In flight it is blue and still (an animated spinner would
/// repaint the window every frame for as long as the run lasts - `PulseClock`'s
/// lesson); a kept session is amber, a failure red.
class HandoffRunChip extends StatelessWidget {
  const HandoffRunChip({super.key, required this.run, this.now});

  final HandoffRun run;

  /// Injectable for tests; defaults to the clock.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final label = handoffRunLabel(run, now: now);
    if (label.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final (IconData icon, Color fg, Color? bg, Color? border) = switch (run.state) {
      'kept' => (Icons.info_outline, AppColors.caution, null, AppColors.caution),
      'failed' => (Icons.error_outline, theme.colorScheme.error, null, theme.colorScheme.error),
      _ => (Icons.hourglass_top, StatusColor.capped, StatusColor.capped.withValues(alpha: 0.14), null),
    };
    return Tooltip(
      message: label,
      child: Container(
        key: ValueKey('handoff-${run.state}'),
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
              // A kept session's reason is a whole sentence the person should be able to read.
              maxLines: run.active ? 1 : 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600),
            ),
          ),
        ]),
      ),
    );
  }
}

/// How much context a hand-off candidate carries: `612k ctx`, or `Long session` when
/// the server did not say.
class HandoffCtxChip extends StatelessWidget {
  const HandoffCtxChip({super.key, required this.tokens});

  final int? tokens;

  @override
  Widget build(BuildContext context) {
    // Muted: a nudge, not an alarm.
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppShape.small),
        border: Border.all(color: AppColors.outlineVariant),
      ),
      child: Text(
        tokens == null ? 'Long session' : '${formatTokensShort(tokens)} ctx',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: muted, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }
}
