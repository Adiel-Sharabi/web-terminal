import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Issue #22: the app must honor the server-persisted session order (drag order)
// and push a reorder to the server. serverOrderIndex reads the last-received
// order; reorderServerSessions POSTs the new order and applies it optimistically.

const _serverA =
    ServerConfig(name: 'A', baseUrl: 'http://a:7785', bearerToken: 'ta');

String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

Map<String, dynamic> _sess(String id) => {
      'id': id,
      'name': 'name-$id',
      'cwd': '/w/$id',
      'status': 'working',
      'claudeSessionId': null,
      'lastActivity': 1000,
      'notifyLevel': 'important',
      'autoCommand': '',
    };

Future<ServerStore> _store() async {
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionRepository reorder (#22)', () {
    late List<String> serverOrder; // what /api/sessions returns, in order
    List<String>? sentOrder; // captured POST /api/sessions/order body

    ApiClient factory(ServerConfig s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            final path = req.url.path;
            if (path == '/api/version') {
              return http.Response(
                jsonEncode({'version': '1', 'serverName': 'A', 'capabilities': []}),
                200,
                headers: {'content-type': 'application/json'},
              );
            }
            if (path == '/api/sessions' && req.method == 'GET') {
              return http.Response(
                jsonEncode([for (final id in serverOrder) _sess(id)]),
                200,
                headers: {'content-type': 'application/json'},
              );
            }
            if (path == '/api/sessions/order' && req.method == 'POST') {
              sentOrder =
                  (jsonDecode(req.body)['orderedIds'] as List).cast<String>();
              return http.Response('{"ok":true}', 200,
                  headers: {'content-type': 'application/json'});
            }
            return http.Response('', 404);
          }),
        );

    setUp(() {
      serverOrder = ['s1', 's2', 's3'];
      sentOrder = null;
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
    });

    test('serverOrderIndex reflects the received order after refresh', () async {
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: factory,
      );
      await repo.refresh();
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's1'), 0);
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's2'), 1);
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's3'), 2);
      // Unknown id sorts last.
      expect(repo.serverOrderIndex(_serverA.baseUrl, 'nope'),
          greaterThan(1000000));
    });

    test('reorderServerSessions POSTs the new order and applies it optimistically',
        () async {
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: factory,
      );
      await repo.refresh();

      await repo.reorderServerSessions(_serverA, ['s3', 's1', 's2']);

      // Persisted to the server.
      expect(sentOrder, ['s3', 's1', 's2']);
      // Applied locally without waiting for a refresh.
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's3'), 0);
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's1'), 1);
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's2'), 2);
    });

    test('ids omitted from the new order keep their prior position at the end',
        () async {
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: factory,
      );
      await repo.refresh();

      // Only reorder s2 and s3; s1 is not mentioned → appended after them.
      await repo.reorderServerSessions(_serverA, ['s3', 's2']);

      expect(repo.serverOrderIndex(_serverA.baseUrl, 's3'), 0);
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's2'), 1);
      expect(repo.serverOrderIndex(_serverA.baseUrl, 's1'), 2);
    });
  });
}
