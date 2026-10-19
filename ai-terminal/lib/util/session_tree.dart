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
/// its parent. A parent handed off to a fresh session is found under its new
/// id too, through [Session.replaces]. A parent that is gone (closed, or on a
/// server that is offline) resolves to nothing, and the child is simply drawn
/// at top level.
///
/// The links come from callers, so nothing here trusts them to form a tree: a
/// session naming itself, or a loop of sessions naming each other, is still
/// drawn exactly once, never lost or recursed into forever.
class SessionTree {
  SessionTree(Iterable<Session> all) {
    final list = all.toList(growable: false);
    for (final s in list) {
      _byId.putIfAbsent(s.id, () => s);
    }
    // A replaced id names its successor - unless a live session still has it.
    for (final s in list) {
      for (final old in s.replaces) {
        _byId.putIfAbsent(old, () => s);
      }
    }
    for (final s in list) {
      final p = parentOf(s);
      if (p != null) _children.putIfAbsent(p, () => <Session>[]).add(s);
    }
  }

  final Map<String, Session> _byId = <String, Session>{};
  final Map<Session, List<Session>> _children = Map<Session, List<Session>>.identity();

  /// The session that opened [s], when it is known and still listed.
  Session? parentOf(Session s) {
    final id = s.parentId;
    if (id == null) return null;
    final p = _byId[id];
    return identical(p, s) ? null : p;
  }

  /// The sessions [s] opened that are still listed, in list order.
  List<Session> childrenOf(Session s) => _children[s] ?? const <Session>[];

  /// [list] reordered so every session follows its parent, when that parent is
  /// in [list] too, with its depth under it. Everything else keeps its place in
  /// [list]: roots stay in their given order (the server's drag order, a
  /// column's favourites-first order), and so do siblings.
  ///
  /// A session whose parent is listed elsewhere (another server's group,
  /// another column) is a root HERE, at depth 0 - indenting it under an
  /// unrelated row would claim a parent it does not have. Every session in
  /// [list] appears exactly once, loops included. Rows are matched by
  /// identity, not id, so two server entries reaching the same box (a LAN and
  /// a tailnet URL) still show both of their rows.
  ///
  /// #377 - a session whose id is in [folded] keeps its whole subtree out of
  /// the result: they ride on its row as [SessionTreeRow.folded], so a caller
  /// can still show their status and still write every id when it saves an
  /// order. A session handed off to a successor stays folded under the new id
  /// ([foldIds] is what a caller must clear to unfold it).
  List<SessionTreeRow> flatten(
    List<Session> list, {
    Set<String> folded = const <String>{},
  }) {
    final here = Set<Session>.identity()..addAll(list);
    final kids = Map<Session, List<Session>>.identity();
    final roots = <Session>[];
    for (final s in list) {
      final p = parentOf(s);
      if (p != null && here.contains(p)) {
        kids.putIfAbsent(p, () => <Session>[]).add(s);
      } else {
        roots.add(s);
      }
    }
    final out = <SessionTreeRow>[];
    final placed = Set<Session>.identity();
    bool isFolded(Session s) => foldIds(s).any(folded.contains);
    void hide(Session s, List<Session> into) {
      if (!placed.add(s)) return;
      into.add(s);
      for (final c in kids[s] ?? const <Session>[]) {
        hide(c, into);
      }
    }

    void walk(Session s, int depth) {
      if (!placed.add(s)) return;
      final at = out.length;
      out.add(SessionTreeRow(s, depth));
      if (isFolded(s)) {
        final hidden = <Session>[];
        for (final c in kids[s] ?? const <Session>[]) {
          hide(c, hidden);
        }
        out[at] = SessionTreeRow(s, depth, descendants: hidden.length, folded: hidden);
        return;
      }
      for (final c in kids[s] ?? const <Session>[]) {
        walk(c, depth + 1);
      }
      // Everything under it: the rows shown below it, and what those fold.
      var under = 0;
      for (var i = at + 1; i < out.length; i++) {
        under += 1 + out[i].folded.length;
      }
      out[at] = SessionTreeRow(s, depth, descendants: under);
    }

    for (final r in roots) {
      walk(r, 0);
    }
    // A loop has no root to hang from: the first of it in [list] becomes one.
    for (final s in list) {
      walk(s, 0);
    }
    return out;
  }

  /// The ids under which [s] counts as folded (#377): its own, and every id it
  /// replaced in a hand-off. Folding stores its own id; unfolding must clear
  /// them all, or a fold made before a hand-off could never be undone.
  static List<String> foldIds(Session s) => [s.id, ...s.replaces];
}

/// One row of [SessionTree.flatten]: the session and how deep it sits under
/// sessions shown directly above it (0 = top level).
class SessionTreeRow {
  const SessionTreeRow(
    this.session,
    this.depth, {
    this.descendants = 0,
    this.folded = const <Session>[],
  });

  final Session session;
  final int depth;

  /// How many sessions hang under this one in the list it was flattened from,
  /// at any depth, whether shown below it or folded into it or into a row
  /// below it - so folding never changes the number.
  final int descendants;

  /// The sessions under this one that the caller folded away (#377), in the
  /// order they would have been shown. Empty when the row is expanded.
  final List<Session> folded;
  bool get isFolded => folded.isNotEmpty;

  /// How far to indent the row: deep chains stop indenting so a phone-width
  /// row keeps room for its title.
  static const double step = 20;
  static const int maxIndentLevels = 3;
  double get indent => step * (depth > maxIndentLevels ? maxIndentLevels : depth);

  /// The narrowest row the session list's card fits in with every chip it can
  /// show (status or reason, context %, recap, bell, star, time). Measured: a
  /// reason-chip card overflows at 340dp, and the status word is squeezed to an
  /// ellipsis well before that.
  static const double minCardRow = 400;

  /// [indent], but never so much that the row is left narrower than
  /// [minCardRow]: an indent is a hint, the card's contents are the content. On
  /// a phone that means little or no indent - the caller marks the row some
  /// other way (the session list puts an arrow in the gutter).
  double indentWithin(double rowWidth) {
    final spare = rowWidth - minCardRow;
    if (spare <= 0) return 0;
    return indent < spare ? indent : spare;
  }
}
