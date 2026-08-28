/// Aggregates sessions across all configured servers into one reactive stream.
///
/// [refresh] fetches every server in parallel, tolerates per-server failure
/// (keeping the last-known sessions for an offline server so they read as stale
/// rather than vanishing), sorts the merged list attention-first, and feeds the
/// notification name cache. In the foreground it also listens to each server's
/// `/ws/notify` stream and re-fetches on events, backed by a 30s poll.
///
/// **Instant cold-launch paint.** Every successful [refresh] persists the merged
/// list to [SharedPreferences] (key [_cacheKey]). On [startForeground] the repo
/// first [primeFromCache]s — emitting that last-known list immediately so the
/// dashboard paints the previous session set before the (possibly slow, on a
/// waking tailnet) network refresh returns — then runs a retrying initial
/// refresh. A failed refresh never blanks the list: the cached sessions are also
/// seeded into the per-server last-known buckets, so an all-offline refresh
/// re-emits them (flagged stale via [serverOnline]) rather than an empty list.
///
/// **Stable server grouping (Complaint B).** This repo intentionally emits a
/// single flat list sorted attention-then-recency ([compareSessions]) — it does
/// NOT order by server. The dashboard groups that list by server using the
/// user's configured order ([AppConfig.servers] via `groupSessionsByServer`), so
/// group order is stable; [compareSessions] only decides the order *within* a
/// group. Do not reintroduce server into [compareSessions].
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import 'favorites_order.dart';
import 'notification_service.dart';
import 'resource_monitor.dart';
import 'server_store.dart';

/// Builds an [ApiClient] for a server. Injectable so tests can supply a
/// fake-transport client; production uses [ApiClient.new].
typedef ApiClientFactory = ApiClient Function(ServerConfig server);

/// Singleton store of the merged, sorted session list.
class SessionRepository {
  SessionRepository._()
      : _store = ServerStore.instance,
        _clientFactory = ApiClient.new;

  /// The shared instance.
  static final SessionRepository instance = SessionRepository._();

  /// Creates an isolated instance for tests, with an injectable server [store]
  /// and [ApiClient] factory so [refresh] / [primeFromCache] run against fakes
  /// (no real network, no shared singletons). Production uses [instance].
  @visibleForTesting
  SessionRepository.forTest({
    ServerStore? store,
    ApiClientFactory? clientFactory,
  })  : _store = store ?? ServerStore.instance,
        _clientFactory = clientFactory ?? ApiClient.new;

  /// The [SharedPreferences] key holding the last successfully-merged session
  /// list, replayed on the next cold launch for an instant first paint.
  static const String _cacheKey = 'wt.lastSessions';

  /// Source of the configured servers (defaults to [ServerStore.instance], which
  /// is exactly what [AppConfig] exposes). Injected in tests.
  final ServerStore _store;

  /// Constructs the per-server [ApiClient]s. Injected in tests.
  final ApiClientFactory _clientFactory;

  final StreamController<List<Session>> _sessions =
      StreamController<List<Session>>.broadcast();
  final StreamController<Map<String, bool>> _online =
      StreamController<Map<String, bool>>.broadcast();

  final Map<String, ApiClient> _clients = <String, ApiClient>{};
  final Map<String, List<Session>> _lastByServer = <String, List<Session>>{};
  final Map<String, bool> _serverOnline = <String, bool>{};
  final Set<String> _namesResolved = <String>{};
  // When each server's `/api/version` was last answered, so an already-resolved
  // server is re-asked only when its free machine reading (#152/#165) has gone
  // stale rather than on every 300ms-debounced [refresh].
  final Map<String, DateTime> _versionFetchedAt = <String, DateTime>{};
  static const Duration _machineReadingMaxAge = Duration(seconds: 10);

  /// Per-server `favorites-sync` capability (#60), keyed by base URL. Filled
  /// from the SAME `/api/version` call [_ensureServerNames] already makes —
  /// no extra request. Absent (not yet resolved, or the server is too old)
  /// reads as unsupported via [supportsFavorites], so the star is never
  /// offered — and no PATCH ever fired — until a server actually confirms it.
  final Map<String, bool> _favoritesSyncSupported = <String, bool>{};

  // Live `/ws/notify` subscriptions, keyed by server base URL, alongside the
  // exact [ServerConfig] each was opened with (to detect a token change).
  // Re-synced from [AppConfig.serversStream] as servers are added/removed.
  final Map<String, StreamSubscription<NotifyEvent>> _notifySubs =
      <String, StreamSubscription<NotifyEvent>>{};
  final Map<String, ServerConfig> _notifyConfigs = <String, ServerConfig>{};
  StreamSubscription<List<ServerConfig>>? _serversSub;

  // Live per-session API-error state. `/api/sessions` never reports api-error
  // status, so the ONLY source is the `/ws/notify` frames consumed in
  // [_applyNotify]. Pruned in [refresh] when a session leaves the list.
  final Map<String, ApiErrorInfo> _apiErrors = <String, ApiErrorInfo>{};

  // Live per-session compaction state (#65), overlaying status the same way
  // [_apiErrors] does. Unlike api-error, `/api/sessions` DOES report
  // `compacting`/`compactingSince` — [refresh] seeds this map from that poll
  // (see [_seedCompacting]) — and [_applyNotify] additionally folds in the
  // live `type:'compacting'` `/ws/notify` frame so the indicator can appear
  // ahead of the next poll. Pruned in [refresh] when a session leaves the list.
  final Map<String, CompactingInfo> _compacting = <String, CompactingInfo>{};

  // Live per-session "your last submit produced no agent activity" event
  // (#179), keyed to the `at` the worker stamped it with. Unlike [_apiErrors]
  // / [_compacting] there is no REST-polled level to seed from and no
  // "cleared" frame to remove it — the worker reports the timeout once and
  // otherwise stays silent (silence IS success; see `lib/submit-confirm.js`).
  // So this map only ever grows here; [clearSubmitUnconfirmed] is the sole
  // remover, called by the screen that has already reacted to an entry.
  // Pruned in [refresh] like the other two when a session leaves the list.
  final Map<String, int> _submitUnconfirmedAt = <String, int>{};

  // Session ids whose attention has been acknowledged (opened/viewed/dismissed)
  // — the chip is hidden for these (#24). Synced cross-device: seeded by a
  // 'clear' notify frame from any device, and re-armed (removed) by a genuine
  // new alert for the session. Replaces the dashboard's old device-local set.
  final Set<String> _dismissedAttention = <String>{};

  List<Session> _current = const <Session>[];
  Timer? _pollTimer;
  Timer? _debounce;
  bool _foreground = false;

  /// Broadcast stream of the merged session list, sorted attention-first.
  Stream<List<Session>> get sessions => _sessions.stream;

  /// The most recently emitted session list (empty before the first refresh).
  List<Session> get current => _current;

  /// The live API-error state for [id], or `null` when the session is not in an
  /// API error. Folded from `/ws/notify` frames (never present in
  /// `/api/sessions`). The `sessions` stream re-emits whenever this map changes,
  /// so the dashboard can read this getter during the triggered rebuild to badge
  /// a session (and show [ApiErrorInfo.text] / retry progress).
  ApiErrorInfo? apiErrorFor(String id) => _apiErrors[id];

  /// The live compaction state for [id], or `null` when the session isn't
  /// currently compacting (#65). Seeded from `/api/sessions`' `compacting`
  /// field on every [refresh] and kept live by the `type:'compacting'`
  /// `/ws/notify` frame — see [_seedCompacting] / [_applyNotify]. The chat
  /// lens reads this to show "Compacting conversation…" ahead of
  /// `SessionStatus.working`.
  CompactingInfo? compactingFor(String id) => _compacting[id];

  /// The epoch-ms `at` of the latest unhandled `submitUnconfirmed` event for
  /// [id] (#179), or `null` when there isn't one. A screen watching this
  /// session compares it against the last value it already acted on (never
  /// stored here — see `SessionScreen._handledSubmitUnconfirmedAt`) so a
  /// later, unrelated `sessions` emission doesn't replay an old event.
  int? submitUnconfirmedAt(String id) => _submitUnconfirmedAt[id];

  /// Forgets the pending `submitUnconfirmed` entry for [id] (#179). Called by
  /// the screen once it has restored the draft and shown its notice, so
  /// neither a later poll nor a fresh `sessions` emission re-delivers the
  /// same event. Re-emits only if there was something to forget.
  void clearSubmitUnconfirmed(String id) {
    if (_submitUnconfirmedAt.remove(id) != null) _emitSessions();
  }

  /// Test-only: seeds/clears [_compacting] directly for [id], bypassing the
  /// notify-frame/poll producers ([_applyNotify] / [_seedCompacting]). Lets a
  /// widget test drive [compactingFor] — which [ConversationView] reads off
  /// this singleton — without standing up a fake `ApiClient` or notify
  /// stream. Re-emits like the production write paths so listeners rebuild.
  @visibleForTesting
  void debugSetCompacting(String id, CompactingInfo? info) {
    if (info == null) {
      _compacting.remove(id);
    } else {
      _compacting[id] = info;
    }
    _emitSessions();
  }

  /// Test-only: feeds a raw `/ws/notify` event through the exact path a live
  /// subscription uses ([_applyNotify]), so a test can drive
  /// [submitUnconfirmedAt] / [apiErrorFor] / [compactingFor] without standing
  /// up a fake WebSocket (the way [debugSetCompacting] bypasses the notify
  /// plumbing entirely, this instead exercises it for real).
  @visibleForTesting
  void debugApplyNotify(NotifyEvent evt) => _applyNotify(evt);

  /// Broadcast stream of per-server reachability (`baseUrl → online`).
  Stream<Map<String, bool>> get serverOnlineStream => _online.stream;

  /// Snapshot of per-server reachability (`baseUrl → online`), updated on every
  /// [refresh].
  Map<String, bool> get serverOnline => Map<String, bool>.unmodifiable(_serverOnline);

  /// Whether the server at [baseUrl] advertises `favorites-sync` (#60) — i.e.
  /// has the `/api/sessions/:id/favorite` route. `false` (never offer the
  /// star) until a successful `/api/version` call actually confirms it, so a
  /// server too old for the route — or one not yet reached — never receives a
  /// PATCH it can't handle.
  bool supportsFavorites(String baseUrl) => _favoritesSyncSupported[baseUrl] ?? false;

  /// Fetches all configured servers in parallel and emits the merged, sorted
  /// list. A server that fails is marked offline and contributes its last-known
  /// (stale) sessions instead of dropping out entirely.
  Future<void> refresh() async {
    await _ensureServerNames();
    final servers = _store.servers;
    final results = await Future.wait(servers.map(_fetchServer));
    final merged = <Session>[for (final r in results) ...r]..sort(compareSessions);

    _current = merged;
    _pruneApiErrors(merged);
    _seedCompacting(merged);
    _pruneCompacting(merged);
    _pruneSubmitUnconfirmed(merged);
    if (!_sessions.isClosed) _sessions.add(merged);
    if (!_online.isClosed) _online.add(serverOnline);
    await _cacheNames(merged);
    // Persist the merged list for the next cold launch — but only when at least
    // one server actually responded this round, so a total outage can't blank
    // the cache the instant-paint path relies on.
    if (_anyServerReachable()) await _writeCache(merged);
  }

  /// Begins foreground live-updates: subscribes to every server's `/ws/notify`
  /// stream (re-fetching on events, debounced), watches [AppConfig.serversStream]
  /// so added/removed servers are picked up live, starts a 30s poll and boots
  /// the list (cache paint + retrying initial refresh). Idempotent — the
  /// `_foreground` guard means the repeated calls from `main()` and every
  /// foreground resume never double-subscribe.
  void startForeground() {
    if (_foreground) return;
    _foreground = true;
    _syncNotifySubs();
    _serversSub = _store.changes.listen((_) => _onServersChanged());
    _pollTimer = Timer.periodic(const Duration(seconds: 30), (_) => refresh());
    unawaited(_bootstrap());
  }

  /// Paints the cached list instantly, then runs the retrying initial refresh.
  Future<void> _bootstrap() async {
    await primeFromCache();
    await _initialRefreshWithRetry();
  }

  /// Fires an immediate [refresh]; if it reaches no configured server (DNS /
  /// tailnet routing often lags for a second or two right after launch), retries
  /// after 2s then 5s. Bails the moment a server responds or the app leaves the
  /// foreground, so it never keeps polling a backgrounded app.
  Future<void> _initialRefreshWithRetry() async {
    await refresh();
    for (final delay in const [Duration(seconds: 2), Duration(seconds: 5)]) {
      if (!_foreground || _anyServerReachable()) return;
      await Future<void>.delayed(delay);
      if (!_foreground) return;
      await refresh();
    }
  }

  /// Seeds the session list from the last-known cache so the dashboard paints
  /// instantly on a cold launch, ahead of the first network [refresh].
  ///
  /// Reads the merged list persisted by [refresh] under [_cacheKey], maps every
  /// cached session back onto its currently-configured [ServerConfig] (dropping
  /// any whose server is no longer configured), sorts it and emits it on
  /// [sessions]. It also seeds the per-server last-known buckets so a subsequent
  /// all-offline [refresh] re-emits these sessions instead of blanking the list.
  ///
  /// No-op once a list is already present (e.g. a foreground resume, or a
  /// network refresh that raced ahead), so it never clobbers live data. Safe to
  /// call from `main()` before `runApp` to also populate [current] for the first
  /// frame.
  Future<void> primeFromCache() async {
    if (_current.isNotEmpty) return;
    final cached = await _readCache();
    if (cached.isEmpty || _current.isNotEmpty) return;
    for (final s in cached) {
      (_lastByServer[s.server.baseUrl] ??= <Session>[]).add(s);
    }
    final sorted = <Session>[...cached]..sort(compareSessions);
    _current = sorted;
    if (!_sessions.isClosed) _sessions.add(sorted);
  }

  /// Stops foreground live-updates (WS subscriptions + server watch + poll).
  /// Idempotent.
  void stopForeground() {
    _foreground = false;
    _serversSub?.cancel();
    _serversSub = null;
    for (final sub in _notifySubs.values) {
      sub.cancel();
    }
    _notifySubs.clear();
    _notifyConfigs.clear();
    _pollTimer?.cancel();
    _pollTimer = null;
    _debounce?.cancel();
    _debounce = null;
  }

  /// Orders sessions per the Phase 1 UI spec: needs-attention first, then by
  /// status, then most-recent first.
  ///
  /// The `/api/sessions` list carries only `status` (no attention `kind`), so
  /// both the attention rank and the status rank are derived from `status`:
  /// `waiting`→approval, `api_error`→apierror, `idle`→done, everything else→none.
  static int compareSessions(Session a, Session b) {
    final byAttention = _attentionRank(a.status).compareTo(_attentionRank(b.status));
    if (byAttention != 0) return byAttention;
    final byStatus = _statusRank(a.status).compareTo(_statusRank(b.status));
    if (byStatus != 0) return byStatus;
    return (b.lastActivity ?? 0).compareTo(a.lastActivity ?? 0);
  }

  // --- internals ----------------------------------------------------------

  /// Handles one `/ws/notify` frame: folds api-error state (for the instant
  /// highlight) and schedules the debounced list refresh (existing behavior).
  void _onNotify(NotifyEvent evt) {
    // #24 cross-device attention sync.
    if (evt.sessionId.isNotEmpty) {
      if (evt.type == 'clear' || evt.cleared) {
        // Another device opened/dismissed this session — clear its chip here too.
        if (_dismissedAttention.add(evt.sessionId)) _reemit();
      } else if (isFreshAlert(evt)) {
        // A genuine NEW alert re-arms a previously-acknowledged session so its
        // chip shows again (a bare status poll does not — no resurrect on noise).
        _dismissedAttention.remove(evt.sessionId);
      }
    }
    _applyNotify(evt);
    _scheduleRefresh();
  }

  /// Whether a notify frame is a genuine new attention alert (carries a message
  /// and a needs-attention condition) versus a bare status/poll frame. Used to
  /// re-arm a dismissed session's chip (#24) — a bare poll must NOT resurrect it.
  @visibleForTesting
  static bool isFreshAlert(NotifyEvent e) =>
      e.message.isNotEmpty &&
      (e.status == 'waiting' || e.status == 'api_error' || e.apiError);

  /// Reacts to a change in the configured server set (from
  /// [AppConfig.serversStream]): re-syncs the `/ws/notify` subscriptions and, if
  /// a server was actually added, removed or re-tokenized, refreshes the list.
  /// A name-only change (server renamed after `/api/version`) touches no
  /// subscription, so it doesn't trigger a redundant refresh here — the refresh
  /// that resolved the name already re-emits the list.
  void _onServersChanged() {
    if (!_foreground) return;
    if (_syncNotifySubs()) _scheduleRefresh();
  }

  /// Aligns the live `/ws/notify` subscriptions with [AppConfig.servers]: opens
  /// one per newly-added server, tears down subscriptions for removed servers
  /// (and forgets their cached state), and re-opens a subscription when a
  /// server's bearer token changed. Returns `true` if any subscription was
  /// added or removed.
  bool _syncNotifySubs() {
    final current = <String, ServerConfig>{
      for (final s in _store.servers) s.baseUrl: s,
    };
    var changed = false;

    // Drop subscriptions for servers that are gone or whose token changed.
    for (final key in _notifySubs.keys.toList()) {
      final cfg = current[key];
      final gone = cfg == null;
      final tokenChanged =
          cfg != null && cfg.bearerToken != _notifyConfigs[key]?.bearerToken;
      if (gone || tokenChanged) {
        _notifySubs.remove(key)!.cancel();
        _notifyConfigs.remove(key);
        changed = true;
        if (gone) _forgetServer(key);
      }
    }

    // Open subscriptions for servers we're not yet watching.
    for (final entry in current.entries) {
      if (_notifySubs.containsKey(entry.key)) continue;
      _notifyConfigs[entry.key] = entry.value;
      _notifySubs[entry.key] = _clientFor(entry.value).notifyStream().listen(
            _onNotify,
            onError: (_) {/* stream self-reconnects */},
          );
      changed = true;
    }
    return changed;
  }

  /// Forgets all cached state for a removed server so it stops contributing
  /// stale sessions and its HTTP client is released.
  void _forgetServer(String baseUrl) {
    _clients.remove(baseUrl)?.close();
    _lastByServer.remove(baseUrl);
    _serverOnline.remove(baseUrl);
    _namesResolved.remove(baseUrl);
    _versionFetchedAt.remove(baseUrl);
    _favoritesSyncSupported.remove(baseUrl);
  }

  /// Updates [_apiErrors], [_compacting] and [_submitUnconfirmedAt] from a
  /// notify frame. The three signals are independent (a frame carries at most
  /// one, but nothing stops any check from also handling the others in one
  /// pass).
  ///
  /// **Api-error:** only a frame that actually carries api-error state
  /// ([NotifyEvent.hasApiErrorSignal]) touches [_apiErrors] — an ordinary
  /// status/approval/idle frame (which has `apiError == false` merely by
  /// default) is ignored, so it can't wrongly clear an active error. On such a
  /// frame: `apiError && !cleared` sets or refreshes the entry (carrying the
  /// latest text/retry detail); otherwise (recovery — `apiError == false`, or
  /// an explicit `cleared`) the entry is removed.
  ///
  /// **Compacting (#65):** mirrors the same guard via
  /// [NotifyEvent.hasCompactingSignal] so a frame without the `compacting` key
  /// leaves [_compacting] untouched. `compacting == true` sets the entry;
  /// `false` (compaction ended) removes it.
  ///
  /// **submitUnconfirmed (#179):** [NotifyEvent.submitUnconfirmed] gates it —
  /// there is no boolean level and no "false" to un-set, so unlike the two
  /// above this branch only ever writes; see [clearSubmitUnconfirmed].
  ///
  /// Every branch re-emits the session list on change so the dashboard/chat
  /// lens rebuilds immediately, ahead of the debounced [refresh].
  void _applyNotify(NotifyEvent evt) {
    if (evt.sessionId.isEmpty) return;
    final id = evt.sessionId;
    if (evt.hasApiErrorSignal) {
      if (evt.apiError && !evt.cleared) {
        _apiErrors[id] = ApiErrorInfo(
          active: true,
          text: evt.apiErrorText,
          transient: evt.transient,
          autoContinue: evt.autoContinue,
          action: evt.action,
        );
        _emitSessions();
      } else if (_apiErrors.remove(id) != null) {
        _emitSessions();
      }
    }
    if (evt.hasCompactingSignal) {
      if (evt.compacting) {
        _compacting[id] = CompactingInfo(active: true, since: evt.compactingSince);
        _emitSessions();
      } else if (_compacting.remove(id) != null) {
        _emitSessions();
      }
    }
    // #179 — an edge, not a level: always record the newest `at` (falling
    // back to "now" on a malformed frame missing it, so the event is still
    // distinguishable from whatever the watching screen last handled) and
    // re-emit. Nothing here ever removes an entry; only [clearSubmitUnconfirmed]
    // does, once a screen has actually reacted to it.
    if (evt.submitUnconfirmed) {
      _submitUnconfirmedAt[id] =
          evt.submitUnconfirmedAt ?? DateTime.now().millisecondsSinceEpoch;
      _emitSessions();
    }
  }

  /// Drops api-error entries for sessions no longer in [sessions].
  void _pruneApiErrors(List<Session> sessions) {
    if (_apiErrors.isEmpty) return;
    final live = <String>{for (final s in sessions) s.id};
    _apiErrors.removeWhere((id, _) => !live.contains(id));
  }

  /// Seeds/refreshes [_compacting] from each session's own `compacting` /
  /// `compactingSince` fields (#65) — unlike api-error, `/api/sessions` DOES
  /// report this directly. Runs on every [refresh] so a session already
  /// compacting when the app (re)connects — or whose live `/ws/notify` frame
  /// was missed — still shows the indicator; [_applyNotify] can still update
  /// the entry sooner, between polls.
  void _seedCompacting(List<Session> sessions) {
    for (final s in sessions) {
      if (s.compacting) {
        _compacting[s.id] = CompactingInfo(active: true, since: s.compactingSince);
      } else {
        _compacting.remove(s.id);
      }
    }
  }

  /// Drops compacting entries for sessions no longer in [sessions] (#65).
  void _pruneCompacting(List<Session> sessions) {
    if (_compacting.isEmpty) return;
    final live = <String>{for (final s in sessions) s.id};
    _compacting.removeWhere((id, _) => !live.contains(id));
  }

  /// Drops submitUnconfirmed entries for sessions no longer in [sessions]
  /// (#179) — a killed session's screen is gone too, so nothing will ever
  /// call [clearSubmitUnconfirmed] for it.
  void _pruneSubmitUnconfirmed(List<Session> sessions) {
    if (_submitUnconfirmedAt.isEmpty) return;
    final live = <String>{for (final s in sessions) s.id};
    _submitUnconfirmedAt.removeWhere((id, _) => !live.contains(id));
  }

  /// Re-emits the current session list (unchanged contents) so listeners rebuild
  /// and re-read [apiErrorFor].
  void _emitSessions() {
    if (!_sessions.isClosed) _sessions.add(_current);
  }

  Future<List<Session>> _fetchServer(ServerConfig server) async {
    try {
      final list = await _clientFor(server).listSessions();
      _serverOnline[server.baseUrl] = true;
      _lastByServer[server.baseUrl] = list;
      return list;
    } catch (_) {
      _serverOnline[server.baseUrl] = false;
      return _lastByServer[server.baseUrl] ?? const <Session>[];
    }
  }

  /// Whether any currently-configured server responded on the last [refresh].
  bool _anyServerReachable() =>
      _store.servers.any((s) => _serverOnline[s.baseUrl] == true);

  /// Reads and decodes the persisted last-known session list, mapping each entry
  /// onto a currently-configured server (dropping the rest). Empty on any error.
  Future<List<Session>> _readCache() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_cacheKey);
      if (raw == null || raw.isEmpty) return const <Session>[];
      return decodeSessionCache(raw, _store.servers);
    } catch (_) {
      return const <Session>[];
    }
  }

  /// Persists [sessions] as the last-known list for the next cold launch.
  /// Best-effort — a storage failure is swallowed.
  Future<void> _writeCache(List<Session> sessions) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey, encodeSessionCache(sessions));
    } catch (_) {/* best-effort */}
  }

  /// Serializes [sessions] to the JSON stored under [_cacheKey]: the fields the
  /// dashboard needs to paint a stale row plus the owning `serverBaseUrl` (used
  /// on load to re-attach the current [ServerConfig]).
  @visibleForTesting
  static String encodeSessionCache(List<Session> sessions) => jsonEncode([
        for (final s in sessions)
          <String, dynamic>{
            'id': s.id,
            'name': s.name,
            'cwd': s.cwd,
            'status': s.status,
            'claudeSessionId': s.claudeSessionId,
            'lastActivity': s.lastActivity,
            'notifyLevel': s.notifyLevel,
            'autoCommand': s.autoCommand,
            'serverBaseUrl': s.server.baseUrl,
            // #60: so the pinned group's instant cold-launch paint (ahead of
            // the first live refresh) already reflects the server's truth
            // instead of momentarily looking unfavorited.
            'favorite': s.favorite,
            'favoriteRank': s.favoriteRank,
          },
      ]);

  /// Rebuilds the cached sessions, re-attaching each to the matching entry in
  /// [servers] by `serverBaseUrl`. Sessions whose server is no longer configured
  /// are dropped; a corrupt payload decodes to an empty list.
  @visibleForTesting
  static List<Session> decodeSessionCache(
    String raw,
    List<ServerConfig> servers,
  ) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const <Session>[];
      final byUrl = <String, ServerConfig>{
        for (final s in servers) s.baseUrl: s,
      };
      final out = <Session>[];
      for (final e in decoded) {
        if (e is! Map) continue;
        final server = byUrl[(e['serverBaseUrl'] ?? '').toString()];
        if (server == null) continue;
        out.add(Session(
          id: (e['id'] ?? '').toString(),
          name: (e['name'] ?? '').toString(),
          cwd: (e['cwd'] ?? '').toString(),
          status: (e['status'] ?? 'idle').toString(),
          claudeSessionId: e['claudeSessionId']?.toString(),
          lastActivity: _asInt(e['lastActivity']),
          notifyLevel: (e['notifyLevel'] ?? 'important').toString(),
          autoCommand: (e['autoCommand'] ?? '').toString(),
          server: server,
          favorite: e['favorite'] == true,
          favoriteRank: _asInt(e['favoriteRank']),
        ));
      }
      return out;
    } catch (_) {
      return const <Session>[];
    }
  }

  /// Coerces a dynamic JSON value to `int?` (accepts numbers and numeric
  /// strings), matching the defensive parsing in `models.dart`.
  static int? _asInt(dynamic v) {
    if (v == null) return null;
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse(v.toString());
  }

  /// Whether [id]'s attention chip is currently acknowledged/hidden (#24).
  /// Synced across devices via 'clear' notify frames.
  bool isAttentionDismissed(String id) => _dismissedAttention.contains(id);

  /// Acknowledges (clears) a session's attention on THIS and every other device
  /// (#24): hides the chip locally at once, then tells the server, which flips
  /// the recorded attention, dismisses phone notifications (FCM 'clear') and
  /// broadcasts a 'clear' frame so other in-app viewers drop the chip too.
  /// Called when the session is opened/viewed or its chip is dismissed.
  Future<void> dismissAttention(Session session) async {
    if (_dismissedAttention.add(session.id)) _reemit();
    // Cancel THIS device's OS notification now (#2). The server's FCM 'clear'
    // is for *other* devices and never fires on a foreground app, so opening
    // the session here must dismiss its own notification directly.
    await NotificationService.cancelForSession(session.id);
    try {
      await _clientFor(session.server).clearAttention(session.id);
    } catch (_) {
      // Best-effort: the local hide already happened; other devices reconcile
      // on the next alert/refresh.
    }
  }

  /// Re-emits the current list so the dashboard rebuilds (StreamBuilder fires on
  /// every event regardless of list identity). Used when a derived overlay
  /// ([_dismissedAttention], server order) changes without a new fetch.
  void _reemit() {
    if (!_sessions.isClosed) _sessions.add(_current);
  }

  /// A session's position in its server's last-received order — the
  /// server-persisted display order that drag-reorder sets (#22). Because
  /// `/api/sessions` returns sessions in the server's stored order, the last
  /// fetched list ([_lastByServer]) *is* that order. Unknown ids sort last so a
  /// freshly-created session (not yet in a persisted order) appends at the end.
  /// The dashboard sorts each server group by this, rather than the flat
  /// attention/recency sort, so a dragged order is honored and survives
  /// reconnect (the server is the source of truth).
  int serverOrderIndex(String baseUrl, String id) {
    final list = _lastByServer[baseUrl];
    if (list == null) return 1 << 30;
    final i = list.indexWhere((s) => s.id == id);
    return i < 0 ? (1 << 30) : i;
  }

  /// Persists a new order for one server's sessions (#22) and applies it
  /// optimistically so every viewer of this device updates instantly. [orderedIds]
  /// is that server's full id list in the desired order; ids not present are
  /// appended in their prior order (matches the server's reorder semantics).
  /// Best-effort persistence — a failed POST is reconciled by the next refresh,
  /// which re-reads the authoritative order from the server.
  Future<void> reorderServerSessions(
    ServerConfig server,
    List<String> orderedIds,
  ) async {
    final base = server.baseUrl;
    final prior = _lastByServer[base] ?? const <Session>[];
    final byId = <String, Session>{for (final s in prior) s.id: s};
    final reordered = <Session>[
      for (final id in orderedIds)
        if (byId[id] != null) byId[id]!,
      for (final s in prior)
        if (!orderedIds.contains(s.id)) s,
    ];
    _lastByServer[base] = reordered;
    // Re-emit the (unchanged) flat list so the dashboard re-groups and re-reads
    // serverOrderIndex — StreamBuilder rebuilds on every event regardless of
    // list identity.
    if (!_sessions.isClosed) _sessions.add(_current);
    try {
      await _clientFor(server).reorderSessions(orderedIds);
    } catch (_) {
      // Next refresh reconciles from the server's authoritative order.
    }
  }

  /// Reorders the pinned favorites (#124): moves [oldIndex] to [newIndex] within
  /// [ordered] (the group as displayed), applies the new ranks optimistically so the
  /// drag lands instantly, then writes each changed session to the server that OWNS
  /// it. Returns the display names of the servers that refused — empty on success.
  ///
  /// Every write is settled, never aborted on the first failure. These are N
  /// independent servers with no transaction across them: rejecting early would
  /// leave the remaining writes in flight and the cluster permanently
  /// half-renumbered, showing an order no server holds and saying nothing. On any
  /// failure the caller reports it and this re-reads server truth.
  Future<List<String>> reorderFavorites(
    List<Session> ordered,
    int oldIndex,
    int newIndex,
  ) async {
    final changes = reorderedFavoriteRanks(ordered, oldIndex, newIndex);
    if (changes.isEmpty) return const <String>[];
    final ranks = <String, int>{for (final c in changes) c.session.id: c.rank};

    Session applied(Session s) =>
        ranks.containsKey(s.id) ? s.withFavoriteRank(ranks[s.id]!) : s;
    _current = <Session>[for (final s in _current) applied(s)];
    // The per-server cache feeds the next re-group; leaving stale ranks there would
    // let the old order reappear the moment anything else triggered a rebuild.
    for (final base in _lastByServer.keys.toList()) {
      _lastByServer[base] = <Session>[for (final s in _lastByServer[base]!) applied(s)];
    }
    _emitSessions();

    final failed = await Future.wait(
      changes.map((c) async {
        try {
          await _clientFor(c.session.server).setFavorite(
            c.session.id,
            true,
            rank: c.rank,
          );
          return null;
        } catch (_) {
          return c.session.server.name;
        }
      }),
    );
    final refused = <String>{for (final name in failed) ?name}.toList();
    if (refused.isNotEmpty) await refresh();
    return refused;
  }

  ApiClient _clientFor(ServerConfig server) {
    final existing = _clients[server.baseUrl];
    // Recreate when the config changed (e.g. the display name was resolved from
    // /api/version) so freshly-tagged sessions carry the up-to-date server.
    if (existing != null && existing.server == server) return existing;
    existing?.close();
    final client = _clientFactory(server);
    _clients[server.baseUrl] = client;
    return client;
  }

  /// Resolves each server's display name AND capability set from
  /// `/api/version`, AND keeps the free machine CPU/memory reading (#152
  /// level 1, #165) current for [ServerResourceLine] via
  /// [ResourceMonitor.publishMachine] — one request answers all three, so
  /// none of it costs anything extra per call.
  ///
  /// Runs on EVERY [refresh] now, not just until "confirmed". Name and
  /// capability resolution used to stop re-fetching once settled (see the
  /// #66 note in the catch below) — that was fine while nothing else needed
  /// this call, but #165 needs the machine reading kept live, and the only
  /// way to do that without a second endpoint is to keep asking. Re-checking
  /// name/capabilities on every call is not a correctness cost:
  /// `updateServerName` no-ops when the name is unchanged, and re-assigning
  /// an unchanged capability flag is a no-op too.
  ///
  /// THROTTLED, though, and that is not an optimisation. [refresh] is NOT a 30s
  /// thing: [_scheduleRefresh] fires it on a 300ms debounce after every
  /// `/ws/notify` event, so while an agent is working an untimed re-fetch would
  /// cost N extra round trips per notify burst — and [refresh] awaits this
  /// before the session list, so the list would queue behind the slowest peer.
  /// Found in review. A server already resolved is re-asked at most every
  /// [_machineReadingMaxAge]; one not yet resolved is asked every time, because
  /// its name and `favorites-sync` capability are still unknown.
  /// Updates the server store in place so the fallback `Shadow` name upgrades
  /// to the real one.
  Future<void> _ensureServerNames() async {
    final now = DateTime.now();
    await Future.wait(_store.servers.map((server) async {
      // Throttled only once a server is FULLY settled — which is the old `confirmed`
      // condition, unchanged: name resolved AND `favorites-sync` confirmed true. A
      // server that does not (yet) support it is still asked on every refresh, because
      // #60 exists to pick the capability up the moment the server is upgraded, with no
      // app restart. Caught by that very test when the throttle was first written
      // without this clause.
      final settled = _namesResolved.contains(server.baseUrl) &&
          (_favoritesSyncSupported[server.baseUrl] ?? false);
      if (settled) {
        final last = _versionFetchedAt[server.baseUrl];
        if (last != null && now.difference(last) < _machineReadingMaxAge) return;
      }
      ServerInfo? info;
      try {
        info = await _clientFor(server).version();
        // A 2xx that is not actually a web-terminal — a squatted `tailscale serve`
        // mount, a captive portal — parses to an EMPTY ServerInfo. Treating that as
        // an authoritative answer would silently drop `favorites-sync` for a server
        // that supports it, and publish a bogus (absent) load reading. Every real
        // server reports a version, so that is the sanity gate. Found in review.
        if (info.version.isEmpty) { info = null; throw StateError('not a web-terminal'); }
        if (info.serverName.isNotEmpty) {
          _store.updateServerName(server.baseUrl, info.serverName);
        }
        _favoritesSyncSupported[server.baseUrl] = info.has('favorites-sync');
        _namesResolved.add(server.baseUrl);
        _versionFetchedAt[server.baseUrl] = now;
      } catch (_) {
        // #66: NOT cleared here on purpose, even though this catch is now
        // reached on every refresh (the old `confirmed` short-circuit that
        // used to skip it entirely is gone — see the doc comment above). A
        // server that once supported favorites-sync and has since gone
        // offline keeps reporting supported here; the actual "star stays
        // enabled while its server is down" case is closed at the decision
        // point instead — see `favoriteToggleAllowed` in
        // dashboard_screen.dart, which gates on live `serverOnline` directly.
      }
      // #152/#165 — published every refresh, success or failure: an
      // unreachable server must go blank (null), never keep showing a load
      // reading from however long ago it was last seen. Mirrors
      // ResourceMonitor.refresh()'s own "overwrite, never keep stale" rule
      // for the expensive per-process poll.
      ResourceMonitor.instance.publishMachine(server.baseUrl, info?.resources);
    }));
  }

  void _scheduleRefresh() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), refresh);
  }

  Future<void> _cacheNames(List<Session> sessions) async {
    if (sessions.isEmpty) return;
    final entries = <String, String>{
      for (final s in sessions) NotificationService.nameCacheKey(s.id): s.name,
    };
    await NotificationService.updateNameCache(entries);
  }

  static int _attentionRank(String status) {
    switch (status) {
      case 'waiting':
        return 0; // approval
      case 'api_error':
        return 1; // apierror
      case 'idle':
        return 2; // done
      default:
        return 3; // none
    }
  }

  static int _statusRank(String status) {
    switch (status) {
      case 'waiting':
        return 0;
      case 'api_error':
        return 1;
      case 'working':
        return 2;
      default:
        return 3;
    }
  }
}
