// #507 - Mission Control, the second home one build runs beside the current one.
//
// Desktop (at or above [AdaptiveHome.splitBreakpoint]): a side nav - Now, Projects,
// Sessions, Machines. Phone: a bottom bar - Now, Projects, Ask, Machines. Projects and
// Ask are filled by later issues (#508, #511) and say so; Sessions is the current
// sessions board; Machines is the board's machines and leases view.
//
// Nothing here touches the current home's split pane: a session opens on the app's one
// session stack and the inbox is pushed as a route, both over Mission Control, so Back
// returns here.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_models.dart';
import '../../api/models.dart';
import '../../services/app_config.dart';
import '../../services/mc_feed.dart';
import '../../services/session_repository.dart';
import '../../util/open_inbox.dart';
import '../adaptive_home.dart';
import '../session_screen.dart' show openSessionOnStack;
import '../settings_screen.dart';
import '../work_board_screen.dart';
import 'machines_view.dart';
import 'now_view.dart';

/// Every place Mission Control can show. Desktop shows [desktopTabs], a phone [phoneTabs].
enum McTab {
  now('Now', Icons.bolt_outlined, Icons.bolt),
  projects('Projects', Icons.folder_outlined, Icons.folder),
  sessions('Sessions', Icons.view_list_outlined, Icons.view_list),
  ask('Ask', Icons.forum_outlined, Icons.forum),
  machines('Machines', Icons.dns_outlined, Icons.dns);

  const McTab(this.label, this.icon, this.selectedIcon);
  final String label;
  final IconData icon;
  final IconData selectedIcon;

  static const List<McTab> desktopTabs = [now, projects, sessions, machines];
  static const List<McTab> phoneTabs = [now, projects, ask, machines];
}

class MissionControlHome extends StatefulWidget {
  const MissionControlHome({
    super.key,
    required this.onShowSessionsHome,
    this.active,
    this.feed,
    this.servers,
    this.clientFactory,
    this.repository,
    this.sessionsBoardBuilder,
  });

  /// Switches the app to the current sessions home.
  final VoidCallback onShowSessionsHome;

  /// Whether Mission Control is the home on screen: it polls only then. Null: always.
  final ValueListenable<bool>? active;

  /// Injectable for tests; defaults to a feed over [AppConfig.servers].
  final McFeed? feed;

  /// Injectable for tests; defaults to [AppConfig.servers].
  final List<ServerConfig> Function()? servers;

  /// Injectable for tests; defaults to `ApiClient.new`.
  final ApiClient Function(ServerConfig server)? clientFactory;

  /// Injectable for tests; defaults to [SessionRepository.instance].
  final SessionRepository? repository;

  /// Test seam: the Sessions tab's board.
  @visibleForTesting
  final Widget Function(void Function(Session) onOpenSession)? sessionsBoardBuilder;

  @override
  State<MissionControlHome> createState() => _MissionControlHomeState();
}

class _MissionControlHomeState extends State<MissionControlHome> {
  McTab _tab = McTab.now;

  List<ServerConfig> _servers() => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  SessionRepository get _repo => widget.repository ?? SessionRepository.instance;

  late final McFeed _feed = widget.feed ??
      McFeed(servers: _servers, client: _client, isForeground: () => _repo.isForeground);

  @override
  void initState() {
    super.initState();
    widget.active?.addListener(_onActive);
    _onActive();
  }

  @override
  void didUpdateWidget(MissionControlHome old) {
    super.didUpdateWidget(old);
    if (old.active != widget.active) {
      old.active?.removeListener(_onActive);
      widget.active?.addListener(_onActive);
      _onActive();
    }
  }

  @override
  void dispose() {
    widget.active?.removeListener(_onActive);
    _feed.active = false;
    if (widget.feed == null) _feed.dispose();
    super.dispose();
  }

  bool get _isActive => widget.active?.value ?? true;

  void _onActive() {
    _feed.active = _isActive;
    // The Sessions and Machines tabs poll on their own timers: they are dropped while
    // Mission Control is hidden and built again when it comes back.
    if (mounted) setState(() {});
  }

  void _openSession(String id, {Session? initial}) =>
      openSessionOnStack(Navigator.of(context), id, initialSession: initial);

  void _answer(McCard card) => pushInbox(Navigator.of(context), focusSessionId: card.sessionId);

  Widget _body(McTab tab) => !_isActive && (tab == McTab.sessions || tab == McTab.machines)
      ? const SizedBox.shrink()
      : switch (tab) {
        McTab.now => McNowView(feed: _feed, onAnswer: _answer, onOpenSession: _openSession),
        McTab.projects => ListenableBuilder(
            listenable: _feed,
            builder: (context, _) => ListView(
              key: const ValueKey('mc-projects-tab'),
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
              children: [
                const McPlaceholderNote(
                    'One page per project and area, with every subject on it, comes with #508 (Project and Area screen). '
                    'Until then, the projects as Now shows them:'),
                const SizedBox(height: 12),
                McProjectsSection(projects: _feed.now?.projects ?? const [], title: 'Projects'),
              ],
            ),
          ),
        McTab.sessions => (widget.sessionsBoardBuilder ??
            (open) => WorkBoardScreen(
                  embedded: true,
                  onOpenSession: open,
                  onOpenInbox: () => pushInbox(Navigator.of(context)),
                ))((s) => _openSession(s.id, initial: s)),
        McTab.ask => const Padding(
            key: ValueKey('mc-ask-tab'),
            padding: EdgeInsets.all(16),
            child: McPlaceholderNote(
                'Ask a read-only Analyst about sessions and work items, with sources: comes with #511 (Ask).'),
          ),
        McTab.machines => McMachinesView(
            servers: _servers,
            client: _client,
            repository: widget.repository,
            onOpenSession: (s) => _openSession(s.id, initial: s),
          ),
      };

  List<Widget> _actions() => [
        if (_tab == McTab.now)
          IconButton(
            key: const ValueKey('mc-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _feed.refresh,
          ),
        IconButton(
          key: const ValueKey('mc-to-sessions-home'),
          tooltip: 'Back to the sessions home',
          icon: const Icon(Icons.swap_horiz),
          onPressed: widget.onShowSessionsHome,
        ),
        IconButton(
          tooltip: 'Settings',
          icon: const Icon(Icons.settings_outlined),
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SettingsScreen())),
        ),
      ];

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= AdaptiveHome.splitBreakpoint;
      final tabs = wide ? McTab.desktopTabs : McTab.phoneTabs;
      // A tab the other layout has (Sessions on a phone, Ask on desktop) shows Now: the
      // choice is kept, so turning back shows it again.
      final shown = tabs.contains(_tab) ? _tab : McTab.now;
      final index = tabs.indexOf(shown);
      // The Sessions board brings its own bar.
      final body = shown == McTab.sessions
          ? _body(shown)
          : Scaffold(
              appBar: AppBar(
                automaticallyImplyLeading: false,
                title: Text(shown == McTab.now ? 'Mission Control' : shown.label),
                actions: _actions(),
              ),
              body: _body(shown),
            );
      if (wide) {
        return Scaffold(
          key: const ValueKey('mc-home-wide'),
          body: Row(children: [
            NavigationRail(
              key: const ValueKey('mc-rail'),
              selectedIndex: index,
              labelType: NavigationRailLabelType.all,
              // Reachable from every tab, the Sessions board (which has its own bar) too.
              trailing: IconButton(
                key: const ValueKey('mc-rail-to-sessions-home'),
                tooltip: 'Back to the sessions home',
                icon: const Icon(Icons.swap_horiz),
                onPressed: widget.onShowSessionsHome,
              ),
              onDestinationSelected: (i) => setState(() => _tab = tabs[i]),
              destinations: [
                for (final t in tabs)
                  NavigationRailDestination(
                    icon: Icon(t.icon, key: ValueKey('mc-nav-${t.name}')),
                    selectedIcon: Icon(t.selectedIcon),
                    label: Text(t.label),
                  ),
              ],
            ),
            const VerticalDivider(width: 1),
            Expanded(child: body),
          ]),
        );
      }
      return Scaffold(
        key: const ValueKey('mc-home-narrow'),
        body: body,
        bottomNavigationBar: NavigationBar(
          key: const ValueKey('mc-bottom-bar'),
          selectedIndex: index,
          onDestinationSelected: (i) => setState(() => _tab = tabs[i]),
          destinations: [
            for (final t in tabs)
              NavigationDestination(
                icon: Icon(t.icon, key: ValueKey('mc-nav-${t.name}')),
                selectedIcon: Icon(t.selectedIcon),
                label: t.label,
              ),
          ],
        ),
      );
    });
  }
}

/// Says which later issue fills a place that is not built yet.
class McPlaceholderNote extends StatelessWidget {
  const McPlaceholderNote(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Icon(Icons.construction_outlined, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
        ]),
      ),
    );
  }
}
