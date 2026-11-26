// #508 - Mission Control's Projects tab: the projects, and one page per project and area
// with every subject on it.
//
// The tab is its own navigator (projects -> a project -> a subject), so the side nav or
// the bottom bar stays in place and a session opened from a subject (on the app's one
// session stack, over Mission Control) comes Back to that subject.
//
// The header, the area tabs and the filters show the counts of the SAME answer the Now
// screen shows (`GET /api/mc/now`, read by [McFeed]): the numbers match Now because they
// are Now's; nothing is re-counted here. The rows are `GET /api/mc/subjects?project=&area=`,
// read again on every Now refresh. Which rows sit under a filter is the server's
// `buckets` once the contract carries it; until then a client-side reading of each
// subject's fields ([McSubject.inFilter]), so the rows can differ from the count.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_models.dart';
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import 'lines_view.dart';
import 'now_view.dart';
import 'running_view.dart' show McEffortScreen;
import 'subject_screen.dart';
import 'subject_widgets.dart';

/// The Projects tab. [actions] go on the list page's bar (the way back to the sessions
/// home, settings); [onAnswer] and [onOpenSession] are Mission Control's own.
class McProjectsNavigator extends StatefulWidget {
  const McProjectsNavigator({
    super.key,
    required this.feed,
    required this.onAnswer,
    required this.onOpenSession,
    this.onStartWork,
    this.actions = const [],
    this.active = true,
    this.now,
    this.onExit,
  });

  /// Leaves the navigator for the page that opened it (Now): called when a pop lands back on the
  /// list, and by the list's own back arrow. Null: the list is a place of its own (no back arrow).
  final VoidCallback? onExit;

  final McFeed feed;
  final void Function(McCard card) onAnswer;
  final void Function(String sessionId) onOpenSession;

  /// #512 - opens Start work with a project preselected; null: the project page has no button.
  final void Function(String projectId)? onStartWork;
  final List<Widget> actions;

  /// Whether Mission Control is the home on screen. Hidden, it still sits in the tree
  /// (the shell keeps both homes), and its pages must not take the system Back from the
  /// sessions home.
  final bool active;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  @override
  State<McProjectsNavigator> createState() => McProjectsNavigatorState();
}

class McProjectsNavigatorState extends State<McProjectsNavigator> {
  final GlobalKey<NavigatorState> _nav = GlobalKey<NavigatorState>();

  /// A pop that lands on the list goes on to [McProjectsNavigator.onExit]: opened from Now,
  /// Back from a line's page returns to Now, not to a list no tab shows any more.
  late final NavigatorObserver _exitObserver = _PopToRootObserver(() {
    final exit = widget.onExit;
    if (exit != null) WidgetsBinding.instance.addPostFrameCallback((_) => exit());
  });

  /// Shows [projectId]'s page, over the list.
  void openProject(String projectId) {
    final nav = _nav.currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    nav.push(_projectRoute(projectId));
  }

  /// Shows line [lineId]'s page, over the list (#523).
  void openLine(String lineId) {
    final nav = _nav.currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    nav.push(_lineRoute(lineId));
  }

  /// Shows the work item [subjectKey]'s page, over the list (#571: a tap on an item of a card's
  /// context sheet). Under this navigator the page keeps Mission Control's scope, so its own cards
  /// answer in place and open their context like any other.
  void openSubject(String subjectKey) {
    final nav = _nav.currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    nav.push(_subjectRouteOf(subjectKey));
  }

  /// Shows effort [effortId]'s page, over the list (#561): from the Running home.
  void openEffort(String effortId) {
    final nav = _nav.currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    nav.push(_effortRoute(effortId));
  }

  Route<void> _effortRoute(String effortId) => MaterialPageRoute<void>(
        settings: RouteSettings(name: 'mc-effort/$effortId'),
        builder: (context) => McEffortScreen(
          feed: widget.feed,
          effortId: effortId,
          now: widget.now,
          onAnswer: widget.onAnswer,
          onOpenSession: widget.onOpenSession,
          onOpenSubject: (key) => Navigator.of(context).push(_subjectRouteOf(key)),
        ),
      );

  Route<void> _subjectRoute(BuildContext context, McSubject s) => _subjectRouteOf(s.key, initial: s);

  Route<void> _subjectRouteOf(String subjectKey, {McSubject? initial}) => MaterialPageRoute<void>(
        settings: RouteSettings(name: 'mc-subject/$subjectKey'),
        builder: (_) => McSubjectScreen(
          feed: widget.feed,
          subjectKey: subjectKey,
          initial: initial,
          onAnswer: widget.onAnswer,
          onOpenSession: widget.onOpenSession,
          now: widget.now,
        ),
      );

  Route<void> _lineRoute(String lineId) => MaterialPageRoute<void>(
        settings: RouteSettings(name: 'mc-line/$lineId'),
        builder: (context) => McLineScreen(
          feed: widget.feed,
          lineId: lineId,
          now: widget.now,
          onAnswer: widget.onAnswer,
          onOpenSession: widget.onOpenSession,
          onOpenSubject: (s) => Navigator.of(context).push(_subjectRoute(context, s)),
        ),
      );

  Route<void> _projectRoute(String projectId) => MaterialPageRoute<void>(
        settings: RouteSettings(name: 'mc-project/$projectId'),
        builder: (context) => McProjectScreen(
          feed: widget.feed,
          projectId: projectId,
          now: widget.now,
          onAnswer: widget.onAnswer,
          onOpenSession: widget.onOpenSession,
          onStartWork: widget.onStartWork == null ? null : () => widget.onStartWork!(projectId),
          onOpenSubject: (s) => Navigator.of(context).push(_subjectRoute(context, s)),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return NavigatorPopHandler(
      enabled: widget.active,
      onPopWithResult: (_) => _nav.currentState?.maybePop(),
      child: Navigator(
        key: _nav,
        observers: [_exitObserver],
        onGenerateRoute: (settings) => MaterialPageRoute<void>(
          settings: settings,
          builder: (context) => Scaffold(
            appBar: AppBar(
                automaticallyImplyLeading: false,
                leading: widget.onExit == null
                    ? null
                    : BackButton(key: const ValueKey('mc-projects-exit'), onPressed: widget.onExit),
                title: Text(widget.feed.now?.lines != null ? 'Lines' : 'Projects'),
                actions: widget.actions),
            body: ListenableBuilder(
              listenable: widget.feed,
              builder: (context, _) => RefreshIndicator(
                onRefresh: widget.feed.refresh,
                child: ListView(
                  key: const ValueKey('mc-projects-tab'),
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                  children: [
                    if (widget.feed.now == null)
                      widget.feed.status == McStatus.loading
                          ? const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
                          : Text(widget.feed.message ?? 'Mission Control has not answered yet',
                              key: const ValueKey('mc-projects-none'),
                              style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant))
                    else ...[
                      if (widget.feed.message != null)
                        McStaleBanner(message: widget.feed.message!, at: widget.feed.receivedAt),
                      // #523: the lines when the server sends them, else the projects.
                      if (widget.feed.now?.lines != null)
                        McLinesList(
                          lines: widget.feed.now!.lines!,
                          onOpen: (l) => Navigator.of(context).push(_lineRoute(l.id)),
                        )
                      else
                        McProjectsSection(
                          projects: widget.feed.now?.projects ?? const [],
                          onOpen: (p) => Navigator.of(context).push(_projectRoute(p.id)),
                        ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One project's page: header, area tabs, filters, and its subjects grouped by run.
class McProjectScreen extends StatefulWidget {
  const McProjectScreen({
    super.key,
    required this.feed,
    required this.projectId,
    required this.onOpenSubject,
    this.onAnswer,
    this.onOpenSession,
    this.onStartWork,
    this.now,
  });

  final McFeed feed;
  final String projectId;

  final void Function(McSubject subject) onOpenSubject;

  /// #546 - answer / open for the waits shown once above the items; null: none is shown.
  final void Function(McCard card)? onAnswer;
  final void Function(String sessionId)? onOpenSession;

  /// #512 - Start work in this project; null: no button.
  final VoidCallback? onStartWork;
  final DateTime? now;

  @override
  State<McProjectScreen> createState() => _McProjectScreenState();
}

class _McProjectScreenState extends State<McProjectScreen> {
  /// The area tab: null is every area.
  String? _area;
  McSubjectFilter _filter = McSubjectFilter.active;
  McSubjects? _data;
  String? _error;
  bool _unsupported = false;
  DateTime? _feedAt;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _feedAt = widget.feed.receivedAt;
    widget.feed.addListener(_onFeed);
    unawaited(_load());
  }

  @override
  void dispose() {
    widget.feed.removeListener(_onFeed);
    super.dispose();
  }

  /// Every new Now answer reads the rows again, so the rows move with the counts.
  void _onFeed() {
    final at = widget.feed.receivedAt;
    if (at != null && at != _feedAt) {
      _feedAt = at;
      unawaited(_load());
    } else if (mounted) {
      setState(() {});
    }
  }

  /// Reads the rows of the current area. An answer for an area no longer chosen is
  /// dropped; a failed read keeps the last rows, with the reason beside them.
  Future<void> _load() async {
    final seq = ++_seq;
    final area = _area;
    try {
      final data = await widget.feed.subjects(project: widget.projectId, area: area);
      if (!mounted || seq != _seq) return;
      setState(() {
        _data = data;
        _error = null;
        _unsupported = false;
      });
    } on ApiException catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _unsupported = e.status == 404;
        _error = e.status == 404 ? 'This server has no subject list yet: it arrives with a server update' : e.message;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() => _error = 'Could not read the subjects: $e');
    }
  }

  /// A refresh asks Now again (which reads the rows again when it answers); only when Now
  /// brought nothing new are the rows read on their own.
  Future<void> _refresh() async {
    final before = widget.feed.receivedAt;
    await widget.feed.refresh();
    if (mounted && widget.feed.receivedAt == before) await _load();
  }

  void _pickArea(String? area) {
    if (area == _area) return;
    setState(() {
      _area = area;
      _data = null;
      _error = null;
    });
    unawaited(_load());
  }

  McProject? get _project {
    for (final p in widget.feed.now?.projects ?? const <McProject>[]) {
      if (p.id == widget.projectId) return p;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final p = _project;
    McArea? area;
    for (final a in p?.areas ?? const <McArea>[]) {
      if (a.id == _area) area = a;
    }
    final counts = area?.counts ?? p?.counts ?? const McCounts();
    final data = _data;
    return Scaffold(
      appBar: AppBar(
        title: Text(p?.name ?? widget.projectId),
        actions: [
          if (widget.onStartWork != null)
            IconButton(
              key: const ValueKey('mc-project-start-work'),
              tooltip: 'Start work in this project',
              icon: const Icon(Icons.play_circle_outline),
              onPressed: widget.onStartWork,
            ),
          IconButton(
            key: const ValueKey('mc-project-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () => unawaited(_refresh()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          key: const ValueKey('mc-project-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
          children: [
            // Header: project, tracker, counts.
            Row(children: [
              Expanded(
                child: Text(p?.name ?? widget.projectId,
                    key: const ValueKey('mc-project-name'),
                    style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
              ),
              if (p?.trackerLabel != null) Text(p!.trackerLabel!, key: const ValueKey('mc-project-tracker'), style: muted),
            ]),
            const SizedBox(height: 4),
            Text(p == null ? 'Not in the latest Now answer' : mcCountsLine(p.counts),
                key: const ValueKey('mc-project-header-counts'), style: theme.textTheme.bodySmall),
            if (p != null && p.counts.stages.isNotEmpty && p.counts.stageTotal > 0) ...[
              const SizedBox(height: 8),
              McStageBar(stages: p.counts.stages),
            ],
            const SizedBox(height: 12),
            // Area tabs, each with its count and, in orange, how many need the person.
            if (p != null && p.areas.isNotEmpty)
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [
                  _AreaTab(
                      key: const ValueKey('mc-area-tab-all'),
                      name: 'All',
                      counts: p.counts,
                      selected: _area == null,
                      onTap: () => _pickArea(null)),
                  for (final a in p.areas)
                    _AreaTab(
                        key: ValueKey('mc-area-tab-${a.id}'),
                        name: a.name,
                        counts: a.counts,
                        selected: _area == a.id,
                        onTap: () => _pickArea(a.id)),
                ]),
              ),
            const SizedBox(height: 8),
            // #546: a wait that names no item, once - not on each item it covers.
            if (data != null && widget.onAnswer != null && widget.onOpenSession != null)
              ...mcWaitBanners(context, widget.feed, data,
                  onAnswer: widget.onAnswer!, onOpenSession: widget.onOpenSession!, now: widget.now),
            // Filters, each with the server's count.
            Wrap(spacing: 6, runSpacing: 4, children: [
              for (final f in McSubjectFilter.values)
                ChoiceChip(
                  key: ValueKey('mc-filter-${f.name}'),
                  visualDensity: VisualDensity.compact,
                  label: Text('${f.label} ${f.countIn(counts)}'),
                  selected: _filter == f,
                  onSelected: (_) => setState(() => _filter = f),
                ),
            ]),
            const SizedBox(height: 8),
            if (_error != null && data != null)
              McStaleBanner(message: _error!, at: data.generatedAt),
            if (data != null && data.servers.any((s) => !s.ok))
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                    'Not answering: ${data.servers.where((s) => !s.ok).map((s) => s.name).join(', ')} - their sessions are missing',
                    key: const ValueKey('mc-project-servers-down'),
                    style: theme.textTheme.bodySmall?.copyWith(color: AppColors.caution)),
              ),
            ..._rows(context, data),
          ],
        ),
      ),
    );
  }

  List<Widget> _rows(BuildContext context, McSubjects? data) {
    final muted = Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant);
    if (data == null) {
      if (_error != null) {
        return [
          Padding(
            key: ValueKey(_unsupported ? 'mc-project-unsupported' : 'mc-project-error'),
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text(_error!, style: muted),
          ),
          if (!_unsupported)
            Center(
              child: TextButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('Try again')),
            ),
        ];
      }
      return const [Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))];
    }
    final shown = [for (final s in data.subjects) if (s.inFilter(_filter, now: widget.now)) s];
    if (shown.isEmpty) {
      return [
        Padding(
          key: const ValueKey('mc-project-empty'),
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Text(
              _filter == McSubjectFilter.needsYou && data.waits.isNotEmpty
                  ? 'What needs you is the wait above: it names no work item.'
                  : 'Nothing under "${_filter.label}" here.',
              style: muted),
        ),
      ];
    }
    return mcSubjectRows(context, data, shown, now: widget.now, onOpen: widget.onOpenSubject);
  }
}

/// The rows of [shown] (a filtered view of [data]'s subjects), grouped by the server's runs
/// in its order, then the rest under "Not in a run". Shared by the project and line pages.
List<Widget> mcSubjectRows(BuildContext context, McSubjects data, List<McSubject> shown,
    {DateTime? now, required void Function(McSubject subject) onOpen}) {
  Widget row(McSubject s) => McSubjectRow(
        key: ValueKey('mc-subject-row-${s.key}'),
        subject: s,
        now: now,
        onTap: () => onOpen(s),
      );
  final out = <Widget>[];
  final placed = <String>{};
  // Runs first, in the server's order, each with its own subjects under it.
  for (final r in data.runs) {
    final mine = [for (final s in shown) if (s.runId == r.id) s];
    if (mine.isEmpty) continue;
    out.add(McRunHeader(run: r, now: now));
    for (final s in mine) {
      placed.add(s.key);
      out.add(row(s));
    }
  }
  final rest = [for (final s in shown) if (!placed.contains(s.key)) s];
  if (rest.isNotEmpty && out.isNotEmpty) {
    out.add(Padding(
      key: const ValueKey('mc-project-no-run'),
      padding: const EdgeInsets.fromLTRB(2, 10, 2, 6),
      child: Text('Not in a run', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
    ));
  }
  out.addAll(rest.map(row));
  return out;
}

class _AreaTab extends StatelessWidget {
  const _AreaTab({super.key, required this.name, required this.counts, required this.selected, required this.onTap});
  final String name;
  final McCounts counts;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.labelLarge;
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: ChoiceChip(
        selected: selected,
        onSelected: (_) => onTap(),
        label: Row(mainAxisSize: MainAxisSize.min, children: [
          Text('$name ${counts.active}', style: style),
          if (counts.needsYou > 0) ...[
            const SizedBox(width: 6),
            Text('${counts.needsYou}',
                key: const ValueKey('mc-area-needs-you'),
                style: style?.copyWith(color: AppColors.caution, fontWeight: FontWeight.w700)),
          ],
        ]),
      ),
    );
  }
}


/// Calls [onRoot] when a pop leaves only the navigator's first route (the list) showing.
class _PopToRootObserver extends NavigatorObserver {
  _PopToRootObserver(this.onRoot);
  final VoidCallback onRoot;

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null && previousRoute.isFirst) onRoot();
  }
}
