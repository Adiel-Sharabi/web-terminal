// #337 - the sessions board lives BESIDE the session list on a wide window, and it is
// what the detail pane shows whenever no session is open: the default on launch,
// replacing the old "Pick a session" placeholder.
//
// It used to be pushed as a root route from the list's app bar, so on a desktop it
// covered the whole window, the list rail included, and getting to a session meant
// leaving the board. Now the pane shows either one session or the board
// ([SessionSelection.pane]): the rail stays, a card's Open selects its session in the
// pane (which is also what replaces the board), and the dashboard button brings the
// board back. A phone is unchanged: the board is still pushed as a full screen.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/screens/work_board_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

class _Pushes extends NavigatorObserver {
  final List<Route<dynamic>> routes = [];
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => routes.add(route);
}

ApiClient _client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
      switch (req.url.path) {
        case '/api/version':
          return http.Response(jsonEncode({'version': '1.74.0', 'capabilities': ['session-brief']}), 200);
        case '/api/sessions':
          return http.Response(
              jsonEncode([
                {
                  'id': 's1',
                  'name': 'Dictation work',
                  'cwd': '/w',
                  'status': 'idle',
                  'notifyLevel': 'important',
                  'agent': 'claude',
                  'brief': {'v': 1, 'reporting': 'on', 'items': [], 'headline': 'Dictation shipped'},
                },
              ]),
              200);
        case '/api/dashboard/closed':
          return http.Response(jsonEncode({'closed': []}), 200);
      }
      return http.Response('', 404);
    }));

Future<_Pushes> _pumpHome(WidgetTester tester, Size size, {AdaptiveHome home = const AdaptiveHome()}) async {
  final pushes = _Pushes();
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, navigatorObservers: [pushes], home: home));
  await tester.pump();
  return pushes;
}

Future<void> _tapDashboardButton(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('open-work-board')));
  await tester.pump();
  await tester.pump(const Duration(seconds: 1)); // a route transition, if one were pushed
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
  });
  tearDown(() => SessionSelection.instance.reset());

  testWidgets('wide: the board IS the pane on launch, beside the rail - no route pushed, no placeholder',
      (tester) async {
    final pushes = await _pumpHome(tester, const Size(1400, 900));
    expect(pushes.routes, hasLength(1), reason: 'just the home route');
    expect(SessionSelection.instance.pane.value, DetailPane.board, reason: 'the default');
    expect(find.byType(WorkBoardScreen), findsOneWidget);
    expect(find.text('Pick a session'), findsNothing, reason: 'the placeholder is gone (#337)');

    await _tapDashboardButton(tester);

    expect(pushes.routes, hasLength(1), reason: 'the board must not be pushed over the split');
    expect(SessionSelection.instance.pane.value, DetailPane.board);
    expect(find.byType(WorkBoardScreen), findsOneWidget);
    // The rail is still there and usable: that is the whole point.
    expect(find.byType(DashboardScreen), findsOneWidget);
    expect(find.byKey(const Key('rail-resize-handle')), findsOneWidget);
    expect(find.byKey(const ValueKey('open-work-board')).hitTestable(), findsOneWidget);
    expect(find.byType(BackButton), findsNothing, reason: 'beside the list there is nothing to go back to');

    // Pressing it again while the board shows is a no-op, like re-selecting a row.
    await _tapDashboardButton(tester);
    expect(SessionSelection.instance.pane.value, DetailPane.board);
    expect(pushes.routes, hasLength(1));

    // Selecting a session from the rail (or a notification) replaces the board.
    SessionSelection.instance.select('from-the-rail');
    await tester.pump();
    expect(find.byType(WorkBoardScreen), findsNothing);
    expect(tester.widget<SessionScreen>(find.byType(SessionScreen)).sessionId, 'from-the-rail');

    // ...and the dashboard button returns to it.
    await _tapDashboardButton(tester);
    expect(SessionSelection.instance.pane.value, DetailPane.board);
    expect(find.byType(WorkBoardScreen), findsOneWidget);
    expect(find.byType(SessionScreen), findsNothing);
    expect(pushes.routes, hasLength(1));

    // A session that ends clears the selection: back to the board, never a blank pane.
    SessionSelection.instance.select('ends');
    await tester.pump();
    SessionSelection.instance.clear();
    await tester.pump();
    expect(find.byType(WorkBoardScreen), findsOneWidget);

    await tester.pumpWidget(const SizedBox()); // dispose -> cancel the board's poll
  });

  testWidgets('wide: Open on a board row selects that session in the pane', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
      ]),
    });
    final store = ServerStore.forTest();
    await store.init();
    final repo = SessionRepository.forTest(store: store, clientFactory: _client);

    final pushes = await _pumpHome(
      tester,
      const Size(1400, 900),
      home: AdaptiveHome(
        boardBuilder: (onOpenSession) => WorkBoardScreen(
          embedded: true,
          onOpenSession: onOpenSession,
          repository: repo,
          servers: () => const [_server],
          clientFactory: _client,
          pollInterval: const Duration(hours: 1),
        ),
      ),
    );
    await tester.runAsync(() => repo.refresh());
    await tester.pump();

    final card = find.byKey(ValueKey('board-${_server.baseUrl}-s1'));
    expect(card, findsOneWidget);
    await tester.tap(find.byKey(ValueKey('board-open-${_server.baseUrl}-s1')));
    await tester.pump();

    expect(SessionSelection.instance.pane.value, const DetailPane.session('s1'));
    expect(find.byType(WorkBoardScreen), findsNothing, reason: 'the session replaced the board');
    final pane = tester.widget<SessionScreen>(find.byType(SessionScreen));
    expect(pane.sessionId, 's1');
    expect(pane.embedded, isTrue);
    expect(pushes.routes, hasLength(1), reason: 'selected in the pane, never pushed');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1)); // the opened pane's own short timers
  });

  testWidgets('narrow: the board is still pushed as a full screen, with a way back', (tester) async {
    final pushes = await _pumpHome(tester, const Size(420, 900));
    expect(pushes.routes, hasLength(1));

    await _tapDashboardButton(tester);

    expect(pushes.routes, hasLength(2), reason: 'a phone has no pane to show it in');
    expect(find.byType(WorkBoardScreen), findsOneWidget);
    expect(find.byType(BackButton), findsOneWidget);
    expect(SessionSelection.instance.pane.value, DetailPane.board, reason: 'untouched: a phone has no pane');

    await tester.pumpWidget(const SizedBox());
  });
}
