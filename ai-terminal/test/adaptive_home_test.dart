// Verifies the responsive split: wide windows show the master-detail layout
// (list rail + "Pick a session" detail placeholder); narrow windows do not.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/theme/app_theme.dart';

Widget _wrap() => MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome());

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('wide window shows the split detail placeholder', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_wrap());
    await tester.pump();

    expect(find.text('Pick a session'), findsOneWidget);
    expect(find.byType(VerticalDivider), findsOneWidget);
  });

  testWidgets('narrow window has no split (single pane)', (tester) async {
    tester.view.physicalSize = const Size(420, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_wrap());
    await tester.pump();

    expect(find.text('Pick a session'), findsNothing);
    expect(find.byType(VerticalDivider), findsNothing);
  });
}
