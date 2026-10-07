// The sessions dashboard (#306): what every session on every server is working on,
// in one view — the companion's copy of `app.html`'s ▦ overlay (#298).
//
// Every rule behind a card is SERVER-side (`lib/session-brief.js`): which work items
// show, pinned-over-reported precedence, when a report is stale. This screen only
// lays the answer out, so the web app and the companion cannot disagree about a card.
// The session rows come from [SessionRepository], which already merges every server
// client-side; this screen adds a faster poll while it is open, and each server's
// "closed in the last day" list.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/app_config.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import '../widgets/format_utils.dart';
import '../widgets/status_dot.dart';

/// How the board is grouped: one section per server, or one per work item.
enum BoardGrouping { server, item }

/// A session's status as the board shows it: a label and a colour.
class BoardStatus {
  final String label;
  final Color color;
  final SessionStatus dot;
  const BoardStatus(this.label, this.color, this.dot);
}

/// The board's reading of a session's status. A capped session is shown as capped
/// whatever its raw status, because "sitting out its 5h window" is the answer to
/// "why is nothing happening"; a blocked one names what it owes you.
BoardStatus boardStatusOf(Session s) {
  final cap = s.usageLimit;
  if (cap != null && cap.waiting) {
    final at = cap.resumeAt;
    final label = (cap.armed && at != null) ? 'Capped · resumes ${_hhmm(at)}' : 'Capped';
    return BoardStatus(label, StatusColor.capped, SessionStatus.idle);
  }
  final st = sessionStatusFromString(s.status);
  return switch (st) {
    SessionStatus.waiting => BoardStatus(
        s.waitingFor == 'question' ? 'Question for you' : 'Needs you', StatusColor.waiting, st),
    SessionStatus.working => const BoardStatus('Working', StatusColor.working, SessionStatus.working),
    SessionStatus.active => const BoardStatus('Active', StatusColor.active, SessionStatus.active),
    SessionStatus.apiError => const BoardStatus('API error', StatusColor.apiError, SessionStatus.apiError),
    SessionStatus.idle => const BoardStatus('Idle', StatusColor.idle, SessionStatus.idle),
  };
}

String _hhmm(int ms) {
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

/// `ready-for-test` -> `ready for test`.
String briefStateLabel(String state) => state.replaceAll('-', ' ');

/// The pill colours for a work-item state; matches `app.html`'s `.db-state.s-*`.
({Color bg, Color fg}) briefStateColors(String? state) => switch (state) {
      'planning' => (bg: const Color(0xFF2A2540), fg: const Color(0xFFC9BCFF)),
      'in-progress' => (bg: const Color(0xFF3A2A12), fg: const Color(0xFFFFB454)),
      'blocked' => (bg: const Color(0xFF3A1D26), fg: const Color(0xFFFF9AAC)),
      'ready-for-test' => (bg: const Color(0xFF123A33), fg: const Color(0xFF5FE8C9)),
      'committed' => (bg: const Color(0xFF1B2B3D), fg: const Color(0xFF9CC6F0)),
      'done' => (bg: const Color(0xFF1D3320), fg: const Color(0xFF8FD59A)),
      _ => (bg: const Color(0xFF2A303C), fg: const Color(0xFFC3C9D4)),
    };

/// One "by work item" section: the item (as the first session reported it) and
/// every session carrying it.
class WorkItemGroup {
  final BriefItem item;
  final List<Session> sessions;
  const WorkItemGroup(this.item, this.sessions);
}

/// Groups [sessions] by work item, on the server's cross-session [BriefItem.key].
/// A session with several items appears under each. Sessions with none come back
/// separately, so the caller can show them last. Order is first appearance.
({List<WorkItemGroup> groups, List<Session> none}) groupByWorkItem(List<Session> sessions) {
  final byKey = <String, WorkItemGroup>{};
  final none = <Session>[];
  for (final s in sessions) {
    final items = s.brief?.items ?? const <BriefItem>[];
    if (items.isEmpty) {
      none.add(s);
      continue;
    }
    for (final it in items) {
      byKey.putIfAbsent(it.key, () => WorkItemGroup(it, <Session>[])).sessions.add(s);
    }
  }
  return (groups: byKey.values.toList(growable: false), none: none);
}

/// Why a card shows no work item.
String noItemReason(Session s) {
  final b = s.brief;
  if (b == null) return s.agent == 'claude' ? 'Nothing reported yet' : 'Not reporting';
  return b.reportingOn ? 'No work item' : 'Reporting is off for this session';
}

/// The sessions dashboard. [onOpenSession] is called when a card is tapped; the
/// caller decides how to show it (split pane or a pushed route).
class WorkBoardScreen extends StatefulWidget {
  const WorkBoardScreen({
    super.key,
    required this.onOpenSession,
    this.repository,
    this.servers,
    this.clientFactory,
    this.pollInterval = const Duration(seconds: 5),
  });

  final void Function(Session session) onOpenSession;

  /// Injectable for tests; defaults to [SessionRepository.instance].
  final SessionRepository? repository;

  /// Injectable for tests; defaults to [AppConfig.servers].
  final List<ServerConfig> Function()? servers;

  /// Injectable for tests; defaults to `ApiClient.new`.
  final ApiClient Function(ServerConfig server)? clientFactory;

  /// How often the board re-asks every server while it is open. The repository's
  /// own 30s timer is too slow for a screen whose whole job is "now".
  final Duration pollInterval;

  @override
  State<WorkBoardScreen> createState() => _WorkBoardScreenState();
}

class _WorkBoardScreenState extends State<WorkBoardScreen> {
  static const _closedEvery = Duration(seconds: 30);

  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  StreamSubscription<List<Session>>? _sub;
  Timer? _poll;
  List<Session> _sessions = const [];
  final Map<String, ({DateTime at, List<ClosedSession> list})> _closed = {};
  DateTime? _updatedAt;
  BoardGrouping _grouping = BoardGrouping.server;

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);

  @override
  void initState() {
    super.initState();
    _sessions = _repo.current;
    _sub = _repo.sessions.listen((list) {
      if (!mounted) return;
      setState(() {
        _sessions = list;
        _updatedAt = DateTime.now();
      });
      unawaited(_refreshClosed());
    });
    // Only while the app is in the foreground: `main.dart` stops the repository's own
    // polling when the app is backgrounded, and this faster tick must not undo that.
    _poll = Timer.periodic(widget.pollInterval, (_) {
      if (_repo.isForeground) unawaited(_repo.refresh());
    });
    unawaited(_repo.refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refreshClosed() async {
    final servers = _servers;
    // A server removed from the list takes its history with it.
    _closed.removeWhere((url, _) => !servers.any((sv) => sv.baseUrl == url));
    final due = servers.where((sv) {
      if (!_repo.supportsBrief(sv.baseUrl)) return false;
      // Not worth a request that cannot succeed; its last list stays until it is back.
      if (_repo.serverUsable[sv.baseUrl] != true) return false;
      final hit = _closed[sv.baseUrl];
      return hit == null || DateTime.now().difference(hit.at) > _closedEvery;
    }).toList();
    if (due.isEmpty) return;
    // Stamp first, so a slow server is not asked again by the next emit.
    for (final sv in due) {
      _closed[sv.baseUrl] = (at: DateTime.now(), list: _closed[sv.baseUrl]?.list ?? const []);
    }
    await Future.wait(due.map((sv) async {
      try {
        final list = await _client(sv).dashboardClosed();
        _closed[sv.baseUrl] = (at: DateTime.now(), list: list);
      } catch (_) {
        // Best effort: the strip is history, and the live cards are unaffected.
      }
    }));
    if (mounted) setState(() {});
  }

  Future<void> _patch(Session s, {List<Map<String, dynamic>>? pinned, bool? optOut}) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _client(s.server).patchBrief(s.id, pinned: pinned, optOut: optOut);
    } catch (e) {
      // A snackbar rather than a banner: it says what failed and then goes away,
      // instead of sitting on the board until some later save happens to succeed.
      final msg = e is ApiException ? e.message : '$e';
      messenger.showSnackBar(SnackBar(content: Text('Could not save: $msg')));
    }
    await _repo.refresh();
  }

  Future<void> _pin(Session s) async {
    final item = await showDialog<BriefItem>(context: context, builder: (_) => const _PinDialog());
    if (item == null) return;
    final kept = (s.brief?.items ?? const <BriefItem>[])
        .where((i) => i.pinned && i.ref != item.ref)
        .map((i) => i.toPinJson());
    await _patch(s, pinned: [...kept, item.toPinJson()]);
  }

  Future<void> _unpin(Session s, BriefItem item) =>
      _patch(s, pinned: (s.brief?.pinnedForPatch ?? const []).where((p) => p['ref'] != item.ref).toList());

  Future<void> _toggleReporting(Session s) => _patch(s, optOut: s.brief?.reportingOn ?? true);

  @override
  Widget build(BuildContext context) {
    final sessions = _sessions;
    final needs = sessions.where((s) => s.status == 'waiting').toList();
    final working = sessions.where((s) => s.status == 'working').length;
    final capped = sessions.where((s) => s.usageLimit?.waiting == true).length;
    final servers = _servers;
    final closed = _closed.values.expand((v) => v.list).toList()
      ..sort((a, b) => (b.at ?? 0).compareTo(a.at ?? 0));

    final children = <Widget>[
      _SummaryRow(
        sessions: sessions.length,
        servers: servers.length,
        needs: needs.length,
        working: working,
        capped: capped,
        updatedAt: _updatedAt,
      ),
      if (needs.isNotEmpty) _NeedsYou(sessions: needs, onOpen: widget.onOpenSession),
      if (sessions.isEmpty)
        const Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: Text('No sessions on any server.')),
        ),
      if (_grouping == BoardGrouping.server)
        for (final sv in servers) _serverSection(sv, sessions)
      else
        ..._itemSections(sessions),
      if (closed.isNotEmpty) _ClosedStrip(closed: closed),
      const SizedBox(height: 24),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        // Below the title rather than in `actions`: a phone has no room for both.
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: SegmentedButton<BoardGrouping>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: BoardGrouping.server, label: Text('By server')),
                  ButtonSegment(value: BoardGrouping.item, label: Text('By work item')),
                ],
                selected: {_grouping},
                onSelectionChanged: (v) => setState(() => _grouping = v.first),
              ),
            ),
          ),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _repo.refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: children,
        ),
      ),
    );
  }

  Widget _serverSection(ServerConfig sv, List<Session> sessions) {
    final mine = sessions.where((s) => s.server.baseUrl == sv.baseUrl).toList();
    final needsAuth = _repo.serverNeedsAuth[sv.baseUrl] == true;
    final offline = _repo.serverOfflineConfirmed[sv.baseUrl] == true;
    final version = _repo.serverVersion(sv.baseUrl);
    final (label, color) = needsAuth
        ? ('needs login', StatusColor.serverNeedsAuth)
        : offline
            ? ('offline', StatusColor.serverOffline)
            : ('online${version == null ? '' : ' · $version'}', StatusColor.serverOnline);
    return _Section(
      title: sv.name,
      trailing: [
        Text('● $label', style: TextStyle(color: color, fontSize: 12)),
        _countText(mine.length),
      ],
      cards: [for (final s in mine) _card(s)],
    );
  }

  List<Widget> _itemSections(List<Session> sessions) {
    final g = groupByWorkItem(sessions);
    return [
      for (final grp in g.groups)
        _Section(
          title: '${grp.item.ref} ${grp.item.title}'.trim(),
          trailing: [
            if (grp.item.state != null) _StatePill(grp.item.state!),
            _countText(grp.sessions.length),
          ],
          cards: [for (final s in grp.sessions) _card(s)],
        ),
      if (g.none.isNotEmpty)
        _Section(
          title: 'No work item',
          trailing: [_countText(g.none.length)],
          cards: [for (final s in g.none) _card(s)],
        ),
    ];
  }

  Widget _countText(int n) => Text('$n session${n == 1 ? '' : 's'}',
      style: const TextStyle(color: AppColors.onSurfaceVariant, fontSize: 12));

  Widget _card(Session s) {
    final canEdit = _repo.supportsBrief(s.server.baseUrl);
    return BoardCard(
      key: ValueKey('board-${s.server.baseUrl}-${s.id}'),
      session: s,
      onOpen: () => widget.onOpenSession(s),
      onPin: canEdit ? () => _pin(s) : null,
      onUnpin: canEdit ? (it) => _unpin(s, it) : null,
      // Only a session with a brief can stop or resume: one that never reported has
      // nothing to switch, and the button would mean nothing.
      onToggleReporting: (canEdit && s.brief != null) ? () => _toggleReporting(s) : null,
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({
    required this.sessions,
    required this.servers,
    required this.needs,
    required this.working,
    required this.capped,
    required this.updatedAt,
  });
  final int sessions, servers, needs, working, capped;
  final DateTime? updatedAt;

  @override
  Widget build(BuildContext context) {
    Widget chip(String text, Color fg) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(
            color: fg.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(text, style: TextStyle(color: fg, fontSize: 12)),
        );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          chip('$sessions session${sessions == 1 ? '' : 's'} · $servers server${servers == 1 ? '' : 's'}',
              AppColors.onSurfaceVariant),
          if (needs > 0) chip('$needs need${needs == 1 ? 's' : ''} you', StatusColor.waiting),
          if (working > 0) chip('$working working', StatusColor.working),
          if (capped > 0) chip('$capped capped', StatusColor.capped),
          if (updatedAt != null)
            Text('updated ${relativeTime(updatedAt!.millisecondsSinceEpoch)}',
                style: const TextStyle(color: AppColors.onSurfaceVariant, fontSize: 11)),
        ],
      ),
    );
  }
}

class _NeedsYou extends StatelessWidget {
  const _NeedsYou({required this.sessions, required this.onOpen});
  final List<Session> sessions;
  final void Function(Session) onOpen;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('board-needs-you'),
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: StatusColor.waiting.withValues(alpha: 0.08),
        border: Border.all(color: StatusColor.waiting.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(AppShape.medium),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          const Text('Needs you', style: TextStyle(fontWeight: FontWeight.w700, color: StatusColor.waiting)),
          for (final s in sessions)
            ActionChip(
              avatar: const StatusDot(status: SessionStatus.waiting, size: 8),
              label: Text('${s.name} · ${s.server.name} · '
                  '${s.waitingFor == 'question' ? 'a question' : 'a permission'}'),
              onPressed: () => onOpen(s),
            ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.trailing, required this.cards});
  final String title;
  final List<Widget> trailing;
  final List<Widget> cards;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Wrap(
              spacing: 10,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                ...trailing,
              ],
            ),
          ),
          // A grid on a wide window, one column on a phone.
          LayoutBuilder(builder: (context, c) {
            const gap = 10.0;
            final cols = (c.maxWidth / 340).floor().clamp(1, 6);
            final w = (c.maxWidth - gap * (cols - 1)) / cols;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [for (final card in cards) SizedBox(width: w, child: card)],
            );
          }),
        ],
      ),
    );
  }
}

class _StatePill extends StatelessWidget {
  const _StatePill(this.state);
  final String state;

  @override
  Widget build(BuildContext context) {
    final c = briefStateColors(state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(color: c.bg, borderRadius: BorderRadius.circular(999)),
      child: Text(briefStateLabel(state),
          style: TextStyle(color: c.fg, fontSize: 10, fontWeight: FontWeight.w600)),
    );
  }
}

/// One session's card on the dashboard.
class BoardCard extends StatelessWidget {
  const BoardCard({
    super.key,
    required this.session,
    required this.onOpen,
    this.onPin,
    this.onUnpin,
    this.onToggleReporting,
  });

  final Session session;
  final VoidCallback onOpen;

  /// Null when the session's server cannot take a pin (too old for #298).
  final VoidCallback? onPin;
  final void Function(BriefItem item)? onUnpin;
  final VoidCallback? onToggleReporting;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = session;
    final b = s.brief;
    final st = boardStatusOf(s);
    final items = b?.items ?? const <BriefItem>[];
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);

    final lines = <(String, BriefLine)>[
      if (b?.now != null && s.status == 'working') ('Now', b!.now!),
      if (b?.did != null) ('Did', b!.did!),
      if (b?.prompt != null) ('You', b!.prompt!),
    ];

    return Material(
      color: AppColors.surfaceContainer,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppShape.large),
        side: BorderSide(color: s.status == 'waiting' ? StatusColor.waiting : AppColors.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                StatusDot(status: st.dot, size: 9),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(s.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 8),
                Text(st.label, style: TextStyle(color: st.color, fontSize: 12, fontWeight: FontWeight.w600)),
              ]),
              const SizedBox(height: 8),
              if (items.isEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  decoration: BoxDecoration(
                    border: Border.all(color: AppColors.outlineVariant),
                    borderRadius: BorderRadius.circular(AppShape.small),
                  ),
                  child: Text(noItemReason(s), style: muted),
                )
              else
                for (final it in items) _itemRow(context, it),
              if (b?.headline != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(b!.headline!, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
                ),
              if (lines.isNotEmpty) const SizedBox(height: 6),
              for (final (label, line) in lines)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    SizedBox(width: 34, child: Text(label, style: muted)),
                    Expanded(
                      child: Tooltip(
                        message: line.text,
                        child: Text(line.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
                      ),
                    ),
                    if (line.at != null) ...[
                      const SizedBox(width: 6),
                      Text(relativeTime(line.at), style: muted?.copyWith(fontSize: 10)),
                    ],
                  ]),
                ),
              if (b?.staleReason != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('⚠ Report may be out of date: ${b!.staleReason}',
                      key: const ValueKey('board-stale'),
                      style: const TextStyle(color: AppColors.caution, fontSize: 12)),
                ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(s.server.name, style: muted),
                  if (s.lastActivity != null) Text(relativeTime(s.lastActivity), style: muted),
                  if (onPin != null)
                    OutlinedButton(
                      style: _smallButton,
                      onPressed: onPin,
                      child: const Text('Pin work item'),
                    ),
                  if (onToggleReporting != null)
                    OutlinedButton(
                      style: _smallButton,
                      onPressed: onToggleReporting,
                      child: Text(b?.reportingOn == false ? 'Resume reporting' : 'Stop reporting'),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  static final ButtonStyle _smallButton = OutlinedButton.styleFrom(
    visualDensity: VisualDensity.compact,
    padding: const EdgeInsets.symmetric(horizontal: 10),
    minimumSize: const Size(0, 30),
    textStyle: const TextStyle(fontSize: 12),
  );

  Widget _itemRow(BuildContext context, BriefItem it) {
    final theme = Theme.of(context);
    final ref = Text(it.ref,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: theme.colorScheme.primary,
          fontFamily: 'monospace',
          fontFamilyFallback: const ['Consolas', 'Menlo', 'Courier New'],
          fontSize: 12,
          decoration: it.url != null ? TextDecoration.underline : null,
        ));
    final uri = it.url == null ? null : Uri.tryParse(it.url!);
    return Tooltip(
      message: it.note,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          // Flexible: a qualified ref (`owner/repo#306`) beside a state pill and an
          // unpin button is wider than a phone card. The ref gives way, not the pill.
          Flexible(
            child: uri != null
                ? InkWell(
                    onTap: () => launchUrl(uri, mode: LaunchMode.externalApplication),
                    child: ref,
                  )
                : ref,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(it.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
          ),
          if (it.state != null) ...[const SizedBox(width: 6), _StatePill(it.state!)],
          if (it.pinned && onUnpin != null)
            IconButton(
              tooltip: 'Unpin ${it.ref}',
              visualDensity: VisualDensity.compact,
              iconSize: 16,
              icon: const Icon(Icons.close),
              onPressed: () => onUnpin!(it),
            ),
        ]),
      ),
    );
  }
}

class _ClosedStrip extends StatelessWidget {
  const _ClosedStrip({required this.closed});
  final List<ClosedSession> closed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Closed in the last 24h', style: theme.textTheme.titleSmall),
          const SizedBox(height: 6),
          for (final c in closed)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Wrap(
                spacing: 8,
                children: [
                  Text(c.name, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
                  Text(c.server.name, style: muted),
                  if (c.items.isNotEmpty)
                    Text(
                        c.items
                            .map((i) => i.state == null ? i.ref : '${i.ref} ${briefStateLabel(i.state!)}')
                            .join(', '),
                        style: theme.textTheme.bodySmall),
                  if ((c.did?.text ?? c.headline) != null)
                    Text(c.did?.text ?? c.headline!, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
                  if (c.at != null) Text(relativeTime(c.at), style: muted),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Asks for a work item to pin: a reference, a title and a state.
class _PinDialog extends StatefulWidget {
  const _PinDialog();

  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  final _ref = TextEditingController();
  final _title = TextEditingController();
  String? _state;

  @override
  void dispose() {
    _ref.dispose();
    _title.dispose();
    super.dispose();
  }

  void _save() {
    final ref = _ref.text.trim();
    if (ref.isEmpty) return;
    Navigator.of(context).pop(BriefItem(ref: ref, key: ref, title: _title.text.trim(), state: _state, pinned: true));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      // Scrollable: with a phone keyboard up there is not room for all three fields.
      scrollable: true,
      title: const Text('Pin a work item'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            key: const ValueKey('pin-ref'),
            controller: _ref,
            autofocus: true,
            maxLength: 60,
            decoration: const InputDecoration(labelText: 'Reference', hintText: '#123 or ado:12345'),
            onSubmitted: (_) => _save(),
          ),
          TextField(
            key: const ValueKey('pin-title'),
            controller: _title,
            maxLength: 140,
            decoration: const InputDecoration(labelText: 'Title'),
            onSubmitted: (_) => _save(),
          ),
          DropdownButtonFormField<String?>(
            key: const ValueKey('pin-state'),
            initialValue: _state,
            // Expanded: a long state label ellipsises inside a narrow dialog.
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'State'),
            items: [
              const DropdownMenuItem<String?>(value: null, child: Text('—')),
              for (final st in kBriefItemStates)
                DropdownMenuItem<String?>(value: st, child: Text(briefStateLabel(st))),
            ],
            onChanged: (v) => setState(() => _state = v),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(key: const ValueKey('pin-save'), onPressed: _save, child: const Text('Pin')),
      ],
    );
  }
}
