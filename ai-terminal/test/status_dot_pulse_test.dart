// The pulsing status dot must stay cheap: its animation is isolated behind a
// RepaintBoundary (so a working dot repaints the ~10px dot, not the whole session
// card) and it parks/stops when the window is not visible. A repeating 60fps
// Opacity over the un-boundaried card was ~1 core / 20% GPU while any session was
// non-idle — this pins the fix so a future edit can't quietly bring it back.
//
// Hosted in a bare Directionality (not MaterialApp) so the only FadeTransition /
// RepaintBoundary in the tree is the dot's own — MaterialApp adds its own for
// page routes and would make the finders ambiguous.
import 'package:ai_terminal/theme/status_colors.dart';
import 'package:ai_terminal/widgets/status_dot.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget host(Widget child) => Directionality(
        textDirection: TextDirection.ltr,
        child: Center(child: child),
      );

  testWidgets('a working dot pulses behind a RepaintBoundary via FadeTransition',
      (tester) async {
    await tester.pumpWidget(host(const StatusDot(status: SessionStatus.working)));

    final fade = find.byType(FadeTransition);
    expect(fade, findsOneWidget, reason: 'pulse uses FadeTransition, not a per-frame Opacity');
    expect(
      find.ancestor(of: fade, matching: find.byType(RepaintBoundary)),
      findsOneWidget,
      reason: 'the pulse must be isolated by a RepaintBoundary',
    );
  });

  testWidgets('an idle dot has no animation at all', (tester) async {
    await tester.pumpWidget(host(const StatusDot(status: SessionStatus.idle)));
    expect(find.byType(FadeTransition), findsNothing);
  });

  testWidgets('the pulse parks at full opacity when the window hides',
      (tester) async {
    await tester.pumpWidget(host(const StatusDot(status: SessionStatus.working)));
    await tester.pump(const Duration(milliseconds: 300)); // let it fade off full

    // Window no longer visible → the controller stops and the dot parks fully
    // opaque so a static dot still reads as solid.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();

    final fade = tester.widget<FadeTransition>(find.byType(FadeTransition));
    expect(fade.opacity.value, 1.0, reason: 'parked at full opacity when hidden');
  });
}
