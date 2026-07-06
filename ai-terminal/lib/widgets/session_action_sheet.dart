/// Shared "Rename / Kill / Notify level" bottom sheet, opened from a
/// long-pressed session card on the dashboard and from the session screen's
/// app bar menu. One home for this logic keeps both call sites in sync.
library;

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../theme/app_theme.dart';

/// Opens the actions sheet for [session]. Calls [onChanged] after any action
/// that mutated server state, so the caller can trigger a repository refresh.
/// [onForked], when given, is called with the newly created fork session
/// after a successful "Fork session" action (only offered when
/// [Session.claudeSessionId] is non-null) — the caller owns navigating to it.
Future<void> showSessionActionsSheet(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ValueChanged<Session>? onForked,
}) {
  final api = ApiClient(session.server);
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    // Let the sheet grow past the default ~half-height and, on a short window,
    // scroll its own content rather than clipping the lower rows (issue #13).
    isScrollControlled: true,
    builder: (context) => _SessionActionsSheet(
      session: session,
      api: api,
      onChanged: onChanged,
      onForked: onForked,
    ),
  );
}

/// Opens a compact notify-level picker — just the three push levels, no
/// rename/kill/fork — mirroring the web's per-card bell menu
/// (`showNotifyLevelMenu`). The full picker (with those other actions) is
/// [showSessionActionsSheet].
Future<void> showNotifyLevelPicker(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
}) {
  final api = ApiClient(session.server);
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _ScrollableSheet(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.screenPadding,
            ),
            child: Text(
              'Notify me on this session',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          const SizedBox(height: 8),
          _NotifyLevelRadios(
            groupValue: session.notifyLevel,
            onSelected: (level) async {
              try {
                await api.setNotifyLevel(session.id, level);
                onChanged();
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text('Failed: $e')));
                }
              }
              if (context.mounted) Navigator.pop(context);
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}

/// Wraps a bottom-sheet body so it never overflows a short viewport: caps the
/// height at 85% of the screen and scrolls its content past that, keeping the
/// bottom rows (e.g. the Notify Level radios) reachable (issue #13). Used with
/// `isScrollControlled: true` on the `showModalBottomSheet` call.
class _ScrollableSheet extends StatelessWidget {
  const _ScrollableSheet({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
        child: SingleChildScrollView(child: child),
      ),
    );
  }
}

/// Builds the auto-command for forking a Claude session — exactly the web's
/// fork logic (`claude --resume <id> --fork-session`, carrying over
/// `--dangerously-skip-permissions` if the source session used it). Pulled
/// out as a pure function so it's testable without a widget pump.
String buildForkAutoCommand(Session session) {
  final claudeId = session.claudeSessionId;
  assert(claudeId != null, 'buildForkAutoCommand requires a Claude session');
  final skipPermissions = session.autoCommand.contains(
    '--dangerously-skip-permissions',
  );
  return 'claude --resume $claudeId --fork-session'
      '${skipPermissions ? ' --dangerously-skip-permissions' : ''}';
}

class _SessionActionsSheet extends StatelessWidget {
  const _SessionActionsSheet({
    required this.session,
    required this.api,
    required this.onChanged,
    this.onForked,
  });

  final Session session;
  final ApiClient api;
  final VoidCallback onChanged;
  final ValueChanged<Session>? onForked;

  Future<void> _run(
    BuildContext context,
    Future<void> Function() action,
  ) async {
    try {
      await action();
      onChanged();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _rename(BuildContext context) async {
    final controller = TextEditingController(text: session.name);
    final newName = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename session'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
    if (newName == null || newName.isEmpty || !context.mounted) return;
    await _run(context, () => api.renameSession(session.id, newName));
    if (context.mounted) Navigator.pop(context);
  }

  Future<void> _kill(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Kill session?'),
        content: const Text('This cannot be undone.'),
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
            child: const Text('Kill'),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    await _run(context, () => api.killSession(session.id));
    if (context.mounted) Navigator.pop(context);
  }

  Future<void> _setNotifyLevel(BuildContext context, String level) async {
    await _run(context, () => api.setNotifyLevel(session.id, level));
    if (context.mounted) Navigator.pop(context);
  }

  Future<void> _fork(BuildContext context) async {
    try {
      final forked = await api.createSession(
        name: '${session.name} (fork)',
        cwd: session.cwd,
        autoCommand: buildForkAutoCommand(session),
      );
      onChanged();
      if (context.mounted) Navigator.pop(context);
      onForked?.call(forked);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Fork failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return _ScrollableSheet(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.screenPadding,
            ),
            child: Text(
              session.name.isEmpty
                  ? 'Session ${session.shortId}'
                  : session.name,
              style: Theme.of(context).textTheme.titleMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(height: 8),
          ListTile(
            leading: const Icon(Icons.edit_outlined),
            title: const Text('Rename'),
            onTap: () => _rename(context),
          ),
          if (session.claudeSessionId != null)
            ListTile(
              leading: const Icon(Icons.call_split),
              title: const Text('Fork session'),
              onTap: () => _fork(context),
            ),
          ListTile(
            leading: Icon(
              Icons.delete_outline,
              color: Theme.of(context).colorScheme.error,
            ),
            title: const Text('Kill session'),
            onTap: () => _kill(context),
          ),
          const Divider(),
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.screenPadding,
            ),
            child: Text(
              'NOTIFY LEVEL',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                letterSpacing: 0.08,
              ),
            ),
          ),
          _NotifyLevelRadios(
            groupValue: session.notifyLevel,
            onSelected: (level) => _setNotifyLevel(context, level),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// The three notify-level radio rows, shared by the full actions sheet and
/// the compact per-card bell picker so both stay in sync.
class _NotifyLevelRadios extends StatelessWidget {
  const _NotifyLevelRadios({required this.groupValue, required this.onSelected});

  final String groupValue;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    return RadioGroup<String>(
      groupValue: groupValue,
      onChanged: (v) => onSelected(v!),
      child: const Column(
        children: [
          RadioListTile<String>(
            value: 'off',
            title: Text('Off'),
            subtitle: Text('No phone notifications'),
          ),
          RadioListTile<String>(
            value: 'important',
            title: Text('Important'),
            subtitle: Text('Approval + stuck API errors'),
          ),
          RadioListTile<String>(
            value: 'all',
            title: Text('All'),
            subtitle: Text('+ finished / waiting for input'),
          ),
        ],
      ),
    );
  }
}
