// #327 - the session list: a title filter, and "Not waiting" in the session's menu.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/widgets/session_action_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

Session _s(String id, String name, {SessionReason? reason}) => Session(
      id: id,
      name: name,
      cwd: r'C:\dev',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 0,
      notifyLevel: 'important',
      server: _server,
      reason: reason,
    );

void main() {
  group('sessionsMatchingTitle', () {
    final list = [_s('a', 'Speed up downloads'), _s('b', 'GP10 version'), _s('c', 'speedy')];

    test('matches any part of the title, ignoring case and surrounding spaces', () {
      expect(sessionsMatchingTitle(list, '  SPEED ').map((s) => s.id), ['a', 'c']);
      expect(sessionsMatchingTitle(list, 'version').map((s) => s.id), ['b']);
    });

    test('a blank query keeps everything; no match is an empty list', () {
      expect(sessionsMatchingTitle(list, '   ').length, 3);
      expect(sessionsMatchingTitle(list, 'nothing like it'), isEmpty);
    });
  });

  group('session menu: Not waiting', () {
    late List<http.Request> sent;
    ApiClient api() => ApiClient(_server, httpClient: MockClient((req) async {
          sent.add(req);
          return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
        }));

    setUp(() => sent = []);

    Future<void> open(WidgetTester tester, Session s, {required bool canClearWait}) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showSessionActionsSheet(context, s,
                  onChanged: () {}, canClearWait: canClearWait, api: api()),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    const reported = SessionReason(kind: 'you', text: 'say go', source: 'reported');

    testWidgets('offered when allowed: names what the agent said and clears it', (tester) async {
      await open(tester, _s('r', 'Reported', reason: reported), canClearWait: true);
      expect(find.text('Not waiting'), findsOneWidget);
      expect(find.text('Agent says: say go'), findsOneWidget);
      await tester.tap(find.text('Not waiting'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Failed'), findsNothing, reason: 'the PATCH must have succeeded');
      expect(sent.map((r) => '${r.method} ${r.url.path} ${r.body}'), ['PATCH /api/sessions/r/brief {"clearWait":true}']);
      expect(find.text('Not waiting'), findsNothing, reason: 'the sheet closes');
    });

    testWidgets('not offered when the rule says no', (tester) async {
      await open(tester, _s('m', 'Mechanical', reason: reported), canClearWait: false);
      expect(find.text('Not waiting'), findsNothing);
      expect(find.text('Rename'), findsOneWidget);
    });
  });
}
