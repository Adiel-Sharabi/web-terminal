// Tests for the new-session sheet: filterFolders (folder-autocomplete
// filter, mirroring the web's showFolders: case-insensitive substring match,
// empty query shows everything) and the server dropdown's visibility (owner:
// "there is no server selection" — it must show even with a single server).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/new_session_sheet.dart';

void main() {
  group('server dropdown', () {
    testWidgets('shows even with a single configured server', (tester) async {
      const server = ServerConfig(
        name: 'Solo',
        baseUrl: 'http://x',
        bearerToken: 't',
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showNewSessionSheet(
                  context,
                  servers: const [server],
                  initialServer: server,
                  onCreated: (_) {},
                  clientBuilder: (server) => ApiClient(
                    server,
                    httpClient: MockClient(
                      (req) async => http.Response('{}', 200),
                    ),
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

      expect(
        find.byType(DropdownButtonFormField<ServerConfig>),
        findsOneWidget,
      );
      expect(find.text('Server'), findsOneWidget);
    });
  });

  group('folder picker (issue #18)', () {
    const server = ServerConfig(
      name: 'Solo',
      baseUrl: 'http://x',
      bearerToken: 't',
    );

    Future<void> pumpSheet(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showNewSessionSheet(
                  context,
                  servers: const [server],
                  initialServer: server,
                  onCreated: (_) {},
                  clientBuilder: (server) => ApiClient(
                    server,
                    httpClient: MockClient((req) async {
                      if (req.url.path == '/api/history/folders') {
                        return http.Response(
                          '["/dev/web-terminal","/dev/ai-terminal"]',
                          200,
                        );
                      }
                      return http.Response('{}', 200);
                    }),
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

    testWidgets('a mouse click on a folder selects it (not dismisses)', (
      tester,
    ) async {
      await pumpSheet(tester);

      // Focus the working-dir field so the (empty-query = all) suggestions show.
      await tester.tap(find.text('Working directory'));
      await tester.pumpAndSettle();

      // The list is wrapped so tapping it doesn't blur the field and tear the
      // list down before the tap lands (the mouse-select bug).
      expect(find.byType(TextFieldTapRegion), findsWidgets);
      expect(find.text('/dev/ai-terminal'), findsOneWidget);

      await tester.tap(find.text('/dev/ai-terminal'));
      await tester.pumpAndSettle();

      // The pick landed: the field now holds the folder and the list is gone.
      final cwdField = tester.widget<TextField>(
        find.ancestor(
          of: find.text('Working directory'),
          matching: find.byType(TextField),
        ),
      );
      expect(cwdField.controller!.text, '/dev/ai-terminal');
    });

    testWidgets('the working-dir field submits on Enter', (tester) async {
      await pumpSheet(tester);

      final cwdField = tester.widget<TextField>(
        find.ancestor(
          of: find.text('Working directory'),
          matching: find.byType(TextField),
        ),
      );
      // Enter creates the session from the working-dir field (issue #18).
      expect(cwdField.textInputAction, TextInputAction.done);
      expect(cwdField.onSubmitted, isNotNull);
    });
  });

  group('agent picker', () {
    const server = ServerConfig(
      name: 'Solo',
      baseUrl: 'http://x',
      bearerToken: 't',
    );

    Future<void> pumpSheet(
      WidgetTester tester,
      Future<http.Response> Function(http.Request) handler,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showNewSessionSheet(
                  context,
                  servers: const [server],
                  initialServer: server,
                  onCreated: (_) {},
                  clientBuilder: (server) =>
                      ApiClient(server, httpClient: MockClient(handler)),
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

    testWidgets('lists Auto plus every agent from GET /api/agents', (
      tester,
    ) async {
      await pumpSheet(tester, (req) async {
        if (req.url.path == '/api/agents') {
          return http.Response(
            jsonEncode({
              'agents': [
                {'id': 'claude', 'label': 'Claude Code', 'color': '#d97757'},
                {'id': 'codex', 'label': 'Codex', 'color': '#10a37f'},
              ],
              'default': 'claude',
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      });

      expect(find.text('AI agent'), findsOneWidget);
      // DropdownButtonFormField doesn't expose `items` itself (only the
      // FormField wrapper) — the underlying DropdownButton it builds does.
      final dropdown = tester.widget<DropdownButton<String?>>(
        find.byType(DropdownButton<String?>),
      );
      final labels = dropdown.items!
          .map((i) => (i.child as Text).data)
          .toList(growable: false);
      expect(labels, [
        'Auto (detect from command)',
        'Claude Code',
        'Codex',
      ]);
    });

    testWidgets('shows only Auto when GET /api/agents fails', (tester) async {
      await pumpSheet(
        tester,
        (req) async => http.Response('', 500),
      );

      final dropdown = tester.widget<DropdownButton<String?>>(
        find.byType(DropdownButton<String?>),
      );
      final labels = dropdown.items!
          .map((i) => (i.child as Text).data)
          .toList(growable: false);
      expect(labels, ['Auto (detect from command)']);
    });
  });

  group('filterFolders', () {
    const folders = [
      r'C:\dev\web-terminal',
      r'C:\dev\ai-terminal',
      r'C:\dev\am8_core',
      r'C:\Users\adiel\projects',
    ];

    test('empty query returns every folder', () {
      expect(filterFolders(folders, ''), folders);
    });

    test('matches case-insensitively as a substring', () {
      expect(filterFolders(folders, 'TERMINAL'), [
        r'C:\dev\web-terminal',
        r'C:\dev\ai-terminal',
      ]);
    });

    test('matches on any path segment, not just a prefix', () {
      expect(filterFolders(folders, 'adiel'), [r'C:\Users\adiel\projects']);
    });

    test('no matches returns an empty list', () {
      expect(filterFolders(folders, 'nope-nothing-here'), isEmpty);
    });

    test('whitespace-only query behaves like empty', () {
      expect(filterFolders(folders, '   '), folders);
    });
  });
}
