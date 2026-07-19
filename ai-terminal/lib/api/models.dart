/// Immutable data models shared across the API and service layers.
///
/// Every model is a plain value object with a `fromJson` factory that mirrors
/// the exact wire shape returned by the web-terminal server (see
/// `COMPANION-APP-DESIGN.md` for the contract). Parsing is defensive: missing
/// or wrongly-typed fields fall back to sane defaults rather than throwing, so
/// a partial/older server response never crashes the app.
library;

/// One configured web-terminal server: its display name, base URL and the
/// bearer token used to authenticate every REST/WS call against it.
///
/// Immutable — use [copyWith] to produce a variant (e.g. once the real server
/// name has been read from `/api/version`).
class ServerConfig {
  /// Human-readable server name (from `/api/version`; a placeholder until the
  /// first successful version call resolves it).
  final String name;

  /// Base URL including scheme and port, no trailing slash
  /// (e.g. `http://100.79.226.100:7785`).
  final String baseUrl;

  /// Bearer token sent as `Authorization: Bearer <token>` on every request and
  /// as the `?token=` query parameter on WebSocket connections.
  final String bearerToken;

  /// Creates a server configuration. All fields are required.
  const ServerConfig({
    required this.name,
    required this.baseUrl,
    required this.bearerToken,
  });

  /// Returns a copy with the given fields replaced.
  ServerConfig copyWith({String? name, String? baseUrl, String? bearerToken}) {
    return ServerConfig(
      name: name ?? this.name,
      baseUrl: baseUrl ?? this.baseUrl,
      bearerToken: bearerToken ?? this.bearerToken,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is ServerConfig &&
      other.name == name &&
      other.baseUrl == baseUrl &&
      other.bearerToken == bearerToken;

  @override
  int get hashCode => Object.hash(name, baseUrl, bearerToken);

  @override
  String toString() => 'ServerConfig($name, $baseUrl)';
}

/// A single terminal session as returned by `GET /api/sessions`, tagged with the
/// [server] it belongs to (the list endpoint itself is per-server).
class Session {
  /// Opaque session id (a UUID minted by the server).
  final String id;

  /// Display name (the working folder name, a custom label, or `Session N`).
  final String name;

  /// Absolute working directory of the shell/agent.
  final String cwd;

  /// Live status string: `working`, `idle`, `waiting`, `api_error`, … Kept as a
  /// raw string so a new server-side status never breaks parsing.
  final String status;

  /// Claude Code session id when this session is a Claude session; `null` for a
  /// plain shell.
  final String? claudeSessionId;

  /// Epoch milliseconds of the last activity, or `null` if unknown.
  final int? lastActivity;

  /// Per-session push level: `off`, `important` or `all`.
  final String notifyLevel;

  /// The command this session was launched with (e.g.
  /// `claude --dangerously-skip-permissions`), or `''` for a plain shell. Used
  /// to carry launch flags forward when forking a session.
  final String autoCommand;

  /// The server this session was fetched from.
  final ServerConfig server;

  /// Live Claude Code status-line metrics (context %, 5h/7d rate-limit %), or
  /// `null` when none have been reported for this session recently.
  final SessionMetrics? metrics;

  /// The AI CLI agent provider driving this session (e.g. `claude`, `codex`),
  /// or `null` for a plain shell. Comes straight from the server's provider
  /// registry — never defaulted to `'claude'` here, since `null` is itself a
  /// meaningful "no agent" signal the UI relies on to hide the agent chip.
  final String? agent;

  /// Whether this session is pinned (starred). A PROPERTY OF THE SESSION,
  /// stored on the server that owns it (`favorites.json` there) — see issue
  /// #60. This client keeps no divergent copy: the star writes
  /// `PATCH /api/sessions/:id/favorite` and re-reads, it never flips a local
  /// list. Rides on `GET /api/sessions` and `GET /api/cluster/sessions`.
  final bool favorite;

  /// This session's position in the pinned group, or `null` when [favorite]
  /// is `false`. The pinned group's ORDER is DERIVED — see
  /// [Session.pinnedOrder] — never stored as a separate list.
  final int? favoriteRank;

  /// Whether this session is currently compacting its context (#65). Rides on
  /// `GET /api/sessions` / `GET /api/cluster/sessions` — [SessionRepository]
  /// seeds its `compactingFor` overlay from this on every poll, so a live
  /// `/ws/notify` push isn't the only way the indicator can show.
  final bool compacting;

  /// Epoch milliseconds when the current compaction started, or `null` when
  /// [compacting] is `false` or the server didn't report one.
  final int? compactingSince;

  /// Creates a session value object. [autoCommand] is optional (default `''`)
  /// so existing call sites and tests that predate the field keep compiling.
  const Session({
    required this.id,
    required this.name,
    required this.cwd,
    required this.status,
    required this.claudeSessionId,
    required this.lastActivity,
    required this.notifyLevel,
    required this.server,
    this.autoCommand = '',
    this.metrics,
    this.agent,
    this.favorite = false,
    this.favoriteRank,
    this.compacting = false,
    this.compactingSince,
  });

  /// Builds a [Session] from one element of the `GET /api/sessions` array,
  /// tagging it with the [server] it came from.
  factory Session.fromJson(ServerConfig server, Map<String, dynamic> json) {
    return Session(
      id: (json['id'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      cwd: (json['cwd'] ?? '').toString(),
      status: (json['status'] ?? 'idle').toString(),
      claudeSessionId: json['claudeSessionId']?.toString(),
      lastActivity: _asInt(json['lastActivity']),
      notifyLevel: (json['notifyLevel'] ?? 'important').toString(),
      autoCommand: (json['autoCommand'] ?? '').toString(),
      server: server,
      metrics: SessionMetrics.fromJson(json['metrics']),
      agent: json['agent']?.toString(),
      favorite: json['favorite'] == true,
      favoriteRank: _asInt(json['favoriteRank']),
      compacting: json['compacting'] == true,
      compactingSince: _asInt(json['compactingSince']),
    );
  }

  /// A short 8-char id fragment, handy for `Session {shortId}` fallback names.
  String get shortId => id.length <= 8 ? id : id.substring(0, 8);

  /// The pinned group in DISPLAY order: every favorited session in
  /// [sessions] (which may span several cluster servers), sorted by
  /// `(favoriteRank, id)`. Never stored — always recomputed from the live
  /// session list, exactly mirroring the server's own derivation (#60), so
  /// every device renders the identical order with no central list anywhere.
  ///
  /// Note there is no client-side "next rank" helper: a plain pin PATCHes
  /// with no `rank` at all, and the OWNING server assigns a monotonic
  /// wall-clock rank itself (`nextFavoriteRank` in server.js) — the whole
  /// point being that no single client ever has to invent a position from
  /// only the partial set of peers it can currently see. An explicit rank on
  /// the wire is reserved for a drag-reorder (not offered by this client).
  static List<Session> pinnedOrder(List<Session> sessions) {
    final favs = sessions.where((s) => s.favorite).toList(growable: false);
    favs.sort((a, b) {
      final byRank = (a.favoriteRank ?? 0).compareTo(b.favoriteRank ?? 0);
      return byRank != 0 ? byRank : a.id.compareTo(b.id);
    });
    return favs;
  }

  @override
  String toString() => 'Session($id, $name, $status @ ${server.name})';
}

/// Claude Code status-line metrics for a session: context-window usage and the
/// 5-hour / 7-day rate-limit usage, each a whole percentage (0–100) or `null`
/// when that number isn't currently known.
class SessionMetrics {
  final int? ctx;

  /// The model's context window in tokens, as the SERVER reports it (#71).
  ///
  /// This is read from Claude's own status-line payload
  /// (`context_window.context_window_size` — 200000 normally, 1000000 on an
  /// extended-context session) or from Codex's rollout. The client must never
  /// assume it: this field replaced a hardcoded `200000` here, which pinned
  /// every 1M session's badge at ~100% once it passed 200k tokens.
  ///
  /// `null` when the server hasn't reported one — in which case no estimate is
  /// shown at all, because a guessed denominator is what the bug WAS.
  final int? ctxWindow;
  final int? fiveH;
  final int? sevenD;
  final String? model;
  final String? effort;

  const SessionMetrics({
    this.ctx,
    this.ctxWindow,
    this.fiveH,
    this.sevenD,
    this.model,
    this.effort,
  });

  /// Parses the `metrics` object from a session JSON element. Returns `null`
  /// when the field is absent/null or when no numeric metric is present, so the
  /// header can simply skip rendering.
  static SessionMetrics? fromJson(dynamic json) {
    if (json is! Map) return null;
    int? pct(dynamic v) {
      if (v is num) return v.round().clamp(0, 100);
      return null;
    }

    String? str(dynamic v) => v is String && v.isNotEmpty ? v : null;
    // A token count, not a percentage — never clamped to 100.
    int? tokens(dynamic v) => v is num && v > 0 ? v.toInt() : null;
    final m = SessionMetrics(
      ctx: pct(json['ctx']),
      ctxWindow: tokens(json['ctxWindow']),
      fiveH: pct(json['fiveH']),
      sevenD: pct(json['sevenD']),
      model: str(json['model']),
      effort: str(json['effort']),
    );
    // ctxWindow alone is not a reading — it says how big the window is, not how
    // much of it is used — so it does not by itself make a renderable metric.
    if (m.ctx == null && m.fiveH == null && m.sevenD == null) return null;
    return m;
  }

  bool get hasAny => ctx != null || fiveH != null || sevenD != null;
}

/// The `GET /api/sessions/:id/attention` response: the last recorded attention
/// event plus Claude's freshly-read last message. All event fields are `null`
/// when nothing currently needs attention.
class AttentionInfo {
  /// Attention kind: `approval`, `apierror`, `idle`, or `null` when nothing is
  /// pending.
  final String? kind;

  /// Human-readable reason (e.g. the command awaiting approval); may be empty.
  final String? reason;

  /// Session name captured at the time of the event; may be empty.
  final String? name;

  /// Claude's last assistant message, read live from the transcript; empty when
  /// unavailable or content is withheld.
  final String? lastMessage;

  /// Epoch milliseconds when the event was recorded, or `null`.
  final int? at;

  /// Whether the event has since been resolved/cleared. `null` when there is no
  /// event at all.
  final bool? cleared;

  /// The server that produced this attention record.
  final String serverName;

  /// Creates an attention info value object.
  const AttentionInfo({
    required this.kind,
    required this.reason,
    required this.name,
    required this.lastMessage,
    required this.at,
    required this.cleared,
    required this.serverName,
  });

  /// Parses the `/api/sessions/:id/attention` response body.
  factory AttentionInfo.fromJson(Map<String, dynamic> json) {
    return AttentionInfo(
      kind: json['kind']?.toString(),
      reason: json['reason']?.toString(),
      name: json['name']?.toString(),
      lastMessage: json['lastMessage']?.toString(),
      at: _asInt(json['at']),
      cleared: json['cleared'] is bool ? json['cleared'] as bool : null,
      serverName: (json['serverName'] ?? '').toString(),
    );
  }

  /// True when a live, unresolved attention event is present.
  bool get hasAttention => kind != null && cleared != true;

  @override
  String toString() => 'AttentionInfo($kind, cleared=$cleared @ $serverName)';
}

/// A single event pushed over the `/ws/notify` WebSocket. Flattened from the
/// server's `{notification: {...}}` envelope.
///
/// The server emits four shapes over this socket:
/// * a bare status frame — `{type:'status', sessionId, status}` (no api-error
///   keys);
/// * a status/approval/idle notification — same shape plus a `message`;
/// * an **api-error** frame — carries `apiError`, `apiErrorText`, `transient`,
///   `autoContinue`, `action` and `replayText` (but no `status`);
/// * a **compacting** frame (#65) — `{type:'compacting', id, compacting,
///   since}`. Note the session id key is `id`, not `sessionId` — [sessionId]
///   falls back to `id` so this frame reads like every other one downstream.
///
/// Only api-error frames carry the `apiError` key, so [hasApiErrorSignal]
/// distinguishes them from ordinary status frames. This matters because the
/// server signals *recovery* with an api-error frame whose `apiError` is
/// `false` — a plain status frame (which also has `apiError == false` by
/// default) must **not** be mistaken for that recovery. There is currently no
/// `cleared` key on the wire; [cleared] is parsed defensively for
/// forward-compatibility, and recovery is detected via `apiError == false` on a
/// frame where [hasApiErrorSignal] is true.
class NotifyEvent {
  /// Event type: `status`, `approval_needed`, `idle`, `api_error`.
  final String type;

  /// Message body (may be empty for pure status transitions).
  final String message;

  /// Session id the event concerns.
  final String sessionId;

  /// Session status carried with the event (may be empty; api-error frames omit
  /// it).
  final String status;

  /// True when the event reports an active API error condition. On an api-error
  /// frame, `false` means the error has recovered/cleared.
  final bool apiError;

  /// The API error line (e.g. the upstream error text), or `null`/empty when the
  /// frame carries no error text (recovery frames blank this out).
  final String? apiErrorText;

  /// Defensive parse of a future `cleared` key. Not currently emitted by the
  /// server — recovery is signalled by `apiError == false` — but treated as a
  /// clear when present.
  final bool cleared;

  /// Whether the error is a transient/retryable condition.
  final bool transient;

  /// Auto-continue retry counter: `0` for the initial detection, `>0` on each
  /// automatic retry the server performs.
  final int autoContinue;

  /// Server-side recovery action label (e.g. the key/text being replayed), or
  /// `null` when absent.
  final String? action;

  /// Text the server auto-replayed into the PTY to recover, or `null` when
  /// absent.
  final String? replayText;

  /// True when this frame actually carried api-error state (the `apiError` or
  /// `apiErrorText` key was present). Ordinary status/approval/idle frames set
  /// this to `false`, so consumers can leave a session's tracked api-error state
  /// untouched on unrelated status updates. Derived at parse time from raw key
  /// presence.
  final bool hasApiErrorSignal;

  /// True when the event reports an active compaction condition (#65). On a
  /// `type:'compacting'` frame, `false` means compaction just ended.
  final bool compacting;

  /// Epoch milliseconds when compaction started, or `null` when absent/ended.
  final int? compactingSince;

  /// True when this frame actually carried compacting state (the `compacting`
  /// key was present) — mirrors [hasApiErrorSignal]. An ordinary status frame
  /// (which also has `compacting == false` merely by default) must not be
  /// mistaken for an explicit "compaction ended" signal.
  final bool hasCompactingSignal;

  /// Creates a notify event value object.
  const NotifyEvent({
    required this.type,
    required this.message,
    required this.sessionId,
    required this.status,
    required this.apiError,
    this.apiErrorText,
    this.cleared = false,
    this.transient = false,
    this.autoContinue = 0,
    this.action,
    this.replayText,
    this.hasApiErrorSignal = false,
    this.compacting = false,
    this.compactingSince,
    this.hasCompactingSignal = false,
  });

  /// Parses one `/ws/notify` frame. Accepts either the full
  /// `{notification: {...}}` envelope or a bare notification object.
  factory NotifyEvent.fromJson(Map<String, dynamic> json) {
    final n = json['notification'] is Map<String, dynamic>
        ? json['notification'] as Map<String, dynamic>
        : json;
    return NotifyEvent(
      type: (n['type'] ?? 'status').toString(),
      message: (n['message'] ?? '').toString(),
      // The compacting frame's session-id key is `id`, not `sessionId` (#65)
      // — fall back so it flows through the same field as every other frame.
      sessionId: (n['sessionId'] ?? n['id'] ?? '').toString(),
      status: (n['status'] ?? '').toString(),
      apiError: n['apiError'] == true,
      apiErrorText: n['apiErrorText']?.toString(),
      cleared: n['cleared'] == true,
      transient: n['transient'] == true,
      autoContinue: _asInt(n['autoContinue']) ?? 0,
      action: n['action']?.toString(),
      replayText: n['replayText']?.toString(),
      hasApiErrorSignal:
          n.containsKey('apiError') || n.containsKey('apiErrorText'),
      compacting: n['compacting'] == true,
      compactingSince: _asInt(n['since']),
      hasCompactingSignal: n.containsKey('compacting'),
    );
  }

  @override
  String toString() =>
      'NotifyEvent($type, $sessionId, $status, apiError=$apiError)';
}

/// Derived per-session API-error state tracked by the session repository.
///
/// `/api/sessions` does not report api-error state, so this is folded together
/// purely from `/ws/notify` frames (see [NotifyEvent]). [active] mirrors the
/// live error condition; the remaining fields carry the most recent detail for
/// the UI (error text, whether it is transient, the auto-continue retry counter
/// and any recovery [action]).
class ApiErrorInfo {
  /// Whether the session is currently in an (unrecovered) API error.
  final bool active;

  /// The latest error line, or `null` when unknown.
  final String? text;

  /// Whether the error is a transient/retryable condition.
  final bool transient;

  /// Auto-continue retry counter: `0` at first detection, `>0` while the server
  /// is auto-retrying.
  final int autoContinue;

  /// The most recent server recovery action label, or `null`.
  final String? action;

  /// Creates an api-error info value object.
  const ApiErrorInfo({
    required this.active,
    this.text,
    this.transient = false,
    this.autoContinue = 0,
    this.action,
  });

  @override
  String toString() =>
      'ApiErrorInfo(active=$active, autoContinue=$autoContinue)';
}

/// Derived per-session compaction state tracked by the session repository
/// (#65), mirroring [ApiErrorInfo]'s overlay-on-top-of-status shape. Unlike
/// api-error state, `compacting`/`compactingSince` also ride `/api/sessions`
/// (see [Session]) — [active]/[since] are folded from BOTH that poll and the
/// live `type:'compacting'` `/ws/notify` frame, so the indicator can appear
/// ahead of the next poll.
class CompactingInfo {
  /// Whether the session is currently compacting its context.
  final bool active;

  /// Epoch milliseconds when compaction started, or `null` if unknown.
  final int? since;

  /// Creates a compacting info value object.
  const CompactingInfo({required this.active, this.since});

  @override
  String toString() => 'CompactingInfo(active=$active, since=$since)';
}

/// The `GET /api/version` response used for per-server feature gating and the
/// resolved display name.
class ServerInfo {
  /// Server semantic version string.
  final String version;

  /// Human-readable server name.
  final String serverName;

  /// Feature capability flags (e.g. `attention`, `clear`, `push-devices`,
  /// `fcm`) advertised by this server.
  final List<String> capabilities;

  /// Creates a server info value object.
  const ServerInfo({
    required this.version,
    required this.serverName,
    required this.capabilities,
  });

  /// Parses the `/api/version` response body.
  factory ServerInfo.fromJson(Map<String, dynamic> json) {
    final caps = json['capabilities'];
    return ServerInfo(
      version: (json['version'] ?? '').toString(),
      serverName: (json['serverName'] ?? '').toString(),
      capabilities: caps is List
          ? caps.map((e) => e.toString()).toList(growable: false)
          : const <String>[],
    );
  }

  /// Whether this server advertises the given [capability].
  bool has(String capability) => capabilities.contains(capability);

  @override
  String toString() => 'ServerInfo($serverName, v$version, $capabilities)';
}

/// The subset of `GET /api/config` this app cares about: the defaults used when
/// creating a new session and the server's own display name.
///
/// The full config response also carries auth/cluster/tuning keys (password,
/// port, cluster, …) which are intentionally ignored here. Every field is
/// defensively defaulted (`defaultCwd`/`defaultCommand` to `''`, [scanFolders]
/// to `[]`, [serverName] to `''`) so an older or partial server never breaks
/// parsing.
class ServerRuntimeConfig {
  /// The working directory a new session opens in when none is specified.
  final String defaultCwd;

  /// The command auto-run in a new session (e.g. `claude`), or `''` for a plain
  /// shell.
  final String defaultCommand;

  /// The roots scanned to populate the New Session folder picker. Note: this is
  /// the *configured* scan roots from config, not the live folder listing — use
  /// [ApiClient.folders] for the live per-server scan.
  final List<String> scanFolders;

  /// The server's configured display name (may be empty).
  final String serverName;

  /// Creates a runtime-config value object.
  const ServerRuntimeConfig({
    required this.defaultCwd,
    required this.defaultCommand,
    required this.scanFolders,
    required this.serverName,
  });

  /// Parses the (subset of the) `GET /api/config` response body, ignoring all
  /// keys other than the four this app uses.
  factory ServerRuntimeConfig.fromJson(Map<String, dynamic> json) {
    final folders = json['scanFolders'];
    return ServerRuntimeConfig(
      defaultCwd: (json['defaultCwd'] ?? '').toString(),
      defaultCommand: (json['defaultCommand'] ?? '').toString(),
      scanFolders: folders is List
          ? folders.map((e) => e.toString()).toList(growable: false)
          : const <String>[],
      serverName: (json['serverName'] ?? '').toString(),
    );
  }

  @override
  String toString() =>
      'ServerRuntimeConfig($serverName, cwd=$defaultCwd, ${scanFolders.length} roots)';
}

/// One entry from `GET /api/agents`: an AI CLI agent provider the server can
/// launch a session with — its stable id (passed back as `POST /api/sessions`'
/// `agent` field), display label and accent color. Powers the New Session
/// sheet's agent picker.
class AgentInfo {
  /// Stable provider id (e.g. `claude`, `codex`).
  final String id;

  /// Human-readable display label (e.g. `Claude Code`).
  final String label;

  /// Accent color as `#rrggbb`; '' if the server omitted it.
  final String color;

  /// Creates an agent-info value object.
  const AgentInfo({required this.id, required this.label, required this.color});

  /// Parses one element of the `agents` array.
  factory AgentInfo.fromJson(Map<String, dynamic> json) => AgentInfo(
        id: (json['id'] ?? '').toString(),
        label: (json['label'] ?? '').toString(),
        color: (json['color'] ?? '').toString(),
      );

  @override
  String toString() => 'AgentInfo($id, $label, $color)';
}

/// A ranged slice of a session's sanitized scrollback, from
/// `GET /api/sessions/:id/scrollback`.
class ScrollbackChunk {
  /// The sanitized scrollback text for this range.
  final String data;

  /// Total length (in UTF-16 code units) of the full scrollback buffer.
  final int total;

  /// Offset (in UTF-16 code units) at which [data] begins.
  final int offset;

  /// Length (in UTF-16 code units) of [data].
  final int limit;

  /// Creates a scrollback chunk value object.
  const ScrollbackChunk({
    required this.data,
    required this.total,
    required this.offset,
    required this.limit,
  });

  /// Parses the `/api/sessions/:id/scrollback` response body.
  factory ScrollbackChunk.fromJson(Map<String, dynamic> json) {
    return ScrollbackChunk(
      data: (json['data'] ?? '').toString(),
      total: _asInt(json['total']) ?? 0,
      offset: _asInt(json['offset']) ?? 0,
      limit: _asInt(json['limit']) ?? 0,
    );
  }

  @override
  String toString() =>
      'ScrollbackChunk(offset=$offset, limit=$limit, total=$total)';
}

/// One tool invocation within an assistant turn, summarized for the chat view.
class ToolUse {
  /// Tool name (e.g. `Bash`, `Edit`); may be empty if the server couldn't read
  /// it.
  final String name;

  /// A short preview (~first 80 chars) of the tool input.
  final String inputPreview;

  /// The tool_use id (pairs with its result server-side); '' if unknown.
  final String id;

  /// The tool's input, ANSI-stripped and per-field-capped, for rich cards
  /// (e.g. `command`, `file_path`, `description`, `pattern`, `url`).
  final Map<String, dynamic> input;

  /// The tool's OUTPUT (tool_result text, capped), or null if none was captured.
  final String? result;

  /// For a `Task` tool_use that spawned a subagent: a light stub the chat view
  /// uses to show a running dot and offer to drill into the subagent's own turns
  /// (lazily, via `GET /api/sessions/:id/subagent/:toolUseId`). `null` for tools
  /// with no subagent trace on disk (and for servers that predate the feature).
  final SubagentTrace? subagent;

  /// Creates a tool-use summary.
  const ToolUse({
    required this.name,
    required this.inputPreview,
    this.id = '',
    this.input = const {},
    this.result,
    this.subagent,
  });

  /// Parses one element of a turn's `toolUses` array.
  factory ToolUse.fromJson(Map<String, dynamic> json) => ToolUse(
        name: (json['name'] ?? '').toString(),
        inputPreview: (json['inputPreview'] ?? '').toString(),
        id: (json['id'] ?? '').toString(),
        input: json['input'] is Map
            ? Map<String, dynamic>.from(json['input'] as Map)
            : const <String, dynamic>{},
        result: json['result']?.toString(),
        subagent: json['subagent'] is Map
            ? SubagentTrace.fromJson(
                Map<String, dynamic>.from(json['subagent'] as Map))
            : null,
      );

  @override
  String toString() => 'ToolUse($name)';
}

/// A `Task` tool_use's subagent trace stub, attached by the server when the
/// subagent left a transcript on disk. Just enough to render the collapsed card
/// (agent type + description) and a live running dot; the subagent's actual turns
/// are fetched on demand via `ApiClient.subagent`.
class SubagentTrace {
  /// The subagent's type (e.g. `Explore`, `general-purpose`), or ''.
  final String agentType;

  /// The Task's description (what the subagent was asked to do), or ''.
  final String description;

  /// Whether the subagent is still running (its Task has no result yet).
  final bool running;

  /// Creates a subagent trace stub.
  const SubagentTrace({
    required this.agentType,
    required this.description,
    required this.running,
  });

  /// Parses a Task tool_use's `subagent` stub.
  factory SubagentTrace.fromJson(Map<String, dynamic> json) => SubagentTrace(
        agentType: (json['agentType'] ?? '').toString(),
        description: (json['description'] ?? '').toString(),
        running: json['running'] == true,
      );

  @override
  String toString() =>
      'SubagentTrace($agentType, running=$running)';
}

/// A single conversation turn from a session's transcript.
class TranscriptTurn {
  /// Turn author: `assistant` or `user`.
  final String role;

  /// The turn's rendered text (control sequences stripped, length-capped by the
  /// server). May be empty for an assistant turn that is only tool use.
  final String text;

  /// Tool invocations in this turn (always empty for user turns).
  final List<ToolUse> toolUses;

  /// ISO-8601 timestamp string, or `null` if the transcript line had none.
  final String? ts;

  /// Total context tokens carried into this assistant turn's request (fresh
  /// input + both cache tiers), or `null` for user turns / turns with no usage.
  /// Used to derive an approximate ctx% when the live status line isn't posting.
  final int? ctxTokens;

  /// Creates a transcript turn.
  const TranscriptTurn({
    required this.role,
    required this.text,
    required this.toolUses,
    required this.ts,
    this.ctxTokens,
  });

  /// Parses one element of the transcript page's `messages` array.
  factory TranscriptTurn.fromJson(Map<String, dynamic> json) {
    final tu = json['toolUses'];
    final ct = json['ctxTokens'];
    return TranscriptTurn(
      role: (json['role'] ?? '').toString(),
      text: (json['text'] ?? '').toString(),
      toolUses: tu is List
          ? tu
              .whereType<Map<String, dynamic>>()
              .map(ToolUse.fromJson)
              .toList(growable: false)
          : const <ToolUse>[],
      ts: json['ts']?.toString(),
      ctxTokens: ct is num && ct > 0 ? ct.toInt() : null,
    );
  }

  /// Whether this is an assistant turn.
  bool get isAssistant => role == 'assistant';

  /// Whether this is a user turn.
  bool get isUser => role == 'user';

  @override
  String toString() => 'TranscriptTurn($role, ${toolUses.length} tools)';
}

/// One backward-paginated page of transcript turns from
/// `GET /api/sessions/:id/transcript`.
class TranscriptPage {
  /// Turns in chronological order — **newest last** — ready to append to the
  /// bottom of a chat view.
  final List<TranscriptTurn> messages;

  /// Opaque cursor for the *older* page: pass it back as the `before` argument.
  /// `null` when there are no older turns ([hasMore] is false) or the page is
  /// empty.
  final String? cursor;

  /// Whether older turns remain. Note: this can be `true` while the next page
  /// comes back empty (only non-conversational lines preceded the cursor) — the
  /// following page then reports `hasMore == false`. Callers should stop
  /// paginating when [cursor] is `null`, not solely on [hasMore].
  final bool hasMore;

  /// The provider that parsed this transcript (e.g. `claude`, `codex`), or
  /// `null` if the server didn't report one (an older server, or a session
  /// with no resolvable agent).
  final String? agent;

  /// Creates a transcript page.
  const TranscriptPage({
    required this.messages,
    required this.cursor,
    required this.hasMore,
    this.agent,
  });

  /// Parses the `/api/sessions/:id/transcript` response body.
  factory TranscriptPage.fromJson(Map<String, dynamic> json) {
    final msgs = json['messages'];
    return TranscriptPage(
      messages: msgs is List
          ? msgs
              .whereType<Map<String, dynamic>>()
              .map(TranscriptTurn.fromJson)
              .toList(growable: false)
          : const <TranscriptTurn>[],
      cursor: json['cursor']?.toString(),
      hasMore: json['hasMore'] == true,
      agent: json['agent']?.toString(),
    );
  }

  @override
  String toString() =>
      'TranscriptPage(${messages.length} turns, hasMore=$hasMore, agent=$agent)';
}

/// One backward-paginated page of a *subagent's* transcript from
/// `GET /api/sessions/:id/subagent/:toolUseId` — the same shape as
/// [TranscriptPage] (its [messages] can themselves carry nested `Task` subagent
/// stubs, so the view can drill deeper) plus the subagent's identity + live
/// running state.
class SubagentPage {
  /// The subagent's type (e.g. `Explore`), echoed from its meta sidecar.
  final String agentType;

  /// The Task description the subagent was spawned with.
  final String description;

  /// Whether the subagent is still running (its parent Task has no result yet).
  final bool running;

  /// The subagent's turns, newest-last (same pagination contract as
  /// [TranscriptPage]).
  final List<TranscriptTurn> messages;

  /// Opaque cursor for the *older* page; `null` at the start / when empty.
  final String? cursor;

  /// Whether older turns remain (see [TranscriptPage.hasMore] for the caveat).
  final bool hasMore;

  /// Creates a subagent transcript page.
  const SubagentPage({
    required this.agentType,
    required this.description,
    required this.running,
    required this.messages,
    required this.cursor,
    required this.hasMore,
  });

  /// Parses the `/api/sessions/:id/subagent/:toolUseId` response body.
  factory SubagentPage.fromJson(Map<String, dynamic> json) {
    final msgs = json['messages'];
    return SubagentPage(
      agentType: (json['agentType'] ?? '').toString(),
      description: (json['description'] ?? '').toString(),
      running: json['running'] == true,
      messages: msgs is List
          ? msgs
              .whereType<Map<String, dynamic>>()
              .map(TranscriptTurn.fromJson)
              .toList(growable: false)
          : const <TranscriptTurn>[],
      cursor: json['cursor']?.toString(),
      hasMore: json['hasMore'] == true,
    );
  }

  @override
  String toString() =>
      'SubagentPage($agentType, ${messages.length} turns, running=$running)';
}

/// One selectable option in a [PendingQuestionItem] (label + optional blurb).
class QuestionOption {
  final String label;
  final String description;
  const QuestionOption({required this.label, this.description = ''});

  factory QuestionOption.fromJson(Map<String, dynamic> json) => QuestionOption(
    label: (json['label'] ?? '').toString(),
    description: (json['description'] ?? '').toString(),
  );
}

/// One question of a [PendingQuestion] — a "tab" when the prompt has several.
class PendingQuestionItem {
  final String header;
  final String question;
  final bool multiSelect;
  final List<QuestionOption> options;

  const PendingQuestionItem({
    required this.header,
    required this.question,
    required this.multiSelect,
    required this.options,
  });

  factory PendingQuestionItem.fromJson(Map<String, dynamic> json) {
    final opts = json['options'];
    return PendingQuestionItem(
      header: (json['header'] ?? '').toString(),
      question: (json['question'] ?? '').toString(),
      multiSelect: json['multiSelect'] == true,
      options: opts is List
          ? opts
              .whereType<Map<String, dynamic>>()
              .map(QuestionOption.fromJson)
              .toList(growable: false)
          : const <QuestionOption>[],
    );
  }
}

/// Claude's pending interactive prompt (AskUserQuestion), from
/// `GET /api/sessions/:id/pending-question`. [questions] holds more than one
/// entry for a multi-tab prompt. Rendered as a native overlay (issue #19).
class PendingQuestion {
  final String toolUseId;
  final List<PendingQuestionItem> questions;

  const PendingQuestion({required this.toolUseId, required this.questions});

  /// Parses the endpoint body; returns `null` when nothing is pending (so the
  /// caller can treat "no question" and "malformed" identically — hide it).
  static PendingQuestion? fromJson(Map<String, dynamic> json) {
    if (json['pending'] != true) return null;
    final q = json['question'];
    if (q is! Map<String, dynamic>) return null;
    final items = q['questions'];
    final list = items is List
        ? items
            .whereType<Map<String, dynamic>>()
            .map(PendingQuestionItem.fromJson)
            .toList(growable: false)
        : const <PendingQuestionItem>[];
    if (list.isEmpty) return null;
    return PendingQuestion(
      toolUseId: (q['toolUseId'] ?? '').toString(),
      questions: list,
    );
  }

  /// Identity is the tool-use id, so the UI can tell when a *different* question
  /// arrives (reset selection) vs. the same one being re-polled.
  @override
  bool operator ==(Object other) =>
      other is PendingQuestion && other.toolUseId == toolUseId;

  @override
  int get hashCode => toolUseId.hashCode;
}

/// Coerces a dynamic JSON value to an `int?`, accepting numbers and numeric
/// strings (FCM/JSON sometimes stringifies numbers). Returns `null` on failure.
int? _asInt(dynamic v) {
  if (v == null) return null;
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse(v.toString());
}
