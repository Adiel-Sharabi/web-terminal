// #523 - Mission Control's lines of work: the cards at the top of Now and in the Lines
// tab, one line's page (its subjects), and the "Move to line" sheet.
//
// The server decides which line a work item is on and why (`Subject.line`); this file
// renders that answer and never re-derives it. A move is the person's own correction,
// sent to the server (`POST /api/mc/lines/move`) and shown again from its next answer.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_models.dart';
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import '../../widgets/app_bottom_sheet.dart';
import 'now_view.dart';
import 'project_view.dart' show mcSubjectRows;

/// A line's counts in one line: who needs the person, the live sessions, the machines.
String mcLineCountsLine(McLine l) {
  final k = l.counts;
  return [
    if (k.needsYou > 0) '${k.needsYou} need you',
    '${k.active} active',
    '${k.sessions} live session${k.sessions == 1 ? '' : 's'}',
    if (l.machines.isNotEmpty) 'on ${l.machines.join(', ')}',
  ].join(' · ');
}

/// The lines of work, each a card with its project label and its stage bar.
class McLinesSection extends StatelessWidget {
  const McLinesSection({super.key, required this.lines, this.title = 'Lines of work', this.onOpen});
  final List<McLine> lines;
  final String title;

  /// Opens a line's page; null: the cards are not tappable.
  final void Function(McLine line)? onOpen;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      mcSectionTitle(context, title),
      if (lines.isEmpty)
        Text('No line of work has work yet.',
            key: const ValueKey('mc-lines-empty'),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant)),
      for (final l in lines)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: McLineCard(key: ValueKey('mc-line-${l.id}'), line: l, onTap: onOpen == null ? null : () => onOpen!(l)),
        ),
    ]);
  }
}

class McLineCard extends StatelessWidget {
  const McLineCard({super.key, required this.line, this.onTap});
  final McLine line;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final l = line;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(l.name, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600))),
              if (l.projectLabel != null) ...[
                const SizedBox(width: 8),
                Flexible(
                    child: Text(l.projectLabel!,
                        key: const ValueKey('mc-line-project'), style: muted, overflow: TextOverflow.ellipsis)),
              ],
            ]),
            const SizedBox(height: 4),
            Text(mcLineCountsLine(l), key: const ValueKey('mc-line-counts'), style: theme.textTheme.bodySmall),
            if (l.counts.stages.isNotEmpty && l.counts.stageTotal > 0) ...[
              const SizedBox(height: 8),
              McStageBar(stages: l.counts.stages),
            ],
          ]),
        ),
      ),
    );
  }
}

/// The Lines tab's list page: the lines, with a filter chip per project they belong to.
class McLinesList extends StatefulWidget {
  const McLinesList({super.key, required this.lines, required this.onOpen});
  final List<McLine> lines;
  final void Function(McLine line) onOpen;

  @override
  State<McLinesList> createState() => _McLinesListState();
}

class _McLinesListState extends State<McLinesList> {
  /// The chosen project id; null is every project.
  String? _project;

  @override
  Widget build(BuildContext context) {
    final projects = <String, String>{};
    for (final l in widget.lines) {
      final id = l.project;
      if (id != null) projects.putIfAbsent(id, () => l.projectLabel ?? id);
    }
    // A project whose lines are all gone is no longer a filter: show everything.
    final project = projects.containsKey(_project) ? _project : null;
    final shown = [for (final l in widget.lines) if (project == null || l.project == project) l];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (projects.length > 1)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Wrap(spacing: 6, runSpacing: 4, children: [
            ChoiceChip(
              key: const ValueKey('mc-lines-filter-all'),
              visualDensity: VisualDensity.compact,
              label: const Text('All'),
              selected: project == null,
              onSelected: (_) => setState(() => _project = null),
            ),
            for (final e in projects.entries)
              ChoiceChip(
                key: ValueKey('mc-lines-filter-${e.key}'),
                visualDensity: VisualDensity.compact,
                label: Text(e.value),
                selected: project == e.key,
                onSelected: (_) => setState(() => _project = e.key),
              ),
          ]),
        ),
      McLinesSection(lines: shown, title: 'Lines', onOpen: widget.onOpen),
    ]);
  }
}

/// One line's page: header, filters and its subjects grouped by run.
class McLineScreen extends StatefulWidget {
  const McLineScreen({
    super.key,
    required this.feed,
    required this.lineId,
    required this.onOpenSubject,
    this.onAnswer,
    this.onOpenSession,
    this.now,
  });

  final McFeed feed;
  final String lineId;
  final void Function(McSubject subject) onOpenSubject;

  /// #546 - answer / open for the waits shown once above the items; null: none is shown.
  final void Function(McCard card)? onAnswer;
  final void Function(String sessionId)? onOpenSession;
  final DateTime? now;

  @override
  State<McLineScreen> createState() => _McLineScreenState();
}

class _McLineScreenState extends State<McLineScreen> {
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

  void _onFeed() {
    final at = widget.feed.receivedAt;
    if (at != null && at != _feedAt) {
      _feedAt = at;
      unawaited(_load());
    } else if (mounted) {
      setState(() {});
    }
  }

  Future<void> _load() async {
    final seq = ++_seq;
    try {
      final data = await widget.feed.subjects(line: widget.lineId);
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
        _error = e.status == 404 ? 'This server has no line list yet: it arrives with a server update' : e.message;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() => _error = 'Could not read the subjects: $e');
    }
  }

  Future<void> _refresh() async {
    final before = widget.feed.receivedAt;
    await widget.feed.refresh();
    if (mounted && widget.feed.receivedAt == before) await _load();
  }

  McLine? get _line {
    for (final l in widget.feed.now?.lines ?? const <McLine>[]) {
      if (l.id == widget.lineId) return l;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final l = _line;
    final counts = l?.counts ?? const McCounts();
    final data = _data;
    return Scaffold(
      appBar: AppBar(
        title: Text(l?.name ?? widget.lineId),
        actions: [
          IconButton(
            key: const ValueKey('mc-line-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () => unawaited(_refresh()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          key: const ValueKey('mc-line-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
          children: [
            Row(children: [
              Expanded(
                child: Text(l?.name ?? widget.lineId,
                    key: const ValueKey('mc-line-name'),
                    style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
              ),
              if (l?.projectLabel != null) Text(l!.projectLabel!, key: const ValueKey('mc-line-header-project'), style: muted),
            ]),
            const SizedBox(height: 4),
            Text(l == null ? 'Not in the latest Now answer' : mcLineCountsLine(l),
                key: const ValueKey('mc-line-header-counts'), style: theme.textTheme.bodySmall),
            if (l != null && l.counts.stages.isNotEmpty && l.counts.stageTotal > 0) ...[
              const SizedBox(height: 8),
              McStageBar(stages: l.counts.stages),
            ],
            const SizedBox(height: 12),
            if (data != null && widget.onAnswer != null && widget.onOpenSession != null)
              ...mcWaitBanners(context, widget.feed, data,
                  onAnswer: widget.onAnswer!, onOpenSession: widget.onOpenSession!, now: widget.now),
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
            if (_error != null && data != null) McStaleBanner(message: _error!, at: data.generatedAt),
            if (data != null && data.servers.any((s) => !s.ok))
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                    'Not answering: ${data.servers.where((s) => !s.ok).map((s) => s.name).join(', ')} - their sessions are missing',
                    key: const ValueKey('mc-line-servers-down'),
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
            key: ValueKey(_unsupported ? 'mc-line-unsupported' : 'mc-line-error'),
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text(_error!, style: muted),
          ),
          if (!_unsupported)
            Center(child: TextButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('Try again'))),
        ];
      }
      return const [Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))];
    }
    final shown = [for (final s in data.subjects) if (s.inFilter(_filter, now: widget.now)) s];
    if (shown.isEmpty) {
      return [
        Padding(
          key: const ValueKey('mc-line-empty'),
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

/// Opens the "Move to line" sheet for [subject]; true when it was moved.
Future<bool> showMoveToLineSheet(BuildContext context, {required McFeed feed, required McSubject subject}) async {
  final moved = await showAppBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: false,
    builder: (_) => McMoveToLineSheet(feed: feed, subject: subject),
  );
  return moved == true;
}

/// The configured lines and the current ones to pick from, a new name, and - when the
/// person moved it before - the way back to the rules.
class McMoveToLineSheet extends StatefulWidget {
  const McMoveToLineSheet({super.key, required this.feed, required this.subject});
  final McFeed feed;
  final McSubject subject;

  @override
  State<McMoveToLineSheet> createState() => _McMoveToLineSheetState();
}

class _McMoveToLineSheetState extends State<McMoveToLineSheet> {
  final _name = TextEditingController();
  McLines? _lines;
  String? _loadError;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name.addListener(() => setState(() {}));
    unawaited(_load());
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await widget.feed.lines();
      if (mounted) setState(() => _lines = r);
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
    } catch (e) {
      if (mounted) setState(() => _loadError = '$e');
    }
  }

  /// Sends one move: [line] an id, [name] a new line, neither = back to the rules.
  Future<void> _move({String? line, String? name}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.feed.moveLine(widget.subject.key, line: line, name: name);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _newName => _name.text.trim();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final current = widget.subject.line;
    final choices = _lines?.choices ?? const <(String, String, String?)>[];
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ListView(
        key: const ValueKey('mc-move-sheet'),
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          Text('Move to line', style: theme.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(widget.subject.refLabel, style: muted),
          const SizedBox(height: 8),
          if (current != null && current.moved)
            ListTile(
              key: const ValueKey('mc-move-auto'),
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.auto_fix_high_outlined),
              title: const Text('Back to automatic'),
              subtitle: const Text('Let the rules choose the line again'),
              enabled: !_busy,
              onTap: () => _move(),
            ),
          if (_loadError != null)
            Text('Could not read the lines: $_loadError', style: muted)
          else if (_lines == null)
            const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator())
          else if (choices.isEmpty)
            Text('No line to pick yet: name a new one below.', key: const ValueKey('mc-move-none'), style: muted),
          for (final (id, name, project) in choices)
            ListTile(
              key: ValueKey('mc-move-line-$id'),
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Icon(id == current?.id ? Icons.radio_button_checked : Icons.radio_button_unchecked),
              title: Text(name),
              subtitle: project == null ? null : Text(project),
              enabled: !_busy && id != current?.id,
              onTap: () => _move(line: id),
            ),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('mc-move-new'),
            controller: _name,
            maxLength: kMcLineNameMax,
            maxLines: 1,
            decoration: const InputDecoration(labelText: 'New line...', hintText: 'A name for a new line'),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(_error!, key: const ValueKey('mc-move-error'), style: TextStyle(color: theme.colorScheme.error)),
            ),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              key: const ValueKey('mc-move-new-go'),
              onPressed: _busy || _newName.isEmpty ? null : () => _move(name: _newName),
              child: const Text('Move to the new line'),
            ),
          ),
        ],
      ),
    );
  }
}
