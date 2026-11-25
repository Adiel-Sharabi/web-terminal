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

/// Alpha is the authority. [start] answers `POST /api/mc/start`; [models] answers
/// `GET /api/mc/models` (#533) - null is an authority older than the picker (404).
class _Authority {
  final List<http.Request> requests = [];
  Object? models;
  (int, Object) start = (200, {'server': 'beta', 'serverUrl': 'https://beta.example.test', 'sessionId': 'new-1', 'name': 'Web Terminal #42'});

  http.Response _answer(http.Request req) {
    requests.add(req);
    final path = req.url.path;
    if (path == '/api/mc/now') return http.Response(jsonEncode(_json('mc_now.json')), 200);
    if (path == '/api/mc/subjects') return http.Response(jsonEncode(_json('mc_subjects.json')), 200);
    if (path == '/api/mc/machines') return http.Response(jsonEncode(_machines), 200);
    if (path == '/api/mc/models' && models != null) return http.Response(jsonEncode(models), 200);
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

/// The start sheet's model picker: what the authority serves, as the server's own catalogue (a JS
/// spec pins this file to it).
Map<String, dynamic> _modelsFixture() => _json('mc_models.json');

/// Picks [label] in the dropdown [key]: opens it, taps the item in the menu.
Future<void> _pick(WidgetTester tester, String key, String label) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.tap(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

String? _shown(WidgetTester tester, String key) =>
    tester.widget<DropdownButtonFormField<String>>(find.byKey(ValueKey(key))).initialValue;

/// A page with one button that opens the sheet for [projectId].
Widget _host(McFeed feed, List<String> opened, {String? projectId}) => MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            key: const ValueKey('open'),
            onPressed: () => showStartWorkSheet(context, feed: feed, projectId: projectId, onOpenSession: (id, initial) => opened.add('$id@${initial?.server.name}@${initial?.agentReady}')),
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

    test('#533 the model catalogue parses; what cannot draw a picker is no catalogue', () {
      final m = McStartModels.fromJson(_modelsFixture())!;
      expect(m.kinds.map((k) => k.id).toList(), ['fix', 'run', 'lookup', 'design']);
      expect(m.models.map((c) => c.id).toList(), ['default', 'sonnet', 'haiku']);
      // Work items begin on a routine fix, a hunt on design work (the server's defaults).
      expect(m.kindFor(hunt: false), 'fix');
      expect(m.kindFor(hunt: true), 'design');
      // A kind suggests its model; the design kind names none = the default model's id.
      expect(m.suggestedModel('fix'), 'sonnet');
      expect(m.suggestedModel('lookup'), 'haiku');
      expect(m.suggestedModel('design'), 'default');
      expect(m.labelOf('haiku'), 'Haiku');
      expect(m.labelOf('claude-x'), 'claude-x');
      // A server naming no default kind we list: the first kind, never a crash.
      expect(McStartModels.fromJson({..._modelsFixture(), 'defaults': {'subjects': 'nope'}})!.kindFor(hunt: false), 'fix');
      // Junk, or a reply with no kinds or no models: no picker.
      expect(McStartModels.fromJson({'kinds': [7, null], 'models': _modelsFixture()['models']}), isNull);
      expect(McStartModels.fromJson({'kinds': _modelsFixture()['kinds'], 'models': []}), isNull);
      expect(McStartModels.fromJson('x'), isNull);
      // A start command that cannot take --model (`modelPlaceable: false`) draws no picker, like an older
      // authority; a server that says nothing about it reads as able.
      expect(McStartModels.fromJson({..._modelsFixture(), 'modelPlaceable': false}), isNull);
      expect(McStartModels.fromJson({..._modelsFixture(), 'modelPlaceable': true}), isNotNull);
      expect(McStartModels.fromJson({..._modelsFixture()}..remove('modelPlaceable')), isNotNull);
    });

    test('#533 the start answer, a card and a session row carry their model', () {
      final r = McStartResult.fromJson({'sessionId': 'x', 'model': 'sonnet', 'kind': 'fix'})!;
      expect([r.model, r.kind], ['sonnet', 'fix']);
      expect(McStartResult.fromJson({'sessionId': 'x'})!.model, isNull);
      expect(McSubjectSession.fromJson({'id': 's', 'model': 'haiku'})!.model, 'haiku');
      expect(McSubjectSession.fromJson({'id': 's', 'model': ''})!.model, isNull);
      // The session line a card face shows: name, machine and model - what is absent is left out.
      final c = McCard.fromJson({'id': 'c', 'sessionName': 'WI 7', 'server': 'beta', 'model': 'sonnet'})!;
      expect(c.model, 'sonnet');
      expect(c.sessionLine, 'WI 7 · beta · sonnet');
      expect(McCard.fromJson({'id': 'c', 'sessionName': 'WI 7', 'server': 'beta'})!.sessionLine, 'WI 7 · beta');
      expect(McCard.fromJson({'id': 'c'})!.sessionLine, '');
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
      // Started on a peer this app does not list: opened by id alone.
      expect(opened, ['new-1@null@null']);
      expect(find.byKey(const ValueKey('mc-start-sheet')), findsNothing);
    });

    testWidgets('a hunt needs no work item and sends none', (tester) async {
      await _size(tester, const Size(900, 1400));
      final auth = _Authority()
        ..start = (200, {'server': 'alpha', 'serverUrl': null, 'sessionId': 'new-2', 'agent': 'claude', 'agentReady': false});
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
      // Started on the authority itself: opened with its session object, on the server that
      // answered, not ready yet (#147).
      expect(opened, ['new-2@Alpha@false']);
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

  group('#533 model picker', () {
    Future<_Authority> open(WidgetTester tester, {bool withModels = true, List<String>? opened}) async {
      await _size(tester, const Size(900, 1600));
      final auth = _Authority();
      if (withModels) auth.models = _modelsFixture();
      final feed = auth.feed();
      await feed.refresh();
      await tester.pumpWidget(_host(feed, opened ?? <String>[], projectId: 'web-terminal'));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      return auth;
    }

    testWidgets('work items begin on the routine-fix kind and Sonnet, marked as the suggestion; the start carries both', (tester) async {
      final auth = await open(tester);
      expect(_shown(tester, 'mc-start-kind'), 'fix');
      expect(_shown(tester, 'mc-start-model'), 'sonnet');
      expect(find.text('Sonnet (suggested)'), findsWidgets);
      expect(find.byKey(const ValueKey('mc-start-model-note')), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('mc-start-refs')), '#5');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single, containsPair('kind', 'fix'));
      expect(auth.startBodies.single, containsPair('model', 'sonnet'));
    });

    testWidgets('a hunt begins on design work and the default model, and the start says so', (tester) async {
      final auth = await open(tester);
      await tester.tap(find.text('Hunt'));
      await tester.pumpAndSettle();
      expect(_shown(tester, 'mc-start-kind'), 'design');
      expect(_shown(tester, 'mc-start-model'), 'default');
      expect(find.text('Default model (suggested)'), findsWidgets);
      // Back to work items: the kind follows the mode again while nothing was picked.
      await tester.tap(find.text('Work items'));
      await tester.pumpAndSettle();
      expect(_shown(tester, 'mc-start-kind'), 'fix');
      expect(_shown(tester, 'mc-start-model'), 'sonnet');
      await tester.tap(find.text('Hunt'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single, containsPair('hunt', true));
      expect(auth.startBodies.single, containsPair('kind', 'design'));
      expect(auth.startBodies.single, containsPair('model', 'default'));
    });

    testWidgets('picking another kind moves the model to that kind\'s suggestion', (tester) async {
      await open(tester);
      await _pick(tester, 'mc-start-kind', 'Lookup, status check or build');
      expect(_shown(tester, 'mc-start-kind'), 'lookup');
      expect(_shown(tester, 'mc-start-model'), 'haiku');
      await _pick(tester, 'mc-start-kind', 'Design, ambiguous or security work');
      expect(_shown(tester, 'mc-start-model'), 'default');
    });

    testWidgets('a model the person picked sticks across a change of kind and of mode, and is what the start sends', (tester) async {
      final auth = await open(tester);
      await _pick(tester, 'mc-start-model', 'Haiku');
      expect(_shown(tester, 'mc-start-model'), 'haiku');
      await _pick(tester, 'mc-start-kind', 'Design, ambiguous or security work');
      expect(_shown(tester, 'mc-start-kind'), 'design');
      expect(_shown(tester, 'mc-start-model'), 'haiku');
      await tester.tap(find.text('Hunt'));
      await tester.pumpAndSettle();
      expect(_shown(tester, 'mc-start-model'), 'haiku');
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single, containsPair('kind', 'design'));
      expect(auth.startBodies.single, containsPair('model', 'haiku'));
    });

    testWidgets('a kind the person picked is not moved by the mode', (tester) async {
      await open(tester);
      await _pick(tester, 'mc-start-kind', 'Watch, deploy or merge run');
      await tester.tap(find.text('Hunt'));
      await tester.pumpAndSettle();
      expect(_shown(tester, 'mc-start-kind'), 'run');
      expect(_shown(tester, 'mc-start-model'), 'sonnet');
    });

    testWidgets('an authority older than the picker (404): no picker, and the start sends neither kind nor model', (tester) async {
      final auth = await open(tester, withModels: false);
      expect(find.byKey(const ValueKey('mc-start-kind')), findsNothing);
      expect(find.byKey(const ValueKey('mc-start-model')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('mc-start-refs')), '#5');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single.containsKey('kind'), isFalse);
      expect(auth.startBodies.single.containsKey('model'), isFalse);
    });

    testWidgets('a catalogue that cannot draw a picker is the same as none: the work still starts', (tester) async {
      await _size(tester, const Size(900, 1600));
      final auth = _Authority()..models = {'kinds': [], 'models': []};
      final feed = auth.feed();
      await feed.refresh();
      await tester.pumpWidget(_host(feed, <String>[], projectId: 'web-terminal'));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-start-kind')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('mc-start-refs')), '#5');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single.containsKey('model'), isFalse);
    });

    testWidgets('a start command that cannot take --model (modelPlaceable false): no picker, and the start sends neither kind nor model', (tester) async {
      await _size(tester, const Size(900, 1600));
      final auth = _Authority()..models = {..._modelsFixture(), 'modelPlaceable': false};
      final feed = auth.feed();
      await feed.refresh();
      await tester.pumpWidget(_host(feed, <String>[], projectId: 'web-terminal'));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-start-kind')), findsNothing);
      expect(find.byKey(const ValueKey('mc-start-model')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('mc-start-refs')), '#5');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-start-go')));
      await tester.pumpAndSettle();
      expect(auth.startBodies.single.containsKey('kind'), isFalse);
      expect(auth.startBodies.single.containsKey('model'), isFalse);
    });

    testWidgets('the session it opens carries the model the server started it with', (tester) async {
      await _size(tester, const Size(900, 1600));
      final auth = _Authority()
        ..models = _modelsFixture()
        ..start = (200, {'server': 'alpha', 'serverUrl': null, 'sessionId': 'new-3', 'model': 'sonnet', 'kind': 'fix'});
      final feed = auth.feed();
      await feed.refresh();
      final s = feed.startedSession(McStartResult.fromJson(auth.start.$2)!);
      expect(s?.model, 'sonnet');
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
