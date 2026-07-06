// Widget test for issue #13: the session actions bottom sheet must stay fully
// reachable on a short window — the lower "Notify Level" rows were clipped
// below the viewport with no way to scroll to them. The fix wraps the body in
// a height-capped SingleChildScrollView (opened with isScrollControlled), so
// this asserts the sheet is scrollable and every option is built.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/session_action_sheet.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session() => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: r'C:\dev\my-project',
  status: 'idle',
  claudeSessionId: 'claude-abc',
  lastActivity: 0,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

void main() {
  testWidgets('actions sheet scrolls so a short window never clips it', (
    tester,
  ) async {
    // A deliberately short viewport — the case that used to clip the bottom
    // "Notify Level" rows.
    tester.view.physicalSize = const Size(400, 500);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showSessionActionsSheet(
                  context,
                  _session(),
                  onChanged: () {},
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // The body is wrapped in a scroll view (issue #13 fix).
    expect(find.byType(SingleChildScrollView), findsWidgets);
    // Every action + all three notify levels are built and reachable.
    expect(find.text('Rename'), findsOneWidget);
    expect(find.text('Kill session'), findsOneWidget);
    expect(find.text('Off'), findsOneWidget);
    expect(find.text('Important'), findsOneWidget);
    expect(find.text('All'), findsOneWidget);

    // The lowest option can be scrolled into view (proves it isn't clipped).
    await tester.scrollUntilVisible(find.text('All'), 100);
    expect(find.text('All'), findsOneWidget);
  });
}
