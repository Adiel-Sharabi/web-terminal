// #567 - Mission Control's work board (step 1, read-only): the next candidates per source, then what is in
// progress, in a PR or in review, committed or merged, and ready for test. Five columns side by side on a
// desktop, one swipeable page each on a phone.
//
// The SERVER owns every rule (`lib/mc-board.js`): which column an item is in, the age in it, the wait
// badge - the supervisor's verdict, exactly as the Running home shows it - and what a candidate is. This
// file lays the answer out and re-derives nothing. A card opens its live session, else the item's page;
// a candidate opens a sheet with its tracker link. Nothing here writes: no Queued column and no Start yet.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/mc_models.dart';
import '../../services/mc_board_feed.dart';
import '../../theme/app_theme.dart';
import '../../widgets/format_utils.dart' show relativeTime;
import '../adaptive_home.dart' show AdaptiveHome;
import 'now_view.dart' show McTag, mcAge;

/// The heading of the candidates column.
const String kBoardCandidatesTitle = 'Candidates';

Color mcBadgeColor(String kind) => switch (kind) {
      'you' => AppColors.error,
      'suspect' => AppColors.caution,
      'legit' => AppColors.onSurfaceVariant,
      _ => AppColors.onSurfaceDisabled,
    };

class McBoardView extends StatefulWidget {
  const McBoardView({
    super.key,
    required this.feed,
    required this.onOpenSession,
    required this.onOpenSubject,
    this.onOpenUrl,
    this.now,
  });

  final McBoardFeed feed;

  /// A card with a live session opens it.
  final void Function(String sessionId) onOpenSession;

  /// A card with none opens the item's page (a subject's key).
  final void Function(String key) onOpenSubject;

  /// Opens a candidate's tracker link; defaults to the system browser.
  final void Function(Uri url)? onOpenUrl;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  @override
  State<McBoardView> createState() => _McBoardViewState();
}

class _McBoardViewState extends State<McBoardView> {
  // The board is polled only while it is on screen: built = polling, gone = stopped.
  @override
  void initState() {
    super.initState();
    widget.feed.active = true;
  }

  @override
  void didUpdateWidget(McBoardView old) {
    super.didUpdateWidget(old);
    if (old.feed != widget.feed) {
      old.feed.active = false;
      widget.feed.active = true;
    }
  }

  @override
  void dispose() {
    widget.feed.active = false;
    super.dispose();
  }

  void _openUrl(Uri u) => (widget.onOpenUrl ?? (x) => launchUrl(x, mode: LaunchMode.externalApplication))(u);

  void _openWork(McBoardCard c) {
    if (c.sessions.isNotEmpty) {
      widget.onOpenSession(c.sessions.first.id);
    } else {
      widget.onOpenSubject(c.key);
    }
  }

  void _openCandidate(McBoardCard c) => showDialog<void>(
        context: context,
        builder: (_) => McCandidateSheet(card: c, onOpenUrl: _openUrl, now: widget.now),
      );

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.feed,
      builder: (context, _) {
        final f = widget.feed;
        final board = f.board;
        if (board == null) return _Placeholder(feed: f);
        return Column(children: [
          _Notes(feed: f, board: board, now: widget.now),
          Expanded(
            child: LayoutBuilder(builder: (context, box) {
              final wide = box.maxWidth >= AdaptiveHome.splitBreakpoint;
              final cols = _columns(board);
              return wide ? _wide(cols, box.maxWidth) : _narrow(cols);
            }),
          ),
        ]);
      },
    );
  }

  List<_Col> _columns(McBoard b) => [
        _Col(
          id: 'candidates',
          title: kBoardCandidatesTitle,
          count: b.candidateCount,
          body: (_) => _CandidatesBody(board: b, feed: widget.feed, onOpen: _openCandidate, now: widget.now),
        ),
        for (final c in b.columns)
          _Col(
            id: c.id,
            title: c.title,
            count: c.count,
            body: (_) => _WorkBody(column: c, feed: widget.feed, onOpen: _openWork, now: widget.now),
          ),
      ];

  Widget _wide(List<_Col> cols, double width) {
    // Five columns side by side; narrower than their minimum, the row scrolls sideways.
    final each = math.max(270.0, width / cols.length);
    return SingleChildScrollView(
      key: const ValueKey('mc-board-wide'),
      scrollDirection: Axis.horizontal,
      child: SizedBox(
        width: each * cols.length,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final c in cols)
            SizedBox(
              width: each,
              child: Column(children: [
                _ColumnHeader(col: c),
                const Divider(height: 1),
                Expanded(child: KeyedSubtree(key: ValueKey('mc-board-col-${c.id}'), child: c.body(context))),
              ]),
            ),
        ]),
      ),
    );
  }

  Widget _narrow(List<_Col> cols) => DefaultTabController(
        key: const ValueKey('mc-board-narrow'),
        length: cols.length,
        child: Column(children: [
          TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [for (final c in cols) Tab(key: ValueKey('mc-board-tab-${c.id}'), text: '${c.title} ${c.count}')],
          ),
          Expanded(
            child: TabBarView(children: [
              for (final c in cols) KeyedSubtree(key: ValueKey('mc-board-col-${c.id}'), child: c.body(context)),
            ]),
          ),
        ]),
      );
}

class _Col {
  const _Col({required this.id, required this.title, required this.count, required this.body});
  final String id;
  final String title;
  final int count;
  final Widget Function(BuildContext) body;
}

class _ColumnHeader extends StatelessWidget {
  const _ColumnHeader({required this.col});
  final _Col col;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
        child: Row(children: [
          Expanded(
            child: Text(col.title,
                key: ValueKey('mc-board-title-${col.id}'),
                style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
          ),
          Text('${col.count}', key: ValueKey('mc-board-count-${col.id}'), style: Theme.of(context).textTheme.labelLarge),
        ]),
      );
}

/// What shows before there is a board: reading, an authority with no board, or a failed read.
class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.feed});
  final McBoardFeed feed;

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant);
    return switch (feed.status) {
      McBoardStatus.unsupported => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('This server has no board yet.\nUpdate the Mission Control server (1.140 or newer) to see it.',
                key: const ValueKey('mc-board-unsupported'), textAlign: TextAlign.center, style: muted),
          ),
        ),
      McBoardStatus.failed => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('The board could not be read: ${feed.message ?? 'no answer'}',
                key: const ValueKey('mc-board-failed'), textAlign: TextAlign.center, style: muted),
          ),
        ),
      _ => const Center(child: CircularProgressIndicator(key: ValueKey('mc-board-loading'))),
    };
  }
}

/// The lines above the columns: why the board is old, a machine that did not answer, when it was read.
class _Notes extends StatelessWidget {
  const _Notes({required this.feed, required this.board, this.now});
  final McBoardFeed feed;
  final McBoard board;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final warn = theme.textTheme.bodySmall?.copyWith(color: AppColors.caution);
    final read = board.refreshedAt;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text(
                read == null ? 'Candidates not read yet' : 'Candidates read ${relativeTime(read.millisecondsSinceEpoch, now: now)}',
                key: const ValueKey('mc-board-read'),
                style: muted),
          ),
          if (feed.busy) const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
        ]),
        if (feed.message != null) Text(feed.message!, key: const ValueKey('mc-board-note'), style: warn),
        if (!board.complete)
          Text('A machine did not answer: a card may have a session there.', key: const ValueKey('mc-board-incomplete'), style: warn),
      ]),
    );
  }
}

class _WorkBody extends StatelessWidget {
  const _WorkBody({required this.column, required this.feed, required this.onOpen, this.now});
  final McBoardColumn column;
  final McBoardFeed feed;
  final void Function(McBoardCard) onOpen;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return RefreshIndicator(
      onRefresh: () => feed.refresh(candidates: true, force: true),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(8),
        children: [
          if (column.cards.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('Nothing here.', style: muted)),
          for (final c in column.cards)
            Padding(padding: const EdgeInsets.only(bottom: 8), child: McBoardCardTile(card: c, onTap: () => onOpen(c), now: now)),
          if (column.more > 0) Padding(padding: const EdgeInsets.all(8), child: Text('+${column.more} more not shown', style: muted)),
        ],
      ),
    );
  }
}

class _CandidatesBody extends StatelessWidget {
  const _CandidatesBody({required this.board, required this.feed, required this.onOpen, this.now});
  final McBoard board;
  final McBoardFeed feed;
  final void Function(McBoardCard) onOpen;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return RefreshIndicator(
      onRefresh: () => feed.refresh(candidates: true, force: true),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(8),
        children: [
          if (board.candidates.isEmpty)
            Padding(padding: const EdgeInsets.all(12), child: Text('No candidate sources are configured.', style: muted)),
          for (final s in board.candidates) ..._source(context, s, muted),
        ],
      ),
    );
  }

  List<Widget> _source(BuildContext context, McCandidateSource s, TextStyle? muted) {
    final theme = Theme.of(context);
    final badState = s.state == 'error' || s.state == 'stale';
    final stateWord = switch (s.state) {
      'ok' => null,
      'stale' => 'old list',
      'loading' => 'reading…',
      'error' => 'could not read',
      'not-wired' => 'not wired yet',
      _ => s.state,
    };
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
        child: Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text(s.heading,
              key: ValueKey('mc-board-source-${s.id}'), style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600)),
          if (s.project != null) McTag(s.project!, muted: true),
          if (stateWord != null)
            McTag(stateWord, key: ValueKey('mc-board-source-state-${s.id}'), color: badState ? AppColors.caution : null, muted: !badState),
        ]),
      ),
      if (s.why != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
          child: Text(s.why!,
              key: ValueKey('mc-board-source-why-${s.id}'),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: muted?.copyWith(color: badState ? AppColors.caution : AppColors.onSurfaceVariant)),
        ),
      if (s.cards.isEmpty && (s.state == 'ok' || s.state == 'stale'))
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(s.hidden > 0 ? 'No new candidates (${s.hidden} already on the board).' : 'No candidates.', style: muted),
        ),
      for (final c in s.cards)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: McBoardCardTile(card: c, candidate: true, onTap: () => onOpen(c), now: now),
        ),
      if (s.more || s.hidden > 0 && s.cards.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text([if (s.more) 'More in the tracker.', if (s.hidden > 0) '${s.hidden} already on the board.'].join(' '), style: muted),
        ),
    ];
  }
}

/// One card: the title, then source, project, state, the age in its column and the wait badge. [candidate]:
/// the age is how long it has waited to be taken, not how long it has been in a column.
class McBoardCardTile extends StatelessWidget {
  const McBoardCardTile({super.key, required this.card, this.onTap, this.candidate = false, this.now});
  final McBoardCard card;
  final VoidCallback? onTap;
  final bool candidate;
  final DateTime? now;

  /// "3 d in column", "5 h old" (a candidate), or null when the server does not know.
  String? get ageText {
    final at = card.since;
    if (at == null) return null;
    final d = (now ?? DateTime.now()).difference(at);
    return '${mcAge(d.isNegative ? Duration.zero : d)} ${candidate ? 'old' : 'in column'}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final b = card.badge;
    final age = ageText;
    final source = [card.sourceName, if (card.sourceKind == 'ado') 'ADO'].whereType<String>().join(' · ');
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('mc-board-card-${card.key}'),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(border: Border(left: BorderSide(color: b.isNone ? Colors.transparent : mcBadgeColor(b.kind), width: 4))),
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(card.refLabel, style: muted),
            const SizedBox(height: 2),
            Text(card.title ?? card.refLabel,
                key: ValueKey('mc-board-card-title-${card.key}'),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 4, children: [
              if (source.isNotEmpty) McTag(source, key: ValueKey('mc-board-source-chip-${card.key}'), muted: true),
              if (card.project != null) McTag(card.project!, key: ValueKey('mc-board-project-${card.key}'), muted: true),
              if (card.stateLabel != null) McTag(card.stateLabel!, key: ValueKey('mc-board-state-${card.key}'), muted: true),
              if (age != null) McTag(age, key: ValueKey('mc-board-age-${card.key}'), muted: true),
              if (card.handsOff) McTag('hands off', key: ValueKey('mc-board-handsoff-${card.key}'), color: AppColors.caution),
              if (!b.isNone)
                Tooltip(
                  message: b.text ?? b.label,
                  child: McTag(b.label, key: ValueKey('mc-board-badge-${card.key}'), color: mcBadgeColor(b.kind)),
                ),
            ]),
            if (!b.isNone && b.text != null && (b.isYou || b.isSuspect)) ...[
              const SizedBox(height: 4),
              Text(b.text!,
                  key: ValueKey('mc-board-badge-text-${card.key}'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: muted?.copyWith(color: mcBadgeColor(b.kind))),
            ],
            if (!candidate && card.sessions.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                  card.sessions.length == 1
                      ? (card.sessions.first.name ?? card.sessions.first.id)
                      : '${card.sessions.length} sessions',
                  key: ValueKey('mc-board-sessions-${card.key}'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: muted),
            ] else if (!candidate && !card.live) ...[
              const SizedBox(height: 4),
              Text('No session on it', key: ValueKey('mc-board-nosession-${card.key}'), style: muted),
            ],
          ]),
        ),
      ),
    );
  }
}

/// A candidate, opened: what the tracker says about it, and the link to it. It starts nothing (step 2).
class McCandidateSheet extends StatelessWidget {
  const McCandidateSheet({super.key, required this.card, required this.onOpenUrl, this.now});
  final McBoardCard card;
  final void Function(Uri url) onOpenUrl;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final uri = card.url == null ? null : Uri.tryParse(card.url!);
    final link = uri != null && (uri.isScheme('https') || uri.isScheme('http')) ? uri : null;
    final tile = McBoardCardTile(card: card, candidate: true, now: now);
    return AlertDialog(
      key: const ValueKey('mc-candidate-sheet'),
      title: Text(card.refLabel),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(card.title ?? card.refLabel, key: const ValueKey('mc-candidate-title'), style: theme.textTheme.bodyLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 4, children: [
            if (card.sourceName != null) McTag(card.sourceName!, muted: true),
            if (card.project != null) McTag(card.project!, muted: true),
            if (card.type != null) McTag(card.type!, muted: true),
            if (card.station != null) McTag(card.station!, muted: true),
            if (card.priority != null) McTag('priority ${card.priority}', muted: true),
            if (card.severity != null) McTag('severity ${card.severity}', muted: true),
            if (tile.ageText != null) McTag(tile.ageText!, muted: true),
            if (card.handsOff) McTag('hands off', color: AppColors.caution),
          ]),
          const SizedBox(height: 12),
          Text('Nothing is running on this yet. Starting it from the board comes next.', style: muted),
        ]),
      ),
      actions: [
        if (link != null)
          TextButton(key: const ValueKey('mc-candidate-open'), onPressed: () => onOpenUrl(link), child: const Text('Open in tracker')),
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
      ],
    );
  }
}
