import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import 'format_utils.dart';

/// The "where was I in this one?" sheet.
///
/// With a list full of sessions the row says *that* one is running, never *what*.
/// This shows the last thing you asked, the agent's latest word, the task it is
/// on, and what it has done since.
///
/// It is a SHEET, not a screen: opening it must not cost you the session you are
/// already in. Tapping the recap icon deliberately does not navigate — the whole
/// point is to look into a session without leaving where you are.
///
/// It PAINTS ONLY. Which user turn counts as a typed prompt, what to condense and
/// which task is current are all decided server-side (`lib/recap.js`) and arrive
/// whole in [SessionRecap]. The same card exists in `app.html`; duplicating the
/// rules across both clients is the drift this codebase keeps paying for.
Future<void> showRecapSheet(
  BuildContext context, {
  required ApiClient client,
  required String sessionId,
  required String sessionName,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => RecapSheet(
      client: client,
      sessionId: sessionId,
      sessionName: sessionName,
    ),
  );
}

class RecapSheet extends StatefulWidget {
  const RecapSheet({
    super.key,
    required this.client,
    required this.sessionId,
    required this.sessionName,
  });

  final ApiClient client;
  final String sessionId;
  final String sessionName;

  @override
  State<RecapSheet> createState() => _RecapSheetState();
}

class _RecapSheetState extends State<RecapSheet> {
  SessionRecap? _recap;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.client.recap(widget.sessionId);
      if (mounted) setState(() => _recap = r);
    } catch (e) {
      // A server older than 1.57.0 has no such route. Say so plainly rather than
      // showing an empty card that looks like "this session did nothing".
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.75,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: _body(theme),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _body(ThemeData theme) {
    final r = _recap;
    if (_error != null) {
      return [
        Text(widget.sessionName, style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        Text('Could not read this session.\n$_error',
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.error)),
      ];
    }
    if (r == null) {
      return [
        Text(widget.sessionName, style: theme.textTheme.titleMedium),
        const SizedBox(height: 16),
        const Center(child: CircularProgressIndicator()),
        const SizedBox(height: 16),
      ];
    }

    const waitLabel = <String, String>{
      'question': 'waiting for your answer',
      'permission': 'waiting for permission',
    };

    return [
      Row(
        children: [
          Expanded(
            child: Text(r.name.isEmpty ? widget.sessionName : r.name,
                style: theme.textTheme.titleMedium,
                overflow: TextOverflow.ellipsis),
          ),
          if (r.agent != null && r.agent!.isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(r.agent!,
                  style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onPrimaryContainer)),
            ),
        ],
      ),
      const SizedBox(height: 2),
      Text(
        [
          if (r.cwd.isNotEmpty) r.cwd,
          if (r.lastActivity != null) relativeTime(r.lastActivity!),
        ].join(' · '),
        style: theme.textTheme.bodySmall
            ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        overflow: TextOverflow.ellipsis,
      ),

      if (r.waitingFor != null) ...[
        const SizedBox(height: 12),
        Row(children: [
          Icon(Icons.warning_amber_rounded,
              size: 16, color: theme.colorScheme.error),
          const SizedBox(width: 6),
          Text(waitLabel[r.waitingFor] ?? r.waitingFor!,
              style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                  fontWeight: FontWeight.w600)),
        ]),
      ],

      _section(
        theme,
        'You asked',
        r.prompt?.text,
        emptyNote: 'no prompt found in the recent transcript',
        when: r.prompt?.at,
        accent: theme.colorScheme.primary,
      ),

      if (r.reply != null)
        _section(
          theme,
          r.reply!.isSummary ? 'Its summary' : 'It replied',
          r.reply!.text,
          when: r.reply!.at,
          accent: theme.colorScheme.outlineVariant,
        ),

      if (r.tasks != null) _tasks(theme, r.tasks!),

      if (r.sinceTurns > 0) ...[
        const SizedBox(height: 14),
        _label(theme, 'Since then'),
        const SizedBox(height: 4),
        Text('${r.sinceTurns} turn${r.sinceTurns == 1 ? '' : 's'}',
            style: theme.textTheme.bodyMedium),
        if (r.tools.isNotEmpty) ...[
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final t in r.tools)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    border: Border.all(color: theme.colorScheme.outlineVariant),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(t, style: theme.textTheme.labelSmall),
                ),
            ],
          ),
        ],
      ],
    ];
  }

  Widget _label(ThemeData theme, String text) => Text(
        text.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          letterSpacing: 0.6,
        ),
      );

  Widget _section(
    ThemeData theme,
    String label,
    String? body, {
    String? emptyNote,
    String? when,
    required Color accent,
  }) {
    if (body == null && emptyNote == null) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 14),
        _label(theme, label),
        const SizedBox(height: 4),
        if (body != null)
          Container(
            padding: const EdgeInsets.only(left: 10),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: accent, width: 2)),
            ),
            // SelectableText: a recap's most common next action is copying the
            // prompt back out to re-ask it somewhere else.
            child: SelectableText(body, style: theme.textTheme.bodyMedium),
          )
        else
          Text(emptyNote!,
              style: theme.textTheme.bodySmall?.copyWith(
                  fontStyle: FontStyle.italic,
                  color: theme.colorScheme.onSurfaceVariant)),
        if (when != null && when.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(_ago(when),
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          ),
      ],
    );
  }

  Widget _tasks(ThemeData theme, RecapTasks t) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 14),
        _label(theme, 'Tasks ${t.done}/${t.total}'),
        const SizedBox(height: 4),
        if (t.current != null)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (t.currentIsActive) ...[
                Icon(Icons.play_arrow,
                    size: 16, color: theme.colorScheme.primary),
                const SizedBox(width: 4),
              ],
              Expanded(
                  child: Text(t.current!, style: theme.textTheme.bodyMedium)),
            ],
          ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(2),
          child: LinearProgressIndicator(
            value: t.total == 0 ? 0 : t.done / t.total,
            minHeight: 4,
          ),
        ),
      ],
    );
  }

  /// An ISO stamp from the transcript rendered as "12m ago". Returns '' for
  /// anything unparseable, so an odd stamp simply omits the line.
  String _ago(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return '';
    return relativeTime(t.millisecondsSinceEpoch);
  }
}
