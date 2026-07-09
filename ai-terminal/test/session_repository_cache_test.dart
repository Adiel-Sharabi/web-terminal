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
const _serverB =
    ServerConfig(name: 'B', baseUrl: 'http://b:7785', bearerToken: 'tb');

Session _mk(
  ServerConfig server,
  String id,
  String status, {
  int? last,
  String name = 'n',
}) =>
    Session(
      id: id,
      name: name,
      cwd: '/w/$id',
      status: status,
      claudeSessionId: null,
      lastActivity: last,
      notifyLevel: 'important',
      server: server,
      autoCommand: '',
    );

/// Encodes a server list the way [ServerStore] persists it.
String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

/// A client factory whose every request fails (server unreachable), so a
/// [SessionRepository.refresh] marks all servers offline.
ApiClient _offlineFactory(ServerConfig s) =>
    ApiClient(s, httpClient: MockClient((_) async => http.Response('', 503)));

/// A client factory whose `/api/sessions` returns one session (id `<name>1`);
/// everything else (e.g. `/api/version`) 503s. Used to prove a refresh
/// populates [SessionRepository.current].
ApiClient _onlineFactory(ServerConfig s) => ApiClient(
      s,
      httpClient: MockClient((req) async {
        if (req.url.path == '/api/sessions') {
          return http.Response(
            jsonEncode([
              {'id': '${s.name}1', 'name': 'proj', 'status': 'idle', 'lastActivity': 1000},
            ]),
            200,
          );
        }
        return http.Response('', 503);
      }),
    );

/// A loaded, isolated [ServerStore] over the current mock prefs.
Future<ServerStore> _store() async {
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionRepository session cache (encode/decode)', () {
    test('round-trips fields and re-attaches the current ServerConfig', () {
      final raw = SessionRepository.encodeSessionCache([
        _mk(_serverA, 'a1', 'working', last: 1000, name: 'proj-a'),
        _mk(_serverB, 'b1', 'waiting', last: 2000, name: 'proj-b'),
      ]);
      final back = SessionRepository.decodeSessionCache(raw, [_serverA, _serverB]);

      expect(back.map((s) => s.id), ['a1', 'b1']);
      expect(back[0].name, 'proj-a');
      expect(back[0].status, 'working');
      expect(back[0].lastActivity, 1000);
      expect(back[0].cwd, '/w/a1');
      // The session is re-attached to the live server instance (identical).
      expect(identical(back[0].server, _serverA), isTrue);
      expect(identical(back[1].server, _serverB), isTrue);
    });

    test('drops cached sessions whose server is no longer configured', () {
      final raw = SessionRepository.encodeSessionCache([
        _mk(_serverA, 'a1', 'idle'),
        _mk(_serverB, 'b1', 'idle'),
      ]);
      // Only A is configured now — B's sessions must be dropped.
      final back = SessionRepository.decodeSessionCache(raw, [_serverA]);
      expect(back.map((s) => s.id), ['a1']);
    });

    test('a corrupt or non-list payload decodes to empty', () {
      expect(SessionRepository.decodeSessionCache('not json', [_serverA]),
          isEmpty);
      expect(SessionRepository.decodeSessionCache('{"a":1}', [_serverA]),
          isEmpty);
    });
  });

  group('SessionRepository.primeFromCache', () {
    test('emits the cached list (sorted attention-first) before any network',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA, _serverB]),
        'wt.lastSessions': SessionRepository.encodeSessionCache([
          _mk(_serverA, 'a1', 'working', last: 1000),
          _mk(_serverB, 'b1', 'waiting', last: 2000),
        ]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _offlineFactory,
      );

      final emissions = <List<Session>>[];
      final sub = repo.sessions.listen(emissions.add);
      await repo.primeFromCache();
      await Future<void>.delayed(Duration.zero);

      // waiting (attention rank 0) sorts ahead of working (rank 3).
      expect(emissions, isNotEmpty);
      expect(emissions.last.map((s) => s.id), ['b1', 'a1']);
      expect(repo.current.map((s) => s.id), ['b1', 'a1']);
      await sub.cancel();
    });

    test('is a no-op once a list is already present', () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
        'wt.lastSessions':
            SessionRepository.encodeSessionCache([_mk(_serverA, 'a1', 'idle')]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _offlineFactory,
      );
      await repo.primeFromCache();
      expect(repo.current.map((s) => s.id), ['a1']);
      // A second prime with the same cache must not duplicate or re-emit stale.
      await repo.primeFromCache();
      expect(repo.current.map((s) => s.id), ['a1']);
    });

    test('empty when there is no cache', () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _offlineFactory,
      );
      await repo.primeFromCache();
      expect(repo.current, isEmpty);
    });
  });

  group('SessionRepository.refresh + cache', () {
    test('an all-offline refresh keeps the primed cache instead of blanking',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA, _serverB]),
        'wt.lastSessions': SessionRepository.encodeSessionCache([
          _mk(_serverA, 'a1', 'working', last: 1000),
          _mk(_serverB, 'b1', 'waiting', last: 2000),
        ]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _offlineFactory,
      );

      await repo.primeFromCache();
      expect(repo.current, isNotEmpty);

      await repo.refresh(); // every server returns 503 → offline

      // The cached sessions survive (seeded into the per-server buckets), and
      // every server is flagged offline for the UI's stale/offline treatment.
      expect(repo.current.map((s) => s.id), ['b1', 'a1']);
      expect(repo.serverOnline[_serverA.baseUrl], false);
      expect(repo.serverOnline[_serverB.baseUrl], false);
    });

    test('a reachable refresh persists the merged list to wt.lastSessions',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            switch (req.url.path) {
              case '/api/version':
                return http.Response(
                  jsonEncode(
                      {'serverName': 'A', 'version': '1', 'capabilities': []}),
                  200,
                );
              case '/api/sessions':
                return http.Response(
                  jsonEncode([
                    {
                      'id': 's1',
                      'name': 'one',
                      'cwd': '/x',
                      'status': 'working',
                      'lastActivity': 1000,
                      'notifyLevel': 'all',
                    }
                  ]),
                  200,
                );
              default:
                return http.Response('[]', 200);
            }
          }),
        ),
      );

      await repo.refresh();

      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('wt.lastSessions');
      expect(raw, isNotNull);
      final decoded =
          SessionRepository.decodeSessionCache(raw!, [_serverA]);
      expect(decoded.map((s) => s.id), ['s1']);
      expect(decoded.first.name, 'one');
      expect(decoded.first.notifyLevel, 'all');
    });

    // The `sessions` stream is broadcast (no replay), so a screen opened from a
    // notification tap seeds itself from `current` instead of waiting for the
    // next emission. This guards that seed source: after a reachable refresh,
    // `current` holds the session — so a late subscriber can find it at once
    // rather than flashing "session not found".
    test('current holds the session after a refresh (notification-tap seed source)',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _onlineFactory,
      );

      expect(repo.current, isEmpty); // nothing before the first fetch
      await repo.refresh();
      expect(repo.current.map((s) => s.id), ['A1']);
    });

    test('an all-offline refresh with no prior cache does NOT write the cache',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: _offlineFactory,
      );

      await repo.refresh();

      final prefs = await SharedPreferences.getInstance();
      // Nothing reachable → the cache key is never written (stays absent).
      expect(prefs.getString('wt.lastSessions'), isNull);
    });
  });
}
