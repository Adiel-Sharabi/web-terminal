// Tests for the new-session sheet: filterFolders (folder-autocomplete
// filter, mirroring the web's showFolders: case-insensitive substring match,
// empty query shows everything) and the server dropdown's visibility (owner:
// "there is no server selection" — it must show even with a single server).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

  group('nextFolderHighlight (issue #48 arrow nav math)', () {
    test('entering an unhighlighted list: Down picks the first row', () {
      expect(nextFolderHighlight(-1, 1, 3), 0);
    });

    test('entering an unhighlighted list: Up picks the last row', () {
      expect(nextFolderHighlight(-1, -1, 3), 2);
    });

    test('Down/Up step through the rows', () {
      expect(nextFolderHighlight(0, 1, 3), 1);
      expect(nextFolderHighlight(1, 1, 3), 2);
      expect(nextFolderHighlight(2, -1, 3), 1);
    });

    test('wraps around at both ends', () {
      expect(nextFolderHighlight(2, 1, 3), 0); // past the bottom → top
      expect(nextFolderHighlight(0, -1, 3), 2); // above the top → bottom
    });

    test('an empty list stays unhighlighted', () {
      expect(nextFolderHighlight(-1, 1, 0), -1);
      expect(nextFolderHighlight(0, 1, 0), -1);
    });

    test('a single-row list always lands on that row', () {
      expect(nextFolderHighlight(-1, 1, 1), 0);
      expect(nextFolderHighlight(0, 1, 1), 0);
      expect(nextFolderHighlight(0, -1, 1), 0);
    });
  });

  group('folder keyboard nav (issue #48)', () {
    const server = ServerConfig(
      name: 'Solo',
      baseUrl: 'http://x',
      bearerToken: 't',
    );

    // Pumps the sheet; `onCreate` captures the POST /api/sessions body so a test
    // can assert which cwd a keyboard-driven submit sent.
    Future<void> pumpNav(
      WidgetTester tester, {
      void Function(Map<String, dynamic> body)? onCreate,
    }) async {
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
                      if (req.method == 'POST' &&
                          req.url.path == '/api/sessions') {
                        onCreate?.call(
                          jsonDecode(req.body) as Map<String, dynamic>,
                        );
                        return http.Response('{"id":"n","name":"x"}', 200);
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

    Finder cwdField() => find.ancestor(
          of: find.text('Working directory'),
          matching: find.byType(TextField),
        );

    testWidgets('ArrowDown highlights the first folder; Enter starts there', (
      tester,
    ) async {
      String? sentCwd;
      await pumpNav(tester, onCreate: (b) => sentCwd = b['cwd'] as String?);

      // Focus the working-dir field → the (empty-query = all) list shows.
      await tester.tap(find.text('Working directory'));
      await tester.pumpAndSettle();
      expect(find.text('/dev/web-terminal'), findsOneWidget);

      // Down enters the list at the first row; Enter submits in that folder.
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();

      expect(sentCwd, '/dev/web-terminal');
    });

    testWidgets('Down twice lands on the second folder', (tester) async {
      String? sentCwd;
      await pumpNav(tester, onCreate: (b) => sentCwd = b['cwd'] as String?);

      await tester.tap(find.text('Working directory'));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();

      expect(sentCwd, '/dev/ai-terminal');
    });

    testWidgets('Escape closes the suggestion list', (tester) async {
      await pumpNav(tester);

      await tester.tap(find.text('Working directory'));
      await tester.pumpAndSettle();
      expect(find.text('/dev/web-terminal'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();

      expect(find.text('/dev/web-terminal'), findsNothing);
    });

    testWidgets('with nothing highlighted, Enter submits the typed path (#18)', (
      tester,
    ) async {
      String? sentCwd;
      await pumpNav(tester, onCreate: (b) => sentCwd = b['cwd'] as String?);

      // Typing resets any highlight, so Enter keeps the #18 behavior.
      await tester.enterText(cwdField(), r'C:\custom\path');
      await tester.pumpAndSettle();
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();

      expect(sentCwd, r'C:\custom\path');
    });
  });

  group('opening the created session', () {
    const server = ServerConfig(
      name: 'Solo',
      baseUrl: 'http://x',
      bearerToken: 't',
    );

    // The list refresh fans out to EVERY configured server, and an unreachable
    // peer holds it for its whole client deadline (twice, when a poll round is
    // already in flight): 27-40 s measured on Home with XPS and a MacBook down.
    // The session just created must open at once, whatever the refresh is doing.
    testWidgets('opens the new session without waiting for the list refresh', (
      tester,
    ) async {
      Session? recorded;
      Session? opened;
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
                  onCreated: (s) => opened = s,
                  // The production hook (SessionRepository.noteCreated) refreshes
                  // in the background; this one never finishes anything at all.
                  recordCreated: (s) => recorded = s,
                  clientBuilder: (server) => ApiClient(
                    server,
                    httpClient: MockClient((req) async {
                      if (req.method == 'POST' &&
                          req.url.path == '/api/sessions') {
                        return http.Response('{"id":"new-1","name":"x"}', 200);
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

      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();

      expect(recorded?.id, 'new-1', reason: 'recorded, so the list carries it at once');
      expect(opened?.id, 'new-1');
      expect(find.text('New session'), findsNothing, reason: 'the sheet closed');
    });
  });

  group('filterFolders', () {
    const folders = [
      r'C:\dev\web-terminal',
      r'C:\dev\ai-terminal',
      r'C:\dev\acme_core',
      r'C:\Users\yourname\projects',
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
      expect(filterFolders(folders, 'yourname'), [r'C:\Users\yourname\projects']);
    });

    test('no matches returns an empty list', () {
      expect(filterFolders(folders, 'nope-nothing-here'), isEmpty);
    });

    test('whitespace-only query behaves like empty', () {
      expect(filterFolders(folders, '   '), folders);
    });
  });

  group('cwdWithTrailingSep (pre-filled default folder)', () {
    test('appends the separator the path itself uses', () {
      expect(cwdWithTrailingSep(r'C:\dev'), r'C:\dev' '\\');
      expect(cwdWithTrailingSep('/home/user'), '/home/user/');
    });

    test('a path that already ends in a separator is left alone', () {
      // Otherwise re-opening the sheet would keep stacking separators.
      expect(cwdWithTrailingSep('C:\\dev\\'), 'C:\\dev\\');
      expect(cwdWithTrailingSep('/home/user/'), '/home/user/');
    });

    test('a REMOTE posix default keeps posix separators on a windows host', () {
      // The sheet may show a cluster peer's default cwd, so the separator has to
      // follow the path's own style rather than this device's.
      expect(cwdWithTrailingSep('/srv/work'), '/srv/work/');
    });

    test('empty stays empty — nothing to append to', () {
      expect(cwdWithTrailingSep(''), '');
    });
  });
  // #421 - the limit is soft: the sheet SHOWS the chosen machine's count, coloured by
  // the server's level, and never stops the create.
  group('session count (#421)', () {
    test('wording follows the server level; unknown is said, never zero', () {
      expect(sessionCountLine(null, loading: true), 'Counting sessions on this machine...');
      expect(sessionCountLine(null, loading: false), 'Sessions on this machine: unknown');
      expect(
        sessionCountLine((count: 1, working: 1, waiting: 0, max: 10, level: 'ok'), loading: false),
        '1 session already on this machine (1 working, 0 waiting)',
      );
      expect(
        sessionCountLine((count: 10, working: 2, waiting: 1, max: 10, level: 'warn'), loading: false),
        '10 sessions already on this machine (2 working, 1 waiting) - at the limit of 10',
      );
      expect(
        sessionCountLine((count: 12, working: 3, waiting: 0, max: 10, level: 'hot'), loading: false),
        '12 sessions already on this machine (3 working, 0 waiting) - over the limit of 10',
      );
    });

    testWidgets('a machine past its limit reads red, and Create still creates', (tester) async {
      const server = ServerConfig(name: 'Busy', baseUrl: 'http://x', bearerToken: 't');
      final posted = <String>[];
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
                  recordCreated: (_) {},
                  clientBuilder: (server) => ApiClient(
                    server,
                    httpClient: MockClient((req) async {
                      if (req.url.path == '/api/machine') {
                        return http.Response(
                          jsonEncode({
                            'sessions': {'count': 11, 'working': 4, 'waiting': 1, 'max': 10, 'level': 'hot'},
                          }),
                          200,
                        );
                      }
                      if (req.method == 'POST' && req.url.path == '/api/sessions') {
                        posted.add(req.url.path);
                        return http.Response(jsonEncode({'id': 'n1', 'name': 'S12', 'agent': null}), 200);
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

      final line = find.byKey(const ValueKey('new-session-count'));
      expect(line, findsOneWidget);
      final text = tester.widget<Text>(line);
      expect(text.data, '11 sessions already on this machine (4 working, 1 waiting) - over the limit of 10');
      final ctx = tester.element(line);
      expect(text.style?.color, Theme.of(ctx).colorScheme.error);

      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();
      expect(posted, ['/api/sessions']);
    });

    // The SERVER decides the colour: a level that contradicts the raw numbers must win,
    // or a client that recomputed the threshold would pass the test above too.
    testWidgets('the colour and wording follow the server level, not the numbers', (tester) async {
      const server = ServerConfig(name: 'Odd', baseUrl: 'http://x', bearerToken: 't');
      final asked = <String>[];
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
                      if (req.url.path == '/api/machine') {
                        asked.add(req.url.query);
                        return http.Response(
                          jsonEncode({
                            'sessions': {'count': 3, 'working': 0, 'waiting': 0, 'max': 10, 'level': 'hot'},
                          }),
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

      final line = find.byKey(const ValueKey('new-session-count'));
      final text = tester.widget<Text>(line);
      expect(text.data, endsWith('over the limit of 10'));
      expect(text.style?.color, Theme.of(tester.element(line)).colorScheme.error);
      // The cheap answer: never the CIM-backed full profile.
      expect(asked, ['part=sessions']);
    });
  });
}
