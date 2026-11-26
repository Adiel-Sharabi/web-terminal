// #561 - Mission Control's Running home: what RUNS, not what is filed.
//
// One card per effort (a lead session and every session it started, on any machine), the
// state the server read off the whole tree (needs you / stuck / moving / waiting), what it
// is doing, the supervisor's verdict on its wait, its work items, and Answer on the cards
// that wait for the person. Below them, folded: the work nobody runs, grouped by line.
// A machine chip per server says how full it is.
//
// It renders `GET /api/mc/efforts` (read by [McFeed] beside Now) and re-derives nothing: the
// order, the state, the verdict kind and the not-running class are the server's
// (`lib/mc-efforts.js`). The one thing computed here is a set difference of two server lists:
// a card Now lists that no effort carries (the dispatcher's own, one whose tree has closed)
// is shown above the efforts, so a wait on the person never disappears from the home.
// An authority without the efforts keeps the Now screen ([McNowView]) - see [McFeed.efforts].

import 'package:flutter/material.dart';

import '../../api/mc_models.dart';
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import '../../widgets/format_utils.dart';
import 'now_view.dart';

/// The colour of an effort's state: red needs you, amber is stuck, green moves, grey waits.
Color mcEffortColor(String state) => switch (state) {
      'needs-you' => AppColors.error,
      'stuck' => AppColors.caution,
      'moving' => AppColors.primary,
      _ => AppColors.onSurfaceVariant,
    };

/// The words of an effort's state; a state this app does not know is shown as sent.
String mcEffortStateLabel(String state) => switch (state) {
      'needs-you' => 'Needs you',
      'stuck' => 'Stuck',
      'moving' => 'Moving',
      'waiting' => 'Waiting',
      _ => state,
    };

/// The words of a not-running class; one this app does not know is shown as sent.
String mcIdleClassLabel(String cls) => switch (cls) {
      'waits-test' => 'Waits for test',
      'not-started' => 'Not started',
      'stranded' => 'Stranded',
      'finished' => 'Finished',
      _ => cls,
    };

/// The Running home. [onOpenEffort] opens an effort's page; [onOpenLine] a line's page (by id);
/// [onStartWork] opens Start work on an item nobody runs (its line's project, when it has one).
class McRunningView extends StatelessWidget {
  const McRunningView({
    super.key,
    required this.feed,
    required this.onAnswer,
    required this.onOpenSession,
    required this.onOpenEffort,
    required this.onOpenLine,
    required this.onStartWork,
    this.now,
  });

  final McFeed feed;
  final void Function(McCard card) onAnswer;
  final void Function(String sessionId) onOpenSession;
  final void Function(McEffort effort) onOpenEffort;
  final void Function(String lineId) onOpenLine;
  final void Function(McIdleItem item, String? projectId) onStartWork;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: feed,
      builder: (context, _) {
        final data = feed.efforts;
        final nowData = feed.now;
        if (data == null || nowData == null) return const Center(child: CircularProgressIndicator());
        final projectNames = {for (final p in nowData.projects) p.id: p.name};
        final carried = {for (final e in data.efforts) for (final c in e.needsYou) c.id};
        // A card Now lists that no effort carries: never hidden (see the file header).
        final loose = [for (final c in nowData.answerNow) if (!carried.contains(c.id)) c];
        return RefreshIndicator(
          onRefresh: () => feed.refresh(show: true),
          child: ListView(
            key: const ValueKey('mc-running-list'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
            children: [
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 900),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    if (feed.message != null) McStaleBanner(message: feed.message!, at: feed.receivedAt),
                    if (feed.effortsMessage != null) McStaleBanner(message: feed.effortsMessage!, at: feed.receivedAt),
                    McMachineChips(machines: data.machines),
                    if (!data.complete) _IncompleteNote(silent: data.silent),
                    const SizedBox(height: 12),
                    McTodoSection(
                        feed: feed,
                        actions: nowData.actions,
                        todos: nowData.todo,
                        projectNames: projectNames,
                        onOpenSession: onOpenSession,
                        now: now),
                    const SizedBox(height: 16),
                    if (loose.isNotEmpty) ...[
                      mcSectionTitle(context, 'Also waiting on you (${loose.length})',
                          key: const ValueKey('mc-loose-title'), hint: 'no running effort carries these'),
                      for (final c in loose)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: mcWaitCard(context, feed, c, onAnswer: onAnswer, onOpenSession: onOpenSession, now: now),
                        ),
                      const SizedBox(height: 8),
                    ],
                    mcSectionTitle(context, 'Running (${data.efforts.length})',
                        key: const ValueKey('mc-running-title'), hint: 'the sessions that run, by the lead that started them'),
                    if (data.efforts.isEmpty)
                      Padding(
                        key: const ValueKey('mc-running-empty'),
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Text('Nothing is running.',
                            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant)),
                      ),
                    for (final e in data.efforts)
                      Padding(
                        key: ValueKey('mc-effort-${e.id}'),
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          McEffortCard(effort: e, now: now, onTap: () => onOpenEffort(e)),
                          for (final c in e.needsYou)
                            Padding(
                              padding: const EdgeInsets.only(left: 14, top: 6),
                              child: mcWaitCard(context, feed, c, onAnswer: onAnswer, onOpenSession: onOpenSession, now: now),
                            ),
                        ]),
                      ),
                    const SizedBox(height: 8),
                    McNotRunning(groups: data.idle, onOpenLine: onOpenLine, onStartWork: onStartWork, now: now),
                  ]),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The header: one chip per machine, `Home 4/10` (live sessions out of its limit; the limit is left
/// out when it was not read). A machine that did not answer is greyed.
class McMachineChips extends StatelessWidget {
  const McMachineChips({super.key, required this.machines});
  final List<McMachineSlot> machines;

  @override
  Widget build(BuildContext context) {
    if (machines.isEmpty) return const SizedBox.shrink();
    final small = Theme.of(context).textTheme.labelMedium;
    return Wrap(
      key: const ValueKey('mc-machine-chips'),
      spacing: 6,
      runSpacing: 4,
      children: [
        for (final m in machines)
          Tooltip(
            message: m.ok ? '${m.working} working' : '${m.name} did not answer',
            child: Chip(
              key: ValueKey('mc-machine-chip-${m.name}'),
              visualDensity: VisualDensity.compact,
              avatar: Icon(Icons.circle, size: 10, color: m.ok ? AppColors.primary : AppColors.onSurfaceDisabled),
              // A machine that did not answer has no count to show: it was never read.
              label: Text(m.ok ? m.label : '${m.name} - no answer',
                  style: small?.copyWith(color: m.ok ? null : AppColors.onSurfaceDisabled)),
            ),
          ),
      ],
    );
  }
}

class _IncompleteNote extends StatelessWidget {
  const _IncompleteNote({required this.silent});
  final List<String> silent;

  @override
  Widget build(BuildContext context) {
    final who = silent.isEmpty ? 'A machine' : silent.join(', ');
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(key: const ValueKey('mc-running-incomplete'), crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Icon(Icons.warning_amber_rounded, color: AppColors.caution, size: 16),
        const SizedBox(width: 6),
        Expanded(
          child: Text('$who did not answer: an effort that runs there may be missing.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.caution)),
        ),
      ]),
    );
  }
}

/// One effort: its state, name, machines, what it is doing, the verdict on its wait and a strip of
/// its work items. [onTap] opens the effort's page; null: not tappable (the page's own header).
class McEffortCard extends StatelessWidget {
  const McEffortCard({super.key, required this.effort, this.onTap, this.now});
  final McEffort effort;
  final VoidCallback? onTap;
  final DateTime? now;

  static const int _itemChips = 4;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final e = effort;
    final color = mcEffortColor(e.state);
    final last = e.lastActivity;
    final live = e.liveSessions.length;
    final where = [
      if (e.machines.isNotEmpty) e.machines.join(' · '),
      '$live ${live == 1 ? 'session' : 'sessions'}',
    ].join(' · ');
    final v = e.verdict;
    final verdictColor = v == null
        ? null
        : v.isSuspect
            ? AppColors.caution
            : (v.isLegit ? AppColors.onSurfaceVariant : AppColors.onSurfaceDisabled);
    final shown = e.items.take(_itemChips).toList();
    final more = e.items.length - shown.length;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(border: Border(left: BorderSide(color: color, width: 4))),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              McTag(mcEffortStateLabel(e.state), key: ValueKey('mc-effort-state-${e.id}'), color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(e.name,
                    key: ValueKey('mc-effort-name-${e.id}'),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
              ),
              if (last != null) ...[
                const SizedBox(width: 8),
                Text(relativeTime(last.millisecondsSinceEpoch, now: now), style: muted),
              ],
            ]),
            const SizedBox(height: 4),
            Text(where, key: ValueKey('mc-effort-where-${e.id}'), style: muted),
            if (e.doing != null) ...[
              const SizedBox(height: 4),
              Text(e.doing!,
                  key: ValueKey('mc-effort-doing-${e.id}'), maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium),
            ],
            if (v != null) ...[
              const SizedBox(height: 4),
              Text(v.line,
                  key: ValueKey('mc-effort-verdict-${e.id}'),
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(color: verdictColor, fontWeight: v.isSuspect ? FontWeight.w600 : null)),
            ],
            if (e.todoCount > 0) ...[
              const SizedBox(height: 4),
              Text(e.todoCount == 1 ? 'One thing for you is on My to-do.' : '${e.todoCount} things for you are on My to-do.',
                  key: ValueKey('mc-effort-todo-${e.id}'), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.caution)),
            ],
            if (e.partial) ...[
              const SizedBox(height: 4),
              Text(
                  e.missing.isEmpty
                      ? 'Its lead may be on a machine that did not answer.'
                      : 'Its lead may be on ${e.missing.join(', ')}, which did not answer.',
                  key: ValueKey('mc-effort-partial-${e.id}'),
                  style: theme.textTheme.bodySmall?.copyWith(color: AppColors.caution)),
            ],
            if (shown.isNotEmpty) ...[
              const SizedBox(height: 6),
              Wrap(key: ValueKey('mc-effort-items-${e.id}'), spacing: 6, runSpacing: 4, children: [
                for (final i in shown) McTag('${i.refLabel} · ${i.stateLabel ?? 'no stage'}', muted: true),
                if (more > 0) McTag('+$more', muted: true),
              ]),
            ],
          ]),
        ),
      ),
    );
  }
}

/// "Not running (N)": the work nobody runs, folded, grouped by line, in the server's order. A line's
/// name opens its page; an item has Start work.
class McNotRunning extends StatefulWidget {
  const McNotRunning({super.key, required this.groups, required this.onOpenLine, required this.onStartWork, this.now});
  final List<McIdleGroup> groups;
  final void Function(String lineId) onOpenLine;
  final void Function(McIdleItem item, String? projectId) onStartWork;
  final DateTime? now;

  @override
  State<McNotRunning> createState() => _McNotRunningState();
}

class _McNotRunningState extends State<McNotRunning> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final total = widget.groups.fold<int>(0, (n, g) => n + g.items.length);
    if (total == 0) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          key: const ValueKey('mc-idle-toggle'),
          onPressed: () => setState(() => _open = !_open),
          icon: Icon(_open ? Icons.expand_less : Icons.expand_more),
          label: Text('Not running ($total)'),
        ),
      ),
      if (_open)
        for (final g in widget.groups)
          Padding(
            key: ValueKey('mc-idle-group-${g.line?.id ?? 'none'}'),
            padding: const EdgeInsets.only(bottom: 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              InkWell(
                key: ValueKey('mc-idle-line-${g.line?.id ?? 'none'}'),
                onTap: g.line == null ? null : () => widget.onOpenLine(g.line!.id),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [
                    Expanded(
                      child: Text(g.line?.name ?? 'On no line',
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis),
                    ),
                    if (g.line?.project != null) Text(g.line!.project!, style: muted),
                    if (g.line != null) const Icon(Icons.chevron_right, size: 18, color: AppColors.onSurfaceVariant),
                  ]),
                ),
              ),
              for (final i in g.items) _item(context, g, i),
            ]),
          ),
    ]);
  }

  Widget _item(BuildContext context, McIdleGroup g, McIdleItem i) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final state = i.stateLabel;
    return Card(
      key: ValueKey('mc-idle-item-${i.key}'),
      margin: const EdgeInsets.only(bottom: 6),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${i.refLabel}${i.title == null ? '' : '  ${i.title}'}', maxLines: 2, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 2),
              Wrap(spacing: 6, runSpacing: 2, crossAxisAlignment: WrapCrossAlignment.center, children: [
                McTag(mcIdleClassLabel(i.cls), key: ValueKey('mc-idle-cls-${i.key}'), muted: true),
                if (state != null) Text(state, style: muted),
                if (i.updatedAt != null) Text(relativeTime(i.updatedAt!.millisecondsSinceEpoch, now: widget.now), style: muted),
              ]),
            ]),
          ),
          // A session-local item (`<key>@<session id>`, lib/mc-subjects.js subjectKeyOf) names nothing
          // the tracker knows: Start work has nothing to bind to.
          if (!i.key.contains('@'))
            TextButton(
              key: ValueKey('mc-idle-start-${i.key}'),
              onPressed: () => widget.onStartWork(i, g.line?.project),
              child: const Text('Start work'),
            ),
        ]),
      ),
    );
  }
}

/// An effort's page: its card, what waits on the person, its work items (each opens the item's page)
/// and its session tree (each live session opens). It reads the feed, so it follows the effort live;
/// an effort that has ended says so.
class McEffortScreen extends StatelessWidget {
  const McEffortScreen({
    super.key,
    required this.feed,
    required this.effortId,
    required this.onAnswer,
    required this.onOpenSession,
    required this.onOpenSubject,
    this.now,
  });

  final McFeed feed;
  final String effortId;
  final void Function(McCard card) onAnswer;
  final void Function(String sessionId) onOpenSession;
  final void Function(String subjectKey) onOpenSubject;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: feed,
      builder: (context, _) {
        final e = feed.efforts?.effort(effortId);
        return Scaffold(
          appBar: AppBar(title: Text(e?.name ?? 'Effort', overflow: TextOverflow.ellipsis)),
          body: e == null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text('This effort is not running any more.',
                        key: const ValueKey('mc-effort-gone'),
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant)),
                  ),
                )
              : _body(context, e),
        );
      },
    );
  }

  Widget _body(BuildContext context, McEffort e) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return RefreshIndicator(
      onRefresh: () => feed.refresh(show: true),
      child: ListView(
        key: const ValueKey('mc-effort-page'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: [
          McEffortCard(effort: e, now: now),
          if (e.needsYou.isNotEmpty) ...[
            const SizedBox(height: 16),
            mcSectionTitle(context, 'Waiting on you (${e.needsYou.length})', key: const ValueKey('mc-effort-waits-title')),
            for (final c in e.needsYou)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: mcWaitCard(context, feed, c, onAnswer: onAnswer, onOpenSession: onOpenSession, now: now),
              ),
          ],
          const SizedBox(height: 16),
          mcSectionTitle(context, 'Items (${e.items.length})', key: const ValueKey('mc-effort-items-title')),
          if (e.items.isEmpty) Text('It names no work item.', key: const ValueKey('mc-effort-no-items'), style: muted),
          for (final i in e.items)
            Card(
              key: ValueKey('mc-effort-item-${i.key}'),
              margin: const EdgeInsets.only(bottom: 6),
              child: ListTile(
                dense: true,
                title: Text('${i.refLabel}${i.title == null ? '' : '  ${i.title}'}', maxLines: 2, overflow: TextOverflow.ellipsis),
                subtitle: Text([?i.stateLabel, if (i.waitsOn != null) 'waits on ${i.waitsOn}'].join(' · ')),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => onOpenSubject(i.key),
              ),
            ),
          const SizedBox(height: 16),
          mcSectionTitle(context, 'Sessions (${e.sessions.length})', key: const ValueKey('mc-effort-sessions-title')),
          for (final s in e.sessions) _session(context, s),
        ],
      ),
    );
  }

  Widget _session(BuildContext context, McEffortSession s) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final v = s.verdict;
    final line = [
      ?s.server,
      if (s.closed) 'closed' else ?s.status,
      if (s.wait != null) 'waits on ${s.wait!.on}${s.wait!.what == null || s.wait!.what!.isEmpty ? '' : ': ${s.wait!.what}'}',
    ].join(' · ');
    return Padding(
      key: ValueKey('mc-effort-session-${s.id}'),
      padding: EdgeInsets.only(left: 16.0 * s.depth.clamp(0, 6), bottom: 4),
      child: Card(
        margin: EdgeInsets.zero,
        child: InkWell(
          // A closed session has nothing to open on this app's stack.
          onTap: s.closed ? null : () => onOpenSession(s.id),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(color: s.closed ? AppColors.onSurfaceVariant : null)),
              if (line.isNotEmpty) Text(line, style: muted),
              if (v != null)
                Text(v.line,
                    style: theme.textTheme.bodySmall?.copyWith(
                        color: v.isSuspect ? AppColors.caution : (v.isLegit ? AppColors.onSurfaceVariant : AppColors.onSurfaceDisabled))),
            ]),
          ),
        ),
      ),
    );
  }
}
