import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

void main() {
  group('ApiClient.serverConfig', () {
    test('GETs /api/config and surfaces the runtime subset', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(
            jsonEncode({
              'defaultCwd': r'C:\dev',
              'defaultCommand': 'claude',
              'scanFolders': [r'C:\dev'],
              'serverName': 'Home',
              'password': '***',
            }),
            200,
          );
        }),
      );

      final cfg = await client.serverConfig();
      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/config');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(cfg.defaultCwd, r'C:\dev');
      expect(cfg.defaultCommand, 'claude');
      expect(cfg.scanFolders, [r'C:\dev']);
      expect(cfg.serverName, 'Home');
    });

    test('maps a 500 to an ApiException', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response('{}', 500)),
      );
      await expectLater(client.serverConfig(),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 500)));
    });
  });

  group('ApiClient.folders', () {
    test('GETs /api/history/folders with no-store, returns the flat array',
        () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(
            jsonEncode([r'C:\dev', r'C:\dev\ai-terminal', r'C:\work']),
            200,
          );
        }),
      );

      final list = await client.folders();
      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/history/folders');
      expect(captured.headers['cache-control'], 'no-store');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(list, [r'C:\dev', r'C:\dev\ai-terminal', r'C:\work']);
    });

    test('throws when the body is not a JSON array', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient(
            (req) async => http.Response(jsonEncode({'nope': true}), 200)),
      );
      await expectLater(client.folders(), throwsA(isA<ApiException>()));
    });
  });

  group('ApiClient.reorderSessions', () {
    test('POSTs /api/sessions/order with {orderedIds}', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'ok': true}), 200);
        }),
      );

      await client.reorderSessions(['a', 'b', 'c']);
      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/sessions/order');
      expect(captured.headers['content-type'], contains('application/json'));
      expect(jsonDecode(captured.body), {
        'orderedIds': ['a', 'b', 'c']
      });
    });

    test('maps a 400 (bad ids) to an ApiException', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async =>
            http.Response(jsonEncode({'error': 'orderedIds too long'}), 400)),
      );
      await expectLater(
        client.reorderSessions(['x']),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 400)
            .having((e) => e.message, 'message', 'orderedIds too long')),
      );
    });
  });
}
