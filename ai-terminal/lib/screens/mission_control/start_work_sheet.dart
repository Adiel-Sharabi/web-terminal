// #512 - Mission Control's one "Start work" entry point.
//
// A sheet: the project -> its work items (the server's subjects, ticked, and any refs
// typed in), or a hunt with no list -> the machine (the server's suggestion, the least
// loaded healthy one, preselected) -> Start. The SERVER starts the session, names it,
// briefs its agent and binds it to the project and the work items at birth
// (`POST /api/mc/start`), so it is on its subject before it reports anything; this
// sheet only collects the choices and then opens the new session.

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_models.dart';
import '../../api/models.dart';
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import '../../widgets/app_bottom_sheet.dart';

/// Opens the Start work sheet; on a start, opens the new session with [onOpenSession]
/// (with the session object built from the answer, null when its server is not in this
/// app's list). [projectId] preselects a project (the Project screen passes its own).
Future<void> showStartWorkSheet(
  BuildContext context, {
  required McFeed feed,
  required void Function(String sessionId, Session? initial) onOpenSession,
  String? projectId,
}) async {
  final started = await showAppBottomSheet<McStartResult>(
    context: context,
    isScrollControlled: true,
    showDragHandle: false,
    builder: (_) => McStartWorkSheet(feed: feed, projectId: projectId),
  );
  if (started != null) onOpenSession(started.sessionId, feed.startedSession(started));
}

/// The refs typed into the free field: split on commas and blanks.
List<String> mcTypedRefs(String text) =>
    [for (final p in text.split(RegExp(r'[,\s]+'))) if (p.trim().isNotEmpty) p.trim()];

class McStartWorkSheet extends StatefulWidget {
  const McStartWorkSheet({super.key, required this.feed, this.projectId});
  final McFeed feed;
  final String? projectId;

  @override
  State<McStartWorkSheet> createState() => _McStartWorkSheetState();
}

class _McStartWorkSheetState extends State<McStartWorkSheet> {
  final _refs = TextEditingController();
  final _brief = TextEditingController();
  String? _project;
  bool _hunt = false;
  final Set<String> _ticked = {};
  List<McSubject>? _subjects;
  String? _subjectsError;
  McMachines? _machines;
  String? _machinesError;
  String? _server;
  bool _busy = false;
  String? _error;
  int _seq = 0;

  /// The configured projects a session can be started in (`other` has no folder).
  List<McProject> get _projects =>
      [for (final p in widget.feed.now?.projects ?? const <McProject>[]) if (p.id != 'other') p];

  @override
  void initState() {
    super.initState();
    final ps = _projects;
    _project = ps.any((p) => p.id == widget.projectId) ? widget.projectId : (ps.isEmpty ? null : ps.first.id);
    _refs.addListener(() => setState(() {}));
    _loadSubjects();
    _loadMachines();
  }

  @override
  void dispose() {
    _refs.dispose();
    _brief.dispose();
    super.dispose();
  }

  Future<void> _loadSubjects() async {
    final p = _project;
    final seq = ++_seq;
    setState(() {
      _subjects = null;
      _subjectsError = null;
      _ticked.clear();
    });
    if (p == null) return;
    try {
      final r = await widget.feed.subjects(project: p);
      if (!mounted || seq != _seq) return;
      // Only a tracker's work item can be started on: a subject of one session alone
      // (`<key>@<session id>`) names nothing the server could bind to.
      setState(() => _subjects = [
            for (final s in r.subjects)
              if (s.inFilter(McSubjectFilter.active) && !s.key.contains('@')) s
          ]);
    } on ApiException catch (e) {
      if (mounted && seq == _seq) setState(() => _subjectsError = e.message);
    } catch (e) {
      if (mounted && seq == _seq) setState(() => _subjectsError = '$e');
    }
  }

  Future<void> _loadMachines() async {
    try {
      final m = await widget.feed.machines();
      if (!mounted) return;
      setState(() {
        _machines = m;
        _server ??= m.suggested;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _machinesError = e.message);
    } catch (e) {
      if (mounted) setState(() => _machinesError = '$e');
    }
  }

  List<String> get _chosen => [..._ticked, ...mcTypedRefs(_refs.text)];

  bool get _canStart => !_busy && _project != null && _server != null && (_hunt || _chosen.isNotEmpty);

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final brief = _brief.text.trim();
      final r = await widget.feed.start(
        project: _project!,
        subjects: _chosen,
        hunt: _hunt,
        server: _server!,
        brief: brief.isEmpty ? null : brief,
      );
      if (mounted) Navigator.of(context).pop(r);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final projects = _projects;
    final machines = _machines?.machines ?? const <McMachine>[];
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ListView(
        key: const ValueKey('mc-start-sheet'),
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          Text('Start work', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          if (projects.isEmpty)
            Text('No project yet: add one under Projects in Settings, with the folder its sessions start in.',
                key: const ValueKey('mc-start-no-projects'), style: muted)
          else
            DropdownButtonFormField<String>(
              key: const ValueKey('mc-start-project'),
              initialValue: _project,
              decoration: const InputDecoration(labelText: 'Project'),
              items: [for (final p in projects) DropdownMenuItem(value: p.id, child: Text(p.name))],
              onChanged: (v) {
                setState(() => _project = v);
                _loadSubjects();
              },
            ),
          const SizedBox(height: 12),
          SegmentedButton<bool>(
            key: const ValueKey('mc-start-mode'),
            segments: const [
              ButtonSegment(value: false, label: Text('Work items'), icon: Icon(Icons.task_alt)),
              ButtonSegment(value: true, label: Text('Hunt'), icon: Icon(Icons.bug_report_outlined)),
            ],
            selected: {_hunt},
            onSelectionChanged: (s) => setState(() => _hunt = s.first),
          ),
          const SizedBox(height: 8),
          if (_hunt)
            Text('A bug hunt in the project, with no list: what it finds becomes its own work items.', style: muted),
          if (!_hunt) ...[
            if (_subjectsError != null)
              Text('Could not read the work items: $_subjectsError', style: muted)
            else if (_subjects == null && _project != null)
              const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator())
            else
              for (final s in _subjects ?? const <McSubject>[])
                CheckboxListTile(
                  key: ValueKey('mc-start-subject-${s.key}'),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _ticked.contains(s.key),
                  title: Text('${s.ref ?? s.key}  ${s.title ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis),
                  onChanged: (on) => setState(() => on == true ? _ticked.add(s.key) : _ticked.remove(s.key)),
                ),
            TextField(
              key: const ValueKey('mc-start-refs'),
              controller: _refs,
              decoration: const InputDecoration(
                labelText: 'Other work items',
                hintText: '#123, owner/repo#123, ado:123',
              ),
            ),
          ],
          const SizedBox(height: 12),
          if (_machinesError != null)
            Text('Could not read the machines: $_machinesError', style: muted)
          else if (_machines == null)
            const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator())
          else
            DropdownButtonFormField<String>(
              key: const ValueKey('mc-start-machine'),
              initialValue: _server,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Machine'),
              items: [
                for (final m in machines)
                  DropdownMenuItem(
                    value: m.name,
                    enabled: m.ok,
                    child: Text(
                      '${m.name}${m.name == _machines?.suggested ? ' (suggested)' : ''} - ${m.line}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: m.ok ? null : muted,
                    ),
                  ),
              ],
              onChanged: (v) => setState(() => _server = v),
            ),
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('mc-start-brief'),
            controller: _brief,
            maxLength: 500,
            decoration: const InputDecoration(labelText: 'Brief for the agent (optional)'),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(_error!, key: const ValueKey('mc-start-error'), style: TextStyle(color: theme.colorScheme.error)),
            ),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton.icon(
              key: const ValueKey('mc-start-go'),
              onPressed: _canStart ? _start : null,
              icon: _busy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.play_arrow),
              label: const Text('Start'),
            ),
          ),
        ],
      ),
    );
  }
}
