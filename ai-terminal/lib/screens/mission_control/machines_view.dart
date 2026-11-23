// #507 - Mission Control's Machines tab: at first, the board's own Machines and Leases
// sections (#331, #428) on a page of their own, every configured server (cluster peers
// included) one card. The cards, the lease panel and their rules are the board's
// ([MachineCard], [LeasesPanel], [machineNoteFor], [askLeaseTable]); this only asks.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../services/session_repository.dart';
import '../../theme/app_theme.dart';
import '../../widgets/claude_account_sheet.dart';
import '../../widgets/lease_view.dart';
import '../work_board_screen.dart' show MachineCard, askLeaseTable, machineNoteFor;

class McMachinesView extends StatefulWidget {
  const McMachinesView({
    super.key,
    required this.servers,
    required this.client,
    required this.onOpenSession,
    this.repository,
    this.machineEvery = const Duration(seconds: 30),
    this.leaseEvery = const Duration(seconds: 10),
  });

  final List<ServerConfig> Function() servers;
  final ApiClient Function(ServerConfig) client;
  final void Function(Session session) onOpenSession;

  /// Injectable for tests; defaults to [SessionRepository.instance].
  final SessionRepository? repository;
  final Duration machineEvery;
  final Duration leaseEvery;

  @override
  State<McMachinesView> createState() => _McMachinesViewState();
}

class _McMachinesViewState extends State<McMachinesView> {
  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  final Map<String, ({MachineProfile? data, bool failed})> _machines = {};
  LeaseListing? _leaseTable;
  String? _leaseDown;
  bool _asking = false;
  Timer? _machineTimer;
  Timer? _leaseTimer;
  StreamSubscription<List<Session>>? _sub;
  List<Session> _sessions = const [];

  @override
  void initState() {
    super.initState();
    _sessions = _repo.current;
    _sub = _repo.sessions.listen((list) {
      if (mounted) setState(() => _sessions = list);
    });
    unawaited(_refreshMachines());
    unawaited(_refreshLeases());
    _machineTimer = Timer.periodic(widget.machineEvery, (_) {
      if (_repo.isForeground) unawaited(_refreshMachines());
    });
    _leaseTimer = Timer.periodic(widget.leaseEvery, (_) {
      if (_repo.isForeground) unawaited(_refreshLeases());
    });
  }

  @override
  void dispose() {
    _machineTimer?.cancel();
    _leaseTimer?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refreshMachines() async {
    final due = widget.servers()
        .where((sv) => _repo.supportsMachine(sv.baseUrl) && _repo.serverUsable[sv.baseUrl] == true)
        .toList();
    await Future.wait(due.map((sv) async {
      final p = await widget.client(sv).machine();
      // Unknown, not the previous reading: an old number would age into a confident lie.
      _machines[sv.baseUrl] = (data: p, failed: p == null);
    }));
    if (mounted) setState(() {});
  }

  List<ServerConfig> get _leaseServers =>
      widget.servers().where((sv) => _repo.supportsLeases(sv.baseUrl)).toList();

  Future<void> _refreshLeases() async {
    if (_asking) return;
    final usable = _leaseServers.where((sv) => _repo.serverUsable[sv.baseUrl] == true).toList();
    if (usable.isEmpty) {
      if (mounted) {
        setState(() {
          _leaseTable = null;
          _leaseDown = _leaseServers.isEmpty ? null : 'no server that answers lease calls is reachable';
        });
      }
      return;
    }
    _asking = true;
    try {
      final got = await askLeaseTable(usable, widget.client);
      if (!mounted) return;
      setState(() {
        _leaseTable = got.table;
        _leaseDown = got.down;
      });
    } finally {
      _asking = false;
    }
  }

  Session? _sessionById(String id) {
    final want = id.toLowerCase();
    for (final s in _sessions) {
      if (s.id.toLowerCase() == want) return s;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final servers = widget.servers();
    final theme = Theme.of(context);
    return RefreshIndicator(
      onRefresh: () async {
        await _repo.refresh();
        await Future.wait([_refreshMachines(), _refreshLeases()]);
      },
      child: ListView(
        key: const ValueKey('mc-machines-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: [
          Text('Disk, memory and load: where to open a new session', style: theme.textTheme.bodySmall),
          const SizedBox(height: 8),
          if (servers.isEmpty) const Text('No server yet.'),
          for (final sv in servers)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: MachineCard(
                key: ValueKey('mc-machine-${sv.baseUrl}'),
                name: sv.name,
                color: colorFromHex(_repo.serverColor(sv.baseUrl)),
                note: machineNoteFor(_repo, sv,
                    hasData: _machines[sv.baseUrl]?.data != null, failed: _machines[sv.baseUrl]?.failed == true),
                profile: _machines[sv.baseUrl]?.data,
                onAccount: _repo.supportsClaudeAccount(sv.baseUrl) && _repo.serverUsable[sv.baseUrl] == true
                    ? () => showClaudeAccountSheet(context, client: widget.client(sv), machineName: sv.name)
                    : null,
              ),
            ),
          if (_leaseServers.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Leases', style: theme.textTheme.titleMedium),
            Text('Who holds each cluster resource, and who waits', style: theme.textTheme.bodySmall),
            const SizedBox(height: 8),
            LeasesPanel(
              listing: _leaseTable,
              down: _leaseDown,
              sessionOf: _sessionById,
              onOpen: widget.onOpenSession,
            ),
          ],
        ],
      ),
    );
  }
}
