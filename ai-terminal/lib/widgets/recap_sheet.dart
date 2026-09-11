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
        // Two different absences, said differently. "We stopped looking after N
        // turns" is not "this session has no prompt", and on a session that has
        // drifted far enough to exhaust the walk, the second would be confidently
        // wrong — which is the one thing this card must never be.
        emptyNote: r.scanExhausted
            ? 'nothing you typed in the last ${r.scanTurns} turns'
            : 'no prompt found in the recent transcript',
        when: r.prompt?.at,
        accent: theme.colorScheme.primary,
      ),
      RecapPromptTrail(prompts: r.prompts),

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
            child: recapAge(theme, when),
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

}

/// An ISO stamp from the transcript rendered as "12m ago", with the absolute time
/// one long-press away.
///
/// Relative is the primary reading: the question this card answers is *how stale
/// is this*, not *what o'clock was it*. The absolute form is still worth having —
/// "that was not my last prompt" is settled by a clock reading — and a [Tooltip]
/// is an overlay, so it costs no layout at all.
///
/// Renders an empty string for anything unparseable, so an odd stamp simply
/// leaves the line blank rather than showing a broken date.
Widget recapAge(ThemeData theme, String? iso, {TextAlign? align}) {
  final style = theme.textTheme.labelSmall
      ?.copyWith(color: theme.colorScheme.onSurfaceVariant);
  final t = iso == null ? null : DateTime.tryParse(iso);
  if (t == null) return Text('', style: style, textAlign: align);
  final ms = t.millisecondsSinceEpoch;
  return Tooltip(
    message: absoluteTime(ms),
    child: Text(relativeTime(ms),
        style: style,
        textAlign: align,
        maxLines: 1,
        overflow: TextOverflow.ellipsis),
  );
}

/// The prompts BEFORE the newest one, one compact line each (#246).
///
/// ONE PROMPT IS NOT ENOUGH STATE TO RE-ORIENT ON. The reported card led with a
/// 13h-old prompt that read exactly like a fresh one; the selection was right and
/// the user still lost the thread. These rows carry the age FIRST, right-aligned
/// in a fixed column, so the ages line up as a small table and "1m / 13h" is read
/// in one downward glance — where a trailing stamp would make you read each
/// sentence to its end before reaching the number that matters.
///
/// They are deliberately SUBORDINATE to the block above:
///  * no label of their own — proximity and the shared left inset bind them to
///    "You asked", and a second caption would cost a line to say nothing;
///  * no accent rule — `outlineVariant` is the REPLY's rule, and borrowing it
///    here would conflate something you asked with something it said;
///  * plain [Text], not [SelectableText] — a one-line preview that is already cut
///    is not worth dragging selection handles across; the full newest prompt above
///    stays selectable, which is where copying actually starts.
///
/// Empty (and renders nothing at all) when there is one prompt or none, so the
/// common case is byte-for-byte the card that shipped before this.
class RecapPromptTrail extends StatelessWidget {
  const RecapPromptTrail({super.key, required this.prompts});

  /// The full newest-first list. The first entry is the headline shown above and
  /// is skipped here.
  final List<RecapEntry> prompts;

  /// Wide enough for the longest thing [relativeTime] produces ("just now").
  static const double _ageColumn = 60;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final older = prompts.skip(1).toList(growable: false);
    if (older.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 6),
        for (final p in older)
          Padding(
            padding: const EdgeInsets.only(left: 10, top: 4),
            child: Row(
              children: [
                SizedBox(
                  width: _ageColumn,
                  child: recapAge(theme, p.at, align: TextAlign.right),
                ),
                const SizedBox(width: 8),
                // One line, cut by the renderer. The server's own cut marker can
                // only show on a row short enough not to overflow, so the two
                // truncations can never both appear.
                Expanded(
                  child: Text(
                    p.text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
