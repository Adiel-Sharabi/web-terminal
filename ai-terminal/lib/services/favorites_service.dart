/// Local, per-device store of favorited session ids.
///
/// Pure local storage — **no network**. Mirrors the web terminal, which keeps
/// favorites in `localStorage['wt.favorites']` as an *ordered* JSON array of
/// session-id strings; this service persists the identical shape under the same
/// key via [SharedPreferences]. The stored order **is** the display order (the
/// UI renders favorites top-to-bottom in this order and rewrites it on drag).
///
/// Favorites are keyed by session id (a globally-unique UUID), so a favorite is
/// stable regardless of which cluster server the session lives on.
///
/// Consume it as: seed the UI with [current] and rebuild on [favorites]. The
/// production [instance] auto-loads on first use and re-emits its current value
/// to every new listener, so a late subscriber never misses the loaded list.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Singleton store of the ordered favorite session-id list.
class FavoritesService {
  /// The [SharedPreferences] key holding the ordered JSON array of ids. Matches
  /// the web terminal's `localStorage` key so the concept stays 1:1.
  static const String storageKey = 'wt.favorites';

  FavoritesService._() {
    // The production singleton loads eagerly so [current] is populated as soon
    // as possible; listeners still get the loaded list via the onListen replay.
    unawaited(init());
  }

  /// The shared instance (auto-loads persisted favorites on construction).
  static final FavoritesService instance = FavoritesService._();

  /// Creates an isolated, non-auto-loading instance for tests. Call [init]
  /// yourself after `SharedPreferences.setMockInitialValues(...)`.
  @visibleForTesting
  FavoritesService.forTest();

  late final StreamController<List<String>> _controller =
      StreamController<List<String>>.broadcast(
    onListen: () => scheduleMicrotask(_emit),
  );

  List<String> _ids = <String>[];
  SharedPreferences? _prefs;

  /// Broadcast stream of the ordered favorite ids. Emits on every change and
  /// replays the current value to each new listener.
  Stream<List<String>> get favorites => _controller.stream;

  /// The current ordered favorite ids (empty until [init] has loaded them).
  List<String> get current => List<String>.unmodifiable(_ids);

  /// Whether [id] is currently favorited.
  bool isFavorite(String id) => _ids.contains(id);

  /// Loads persisted favorites and emits them. Safe to call more than once
  /// (re-reads storage). Awaited by tests; the production [instance] calls it
  /// automatically.
  Future<void> init() async {
    final prefs = await _prefsInstance();
    _ids = _read(prefs);
    _emit();
  }

  /// Toggles [id]: appends it to the end when absent, removes it when present.
  /// Persists and emits the new order.
  Future<void> toggle(String id) async {
    final prefs = await _prefsInstance();
    final next = List<String>.of(_ids);
    if (next.remove(id)) {
      // was present → now removed
    } else {
      next.add(id); // absent → append to the end
    }
    _ids = next;
    await _persist(prefs);
    _emit();
  }

  /// Replaces the whole order with [ids] (used by drag-reorder). Duplicates are
  /// dropped, keeping the first occurrence, so the no-duplicates invariant
  /// holds. Persists and emits.
  Future<void> setOrder(List<String> ids) async {
    final prefs = await _prefsInstance();
    final seen = <String>{};
    final deduped = <String>[];
    for (final id in ids) {
      if (seen.add(id)) deduped.add(id);
    }
    _ids = deduped;
    await _persist(prefs);
    _emit();
  }

  /// Closes the change stream. Intended for tests; the production singleton
  /// lives for the app's lifetime.
  @visibleForTesting
  Future<void> dispose() => _controller.close();

  // --- internals ----------------------------------------------------------

  Future<SharedPreferences> _prefsInstance() async =>
      _prefs ??= await SharedPreferences.getInstance();

  List<String> _read(SharedPreferences prefs) {
    final raw = prefs.getString(storageKey);
    if (raw == null || raw.isEmpty) return <String>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        return decoded.map((e) => e.toString()).toList();
      }
    } catch (_) {/* corrupt value → treat as empty */}
    return <String>[];
  }

  Future<void> _persist(SharedPreferences prefs) =>
      prefs.setString(storageKey, jsonEncode(_ids));

  void _emit() {
    if (!_controller.isClosed) _controller.add(List<String>.unmodifiable(_ids));
  }
}
