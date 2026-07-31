// #76: on a wide window a notification tap must SELECT the session in the
// existing master-detail split — list rail still visible, no Back needed —
// instead of pushing a full-screen route over the layout.
//
// The bug was a *decision*, not a rendering fault: `_openSession` pushed on the
// global navigator unconditionally and nothing in it ever consulted the split
// breakpoint, while wide mode opened sessions by state selection. Two unrelated
// mechanisms for "open a session", and only one of them knew about
// notifications. So the rule is pinned as a pure function, and the wiring that
// feeds it is pinned on the real widget.
//
// #45's narrow-mode guarantee (exactly one screen above the list) must survive —
// it is re-asserted here as well as in notification_stack_test.dart, because
// this change is the one most likely to break it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/main.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';

Widget _wrap() => MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome());

Future<void> _pumpAt(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(_wrap());
  await tester.pump();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    // A static singleton would otherwise leak one test's selection into the next.
    SessionSelection.instance.reset();
  });

  group('planNotificationOpen', () {
    test('wide split available → select, do not push', () {
      expect(
        planNotificationOpen(splitCanSelect: true),
        NotificationOpen.selectInSplit,
      );
    });

    test('no split → push, exactly as #45 specified', () {
      expect(
        planNotificationOpen(splitCanSelect: false),
        NotificationOpen.pushRoute,
      );
    });
  });

  group('AdaptiveHome publishes whether selecting is possible', () {
    testWidgets('a wide window can select', (tester) async {
      await _pumpAt(tester, const Size(1400, 900));
      expect(SessionSelection.instance.splitMounted, isTrue);
      expect(
        planNotificationOpen(
          splitCanSelect: SessionSelection.instance.splitMounted,
        ),
        NotificationOpen.selectInSplit,
      );
    });

    testWidgets('a narrow window cannot — the push path is preserved (#45)', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(420, 900));
      expect(SessionSelection.instance.splitMounted, isFalse);
      expect(
        planNotificationOpen(
          splitCanSelect: SessionSelection.instance.splitMounted,
        ),
        NotificationOpen.pushRoute,
      );
    });

    testWidgets('crossing the breakpoint flips the decision, both ways', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      tester.view.physicalSize = const Size(1400, 900);
      await tester.pumpWidget(_wrap());
      await tester.pump();
      expect(SessionSelection.instance.splitMounted, isTrue);

      // Wide → narrow: no split to select into any more, so a notification must
      // go back to pushing rather than silently selecting into a hidden pane.
      tester.view.physicalSize = const Size(420, 900);
      await tester.pump();
      expect(SessionSelection.instance.splitMounted, isFalse);

      // …and back, without stranding anything.
      tester.view.physicalSize = const Size(1400, 900);
      await tester.pump();
      expect(SessionSelection.instance.splitMounted, isTrue);
    });
  });

  group('the split view follows the shared selection', () {
    testWidgets('with nothing selected it shows the placeholder', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(1400, 900));
      expect(find.text('Pick a session'), findsOneWidget);
    });

    testWidgets('selecting an id replaces the placeholder — no route pushed', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(1400, 900));
      expect(find.text('Pick a session'), findsOneWidget);

      // Exactly what _openSession does on a wide window: set the shared id.
      // A notification carries only an id — never a Session object — which is
      // why the selection is an id and initialSession is merely a hint.
      SessionSelection.instance.selectedId.value = 'sess-from-notification';
      await tester.pump();

      expect(find.text('Pick a session'), findsNothing);
      // The rail is still there: that is the whole point of #76.
      expect(find.byKey(const Key('rail-resize-handle')), findsOneWidget);
    });
  });
}
