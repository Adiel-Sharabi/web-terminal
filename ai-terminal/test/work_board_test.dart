// #306 — the sessions dashboard in the companion, redesigned by #337 into a board of
// three columns with controls. Pins the wire parsing of a session's `brief` (built
// server-side by lib/session-brief.js), the API calls, the pure status/section rules,
// and the screen end to end against a faked server: which column a session sits in,
// and that every control writes the bytes its OWNER builds - a question's answer
// through buildAnswerFrames, a reply through buildComposeSubmission, Stop as a lone
// Esc - plus Not waiting, hide, pin, and Reopen of a closed session.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart' show buildComposeSubmission;
import 'package:ai_terminal/screens/work_board_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/theme/status_colors.dart';
import 'package:ai_terminal/widgets/question_overlay.dart' show buildAnswerFrames;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

Map<String, dynamic> _briefJson({
  List<Object>? items,
  String reporting = 'on',
  Map<String, dynamic>? stale,
}) =>
    {
      'v': 1,
      'reporting': reporting,
      'items': items ??
          [
            {'ref': '#291', 'key': 'o/r#291', 'title': 'Dictation', 'state': 'ready-for-test', 'note': '', 'source': 'agent', 'url': 'https://github.com/o/r/issues/291'},
          ],
      'headline': 'Dictation shipped',
      'reportAt': 1000,
      'now': {'text': 'Run the tests', 'at': 2000},
      'did': {'text': 'Fixed the mic', 'at': 3000},
      'prompt': {'text': 'mark it ready', 'at': 4000},
      'stale': stale,
    };

Map<String, dynamic> _row(String id, String name,
        {String status = 'idle',
        Object? brief,
        String? waitingFor,
        Object? reason,
        bool favorite = false,
        int? rank,
        Object? handoff}) =>
    {
      'id': id,
      'name': name,
      'cwd': '/w',
      'status': status,
      'notifyLevel': 'important',
      'agent': 'claude',
      'waitingFor': waitingFor,
      'brief': brief,
      'reason': reason,
      'favorite': favorite,
      'favoriteRank': rank,
      'handoff': handoff,
    };

Session _session(String id, {SessionBrief? brief, String status = 'idle'}) => Session(
      id: id,
      name: id,
      cwd: '/w',
      status: status,
      claudeSessionId: null,
      lastActivity: null,
      notifyLevel: 'important',
      server: _server,
      brief: brief,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionBrief.fromJson', () {
    test('reads every field the server builds', () {
      final b = SessionBrief.fromJson(_briefJson(stale: {'reason': '3 prompts since the last report', 'since': 1}))!;
      expect(b.reportingOn, isTrue);
      expect(b.items.single.ref, '#291');
      expect(b.items.single.key, 'o/r#291');
      expect(b.items.single.state, 'ready-for-test');
      expect(b.items.single.pinned, isFalse);
      expect(b.items.single.url, 'https://github.com/o/r/issues/291');
      expect(b.headline, 'Dictation shipped');
      expect(b.now!.text, 'Run the tests');
      expect(b.did!.at, 3000);
      expect(b.prompt!.text, 'mark it ready');
      expect(b.staleReason, '3 prompts since the last report');
    });

    test('absent or malformed degrades to null, never throws', () {
      expect(SessionBrief.fromJson(null), isNull);
      expect(SessionBrief.fromJson('x'), isNull);
      final s = Session.fromJson(_server, _row('a', 'a'));
      expect(s.brief, isNull);
    });

    test('a non-https link is dropped; an item with no ref is dropped; key falls back to ref', () {
      final b = SessionBrief.fromJson(_briefJson(items: [
        {'ref': '#1', 'url': 'javascript:alert(1)', 'source': 'pinned'},
        {'ref': '', 'title': 'no ref'},
        'not a map',
      ]))!;
      expect(b.items, hasLength(1));
      expect(b.items.single.url, isNull);
      expect(b.items.single.key, '#1');
      expect(b.items.single.pinned, isTrue);
      expect(b.pinnedForPatch, [
        {'ref': '#1', 'title': ''},
      ]);
    });

    test('toPinJson sends what was pinned, not the merged card values', () {
      final withPin = BriefItem.fromJson({'ref': '#5', 'title': 'agent title', 'state': 'in-progress', 'source': 'pinned', 'pin': {'title': 'mine', 'state': null}})!;
      expect(withPin.toPinJson(), {'ref': '#5', 'title': 'mine'});
      // A server too old to send `pin`: the merged values are all there is.
      final old = BriefItem.fromJson({'ref': '#5', 'title': 'agent title', 'state': 'in-progress', 'source': 'pinned'})!;
      expect(old.toPinJson(), {'ref': '#5', 'title': 'agent title', 'state': 'in-progress'});
    });

    test('reporting off is carried', () {
      expect(SessionBrief.fromJson(_briefJson(reporting: 'off'))!.reportingOn, isFalse);
    });

    test('Session.fromJson carries the brief', () {
      final s = Session.fromJson(_server, _row('a', 'a', brief: _briefJson()));
      expect(s.brief!.items.single.title, 'Dictation');
    });
  });

  group('ApiClient', () {
    test('patchBrief sends PATCH with only the keys given and returns the rebuilt brief', () async {
      late http.Request seen;
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        seen = req;
        return http.Response(jsonEncode({'ok': true, 'brief': _briefJson(reporting: 'off')}), 200);
      }));
      final b = await client.patchBrief('s1', optOut: true);
      expect(seen.method, 'PATCH');
      expect(seen.url.path, '/api/sessions/s1/brief');
      expect(seen.headers['authorization'], 'Bearer tok');
      expect(jsonDecode(seen.body), {'optOut': true});
      expect(b!.reportingOn, isFalse);
    });

    test('#337: a closed record carries what a Reopen needs; without a resume command it cannot reopen', () {
      final c = ClosedSession.fromJson(_server, {
        'id': 'x',
        'cwd': 'C:/w',
        'agent': 'claude',
        'claudeSessionId': 'abc-123',
        'resumeCommand': 'claude --resume abc-123',
      })!;
      expect((c.cwd, c.agent, c.claudeSessionId, c.resumeCommand), ('C:/w', 'claude', 'abc-123', 'claude --resume abc-123'));
      expect(c.canReopen, isTrue);
      // An older server sends none of it; a record the server could not resume says null.
      expect(ClosedSession.fromJson(_server, {'id': 'y'})!.canReopen, isFalse);
      expect(ClosedSession.fromJson(_server, {'id': 'z', 'cwd': 'C:/w', 'resumeCommand': null})!.canReopen, isFalse);
      expect(ClosedSession.fromJson(_server, {'id': 'w', 'cwd': '  ', 'resumeCommand': 'claude --resume q'})!.canReopen, isFalse);
    });

    test('dashboardClosed parses the list and tags the server', () async {
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        expect(req.url.path, '/api/dashboard/closed');
        return http.Response(jsonEncode({
          'closed': [
            {'id': 'x', 'name': 'old one', 'items': [{'ref': '#5', 'state': 'done'}], 'did': {'text': 'finished', 'at': 9}, 'at': 10},
            {'name': 'no id'},
          ],
        }), 200);
      }));
      final list = await client.dashboardClosed();
      expect(list, hasLength(1));
      expect(list.single.name, 'old one');
      expect(list.single.server, _server);
      expect(list.single.items.single.state, 'done');
    });

    test('#340: startHandoff POSTs an empty JSON body; cancelHandoff DELETEs the same route', () async {
      final seen = <http.Request>[];
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        seen.add(req);
        return http.Response(jsonEncode({'ok': true}), 200);
      }));
      await client.startHandoff('s1');
      await client.cancelHandoff('s1');
      expect(seen.map((r) => '${r.method} ${r.url.path}'), ['POST /api/sessions/s1/handoff', 'DELETE /api/sessions/s1/handoff']);
      expect(jsonDecode(seen.first.body), isEmpty);
      expect(seen.first.headers['content-type'], contains('application/json'));
      expect(seen.last.headers['authorization'], 'Bearer tok');
    });

    test('#340: a 409 carries the server\'s own words; a 404 on cancel is a 404', () async {
      final client = ApiClient(_server, httpClient: MockClient((req) async => req.method == 'POST'
          ? http.Response(jsonEncode({'error': 'Not a hand-off candidate', 'why': 'ctx-too-small'}), 409)
          : http.Response(jsonEncode({'error': 'No hand-off to cancel'}), 404)));
      await expectLater(
          client.startHandoff('s1'),
          throwsA(isA<ApiException>()
              .having((e) => e.status, 'status', 409)
              .having((e) => e.message, 'message', 'Not a hand-off candidate')));
      await expectLater(client.cancelHandoff('s1'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });
  });

  group('rules', () {
    test('boardStatusOf: capped wins, a question is named', () {
      final capped = Session.fromJson(_server, {
        ..._row('a', 'a', status: 'working'),
        'usageLimit': {'waiting': true, 'armed': false},
      });
      expect(boardStatusOf(capped).label, 'Capped');
      expect(boardStatusOf(capped).color, StatusColor.capped);
      final q = Session.fromJson(_server, _row('b', 'b', status: 'waiting', waitingFor: 'question'));
      expect(boardStatusOf(q).label, 'Question for you');
      expect(boardStatusOf(_session('c', status: 'working')).label, 'Working');
    });

    test('reasonSectionOf: a peer without `reason` that is working is Working, not Idle', () {
      expect(reasonSectionOf(_session('w', status: 'working', brief: const SessionBrief(headline: 'h'))), ReasonSection.working);
      expect(reasonSectionOf(_session('i', brief: const SessionBrief(headline: 'h'))), ReasonSection.idle);
      expect(reasonSectionOf(_session('n')), ReasonSection.notReported);
    });

    test('a session stuck in a menu needs you (#316)', () {
      final s = Session.fromJson(_server, _row('m', 'menu one', reason: {'kind': 'menu', 'source': 'screen'}));
      expect(boardNeedsYou(s), isTrue);
      expect(reasonSectionOf(s), ReasonSection.needsYou);
    });

    test('noItemReason distinguishes never-reported, off and empty', () {
      expect(noItemReason(_session('a')), 'Not reporting');
      expect(noItemReason(_session('a', brief: const SessionBrief(reportingOn: false))), 'Reporting is off for this session');
      expect(noItemReason(_session('a', brief: const SessionBrief())), 'No work item');
    });

    test('state labels', () {
      expect(briefStateLabel('ready-for-test'), 'ready for test');
      expect(kBriefItemStates, contains('committed'));
    });
  });

  group('WorkBoardScreen', () {
    late List<http.Request> patches;
    late List<http.Request> posts;

    /// Every POST/DELETE to /api/sessions/:id/handoff (#340), and what the server answers.
    late List<http.Request> handoffCalls;
    late int handoffStatus;
    late String handoffReply;
    late List<String> paths;
    late List<Map<String, dynamic>> rows;
    late List<String> capabilities;
    late List<Map<String, dynamic>> closed;

    /// The pending question per session id, as `GET /pending-question` answers it.
    late Map<String, Map<String, dynamic>> questions;

    /// Every key the board wrote, as (session id, keys) - through the injected
    /// [SessionInputRunner], i.e. exactly what would go down the session's socket.
    late List<(String, String)> sent;
    late bool inputReachable;

    Future<bool> fakeInput(Session s, Future<void> Function(void Function(String keys) send) body) async {
      if (!inputReachable) return false;
      await body((keys) {
        sent.add((s.id, keys));
        // The question clears once its confirming Enter lands.
        if (keys == '\r') questions.remove(s.id);
      });
      return true;
    }

    ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
          paths.add(req.url.path);
          final q = RegExp(r'^/api/sessions/([^/]+)/pending-question$').firstMatch(req.url.path);
          if (q != null) {
            final pending = questions[q.group(1)];
            return http.Response(jsonEncode(pending == null ? {'pending': false} : {'pending': true, 'question': pending}), 200);
          }
          if (RegExp(r'^/api/sessions/[^/]+/handoff$').hasMatch(req.url.path)) {
            handoffCalls.add(req);
            return http.Response(handoffReply, handoffStatus);
          }
          if (req.method == 'POST' && req.url.path == '/api/sessions') {
            posts.add(req);
            final body = jsonDecode(req.body) as Map;
            return http.Response(jsonEncode({'id': 'reopened-1', 'name': body['name'], 'agent': body['agent']}), 200);
          }
          switch (req.url.path) {
            case '/api/version':
              return http.Response(jsonEncode({'version': '1.81.0', 'serverName': 'Home', 'serverColor': '#E27BF5', 'capabilities': capabilities}), 200);
            case '/api/sessions':
              return http.Response(jsonEncode(rows), 200);
            case '/api/machine':
              return http.Response(jsonEncode({
                'name': 'Home',
                'cpu': {'pct': 12, 'cores': 16, 'level': 'ok'},
                'memory': {'availBytes': 3 * 1073741824, 'totalBytes': 64 * 1073741824, 'level': 'warn'},
                'commit': {'availBytes': 19 * 1073741824, 'totalBytes': 68 * 1073741824, 'level': 'ok'},
                'disks': [
                  {'root': 'C:', 'freeBytes': 5 * 1073741824, 'totalBytes': 931 * 1073741824, 'level': 'hot'},
                ],
                'sessions': {'count': 2, 'working': 1, 'waiting': 1, 'max': 10, 'level': 'ok'},
                'uptimeSec': 90000,
              }), 200);
            case '/api/dashboard/closed':
              return http.Response(jsonEncode({'closed': closed}), 200);
          }
          if (req.method == 'PATCH') {
            patches.add(req);
            return http.Response(jsonEncode({'ok': true, 'brief': _briefJson()}), 200);
          }
          return http.Response('', 404);
        }));

    Future<SessionRepository> repo() async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      return SessionRepository.forTest(store: store, clientFactory: client);
    }

    setUp(() {
      patches = [];
      posts = [];
      handoffCalls = [];
      handoffStatus = 200;
      handoffReply = jsonEncode({'ok': true});
      paths = [];
      sent = [];
      questions = {};
      inputReachable = true;
      capabilities = ['session-brief', 'session-hide', 'favorites-sync', 'session-clear-wait', 'session-handoff'];
      closed = [
        {'id': 'gone', 'name': 'Finished session', 'items': [], 'did': {'text': 'wrapped up'}, 'at': DateTime.now().millisecondsSinceEpoch},
      ];
      rows = [
        _row('s1', 'Dictation work', status: 'working', brief: _briefJson(
          items: [
            {'ref': '#291', 'key': 'o/r#291', 'title': 'Dictate', 'state': 'ready-for-test', 'source': 'agent'},
            // Pinned with no state; 'blocked' and the title are what the agent's report
            // lent the card. Only `pin` may be sent back.
            {'ref': '#777', 'key': 'o/r#777', 'title': 'Pinned thing', 'state': 'blocked', 'source': 'pinned', 'pin': {'title': '', 'state': null}},
          ],
          stale: {'reason': 'gh issue close touched #4242 after the last report'},
        )),
        _row('s2', 'Waiting one', status: 'waiting', waitingFor: 'permission'),
      ];
    });

    Future<List<Session>> pump(WidgetTester tester, {required SessionRepository r, double width = 1200}) async {
      final opened = <Session>[];
      tester.view.physicalSize = Size(width, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: WorkBoardScreen(
          repository: r,
          servers: () => const [_server],
          clientFactory: client,
          sessionInput: fakeInput,
          pollInterval: const Duration(hours: 1),
          onOpenSession: opened.add,
        ),
      ));
      await tester.runAsync(() => r.refresh());
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      return opened;
    }

    /// Lets the board's own async work (HTTP, paced frames, the answer check) run.
    Future<void> settle(WidgetTester tester, [Duration d = const Duration(milliseconds: 50)]) async {
      await tester.runAsync(() => Future<void>.delayed(d));
      await tester.pump();
    }

    Finder inCol(String col, Finder f) => find.descendant(of: find.byKey(ValueKey('board-col-$col')), matching: f);

    testWidgets('Machines (#331): collapsed it asks nothing; opened it reads each server', (tester) async {
      capabilities = [...capabilities, 'machine-profile'];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.byKey(const ValueKey('board-machines')), findsOneWidget);
      expect(paths, isNot(contains('/api/machine')), reason: 'collapsed costs the server nothing');
      expect(find.byKey(ValueKey('board-machine-${_server.baseUrl}')), findsNothing);

      await tester.tap(find.text('Machines'));
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(paths, contains('/api/machine'));
      final card = find.byKey(ValueKey('board-machine-${_server.baseUrl}'));
      expect(find.descendant(of: card, matching: find.text('2 of 10 · 1 working · 1 waiting')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('3.0 GB free of 64 GB')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('19 GB free of 68 GB')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('C: 5.0 GB free of 931 GB')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('up 1d 1h')), findsOneWidget);
      // the server's level colours it: a nearly full drive is the error colour
      final disk = tester.widget<Text>(find.descendant(of: card, matching: find.text('C: 5.0 GB free of 931 GB')));
      expect(disk.style?.color, AppTheme.dark.colorScheme.error);
      // remembered on this device - and it is the only view setting left to remember (#337)
      final saved = jsonDecode((await SharedPreferences.getInstance()).getString('wt.dashboard.view')!) as Map;
      expect(saved, {'machines': true});
    });

    testWidgets('Machines: a server too old for it says so and is never asked', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final r = await repo();
      await pump(tester, r: r);
      await tester.tap(find.text('Machines'));
      await tester.pump();
      expect(find.text('this server is too old to report its machine'), findsOneWidget);
      expect(paths, isNot(contains('/api/machine')));
    });

    /// Advances the fake clock in small steps, so paced frames and polls all run.
    Future<void> advance(WidgetTester tester, Duration total) async {
      for (var t = Duration.zero; t < total; t += const Duration(milliseconds: 100)) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('#337: three columns - Needs you, Working (incl. on its own / blocked), Idle - each with a count',
        (tester) async {
      rows = [
        _row('w', 'Running one', status: 'working', brief: _briefJson()),
        _row('p', 'Permission one', status: 'waiting', waitingFor: 'permission', brief: _briefJson()),
        _row('o', 'Own one', brief: _briefJson(), reason: {'kind': 'self', 'text': 'waiting for CI', 'source': 'reported'}),
        _row('x', 'External one', brief: _briefJson(), reason: {'kind': 'external', 'text': 'vendor licence', 'source': 'reported'}),
        _row('i', 'Idle one', brief: _briefJson()),
        _row('d', 'Done one', brief: _briefJson(), reason: {'kind': 'done', 'text': 'pushed', 'source': 'reported'}),
        _row('n', 'Quiet one'),
      ];
      final r = await repo();
      await pump(tester, r: r);

      expect(inCol('you', find.text('Permission one')), findsOneWidget);
      for (final name in ['Running one', 'Own one', 'External one']) {
        expect(inCol('work', find.text(name)), findsOneWidget, reason: name);
      }
      for (final name in ['Idle one', 'Done one', 'Quiet one']) {
        expect(inCol('idle', find.text(name)), findsOneWidget, reason: name);
      }
      expect(tester.widget<Text>(find.byKey(const ValueKey('board-count-Needs you'))).data, '1');
      expect(tester.widget<Text>(find.byKey(const ValueKey('board-count-Working'))).data, '3');
      expect(tester.widget<Text>(find.byKey(const ValueKey('board-count-Idle / done'))).data, '3');
      // What each says: the now-line, and the reason in plain words.
      expect(inCol('work', find.textContaining('Now: Run the tests')), findsOneWidget);
      expect(inCol('work', find.textContaining('On its own: waiting for CI')), findsOneWidget);
      expect(inCol('work', find.textContaining('Blocked on others: vendor licence')), findsOneWidget);
      expect(inCol('work', find.textContaining('Last did: Fixed the mic')), findsWidgets);
      // The idle line says what it did.
      expect(inCol('idle', find.text('Fixed the mic')), findsWidgets);
      // A permission prompt has no approval path in the companion: Open, and it says so.
      expect(inCol('you', find.textContaining('Permission: Run the tests')), findsOneWidget);
      expect(inCol('you', find.text('Allow or deny it in the session.')), findsOneWidget);

      // Side by side on a wide window.
      final you = tester.getTopLeft(find.byKey(const ValueKey('board-col-you')));
      final work = tester.getTopLeft(find.byKey(const ValueKey('board-col-work')));
      final idle = tester.getTopLeft(find.byKey(const ValueKey('board-col-idle')));
      expect(you.dy, work.dy);
      expect(you.dx, lessThan(work.dx));
      expect(work.dx, lessThan(idle.dx));

      // Every chrome the board used to carry is gone (#337).
      for (final gone in ['board-tabs', 'board-favorites', 'board-sort', 'board-grouping', 'board-search', 'board-chip-you']) {
        expect(find.byKey(ValueKey(gone)), findsNothing, reason: '$gone was removed');
      }
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: on a phone the columns stack into one', (tester) async {
      rows = [
        _row('w', 'Running one', status: 'working', brief: _briefJson()),
        _row('p', 'Permission one', status: 'waiting', waitingFor: 'permission'),
        _row('i', 'Idle one', brief: _briefJson()),
      ];
      final r = await repo();
      await pump(tester, r: r, width: 390);
      final you = tester.getTopLeft(find.byKey(const ValueKey('board-col-you')));
      final work = tester.getTopLeft(find.byKey(const ValueKey('board-col-work')));
      final idle = tester.getTopLeft(find.byKey(const ValueKey('board-col-idle')));
      expect(work.dx, you.dx);
      expect(idle.dx, you.dx);
      expect(you.dy, lessThan(work.dy));
      expect(work.dy, lessThan(idle.dy));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('cards: work items, stale warning; Open opens the session', (tester) async {
      final r = await repo();
      final opened = await pump(tester, r: r);
      expect(find.text('Dictation work'), findsOneWidget);
      expect(find.text('#291'), findsOneWidget);
      expect(find.text('ready for test'), findsOneWidget);
      expect(find.textContaining('Report may be out of date: gh issue close touched #4242'), findsOneWidget);
      expect(inCol('you', find.text('Waiting one')), findsOneWidget);
      await tester.tap(find.byKey(ValueKey('board-open-${_server.baseUrl}-s1')));
      await tester.pump();
      expect(opened.single.id, 's1');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: a question card answers through the overlay\'s own frames (buildAnswerFrames)', (tester) async {
      final question = {
        'toolUseId': 't1',
        'questions': [
          {
            'header': 'Branch',
            'question': 'Which branch should the hotfix go to?',
            'multiSelect': false,
            'hasPreview': true, // the layout where a digit only MOVES - Enter commits
            'options': [
              {'label': 'net8_master', 'description': '', 'preview': 'a'},
              {'label': 'release/8.4', 'description': '', 'preview': 'b'},
            ],
          },
        ],
      };
      questions = {'q': question};
      rows = [_row('q', 'Combi', status: 'waiting', waitingFor: 'question', brief: _briefJson())];
      final r = await repo();
      final opened = await pump(tester, r: r);
      await settle(tester);

      expect(inCol('you', find.textContaining('Question: Which branch should the hotfix go to?')), findsOneWidget);
      final release = find.byKey(ValueKey('board-answer-${_server.baseUrl}-q-1'));
      expect(release, findsOneWidget);
      expect(find.descendant(of: release, matching: find.text('release/8.4')), findsOneWidget);

      // "Other…" is the session's: its free-text rules depend on the layout (#143).
      await tester.tap(find.byKey(ValueKey('board-other-${_server.baseUrl}-q')));
      await tester.pump();
      expect(opened.single.id, 'q');

      await tester.tap(release);
      await advance(tester, const Duration(seconds: 3));

      final expected = buildAnswerFrames(PendingQuestion.fromJson({'pending': true, 'question': question})!.questions, [
        {1},
      ]).map((f) => f.keys).toList();
      expect(expected, ['2', '\r'], reason: 'previewed layout: digit, then the committing Enter');
      expect(sent, [for (final k in expected) ('q', k)], reason: 'exactly the overlay\'s frames, nothing re-derived');

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: a question that does not take is said out loud, and the Enter is re-sent ONCE', (tester) async {
      questions = {
        'q': {
          'toolUseId': 't1',
          'questions': [
            {
              'header': 'H',
              'question': 'Pick one',
              'multiSelect': false,
              'options': [
                {'label': 'A'},
                {'label': 'B'},
              ],
            },
          ],
        },
      };
      rows = [_row('q', 'Stuck one', status: 'waiting', waitingFor: 'question')];
      final r = await repo();
      await pump(tester, r: r);
      await settle(tester);
      // This session never takes the answer: the question stays pending.
      Future<bool> deaf(Session s, Future<void> Function(void Function(String keys) send) body) async {
        await body((keys) => sent.add((s.id, keys)));
        return true;
      }

      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: WorkBoardScreen(
          repository: r,
          servers: () => const [_server],
          clientFactory: client,
          sessionInput: deaf,
          pollInterval: const Duration(hours: 1),
          onOpenSession: (_) {},
        ),
      ));
      await settle(tester);
      await tester.tap(find.byKey(ValueKey('board-answer-${_server.baseUrl}-q-0')));
      await advance(tester, const Duration(seconds: 10));
      expect(sent.map((e) => e.$2), ['1', '\r', '\r'], reason: 'the confirm is re-sent once, never more');
      expect(find.textContaining('The answer did not take'), findsOneWidget);
      expect(find.byKey(ValueKey('board-answer-${_server.baseUrl}-q-0')), findsOneWidget, reason: 'put back');
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: a multi-question prompt offers no one-press buttons - it is answered in the session', (tester) async {
      Map<String, dynamic> item(String q) => {
            'header': q,
            'question': q,
            'multiSelect': false,
            'options': [
              {'label': 'A'},
            ],
          };
      questions = {
        'q': {
          'toolUseId': 't',
          'questions': [item('one'), item('two')],
        },
      };
      rows = [_row('q', 'Two questions', status: 'waiting', waitingFor: 'question')];
      final r = await repo();
      await pump(tester, r: r);
      await settle(tester);
      expect(find.byKey(ValueKey('board-answer-${_server.baseUrl}-q-0')), findsNothing);
      expect(find.text('Several answers are needed - Open to answer.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: "waiting on you" shows the ask and replies through buildComposeSubmission', (tester) async {
      rows = [
        _row('r', 'OSDP SC', brief: _briefJson(), reason: {'kind': 'you', 'text': 'say which switches', 'source': 'reported'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(inCol('you', find.textContaining('Waiting: say which switches')), findsOneWidget);
      expect(inCol('you', find.textContaining('Asks: Fixed the mic')), findsOneWidget, reason: "the last TL;DR is the ask");

      await tester.enterText(find.byKey(const ValueKey('board-reply-field')), 'positions 6 and 8');
      await tester.tap(find.byKey(const ValueKey('board-reply-send')));
      await tester.pump();
      await settle(tester);
      expect(sent, [('r', buildComposeSubmission('positions 6 and 8'))]);
      expect(sent.single.$2, 'positions 6 and 8\r', reason: 'one frame, the compose bar\'s');
      expect(tester.widget<TextField>(find.byKey(const ValueKey('board-reply-field'))).controller!.text, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: a reply is refused while the agent is still starting (#147); an unreachable session keeps the words',
        (tester) async {
      rows = [
        {..._row('r', 'Booting', brief: _briefJson(), reason: {'kind': 'you', 'text': 'go?', 'source': 'reported'}), 'agentReady': false},
        _row('u', 'Unreachable', brief: _briefJson(), reason: {'kind': 'you', 'text': 'go?', 'source': 'reported'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      final sends = find.byKey(const ValueKey('board-reply-send'));
      final booting = find.descendant(of: find.byKey(ValueKey('board-${_server.baseUrl}-r')), matching: sends);
      expect(tester.widget<FilledButton>(booting).onPressed, isNull);

      inputReachable = false;
      final field = find.descendant(
          of: find.byKey(ValueKey('board-${_server.baseUrl}-u')), matching: find.byKey(const ValueKey('board-reply-field')));
      await tester.enterText(field, 'keep me');
      await tester.tap(find.descendant(of: find.byKey(ValueKey('board-${_server.baseUrl}-u')), matching: sends));
      await tester.pump();
      await settle(tester);
      expect(sent, isEmpty);
      expect(tester.widget<TextField>(field).controller!.text, 'keep me');
      expect(find.text('Could not reach "Unreachable" - nothing was sent'), findsOneWidget);
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337 review: a single MULTI-select question offers no one-press buttons either', (tester) async {
      questions = {
        'q': {
          'toolUseId': 't',
          'questions': [
            {
              'header': 'Pick',
              'question': 'Which ones?',
              'multiSelect': true,
              'options': [
                {'label': 'A'},
                {'label': 'B'},
              ],
            },
          ],
        },
      };
      rows = [_row('q', 'Multi', status: 'waiting', waitingFor: 'question')];
      final r = await repo();
      await pump(tester, r: r);
      await settle(tester);
      expect(find.textContaining('Question: Which ones?'), findsOneWidget);
      expect(find.byKey(ValueKey('board-answer-${_server.baseUrl}-q-0')), findsNothing,
          reason: 'one press would toggle a row, not answer');
      expect(find.text('Several answers are needed - Open to answer.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337 review: a reply the agent did not take (#179) is put back in its box, with a notice',
        (tester) async {
      rows = [
        _row('r', 'OSDP SC', brief: _briefJson(), reason: {'kind': 'you', 'text': 'say which', 'source': 'reported'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      // A report the repository was already holding from BEFORE this send is not about it.
      r.debugApplyNotify(NotifyEvent.fromJson(
          {'type': 'submitUnconfirmed', 'id': 'r', 'at': DateTime.now().millisecondsSinceEpoch - 60000}));
      await tester.pump();
      final field = find.byKey(const ValueKey('board-reply-field'));
      TextEditingController box() => tester.widget<TextField>(field).controller!;

      await tester.enterText(field, 'positions 6 and 8');
      await tester.tap(find.byKey(const ValueKey('board-reply-send')));
      await tester.pump();
      await settle(tester);
      expect(sent.single.$2, 'positions 6 and 8\r');
      expect(box().text, isEmpty, reason: 'delivered to an attached session');
      expect(find.textContaining('did not take your reply'), findsNothing, reason: 'the old report is not this send');

      // Now the server reports THIS submit was swallowed.
      r.debugApplyNotify(NotifyEvent.fromJson(
          {'type': 'submitUnconfirmed', 'id': 'r', 'at': DateTime.now().millisecondsSinceEpoch + 1000}));
      await tester.pump();
      await tester.pump();
      expect(box().text, 'positions 6 and 8', reason: 'the words come back');
      expect(find.textContaining('"OSDP SC" did not take your reply - it is back in the box'), findsOneWidget);
      expect(r.submitUnconfirmedAt('r'), isNull, reason: 'consumed once');
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337 review: Stop re-reads the status and sends nothing to a session that has stopped', (tester) async {
      rows = [_row('w', 'Running one', status: 'working', brief: _briefJson())];
      final r = await repo();
      await pump(tester, r: r);
      // It finishes between the last poll and the press.
      rows = [_row('w', 'Running one', status: 'idle', brief: _briefJson())];
      await tester.tap(find.byKey(ValueKey('board-stop-${_server.baseUrl}-w')));
      await tester.pump();
      await settle(tester);
      await settle(tester);
      expect(sent, isEmpty, reason: 'an Esc to a session that is not working is some other key (#55)');
      expect(find.text('"Running one" is no longer working - Stop was not sent'), findsOneWidget);
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: Stop sends exactly one Esc, and only a WORKING session offers it', (tester) async {
      rows = [
        _row('w', 'Running one', status: 'working', brief: _briefJson()),
        _row('o', 'Own one', brief: _briefJson(), reason: {'kind': 'self', 'text': 'CI', 'source': 'reported'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.byKey(ValueKey('board-stop-${_server.baseUrl}-o')), findsNothing,
          reason: 'Esc interrupts only a working turn (#55); elsewhere it is some other key');
      await tester.tap(find.byKey(ValueKey('board-stop-${_server.baseUrl}-w')));
      await tester.pump();
      await settle(tester);
      expect(sent, [('w', '\x1b')]);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: a session stuck in a menu (#316) offers Esc, which closes it', (tester) async {
      rows = [_row('m', 'Menu one', brief: _briefJson(), reason: {'kind': 'menu', 'text': '', 'source': 'screen'})];
      final r = await repo();
      await pump(tester, r: r);
      await tester.tap(find.byKey(ValueKey('board-esc-${_server.baseUrl}-m')));
      await tester.pump();
      await settle(tester);
      expect(sent, [('m', '\x1b')]);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('"Not waiting" clears a reported wait; a mechanical one offers no such button (#320)', (tester) async {
      rows = [
        _row('r', 'Reported one', brief: _briefJson(), reason: {'kind': 'you', 'text': 'say go', 'source': 'reported'}),
        _row('m', 'Mechanical one', status: 'waiting', waitingFor: 'permission', brief: _briefJson(),
            reason: {'kind': 'you', 'text': 'approve a tool', 'source': 'status'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.byKey(ValueKey('board-clear-wait-${_server.baseUrl}-m')), findsNothing);
      await tester.tap(find.byKey(ValueKey('board-clear-wait-${_server.baseUrl}-r')));
      await tester.pump();
      await settle(tester);
      expect('${patches.last.url.path} ${patches.last.body}', '/api/sessions/r/brief {"clearWait":true}');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a hidden session that needs you stays in Needs you, marked hidden, with Not waiting (#324)', (tester) async {
      rows = [
        _row('r', 'Reported one', brief: {..._briefJson(), 'hidden': true},
            reason: {'kind': 'you', 'text': 'say go', 'source': 'reported'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      final card = find.byKey(ValueKey('board-${_server.baseUrl}-r'));
      expect(inCol('you', card), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('hidden')), findsOneWidget);
      await tester.tap(find.byKey(ValueKey('board-clear-wait-${_server.baseUrl}-r')));
      await tester.pump();
      await settle(tester);
      expect('${patches.last.url.path} ${patches.last.body}', '/api/sessions/r/brief {"clearWait":true}');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('pin (from the menu) sends the WHOLE pinned list; unpin removes one', (tester) async {
      final r = await repo();
      await pump(tester, r: r);

      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-s1')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pin work item'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('pin-ref')), '#888');
      await tester.enterText(find.byKey(const ValueKey('pin-title')), 'New pin');
      await tester.tap(find.byKey(const ValueKey('pin-save')));
      await tester.pump();
      await settle(tester);

      expect(patches, hasLength(1));
      expect(patches.single.url.path, '/api/sessions/s1/brief');
      expect(jsonDecode(patches.single.body), {
        'pinned': [
          {'ref': '#777', 'title': ''},
          {'ref': '#888', 'title': 'New pin'},
        ],
      });

      await tester.tap(find.byTooltip('Unpin #777'));
      await tester.pump();
      await settle(tester);
      expect(jsonDecode(patches.last.body), {'pinned': <dynamic>[]});

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Stop reporting sends optOut:true; Resume sends optOut:false', (tester) async {
      rows = [
        _row('on', 'Reporting', brief: _briefJson()),
        _row('off', 'Silenced', brief: _briefJson(reporting: 'off')),
      ];
      final r = await repo();
      await pump(tester, r: r);
      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-on')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Stop reporting'));
      await tester.pumpAndSettle();
      await settle(tester);
      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-off')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Resume reporting'));
      await tester.pumpAndSettle();
      await settle(tester);
      expect(patches.map((p) => '${p.url.path} ${p.body}'), [
        '/api/sessions/on/brief {"optOut":true}',
        '/api/sessions/off/brief {"optOut":false}',
      ]);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a server without session-brief gets no edit controls and no closed-list request', (tester) async {
      capabilities = [];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.text('Dictation work'), findsOneWidget, reason: 'the card still shows what the row carries');
      expect(find.byKey(ValueKey('board-more-${_server.baseUrl}-s1')), findsNothing, reason: 'nothing it could take');
      expect(find.byTooltip('Unpin #777'), findsNothing);
      expect(paths, isNot(contains('/api/dashboard/closed')));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a phone-width card with a qualified ref, a state and an unpin does not overflow', (tester) async {
      rows = [
        _row('s1', 'Narrow', status: 'working', brief: _briefJson(items: [
          {'ref': 'Adiel-Sharabi/web-terminal#306', 'key': 'k', 'title': 'Companion dashboard', 'state': 'ready-for-test', 'source': 'pinned', 'pin': {'title': '', 'state': null}},
        ])),
      ];
      final r = await repo();
      await pump(tester, r: r, width: 360);
      expect(find.text('Adiel-Sharabi/web-terminal#306'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the pin dialog fits above a phone keyboard', (tester) async {
      final r = await repo();
      await pump(tester, r: r, width: 360);
      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-s1')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pin work item'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('pin-ref')), findsOneWidget);
      // Now the keyboard comes up under a short phone screen.
      tester.view.physicalSize = const Size(360, 640);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('favourites carry a star and lead their column, in pinned order', (tester) async {
      rows = [
        _row('c', 'Gamma', brief: _briefJson()),
        _row('a', 'Alpha', brief: _briefJson(), favorite: true, rank: 2),
        _row('b', 'Beta', brief: _briefJson(), favorite: true, rank: 1),
      ];
      final r = await repo();
      await pump(tester, r: r);
      double y(String name) => tester.getTopLeft(inCol('idle', find.text(name))).dy;
      expect(y('Beta'), lessThan(y('Alpha')), reason: 'rank 1 before rank 2');
      expect(y('Alpha'), lessThan(y('Gamma')), reason: 'favourites first');
      expect(find.text('Alpha'), findsOneWidget, reason: 'moved, not repeated');
      expect(find.descendant(of: find.byKey(ValueKey('board-${_server.baseUrl}-a')), matching: find.byIcon(Icons.star)),
          findsOneWidget);
      expect(find.descendant(of: find.byKey(ValueKey('board-${_server.baseUrl}-c')), matching: find.byIcon(Icons.star)),
          findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('hide from the menu sends hidden:true, offers Undo, and the Hidden fold unhides', (tester) async {
      rows = [
        _row('v', 'Visible one', brief: _briefJson()),
        _row('h', 'Hidden one', brief: {..._briefJson(), 'hidden': true}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.text('Hidden one'), findsNothing);
      expect(find.text('Hidden (1)'), findsOneWidget);

      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-v')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hide from dashboard'));
      await tester.pump();
      await settle(tester);
      expect(patches.map((p) => '${p.url.path} ${p.body}'), ['/api/sessions/v/brief {"hidden":true}']);
      await tester.pumpAndSettle();
      expect(find.text('Undo'), findsOneWidget);
      await tester.tap(find.text('Undo'));
      await tester.pump();
      await settle(tester);
      expect(patches.last.body, '{"hidden":false}');

      await tester.tap(find.text('Hidden (1)'));
      await tester.pump();
      expect(find.text('Hidden one'), findsOneWidget);
      await tester.tap(find.text('Unhide'));
      await tester.pump();
      await settle(tester);
      expect('${patches.last.url.path} ${patches.last.body}', '/api/sessions/h/brief {"hidden":false}');
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the "Hidden" toast with Undo goes away by itself (#322)', (tester) async {
      rows = [_row('v', 'Visible one', brief: _briefJson())];
      final r = await repo();
      await pump(tester, r: r);
      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-v')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hide from dashboard'));
      await tester.pump();
      await settle(tester);
      await tester.pumpAndSettle();
      expect(find.text('Hidden "Visible one"'), findsOneWidget);
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(find.text('Hidden "Visible one"'), findsNothing, reason: 'an action must not make the toast permanent');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('...but under a screen reader it stays, so Undo can be reached (#322)', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(accessibleNavigation: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      rows = [_row('v', 'Visible one', brief: _briefJson())];
      final r = await repo();
      await pump(tester, r: r);
      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-v')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hide from dashboard'));
      await tester.pump();
      await settle(tester);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(find.text('Undo'), findsOneWidget);
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a card carries the machine stripe', (tester) async {
      rows = [
        _row('x', 'External one', brief: _briefJson(), reason: {'kind': 'external', 'text': 'vendor licence', 'source': 'reported'}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      final stripe = find.descendant(
        of: find.byKey(ValueKey('board-${_server.baseUrl}-x')),
        matching: find.byWidgetPredicate((w) => w is ColoredBox && w.color == const Color(0xFFE27BF5)),
      );
      expect(stripe, findsOneWidget, reason: 'the server declared #E27BF5');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a phone-width row keeps most of its width for the session name', (tester) async {
      rows = [_row('q', 'Dictation work in progress')];
      final r = await repo();
      await pump(tester, r: r, width: 360);
      final name = tester.getSize(find.text('Dictation work in progress'));
      expect(name.width, greaterThan(120), reason: 'three equal flexes left it a third of the row');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: closed sessions are grouped by day; Reopen resumes the conversation on ITS server', (tester) async {
      final now = DateTime.now();
      final yesterday = now.subtract(const Duration(days: 1)).millisecondsSinceEpoch;
      closed = [
        {
          'id': 'c1',
          'name': 'GP10 version',
          'did': {'text': 'Built 8.4.2'},
          'at': now.millisecondsSinceEpoch,
          'cwd': 'C:/dev/gp10',
          'agent': 'claude',
          'claudeSessionId': '0b7e2c1a-1111-2222-3333-444455556666',
          'resumeCommand': 'claude --resume 0b7e2c1a-1111-2222-3333-444455556666',
        },
        {'id': 'c2', 'name': 'Plain shell', 'at': yesterday, 'resumeCommand': null},
      ];
      rows = [_row('i', 'Idle one', brief: _briefJson())];
      final r = await repo();
      final opened = await pump(tester, r: r);
      expect(find.text('GP10 version'), findsNothing, reason: 'folded until asked');
      await tester.tap(find.text('Closed in the last days (2)'));
      await tester.pump();
      expect(find.text('Today'), findsOneWidget);
      expect(find.text('Yesterday'), findsOneWidget);
      expect(find.text('Built 8.4.2'), findsOneWidget);
      // A record the server could not name a conversation for is greyed, with no button.
      expect(find.byKey(ValueKey('board-reopen-${_server.baseUrl}-c2')), findsNothing);
      expect(tester.widget<Opacity>(find.byKey(ValueKey('board-closed-${_server.baseUrl}-c2'))).opacity, lessThan(1));

      await tester.tap(find.byKey(ValueKey('board-reopen-${_server.baseUrl}-c1')));
      await tester.pump();
      await settle(tester);
      expect(posts, hasLength(1));
      expect(posts.single.url.toString(), startsWith(_server.baseUrl), reason: 'on the server it closed on');
      expect(jsonDecode(posts.single.body), {
        'name': 'GP10 version',
        'cwd': 'C:/dev/gp10',
        'autoCommand': 'claude --resume 0b7e2c1a-1111-2222-3333-444455556666',
        'agent': 'claude',
      });
      expect(opened.single.id, 'reopened-1', reason: 'the new session is opened (selected in the pane on a wide window)');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#337: a closed conversation that is live again offers Open, not a second copy', (tester) async {
      const conv = '0b7e2c1a-1111-2222-3333-444455556666';
      closed = [
        {'id': 'c1', 'name': 'GP10 version', 'at': DateTime.now().millisecondsSinceEpoch, 'cwd': 'C:/w', 'claudeSessionId': conv, 'resumeCommand': 'claude --resume $conv'},
      ];
      rows = [
        {..._row('live', 'GP10 again', brief: _briefJson()), 'claudeSessionId': conv},
      ];
      final r = await repo();
      final opened = await pump(tester, r: r);
      await tester.tap(find.text('Closed in the last days (1)'));
      await tester.pump();
      expect(find.byKey(ValueKey('board-reopen-${_server.baseUrl}-c1')), findsNothing);
      await tester.tap(find.byKey(ValueKey('board-closed-open-${_server.baseUrl}-c1')));
      await tester.pump();
      expect(opened.single.id, 'live');
      expect(posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });

    /// #340 - every Hand off button on screen (any session).
    Finder handoffButtons() => find.byWidgetPredicate(
        (w) => w.key is ValueKey<String> && (w.key as ValueKey<String>).value.startsWith('board-handoff-btn-'));

    int agoMs(Duration d) => DateTime.now().millisecondsSinceEpoch - d.inMilliseconds;

    testWidgets('#340: an Idle candidate shows its context and Hand off; the confirm says what will happen, and only Hand off sends',
        (tester) async {
      rows = [
        _row('big', 'Big session', brief: _briefJson(), handoff: {'suggest': true, 'ctxTokens': 612000, 'why': null, 'run': null}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      final btn = find.byKey(ValueKey('board-handoff-btn-${_server.baseUrl}-big'));
      expect(inCol('idle', find.text('612k ctx')), findsOneWidget);
      expect(inCol('idle', btn), findsOneWidget);

      await tester.tap(btn);
      await tester.pumpAndSettle();
      expect(find.text('Hand off "Big session" (612k ctx)?'), findsOneWidget);
      expect(find.textContaining('closes afterwards only if nothing would be lost'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(handoffCalls, isEmpty, reason: 'declining the confirm sends nothing');

      await tester.tap(btn);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('board-handoff-confirm')));
      await tester.pump();
      await settle(tester);
      expect(handoffCalls.map((c) => '${c.method} ${c.url.path} ${c.body}'), ['POST /api/sessions/big/handoff {}']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: the server refusing (409) is said in its own words', (tester) async {
      rows = [_row('big', 'Big session', brief: _briefJson(), handoff: {'suggest': true, 'ctxTokens': null})];
      handoffStatus = 409;
      handoffReply = jsonEncode({'error': 'Not a hand-off candidate', 'why': 'busy'});
      final r = await repo();
      await pump(tester, r: r);
      expect(inCol('idle', find.text('Long session')), findsOneWidget, reason: 'no size known: no invented number');
      await tester.tap(find.byKey(ValueKey('board-handoff-btn-${_server.baseUrl}-big')));
      await tester.pumpAndSettle();
      expect(find.text('Hand off "Big session"?'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('board-handoff-confirm')));
      await tester.pump();
      await settle(tester);
      await tester.pump();
      expect(find.text('Could not hand off "Big session": Not a hand-off candidate'), findsOneWidget);
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: no Hand off for a non-candidate, an agent without one, a Working card or a hidden row', (tester) async {
      const cand = {'suggest': true, 'ctxTokens': 700000, 'run': null};
      rows = [
        _row('no', 'Not yet', brief: _briefJson(), handoff: {'suggest': false, 'ctxTokens': 90000, 'why': 'ctx-too-small', 'run': null}),
        _row('none', 'No hand-off', brief: _briefJson()),
        _row('work', 'Busy one', status: 'working', brief: _briefJson(), handoff: cand),
        _row('hid', 'Hidden big', brief: {..._briefJson(), 'hidden': true}, handoff: cand),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.text('Not yet'), findsOneWidget);
      expect(find.text('Busy one'), findsOneWidget);
      expect(handoffButtons(), findsNothing);
      expect(find.text('700k ctx'), findsNothing);
      await tester.tap(find.text('Hidden (1)'));
      await tester.pump();
      expect(find.text('Hidden big'), findsOneWidget);
      expect(handoffButtons(), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: a server without session-handoff offers no button, but a run it left on a row is still drawn',
        (tester) async {
      capabilities = ['session-brief', 'session-hide', 'favorites-sync'];
      rows = [
        _row('big', 'Big session', brief: _briefJson(), handoff: {'suggest': true, 'ctxTokens': 612000, 'run': null}),
        _row('go', 'Going one', brief: _briefJson(), handoff: {
          'suggest': false,
          'run': {'state': 'spawning', 'startedAt': agoMs(const Duration(minutes: 1))},
        }),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(handoffButtons(), findsNothing);
      expect(find.textContaining('Handing off: starting the new session…'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: a run follows its session between columns; Cancel in every in-flight state', (tester) async {
      rows = [
        // Wrapping makes the old session Working: a card, not a row.
        _row('wrap', 'Wrapping one', status: 'working', brief: _briefJson(), handoff: {
          'suggest': true,
          'ctxTokens': 650000,
          'run': {'state': 'wrapping', 'startedAt': agoMs(const Duration(minutes: 4)), 'at': agoMs(const Duration(seconds: 3))},
        }),
        _row('close', 'Closing one', brief: _briefJson(), handoff: {
          'suggest': true,
          'run': {'state': 'closing', 'startedAt': agoMs(const Duration(minutes: 9)), 'successorId': 'n', 'successorName': 'Closing one 2'},
        }),
        _row('ver', 'Verifying one', brief: _briefJson(), handoff: {
          'suggest': true,
          'run': {'state': 'verifying', 'startedAt': agoMs(const Duration(minutes: 5)), 'successorId': 'n2', 'successorName': 'Verifying one 2'},
        }),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(inCol('work', find.textContaining('Handing off: writing its brief… · 4m')), findsOneWidget);
      expect(inCol('idle', find.textContaining('Handing off: closing this one when its turn ends…')), findsOneWidget);
      expect(inCol('idle', find.textContaining('Handing off: checking "Verifying one 2" came up…')), findsOneWidget);
      expect(handoffButtons(), findsNothing, reason: 'a row with a run offers no second one');

      final base = _server.baseUrl;
      expect(find.byKey(ValueKey('board-handoff-cancel-$base-wrap')), findsOneWidget);
      expect(find.byKey(ValueKey('board-handoff-cancel-$base-ver')), findsOneWidget);
      expect(find.byKey(ValueKey('board-handoff-cancel-$base-close')), findsOneWidget, reason: 'closing waits for the old turn to end, and can be cancelled');

      await tester.tap(find.byKey(ValueKey('board-handoff-cancel-$base-wrap')));
      await tester.pump();
      await settle(tester);
      expect(handoffCalls.map((c) => '${c.method} ${c.url.path}'), ['DELETE /api/sessions/wrap/handoff']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: kept and failed say why; Dismiss clears the run; Open new session opens the successor', (tester) async {
      rows = [
        _row('old', 'Old session', brief: _briefJson(), handoff: {
          'suggest': true,
          'run': {
            'state': 'kept',
            'reason': 'unsaved-work',
            'keptBecause': 'two files are not committed',
            'successorId': 'new',
            'successorName': 'Old session 2'
          },
        }),
        _row('new', 'Old session 2', status: 'working', brief: _briefJson()),
        _row('bad', 'Failed one', brief: _briefJson(), handoff: {
          'suggest': true,
          'run': {'state': 'failed', 'reason': 'no-brief'},
        }),
        _row('hid', 'Hidden failed', brief: {..._briefJson(), 'hidden': true}, handoff: {
          'suggest': true,
          'run': {'state': 'failed', 'reason': 'no-slot'},
        }),
      ];
      final r = await repo();
      final opened = await pump(tester, r: r);
      final base = _server.baseUrl;
      expect(find.text('Handed off, but this session was kept: two files are not committed'), findsOneWidget);
      expect(find.text('Hand-off did not finish: It never wrote its brief'), findsOneWidget);
      expect(handoffButtons(), findsNothing);

      // The fresh session is in the list, so the kept row can open it.
      await tester.tap(find.byKey(ValueKey('board-handoff-successor-$base-old')));
      await tester.pump();
      expect(opened.map((s) => s.id), ['new']);
      expect(find.byKey(ValueKey('board-handoff-successor-$base-bad')), findsNothing);

      await tester.tap(find.byKey(ValueKey('board-handoff-dismiss-$base-bad')));
      await tester.pump();
      await settle(tester);
      expect(handoffCalls.map((c) => '${c.method} ${c.url.path}'), ['DELETE /api/sessions/bad/handoff']);

      // A hidden row shows its run (so it is never invisible) but offers no new one.
      await tester.tap(find.text('Hidden (1)'));
      await tester.pump();
      expect(find.text('Hand-off did not finish: No free session slot on this server'), findsOneWidget);
      expect(handoffButtons(), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: dismissing a run that is already gone (404) is not an error', (tester) async {
      rows = [
        _row('bad', 'Failed one', brief: _briefJson(), handoff: {
          'suggest': true,
          'run': {'state': 'failed', 'reason': 'successor-gone'},
        }),
      ];
      handoffStatus = 404;
      handoffReply = jsonEncode({'error': 'No hand-off'});
      final r = await repo();
      await pump(tester, r: r);
      expect(find.text('Hand-off did not finish: The new session was closed'), findsOneWidget);
      await tester.tap(find.byKey(ValueKey('board-handoff-dismiss-${_server.baseUrl}-bad')));
      await tester.pump();
      await settle(tester);
      expect(handoffCalls, hasLength(1));
      expect(find.textContaining('Could not'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#340: a phone-width row with a long name, a long kept reason and a candidate does not overflow', (tester) async {
      rows = [
        _row('a', 'A very long session name that keeps going and going', brief: _briefJson(), handoff: {
          'suggest': true,
          'run': {
            'state': 'kept',
            'reason': 'unsaved-work',
            'keptBecause': 'the working tree has uncommitted changes in nine files and a half-written migration that nothing else records',
            'successorId': 'b',
            'successorName': 'B'
          },
        }),
        _row('b', 'B', status: 'working', brief: _briefJson()),
        _row('c', 'Another long session name that is very long', brief: _briefJson(), handoff: {'suggest': true, 'ctxTokens': 1200000}),
      ];
      final r = await repo();
      await pump(tester, r: r, width: 360);
      expect(find.text('1.2M ctx'), findsOneWidget);
      expect(find.textContaining('Handed off, but this session was kept'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('pushed it has a back arrow; embedded beside the list it has none (#337)', (tester) async {
      final r = await repo();
      // Both are pushed over a first route, so only [embedded] can take the arrow away.
      Future<void> open({required bool embedded}) async {
        await tester.pumpWidget(MaterialApp(
          theme: AppTheme.dark,
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => WorkBoardScreen(
                  embedded: embedded,
                  repository: r,
                  servers: () => const [_server],
                  clientFactory: client,
                  sessionInput: fakeInput,
                  pollInterval: const Duration(hours: 1),
                  onOpenSession: (_) {},
                ),
              )),
              child: const Text('open'),
            ),
          ),
        ));
        await tester.tap(find.text('open'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
      }

      await open(embedded: false);
      expect(find.byType(BackButton), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await open(embedded: true);
      expect(find.byType(WorkBoardScreen), findsOneWidget);
      expect(find.byType(BackButton), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the board reads in a LIGHT theme too', (tester) async {
      rows = [
        _row('w', 'Running one', status: 'working', brief: _briefJson()),
        _row('r', 'Reported one', brief: _briefJson(), reason: {'kind': 'you', 'text': 'go?', 'source': 'reported'}),
      ];
      final r = await repo();
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData.light(),
        home: WorkBoardScreen(
          repository: r,
          servers: () => const [_server],
          clientFactory: client,
          sessionInput: fakeInput,
          pollInterval: const Duration(hours: 1),
          onOpenSession: (_) {},
        ),
      ));
      await tester.runAsync(() => r.refresh());
      await tester.pump();
      expect(find.text('Reported one'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final head = tester.widget<Text>(find.text('NEEDS YOU'));
      expect(head.style?.color, isNot(AppColors.caution), reason: 'a darker amber, readable on white');
      await tester.pumpWidget(const SizedBox());
    });
  });
}
