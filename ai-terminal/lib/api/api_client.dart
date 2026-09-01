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
/// Two jobs, and only the first is conditional: encode when the value cannot
/// ride a header, and keep the result inside [serverFilenameBudget] either way.
///
/// Encoded ONLY when it has to be. The server slices the name through
/// `safeDropName`, which maps anything outside `[A-Za-z0-9._-]` to `_`, so
/// encoding unconditionally would land `my_20file.pdf` on disk where today's
/// space gives `my_file.pdf`.
///
/// Which makes the value alone AMBIGUOUS — `100%-done.pdf` rides verbatim and
/// would blow up a receiver that decoded everything (`URIError` in node,
/// `FormatException` in Dart). So the encoding is announced rather than guessed:
/// [encodedFilenameHeader] is sent only alongside an encoded value, and a server
/// that later wants the real name decodes exactly when it is present. Today's
/// server ignores the extra header, so nothing has to ship in lockstep.
String headerSafeFilename(String name) {
  // The budget applies to BOTH branches. A long all-ASCII name is the common
  // case, not the exotic one, and the server's slice takes the same bite out of
  // it — the tail, i.e. the `.pdf`. Only the encoding is conditional.
  final encoded =
      filenameNeedsEncoding(name) ? Uri.encodeComponent(name) : name;
  if (encoded.length <= serverFilenameBudget) return encoded;
  // Every Hebrew letter costs SIX characters encoded, so a 14-letter name
  // overruns the server's 80-character slice and loses its `.pdf` off the end —
  // handing the agent a file whose type it can no longer tell. Truncate the
  // stem instead and keep the extension.
  //
  // Built up one whole character at a time rather than cut out of the encoded
  // string: slicing that could end mid-escape (`%D7`), which is not decodable
  // at all.
  String enc(String part) =>
      filenameNeedsEncoding(name) ? Uri.encodeComponent(part) : part;
  final dot = name.lastIndexOf('.');
  var ext = dot > 0 ? enc(name.substring(dot)) : '';
  // An "extension" can be longer than the whole budget — `backup.<a Hebrew
  // sentence>` has no real extension at all — and keeping it would return a
  // value OVER budget, which the server then slices mid-`%D7`: precisely the
  // undecodable half-escape the rune-walk below exists to avoid. Past a quarter
  // of the budget it is not an extension worth saving.
  if (ext.length > serverFilenameBudget ~/ 4) ext = '';
  final stem = ext.isEmpty ? name : name.substring(0, dot);
  final out = StringBuffer();
  var used = ext.length;
  for (final rune in stem.runes) {
    final piece = enc(String.fromCharCode(rune));
    if (used + piece.length > serverFilenameBudget) break;
    out.write(piece);
    used += piece.length;
  }
  return '$out$ext';
}

/// How much of a file name survives the server's `safeDropName`, which slices
/// the first 80 characters. Duplicated here for the same reason
/// [ApiClient.uploadLimitBytes] is — the client has to keep its own output
/// inside a budget the server enforces — and guarded by the same kind of drift
/// test, which reads server.js's own slice.
const int serverFilenameBudget = 80;

/// Whether [name] cannot ride a header value as itself — see
/// [headerSafeFilename] for what happens when one tries.
bool filenameNeedsEncoding(String name) =>
    !name.codeUnits.every((c) => c > 31 && c < 128);

/// Marks `X-Filename` as percent-encoded. Absent means the value is literal.
const String encodedFilenameHeader = 'X-Filename-Encoded';

/// A stateless client for one server's REST + WebSocket surface.
class ApiClient {
  /// The server this client talks to.
  final ServerConfig server;

  final http.Client _http;
  static const Duration _timeout = Duration(seconds: 10);
  static const Duration _uploadTimeout = Duration(seconds: 30);

  /// How long an upload of [bytes] may take before it is called dead.
  ///
  /// A flat 30s was right while the only body on this route was a desktop drop
  /// over a LAN. #166 aims it at a phone on cellular, where 30s cannot deliver
  /// even a 25 MB PDF — it would need a sustained ~7 Mbps just to beat the
  /// timer, and losing that race reports "Could not attach report.pdf" for a
  /// file the server may well have written, leaving an orphan in DROPPED_DIR.
  ///
  /// So the allowance scales with the body, against a deliberately pessimistic
  /// [_uploadFloorBytesPerSecond]: fast links never notice, and a slow one is
  /// judged on whether it is moving rather than on a stopwatch. It is a
  /// backstop, not a progress bar — a genuinely dead socket errors long before
  /// this, which is why a generous ceiling costs nothing.
  static Duration uploadTimeoutFor(int bytes) => _uploadTimeout +
      Duration(seconds: bytes ~/ _uploadFloorBytesPerSecond);

  /// ~100 KB/s — under a poor mobile connection, not over a good one. Sizing
  /// this optimistically would put the timer back in front of the transfer.
  static const int _uploadFloorBytesPerSecond = 100 * 1024;

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
  /// Returns `{commands: [...], quick: [...]}` — the whole catalogue plus the
  /// ordered button row (#188). Both come from one request because they are one
  /// table; fetching them separately would let the two drift within a session.
  ///
  /// `quick` is absent on a server older than #188, and an empty list there is
  /// exactly right: no buttons, everything else unchanged.
  Future<Map<String, List<Map<String, dynamic>>>> commandPolicy() async {
    List<Map<String, dynamic>> rows(Object? v) => v is List
        ? v.whereType<Map<String, dynamic>>().toList(growable: false)
        : const <Map<String, dynamic>>[];
    try {
      final body = _asMap(_decode(await _send('GET', '/api/commands')));
      return {'commands': rows(body['commands']), 'quick': rows(body['quick'])};
    } catch (_) {
      return const {
        'commands': <Map<String, dynamic>>[],
        'quick': <Map<String, dynamic>>[],
      };
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
              if (filenameNeedsEncoding(filename)) encodedFilenameHeader: '1',
            },
            body: bytes,
          )
          .timeout(uploadTimeoutFor(bytes.length));
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
  // #193 — TWO origins report on this stream. (1) The server's per-frame WS input cap
  // (server.js `WS_INPUT_MAX`, 256KB since #201 — it was 64KB when this was written)
  // used to refuse an oversized write with a server-side
  // log only; nothing told the client, so a dropped paste or long typed line looked
  // exactly like the agent silently ignoring the user. The server now echoes a bare
  // `{"inputDropped":true,"bytes":N}` frame back on THIS socket (the same `sessionTaken`
  // convention: only the socket that produced the oversized write is attached to it, so
  // no session id is needed on the wire). (2) [_bufferInput]'s own hard ceiling below,
  // for the same reason: a write this client itself had to give up on must never vanish
  // without a trace either.
  final StreamController<int> _inputDropped = StreamController<int>.broadcast();

  static const int _inputBufferCap = 8192; // bound on ORDINARY accumulated offline input (bytes)
  // Offline input is buffered as WHOLE writes, never split. A single sendInput — e.g. a
  // long compose submit made in the reconnect window after the app foregrounds — is
  // flushed intact or not at all: truncating it mid-content used to hand a half-prompt to
  // the agent (#63, "long prompt cut, tail missing"). The cap bounds ORDINARY ACCUMULATION
  // during a sustained outage (arrow keys, individual keystrokes) by evicting the OLDEST
  // whole writes; a write that exceeds the cap ALL BY ITSELF (a big paste) is never one of
  // those evictable writes — see [_bufferInput] for why exempting it is not the same as
  // leaving the buffer unbounded.
  final List<String> _inputWrites = <String>[];
  int _inputBufferLen = 0; // TOTAL bytes across every buffered write, oversized included
  // #193 review — a SEPARATE running sum, deliberately not reused from `_inputBufferLen`.
  // Once one write over `_inputBufferCap` is exempt and sitting in the buffer, TOTAL
  // length can never fall back under the ordinary cap on its own — so comparing stage
  // 1's eviction against `_inputBufferLen` made it run on EVERY call while an oversized
  // write was present, evicting every ordinary write the instant it arrived, silently.
  // (Reported in review, reproduced: paste, then a follow-up prompt, then `ls\r` —
  // buffer ends up holding only the paste, everything typed after it gone with nothing
  // to show for it.) This tracks only the writes that fit within `_inputBufferCap` on
  // their own, so the ordinary bound and the hard-ceiling bound are independent
  // quantities, and a paste can coexist with ordinary keystrokes typed around it.
  int _ordinaryBufferLen = 0;

  // #193 review — a real ceiling, chosen and stated rather than removed. Exempting an
  // oversized write from `_inputBufferCap` above must not mean the buffer can grow
  // without limit: twelve 20KB pastes queued in one outage (240,000 bytes, every one
  // over the ordinary cap on its own) would otherwise sit in memory forever. 256KB is
  // comfortably above six pastes the size #193's own probe measured against a real
  // Claude TUI (41,899 chars, ~41KB) — generous enough that one or two large pastes
  // queued during a real network blip never come near it — while still being a REAL
  // bound rather than none at all. Past it, [_bufferInput] falls back to plain
  // oldest-first eviction with NO size exemption, and reports each loss on
  // [inputDropped] so it is visible rather than silent — the whole buffer can still lose
  // data under sustained abuse, but never without a trace.
  //
  // #201 — THIS NUMBER IS HALF OF A PAIR. Its other half is `WS_INPUT_MAX` in
  // `server.js`, and together they encode one invariant:
  //
  //   NOTHING THIS BUFFER CAN HOLD WITHIN ITS CEILING MAY BE REFUSED AT THE WIRE.
  //
  // The server's per-frame cap used to be 65536 — an inherited default from commit
  // a96e7ba (2026-03-23), never measured, and the tightest limit on the whole path.
  // That left a seam: a 90KB paste typed while the socket was down was ACCEPTED here,
  // spent eviction pressure on the other queued writes, survived to reconnect, and was
  // then refused whole at the wire. #201 raised the server cap to this exact number
  // instead, and since #200 made [_flushInput] send ONE FRAME PER BUFFERED WRITE, no
  // write this buffer holds within its ceiling can exceed it. The seam is closed by
  // construction rather than by a check.
  //
  // Both caps count UTF-16 code units (`data.length` here, `msg.length` there), which
  // is why they are directly comparable; the server's separate transport bound
  // (`WS_MAX_PAYLOAD`, 4 MiB) counts real UTF-8 bytes and is 16x this cap - about 5.3x
  // its worst-case byte width of 256 KB x 3, three being the most UTF-8 bytes one BMP
  // code unit can take. MOVING ONE OF THE THREE ALONE BREAKS THE INVARIANT - the
  // arithmetic lives in the `server.js` block that defines them.
  //
  // #204 - THIS CEILING IS ALSO THE PER-WRITE ONE, applied in [sendInput] before
  // either branch. It reads as two quantities (a per-frame wire cap and a
  // whole-buffer total) but it is ONE NUMBER by the invariant above, so giving the
  // per-write check a named constant of its own would be a third copy of a value
  // whose entire problem was that its copies looked independent. See [sendInput]
  // for why the check belongs there and why the comparison is `>`.
  //
  // That closes what this block used to record as an accepted trade: a single write
  // LARGER than this ceiling was not refused here at all - stage 2 below stops
  // evicting at one entry, so an oversized lone write was buffered anyway and
  // refused at the wire, reported on [inputDropped] up to 4 MiB and, past 4 MiB,
  // not reported at all, because the transport closes the socket before the server
  // can answer and takes anything already dequeued behind it in the same flush.
  // Such a write now reaches neither the buffer nor the socket.
  //
  // (`app.html` has no single send path and is NOT gated this way, so that band is
  // still reachable from the browser. The `server.js` cap block says so in the same
  // words - the fact belongs to the server, which cannot know which client is
  // talking to it.)
  static const int _inputBufferHardCap = 256 * 1024;

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

  /// Fires with the length (UTF-16 code units) whenever a write THIS connection
  /// made failed to reach the agent. THREE origins, all of them #193's principle
  /// — input that is dropped must be visible:
  ///
  /// 1. the server refused it at its per-frame WS cap (`WS_INPUT_MAX`, 256 KB —
  ///    64 KB when this stream was written, raised by #201);
  /// 2. [_bufferInput]'s hard ceiling had to give up an older buffered write
  ///    during a sustained outage (#193);
  /// 3. [sendInput] refused it locally for exceeding that same ceiling (#204),
  ///    which is the only one of the three that can report a write the wire
  ///    would have answered by hanging up.
  ///
  /// Not terminal output, so it is its own stream rather than folded into
  /// [output].
  Stream<int> get inputDropped => _inputDropped.stream;

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
  ///
  /// A write LARGER than [_inputBufferHardCap] is refused HERE and reported on
  /// [inputDropped] (#204). Three things make that the right place for it:
  ///
  /// **The server would refuse it anyway.** That constant is the same number as
  /// `server.js`'s per-frame `WS_INPUT_MAX`, by the #201 invariant stated at both
  /// sites and gated by `scripts/check-shared-constants.js`. So nothing is lost by
  /// answering locally — the user just learns immediately, while the text is still
  /// in front of them, instead of after a round trip.
  ///
  /// **Past the TRANSPORT cap the round trip does not answer at all.** `ws` closes
  /// the socket (1009) on an oversize frame before any server handler runs, so
  /// nothing can send the notice back: that write is lost, and so is anything
  /// already dequeued behind it in the same flush — the user sees a reconnect blip
  /// and no explanation. Refusing at the app cap makes `WS_MAX_PAYLOAD` (4 MiB,
  /// 16x this cap) unreachable from this client, which is strictly better than
  /// defending against it.
  ///
  /// **Before the live/buffered branch, so ONE check covers both paths.** It also
  /// closes an oddity in [_bufferInput]: its stage-2 eviction stops at
  /// `_inputWrites.length > 1`, so a LONE write bigger than the whole ceiling used
  /// to survive eviction and sit in the buffer until a flush handed it to a wire
  /// that would refuse it. Such a write can no longer reach the buffer.
  ///
  /// The comparison is `>`, matching `server.js`'s `msg.length > WS_INPUT_MAX`
  /// exactly. A write AT the ceiling is legal on both sides and must still go —
  /// over-refusing here would be the same class of silent loss in the other
  /// direction.
  void sendInput(String data) {
    if (_closed) return;
    if (data.length > _inputBufferHardCap) {
      if (!_inputDropped.isClosed) _inputDropped.add(data.length);
      return;
    }
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
    _inputDropped.close();
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
    final ordinary = data.length <= _inputBufferCap;
    _inputWrites.add(data); // buffer the write WHOLE — never split (#63)
    _inputBufferLen += data.length;
    if (ordinary) _ordinaryBufferLen += data.length;
    // STAGE 1 — the ORDINARY cap, bounded against `_ordinaryBufferLen` (NOT
    // `_inputBufferLen` — see that field's doc for the regression comparing against
    // total caused). Stay bounded by dropping whole OLDEST writes that fit within
    // `_inputBufferCap` on their own — but never a write that already exceeds the cap BY
    // ITSELF. The old guard was `_inputWrites.length > 1`: it protected only whichever
    // write happened to be left once evicted down to one, which is NOT the same as
    // protecting the important one. A paste is a single whole write already over
    // `_inputBufferCap`; any later write, however small, pushed the total back over
    // budget and evicted the paste — the oldest entry — WHOLE to make room, because
    // eviction never looked at what it was about to throw away (#193: "a 20KB paste
    // followed by any later write is dropped entirely"). Truncating the paste in place
    // instead would be worse, not better — a corrupted prefix with no sign anything was
    // cut. So a write over the cap on its own is simply never a candidate for eviction
    // HERE: this stage keeps bounding ordinary accumulation (arrow keys, individual
    // keystrokes typed during an outage) and is silent, exactly as it always was — losing
    // one buffered character is inconsequential in a way losing a paste is not.
    var i = 0;
    while (_ordinaryBufferLen > _inputBufferCap && i < _inputWrites.length) {
      if (_inputWrites[i].length > _inputBufferCap) {
        i++; // not evictable at this stage — leave it and look at the next one
        continue;
      }
      final removed = _inputWrites.removeAt(i); // shifts the next one into i
      _inputBufferLen -= removed.length;
      _ordinaryBufferLen -= removed.length;
    }
    // STAGE 2 — the HARD ceiling (`_inputBufferHardCap`, see its doc), bounded against
    // TOTAL bytes. Reached only when the buffer is nothing BUT writes stage 1 could not
    // touch (several large pastes queued in one outage). No exemption this time — plain
    // oldest-first, the same shape stage 1 uses for ordinary writes — and every eviction
    // here IS reported: unlike a stray keystroke, this is a paste-sized loss, the exact
    // class of "input vanished with nothing to show for it" #193 is about.
    while (_inputBufferLen > _inputBufferHardCap && _inputWrites.length > 1) {
      final evicted = _inputWrites.removeAt(0);
      _inputBufferLen -= evicted.length;
      if (evicted.length <= _inputBufferCap) _ordinaryBufferLen -= evicted.length;
      if (!_inputDropped.isClosed) _inputDropped.add(evicted.length);
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
    // #193 review, Finding 2 — ONE write at a time, never `_inputWrites.join()`ed into
    // a single string first. Each buffered entry is already a whole frame (the entire
    // point of never splitting/merging one — #63), and joining erased that boundary
    // right before the wire: two pastes that individually fit under the server's real
    // 64KB-per-frame cap (server.js `handleMessage`) could join into a string that does
    // NOT — and the server refuses the WHOLE joined frame, losing BOTH pastes to a
    // limit neither hit alone. Sending one write per `add()` call makes each write's
    // fate independent at the wire, exactly like a live (non-buffered) sendInput
    // already is. A throw still keeps the remainder buffered for the next flush,
    // same retry semantics as before.
    while (_inputWrites.isNotEmpty) {
      final next = _inputWrites.first;
      try {
        socket.add(next);
      } catch (_) {
        return; // this write, and everything behind it, stay buffered for the retry
      }
      _inputWrites.removeAt(0);
      _inputBufferLen -= next.length;
      if (next.length <= _inputBufferCap) _ordinaryBufferLen -= next.length;
    }
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
      if (data.startsWith('{"inputDropped"')) {
        try {
          final bytes = jsonDecode(data)['bytes'];
          if (!_inputDropped.isClosed) {
            _inputDropped.add(bytes is int ? bytes : 0);
          }
        } catch (_) {/* malformed frame — nothing to report */}
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
