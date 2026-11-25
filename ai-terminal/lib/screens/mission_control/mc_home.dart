// #507 - Mission Control, the second home one build runs beside the current one.
//
// Desktop (at or above [AdaptiveHome.splitBreakpoint]): a side nav - Now, Lines,
// Sessions, Machines - and an Ask panel beside any of them, opened from the nav (#511).
// Phone: a bottom bar - Now, Lines, Ask, Machines. Lines (#523) is the lines of work, each
// line's page and each subject's (#508, #509; the projects, on a server with no lines), in its own navigator; Sessions is the
// current sessions board; Machines is the board's machines and leases view. Ask (both
// layouts) is one conversation, kept across tabs.
//
// Nothing here touches the current home's split pane: a session opens on the app's one
// session stack and the inbox is pushed as a route, both over Mission Control, so Back
// returns here. A card is answered in place (#531): "Answer" opens the answer sheet, a route
// over Mission Control that sends through the same writers the inbox uses.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_ask_models.dart';
import '../../api/mc_models.dart';
import '../../services/mc_analyst.dart';
import '../../api/models.dart';
import '../../services/app_config.dart';
import '../../services/mc_feed.dart';
import '../../services/mc_pick_sender.dart';
import '../../services/needs_you_actions.dart';
import '../../services/session_input.dart';
import '../../services/session_repository.dart';
import '../../widgets/timed_snack_bar.dart';
import '../../util/open_inbox.dart';
import '../adaptive_home.dart';
import '../session_screen.dart' show openSessionOnStack;
import '../settings_screen.dart';
import '../work_board_screen.dart';
import 'answer_sheet.dart';
import 'ask_reply_dialog.dart';
import 'ask_view.dart';
import 'machines_view.dart';
import 'now_view.dart';
import 'project_view.dart';
import 'question_panel.dart';
import 'start_work_sheet.dart';

/// Every place Mission Control can show. Desktop shows [desktopTabs], a phone [phoneTabs].
enum McTab {
  now('Now', Icons.bolt_outlined, Icons.bolt),
  projects('Lines', Icons.account_tree_outlined, Icons.account_tree),
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
    this.analyst,
    this.picks,
  });

  /// Test seam: what sends an answer to a card's session.
  @visibleForTesting
  final McPickSender? picks;

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

  /// Injectable for tests; defaults to an [McAnalyst] over [servers] that asks the
  /// feed's server first.
  final McAnalyst? analyst;

  @override
  State<MissionControlHome> createState() => _MissionControlHomeState();
}

class _MissionControlHomeState extends State<MissionControlHome> {
  McTab _tab = McTab.now;
  final GlobalKey<McProjectsNavigatorState> _projects = GlobalKey<McProjectsNavigatorState>();

  List<ServerConfig> _servers() => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  SessionRepository get _repo => widget.repository ?? SessionRepository.instance;

  late final McFeed _feed = widget.feed ??
      McFeed(servers: _servers, client: _client, isForeground: () => _repo.isForeground);

  late final McAnalyst _analyst =
      widget.analyst ?? McAnalyst(servers: _servers, client: _client, preferred: () => _feed.servedBy);

  late final McAskThread _ask = McAskThread(_analyst);

  // #510 - a question card's final pick goes out through the existing answer paths (the
  // writers the board and the inbox use); the follow-ups and suggestions never come here.
  late final NeedsYouActions _needs =
      NeedsYouActions(repository: _repo, client: _client, input: runWithSessionInput, say: _say);
  late final McPickSender _picks =
      widget.picks ?? McPickSender(actions: _needs, sessions: () => _repo.current, currentAsk: _currentAsk);
  bool _needsMade = false;

  /// #179 for a pick sent as a reply: a CR the agent swallowed is said, as on the board.
  StreamSubscription<List<Session>>? _unconfirmed;

  /// The card's ask as the server reads it now; null once the card no longer waits.
  Future<McQuestionAsk?> _currentAsk(McCard card) async {
    try {
      return (await _analyst.questionContext(card.id, 'ask')).ask;
    } catch (_) {
      return null;
    }
  }

  void _say(String text) {
    if (mounted) showTimedSnackBar(context, text);
  }

  /// The writers are made on first use (see [_needs]) and a reply's #179 verdict is watched.
  void _writersUsed() {
    _needsMade = true;
    _unconfirmed ??= _repo.sessions.listen(_needs.checkUnconfirmedReplies);
  }

  /// #550 - an answer that went out folds its card at once and is followed by quick re-reads of Now
  /// ([McFeed.answerWentOut]): the card leaves the server's list in a couple of seconds, well
  /// before the next poll. Every way of answering passes here, wherever the answer was typed.
  Future<bool> _sendPick(McCard card, String text, McQuestionAsk? shown) async {
    _writersUsed();
    final ok = await _picks.send(card, text, shown: shown);
    if (ok && mounted) _feed.answerWentOut(card, shown: text);
    return ok;
  }

  /// #531 - what the answer sheet may do: read the question on screen, send the answer panel's
  /// frames, send words, open the session, ask the Analyst. Whatever went out, Now is read again.
  late final McAnswerPort _answerPort = McAnswerPort(
    pendingQuestion: (card) {
      _writersUsed();
      return _picks.pendingQuestion(card);
    },
    answerQuestion: (card, shown, frames) async {
      _writersUsed();
      final ok = await _picks.answerQuestion(card, shown, frames);
      if (ok && mounted) _feed.answerWentOut(card);
      return ok;
    },
    send: (card, text) => _sendPick(card, text, null),
    openSession: (card) {
      if (card.sessionId != null) _openSession(card.sessionId!);
    },
    askAbout: (card) => McQuestionScope.openPanel(context, card: card, analyst: _analyst, onSend: _sendPick, askFirst: true),
  );

  /// Desktop: whether the Ask panel is open beside the tab.
  bool _askPanel = false;

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
    _ask.dispose();
    _unconfirmed?.cancel();
    if (_needsMade) _needs.dispose();
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

  /// An ask (#526) is no wait - its session is moving on - so it is answered by a reply typed
  /// from its card, as is a possible unreported question. A wait (#531) is answered in place,
  /// on the answer sheet, never by leaving for the questions inbox.
  void _answer(McCard card) {
    if (card.usesReplyDialog) {
      showDialog<void>(
        context: context,
        builder: (_) => McAskReplyDialog(card: card, onSend: (c, text) => _sendPick(c, text, null)),
      );
    } else {
      McAnswerSheet.open(context, card: card, port: _answerPort);
    }
  }

  /// A project tapped on Now: the Projects tab, on that project's page.
  void _openProject(McProject p) {
    setState(() => _tab = McTab.projects);
    WidgetsBinding.instance.addPostFrameCallback((_) => _projects.currentState?.openProject(p.id));
  }

  /// A line tapped on Now: the Lines tab, on that line's page (#523).
  void _openLine(McLine l) {
    setState(() => _tab = McTab.projects);
    WidgetsBinding.instance.addPostFrameCallback((_) => _projects.currentState?.openLine(l.id));
  }

  Widget _body(McTab tab) => !_isActive && (tab == McTab.sessions || tab == McTab.machines)
      ? const SizedBox.shrink()
      : switch (tab) {
        McTab.now => McNowView(
            feed: _feed,
            onAnswer: _answer,
            onOpenSession: _openSession,
            onOpenProject: _openProject,
            onOpenLine: _openLine),
        McTab.projects => McProjectsNavigator(
            key: _projects,
            feed: _feed,
            onAnswer: _answer,
            onOpenSession: _openSession,
            onStartWork: (projectId) => _startWork(projectId: projectId),
            actions: _actions(),
            active: _isActive,
          ),
        McTab.sessions => (widget.sessionsBoardBuilder ??
            (open) => WorkBoardScreen(
                  embedded: true,
                  onOpenSession: open,
                  onOpenInbox: () => pushInbox(Navigator.of(context)),
                ))((s) => _openSession(s.id, initial: s)),
        McTab.ask => KeyedSubtree(key: const ValueKey('mc-ask-tab'), child: _askView()),
        McTab.machines => McMachinesView(
            servers: _servers,
            client: _client,
            repository: widget.repository,
            onOpenSession: (s) => _openSession(s.id, initial: s),
          ),
      };

  /// The one conversation, as the phone's tab or the desktop panel.
  Widget _askView() => ListenableBuilder(
        listenable: _feed,
        builder: (context, _) => McAskView(
          thread: _ask,
          projects: _feed.now?.projects ?? const [],
          onOpenSession: (id) => _openSession(id),
        ),
      );

  Widget _askPanelView(BuildContext context) => SizedBox(
        key: const ValueKey('mc-ask-panel'),
        width: 440,
        child: Scaffold(
          appBar: AppBar(
            automaticallyImplyLeading: false,
            title: const Text('Ask'),
            actions: [
              IconButton(
                key: const ValueKey('mc-ask-panel-close'),
                tooltip: 'Close Ask',
                icon: const Icon(Icons.close),
                onPressed: () => setState(() => _askPanel = false),
              ),
            ],
          ),
          body: _askView(),
        ),
      );

  /// #512 - the one Start work entry point; [projectId] preselects a project.
  void _startWork({String? projectId}) =>
      showStartWorkSheet(context,
          feed: _feed, projectId: projectId, onOpenSession: (id, initial) => _openSession(id, initial: initial));

  List<Widget> _actions() => [
        if (_tab == McTab.now || _tab == McTab.projects)
          IconButton(
            key: const ValueKey('mc-start-work'),
            tooltip: 'Start work',
            icon: const Icon(Icons.play_circle_outline),
            onPressed: _startWork,
          ),
        if (_tab == McTab.now)
          IconButton(
            key: const ValueKey('mc-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () => _feed.refresh(show: true),
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
    // #510 - every question card below (Now, a subject) opens its panel through this.
    return McQuestionScope(analyst: _analyst, onSend: _sendPick, onAnswer: _answer, answerPort: _answerPort, child: _layout());
  }

  Widget _layout() {
    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= AdaptiveHome.splitBreakpoint;
      final tabs = wide ? McTab.desktopTabs : McTab.phoneTabs;
      // A tab the other layout has (Sessions on a phone, Ask on desktop) shows Now: the
      // choice is kept, so turning back shows it again.
      final shown = tabs.contains(_tab) ? _tab : McTab.now;
      final index = tabs.indexOf(shown);
      // The Sessions board and the Projects navigator bring their own bars.
      final body = shown == McTab.sessions || shown == McTab.projects
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
              trailing: Column(mainAxisSize: MainAxisSize.min, children: [
                IconButton(
                  key: const ValueKey('mc-ask-panel-toggle'),
                  tooltip: _askPanel ? 'Close Ask' : 'Ask a question',
                  isSelected: _askPanel,
                  icon: const Icon(Icons.forum_outlined),
                  selectedIcon: const Icon(Icons.forum),
                  onPressed: () => setState(() => _askPanel = !_askPanel),
                ),
                IconButton(
                  key: const ValueKey('mc-rail-to-sessions-home'),
                  tooltip: 'Back to the sessions home',
                  icon: const Icon(Icons.swap_horiz),
                  onPressed: widget.onShowSessionsHome,
                ),
              ]),
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
            if (_askPanel) ...[const VerticalDivider(width: 1), _askPanelView(context)],
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
