// A server that misses ONE poll is not an outage, and a slow server must not
// hold the whole list hostage. Both halves were reported as one complaint.
//
// Reported 2026-09-22: a peer's "<name> is unreachable" banner appearing and
// clearing repeatedly, and "marking favorites makes everything slow". The
// banner was not lying about that round - `GET /api/sessions` really did take
// 10-25s on that peer, because it is the only session route that goes through
// the worker RPC and the worker's event loop stalls for seconds at a time.
// What was wrong is what the client DID with a single such round.
//
// Do not read these specs as "the server was fine". The server fault is real
// and is tracked separately; it is also cluster-wide rather than one sick
// machine, which is precisely why the client has to survive it.
//
// Two defects, one shape - a per-round failure treated as a verdict:
//
//  1. `_serverOnline` flipping false on the FIRST failure is correct; it is
//     the truth of the last round, and the stale-session fallback and
//     `_anyServerReachable` both depend on it staying unsmoothed. What was
//     wrong is that the UI reported it verbatim, so one slow poll painted
//     "unreachable" and the next cleared it - and because #66 gates pinned
//     rows on the same flag, that server's favorites vanished with it.
//  2. `refresh` awaited `Future.wait` over every server, so the SLOWEST one
//     gated the merged list - and a favorite toggle triggers a refresh, which
//     is why a UI action felt as slow as the worst server configured.
//
// These pin the split in BOTH directions. A test that only asserted "two
// failures -> offline" would still pass with the smoothing deleted and every
// failure reported at once, so the one-failure case is the load-bearing one.
import 'dart:async';
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
    ServerConfig(name: 'Office', baseUrl: 'http://a:7785', bearerToken: 'ta');
const _fast =
    ServerConfig(name: 'Fast', baseUrl: 'http://fast:7785', bearerToken: 'tf');
const _slow =
    ServerConfig(name: 'Slow', baseUrl: 'http://slow:7785', bearerToken: 'ts');

String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

String _oneSession(ServerConfig s) => jsonEncode([
      {
        'id': '${s.name}1',
        'name': 'proj',
        'status': 'idle',
        'lastActivity': 1000,
      },
    ]);

Future<ServerStore> _store() async {
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

/// A repo over [_serverA] whose `/api/sessions` status is read from [status]
/// at call time, so a test can flip it between rounds.
SessionRepository _repoWithStatus(ServerStore store, int Function() status) =>
    SessionRepository.forTest(
      store: store,
      clientFactory: (s) => ApiClient(
        s,
        httpClient: MockClient((req) async {
          if (req.url.path == '/api/sessions') {
            final code = status();
            return http.Response(code == 200 ? _oneSession(s) : '', code);
          }
          return http.Response('', 503);
        }),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionRepository.serverOfflineConfirmed (offline hysteresis)', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_serverA]),
      });
    });

    test('ONE failed round does not report the server offline', () async {
      // The load-bearing case: delete the smoothing and this goes red, because
      // a single missed poll is reported as an outage — which is the flap.
      final repo = _repoWithStatus(await _store(), () => 503);
      await repo.refresh();
      expect(repo.serverOfflineConfirmed[_serverA.baseUrl], isNot(isTrue));
    });

    test('the RAW per-round state still flips on the first failure', () async {
      // The opposite guard: smoothing `_serverOnline` itself would strand the
      // stale-session fallback and `_anyServerReachable` on a lie.
      final repo = _repoWithStatus(await _store(), () => 503);
      await repo.refresh();
      expect(repo.serverOnline[_serverA.baseUrl], isFalse);
    });

    test('two consecutive failed rounds do report it offline', () async {
      final repo = _repoWithStatus(await _store(), () => 503);
      await repo.refresh();
      await repo.refresh();
      expect(repo.serverOfflineConfirmed[_serverA.baseUrl], isTrue);
    });

    test('serverUsable is FALSE for a 401, which no amount of hysteresis '
        'would ever report', () async {
      // The gate both the dashboard and `canToggleFavorite` read. A 401 server
      // is REACHABLE - it answered - so it fails the round without being an
      // outage, and smoothing alone would call it usable forever while every
      // PATCH behind its star failed.
      //
      // Load-bearing in the sense that matters: drop the `_serverNeedsAuth`
      // half of `serverUsable` and this is the only assertion that goes red,
      // because ONE 401 round never reaches the failure streak at all.
      final repo = _repoWithStatus(await _store(), () => 401);
      await repo.refresh();
      expect(repo.serverNeedsAuth[_serverA.baseUrl], isTrue);
      expect(repo.serverOfflineConfirmed[_serverA.baseUrl], isNot(isTrue),
          reason: 'one round can never be a confirmed outage');
      expect(repo.serverUsable[_serverA.baseUrl], isFalse,
          reason: 'a refused server is reachable AND unusable');
    });

    test('serverUsable is FALSE once a server is CONFIRMED offline', () async {
      final repo = _repoWithStatus(await _store(), () => 503);
      await repo.refresh();
      expect(repo.serverUsable[_serverA.baseUrl], isTrue,
          reason: 'one missed poll is not yet an outage');
      await repo.refresh();
      expect(repo.serverUsable[_serverA.baseUrl], isFalse);
    });

    test('serverUsable omits a server nobody has failed to reach', () async {
      // A missing key reads as usable at every call site, so a server on its
      // very first paint keeps its star rather than flickering it in.
      final repo = _repoWithStatus(await _store(), () => 200);
      await repo.refresh();
      expect(repo.serverUsable[_serverA.baseUrl], isTrue);
    });

    test('a success between failures resets the streak', () async {
      // Without the reset the streak only ever climbs, so a server that blips
      // once an hour is eventually reported permanently down.
      var code = 503;
      final repo = _repoWithStatus(await _store(), () => code);
      await repo.refresh();
      code = 200;
      await repo.refresh();
      code = 503;
      await repo.refresh();
      expect(repo.serverOfflineConfirmed[_serverA.baseUrl], isNot(isTrue));
    });

    test('a recovered server is no longer reported offline', () async {
      var code = 503;
      final repo = _repoWithStatus(await _store(), () => code);
      await repo.refresh();
      await repo.refresh();
      expect(repo.serverOfflineConfirmed[_serverA.baseUrl], isTrue);
      code = 200;
      await repo.refresh();
      expect(repo.serverOfflineConfirmed[_serverA.baseUrl], isFalse);
    });
  });

  group('SessionRepository.refresh partial emit', () {
    test('a slow server does not gate what the others already returned',
        () async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: _encodeServers([_fast, _slow]),
      });
      // Gates only `/api/sessions` for the slow server: `_ensureServerNames`
      // runs BEFORE the fan-out, so gating `/api/version` too would block the
      // round before it started and the test would prove nothing.
      final gate = Completer<void>();
      final repo = SessionRepository.forTest(
        store: await _store(),
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            if (req.url.path == '/api/sessions') {
              if (s.baseUrl == _slow.baseUrl) await gate.future;
              return http.Response(_oneSession(s), 200);
            }
            return http.Response('', 503);
          }),
        ),
      );

      // Subscribe BEFORE refreshing: the emission under test is the partial
      // one, which is gone by the time `refresh` returns.
      final firstPaint = repo.sessions.first;
      final round = repo.refresh();

      final painted = await firstPaint.timeout(const Duration(seconds: 5));
      expect(painted.map((s) => s.id), contains('Fast1'));
      expect(
        gate.isCompleted,
        isFalse,
        reason: 'the list must paint while the slow server is still in flight',
      );

      gate.complete();
      await round;
      expect(repo.current.map((s) => s.id), containsAll(['Fast1', 'Slow1']));
    });
  });
}
