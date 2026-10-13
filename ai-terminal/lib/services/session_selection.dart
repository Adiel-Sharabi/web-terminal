import 'package:flutter/foundation.dart';

/// What the detail pane of the wide split shows: nothing yet, one session, or the
/// sessions dashboard (#337).
///
/// ONE value rather than a session id plus a "board is open" flag: two fields
/// would let the pane be asked to show a session AND the board at once, and every
/// reader would have to pick a winner. Here showing the board and showing a
/// session replace each other by construction.
@immutable
class DetailPane {
  const DetailPane._(this.sessionId, this.isBoard);

  /// Nothing picked yet: the "Pick a session" placeholder.
  static const DetailPane empty = DetailPane._(null, false);

  /// The sessions dashboard, beside the list (#337).
  static const DetailPane board = DetailPane._(null, true);

  /// One session, by id.
  const DetailPane.session(String id) : this._(id, false);

  /// The session shown, or null when the pane shows the board or nothing.
  final String? sessionId;
  final bool isBoard;

  @override
  bool operator ==(Object other) =>
      other is DetailPane && other.sessionId == sessionId && other.isBoard == isBoard;

  @override
  int get hashCode => Object.hash(sessionId, isBoard);

  @override
  String toString() => isBoard ? 'DetailPane.board' : 'DetailPane(${sessionId ?? 'empty'})';
}

/// Single source of truth for "what the wide split view's detail pane shows".
///
/// Two things open a session and they used to be unrelated mechanisms (#76):
///
///  * the session list, in wide mode, opened one by setting local state inside
///    `AdaptiveHome` — no routing at all;
///  * a notification tap opened one from `main.dart`, which has no
///    `BuildContext`, by pushing a route on the global navigator.
///
/// Only the second knew about notifications and only the first knew about the
/// split, so a notification tap on desktop pushed a full-screen `SessionScreen`
/// **on top of** the master-detail layout the user was already in — list rail
/// gone, Back required. Rather than teach the routing path a second way to
/// reach `AdaptiveHome`'s private state, both paths now agree on one answer to
/// "which session is showing", which is what this holds.
///
/// The selection is an **id**, not a `Session`: a notification carries only an
/// id, exactly as the pushed route always has, and `SessionScreen` has always
/// accepted an id alone. Anything richer would be a second source of truth for
/// the same fact.
///
/// #337 adds the dashboard as a third thing the pane can show, so the value is a
/// [DetailPane] rather than a bare id; see there for why it is one value.
class SessionSelection {
  SessionSelection._();

  static final SessionSelection instance = SessionSelection._();

  /// What the split view's detail pane shows.
  final ValueNotifier<DetailPane> pane = ValueNotifier<DetailPane>(DetailPane.empty);

  /// The session the split view shows, or null for none (nothing picked, or the
  /// dashboard is showing).
  String? get selectedId => pane.value.sessionId;

  /// Whether the split view's detail pane shows the dashboard (#337).
  bool get boardShown => pane.value.isBoard;

  /// Shows session [id] in the pane, replacing whatever was there (the board too).
  void select(String id) => pane.value = DetailPane.session(id);

  /// Shows the dashboard in the pane. Already showing it: a no-op, exactly as
  /// selecting the session that is already showing is.
  void showBoard() => pane.value = DetailPane.board;

  /// Back to the "Pick a session" placeholder.
  void clear() => pane.value = DetailPane.empty;

  /// True while a **wide** `AdaptiveHome` is mounted — i.e. while selecting is
  /// a real alternative to pushing a route.
  ///
  /// Narrow windows leave this false, so the notification path keeps exactly
  /// the push behaviour #45 specified and verified (one screen above the list,
  /// one Back to return). Read by `main.dart`; written by `AdaptiveHome` as it
  /// crosses the breakpoint. Deliberately a plain field and not a notifier —
  /// it is written during build, and anything that rebuilt in response would
  /// loop.
  bool splitMounted = false;

  /// Test seam: widget tests share a process, and a static singleton would
  /// otherwise leak one test's selection into the next.
  @visibleForTesting
  void reset() {
    pane.value = DetailPane.empty;
    splitMounted = false;
  }
}
