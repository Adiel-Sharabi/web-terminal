// #508 - Mission Control's Projects tab: the projects, and one page per project and area
// with every subject on it.
//
// The tab is its own navigator (projects -> a project -> a subject), so the side nav or
// the bottom bar stays in place and a session opened from a subject (on the app's one
// session stack, over Mission Control) comes Back to that subject.
//
// The header and the area tabs show the counts of the SAME answer the Now screen shows
// (`GET /api/mc/now`, read by [McFeed]): the numbers match Now because they are Now's.
// The rows are `GET /api/mc/subjects?project=&area=`, read again on every Now refresh.
// Nothing is re-counted here: a filter's number is the server's count; its rows are the
// subjects the server put under it (see [McSubject.inFilter]).

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_models.dart';
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import 'now_view.dart';
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
    this.actions = const [],
    this.now,
  });

  final McFeed feed;
  final void Function(McCard card) onAnswer;
  final void Function(String sessionId) onOpenSession;
  final List<Widget> actions;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  @override
  State<McProjectsNavigator> createState() => McProjectsNavigatorState();
}

class McProjectsNavigatorState extends State<McProjectsNavigator> {
  final GlobalKey<NavigatorState> _nav = GlobalKey<NavigatorState>();

  /// Shows [projectId]'s page, over the list.
  void openProject(String projectId) {
    final nav = _nav.currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    nav.push(_projectRoute(projectId));
  }

  Route<void> _projectRoute(String projectId) => MaterialPageRoute<void>(
        settings: RouteSettings(name: 'mc-project/$projectId'),
        builder: (context) => McProjectScreen(
          feed: widget.feed,
          projectId: projectId,
          now: widget.now,
          onOpenSubject: (s, order) => Navigator.of(context).push(MaterialPageRoute<void>(
            settings: RouteSettings(name: 'mc-subject/${s.key}'),
            builder: (_) => McSubjectScreen(
              feed: widget.feed,
              subjectKey: s.key,
              initial: s,
              initialOrder: order,
              onAnswer: widget.onAnswer,
              onOpenSession: widget.onOpenSession,
              now: widget.now,
            ),
          )),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return NavigatorPopHandler(
      onPopWithResult: (_) => _nav.currentState?.maybePop(),
      child: Navigator(
        key: _nav,
        onGenerateRoute: (settings) => MaterialPageRoute<void>(
          settings: settings,
          builder: (context) => Scaffold(
            appBar: AppBar(automaticallyImplyLeading: false, title: const Text('Projects'), actions: widget.actions),
            body: ListenableBuilder(
              listenable: widget.feed,
              builder: (context, _) => RefreshIndicator(
                onRefresh: widget.feed.refresh,
                child: ListView(
                  key: const ValueKey('mc-projects-tab'),
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                  children: [
                    if (widget.feed.message != null)
                      McStaleBanner(message: widget.feed.message!, at: widget.feed.receivedAt),
                    if (widget.feed.now == null && widget.feed.status != McStatus.loading)
                      Text(widget.feed.message ?? 'Mission Control has not answered yet',
                          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant))
                    else
                      McProjectsSection(
                        projects: widget.feed.now?.projects ?? const [],
                        onOpen: (p) => Navigator.of(context).push(_projectRoute(p.id)),
                      ),
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
    this.now,
  });

  final McFeed feed;
  final String projectId;

  /// Opens a subject; [order] is the stage order its list was drawn with.
  final void Function(McSubject subject, List<String> order) onOpenSubject;
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
          IconButton(
            key: const ValueKey('mc-project-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () {
              unawaited(widget.feed.refresh());
              unawaited(_load());
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => Future.wait([widget.feed.refresh(), _load()]),
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
    final shown = [for (final s in data.subjects) if (s.inFilter(_filter)) s];
    if (shown.isEmpty) {
      return [
        Padding(
          key: const ValueKey('mc-project-empty'),
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Text('Nothing under "${_filter.label}" here.', style: muted),
        ),
      ];
    }
    Widget row(McSubject s) => McSubjectRow(
          key: ValueKey('mc-subject-row-${s.key}'),
          subject: s,
          order: data.stageOrder,
          now: widget.now,
          onTap: () => widget.onOpenSubject(s, data.stageOrder),
        );
    final out = <Widget>[];
    final placed = <String>{};
    // Runs first, in the server's order, each with its own subjects under it.
    for (final r in data.runs) {
      final mine = [for (final s in shown) if (s.runId == r.id) s];
      if (mine.isEmpty) continue;
      out.add(McRunHeader(run: r, now: widget.now));
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

