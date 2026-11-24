// #523 - Mission Control's lines of work against a faked authority answering synthetic
// fixtures:
//   * the wire parse: `lines` on Now (absent on an older server -> null), the subject's
//     `line`, `GET /api/mc/lines`, junk tolerated;
//   * Now shows one card per line (project as a label, counts, stage bar) and falls back
//     to the projects when `lines` is absent;
//   * the Lines tab opens a line's subjects (`GET /api/mc/subjects?line=<id>`);
//   * the subject screen names its line and "Move to line..." sends the right body for a
//     pick, a new name and back to automatic, and shows a refusal's text;
//   * Start work sends `line` or `lineName`, never both, and no picker without lines.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/lines_view.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/start_work_sheet.dart';
import 'package:ai_terminal/screens/mission_control/subject_screen.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _json(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync()) as Map<String, dynamic>;

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

const _hunt = 'web-terminal/bug-hunter';
const _health = 'web-terminal/health';

Map<String, dynamic> _line(String id, String name, {int needsYou = 0, int sessions = 0, List<String> machines = const []}) => {
      'id': id,
      'name': name,
      'kind': 'config',
      'project': 'web-terminal',
      'projectName': 'Web Terminal',
      'counts': {
        'active': 3,
        'needsYou': needsYou,
        'waitsOnOthers': 0,
        'doneWeek': 0,
        'sessions': sessions,
        'stages': [
          {'stage': 'fixing', 'count': 2},
          {'stage': 'pr-open', 'count': 1},
        ],
      },
      'subjects': ['acme/widgets#41'],
      'machines': machines,
      'updatedAt': 1767225600000,
    };

final Map<String, dynamic> _lines = {
  'lines': [
    _line(_hunt, 'Bug hunter', needsYou: 2, sessions: 3, machines: ['alpha', 'beta']),
    _line(_health, 'Health'),
  ],
  'configured': [
    {'id': _hunt, 'name': 'Bug hunter', 'project': 'web-terminal', 'kind': 'config', 'projectName': 'Web Terminal'},
    {'id': _health, 'name': 'Health', 'project': 'web-terminal', 'kind': 'config', 'projectName': 'Web Terminal'},
    {'id': 'web-terminal/release', 'name': 'Release cut', 'project': 'web-terminal', 'kind': 'config', 'projectName': 'Web Terminal'},
  ],
  'generatedAt': 1,
};

/// Alpha is the authority. [withLines] makes it a server that sends lines.
class _Authority {
  _Authority({this.withLines = true});
  final bool withLines;
  final List<http.Request> requests = [];
  String source = 'rule';
  (int, Object) move = (200, {'subject': 'acme/widgets#41', 'line': {'id': _hunt, 'name': 'Bug hunter', 'project': 'web-terminal', 'kind': 'config', 'source': 'override'}});
  (int, Object) start = (200, {'server': 'alpha', 'serverUrl': null, 'sessionId': 'new-1', 'name': 'Web Terminal #1'});

  Map<String, dynamic> _lineRef() => {'id': _hunt, 'name': 'Bug hunter', 'project': 'web-terminal', 'kind': 'config', 'source': source};

  http.Response _answer(http.Request req) {
    requests.add(req);
    final path = req.url.path;
    if (path == '/api/mc/now') {
      final now = _json('mc_now.json');
      if (withLines) now['lines'] = _lines['lines'];
      return http.Response(jsonEncode(now), 200);
    }
    if (path == '/api/mc/subjects') {
      final subjects = _json('mc_subjects.json');
      for (final s in (subjects['subjects'] as List).whereType<Map<String, dynamic>>()) {
        s['line'] = _lineRef();
      }
      return http.Response(jsonEncode(subjects), 200);
    }
    if (path.startsWith('/api/mc/subjects/')) {
      final d = _json('mc_subject.json');
      (d['subject'] as Map<String, dynamic>)['line'] = _lineRef();
      return http.Response(jsonEncode(d), 200);
    }
    if (path == '/api/mc/lines/move') return http.Response(jsonEncode(move.$2), move.$1);
    if (path == '/api/mc/lines') {
      return withLines ? http.Response(jsonEncode(_lines), 200) : http.Response(jsonEncode({'error': 'Not found'}), 404);
    }
    if (path == '/api/mc/machines') {
      return http.Response(
          jsonEncode({
            'machines': [
              {'name': 'alpha', 'url': null, 'ok': true, 'why': null, 'sessions': 1, 'working': 0, 'load': 1},
            ],
            'suggested': 'alpha',
          }),
          200);
    }
    if (path == '/api/mc/start') return http.Response(jsonEncode(start.$2), start.$1);
    return http.Response(jsonEncode({'error': 'Not found'}), 404);
  }

  McFeed feed() => McFeed(
        servers: () => const [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async => _answer(req))),
      );

  List<Map<String, dynamic>> bodies(String path) => [
        for (final r in requests)
          if (r.url.path == path && r.method == 'POST') jsonDecode(r.body) as Map<String, dynamic>
      ];
}

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _home(McFeed feed) => MaterialApp(
      theme: AppTheme.dark,
      home: MissionControlHome(
        feed: feed,
        onShowSessionsHome: () {},
        sessionsBoardBuilder: (open) => const Scaffold(body: Text('the sessions board')),
      ),
    );

void main() {
  group('wire', () {
    test('Now carries lines when sent, null when absent (an older server)', () {
      final old = McNow.fromJson(_json('mc_now.json'));
      expect(old.lines, isNull);
      final now = McNow.fromJson({..._json('mc_now.json'), 'lines': _lines['lines']});
      expect(now.lines!.map((l) => l.id), [_hunt, _health]);
      final hunt = now.lines!.first;
      expect([hunt.name, hunt.kind, hunt.project, hunt.projectLabel], ['Bug hunter', 'config', 'web-terminal', 'Web Terminal']);
      expect([hunt.counts.needsYou, hunt.counts.sessions, hunt.counts.stageTotal], [2, 3, 3]);
      expect(hunt.machines, ['alpha', 'beta']);
      expect(hunt.subjects, ['acme/widgets#41']);
      expect(McNow.fromJson({'lines': []}).lines, isEmpty, reason: 'an empty list is a server with lines and none yet');
      expect(McNow.fromJson({'lines': 'x'}).lines, isNull);
      expect(McNow.fromJson({'lines': [7, null, {'name': 'no id'}]}).lines, isEmpty);
    });

    test('a subject carries its line and why', () {
      final s = McSubject.fromJson({
        'key': 'ado:101',
        'line': {'id': _hunt, 'name': 'Bug hunter', 'project': 'web-terminal', 'kind': 'config', 'source': 'override'}
      })!;
      expect([s.line!.id, s.line!.name, s.line!.source, s.line!.moved], [_hunt, 'Bug hunter', 'override', true]);
      expect(McSubject.fromJson({'key': 'ado:101'})!.line, isNull);
      expect(McSubject.fromJson({'key': 'ado:101', 'line': {'name': 'no id'}})!.line, isNull);
    });

    test('/api/mc/lines: lines, configured, and the picker choices without a repeat', () {
      final r = McLines.fromJson(_lines);
      expect(r.lines.length, 2);
      expect(r.configured.map((c) => c.name), ['Bug hunter', 'Health', 'Release cut']);
      final extra = McLines.fromJson({
        ..._lines,
        'lines': [..._lines['lines'] as List, _line('web-terminal/run:r1', 'Run of Repro')],
      });
      expect(extra.choices.map((c) => c.$2), ['Bug hunter', 'Health', 'Release cut', 'Run of Repro']);
      expect(McLines.fromJson('junk').choices, isEmpty);
      expect(McMoveResult.fromJson({'subject': 'ado:101', 'line': {'id': 'p/x', 'name': 'X', 'source': 'override'}}).line!.moved, isTrue);
    });
  });

  group('Now', () {
    testWidgets('shows one card per line with its project, counts and stage bar, and no project cards', (tester) async {
      await _size(tester, const Size(900, 1600));
      final auth = _Authority();
      final feed = auth.feed();
      addTearDown(feed.dispose);
      await feed.refresh();
      final opened = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McNowView(feed: feed, onAnswer: (_) {}, onOpenSession: (_) {}, onOpenLine: (l) => opened.add(l.id)),
        ),
      ));
      expect(find.text('Lines of work'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-line-$_hunt')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-line-$_health')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-project-web-terminal')), findsNothing, reason: 'lines replace the projects');
      final card = find.byKey(const ValueKey('mc-line-$_hunt'));
      expect(find.descendant(of: card, matching: find.text('Bug hunter')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('Web Terminal')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.textContaining('2 need you')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.textContaining('3 live sessions')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.textContaining('alpha, beta')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.byKey(const ValueKey('mc-stage-bar'))), findsOneWidget);
      await tester.tap(card);
      expect(opened, [_hunt]);
    });

    testWidgets('an older server (no lines) still shows the projects', (tester) async {
      await _size(tester, const Size(900, 1600));
      final feed = _Authority(withLines: false).feed();
      addTearDown(feed.dispose);
      await feed.refresh();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: McNowView(feed: feed, onAnswer: (_) {}, onOpenSession: (_) {})),
      ));
      expect(find.byKey(const ValueKey('mc-project-web-terminal')), findsOneWidget);
      expect(find.text('Lines of work'), findsNothing);
      expect(find.byType(McLineCard), findsNothing);
    });
  });

  group('Lines tab', () {
    testWidgets('a line tapped on Now opens its subjects (read by ?line=), a row opens the subject', (tester) async {
      await _size(tester, const Size(1400, 2400));
      final auth = _Authority();
      final feed = auth.feed();
      addTearDown(feed.dispose);
      await tester.pumpWidget(_home(feed));
      await feed.refresh();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-line-$_hunt')));
      await tester.pumpAndSettle();
      expect(find.byType(McLineScreen), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-line-name')), findsOneWidget);
      final asked = [for (final r in auth.requests) if (r.url.path == '/api/mc/subjects') r.url.queryParameters];
      expect(asked.last, {'line': _hunt}, reason: 'the id, URL-encoded on the wire and read back whole');
      expect(auth.requests.where((r) => r.url.path == '/api/mc/subjects').last.url.query, contains('line=web-terminal%2Fbug-hunter'));
      await tester.tap(find.byKey(const ValueKey('mc-subject-row-acme/widgets#41')));
      await tester.pumpAndSettle();
      expect(find.byType(McSubjectScreen), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(McLineScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the tab is labelled Lines and lists the lines, filtered by project chips', (tester) async {
      await _size(tester, const Size(1400, 2400));
      final feed = _Authority().feed();
      addTearDown(feed.dispose);
      await tester.pumpWidget(_home(feed));
      await feed.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Projects'), findsNothing);
      await tester.tap(find.text('Lines'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-projects-tab')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-line-$_hunt')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-lines-filter-all')), findsNothing, reason: 'one project: no chips');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a list with two projects offers a chip per project', (tester) async {
      await _size(tester, const Size(900, 1600));
      final other = McLine.fromJson({..._line('acme/docs', 'Docs'), 'project': 'acme', 'projectName': 'Acme'})!;
      final lines = [McLine.fromJson(_lines['lines'][0])!, other];
      final opened = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: SingleChildScrollView(child: McLinesList(lines: lines, onOpen: (l) => opened.add(l.id)))),
      ));
      expect(find.byType(McLineCard), findsNWidgets(2));
      await tester.tap(find.byKey(const ValueKey('mc-lines-filter-acme')));
      await tester.pump();
      expect(find.byType(McLineCard), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-line-acme/docs')), findsOneWidget);
    });
  });

  group('Move to line', () {
    Future<_Authority> open(WidgetTester tester, {String source = 'rule'}) async {
      await _size(tester, const Size(900, 2000));
      final auth = _Authority()..source = source;
      final feed = auth.feed();
      addTearDown(feed.dispose);
      await feed.refresh();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McSubjectScreen(feed: feed, subjectKey: 'acme/widgets#41', onAnswer: (_) {}, onOpenSession: (_) {}),
      ));
      await tester.pumpAndSettle();
      return auth;
    }

    testWidgets('the subject names its line and project; "moved by you" only after an override', (tester) async {
      await open(tester);
      expect(find.byKey(const ValueKey('mc-subject-line')), findsOneWidget);
      expect(find.text('Bug hunter · Web Terminal'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-subject-line-moved')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await open(tester, source: 'override');
      expect(find.byKey(const ValueKey('mc-subject-line-moved')), findsOneWidget);
    });

    testWidgets('picking a line sends {subject, line}', (tester) async {
      final auth = await open(tester);
      await tester.tap(find.byKey(const ValueKey('mc-subject-move-line')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-move-sheet')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-move-auto')), findsNothing, reason: 'nothing to undo yet');
      expect(find.text('Release cut'), findsOneWidget, reason: 'a configured line with no items is offered');
      await tester.tap(find.byKey(const ValueKey('mc-move-line-$_health')));
      await tester.pumpAndSettle();
      expect(auth.bodies('/api/mc/lines/move'), [
        {'subject': 'acme/widgets#41', 'line': _health}
      ]);
      expect(find.byKey(const ValueKey('mc-move-sheet')), findsNothing, reason: 'closed on success');
    });

    testWidgets('a new name sends {subject, name}, trimmed, and no line', (tester) async {
      final auth = await open(tester);
      await tester.tap(find.byKey(const ValueKey('mc-subject-move-line')));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byKey(const ValueKey('mc-move-new-go'))).onPressed, isNull, reason: 'a blank name is not sent');
      await tester.enterText(find.byKey(const ValueKey('mc-move-new')), '  Docket of fixes  ');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-move-new-go')));
      await tester.pumpAndSettle();
      expect(auth.bodies('/api/mc/lines/move'), [
        {'subject': 'acme/widgets#41', 'name': 'Docket of fixes'}
      ]);
    });

    testWidgets('the new-name field holds one line of at most 80 characters', (tester) async {
      await open(tester);
      await tester.tap(find.byKey(const ValueKey('mc-subject-move-line')));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(find.byKey(const ValueKey('mc-move-new')));
      expect(field.maxLength, 80);
      expect(field.maxLines, 1);
    });

    testWidgets('after an override, "Back to automatic" sends line: null', (tester) async {
      final auth = await open(tester, source: 'override');
      await tester.tap(find.byKey(const ValueKey('mc-subject-move-line')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-move-auto')));
      await tester.pumpAndSettle();
      final bodies = auth.bodies('/api/mc/lines/move');
      expect(bodies, [
        {'subject': 'acme/widgets#41', 'line': null}
      ]);
      expect(bodies.single.containsKey('line'), isTrue, reason: 'an explicit null, not an absent key');
      expect(bodies.single.containsKey('name'), isFalse);
    });

    testWidgets("a refusal shows the server's text and keeps the sheet", (tester) async {
      final auth = await open(tester);
      auth.move = (400, {'error': 'unknown line'});
      await tester.tap(find.byKey(const ValueKey('mc-subject-move-line')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-move-line-$_health')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-move-sheet')), findsOneWidget);
      expect(find.text('unknown line'), findsOneWidget);
      auth.move = (404, {'error': 'no session touched it this week'});
      await tester.tap(find.byKey(const ValueKey('mc-move-line-web-terminal/release')));
      await tester.pumpAndSettle();
      expect(find.text('no session touched it this week'), findsOneWidget);
    });
  });

  group('Start work', () {
    Future<_Authority> open(WidgetTester tester, {bool withLines = true}) async {
      await _size(tester, const Size(900, 1800));
      final auth = _Authority(withLines: withLines);
      final feed = auth.feed();
      addTearDown(feed.dispose);
      await feed.refresh();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              key: const ValueKey('open'),
              onPressed: () => showStartWorkSheet(context, feed: feed, projectId: 'web-terminal', onOpenSession: (id, s) {}),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      // A hunt needs no list of work items.
      await tester.tap(find.text('Hunt'));
      await tester.pumpAndSettle();
      return auth;
    }

    testWidgets('a picked line is sent as `line` (an id) and no `lineName`', (tester) async {
      final auth = await open(tester);
      await tester.tap(find.byKey(const ValueKey('mc-start-line')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Health (Web Terminal)').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      final b = auth.bodies('/api/mc/start').single;
      expect(b['line'], _health);
      expect(b.containsKey('lineName'), isFalse);
      expect(auth.requests.where((r) => r.url.path == '/api/mc/lines').single.url.queryParameters, {'project': 'web-terminal'});
    });

    testWidgets('a new line is sent as `lineName` (trimmed) and no `line`', (tester) async {
      final auth = await open(tester);
      await tester.tap(find.byKey(const ValueKey('mc-start-line')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New line...').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('mc-start-line-new')), ' Release cut 2 ');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      final b = auth.bodies('/api/mc/start').single;
      expect(b['lineName'], 'Release cut 2');
      expect(b.containsKey('line'), isFalse);
    });

    testWidgets('no line chosen sends neither; a server without lines shows no picker', (tester) async {
      final auth = await open(tester);
      expect(find.byKey(const ValueKey('mc-start-line')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      var b = auth.bodies('/api/mc/start').single;
      expect(b.containsKey('line') || b.containsKey('lineName'), isFalse);

      await tester.pumpWidget(const SizedBox());
      final old = await open(tester, withLines: false);
      expect(find.byKey(const ValueKey('mc-start-line')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      b = old.bodies('/api/mc/start').single;
      expect(b.containsKey('line') || b.containsKey('lineName'), isFalse);
    });
  });
}
