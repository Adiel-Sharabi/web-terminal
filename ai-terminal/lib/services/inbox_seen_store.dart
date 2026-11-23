// #492 - what the person had seen in the inbox when they last looked, kept on THIS device
// (SharedPreferences key `inbox.seen.v1`, a JSON map of item key -> signature). The inbox
// reads it when it opens as the baseline for "new since you last looked", and writes the
// signatures it showed when the person leaves. Nothing here decides what is new
// (`changedSince` in util/inbox_queue.dart does).

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// The most entries kept: the newest-written are kept, so the map cannot grow for ever.
const int kInboxSeenCap = 500;

/// Where the per-device baseline is read and written; injectable for tests.
abstract class InboxSeenStore {
  /// The saved baseline, or null when this device never saved one (the first look).
  Future<Map<String, String>?> load();

  /// Saves [seen], at most [kInboxSeenCap] entries (the last ones of [seen]).
  Future<void> save(Map<String, String> seen);
}

class PrefsInboxSeenStore implements InboxSeenStore {
  const PrefsInboxSeenStore();

  static const String storageKey = 'inbox.seen.v1';

  @override
  Future<Map<String, String>?> load() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(storageKey);
      if (raw == null) return null;
      final j = jsonDecode(raw);
      if (j is! Map) return null;
      return {
        for (final e in j.entries)
          if (e.key is String && e.value is String) e.key as String: e.value as String,
      };
    } catch (_) {
      // Unreadable is "never looked": nothing is marked new, rather than everything.
      return null;
    }
  }

  @override
  Future<void> save(Map<String, String> seen) async {
    final keys = seen.keys.toList();
    final kept = keys.length > kInboxSeenCap ? keys.sublist(keys.length - kInboxSeenCap) : keys;
    try {
      await (await SharedPreferences.getInstance())
          .setString(storageKey, jsonEncode({for (final k in kept) k: seen[k]}));
    } catch (_) {/* a baseline that was not saved only shows more as new next time */}
  }
}
