/// Persistent, user-editable store of the configured web-terminal servers.
///
/// This is the single source of truth for [ServerConfig] list the whole app
/// runs against. It persists to [SharedPreferences] under [storageKey] as a JSON
/// array of `{name, baseUrl, bearerToken}` objects — the same three fields
/// [ServerConfig] carries — and re-emits the list on every mutation so the
/// dashboard, settings UI and [SessionRepository] can react.
///
/// **Seeding.** On the very first run (the key is absent) the store seeds itself
/// from the gitignored `spike_config.dart` constants as a single server named
/// `Shadow`, so an existing spike install keeps working with no migration. If
/// those constants are empty, it seeds an empty list. Once the key exists (even
/// as an empty array, e.g. the user removed every server) the store never
/// re-seeds — the persisted list wins.
///
/// **De-duplication.** Servers are unique by base URL, compared with the
/// trailing slash normalized away (`http://x:7785/` == `http://x:7785`). [add]
/// of an already-known base URL updates that entry in place instead of creating
/// a duplicate; [setAll] keeps the first occurrence of each base URL. Stored
/// base URLs are normalized (no trailing slash) so [ApiClient] never builds a
/// double-slashed request path.
///
/// **Lifecycle.** The production [instance] loads eagerly on construction and
/// also lazily on the first [servers] read, so it is safe whether or not
/// `main()` awaits [init]. [init] is idempotent — calling it twice returns the
/// same in-flight/completed load. Until the load completes, [servers] returns
/// the synchronous seed (matching the app's previous hardcoded single server),
/// so early readers never see an empty list by accident.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../spike_config.dart' as spike;

/// Singleton store of the persisted, user-editable [ServerConfig] list.
class ServerStore {
  /// The [SharedPreferences] key holding the JSON array of servers. Mirrors the
  /// web terminal's `wt.*` `localStorage` naming.
  static const String storageKey = 'wt.servers';

  ServerStore._() {
    _servers = _seed();
    // The production singleton loads eagerly so [servers] is correct as early as
    // possible; late listeners still get the loaded list via the onListen replay.
    unawaited(init());
  }

  /// The shared instance (auto-loads the persisted servers on construction).
  static final ServerStore instance = ServerStore._();

  /// Creates an isolated, non-auto-loading instance for tests. Call [init]
  /// yourself after `SharedPreferences.setMockInitialValues(...)`.
  @visibleForTesting
  ServerStore.forTest() {
    _servers = _seed();
  }

  late List<ServerConfig> _servers;
  SharedPreferences? _prefs;
  Future<void>? _initFuture;

  late final StreamController<List<ServerConfig>> _controller =
      StreamController<List<ServerConfig>>.broadcast(
    onListen: () => scheduleMicrotask(_emit),
  );

  /// The configured servers (unmodifiable). Returns the synchronous seed until
  /// [init] has loaded the persisted list; reading it also kicks off a lazy
  /// [init] if none has started, so callers work even when `main()` skips it.
  List<ServerConfig> get servers {
    if (_initFuture == null) unawaited(init());
    return List<ServerConfig>.unmodifiable(_servers);
  }

  /// Broadcast stream of the server list. Emits on every mutation and replays
  /// the current value to each new listener.
  Stream<List<ServerConfig>> get changes => _controller.stream;

  /// Loads the persisted servers (seeding + persisting on first run) and emits
  /// them. Idempotent: concurrent or repeated calls share one load. Awaited by
  /// tests and by `main()`; the production [instance] also calls it eagerly.
  Future<void> init() => _initFuture ??= _load();

  Future<void> _load() async {
    final prefs = await _prefsInstance();
    final raw = prefs.getString(storageKey);
    if (raw == null) {
      // First run: persist the seed so the choice sticks across launches.
      _servers = _seed();
      await _persist(prefs);
    } else {
      _servers = _decode(raw);
    }
    _emit();
  }

  /// Adds [config], or updates the existing server with the same (normalized)
  /// base URL in place. Persists and emits.
  Future<void> add(ServerConfig config) async {
    final c = _normalize(config);
    if (c.baseUrl.isEmpty) {
      throw ArgumentError.value(config.baseUrl, 'config.baseUrl', 'must not be empty');
    }
    final next = List<ServerConfig>.of(_servers);
    final idx = next.indexWhere((s) => s.baseUrl == c.baseUrl);
    if (idx >= 0) {
      next[idx] = c;
    } else {
      next.add(c);
    }
    await _commit(next);
  }

  /// Replaces the server at [index] with [config]. Any other entry that would
  /// collide with the updated base URL is dropped so uniqueness holds. Persists
  /// and emits. Throws [RangeError] if [index] is out of range.
  Future<void> update(int index, ServerConfig config) async {
    _checkIndex(index);
    final c = _normalize(config);
    if (c.baseUrl.isEmpty) {
      throw ArgumentError.value(config.baseUrl, 'config.baseUrl', 'must not be empty');
    }
    final next = <ServerConfig>[];
    for (var i = 0; i < _servers.length; i++) {
      if (i == index) {
        next.add(c);
      } else if (_servers[i].baseUrl == c.baseUrl) {
        continue; // collides with the updated URL → drop the stale duplicate
      } else {
        next.add(_servers[i]);
      }
    }
    await _commit(next);
  }

  /// Removes the server at [index]. Persists and emits. Throws [RangeError] if
  /// [index] is out of range.
  Future<void> removeAt(int index) async {
    _checkIndex(index);
    final next = List<ServerConfig>.of(_servers)..removeAt(index);
    await _commit(next);
  }

  /// Replaces the entire list with [configs], normalizing base URLs and dropping
  /// duplicates (keeping the first occurrence of each base URL) and any entry
  /// with an empty base URL. Persists and emits.
  Future<void> setAll(List<ServerConfig> configs) async {
    final next = <ServerConfig>[];
    final seen = <String>{};
    for (final config in configs) {
      final c = _normalize(config);
      if (c.baseUrl.isEmpty) continue;
      if (!seen.add(c.baseUrl)) continue;
      next.add(c);
    }
    await _commit(next);
  }

  /// Upgrades the display name of the server whose (normalized) base URL matches
  /// [baseUrl] — called after a successful `/api/version`. Updates in memory
  /// synchronously (so [servers] reflects it immediately) and persists in the
  /// background. No-op if [name] is empty or nothing matches.
  void updateServerName(String baseUrl, String name) {
    if (name.isEmpty) return;
    final key = _normUrl(baseUrl);
    var changed = false;
    for (var i = 0; i < _servers.length; i++) {
      if (_servers[i].baseUrl == key && _servers[i].name != name) {
        _servers[i] = _servers[i].copyWith(name: name);
        changed = true;
      }
    }
    if (changed) {
      _emit();
      unawaited(_persist());
    }
  }

  /// Probes [config] by calling `GET /api/version` with its token, returning the
  /// server's [ServerInfo] (name, version, capabilities) so the settings UI can
  /// confirm reachability and that the token works. Throws [ApiException] on any
  /// failure (unreachable, timeout, bad token, malformed response).
  Future<ServerInfo> probe(ServerConfig config) async {
    final client = ApiClient(_normalize(config));
    try {
      return await client.version();
    } finally {
      client.close();
    }
  }

  /// Closes the change stream. Intended for tests; the production singleton lives
  /// for the app's lifetime.
  @visibleForTesting
  Future<void> dispose() => _controller.close();

  // --- internals ----------------------------------------------------------

  Future<void> _commit(List<ServerConfig> next) async {
    // Await prefs before mutating/emitting so any pending onListen replay
    // microtask fires against the pre-mutation state first — keeping the
    // `changes` stream strictly ordered (mirrors FavoritesService).
    final prefs = await _prefsInstance();
    _servers = next;
    _emit();
    await prefs.setString(storageKey, _encode(_servers));
  }

  void _checkIndex(int index) {
    if (index < 0 || index >= _servers.length) {
      throw RangeError.index(index, _servers, 'index');
    }
  }

  Future<SharedPreferences> _prefsInstance() async =>
      _prefs ??= await SharedPreferences.getInstance();

  Future<void> _persist([SharedPreferences? prefs]) async {
    final p = prefs ?? await _prefsInstance();
    await p.setString(storageKey, _encode(_servers));
  }

  void _emit() {
    if (!_controller.isClosed) {
      _controller.add(List<ServerConfig>.unmodifiable(_servers));
    }
  }

  /// The first-run seed: the spike server as `Shadow`, or empty when the spike
  /// constants are blank.
  static List<ServerConfig> _seed() {
    // Prefer the multi-server seed (the real cluster) when present.
    if (spike.kSeedServers.isNotEmpty) {
      final out = <ServerConfig>[];
      for (final s in spike.kSeedServers) {
        final base = _normUrl(s['baseUrl'] ?? '');
        final tok = s['bearerToken'] ?? '';
        if (base.isEmpty || tok.isEmpty) continue;
        out.add(ServerConfig(
          name: s['name'] ?? 'Server',
          baseUrl: base,
          bearerToken: tok,
        ));
      }
      return out;
    }
    final base = _normUrl(spike.kServerBase);
    if (base.isEmpty || spike.kBearerToken.isEmpty) return <ServerConfig>[];
    return <ServerConfig>[
      ServerConfig(name: 'Shadow', baseUrl: base, bearerToken: spike.kBearerToken),
    ];
  }

  static String _encode(List<ServerConfig> servers) => jsonEncode([
        for (final s in servers)
          <String, String>{
            'name': s.name,
            'baseUrl': s.baseUrl,
            'bearerToken': s.bearerToken,
          },
      ]);

  /// Parses the stored JSON array, normalizing base URLs and dropping malformed,
  /// empty-URL and duplicate entries. Corrupt storage decodes to an empty list.
  static List<ServerConfig> _decode(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        final out = <ServerConfig>[];
        final seen = <String>{};
        for (final e in decoded) {
          if (e is! Map) continue;
          final baseUrl = _normUrl((e['baseUrl'] ?? '').toString());
          if (baseUrl.isEmpty || !seen.add(baseUrl)) continue;
          out.add(ServerConfig(
            name: (e['name'] ?? '').toString(),
            baseUrl: baseUrl,
            bearerToken: (e['bearerToken'] ?? '').toString(),
          ));
        }
        return out;
      }
    } catch (_) {/* corrupt value → treat as empty */}
    return <ServerConfig>[];
  }

  /// Returns [config] with its base URL trailing-slash-normalized (cheaply
  /// reusing the same instance when already normal).
  static ServerConfig _normalize(ServerConfig config) {
    final n = _normUrl(config.baseUrl);
    return n == config.baseUrl ? config : config.copyWith(baseUrl: n);
  }

  /// Trims whitespace and strips trailing slashes so URLs compare canonically.
  static String _normUrl(String url) {
    var u = url.trim();
    while (u.endsWith('/')) {
      u = u.substring(0, u.length - 1);
    }
    return u;
  }
}
