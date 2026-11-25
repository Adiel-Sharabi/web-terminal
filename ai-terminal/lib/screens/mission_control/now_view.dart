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
          // #550: a pull asks to see the latest list: the cards held back are shown with it.
          onRefresh: () => feed.refresh(show: true),
          child: LayoutBuilder(builder: (context, box) {
            final wide = box.maxWidth >= kMcNowTwoColumns;
            // A card names its project by id (as a subject does); the same answer names it.
            final projectNames = {for (final p in data.projects) p.id: p.name};
            final left = <Widget>[
              _AnswerNowSection(
                  feed: feed,
                  cards: data.answerNow,
                  epoch: feed.seenEpoch,
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

/// How long after a change above it the card in use is held where it was: the collapse of an
/// answered card above it runs for [kMcCollapse], and a little more is left for the frame it ends in.
const Duration kMcAnchorSpan = Duration(milliseconds: 450);

/// #550 - Answer now: the cards the person has on screen, held still.
///
/// What is listed is the server's, but WHEN it changes on screen is the person's: a card already
/// shown keeps its place and its slot in the order while other cards arrive. Those wait behind an
/// "N new" pill and join the list when the person asks to see the latest ([McFeed.seenEpoch]: the
/// pill, a pull to refresh, coming back to Mission Control), or at once when no card is shown
/// (there is nothing to move). A card the server drops goes at once, and the scroll stays anchored
/// on the card in use so the ones above it never push it. A card the person answered is the one
/// exception to "goes at once": its "Answered" row stays until it has faded out.
class _AnswerNowSection extends StatefulWidget {
  const _AnswerNowSection({
    required this.feed,
    required this.cards,
    required this.epoch,
    required this.onAnswer,
    required this.onOpenSession,
    this.hasActions = false,
    this.projectNames = const {},
    this.now,
  });
  final McFeed feed;

  /// The server's list, in its order.
  final List<McCard> cards;

  /// [McFeed.seenEpoch]: a new value shows the whole of [cards].
  final int epoch;

  /// #522: something to DO waits on My to-do, so "nothing is stuck on you" would be untrue.
  final bool hasActions;
  final Map<String, String> projectNames;
  final void Function(McCard) onAnswer;
  final void Function(String) onOpenSession;
  final DateTime? now;

  @override
  State<_AnswerNowSection> createState() => _AnswerNowSectionState();
}

class _AnswerNowSectionState extends State<_AnswerNowSection> {
  /// What is on screen, in the order it was shown.
  late List<McCard> _shown = [...widget.cards];

  /// What each shown card says about itself ([McAnswerCard.onUse]); absent: idle.
  final Map<String, McCardUse> _use = {};
  final Map<String, GlobalKey> _boxes = {};

  /// The ids that reported [McCardUse.inUse], the latest last: the person is on the latest one.
  final List<String> _useOrder = [];

  /// The card the scroll is held on while something above it changes, where its top was, whether a
  /// hold is running (from [_anchorSince], the stamp of its first frame, for [kMcAnchorSpan]), and
  /// where the scroll stood when we last set it (a different value is the person's own scrolling).
  String? _anchorId;
  double? _anchorY;
  double _anchorPixels = 0;
  bool _anchoring = false;
  Duration? _anchorSince;

  McCardUse _useOf(String id) => _use[id] ?? McCardUse.idle;

  /// A card that is no longer a question the person has: answered (its row is leaving) or gone.
  bool _spent(String id) => _useOf(id) == McCardUse.answered || _useOf(id) == McCardUse.gone;

  bool _listed(String id) => widget.cards.any((c) => c.id == id);

  @override
  void didUpdateWidget(_AnswerNowSection old) {
    super.didUpdateWidget(old);
    final merge = widget.epoch != old.epoch;
    if (!merge && identical(widget.cards, old.cards)) return;
    final live = _shown.where((c) => !_spent(c.id)).toList();
    final byId = {for (final c in widget.cards) c.id: c};
    // The whole list when the person asked for it, or when nothing live is shown for a new card to
    // move. A card the server dropped while its answered row is still leaving keeps that row.
    // Anything else keeps what is shown, in the order it was shown.
    if (merge || live.isEmpty) {
      _shown = [
        ...widget.cards,
        for (final c in _shown)
          if (!byId.containsKey(c.id) && _useOf(c.id) == McCardUse.answered) c,
      ];
    } else {
      final next = [
        for (final c in _shown)
          if (byId[c.id] != null) byId[c.id]! else if (_useOf(c.id) == McCardUse.answered) c,
      ];
      // Only a card that went, or the "N new" pill coming or going, can move what is below: a poll
      // that changed nothing on screen holds nothing (and so never fights the person's own scrolling).
      final shownIds = {for (final c in _shown) c.id};
      final nextIds = {for (final c in next) c.id};
      final pillBefore = old.cards.any((c) => !shownIds.contains(c.id));
      final pillAfter = widget.cards.any((c) => !nextIds.contains(c.id));
      // The card in use may be the one that went: then the other card in use is the one to hold.
      if (next.length != _shown.length || pillBefore != pillAfter) {
        _holdAnchor(_inUseId(except: {for (final id in shownIds) if (!nextIds.contains(id)) id}));
      }
      _shown = next;
    }
    _forgetUnshown();
  }

  void _forgetUnshown() {
    final ids = {for (final c in _shown) c.id};
    _use.removeWhere((id, _) => !ids.contains(id));
    _boxes.removeWhere((id, _) => !ids.contains(id));
    _useOrder.removeWhere((id) => !ids.contains(id));
  }

  /// A card's own report of itself. The answered row of a card the server no longer lists is done
  /// with once it has gone.
  void _onUse(String id, McCardUse use) {
    if (!mounted) return;
    // Held before the card changes height: a card that opens is the one the person is on, so it stays;
    // one that folds or goes holds the card the person is still on (never itself).
    _holdAnchor(use == McCardUse.inUse ? id : _inUseId(except: {id}));
    _useOrder.remove(id);
    if (use == McCardUse.inUse) _useOrder.add(id);
    setState(() {
      if (use == McCardUse.idle) {
        _use.remove(id);
      } else {
        _use[id] = use;
      }
      if (use == McCardUse.gone && !_listed(id)) {
        _shown = [for (final c in _shown) if (c.id != id) c];
        _forgetUnshown();
      }
    });
  }

  // --- the scroll stays anchored on the card in use --------------------------------------------

  /// The card in use that reported last: the one the person is working on ([except]: not these,
  /// which are just leaving use or going).
  String? _inUseId({Set<String> except = const {}}) {
    for (final id in _useOrder.reversed) {
      if (!except.contains(id) && _useOf(id) == McCardUse.inUse && _boxes.containsKey(id)) return id;
    }
    return null;
  }

  double? _topOf(String id) {
    final box = _boxes[id]?.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize) return null;
    return box.localToGlobal(Offset.zero).dy;
  }

  /// Called BEFORE something above the card [id] may change its height (the layout it would be
  /// measured against is still the last one): notes where that card is, and from the next frame on
  /// scrolls it back there for [kMcAnchorSpan]. The first note of a run wins: the
  /// target is where the card was before anything moved it. A scroll that is not ours since the
  /// last note (a finger, a wheel, the scrollbar) starts the run afresh from where the person is.
  void _holdAnchor(String? id) {
    if (id == null) return;
    final pos = Scrollable.maybeOf(context)?.position;
    if (pos == null || !pos.hasPixels) return;
    final moved = (pos.pixels - _anchorPixels).abs() > 0.5;
    if (!_anchoring || _anchorId != id || moved) {
      final y = _topOf(id);
      if (y == null) return;
      _anchorId = id;
      _anchorY = y;
      _anchorPixels = pos.pixels;
    }
    _anchorSince = null; // the span runs from the next frame
    if (!_anchoring) {
      _anchoring = true;
      _nextAnchorFrame();
    }
  }

  /// One more look after the next frame. A post-frame callback does not ask for a frame, so the run
  /// asks for one itself: it ends [kMcAnchorSpan] after its first frame, never stalls half way.
  void _nextAnchorFrame() {
    WidgetsBinding.instance.addPostFrameCallback(_keepAnchor);
    WidgetsBinding.instance.scheduleFrame();
  }

  void _keepAnchor(Duration stamp) {
    if (!mounted || !_anchoring) return;
    final pos = Scrollable.maybeOf(context)?.position;
    // The person wins: a finger on the list, or a scroll we did not make (a mouse wheel and the
    // scrollbar never set isScrollingNotifier, but they move the offset).
    if (pos == null || !pos.hasPixels || pos.isScrollingNotifier.value || (pos.pixels - _anchorPixels).abs() > 0.5) {
      _anchoring = false;
      return;
    }
    final id = _anchorId;
    final want = _anchorY;
    if (id != null && want != null) {
      final at = _topOf(id);
      if (at != null && (at - want).abs() > 0.5) {
        pos.jumpTo((pos.pixels + (at - want)).clamp(pos.minScrollExtent, pos.maxScrollExtent));
      }
    }
    _anchorPixels = pos.pixels;
    final since = _anchorSince ??= stamp;
    if (stamp - since >= kMcAnchorSpan) {
      _anchoring = false;
      return;
    }
    _nextAnchorFrame();
  }

  @override
  Widget build(BuildContext context) {
    final shownIds = {for (final c in _shown) c.id};
    final held = widget.cards.where((c) => !shownIds.contains(c.id)).length;
    final live = _shown.where((c) => !_spent(c.id)).length;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      mcSectionTitle(context, 'Answer now ($live)',
          key: const ValueKey('mc-answer-now-title'), hint: 'a session is stuck on you, most blocking first'),
      if (held > 0)
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: ActionChip(
              key: const ValueKey('mc-new-pill'),
              avatar: const Icon(Icons.arrow_upward, size: 16),
              label: Text('$held new'),
              tooltip: 'Show the ${held == 1 ? 'card' : 'cards'} that arrived while you were here',
              onPressed: widget.feed.showLatest,
            ),
          ),
        ),
      if (live == 0)
        Padding(
          key: const ValueKey('mc-answer-now-empty'),
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(widget.hasActions ? 'No question waits on you.' : 'Nothing is stuck on you.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceVariant)),
        ),
      for (final c in _shown)
        AnimatedPadding(
          key: _boxes.putIfAbsent(c.id, GlobalKey.new),
          duration: kMcCollapse,
          padding: EdgeInsets.only(bottom: _useOf(c.id) == McCardUse.gone ? 0 : 8),
          child: McAnswerCard(
            key: ValueKey('mc-card-${c.id}'),
            card: c,
            sent: widget.feed.sentFor(c.id),
            projectName: c.project == null ? null : widget.projectNames[c.project],
            now: widget.now,
            onAnswer: () => widget.onAnswer(c),
            onOpenSession: c.sessionId == null ? null : () => widget.onOpenSession(c.sessionId!),
            onLater: (h) => mcRun(context, () => widget.feed.later(c, h)),
            onTodo: () => mcRun(context, () => widget.feed.addTodo(c)),
            // #547: a wait the person may have answered in another session is told so, in one tap.
            onTell: c.answeredIn == null ? null : () => mcRun(context, () => widget.feed.tellAnswered(c)),
            onUse: (use) => _onUse(c.id, use),
          ),
        ),
    ]);
  }
}

/// #550 - what an Answer-now card tells its list about itself.
enum McCardUse {
  /// Untouched (or answered and still here: it asks again).
  idle,

  /// Open, or being answered (inside its Undo window, or on its way): the list holds the scroll on it.
  inUse,

  /// Answered and folded into its "Answered" row, which is about to fade: not counted.
  answered,

  /// Answered, faded out and out of the way. It stays, unseen, while the server still lists it (it
  /// comes back as "not taken" if it is still there after the grace).
  gone,
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
    this.onTell,
    this.onUse,
    this.sent,
    this.projectName,
    this.now,
  });

  final McCard card;

  /// #550 - the latest answer that went out for this card from anywhere in the app ([McFeed.sentFor]):
  /// one that was not typed on the card (the answer sheet, the ask dialog) folds it into its
  /// "Answered" row all the same.
  final McSent? sent;

  /// #550 - told whenever what the card is doing changes ([McCardUse]): the list holds the scroll on
  /// a card in use and does not count one that was answered.
  final void Function(McCardUse use)? onUse;

  /// The project's name, when the answer that carried the card names it; else its id.
  final String? projectName;
  final VoidCallback onAnswer;
  final VoidCallback? onOpenSession;
  final void Function(int hours) onLater;
  final VoidCallback onTodo;

  /// #547 - tells the card's session its wait was answered in another session ([McCard.answeredIn]);
  /// null: no Tell it (the card is not marked, or the screen cannot send it).
  final VoidCallback? onTell;

  /// #541 - sends the person's reply to the card's session; null: the scope's answer port's
  /// ([McQuestionScope.answerPort]), and with neither the options only explain.
  final McReply? onReply;
  final DateTime? now;

  @override
  State<McAnswerCard> createState() => _McAnswerCardState();
}

/// Where a reply from the card stands: nothing yet, an option inside its Undo window, on its
/// way, sent (#550: the card folds into its "Answered" row, then fades out), or sent and still
/// listed after [kMcSentGrace] (the session did not take it: the card is back and answers again).
enum _McReplyPhase { idle, undo, sending, sent, stale }

class _McAnswerCardState extends State<McAnswerCard> {
  bool _open = false;
  _McReplyPhase _phase = _McReplyPhase.idle;

  /// #550 - while [_phase] is sent: the "Answered" row is fading, then out of the way (no space).
  bool _faded = false;
  bool _hidden = false;
  Timer? _fadeTimer;
  Timer? _hideTimer;
  McCardUse _reported = McCardUse.idle;

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

  /// The [McSent.seq] of the latest answer this card has taken account of (set in [initState]: a
  /// lazy initializer would first run in [didUpdateWidget], against the new widget).
  int _sentSeen = 0;

  @override
  void initState() {
    super.initState();
    _sentSeen = widget.sent?.seq ?? 0;
  }

  @override
  void didUpdateWidget(McAnswerCard old) {
    super.didUpdateWidget(old);
    final s = widget.sent;
    if (s == null || s.seq == _sentSeen) return;
    _sentSeen = s.seq;
    // An answer typed on this card is already on its way through [_deliver]; one that went out from
    // the answer sheet or the ask dialog folds an idle card (or one that came back as "not taken").
    // Told after the frame: the list is told of a change of use, and it is building now.
    if (_phase != _McReplyPhase.idle && _phase != _McReplyPhase.stale) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || (_phase != _McReplyPhase.idle && _phase != _McReplyPhase.stale)) return;
      _set(() {
        _phase = _McReplyPhase.sent;
        _choice = s.shown;
        _faded = false;
        _hidden = false;
      });
      _armSentTimers();
    });
  }

  @override
  void dispose() {
    _sentTimer?.cancel();
    _fadeTimer?.cancel();
    _hideTimer?.cancel();
    _text.dispose();
    super.dispose();
  }

  /// What the list is told this card is doing (#550).
  McCardUse get _use {
    if (_phase == _McReplyPhase.sent) return _hidden ? McCardUse.gone : McCardUse.answered;
    return _open || _busy ? McCardUse.inUse : McCardUse.idle;
  }

  /// [setState], then tells the list when the card's use changed.
  void _set(VoidCallback fn) {
    setState(fn);
    final use = _use;
    if (use == _reported) return;
    _reported = use;
    widget.onUse?.call(use);
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

  void _toggle() => _set(() {
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
    _set(() {
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
    if (mounted) _set(() => _phase = _McReplyPhase.idle);
  }

  /// Runs [send]; true when it went out. A refusal was said by the sender and leaves the card as
  /// it was. The card may have been left meanwhile: the answer still goes (it was asked for).
  /// [shown] is what the status line says was sent.
  Future<bool> _deliver(Future<bool> Function() send, String shown) async {
    if (mounted) {
      _set(() {
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
    _sentTimer?.cancel();
    _fadeTimer?.cancel();
    _hideTimer?.cancel();
    if (mounted) {
      _set(() {
        _phase = ok ? _McReplyPhase.sent : _McReplyPhase.idle;
        _faded = false;
        _hidden = false;
      });
    }
    // #550: an answer that went out folds the card into its "Answered" row at once, and the row
    // fades out; the card does not wait for the server to drop it (it does so within seconds, and
    // the next poll is further off than that). It is kept, unseen, while the server lists it: one
    // still listed after the grace was not taken (the agent's screen swallowed the line, #179) and
    // comes back, answering again - it never stays locked.
    if (ok && mounted) _armSentTimers();
    return ok;
  }

  /// The "Answered" row's clocks (#550): it fades after [kMcAnsweredShow] and is out of the way
  /// [kMcAnsweredFade] later; [kMcSentGrace] after the answer a card still sent is "not taken".
  void _armSentTimers() {
    _sentTimer?.cancel();
    _fadeTimer?.cancel();
    _hideTimer?.cancel();
    _fadeTimer = Timer(kMcAnsweredShow, () {
      if (!mounted || _phase != _McReplyPhase.sent) return;
      setState(() => _faded = true);
      _hideTimer = Timer(kMcAnsweredFade, () {
        if (mounted && _phase == _McReplyPhase.sent) _set(() => _hidden = true);
      });
    });
    _sentTimer = Timer(kMcSentGrace, () {
      if (mounted && _phase == _McReplyPhase.sent) {
        _set(() {
          _phase = _McReplyPhase.stale;
          _faded = false;
          _hidden = false;
        });
      }
    });
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
      // The card is folded into its "Answered" row while sent (#550): it shows no status line.
      _McReplyPhase.sent => null,
      _McReplyPhase.stale => 'Not taken: "$w" was sent, but the session still asks. Answer again if you need to.',
    };
  }

  /// #550 - the slim row an answered card folds into: what was answered, and which card it was.
  Widget _answeredRow(BuildContext context) {
    final theme = Theme.of(context);
    final c = widget.card;
    final what = [?c.ref, ?c.title].join('  ');
    return AnimatedOpacity(
      opacity: _faded ? 0 : 1,
      duration: kMcAnsweredFade,
      child: Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(children: [
            const Icon(Icons.check_circle_outline, size: 18, color: AppColors.primary),
            const SizedBox(width: 8),
            Expanded(
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(
                      text: (_choice ?? '').isEmpty ? 'Answered' : 'Answered: $_choice',
                      style: const TextStyle(fontWeight: FontWeight.w600)),
                  if (what.isNotEmpty)
                    TextSpan(text: '   $what', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant)),
                ]),
                key: const ValueKey('mc-card-answered'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ]),
        ),
      ),
    );
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
    final face = Card(
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
                  // #547 - or a wait answered in another session: the tag says which one.
                  if (c.maybeAnswered)
                    McTag(c.answeredIn?.name == null ? 'may be answered' : 'may be answered in "${c.answeredIn!.name}"',
                        muted: true, key: const ValueKey('mc-card-maybe-answered')),
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
            // #548: the decision's context, its first line, on the face; the opened card shows it whole.
            if (!_open && mcContextLine(decision?.context) != null) ...[
              const SizedBox(height: 4),
              Text(mcContextLine(decision?.context)!,
                  key: const ValueKey('mc-card-context-line'), maxLines: 2, overflow: TextOverflow.ellipsis, style: muted),
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
                      key: const ValueKey('mc-card-status'),
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
                  onPressed: c.usesReplyDialog && reply != null ? () => _set(() => _open = true) : widget.onAnswer,
                  icon: const Icon(Icons.reply, size: 18),
                  label: const Text('Answer'),
                ),
              // #547 - one tap to tell the waiting session where it was answered.
              if (widget.onTell != null)
                TextButton.icon(
                  key: const ValueKey('mc-card-tell'),
                  onPressed: widget.onTell,
                  icon: const Icon(Icons.forward_to_inbox, size: 18),
                  label: const Text('Tell it'),
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
    // #550: an answered card folds into its row at once; the row fades and leaves no space.
    return AnimatedSize(
      duration: kMcCollapse,
      alignment: Alignment.topCenter,
      child: _phase == _McReplyPhase.sent ? (_hidden ? const SizedBox.shrink() : _answeredRow(context)) : face,
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
