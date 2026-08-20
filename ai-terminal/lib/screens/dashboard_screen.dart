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

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/agent_catalog.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../services/app_config.dart';
import '../services/server_store.dart';
import '../services/cluster_discovery.dart';
import '../services/favorites_service.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import '../widgets/app_version_label.dart';
import '../widgets/attention_detail_sheet.dart';
import '../widgets/empty_state.dart';
import '../widgets/favorites_group.dart';
import '../widgets/new_session_sheet.dart';
import '../widgets/offline_banner.dart';
import '../widgets/recap_sheet.dart';
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

  /// Per-group collapse state, keyed by [kFavoritesGroupKey] or a server's
  /// base URL. Loaded from (and persisted to) [SharedPreferences].
  Map<String, bool> _collapsed = const <String, bool>{};

  @override
  void initState() {
    super.initState();
    _loadCollapsed();
    _loadAgentCatalog();
    unawaited(_migrateFavoritesOnce());
  }

  /// One-shot push of any pre-#60 local favorites up to the server that owns
  /// each session (see [FavoritesService]). Fire-and-forget: waits for
  /// whatever session list is/becomes available (the cached instant-paint
  /// list if one's already loaded, otherwise the first live fetch), then
  /// migrates and — only if anything was actually pushed — triggers one more
  /// refresh so the pinned group reflects the newly-server-side favorites.
  Future<void> _migrateFavoritesOnce() async {
    var sessions = SessionRepository.instance.current;
    if (sessions.isEmpty) {
      sessions = await SessionRepository.instance.sessions.first;
    }
    final migrated = await FavoritesService.migrateOnce(
      sessions,
      supportsFavorites: SessionRepository.instance.supportsFavorites,
    );
    if (migrated) await SessionRepository.instance.refresh();
  }

  /// Seed the agent catalogue so each session row can chip its agent. Every server
  /// runs the same provider registry, so the first reachable one answers for all;
  /// a failure is silent (ApiClient.agents never throws) and simply leaves rows
  /// unchipped until the next load.
  Future<void> _loadAgentCatalog() async {
    for (final server in AppConfig.servers) {
      await AgentCatalog.instance.refresh(ApiClient(server));
      if (!AgentCatalog.instance.isEmpty) break;
    }
    if (mounted && !AgentCatalog.instance.isEmpty) setState(() {});
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
  /// treatment and actions — [favoriteRow] only distinguishes the two
  /// groups' widget keys (a favorited session renders in BOTH at once).
  /// `isFavorite`/the star's PATCH both come straight off [Session.favorite]
  /// (server truth, #60) — there is no local list to fall back to.
  Widget _buildCard(
    BuildContext context,
    Session session, {
    required bool favoriteRow,
    int? reorderIndex,
  }) {
    final attentionKind =
        SessionRepository.instance.isAttentionDismissed(session.id)
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
      isFavorite: session.favorite,
      onTap: () => _openSession(session),
      onLongPress: openActions,
      onMoreTap: openActions,
      // Peek at what this session was doing WITHOUT opening it — the whole point
      // is to keep the session you are already in.
      onRecapTap: () => showRecapSheet(
        context,
        client: ApiClient(session.server),
        sessionId: session.id,
        sessionName: session.name,
      ),
      onAttentionTap: attentionKind == null
          ? null
          : () => showAttentionDetailSheet(
              context,
              session,
              onOpenTerminal: () => _openSession(session),
            ),
      onAttentionDismiss: attentionKind == null
          ? null
          : () => SessionRepository.instance.dismissAttention(session),
      // #60/#66: the star is offered only when this session's OWNING server
      // both advertises `favorites-sync` AND is currently reachable — an
      // older server without the route, or one that's simply offline right
      // now, never receives a PATCH it can't handle (`onToggleFavorite: null`
      // hides the star entirely, same treatment SessionCard already gives a
      // caller that omits it).
      onToggleFavorite: favoriteToggleAllowed(
        supportsFavorites:
            SessionRepository.instance.supportsFavorites(session.server.baseUrl),
        serverOnline: SessionRepository.instance.serverOnline[session.server.baseUrl],
      )
          ? () => _toggleFavorite(context, session)
          : null,
      // #137 — the wait chip doubles as the cancel. Offered only when this session
      // actually carries a usageLimit: a server too old to send one has no route
      // to PATCH, so the chip never renders and this is never reachable.
      onAutoResumeTap: session.usageLimit == null
          ? null
          : () => _toggleAutoResume(context, session),
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

  /// Toggles [session]'s pin (#60): PATCHes the server that OWNS it
  /// (`ApiClient.setFavorite`) then re-reads via a full repository refresh —
  /// the star never renders a local guess, only the server's confirmed
  /// answer. No `rank` is sent: the OWNING server assigns a monotonic
  /// wall-clock rank itself when pinning (see `Session.pinnedOrder`'s doc) —
  /// this client never invents a position from the partial set of peers it
  /// can currently see. On failure (e.g. the owning server just went
  /// offline), nothing is mutated locally — there is no optimistic flip to
  /// revert — and the failure is surfaced via a SnackBar, matching every
  /// other session mutation in this screen (rename/kill/notify-level, see
  /// session_action_sheet.dart).
  Future<void> _toggleFavorite(BuildContext context, Session session) async {
    try {
      await ApiClient(session.server).setFavorite(session.id, !session.favorite);
      await SessionRepository.instance.refresh();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Favorite failed: $e')));
      }
    }
  }

  /// #137 — flips this session's 5-hour auto-resume. Same shape as
  /// [_toggleFavorite]: write to the OWNING server, then refresh so the chip
  /// re-renders from the server's answer rather than an optimistic local guess.
  Future<void> _toggleAutoResume(BuildContext context, Session session) async {
    final next = !(session.usageLimit?.enabled ?? true);
    try {
      await ApiClient(session.server).setAutoResume(session.id, next);
      await SessionRepository.instance.refresh();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Auto-resume change failed: $e')),
        );
      }
    }
  }

  /// Persists a dragged favorites order (#124). Unlike the per-server session
  /// reorder next door, this group spans SERVERS: the repository writes each moved
  /// session's new rank to the server that owns it and reports any that refused, so
  /// a partial failure names the box rather than silently leaving the cluster
  /// half-renumbered.
  Future<void> _onReorderFavorites(
    List<Session> ordered,
    int oldIndex,
    int newIndex,
  ) async {
    final refused = await SessionRepository.instance.reorderFavorites(
      ordered,
      oldIndex,
      newIndex,
    );
    if (refused.isEmpty || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Could not save the new order on ${refused.join(', ')} — '
          'showing what the servers hold',
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
            // #97: a pull also re-checks the cluster, so a server added on ANY
            // box shows up here without reinstalling or retyping it. Sessions
            // are refreshed first and awaited — that is what the user pulled
            // for; discovery runs alongside and updates the list when it lands.
            onRefresh: () async {
              unawaited(ClusterDiscovery(store: ServerStore.instance).refresh());
              await SessionRepository.instance.refresh();
            },
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
                        // The running build's version (issue #40) — muted, so
                        // the deployed build is identifiable at a glance.
                        const AppVersionBadge(),
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
                      // Membership + order are server truth (#60,
                      // Session.favorite/favoriteRank) — no local stream to
                      // wrap this in. #66: a favorite whose owning server is
                      // currently offline is dropped rather than rendered
                      // stranded (see [visibleFavoriteSessions]).
                      SliverToBoxAdapter(
                        child: FavoritesGroup(
                          sessions: visibleFavoriteSessions(sessions, online),
                          cardBuilder: (context, s) =>
                              _buildCard(context, s, favoriteRow: true),
                          collapsed: _isCollapsed(kFavoritesGroupKey),
                          onToggleCollapsed: () =>
                              _toggleCollapsed(kFavoritesGroupKey),
                          onReorder: _onReorderFavorites,
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

/// The pinned Favorites group's session list with any session whose owning
/// server is currently offline dropped (#66). [SessionRepository] re-emits
/// an offline peer's last-known stale sessions on purpose (so a group
/// doesn't blank out the instant one server drops) — but a favorite that
/// peer owns would otherwise render pinned with a star wired to an
/// always-failing PATCH. Mirrors the web sidebar, which excludes an offline
/// peer's contribution from the favorites union entirely. Pulled out (and
/// taking [serverOnline] explicitly) so it's unit-testable without pumping
/// the dashboard, matching [groupSessionsByServer].
@visibleForTesting
List<Session> visibleFavoriteSessions(
  List<Session> sessions,
  Map<String, bool> serverOnline,
) =>
    sessions
        .where((s) => serverOnline[s.server.baseUrl] != false)
        .toList(growable: false);

/// Whether the pin/unpin star should be offered for a session on its owning
/// server (#60 + #66): the server must both advertise `favorites-sync` AND
/// be currently reachable. An offline server would only ever fail the PATCH,
/// so the star is hidden (`onToggleFavorite: null`, the same convention
/// [SessionCard] already gives a caller that omits it) rather than wired to
/// a guaranteed failure. Pulled out so the gate is unit-testable without
/// pumping the dashboard.
@visibleForTesting
bool favoriteToggleAllowed({
  required bool supportsFavorites,
  required bool? serverOnline,
}) =>
    supportsFavorites && serverOnline != false;

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
