/// HTTP + WebSocket client for a single web-terminal server.
///
/// One [ApiClient] wraps exactly one [ServerConfig]. Every REST call carries the
/// server's bearer token, uses a 10-second timeout and surfaces failures as a
/// typed [ApiException] — no raw `SocketException`/`TimeoutException` ever
/// escapes. Live streams (`/ws/notify`, `/ws/:id`) are exposed as auto-managed
/// Dart streams.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';

/// Uniform error type for every [ApiClient] operation.
///
/// [status] is the HTTP status code, or `0` for transport-level failures
/// (timeout, DNS, connection refused, malformed response).
class ApiException implements Exception {
  /// HTTP status code, or `0` for a transport/timeout/parse failure.
  final int status;

  /// Human-readable, already-mapped error message safe to show or log.
  final String message;

  /// Creates an API exception.
  const ApiException(this.status, this.message);

  /// True when the failure was transport-level (unreachable/timeout), i.e.
  /// [status] is `0`.
  bool get isTransport => status == 0;

  @override
  String toString() => 'ApiException($status, $message)';
}

/// A stateless client for one server's REST + WebSocket surface.
/// A file name that can actually ride an HTTP header value.
///
/// **This is not tidiness — a raw name FAILS THE WHOLE ATTACH.** `dart:io`'s
/// `HttpHeaders` accepts a value byte only when it is `> 31 && < 128`, and
/// throws `FormatException` before a byte reaches the wire otherwise; the
/// upload's own catch then reports `Server unreachable`, so a Hebrew, accented
/// or emoji file name surfaces as "Could not attach `<name>`" with no hint of the
/// cause. Reproduced against a real loopback server in
/// `test/upload_filename_header_test.dart` — a MockClient never traverses that
/// validation, which is why the drop path (#90) shipped with it unnoticed: the
/// names it meets come from a desktop, and #166 aims the same header at a
/// phone's Downloads folder.
///
/// Encoded ONLY when it has to be. The server slices the name through
/// `safeDropName`, which maps anything outside `[A-Za-z0-9._-]` to `_`, so
/// encoding unconditionally would land `my_20file.pdf` on disk where today's
/// space gives `my_file.pdf`. The encoding is recoverable
/// (`Uri.decodeComponent`), so a server that later wants the real name can have
/// it without a second client release.
String headerSafeFilename(String name) =>
    name.codeUnits.every((c) => c > 31 && c < 128)
        ? name
        : Uri.encodeComponent(name);

class ApiClient {
  /// The server this client talks to.
  final ServerConfig server;

  final http.Client _http;
  static const Duration _timeout = Duration(seconds: 10);
  static const Duration _uploadTimeout = Duration(seconds: 30);

  /// Creates a client for [server]. A custom [httpClient] may be injected for
  /// testing; otherwise a default [http.Client] is used.
  ApiClient(this.server, {http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  /// Exchanges a username + password for a bearer token (#96).
  ///
  /// STATIC, and takes a bare [baseUrl] rather than a [ServerConfig], because
  /// this is what runs when there is no token yet — it is how you GET one. The
  /// server side already exists (`POST /api/auth/token`, rate-limited, no prior
  /// auth), so adding a server by credentials needs no server change at all.
  ///
  /// **The password is used once and never stored.** Only the returned token is
  /// persisted, exactly as if it had been pasted in by hand — so a stolen
  /// device yields a revocable token rather than the account password, and
  /// revoking it server-side (`DELETE /api/auth/tokens/:token`) is enough.
  ///
  /// [label] is what the server records against the token so it can be
  /// recognised and revoked later in the tokens list.
  static Future<String> fetchToken({
    required String baseUrl,
    required String user,
    required String password,
    String label = 'companion',
    http.Client? httpClient,
  }) async {
    final base = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    if (base.isEmpty) throw const ApiException(0, 'Enter a base URL first');
    final client = httpClient ?? http.Client();
    try {
      final res = await client
          .post(
            Uri.parse('$base/api/auth/token'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({
              'user': user,
              'password': password,
              'label': label,
            }),
          )
          .timeout(_timeout);
      if (res.statusCode == 401) {
        throw const ApiException(401, 'Wrong username or password');
      }
      if (res.statusCode == 429) {
        // The server rate-limits failed logins per IP; say so rather than
        // letting it read as bad credentials.
        throw const ApiException(429, 'Too many attempts — wait and retry');
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, 'Server rejected sign-in');
      }
      final body = jsonDecode(res.body);
      final token = (body is Map && body['token'] is String)
          ? body['token'] as String
          : '';
      if (token.isEmpty) {
        throw const ApiException(0, 'Server returned no token');
      }
      return token;
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw const ApiException(0, 'Request timed out');
    } catch (_) {
      throw const ApiException(0, 'Server unreachable');
    } finally {
      if (httpClient == null) client.close();
    }
  }

  /// The peers this server knows about (`GET /api/cluster/servers`) — #97.
  ///
  /// Returns `{name, url, hasToken}` records. `hasToken` is about the SERVER's
  /// own trust in that peer, not ours: a peer the server cannot authenticate to
  /// is one it cannot mint us a token for either, so it is not adoptable yet.
  Future<List<ClusterPeer>> listClusterServers() async {
    final res = await _send('GET', '/api/cluster/servers');
    final body = _decode(res);
    if (body is! List) return const <ClusterPeer>[];
    return [
      for (final e in body)
        if (e is Map<String, dynamic>)
          ClusterPeer(
            name: (e['name'] ?? '').toString(),
            url: (e['url'] ?? '').toString(),
            hasToken: e['hasToken'] == true,
          ),
    ];
  }

  /// Asks this server to obtain a token for peer [url] on our behalf (#97).
  ///
  /// The server spends the cluster trust it already holds for that peer to have
  /// the peer mint a FRESH token for this device — so what we store is revocable
  /// on its own, rather than a copy of the server-to-server credential.
  Future<String> requestClientToken({
    required String url,
    String label = 'companion',
  }) async {
    final res = await _send('POST', '/api/cluster/client-token',
        body: {'url': url, 'label': label});
    final body = _decode(res);
    final token =
        (body is Map && body['token'] is String) ? body['token'] as String : '';
    if (token.isEmpty) throw const ApiException(0, 'Server returned no token');
    return token;
  }

  // --- REST ---------------------------------------------------------------

  /// Fetches this server's sessions (`GET /api/sessions`), each tagged with
  /// [server].
  Future<List<Session>> listSessions() async {
    final res = await _send('GET', '/api/sessions');
    final body = _decode(res);
    if (body is! List) {
      throw const ApiException(0, 'Malformed sessions response');
    }
    return body
        .whereType<Map<String, dynamic>>()
        .map((j) => Session.fromJson(server, j))
        .toList(growable: false);
  }

  /// Reads server version + capabilities (`GET /api/version`).
  Future<ServerInfo> version() async {
    final res = await _send('GET', '/api/version');
    return ServerInfo.fromJson(_asMap(_decode(res)));
  }

  /// Reads this server's CPU/memory detail (`GET /api/resources`, #152).
  ///
  /// Three levels in one answer: the machine, web-terminal's own footprint on
  /// it, and a reading per live session. It is deliberately NOT part of the
  /// session poll — the server has to run a whole-machine process query
  /// (~370 ms) to answer, so it is fetched only while a resources view is
  /// actually being looked at.
  ///
  /// Returns `null` rather than throwing on any failure — an unreachable
  /// server, a malformed body, or a server too old to have the endpoint. The
  /// caller renders `null` as "unknown", which is the honest reading in all
  /// three cases; a thrown exception here would only turn a missing number
  /// into a broken screen.
  Future<ServerResources?> resources() async {
    try {
      // Its own, longer deadline. The server's worst case here is not the usual one:
      // a cold cache costs a settle delay plus TWO whole-machine process queries, and
      // on a loaded box that can pass ten seconds. Timing out under the server's own
      // worst case would leave the view permanently unknown on exactly the busiest
      // machine — the one it exists to identify — while the server kept paying for
      // work nobody ever read. Overlapping polls are already dropped by
      // ResourceMonitor, so a long wait here stacks nothing up.
      final res = await _send('GET', '/api/resources',
          timeout: const Duration(seconds: 25));
      return ServerResources.fromJson(_asMap(_decode(res)));
    } catch (_) {
      return null;
    }
  }

  /// Reads this server's runtime defaults (`GET /api/config`).
  ///
  /// Only the [ServerRuntimeConfig] subset is surfaced; auth/cluster/tuning keys
  /// in the response are ignored. The server masks the password as `***`.
  Future<ServerRuntimeConfig> serverConfig() async {
    final res = await _send('GET', '/api/config');
    return ServerRuntimeConfig.fromJson(_asMap(_decode(res)));
  }

  /// Fetches the AI CLI agents this server can launch a session with
  /// (`GET /api/agents`), for the New Session sheet's agent picker.
  ///
  /// Best-effort: any failure (unreachable server, malformed body, an older
  /// server without the endpoint) yields an empty list rather than throwing —
  /// a picker that can't load extra agents must still let "Auto" through, so a
  /// failure here can never block session creation.
  Future<List<AgentInfo>> agents() async {
    try {
      final res = await _send('GET', '/api/agents');
      final list = _asMap(_decode(res))['agents'];
      if (list is! List) return const <AgentInfo>[];
      return list
          .whereType<Map<String, dynamic>>()
          .map(AgentInfo.fromJson)
          .toList(growable: false);
    } catch (_) {
      return const <AgentInfo>[];
    }
  }

  /// Fetches the per-command lens policy (`GET /api/commands`, #131) — which
  /// slash commands write something the chat lens can render, and which are TUI
  /// paint only.
  ///
  /// Best-effort like [agents]: an older server without the endpoint yields an
  /// empty list and the client falls back to its own built-in table, so a slash
  /// command never depends on this call succeeding.
  Future<List<Map<String, dynamic>>> commandPolicy() async {
    try {
      final res = await _send('GET', '/api/commands');
      final list = _asMap(_decode(res))['commands'];
      if (list is! List) return const <Map<String, dynamic>>[];
      return list.whereType<Map<String, dynamic>>().toList(growable: false);
    } catch (_) {
      return const <Map<String, dynamic>>[];
    }
  }

  /// Lists the folders offered in the New Session picker
  /// (`GET /api/history/folders`).
  ///
  /// The response is a **flat JSON array of absolute path strings**. This is a
  /// live, per-server filesystem scan performed on every request — never cache
  /// the result client-side. A `Cache-Control: no-store` header is sent so no
  /// intermediary caches it either.
  Future<List<String>> folders() async {
    final res = await _send('GET', '/api/history/folders',
        extraHeaders: const {'Cache-Control': 'no-store'});
    final body = _decode(res);
    if (body is! List) {
      throw const ApiException(0, 'Malformed folders response');
    }
    return body.map((e) => e.toString()).toList(growable: false);
  }

  /// Reads the structured attention record for [sessionId]
  /// (`GET /api/sessions/:id/attention`).
  Future<AttentionInfo> attention(String sessionId) async {
    final res = await _send('GET', '/api/sessions/$sessionId/attention');
    return AttentionInfo.fromJson(_asMap(_decode(res)));
  }

  /// Clears a session's attention across every device (issue #24): the server
  /// flips the recorded attention to cleared, fans out an FCM 'clear' so phones
  /// dismiss their OS notification, and broadcasts a 'clear' notify frame so
  /// other in-app viewers drop the chip. Called when the session is opened/viewed
  /// or its chip is dismissed. Idempotent server-side.
  Future<void> clearAttention(String sessionId) async {
    await _send('POST', '/api/sessions/$sessionId/attention/clear', body: {});
  }

  /// Reads the per-session push level (`GET /api/sessions/:id/notify-level`),
  /// one of `off` / `important` / `all`.
  Future<String> notifyLevel(String sessionId) async {
    final res = await _send('GET', '/api/sessions/$sessionId/notify-level');
    return (_asMap(_decode(res))['level'] ?? 'important').toString();
  }

  /// Sets the per-session push level (`PATCH /api/sessions/:id/notify-level`).
  Future<void> setNotifyLevel(String sessionId, String level) async {
    await _send('PATCH', '/api/sessions/$sessionId/notify-level',
        body: {'level': level});
  }

  /// Turns the 5-hour auto-resume off (or back on) for one session
  /// (`PATCH /api/sessions/:id/auto-resume`, issue #137).
  ///
  /// Server-side state, like the notify level above and for the same reason: it
  /// is a property OF THE SESSION, so every device reads one truth rather than
  /// each keeping a local flag. The result rides back on the next session poll
  /// as `usageLimit.enabled` — this client stores nothing.
  ///
  /// A server too old for the route 404s; the caller only offers the control when
  /// the session actually carries a `usageLimit`, which such a server never sends.
  Future<void> setAutoResume(String sessionId, bool enabled) async {
    await _send('PATCH', '/api/sessions/$sessionId/auto-resume',
        body: {'enabled': enabled});
  }

  /// Sets or clears [sessionId]'s pin (`PATCH /api/sessions/:id/favorite`,
  /// issue #60).
  ///
  /// [rank] is only ever sent for an explicit reorder (this client has none —
  /// it's a web-only affordance today). Omit it to pin: the OWNING server then
  /// assigns a monotonic wall-clock rank itself (`nextFavoriteRank` there), so
  /// no client ever has to guess a position from the partial set of peers it
  /// can currently see. The `rank` key is omitted from the request entirely
  /// when null — sending it as JSON `null` fails the server's validation
  /// (`rank !== undefined` — a bare `{favorite:true}` is what "just assign
  /// one" means on the wire).
  ///
  /// This is the ONLY write path for a favorite — there is no local list to
  /// keep in sync. Call only after confirming the owning server advertises
  /// the `favorites-sync` capability (`ServerInfo.has`); an older server
  /// without the route 404s, so never fire this blind.
  Future<void> setFavorite(String sessionId, bool favorite, {int? rank}) async {
    final body = favorite
        ? (rank == null ? {'favorite': true} : {'favorite': true, 'rank': rank})
        : {'favorite': false};
    await _send('PATCH', '/api/sessions/$sessionId/favorite', body: body);
  }

  /// Registers this device's FCM [fcmToken] with the server
  /// (`POST /api/push/devices`) so it receives content-free wake-up pushes.
  Future<void> registerDevice(
    String fcmToken, {
    String deviceName = 'S25',
    String platform = 'android',
  }) async {
    await _send('POST', '/api/push/devices', body: {
      'fcmToken': fcmToken,
      'deviceName': deviceName,
      'platform': platform,
    });
  }

  /// Creates a new session (`POST /api/sessions`).
  ///
  /// The create endpoint returns only `{id, name}`, so the returned [Session] is
  /// partially populated: [Session.cwd] echoes the requested [cwd] (or empty),
  /// [Session.status] defaults to `idle` and [Session.notifyLevel] to
  /// `important`. Call [listSessions] to get the fully-resolved record.
  ///
  /// [agent] selects the AI CLI provider (`claude`/`codex`/…) to launch;
  /// omit it to let the server infer from [autoCommand]. Sent only when
  /// non-null, so older servers without agent support never see the field.
  Future<Session> createSession({
    String? name,
    String? cwd,
    String? autoCommand,
    String? agent,
  }) async {
    final params = <String, String>{};
    if (name != null) params['name'] = name;
    if (cwd != null) params['cwd'] = cwd;
    if (autoCommand != null) params['autoCommand'] = autoCommand;
    if (agent != null) params['agent'] = agent;
    final res = await _send('POST', '/api/sessions', body: params);
    final j = _asMap(_decode(res));
    // The server resolves the agent it actually recorded — the explicit pick, else
    // inferred from the command — and that is what [listSessions] will report. An
    // older server echoes only an explicit pick, so fall back to the request.
    final served = j['agent'];
    return Session(
      id: (j['id'] ?? '').toString(),
      name: (j['name'] ?? name ?? '').toString(),
      cwd: cwd ?? '',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      autoCommand: autoCommand ?? '',
      server: server,
      // The server's answer wins. Taking the REQUEST instead left this null for
      // every session created with the picker on Auto, and the screen opened from
      // this object keeps it — so the Chat lens stayed shut until a re-select
      // replaced it with the list's copy (#119).
      agent: served is String && served.isNotEmpty ? served : agent,
      // #147 — the SAME trap as `agent` one line up, found in review of #150.
      // This object is what SessionScreen opens with, and the sessions stream is
      // broadcast with no replay, so it stands until the next poll — a booting
      // agent sends no notify frame to cut that short. Defaulting to `true` here
      // left the submit gate open for the whole boot window on a freshly created
      // session, which is precisely the flow that was reported.
      agentReady: j['agentReady'] != false,
    );
  }

  /// Renames a session (`PATCH /api/sessions/:id`).
  Future<void> renameSession(String sessionId, String name) async {
    await _send('PATCH', '/api/sessions/$sessionId', body: {'name': name});
  }

  /// Persists a new session display order on the server
  /// (`POST /api/sessions/order`).
  ///
  /// [orderedIds] is the full session-id list in the desired order. The server
  /// caps it at 1000 ids of ≤64 chars each; violations surface as an
  /// [ApiException] with status `400`.
  Future<void> reorderSessions(List<String> orderedIds) async {
    await _send('POST', '/api/sessions/order', body: {'orderedIds': orderedIds});
  }

  /// Kills a session (`DELETE /api/sessions/:id`).
  Future<void> killSession(String sessionId) async {
    await _send('DELETE', '/api/sessions/$sessionId');
  }

  /// Fetches a ranged slice of sanitized scrollback
  /// (`GET /api/sessions/:id/scrollback`).
  Future<ScrollbackChunk> scrollback(
    String sessionId, {
    int? offset,
    int? limit,
  }) async {
    final q = <String, String>{
      if (offset != null) 'offset': '$offset',
      if (limit != null) 'limit': '$limit',
    };
    final res = await _send('GET', '/api/sessions/$sessionId/scrollback',
        query: q.isEmpty ? null : q);
    return ScrollbackChunk.fromJson(_asMap(_decode(res)));
  }

  /// Fetches one backward-paginated page of a session's structured transcript
  /// (`GET /api/sessions/:id/transcript`).
  ///
  /// Turns come back newest-last. Omit [before] for the newest page (the last
  /// [limit] turns; default 50, server-capped at 200); pass the previous page's
  /// [TranscriptPage.cursor] as [before] to fetch the *older* page. Stop when
  /// the returned cursor is `null`.
  ///
  /// Throws [ApiException] with status `404` when the session has no transcript
  /// (a shell/terminal-only session), or `400` for a bad cursor/limit.
  Future<TranscriptPage> transcript(
    String sessionId, {
    String? before,
    int? limit,
  }) async {
    final q = <String, String>{};
    if (before != null) q['before'] = before;
    if (limit != null) q['limit'] = '$limit';
    final res = await _send('GET', '/api/sessions/$sessionId/transcript',
        query: q.isEmpty ? null : q);
    return TranscriptPage.fromJson(_asMap(_decode(res)));
  }

  /// Fetches a session's recap (`GET /api/sessions/:id/recap`) — the answer to
  /// *"where was I in this one?"*: the last prompt the USER typed, the agent's
  /// latest word, the task it is on, and the work done since.
  ///
  /// Every judgement is the server's (`lib/recap.js`) — in particular *which*
  /// `role:user` turn was actually typed by a human, which is emphatically not
  /// "the newest one": slash commands, task-notifications and teammate messages
  /// all arrive as user turns. This client must not second-guess it.
  ///
  /// Never 404s for a live session: one with no transcript still returns
  /// name/cwd/status with null prompt/reply. A `404` means the session id is
  /// unknown; older servers (< 1.57.0) also 404 the route itself.
  Future<SessionRecap> recap(String sessionId) async {
    final res = await _send('GET', '/api/sessions/$sessionId/recap');
    return SessionRecap.fromJson(_asMap(_decode(res)));
  }

  /// Fetches the agent's last answer reduced to a speakable utterance
  /// (`GET /api/sessions/:id/speech`, #70).
  ///
  /// The SERVER decides what is worth saying — it strips code blocks, tables,
  /// URLs and tool plumbing from the newest assistant prose turn. This client
  /// must not second-guess that: an **empty** string is the normal answer for
  /// "the last turns were tool calls or pure code" and means *stay silent*,
  /// never fall back to raw transcript text.
  ///
  /// Throws [ApiException] with status `404` when the session has no transcript
  /// (a shell-only session), or when the server predates 1.42.0.
  Future<String> speech(String sessionId) async {
    final res = await _send('GET', '/api/sessions/$sessionId/speech');
    final m = _asMap(_decode(res));
    final t = m['text'];
    return t is String ? t : '';
  }

  /// Fetches one backward-paginated page of a *subagent's* transcript from
  /// `GET /api/sessions/:id/subagent/:toolUseId`.
  ///
  /// [toolUseId] is the id of the `Task` tool_use that spawned the subagent (from
  /// a [ToolUse.subagent] stub). Same pagination contract as [transcript]: turns
  /// newest-last, omit [before] for the newest page, pass the previous page's
  /// cursor to page older. Throws [ApiException] `404` when that tool_use has no
  /// subagent trace, or `400` for a bad cursor/limit.
  Future<SubagentPage> subagent(
    String sessionId,
    String toolUseId, {
    String? before,
    int? limit,
  }) async {
    final q = <String, String>{};
    if (before != null) q['before'] = before;
    if (limit != null) q['limit'] = '$limit';
    final res = await _send(
        'GET', '/api/sessions/$sessionId/subagent/${Uri.encodeComponent(toolUseId)}',
        query: q.isEmpty ? null : q);
    return SubagentPage.fromJson(_asMap(_decode(res)));
  }

  /// Fetches the session's pending interactive question (Claude's
  /// AskUserQuestion) from `GET /api/sessions/:id/pending-question`, or `null`
  /// when nothing is pending. A `404` (no transcript) is treated as "none"
  /// rather than an error — a plain shell session simply never has one.
  Future<PendingQuestion?> pendingQuestion(String sessionId) async {
    try {
      final res =
          await _send('GET', '/api/sessions/$sessionId/pending-question');
      return PendingQuestion.fromJson(_asMap(_decode(res)));
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }

  /// Uploads raw image [bytes] to `POST /api/clipboard-image` and returns the
  /// exact string to feed into the session's terminal.
  ///
  /// The server saves the image to its own disk and returns an absolute
  /// server-side file path; Claude Code detects an absolute image path pasted
  /// into the PTY and reads the file directly. The returned string is that path
  /// wrapped in bracketed-paste markers (`ESC[200~ … ESC[201~`), ready to hand
  /// straight to [TerminalConnection.sendInput] — exactly what the web UI sends.
  ///
  /// The endpoint expects **raw bytes** (not base64/JSON) with an `image/*`
  /// [mime]; a non-image [mime] is rejected before the request. [sessionId] is
  /// accepted for API symmetry but is unused — the endpoint is server-global and
  /// this client is already bound to the correct server.
  Future<String> uploadClipboardImage(
    String sessionId,
    List<int> bytes, {
    String mime = 'image/png',
  }) async {
    if (!mime.startsWith('image/')) {
      throw ApiException(0, 'mime must be an image type, got "$mime"');
    }
    final uri = Uri.parse('${server.baseUrl}/api/clipboard-image');
    try {
      final res = await _http
          .post(
            uri,
            headers: {
              'Authorization': 'Bearer ${server.bearerToken}',
              'Content-Type': mime,
            },
            body: bytes,
          )
          .timeout(_uploadTimeout);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, _errorMessage(res));
      }
      final j = _asMap(_decode(res));
      final path = (j['path'] ?? '').toString();
      if (j['ok'] != true || path.isEmpty) {
        throw const ApiException(0, 'Image upload failed');
      }
      return '\x1b[200~$path\x1b[201~';
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw const ApiException(0, 'Request timed out');
    } catch (_) {
      throw const ApiException(0, 'Server unreachable');
    }
  }

  /// The largest body `POST /api/upload-file` will accept.
  ///
  /// The SERVER owns this number (`express.raw({ limit: '50mb' })` in
  /// `server.js`); this is a copy so the client can refuse a file before
  /// spending minutes of a phone's data earning a 413. The drift guard lives in
  /// `test/mobile_file_attach_test.dart` ("the limit tracks the SERVER") — it
  /// reads server.js's own line and goes red if the two ever disagree.
  static const int uploadLimitBytes = 50 * 1024 * 1024;

  /// Uploads an arbitrary DROPPED file (#90) and returns its path on the
  /// SERVER's disk.
  ///
  /// Unlike [uploadClipboardImage] this takes any content type, because a drop
  /// is whatever the user grabbed in Explorer. The bytes have to travel for the
  /// same reason: the agent runs on the server, so the dropping device's own path
  /// would name a file the agent cannot open on a remote cluster session.
  ///
  /// Returns the bare path (no bracketed-paste wrapper) — the caller stages it as
  /// an attachment and the existing submit path adds the wrapper, so there is
  /// still exactly one place that decides how an attachment reaches the PTY.
  Future<String> uploadDroppedFile(List<int> bytes, {required String filename}) async {
    final uri = Uri.parse('${server.baseUrl}/api/upload-file');
    try {
      final res = await _http
          .post(
            uri,
            headers: {
              'Authorization': 'Bearer ${server.bearerToken}',
              'Content-Type': 'application/octet-stream',
              // Sanitised server-side — it is joined onto a path there.
              'X-Filename': headerSafeFilename(filename),
            },
            body: bytes,
          )
          .timeout(_uploadTimeout);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, _errorMessage(res));
      }
      final j = _asMap(_decode(res));
      final path = (j['path'] ?? '').toString();
      if (j['ok'] != true || path.isEmpty) {
        throw const ApiException(0, 'File upload failed');
      }
      return path;
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw const ApiException(0, 'Request timed out');
    } catch (_) {
      throw const ApiException(0, 'Server unreachable');
    }
  }

  // --- WebSocket ----------------------------------------------------------

  /// A broadcast stream of `/ws/notify` events for this server.
  ///
  /// The socket is opened when the stream gains its first listener and closed
  /// when the last listener cancels. While listened, it auto-reconnects with
  /// exponential backoff (1s → 30s, reset on a successful connect).
  Stream<NotifyEvent> notifyStream() => _NotifyConnection(server).stream;

  /// Opens a live terminal WebSocket (`/ws/:id`) for [sessionId]. The caller
  /// owns the returned [TerminalConnection] and must [TerminalConnection.close]
  /// it when done.
  ///
  /// Pass [cols]/[rows] — the size the view is ALREADY laid out at — so the PTY
  /// learns this client's size in the connect handshake (#59). A PTY has one
  /// size shared by every viewer, so a connection that never states its own
  /// inherits whatever the last viewer set: a phone attaching to a session a
  /// desktop is watching then renders desktop-width output, torn, until some
  /// unrelated relayout happens to fire a resize.
  TerminalConnection openTerminal(String sessionId, {int? cols, int? rows}) =>
      TerminalConnection(server, sessionId, cols: cols, rows: rows);

  /// Closes the underlying HTTP client. Call when this client is discarded.
  void close() => _http.close();

  // --- internals ----------------------------------------------------------

  Future<http.Response> _send(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
    Map<String, String>? extraHeaders,
    Duration? timeout,
  }) async {
    // Per-call deadline, defaulting to the shared one. Only /api/resources sets it.
    final deadline = timeout ?? _timeout;
    var uri = Uri.parse('${server.baseUrl}$path');
    if (query != null) uri = uri.replace(queryParameters: query);
    final headers = <String, String>{
      'Authorization': 'Bearer ${server.bearerToken}',
      if (body != null) 'Content-Type': 'application/json',
      ...?extraHeaders,
    };
    final payload = body == null ? null : jsonEncode(body);
    try {
      final http.Response res;
      switch (method) {
        case 'GET':
          res = await _http.get(uri, headers: headers).timeout(deadline);
        case 'POST':
          res = await _http
              .post(uri, headers: headers, body: payload)
              .timeout(deadline);
        case 'PATCH':
          res = await _http
              .patch(uri, headers: headers, body: payload)
              .timeout(deadline);
        case 'DELETE':
          res = await _http
              .delete(uri, headers: headers, body: payload)
              .timeout(deadline);
        default:
          throw ApiException(0, 'Unsupported method $method');
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, _errorMessage(res));
      }
      return res;
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw const ApiException(0, 'Request timed out');
    } catch (_) {
      throw const ApiException(0, 'Server unreachable');
    }
  }

  /// Decodes a JSON response body, or throws a typed parse error.
  static dynamic _decode(http.Response res) {
    if (res.body.isEmpty) return const <String, dynamic>{};
    try {
      return jsonDecode(res.body);
    } catch (_) {
      throw const ApiException(0, 'Malformed server response');
    }
  }

  static Map<String, dynamic> _asMap(dynamic v) =>
      v is Map<String, dynamic> ? v : const <String, dynamic>{};

  /// Maps a non-2xx response to a friendly message: the body's `error` field
  /// when present, otherwise a code-based fallback.
  static String _errorMessage(http.Response res) {
    try {
      final j = jsonDecode(res.body);
      if (j is Map && j['error'] != null) return j['error'].toString();
    } catch (_) {/* fall through */}
    switch (res.statusCode) {
      case 401:
        return 'Wrong username or password';
      case 404:
        return 'Not found';
      case 429:
        return 'Too many attempts';
      default:
        return res.statusCode >= 500
            ? 'Server error (${res.statusCode})'
            : 'Request failed (${res.statusCode})';
    }
  }
}

/// Minimal transport abstraction behind [TerminalConnection], so its
/// reconnect / heartbeat / input-buffer logic can be unit-tested with a fake
/// socket. The default implementation wraps a [WebSocketChannel].
abstract class TerminalSocket {
  /// Completes when the socket is connected, or throws if the connect fails.
  Future<void> get ready;

  /// Inbound frames from the server (each `String` or `List<int>`).
  Stream<dynamic> get stream;

  /// Sends a frame to the server (a `String` of keystrokes or a JSON control
  /// frame).
  void add(Object data);

  /// Closes the socket.
  Future<void> close();
}

/// Creates a [TerminalSocket] for a `/ws/:id` URI.
typedef TerminalSocketFactory = TerminalSocket Function(Uri uri);

TerminalSocket _defaultTerminalSocketFactory(Uri uri) =>
    _WebSocketTerminalSocket(WebSocketChannel.connect(uri));

class _WebSocketTerminalSocket implements TerminalSocket {
  _WebSocketTerminalSocket(this._ch);
  final WebSocketChannel _ch;

  @override
  Future<void> get ready => _ch.ready;

  @override
  Stream<dynamic> get stream => _ch.stream;

  @override
  void add(Object data) => _ch.sink.add(data);

  @override
  Future<void> close() async {
    try {
      await _ch.sink.close();
    } catch (_) {/* ignore */}
  }
}

/// A live, self-healing connection to one session's `/ws/:id` terminal socket.
///
/// Server text/binary frames are surfaced as UTF-8 strings on [output].
/// The connection maintains itself: it heartbeats every 25s, and on an
/// unexpected drop it auto-reconnects with 0.5s→1s→2s→4s backoff (reset on
/// success), replaying the last `mode`/`resize` and flushing any input typed
/// while offline.
///
/// **[connected] semantics (important for the UI):** `true` is emitted on a
/// successful (re)connect; `false` is emitted only after a reconnect *attempt*
/// has failed — a brief blip that reconnects immediately never emits `false`,
/// so the UI won't flicker. The UI should *still* debounce ~3–4s before showing
/// any "reconnecting" banner.
///
/// **[reconnected]** fires once per successful reconnect (never on the first
/// connect), emitted *before* the replayed scrollback lands on [output]. The UI
/// must clear its terminal buffer on this event, otherwise the server's
/// on-attach scrollback replay duplicates history.
///
/// **[sessionTaken]** becomes `true` if the server reports the session was
/// opened elsewhere. That is a terminal state: `connected == false` is emitted
/// immediately, the heartbeat stops and auto-reconnect is disabled (so the app
/// isn't kicked in a loop). The UI shows an "opened elsewhere — Retake" prompt
/// and, to retake, [close]s and re-opens the connection.
class TerminalConnection {
  final ServerConfig _server;
  final String _sessionId;
  final String _browserId = _randomId();
  final TerminalSocketFactory _socketFactory;
  final List<Duration> _backoff;
  final Duration _heartbeatInterval;

  final StreamController<String> _output = StreamController<String>.broadcast();
  final StreamController<bool> _connected = StreamController<bool>.broadcast();
  final StreamController<void> _reconnected =
      StreamController<void>.broadcast();

  static const int _inputBufferCap = 8192; // bound on ACCUMULATED offline input (bytes)
  // Offline input is buffered as WHOLE writes, never split. A single sendInput — e.g. a
  // long compose submit made in the reconnect window after the app foregrounds — is
  // flushed intact or not at all: truncating it mid-content used to hand a half-prompt to
  // the agent (#63, "long prompt cut, tail missing"). The cap bounds ACCUMULATION during a
  // sustained outage by evicting the OLDEST whole writes; it never cuts the newest submit,
  // so a lone write that itself exceeds the cap still survives whole.
  final List<String> _inputWrites = <String>[];
  int _inputBufferLen = 0;

  TerminalSocket? _socket;
  StreamSubscription? _sub;
  Timer? _heartbeatTimer;
  Timer? _reconnectTimer;

  bool _closed = false;
  bool _live = false; // a ready socket is currently attached
  bool _everConnected = false; // at least one successful connect happened
  bool _takenOver = false; // server said the session was opened elsewhere
  bool? _lastConnectedEmitted; // dedupe [connected]
  int _attempt = 0; // backoff index

  String? _lastMode; // last setMode, replayed on reconnect
  int? _lastCols;
  int? _lastRows;

  /// Opens the terminal socket for [sessionId] on [server].
  ///
  /// [cols]/[rows] seed the size this client renders at, so it is stated in the
  /// CONNECT HANDSHAKE rather than whenever a relayout next happens to fire
  /// (#59). They are the same fields [resize] writes, so a later real resize
  /// simply supersedes them, and both the reconnect replay and the proxy's
  /// `requestResize` can answer with a size from the very first socket.
  ///
  /// [socketFactory], [reconnectBackoff] and [heartbeatInterval] are injectable
  /// for testing; production callers use the defaults via
  /// [ApiClient.openTerminal].
  TerminalConnection(
    this._server,
    this._sessionId, {
    int? cols,
    int? rows,
    TerminalSocketFactory? socketFactory,
    List<Duration>? reconnectBackoff,
    Duration heartbeatInterval = const Duration(seconds: 25),
  })  : _lastCols = cols,
        _lastRows = rows,
        _socketFactory = socketFactory ?? _defaultTerminalSocketFactory,
        _backoff = reconnectBackoff ??
            const [
              Duration(milliseconds: 500),
              Duration(seconds: 1),
              Duration(seconds: 2),
              Duration(seconds: 4),
            ],
        // A named param can't start with '_', so no initializing formal here.
        // ignore: prefer_initializing_formals
        _heartbeatInterval = heartbeatInterval {
    _connect();
  }

  /// Terminal output as UTF-8 text (server → client).
  Stream<String> get output => _output.stream;

  /// Connection state. See the class doc for the no-flicker semantics.
  Stream<bool> get connected => _connected.stream;

  /// Fires after each successful reconnect (not the first connect), before the
  /// replayed scrollback reaches [output]. Clear the terminal buffer on this.
  Stream<void> get reconnected => _reconnected.stream;

  /// Whether the server reported this session was opened elsewhere.
  ///
  /// When `true` the connection is in a permanently-stopped state: it has
  /// emitted `connected == false`, stopped heartbeating and will **not**
  /// auto-reconnect (reconnecting would just be kicked again). This is the
  /// precise, immediate signal for an "opened elsewhere — Retake" prompt; to
  /// retake, [close] this connection and open a fresh one via
  /// [ApiClient.openTerminal].
  bool get sessionTaken => _takenOver;

  /// Sends raw keystrokes/input to the PTY (client → server). While
  /// disconnected, input is buffered (up to 8KB) and flushed on reconnect.
  void sendInput(String data) {
    if (_closed) return;
    if (_live && _socket != null) {
      _socket!.add(data);
    } else {
      _bufferInput(data);
    }
  }

  /// Requests a PTY resize to [cols]×[rows]. The size is remembered and
  /// re-sent automatically after a reconnect.
  void resize(int cols, int rows) {
    _lastCols = cols;
    _lastRows = rows;
    _sendControl({
      'resize': {'cols': cols, 'rows': rows}
    });
  }

  /// Declares this client's mode: `active` (foreground, receives focus) or
  /// `background`. The mode is remembered and re-declared after a reconnect.
  void setMode(String mode) {
    _lastMode = mode;
    _sendControl({'mode': mode, 'browserId': _browserId});
  }

  /// Closes the socket, stops reconnecting, and closes all streams. Idempotent.
  void close() {
    if (_closed) return;
    _closed = true;
    _live = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    _teardownSocket();
    _output.close();
    _connected.close();
    _reconnected.close();
  }

  // --- internals ----------------------------------------------------------

  void _sendControl(Map<String, dynamic> frame) {
    if (_live && _socket != null) {
      try {
        _socket!.add(jsonEncode(frame));
      } catch (_) {/* replayed on reconnect */}
    }
    // When offline the frame is state (_lastMode/_lastCols) and is replayed on
    // reconnect, so nothing to buffer here.
  }

  void _bufferInput(String data) {
    if (data.isEmpty) return;
    _inputWrites.add(data); // buffer the write WHOLE — never split (#63)
    _inputBufferLen += data.length;
    // Stay bounded by dropping whole OLDEST writes, but never evict the newest write:
    // a single submit that alone exceeds the cap must still flush intact.
    while (_inputBufferLen > _inputBufferCap && _inputWrites.length > 1) {
      _inputBufferLen -= _inputWrites.removeAt(0).length;
    }
  }

  void _flushInput() {
    if (_inputWrites.isEmpty) return;
    final socket = _socket;
    // Flush only onto a socket that exists, and CLEAR ONLY AFTER the write lands.
    //
    // This used to clear first and then `_socket?.add(pending)` inside a bare
    // `catch (_) {}`. Both halves of that silently destroyed input: if the socket had
    // gone (dropped between `await socket.ready` and here, or torn down by a racing
    // reconnect) the `?.` made the send a no-op, and if `add` threw on a closing
    // socket the throw was swallowed — either way the buffer had already been
    // emptied, so there was nothing left to retry and no error anywhere. Keeping the
    // buffer until the write succeeds means a failed flush is retried by the next
    // one instead of costing the user their prompt.
    if (socket == null) return;
    final pending = _inputWrites.join();
    try {
      socket.add(pending);
    } catch (_) {
      return; // still buffered — the next flush retries it
    }
    _inputWrites.clear();
    _inputBufferLen = 0;
  }

  Future<void> _connect() async {
    if (_closed || _takenOver) return;
    late final TerminalSocket socket;
    try {
      socket = _socketFactory(_wsUri(_server, '/ws/$_sessionId'));
      _socket = socket;
      await socket.ready;
    } catch (_) {
      _onAttemptFailed();
      return;
    }
    if (_closed || _takenOver) {
      socket.close();
      return;
    }

    _live = true;
    _attempt = 0;
    _emitConnected(true);

    final wasReconnect = _everConnected;
    _everConnected = true;
    // Emit BEFORE forwarding any output so the UI clears before the replay.
    if (wasReconnect && !_reconnected.isClosed) _reconnected.add(null);

    // Restore session-scoped state onto the fresh socket.
    if (_lastMode != null) {
      socket.add(jsonEncode({'mode': _lastMode, 'browserId': _browserId}));
    }
    if (_lastCols != null && _lastRows != null) {
      socket.add(jsonEncode({
        'resize': {'cols': _lastCols, 'rows': _lastRows}
      }));
    }
    _flushInput();
    _startHeartbeat();

    _sub = socket.stream.listen(
      _onData,
      onError: (_) => _onSocketDropped(),
      onDone: _onSocketDropped,
      cancelOnError: true,
    );
  }

  void _onData(dynamic data) {
    if (data is String) {
      // Filter JSON control frames the server may send inline.
      if (data.startsWith('{"heartbeat":')) return;
      if (data.startsWith('{"sessionTaken"')) {
        _onTakenOver();
        return;
      }
      if (data.startsWith('{"requestResize"')) {
        if (_live && _lastCols != null && _lastRows != null) {
          _socket?.add(jsonEncode({
            'resize': {'cols': _lastCols, 'rows': _lastRows}
          }));
        }
        return;
      }
      if (!_output.isClosed) _output.add(data);
    } else if (data is List<int>) {
      if (!_output.isClosed) _output.add(utf8.decode(data, allowMalformed: true));
    }
  }

  /// A previously-live socket dropped unexpectedly. Do NOT emit `false` yet —
  /// try to reconnect; only a failed attempt surfaces disconnection.
  void _onSocketDropped() {
    if (_closed || _takenOver || !_live) return;
    _live = false;
    _stopHeartbeat();
    _teardownSocket();
    _scheduleReconnect();
  }

  /// A connect attempt (initial or reconnect) failed. Surface disconnection and
  /// keep retrying with backoff.
  void _onAttemptFailed() {
    if (_closed || _takenOver) return;
    _live = false;
    _stopHeartbeat();
    _teardownSocket();
    _emitConnected(false);
    _scheduleReconnect();
  }

  /// The server reported the session was opened elsewhere (`sessionTaken`).
  /// Reconnecting would just get kicked again, so stop permanently.
  void _onTakenOver() {
    _takenOver = true;
    _live = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    _teardownSocket();
    _emitConnected(false);
  }

  void _scheduleReconnect() {
    if (_closed || _takenOver) return;
    _reconnectTimer?.cancel();
    final delay = _backoff[_attempt < _backoff.length ? _attempt : _backoff.length - 1];
    _attempt++;
    _reconnectTimer = Timer(delay, () {
      _reconnectTimer = null;
      _connect();
    });
  }

  void _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (_live) {
        try {
          _socket?.add('{"heartbeat":true}');
        } catch (_) {/* ignore */}
      }
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _emitConnected(bool value) {
    if (_lastConnectedEmitted == value) return;
    _lastConnectedEmitted = value;
    if (!_connected.isClosed) _connected.add(value);
  }

  void _teardownSocket() {
    _sub?.cancel();
    _sub = null;
    final s = _socket;
    _socket = null;
    if (s != null) unawaited(s.close());
  }
}

/// Manages the auto-reconnecting `/ws/notify` broadcast stream for one server.
class _NotifyConnection {
  _NotifyConnection(this._server);

  final ServerConfig _server;
  final StreamController<NotifyEvent> _controller =
      StreamController<NotifyEvent>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _retry;
  bool _active = false;
  int _attempt = 0;

  Stream<NotifyEvent> get stream {
    _controller.onListen = _start;
    _controller.onCancel = _stop;
    return _controller.stream;
  }

  void _start() {
    if (_active) return;
    _active = true;
    _attempt = 0;
    _connect();
  }

  void _stop() {
    _active = false;
    _retry?.cancel();
    _retry = null;
    _teardownSocket();
  }

  Future<void> _connect() async {
    if (!_active) return;
    final ch = WebSocketChannel.connect(_wsUri(_server, '/ws/notify'));
    _channel = ch;
    try {
      await ch.ready;
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    if (!_active) {
      _teardownSocket();
      return;
    }
    _attempt = 0;
    _sub = ch.stream.listen(
      (data) {
        final evt = _parse(data);
        if (evt != null && !_controller.isClosed) _controller.add(evt);
      },
      onError: (_) => _scheduleReconnect(),
      onDone: () => _scheduleReconnect(),
      cancelOnError: true,
    );
  }

  void _scheduleReconnect() {
    if (!_active) return;
    _teardownSocket();
    final delay = _backoff(_attempt++);
    _retry?.cancel();
    _retry = Timer(delay, () {
      _retry = null;
      _connect();
    });
  }

  void _teardownSocket() {
    _sub?.cancel();
    _sub = null;
    try {
      _channel?.sink.close();
    } catch (_) {/* ignore */}
    _channel = null;
  }

  static NotifyEvent? _parse(dynamic data) {
    try {
      final text = data is String ? data : utf8.decode(data as List<int>);
      final j = jsonDecode(text);
      if (j is Map<String, dynamic>) return NotifyEvent.fromJson(j);
    } catch (_) {/* ignore malformed frame */}
    return null;
  }

  static Duration _backoff(int attempt) {
    final capped = attempt > 5 ? 5 : attempt; // cap growth at 2^5 = 32
    final base = 1000 * (1 << capped);
    final jitter = Random().nextInt(400);
    final ms = (base + jitter).clamp(1000, 30000);
    return Duration(milliseconds: ms);
  }
}

/// Builds the `ws://` / `wss://` URI for [path] on [server], deriving the scheme
/// from the server's HTTP base URL and appending the bearer token as `?token=`.
Uri _wsUri(ServerConfig server, String path) {
  final base = Uri.parse(server.baseUrl);
  final scheme = base.scheme == 'https' ? 'wss' : 'ws';
  return base.replace(
    scheme: scheme,
    path: path,
    queryParameters: {'token': server.bearerToken},
  );
}

String _randomId() {
  final r = Random();
  final bytes = List<int>.generate(8, (_) => r.nextInt(256));
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}
