/// New-session bottom sheet — mirrors the web app's inline "New session"
/// form (`#newSessionForm` in app.html): a server picker, name, working
/// directory (with live folder autocomplete) and an optional auto-command,
/// prefilled from the target server's own defaults.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/agent_catalog.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';

/// Opens the new-session sheet for [initialServer] (pre-selected; usually the
/// server of the currently-viewed context, falling back to the first
/// configured server). On successful creation, refreshes
/// [SessionRepository] and calls [onCreated] with the new (partially
/// populated — the create endpoint only returns `{id, name}`) [Session].
///
/// [clientBuilder] is injectable for tests; production callers use the
/// default, which just wraps the server in a real [ApiClient].
Future<void> showNewSessionSheet(
  BuildContext context, {
  required List<ServerConfig> servers,
  required ServerConfig initialServer,
  required ValueChanged<Session> onCreated,
  ApiClient Function(ServerConfig server)? clientBuilder,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _NewSessionSheet(
      servers: servers,
      initialServer: initialServer,
      onCreated: onCreated,
      clientBuilder: clientBuilder ?? ApiClient.new,
    ),
  );
}

/// Case-insensitive substring filter over the live folder list — matches the
/// web's `showFolders`: an empty [query] shows every folder.
List<String> filterFolders(List<String> folders, String query) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) return folders;
  return folders
      .where((f) => f.toLowerCase().contains(needle))
      .toList(growable: false);
}

/// The default folder as it is PRE-FILLED, with a trailing separator so a
/// subfolder can be typed straight onto the end (`C:\dev\` + `myproj`) instead of
/// the user having to type the separator every time.
///
/// Display only. The server canonicalises the cwd on create (`lib/cwd.js`), which
/// is what stops the trailing separator reaching `claudeProjectDirName` — it gives
/// every non-alphanumeric char its own dash, so a trailing one names a project
/// directory Claude never created and the Chat lens silently finds nothing.
///
/// The separator matches the path's own style rather than the host's: this field
/// may be showing the default cwd of a REMOTE cluster server. Pure/testable.
String cwdWithTrailingSep(String cwd) {
  if (cwd.isEmpty) return cwd;
  if (cwd.endsWith('\\') || cwd.endsWith('/')) return cwd;
  return cwd + (cwd.contains('\\') ? '\\' : '/');
}

/// Next highlight index after moving [delta] (+1 down / -1 up) through [count]
/// folder-suggestion rows, from [current] (-1 = nothing highlighted). Entering
/// an unhighlighted list highlights the first row going down / the last going
/// up, and it wraps around at both ends — parity with the web `folderKeydown`
/// (issue #48). Pure/testable.
int nextFolderHighlight(int current, int delta, int count) {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return ((current + delta) % count + count) % count;
}

/// Arrow ↑/↓ through the open folder-suggestion list (issue #48).
class _FolderMoveIntent extends Intent {
  const _FolderMoveIntent(this.delta);
  final int delta;
}

/// Escape closes the folder-suggestion list (web `folderKeydown` parity).
class _FolderDismissIntent extends Intent {
  const _FolderDismissIntent();
}

/// Arrow/Escape are only intercepted while the suggestion list is open and
/// non-empty; otherwise the Action is disabled so the key keeps its default
/// behavior (caret nav in the field / dismissing the sheet on Escape).
class _FolderMoveAction extends Action<_FolderMoveIntent> {
  _FolderMoveAction(this.state);
  final _NewSessionSheetState state;

  @override
  bool isEnabled(_FolderMoveIntent intent) => state._suggestionsVisible;

  @override
  Object? invoke(_FolderMoveIntent intent) {
    state._moveHighlight(intent.delta);
    return null;
  }
}

class _FolderDismissAction extends Action<_FolderDismissIntent> {
  _FolderDismissAction(this.state);
  final _NewSessionSheetState state;

  @override
  bool isEnabled(_FolderDismissIntent intent) => state._suggestionsVisible;

  @override
  Object? invoke(_FolderDismissIntent intent) {
    state._dismissSuggestions();
    return null;
  }
}

class _NewSessionSheet extends StatefulWidget {
  const _NewSessionSheet({
    required this.servers,
    required this.initialServer,
    required this.onCreated,
    required this.clientBuilder,
  });

  final List<ServerConfig> servers;
  final ServerConfig initialServer;
  final ValueChanged<Session> onCreated;
  final ApiClient Function(ServerConfig server) clientBuilder;

  @override
  State<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<_NewSessionSheet> {
  late ServerConfig _server = widget.initialServer;
  final _name = TextEditingController();
  final _cwd = TextEditingController();
  final _command = TextEditingController();
  final _cwdFocus = FocusNode();

  // Only overwritten by the server-default prefill while the user hasn't
  // typed their own value — mirrors the web form re-populating on server
  // switch without clobbering a manual edit.
  bool _cwdEdited = false;
  bool _commandEdited = false;
  bool _settingProgrammatically = false;

  List<String> _folders = const [];
  bool _showSuggestions = false;
  bool _creating = false;
  String? _error;

  // Keyboard-highlighted row in the folder suggestion list (issue #48). -1 =
  // nothing highlighted, so Enter submits the typed path (existing #18
  // behavior); ArrowDown enters the list at the first row. Reset to -1 whenever
  // the filtered list can change (typing, server switch), so it never points at
  // a stale row.
  int _highlight = -1;
  final _suggestScroll = ScrollController();
  static const double _kSuggestRowExtent = 34;

  // The AI agent picker. `null` is "Auto (detect from command)" — the same
  // default behavior as omitting the field entirely. Agent choices are
  // per-server, so a server switch resets this back to Auto.
  List<AgentInfo> _agents = const [];
  String? _agent;

  @override
  void initState() {
    super.initState();
    _cwd.addListener(() {
      if (_settingProgrammatically) return;
      _cwdEdited = true;
    });
    _command.addListener(() {
      if (_settingProgrammatically) return;
      _commandEdited = true;
    });
    _cwdFocus.addListener(() {
      if (mounted) setState(() => _showSuggestions = _cwdFocus.hasFocus);
    });
    _loadForServer(_server);
  }

  @override
  void dispose() {
    _name.dispose();
    _cwd.dispose();
    _command.dispose();
    _cwdFocus.dispose();
    _suggestScroll.dispose();
    super.dispose();
  }

  Future<void> _loadForServer(ServerConfig server) async {
    final api = widget.clientBuilder(server);
    try {
      final config = await api.serverConfig();
      if (!mounted || _server != server) return;
      _settingProgrammatically = true;
      if (!_cwdEdited && config.defaultCwd.isNotEmpty) {
        _cwd.text = cwdWithTrailingSep(config.defaultCwd);
      }
      if (!_commandEdited && config.defaultCommand.isNotEmpty) {
        _command.text = config.defaultCommand;
      }
      _settingProgrammatically = false;
    } catch (_) {
      // best effort — leave fields as-is, matching the web's silent failure.
    }
    try {
      final folders = await api.folders();
      if (!mounted || _server != server) return;
      setState(() => _folders = folders);
    } catch (_) {
      if (mounted) setState(() => _folders = const []);
    }
    // ApiClient.agents() never throws (failures yield an empty list), so an
    // unreachable server or an older build without the endpoint just leaves
    // the picker showing "Auto" only — it never blocks session creation.
    final agents = await api.agents();
    // Feed the shared catalogue too, so the session-list chips learn any provider
    // this fetch just discovered without a second round-trip.
    for (final a in agents) {
      AgentCatalog.instance.adopt(a);
    }
    if (!mounted || _server != server) return;
    setState(() => _agents = agents);
  }

  void _onServerChanged(ServerConfig? value) {
    if (value == null || value == _server) return;
    setState(() {
      _server = value;
      // Agent choices are per-server; reset to Auto rather than carry a
      // selection that may not exist on the new server.
      _agent = null;
      // The folder list is about to be replaced; drop any stale highlight.
      _highlight = -1;
    });
    _loadForServer(value);
  }

  void _pickFolder(String folder) {
    _settingProgrammatically = true;
    _cwd.value = TextEditingValue(
      text: folder,
      selection: TextSelection.collapsed(offset: folder.length),
    );
    _settingProgrammatically = false;
    _cwdEdited = true;
    _cwdFocus.unfocus();
    setState(() {
      _showSuggestions = false;
      _highlight = -1;
    });
  }

  /// The folder suggestion list is showing at least one row — the only state in
  /// which the arrow-nav / Escape shortcuts are active (issue #48).
  bool get _suggestionsVisible =>
      _showSuggestions && filterFolders(_folders, _cwd.text).isNotEmpty;

  /// Move the keyboard highlight through the suggestion list (issue #48),
  /// keeping the highlighted row scrolled into view.
  void _moveHighlight(int delta) {
    final n = filterFolders(_folders, _cwd.text).length;
    if (n == 0) return;
    setState(() => _highlight = nextFolderHighlight(_highlight, delta, n));
    _scrollHighlightIntoView();
  }

  void _dismissSuggestions() {
    setState(() {
      _showSuggestions = false;
      _highlight = -1;
    });
  }

  /// Keeps the highlighted row visible in the fixed-extent suggestion list.
  void _scrollHighlightIntoView() {
    if (_highlight < 0 || !_suggestScroll.hasClients) return;
    final pos = _suggestScroll.position;
    final rowTop = _highlight * _kSuggestRowExtent;
    final rowBottom = rowTop + _kSuggestRowExtent;
    double? to;
    if (rowTop < pos.pixels) {
      to = rowTop;
    } else if (rowBottom > pos.pixels + pos.viewportDimension) {
      to = rowBottom - pos.viewportDimension;
    }
    if (to != null) {
      _suggestScroll.jumpTo(
        to.clamp(pos.minScrollExtent, pos.maxScrollExtent),
      );
    }
  }

  Future<void> _submit() async {
    if (_creating) return;
    setState(() {
      _creating = true;
      _error = null;
    });
    final api = widget.clientBuilder(_server);
    try {
      final name = _name.text.trim();
      final cwd = _cwd.text.trim();
      final command = _command.text.trim();
      final created = await api.createSession(
        name: name.isEmpty ? null : name,
        cwd: cwd.isEmpty ? null : cwd,
        autoCommand: command.isEmpty ? null : command,
        agent: _agent,
      );
      await SessionRepository.instance.refresh();
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onCreated(created);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not create session: $e');
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final suggestions = filterFolders(_folders, _cwd.text);

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.screenPadding,
        right: AppSpacing.screenPadding,
        top: 4,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.screenPadding,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('New session', style: theme.textTheme.titleMedium),
            const SizedBox(height: 16),
            // Always shown — even with a single configured server — so the
            // server this session will run on is never a mystery (owner:
            // "there is no server selection"). Settings is where more
            // servers get added; this dropdown is how one is picked per
            // session.
            if (widget.servers.isNotEmpty) ...[
              DropdownButtonFormField<ServerConfig>(
                initialValue: _server,
                decoration: const InputDecoration(labelText: 'Server'),
                items: widget.servers
                    .map((s) => DropdownMenuItem(value: s, child: Text(s.name)))
                    .toList(growable: false),
                onChanged: _onServerChanged,
              ),
              const SizedBox(height: 12),
            ],
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Name (optional)'),
              textInputAction: TextInputAction.next,
            ),
            const SizedBox(height: 12),
            // Shortcuts intercept ↑/↓/Escape for folder-list navigation (issue
            // #48) only while the list is open (the Actions are disabled
            // otherwise, so the keys keep their default field/sheet behavior).
            Shortcuts(
              shortcuts: const <ShortcutActivator, Intent>{
                SingleActivator(LogicalKeyboardKey.arrowDown):
                    _FolderMoveIntent(1),
                SingleActivator(LogicalKeyboardKey.arrowUp):
                    _FolderMoveIntent(-1),
                SingleActivator(LogicalKeyboardKey.escape):
                    _FolderDismissIntent(),
              },
              child: Actions(
                actions: <Type, Action<Intent>>{
                  _FolderMoveIntent: _FolderMoveAction(this),
                  _FolderDismissIntent: _FolderDismissAction(this),
                },
                child: TextField(
                  controller: _cwd,
                  focusNode: _cwdFocus,
                  decoration:
                      const InputDecoration(labelText: 'Working directory'),
                  autocorrect: false,
                  // Enter from the working-dir field creates the session (issue
                  // #18: "Enter doesn't create"), OR — when a folder row is
                  // arrow-highlighted (#48) — starts the session in that folder.
                  textInputAction: TextInputAction.done,
                  // A new filter can shift/empty the list, so drop the highlight.
                  onChanged: (_) => setState(() => _highlight = -1),
                  onSubmitted: (_) {
                    final suggestions = filterFolders(_folders, _cwd.text);
                    if (_showSuggestions &&
                        _highlight >= 0 &&
                        _highlight < suggestions.length) {
                      _pickFolder(suggestions[_highlight]);
                    }
                    _submit();
                  },
                ),
              ),
            ),
            if (_showSuggestions && suggestions.isNotEmpty)
              // TextFieldTapRegion keeps the working-dir field focused when a
              // suggestion is clicked. Without it, a mouse click lands OUTSIDE
              // the field, blurs it, flips `_showSuggestions` false and tears
              // down this list before the InkWell's onTap can fire — so folders
              // were unselectable by mouse (issue #18). `_pickFolder` still
              // unfocuses deliberately afterwards to dismiss the list.
              TextFieldTapRegion(
                child: Container(
                  margin: const EdgeInsets.only(top: 4),
                  constraints: const BoxConstraints(maxHeight: 160),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(AppShape.small),
                    border: Border.all(color: theme.colorScheme.outlineVariant),
                  ),
                  child: ListView.builder(
                    controller: _suggestScroll,
                    shrinkWrap: true,
                    padding: EdgeInsets.zero,
                    itemExtent: _kSuggestRowExtent,
                    itemCount: suggestions.length,
                    itemBuilder: (context, i) {
                      final folder = suggestions[i];
                      final active = i == _highlight;
                      return InkWell(
                        onTap: () => _pickFolder(folder),
                        child: Container(
                          color:
                              active ? theme.colorScheme.primaryContainer : null,
                          alignment: Alignment.centerLeft,
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text(
                            folder,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              fontFamily: 'monospace',
                              color: active
                                  ? theme.colorScheme.onPrimaryContainer
                                  : null,
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
            const SizedBox(height: 12),
            TextField(
              controller: _command,
              decoration: const InputDecoration(labelText: 'Command (optional)'),
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 12),
            // Auto is always first and always available, even when
            // GET /api/agents failed or returned nothing — a picker with only
            // "Auto" never blocks session creation.
            DropdownButtonFormField<String?>(
              initialValue: _agent,
              decoration: const InputDecoration(labelText: 'AI agent'),
              items: [
                const DropdownMenuItem<String?>(
                  value: null,
                  child: Text('Auto (detect from command)'),
                ),
                for (final a in _agents)
                  DropdownMenuItem<String?>(value: a.id, child: Text(a.label)),
              ],
              onChanged: (value) => setState(() => _agent = value),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            ],
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _creating ? null : _submit,
                    child: _creating
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Create'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
