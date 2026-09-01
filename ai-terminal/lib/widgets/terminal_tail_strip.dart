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

  // The type scale this strip renders at. Named so [heightFor] and [build]
  // cannot drift apart: the parent insets the conversation by exactly what
  // this widget occupies, and a stale number there means either a covered
  // message or a visible gap.
  static const double _fontSize = 12;
  static const double _lineHeight = 1.3;
  static const double _verticalPadding = AppSpacing.grid * 2;
  static const double _bottomMargin = AppSpacing.grid * 2;
  static const double _border = 1;

  /// The trailing chevron's box. It is the FLOOR on the content height: at one
  /// line the icon is taller than the line, so the Row takes the icon's height.
  static const double _chevron = 18;

  /// The height this strip occupies when rendering [lineCount] lines.
  ///
  /// The parent needs this to inset whatever it floats the strip OVER (see
  /// `ConversationView.bottomInset`), and it lives here — beside the styling
  /// that produces it — rather than being re-derived at the call site, which
  /// is how the two would drift. Returns 0 for an empty strip, because the
  /// caller does not mount one.
  ///
  /// TWO PARTS OF THIS WERE WRONG WHEN DERIVED FROM THE CONSTANTS ALONE, and
  /// review caught them by MEASURING the mounted widget rather than by reading
  /// the arithmetic. Both are now in the formula, and
  /// `session_screen_terminal_tail_test.dart` asserts this function against
  /// `tester.getSize` at every line count, so the next style change cannot
  /// silently reintroduce the gap:
  ///
  ///   * a text line lays out at 16.0px, not 12 x 1.3 = 15.6 — a paragraph
  ///     rounds its line box UP to whole pixels;
  ///   * at one line the 18px chevron is taller than the line, so the Row's
  ///     height is the icon's, not the text's.
  ///
  /// An under-report is not cosmetic: it is exactly the occlusion and
  /// tap-shadowing this number exists to prevent, just small enough to look
  /// fine.
  static double heightFor(int lineCount) {
    if (lineCount <= 0) return 0;
    final lineBox = (_fontSize * _lineHeight).ceilToDouble();
    final content = lineCount * lineBox;
    return (content < _chevron ? _chevron : content) +
        _verticalPadding * 2 +
        _border * 2 +
        _bottomMargin;
  }

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
              _bottomMargin,
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.cardPadding * 0.75,
              vertical: _verticalPadding,
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
                          // TERMINAL CONTENT DOES NOT FOLLOW THE SYSTEM TEXT
                          // SCALE, and this strip is a peek at terminal
                          // content. Measured at TextScaler.linear(1.3) the
                          // strip grew to 106px against a 88.4px inset — so
                          // the occlusion and the tap-shadowing came back for
                          // exactly the users least able to absorb them.
                          //
                          // Pinning is the accessible answer here, not the
                          // lazy one. The terminal lens itself renders at the
                          // app's own font setting and ignores the system
                          // scaler, so a scaled strip would show LARGER text
                          // than the terminal it previews while fitting FEWER
                          // characters before the ellipsis — strictly less
                          // information, for the reader who most needs it. The
                          // strip is a tap away from that lens, which is where
                          // font size is actually configurable.
                          textScaler: TextScaler.noScaling,
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
                            fontSize: _fontSize,
                            height: _lineHeight,
                            color: AppColors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.grid),
                const Icon(
                  Icons.chevron_right,
                  // `_chevron`, not a literal 18: this icon is the FLOOR in
                  // `heightFor` at one line, and review named the literal/constant
                  // pair as the one place the number could still drift. True by
                  // construction now, rather than only caught by the pinning test.
                  size: _chevron,
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
