// #271 - an answer is typed by the SERVER (POST /api/sessions/:id/answer), so an app
// pause or socket reattach mid-answer cannot cut it short. [deliverAnswer] owns the
// choice between that and the old socket-paced loop.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _frames = [
  AnswerFrame('1', 250),
  AnswerFrame('\x1b[B', 600),
  AnswerFrame('\x1b[200~words\x1b[201~', 600, text: true, other: true),
  AnswerFrame('\r', 600),
];

void main() {
  group('deliverAnswer', () {
    test('a server that accepts types it: nothing goes over the socket', () async {
      final sent = <String>[];
      List<Map<String, Object>>? wire;
      final ok = await deliverAnswer(_frames,
          post: (w) async {
            wire = w;
            return 0;
          },
          send: sent.add);
      expect(ok, isTrue);
      expect(sent, isEmpty);
      expect(wire, [
        {'keys': '1', 'delayMs': 250},
        {'keys': '\x1b[B', 'delayMs': 600},
        {'keys': '\x1b[200~words\x1b[201~', 'delayMs': 600},
        {'keys': '\r', 'delayMs': 600},
      ]);
    });

    test('waits as long as the server says the typing takes', () async {
      final sw = Stopwatch()..start();
      await deliverAnswer(_frames, post: (_) async => 300, send: (_) {});
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(290));
    });

    test('a server too old for the route falls back to the socket loop, in order', () async {
      final sent = <String>[];
      await deliverAnswer(const [AnswerFrame('1', 0), AnswerFrame('\r', 0)],
          post: (_) async => null, send: sent.add);
      expect(sent, ['1', '\r']);
    });

    test('no poster at all is the socket loop', () async {
      final sent = <String>[];
      await deliverAnswer(const [AnswerFrame('2', 0)], post: null, send: sent.add);
      expect(sent, ['2']);
    });

    test('a FAILED post is never retyped over the socket (it may have landed)', () async {
      final sent = <String>[];
      final ok = await deliverAnswer(_frames,
          post: (_) async => throw const ApiException(0, 'timeout'), send: sent.add);
      expect(sent, isEmpty);
      expect(ok, isTrue, reason: 'the caller verifies, and puts the card back if needed');
    });

    test('a 400 (the server refused it and typed nothing) goes over the socket', () async {
      final sent = <String>[];
      await deliverAnswer(const [AnswerFrame('1', 0), AnswerFrame('\r', 0)],
          post: (_) async => throw const ApiException(400, 'frames take 70000 ms'), send: sent.add);
      expect(sent, ['1', '\r']);
    });

    test('a 409 (another answer still being typed) is not typed again', () async {
      final sent = <String>[];
      await deliverAnswer(_frames, post: (_) async => throw const ApiException(409, 'busy'), send: sent.add);
      expect(sent, isEmpty);
    });

    test('reports a caller that went away', () async {
      expect(await deliverAnswer(_frames, post: (_) async => 0, send: (_) {}, alive: () => false), isFalse);
    });
  });

  group('ApiClient.postAnswer', () {
    const server = ServerConfig(name: 'S', baseUrl: 'http://s.test', bearerToken: 't');

    test('202 returns the typing time and sends the frames as JSON', () async {
      Object? body;
      final c = ApiClient(server, httpClient: MockClient((req) async {
        expect(req.method, 'POST');
        expect(req.url.path, '/api/sessions/abc/answer');
        body = jsonDecode(req.body);
        return http.Response(jsonEncode({'ok': true, 'frames': 1, 'ms': 600}), 202);
      }));
      expect(await c.postAnswer('abc', [{'keys': '1', 'delayMs': 600}]), 600);
      expect(body, {
        'frames': [{'keys': '1', 'delayMs': 600}],
      });
    });

    test('a bare 404 (no such route) is null: the one case that may fall back', () async {
      final c = ApiClient(server, httpClient: MockClient((_) async => http.Response('Cannot POST', 404)));
      expect(await c.postAnswer('abc', [{'keys': '1', 'delayMs': 0}]), isNull);
    });

    test("the route's own 404 (no such session) throws, never falls back", () async {
      final c = ApiClient(server,
          httpClient: MockClient((_) async => http.Response(jsonEncode({'error': 'session not found'}), 404)));
      expect(c.postAnswer('abc', [{'keys': '1', 'delayMs': 0}]), throwsA(isA<ApiException>()));
    });

    test('a 409 (an answer already being typed) throws', () async {
      final c = ApiClient(server,
          httpClient: MockClient((_) async => http.Response(jsonEncode({'error': 'busy'}), 409)));
      expect(c.postAnswer('abc', [{'keys': '1', 'delayMs': 0}]), throwsA(isA<ApiException>()));
    });
  });
}
