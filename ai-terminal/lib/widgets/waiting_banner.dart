import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// "This session is blocked on you" — the chat lens's answer to #79.
///
/// WHY A BANNER AND NOT AN INLINE MARKER. The defining symptom of `waiting` is
/// that **no further turn arrives**: the session is blocked by design until it is
/// answered. An inline marker would sit wherever the last turn happens to be, so
/// the user would have to scroll to the bottom to discover that nothing more is
/// coming — which is precisely the thing they could not tell in the first place.
/// Pinned above the transcript, it is visible at any scroll position.
///
/// WHY IT DOES NOT OFFER AN ANSWER BUTTON. A structured question already has a
/// native overlay (#19); a permission prompt lives in the agent's own TUI and is
/// answered in the terminal lens. Putting a second, half-working answer path here
/// would be a second source of truth for the same interaction.
///
/// [kind] comes from the SERVER (`waitingFor`) and is never re-derived here — see
/// `Session.waitingFor`.
class WaitingBanner extends StatelessWidget {
  const WaitingBanner({super.key, required this.kind});

  /// `'question'` or `'permission'`, as sent by the server.
  final String kind;

  bool get _isQuestion => kind == 'question';

  /// Amber rather than the error red: the session is healthy and deliberately
  /// paused, not broken. Reusing `error` would make every ordinary permission
  /// prompt look like a failure.
  static const Color _accent = Color(0xFFFFB020);
  static const Color _container = Color(0xFF2A2113);

  @override
  Widget build(BuildContext context) {
    final title = _isQuestion
        ? 'Waiting for your answer'
        : 'Waiting for your permission';
    // Says WHERE to respond, because the banner deliberately offers no control of
    // its own and "waiting" with nowhere to go is a dead end.
    final detail = _isQuestion
        ? 'This session asked a question and will not continue until you reply.'
        : 'This session needs permission to continue. Answer it in the Terminal lens.';

    return Semantics(
      liveRegion: true,
      label: '$title. $detail',
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(
          AppSpacing.screenPadding, AppSpacing.grid * 2, AppSpacing.screenPadding, 0,
        ),
        padding: const EdgeInsets.all(AppSpacing.cardPadding * 0.75),
        decoration: BoxDecoration(
          color: _container,
          borderRadius: BorderRadius.circular(AppShape.medium),
          border: Border.all(color: _accent.withValues(alpha: 0.45)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              _isQuestion ? Icons.help_outline : Icons.lock_outline,
              size: 20,
              color: _accent,
            ),
            const SizedBox(width: AppSpacing.grid * 3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    key: const Key('waiting-banner-title'),
                    style: const TextStyle(
                      color: _accent,
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.grid),
                  Text(
                    detail,
                    style: const TextStyle(
                      color: AppColors.onSurfaceVariant,
                      fontSize: 13,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
