// #475 - the Supervisor: the dispatcher's row (`role: "supervisor"`) is never listed among the
// sessions ([listedSessions]), and the Supervisor page shows the dispatcher, its open cases,
// the autonomy switches and the decisions feed against a faked cluster (Home a peer naming
// Office, Office the authority). Pause and the switches POST to the authority; Talk to it
// opens the dispatcher's session; how it is reached (split pane, pushed on a phone).
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/supervisor_models.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/supervisor_screen.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/services/supervisor_lookup.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/util/listed_sessions.dart';
import 'package:ai_terminal/util/supervisor_authority.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 'tok');

const _disp = '00000000-0000-4000-8000-0000000000d1';
const _w = '00000000-0000-4000-8000-000000000001';

Session _row(String id, String name, {String? role}) => Session(
      id: id,
      name: name,
      cwd: '/w',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 1,
      notifyLevel: 'important',
      server: _office,
      role: role,
    );

Map<String, dynamic> _state(int now, {bool paused = false, String? dispatcherId = _disp}) => {
      'enabled': true,
      'role': 'authority',
      'at': now - 20000,
      'now': now,
      'everyMs': 60000,
      'complete': true,
      'servers': [
        {'name': 'Office', 'ok': true, 'sessions': 2},
      ],
      'sessions': [
        {'id': _disp, 'server': 'Office', 'name': 'web-terminal supervisor', 'status': 'working', 'role': 'supervisor', 'items': []},
        {'id': _w, 'server': 'Office', 'name': 'Worker', 'status': 'idle', 'items': []},
      ],
      'needsYou': [],
      'live': [_w],
      'readyToClose': [],
      'history': [],
      'cards': [],
      'cases': [
        {'id': 'c1', 'rule': 'R3', 'sessionId': _w, 'server': 'Office', 'name': 'Worker', 'line': 'same answer twice', 'openedAt': now - 60000,
         'deliveredAt': now - 50000, 'takenAt': now - 40000, 'escalated': null, 'resolvedAt': null},
        {'id': 'c0', 'rule': 'R2', 'sessionId': _w, 'server': 'Office', 'name': 'Worker', 'line': 'old', 'openedAt': now - 900000,
         'escalated': null, 'resolvedAt': now - 800000},
      ],
      'dispatcher': {'enabled': true, 'paused': paused, 'id': dispatcherId, 'status': dispatcherId == null ? null : 'working',
        'capped': false, 'startedAt': now - 3600000, 'state': paused ? 'paused' : 'working'},
      'autonomy': {
        'wake': {'mode': 'act', 'approved': 0, 'dismissed': 0, 'pending': 0, 'edited': 0, 'told': 0, 'retired': 0},
        'answer': {'mode': 'recommend', 'approved': 2, 'dismissed': 1, 'pending': 0, 'edited': 0, 'told': 0, 'retired': 0},
      },
      'actions': [
        {'at': now - 30000, 'id': _w, 'server': 'Office', 'rule': 'answer', 'text': 'Answered for the owner (can be undone): take the server side',
         'outcome': 'delivered', 'caseId': 'c1', 'undo': 'tell it to switch to the client side'},
        {'at': now - 40000, 'id': _w, 'server': 'Office', 'rule': 'coach', 'text': 'Coaching: step back', 'outcome': 'delivered', 'caseId': 'c1', 'undo': null},
      ],
    };

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status,
    headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  late List<String> asked;
  late Map<String, Object> answers;
  late List<Map<String, dynamic>> posted;
  late List<Session> opened;

  ApiClient client(ServerConfig sv) => ApiClient(sv, httpClient: MockClient((req) async {
        asked.add('${sv.name} ${req.method} ${req.url.path}');
        if (req.method == 'POST') {
          final b = jsonDecode(req.body) as Map<String, dynamic>;
          posted.add({'server': sv.name, 'path': req.url.path, ...b});
          return _json(req.url.path.endsWith('/pause') ? {'paused': b['paused']} : {'class': b['class'], 'mode': b['mode']});
        }
        final body = answers[sv.baseUrl];
        return body == null ? _json({'error': 'not found'}, 404) : _json(body);
      }));

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
    SupervisorFeed.instance.resetForTest();
    asked = [];
    posted = [];
    opened = [];
    final now = DateTime.now().millisecondsSinceEpoch;
    answers = {
      _home.baseUrl: {'role': 'peer', 'authority': {'name': 'office'}},
      _office.baseUrl: _state(now),
    };
  });
  tearDown(() {
    SessionSelection.instance.reset();
    SupervisorFeed.instance.resetForTest();
  });

  SupervisorScreen screen({bool embedded = false}) => SupervisorScreen(
        embedded: embedded,
        repository: SessionRepository.instance,
        onOpenSession: opened.add,
        servers: () => const [_home, _office],
        clientFactory: client,
        refreshFloor: const Duration(hours: 1),
      );

  Future<void> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: screen()));
    await tester.pump();
    await tester.pump();
  }

  Future<void> done(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  }

  // matchRoot: the state line's key is on its Text itself, and a descendant search skips the root.
  Finder inKey(String key, String text) =>
      find.descendant(of: find.byKey(ValueKey(key)), matching: find.textContaining(text), matchRoot: true);

  SupervisorFind foundFor(String? dispatcherId) => SupervisorFind(SupervisorFindKind.found,
      server: _office, state: SupervisorState.fromJson(_state(1000, dispatcherId: dispatcherId), receivedAt: DateTime.now()));

  test('listedSessions hides exactly the dispatcher the Supervisor entry stands for, in order', () {
    final rows = [_row('a', 'A'), _row(_disp, 'web-terminal supervisor', role: 'supervisor'), _row('b', 'B')];
    // Before the first answer the server's own word (its role) decides: no flash at launch.
    expect(listedSessions(rows, find: null).map((s) => s.id), ['a', 'b']);
    // The entry exists for that id: that row is the Supervisor...
    expect(listedSessions(rows, find: foundFor(_disp)).map((s) => s.id), ['a', 'b']);
    // ...by id, not by role: a hand-off's successor is hidden before its server tags it,
    expect(listedSessions([_row('a', 'A'), _row('succ', 'successor')], find: foundFor('succ')).map((s) => s.id), ['a']);
    // ...and a role-tagged row of ANOTHER dispatcher (the authority moved) is an ordinary session.
    expect(listedSessions(rows, find: foundFor('other')).map((s) => s.id), ['a', _disp, 'b']);
    expect(supervisorSessionOf(rows)?.id, _disp);
    expect(supervisorSessionOf(rows, id: 'b')?.id, 'b');
  });

  test('with no Supervisor entry the dispatcher is listed: never in no list and behind no entry', () {
    final rows = [_row('a', 'A'), _row(_disp, 'web-terminal supervisor', role: 'supervisor')];
    for (final find in [
      const SupervisorFind(SupervisorFindKind.off, message: 'off'),
      const SupervisorFind(SupervisorFindKind.nobodyAnswered, message: 'none'),
      foundFor(null), // the authority answered, but runs no dispatcher
    ]) {
      expect(listedSessions(rows, find: find).map((s) => s.id), ['a', _disp], reason: '${find.kind}');
    }
  });

  test('a row says it is the dispatcher only by its role; the cache keeps that role', () {
    final s = Session.fromJson(_office, {'id': _disp, 'name': 'x', 'role': 'supervisor'});
    expect(s.isSupervisor, isTrue);
    expect(Session.fromJson(_office, {'id': _w, 'name': 'y'}).isSupervisor, isFalse);
    expect(Session.fromJson(_office, {'id': _w, 'name': 'y', 'role': ''}).role, isNull);
    final back = SessionRepository.decodeSessionCache(SessionRepository.encodeSessionCache([s]), const [_office]);
    expect(back.single.isSupervisor, isTrue, reason: 'a cold launch must not list the dispatcher until the first poll');
  });

  test('the state carries the dispatcher, autonomy in served order, and actions with case and undo', () {
    final st = SupervisorState.fromJson(_state(1000), receivedAt: DateTime.fromMillisecondsSinceEpoch(1000))!;
    expect(st.dispatcher!.id, _disp);
    expect(st.dispatcher!.paused, isFalse);
    expect(st.autonomy.map((a) => '${a.cls}:${a.mode}'), ['wake:act', 'answer:recommend']);
    expect(st.actions.first.caseId, 'c1');
    expect(st.actions.first.undo, 'tell it to switch to the client side');
    expect(st.actions[1].undo, isNull);
    expect(st.cases.where((c) => c.open).map((c) => c.id), ['c1']);
    expect(st.cases.first.takenAt, isNotNull);
    expect(st.node(_disp)!.role, 'supervisor');
  });

  test('supervisorStateLine says what the dispatcher is doing, in its words', () {
    expect(supervisorStateLine(null, 0), contains('does not run'));
    expect(supervisorStateLine(const SupervisorDispatcher(enabled: false, state: 'off'), 0), startsWith('Off'));
    expect(supervisorStateLine(const SupervisorDispatcher(enabled: true, paused: true, state: 'paused'), 2), startsWith('Paused'));
    expect(supervisorStateLine(const SupervisorDispatcher(enabled: true, capped: true, id: 'x', state: 'capped'), 1), contains('usage cap'));
    expect(supervisorStateLine(const SupervisorDispatcher(enabled: true, state: 'not running'), 0), startsWith('Not running'));
    expect(supervisorStateLine(const SupervisorDispatcher(enabled: true, state: 'not running'), 2), 'Starting: 2 open cases wait for it');
    expect(supervisorStateLine(const SupervisorDispatcher(enabled: true, id: 'x', status: 'working', state: 'working'), 1), 'Working - 1 open case');
  });

  testWidgets('the page: the dispatcher, its open cases, autonomy and the decisions feed with case and undo', (tester) async {
    await pump(tester);
    expect(asked, contains('Office GET /api/supervisor/state'));
    expect(inKey('supervisor-state', 'Working - 1 open case'), findsOneWidget);
    expect(find.text('Open cases (1)'), findsOneWidget);
    expect(inKey('supervisor-case-c1', 'same answer twice'), findsOneWidget);
    expect(inKey('supervisor-case-c1', 'taken'), findsOneWidget);
    expect(find.byKey(const ValueKey('supervisor-case-c0')), findsNothing, reason: 'a resolved case is not open');
    expect(inKey('supervisor-autonomy-answer', '2 approved - 1 dismissed'), findsOneWidget);
    expect(find.text('Recent decisions (2)'), findsOneWidget);
    expect(inKey('supervisor-action-0', 'Answered for you'), findsOneWidget);
    expect(find.byKey(const ValueKey('supervisor-undo-0')), findsOneWidget);
    expect(inKey('supervisor-undo-0', 'To undo: tell it to switch to the client side'), findsOneWidget);
    expect(inKey('supervisor-action-0', 'case c1'), findsOneWidget);
    expect(find.byKey(const ValueKey('supervisor-undo-1')), findsNothing);
    // The answer is shared: the session list's Supervisor entry reads the same one.
    expect(SupervisorFeed.instance.find?.found, isTrue);
    await done(tester);
  });

  testWidgets('Talk to it opens the dispatcher session on the authority', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey('supervisor-talk')));
    await tester.pump();
    expect(opened.single.id, _disp);
    expect(opened.single.server.baseUrl, _office.baseUrl);
    await done(tester);
  });

  testWidgets('Talk to it finds the dispatcher by the name the app gives the authority, not the one its scan gives it', (tester) async {
    final st = _state(DateTime.now().millisecondsSinceEpoch);
    // The authority calls itself something else than the app does.
    ((st['sessions'] as List).first as Map<String, dynamic>)['server'] = 'office-main';
    answers[_office.baseUrl] = st;
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey('supervisor-talk')));
    await tester.pump();
    expect(opened.single.id, _disp);
    expect(opened.single.server.baseUrl, _office.baseUrl);
    await done(tester);
  });

  testWidgets('not running: Talk to it is off and says so', (tester) async {
    answers[_office.baseUrl] = _state(DateTime.now().millisecondsSinceEpoch, dispatcherId: null);
    await pump(tester);
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('supervisor-talk'))).onPressed, isNull);
    expect(inKey('supervisor-talk', 'Not running'), findsOneWidget);
    await done(tester);
  });

  testWidgets('Pause and an autonomy switch POST to the authority, never the peer', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey('supervisor-pause')));
    await tester.pump();
    await tester.pump();
    expect(posted, [
      {'server': 'Office', 'path': '/api/supervisor/pause', 'paused': true},
    ]);
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('supervisor-mode-wake')), matching: find.text('Ask')));
    await tester.pump();
    await tester.pump();
    expect(posted.last, {'server': 'Office', 'path': '/api/supervisor/autonomy', 'class': 'wake', 'mode': 'recommend'});
    expect(asked.where((a) => a.startsWith('Home POST')), isEmpty);
    await done(tester);
  });

  testWidgets('paused: the button resumes', (tester) async {
    answers[_office.baseUrl] = _state(DateTime.now().millisecondsSinceEpoch, paused: true);
    await pump(tester);
    expect(inKey('supervisor-state', 'Paused'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('supervisor-resume')));
    await tester.pump();
    await tester.pump();
    expect(posted.single['paused'], false);
    await done(tester);
  });

  testWidgets('no supervisor: an honest empty state', (tester) async {
    answers = {_home.baseUrl: {'role': 'none'}, _office.baseUrl: {'role': 'none'}};
    await pump(tester);
    expect(find.byKey(const ValueKey('supervisor-empty')), findsOneWidget);
    await done(tester);
  });

  test('DetailPane.supervisor is its own value', () {
    expect(DetailPane.supervisor.isBoard, isFalse);
    expect(DetailPane.supervisor, isNot(DetailPane.journal));
    SessionSelection.instance.showSupervisor();
    expect(SessionSelection.instance.supervisorShown, isTrue);
    expect(SessionSelection.instance.journalShown, isFalse);
    SessionSelection.instance.reset();
  });

  testWidgets('split view: the Supervisor entry on the rail shows it in the pane', (tester) async {
    tester.view.physicalSize = const Size(1600, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SupervisorFeed.instance.publish(await askSupervisor(const [_home, _office], client));
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: AdaptiveHome(supervisorBuilder: (open) => screen(embedded: true)),
    ));
    await tester.pump();
    expect(find.descendant(of: find.byKey(const ValueKey('open-supervisor')), matching: find.textContaining('Working')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('open-supervisor')));
    await tester.pumpAndSettle();
    expect(SessionSelection.instance.pane.value, DetailPane.supervisor);
    expect(find.byType(SupervisorScreen), findsOneWidget);
    expect(find.byType(BackButton), findsNothing);
    await done(tester);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('no supervisor answer yet: the session list shows no entry', (tester) async {
    tester.view.physicalSize = const Size(420, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome()));
    await tester.pump();
    expect(find.byKey(const ValueKey('open-supervisor')), findsNothing);
    await done(tester);
    await tester.pump(const Duration(seconds: 1));
  });
}
