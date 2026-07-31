import 'package:flutter/foundation.dart';

/// Single source of truth for "which session the wide split view is showing".
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
class SessionSelection {
  SessionSelection._();

  static final SessionSelection instance = SessionSelection._();

  /// The session the split view should show, or null for "none picked yet".
  final ValueNotifier<String?> selectedId = ValueNotifier<String?>(null);

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
    selectedId.value = null;
    splitMounted = false;
  }
}
