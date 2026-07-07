import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Issue #24: dismissing/opening a session clears its attention everywhere.
// dismissAttention hides the chip locally at once and POSTs the clear; a bare
// status poll must not resurrect a dismissed chip, but a genuine new alert must.

const _serverA =
    ServerConfig(name: 'A', baseUrl: 'http://a:7785', bearerToken: 'ta');

Session _mk(String id, String status) => Session(
      id: id,
      name: 'n-$id',
      cwd: '/w/$id',
      status: status,
      claudeSessionId: null,
      lastActivity: 1,
      notifyLevel: 'important',
      server: _serverA,
      autoCommand: '',
    );

NotifyEvent _evt({
  String type = 'status',
  String status = '',
  String message = '',
  String sessionId = 's1',
  bool apiError = false,
  bool cleared = false,
}) =>
    NotifyEvent(
      type: type,
      message: message,
      sessionId: sessionId,
      status: status,
      apiError: apiError,
      cleared: cleared,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('dismissAttention (#24)', () {
    test('hides the chip locally and POSTs the clear to the session server',
        () async {
      String? clearedPath;
      ApiClient factory(ServerConfig s) => ApiClient(
            s,
            httpClient: MockClient((req) async {
              if (req.url.path.endsWith('/attention/clear') &&
                  req.method == 'POST') {
                clearedPath = req.url.path;
                return http.Response('{"ok":true}', 200,
                    headers: {'content-type': 'application/json'});
              }
              return http.Response('', 404);
            }),
          );
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          {'name': 'A', 'baseUrl': _serverA.baseUrl, 'bearerToken': 'ta'},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      final repo =
          SessionRepository.forTest(store: store, clientFactory: factory);

      expect(repo.isAttentionDismissed('s1'), isFalse);
      await repo.dismissAttention(_mk('s1', 'waiting'));

      expect(repo.isAttentionDismissed('s1'), isTrue);
      expect(clearedPath, '/api/sessions/s1/attention/clear');
    });
  });

  group('isFreshAlert re-arm predicate (#24)', () {
    test('a genuine approval/api-error alert (with a message) re-arms', () {
      expect(
        SessionRepository.isFreshAlert(
            _evt(status: 'waiting', message: 'needs approval')),
        isTrue,
      );
      expect(
        SessionRepository.isFreshAlert(_evt(apiError: true, message: 'boom')),
        isTrue,
      );
    });

    test('a bare status poll (no message) does NOT re-arm — no resurrect', () {
      expect(SessionRepository.isFreshAlert(_evt(status: 'waiting')), isFalse);
      expect(
        SessionRepository.isFreshAlert(_evt(status: 'working', message: 'x')),
        isFalse,
      );
      expect(SessionRepository.isFreshAlert(_evt(type: 'clear', cleared: true)),
          isFalse);
    });
  });
}
