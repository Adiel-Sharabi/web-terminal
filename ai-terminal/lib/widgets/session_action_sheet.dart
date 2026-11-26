/// Shared "Rename / Kill / Notify level" bottom sheet, opened from a
/// long-pressed or ⋮-tapped session card on the dashboard, and the ONE home of
/// the actions themselves: [confirmAndKillSession], [promptAndRenameSession] and
/// [clearSessionWait] are called by the sheet's rows AND by the session screen's
/// app bar menu, which goes straight to them (#424) instead of opening this sheet
/// to ask again which of them was meant.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../util/session_tree.dart';
import 'app_bottom_sheet.dart';

/// Opens the actions sheet for [session]. Calls [onChanged] after any action
/// that mutated server state, so the caller can trigger a repository refresh.
/// [onForked], when given, is called with the newly created fork session
/// after a successful "Fork session" action (only offered when
/// [Session.claudeSessionId] is non-null) — the caller owns navigating to it.
///
/// "Not waiting" (#327) is offered when [canClearWait] is true. It is REQUIRED, not
/// defaulted: every caller answers it with [SessionRepository.canClearWait] (the one
/// rule), and a silent default is what would let that wiring break with every test green.
/// [canMove] (#558) is required for the same reason, answered with
/// [SessionRepository.canMoveSession]: "Move under..." and "Hand sub-sessions to...".
Future<void> showSessionActionsSheet(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ValueChanged<Session>? onForked,
  required bool canClearWait,
  required bool canMove,
  ApiClient? api,
}) {
  final client = api ?? ApiClient(session.server);
  return showAppBottomSheet<void>(
    context: context,
    showDragHandle: true,
    // Let the sheet grow past the default ~half-height and, on a short window,
    // scroll its own content rather than clipping the lower rows (issue #13).
    isScrollControlled: true,
    builder: (context) => _SessionActionsSheet(
      session: session,
      api: client,
      onChanged: onChanged,
      onForked: onForked,
      canClearWait: canClearWait,
      canMove: canMove,
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
  return showAppBottomSheet<void>(
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
              await _runSessionAction(
                context,
                onChanged,
                () => api.setNotifyLevel(session.id, level),
              );
              if (context.mounted) Navigator.pop(context);
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}

/// Runs one mutation of a session: [onChanged] after it, a "Failed" snackbar if it
/// threw. The one place that rule lives for every action in this file.
Future<void> _runSessionAction(
  BuildContext context,
  VoidCallback onChanged,
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

/// The keys that press the focused button on desktop (Flutter's default
/// `ActivateIntent` shortcuts), re-mapped for a dialog that must not be confirmed
/// by a key still held down from the pick that opened it (#424).
///
/// A held key reaches the dialog as REPEAT events, and the default shortcuts accept
/// those, so the autofocused Kill button would be pressed ~half a second after the
/// dialog appeared. Each key therefore activates only on a fresh key-down
/// (`includeRepeats: false`), and a repeat is consumed here
/// ([DoNothingAndStopPropagationIntent]) so the app-level default - which does accept
/// it - never sees it. Order matters: the first activator that accepts the event wins.
const Map<ShortcutActivator, Intent> _freshPressActivates =
    <ShortcutActivator, Intent>{
      SingleActivator(LogicalKeyboardKey.enter, includeRepeats: false):
          ActivateIntent(),
      SingleActivator(LogicalKeyboardKey.enter):
          DoNothingAndStopPropagationIntent(),
      SingleActivator(LogicalKeyboardKey.numpadEnter, includeRepeats: false):
          ActivateIntent(),
      SingleActivator(LogicalKeyboardKey.numpadEnter):
          DoNothingAndStopPropagationIntent(),
      SingleActivator(LogicalKeyboardKey.space, includeRepeats: false):
          ActivateIntent(),
      SingleActivator(LogicalKeyboardKey.space):
          DoNothingAndStopPropagationIntent(),
      SingleActivator(LogicalKeyboardKey.select, includeRepeats: false):
          ActivateIntent(),
      SingleActivator(LogicalKeyboardKey.select):
          DoNothingAndStopPropagationIntent(),
    };

/// THE kill flow (#424): ONE confirmation, then `DELETE`. Called by the actions
/// sheet's "Kill session" row and by the session screen's ⋮ menu alike - a second
/// copy of this dialog is how the two would drift apart.
///
/// Returns true once the user confirmed (the kill was attempted; a failure is the
/// "Failed" snackbar, as ever), false when they cancelled or [context] went away - so
/// a caller that has a sheet of its own to close knows whether to.
///
/// Keyboard (desktop): Esc cancels - the dialog route's default dismiss - and a FRESH
/// Enter press confirms, because the destructive button is the autofocused one. It is
/// fresh-press only ([_freshPressActivates]): the pick that opened this dialog may
/// itself have been an Enter that is still held, and its repeats must not kill.
Future<bool> confirmAndKillSession(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ApiClient? api,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => Shortcuts(
      shortcuts: _freshPressActivates,
      child: AlertDialog(
        title: const Text('Kill session?'),
        content: const Text('This cannot be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            autofocus: true,
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Kill'),
          ),
        ],
      ),
    ),
  );
  if (confirmed != true || !context.mounted) return false;
  await _runSessionAction(
    context,
    onChanged,
    () => (api ?? ApiClient(session.server)).killSession(session.id),
  );
  return true;
}

/// THE rename flow: a name dialog, then `PATCH`. Returns true when a new name was
/// sent (a failure is the "Failed" snackbar), false on cancel or an empty name.
Future<bool> promptAndRenameSession(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ApiClient? api,
}) async {
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
  if (newName == null || newName.isEmpty || !context.mounted) return false;
  await _runSessionAction(
    context,
    onChanged,
    () => (api ?? ApiClient(session.server)).renameSession(session.id, newName),
  );
  return true;
}

/// "Not waiting" (#327): clears a wait the AGENT reported. Offered only where
/// `SessionRepository.canClearWait` says so.
Future<void> clearSessionWait(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ApiClient? api,
}) => _runSessionAction(
  context,
  onChanged,
  () => (api ?? ApiClient(session.server)).patchBrief(session.id, clearWait: true),
);

/// #558 - THE "Move under..." flow: pick a new parent for [session] from every
/// listed session on every server (never itself or anything under it: the server
/// refuses a loop, so it is not offered), or "No parent". Shared by the actions
/// sheet and the session screen's menu. Returns true once a move was sent.
Future<bool> promptAndMoveSession(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ApiClient? api,
  List<Session>? sessions,
}) async {
  final all = sessions ?? SessionRepository.instance.current;
  final tree = SessionTree(all);
  final exclude = <String>{session.id, ...tree.descendantsOf(session).map((s) => s.id)};
  final current = tree.parentOf(session);
  final pick = await _pickParent(
    context,
    title: 'Move "${session.displayName}" under',
    candidates: _uniqueById(all).where((s) => !exclude.contains(s.id)).toList(),
    currentId: current?.id,
    offerNone: session.parentId != null,
  );
  if (pick == null || !context.mounted) return false;
  final client = api ?? ApiClient(session.server);
  final messenger = ScaffoldMessenger.of(context);
  try {
    await client.setSessionParent(session.id, pick.session?.id);
    onChanged();
    messenger.showSnackBar(SnackBar(
      content: Text(pick.session == null
          ? '${session.displayName} is now a top-level session'
          : '${session.displayName} moved under ${pick.session!.displayName}'),
    ));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('Move failed: ${e is ApiException ? e.message : e}')));
  }
  return true;
}

/// #558 - THE "Hand sub-sessions to..." flow: every child of [session] (on any
/// server) moves under the session picked, or to the top level. The server that
/// owns [session] forwards each child's move to the child's own server.
Future<bool> promptAndHandOverChildren(
  BuildContext context,
  Session session, {
  required VoidCallback onChanged,
  ApiClient? api,
  List<Session>? sessions,
}) async {
  final all = sessions ?? SessionRepository.instance.current;
  final tree = SessionTree(all);
  final kids = tree.childrenOf(session);
  final exclude = <String>{session.id, ...tree.descendantsOf(session).map((s) => s.id)};
  final pick = await _pickParent(
    context,
    title: 'Hand ${kids.length} sub-session${kids.length == 1 ? '' : 's'} of "${session.displayName}" to',
    candidates: _uniqueById(all).where((s) => !exclude.contains(s.id)).toList(),
    currentId: null,
    offerNone: true,
  );
  if (pick == null || !context.mounted) return false;
  final client = api ?? ApiClient(session.server);
  final messenger = ScaffoldMessenger.of(context);
  try {
    final r = await client.moveChildren(session.id, pick.session?.id);
    onChanged();
    final where = pick.session == null ? 'the top level' : pick.session!.displayName;
    messenger.showSnackBar(SnackBar(
      content: Text(r.failed == 0
          ? 'Moved ${r.moved} to $where'
          : 'Moved ${r.moved} to $where; ${r.failed} not moved: ${r.firstError ?? 'refused'}'),
    ));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('Hand-over failed: ${e is ApiException ? e.message : e}')));
  }
  return true;
}

/// One row per session id: two server entries reaching the same box (a LAN and a
/// tailnet URL) list the same session twice.
List<Session> _uniqueById(List<Session> all) {
  final seen = <String>{};
  return [for (final s in all) if (seen.add(s.id)) s];
}

/// What the parent picker answered: a session, or [session] null for "No parent".
class _ParentPick {
  const _ParentPick(this.session);
  final Session? session;
}

/// The parent picker: a filter field over [candidates] (name, folder, server),
/// "No parent" first when [offerNone]. Null when cancelled.
Future<_ParentPick?> _pickParent(
  BuildContext context, {
  required String title,
  required List<Session> candidates,
  required String? currentId,
  required bool offerNone,
}) {
  return showDialog<_ParentPick>(
    context: context,
    builder: (context) => _ParentPickerDialog(
      title: title,
      candidates: candidates,
      currentId: currentId,
      offerNone: offerNone,
    ),
  );
}

class _ParentPickerDialog extends StatefulWidget {
  const _ParentPickerDialog({
    required this.title,
    required this.candidates,
    required this.currentId,
    required this.offerNone,
  });

  final String title;
  final List<Session> candidates;
  final String? currentId;
  final bool offerNone;

  @override
  State<_ParentPickerDialog> createState() => _ParentPickerDialogState();
}

class _ParentPickerDialogState extends State<_ParentPickerDialog> {
  String _filter = '';

  @override
  Widget build(BuildContext context) {
    final q = _filter.trim().toLowerCase();
    final shown = q.isEmpty
        ? widget.candidates
        : widget.candidates
            .where((s) =>
                s.displayName.toLowerCase().contains(q) ||
                s.cwd.toLowerCase().contains(q) ||
                s.server.name.toLowerCase().contains(q))
            .toList();
    return AlertDialog(
      title: Text(widget.title, maxLines: 2, overflow: TextOverflow.ellipsis),
      contentPadding: const EdgeInsets.fromLTRB(0, 12, 0, 0),
      content: SizedBox(
        width: 420,
        height: 420,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TextField(
                key: const ValueKey('parent-picker-filter'),
                autofocus: true,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Filter by name, folder or machine',
                ),
                onChanged: (v) => setState(() => _filter = v),
              ),
            ),
            Expanded(
              child: ListView(
                children: [
                  if (widget.offerNone)
                    ListTile(
                      key: const ValueKey('parent-picker-none'),
                      leading: const Icon(Icons.vertical_align_top),
                      title: const Text('No parent (top level)'),
                      onTap: () => Navigator.pop(context, const _ParentPick(null)),
                    ),
                  for (final s in shown)
                    ListTile(
                      key: ValueKey('parent-picker-${s.id}'),
                      leading: Icon(s.id == widget.currentId ? Icons.check : Icons.subdirectory_arrow_right),
                      title: Text(s.displayName, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text('${s.server.name} - ${s.cwd}', maxLines: 1, overflow: TextOverflow.ellipsis),
                      enabled: s.id != widget.currentId,
                      onTap: () => Navigator.pop(context, _ParentPick(s)),
                    ),
                  if (shown.isEmpty && !widget.offerNone)
                    const Padding(
                      padding: EdgeInsets.all(16),
                      child: Text('No other session to move it under.'),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
      ],
    );
  }
}

/// Wraps a bottom-sheet body so it never overflows a short viewport: caps the
/// height at 85% of the screen and scrolls its content past that, keeping the
/// bottom rows (e.g. the Notify Level radios) reachable (issue #13). Used with
/// `isScrollControlled: true` on the `showAppBottomSheet` call.
class _ScrollableSheet extends StatelessWidget {
  const _ScrollableSheet({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      child: SingleChildScrollView(child: child),
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
    this.canClearWait = false,
    this.canMove = false,
  });

  final Session session;
  final ApiClient api;
  final VoidCallback onChanged;
  final ValueChanged<Session>? onForked;
  final bool canClearWait;
  final bool canMove;

  Future<void> _move(BuildContext context) async {
    final moved = await promptAndMoveSession(context, session, onChanged: onChanged, api: api);
    if (moved && context.mounted) Navigator.pop(context);
  }

  Future<void> _handOver(BuildContext context) async {
    final moved = await promptAndHandOverChildren(context, session, onChanged: onChanged, api: api);
    if (moved && context.mounted) Navigator.pop(context);
  }

  Future<void> _run(
    BuildContext context,
    Future<void> Function() action,
  ) => _runSessionAction(context, onChanged, action);

  Future<void> _rename(BuildContext context) async {
    final renamed = await promptAndRenameSession(
      context,
      session,
      onChanged: onChanged,
      api: api,
    );
    if (renamed && context.mounted) Navigator.pop(context);
  }

  Future<void> _kill(BuildContext context) async {
    final killed = await confirmAndKillSession(
      context,
      session,
      onChanged: onChanged,
      api: api,
    );
    if (killed && context.mounted) Navigator.pop(context);
  }

  Future<void> _clearWait(BuildContext context) async {
    await clearSessionWait(context, session, onChanged: onChanged, api: api);
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
      // Recorded, not refreshed-and-awaited: the fork's screen opens before any list has it.
      SessionRepository.instance.noteCreated(forked);
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
              session.displayName,
              style: Theme.of(context).textTheme.titleMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(height: 8),
          // #327 - the agent said it is waiting on you and it is not.
          if (canClearWait)
            ListTile(
              key: const ValueKey('session-action-clear-wait'),
              leading: const Icon(Icons.hourglass_disabled_outlined),
              title: const Text('Not waiting'),
              subtitle: (session.reason?.text ?? '').isEmpty
                  ? null
                  : Text('Agent says: ${session.reason!.text}', maxLines: 2, overflow: TextOverflow.ellipsis),
              onTap: () => _clearWait(context),
            ),
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
          // #558 - change who this session is drawn under, or hand its children on.
          if (canMove)
            ListTile(
              key: const ValueKey('session-action-move'),
              leading: const Icon(Icons.account_tree_outlined),
              title: const Text('Move under...'),
              onTap: () => _move(context),
            ),
          if (canMove && SessionTree(SessionRepository.instance.current).childrenOf(session).isNotEmpty)
            ListTile(
              key: const ValueKey('session-action-hand-over'),
              leading: const Icon(Icons.move_down),
              title: const Text('Hand sub-sessions to...'),
              onTap: () => _handOver(context),
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
