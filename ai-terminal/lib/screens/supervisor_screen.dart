// #475 - the Supervisor: the fleet's one supervisor, apart from the session list but never
// hidden. Its dispatcher (the Claude Code session the authority runs for the cases the rules
// cannot settle) is not a row among the sessions; this page is where the owner reaches it:
//   * the dispatcher - what it is doing, Pause / Resume, and Talk to it (opens its session);
//   * what waits on you - the supervisor's cards and escalations, answered in the inbox (#492);
//   * open cases     - what the rules handed it, and whether it took them;
//   * autonomy       - each class of action: act on its own, or ask you first (a card);
//   * decisions      - what it did, newest first: the case, what it did, how to undo it.
//
// Every rule is the SERVER's (GET /api/supervisor/state on the lease authority, found by
// `askSupervisor`); this page only shows what it said and sends the owner's two switches.
// On a wide window it is what the split's detail pane shows ([DetailPane.supervisor]); on a
// phone it is pushed full screen.

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../api/supervisor_models.dart';
import '../services/app_config.dart';
import '../services/session_repository.dart';
import '../services/supervisor_lookup.dart';
import '../util/inbox_queue.dart' show supervisorItemsOf;
import '../util/open_inbox.dart';
import '../util/supervisor_authority.dart';
import '../util/supervisor_session.dart';
import '../widgets/empty_state.dart';
import '../widgets/format_utils.dart' show clockTime, relativeTime;
import 'journal_screen.dart' show journalRefreshPeriod;

/// The dispatcher in one line, from the server's own word for it and its open cases.
String supervisorStateLine(SupervisorDispatcher? d, int openCases) {
  final cases = openCases == 1 ? '1 open case' : '$openCases open cases';
  if (d == null) return 'This server does not run a dispatcher';
  if (!d.enabled || d.state == 'off') return 'Off: the dispatcher is switched off in the config';
  if (d.paused) return 'Paused: new cases go straight to you';
  if (d.capped || d.state == 'capped') return 'At its usage cap: new cases go to you';
  if (d.id == null) return openCases == 0 ? 'Not running: it starts when a case needs it' : 'Starting: $cases wait for it';
  final word = d.status ?? d.state;
  if (word == 'working') return 'Working - $cases';
  if (word == 'waiting') return 'Waiting on a prompt - $cases';
  return 'Idle - $cases';
}

/// What a class of action means, for the autonomy switches.
String supervisorClassLabel(String cls) => switch (cls) {
      'wake' => 'Wake a session with the facts',
      'coach' => 'Coach a session that goes in circles',
      'answer' => 'Answer for you (only what can be undone)',
      'lead' => 'Stand in for a lost lead',
      'close' => 'Close a finished session',
      'spawn' => 'Replace a stuck session',
      _ => cls,
    };

/// What a rule or verb did, in a word or two, for the decisions feed.
String supervisorRuleLabel(String? rule) => switch (rule) {
      null => 'Action',
      'R2' => 'Lost lead',
      'R3' => 'No progress',
      'R4' => 'Waits on you',
      'R5' => 'Close-out',
      'R6' => 'Hung turn',
      'R7' => 'Agent gone',
      'R9' => 'Going in circles',
      'wake' => 'Woke',
      'coach' => 'Coached',
      'answer' => 'Answered for you',
      'lead' => 'Stood in as lead',
      'close' => 'Closed',
      'spawn' => 'Replaced',
      'owner' => 'Your decision',
      'resolve' => 'Resolved',
      _ => rule,
    };

/// A case's progress in a few words.
String supervisorCaseProgress(SupervisorCase c) {
  if (c.waitsOnOwner) return c.checking ? 'the supervisor looks first' : 'with you';
  if (c.takenAt != null) return 'taken';
  if (c.deliveredAt != null) return 'handed to the dispatcher';
  return 'open';
}

/// What each card's record line says: what the owner did with this class's cards.
String supervisorAutonomyRecord(SupervisorAutonomy a) {
  final parts = <String>[
    if (a.pending > 0) '${a.pending} waiting',
    if (a.approved > 0) '${a.approved} approved',
    if (a.dismissed > 0) '${a.dismissed} dismissed',
    if (a.edited > 0) '${a.edited} edited',
    if (a.told > 0) '${a.told} redirected',
  ];
  return parts.isEmpty ? 'No cards yet' : parts.join(' - ');
}

class SupervisorScreen extends StatefulWidget {
  const SupervisorScreen({
    super.key,
    required this.onOpenSession,
    this.embedded = false,
    this.servers,
    this.clientFactory,
    this.repository,
    this.refreshFloor = const Duration(seconds: 30),
    this.onOpenInbox,
  });

  /// Opens a session the way a tap on its row in the session list does.
  final void Function(Session session) onOpenSession;

  /// Shown in the split view's detail pane: no back button.
  final bool embedded;

  /// Test seam: the configured servers. Defaults to [AppConfig.servers].
  final List<ServerConfig> Function()? servers;

  /// Test seam: the client for a server. Defaults to [ApiClient.new].
  final ApiClient Function(ServerConfig server)? clientFactory;

  /// Where a session's full row is looked up, so opening one paints at once.
  final SessionRepository? repository;

  /// The shortest refresh period; the served `everyMs` sets it when longer.
  final Duration refreshFloor;

  /// Test seam: opens the inbox. Defaults to the app's one [openInbox].
  @visibleForTesting
  final VoidCallback? onOpenInbox;

  @override
  State<SupervisorScreen> createState() => _SupervisorScreenState();
}

class _SupervisorScreenState extends State<SupervisorScreen> {
  SupervisorFind? _find;
  bool _asking = false;
  Timer? _timer;

  /// A switch whose POST is out: `pause`, or `autonomy:<class>`.
  final Set<String> _sending = <String>{};

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  SessionRepository get _repo => widget.repository ?? SessionRepository.instance;

  @override
  void initState() {
    super.initState();
    _find = SupervisorFeed.instance.find; // paint the last answer at once, then ask
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_asking) return;
    _asking = true;
    _timer?.cancel();
    try {
      final find = await askSupervisor(_servers, _client);
      if (!mounted) return;
      SupervisorFeed.instance.publish(find); // the Supervisor entry reads the same answer
      setState(() => _find = find);
    } finally {
      _asking = false;
      if (mounted) {
        _timer = Timer(journalRefreshPeriod(_find?.state?.everyMs, widget.refreshFloor), () => unawaited(_refresh()));
      }
    }
  }

  /// The app's row for a session the authority names; null when nothing here reaches it.
  Session? _sessionFor(String? id, String? server, {String? name}) {
    if (id == null) return null;
    final n = _find?.state?.node(id);
    return supervisedSession(
        id: id, server: n?.server ?? server, servers: _servers, current: _repo.current,
        name: n?.name ?? name, cwd: n?.cwd, status: n?.status, agent: n?.agent);
  }

  /// The dispatcher's session: on the authority, which is the server that answered. The app's
  /// own name for that server finds it, never the name the scan gives it (a server may call
  /// itself something else than the app does).
  Session? _dispatcherSession(SupervisorFind find, SupervisorDispatcher d) {
    final id = d.id;
    if (id == null) return null;
    final n = _find?.state?.node(id);
    return supervisedSession(
        id: id, server: find.server?.name, servers: _servers, current: _repo.current,
        name: n?.name ?? 'web-terminal supervisor', cwd: n?.cwd, status: n?.status, agent: n?.agent);
  }

  Future<void> _send(String key, Future<void> Function(ApiClient api) call, String failed) async {
    final authority = _find?.server;
    if (authority == null || _sending.contains(key)) return;
    setState(() => _sending.add(key));
    try {
      await call(_client(authority));
      await _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            key: const ValueKey('supervisor-send-failed'),
            content: Text('$failed: ${e is ApiException ? e.message : e}')));
      }
    } finally {
      if (mounted) setState(() => _sending.remove(key));
    }
  }

  void _setPaused(bool paused) => unawaited(_send('pause', (api) => api.setSupervisorPaused(paused),
      paused ? 'Not paused' : 'Not resumed'));

  void _setMode(String cls, String mode) => unawaited(_send('autonomy:$cls', (api) => api.setSupervisorAutonomy(cls, mode),
      'Not changed'));

  void _openInbox() {
    final open = widget.onOpenInbox;
    if (open != null) {
      open();
      return;
    }
    openInbox(Navigator.of(context), openSession: widget.onOpenSession);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: !widget.embedded,
        title: const Text('Supervisor'),
        actions: [
          IconButton(
            key: const ValueKey('supervisor-refresh'),
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
          EmptyState(key: const ValueKey('supervisor-empty'), icon: Icons.shield_outlined, title: find.message),
        ]),
      );
    }
    final theme = Theme.of(context);
    final now = DateTime.now();
    final open = state.cases.where((c) => c.open).toList(growable: false);
    final yours = supervisorItemsOf(state, find.server, _repo.current).length;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        key: const ValueKey('supervisor-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          _dispatcherCard(context, find, state, open.length, now),
          if (yours > 0)
            ListTile(
              key: const ValueKey('supervisor-open-inbox'),
              dense: true,
              leading: Icon(Icons.inbox_outlined, color: theme.colorScheme.primary),
              title: Text(yours == 1 ? '1 card or question waits on you - open the inbox' : '$yours cards or questions wait on you - open the inbox'),
              trailing: const Icon(Icons.chevron_right),
              onTap: _openInbox,
            ),
          _Header('Open cases', open.length, key: const ValueKey('supervisor-section-cases')),
          if (open.isEmpty) const _None('No open case.'),
          for (final c in open) _caseRow(context, state, c, now),
          _Header('Autonomy', null, key: const ValueKey('supervisor-section-autonomy')),
          const _None('Act: it does it on its own. Ask: it makes a card for you to approve.'),
          if (state.autonomy.isEmpty) const _None('This server does not say.'),
          for (final a in state.autonomy) _autonomyRow(context, a),
          _Header('Recent decisions', state.actions.length, key: const ValueKey('supervisor-section-decisions')),
          if (state.actions.isEmpty) const _None('Nothing yet.'),
          for (final (i, a) in state.actions.indexed) _actionRow(context, state, a, i, now),
        ],
      ),
    );
  }

  Widget _dispatcherCard(BuildContext context, SupervisorFind find, SupervisorState state, int openCases, DateTime now) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final d = state.dispatcher;
    final session = d == null ? null : _dispatcherSession(find, d);
    final started = d == null ? null : state.local(d.startedAt);
    final pausing = _sending.contains('pause');
    return Card(
      key: const ValueKey('supervisor-dispatcher'),
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(Icons.shield_outlined, color: theme.colorScheme.primary),
            const SizedBox(width: 8),
            Expanded(child: Text('Dispatcher', style: theme.textTheme.titleMedium)),
            Text(find.server!.name, style: muted),
          ]),
          const SizedBox(height: 6),
          Text(supervisorStateLine(d, openCases), key: const ValueKey('supervisor-state'), style: theme.textTheme.bodyLarge),
          if (started != null && d?.id != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text('Started ${relativeTime(started, now: now)} (${clockTime(started)})', style: muted),
            ),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton.icon(
              key: const ValueKey('supervisor-talk'),
              onPressed: session == null ? null : () => widget.onOpenSession(session),
              icon: const Icon(Icons.chat_bubble_outline, size: 18),
              label: Text(session == null ? 'Not running' : 'Talk to it'),
            ),
            if (d != null && d.enabled)
              OutlinedButton.icon(
                key: ValueKey(d.paused ? 'supervisor-resume' : 'supervisor-pause'),
                onPressed: pausing ? null : () => _setPaused(!d.paused),
                icon: Icon(d.paused ? Icons.play_arrow : Icons.pause, size: 18),
                label: Text(d.paused ? 'Resume' : 'Pause'),
              ),
          ]),
        ]),
      ),
    );
  }

  Widget _caseRow(BuildContext context, SupervisorState state, SupervisorCase c, DateTime now) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final session = _sessionFor(c.sessionId, c.server, name: c.name);
    final opened = state.local(c.openedAt);
    return ListTile(
      key: ValueKey('supervisor-case-${c.id}'),
      dense: true,
      title: Row(children: [
        _Badge(supervisorRuleLabel(c.rule)),
        const SizedBox(width: 8),
        Flexible(child: Text(c.name ?? c.sessionId ?? '?', overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall)),
        const SizedBox(width: 8),
        Flexible(child: Text(c.server ?? '', overflow: TextOverflow.ellipsis, style: muted)),
      ]),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (c.line.isNotEmpty) Text(c.line, style: theme.textTheme.bodyMedium, maxLines: 3, overflow: TextOverflow.ellipsis),
        Text(
          [supervisorCaseProgress(c), if (opened != null) 'opened ${relativeTime(opened, now: now)}', 'case ${c.id}'].join(' - '),
          style: muted,
        ),
      ]),
      onTap: session == null ? null : () => widget.onOpenSession(session),
    );
  }

  Widget _autonomyRow(BuildContext context, SupervisorAutonomy a) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final busy = _sending.contains('autonomy:${a.cls}');
    return Padding(
      key: ValueKey('supervisor-autonomy-${a.cls}'),
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(supervisorClassLabel(a.cls), style: theme.textTheme.bodyMedium),
            Text(supervisorAutonomyRecord(a), style: muted),
          ]),
        ),
        const SizedBox(width: 8),
        SegmentedButton<String>(
          key: ValueKey('supervisor-mode-${a.cls}'),
          showSelectedIcon: false,
          style: const ButtonStyle(visualDensity: VisualDensity.compact),
          segments: const [
            ButtonSegment(value: 'act', label: Text('Act')),
            ButtonSegment(value: 'recommend', label: Text('Ask')),
          ],
          selected: {a.mode},
          onSelectionChanged: busy ? null : (v) => _setMode(a.cls, v.first),
        ),
      ]),
    );
  }

  Widget _actionRow(BuildContext context, SupervisorState state, SupervisorAction a, int i, DateTime now) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final id = a.sessionId;
    final n = id == null ? null : state.node(id);
    final session = _sessionFor(id, a.server);
    final at = state.local(a.at);
    // An id the scan no longer lists is named by its first 8 characters, as the CLI does.
    final who = n?.name ?? (id == null ? null : (id.length < 8 ? id : id.substring(0, 8)));
    return ListTile(
      key: ValueKey('supervisor-action-$i'),
      dense: true,
      title: Row(children: [
        Text(supervisorRuleLabel(a.rule), style: theme.textTheme.titleSmall),
        if (who != null) ...[
          const SizedBox(width: 8),
          Flexible(child: Text(who, overflow: TextOverflow.ellipsis, style: muted)),
        ],
        const Spacer(),
        if (at != null) Text(relativeTime(at, now: now), style: muted),
      ]),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (a.text.isNotEmpty) Text(a.text, style: theme.textTheme.bodyMedium, maxLines: 3, overflow: TextOverflow.ellipsis),
        if (a.undo != null)
          Text('To undo: ${a.undo}', key: ValueKey('supervisor-undo-$i'),
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary)),
        Text([if (a.caseId != null) 'case ${a.caseId}', if (a.outcome != null) a.outcome!].join(' - '), style: muted),
      ]),
      onTap: session == null ? null : () => widget.onOpenSession(session),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.title, this.count, {super.key});
  final String title;
  final int? count;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(count == null ? title : '$title ($count)', style: Theme.of(context).textTheme.titleMedium),
      );
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
  const _Badge(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(border: Border.all(color: color), borderRadius: BorderRadius.circular(4)),
      child: Text(text, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color)),
    );
  }
}
