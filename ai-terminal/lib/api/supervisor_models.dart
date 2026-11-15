// #466 - the supervisor's answer (`GET /api/supervisor/state`), as the companion's
// Journal page reads it. The server owns every rule here (lib/supervisor.js `stateOf`,
// lib/session-journal.js `foldJournal`): which sessions need you, which are live,
// which are ready to close, what an orphan is. These classes only carry what it said.
//
// Every field may be absent - an older server, a peer that is not the authority, a
// supervisor switched off - so every parse is tolerant: a wrong type is "not said",
// never a crash, and a malformed body is null (unknown), never "nothing to show".

/// One work item a session reported (`{ref, title, state}`; history keeps no title).
class SupervisorItem {
  final String? ref;
  final String? title;
  final String? state;
  const SupervisorItem({this.ref, this.title, this.state});

  static SupervisorItem? fromJson(dynamic j) {
    if (j is! Map) return null;
    final it = SupervisorItem(ref: _str(j['ref']), title: _str(j['title']), state: _str(j['state']));
    return it.ref == null && it.title == null ? null : it;
  }
}

/// A reported wait: what the session waits on (`you`, `self`, `external`, `done`).
class SupervisorWait {
  final String on;
  final String what;

  /// When it was reported, on the AUTHORITY's clock (epoch ms).
  final int? at;

  /// The kind of the named target (`session`, `lead`, `pr`, ...), when one was named.
  final String? targetKind;

  /// Minutes until the wait is overdue, when the session said.
  final int? checkBy;

  const SupervisorWait({required this.on, this.what = '', this.at, this.targetKind, this.checkBy});

  static SupervisorWait? fromJson(dynamic j) {
    if (j is! Map) return null;
    final on = _str(j['on']);
    if (on == null) return null;
    final t = j['target'];
    return SupervisorWait(
      on: on,
      what: _str(j['what']) ?? '',
      at: _int(j['at']),
      targetKind: t is Map ? _str(t['kind']) : null,
      checkBy: _int(j['checkBy']),
    );
  }
}

/// The supervisor's verdict on a session whose lead is not live: `suspect`, `orphan`
/// (its lead is gone from every server) or `unknown` (some server did not answer, or the
/// lead was never seen in scope).
class SupervisorOrphan {
  final String state;
  final String? parentId;
  final int? since;
  const SupervisorOrphan({required this.state, this.parentId, this.since});

  static SupervisorOrphan? fromJson(dynamic j) {
    if (j is! Map) return null;
    final s = _str(j['state']);
    return s == null ? null : SupervisorOrphan(state: s, parentId: _str(j['parentId']), since: _int(j['since']));
  }
}

/// One live session in the cluster graph.
class SupervisorNode {
  final String id;

  /// The name of the server it lives on, as the authority's cluster names it.
  final String? server;
  final String? name;
  final String? cwd;
  final String? status;
  final String? agent;
  final int clients;
  final String? parentId;
  final String? leadId;
  final String? goal;
  final String? headline;
  final String? now;
  final List<SupervisorItem> items;
  final SupervisorWait? wait;
  final SupervisorOrphan? orphan;

  /// When the journal saw it open (authority clock), if it did.
  final int? openedAt;

  const SupervisorNode({
    required this.id,
    this.server,
    this.name,
    this.cwd,
    this.status,
    this.agent,
    this.clients = 0,
    this.parentId,
    this.leadId,
    this.goal,
    this.headline,
    this.now,
    this.items = const [],
    this.wait,
    this.orphan,
    this.openedAt,
  });

  /// The lead is gone from every server (the "lead gone" badge).
  bool get leadGone => orphan?.state == 'orphan';

  /// Whether the lead is live could not be told (the quieter "lead unknown").
  bool get leadUnknown => orphan?.state == 'unknown';

  static SupervisorNode? fromJson(dynamic j) {
    if (j is! Map) return null;
    final id = _str(j['id']);
    if (id == null) return null;
    final journal = j['journal'];
    return SupervisorNode(
      id: id,
      server: _str(j['server']),
      name: _str(j['name']),
      cwd: _str(j['cwd']),
      status: _str(j['status']),
      agent: _str(j['agent']),
      clients: _int(j['clients']) ?? 0,
      parentId: _str(j['parentId']),
      leadId: _str(j['leadId']),
      goal: _str(j['goal']),
      headline: _str(j['headline']),
      now: _str(j['now']),
      items: _items(j['items']),
      wait: SupervisorWait.fromJson(j['wait']),
      orphan: SupervisorOrphan.fromJson(j['orphan']),
      openedAt: journal is Map ? _int(journal['openedAt']) : null,
    );
  }
}

/// One session that ended, from the cluster's journal.
class JournalEntry {
  final String? id;
  final String? machine;
  final String? name;
  final String? cwd;

  /// Why it ended: `closed`, `reaped`, `handed-off`, `exited` or `lost`.
  final String? why;
  final int? openedAt;
  final int? closedAt;
  final String? goal;
  final String? headline;
  final String? did;
  final String? successorId;
  final List<SupervisorItem> items;

  const JournalEntry({
    this.id,
    this.machine,
    this.name,
    this.cwd,
    this.why,
    this.openedAt,
    this.closedAt,
    this.goal,
    this.headline,
    this.did,
    this.successorId,
    this.items = const [],
  });

  static JournalEntry? fromJson(dynamic j) {
    if (j is! Map) return null;
    return JournalEntry(
      id: _str(j['id']),
      machine: _str(j['machine']),
      name: _str(j['name']),
      cwd: _str(j['cwd']),
      why: _str(j['why']),
      openedAt: _int(j['openedAt']),
      closedAt: _int(j['closedAt']),
      goal: _str(j['goal']),
      headline: _str(j['headline']),
      did: _str(j['did']),
      successorId: _str(j['successorId']),
      items: _items(j['items']),
    );
  }
}

/// One server the authority polled, and whether it answered.
class SupervisorServer {
  final String name;
  final bool ok;
  final String? reason;
  final int sessions;
  const SupervisorServer({required this.name, required this.ok, this.reason, this.sessions = 0});

  static SupervisorServer? fromJson(dynamic j) {
    if (j is! Map) return null;
    final name = _str(j['name']);
    return name == null
        ? null
        : SupervisorServer(name: name, ok: j['ok'] == true, reason: _str(j['reason']), sessions: _int(j['sessions']) ?? 0);
  }
}

/// `GET /api/supervisor/state`. [role] is `authority` (the answer carries the graph),
/// `peer` (it names the authority in [authorityName]) or `none` (no authority set up).
class SupervisorState {
  final String role;

  /// False when the authority's supervisor is switched off. Absent reads as on.
  final bool enabled;

  /// For a `peer` answer: the authority's server name.
  final String? authorityName;

  /// When the last scan ran (authority clock), null before the first one.
  final int? at;
  final int? everyMs;

  /// Every server answered the last scan.
  final bool complete;
  final List<SupervisorServer> servers;
  final List<SupervisorNode> sessions;
  final List<String> needsYou;
  final List<String> live;
  final List<String> readyToClose;
  final List<JournalEntry> history;

  /// This device's clock minus the authority's, from the served `now`; 0 when unsaid.
  final int skewMs;

  const SupervisorState({
    required this.role,
    this.enabled = true,
    this.authorityName,
    this.at,
    this.everyMs,
    this.complete = false,
    this.servers = const [],
    this.sessions = const [],
    this.needsYou = const [],
    this.live = const [],
    this.readyToClose = const [],
    this.history = const [],
    this.skewMs = 0,
  });

  bool get isAuthority => role == 'authority';

  /// An authority timestamp on this device's clock.
  int? local(int? authorityMs) => authorityMs == null ? null : authorityMs + skewMs;

  SupervisorNode? node(String id) {
    for (final n in sessions) {
      if (n.id == id) return n;
    }
    return null;
  }

  /// The nodes a list of ids names, in the served order; an id with no node is skipped.
  List<SupervisorNode> nodesOf(List<String> ids) => ids.map(node).whereType<SupervisorNode>().toList(growable: false);

  /// The servers that did not answer the last scan.
  List<SupervisorServer> get silent => servers.where((s) => !s.ok).toList(growable: false);

  /// Null when the body is not a state at all (no `role`): unknown, never "empty".
  /// [receivedAt] is this device's clock when the answer arrived.
  static SupervisorState? fromJson(dynamic j, {required DateTime receivedAt}) {
    if (j is! Map) return null;
    final role = _str(j['role']);
    if (role == null) return null;
    final now = _int(j['now']);
    final auth = j['authority'];
    return SupervisorState(
      role: role,
      enabled: j['enabled'] != false,
      authorityName: auth is Map ? _str(auth['name']) : null,
      at: _int(j['at']),
      everyMs: _int(j['everyMs']),
      complete: j['complete'] == true,
      servers: _list(j['servers'], SupervisorServer.fromJson),
      sessions: _list(j['sessions'], SupervisorNode.fromJson),
      needsYou: _ids(j['needsYou']),
      live: _ids(j['live']),
      readyToClose: _ids(j['readyToClose']),
      history: _list(j['history'], JournalEntry.fromJson),
      skewMs: now == null ? 0 : receivedAt.millisecondsSinceEpoch - now,
    );
  }
}

String? _str(dynamic v) => v is String && v.isNotEmpty ? v : null;

int? _int(dynamic v) => v is int ? v : (v is num && v.isFinite ? v.toInt() : null);

List<T> _list<T>(dynamic v, T? Function(dynamic) parse) =>
    v is List ? List.unmodifiable(v.map(parse).whereType<T>()) : const [];

List<String> _ids(dynamic v) => v is List ? List.unmodifiable(v.whereType<String>()) : const [];

List<SupervisorItem> _items(dynamic v) => _list(v, SupervisorItem.fromJson);
