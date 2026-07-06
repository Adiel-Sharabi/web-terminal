import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

void main() {
  group('ApiClient.uploadClipboardImage', () {
    test('sends raw bytes + image mime, returns bracketed-paste path', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(
            jsonEncode({'ok': true, 'path': r'C:\srv\clip-1.png'}),
            200,
          );
        }),
      );

      final result = await client.uploadClipboardImage(
        'sess-1',
        <int>[1, 2, 3, 4],
        mime: 'image/png',
      );

      // The returned string is exactly what the PTY should receive.
      expect(result, '\x1b[200~C:\\srv\\clip-1.png\x1b[201~');
      // Raw bytes, image content-type, bearer auth, correct route.
      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/clipboard-image');
      expect(captured.bodyBytes, <int>[1, 2, 3, 4]);
      expect(captured.headers['content-type'], contains('image/png'));
      expect(captured.headers['authorization'], 'Bearer tok');
    });

    test('rejects a non-image mime before hitting the network', () async {
      var called = false;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          called = true;
          return http.Response('{}', 200);
        }),
      );

      expect(
        () => client.uploadClipboardImage('s', <int>[0], mime: 'text/plain'),
        throwsA(isA<ApiException>()),
      );
      expect(called, isFalse);
    });

    test('maps a server 500 to an ApiException', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async =>
            http.Response(jsonEncode({'error': 'Internal error'}), 500)),
      );

      await expectLater(
        client.uploadClipboardImage('s', <int>[9]),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 500)
            .having((e) => e.message, 'message', 'Internal error')),
      );
    });

    test('treats ok:false / empty path as a failure', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient(
            (req) async => http.Response(jsonEncode({'ok': false}), 200)),
      );

      await expectLater(
        client.uploadClipboardImage('s', <int>[9]),
        throwsA(isA<ApiException>()),
      );
    });
  });
}
