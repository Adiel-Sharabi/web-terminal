// #424 - the session screen's ⋮ menu goes STRAIGHT to the action it names.
//
// Before: Rename, Kill and Notify level fell through `onSelected` into the
// dashboard's actions sheet, which asked again which of them was meant - menu,
// sheet, then the confirm for a kill. Each test below taps ONE menu entry and
// asserts the thing it names is on screen and the sheet is not (the sheet is the
// only widget in the app that carries the "NOTIFY LEVEL" header, and it is a
// BottomSheet; both are asserted so a rename of one cannot hide the regression).
//
// The screen attaches to a numeric, dead-port server (see session_gone_exit_test:
// a hostname would leave a DNS timer pending in the fake-async zone); nothing here
// sends a request - every test stops at the dialog or picker.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';

const _server = ServerConfig(
  name: 'Office',
  baseUrl: 'http://127.0.0.1:1',
  bearerToken: 't',
);

const _reported = SessionReason(
  kind: 'you',
  text: 'say go',
  source: 'reported',
);

Session _session({SessionReason? reason}) => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: r'C:\dev\my-project',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 0,
  notifyLevel: 'important',
  server: _server,
  autoCommand: '',
  reason: reason,
);

/// Pumps the session screen and opens its ⋮ menu.
Future<void> _openMenu(WidgetTester tester, {SessionReason? reason}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SessionScreen(
        sessionId: 'sess-1',
        initialSession: _session(reason: reason),
      ),
    ),
  );
  await tester.pump();
  await tester.tap(find.byType(PopupMenuButton<String>));
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
}

/// Taps [label] in the open menu and lets the next route finish opening.
Future<void> _pick(WidgetTester tester, String label) async {
  await tester.tap(find.text(label));
  await tester.pump();
  // Not pumpAndSettle: the screen's connection spinner never settles.
  await tester.pump(const Duration(seconds: 1));
}

/// [pickerIsASheet]: the Notify level picker is itself a (compact) bottom sheet,
/// so for it "no sheet" can only mean none of the ACTIONS sheet's own rows.
void _expectNoActionsSheet({bool pickerIsASheet = false}) {
  if (!pickerIsASheet) {
    expect(find.byType(BottomSheet), findsNothing, reason: 'no intermediate sheet');
  }
  expect(find.text('NOTIFY LEVEL'), findsNothing);
  expect(find.text('Kill session'), findsNothing, reason: "the sheet's own row");
}

Future<void> _dispose(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox()); // dispose -> cancel timers
  await tester.pump();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
  });
  tearDown(() {
    SessionSelection.instance.reset();
    SessionRepository.instance.debugSetClearWaitSupported(_server.baseUrl, false);
  });

  testWidgets('Kill opens the one confirm directly - no sheet in between', (
    tester,
  ) async {
    await _openMenu(tester);
    await _pick(tester, 'Kill');

    expect(find.text('Kill session?'), findsOneWidget);
    expect(find.text('This cannot be undone.'), findsOneWidget);
    _expectNoActionsSheet();

    await tester.tap(find.text('Cancel'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Kill session?'), findsNothing, reason: 'cancel closes it');
    _expectNoActionsSheet();
    await _dispose(tester);
  });

  testWidgets('Rename opens the rename dialog directly, seeded with the name', (
    tester,
  ) async {
    await _openMenu(tester);
    await _pick(tester, 'Rename');

    expect(find.text('Rename session'), findsOneWidget);
    // The compose bar is a TextField too: look inside the dialog.
    final field = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    expect(tester.widget<TextField>(field).controller!.text, 'my-project');
    _expectNoActionsSheet();
    await _dispose(tester);
  });

  testWidgets('Notify level opens the compact picker, not the actions sheet', (
    tester,
  ) async {
    await _openMenu(tester);
    await _pick(tester, 'Notify level');

    expect(find.text('Notify me on this session'), findsOneWidget);
    expect(find.text('Important'), findsOneWidget);
    expect(find.text('Rename'), findsNothing, reason: 'no repeated choices');
    _expectNoActionsSheet(pickerIsASheet: true);
    await _dispose(tester);
  });

  testWidgets('"Not waiting" (#327) stays reachable here, as its own entry', (
    tester,
  ) async {
    SessionRepository.instance.debugSetClearWaitSupported(_server.baseUrl, true);
    await _openMenu(tester, reason: _reported);

    expect(find.text('Not waiting'), findsOneWidget);
    expect(find.text('Agent says: say go'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('"Not waiting" runs the action: the PATCH is attempted', (
    tester,
  ) async {
    SessionRepository.instance.debugSetClearWaitSupported(_server.baseUrl, true);
    await _openMenu(tester, reason: _reported);
    await _pick(tester, 'Not waiting');

    // flutter_test answers every real HTTP request with a 400, so an attempted
    // PATCH surfaces as the action's own "Failed" snackbar - which is all this
    // asserts (what the request carries is session_list_filter_clear_test's job).
    expect(find.textContaining('Failed'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('confirming the menu kill runs it: the DELETE is attempted', (
    tester,
  ) async {
    await _openMenu(tester);
    await _pick(tester, 'Kill');
    await tester.tap(find.widgetWithText(FilledButton, 'Kill'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('Kill session?'), findsNothing, reason: 'the confirm closed');
    expect(find.textContaining('Failed'), findsOneWidget, reason: 'the 400 for the DELETE');
    await _dispose(tester);
  });

  testWidgets('"Not waiting" is not offered when the rule says no', (
    tester,
  ) async {
    // The server does not advertise the PATCH key (the default).
    await _openMenu(tester, reason: _reported);

    expect(find.text('Kill'), findsOneWidget, reason: 'the menu is open');
    expect(find.text('Not waiting'), findsNothing);
    await _dispose(tester);
  });
}
