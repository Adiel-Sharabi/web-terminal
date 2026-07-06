/// Settings screen — global app preferences plus the configured web-terminal
/// servers.
///
/// Reachable from a gear icon in the dashboard app bar. Two sections:
///
/// * **Terminal text size** — a global font-size slider (owner: "still need
///   an option to change font size"). This is the discoverable home for the
///   control; it reads/writes the same `wt.termFontSize` SharedPreferences key
///   as the session screen's "Terminal text size" menu item
///   (`session_screen.dart`'s `_showFontSizeDialog`), so a value set in either
///   place stays in sync. A change here applies to sessions opened
///   afterward — an already-open session keeps whatever size it loaded with.
/// * **Servers** — (owner: "there is no server selection" — this is how he
///   adds his real servers once more than the single spike-config one
///   exist). Backed by [ServerStore]: lists every configured server, and
///   opens an editor sheet to add/edit one (name + base URL + bearer token)
///   with a "Test" button that probes the server (`GET /api/version`) and
///   shows its resolved name/version or the failure reason before saving.
///
/// [store] and [probe] are injectable for tests (mirrors the new-session
/// sheet's `clientBuilder`); production callers use the defaults, which bind
/// to the real [ServerStore] singleton.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/server_store.dart';
import '../theme/app_theme.dart';

/// The SharedPreferences key holding the global terminal font size, shared
/// with `session_screen.dart`'s font-size dialog.
const String kTermFontSizeKey = 'wt.termFontSize';

/// Probes a candidate [ServerConfig] and returns its [ServerInfo], or throws.
typedef ProbeFn = Future<ServerInfo> Function(ServerConfig config);

class SettingsScreen extends StatelessWidget {
  SettingsScreen({super.key, ServerStore? store, ProbeFn? probe})
    : _store = store ?? ServerStore.instance,
      _probe = probe ?? (store ?? ServerStore.instance).probe;

  final ServerStore _store;
  final ProbeFn _probe;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: Column(
        children: [
          const _FontSizeSection(),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.screenPadding,
              16,
              AppSpacing.screenPadding,
              4,
            ),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'SERVERS',
                style: theme.textTheme.labelSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.08,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
          Expanded(
            child: StreamBuilder<List<ServerConfig>>(
              stream: _store.changes,
              initialData: _store.servers,
              builder: (context, snapshot) {
                final servers = snapshot.data ?? const <ServerConfig>[];
                if (servers.isEmpty) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.screenPadding),
                      child: Text(
                        'No servers configured yet.\nTap + to add your first server.',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ),
                  );
                }
                return ListView.separated(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: servers.length,
                  separatorBuilder: (context, _) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final server = servers[i];
                    return ListTile(
                      title: Text(
                        server.name.isEmpty ? server.baseUrl : server.name,
                      ),
                      subtitle: Text(
                        server.baseUrl,
                        style: const TextStyle(fontFamily: 'monospace'),
                      ),
                      onTap: () =>
                          _openEditor(context, index: i, existing: server),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline),
                        tooltip: 'Remove server',
                        onPressed: () => _confirmRemove(context, i, server),
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _openEditor(context),
        tooltip: 'Add server',
        child: const Icon(Icons.add),
      ),
    );
  }

  Future<void> _confirmRemove(
    BuildContext context,
    int index,
    ServerConfig server,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove server?'),
        content: Text(
          'Remove "${server.name.isEmpty ? server.baseUrl : server.name}"? '
          'Its sessions will no longer appear here.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await _store.removeAt(index);
    }
  }

  Future<void> _openEditor(
    BuildContext context, {
    int? index,
    ServerConfig? existing,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _ServerEditorSheet(
        store: _store,
        probe: _probe,
        index: index,
        existing: existing,
      ),
    );
  }
}

/// Add/edit form for one server: name, base URL, bearer token, plus a "Test"
/// button that probes the in-progress field values before saving.
class _ServerEditorSheet extends StatefulWidget {
  const _ServerEditorSheet({
    required this.store,
    required this.probe,
    this.index,
    this.existing,
  });

  final ServerStore store;
  final ProbeFn probe;

  /// The server's index in `store.servers`, or `null` when adding a new one.
  final int? index;

  /// The server being edited, or `null` when adding a new one.
  final ServerConfig? existing;

  @override
  State<_ServerEditorSheet> createState() => _ServerEditorSheetState();
}

class _ServerEditorSheetState extends State<_ServerEditorSheet> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _baseUrl = TextEditingController(
    text: widget.existing?.baseUrl ?? '',
  );
  late final _bearerToken = TextEditingController(
    text: widget.existing?.bearerToken ?? '',
  );

  bool _testing = false;
  bool _saving = false;
  String? _testResult;
  bool _testOk = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _baseUrl.dispose();
    _bearerToken.dispose();
    super.dispose();
  }

  ServerConfig _draft() => ServerConfig(
    name: _name.text.trim(),
    baseUrl: _baseUrl.text.trim(),
    bearerToken: _bearerToken.text.trim(),
  );

  Future<void> _test() async {
    final draft = _draft();
    if (draft.baseUrl.isEmpty) {
      setState(() {
        _testResult = null;
        _error = 'Enter a base URL first';
      });
      return;
    }
    setState(() {
      _testing = true;
      _testResult = null;
      _error = null;
    });
    try {
      final info = await widget.probe(draft);
      if (!mounted) return;
      final name = info.serverName.isEmpty ? 'Reachable' : info.serverName;
      final version = info.version.isEmpty ? '?' : info.version;
      setState(() {
        _testOk = true;
        _testResult = '$name (v$version)';
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _testOk = false;
          _testResult = e.message;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _testOk = false;
          _testResult = 'Could not reach server: $e';
        });
      }
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _save() async {
    final draft = _draft();
    if (draft.baseUrl.isEmpty) {
      setState(() => _error = 'Base URL is required');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (widget.index != null) {
        await widget.store.update(widget.index!, draft);
      } else {
        await widget.store.add(draft);
      }
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not save: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isEditing = widget.index != null;

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.screenPadding,
        right: AppSpacing.screenPadding,
        top: 4,
        bottom:
            MediaQuery.of(context).viewInsets.bottom + AppSpacing.screenPadding,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              isEditing ? 'Edit server' : 'Add server',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Name'),
              textInputAction: TextInputAction.next,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _baseUrl,
              decoration: const InputDecoration(
                labelText: 'Base URL',
                hintText: 'http://100.x.x.x:7681',
              ),
              keyboardType: TextInputType.url,
              autocorrect: false,
              textInputAction: TextInputAction.next,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _bearerToken,
              decoration: const InputDecoration(labelText: 'Bearer token'),
              autocorrect: false,
              obscureText: true,
              textInputAction: TextInputAction.done,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                OutlinedButton(
                  onPressed: _testing ? null : _test,
                  child: _testing
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Test'),
                ),
                const SizedBox(width: 12),
                if (_testResult != null)
                  Expanded(
                    child: Text(
                      _testResult!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: _testOk
                            ? theme.colorScheme.primary
                            : theme.colorScheme.error,
                      ),
                    ),
                  ),
              ],
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
                    onPressed: _saving ? null : _save,
                    child: _saving
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Save'),
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

/// Global "Terminal text size" control (owner: "still need an option to
/// change font size"). Reads/writes [kTermFontSizeKey] directly — the same
/// key the session screen's font-size dialog uses — so this is just another
/// place to reach the one persisted value, not a second source of truth.
class _FontSizeSection extends StatefulWidget {
  const _FontSizeSection();

  @override
  State<_FontSizeSection> createState() => _FontSizeSectionState();
}

class _FontSizeSectionState extends State<_FontSizeSection> {
  static const double _defaultSize = 10;

  double _size = _defaultSize;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getDouble(kTermFontSizeKey);
    if (mounted && stored != null && stored >= 6 && stored <= 24) {
      setState(() => _size = stored);
    }
  }

  void _onChanged(double value) {
    setState(() => _size = value);
    unawaited(_persist(value));
  }

  Future<void> _persist(double value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(kTermFontSizeKey, value);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.screenPadding,
        16,
        AppSpacing.screenPadding,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Terminal text size', style: theme.textTheme.titleMedium),
              const Spacer(),
              Text(
                '${_size.round()} pt',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          Slider(
            min: 6,
            max: 24,
            divisions: 18,
            value: _size,
            label: '${_size.round()}',
            onChanged: _onChanged,
          ),
          Text(
            'Smaller fits more columns — less line wrapping.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
