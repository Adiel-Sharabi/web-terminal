import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// #179 — the repository half of "your submit produced no agent activity".
///
/// The pure decision (`resolveSubmitUnconfirmedReaction`) and the banner are covered by
/// `submit_unconfirmed_test.dart`. This covers the band between them, which is where the
/// review found a real defect: the repository holds the event until a screen consumes
/// it, there is no "confirmed" frame to clear it on, and each screen keeps its own
/// "already handled" marker — so a stranded entry could replay against a later,
/// successful prompt.
///
/// Driven through `debugApplyNotify`, which feeds the SAME `_applyNotify` a live
/// `/ws/notify` subscription uses, rather than around it.
const _serverA = ServerConfig(name: 'A', baseUrl: 'http://a:7785', bearerToken: 'ta');

String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

ApiClient _offlineFactory(ServerConfig s) =>
    ApiClient(s, httpClient: MockClient((_) async => http.Response('', 503)));

Future<SessionRepository> _repo() async {
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: _encodeServers([_serverA]),
  });
  final store = ServerStore.forTest();
  await store.init();
  return SessionRepository.forTest(store: store, clientFactory: _offlineFactory);
}

NotifyEvent _unconfirmed(String id, int at) =>
    NotifyEvent.fromJson({'type': 'submitUnconfirmed', 'id': id, 'at': at});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionRepository submitUnconfirmed (#179)', () {
    test('a frame records the event for its session, and only that session', () async {
      final repo = await _repo();
      repo.debugApplyNotify(_unconfirmed('s1', 1000));

      expect(repo.submitUnconfirmedAt('s1'), 1000);
      expect(repo.submitUnconfirmedAt('s2'), isNull);
    });

    test('a NEWER frame for the same session replaces the older stamp', () async {
      // The screen compares this against the last `at` it handled, so a second failure
      // must present a different value or it reads as "already dealt with".
      final repo = await _repo();
      repo.debugApplyNotify(_unconfirmed('s1', 1000));
      repo.debugApplyNotify(_unconfirmed('s1', 2000));

      expect(repo.submitUnconfirmedAt('s1'), 2000);
    });

    test('an ordinary status frame does not touch it', () async {
      // The frame shares the socket with every status push, so the type check has to be
      // exact — otherwise an idle notification would raise the banner.
      final repo = await _repo();
      repo.debugApplyNotify(_unconfirmed('s1', 1000));
      repo.debugApplyNotify(NotifyEvent.fromJson({'type': 'idle', 'sessionId': 's1'}));

      expect(repo.submitUnconfirmedAt('s1'), 1000);
    });

    test('a frame with no `at` is still distinguishable from nothing', () async {
      // A malformed frame must not read as "no event"; the screen would then never
      // react to it at all.
      final repo = await _repo();
      repo.debugApplyNotify(NotifyEvent.fromJson({'type': 'submitUnconfirmed', 'id': 's1'}));

      expect(repo.submitUnconfirmedAt('s1'), isNotNull);
    });

    test('only the screen that CONSUMED it clears it', () async {
      // THE REASON THIS IS NOT SELF-CLEARING. A session can be open in more than one
      // window (a detached window beside the split view), both sharing this repository.
      // Clearing from the instance that is NOT the submitter would race the one that is.
      final repo = await _repo();
      repo.debugApplyNotify(_unconfirmed('s1', 1000));

      repo.clearSubmitUnconfirmed('s1');
      expect(repo.submitUnconfirmedAt('s1'), isNull);

      // ...and clearing something that was never there is a no-op, not a crash.
      repo.clearSubmitUnconfirmed('s1');
      repo.clearSubmitUnconfirmed('never-existed');
      expect(repo.submitUnconfirmedAt('s1'), isNull);
    });

    test('clearing re-emits, so a listening screen rebuilds without waiting for a poll', () async {
      final repo = await _repo();
      repo.debugApplyNotify(_unconfirmed('s1', 1000));

      final emissions = <List<Session>>[];
      final sub = repo.sessions.listen(emissions.add);
      repo.clearSubmitUnconfirmed('s1');
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();

      expect(emissions, isNotEmpty);
    });

    test('an entry for a session that has gone away is pruned', () async {
      // Nothing will ever call clearSubmitUnconfirmed for a killed session — its screen
      // is gone too — so without the prune the map only grows.
      final repo = await _repo();
      repo.debugApplyNotify(_unconfirmed('s1', 1000));
      expect(repo.submitUnconfirmedAt('s1'), 1000);

      // refresh() against an offline server yields an empty list, which prunes.
      await repo.refresh();
      expect(repo.submitUnconfirmedAt('s1'), isNull);
    });
  });
}
