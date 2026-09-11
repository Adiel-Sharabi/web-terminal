// #252 - a failed defaults fetch must not be indistinguishable from "this server has
// no defaults". The sheet used to swallow the error and leave the fields blank, with a
// comment saying it was "matching the web's silent failure" - and the web had the same
// hole, which is why one server blip cost the defaults on BOTH clients at once.
//
// This client cannot be reloaded the way a browser tab can, so it must say so and retry.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/new_session_sheet.dart';

const _server = ServerConfig(name: 'Box', baseUrl: 'http://x', bearerToken: 't');

const _configBody = '{"defaultCwd":"C:/test-root","defaultCommand":"TEST-CMD",'
    '"scanFolders":["C:/test-root"]}';

/// Serves everything the sheet asks for; `/api/config` is delegated so each test
/// decides whether (and when) it fails.
MockClient _client(http.Response Function(int callNo) config) {
  var configCalls = 0;
  return MockClient((req) async {
    final path = req.url.path;
    if (path.endsWith('/api/config')) return config(++configCalls);
    if (path.endsWith('/history/folders')) return http.Response('[]', 200);
    if (path.endsWith('/api/agents')) return http.Response('{"agents":[]}', 200);
    return http.Response('{}', 200);
  });
}

Future<void> _openSheet(WidgetTester tester, MockClient client) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showNewSessionSheet(
              context,
              servers: const [_server],
              initialServer: _server,
              onCreated: (_) {},
              clientBuilder: (s) => ApiClient(s, httpClient: client),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

/// Tears the tree down so the sheet's dispose() cancels the retry timer - a widget
/// test fails on a pending timer, and the retry is deliberately still armed.
Future<void> _teardown(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a failed /api/config is reported, not left as blank fields', (tester) async {
    await _openSheet(tester, _client((_) => http.Response('nope', 500)));

    expect(find.textContaining('Could not reach this server for its defaults'), findsOneWidget);
    await _teardown(tester);
  });

  testWidgets('the defaults arrive on the retry, and the notice goes away', (tester) async {
    var calls = 0;
    await _openSheet(tester, _client((n) {
      calls = n;
      return n == 1 ? http.Response('nope', 500) : http.Response(_configBody, 200);
    }));

    expect(find.textContaining('Could not reach this server'), findsOneWidget);

    // The first backoff is 2s.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(calls, greaterThanOrEqualTo(2), reason: 'it must actually retry');
    expect(find.textContaining('Could not reach this server'), findsNothing);
    expect(
      tester.widget<TextField>(find.byType(TextField).at(2)).controller?.text,
      'TEST-CMD',
    );
    await _teardown(tester);
  });
}
