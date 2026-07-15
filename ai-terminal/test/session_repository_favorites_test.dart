// Unit tests for SessionRepository's #60 support: the favorites-sync
// capability cache (gating whether the star may be offered at all) and that
// Session.favorite/favoriteRank round-trip through a refresh exactly like any
// other server-reported field — proving the repository is the only path
// sessions/favorite state flows through (no local favorites store is ever
// consulted).
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _serverA =
    ServerConfig(name: 'A', baseUrl: 'http://a:7785', bearerToken: 'ta');

String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

Future<ServerStore> _store() async {
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

/// A client factory whose `/api/version` reports [capabilities] and whose
/// `/api/sessions` returns [sessions] (raw JSON maps).
ApiClient Function(ServerConfig) _factory({
  List<String> capabilities = const [],
  List<Map<String, dynamic>> sessions = const [],
}) =>
    (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            switch (req.url.path) {
              case '/api/version':
                return http.Response(
                  jsonEncode({
                    'serverName': s.name,
                    'version': '1',
                    'capabilities': capabilities,
                  }),
                  200,
                );
              case '/api/sessions':
                return http.Response(jsonEncode(sessions), 200);
              default:
                return http.Response('[]', 200);
            }
          }),
        );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionRepository.supportsFavorites (#60)', () {
    test('false before any server has ever been reached', () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _factory(capabilities: const ['favorites-sync']),
      );
      expect(repo.supportsFavorites(_serverA.baseUrl), isFalse);
    });

    test('true once /api/version reports favorites-sync', () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _factory(capabilities: const ['favorites-sync']),
      );
      await repo.refresh();
      expect(repo.supportsFavorites(_serverA.baseUrl), isTrue);
    });

    test('stays false for a server too old to advertise the capability',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        // An old server's capabilities array simply omits favorites-sync.
        clientFactory: _factory(capabilities: const ['attention', 'clear']),
      );
      await repo.refresh();
      expect(repo.supportsFavorites(_serverA.baseUrl), isFalse);
    });

    test('picks up favorites-sync when the server is UPGRADED mid-session '
        '(no app restart)', () async {
      // The bug: the capability was cached on first contact and never re-checked,
      // so a server cold-restarted onto a favorites-sync build while the app was
      // already running stayed "unsupported" until the app was restarted. A later
      // refresh must now flip it true.
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      // /api/version reports the OLD capability set first, then the upgraded one.
      var caps = <String>['attention', 'clear'];
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            if (req.url.path == '/api/version') {
              return http.Response(
                jsonEncode({'serverName': s.name, 'version': '1', 'capabilities': caps}),
                200,
              );
            }
            return http.Response('[]', 200);
          }),
        ),
      );
      await repo.refresh();
      expect(repo.supportsFavorites(_serverA.baseUrl), isFalse,
          reason: 'old server: no favorites-sync yet');

      caps = <String>['attention', 'clear', 'favorites-sync']; // server upgraded
      await repo.refresh();
      expect(repo.supportsFavorites(_serverA.baseUrl), isTrue,
          reason: 'a later refresh must pick up the upgrade');
    });
  });

  group('Session.favorite/favoriteRank round-trip via refresh (#60)', () {
    test('a session\'s favorite + rank come straight from /api/sessions — '
        'no local store involved', () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _factory(
          capabilities: const ['favorites-sync'],
          sessions: const [
            {
              'id': 's1',
              'name': 'pinned',
              'status': 'idle',
              'favorite': true,
              'favoriteRank': 2,
            },
            {'id': 's2', 'name': 'not-pinned', 'status': 'idle'},
          ],
        ),
      );

      await repo.refresh();

      final byId = {for (final s in repo.current) s.id: s};
      expect(byId['s1']!.favorite, isTrue);
      expect(byId['s1']!.favoriteRank, 2);
      expect(byId['s2']!.favorite, isFalse);
      expect(byId['s2']!.favoriteRank, isNull);
    });

    test('the pinned order (Session.pinnedOrder) survives a cache round-trip',
        () async {
      final raw = SessionRepository.encodeSessionCache([
        Session(
          id: 's1',
          name: 'a',
          cwd: '/x',
          status: 'idle',
          claudeSessionId: null,
          lastActivity: 1,
          notifyLevel: 'important',
          server: _serverA,
          favorite: true,
          favoriteRank: 1,
        ),
        Session(
          id: 's2',
          name: 'b',
          cwd: '/x',
          status: 'idle',
          claudeSessionId: null,
          lastActivity: 1,
          notifyLevel: 'important',
          server: _serverA,
          favorite: true,
          favoriteRank: 0,
        ),
      ]);
      final back = SessionRepository.decodeSessionCache(raw, [_serverA]);
      expect(Session.pinnedOrder(back).map((s) => s.id), ['s2', 's1']);
    });
  });
}
