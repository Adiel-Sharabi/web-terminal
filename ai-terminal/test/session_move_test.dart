// #558 - "Move under..." and "Hand sub-sessions to...": the picker never offers the
// session itself or anything under it, and the right request goes to the server.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/widgets/session_action_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

Session _s(String id, String name, {String? parentId}) => Session(
      id: id,
      name: name,
      cwd: r'C:\dev',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 0,
      notifyLevel: 'important',
      server: _server,
      parentId: parentId,
    );

void main() {
  // lead L opened kid K, which opened grandkid G; X is unrelated.
  final lead = _s('L', 'Lead');
  final kid = _s('K', 'Kid', parentId: 'L');
  final grand = _s('G', 'Grandkid', parentId: 'K');
  final other = _s('X', 'Other');
  final all = [lead, kid, grand, other];

  late List<http.Request> sent;
  late http.Response Function(http.Request) reply;
  ApiClient api() => ApiClient(_server, httpClient: MockClient((req) async {
        sent.add(req);
        return reply(req);
      }));
  setUp(() {
    sent = [];
    reply = (_) => http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
  });

  Future<void> pump(WidgetTester tester, Future<void> Function(BuildContext) open) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(builder: (context) => TextButton(onPressed: () => open(context), child: const Text('open'))),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  String req(http.Request r) => '${r.method} ${r.url.path} ${r.body}';

  testWidgets('Move under: never itself or a descendant; the pick is PATCHed to the owner', (tester) async {
    await pump(tester, (c) => promptAndMoveSession(c, kid, onChanged: () {}, api: api(), sessions: all));
    expect(find.byKey(const ValueKey('parent-picker-K')), findsNothing, reason: 'itself');
    expect(find.byKey(const ValueKey('parent-picker-G')), findsNothing, reason: 'under it: a loop');
    expect(find.byKey(const ValueKey('parent-picker-L')), findsOneWidget, reason: 'its current parent, shown checked');
    expect(find.byKey(const ValueKey('parent-picker-none')), findsOneWidget, reason: 'it has a parent to leave');
    await tester.tap(find.byKey(const ValueKey('parent-picker-X')));
    await tester.pumpAndSettle();
    expect(sent.map(req), ['PATCH /api/sessions/K/parent {"parentId":"X"}']);
    expect(find.text('Kid moved under Other'), findsOneWidget);
  });

  testWidgets('Move under: "No parent" sends null; a top-level session is not offered it', (tester) async {
    await pump(tester, (c) => promptAndMoveSession(c, kid, onChanged: () {}, api: api(), sessions: all));
    await tester.tap(find.byKey(const ValueKey('parent-picker-none')));
    await tester.pumpAndSettle();
    expect(sent.map(req), ['PATCH /api/sessions/K/parent {"parentId":null}']);

    await pump(tester, (c) => promptAndMoveSession(c, other, onChanged: () {}, api: api(), sessions: all));
    expect(find.byKey(const ValueKey('parent-picker-none')), findsNothing);
  });

  testWidgets('Move under: the server\'s refusal is shown, not swallowed', (tester) async {
    reply = (_) => http.Response(jsonEncode({'error': 'the move would make a loop'}), 409, headers: {'content-type': 'application/json'});
    await pump(tester, (c) => promptAndMoveSession(c, kid, onChanged: () {}, api: api(), sessions: all));
    await tester.tap(find.byKey(const ValueKey('parent-picker-X')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Move failed'), findsOneWidget);
  });

  testWidgets('Hand sub-sessions: the whole subtree is excluded; a partial move says what failed', (tester) async {
    reply = (_) => http.Response(
        jsonEncode({'moved': [], 'failed': [{'id': 'K', 'status': 501, 'error': 'that server cannot move sessions yet (update it)'}]}),
        501, headers: {'content-type': 'application/json'});
    await pump(tester, (c) => promptAndHandOverChildren(c, lead, onChanged: () {}, api: api(), sessions: all));
    for (final id in ['L', 'K', 'G']) {
      expect(find.byKey(ValueKey('parent-picker-$id')), findsNothing, reason: '$id is the session or under it');
    }
    await tester.tap(find.byKey(const ValueKey('parent-picker-X')));
    await tester.pumpAndSettle();
    expect(sent.map(req), ['POST /api/sessions/L/children/move {"to":"X"}']);
    expect(find.textContaining('1 not moved: that server cannot move sessions yet'), findsOneWidget);
  });

  // One sheet per test: a second pump keeps the first sheet open over the button.
  testWidgets('the actions sheet does not offer Move under when the owner cannot take it', (tester) async {
    await pump(tester, (c) => showSessionActionsSheet(c, kid, onChanged: () {}, canClearWait: false, canMove: false, api: api()));
    expect(find.text('Rename'), findsOneWidget);
    expect(find.text('Move under...'), findsNothing);
  });

  testWidgets('the actions sheet offers Move under when the owner can take it', (tester) async {
    await pump(tester, (c) => showSessionActionsSheet(c, kid, onChanged: () {}, canClearWait: false, canMove: true, api: api()));
    expect(find.text('Rename'), findsOneWidget);
    expect(find.text('Move under...'), findsOneWidget);
  });
}
