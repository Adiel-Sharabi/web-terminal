import '../api/models.dart';

/// #374 - sessions opened by other sessions, drawn as their children.
///
/// An agent that opens a helper session passes its own id, and the server
/// publishes it as `spawn.parentId` ([Session.parentId]). This is the ONE rule
/// both the session list and the dashboard draw the relationship from, so the
/// two cannot disagree about who is whose child.
///
/// Ids are UUIDs, unique across the cluster, so a parent is looked up across
/// EVERY server's sessions: a helper started on another machine still knows
/// its parent. A parent that is gone (closed, or on a server that is offline)
/// resolves to nothing, and the child is simply drawn at top level.
///
/// The links come from callers, so nothing here trusts them to form a tree: a
/// session naming itself, or a loop of sessions naming each other, is drawn
/// flat rather than lost or recursed into forever.
class SessionTree {
  SessionTree(Iterable<Session> all) {
    for (final s in all) {
      _byId[s.id] = s;
    }
    for (final s in _byId.values) {
      final p = parentOf(s);
      if (p != null) _children.putIfAbsent(p.id, () => <Session>[]).add(s);
    }
  }

  final Map<String, Session> _byId = <String, Session>{};
  final Map<String, List<Session>> _children = <String, List<Session>>{};

  /// The session that opened [s], when it is known and still listed.
  Session? parentOf(Session s) {
    final id = s.parentId;
    if (id == null || id == s.id) return null;
    return _byId[id];
  }

  /// The sessions [s] opened that are still listed, in list order.
  List<Session> childrenOf(Session s) => _children[s.id] ?? const <Session>[];

  /// [list] reordered so every session follows its parent, when that parent is
  /// in [list] too, with its depth under it. Everything else keeps its place in
  /// [list]: roots stay in their given order (the server's drag order, a
  /// column's favourites-first order), and so do siblings.
  ///
  /// A session whose parent is listed elsewhere (another server's group,
  /// another column) is a root HERE, at depth 0 - indenting it under an
  /// unrelated row would claim a parent it does not have. Every session in
  /// [list] appears exactly once, loops included.
  List<SessionTreeRow> flatten(List<Session> list) {
    final here = <String>{for (final s in list) s.id};
    final kids = <String, List<Session>>{};
    final roots = <Session>[];
    for (final s in list) {
      final p = parentOf(s);
      if (p != null && here.contains(p.id)) {
        kids.putIfAbsent(p.id, () => <Session>[]).add(s);
      } else {
        roots.add(s);
      }
    }
    final out = <SessionTreeRow>[];
    final placed = <String>{};
    void walk(Session s, int depth) {
      if (!placed.add(s.id)) return;
      out.add(SessionTreeRow(s, depth));
      for (final c in kids[s.id] ?? const <Session>[]) {
        walk(c, depth + 1);
      }
    }

    for (final r in roots) {
      walk(r, 0);
    }
    // Sessions in a loop have no root to hang from: draw them flat, in order.
    for (final s in list) {
      walk(s, 0);
    }
    return out;
  }
}

/// One row of [SessionTree.flatten]: the session and how deep it sits under
/// sessions shown directly above it (0 = top level).
class SessionTreeRow {
  const SessionTreeRow(this.session, this.depth);

  final Session session;
  final int depth;

  /// How far to indent the row: deep chains stop indenting so a phone-width
  /// row keeps room for its title.
  static const double step = 20;
  static const int maxIndentLevels = 3;
  double get indent => step * (depth > maxIndentLevels ? maxIndentLevels : depth);
}
