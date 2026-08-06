// The disconnect hairline must never animate.
//
// It was an indeterminate LinearProgressIndicator, and a disconnect is
// *unbounded*: when the server died at 22:01 the bar swept on until someone
// noticed. One running ticker keeps the Flutter engine producing a frame every
// vsync, so the whole window is rebuilt, rasterised and presented 60x/s to move
// a 3px bar. Measured on a 2576x1048 window (Intel UHD 770): 14.9% GPU + 6.4%
// DWM while disconnected, vs 6.2% + 4.1% once reconnected.
//
// These pin the fix so a future edit can't quietly restore a ticker here. All
// three go red against the old widget: the first two on the animation, the
// third guards against "fixing" it by deleting the affordance.
//
// Hosted in a bare Directionality + Theme (not MaterialApp) so the only
// ColoredBox in the tree is the hairline's own.
import 'package:ai_terminal/widgets/disconnect_hairline.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final themeData = ThemeData.dark();

  // A Column, because that is what the real parent is (`session_screen.dart`)
  // and because pumpWidget hands its root *tight* constraints — under those the
  // hairline could not be 3dp tall no matter what it asked for.
  Widget host(Widget child) => Directionality(
        textDirection: TextDirection.ltr,
        child: Theme(
          data: themeData,
          child: Column(mainAxisSize: MainAxisSize.min, children: [child]),
        ),
      );

  testWidgets('runs no animation, so the engine idles while disconnected',
      (tester) async {
    await tester.pumpWidget(host(const DisconnectHairline()));
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      tester.hasRunningAnimations,
      isFalse,
      reason: 'a disconnect is unbounded — an animation here never stops',
    );
    // Would throw "pumpAndSettle timed out" against the indeterminate bar.
    await tester.pumpAndSettle();
  });

  testWidgets('uses no progress indicator', (tester) async {
    await tester.pumpWidget(host(const DisconnectHairline()));

    expect(
      find.byType(LinearProgressIndicator),
      findsNothing,
      reason: 'a progress bar promises progress the app cannot back',
    );
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('still paints a full-width 3dp error-coloured bar',
      (tester) async {
    await tester.pumpWidget(host(const DisconnectHairline()));

    final size = tester.getSize(find.byType(DisconnectHairline));
    expect(size.height, 3, reason: 'the affordance must survive the fix');
    expect(size.width, greaterThan(0));

    final box = tester.widget<ColoredBox>(find.byType(ColoredBox));
    expect(box.color, themeData.colorScheme.error.withValues(alpha: 0.7));
  });
}
