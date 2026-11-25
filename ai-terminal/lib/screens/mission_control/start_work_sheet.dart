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

  /// #533 - the kinds of work and models the authority offers; null = no picker (the authority is
  /// older than the picker, or it could not be read: starting work never waits on it).
  McStartModels? _models;
  bool _modelsLoading = true;
  String? _kind;
  String? _model;

  /// Whether the person chose the kind / the model themselves: a later change of mode or kind
  /// then no longer overwrites their choice with the suggestion.
  bool _kindPicked = false;
  bool _modelPicked = false;

  /// #523 - the line to bind to: null none, [_newLine] a new name, else a line id.
  String? _line;
  static const String _newLine = '+new';
  final _lineName = TextEditingController();
  List<(String, String, String?)> _lineChoices = const [];
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
    _lineName.addListener(() => setState(() {}));
    _loadSubjects();
    _loadLines();
    _loadMachines();
    _loadModels();
  }

  @override
  void dispose() {
    _refs.dispose();
    _brief.dispose();
    _lineName.dispose();
    super.dispose();
  }

  int _linesSeq = 0;

  /// The lines of the chosen project to pick from. A server without lines (404) or any
  /// failure leaves the picker out: starting work never waits on it.
  Future<void> _loadLines() async {
    final p = _project;
    final seq = ++_linesSeq;
    setState(() {
      _lineChoices = const [];
      _line = null;
      _lineName.clear();
    });
    if (p == null) return;
    try {
      final r = await widget.feed.lines(project: p);
      if (!mounted || seq != _linesSeq) return;
      setState(() => _lineChoices = [
            for (final c in r.choices)
              if (_inProject(r, c.$1, p)) c
          ]);
    } catch (_) {
      // No picker: the session starts on the rules' line.
    }
  }

  /// Whether line [id] belongs to project [p] (the server filters by project; this only
  /// keeps a line of another project out of the picker should it send one).
  static bool _inProject(McLines r, String id, String p) {
    for (final c in r.configured) {
      if (c.id == id) return c.project == null || c.project == p;
    }
    for (final l in r.lines) {
      if (l.id == id) return l.project == null || l.project == p;
    }
    return true;
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

  /// The picker's data. A 404 (an authority without the picker) or any failure leaves the picker
  /// out and the start without a `kind` / `model`, so the session starts as it always did.
  Future<void> _loadModels() async {
    McStartModels? m;
    try {
      m = await widget.feed.models();
    } catch (_) {
      m = null;
    }
    if (!mounted) return;
    setState(() {
      _models = m;
      _modelsLoading = false;
      if (m != null) {
        _kind = m.kindFor(hunt: _hunt);
        _model = m.suggestedModel(_kind!);
      }
    });
  }

  /// Work items <-> hunt: the kind follows the mode (a hunt is open-ended, so it begins on the
  /// stronger model) unless the person picked a kind; the model follows the kind unless picked.
  void _setMode(bool hunt) {
    final m = _models;
    setState(() {
      _hunt = hunt;
      if (m != null && !_kindPicked) _kind = m.kindFor(hunt: hunt);
      if (m != null && !_modelPicked) _model = m.suggestedModel(_kind!);
    });
  }

  void _setKind(String? id) {
    final m = _models;
    if (m == null || id == null) return;
    setState(() {
      _kind = id;
      _kindPicked = true;
      if (!_modelPicked) _model = m.suggestedModel(id);
    });
  }

  List<String> get _chosen => [..._ticked, ...mcTypedRefs(_refs.text)];

  bool get _canStart =>
      !_busy && !_modelsLoading && _project != null && _server != null && (_hunt || _chosen.isNotEmpty);

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final brief = _brief.text.trim();
      final newName = _lineName.text.trim();
      final r = await widget.feed.start(
        line: _line != null && _line != _newLine ? _line : null,
        lineName: _line == _newLine && newName.isNotEmpty ? newName : null,
        project: _project!,
        subjects: _chosen,
        hunt: _hunt,
        server: _server!,
        brief: brief.isEmpty ? null : brief,
        // Only an authority that offered the picker is asked to place a model.
        kind: _models == null ? null : _kind,
        model: _models == null ? null : _model,
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

  /// #533 - the kind of work and the model it runs on. The kind suggests a model (marked in the
  /// list); the person may pick another, and that choice sticks across a change of kind.
  List<Widget> _modelPicker(McStartModels models, TextStyle? muted) {
    final kind = _kind!;
    final model = _model!;
    final suggested = models.suggestedModel(kind);
    return [
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(
        key: const ValueKey('mc-start-kind'),
        initialValue: kind,
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Kind of work'),
        items: [
          for (final k in models.kinds) DropdownMenuItem(value: k.id, child: Text(k.label, overflow: TextOverflow.ellipsis)),
        ],
        onChanged: _setKind,
      ),
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(
        key: const ValueKey('mc-start-model'),
        initialValue: model,
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Model'),
        items: [
          for (final c in models.models) _modelItem(models, c.id, suggested),
          if (!models.models.any((c) => c.id == model)) _modelItem(models, model, suggested),
        ],
        onChanged: (v) {
          if (v != null) {
            setState(() {
              _model = v;
              _modelPicked = true;
            });
          }
        },
      ),
      const SizedBox(height: 4),
      Text('The agent\'s brief says which model it runs on and why.', key: const ValueKey('mc-start-model-note'), style: muted),
    ];
  }

  DropdownMenuItem<String> _modelItem(McStartModels models, String id, String suggested) => DropdownMenuItem(
        value: id,
        child: Text('${models.labelOf(id)}${id == suggested ? ' (suggested)' : ''}', overflow: TextOverflow.ellipsis),
      );

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
                _loadLines();
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
            onSelectionChanged: (s) => _setMode(s.first),
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
          if (_lineChoices.isNotEmpty) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String?>(
              key: const ValueKey('mc-start-line'),
              initialValue: _line,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Line of work (optional)'),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('None - the rules choose')),
                for (final (id, name, project) in _lineChoices)
                  DropdownMenuItem<String?>(
                      value: id, child: Text(project == null ? name : '$name ($project)', overflow: TextOverflow.ellipsis)),
                const DropdownMenuItem<String?>(value: _newLine, child: Text('New line...')),
              ],
              onChanged: (v) => setState(() => _line = v),
            ),
            if (_line == _newLine)
              TextField(
                key: const ValueKey('mc-start-line-new'),
                controller: _lineName,
                maxLength: kMcLineNameMax,
                maxLines: 1,
                decoration: const InputDecoration(labelText: 'New line name'),
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
          if (_models != null) ..._modelPicker(_models!, muted),
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
