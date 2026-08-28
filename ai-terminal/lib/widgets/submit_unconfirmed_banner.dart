import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// "That prompt may not have reached the agent, and here are your words back"
/// — the chat lens's answer to #179.
///
/// WHY THIS EXISTS AT ALL. `lib/submit-confirm.js` (server) watches every
/// client submit and reports `submitUnconfirmed` when no agent hook follows
/// it within the timeout — the TUI was sitting on something that swallows
/// keystrokes (`/usage`, a permission prompt, a crashed TUI back at bash) and
/// the compose bar's submit never started a turn. Measured on claude 2.1.250:
/// NONE of those states emit a distinguishing byte, so there is nothing to
/// detect ahead of time — only to verify after the fact. That is why this is
/// a reactive notice, not a predictive one, and why it never names which
/// state the terminal is in: that was measured to be unknowable from here.
///
/// WHY THE WORDING NEVER OVERCLAIMS. The server frame carries no text — the
/// worker only knows a submit went unconfirmed, not what it said (see the
/// header of `lib/submit-confirm.js`) — so recovering it is entirely on the
/// client's own copy of what it last sent (`SessionScreen._lastSubmittedPrompt`).
/// That copy can only be replayed into an EMPTY compose bar: a user who has
/// already started a new prompt must never have it overwritten by a notice
/// about an older one. [restored] tells this widget which happened, so it
/// never claims "your text is back" when it is sitting, un-restored, in
/// [SessionScreen]'s memory instead of the field below.
///
/// SAME SHAPE AS [WaitingBanner] on purpose — an amber card above the
/// terminal/chat stack, never a red one (the session isn't broken, a prompt
/// just needs resending) and never an overlay (it takes a Column slot, so it
/// can never cover the terminal or steal a tap meant for it).
class SubmitUnconfirmedBanner extends StatelessWidget {
  const SubmitUnconfirmedBanner({
    super.key,
    required this.restored,
    required this.onDismiss,
    this.onViewTerminal,
  });

  /// Whether the compose bar was empty when the notice arrived, so the saved
  /// text was actually put back into it. `false` means a newer draft was
  /// sitting there and was left alone — the non-destructive rule #179 asks
  /// for by name.
  final bool restored;

  /// Closes the notice without acting further. Wired to the compose bar's own
  /// dismiss, and also fired implicitly (by the screen, not this widget) on
  /// the next submit or a lens/session switch.
  final VoidCallback onDismiss;

  /// Switches to the Terminal lens (reuses the existing lens toggle — see
  /// `SessionScreen._setLens`). `null` while the Terminal lens is already the
  /// one showing, where offering to switch to it would be a no-op button.
  final VoidCallback? onViewTerminal;

  @override
  Widget build(BuildContext context) {
    const accent = AppColors.caution;
    final title = 'That prompt may not have reached the agent';
    final detail = restored
        ? 'Nothing happened after it went out, so it’s back in the '
            'compose bar below. Check the terminal before sending it again — '
            'it may be showing a menu or a full-screen view.'
        : 'Nothing happened after it went out. Check the terminal before '
            'sending it again — it may be showing a menu or a full-screen view.';

    return Semantics(
      liveRegion: true,
      label: '$title. $detail',
      child: Container(
        key: const Key('submit-unconfirmed-banner'),
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(
          AppSpacing.screenPadding, AppSpacing.grid * 2, AppSpacing.screenPadding, 0,
        ),
        padding: const EdgeInsets.all(AppSpacing.cardPadding * 0.75),
        decoration: BoxDecoration(
          color: AppColors.cautionContainer,
          borderRadius: BorderRadius.circular(AppShape.medium),
          border: Border.all(color: accent.withValues(alpha: 0.45)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.replay_outlined, size: 20, color: accent),
            const SizedBox(width: AppSpacing.grid * 3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    key: const Key('submit-unconfirmed-title'),
                    style: const TextStyle(
                      color: accent,
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.grid),
                  Text(
                    detail,
                    key: const Key('submit-unconfirmed-detail'),
                    style: const TextStyle(
                      color: AppColors.onSurfaceVariant,
                      fontSize: 13,
                      height: 1.35,
                    ),
                  ),
                  if (onViewTerminal != null) ...[
                    const SizedBox(height: AppSpacing.grid),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        key: const Key('submit-unconfirmed-view-terminal'),
                        onPressed: onViewTerminal,
                        style: TextButton.styleFrom(
                          foregroundColor: accent,
                          padding: EdgeInsets.zero,
                          minimumSize: const Size(0, 32),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        icon: const Icon(Icons.terminal, size: 16),
                        label: const Text('View terminal'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              key: const Key('submit-unconfirmed-dismiss'),
              onPressed: onDismiss,
              icon: const Icon(Icons.close, size: 18),
              color: AppColors.onSurfaceVariant,
              tooltip: 'Dismiss',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            ),
          ],
        ),
      ),
    );
  }
}
