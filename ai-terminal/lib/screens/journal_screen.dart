// #466 - the Journal page: the supervisor's view of the whole cluster, read from the
// lease authority (`GET /api/supervisor/state`). Four sections, in this order:
//   * Needs you      - sessions whose reported wait is on you, oldest first, as served;
//   * Live           - every other live session: what it is doing, what it waits on,
//                      and whether its lead is gone;
//   * Ready to close - reported done, idle, nobody looking; one tap closes it through
//                      the app's one kill flow ([confirmAndKillSession]);
//   * History        - what ended, grouped by day, with a search field.
//
// Every rule is the SERVER's (lib/supervisor.js decides each section and each orphan
// verdict); this page only shows what it said, as text. WHICH server to ask is the one
// pure rule in `util/supervisor_authority.dart`.
//
// On a wide window it is what the split's detail pane shows ([DetailPane.journal]); on a
// phone it is pushed full screen.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../api/supervisor_models.dart';
import '../services/app_config.dart';
import '../services/session_repository.dart';
import '../services/supervisor_lookup.dart';
import '../util/open_inbox.dart';
import '../util/supervisor_authority.dart';
import '../widgets/brief_item_row.dart' show briefStateLabel;
import '../widgets/empty_state.dart';
import '../widgets/format_utils.dart' show clockTime, relativeTime;
import '../widgets/session_action_sheet.dart' show confirmAndKillSession;

/// What History's search matches: name, machine, goal, headline, what it did and every
/// item ref, case-insensitively. Empty [query] matches everything.
bool journalEntryMatches(JournalEntry e, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  final hay = <String?>[e.name, e.machine, e.goal, e.headline, e.did, for (final i in e.items) i.ref];
  return hay.any((s) => s != null && s.toLowerCase().contains(q));
}

/// How long the page waits between reads: the served scan period, never under [floor]
/// (30 s by default), and never over a day (a served period too large for a [Duration]
/// would fire at once, every time). An authority that said nothing is read once a minute.
Duration journalRefreshPeriod(int? everyMs, Duration floor) => Duration(
    milliseconds: math.max(math.min(everyMs ?? 60000, const Duration(days: 1).inMilliseconds), floor.inMilliseconds));

/// A session id as the server mints it. Anything else is never sent back in a URL: a
/// node comes from the authority, and its id would ride another server's token.
final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);

/// A wait's length, short: `<1m`, `12m`, `3h`, `2d`.
String waitedFor(int? sinceMs, DateTime now) {
  if (sinceMs == null) return '';
  final d = now.difference(DateTime.fromMillisecondsSinceEpoch(sinceMs));
  if (d.inMinutes < 1) return '<1m';
  if (d.inHours < 1) return '${d.inMinutes}m';
  if (d.inDays < 1) return '${d.inHours}h';
  return '${d.inDays}d';
}

class JournalScreen extends StatefulWidget {
  const JournalScreen({
    super.key,
    required this.onOpenSession,
    this.embedded = false,
    this.servers,
    this.clientFactory,
    this.repository,
    this.refreshFloor = const Duration(seconds: 30),
    this.onOpenInbox,
  });

  /// Test seam: opens the inbox (#492). Defaults to the app's one [openInbox].
  @visibleForTesting
  final VoidCallback? onOpenInbox;

  /// Opens a session the way a tap on its row in the session list does.
  final void Function(Session session) onOpenSession;

  /// Shown in the split view's detail pane: no back button.
  final bool embedded;

  /// Test seam: the configured servers. Defaults to [AppConfig.servers].
  final List<ServerConfig> Function()? servers;

  /// Test seam: the client for a server. Defaults to [ApiClient.new].
  final ApiClient Function(ServerConfig server)? clientFactory;

  /// Where a listed session's full row is looked up, so opening one paints at once.
  final SessionRepository? repository;

  /// The shortest refresh period; the served `everyMs` sets it when longer.
  final Duration refreshFloor;

  @override
  State<JournalScreen> createState() => _JournalScreenState();
}

class _JournalScreenState extends State<JournalScreen> {
  SupervisorFind? _find;
  bool _asking = false;
  Timer? _timer;
  String _query = '';
  final TextEditingController _search = TextEditingController();

  /// Sessions closed from here that the last scan still lists: hidden until a scan
  /// no longer does (the authority scans once a minute).
  final Set<String> _closed = <String>{};

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  SessionRepository get _repo => widget.repository ?? SessionRepository.instance;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_asking) return;
    _asking = true;
    _timer?.cancel();
    final servers = _servers;
    try {
      final find = await askSupervisor(servers, _client);
      if (!mounted) return;
      setState(() {
        _find = find;
        final listed = {for (final n in find.state?.sessions ?? const <SupervisorNode>[]) n.id};
        _closed.retainAll(listed);
      });
    } finally {
      _asking = false;
      // Rescheduled whatever happened above, so one bad read never ends the refresh.
      if (mounted) {
        _timer = Timer(journalRefreshPeriod(_find?.state?.everyMs, widget.refreshFloor), () => unawaited(_refresh()));
      }
    }
  }

  /// The configured server a node lives on, by the name the authority gave it.
  ServerConfig? _serverNamed(String? name) {
    if (name == null) return null;
    final want = name.toLowerCase();
    for (final s in _servers) {
      if (s.name.toLowerCase() == want) return s;
    }
    return null;
  }

  /// The app's own live row for [n], when it has one.
  Session? _liveRow(SupervisorNode n, ServerConfig server) {
    for (final s in _repo.current) {
      if (s.id == n.id && s.server.baseUrl == server.baseUrl) return s;
    }
    return null;
  }

  /// The app's own row for [n] when it has one, else one built from the node. Null when
  /// its server is not in this app's list, or its id is not a session id: nothing here
  /// could (or may) reach it.
  Session? _sessionOf(SupervisorNode n) {
    final server = _serverNamed(n.server);
    if (server == null || !_uuid.hasMatch(n.id)) return null;
    return _liveRow(n, server) ?? Session.fromJson(server, {
      'id': n.id,
      'name': n.name ?? n.id,
      'cwd': n.cwd ?? '',
      'status': n.status ?? 'idle',
      'agent': n.agent,
    });
  }

  Future<void> _close(SupervisorNode n) async {
    final s = _sessionOf(n);
    if (s == null) return;
    // "Ready to close" is the last scan's verdict, up to a minute or two old. The app's
    // own row is fresher: a session that started working again since is not closed.
    if (s.status != 'idle') {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          key: const ValueKey('journal-close-refused'),
          content: Text('Not closed: ${s.name} is ${s.status} now, not idle')));
      // The refusal read the app's own row; make sure the next look is a fresh one.
      unawaited(_repo.refresh());
      return;
    }
    var killed = false;
    await confirmAndKillSession(context, s, api: _client(s.server), onChanged: () {
      killed = true;
      unawaited(_repo.refresh());
    });
    if (!killed || !mounted) return;
    setState(() => _closed.add(n.id));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: !widget.embedded,
        title: const Text('Journal'),
        actions: [
          IconButton(
            key: const ValueKey('journal-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () => unawaited(_refresh()),
          ),
        ],
      ),
      body: _body(context),
    );
  }

  Widget _body(BuildContext context) {
    final find = _find;
    if (find == null) return const Center(child: CircularProgressIndicator());
    final state = find.state;
    if (!find.found || state == null) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
          const SizedBox(height: 80),
          EmptyState(
            key: const ValueKey('journal-empty'),
            icon: Icons.menu_book_outlined,
            title: find.message,
          ),
        ]),
      );
    }
    final theme = Theme.of(context);
    final now = DateTime.now();
    List<SupervisorNode> shown(List<String> ids) =>
        state.nodesOf(ids).where((n) => !_closed.contains(n.id)).toList(growable: false);
    final needs = shown(state.needsYou);
    final live = shown(state.live);
    final ready = shown(state.readyToClose);
    final history = state.history.where((e) => journalEntryMatches(e, _query)).toList(growable: false);
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        key: const ValueKey('journal-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          _scanLine(theme, find, state, now),
          _Header('Needs you', needs.length, key: const ValueKey('journal-section-needs')),
          // #492: the inbox is the ONE Needs-you list; the journal keeps only the count
          // (the supervisor's needsYou, not the inbox's cards) and the way there.
          if (needs.isEmpty) const _None('Nothing is waiting on you.') else _openInboxRow(theme, needs.length),
          _Header('Live', live.length, key: const ValueKey('journal-section-live')),
          if (live.isEmpty) const _None('No other live session.'),
          for (final n in live) _nodeRow(context, n, now, section: 'live'),
          _Header('Ready to close', ready.length, key: const ValueKey('journal-section-ready')),
          if (ready.isEmpty) const _None('Nothing is ready to close.'),
          for (final n in ready) _nodeRow(context, n, now, section: 'ready'),
          _Header('History', state.history.length, key: const ValueKey('journal-section-history')),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              key: const ValueKey('journal-search'),
              controller: _search,
              onChanged: (v) => setState(() => _query = v),
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search, size: 18),
                hintText: 'Search name, machine, goal, headline, item',
                suffixIcon: _query.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear',
                        icon: const Icon(Icons.clear, size: 18),
                        onPressed: () => setState(() {
                          _search.clear();
                          _query = '';
                        }),
                      ),
              ),
            ),
          ),
          if (history.isEmpty) _None(_query.isEmpty ? 'Nothing has ended yet.' : 'No ended session matches.'),
          ..._historyRows(theme, state, history, now),
        ],
      ),
    );
  }

  void _openInbox() {
    final open = widget.onOpenInbox;
    if (open != null) {
      open();
      return;
    }
    openInbox(Navigator.of(context), openSession: widget.onOpenSession);
  }

  Widget _openInboxRow(ThemeData theme, int n) => ListTile(
        key: const ValueKey('journal-open-inbox'),
        dense: true,
        leading: Icon(Icons.inbox_outlined, color: theme.colorScheme.primary),
        title: Text('$n need you - open the inbox'),
        trailing: const Icon(Icons.chevron_right),
        onTap: _openInbox,
      );

  Widget _scanLine(ThemeData theme, SupervisorFind find, SupervisorState state, DateTime now) {
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final at = state.local(state.at);
    final silent = state.silent;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          at == null
              ? 'No scan yet on ${find.server!.name}'
              : 'Scanned ${relativeTime(at, now: now)} (${clockTime(at)}) on ${find.server!.name}',
          key: const ValueKey('journal-scan'),
          style: muted,
        ),
        if (!state.complete && at != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              silent.isEmpty
                  ? 'Some server did not answer the last scan'
                  : 'Did not answer: ${silent.map((s) => s.reason == null ? s.name : '${s.name} (${s.reason})').join(', ')}',
              key: const ValueKey('journal-incomplete'),
              style: muted?.copyWith(color: theme.colorScheme.error),
            ),
          ),
      ]),
    );
  }

  Widget _nodeRow(BuildContext context, SupervisorNode n, DateTime now, {required String section}) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final session = _sessionOf(n);
    final w = n.wait;
    final lines = <Widget>[
      if (n.goal != null) Text('Goal: ${n.goal}', style: muted, maxLines: 2, overflow: TextOverflow.ellipsis),
      if (section == 'needs' && w != null)
        Text(
          [if (w.what.isNotEmpty) w.what, if (w.at != null) 'waiting ${waitedFor(_local(w.at), now)}'].join(' - '),
          style: theme.textTheme.bodyMedium,
        ),
      if (section != 'needs' && (n.headline ?? n.now) != null)
        Text(n.headline ?? n.now!, style: theme.textTheme.bodyMedium, maxLines: 2, overflow: TextOverflow.ellipsis),
      if (section == 'live' && w != null)
        Text(
          'Waits on ${w.on}${w.targetKind == null ? '' : ' (${w.targetKind})'}${w.what.isEmpty ? '' : ': ${w.what}'}',
          style: muted,
        ),
    ];
    final title = Row(children: [
      Flexible(child: Text(n.name ?? n.id, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall)),
      const SizedBox(width: 8),
      Flexible(child: Text(n.server ?? '?', overflow: TextOverflow.ellipsis, style: muted)),
      if (n.leadGone) ...[
        const SizedBox(width: 8),
        _Badge('lead gone', theme.colorScheme.error, key: ValueKey('journal-orphan-${n.id}')),
      ] else if (n.leadUnknown) ...[
        const SizedBox(width: 8),
        Text('lead unknown', key: ValueKey('journal-lead-unknown-${n.id}'), style: muted),
      ],
    ]);
    return ListTile(
      key: ValueKey('journal-$section-${n.id}'),
      dense: true,
      title: title,
      subtitle: lines.isEmpty ? null : Column(crossAxisAlignment: CrossAxisAlignment.start, children: lines),
      onTap: session == null ? null : () => widget.onOpenSession(session),
      trailing: section != 'ready'
          ? null
          : TextButton(
              key: ValueKey('journal-close-${n.id}'),
              onPressed: session == null ? null : () => unawaited(_close(n)),
              child: Text(session == null ? 'Not reachable' : 'Close'),
            ),
    );
  }

  /// An authority timestamp on this device's clock, by the shown state.
  int? _local(int? authorityMs) => _find?.state?.local(authorityMs);

  Iterable<Widget> _historyRows(ThemeData theme, SupervisorState st, List<JournalEntry> list, DateTime now) sync* {
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    String? day;
    for (final e in list) {
      final closed = st.local(e.closedAt);
      final d = _dayKey(closed);
      if (d != day) {
        day = d;
        yield Padding(
          key: ValueKey('journal-day-$d'),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Text(_dayLabel(closed, now), style: theme.textTheme.labelMedium),
        );
      }
      final did = e.headline ?? e.did;
      yield ListTile(
        key: ValueKey('journal-history-${e.machine}|${e.id}'),
        dense: true,
        title: Row(children: [
          Flexible(child: Text(e.name ?? e.id ?? '?', overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall)),
          const SizedBox(width: 8),
          Flexible(child: Text(e.machine ?? '?', overflow: TextOverflow.ellipsis, style: muted)),
        ]),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${e.why ?? 'ended'} at ${clockTime(closed)}', style: muted),
          if (e.goal != null) Text('Goal: ${e.goal}', style: muted, maxLines: 2, overflow: TextOverflow.ellipsis),
          if (did != null) Text(did, style: theme.textTheme.bodyMedium, maxLines: 2, overflow: TextOverflow.ellipsis),
          if (e.items.isNotEmpty)
            Text(
              e.items.map((i) => [i.ref ?? i.title, if (i.state != null) briefStateLabel(i.state!)].join(' ')).join(', '),
              style: muted,
            ),
        ]),
      );
    }
  }

  static String _dayKey(int? ms) {
    if (ms == null) return 'unknown';
    final t = DateTime.fromMillisecondsSinceEpoch(ms);
    String pad(int n) => n.toString().padLeft(2, '0');
    return '${t.year}-${pad(t.month)}-${pad(t.day)}';
  }

  static String _dayLabel(int? ms, DateTime now) {
    if (ms == null) return 'Unknown day';
    final key = _dayKey(ms);
    if (key == _dayKey(now.millisecondsSinceEpoch)) return 'Today';
    if (key == _dayKey(now.subtract(const Duration(days: 1)).millisecondsSinceEpoch)) return 'Yesterday';
    return key;
  }
}

class _Header extends StatelessWidget {
  const _Header(this.title, this.count, {super.key});
  final String title;
  final int count;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text('$title ($count)', style: theme.textTheme.titleMedium),
    );
  }
}

class _None extends StatelessWidget {
  const _None(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Text(text, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, this.color, {super.key});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        border: Border.all(color: color),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(text, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color)),
    );
  }
}
