// Unit tests for FavoritesService.migrateOnce — the #60 one-shot migration
// of the OLD per-device favorites list up to the server that owns each
// session. FavoritesService itself holds no state and is no longer a source
// of truth; these tests exercise the migration logic directly, mocking the
// network via an injected ApiClient factory (mirrors SessionRepository's own
// ApiClientFactory seam).
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/favorites_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

Session _session(
  String id, {
  bool favorite = false,
  int? favoriteRank,
  ServerConfig server = _server,
}) => Session(
  id: id,
  name: 'n-$id',
  cwd: '/w/$id',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 1,
  notifyLevel: 'important',
  server: server,
  autoCommand: '',
  favorite: favorite,
  favoriteRank: favoriteRank,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('FavoritesService.migrateOnce', () {
    test('no-op and returns false when there was never a local list', () async {
      SharedPreferences.setMockInitialValues({});
      final migrated = await FavoritesService.migrateOnce(
        [_session('a')],
        supportsFavorites: (_) => true,
        clientFactory: (s) => ApiClient(
          s,
          httpClient:
              MockClient((_) async => throw StateError('must not be called')),
        ),
      );
      expect(migrated, isFalse);
    });

    test('PATCHes each resolvable id to its owning server, then clears the key',
        () async {
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['a', 'b']),
      });
      final patched = <String, Map<String, dynamic>>{};
      ApiClient factory(ServerConfig s) => ApiClient(
            s,
            httpClient: MockClient((req) async {
              if (req.method == 'PATCH') {
                patched[req.url.pathSegments[2]] =
                    jsonDecode(req.body) as Map<String, dynamic>;
                return http.Response('{"ok":true}', 200);
              }
              return http.Response('', 404);
            }),
          );

      final migrated = await FavoritesService.migrateOnce(
        [_session('a'), _session('b')],
        supportsFavorites: (_) => true,
        clientFactory: factory,
      );

      expect(migrated, isTrue);
      expect(patched.keys, containsAll(['a', 'b']));
      // Ranks are wall-clock timestamps assigned by the client during
      // migration (see class doc) — one per id, strictly increasing in the
      // local list's order — rather than any fixed literal.
      expect(patched['a']!['favorite'], isTrue);
      expect(patched['b']!['favorite'], isTrue);
      final rankA = patched['a']!['rank'] as int;
      final rankB = patched['b']!['rank'] as int;
      expect(rankB, rankA + 1);

      // Permanently cleared — a second call is a no-op even with the same
      // (now stale) session list.
      expect(
        (await SharedPreferences.getInstance())
            .getString(FavoritesService.storageKey),
        isNull,
      );
      final second = await FavoritesService.migrateOnce(
        [_session('a'), _session('b')],
        supportsFavorites: (_) => true,
        clientFactory: (s) => ApiClient(
          s,
          httpClient:
              MockClient((_) async => throw StateError('must not be called')),
        ),
      );
      expect(second, isFalse);
    });

    test('never PATCHes a session whose server lacks favorites-sync', () async {
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['a']),
      });
      var called = false;
      final migrated = await FavoritesService.migrateOnce(
        [_session('a')],
        supportsFavorites: (_) => false, // old server — no route
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((_) async {
            called = true;
            return http.Response('{"ok":true}', 200);
          }),
        ),
      );
      expect(migrated, isFalse);
      expect(called, isFalse);
    });

    test('skips an id the server already holds as a favorite', () async {
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['a']),
      });
      var called = false;
      final migrated = await FavoritesService.migrateOnce(
        [_session('a', favorite: true, favoriteRank: 3)],
        supportsFavorites: (_) => true,
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((_) async {
            called = true;
            return http.Response('{"ok":true}', 200);
          }),
        ),
      );
      expect(migrated, isFalse);
      expect(called, isFalse);
    });

    test('an id whose session cannot currently be resolved is simply dropped',
        () async {
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['gone', 'a']),
      });
      final patched = <String>[];
      final migrated = await FavoritesService.migrateOnce(
        [_session('a')], // 'gone' isn't in the current session list
        supportsFavorites: (_) => true,
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            patched.add(req.url.pathSegments[2]);
            return http.Response('{"ok":true}', 200);
          }),
        ),
      );
      expect(migrated, isTrue);
      expect(patched, ['a']);
      // The key is still cleared, even though 'gone' was never migrated —
      // it cannot resurrect a pin removed elsewhere (see class doc).
      expect(
        (await SharedPreferences.getInstance())
            .getString(FavoritesService.storageKey),
        isNull,
      );
    });

    test('a per-id PATCH failure is swallowed; the key is still cleared',
        () async {
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['a']),
      });
      final migrated = await FavoritesService.migrateOnce(
        [_session('a')],
        supportsFavorites: (_) => true,
        clientFactory: (s) =>
            ApiClient(s, httpClient: MockClient((_) async => http.Response('', 503))),
      );
      expect(migrated, isFalse);
      expect(
        (await SharedPreferences.getInstance())
            .getString(FavoritesService.storageKey),
        isNull,
      );
    });

    test('assigns a wall-clock rank — independent of any existing favoriteRank',
        () async {
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['b']),
      });
      final patched = <String, Map<String, dynamic>>{};
      final before = DateTime.now().millisecondsSinceEpoch;
      final migrated = await FavoritesService.migrateOnce(
        [
          // An existing favorite with a small rank must NOT influence the
          // migrated id's rank (that was the OLD, now-wrong index scheme).
          _session('a', favorite: true, favoriteRank: 5),
          _session('b'),
        ],
        supportsFavorites: (_) => true,
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            patched[req.url.pathSegments[2]] =
                jsonDecode(req.body) as Map<String, dynamic>;
            return http.Response('{"ok":true}', 200);
          }),
        ),
      );
      final after = DateTime.now().millisecondsSinceEpoch;
      expect(migrated, isTrue);
      expect(patched['b']!['favorite'], isTrue);
      final rank = patched['b']!['rank'] as int;
      expect(rank, greaterThanOrEqualTo(before));
      expect(rank, lessThanOrEqualTo(after));
    });

    test('never sends an explicit rank equal to another session\'s existing '
        'favoriteRank by construction (wall clock, not index-based)', () async {
      // Regression guard for the old (wrong) max+1 scheme: 'a' already holds
      // rank 0, so an index-based "next" rank for 'b' would ALSO be a small
      // integer that could collide cross-server. A wall-clock rank never is.
      SharedPreferences.setMockInitialValues({
        FavoritesService.storageKey: jsonEncode(['b']),
      });
      int? sentRank;
      final migrated = await FavoritesService.migrateOnce(
        [_session('a', favorite: true, favoriteRank: 0), _session('b')],
        supportsFavorites: (_) => true,
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async {
            sentRank = (jsonDecode(req.body) as Map)['rank'] as int;
            return http.Response('{"ok":true}', 200);
          }),
        ),
      );
      expect(migrated, isTrue);
      expect(sentRank, greaterThan(1000000000000)); // a real wall-clock ms value
    });
  });
}
