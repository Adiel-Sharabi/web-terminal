// #529 - Mission Control's Usage tab: where the weekly limit went. The weekly totals, the
// sessions that burned the most in the last days and WHY each is big, and what the check-in
// scan decided (#540) - the server's `GET /api/usage-ledger?cluster=1`, which reads the ledger
// claude-memory's usage-monitor.js keeps and merges the other machines' ledgers. The rules
// (what a week holds, how sessions rank, the reasons) are the server's; this only asks and
// shows. The units are an ESTIMATE of weighted cost, and a session's number a lower bound (a
// ledger window names only its top 3 sessions): the screen says both.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../api/usage_ledger_models.dart';
import '../../services/session_repository.dart';

class McUsageView extends StatefulWidget {
  const McUsageView({
    super.key,
    required this.servers,
    required this.client,
    required this.onOpenSession,
    this.repository,
    this.canAsk,
    this.every = const Duration(minutes: 5),
  });

  final List<ServerConfig> Function() servers;
  final ApiClient Function(ServerConfig) client;

  /// Opens the web-terminal session a row belongs to (only offered while it exists).
  final void Function(String sessionId) onOpenSession;

  /// Injectable for tests; defaults to [SessionRepository.instance].
  final SessionRepository? repository;

  /// Whether [server] can be asked: by default one that advertises `usage-ledger` and answers.
  final bool Function(ServerConfig server)? canAsk;
  final Duration every;

  @override
  State<McUsageView> createState() => _McUsageViewState();
}

class _McUsageViewState extends State<McUsageView> {
  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  UsageLedger? _ledger;
  String? _down;
  bool _asking = false;
  Timer? _timer;
  StreamSubscription<List<Session>>? _sub;

  bool _can(ServerConfig sv) =>
      widget.canAsk?.call(sv) ?? (_repo.supportsUsageLedger(sv.baseUrl) && _repo.serverUsable[sv.baseUrl] == true);

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
    _timer = Timer.periodic(widget.every, (_) {
      if (_repo.isForeground) unawaited(_refresh());
    });
    // A server whose capabilities were not known at the first ask: ask now, not at the next tick.
    _sub = _repo.sessions.listen((_) {
      if (mounted && _ledger == null && widget.servers().any(_can)) unawaited(_refresh());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  /// The first server that answers speaks for the cluster (`?cluster=1` merges the rest). All
  /// failing is the ledger UNKNOWN, with the first reason - never an empty ledger.
  Future<void> _refresh() async {
    if (_asking) return;
    final servers = widget.servers();
    final usable = servers.where(_can).toList();
    if (usable.isEmpty) {
      if (mounted) {
        setState(() {
          _ledger = null;
          _down = servers.isEmpty ? null : 'No server that keeps a usage ledger is reachable (it needs a server of this release or later).';
        });
      }
      return;
    }
    _asking = true;
    UsageLedger? got;
    String? firstError;
    try {
      for (final sv in usable) {
        try {
          got = await widget.client(sv).usageLedger();
          break;
        } on ApiException catch (e) {
          firstError ??= '${sv.name} says ${e.message}';
        } catch (e) {
          firstError ??= '${sv.name} could not be asked';
        }
      }
    } finally {
      _asking = false;
    }
    if (!mounted) return;
    setState(() {
      _ledger = got;
      _down = got == null ? firstError : null;
    });
  }

  static String _m(double v) => '${v.toStringAsFixed(1)}M';

  /// `2026-11-23` -> `Nov 23`.
  static String _weekLabel(String weekOf) {
    final d = DateTime.tryParse(weekOf);
    if (d == null) return weekOf;
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${names[d.month - 1]} ${d.day}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = _ledger;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        key: const ValueKey('mc-usage-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: [
          Text(
            "Weighted cost units, in millions: an estimate (the weekly limit's real weighting is not published).",
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          if (_down != null) Text(_down!, key: const ValueKey('mc-usage-down'), style: theme.textTheme.bodyMedium),
          if (l == null && _down == null) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
          if (l != null) ..._ledgerBody(context, l),
        ],
      ),
    );
  }

  List<Widget> _ledgerBody(BuildContext context, UsageLedger l) {
    final theme = Theme.of(context);
    return [
      if (l.machines.length > 1)
        Text('Machines: ${l.machines.join(', ')}', key: const ValueKey('mc-usage-machines'), style: theme.textTheme.bodySmall),
      for (final s in l.skipped)
        Text('${s.machine}: not in this view${s.reason == null ? '' : ' (${s.reason})'}',
            key: ValueKey('mc-usage-skipped-${s.machine}'), style: theme.textTheme.bodySmall),
      if (l.unreachable.isNotEmpty)
        Text('Could not be asked: ${l.unreachable.join(', ')}', key: const ValueKey('mc-usage-unreachable'), style: theme.textTheme.bodySmall),
      const SizedBox(height: 8),
      Text('By week', style: theme.textTheme.titleMedium),
      if (l.weeks.isEmpty) const Text('The ledger holds no usage yet.', key: ValueKey('mc-usage-no-weeks')),
      ..._weeks(context, l),
      if (l.checkInsTotal > 0) ...[
        const SizedBox(height: 16),
        Text('Check-ins, last ${l.days} days', style: theme.textTheme.titleMedium),
        Text(
          'Woken ${l.checkInsWoken} · skipped ${l.checkInsSkipped} · told ${l.checkInsTold} · handed off ${l.checkInsHandedOff}',
          key: const ValueKey('mc-usage-checkins'),
        ),
        Text('A woken session re-reads its whole context cold; a skip or a hand-off costs nothing.', style: theme.textTheme.bodySmall),
      ],
      const SizedBox(height: 16),
      Text('Who burned the most, last ${l.days} days', style: theme.textTheme.titleMedium),
      Text(
        "Counted where a session ranked in a window's top 3, so every number here is a lower bound.",
        style: theme.textTheme.bodySmall,
      ),
      const SizedBox(height: 4),
      if (l.sessions.isEmpty) const Text('No session ranked in the ledger in this period.', key: ValueKey('mc-usage-no-sessions')),
      for (var i = 0; i < l.sessions.length; i++) _sessionCard(context, i + 1, l.sessions[i], showMachine: l.machines.length > 1),
    ];
  }

  List<Widget> _weeks(BuildContext context, UsageLedger l) {
    final theme = Theme.of(context);
    final most = l.weeks.fold<double>(0, (m, w) => w.unitsM > m ? w.unitsM : m);
    return [
      for (final w in l.weeks)
        Padding(
          key: ValueKey('mc-usage-week-${w.weekOf}'),
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('Week of ${_weekLabel(w.weekOf)}${w.partial ? ' (so far)' : ''}')),
              Text(_m(w.unitsM), style: theme.textTheme.titleSmall),
            ]),
            LinearProgressIndicator(value: most > 0 ? (w.unitsM / most).clamp(0.0, 1.0) : 0, minHeight: 4),
            Text(
              '${_m(w.perDayM)}/day over ${w.days} day${w.days == 1 ? '' : 's'}'
              '${w.subagentShare == null ? '' : ' · subagents ${(w.subagentShare! * 100).round()}%'}'
              '${w.opusM > 0 ? ' · opus ${_m(w.opusM)}' : ''}'
              '${w.wakeCount > 0 ? ' · ${w.wakeCount} wake-ups (${_m(w.wakeM)})' : ''}',
              style: theme.textTheme.bodySmall,
            ),
          ]),
        ),
    ];
  }

  bool _exists(String id) => _repo.current.any((s) => s.id.toLowerCase() == id.toLowerCase());

  Widget _sessionCard(BuildContext context, int rank, UsageSession s, {required bool showMachine}) {
    final theme = Theme.of(context);
    final linked = s.sessionId != null;
    final title = s.name ?? 'Session ${s.id}';
    final bits = <String>[
      _m(s.unitsM),
      '${s.windows} window${s.windows == 1 ? '' : 's'}',
      if (showMachine && s.machine.isNotEmpty) s.machine,
      if (!linked) 'no longer open',
    ];
    return Card(
      key: ValueKey('mc-usage-row-${s.machine}-${s.id}'),
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text('$rank.', style: theme.textTheme.titleSmall),
            const SizedBox(width: 8),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis),
                Text(bits.join(' · '), style: theme.textTheme.bodySmall),
              ]),
            ),
            if (linked)
              IconButton(
                key: ValueKey('mc-usage-open-${s.id}'),
                tooltip: _exists(s.sessionId!) ? 'Open the session' : 'Open the session (not listed here yet)',
                icon: const Icon(Icons.open_in_new),
                onPressed: () => widget.onOpenSession(s.sessionId!),
              ),
          ]),
          for (final w in s.why)
            Padding(
              padding: const EdgeInsets.only(left: 24, top: 2),
              child: Text('• ${w.text}', key: ValueKey('mc-usage-why-${s.id}-${w.code}'), style: theme.textTheme.bodySmall),
            ),
        ]),
      ),
    );
  }
}
