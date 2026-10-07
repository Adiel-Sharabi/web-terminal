// #306 — the sessions dashboard in the companion. Pins the wire parsing of a
// session's `brief` (built server-side by lib/session-brief.js), the two API calls,
// the pure grouping/status rules, and the screen end to end against a faked server:
// a card shows its work items, a session owing an answer is in "Needs you", a pin
// sends the whole pinned list, and a tap opens the session.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/work_board_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/theme/status_colors.dart';
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
        {String status = 'idle', Object? brief, String? waitingFor, Object? reason, bool favorite = false, int? rank}) =>
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
  });

  group('rules', () {
    test('groupByWorkItem groups on the server key, keeps sessions without items apart', () {
      SessionBrief brief(List<BriefItem> items) => SessionBrief(items: items);
      final a = _session('a', brief: brief(const [BriefItem(ref: '#297', key: 'o/r#297'), BriefItem(ref: '#1', key: 'o/r#1')]));
      final b = _session('b', brief: brief(const [BriefItem(ref: 'o/r#297', key: 'o/r#297')]));
      final c = _session('c');
      final g = groupByWorkItem([a, b, c]);
      expect(g.groups.map((x) => x.item.key), ['o/r#297', 'o/r#1']);
      expect(g.groups.first.sessions.map((s) => s.id), ['a', 'b']);
      expect(g.groups[1].sessions, isEmpty, reason: 'a card shows once, under its FIRST item');
      expect(g.groups[1].refs.map((s) => s.id), ['a']);
      expect(g.none.map((s) => s.id), ['c']);
    });

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
    late List<String> paths;
    late List<Map<String, dynamic>> rows;
    late List<String> capabilities;

    ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
          paths.add(req.url.path);
          switch (req.url.path) {
            case '/api/version':
              return http.Response(jsonEncode({'version': '1.74.0', 'serverName': 'Home', 'serverColor': '#E27BF5', 'capabilities': capabilities}), 200);
            case '/api/sessions':
              return http.Response(jsonEncode(rows), 200);
            case '/api/dashboard/closed':
              return http.Response(jsonEncode({'closed': [{'id': 'gone', 'name': 'Finished session', 'items': [], 'did': {'text': 'wrapped up'}, 'at': DateTime.now().millisecondsSinceEpoch}]}), 200);
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
      paths = [];
      capabilities = ['session-brief', 'session-hide', 'favorites-sync'];
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

    testWidgets('cards, needs-you, stale warning, closed strip; a tap opens the session', (tester) async {
      final r = await repo();
      final opened = await pump(tester, r: r);

      expect(find.text('Dictation work'), findsOneWidget);
      expect(find.text('#291'), findsOneWidget);
      expect(find.text('ready for test'), findsOneWidget);
      expect(find.text('Run the tests'), findsOneWidget, reason: 'Now shows while working');
      expect(find.textContaining('Report may be out of date: gh issue close touched #4242'), findsOneWidget);
      // #313: by reason (the default), the waiting session leads in its own section.
      expect(find.descendant(of: find.byKey(const ValueKey('board-sec-you')), matching: find.text('Waiting one')), findsOneWidget);
      expect(find.text('Nothing reported yet'), findsOneWidget, reason: 'a Claude session with no brief yet');
      expect(find.text('Finished session'), findsOneWidget);

      await tester.tap(find.text('Dictation work'));
      await tester.pump();
      expect(opened.single.id, 's1');

      // By server: the Needs-you strip and the server's own header.
      await tester.tap(find.text('By server'));
      await tester.pump();
      expect(find.byKey(const ValueKey('board-needs-you')), findsOneWidget);
      expect(find.textContaining('Waiting one · Home · a permission'), findsOneWidget);
      expect(find.text('● online · 1.74.0'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('pin sends the WHOLE pinned list; unpin removes one', (tester) async {
      final r = await repo();
      await pump(tester, r: r);

      final card = find.byKey(ValueKey('board-${_server.baseUrl}-s1'));
      await tester.tap(find.descendant(of: card, matching: find.widgetWithText(OutlinedButton, 'Pin work item')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('pin-ref')), '#888');
      await tester.enterText(find.byKey(const ValueKey('pin-title')), 'New pin');
      await tester.tap(find.byKey(const ValueKey('pin-save')));
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();

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
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
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
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-off')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Resume reporting'));
      await tester.pumpAndSettle();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
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
      expect(find.text('Pin work item'), findsNothing);
      expect(find.byKey(ValueKey('board-more-${_server.baseUrl}-s1')), findsNothing, reason: 'nothing it could take');
      expect(find.byTooltip('Unpin #777'), findsNothing);
      expect(paths, isNot(contains('/api/dashboard/closed')));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a phone-width card with a qualified ref, a state and an unpin does not overflow', (tester) async {
      rows = [
        _row('s1', 'Narrow', brief: _briefJson(items: [
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
      final card = find.byKey(ValueKey('board-${_server.baseUrl}-s1'));
      await tester.tap(find.descendant(of: card, matching: find.widgetWithText(OutlinedButton, 'Pin work item')));
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

    testWidgets('favourites lead, in pinned order, and are not repeated below', (tester) async {
      rows = [
        _row('a', 'Alpha', brief: _briefJson(), favorite: true, rank: 2),
        _row('b', 'Beta', brief: _briefJson(), favorite: true, rank: 1),
        _row('c', 'Gamma', brief: _briefJson()),
      ];
      final r = await repo();
      await pump(tester, r: r);
      final favs = find.byKey(const ValueKey('board-favorites'));
      expect(find.descendant(of: favs, matching: find.text('Alpha')), findsOneWidget);
      expect(find.descendant(of: favs, matching: find.text('Gamma')), findsNothing);
      expect(find.text('Alpha'), findsOneWidget, reason: 'moved, not repeated');
      expect(tester.getTopLeft(find.text('Beta')).dx, lessThan(tester.getTopLeft(find.text('Alpha')).dx),
          reason: 'pinned order: rank 1 before rank 2 (side by side in the wide grid)');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('hide from the menu sends hidden:true, offers Undo, and the Hidden tab unhides', (tester) async {
      rows = [
        _row('v', 'Visible one', brief: _briefJson()),
        _row('h', 'Hidden one', brief: {..._briefJson(), 'hidden': true}),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.text('Hidden one'), findsNothing);
      expect(find.text('Hidden 1'), findsOneWidget);

      await tester.tap(find.byKey(ValueKey('board-more-${_server.baseUrl}-v')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hide from dashboard'));
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(patches.map((p) => '${p.url.path} ${p.body}'), ['/api/sessions/v/brief {"hidden":true}']);
      await tester.pumpAndSettle();
      expect(find.text('Undo'), findsOneWidget);
      await tester.tap(find.text('Undo'));
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      expect(patches.last.body, '{"hidden":false}');

      await tester.tap(find.text('Hidden 1'));
      await tester.pump();
      expect(find.text('Hidden one'), findsOneWidget);
      await tester.tap(find.text('Unhide'));
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      expect('${patches.last.url.path} ${patches.last.body}', '/api/sessions/h/brief {"hidden":false}');
      ScaffoldMessenger.of(tester.element(find.byType(ListView))).clearSnackBars();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the filter narrows the cards by name, work item and machine', (tester) async {
      rows = [
        _row('a', 'Alpha', brief: _briefJson()),
        _row('b', 'Beta', brief: _briefJson(items: [{'ref': 'ado:777', 'key': 'ado:777', 'title': 'Galaxy', 'state': 'planning', 'source': 'agent'}])),
      ];
      final r = await repo();
      await pump(tester, r: r);
      await tester.enterText(find.byKey(const ValueKey('board-search')), 'galaxy');
      await tester.pump();
      expect(find.text('Beta'), findsOneWidget);
      expect(find.text('Alpha'), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('board-search')), 'nothing like it');
      await tester.pump();
      expect(find.text('No session matches the filter.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('reasons group the board; done is collapsed; the card carries the machine stripe', (tester) async {
      rows = [
        _row('x', 'External one', brief: _briefJson(), reason: {'kind': 'external', 'text': 'vendor licence', 'source': 'reported'}),
        _row('d', 'Done one', brief: _briefJson(), reason: {'kind': 'done', 'text': 'pushed', 'source': 'reported'}),
        _row('q', 'Quiet one'),
      ];
      final r = await repo();
      await pump(tester, r: r);
      expect(find.text('Blocked on others'), findsOneWidget);
      expect(find.text('Blocked: vendor licence'), findsOneWidget);
      expect(find.text('Not reported'), findsOneWidget);
      expect(find.text('Quiet one'), findsOneWidget);
      expect(find.text('Done one'), findsNothing, reason: 'Done starts collapsed');
      await tester.tap(find.text('Done'));
      await tester.pump();
      expect(find.text('Done one'), findsOneWidget);
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

    testWidgets('by work item groups sessions under the item', (tester) async {
      final r = await repo();
      await pump(tester, r: r);
      await tester.tap(find.text('By work item'));
      await tester.pump();
      expect(find.text('#291 Dictate'), findsOneWidget);
      expect(find.text('No work item'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
