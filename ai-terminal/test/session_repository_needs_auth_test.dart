// A 401 is not unreachability — and collapsing the two cost three rounds of
// misdiagnosis on a live report.
//
// Reported 2026-09-21 from the S25: "Office is unreachable — sessions from this
// server may be stale", with office in fact up, directly pingable at 37ms and
// serving 7 sessions to every other caller. What had actually happened is that
// office's companion-app token hit its 90-day expiry and was pruned from that
// server's store, so office answered the phone with a plain 401.
//
// `SessionRepository._fetchServer` caught that with a bare `catch (_)`, threw
// the exception away and set `_serverOnline = false`, which is the one verdict
// the user cannot act on: an unreachable server may fix itself, an expired
// token never does. The banner then reported the network — the only part that
// was healthy — and hid the credential, the only part that was broken.
//
// The discrimination is what these tests pin, in BOTH directions. A test that
// only asserted "401 → needsAuth" would still pass if someone marked every
// failure as needsAuth, which would be the same defect pointing the other way.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/widgets/offline_banner.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _serverA =
    ServerConfig(name: 'Office', baseUrl: 'http://a:7785', bearerToken: 'ta');

String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

/// Every request answers [status] — so `/api/sessions` fails that way.
ApiClient Function(ServerConfig) _factoryReturning(int status) =>
    (ServerConfig s) => ApiClient(
          s,
          httpClient: MockClient((_) async => http.Response('', status)),
        );

Future<ServerStore> _store() async {
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

Future<SessionRepository> _refreshed(int status) async {
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: _encodeServers([_serverA]),
  });
  final repo = SessionRepository.forTest(
    store: await _store(),
    clientFactory: _factoryReturning(status),
  );
  await repo.refresh();
  return repo;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionRepository.serverNeedsAuth', () {
    test('a 401 marks the server needs-auth', () async {
      final repo = await _refreshed(401);
      expect(repo.serverNeedsAuth[_serverA.baseUrl], isTrue);
    });

    test('a 401 server is NOT reported reachable', () async {
      // The stale-session fallback and `_anyServerReachable` both key off this,
      // so a 401 has to stay "not online" — only the ADVICE changes.
      final repo = await _refreshed(401);
      expect(repo.serverOnline[_serverA.baseUrl], isFalse);
    });

    test('a 503 marks it offline but NOT needs-auth', () async {
      // The load-bearing negative: without the status check in `_fetchServer`
      // this goes red, because every failure would claim an expired token.
      final repo = await _refreshed(503);
      expect(repo.serverOnline[_serverA.baseUrl], isFalse);
      expect(repo.serverNeedsAuth[_serverA.baseUrl], isFalse);
    });

    test('a successful refresh clears a previous needs-auth', () async {
      // Re-authenticating must actually clear the banner. A latch here would
      // leave "needs sign-in" up forever after the token was replaced.
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      var status = 401;
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            if (status == 200 && req.url.path == '/api/sessions') {
              return http.Response(jsonEncode(const []), 200);
            }
            return http.Response('', status);
          }),
        ),
      );
      await repo.refresh();
      expect(repo.serverNeedsAuth[_serverA.baseUrl], isTrue);
      status = 200;
      await repo.refresh();
      expect(repo.serverNeedsAuth[_serverA.baseUrl], isFalse);
      expect(repo.serverOnline[_serverA.baseUrl], isTrue);
    });
  });

  group('OfflineBanner wording', () {
    test('names the server and the screen that fixes it', () {
      final msg = OfflineBanner.messageFor(
        offline: const <String>[],
        needsAuth: const ['Office'],
      );
      expect(msg, contains('Office'));
      expect(msg, contains('needs sign-in'));
      expect(msg, contains('Settings'));
      // The word that sent the user to look at the network must be gone.
      expect(msg, isNot(contains('unreachable')));
    });

    test('auth wins when a server is down AND another needs sign-in', () {
      // Auth is the only half that is actionable; reporting the other half is
      // what made an expired token read as a network fault.
      final msg = OfflineBanner.messageFor(
        offline: const ['XPS'],
        needsAuth: const ['Office'],
      );
      expect(msg, contains('needs sign-in'));
      expect(msg, isNot(contains('unreachable')));
    });

    test('plural needs-auth does not name one server', () {
      final msg = OfflineBanner.messageFor(
        offline: const <String>[],
        needsAuth: const ['Office', 'XPS'],
      );
      expect(msg, contains('2 servers need sign-in'));
    });

    test('the unreachable wording is unchanged when nothing needs auth', () {
      expect(
        OfflineBanner.messageFor(
          offline: const ['Office'],
          needsAuth: const <String>[],
        ),
        'Office is unreachable — sessions from this server may be stale',
      );
      expect(
        OfflineBanner.messageFor(
          offline: const ['Office', 'XPS'],
          needsAuth: const <String>[],
        ),
        '2 servers are unreachable',
      );
    });
  });
}
