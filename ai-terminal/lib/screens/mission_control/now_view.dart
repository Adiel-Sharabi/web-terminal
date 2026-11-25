// #507 - Mission Control's Now screen: what is stuck on the person (Answer now), what
// they parked for the desk (My to-do), what moves on its own, and the projects.
//
// It renders the server's answer (`GET /api/mc/now`, read by [McFeed]) and re-derives
// nothing: the order of the cards, why each ranks, the counts and the stages are all the
// server's. Answering a question or a decision is NOT done here: "Answer" opens the
// questions inbox focused on that session, where the one answer path lives (#383, #492).

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/mc_models.dart';
import '../../api/models.dart' show PendingQuestion;
import '../../services/mc_feed.dart';
import '../../theme/app_theme.dart';
import '../../widgets/empty_state.dart';
import '../../widgets/format_utils.dart';
import '../../widgets/question_overlay.dart' show buildAnswerFrames;
import '../../widgets/timed_snack_bar.dart';
import 'answer_sheet.dart' show McAnswerPort;
import 'card_decision.dart';
import 'lines_view.dart';
import 'question_panel.dart';

/// The hours a card can be put off for (`POST /api/mc/later`, 1-24).
const List<int> kMcLaterHours = [1, 2, 4, 8, 24];

/// Below this width the Now screen is one column (a phone, a narrow window).
const double kMcNowTwoColumns = 900;

/// The Now screen's body. [onAnswer] opens the inbox focused on a card's session;
/// [onOpenSession] opens a session by id.
class McNowView extends StatelessWidget {
  const McNowView({
    super.key,
    required this.feed,
    required this.onAnswer,
    required this.onOpenSession,
    this.onOpenProject,
    this.onOpenLine,
    this.now,
  });

  final McFeed feed;
  final void Function(McCard card) onAnswer;
  final void Function(String sessionId) onOpenSession;

  /// Opens a project's page (#508); null: the project cards are not tappable.
  final void Function(McProject project)? onOpenProject;

  /// Opens a line's page (#523); null: the line cards are not tappable.
  final void Function(McLine line)? onOpenLine;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: feed,
      builder: (context, _) {
        final data = feed.now;
        if (data == null) return _McStateView(feed: feed);
        return RefreshIndicator(
          onRefresh: feed.refresh,
          child: LayoutBuilder(builder: (context, box) {
            final wide = box.maxWidth >= kMcNowTwoColumns;
            // A card names its project by id (as a subject does); the same answer names it.
            final projectNames = {for (final p in data.projects) p.id: p.name};
            final left = <Widget>[
              _AnswerNowSection(
                  feed: feed,
                  cards: data.answerNow,
                  hasActions: data.actions.isNotEmpty,
                  projectNames: projectNames,
                  onAnswer: onAnswer,
                  onOpenSession: onOpenSession,
                  now: now),
              const SizedBox(height: 16),
              McTodoSection(
                  feed: feed,
                  actions: data.actions,
                  todos: data.todo,
                  projectNames: projectNames,
                  onOpenSession: onOpenSession,
                  now: now),
            ];
            final right = <Widget>[
              McMovingLine(moving: data.moving),
              const SizedBox(height: 16),
              // #523: lines replace the projects; an older server sends none.
              if (data.lines != null)
                McLinesSection(lines: data.lines!, onOpen: onOpenLine)
              else
                McProjectsSection(projects: data.projects, onOpen: onOpenProject),
            ];
            return ListView(
              key: const ValueKey('mc-now-list'),
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
              children: [
                if (feed.message != null) McStaleBanner(message: feed.message!, at: feed.receivedAt),
                if (wide)
                  Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Expanded(flex: 3, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left)),
                    const SizedBox(width: 16),
                    Expanded(flex: 2, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right)),
                  ])
                else ...[
                  ...left,
                  const SizedBox(height: 16),
                  ...right,
                ],
              ],
            );
          }),
        );
      },
    );
  }
}

/// What the screen shows while there is no answer: loading, or why there is none.
class _McStateView extends StatelessWidget {
  const _McStateView({required this.feed});
  final McFeed feed;

  @override
  Widget build(BuildContext context) {
    final (icon, title) = switch (feed.status) {
      McStatus.loading => (null, ''),
      McStatus.ok => (null, ''),
      McStatus.noServers => (Icons.dns_outlined, 'No server yet'),
      McStatus.unsupported => (Icons.update, 'No Mission Control yet'),
      McStatus.notListed => (Icons.add_link, 'Mission Control is on another server'),
      McStatus.unreachable => (Icons.cloud_off, 'Mission Control is not reachable'),
    };
    if (icon == null) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: feed.refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 48),
          EmptyState(
            key: ValueKey('mc-state-${feed.status.name}'),
            icon: icon,
            title: title,
            subtitle: feed.message,
          ),
          if (feed.status == McStatus.unreachable)
            Center(
              child: TextButton.icon(
                key: const ValueKey('mc-retry'),
                onPressed: feed.refresh,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
            ),
        ],
      ),
    );
  }
}

/// The last answer is on screen, but the latest ask failed: says so, and how old it is.
class McStaleBanner extends StatelessWidget {
  const McStaleBanner({super.key, required this.message, this.at});
  final String message;
  final DateTime? at;

  @override
  Widget build(BuildContext context) {
    final when = at == null ? '' : ' (shown: ${relativeTime(at!.millisecondsSinceEpoch)})';
    return Card(
      key: const ValueKey('mc-stale'),
      color: AppColors.cautionContainer,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(children: [
          const Icon(Icons.warning_amber_rounded, color: AppColors.caution, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text('$message$when', style: Theme.of(context).textTheme.bodySmall)),
        ]),
      ),
    );
  }
}

Widget mcSectionTitle(BuildContext context, String text, {Key? key, String? hint}) {
  final theme = Theme.of(context);
  return Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
      Text(text, key: key, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
      if (hint != null) ...[
        const SizedBox(width: 8),
        Flexible(
          child: Text(hint,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant)),
        ),
      ],
    ]),
  );
}

String mcAge(Duration d) {
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min';
  if (d.inHours < 24) return '${d.inHours} h';
  return '${d.inDays} d';
}

/// How long a card has waited: the server's `ageMin`, else since `askedAt`, else null.
String? mcCardAge(McCard c, {DateTime? now}) {
  final m = c.why.ageMin;
  if (m != null && m >= 0) return mcAge(Duration(minutes: m));
  final at = c.askedAt;
  if (at == null) return null;
  final d = (now ?? DateTime.now()).difference(at);
  return mcAge(d.isNegative ? Duration.zero : d);
}

Future<void> mcRun(BuildContext context, Future<String?> Function() action) async {
  try {
    final said = await action();
    if (said != null && context.mounted) showTimedSnackBar(context, said);
  } catch (e) {
    if (context.mounted) showTimedSnackBar(context, 'Could not do it: ${e is ApiException ? e.message : '$e'}');
  }
}

class _AnswerNowSection extends StatelessWidget {
  const _AnswerNowSection({
    required this.feed,
    required this.cards,
    required this.onAnswer,
    required this.onOpenSession,
    this.hasActions = false,
    this.projectNames = const {},
    this.now,
  });
  final McFeed feed;
  final List<McCard> cards;

  /// #522: something to DO waits on My to-do, so "nothing is stuck on you" would be untrue.
  final bool hasActions;
  final Map<String, String> projectNames;
  final void Function(McCard) onAnswer;
  final void Function(String) onOpenSession;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      mcSectionTitle(context, 'Answer now (${cards.length})',
          key: const ValueKey('mc-answer-now-title'), hint: 'a session is stuck on you, most blocking first'),
      if (cards.isEmpty)
        Padding(
          key: const ValueKey('mc-answer-now-empty'),
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(hasActions ? 'No question waits on you.' : 'Nothing is stuck on you.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant)),
        ),
      for (final c in cards)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: McAnswerCard(
            key: ValueKey('mc-card-${c.id}'),
            card: c,
            projectName: c.project == null ? null : projectNames[c.project],
            now: now,
            onAnswer: () => onAnswer(c),
            onOpenSession: c.sessionId == null ? null : () => onOpenSession(c.sessionId!),
            onLater: (h) => mcRun(context, () => feed.later(c, h)),
            onTodo: () => mcRun(context, () => feed.addTodo(c)),
          ),
        ),
    ]);
  }
}

/// One Answer-now card: project, ref + title, why it ranks, age, the options, and what
/// can be done with it.
///
/// #541 - an ask or a decision is answered where it is. An option chip on the face answers at
/// once through [onReply] (the home's reply path) after a short Undo; a tap on the card (or its
/// chevron) expands it in place: the context, every option with its consequence, a one-line
/// reply. The card sends nothing itself and decides nothing: the options, their order, the
/// recommended one and the question are the server's.
class McAnswerCard extends StatefulWidget {
  const McAnswerCard({
    super.key,
    required this.card,
    required this.onAnswer,
    required this.onLater,
    required this.onTodo,
    this.onOpenSession,
    this.onReply,
    this.projectName,
    this.now,
  });

  final McCard card;

  /// The project's name, when the answer that carried the card names it; else its id.
  final String? projectName;
  final VoidCallback onAnswer;
  final VoidCallback? onOpenSession;
  final void Function(int hours) onLater;
  final VoidCallback onTodo;

  /// #541 - sends the person's reply to the card's session; null: the scope's answer port's
  /// ([McQuestionScope.answerPort]), and with neither the options only explain.
  final McReply? onReply;
  final DateTime? now;

  @override
  State<McAnswerCard> createState() => _McAnswerCardState();
}

/// Where a reply from the card stands: nothing yet, an option inside its Undo window, on its
/// way, sent (the card should go), or sent and still here after [kMcSentGrace] (the session did
/// not take it: the card answers again).
enum _McReplyPhase { idle, undo, sending, sent, stale }

class _McAnswerCardState extends State<McAnswerCard> {
  bool _open = false;
  _McReplyPhase _phase = _McReplyPhase.idle;

  /// #541 - the AskUserQuestion on the session's screen, read each time a question card is opened
  /// (it may have changed since it was last shown); null while the card is folded. The future never
  /// errors: it starts in a tap and is listened to a frame later, so a read that fails at once
  /// (an unknown session) would be an unhandled error. A failure is its second value.
  Future<(PendingQuestion?, Object?)>? _pending;

  /// The option's label or the person's words, while [_phase] is not idle.
  String? _choice;
  final TextEditingController _text = TextEditingController();

  /// The Undo window's own clock: it ends in the send, and only Undo stops it. It is not the toast
  /// that decides: another toast (a refusal said by the sender, a pick on a second card) hides this
  /// one at once, and that must not send the pick early. Left running when the card is left (the
  /// answer was asked for).
  Timer? _undoTimer;

  /// Which pick the Undo window belongs to: a late tap on the toast of an earlier pick must not
  /// take back a later one.
  int _pickSeq = 0;

  /// Runs out [kMcSentGrace] after a send; a card still here then was not taken.
  Timer? _sentTimer;

  @override
  void dispose() {
    _sentTimer?.cancel();
    _text.dispose();
    super.dispose();
  }

  /// The reply path, when this card can use one: an ask, a possible unreported question or a
  /// decision, of a session the app can name.
  McReply? get _reply {
    final c = widget.card;
    if (c.sessionId == null) return null;
    if (!(c.isAsk || c.isPossibleAsk || (c.kind == 'decision' && c.decision != null))) return null;
    return widget.onReply ?? McQuestionScope.maybeOf(context)?.answerPort?.send;
  }

  /// The answer port, for a card that is a pending AskUserQuestion of a session the app can name.
  McAnswerPort? get _port {
    final c = widget.card;
    return c.kind == 'question' && c.sessionId != null ? McQuestionScope.maybeOf(context)?.answerPort : null;
  }

  bool get _busy => _phase != _McReplyPhase.idle && _phase != _McReplyPhase.stale;

  /// Context and options to show, a sentence to answer, or a question on its session's screen.
  bool get _expandable => widget.card.decision != null || widget.card.isPossibleAsk || _port != null;

  void _toggle() => setState(() {
        _open = !_open;
        final port = _port;
        _pending = _open && port != null
            ? port.pendingQuestion(widget.card).then<(PendingQuestion?, Object?)>((q) => (q, null), onError: (Object e) => (null, e))
            : null;
      });

  /// A decision or ask option tapped: its text is the reply.
  void _pickOption(String label) {
    final send = _reply;
    if (send == null) return;
    final card = widget.card;
    _startPick(label, () => send(card, label));
  }

  /// A pending question's option [i] tapped: the answer is the frames [buildAnswerFrames] makes
  /// for that pick (the panel's own rule), sent for the question the person was shown.
  void _pickQuestionOption(PendingQuestion q, int i) {
    final port = _port;
    if (port == null) return;
    final card = widget.card;
    _startPick(q.questions.single.options[i].label, () => port.answerQuestion(card, q, buildAnswerFrames(q.questions, [<int>{i}])));
  }

  /// An option tapped: for [kMcUndoWindow] it can be taken back (the toast's Undo, or the card's
  /// own "Take it back" - the toast may be gone by then), then [send] runs. With no messenger
  /// there is no Undo to offer, so it goes at once. [label] is what the status line says.
  void _startPick(String label, Future<bool> Function() send) {
    if (_busy) return;
    final seq = ++_pickSeq;
    final toast = showTimedSnackBar(
      context,
      'Answering "$label" - Undo stops it',
      duration: kMcUndoWindow,
      action: SnackBarAction(label: 'Undo', onPressed: () => _undoPick(seq)),
    );
    if (toast == null) {
      unawaited(_deliver(send, label));
      return;
    }
    setState(() {
      _phase = _McReplyPhase.undo;
      _choice = label;
    });
    _undoTimer = Timer(kMcUndoWindow, () {
      _undoTimer = null;
      unawaited(_deliver(send, label));
    });
  }

  /// Takes back the pick inside its window; nothing to take back once it went (a late tap on a
  /// toast that outlived it).
  void _undoPick(int seq) {
    final t = _undoTimer;
    if (t == null || seq != _pickSeq) return;
    t.cancel();
    _undoTimer = null;
    if (mounted) setState(() => _phase = _McReplyPhase.idle);
  }

  /// Runs [send]; true when it went out. A refusal was said by the sender and leaves the card as
  /// it was. The card may have been left meanwhile: the answer still goes (it was asked for).
  /// [shown] is what the status line says was sent.
  Future<bool> _deliver(Future<bool> Function() send, String shown) async {
    if (mounted) {
      setState(() {
        _phase = _McReplyPhase.sending;
        _choice = shown;
      });
    }
    var ok = false;
    try {
      ok = await send();
    } catch (e) {
      if (mounted) showTimedSnackBar(context, 'Could not send: ${e is ApiException ? e.message : '$e'}');
    }
    if (mounted) setState(() => _phase = ok ? _McReplyPhase.sent : _McReplyPhase.idle);
    _sentTimer?.cancel();
    // The card goes when the server drops the ask. One that is still here after the grace was not
    // taken (the agent's screen swallowed the line, #179): it answers again, never stays locked.
    if (ok && mounted) {
      _sentTimer = Timer(kMcSentGrace, () {
        if (mounted && _phase == _McReplyPhase.sent) setState(() => _phase = _McReplyPhase.stale);
      });
    }
    return ok;
  }

  Future<void> _sendTyped() async {
    final send = _reply;
    final words = _text.text.trim();
    if (send == null || words.isEmpty || _busy) return;
    final card = widget.card;
    final ok = await _deliver(() => send(card, words), words);
    if (ok && mounted) _text.clear();
  }

  String? get _status {
    final w = _choice;
    return switch (_phase) {
      _McReplyPhase.idle => null,
      _McReplyPhase.undo => 'About to answer "$w" - Undo stops it',
      _McReplyPhase.sending => 'Sending "$w"...',
      _McReplyPhase.sent => 'Sent "$w". The card goes once the session has it.',
      _McReplyPhase.stale => 'Sent "$w", but the card is still here - the session may not have taken it. Answer again if you need to.',
    };
  }

  /// What an opened question card shows of its question: the options of a simple one, to answer
  /// from here; for any other a line saying it is answered in the sheet; or why it cannot be shown.
  Widget _questionBody(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return FutureBuilder<(PendingQuestion?, Object?)>(
      future: _pending,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done || snap.data == null) {
          return const LinearProgressIndicator(key: ValueKey('mc-card-q-loading'));
        }
        final (q, e) = snap.data!;
        if (e != null) {
          return Text(e is ApiException ? e.message : 'The question could not be read ($e)',
              key: const ValueKey('mc-card-q-error'), style: TextStyle(color: theme.colorScheme.error));
        }
        if (q == null) {
          return Text('This question is no longer on its screen: it was answered, or the session moved on.',
              key: const ValueKey('mc-card-q-gone'), style: muted);
        }
        if (!mcSimpleQuestion(q)) {
          return Text('This question has several parts or a layout of its own: Answer opens it.',
              key: const ValueKey('mc-card-q-sheet'), style: muted);
        }
        return McQuestionOptions(item: q.questions.single, enabled: !_busy, onPick: (i) => _pickQuestionOption(q, i));
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall;
    final muted = small?.copyWith(color: AppColors.onSurfaceVariant);
    final c = widget.card;
    final age = mcCardAge(c, now: widget.now);
    final why = c.why;
    final blocked = [for (final s in why.blockedSessions) ?s.name];
    final heading = [?c.ref, ?c.title].join('  ');
    final session = c.sessionLine;
    final decision = c.decision;
    final questions = McQuestionScope.maybeOf(context);
    final reply = _reply;
    final decisionQuestion = mcDecisionQuestionToShow(c);
    final status = _status;
    // The reply box and the rows only answer when a reply path exists.
    final onPick = reply == null || decision == null ? null : _pickOption;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: _expandable ? _toggle : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Wrap(spacing: 6, runSpacing: 4, children: [
                  if (c.project != null) McTag(widget.projectName ?? c.project!, key: const ValueKey('mc-card-project')),
                  McTag(c.isPossibleAsk ? 'possible unreported question' : c.kind, muted: true),
                  // #526 - a prompt typed into the session since it asked: it may be settled.
                  if (c.maybeAnswered) McTag('may be answered', muted: true, key: const ValueKey('mc-card-maybe-answered')),
                  if (why.severity != null) McTag('severity ${why.severity}', color: AppColors.caution),
                ]),
              ),
              if (age != null) ...[
                const SizedBox(width: 8),
                Text(age, key: const ValueKey('mc-card-age'), style: muted),
              ],
              if (_expandable)
                IconButton(
                  key: const ValueKey('mc-card-expand'),
                  tooltip: _open ? 'Fold the card' : 'Show its context and options',
                  visualDensity: VisualDensity.compact,
                  iconSize: 20,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 32, minHeight: 28),
                  icon: Icon(_open ? Icons.expand_less : Icons.expand_more),
                  onPressed: _toggle,
                ),
            ]),
            const SizedBox(height: 6),
            // #541: a card the server says is about no item (no ref, no title) has the question itself
            // for a heading - never a title borrowed from another item - and the session's name
            // stands beneath it (the line below); the question is then not printed a second time.
            // A question card's own words ("answer a question") say nothing: its questions follow.
            Text(heading.isNotEmpty ? heading : ((c.kind == 'question' ? null : c.what) ?? c.sessionName ?? 'A session'),
                key: const ValueKey('mc-card-heading'),
                // A question for a heading can run to 240 characters: folded, a few lines of it.
                maxLines: _open ? null : 4,
                overflow: _open ? TextOverflow.visible : TextOverflow.ellipsis,
                style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
            // #531: a question card shows the questions themselves; its own words ("answer a
            // question") say nothing about what is asked.
            if (c.kind == 'question') ...[
              const SizedBox(height: 4),
              McCardQuestions(questions: c.questions),
            ] else if (c.what != null && heading.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(c.what!,
                  key: const ValueKey('mc-card-what'),
                  maxLines: _open ? null : 3,
                  overflow: _open ? TextOverflow.visible : TextOverflow.ellipsis,
                  style: c.maybeAnswered ? muted : null),
            ],
            // #541: the decision's own question only when the line above does not already say it.
            if (decisionQuestion != null) ...[
              const SizedBox(height: 4),
              Text(decisionQuestion, key: const ValueKey('mc-card-decision-question'), style: small),
            ],
            if (decision != null) ...[
              const SizedBox(height: 4),
              if (_open)
                McCardDetail(
                  decision: decision,
                  controller: _text,
                  enabled: !_busy,
                  onPick: onPick,
                  onSend: reply == null ? null : _sendTyped,
                )
              else
                McCardOptionChips(decision: decision, onPick: onPick, enabled: !_busy),
            ] else if (_open && reply != null) ...[
              const SizedBox(height: 4),
              McCardDetail(decision: null, controller: _text, enabled: !_busy, onPick: null, onSend: _sendTyped),
            ],
            // #541: a pending AskUserQuestion, read when the card was opened.
            if (_open && _pending != null) ...[
              const SizedBox(height: 4),
              _questionBody(context),
            ],
            if (status != null) ...[
              const SizedBox(height: 4),
              Row(children: [
                Expanded(
                  child: Text(status,
                      key: ValueKey(_phase == _McReplyPhase.sent ? 'mc-card-sent' : 'mc-card-status'),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: small?.copyWith(color: AppColors.primary)),
                ),
                if (_phase == _McReplyPhase.undo)
                  TextButton(
                    key: const ValueKey('mc-card-undo'),
                    onPressed: () => _undoPick(_pickSeq),
                    child: const Text('Take it back'),
                  ),
              ]),
            ],
            if (why.text != null || blocked.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                [
                  ?why.text,
                  if (blocked.isNotEmpty) 'waiting: ${blocked.join(', ')}',
                ].join(' - '),
                key: const ValueKey('mc-card-why'),
                // An ask holds nobody up: its line says what the session does instead, not a warning.
                style: small?.copyWith(color: c.blocking ? AppColors.caution : AppColors.onSurfaceVariant),
              ),
            ],
            if (session.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(session, style: muted),
            ],
            const SizedBox(height: 2),
            Wrap(spacing: 2, children: [
              if (c.answerable)
                TextButton.icon(
                  key: const ValueKey('mc-card-answer'),
                  // #541: an ask is answered on the card, not in a dialog over it.
                  onPressed: c.usesReplyDialog && reply != null ? () => setState(() => _open = true) : widget.onAnswer,
                  icon: const Icon(Icons.reply, size: 18),
                  label: const Text('Answer'),
                ),
              if (widget.onOpenSession != null)
                TextButton.icon(
                  key: const ValueKey('mc-card-open'),
                  onPressed: widget.onOpenSession,
                  icon: const Icon(Icons.open_in_new, size: 18),
                  label: const Text('Open session'),
                ),
              // #531 - one tap to ask the Analyst about this card; the session never sees it.
              if (questions != null)
                TextButton.icon(
                  key: const ValueKey('mc-card-ask'),
                  onPressed: () => questions.open(context, c, askFirst: true),
                  icon: const Icon(Icons.help_outline, size: 18),
                  label: const Text('Ask about this'),
                ),
              // #510 - the card's context at three levels, follow-ups, suggested options.
              if (questions != null)
                TextButton(
                  key: const ValueKey('mc-card-context'),
                  onPressed: () => questions.open(context, c),
                  child: const Text('More context'),
                ),
              PopupMenuButton<int>(
                key: const ValueKey('mc-card-later'),
                tooltip: 'Later: hide it for a while; it comes back if it still waits',
                onSelected: widget.onLater,
                itemBuilder: (_) => [
                  for (final h in kMcLaterHours)
                    PopupMenuItem(
                        key: ValueKey('mc-later-$h'), value: h, child: Text(h == 1 ? 'In an hour' : 'In $h hours')),
                ],
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Text('Later', style: TextStyle(color: AppColors.primary)),
                ),
              ),
              TextButton(
                key: const ValueKey('mc-card-todo'),
                onPressed: widget.onTodo,
                child: const Text('To my to-do'),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// How many of a question card's questions its face shows; the rest are counted ("+2 more").
const int kMcCardQuestionsShown = 2;

/// #531 - what a question card asks: each question's header and text (the server's one line
/// each), the first [kMcCardQuestionsShown], then "+N more". A card whose question could not
/// be read says so instead.
class McCardQuestions extends StatelessWidget {
  const McCardQuestions({super.key, required this.questions});
  final List<McCardQuestion> questions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    if (questions.isEmpty) {
      return Text('A question is on its screen; its text could not be read here.',
          key: const ValueKey('mc-card-q-unread'), style: muted);
    }
    final shown = questions.take(kMcCardQuestionsShown).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (var i = 0; i < shown.length; i++)
        Padding(
          key: ValueKey('mc-card-q-$i'),
          padding: EdgeInsets.only(bottom: i == shown.length - 1 ? 0 : 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (shown[i].header != null)
              Text(shown[i].header!, style: theme.textTheme.labelMedium?.copyWith(color: AppColors.primary, fontWeight: FontWeight.w600)),
            Text(shown[i].text, maxLines: 3, overflow: TextOverflow.ellipsis),
          ]),
        ),
      if (questions.length > shown.length)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('+${questions.length - shown.length} more', key: const ValueKey('mc-card-q-more'), style: muted),
        ),
    ]);
  }
}

class McTag extends StatelessWidget {
  const McTag(this.text, {super.key, this.muted = false, this.color});
  final String text;
  final bool muted;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? (muted ? AppColors.onSurfaceVariant : AppColors.primary);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        border: Border.all(color: c.withValues(alpha: 0.6)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(text, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: c)),
    );
  }
}

/// My to-do: what sessions wait for the person to DO (#522 actions, ranked by what they
/// unblock, each with its steps, where and a Done), then what the person parked for the desk.
/// Open ones first; done ones folded.
class McTodoSection extends StatefulWidget {
  const McTodoSection({
    super.key,
    required this.feed,
    required this.todos,
    required this.onOpenSession,
    this.actions = const [],
    this.projectNames = const {},
    this.now,
  });
  final McFeed feed;
  final List<McTodo> todos;

  /// #522: the action cards, in the server's order.
  final List<McCard> actions;
  final Map<String, String> projectNames;
  final void Function(String sessionId) onOpenSession;
  final DateTime? now;

  @override
  State<McTodoSection> createState() => _McTodoSectionState();
}

class _McTodoSectionState extends State<McTodoSection> {
  bool _doneOpen = false;

  @override
  Widget build(BuildContext context) {
    final open = widget.todos.where((t) => !t.done).toList();
    final done = widget.todos.where((t) => t.done).toList();
    final muted = Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant);
    final actions = widget.actions;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      mcSectionTitle(context, 'My to-do (${actions.length + open.length})',
          key: const ValueKey('mc-todo-title'), hint: 'things to do; a session waits for the first ones'),
      if (open.isEmpty && actions.isEmpty)
        Padding(
          key: const ValueKey('mc-todo-empty'),
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text('Nothing to do.', style: muted),
        ),
      for (final c in actions)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: McActionCard(
            key: ValueKey('mc-action-${c.id}'),
            card: c,
            projectName: c.project == null ? null : widget.projectNames[c.project],
            now: widget.now,
            onDone: () => mcRun(context, () => widget.feed.actionDone(c)),
            onLater: (h) => mcRun(context, () => widget.feed.later(c, h)),
            onOpenSession: c.sessionId == null ? null : () => widget.onOpenSession(c.sessionId!),
          ),
        ),
      for (final t in open) _row(t),
      if (done.isNotEmpty)
        TextButton.icon(
          key: const ValueKey('mc-todo-done-toggle'),
          onPressed: () => setState(() => _doneOpen = !_doneOpen),
          icon: Icon(_doneOpen ? Icons.expand_less : Icons.expand_more),
          label: Text('Done (${done.length})'),
        ),
      if (_doneOpen) for (final t in done) _row(t),
    ]);
  }

  Widget _row(McTodo t) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final headline = t.text ?? t.title ?? t.ref ?? 'To-do';
    final line = [
      if (t.text != null) ...[?t.ref, ?t.title] else if (t.title != null) ?t.ref,
      ?t.project,
      if (t.createdAt != null) relativeTime(t.createdAt!.millisecondsSinceEpoch, now: widget.now),
    ].join(' · ');
    void act(String action) => mcRun(context, () => widget.feed.todoAction(t, action));
    // The park message, when the session was NOT told: why, and the one way to try again.
    final park = t.park;
    final notTold = t.done
        ? null
        : park.notSent
            ? 'Its session was not told: ${park.reason ?? park.refused ?? 'refused'}'
            : (park.maybeSent ? 'The message may have reached its session' : null);
    return Card(
      key: ValueKey('mc-todo-${t.id}'),
      margin: const EdgeInsets.only(bottom: 6),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(headline,
                  style: t.done
                      ? theme.textTheme.bodyMedium?.copyWith(decoration: TextDecoration.lineThrough, color: AppColors.onSurfaceVariant)
                      : theme.textTheme.bodyMedium),
              if (line.isNotEmpty) Text(line, style: muted),
              if (notTold != null)
                Text(notTold, key: ValueKey('mc-todo-park-${t.id}'), style: muted?.copyWith(color: AppColors.caution)),
            ]),
          ),
          if (t.done)
            TextButton(key: ValueKey('mc-todo-reopen-${t.id}'), onPressed: () => act('reopen'), child: const Text('Reopen'))
          else ...[
            if (park.isRefused)
              IconButton(
                key: ValueKey('mc-todo-tell-${t.id}'),
                tooltip: 'Tell its session again',
                icon: const Icon(Icons.send, size: 18),
                onPressed: () => act('park'),
              ),
            if (t.sessionId != null)
              IconButton(
                tooltip: 'Open its session',
                icon: const Icon(Icons.open_in_new, size: 18),
                onPressed: () => widget.onOpenSession(t.sessionId!),
              ),
            IconButton(
              key: ValueKey('mc-todo-back-${t.id}'),
              tooltip: 'Back to Answer now',
              icon: const Icon(Icons.undo, size: 18),
              onPressed: () => act('back'),
            ),
            IconButton(
              key: ValueKey('mc-todo-done-${t.id}'),
              tooltip: 'Done',
              icon: const Icon(Icons.check, size: 18),
              onPressed: () => act('done'),
            ),
          ],
        ]),
      ),
    );
  }
}

/// #522 - one thing a session waits for the person to DO: what, where, the steps in order,
/// what it unblocks, and Done (tells the session once) or Not now. Never phrased as a question.
class McActionCard extends StatelessWidget {
  const McActionCard({
    super.key,
    required this.card,
    required this.onDone,
    required this.onLater,
    this.onOpenSession,
    this.projectName,
    this.now,
  });

  final McCard card;
  final String? projectName;
  final VoidCallback onDone;
  final void Function(int hours) onLater;
  final VoidCallback? onOpenSession;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall;
    final muted = small?.copyWith(color: AppColors.onSurfaceVariant);
    final c = card;
    final age = mcCardAge(c, now: now);
    final steps = c.action?.steps ?? const <String>[];
    final where = c.action?.where;
    final heading = [?c.ref, ?c.title].join('  ');
    final session = c.sessionLine;
    final done = c.done;
    final notTold = done != null && done.notSent ? 'Its session was not told: ${done.reason ?? done.refused ?? 'refused'}' : null;
    // It may have landed (no answer came): never sent twice, so no Done; the card goes once
    // its session's wait ends.
    final maybeTold = done != null && done.maybeSent;
    // Told (a subject's card until its wait leaves the view): never offered again.
    final told = done != null && done.state == 'delivered';
    final unblocks = c.why.text;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                if (c.project != null) McTag(projectName ?? c.project!),
                const McTag('to do', muted: true),
                if (where != null)
                  Row(key: const ValueKey('mc-action-where'), mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.place_outlined, size: 14, color: AppColors.caution),
                    const SizedBox(width: 2),
                    Text(where, style: small?.copyWith(color: AppColors.caution, fontWeight: FontWeight.w600)),
                  ]),
              ]),
            ),
            if (age != null) ...[
              const SizedBox(width: 8),
              Text(age, style: muted),
            ],
          ]),
          const SizedBox(height: 6),
          Text(c.what ?? (heading.isEmpty ? 'Something to do' : heading),
              key: const ValueKey('mc-action-what'),
              style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
          if (c.what != null && heading.isNotEmpty) Text(heading, style: muted),
          if (steps.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (var i = 0; i < steps.length; i++)
              Padding(
                key: ValueKey('mc-action-step-$i'),
                padding: const EdgeInsets.only(bottom: 2),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 22, child: Text('${i + 1}.', style: muted)),
                  Expanded(child: Text(steps[i], style: theme.textTheme.bodyMedium)),
                ]),
              ),
          ],
          if (unblocks != null) ...[
            const SizedBox(height: 4),
            Text('Done unblocks: ${unblocks.replaceFirst('blocks ', '')}',
                key: const ValueKey('mc-action-why'), style: small?.copyWith(color: AppColors.caution)),
          ],
          if (session.isNotEmpty) Text(session, style: muted),
          if (notTold != null) ...[
            const SizedBox(height: 2),
            Text(notTold, key: const ValueKey('mc-action-not-told'), style: small?.copyWith(color: AppColors.caution)),
          ],
          if (told) ...[
            const SizedBox(height: 2),
            Text('Done: its session was told to carry on.', key: const ValueKey('mc-action-told'), style: muted),
          ],
          if (maybeTold) ...[
            const SizedBox(height: 2),
            Text('Done was sent; it may have reached its session. It goes once the session carries on.',
                key: const ValueKey('mc-action-maybe-told'), style: muted),
          ],
          const SizedBox(height: 4),
          Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (!maybeTold && !told)
              FilledButton.tonalIcon(
                key: const ValueKey('mc-action-done'),
                onPressed: onDone,
                icon: const Icon(Icons.check, size: 18),
                label: const Text('Done'),
              ),
            if (onOpenSession != null)
              TextButton.icon(
                onPressed: onOpenSession,
                icon: const Icon(Icons.open_in_new, size: 18),
                label: const Text('Open session'),
              ),
            PopupMenuButton<int>(
              key: const ValueKey('mc-action-later'),
              tooltip: 'Not now: hide it for a while; it comes back if the session still waits',
              onSelected: onLater,
              itemBuilder: (_) => [
                for (final h in kMcLaterHours)
                  PopupMenuItem(value: h, child: Text(h == 1 ? 'In an hour' : 'In $h hours')),
              ],
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Text('Not now', style: TextStyle(color: AppColors.primary)),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}

/// "Moving on its own": the sessions nobody needs to look at.
class McMovingLine extends StatelessWidget {
  const McMovingLine({super.key, required this.moving});
  final McMoving moving;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      mcSectionTitle(context, 'Moving on its own'),
      Text(
        '${moving.working} working · ${moving.idle} idle · ${moving.total} in all',
        key: const ValueKey('mc-moving'),
        style: theme.textTheme.bodyMedium,
      ),
    ]);
  }
}

/// The projects, each a card with its area labels and its stage bar.
class McProjectsSection extends StatelessWidget {
  const McProjectsSection({super.key, required this.projects, this.title = 'Projects', this.onOpen});
  final List<McProject> projects;
  final String title;

  /// Opens a project's page (#508); null: the cards are not tappable.
  final void Function(McProject project)? onOpen;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      mcSectionTitle(context, title),
      if (projects.isEmpty)
        Text('No project has work yet.',
            key: const ValueKey('mc-projects-empty'),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant)),
      for (final p in projects)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: McProjectCard(key: ValueKey('mc-project-${p.id}'), project: p, onTap: onOpen == null ? null : () => onOpen!(p)),
        ),
    ]);
  }
}

/// A project's (or an area's) counts in one line, as the server counted them.
String mcCountsLine(McCounts k) => [
      if (k.needsYou > 0) '${k.needsYou} need you',
      if (k.waitsOnOthers > 0) '${k.waitsOnOthers} waiting on others',
      '${k.active} active',
      if (k.doneWeek > 0) '${k.doneWeek} done this week',
      '${k.sessions} sessions',
    ].join(' · ');

class McProjectCard extends StatelessWidget {
  const McProjectCard({super.key, required this.project, this.onTap});
  final McProject project;

  /// Opens the project's page; null: not tappable.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final p = project;
    final k = p.counts;
    final counts = mcCountsLine(k);
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(p.name, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600))),
            if (p.trackerLabel != null) ...[
              const SizedBox(width: 8),
              Flexible(child: Text(p.trackerLabel!, style: muted, overflow: TextOverflow.ellipsis)),
            ],
          ]),
          const SizedBox(height: 4),
          Text(counts, key: const ValueKey('mc-project-counts'), style: theme.textTheme.bodySmall),
          if (k.stages.isNotEmpty && k.stageTotal > 0) ...[
            const SizedBox(height: 8),
            McStageBar(stages: k.stages),
          ],
          if (p.areas.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 4, children: [
              for (final a in p.areas)
                Chip(
                  key: ValueKey('mc-area-${a.id}'),
                  visualDensity: VisualDensity.compact,
                  label: Text(a.counts.needsYou > 0 ? '${a.name} · ${a.counts.active} · ${a.counts.needsYou} need you' : '${a.name} · ${a.counts.active}'),
                ),
            ]),
          ],
        ]),
      ),
      ),
    );
  }
}

/// How a project's subjects spread over the progress stages, in the server's order. The
/// colours run from muted (early) to the primary colour (late) by POSITION, so the bar
/// needs no table of stage names.
class McStageBar extends StatelessWidget {
  const McStageBar({super.key, required this.stages});
  final List<McStageCount> stages;

  static Color colorAt(int i, int n) =>
      Color.lerp(AppColors.outline, AppColors.primary, n <= 1 ? 1 : i / (n - 1)) ?? AppColors.primary;

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).textTheme.labelSmall?.copyWith(color: AppColors.onSurfaceVariant);
    final n = stages.length;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: SizedBox(
          key: const ValueKey('mc-stage-bar'),
          height: 8,
          child: Row(children: [
            for (var i = 0; i < n; i++)
              if (stages[i].count > 0)
                Expanded(
                  key: ValueKey('mc-stage-${stages[i].stage}'),
                  flex: stages[i].count,
                  child: ColoredBox(color: colorAt(i, n)),
                ),
          ]),
        ),
      ),
      const SizedBox(height: 4),
      Wrap(spacing: 10, children: [
        for (var i = 0; i < n; i++)
          if (stages[i].count > 0)
            Row(mainAxisSize: MainAxisSize.min, children: [
              Container(width: 8, height: 8, color: colorAt(i, n)),
              const SizedBox(width: 4),
              Text('${stages[i].name} ${stages[i].count}', style: muted),
            ]),
      ]),
    ]);
  }
}
