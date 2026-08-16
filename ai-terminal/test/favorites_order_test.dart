// #124 — the permute rule behind a favorites drag.
//
// These mirror `commitFavReorder` in app.html one for one. That JS is the sibling
// copy: the computation needs the cross-server union of favorites and no single
// server holds it, so it cannot move server-side. If you change one, change both.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/favorites_order.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h', bearerToken: 't');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o', bearerToken: 't');

Session _fav(String id, int? rank, {ServerConfig server = _home}) => Session(
  id: id,
  name: id,
  cwd: '/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 0,
  notifyLevel: 'important',
  server: server,
  favorite: true,
  favoriteRank: rank,
);

/// The order the group would render in after [changes] are applied — i.e. what
/// the server's `(rank, id)` sort will produce.
List<String> _resultingOrder(List<Session> before, List<FavoriteRankChange> changes) {
  final ranks = <String, int>{
    for (final s in before) s.id: s.favoriteRank ?? 0,
    for (final c in changes) c.session.id: c.rank,
  };
  final ids = before.map((s) => s.id).toList()
    ..sort((a, b) {
      final byRank = ranks[a]!.compareTo(ranks[b]!);
      return byRank != 0 ? byRank : a.compareTo(b);
    });
  return ids;
}

void main() {
  group('reorderedFavoriteRanks', () {
    // Wall-clock timestamps, as server.js nextFavoriteRank actually mints them.
    final group3 = [
      _fav('a', 1786000000000),
      _fav('b', 1786000000100),
      _fav('c', 1786000000200),
    ];

    test('moving the last item to the front produces exactly that order', () {
      final changes = reorderedFavoriteRanks(group3, 2, 0);
      expect(_resultingOrder(group3, changes), ['c', 'a', 'b']);
    });

    test('moving the first item to the end produces exactly that order', () {
      final changes = reorderedFavoriteRanks(group3, 0, 2);
      expect(_resultingOrder(group3, changes), ['b', 'c', 'a']);
    });

    test('REUSES the slots the group already holds — never renumbers to 0..N-1', () {
      // The whole point: an offline peer's pins hold timestamps we cannot see, so
      // rewriting these to small indices would jump the whole group ahead of them
      // the moment that peer reconnected.
      final changes = reorderedFavoriteRanks(group3, 2, 0);
      final assigned = {for (final c in changes) c.rank};
      for (final r in assigned) {
        expect(r, greaterThanOrEqualTo(1786000000000));
      }
      final all = <int>{
        for (final s in group3) s.favoriteRank!,
      };
      expect(assigned.every(all.contains), isTrue,
          reason: 'assigned ranks must come from the slots already occupied');
    });

    test('only the sessions whose rank actually changed are returned', () {
      // c moves to the front; a and b shift up. The set is minimal — no session
      // whose rank is unchanged should be PATCHed.
      final changes = reorderedFavoriteRanks(group3, 2, 0);
      expect(changes.length, lessThanOrEqualTo(3));
      for (final c in changes) {
        final before = group3.firstWhere((s) => s.id == c.session.id).favoriteRank;
        expect(c.rank, isNot(before));
      }
    });

    test('a no-op drag returns nothing — no PATCH for a drag that moved nothing', () {
      expect(reorderedFavoriteRanks(group3, 1, 1), isEmpty);
    });

    test('an out-of-range index is refused rather than throwing', () {
      expect(reorderedFavoriteRanks(group3, 7, 0), isEmpty);
      expect(reorderedFavoriteRanks(const <Session>[], 0, 0), isEmpty);
    });

    test('legacy DUPLICATE ranks cannot tie — the drag must not look like a no-op', () {
      // Pre-timestamp builds wrote 0 for everything. Without the strictly-increasing
      // rule the (rank, id) sort would put these straight back in id order and the
      // drag would appear to do nothing.
      final legacy = [_fav('a', 0), _fav('b', 0), _fav('c', 0)];
      final changes = reorderedFavoriteRanks(legacy, 2, 0);
      expect(_resultingOrder(legacy, changes), ['c', 'a', 'b']);
    });

    test('a null rank is treated as 0, not as a crash', () {
      final withNull = [_fav('a', null), _fav('b', 5)];
      final changes = reorderedFavoriteRanks(withNull, 1, 0);
      expect(_resultingOrder(withNull, changes), ['b', 'a']);
    });

    test('each change carries its OWN server — a reorder spans the cluster', () {
      final mixed = [
        _fav('a', 10),
        _fav('b', 20, server: _office),
        _fav('c', 30),
      ];
      final changes = reorderedFavoriteRanks(mixed, 1, 0);
      final moved = changes.firstWhere((c) => c.session.id == 'b');
      expect(moved.session.server.name, 'Office',
          reason: 'the write must go to the server that OWNS the session');
    });
  });
}
