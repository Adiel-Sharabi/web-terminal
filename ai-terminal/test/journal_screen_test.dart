// #466 - the Journal page against a faked cluster: Home answers as a peer naming
// Office, Office answers as the authority. The four sections render in order with what
// each row shows; History filters and groups by day; Close goes through the app's one
// kill flow (confirm, then DELETE on the session's own server); a live row opens its
// session; an honest empty state when there is no supervisor; and how it is reached
// (split pane beside the rail, pushed on a phone).
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart' show dashboardFoldsActions;
import 'package:ai_terminal/screens/journal_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 'tok');

// Made-up session ids, in the shape the server mints (the page sends nothing else back).
const _n1 = '00000000-0000-4000-8000-000000000001';
const _n2 = '00000000-0000-4000-8000-000000000002';
const _n3 = '00000000-0000-4000-8000-000000000003';
const _n4 = '00000000-0000-4000-8000-000000000004';

Map<String, dynamic> _node(String id, String name, String server,
        {String status = 'idle', Object? wait, Object? orphan, String? goal, String? headline, String? now}) =>
    {
      'id': id,
      'server': server,
      'name': name,
      'cwd': '/w/$name',
      'status': status,
      'agent': 'claude',
      'clients': 0,
      'goal': goal,
      'headline': headline,
      'now': now,
      'items': [],
      'wait': wait,
      'orphan': orphan,
    };

Map<String, dynamic> _state(int now, {bool complete = true}) => {
      'enabled': true,
      'role': 'authority',
      'at': now - 20000,
      'now': now,
      'everyMs': 60000,
      'complete': complete,
      'servers': [
        {'name': 'Office', 'ok': true, 'sessions': 2},
        {'name': 'Home', 'ok': true, 'sessions': 2},
        if (!complete) {'name': 'Laptop', 'ok': false, 'reason': 'HTTP 502', 'sessions': 0},
      ],
      'sessions': [
        _node(_n1, 'Alpha', 'Office',
            status: 'waiting',
            goal: 'Ship the widget',
            wait: {'on': 'you', 'what': 'pick a colour', 'at': now - 12 * 60000}),
        _node(_n2, 'Beta', 'Home',
            status: 'working',
            headline: 'Running the suite',
            wait: {'on': 'external', 'what': 'CI run', 'at': now, 'target': {'kind': 'ci'}},
            orphan: {'state': 'orphan', 'parentId': 'p', 'since': now}),
        _node(_n3, 'Gamma', 'Home', status: 'working', now: 'Reading code', orphan: {'state': 'unknown', 'parentId': 'q'}),
        _node(_n4, 'Delta', 'Home', wait: {'on': 'done', 'what': 'finished', 'at': now}),
      ],
      'needsYou': [_n1],
      'live': [_n2, _n3],
      'readyToClose': [_n4],
      'history': [
        {
          'id': 'h1',
          'machine': 'Home',
          'name': 'Epsilon',
          'why': 'closed',
          'openedAt': now - 7200000,
          'closedAt': now - 60000,
          'goal': 'Fix the parser',
          'items': [
            {'ref': '#12', 'state': 'done'},
          ],
        },
        {
          'id': 'h2',
          'machine': 'Office',
          'name': 'Zeta',
          'why': 'reaped',
          'closedAt': now - 3 * 86400000,
          'headline': 'Moved the docs',
          'items': [],
        },
      ],
    };

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status,
    headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  late List<String> asked;
  late Map<String, Object> answers; // baseUrl -> body (a 404 when absent)
  late Map<String, List<Map<String, dynamic>>> rows; // baseUrl -> GET /api/sessions
  late List<Session> opened;

  ApiClient client(ServerConfig sv) => ApiClient(sv, httpClient: MockClient((req) async {
        asked.add('${sv.name} ${req.method} ${req.url.path}');
        if (req.method == 'DELETE') return _json({'ok': true});
        if (req.url.path == '/api/sessions') return _json(rows[sv.baseUrl] ?? const []);
        final body = answers[sv.baseUrl];
        return body == null ? _json({'error': 'not found'}, 404) : _json(body);
      }));

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
    asked = [];
    rows = {};
    opened = [];
    final now = DateTime.now().millisecondsSinceEpoch;
    answers = {
      _home.baseUrl: {'role': 'peer', 'authority': {'name': 'office'}},
      _office.baseUrl: _state(now),
    };
  });
  tearDown(SessionSelection.instance.reset);

  JournalScreen screen({bool embedded = false, SessionRepository? repository}) => JournalScreen(
        embedded: embedded,
        repository: repository,
        onOpenSession: opened.add,
        servers: () => const [_home, _office],
        clientFactory: client,
        refreshFloor: const Duration(hours: 1),
      );

  Future<void> pump(WidgetTester tester, {SessionRepository? repository}) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: screen(repository: repository)));
    await tester.pump();
    await tester.pump();
  }

  Future<void> done(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  }

  Finder inRow(String key, String text) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.textContaining(text));

  testWidgets('the four sections, in order, each row showing what it says', (tester) async {
    await pump(tester);
    expect(asked, containsAll(['Home GET /api/supervisor/state', 'Office GET /api/supervisor/state']));
    double y(String k) => tester.getTopLeft(find.byKey(ValueKey(k))).dy;
    expect(y('journal-section-needs'), lessThan(y('journal-section-live')));
    expect(y('journal-section-live'), lessThan(y('journal-section-ready')));
    expect(y('journal-section-ready'), lessThan(y('journal-section-history')));
    expect(find.text('Needs you (1)'), findsOneWidget);
    expect(find.text('Live (2)'), findsOneWidget);
    expect(find.text('Ready to close (1)'), findsOneWidget);
    expect(find.text('History (2)'), findsOneWidget);

    // Needs you (#492): ONE row to the inbox, never a per-session list.
    expect(inRow('journal-open-inbox', '1 need you - open the inbox'), findsOneWidget);
    // Live: headline (or now), the wait with its target kind, the orphan badges.
    expect(inRow('journal-live-$_n2', 'Running the suite'), findsOneWidget);
    expect(inRow('journal-live-$_n2', 'Waits on external (ci): CI run'), findsOneWidget);
    expect(find.byKey(ValueKey('journal-orphan-$_n2')), findsOneWidget);
    expect(find.byKey(ValueKey('journal-lead-unknown-$_n2')), findsNothing);
    expect(inRow('journal-live-$_n3', 'Reading code'), findsOneWidget);
    expect(find.byKey(ValueKey('journal-lead-unknown-$_n3')), findsOneWidget);
    expect(find.byKey(ValueKey('journal-orphan-$_n3')), findsNothing);
    // Ready to close carries its Close.
    expect(find.byKey(ValueKey('journal-close-$_n4')), findsOneWidget);
    // The scan line names the authority; a complete scan names nobody silent.
    expect(find.textContaining('on Office'), findsOneWidget);
    expect(find.byKey(const ValueKey('journal-incomplete')), findsNothing);
    await done(tester);
  });

  testWidgets('#492: Needs you is one "N need you" row, no per-session rows, and it opens the inbox', (tester) async {
    final st = _state(DateTime.now().millisecondsSinceEpoch);
    ((st['sessions'] as List).firstWhere((n) => (n as Map)['id'] == _n2) as Map)['status'] = 'waiting';
    st['needsYou'] = [_n1, _n2];
    answers[_office.baseUrl] = st;
    var opened = 0;
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: JournalScreen(
          onOpenSession: (_) {},
          servers: () => const [_home, _office],
          clientFactory: client,
          refreshFloor: const Duration(hours: 1),
          onOpenInbox: () => opened++,
        )));
    await tester.pump();
    await tester.pump();
    expect(find.text('2 need you - open the inbox'), findsOneWidget);
    expect(find.byKey(ValueKey('journal-needs-$_n1')), findsNothing);
    expect(find.byKey(ValueKey('journal-needs-$_n2')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('journal-open-inbox')));
    expect(opened, 1);
    await done(tester);
  });

  testWidgets('#492: with nothing waiting there is no inbox row, and the empty line says so', (tester) async {
    final st = _state(DateTime.now().millisecondsSinceEpoch);
    st['needsYou'] = <String>[];
    answers[_office.baseUrl] = st;
    await pump(tester);
    expect(find.byKey(const ValueKey('journal-open-inbox')), findsNothing);
    expect(find.text('Nothing is waiting on you.'), findsOneWidget);
    await done(tester);
  });

  testWidgets('#492: on a split the row shows the inbox in the pane (the one open-inbox path)', (tester) async {
    SessionSelection.instance.splitMounted = true;
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey('journal-open-inbox')));
    expect(SessionSelection.instance.inboxShown, isTrue);
    await done(tester);
  });

  testWidgets('an incomplete scan names the server that did not answer', (tester) async {
    answers[_office.baseUrl] = _state(DateTime.now().millisecondsSinceEpoch, complete: false);
    await pump(tester);
    expect(find.text('Did not answer: Laptop (HTTP 502)'), findsOneWidget);
    await done(tester);
  });

  testWidgets('History groups by day and its search filters name, machine, goal, headline and item refs',
      (tester) async {
    await pump(tester);
    final days = find.byWidgetPredicate((w) => w.key is ValueKey<String> && (w.key as ValueKey<String>).value.startsWith('journal-day-'));
    expect(days, findsNWidgets(2));
    expect(inRow('journal-history-Home|h1', 'closed at'), findsOneWidget);
    expect(inRow('journal-history-Home|h1', 'Goal: Fix the parser'), findsOneWidget);
    expect(inRow('journal-history-Home|h1', '#12 done'), findsOneWidget);
    expect(inRow('journal-history-Office|h2', 'Moved the docs'), findsOneWidget);

    Future<(bool, bool)> search(String q) async {
      await tester.enterText(find.byKey(const ValueKey('journal-search')), q);
      await tester.pump();
      return (
        find.byKey(const ValueKey('journal-history-Home|h1')).evaluate().isNotEmpty,
        find.byKey(const ValueKey('journal-history-Office|h2')).evaluate().isNotEmpty,
      );
    }

    expect(await search('parser'), (true, false), reason: 'goal');
    expect(await search('#12'), (true, false), reason: 'item ref');
    expect(await search('ZETA'), (false, true), reason: 'name, any case');
    expect(await search('office'), (false, true), reason: 'machine');
    expect(await search('moved'), (false, true), reason: 'headline');
    expect(await search('nothing like it'), (false, false));
    expect(find.text('No ended session matches.'), findsOneWidget);
    expect(await search(''), (true, true));
    // The live sections are not filtered by History's search.
    await search('parser');
    expect(find.byKey(const ValueKey('journal-open-inbox')), findsOneWidget);
    await done(tester);
  });

  testWidgets('Close confirms, then kills through the session\'s own server, and the row goes', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(ValueKey('journal-close-$_n4')));
    await tester.pumpAndSettle();
    expect(find.text('Kill session?'), findsOneWidget, reason: "the app's one kill confirmation");
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(asked.where((a) => a.contains('DELETE')), isEmpty, reason: 'cancel kills nothing');

    await tester.tap(find.byKey(ValueKey('journal-close-$_n4')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Kill'));
    await tester.pumpAndSettle();
    expect(asked.where((a) => a.contains('DELETE')), ['Home DELETE /api/sessions/$_n4'],
        reason: "the session's own server, not the authority's");
    expect(find.byKey(ValueKey('journal-ready-$_n4')), findsNothing);
    expect(find.text('Ready to close (0)'), findsOneWidget);
    await done(tester);
  });

  testWidgets('Close refuses a session the app sees working again since the scan', (tester) async {
    rows = {
      _home.baseUrl: [
        {'id': _n4, 'name': 'Delta', 'cwd': '/w', 'status': 'working', 'agent': 'claude'},
      ],
    };
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in const [_home, _office]) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
    });
    final store = ServerStore.forTest();
    await store.init();
    final repo = SessionRepository.forTest(store: store, clientFactory: client);
    await tester.runAsync(repo.refresh);
    expect(repo.current.map((s) => '${s.id} ${s.status}'), ['$_n4 working'], reason: 'precondition');
    await pump(tester, repository: repo);
    await tester.tap(find.byKey(ValueKey('journal-close-$_n4')));
    await tester.pump();
    expect(find.byKey(const ValueKey('journal-close-refused')), findsOneWidget);
    expect(find.text('Kill session?'), findsNothing, reason: 'no dialog, no kill');
    expect(asked.where((a) => a.contains('DELETE')), isEmpty);
    await done(tester);
  });

  testWidgets('a node whose id is not a session id is never sent back in a URL', (tester) async {
    final st = _state(DateTime.now().millisecondsSinceEpoch);
    (st['sessions'] as List).add(_node('../leases/x', 'Odd', 'Home', wait: {'on': 'done', 'what': 'x'}));
    (st['readyToClose'] as List).add('../leases/x');
    answers[_office.baseUrl] = st;
    await pump(tester);
    final close = find.byKey(const ValueKey('journal-close-../leases/x'));
    expect(find.descendant(of: close, matching: find.text('Not reachable')), findsOneWidget);
    await tester.tap(close);
    await tester.pumpAndSettle();
    expect(find.text('Kill session?'), findsNothing);
    expect(asked.where((a) => a.contains('DELETE')), isEmpty);
    await done(tester);
  });

  testWidgets('a timestamp no clock can hold never blanks the page', (tester) async {
    final st = _state(DateTime.now().millisecondsSinceEpoch);
    (st['history'] as List).add({'id': 'h3', 'machine': 'Home', 'name': 'Eta', 'why': 'lost', 'closedAt': -9e15});
    ((st['sessions'] as List).first as Map)['wait'] = {'on': 'you', 'what': 'odd clock', 'at': 9e15};
    answers[_office.baseUrl] = st;
    await pump(tester);
    expect(tester.takeException(), isNull);
    expect(inRow('journal-history-Home|h3', 'Eta'), findsOneWidget);
    expect(find.text('Unknown day'), findsOneWidget);
    expect(find.byKey(const ValueKey('journal-open-inbox')), findsOneWidget);
    await done(tester);
  });

  testWidgets('a failed read is said, and the page reads again on its timer', (tester) async {
    var calls = 0;
    ApiClient flaky(ServerConfig sv) => ApiClient(sv, httpClient: MockClient((req) async {
          asked.add('${sv.name} ${req.method} ${req.url.path}');
          if (sv == _office && calls++ == 0) throw StateError('boom');
          final body = answers[sv.baseUrl];
          return body == null ? _json({'error': 'not found'}, 404) : _json(body);
        }));
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: JournalScreen(
        onOpenSession: opened.add,
        servers: () => const [_home, _office],
        clientFactory: flaky,
        refreshFloor: const Duration(seconds: 30),
      ),
    ));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('journal-empty')), findsOneWidget, reason: 'the first read failed');
    expect(asked.where((a) => a.startsWith('Office')), hasLength(1));
    // Nothing served a period, so the next read is a minute later.
    await tester.pump(const Duration(seconds: 61));
    await tester.pump();
    expect(asked.where((a) => a.startsWith('Office')), hasLength(2), reason: 'the refresh survived the failure');
    expect(find.text('Needs you (1)'), findsOneWidget);
    await done(tester);
  });

  testWidgets('tapping a live row opens that session on its own server', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(ValueKey('journal-live-$_n2')));
    await tester.pump();
    expect(opened.map((s) => '${s.id} ${s.server.name} ${s.name}'), ['$_n2 Home Beta']);
    await done(tester);
  });

  testWidgets('no supervisor: an honest empty state, never empty sections', (tester) async {
    answers = {
      _home.baseUrl: {'role': 'none', 'authority': null},
      _office.baseUrl: {'role': 'none', 'authority': null},
    };
    await pump(tester);
    expect(find.text('No supervisor: no lease authority is configured'), findsOneWidget);
    expect(find.byKey(const ValueKey('journal-section-needs')), findsNothing);
    await done(tester);
  });

  testWidgets('the authority not answering is said, by name', (tester) async {
    answers.remove(_office.baseUrl);
    await pump(tester);
    expect(find.textContaining("The supervisor's server (office) is not reachable"), findsOneWidget);
    await done(tester);
  });

  group('reaching it', () {
    testWidgets('split view: the rail button shows the journal in the pane', (tester) async {
      tester.view.physicalSize = const Size(1600, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: AdaptiveHome(journalBuilder: (open) => screen(embedded: true)),
      ));
      await tester.pump();
      // A 340 px rail at standard density folds Journal and Settings into More.
      expect(find.byKey(const ValueKey('open-journal')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('dashboard-more')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-journal')));
      await tester.pumpAndSettle();
      expect(SessionSelection.instance.pane.value, DetailPane.journal);
      expect(find.byType(JournalScreen), findsOneWidget);
      expect(find.byType(BackButton), findsNothing, reason: 'beside the list there is nothing to go back to');
      SessionSelection.instance.showBoard();
      await tester.pump();
      expect(find.byType(JournalScreen), findsNothing);
      await done(tester);
      await tester.pump(const Duration(seconds: 1));
    });

    testWidgets('phone: the button pushes the journal, with a way back', (tester) async {
      tester.view.physicalSize = const Size(420, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome()));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('open-journal')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(JournalScreen), findsOneWidget);
      expect(find.byType(BackButton), findsOneWidget);
      expect(SessionSelection.instance.pane.value, DetailPane.board, reason: 'a phone has no pane to set');
      await done(tester);
      await tester.pump(const Duration(seconds: 1));
    });
  });

  test('DetailPane.journal is its own value: not the board, not the inbox', () {
    expect(DetailPane.journal.isBoard, isFalse);
    expect(DetailPane.journal, isNot(DetailPane.inbox));
    expect(DetailPane.journal, isNot(DetailPane.board));
    expect(DetailPane.journal.sessionId, isNull);
    SessionSelection.instance.showJournal();
    expect(SessionSelection.instance.journalShown, isTrue);
    expect(SessionSelection.instance.inboxShown, isFalse);
    expect(SessionSelection.instance.boardShown, isFalse);
    SessionSelection.instance.reset();
  });

  test('journalRefreshPeriod: the served period, never under the floor', () {
    const floor = Duration(seconds: 30);
    expect(journalRefreshPeriod(60000, floor), const Duration(minutes: 1));
    expect(journalRefreshPeriod(5000, floor), floor);
    expect(journalRefreshPeriod(null, floor), const Duration(minutes: 1));
    expect(journalRefreshPeriod(10000000000000000, floor), const Duration(days: 1), reason: 'capped');
  });

  test('dashboardFoldsActions: the bar folds only when it cannot hold every button', () {
    const desktop = VisualDensity.compact, phone = VisualDensity.standard;
    expect(dashboardFoldsActions(AdaptiveHome.railMinWidth, desktop), isTrue, reason: 'the rail at its minimum');
    expect(dashboardFoldsActions(AdaptiveHome.railWidth, desktop), isFalse, reason: 'the default rail on desktop');
    expect(dashboardFoldsActions(360, phone), isTrue, reason: 'a 360 dp phone');
    expect(dashboardFoldsActions(412, phone), isFalse);
  });

  test('waitedFor: the length of a wait, short', () {
    final now = DateTime(2026, 11, 15, 12);
    int ago(Duration d) => now.subtract(d).millisecondsSinceEpoch;
    expect(waitedFor(ago(const Duration(seconds: 20)), now), '<1m');
    expect(waitedFor(ago(const Duration(minutes: 12)), now), '12m');
    expect(waitedFor(ago(const Duration(hours: 3)), now), '3h');
    expect(waitedFor(ago(const Duration(days: 2)), now), '2d');
    expect(waitedFor(null, now), '');
  });
}
