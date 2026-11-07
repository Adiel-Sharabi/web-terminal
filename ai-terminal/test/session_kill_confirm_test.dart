// #424 - the kill confirmation and the `DELETE` live in ONE place
// (`confirmAndKillSession`), called by the session screen's ⋮ menu and by the
// actions sheet's "Kill session" row alike. These tests drive it directly with a
// recording HTTP client, then through the sheet, so a second copy of the dialog
// (or a sheet that stops calling the shared one) shows up as a missing request.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/widgets/session_action_sheet.dart';

const _server = ServerConfig(
  name: 'Home',
  baseUrl: 'http://h:7681',
  bearerToken: 'tok',
);

Session _session() => Session(
  id: 's1',
  name: 'my-project',
  cwd: r'C:\dev',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 0,
  notifyLevel: 'important',
  server: _server,
);

void main() {
  late List<http.Request> sent;
  late int changed;
  int status = 200;

  ApiClient api() => ApiClient(
    _server,
    httpClient: MockClient((req) async {
      sent.add(req);
      return http.Response(
        jsonEncode({'ok': true}),
        status,
        headers: {'content-type': 'application/json'},
      );
    }),
  );

  List<String> requests() => [for (final r in sent) '${r.method} ${r.url.path}'];

  setUp(() {
    sent = [];
    changed = 0;
    status = 200;
  });

  /// A page whose button runs the shared kill flow and records its result.
  Future<void> openKill(WidgetTester tester, List<bool> results) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async => results.add(
                await confirmAndKillSession(
                  context,
                  _session(),
                  onChanged: () => changed++,
                  api: api(),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  group('confirmAndKillSession', () {
    testWidgets('asks once, then sends the DELETE and reports it', (tester) async {
      final results = <bool>[];
      await openKill(tester, results);

      expect(find.text('Kill session?'), findsOneWidget);
      expect(sent, isEmpty, reason: 'nothing is sent before the confirm');

      await tester.tap(find.widgetWithText(FilledButton, 'Kill'));
      await tester.pumpAndSettle();

      expect(requests(), ['DELETE /api/sessions/s1']);
      expect(changed, 1, reason: 'the caller refreshes after the kill');
      expect(results, [true]);
      expect(find.text('Kill session?'), findsNothing);
    });

    testWidgets('Cancel sends nothing and reports false', (tester) async {
      final results = <bool>[];
      await openKill(tester, results);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(sent, isEmpty);
      expect(changed, 0);
      expect(results, [false]);
    });

    testWidgets('the destructive button is error-coloured', (tester) async {
      await openKill(tester, <bool>[]);

      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Kill'),
      );
      expect(
        button.style?.backgroundColor?.resolve(<WidgetState>{}),
        Theme.of(tester.element(find.byType(AlertDialog))).colorScheme.error,
      );
    });

    testWidgets('desktop: Esc cancels', (tester) async {
      final results = <bool>[];
      // Reset in the body: the binding checks foundation vars BEFORE tearDowns run.
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        await openKill(tester, results);

        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }

      expect(find.text('Kill session?'), findsNothing);
      expect(sent, isEmpty);
      expect(results, [false]);
    });

    testWidgets('desktop: Enter confirms - the Kill button is the focused one', (
      tester,
    ) async {
      final results = <bool>[];
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        await openKill(tester, results);

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }

      expect(requests(), ['DELETE /api/sessions/s1']);
      expect(results, [true]);
    });

    testWidgets('a failed DELETE is a snackbar, still reported as attempted', (
      tester,
    ) async {
      status = 500;
      final results = <bool>[];
      await openKill(tester, results);

      await tester.tap(find.widgetWithText(FilledButton, 'Kill'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed'), findsOneWidget);
      expect(changed, 0, reason: 'nothing changed, so nothing to refresh');
      expect(results, [true]);
    });
  });

  group('the actions sheet uses the shared flow', () {
    Future<void> openSheet(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showSessionActionsSheet(
                  context,
                  _session(),
                  onChanged: () => changed++,
                  canClearWait: false,
                  api: api(),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('Kill session -> the same confirm -> DELETE, and the sheet closes', (
      tester,
    ) async {
      await openSheet(tester);
      await tester.tap(find.text('Kill session'));
      await tester.pumpAndSettle();
      expect(find.text('Kill session?'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Kill'));
      await tester.pumpAndSettle();

      expect(requests(), ['DELETE /api/sessions/s1']);
      expect(changed, 1);
      expect(find.text('NOTIFY LEVEL'), findsNothing, reason: 'the sheet closed');
    });

    testWidgets('cancelling the confirm leaves the sheet open', (tester) async {
      await openSheet(tester);
      await tester.tap(find.text('Kill session'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(sent, isEmpty);
      expect(find.text('NOTIFY LEVEL'), findsOneWidget, reason: 'back to the sheet');
    });

    testWidgets('Rename -> the shared dialog -> PATCH, and the sheet closes', (
      tester,
    ) async {
      await openSheet(tester);
      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'renamed');
      await tester.tap(find.widgetWithText(FilledButton, 'Rename'));
      await tester.pumpAndSettle();

      expect(requests(), ['PATCH /api/sessions/s1']);
      expect(sent.single.body, '{"name":"renamed"}');
      expect(find.text('NOTIFY LEVEL'), findsNothing, reason: 'the sheet closed');
    });
  });
}
