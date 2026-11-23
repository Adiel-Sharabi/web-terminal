// #508 / #509 - the pieces the Project and Subject screens share: the stage track, a
// subject's row, a run's header. Each renders the server's answer as sent: the stage the
// server computed, its order, its tree and its runs. Nothing is re-derived here.

import 'package:flutter/material.dart';

import '../../api/mc_models.dart';
import '../../theme/app_theme.dart';
import '../../widgets/format_utils.dart';
import 'now_view.dart' show McTag, mcAge;

/// Where [stage] sits in [order], or -1 when it is not in it (or null).
int mcStageIndex(List<String> order, String? stage) => stage == null ? -1 : order.indexOf(stage);

/// The steps of the progress track, one segment each, filled up to the current one.
class McStageTrack extends StatelessWidget {
  const McStageTrack({super.key, required this.stage, this.order = kMcStageOrder});
  final McStage stage;
  final List<String> order;

  @override
  Widget build(BuildContext context) {
    final at = mcStageIndex(order, stage.current);
    return Semantics(
      label: stage.current == null ? 'no stage yet' : 'stage ${mcStageLabel(stage.current!)}',
      child: SizedBox(
        height: 6,
        child: Row(children: [
          for (var i = 0; i < order.length; i++) ...[
            if (i > 0) const SizedBox(width: 2),
            Expanded(
              child: Container(
                key: ValueKey('mc-track-${order[i]}-${i <= at ? 'on' : 'off'}'),
                decoration: BoxDecoration(
                  color: i < at
                      ? AppColors.primary.withValues(alpha: 0.55)
                      : i == at
                          ? AppColors.primary
                          : AppColors.outline,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ],
        ]),
      ),
    );
  }
}

/// What a subject waits on, in words: `waits on you: <what>`, `waits on others`, ...; null
/// when the server says nothing.
String? mcWaitsText(McSubject s) {
  String? whatFor(String on) {
    for (final x in s.sessions) {
      final w = x.wait;
      if (!x.closed && w != null && w.on == on && w.what != null) return w.what;
    }
    return null;
  }

  switch (s.waitsOn) {
    case 'you':
      final what = s.needsYou?.what ?? whatFor('you');
      return what == null ? 'waits on you' : 'waits on you: $what';
    case 'external':
      final what = whatFor('external');
      return what == null ? 'waits on others' : 'waits on others: $what';
    case 'self':
      return 'moving on its own';
    case 'done':
      return 'nothing pending';
  }
  return null;
}

/// How old a subject is: since the work item was opened, else since it last changed.
String? mcSubjectAge(McSubject s, {DateTime? now}) {
  final at = s.meta?.createdAt ?? s.updatedAt;
  if (at == null) return null;
  final d = (now ?? DateTime.now()).difference(at);
  return mcAge(d.isNegative ? Duration.zero : d);
}

/// A small chip naming a machine.
class McMachineChip extends StatelessWidget {
  const McMachineChip(this.name, {super.key});
  final String name;

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      const Icon(Icons.dns_outlined, size: 12, color: AppColors.onSurfaceVariant),
      const SizedBox(width: 3),
      Text(name, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: AppColors.onSurfaceVariant)),
    ]);
  }
}

/// One subject on the Project screen: ref and title; type, area and opener; severity; the
/// stage track; the current step and what it waits on; its machines; its age. Tapping it
/// opens the Subject screen.
class McSubjectRow extends StatelessWidget {
  const McSubjectRow({super.key, required this.subject, required this.onTap, this.order = kMcStageOrder, this.now});
  final McSubject subject;
  final VoidCallback onTap;
  final List<String> order;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final s = subject;
    final meta = s.meta;
    final kind = [
      ?meta?.type,
      ?s.area,
      if (meta?.createdBy != null) 'by ${meta!.createdBy}',
    ].join(' · ');
    final current = s.stage.current;
    final waits = mcWaitsText(s);
    final step = [
      current == null ? 'no stage yet' : mcStageLabel(current),
      ?waits,
    ].join(' · ');
    final age = mcSubjectAge(s, now: now);
    final severity = meta?.severityLabel;
    final needsYou = s.inFilter(McSubjectFilter.needsYou);
    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('mc-subject-${s.key}'),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.refLabel,
                  style: theme.textTheme.titleSmall?.copyWith(color: AppColors.primary, fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(s.titleLabel,
                    key: const ValueKey('mc-subject-title'),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall),
              ),
              if (age != null) ...[
                const SizedBox(width: 8),
                Text(age, key: const ValueKey('mc-subject-age'), style: muted),
              ],
            ]),
            if (kind.isNotEmpty || severity != null) ...[
              const SizedBox(height: 4),
              Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                if (kind.isNotEmpty) Text(kind, key: const ValueKey('mc-subject-kind'), style: muted),
                if (severity != null) McTag(severity, key: const ValueKey('mc-subject-severity'), color: AppColors.caution),
              ]),
            ],
            const SizedBox(height: 8),
            McStageTrack(stage: s.stage, order: order),
            const SizedBox(height: 6),
            Text(step,
                key: const ValueKey('mc-subject-step'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(color: needsYou ? AppColors.caution : null)),
            if (s.machines.isNotEmpty) ...[
              const SizedBox(height: 4),
              Wrap(spacing: 10, runSpacing: 2, children: [for (final m in s.machines) McMachineChip(m)]),
            ],
          ]),
        ),
      ),
    );
  }
}

/// A run's header: its name, when it started, on which machine, the orchestrator's state
/// and its children with theirs.
class McRunHeader extends StatelessWidget {
  const McRunHeader({super.key, required this.run, this.now});
  final McRun run;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final r = run;
    final line = [
      if (r.startedAt != null) 'started ${relativeTime(r.startedAt!.millisecondsSinceEpoch, now: now)}',
      if (r.server != null) 'on ${r.server}',
      if (r.status != null) 'orchestrator ${r.status}',
      r.subjects.length == 1 ? '1 subject' : '${r.subjects.length} subjects',
    ].join(' · ');
    return Padding(
      key: ValueKey('mc-run-${r.id}'),
      padding: const EdgeInsets.fromLTRB(2, 10, 2, 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Icon(Icons.account_tree_outlined, size: 16, color: AppColors.primary),
          const SizedBox(width: 6),
          Expanded(
            child: Text(r.name ?? 'Run',
                style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                overflow: TextOverflow.ellipsis),
          ),
        ]),
        Text(line, key: const ValueKey('mc-run-line'), style: muted),
        if (r.children.isNotEmpty) ...[
          const SizedBox(height: 4),
          Wrap(spacing: 6, runSpacing: 4, children: [
            for (final c in r.children)
              McTag([c.name ?? c.id ?? 'child', ?c.status].join(' · '), muted: true),
          ]),
        ],
      ]),
    );
  }
}
