/// Landing screen — spec §2. `LargeTopAppBar('Sessions')` with an
/// offline-count warning badge, a settings gear, server filter chips,
/// pull-to-refresh session list, a pinned Favorites group, and a `+` FAB for
/// creating a session. Tapping a card opens the terminal directly
/// ([SessionScreen]) per the owner's pivot; tapping a session's
/// [AttentionChip] opens the [showAttentionDetailSheet] instead.
///
/// Sessions are grouped: a pinned, cross-server Favorites group, then one
/// group per server (name + online dot + count), mirroring the web
/// sidebar's collapsible groups. Each group's collapsed/expanded state is
/// per-device and persisted in [SharedPreferences] under
/// `wt.collapsed.<key>` (`__favorites__`, or the server's base URL).
///
/// Per-server group ORDER follows the user's configured server order
/// ([AppConfig.servers]) rather than session recency — owner: "the server
/// order always changes, it's confusing". See [groupSessionsByServer].
library;

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/models.dart';
import '../services/app_config.dart';
import '../services/favorites_service.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import '../widgets/attention_detail_sheet.dart';
import '../widgets/empty_state.dart';
import '../widgets/favorites_group.dart';
import '../widgets/new_session_sheet.dart';
import '../widgets/offline_banner.dart';
import '../widgets/session_action_sheet.dart';
import '../widgets/session_card.dart';
import '../widgets/status_dot.dart';
import 'session_screen.dart';
import 'settings_screen.dart';

const String _kAllServers = 'All';

/// The [SharedPreferences] key prefix for a group's persisted collapse state
/// (`wt.collapsed.<key>`). Exposed for tests.
const String kCollapsedKeyPrefix = 'wt.collapsed.';

/// The collapse-state key for the pinned Favorites group.
const String kFavoritesGroupKey = '__favorites__';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, this.selectedId, this.onSelectSession});

  /// In the wide-screen split view, the id of the session shown in the detail
  /// pane — its row is highlighted. `null` in normal (phone) mode.
  final String? selectedId;

  /// When set (split view), tapping a session selects it in the detail pane
  /// instead of pushing a full-screen route.
  final void Function(Session session)? onSelectSession;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  String _filter = _kAllServers;

  /// Session ids whose attention chip was locally dismissed (spec §3
  /// "Dismiss notification": no server call in Phase 1 — this simply hides
  /// the chip until the next status change re-derives it).
  final Set<String> _dismissedAttention = {};

  /// Per-group collapse state, keyed by [kFavoritesGroupKey] or a server's
  /// base URL. Loaded from (and persisted to) [SharedPreferences].
  Map<String, bool> _collapsed = const <String, bool>{};

  @override
  void initState() {
    super.initState();
    _loadCollapsed();
  }

  Future<void> _loadCollapsed() async {
    final prefs = await SharedPreferences.getInstance();
    final loaded = <String, bool>{};
    for (final key in prefs.getKeys()) {
      if (!key.startsWith(kCollapsedKeyPrefix)) continue;
      loaded[key.substring(kCollapsedKeyPrefix.length)] =
          prefs.getBool(key) ?? false;
    }
    if (mounted) setState(() => _collapsed = loaded);
  }

  bool _isCollapsed(String key) => _collapsed[key] ?? false;

  Future<void> _toggleCollapsed(String key) async {
    final next = !_isCollapsed(key);
    setState(() => _collapsed = {..._collapsed, key: next});
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('$kCollapsedKeyPrefix$key', next);
  }

  List<Session> _filtered(List<Session> sessions) {
    if (_filter == _kAllServers) return sessions;
    return sessions
        .where((s) => s.server.name == _filter)
        .toList(growable: false);
  }

  void _openSession(Session session) {
    // Split view: select into the detail pane. Phone: push a full-screen route.
    final onSelect = widget.onSelectSession;
    if (onSelect != null) {
      onSelect(session);
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) =>
            SessionScreen(sessionId: session.id, initialSession: session),
      ),
    );
  }

  void _openSettings() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SettingsScreen()),
    );
  }

  Future<void> _createSession(List<ServerConfig> servers) async {
    if (servers.isEmpty) return;
    final defaultServer = servers.firstWhere(
      (s) => s.name == _filter,
      orElse: () => servers.first,
    );
    await showNewSessionSheet(
      context,
      servers: servers,
      initialServer: defaultServer,
      onCreated: _openSession,
    );
  }

  /// Builds one session row. Used for both the pinned favorites group and
  /// the main per-server list so both get identical status/api-error
  /// treatment and actions — [favoriteRow] only changes the star's initial
  /// (always-filled) state.
  Widget _buildCard(
    BuildContext context,
    Session session, {
    required bool favoriteRow,
    int? reorderIndex,
  }) {
    final attentionKind = _dismissedAttention.contains(session.id)
        ? null
        : attentionKindForStatus(session.status);
    void openActions() => showSessionActionsSheet(
      context,
      session,
      onChanged: SessionRepository.instance.refresh,
      onForked: _openSession,
    );
    return SessionCard(
      key: ValueKey('${favoriteRow ? 'fav' : 'main'}-${session.id}'),
      session: session,
      selected: widget.selectedId == session.id,
      attentionKind: attentionKind,
      apiError: SessionRepository.instance.apiErrorFor(session.id),
      isFavorite:
          favoriteRow || FavoritesService.instance.isFavorite(session.id),
      onTap: () => _openSession(session),
      onLongPress: openActions,
      onMoreTap: openActions,
      onAttentionTap: attentionKind == null
          ? null
          : () => showAttentionDetailSheet(
              context,
              session,
              onOpenTerminal: () => _openSession(session),
            ),
      onAttentionDismiss: attentionKind == null
          ? null
          : () => setState(() => _dismissedAttention.add(session.id)),
      onToggleFavorite: () => FavoritesService.instance.toggle(session.id),
      onBellTap: () => showNotifyLevelPicker(
        context,
        session,
        onChanged: SessionRepository.instance.refresh,
      ),
      // Issue #22: drag handle only in the main per-server list. The handle
      // (not the whole card) starts a reorder, so the card's long-press stays
      // bound to the actions sheet. ReorderableDragStartListener works for both
      // a desktop mouse-drag and a mobile touch-drag on the handle.
      dragHandle: reorderIndex == null
          ? null
          : ReorderableDragStartListener(
              index: reorderIndex,
              child: Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Icon(
                  Icons.drag_handle,
                  size: 18,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
    );
  }

  /// A server group's rows as a reorderable sliver (issue #22). Rows are dragged
  /// by their handle (see [_buildCard]); [onReorder] persists the new order.
  Widget _reorderableGroup(List<Session> sessions, ServerConfig server) {
    return SliverReorderableList(
      itemCount: sessions.length,
      // onReorderItem delivers newIndex already adjusted for the removed item,
      // so no manual `if (newIndex > oldIndex) newIndex--` dance.
      onReorderItem: (oldIndex, newIndex) =>
          _onReorderGroup(server, sessions, oldIndex, newIndex),
      itemBuilder: (context, i) =>
          _buildCard(context, sessions[i], favoriteRow: false, reorderIndex: i),
    );
  }

  void _onReorderGroup(
    ServerConfig server,
    List<Session> ordered,
    int oldIndex,
    int newIndex,
  ) {
    if (newIndex == oldIndex) return;
    final ids = [for (final s in ordered) s.id];
    final moved = ids.removeAt(oldIndex);
    ids.insert(newIndex, moved);
    SessionRepository.instance.reorderServerSessions(server, ids);
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<ServerConfig>>(
      stream: AppConfig.serversStream,
      initialData: AppConfig.servers,
      builder: (context, serverSnapshot) {
        final servers = serverSnapshot.data ?? const <ServerConfig>[];
        return Scaffold(
          body: RefreshIndicator(
            onRefresh: SessionRepository.instance.refresh,
            child: StreamBuilder<List<Session>>(
              stream: SessionRepository.instance.sessions,
              builder: (context, snapshot) {
                final sessions = snapshot.data;
                final online = SessionRepository.instance.serverOnline;
                final offlineNames = servers
                    .where((s) => online[s.baseUrl] == false)
                    .map((s) => s.name)
                    .toList(growable: false);
                final allOffline =
                    servers.isNotEmpty && offlineNames.length == servers.length;
                final visible = sessions == null ? null : _filtered(sessions);

                return CustomScrollView(
                  slivers: [
                    SliverAppBar.large(
                      title: const Text('Sessions'),
                      actions: [
                        IconButton(
                          icon: const Icon(Icons.settings_outlined),
                          tooltip: 'Settings',
                          onPressed: _openSettings,
                        ),
                        if (offlineNames.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(right: 12),
                            child: Center(
                              child: Badge(
                                label: Text('${offlineNames.length}'),
                                backgroundColor: StatusColor.serverOffline,
                                child: const Icon(Icons.cloud_off),
                              ),
                            ),
                          ),
                      ],
                    ),
                    if (servers.length > 1)
                      SliverToBoxAdapter(
                        child: _FilterChips(
                          servers: servers,
                          value: _filter,
                          onChanged: (v) => setState(() => _filter = v),
                        ),
                      ),
                    if (offlineNames.isNotEmpty && !allOffline)
                      SliverToBoxAdapter(
                        child: OfflineBanner(offlineServerNames: offlineNames),
                      ),
                    if (sessions == null)
                      const SliverFillRemaining(
                        hasScrollBody: false,
                        child: Center(child: CircularProgressIndicator()),
                      )
                    else if (allOffline)
                      const SliverFillRemaining(
                        hasScrollBody: false,
                        child: EmptyState(
                          icon: Icons.cloud_off,
                          title: 'No servers reachable',
                          subtitle: 'Pull down to retry',
                        ),
                      )
                    else ...[
                      // Pinned favorites — cross-server, unaffected by the
                      // server filter chips above (mirrors the web sidebar,
                      // where the favorites group always spans every server).
                      SliverToBoxAdapter(
                        child: StreamBuilder<List<String>>(
                          stream: FavoritesService.instance.favorites,
                          initialData: FavoritesService.instance.current,
                          builder: (context, favSnapshot) => FavoritesGroup(
                            order: favSnapshot.data ?? const <String>[],
                            sessions: sessions,
                            cardBuilder: (context, s) =>
                                _buildCard(context, s, favoriteRow: true),
                            collapsed: _isCollapsed(kFavoritesGroupKey),
                            onToggleCollapsed: () =>
                                _toggleCollapsed(kFavoritesGroupKey),
                          ),
                        ),
                      ),
                      if (visible!.isEmpty)
                        const SliverFillRemaining(
                          hasScrollBody: false,
                          child: EmptyState(
                            icon: Icons.terminal,
                            title: 'No sessions running',
                            subtitle: 'Start a session from the + button',
                          ),
                        )
                      else ...[
                        const SliverToBoxAdapter(child: SizedBox(height: 4)),
                        for (final group in groupSessionsByServer(visible, servers)) ...[
                          SliverToBoxAdapter(
                            child: _ServerGroupHeader(
                              name: group.server.name,
                              count: group.sessions.length,
                              online:
                                  online[group.server.baseUrl] ?? true,
                              collapsed: _isCollapsed(group.server.baseUrl),
                              onToggle: () =>
                                  _toggleCollapsed(group.server.baseUrl),
                            ),
                          ),
                          if (!_isCollapsed(group.server.baseUrl))
                            // Issue #22: render each group in the server's
                            // persisted (drag) order and let the user reorder by
                            // the per-row handle. Order comes from the server,
                            // so it's consistent across devices and survives
                            // reconnect.
                            _reorderableGroup(
                              orderedSessionsFor(group, SessionRepository.instance),
                              group.server,
                            ),
                        ],
                        const SliverToBoxAdapter(child: SizedBox(height: 96)),
                      ],
                    ],
                  ],
                );
              },
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => _createSession(servers),
            child: const Icon(Icons.add),
          ),
        );
      },
    );
  }
}

/// Orders a server group's sessions by the server's persisted (drag) order
/// (issue #22) instead of the flat attention/recency sort, so a user-set order
/// is honored and consistent across devices. [repo.serverOrderIndex] returns
/// each session's position in the server's last-received list; unknown ids sort
/// last (a freshly-created session appends). Pulled out (and taking [repo]
/// explicitly) so it's unit-testable without pumping the dashboard.
@visibleForTesting
List<Session> orderedSessionsFor(ServerGroup group, SessionRepository repo) {
  final out = [...group.sessions];
  out.sort((a, b) => repo
      .serverOrderIndex(group.server.baseUrl, a.id)
      .compareTo(repo.serverOrderIndex(group.server.baseUrl, b.id)));
  return out;
}

/// One server's bucket of sessions, in their incoming (attention-sorted)
/// order — see [groupSessionsByServer].
class ServerGroup {
  const ServerGroup({required this.server, required this.sessions});

  final ServerConfig server;
  final List<Session> sessions;
}

/// Buckets [sessions] by their server, preserving each session's relative
/// (already attention-sorted) order, and orders the resulting groups by each
/// server's position in [orderedServers] (i.e. [AppConfig.servers]) — NOT by
/// session recency or first appearance, so the dashboard's server groups
/// don't reshuffle on every refresh (owner: "the server order always
/// changes, it's confusing").
///
/// A session whose server no longer appears in [orderedServers] (e.g. it was
/// just removed from Settings) still gets a group — appended after the
/// configured ones, in first-appearance order — so it doesn't silently
/// disappear.
///
/// Exposed at library level (not a private method) so it's directly unit
/// testable without standing up the whole [DashboardScreen] widget tree.
@visibleForTesting
List<ServerGroup> groupSessionsByServer(
  List<Session> sessions,
  List<ServerConfig> orderedServers,
) {
  final byBaseUrl = <String, List<Session>>{};
  for (final s in sessions) {
    byBaseUrl.putIfAbsent(s.server.baseUrl, () => <Session>[]).add(s);
  }

  final groups = <ServerGroup>[];
  final seen = <String>{};
  for (final server in orderedServers) {
    final bucket = byBaseUrl[server.baseUrl];
    if (bucket == null) continue;
    seen.add(server.baseUrl);
    groups.add(ServerGroup(server: server, sessions: bucket));
  }
  for (final entry in byBaseUrl.entries) {
    if (seen.contains(entry.key)) continue;
    groups.add(ServerGroup(server: entry.value.first.server, sessions: entry.value));
  }
  return groups;
}

/// Tappable, collapsible header for one server's session group: a
/// reachability dot, the server name, the session count, and a chevron —
/// mirrors [FavoritesGroup]'s header but keyed off server reachability
/// instead of the gold favorites star.
class _ServerGroupHeader extends StatelessWidget {
  const _ServerGroupHeader({
    required this.name,
    required this.count,
    required this.online,
    required this.collapsed,
    required this.onToggle,
  });

  final String name;
  final int count;
  final bool online;
  final bool collapsed;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onToggle,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.screenPadding,
          12,
          AppSpacing.screenPadding,
          4,
        ),
        child: Row(
          children: [
            ServerStatusDot(
              status: online ? ServerStatus.online : ServerStatus.offline,
            ),
            const SizedBox(width: 8),
            Text(
              name.toUpperCase(),
              style: theme.textTheme.labelSmall?.copyWith(
                fontWeight: FontWeight.w700,
                letterSpacing: 0.08,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const Spacer(),
            Text(
              '$count',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            Icon(
              collapsed ? Icons.chevron_right : Icons.expand_more,
              size: 18,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }
}

class _FilterChips extends StatelessWidget {
  const _FilterChips({
    required this.servers,
    required this.value,
    required this.onChanged,
  });

  final List<ServerConfig> servers;
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final labels = [_kAllServers, ...servers.map((s) => s.name)];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: SizedBox(
        height: 40,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.screenPadding,
          ),
          itemCount: labels.length,
          separatorBuilder: (_, _) => const SizedBox(width: 8),
          itemBuilder: (context, i) {
            final label = labels[i];
            return ChoiceChip(
              label: Text(label),
              selected: value == label,
              onSelected: (_) => onChanged(label),
            );
          },
        ),
      ),
    );
  }
}
