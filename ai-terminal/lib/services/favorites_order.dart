/// The permute rule for reordering the pinned favorites (#124).
///
/// **This is the SECOND copy of this rule.** The first is `commitFavReorder` in
/// `app.html` (search `Favorites: drag / long-press reorder`). That duplication is
/// structural rather than sloppy: the computation needs the CROSS-SERVER union of
/// favorites, and no single server holds it — a peer knows only its own pins — so it
/// cannot move server-side. Change one and you must change the other; the tests here
/// mirror the JS cases one for one.
library;

import '../api/models.dart';

/// One favorite whose rank changed, and the rank to PATCH to its owning server.
class FavoriteRankChange {
  const FavoriteRankChange(this.session, this.rank);

  /// The session to write. Carries its own [Session.server], which is how a
  /// cross-server reorder knows where each write goes.
  final Session session;

  /// Its new `favoriteRank`.
  final int rank;

  @override
  String toString() => 'FavoriteRankChange(${session.id} -> $rank)';
}

/// Moves the favorite at [oldIndex] to [newIndex] within [ordered] — the pinned
/// group exactly as displayed, i.e. already in `Session.pinnedOrder` — and returns
/// ONLY the entries whose rank changed.
///
/// [newIndex] is the FINAL index the item should occupy — `onReorderItem`
/// semantics, which already adjust for the removed item, matching the per-server
/// reorder next door (`dashboard_screen.dart`). The older `onReorder` reports the
/// index *before* removal and would need a `newIndex--` on a downward move; this
/// takes the adjusted one so neither caller has to remember which is which.
///
/// **Ranks are PERMUTED, never renumbered to `0..N-1`.** A rank is a wall-clock
/// timestamp (`server.js` `nextFavoriteRank`), and an offline peer's pins hold
/// timestamps this device cannot see — #66 drops an unreachable server's favorites
/// from the view entirely, so this list is always a PARTIAL union. Rewriting the
/// visible rows to small indices would silently move every one of them ahead of that
/// peer's pins the moment it reconnected. Reusing the rank VALUES the group already
/// occupies keeps it in exactly the same slots of the global order, and only changes
/// which session sits in which slot — which is precisely what a reorder means.
List<FavoriteRankChange> reorderedFavoriteRanks(
  List<Session> ordered,
  int oldIndex,
  int newIndex,
) {
  if (oldIndex < 0 || oldIndex >= ordered.length) return const <FavoriteRankChange>[];

  var to = newIndex;
  if (to < 0) to = 0;
  if (to > ordered.length - 1) to = ordered.length - 1;
  if (to == oldIndex) return const <FavoriteRankChange>[];

  final moved = List<Session>.of(ordered);
  moved.insert(to, moved.removeAt(oldIndex));

  // The slots this group already occupies, low to high.
  final slots = <int>[for (final s in ordered) s.favoriteRank ?? 0]..sort();
  final before = <String, int?>{for (final s in ordered) s.id: s.favoriteRank};

  final changes = <FavoriteRankChange>[];
  var previous = 0;
  for (var i = 0; i < moved.length; i++) {
    // Strictly increasing, so the server-side `(rank, id)` sort can reproduce ONLY
    // this order. Without the max, a legacy duplicate rank (`0,0` from a
    // pre-timestamp build) would tie and the drag would look like it did nothing.
    final rank = i == 0
        ? slots[0]
        : (slots[i] > previous ? slots[i] : previous + 1);
    previous = rank;
    if (before[moved[i].id] != rank) {
      changes.add(FavoriteRankChange(moved[i], rank));
    }
  }
  return changes;
}
