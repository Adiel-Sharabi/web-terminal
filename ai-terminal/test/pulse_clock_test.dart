// A pulsing dot must not cost a 60fps window.
//
// A running AnimationController asks the engine for a frame on every vsync, and
// a Flutter frame is whole-window work: build, layout, paint, rasterise,
// present — then DWM composites it. So the price of a pulse has almost nothing
// to do with the size of the dot. Measured on a 2576x1048 window (Intel UHD
// 770): three 6px dots in the chat lens's "Claude is working" bubble cost
// 13.5% GPU + 7.7% DWM, against 6.2% + 4.1% with no bubble on screen.
//
// A RepaintBoundary makes each frame cheap but cannot make the frames stop.
// Only the frame RATE does — so every Pulse in the app is driven by one shared
// 10fps Timer (PulseClock) instead of a ticker of its own. These tests pin the
// three things that keeps true: no ticker, one clock however many dots, and it
// still visibly breathes.
//
// Measured in this harness, one Pulse mounted, after a 100ms pump:
//
//                            old (ticker)   new (clock)
//   transientCallbackCount        1              0
//   hasScheduledFrame            true          false
//
// i.e. the old one asked for a frame on every vsync; this one lets the engine
// idle between ticks. Five of the six tests below go red against the old
// implementation — the sixth ("it still breathes") stays green on purpose,
// because it guards the feature rather than the fix.
import 'package:ai_terminal/theme/pulse_clock.dart';
import 'package:ai_terminal/theme/status_colors.dart';
import 'package:ai_terminal/widgets/pulsing_dots.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() => PulseClock.instance.resetForTest());
  tearDown(() => PulseClock.instance.resetForTest());

  Widget host(Widget child) => Directionality(
        textDirection: TextDirection.ltr,
        child: Center(child: child),
      );

  const dot = SizedBox(width: 6, height: 6);
  const green = Color(0xFF00FF00);

  double alphaOf(WidgetTester t) =>
      t.widget<FadeTransition>(find.byType(FadeTransition)).opacity.value;

  testWidgets('a pulse runs NO ticker — a ticker is what pinned us to vsync',
      (tester) async {
    await tester.pumpWidget(host(const Pulse(child: dot)));
    await tester.pump(PulseClock.tick);

    expect(
      tester.hasRunningAnimations,
      isFalse,
      reason: 'a ticker asks for a frame every vsync; the clock asks for ~10/s',
    );
    expect(PulseClock.instance.running, isTrue, reason: 'but it IS pulsing');
  });

  testWidgets('the clock ticks ~10x a second, not ~60', (tester) async {
    await tester.pumpWidget(host(const PulsingDots(color: green)));

    var ticks = 0;
    void count() => ticks++;
    PulseClock.instance.addListener(count);
    await tester.pump(const Duration(seconds: 1));
    PulseClock.instance.removeListener(count);

    expect(
      ticks,
      inInclusiveRange(6, 20),
      reason: '10fps by design; a vsync-driven ticker would be ~60',
    );
  });

  testWidgets('three dots share ONE clock and stagger inside it',
      (tester) async {
    await tester.pumpWidget(host(const PulsingDots(color: green)));
    await tester.pump(PulseClock.tick * 2);

    expect(PulseClock.instance.subscriberCount, 3);
    final values = tester
        .widgetList<FadeTransition>(find.byType(FadeTransition))
        .map((f) => f.opacity.value)
        .toSet();
    expect(values.length, greaterThan(1),
        reason: 'staggered by Pulse.phase, not breathing in unison');
  });

  testWidgets('it still breathes — opacity moves as the clock advances',
      (tester) async {
    await tester.pumpWidget(host(const Pulse(child: dot)));
    final first = alphaOf(tester);
    await tester.pump(PulseClock.tick * 4);

    expect((alphaOf(tester) - first).abs(), greaterThan(0.05),
        reason: 'the indication has to still read as alive');
  });

  testWidgets('the clock stops when the last pulse leaves the tree',
      (tester) async {
    await tester.pumpWidget(host(const PulsingDots(color: green)));
    expect(PulseClock.instance.running, isTrue);

    await tester.pumpWidget(host(const SizedBox()));
    expect(PulseClock.instance.running, isFalse,
        reason: 'nothing pulsing => no timer => the engine idles');
  });

  testWidgets('the clock stops while the window is not visible',
      (tester) async {
    await tester.pumpWidget(host(const PulsingDots(color: green)));
    await tester.pump(PulseClock.tick * 3);
    expect(PulseClock.instance.running, isTrue);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();

    expect(PulseClock.instance.running, isFalse);
    for (final f
        in tester.widgetList<FadeTransition>(find.byType(FadeTransition))) {
      expect(f.opacity.value, 1.0,
          reason: 'parked solid, never frozen mid-fade');
    }
  });
}
