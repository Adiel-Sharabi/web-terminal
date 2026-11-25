// #529 - Mission Control's Usage tab against a faked server answering the shape
// `GET /api/usage-ledger?cluster=1` really returns (test/fixtures/usage_ledger.json was made by
// the server's own lib/usage-ledger.js over a synthetic two-machine ledger): the weeks, the
// ranked sessions with the reasons the server gave, a link only on a session that still
// exists, the peers the merge left out, and an honest "unknown" - never a zero - when no
// server can answer.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/usage_ledger_models.dart';
import 'package:ai_terminal/screens/mission_control/usage_view.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');
const _b = ServerConfig(name: 'Beta', baseUrl: 'http://beta.test:7681', bearerToken: 'tb', origin: ServerOrigin.cluster);

String _fixtureText() => File('test/fixtures/usage_ledger.json').readAsStringSync();

Future<SessionRepository> _repo() async {
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: jsonEncode([
      for (final sv in const [_a, _b]) {'name': sv.name, 'baseUrl': sv.baseUrl, 'bearerToken': sv.bearerToken},
    ]),
  });
  final store = ServerStore.forTest();
  await store.init();
  return SessionRepository.forTest(
      store: store, clientFactory: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response('{}', 404))));
}

void main() {
  group('the wire shape', () {
    test('the server\'s report is read as it is: weeks newest first, sessions ranked, links and reasons kept', () {
      final l = UsageLedger.fromJson(jsonDecode(_fixtureText()));
      expect(l.machines, ['Alpha', 'Beta']);
      expect(l.weeks.first.weekOf, '2026-11-23');
      expect(l.weeks.first.partial, isTrue, reason: 'today is in the week: its units are the day so far');
      expect(l.weeks.last.partial, isFalse);
      // 37.5M of subagent units over 191.8M: the in-progress day carries no split, so it dilutes the share.
      expect(l.weeks.first.subagentShare, closeTo(37.5 / 191.8, 0.001));
      expect(l.sessions.map((s) => '${s.machine}:${s.id}'), ['Alpha:1a2b3c4d', 'Beta:b1b2b3b4', 'Alpha:5e6f7a8b', 'Alpha:9c0d1e2f']);
      final top = l.sessions.first;
      expect(top.sessionId, 'abcd1234-0000-4000-8000-000000000001');
      expect(top.name, 'build the panel');
      expect(top.why.map((w) => w.code), containsAll(['context-reread', 'long-run', 'check-in-wakes']));
      expect(top.checkIns?.woken, 2);
      expect(top.checkIns?.maxCtxK, 610);
      expect(l.sessions[1].sessionId, isNull, reason: 'ended, or on a machine that could not name it');
      expect(l.checkInsWoken, 2);
      expect(l.skipped.single.machine, 'Delta');
      expect(l.unreachable, ['Gamma']);
    });

    test('junk and missing fields read as empty, never as an exception or a made-up number', () {
      final l = UsageLedger.fromJson({'weeks': 'x', 'sessions': [1, null, {}, {'id': 7}], 'checkIns': 'no', 'skipped': [{}], 'machine': 4});
      expect(l.isEmpty, isTrue);
      expect(l.machines, isEmpty);
      expect(UsageLedger.fromJson(null).isEmpty, isTrue);
      expect(UsageLedger.fromJson({'weeks': [{'weekOf': '2026-11-23', 'unitsM': 'many'}]}).weeks.single.unitsM, 0);
    });
  });

  group('the Usage tab', () {
    Future<void> pump(WidgetTester tester, {required ApiClient Function(ServerConfig) client, void Function(String)? open, bool Function(ServerConfig)? canAsk, List<ServerConfig> servers = const [_a, _b]}) async {
      tester.view.physicalSize = const Size(420, 3200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repo = await _repo();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McUsageView(
            servers: () => servers,
            client: client,
            repository: repo,
            onOpenSession: open ?? (_) {},
            canAsk: canAsk ?? (_) => true,
            every: const Duration(hours: 1),
          ),
        ),
      ));
      await tester.pump();
      await tester.pump();
    }

    testWidgets('shows the weeks, the ranked sessions with their reasons, and the peers the merge left out; asks for the cluster', (tester) async {
      final asked = <Uri>[];
      await pump(tester, client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
            asked.add(req.url);
            return http.Response(_fixtureText(), 200, headers: {'content-type': 'application/json'});
          })));
      expect(asked, hasLength(1), reason: 'the first server that answers speaks for the cluster');
      expect(asked.single.path, '/api/usage-ledger');
      expect(asked.single.queryParameters['cluster'], '1');
      expect(find.byKey(const ValueKey('mc-usage-machines')), findsOneWidget);
      expect(find.textContaining('Week of Nov 23 (so far)'), findsOneWidget);
      expect(find.textContaining('Week of Nov 16'), findsOneWidget);
      expect(find.text('191.8M'), findsOneWidget);
      // The ranked rows, in the server's order, the live one by its name.
      expect(find.byKey(const ValueKey('mc-usage-row-Alpha-1a2b3c4d')), findsOneWidget);
      expect(find.text('build the panel'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-why-1a2b3c4d-context-reread')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-why-1a2b3c4d-check-in-wakes')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-why-b1b2b3b4-cold-cache-write')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-checkins')), findsOneWidget);
      expect(find.textContaining('lower bound'), findsWidgets);
      // A peer too old for the route is named, calmly; one that could not be asked, too.
      expect(find.byKey(const ValueKey('mc-usage-skipped-Delta')), findsOneWidget);
      expect(find.textContaining('older version'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-unreachable')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-down')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('only a session that still exists can be opened', (tester) async {
      final opened = <String>[];
      await pump(tester,
          open: opened.add,
          client: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response(_fixtureText(), 200, headers: {'content-type': 'application/json'}))));
      expect(find.byKey(const ValueKey('mc-usage-open-1a2b3c4d')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-open-b1b2b3b4')), findsNothing);
      expect(find.byKey(const ValueKey('mc-usage-open-5e6f7a8b')), findsNothing);
      expect(find.textContaining('no longer open'), findsWidgets);
      await tester.tap(find.byKey(const ValueKey('mc-usage-open-1a2b3c4d')));
      expect(opened, ['abcd1234-0000-4000-8000-000000000001']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a server too old for the route is UNKNOWN, with its words - not an empty ledger - and the next server is tried', (tester) async {
      final order = <String>[];
      await pump(tester, client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
            order.add(sv.name);
            return sv.name == 'Alpha'
                ? http.Response('{"error":"not found"}', 404, headers: {'content-type': 'application/json'})
                : http.Response(_fixtureText(), 200, headers: {'content-type': 'application/json'});
          })));
      expect(order, ['Alpha', 'Beta']);
      expect(find.byKey(const ValueKey('mc-usage-row-Alpha-1a2b3c4d')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-down')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('every server failing says so; no week or session is drawn from nothing', (tester) async {
      await pump(tester, client: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response('{"error":"boom"}', 500, headers: {'content-type': 'application/json'}))));
      expect(find.byKey(const ValueKey('mc-usage-down')), findsOneWidget);
      expect(find.textContaining('Alpha'), findsWidgets);
      expect(find.byKey(const ValueKey('mc-usage-no-weeks')), findsNothing);
      expect(find.textContaining('Week of'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('no server that keeps a ledger: it says so and asks nothing', (tester) async {
      var calls = 0;
      await pump(tester, canAsk: (_) => false, client: (sv) => ApiClient(sv, httpClient: MockClient((_) async {
            calls++;
            return http.Response('{}', 200);
          })));
      expect(calls, 0);
      expect(find.byKey(const ValueKey('mc-usage-down')), findsOneWidget);
      expect(find.textContaining('this release or later'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a ledger with nothing in it says it is empty rather than drawing zeros', (tester) async {
      await pump(tester, client: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response(
          '{"version":1,"machine":"Alpha","days":7,"weeks":[],"sessions":[],"checkIns":{"total":{},"sessions":[]}}', 200,
          headers: {'content-type': 'application/json'}))));
      expect(find.byKey(const ValueKey('mc-usage-no-weeks')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-no-sessions')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-usage-checkins')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
