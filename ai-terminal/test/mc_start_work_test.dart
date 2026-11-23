// #512 - Mission Control's Start work sheet against a faked authority answering synthetic
// fixtures:
//   * the wire parse tolerates junk;
//   * the sheet preselects the project it was opened for and the machine the SERVER
//     suggests (a machine that cannot take a session is listed, not selectable);
//   * Start posts the ticked subjects plus the typed refs (or a hunt with no list) to
//     `POST /api/mc/start` on the authority, then opens the new session;
//   * a refusal is shown with the server's reason and opens nothing;
//   * the button is on the Now bar and on a project's page.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/screens/mission_control/project_view.dart';
import 'package:ai_terminal/screens/mission_control/start_work_sheet.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _json(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync()) as Map<String, dynamic>;

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

final Map<String, dynamic> _machines = {
  'machines': [
    {'name': 'alpha', 'url': null, 'ok': true, 'why': null, 'sessions': 4, 'working': 2, 'load': 40},
    {'name': 'beta', 'url': 'https://beta.example.test', 'ok': true, 'why': null, 'sessions': 1, 'working': 0, 'load': 5.4},
    {'name': 'gamma', 'url': 'https://gamma.example.test', 'ok': false, 'why': 'restart hold: update', 'sessions': 0, 'working': 0, 'load': null},
  ],
  'suggested': 'beta',
  'generatedAt': 1,
};

/// Alpha is the authority. [start] answers `POST /api/mc/start`.
class _Authority {
  final List<http.Request> requests = [];
  (int, Object) start = (200, {'server': 'beta', 'serverUrl': 'https://beta.example.test', 'sessionId': 'new-1', 'name': 'Web Terminal #42'});

  http.Response _answer(http.Request req) {
    requests.add(req);
    final path = req.url.path;
    if (path == '/api/mc/now') return http.Response(jsonEncode(_json('mc_now.json')), 200);
    if (path == '/api/mc/subjects') return http.Response(jsonEncode(_json('mc_subjects.json')), 200);
    if (path == '/api/mc/machines') return http.Response(jsonEncode(_machines), 200);
    if (path == '/api/mc/start') return http.Response(jsonEncode(start.$2), start.$1);
    return http.Response(jsonEncode({'error': 'Not found'}), 404);
  }

  McFeed feed() => McFeed(
        servers: () => const [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async => _answer(req))),
      );

  List<Map<String, dynamic>> get startBodies => [
        for (final r in requests)
          if (r.url.path == '/api/mc/start') jsonDecode(r.body) as Map<String, dynamic>
      ];
}

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// A page with one button that opens the sheet for [projectId].
Widget _host(McFeed feed, List<String> opened, {String? projectId}) => MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            key: const ValueKey('open'),
            onPressed: () => showStartWorkSheet(context, feed: feed, projectId: projectId, onOpenSession: opened.add),
            child: const Text('open'),
          ),
        ),
      ),
    );

void main() {
  group('wire', () {
    test('machines and the start answer parse, junk tolerated', () {
      final m = McMachines.fromJson(_machines);
      expect(m.suggested, 'beta');
      expect(m.machines.map((x) => [x.name, x.ok, x.load]).toList(), [
        ['alpha', true, 40],
        ['beta', true, 5],
        ['gamma', false, null],
      ]);
      expect(m.machines[2].line, 'restart hold: update - 0 sessions, 0 working');
      expect(m.machines[0].line, '4 sessions, 2 working, CPU 40%');
      expect(McMachines.fromJson({'machines': [7, null, {'name': 3}], 'suggested': 5}).machines, isEmpty);
      expect(McStartResult.fromJson({'sessionId': 'x', 'server': 'beta'})!.server, 'beta');
      expect(McStartResult.fromJson({'server': 'beta'}), isNull);
      expect(mcTypedRefs(' #1, ado:2  owner/r#3 ,,'), ['#1', 'ado:2', 'owner/r#3']);
    });
  });

  group('sheet', () {
    testWidgets('preselects the project and the suggested machine; Start sends the choice and opens the session', (tester) async {
      await _size(tester, const Size(900, 1400));
      final auth = _Authority();
      final feed = auth.feed();
      await feed.refresh();
      final opened = <String>[];
      await tester.pumpWidget(_host(feed, opened, projectId: 'web-terminal'));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('mc-start-sheet')), findsOneWidget);
      expect(find.text('Web Terminal'), findsWidgets); // the project, preselected
      expect(find.textContaining('beta (suggested)'), findsOneWidget);
      // `other` has no folder: never offered.
      expect(find.text('Other'), findsNothing);
      // Nothing chosen yet: Start is off.
      expect(tester.widget<FilledButton>(find.byKey(const ValueKey('mc-start-go'))).onPressed, isNull);

      await tester.tap(find.byKey(const ValueKey('mc-start-subject-acme/widgets#41')));
      await tester.enterText(find.byKey(const ValueKey('mc-start-refs')), '#99, ado:7');
      await tester.enterText(find.byKey(const ValueKey('mc-start-brief')), 'Keep it small');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();

      expect(auth.startBodies, [
        {
          'project': 'web-terminal',
          'subjects': ['acme/widgets#41', '#99', 'ado:7'],
          'hunt': false,
          'server': 'beta',
          'brief': 'Keep it small',
        }
      ]);
      expect(opened, ['new-1']);
      expect(find.byKey(const ValueKey('mc-start-sheet')), findsNothing);
    });

    testWidgets('a hunt needs no work item and sends none', (tester) async {
      await _size(tester, const Size(900, 1400));
      final auth = _Authority();
      final feed = auth.feed();
      await feed.refresh();
      final opened = <String>[];
      await tester.pumpWidget(_host(feed, opened));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hunt'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-start-refs')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single, {'project': 'web-terminal', 'subjects': <String>[], 'hunt': true, 'server': 'beta'});
      expect(opened, ['new-1']);
    });

    testWidgets('a refusal shows the server reason and opens nothing', (tester) async {
      await _size(tester, const Size(900, 1400));
      final auth = _Authority()..start = (400, {'error': 'Web Terminal has no folder to start in'});
      final feed = auth.feed();
      await feed.refresh();
      final opened = <String>[];
      await tester.pumpWidget(_host(feed, opened));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('mc-start-refs')), '#5');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(find.text('Web Terminal has no folder to start in'), findsOneWidget);
      expect(opened, isEmpty);
      expect(find.byKey(const ValueKey('mc-start-sheet')), findsOneWidget);
    });
  });

  testWidgets('the Start work button is on the Now bar and opens the sheet', (tester) async {
    await _size(tester, const Size(1400, 1000));
    final auth = _Authority();
    final feed = auth.feed();
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: MissionControlHome(onShowSessionsHome: () {}, feed: feed, servers: () => const [_a]),
    ));
    await feed.refresh();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('mc-start-work')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mc-start-sheet')), findsOneWidget);
    feed.dispose();
  });

  testWidgets('a project page has its own Start work button, for that project; none without the callback', (tester) async {
    await _size(tester, const Size(1000, 1200));
    final auth = _Authority();
    final feed = auth.feed();
    await feed.refresh();
    var asked = 0;
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: McProjectScreen(feed: feed, projectId: 'web-terminal', onOpenSubject: (_) {}, onStartWork: () => asked++),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('mc-project-start-work')));
    expect(asked, 1);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: McProjectScreen(feed: feed, projectId: 'web-terminal', onOpenSubject: (_) {}),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mc-project-start-work')), findsNothing);
  });
}
