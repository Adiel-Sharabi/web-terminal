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
      // Echoes only what was explicitly requested — when omitted (server
      // infers it), the resolved id isn't known yet; [listSessions] picks it
      // up on the next fetch.
      agent: agent,
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
  }) async {
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
          res = await _http.get(uri, headers: headers).timeout(_timeout);
        case 'POST':
          res = await _http
              .post(uri, headers: headers, body: payload)
              .timeout(_timeout);
        case 'PATCH':
          res = await _http
              .patch(uri, headers: headers, body: payload)
              .timeout(_timeout);
        case 'DELETE':
          res = await _http
              .delete(uri, headers: headers, body: payload)
              .timeout(_timeout);
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

  static const int _inputBufferCap = 8192; // 8KB of offline keystrokes
  final StringBuffer _inputBuffer = StringBuffer();

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
    final room = _inputBufferCap - _inputBuffer.length;
    if (room <= 0) return; // full — drop to stay bounded during an outage
    _inputBuffer.write(data.length <= room ? data : data.substring(0, room));
  }

  void _flushInput() {
    if (_inputBuffer.isEmpty) return;
    final pending = _inputBuffer.toString();
    _inputBuffer.clear();
    try {
      _socket?.add(pending);
    } catch (_) {/* ignore */}
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
