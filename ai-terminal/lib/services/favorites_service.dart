/// One-shot migration of the OLD per-device favorites list (#60).
///
/// Before #60, a favorite was purely local: an ordered JSON array of session
/// ids under [FavoritesService.storageKey] in [SharedPreferences] (mirroring
/// the web terminal's `localStorage['wt.favorites']`). That made every
/// browser and every install its own island — starring a session on the phone
/// did nothing on the web and vice versa, despite the UI implying otherwise.
///
/// A favorite is now a PROPERTY OF THE SESSION, stored on the server that owns
/// it (`favorite` + `favoriteRank` ride on [Session]; see
/// `ApiClient.setFavorite`). This class is no longer a source of truth — it
/// exists only to push the old local list up to the server ONCE, then
/// permanently forget it, so it can never resurrect a pin the user removed on
/// another device.
///
/// [migrateOnce] is deliberately best-effort but NOT retried: the local key is
/// cleared before/regardless of how many ids actually resolved, because
/// leaving it around risks exactly the bug #60 fixes (a stale local id
/// silently re-favoriting something the user deliberately unstarred
/// elsewhere). An id whose session can't be found right now (its server is
/// offline, or it was renamed/removed) is simply not migrated — favorites are
/// a convenience, not data worth that risk.
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/models.dart';

class FavoritesService {
  /// The [SharedPreferences] key that used to hold the ordered JSON array of
  /// favorite ids. Read (and permanently cleared) by [migrateOnce]; nothing
  /// else may read or write it.
  static const String storageKey = 'wt.favorites';

  FavoritesService._();

  /// Pushes any pre-#60 local favorites up to the server that owns each
  /// session, using [sessions] (the current merged, cross-server list — e.g.
  /// `SessionRepository.current`) to resolve each id to its owning [Session].
  /// Only sessions whose server currently advertises `favorites-sync` are
  /// pushed — pass `SessionRepository.instance.supportsFavorites` as
  /// [supportsFavorites] so this never fires a PATCH at a server that can't
  /// take it.
  ///
  /// Ranks are explicit wall-clock timestamps (`now + i`, one per pushed id,
  /// in the local list's order) rather than left for each owning server to
  /// assign independently: a plain `{favorite:true}` PATCH would let servers
  /// racing this same migration interleave their own clocks and scramble the
  /// list's original relative order, where a single client-chosen, strictly
  /// increasing sequence preserves it — mirrors the web migration exactly.
  ///
  /// Idempotent and safe to call on every app start: a no-op after the first
  /// successful call (or if there was never a local list), since the key is
  /// gone. Returns `true` if anything was actually pushed, so the caller knows
  /// a repository refresh is worth doing.
  ///
  /// [clientFactory] builds the [ApiClient] used for each PATCH — defaults to
  /// the real [ApiClient.new]; tests inject a factory wrapping a mock
  /// `http.Client` (see `SessionRepository`'s identical `ApiClientFactory`
  /// seam) so this never touches the network in a test run.
  static Future<bool> migrateOnce(
    List<Session> sessions, {
    required bool Function(String baseUrl) supportsFavorites,
    ApiClient Function(ServerConfig server)? clientFactory,
  }) async {
    final buildClient = clientFactory ?? ApiClient.new;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(storageKey);
    if (raw == null) return false; // already migrated, or never had any

    List<String> ids;
    try {
      final decoded = jsonDecode(raw);
      ids = decoded is List
          ? decoded.map((e) => e.toString()).toList()
          : <String>[];
    } catch (_) {
      ids = <String>[];
    }

    // Clear FIRST, unconditionally: a crash/kill mid-loop below must not
    // leave this key alive to run again — see the class doc.
    await prefs.remove(storageKey);
    if (ids.isEmpty) return false;

    final byId = {for (final s in sessions) s.id: s};
    final base = DateTime.now().millisecondsSinceEpoch;
    var offset = 0;
    var pushed = false;
    for (final id in ids) {
      final session = byId[id];
      if (session == null || session.favorite) {
        continue; // unresolved right now, or the server already holds it
      }
      if (!supportsFavorites(session.server.baseUrl)) continue;
      try {
        await buildClient(session.server)
            .setFavorite(id, true, rank: base + offset);
        offset++;
        pushed = true;
      } catch (_) {
        // Best-effort — this id's local pin is simply dropped (see class doc).
      }
    }
    return pushed;
  }
}
