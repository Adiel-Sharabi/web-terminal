// #389 - "Switch account" for one machine. The server owns the swap; these pin what
// the companion sends (the target's label, to THIS machine only) and what it paints.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/widgets/claude_account_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _server = ServerConfig(name: 'Office', baseUrl: 'http://office:7681', bearerToken: 'tok');

Map<String, dynamic> _status(String activeEmail) => {
      'active': {'email': activeEmail, 'label': activeEmail, 'plan': 'max', 'refreshExpiresAt': 1795000000000},
      'saved': [
        {'label': 'a@example.com', 'email': 'a@example.com', 'active': activeEmail == 'a@example.com', 'plan': 'max'},
        {
          'label': 'b@example.com', 'email': 'b@example.com', 'active': activeEmail == 'b@example.com', 'plan': 'max',
          'refreshExpiringSoon': true,
        },
      ],
    };

/// A fake server that keeps one active account and records every request.
({ApiClient client, List<http.Request> requests}) _fake({String active = 'a@example.com'}) {
  final requests = <http.Request>[];
  var current = active;
  final client = ApiClient(_server, httpClient: MockClient((req) async {
    requests.add(req);
    if (req.method == 'GET' && req.url.path == '/api/claude-account') {
      return http.Response(jsonEncode(_status(current)), 200);
    }
    if (req.method == 'POST' && req.url.path == '/api/claude-account/switch') {
      current = (jsonDecode(req.body) as Map)['account'] as String;
      return http.Response(jsonEncode({'to': current, 'alreadyActive': false, 'status': _status(current)}), 200);
    }
    return http.Response('{"error":"unexpected"}', 404);
  }));
  return (client: client, requests: requests);
}

Future<void> _pump(WidgetTester tester, ApiClient client) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: SingleChildScrollView(child: ClaudeAccountSheet(client: client, machineName: 'Office'))),
  ));
  await tester.pumpAndSettle();
}

void main() {
  test('parses the status the server sends, with no token anywhere', () {
    final s = ClaudeAccountStatus.fromJson(_status('a@example.com'));
    expect(s.active?.email, 'a@example.com');
    expect(s.active?.refreshExpiresAt, DateTime.fromMillisecondsSinceEpoch(1795000000000));
    expect(s.saved.map((a) => a.active), [true, false]);
    expect(s.saved[1].refreshExpiringSoon, isTrue);
  });

  testWidgets('switching posts the chosen account to this machine, after a confirm', (tester) async {
    final f = _fake();
    await _pump(tester, f.client);
    expect(find.text('a@example.com'), findsOneWidget); // logged in now
    expect(find.textContaining('expires soon'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('claude-account-b@example.com')));
    await tester.pumpAndSettle();
    expect(f.requests.where((r) => r.method == 'POST'), isEmpty, reason: 'nothing is written before the confirm');
    await tester.tap(find.widgetWithText(FilledButton, 'Switch'));
    await tester.pumpAndSettle();

    final post = f.requests.singleWhere((r) => r.method == 'POST');
    expect(post.url.toString(), 'http://office:7681/api/claude-account/switch');
    expect(jsonDecode(post.body), {'account': 'b@example.com'});
    // The sheet repaints from the server's answer: b is now the login, a is offered.
    expect(find.byKey(const ValueKey('claude-account-a@example.com')), findsOneWidget);
  });

  testWidgets('cancel writes nothing', (tester) async {
    final f = _fake();
    await _pump(tester, f.client);
    await tester.tap(find.byKey(const ValueKey('claude-account-b@example.com')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(f.requests.where((r) => r.method == 'POST'), isEmpty);
  });

  testWidgets("a refusal from the server is shown, not swallowed", (tester) async {
    final client = ApiClient(_server, httpClient: MockClient((req) async =>
        http.Response(jsonEncode({'error': '~/.claude.json is not valid JSON; nothing was changed'}), 409)));
    await _pump(tester, client);
    expect(find.textContaining('not valid JSON'), findsOneWidget);
  });

  testWidgets('an active login never saved offers Save, which posts to save', (tester) async {
    final requests = <http.Request>[];
    final client = ApiClient(_server, httpClient: MockClient((req) async {
      requests.add(req);
      final saved = req.method == 'POST';
      return http.Response(jsonEncode(saved
          ? {'label': 'c@example.com', 'status': _status('a@example.com')}
          : {'active': {'email': 'c@example.com', 'label': null}, 'saved': []}), 200);
    }));
    await _pump(tester, client);
    await tester.tap(find.byKey(const ValueKey('claude-account-save')));
    await tester.pumpAndSettle();
    expect(requests.last.url.path, '/api/claude-account/save');
  });
}
