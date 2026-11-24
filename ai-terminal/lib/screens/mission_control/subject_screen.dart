// #509 - Mission Control's Subject screen: one work item across every server.
//
// It renders `GET /api/mc/subjects/:key` as sent: the progress track with the time and the
// evidence of each step, this subject's open question (the SAME card as Now), the work
// item from the tracker, and the sessions on it as a tree drawn from the server's
// `parentId` (the server owns the tree rule; nothing is re-derived here).
//
// "Pause this subject" tells every live session on it one fixed line, each through the
// gated prompt on its own server (`POST /api/sessions/:id/prompt`), after a confirm; each
// session's answer is shown as it came back - told, or refused and why.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_ask_models.dart';
import '../../api/mc_models.dart';
import '../../services/mc_analyst.dart';
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import '../../util/terminal_links.dart' show isLaunchableHttpUrl;
import '../../widgets/conversation_view.dart' show openChatLink;
import '../../widgets/format_utils.dart';
import 'ask_view.dart';
import 'now_view.dart';
import 'subject_widgets.dart';

/// The line "Pause this subject" sends (the server puts its tag in front). One line, no
/// control characters, well under the gated prompt's 511 bytes.
String mcPauseText(String ref) {
  final r = ref.length > 80 ? '${ref.substring(0, 80)}...' : ref;
  return 'The owner paused work on $r from Mission Control. Stop at the next safe point, '
      'report where you are, and wait for the owner before going on.';
}

class McSubjectScreen extends StatefulWidget {
  const McSubjectScreen({
    super.key,
    required this.feed,
    required this.subjectKey,
    required this.onAnswer,
    required this.onOpenSession,
    this.initial,
    this.now,
    this.openUrl,
  });

  final McFeed feed;
  final String subjectKey;
  final void Function(McCard card) onAnswer;
  final void Function(String sessionId) onOpenSession;

  /// The row it was opened from: shown at once, until the server's answer arrives.
  final McSubject? initial;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  /// Test seam: receives a url that passed the app's link gate, in place of opening it.
  /// Defaults to the app's one link opener ([openChatLink]).
  final void Function(String url)? openUrl;

  @override
  State<McSubjectScreen> createState() => _McSubjectScreenState();
}

class _McSubjectScreenState extends State<McSubjectScreen> {
  McSubject? _subject;
  List<McRun> _runs = const [];
  String? _error;
  bool _gone = false;
  DateTime? _feedAt;
  bool _pausing = false;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _subject = widget.initial;
    _feedAt = widget.feed.receivedAt;
    widget.feed.addListener(_onFeed);
    unawaited(_load());
  }

  /// #511 - this subject's conversation with the Analyst, made on the first ask and kept
  /// while the page lives (asked of the server that answers Mission Control).
  McAskThread? _ask;

  @override
  void dispose() {
    widget.feed.removeListener(_onFeed);
    _ask?.dispose();
    super.dispose();
  }

  void _openAsk(McSubject s) {
    final thread = _ask ??= McAskThread(
        McAnalyst(servers: widget.feed.servers, client: widget.feed.client, preferred: () => widget.feed.servedBy));
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        appBar: AppBar(title: Text('Ask about ${s.refLabel}')),
        body: McAskView(
          thread: thread,
          fixedScope: McAskScope.subject(s.key),
          fixedScopeLabel: s.refLabel,
          onOpenSession: widget.onOpenSession,
          onOpenUrl: (u) => _open(u.toString()),
        ),
      ),
    ));
  }

  void _onFeed() {
    final at = widget.feed.receivedAt;
    if (at != null && at != _feedAt) {
      _feedAt = at;
      unawaited(_load());
    }
  }

  /// Reads the subject again; an answer overtaken by a newer read is dropped.
  Future<void> _load() async {
    final seq = ++_seq;
    try {
      final d = await widget.feed.subject(widget.subjectKey);
      if (!mounted || seq != _seq) return;
      setState(() {
        if (d.subject != null) _subject = d.subject;
        _runs = d.runs;
        _error = d.subject == null ? 'The server sent no subject' : null;
        _gone = false;
      });
    } on ApiException catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _gone = e.status == 404;
        _error = e.status == 404
            ? 'The server does not know this subject (any more), or has no subject page yet'
            : e.message;
      });
    } catch (e) {
      if (mounted && seq == _seq) setState(() => _error = 'Could not read the subject: $e');
    }
  }

  /// Opens a tracker or PR link the way the app opens every link ([openChatLink]: its
  /// http/https gate, the external browser, a refused launch swallowed).
  void _open(String? url) {
    final f = widget.openUrl;
    if (f == null) {
      unawaited(openChatLink(url));
    } else if (isLaunchableHttpUrl(url)) {
      f(url!);
    }
  }

  Future<void> _pause(McSubject s) async {
    final live = s.liveSessions;
    if (live.isEmpty) return;
    final text = mcPauseText(s.refLabel);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Pause this subject?'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Each of these ${live.length == 1 ? 'session is' : '${live.length} sessions are'} told, '
                'only if it can take a prompt right now:'),
            const SizedBox(height: 8),
            for (final x in live) Text('- ${x.label}${x.server == null ? '' : ' (${x.server})'}'),
            const SizedBox(height: 8),
            Text('"$text"', style: Theme.of(ctx).textTheme.bodySmall),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          FilledButton(
              key: const ValueKey('mc-pause-confirm'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Pause')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _pausing = true);
    final results = await widget.feed.tell(live, text);
    if (!mounted) return;
    setState(() => _pausing = false);
    final told = results.where((r) => r.$2.delivered).length;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(told == results.length ? 'Paused' : 'Told $told of ${results.length}'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final (x, r) in results)
              Padding(
                key: ValueKey('mc-pause-result-${x.id}'),
                padding: const EdgeInsets.only(bottom: 6),
                child: Text('${x.label}: ${r.text}',
                    style: TextStyle(color: r.delivered ? AppColors.primary : AppColors.caution)),
              ),
          ]),
        ),
        actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('OK'))],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = _subject;
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final link = s?.meta?.url ?? s?.url;
    return Scaffold(
      appBar: AppBar(
        title: Text(s?.refLabel ?? widget.subjectKey),
        actions: [
          if (link != null)
            IconButton(
              key: const ValueKey('mc-subject-open-tracker-bar'),
              tooltip: 'Open in the tracker',
              icon: const Icon(Icons.open_in_browser),
              onPressed: () => _open(link),
            ),
          IconButton(
            key: const ValueKey('mc-subject-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load,
          ),
        ],
      ),
      body: s == null
          ? (_error == null
              ? const Center(child: CircularProgressIndicator())
              : Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_error!, key: const ValueKey('mc-subject-error'), textAlign: TextAlign.center),
                  ),
                ))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                key: const ValueKey('mc-subject-list'),
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 32),
                children: [
                  if (_error != null) McStaleBanner(message: _gone ? '$_error - showing the last copy' : _error!),
                  Text(s.titleLabel,
                      key: const ValueKey('mc-subject-heading'),
                      style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text([s.refLabel, ?s.project, ?s.area].join(' · '), style: muted),
                  const SizedBox(height: 12),
                  if (s.needsYou != null) ...[
                    mcSectionTitle(context, 'Open question'),
                    McAnswerCard(
                      key: ValueKey('mc-card-${s.needsYou!.id}'),
                      card: s.needsYou!,
                      now: widget.now,
                      onAnswer: () => widget.onAnswer(s.needsYou!),
                      onOpenSession: s.needsYou!.sessionId == null
                          ? null
                          : () => widget.onOpenSession(s.needsYou!.sessionId!),
                      onLater: (h) => mcRun(context, () => widget.feed.later(s.needsYou!, h)),
                      onTodo: () => mcRun(context, () => widget.feed.addTodo(s.needsYou!)),
                    ),
                    const SizedBox(height: 16),
                  ],
                  mcSectionTitle(context, 'Progress'),
                  McProgressTrack(stage: s.stage, now: widget.now),
                  const SizedBox(height: 16),
                  mcSectionTitle(context, 'Work item'),
                  McWorkItemCard(subject: s, onOpen: _open, now: widget.now),
                  const SizedBox(height: 16),
                  for (final r in _runs) if (r.id == s.runId) McRunHeader(run: r, now: widget.now),
                  mcSectionTitle(context, 'Sessions (${s.sessions.length})'),
                  if (s.sessions.isEmpty)
                    Text('No session has reported on it.', style: muted)
                  else
                    McSessionTree(sessions: s.sessions, onOpen: widget.onOpenSession, now: widget.now),
                  const SizedBox(height: 16),
                  mcSectionTitle(context, 'Ask about this subject'),
                  // Opens the Ask page for this subject (#511): the answer needs room this list has not.
                  TextField(
                    key: const ValueKey('mc-subject-ask'),
                    readOnly: true,
                    onTap: () => _openAsk(s),
                    decoration: const InputDecoration(
                      hintText: 'Ask a read-only Analyst about this subject',
                      suffixIcon: Icon(Icons.forum_outlined),
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton.icon(
                      key: const ValueKey('mc-subject-pause'),
                      onPressed: s.liveSessions.isEmpty || _pausing ? null : () => _pause(s),
                      icon: _pausing
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.pause_circle_outline),
                      label: Text(s.liveSessions.isEmpty
                          ? 'Pause this subject (no live session)'
                          : 'Pause this subject (${s.liveSessions.length})'),
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}

/// The progress track, one line per step in the stage order: reached or not, and for
/// every step the history records, when and on what evidence.
class McProgressTrack extends StatelessWidget {
  const McProgressTrack({super.key, required this.stage, this.order = kMcStageOrder, this.now});
  final McStage stage;
  final List<String> order;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final at = mcStageIndex(order, stage.current);
    // A stage the history names that the order does not: shown after the order, by name.
    final extra = <String>{
      for (final h in stage.history)
        if (!order.contains(h.stage)) h.stage,
      if (stage.current != null && !order.contains(stage.current)) stage.current!,
    }.toList();
    final halves = [
      if (stage.reported != null) 'reported ${mcStageLabel(stage.reported!)}',
      if (stage.evidence != null) 'evidence ${mcStageLabel(stage.evidence!)}',
    ].join(' · ');
    Widget line(String st, bool reached, bool current) {
      final steps = stage.stepsFor(st);
      return Padding(
        key: ValueKey('mc-step-$st'),
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(
            current ? Icons.radio_button_checked : (reached ? Icons.check_circle : Icons.radio_button_unchecked),
            size: 18,
            color: reached || current ? AppColors.primary : AppColors.outline,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(mcStageLabel(st),
                  style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: current ? FontWeight.w700 : null,
                      color: reached || current ? null : AppColors.onSurfaceVariant)),
              for (final h in steps)
                Text(
                  [
                    if (h.at != null) relativeTime(h.at!.millisecondsSinceEpoch, now: now),
                    if (h.source != null) 'from ${h.source}',
                    ?h.detail,
                  ].join(' · '),
                  key: const ValueKey('mc-step-evidence'),
                  style: muted,
                ),
            ]),
          ),
        ]),
      );
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (stage.current == null)
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Text('No stage reported or seen yet.', style: muted),
        ),
      if (halves.isNotEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(halves, key: const ValueKey('mc-stage-halves'), style: muted)),
      // Reached: before the current step, or recorded in the history (so a current step
      // outside the order still shows what was reached on the way).
      for (var i = 0; i < order.length; i++)
        line(order[i], (at >= 0 && i < at) || stage.stepsFor(order[i]).isNotEmpty, i == at),
      for (final st in extra) line(st, true, st == stage.current),
    ]);
  }
}

/// The work item as the tracker has it: type, state, severity, opener, area, PRs, a
/// one-line summary, and a link to the tracker.
class McWorkItemCard extends StatelessWidget {
  const McWorkItemCard({super.key, required this.subject, required this.onOpen, this.now});
  final McSubject subject;
  final void Function(String? url) onOpen;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final s = subject;
    final m = s.meta;
    final link = m?.url ?? s.url;
    String? field(String label, String? v) => v == null ? null : '$label: $v';
    final fields = [
      field('Type', m?.type),
      field('State', m == null ? null : [?m.state, if (m.closed) '(closed)'].join(' ').trim().nullIfEmpty),
      field('Severity', m?.severityLabel),
      field('Opened by', m?.createdBy == null ? null : [m!.createdBy!, if (m.createdAt != null) relativeTime(m.createdAt!.millisecondsSinceEpoch, now: now)].join(', ')),
      field('Area', m?.area ?? s.area),
      field('Assigned to', m?.assignee),
    ].whereType<String>().toList();
    final summary = m?.summary ?? m?.title;
    return Card(
      key: const ValueKey('mc-work-item'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (m == null)
            Text('The tracker has not been read for this item.', style: muted)
          else ...[
            if (summary != null)
              Text(summary, key: const ValueKey('mc-work-item-summary'), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 4),
            for (final f in fields) Text(f, style: theme.textTheme.bodySmall),
            if (m.prs.isNotEmpty) ...[
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 4, children: [
                for (final pr in m.prs)
                  ActionChip(
                    key: ValueKey('mc-pr-${pr.number ?? pr.url}'),
                    visualDensity: VisualDensity.compact,
                    avatar: const Icon(Icons.merge_type, size: 16),
                    label: Text(pr.label),
                    onPressed: pr.url == null ? null : () => onOpen(pr.url),
                  ),
              ]),
            ],
            if (m.error != null || m.warning != null) ...[
              const SizedBox(height: 6),
              Text(
                [
                  if (m.error != null) 'The tracker could not be read: ${m.error}',
                  ?m.warning,
                  if (m.staleSince != null) 'copy from ${relativeTime(m.staleSince!.millisecondsSinceEpoch, now: now)}',
                ].join(' · '),
                key: const ValueKey('mc-work-item-warning'),
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.caution),
              ),
            ],
          ],
          if (link != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const ValueKey('mc-subject-open-tracker'),
                onPressed: () => onOpen(link),
                icon: const Icon(Icons.open_in_browser, size: 18),
                label: const Text('Open in the tracker'),
              ),
            ),
        ]),
      ),
    );
  }
}

extension on String {
  String? get nullIfEmpty => isEmpty ? null : this;
}

/// The sessions on a subject as a tree, drawn from the server's [McSubjectSession.parentId]:
/// a session whose parent is on the subject sits under it; any other is a root. Each node
/// is one widget holding its children, so "under its parent" is a fact of the widget tree.
class McSessionTree extends StatelessWidget {
  const McSessionTree({super.key, required this.sessions, required this.onOpen, this.now});
  final List<McSubjectSession> sessions;
  final void Function(String sessionId) onOpen;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final ids = {for (final s in sessions) s.id};
    final kids = <String, List<McSubjectSession>>{};
    final roots = <McSubjectSession>[];
    for (final s in sessions) {
      final p = s.parentId;
      if (p != null && p != s.id && ids.contains(p)) {
        (kids[p] ??= []).add(s);
      } else {
        roots.add(s);
      }
    }
    final drawn = <String>{};
    Widget node(McSubjectSession s) {
      drawn.add(s.id);
      final children = kids[s.id] ?? const <McSubjectSession>[];
      return Column(
        key: ValueKey('mc-node-${s.id}'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _SessionRow(session: s, onOpen: onOpen, now: now),
          if (children.any((c) => !drawn.contains(c.id)))
            Padding(
              padding: const EdgeInsets.only(left: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [for (final c in children) if (!drawn.contains(c.id)) node(c)],
              ),
            ),
        ],
      );
    }

    final out = [for (final r in roots) node(r)];
    // A parent cycle the server should never send leaves sessions unreached from any
    // root: shown flat at the end rather than lost.
    for (final s in sessions) {
      if (!drawn.contains(s.id)) out.add(node(s));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: out);
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.session, required this.onOpen, this.now});
  final McSubjectSession session;
  final void Function(String sessionId) onOpen;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final s = session;
    final r = s.lastReport;
    final report = r == null
        ? null
        : [
            ?r.state,
            if (r.stage != null) mcStageLabel(r.stage!),
            ?r.line,
            if (r.at != null) relativeTime(r.at!.millisecondsSinceEpoch, now: now),
          ].join(' · ');
    final w = s.wait;
    return Card(
      key: ValueKey('mc-session-${s.id}'),
      margin: const EdgeInsets.only(bottom: 6),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text(s.label,
                    style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600, color: s.closed ? AppColors.onSurfaceVariant : null)),
                if (s.server != null) McMachineChip(s.server!),
                if (s.closed)
                  McTag(
                      s.closedAt == null
                          ? 'closed'
                          : 'closed ${relativeTime(s.closedAt!.millisecondsSinceEpoch, now: now)}',
                      muted: true)
                else if (s.status != null)
                  McTag(s.status!, muted: s.status != 'working'),
              ]),
              if (report != null && report.isNotEmpty)
                Text(report, key: const ValueKey('mc-session-report'), maxLines: 2, overflow: TextOverflow.ellipsis, style: muted),
              if (w != null && !s.closed)
                Text(w.what == null ? 'waits on ${w.on}' : 'waits on ${w.on}: ${w.what}',
                    style: theme.textTheme.bodySmall?.copyWith(color: w.on == 'you' ? AppColors.caution : null)),
            ]),
          ),
          if (!s.closed)
            TextButton(
              key: ValueKey('mc-session-open-${s.id}'),
              onPressed: () => onOpen(s.id),
              child: const Text('Open'),
            ),
        ]),
      ),
    );
  }
}

