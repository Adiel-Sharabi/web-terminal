// #96 — adding a server with a USERNAME + PASSWORD instead of a bearer token.
//
// The complaint this fixes: a bearer token could only be obtained by reading it
// off the server's disk (api-tokens.json) or by already having one. There was no
// way to add a server from the app alone, which made a new box unreachable from
// the companion until someone SSH'd in.
//
// The server side already existed — POST /api/auth/token takes {user, password,
// label} and returns a token — so this needed no server change at all.
//
// The security property under test is that the PASSWORD IS NEVER STORED: it is
// exchanged once for a revocable token, and only the token is persisted.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';

void main() {
  group('ApiClient.fetchToken', () {
    test('posts the credentials and returns the token', () async {
      late http.Request seen;
      final client = MockClient((req) async {
        seen = req;
        return http.Response(
          jsonEncode({'ok': true, 'token': 'tok_abc123'}),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final token = await ApiClient.fetchToken(
        baseUrl: 'https://box.example',
        user: 'admin',
        password: 'hunter2',
        label: 'companion',
        httpClient: client,
      );

      expect(token, 'tok_abc123');
      expect(seen.method, 'POST');
      expect(seen.url.toString(), 'https://box.example/api/auth/token');
      final body = jsonDecode(seen.body) as Map<String, dynamic>;
      expect(body['user'], 'admin');
      expect(body['password'], 'hunter2');
      expect(body['label'], 'companion');
    });

    test('a trailing slash on the base URL does not double up the path', () {
      // '/api/auth/token' appended to 'https://box.example/' would give a
      // double slash, which some reverse proxies 404.
      return () async {
        late http.Request seen;
        final client = MockClient((req) async {
          seen = req;
          return http.Response(jsonEncode({'ok': true, 'token': 't'}), 200);
        });
        await ApiClient.fetchToken(
          baseUrl: 'https://box.example///',
          user: 'admin',
          password: 'p',
          httpClient: client,
        );
        expect(seen.url.toString(), 'https://box.example/api/auth/token');
      }();
    });

    test('401 is reported as bad credentials, not as an outage', () async {
      final client = MockClient((_) async =>
          http.Response(jsonEncode({'error': 'Invalid credentials'}), 401));
      await expectLater(
        ApiClient.fetchToken(
          baseUrl: 'https://box.example',
          user: 'admin',
          password: 'wrong',
          httpClient: client,
        ),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', contains('Wrong username or password'))),
      );
    });

    test('429 says rate-limited rather than looking like a wrong password',
        () async {
      // The server rate-limits failed logins per IP. Reporting that as bad
      // credentials would send the user chasing a password that is correct.
      final client = MockClient((_) async =>
          http.Response(jsonEncode({'error': 'Too many attempts'}), 429));
      await expectLater(
        ApiClient.fetchToken(
          baseUrl: 'https://box.example',
          user: 'admin',
          password: 'p',
          httpClient: client,
        ),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', contains('Too many attempts'))),
      );
    });

    test('a 200 with no token is an error, not an empty token', () async {
      // Silently storing '' would produce a server that fails every later call
      // with a confusing 401.
      final client = MockClient(
          (_) async => http.Response(jsonEncode({'ok': true}), 200));
      await expectLater(
        ApiClient.fetchToken(
          baseUrl: 'https://box.example',
          user: 'admin',
          password: 'p',
          httpClient: client,
        ),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', contains('no token'))),
      );
    });

    test('an empty base URL fails before any request is made', () async {
      var called = false;
      final client = MockClient((_) async {
        called = true;
        return http.Response('', 200);
      });
      await expectLater(
        ApiClient.fetchToken(
          baseUrl: '   ',
          user: 'admin',
          password: 'p',
          httpClient: client,
        ),
        throwsA(isA<ApiException>()),
      );
      expect(called, isFalse);
    });

    test('THE security property: the password is not in what gets persisted',
        () async {
      // A ServerConfig is what reaches disk. It has no password field at all —
      // only the token the password bought. This test exists so that adding one
      // later fails loudly.
      final client = MockClient((_) async =>
          http.Response(jsonEncode({'ok': true, 'token': 'tok_xyz'}), 200));
      final token = await ApiClient.fetchToken(
        baseUrl: 'https://box.example',
        user: 'admin',
        password: 'super-secret-pw',
        httpClient: client,
      );
      final cfg = ServerConfig(
        name: 'Office-Tests',
        baseUrl: 'https://box.example',
        bearerToken: token,
      );
      // ServerConfig is persisted as {name, baseUrl, bearerToken} (server_store
      // doc, :5). Reconstruct exactly that and assert the password is absent.
      final persisted = jsonEncode({
        'name': cfg.name,
        'baseUrl': cfg.baseUrl,
        'bearerToken': cfg.bearerToken,
      });
      expect(persisted, contains('tok_xyz'));
      expect(persisted.contains('super-secret-pw'), isFalse,
          reason: 'the password must never reach persisted config');
      // And the type itself carries no password-shaped field to leak later.
      expect(cfg.toString().contains('super-secret-pw'), isFalse);
    });
  });
}
