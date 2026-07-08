// Verifies the responsive split: wide windows show the master-detail layout
// (list rail + "Pick a session" detail placeholder) with a draggable resize
// handle between the panes; narrow windows do not. Also pins the rail-resize
// behavior: dragging the handle changes the rail width (clamped) and persists it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/theme/app_theme.dart';

Widget _wrap() => MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome());

const _handle = Key('rail-resize-handle');

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('wide window shows the split detail placeholder + resize handle', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_wrap());
    await tester.pump();

    expect(find.text('Pick a session'), findsOneWidget);
    expect(find.byKey(_handle), findsOneWidget);
  });

  testWidgets('narrow window has no split (single pane, no handle)', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(420, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_wrap());
    await tester.pump();

    expect(find.text('Pick a session'), findsNothing);
    expect(find.byKey(_handle), findsNothing);
  });

  testWidgets('dragging the handle widens the rail and persists the width', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_wrap());
    await tester.pump();

    // Default rail width before any drag.
    final rail = find
        .ancestor(of: find.text('Pick a session'), matching: find.byType(Row))
        .first;
    final SizedBox railBox = tester.widget<SizedBox>(
      find
          .descendant(of: rail, matching: find.byType(SizedBox))
          .first,
    );
    expect(railBox.width, AdaptiveHome.railWidth);

    // Drag the handle 80px to the right → rail grows by 80 (within clamp).
    // (pump(), not pumpAndSettle — DashboardScreen animates a loading spinner
    // that never settles in a test harness.)
    await tester.drag(find.byKey(_handle), const Offset(80, 0));
    await tester.pump();

    final SizedBox afterBox = tester.widget<SizedBox>(
      find
          .descendant(of: rail, matching: find.byType(SizedBox))
          .first,
    );
    expect(afterBox.width, AdaptiveHome.railWidth + 80);

    // The dragged width was persisted under the SSOT key.
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getDouble('wt_rail_width'), AdaptiveHome.railWidth + 80);
  });

  testWidgets('a persisted width is restored on next open (clamped)', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({'wt_rail_width': 500.0});
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_wrap());
    await tester.pump(); // initial build
    await tester.pump(const Duration(milliseconds: 50)); // async _loadRailWidth → setState

    final rail = find
        .ancestor(of: find.text('Pick a session'), matching: find.byType(Row))
        .first;
    final SizedBox railBox = tester.widget<SizedBox>(
      find
          .descendant(of: rail, matching: find.byType(SizedBox))
          .first,
    );
    expect(railBox.width, 500.0);
  });
}
