import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The chat lens's tap-through peek at the terminal (#194 Part 1) — a small
/// monospace strip showing [lines] (already reduced to the terminal's last
/// few non-blank rows, see `util/terminal_tail.dart`), tapping through to the
/// terminal lens.
///
/// Deliberately dumb: this widget renders whatever it is given and asks
/// nothing about status or which lens is active. [SessionScreen] owns the
/// gate (chat lens active AND the session is not `working`) and the
/// subscription that keeps [lines] current — that state has to live in
/// `_SessionScreenState`, not here, because the chat lens (and everything in
/// it, `ConversationView` included) is torn down on every lens flip while the
/// terminal is not.
class TerminalTailStrip extends StatelessWidget {
  const TerminalTailStrip({super.key, required this.lines, required this.onTap});

  /// The rows to show, top-to-bottom, already blank-filtered and trimmed.
  /// Never empty when this widget is built — the caller gates on that so an
  /// empty strip is never mounted at all.
  final List<String> lines;

  /// Switches to the Terminal lens (`SessionScreen._setLens`).
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label:
          'The terminal is showing: ${lines.join(". ")}. Tap to open the terminal.',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: const Key('terminal-tail-strip'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppShape.medium),
          child: Container(
            width: double.infinity,
            margin: const EdgeInsets.fromLTRB(
              AppSpacing.screenPadding,
              0,
              AppSpacing.screenPadding,
              AppSpacing.grid * 2,
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.cardPadding * 0.75,
              vertical: AppSpacing.grid * 2,
            ),
            decoration: BoxDecoration(
              color: AppColors.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(AppShape.medium),
              border: Border.all(color: AppColors.outline),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.terminal,
                  size: 16,
                  color: AppColors.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.grid * 2),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final line in lines)
                        Text(
                          line,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            // 'monospace' is an Android/fontconfig alias that
                            // resolves to NOTHING on Windows, macOS and iOS
                            // (#145) — without a fallback this strip loses the
                            // column alignment that is the whole reason the
                            // terminal's own text reads correctly.
                            fontFamilyFallback: [
                              'Consolas',
                              'Menlo',
                              'Courier New',
                            ],
                            fontSize: 12,
                            height: 1.3,
                            color: AppColors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.grid),
                const Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: AppColors.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
