// The questions inbox (#383): every question and wait that is on the person, on every
// server, in one place, readable and answerable there. The owner's brief: "one screen
// ... see all the questions that's waiting for me, in [an] appropriate format that I
// can read them, understand them and answer them in one place."
//
// Nothing here decides who needs you or what to write:
//  * which sessions are items, as what, in what order -> `util/inbox_items.dart`, built
//    on the board's own rules (`util/needs_you.dart`) and the server's fields;
//  * a question's answer -> [QuestionAnswerPanel] (the session overlay's own card) and
//    [buildAnswerFrames], written by [NeedsYouActions.answer] after its re-check that
//    the question is still the one shown (#383);
//  * a reply -> [NeedsYouActions.reply] (the compose bar's one-frame submit), and Esc
//    -> [NeedsYouActions.esc]; each after a re-read of the session row here, because a
//    card can be a poll old and a reply or an Esc that reaches a session which has moved
//    on is some other input.
//
// What is fetched, and when (report-L section 4). The rows come from
// [SessionRepository] with a faster poll while the screen is open, as on the board.
// Everything else is asked only while the screen is mounted, and only for the items
// that need it: a question row's live question (throttled by [NeedsYouActions]), the
// agent's current turn from its transcript ([loadAgentTurn]: once per (session,
// lastActivity) for a prose candidate or a reported wait, once per WAIT for a
// permission ([_waitStamp], never on terminal output) and again when it is focused
// at most every [kTurnRefocusEvery], once per question for the focused question),
// the focused item's permission detail and terminal tail, and each server's
// background agents. And an AI summary of each item's wait ([_refreshDigests]), from
// a server that writes one: once per (session, stamp), at most [kDigestMaxInFlight]
// asked at a time, by the same stamp rules as the turn. It is context only: the
// question, its options and a permission's command never come from it.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:xterm/xterm.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/app_config.dart';
import '../services/needs_you_actions.dart';
import '../services/question_draft_store.dart';
import '../services/session_input.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../util/agent_turn.dart';
import '../util/inbox_items.dart';
import '../util/needs_you.dart';
import '../util/reply_text.dart';
import '../util/scrollback_window.dart' show scrollbackTailOffset;
import '../util/session_tree.dart';
import '../util/terminal_tail.dart';
import '../util/terminal_write.dart' show safeTerminalWrite;
import '../util/text_direction.dart';
import '../widgets/brief_item_row.dart';
import '../widgets/conversation_view.dart' show markdownStyle, openChatLink;
import '../widgets/directional_text.dart';
import '../widgets/format_utils.dart';
import '../widgets/machine_stripe.dart';
import '../widgets/question_answer_panel.dart';
import '../widgets/question_overlay.dart' show AnswerFrame, kWideMinWidth;
import '../widgets/reply_box.dart';
import '../widgets/server_badge.dart';
import '../widgets/session_family.dart';
import '../widgets/terminal_tail_strip.dart';
import 'session_screen.dart' show questionSignature;
import 'work_board_screen.dart' show BoardColumnView, BoardPalette;

/// The width of the list beside the focused item on a wide pane.
const double kInboxListWidth = 360;

/// How much of a session's scrollback the focused view renders for its terminal tail.
const int kInboxTailBytes = 32768;

/// How many terminal rows the focused view shows.
const int kInboxTailLines = 14;

/// Focusing a permission re-reads its turn, but never more often than this.
const Duration kTurnRefocusEvery = Duration(seconds: 15);

/// The share of the focused view's height a permission's lead-up may fill before
/// "Show all" ([kLeadClamp] is the least it gets).
const double kLeadShare = 0.6;

/// At most this many AI summaries are asked for at once, across every server (#383):
/// each one is a model run on the machine that answers it.
const int kDigestMaxInFlight = 3;

/// How many of its last lines a lead-up shows while its summary is being written.
const int kDigestTeaserLines = 3;

/// How long a server answers a failed summary from memory, with the same failure
/// (`lib/inbox-digest.js`, `failureTtlMs`): a retry inside it cannot succeed, so none
/// is offered until it has passed.
const Duration kDigestFailureMemory = Duration(seconds: 60);

/// A reply's summary is not asked for again sooner than this after the last one
/// landed, while that one is still shown: its stamp follows lastActivity, which moves
/// with every chunk of output, and the server answers the same wait from its cache.
const Duration kDigestReplyReaskAfter = Duration(seconds: 20);

/// What the focused view does with an item's AI summary (#383): [off] (the server
/// writes none, or there is no wait to stamp yet) and [plain] (it answered that there
/// is nothing to show) are today's view; [loading] and [ready] fold the agent's own
/// words behind "Show full context"; [failed] is today's view with a retry.
enum DigestView { off, loading, ready, plain, failed }

class QuestionsInboxScreen extends StatefulWidget {
  const QuestionsInboxScreen({
    super.key,
    required this.onOpenSession,
    this.embedded = false,
    this.repository,
    this.servers,
    this.clientFactory,
    this.sessionInput,
    this.pollInterval = const Duration(seconds: 5),
    this.focusInterval = const Duration(seconds: 4),
    this.agentsInterval = const Duration(seconds: 30),
  });

  /// Opens a session; the caller decides how (the split pane, or a pushed route).
  final void Function(Session session) onOpenSession;

  /// Shown as the split view's detail pane (#383): no back button.
  final bool embedded;

  /// Injectable for tests; defaults to [SessionRepository.instance].
  final SessionRepository? repository;

  /// Injectable for tests; defaults to [AppConfig.servers].
  final List<ServerConfig> Function()? servers;

  /// Injectable for tests; defaults to `ApiClient.new`.
  final ApiClient Function(ServerConfig server)? clientFactory;

  /// Injectable for tests; defaults to [runWithSessionInput].
  final SessionInputRunner? sessionInput;

  /// How often every server is re-asked while the screen is open.
  final Duration pollInterval;

  /// How often the focused item's terminal tail and permission detail are re-read.
  final Duration focusInterval;

  /// How often each server's background agents are re-read.
  final Duration agentsInterval;

  @override
  State<QuestionsInboxScreen> createState() => _QuestionsInboxScreenState();
}

class _QuestionsInboxScreenState extends State<QuestionsInboxScreen> {
  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  StreamSubscription<List<Session>>? _sub;
  Timer? _poll;
  Timer? _focusTick;
  Timer? _agentsTick;
  List<Session> _sessions = const [];
  bool _disposed = false;

  /// Bumped on every change, so a focused view pushed as its own route rebuilds too.
  final ValueNotifier<int> _rev = ValueNotifier<int>(0);

  late final NeedsYouActions _needs = NeedsYouActions(
      repository: _repo, client: _client, input: (s, body) => _input(s, body), say: _say);

  /// The agent's current turn ([loadAgentTurn]), by [sessionKey], with the stamp it
  /// was read for ([_turnStamp]): a new stamp is read afresh.
  final Map<String, ({String stamp, AgentTurn? turn})> _turns = {};
  final Set<String> _turnsInFlight = {};

  /// The stamp the newest read of each session's turn was started for: a read that
  /// lands for any other stamp is older than one already asked for, and is dropped,
  /// so two reads that land out of order cannot leave the older one on screen.
  final Map<String, String> _turnWant = {};

  /// When each session's turn was last read, for the refocus throttle.
  final Map<String, DateTime> _turnReadAt = {};

  /// The lastActivity a session had when it was first seen waiting for a permission,
  /// by [sessionKey], for as long as it keeps waiting: what tells one wait from the
  /// next when the server gives no start of its own ([_waitStamp]).
  final Map<String, int?> _permSeen = {};

  /// A permission row's attention record, with the wait ([_waitStamp]) it was read for.
  final Map<String, ({String wait, AttentionInfo? info})> _attention = {};

  /// The focused item's terminal tail, by [sessionKey].
  final Map<String, List<String>> _tails = {};

  /// Each server's background agents, by base URL.
  final Map<String, List<BackgroundAgentRow>> _agents = {};

  /// Servers whose background-agent route answered 404: not asked again while open.
  final Set<String> _agentsSkip = {};

  /// Replies marked "not a question" ([proseDismissKey]). Local and in memory.
  final Set<String> _dismissed = {};

  /// The item shown in the focused view, by [InboxItem.key], and the last item seen
  /// under that key: what stays on screen, under a banner, if it stops waiting while
  /// words are typed into it.
  String? _focusKey;
  InboxItem? _snapshot;

  /// A focused view is pushed as its own route (a narrow pane).
  bool _routeOpen = false;

  /// Lead-up text being expanded in a permission view.
  final Set<String> _expanded = {};

  /// Cards whose question or ask is shown whole, in place, by [InboxItem.key].
  final Set<String> _cardOpen = {};

  /// AI summaries (#383), by `[sessionKey]|[_turnStamp]`: what the server answered
  /// for that wait, kept for the life of the screen.
  final Map<String, InboxDigest> _digests = {};

  /// The newest summary that landed for each session's REPLY stamp: shown under a
  /// newer one until that one lands, by the turn's own progress rule ([_turnFor]).
  /// Only for as long as the session stays on a reply ([_pruneDigests]).
  final Map<String, ({String stamp, InboxDigest digest})> _digestLatest = {};

  /// The reply stamp each session's newest reply summary was asked for, dropped when
  /// the session leaves the reply: a summary that lands after that is not its latest
  /// ([_turnWant]'s rule, for the summary).
  final Map<String, String> _digestReplyWant = {};

  /// Sessions whose reply summary landed less than [kDigestReplyReaskAfter] ago.
  final Set<String> _digestCooling = {};

  /// Sessions whose summary the SERVER answered as failed less than
  /// [kDigestFailureMemory] ago, each with the timer that ends it.
  final Map<String, Timer> _digestFailedAt = {};

  /// The timers above and the re-asks, cancelled with the screen.
  final Set<Timer> _digestTimers = {};

  /// The `[sessionKey]|stamp` of each summary asked for and not yet answered.
  final Set<String> _digestsInFlight = {};

  /// Summaries waiting for one of the [kDigestMaxInFlight] slots, focused item first.
  final List<(Session, String)> _digestQueue = [];

  /// Items whose agent's own words are open under their summary, by [InboxItem.key],
  /// for the life of the screen.
  final Set<String> _fullContext = {};

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  SessionInputRunner get _input => widget.sessionInput ?? runWithSessionInput;
  Color? _colorOf(String baseUrl) => colorFromHex(_repo.serverColor(baseUrl));

  @override
  void initState() {
    super.initState();
    _sessions = _repo.current;
    _notePermissionWaits();
    _needs.addListener(_onNeeds);
    _sub = _repo.sessions.listen((list) {
      if (_disposed) return;
      _update(() {
        _sessions = list;
        _notePermissionWaits();
      });
      _needs.checkUnconfirmedReplies(_sessions);
      _fetchAll();
    });
    _poll = Timer.periodic(widget.pollInterval, (_) {
      if (_repo.isForeground) unawaited(_repo.refresh());
    });
    _focusTick = Timer.periodic(widget.focusInterval, (_) => unawaited(_refreshFocused(force: true)));
    _agentsTick = Timer.periodic(widget.agentsInterval, (_) => unawaited(_refreshAgents()));
    unawaited(_repo.refresh());
    _fetchAll();
    unawaited(_refreshAgents());
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _focusTick?.cancel();
    _agentsTick?.cancel();
    for (final t in _digestTimers) {
      t.cancel();
    }
    _sub?.cancel();
    _needs.removeListener(_onNeeds);
    _needs.dispose();
    _rev.dispose();
    super.dispose();
  }

  void _update(VoidCallback fn) {
    if (_disposed || !mounted) return;
    setState(fn);
    _rev.value++;
  }

  void _changed() {
    _update(() {});
    // Whatever just changed may have made a new wait, or a new stamp for one.
    _refreshDigests();
  }

  /// A question read for the first time may be the focused one: read its lead-up too.
  void _onNeeds() {
    _changed();
    unawaited(_refreshFocused());
  }

  void _say(String text) {
    if (_disposed || !mounted) return;
    final m = ScaffoldMessenger.maybeOf(context);
    m?.hideCurrentSnackBar();
    m?.showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 5)));
  }

  // ---- fetching ------------------------------------------------------------------

  void _fetchAll() {
    if (_disposed) return;
    _pruneFocusCaches();
    unawaited(_needs.refreshQuestions(_sessions.where((s) => needKindOf(s) == NeedKind.question)));
    unawaited(_refreshTurns());
    unawaited(_refreshAttention());
    unawaited(_refreshFocused());
    _refreshDigests();
  }

  /// Drops the focused-view reads of sessions that are no longer items (the one still
  /// on screen under a banner is kept), so the maps cannot grow for the app's life.
  void _pruneFocusCaches() {
    final live = {
      for (final it in _items)
        if (it.session != null) sessionKey(it.session!),
      if (_snapshot?.session != null) sessionKey(_snapshot!.session!),
    };
    _tails.removeWhere((k, _) => !live.contains(k));
    _expanded.removeWhere((k) => !live.contains(k));
    _cardOpen.removeWhere((k) => !_items.any((it) => it.key == k));
  }

  /// What a session's current turn is read for, or null when none is needed: a
  /// question's lead-up (once per question, read only while it is focused), a
  /// permission's lead-up and tool call (once per wait), and the last reply of a
  /// reported wait or a prose candidate (once per lastActivity: never on a poll).
  String? _turnStamp(Session s) {
    if (boardNeedsYou(s)) {
      switch (needKindOf(s)) {
        case NeedKind.question:
          final q = _needs.questionFor(s);
          return q == null ? null : 'q|${questionSignature(q)}';
        case NeedKind.permission:
          return 'p|${_waitStamp(s)}';
        case NeedKind.reported:
          return 'a|${s.lastActivity}';
        default:
          return null;
      }
    }
    return proseCandidate(s) ? 'a|${s.lastActivity}' : null;
  }

  /// Which permission wait [s] is in. NOT its lastActivity, which the worker bumps on
  /// every chunk of terminal output, and the server gives a `waiting` row no start
  /// (`lib/session-reason.js`: `since: null`), so a stamp built on it re-read the
  /// turn and the attention record on every repaint of the prompt (#383). It is the
  /// kind of wait, the server's PreToolUse time for the tool that waits
  /// (`brief.now.at`: a new call is a new wait), and the lastActivity the session had
  /// when this inbox first saw it waiting ([_permSeen]), which holds still for as
  /// long as it waits.
  String _waitStamp(Session s) =>
      '${s.waitingFor}|${s.brief?.now?.at ?? ''}|${_permSeen[sessionKey(s)] ?? s.lastActivity}';

  /// Records when each permission wait was first seen, and forgets the ones that
  /// ended, so the next wait of the same session is a new one.
  void _notePermissionWaits() {
    final waiting = <String>{};
    for (final s in _sessions) {
      if (!boardNeedsYou(s) || needKindOf(s) != NeedKind.permission) continue;
      final k = sessionKey(s);
      waiting.add(k);
      _permSeen.putIfAbsent(k, () => s.lastActivity);
    }
    _permSeen.removeWhere((k, _) => !waiting.contains(k));
  }

  /// [s]'s turn as read for the stamp [s] has NOW, else null (#383): a turn read for
  /// an earlier wait is not this one's, and showing it would put one permission's
  /// command under the next until the next read lands. A reply ([_isReplyStamp]) is
  /// the exception: the newest one that landed is shown even when lastActivity has
  /// moved since it was asked for. A reply seconds old is still the reply, and holding
  /// out for an exact match meant a session whose output outran its read never showed.
  AgentTurn? _turnFor(Session s) {
    final e = _turns[sessionKey(s)];
    final stamp = _turnStamp(s);
    if (e == null || stamp == null) return null;
    if (e.stamp == stamp) return e.turn;
    return _isReplyStamp(stamp) && _isReplyStamp(e.stamp) ? e.turn : null;
  }

  /// A stamp for the last reply of a reported wait or a prose candidate: one taken
  /// from lastActivity, which moves with every chunk of terminal output.
  static bool _isReplyStamp(String stamp) => stamp.startsWith('a|');

  /// Whether any read of the turn of the session keyed [k] is still out.
  bool _turnReading(String k) => _turnsInFlight.any((f) => f.startsWith('$k|'));

  /// Reads [s]'s current turn for [stamp] and keeps it under that stamp, unless a read
  /// for another stamp was started since ([_turnWant]). A failed read is kept as
  /// nothing when [keepFailed], so it is not asked again until the stamp changes.
  Future<void> _loadTurn(Session s, String stamp, {required bool earlier, bool keepFailed = true}) async {
    final k = sessionKey(s);
    final flight = '$k|$stamp';
    if (_turnsInFlight.contains(flight)) return;
    _turnsInFlight.add(flight);
    _turnWant[k] = stamp;
    final turn = await _readTurn(s, earlier: earlier);
    _turnsInFlight.remove(flight);
    if (_disposed) return;
    if (_turnWant[k] == stamp) {
      _turnReadAt[k] = DateTime.now();
      if (turn != null || keepFailed) _turns[k] = (stamp: stamp, turn: turn);
    }
    // A reply is read one at a time per session ([_refreshTurns]): if lastActivity
    // moved while this one was out, read again now rather than on the next poll.
    final now = _sessions.where((x) => sessionKey(x) == k).firstOrNull;
    final want = now == null ? null : _turnStamp(now);
    if (want != null && _isReplyStamp(want) && _turns[k]?.stamp != want && !_turnReading(k)) {
      unawaited(_refreshTurns());
    }
  }

  /// The current turn of every listed session that needs one, except a question, which
  /// is read only while focused ([_refreshFocused]). A read that fails is kept as
  /// nothing for that stamp: no reply to read is no question to show, and it is asked
  /// again on new activity.
  Future<void> _refreshTurns() async {
    final due = <(Session, String)>[];
    final live = <String>{};
    for (final s in _sessions) {
      final stamp = _turnStamp(s);
      if (stamp == null) continue;
      final k = sessionKey(s);
      live.add(k);
      if (stamp.startsWith('q|') || _turns[k]?.stamp == stamp || _turnsInFlight.contains('$k|$stamp')) continue;
      // A reply waits for the read already out for its session, which re-checks when
      // it lands ([_loadTurn]). Starting one per lastActivity instead left every read
      // older than the newest asked for, so none was kept and the item never showed.
      // A permission is not held back: its stamp is strict, and a new wait wants a
      // new read now.
      if (_isReplyStamp(stamp) && _turnReading(k)) continue;
      due.add((s, stamp));
    }
    final focus = _snapshot?.session;
    bool keep(String k) => live.contains(k) || (focus != null && sessionKey(focus) == k);
    _turns.removeWhere((k, _) => !keep(k));
    _turnWant.removeWhere((k, _) => !keep(k));
    _turnReadAt.removeWhere((k, _) => !keep(k));
    if (due.isEmpty) return;
    // A blocking item shows "You asked / Earlier it said" when its turn has no prose;
    // a prose candidate with no prose asks nothing, so it needs no older page.
    await Future.wait(due.map((d) => _loadTurn(d.$1, d.$2, earlier: boardNeedsYou(d.$1))));
    _changed();
  }

  /// [s]'s current turn, or null when its transcript could not be read.
  Future<AgentTurn?> _readTurn(Session s, {required bool earlier}) async {
    final api = _client(s.server);
    try {
      return await loadAgentTurn((before, limit) => api.transcript(s.id, before: before, limit: limit),
          earlier: earlier);
    } catch (_) {
      return null;
    }
  }

  /// A permission row's attention record, once per wait; the focused one is re-read.
  Future<void> _refreshAttention({String? force}) async {
    final rows = _sessions.where((s) => boardNeedsYou(s) && needKindOf(s) == NeedKind.permission).toList();
    final live = {for (final s in rows) sessionKey(s)};
    _attention.removeWhere((k, _) => !live.contains(k));
    final due = rows.where((s) {
      final k = sessionKey(s);
      return k == force || _attention[k] == null || _attention[k]!.wait != _waitStamp(s);
    }).toList();
    if (due.isEmpty) return;
    for (final s in due) {
      // A re-read of the SAME wait keeps its record on screen meanwhile; a new wait
      // starts with none, so the last wait's words never show under this one.
      final old = _attention[sessionKey(s)];
      final wait = _waitStamp(s);
      _attention[sessionKey(s)] = (wait: wait, info: old?.wait == wait ? old?.info : null);
    }
    await Future.wait(due.map((s) async {
      try {
        final k = sessionKey(s);
        final wait = _waitStamp(s);
        final info = await _client(s.server).attention(s.id);
        // Dropped when a newer wait was asked for while this read was out.
        if (_disposed || _attention[k]?.wait != wait) return;
        _attention[k] = (wait: wait, info: info);
      } catch (_) {/* the card falls back to the session's own words */}
    }));
    _changed();
  }

  /// What only the FOCUSED item needs: a question's lead-up (once per question), and
  /// the terminal tail of a permission, menu or plain wait ([force]: re-read it).
  /// [refocus]: the person has just opened it, so a permission's turn is read again
  /// (at most every [kTurnRefocusEvery]) in case its wait changed unseen.
  Future<void> _refreshFocused({bool force = false, bool refocus = false}) async {
    if (_disposed) return;
    final it = _currentFocus();
    final s = it?.session;
    if (it == null || s == null) return;
    final k = sessionKey(s);
    switch (it.kind) {
      case InboxKind.question:
        final q = it.question;
        if (q == null) return;
        final stamp = 'q|${questionSignature(q)}';
        if (_turns[k]?.stamp == stamp) return;
        // A failed read is not kept: no lead-up panel for now, asked again next time.
        await _loadTurn(s, stamp, earlier: true, keepFailed: false);
        _changed();
      case InboxKind.permission || InboxKind.menu || InboxKind.waiting:
        final stamp = _turnStamp(s);
        final read = _turnReadAt[k];
        if (refocus &&
            it.kind == InboxKind.permission &&
            stamp != null &&
            (read == null || DateTime.now().difference(read) >= kTurnRefocusEvery)) {
          unawaited(_loadTurn(s, stamp, earlier: true).then((_) => _changed()));
        }
        if (!force && _tails.containsKey(k)) return;
        if (it.kind == InboxKind.permission && force) unawaited(_refreshAttention(force: k));
        await _readTail(s);
      default:
        return;
    }
  }

  Future<void> _readTail(Session s) async {
    try {
      final api = _client(s.server);
      final head = await api.scrollback(s.id, limit: 1);
      if (_disposed) return;
      final chunk = await api.scrollback(s.id,
          offset: scrollbackTailOffset(head.total, kInboxTailBytes), limit: kInboxTailBytes);
      if (_disposed) return;
      final t = Terminal(maxLines: 2000)..resize(120, 40);
      safeTerminalWrite(t, chunk.data);
      final buf = t.buffer;
      final w = terminalTailWindow(lineCount: buf.lines.length, viewHeight: buf.viewHeight);
      _tails[sessionKey(s)] = terminalTailLines(
          rowCount: w.rows, rowText: (i) => buf.lines[w.base + i].getText(), maxLines: kInboxTailLines);
      _changed();
    } catch (_) {/* the view still offers Open session */}
  }

  /// Each server's background agents. A 404 means the server has no such route: it is
  /// skipped for the life of this screen. An unreachable server keeps what it said.
  Future<void> _refreshAgents() async {
    if (_disposed) return;
    final servers = _servers;
    _agents.removeWhere((url, _) => !servers.any((sv) => sv.baseUrl == url));
    final due = servers
        .where((sv) => !_agentsSkip.contains(sv.baseUrl) && _repo.serverUsable[sv.baseUrl] != false)
        .toList();
    await Future.wait(due.map((sv) async {
      try {
        final rows = await _client(sv).backgroundAgents();
        if (_disposed) return;
        _agents[sv.baseUrl] = rows ?? const [];
      } on ApiException catch (e) {
        if (e.status == 404) {
          _agentsSkip.add(sv.baseUrl);
          _agents.remove(sv.baseUrl);
        }
      } catch (_) {/* keep the last list */}
    }));
    _changed();
  }

  // ---- AI summaries (#383) ---------------------------------------------------------

  /// The kinds of item a summary is asked for: the ones with the agent's words to read.
  static bool _digestible(InboxItem it) =>
      it.session != null &&
      (it.kind == InboxKind.question ||
          it.kind == InboxKind.permission ||
          it.kind == InboxKind.prose ||
          it.kind == InboxKind.reported);

  /// The session listed under [k] now, if it still is.
  Session? _sessionAt(String k) => _sessions.where((x) => sessionKey(x) == k).firstOrNull;

  /// Whether [s]'s server can be asked for a summary now: it writes them, and it is not
  /// offline or signed out (the rule [_refreshAgents] asks by). A request to a server
  /// that cannot answer holds one of the [kDigestMaxInFlight] slots until it times out.
  bool _digestReachable(Session s) =>
      _repo.supportsDigest(s.server.baseUrl) && _repo.serverUsable[s.server.baseUrl] != false;

  /// The wait a summary is kept for: the turn's stamp ([_turnStamp]), and for a question
  /// also its tool call, the id the server's own `waitKey` is built from. A question is
  /// stamped by its words, so the same question asked again is the same turn read; it
  /// is a new wait all the same, and its summary is written anew.
  String? _digestStamp(Session s) {
    final stamp = _turnStamp(s);
    if (stamp == null || !stamp.startsWith('q|')) return stamp;
    final id = _needs.questionFor(s)?.toolUseId ?? '';
    return id.isEmpty ? stamp : '$stamp|$id';
  }

  /// Runs [fn] after [d], unless the screen goes first; [hold] is handed the timer.
  void _after(Duration d, VoidCallback fn, {void Function(Timer t)? hold}) {
    late final Timer t;
    t = Timer(d, () {
      _digestTimers.remove(t);
      if (!_disposed) fn();
    });
    _digestTimers.add(t);
    hold?.call(t);
  }

  /// Keeps only the summaries of the wait each listed session is in NOW: one answered,
  /// or one it has moved on from, takes its own with it, so the same wait coming back
  /// is summarised anew and the map does not grow with every lastActivity. And a
  /// session that leaves its reply (to work, or to a question) loses its latest reply
  /// summary, as [_refreshTurns] drops its turn, so the NEXT reply never shows it.
  void _pruneDigests() {
    final current = <String>{};
    final onReply = <String>{};
    for (final s in _sessions) {
      final stamp = _digestStamp(s);
      if (stamp == null) continue;
      final k = sessionKey(s);
      current.add('$k|$stamp');
      if (_isReplyStamp(stamp)) onReply.add(k);
    }
    _digests.removeWhere((key, _) => !current.contains(key));
    _digestLatest.removeWhere((k, _) => !onReply.contains(k));
    _digestReplyWant.removeWhere((k, _) => !onReply.contains(k));
  }

  /// Asks for the summary of every item that has none for the stamp it has NOW
  /// ([_digestStamp], the turn's own rule: a question per question, a permission per
  /// wait, a reply per lastActivity). A stamp that did not change asks nothing, so a
  /// poll that changed nothing costs nothing. A server that does not advertise
  /// `inbox-digest`, or cannot be reached, is never asked.
  void _refreshDigests() {
    if (_disposed) return;
    _pruneDigests();
    var added = false;
    for (final it in _items) {
      if (!_digestible(it)) continue;
      final s = it.session!;
      if (!_digestReachable(s)) continue;
      final stamp = _digestStamp(s);
      if (stamp == null) continue;
      final k = sessionKey(s);
      final key = '$k|$stamp';
      final focused = it.key == _focusKey;
      if (_digests.containsKey(key) || _digestsInFlight.contains(key)) continue;
      final at = _digestQueue.indexWhere((q) => sessionKey(q.$1) == k && q.$2 == stamp);
      if (at >= 0) {
        // Already waiting for a slot: the focused item goes to the front of the queue.
        if (focused && at > 0) {
          _digestQueue.insert(0, _digestQueue.removeAt(at));
          added = true;
        }
        continue;
      }
      if (_isReplyStamp(stamp)) {
        // A reply is summarised one at a time per session, like its read: the one out
        // asks again when it lands if lastActivity moved meanwhile ([_loadDigest]).
        if (_digestsInFlight.any((f) => f.startsWith('$k|'))) continue;
        // And not again within [kDigestReplyReaskAfter] of the last one, while that
        // one is still shown: a timer asks once the time is up.
        if (_digestCooling.contains(k) && _digestLatest.containsKey(k)) continue;
      }
      if (focused) {
        _digestQueue.insert(0, (s, stamp));
      } else {
        _digestQueue.add((s, stamp));
      }
      added = true;
    }
    if (added) _pumpDigests();
  }

  /// Starts queued summaries while a slot is free. One whose wait moved on while it
  /// queued, or whose server went out of reach, is dropped: it is queued again as it is.
  void _pumpDigests() {
    while (_digestsInFlight.length < kDigestMaxInFlight && _digestQueue.isNotEmpty) {
      final (queued, stamp) = _digestQueue.removeAt(0);
      final s = _sessionAt(sessionKey(queued));
      if (s == null || _digestStamp(s) != stamp || !_digestReachable(s)) continue;
      unawaited(_loadDigest(s, stamp));
    }
  }

  /// Asks for [s]'s summary for [stamp], and keeps the answer under THAT stamp, the
  /// one it was asked for, whatever the session is in by the time it lands: so an
  /// older wait's late answer is never filed under the wait that replaced it.
  Future<void> _loadDigest(Session s, String stamp) async {
    final k = sessionKey(s);
    final key = '$k|$stamp';
    _digestsInFlight.add(key);
    final reply = _isReplyStamp(stamp);
    if (reply) _digestReplyWant[k] = stamp;
    InboxDigest d;
    var answered = false;
    try {
      d = await _client(s.server).digest(s.id);
      answered = true;
    } on ApiException catch (e) {
      // 404: a server that says it has the route and does not is an older one.
      d = e.status == 404
          ? const InboxDigest(status: InboxDigestStatus.unavailable, reason: 'no-route')
          : InboxDigest(status: InboxDigestStatus.failed, reason: e.status == 0 ? 'unreachable' : 'error');
    } catch (_) {
      d = const InboxDigest(status: InboxDigestStatus.failed, reason: 'error');
    }
    _digestsInFlight.remove(key);
    if (_disposed) return;
    _digests[key] = d;
    if (reply) {
      // The session's latest only while it is still on the reply this was asked for:
      // one that has left it since must not get an older reply's words back.
      if (_digestReplyWant[k] == stamp) _digestLatest[k] = (stamp: stamp, digest: d);
      _digestCooling.add(k);
      _after(kDigestReplyReaskAfter, () {
        _digestCooling.remove(k);
        _refreshDigests();
      });
    }
    if (answered && d.status == InboxDigestStatus.failed) {
      // The server remembers it, and would answer a retry with the same failure.
      _digestFailedAt.remove(k)?.cancel();
      _after(kDigestFailureMemory, () => _update(() => _digestFailedAt.remove(k)), hold: (t) => _digestFailedAt[k] = t);
    }
    _changed();
    _pumpDigests();
  }

  /// [s]'s summary for the wait it is in now, else null: the one for its exact stamp,
  /// or for a reply the newest reply summary that landed.
  InboxDigest? _digestFor(Session s) {
    final stamp = _digestStamp(s);
    if (stamp == null) return null;
    final k = sessionKey(s);
    final exact = _digests['$k|$stamp'];
    if (exact != null) return exact;
    // A question or a permission is STRICT: an older wait's summary, landed late or
    // not, is never shown under this one - one approval's words under the next is
    // worse than "Summarising...".
    if (!_isReplyStamp(stamp)) return null;
    return _digestLatest[k]?.digest;
  }

  /// What [it]'s focused view does with its summary ([DigestView]).
  DigestView _digestView(InboxItem it) {
    final s = it.session;
    if (s == null || !_digestible(it) || !_repo.supportsDigest(s.server.baseUrl)) return DigestView.off;
    if (_digestStamp(s) == null) return DigestView.off;
    final d = _digestFor(s);
    // Nothing is asked of a server out of reach, so nothing is being written.
    if (d == null) return _digestReachable(s) ? DigestView.loading : DigestView.off;
    if (d.isReady) return DigestView.ready;
    // A busy server is a moment's refusal, not an answer about this wait: offer the
    // same retry a failed run gets, rather than keep it for the life of the screen.
    final retry = d.status == InboxDigestStatus.failed ||
        (d.status == InboxDigestStatus.unavailable && d.reason == 'busy');
    return retry ? DigestView.failed : DigestView.plain;
  }

  /// Whether a retry of [s]'s failed summary would be answered from the server's
  /// memory of the failure ([kDigestFailureMemory]), so none is offered yet.
  bool _digestRetryWaits(Session s) => _digestFailedAt.containsKey(sessionKey(s));

  /// Forgets [s]'s failed summary for the wait it is in, and asks again.
  void _retryDigest(Session s) {
    final stamp = _digestStamp(s);
    if (stamp == null || _digestRetryWaits(s)) return;
    final k = sessionKey(s);
    _digests.remove('$k|$stamp');
    if (_digestLatest[k]?.digest.isReady == false) _digestLatest.remove(k);
    _digestCooling.remove(k);
    _changed();
  }

  void _toggleFullContext(InboxItem it) =>
      _update(() => _fullContext.contains(it.key) ? _fullContext.remove(it.key) : _fullContext.add(it.key));

  // ---- the items -----------------------------------------------------------------

  List<InboxItem> get _items => inboxItemsOf(
        _sessions,
        questions: {
          for (final s in _sessions)
            if (needKindOf(s) == NeedKind.question) sessionKey(s): _needs.questionFor(s),
        },
        turns: {
          for (final s in _sessions) sessionKey(s): ?_turnFor(s),
        },
        agents: _agents,
        dismissed: _dismissed,
      );

  /// The item under [key] now, whatever it waits on.
  InboxItem? _itemAt(String key) {
    for (final it in _items) {
      if (it.key == key) return it;
    }
    return null;
  }

  /// The focused item, if it is still the SAME item: the same session waiting on the
  /// same kind of thing, and for a question the same question (#383). A session that
  /// moves from one wait to another under the person's typing is a replacement, not
  /// an update, and must leave the words they typed on screen.
  InboxItem? _currentFocus() {
    final k = _focusKey;
    if (k == null) return null;
    final it = _itemAt(k);
    if (it == null) return null;
    final was = _snapshot;
    return was == null || _sameItem(was, it) ? it : null;
  }

  /// [now] is [was] still, rather than something else waiting in the same session. A
  /// question not yet read when [was] was seen takes whatever question arrives.
  static bool _sameItem(InboxItem was, InboxItem now) =>
      was.key == now.key &&
      was.kind == now.kind &&
      (was.kind != InboxKind.question ||
          was.question == null ||
          questionSignature(was.question) == questionSignature(now.question));

  /// An item's identity in the focused view: [_sameItem] as a key.
  static String _identity(InboxItem it) =>
      '${it.key}|${it.kind.name}|${it.kind == InboxKind.question ? questionSignature(it.question).hashCode : ''}';

  /// The words typed into [it] that have not been sent: what would be lost if it went.
  List<String> _typedWords(InboxItem it) {
    final s = it.session;
    if (s == null) return const [];
    switch (it.kind) {
      case InboxKind.question:
        final q = it.question;
        final d = QuestionDraftStore.instance.peek(s.server.baseUrl, s.id);
        if (q == null || d == null || d.key != questionSignature(q) || d.flaggedFor(d.key!)) return const [];
        return [
          for (final w in [...d.other, ...d.note])
            if (w != null && w.trim().isNotEmpty) w.trim(),
        ];
      case InboxKind.prose || InboxKind.reported:
        final t = _needs.replyBox(s).text.trim();
        return t.isEmpty ? const [] : [t];
      default:
        return const [];
    }
  }

  void _focus(InboxItem it) {
    _update(() {
      _focusKey = it.key;
      _snapshot = it;
    });
    unawaited(_refreshFocused(refocus: true));
    // Its summary, if it is still waiting for a slot, is the next one asked for.
    _refreshDigests();
  }

  /// The next blocking item after [key], or the first item left.
  InboxItem? _nextAfter(String key) {
    final items = _items.where((i) => i.key != key).toList();
    return items.where((i) => i.blocking).firstOrNull ?? items.firstOrNull;
  }

  /// On from the focused item under [key]: to what that session waits on now, if it
  /// waits on something else, else to the next item ([_moveOn]).
  void _advance(String key) {
    final now = _itemAt(key);
    if (now == null) {
      _moveOn(key);
      return;
    }
    _update(() {
      _focusKey = key;
      _snapshot = now;
    });
    unawaited(_refreshFocused());
  }

  void _moveOn(String fromKey) {
    final next = _nextAfter(fromKey);
    if (_routeOpen) {
      Navigator.of(context).maybePop();
      return;
    }
    _update(() {
      _focusKey = next?.key;
      _snapshot = next;
    });
    if (next != null) unawaited(_refreshFocused());
  }

  void _open(InboxItem it, bool wide) {
    if (wide) {
      _focus(it);
      return;
    }
    _focus(it);
    _routeOpen = true;
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => _FocusRoute(state: this)))
        .whenComplete(() {
      _routeOpen = false;
      _update(() {
        _focusKey = null;
        _snapshot = null;
      });
    });
  }

  void _openSession(Session s) {
    if (_routeOpen) Navigator.of(context).maybePop();
    widget.onOpenSession(s);
  }

  // ---- the writes ----------------------------------------------------------------

  Future<void> _answer(InboxItem it, PendingQuestion q, List<AnswerFrame> frames) async {
    final s = it.session!;
    await _needs.answer(s, q, frames, onSettled: (landed) {
      if (!landed || _disposed) return;
      _say('Answered "${s.name}"');
      if (_focusKey == it.key) _moveOn(it.key);
    });
  }

  Future<void> _quickAnswer(InboxItem it, PendingQuestion q, int index) async {
    final s = it.session!;
    await _needs.quickAnswer(s, q, index, onSettled: (landed) {
      if (landed && !_disposed) _say('Answered "${s.name}"');
    });
  }

  /// A reply to an agent that asked in prose (c): only while it is still idle on the
  /// SAME reply, re-read first ([NeedsYouActions.reply]).
  Future<bool> _replyProse(Session s, String text) => _needs.reply(s, text,
      still: (fresh) => fresh.status == 'idle' && fresh.lastActivity == s.lastActivity,
      movedOn: '"${s.name}" has moved on since - nothing was sent');

  /// A reply to an agent that reported it waits on you (d): only while it still does,
  /// and never into a selector that has come up since ([replyStillWanted]).
  Future<bool> _replyReported(Session s, String text) => _needs.reply(s, text,
      still: replyStillWanted, movedOn: '"${s.name}" is no longer waiting on you - nothing was sent');

  /// Esc to close a panel over the composer (e): only while one still covers it.
  Future<void> _esc(Session s) => _needs.esc(s,
      still: escStillCloses, movedOn: '"${s.name}" no longer shows a menu - Esc was not sent');

  Future<void> _notWaiting(Session s) async {
    try {
      await _client(s.server).patchBrief(s.id, clearWait: true);
    } catch (e) {
      _say('Could not save: ${e is ApiException ? e.message : '$e'}');
    }
    await _repo.refresh();
  }

  /// What a permission prompt asks, in the best words on hand: the attention record's
  /// reason (it names the tool), else the session's own "now".
  /// What a permission prompt is for: the tool that is waiting (`brief.now`, the
  /// board's own line), else the notification's text, which is often only the
  /// generic "Claude Code needs your approval".
  String _permissionReason(Session s) {
    final now = s.brief?.now?.text.trim();
    if (now != null && now.isNotEmpty) return now;
    final r = _attention[sessionKey(s)]?.info?.reason?.trim();
    if (r != null && r.isNotEmpty) return r;
    return 'a tool wants to run';
  }

  void _notAQuestion(InboxItem it) {
    final s = it.session;
    final r = it.turn;
    if (s == null || r == null) return;
    _update(() => _dismissed.add(proseDismissKey(s, r)));
    _moveOn(it.key);
  }

  // ---- build ---------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final items = _items;
    final blocking = items.where((i) => i.blocking).toList();
    final background = items.where((i) => !i.blocking).toList();
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: !widget.embedded,
        title: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          const Text('Questions'),
          const SizedBox(width: 12),
          Flexible(
            child: Text('${blocking.length} waiting, ${background.length} in background',
                key: const ValueKey('inbox-counts'), overflow: TextOverflow.ellipsis, style: muted),
          ),
        ]),
        actions: [
          IconButton(
            key: const ValueKey('inbox-refresh'),
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () {
              unawaited(_repo.refresh());
              unawaited(_refreshAgents());
            },
          ),
        ],
      ),
      body: LayoutBuilder(builder: (context, box) {
        final wide = box.maxWidth >= kWideMinWidth;
        final list = _list(context, blocking, background, wide);
        if (!wide) return list;
        // A wide pane always shows something beside the list: the oldest wait.
        if (_focusKey == null && items.isNotEmpty) {
          _focusKey = items.first.key;
          _snapshot = items.first;
          scheduleMicrotask(() => unawaited(_refreshFocused()));
        }
        return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SizedBox(key: const ValueKey('inbox-list'), width: kInboxListWidth, child: list),
          VerticalDivider(width: 1, color: theme.dividerColor),
          Expanded(key: const ValueKey('inbox-focus-pane'), child: _focusPane(context)),
        ]);
      }),
    );
  }

  /// The servers that cannot show their questions right now, by name.
  List<String> _downServers() => [
        for (final sv in _servers)
          if (_repo.serverOfflineConfirmed[sv.baseUrl] == true || _repo.serverNeedsAuth[sv.baseUrl] == true) sv.name,
      ];

  Widget _list(BuildContext context, List<InboxItem> blocking, List<InboxItem> background, bool wide) {
    final theme = Theme.of(context);
    final pal = BoardPalette.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: pal.idle);
    final down = _downServers();
    final caveat = down.isEmpty
        ? null
        : Text(
            '${down.join(', ')} ${down.length == 1 ? 'is' : 'are'} offline, so '
            '${down.length == 1 ? 'its' : 'their'} questions can\'t be shown.',
            key: const ValueKey('inbox-offline-caveat'),
            style: muted);
    if (blocking.isEmpty && background.isEmpty) {
      return ListView(padding: const EdgeInsets.all(24), children: [
        Text('Nothing is waiting for you.', key: const ValueKey('inbox-empty'), style: theme.textTheme.titleMedium),
        if (caveat != null) ...[const SizedBox(height: 8), caveat],
      ]);
    }
    Widget card(InboxItem it) => _InboxCard(
          key: ValueKey('inbox-card-${it.key}'),
          item: it,
          state: this,
          wide: wide,
          selected: wide && it.key == _focusKey,
        );
    return RefreshIndicator(
      onRefresh: _repo.refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: [
          if (caveat != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: caveat),
          BoardColumnView(
            key: const ValueKey('inbox-blocking'),
            title: 'Blocking',
            color: pal.you,
            count: blocking.length,
            children: blocking.isEmpty
                ? [Text('Nothing is blocked on you.', style: muted)]
                : [for (final it in blocking) card(it)],
          ),
          const SizedBox(height: 12),
          if (background.isNotEmpty)
            BoardColumnView(
              key: const ValueKey('inbox-background'),
              title: 'Background',
              color: pal.idle,
              count: background.length,
              children: [for (final it in background) card(it)],
            ),
        ],
      ),
    );
  }

  /// The focused item, or the banner left when it stopped waiting with words typed.
  Widget _focusPane(BuildContext context) {
    final theme = Theme.of(context);
    final k = _focusKey;
    if (k == null) {
      return Center(child: Text('Pick an item to read it here.', style: theme.textTheme.bodyMedium));
    }
    final live = _currentFocus();
    if (live != null) _snapshot = live;
    final it = live ?? _snapshot;
    if (it == null) return const SizedBox.shrink();
    final words = live == null ? _typedWords(it) : const <String>[];
    if (live == null && words.isEmpty) {
      // Gone or replaced, with nothing typed that could be lost: on to what it waits
      // on now, or to the next one.
      scheduleMicrotask(() {
        if (!_disposed && _focusKey == k && _currentFocus() == null) _advance(k);
      });
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      // The banner joins ABOVE the view; the view below keeps its element (the list
      // diff matches from the bottom too), so its typed words and caret stay put.
      if (live == null && words.isNotEmpty) _goneBanner(context, it, words),
      Expanded(child: _FocusView(key: ValueKey('inbox-focus-${_identity(it)}'), item: it, state: this, gone: live == null)),
    ]);
  }

  Widget _goneBanner(BuildContext context, InboxItem it, List<String> words) {
    final theme = Theme.of(context);
    return Container(
      key: const ValueKey('inbox-gone-banner'),
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(AppShape.medium),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('This question is no longer waiting. Your words are below to copy.', style: theme.textTheme.bodyMedium),
        const SizedBox(height: 6),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 120),
          child: SingleChildScrollView(
            child: SelectableText(words.join('\n'), key: const ValueKey('inbox-gone-words')),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            key: const ValueKey('inbox-gone-next'),
            onPressed: () => _advance(it.key),
            child: const Text('Next'),
          ),
        ),
      ]),
    );
  }
}

/// The focused view pushed as its own route on a narrow pane: it rebuilds whenever the
/// screen beneath it does, so it shows the same live item.
class _FocusRoute extends StatelessWidget {
  const _FocusRoute({required this.state});
  final _QuestionsInboxScreenState state;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: state._rev,
      builder: (context, _, _) {
        // The view's own head names the session and its machine, so the bar does not.
        return Scaffold(
          appBar: AppBar(title: const Text('Questions')),
          body: SafeArea(child: state._focusPane(context)),
        );
      },
    );
  }
}

final ButtonStyle _smallOutlined = OutlinedButton.styleFrom(
  visualDensity: VisualDensity.compact,
  padding: const EdgeInsets.symmetric(horizontal: 10),
  minimumSize: const Size(0, 30),
  textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
);

/// A labelled line: `<b>Label:</b> text`, in the direction of the text's first
/// paragraph. [maxLines] clamps it; null shows it whole, for a [questionSnippet] that is
/// already shortened at a sentence boundary and must not be cut again mid-word.
Widget _labelled(BuildContext context, String label, String text, {int? maxLines = 3, Key? key, TextStyle? style}) {
  final theme = Theme.of(context);
  return Text.rich(
    TextSpan(children: [
      // Isolated (LRI .. PDI) so an English label keeps its colon on its own side
      // when the text after it reads right to left.
      TextSpan(text: '\u2066$label:\u2069 ', style: const TextStyle(fontWeight: FontWeight.w700)),
      TextSpan(text: text),
    ]),
    key: key,
    maxLines: maxLines,
    overflow: maxLines == null ? null : TextOverflow.ellipsis,
    textDirection: textDirectionFor(paragraphsOf(text).firstOrNull ?? ''),
    style: style ?? theme.textTheme.bodySmall?.copyWith(fontSize: 13),
  );
}

/// A card's question or ask: the sentence that asks ([questionSnippet], cut only at
/// sentence boundaries), and, when that left something out, a tap that shows [whole]
/// in place, so it can be read without opening the item (#383). The rest of the card
/// still opens it.
class _Snippet extends StatelessWidget {
  const _Snippet({required this.item, required this.state, required this.label, required this.text, required this.whole});
  final InboxItem item;
  final _QuestionsInboxScreenState state;
  final String label;
  final String text;

  /// Everything the card can show in place: each question with its own header.
  final List<({String label, String text})> whole;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final short = questionSnippet(text);
    final canOpen = short != text.trim() || whole.length > 1;
    final open = canOpen && state._cardOpen.contains(item.key);
    final shown = open
        ? Column(key: ValueKey('inbox-whole-${item.key}'), crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final (i, w) in whole.indexed)
              Padding(
                  padding: EdgeInsets.only(top: i == 0 ? 0 : 6), child: _labelled(context, w.label, w.text.trim(), maxLines: null)),
          ])
        : _labelled(context, label, short, maxLines: null, key: ValueKey('inbox-snippet-${item.key}'));
    if (!canOpen) return shown;
    return InkWell(
      key: ValueKey('inbox-expand-${item.key}'),
      onTap: () => state._update(() => open ? state._cardOpen.remove(item.key) : state._cardOpen.add(item.key)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        shown,
        Text(open ? 'Show less' : 'Show all',
            style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.primary, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

/// The tool call a permission prompt asks to run, as the transcript recorded it: its
/// name and, in monospace, the command or path being approved. [maxLines] clamps it in
/// a card; null shows it whole and selectable.
class _ToolCall extends StatelessWidget {
  const _ToolCall({required this.name, required this.text, this.maxLines});
  final String name;
  final String text;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mono = theme.textTheme.bodySmall?.copyWith(
        fontFamily: 'monospace', fontFamilyFallback: const ['Consolas', 'Menlo', 'Courier New'], fontSize: 12.5);
    final body = maxLines == null
        ? SelectableText(text, key: const ValueKey('inbox-tool-call'), style: mono)
        : Text(text, maxLines: maxLines, overflow: TextOverflow.ellipsis, style: mono, textDirection: TextDirection.ltr);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppShape.small),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (name.isNotEmpty)
          Text(name, style: theme.textTheme.labelSmall?.copyWith(fontWeight: FontWeight.w700, color: theme.colorScheme.onSurfaceVariant)),
        body,
      ]),
    );
  }
}

/// The agent's lead-up, clamped until opened to [clamp]: a share of the view's height
/// ([kLeadShare]), never less than [kLeadClamp]. "Show all" is offered only when the
/// text is actually taller than the clamp - measured after layout, since a character
/// count cannot know the width it wraps at. Clamped, it shows the END of the text,
/// the part next to the tool call (#383); the head is what "Show all" adds.
const double kLeadClamp = 160;

class _ClampedLead extends StatefulWidget {
  const _ClampedLead({required this.open, required this.onToggle, required this.clamp, required this.child});
  final bool open;
  final VoidCallback onToggle;
  final double clamp;
  final Widget child;

  @override
  State<_ClampedLead> createState() => _ClampedLeadState();
}

class _ClampedLeadState extends State<_ClampedLead> {
  final _scroll = ScrollController();
  bool _overflows = false;

  void _measure() {
    if (!mounted || widget.open || !_scroll.hasClients) return;
    final over = _scroll.position.maxScrollExtent > 0;
    if (over != _overflows) setState(() => _overflows = over);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ConstrainedBox(
        constraints: BoxConstraints(maxHeight: widget.open ? double.infinity : widget.clamp),
        child: ClipRect(
            child: SingleChildScrollView(
                key: const ValueKey('inbox-lead'),
                controller: _scroll,
                physics: const NeverScrollableScrollPhysics(),
                reverse: true,
                child: widget.child)),
      ),
      if (widget.open || _overflows)
        TextButton(
          key: const ValueKey('inbox-lead-toggle'),
          onPressed: widget.onToggle,
          child: Text(widget.open ? 'Show less' : 'Show all'),
        ),
    ]);
  }
}

/// The label over an item's AI summary (#383).
const String kDigestLabel = 'AI summary';

/// A small heading inside the summary.
Widget _subLabel(BuildContext context, String text) => Text(text,
    style: Theme.of(context).textTheme.labelSmall?.copyWith(
        color: Theme.of(context).colorScheme.onSurfaceVariant, fontWeight: FontWeight.w700));

/// The last few lines of [text] ([kDigestTeaserLines]), the part next to the question,
/// shown while its summary is written so the item is never blank. A last line too long
/// to show whole keeps its END, cut at a space.
String leadTeaser(String text, {int lines = kDigestTeaserLines, int maxChars = 300}) {
  final kept = text.split('\n').map((l) => l.trimRight()).where((l) => l.trim().isNotEmpty).toList();
  var out = kept.sublist(math.max(0, kept.length - lines)).join('\n');
  // Counted and cut in characters, not UTF-16 units, so an emoji or a combining mark
  // is never split in two.
  final chars = out.characters;
  if (chars.length > maxChars) {
    final cut = chars.skip(chars.length - maxChars).toString();
    final sp = cut.indexOf(' ');
    out = '\u2026${sp < 0 ? cut : cut.substring(sp + 1)}';
  }
  return out;
}

/// What a summary says: what it is about, what is asked (bold, one line per ask) and
/// what is good to know, each line in its own reading direction ([DirectionalText]).
class _DigestBlock extends StatelessWidget {
  const _DigestBlock({required this.digest});
  final InboxDigest digest;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body = theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurface);
    final d = digest;
    Widget gap(Widget w) => Padding(padding: const EdgeInsets.only(top: 4), child: w);
    return Column(
      key: const ValueKey('inbox-digest'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (d.about.isNotEmpty) ...[
          _subLabel(context, 'About'),
          gap(DirectionalText(d.about, key: const ValueKey('inbox-digest-about'), style: body)),
          const SizedBox(height: 8),
        ],
        if (d.asking.isNotEmpty) ...[
          _subLabel(context, 'Asking'),
          for (final (i, a) in d.asking.indexed)
            gap(DirectionalText(a, key: ValueKey('inbox-digest-ask-$i'), style: body?.copyWith(fontWeight: FontWeight.w700))),
          const SizedBox(height: 8),
        ],
        if (d.know.isNotEmpty) ...[
          _subLabel(context, 'Good to know'),
          for (final (i, k) in d.know.indexed)
            gap(Directionality(
              textDirection: textDirectionFor(k),
              child: Row(key: ValueKey('inbox-digest-know-$i'), crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('\u2022  ', style: body),
                Expanded(child: Text(k, style: body, textDirection: textDirectionFor(k))),
              ]),
            )),
        ],
      ],
    );
  }
}

/// "Summary failed - retry": the agent's own words stay where they are, open. While
/// the server still remembers the failure ([waits]) a retry would get it again at
/// once, so it says when to try instead of offering a button that cannot work.
class _DigestRetry extends StatelessWidget {
  const _DigestRetry({required this.waits, required this.onRetry});
  final bool waits;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Align(
        alignment: AlignmentDirectional.centerStart,
        child: waits
            ? Padding(
                padding: const EdgeInsetsDirectional.only(start: 6, top: 6, bottom: 6),
                child: Text('Summary failed - try again in a minute',
                    key: const ValueKey('inbox-digest-retry-wait'),
                    style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant)),
              )
            : TextButton(
          key: const ValueKey('inbox-digest-retry'),
          style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 6)),
          onPressed: onRetry,
          child: const Text('Summary failed - retry', style: TextStyle(fontSize: 12)),
        ),
      );
}

/// An item's summary while it is written ([DigestView.loading]: one line saying so,
/// and the last lines of the agent's words) or once it is ready, with the agent's own
/// words ([full]) folded behind "Show full context". Opened, they show whole, under the
/// summary and above the toggle, so the toggle that closes them is where the view lands.
class _DigestSection extends StatelessWidget {
  const _DigestSection(
      {required this.item, required this.state, required this.view, this.teaser, this.full, this.header = false});
  final InboxItem item;
  final _QuestionsInboxScreenState state;
  final DigestView view;
  final String? teaser;
  final Widget? full;

  /// Labels it "AI summary" itself; inside the answer panel the panel's heading does.
  final bool header;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final open = state._fullContext.contains(item.key);
    final d = view == DigestView.ready ? state._digestFor(item.session!) : null;
    final t = teaser == null ? '' : leadTeaser(teaser!);
    return Column(
      key: const ValueKey('inbox-digest-section'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (header) ...[_subLabel(context, kDigestLabel), const SizedBox(height: 6)],
        if (d != null) _DigestBlock(digest: d),
        if (view == DigestView.loading) ...[
          Row(key: const ValueKey('inbox-digest-loading'), children: [
            const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5)),
            const SizedBox(width: 8),
            Text('Summarising...', style: muted),
          ]),
          if (t.isNotEmpty && !open)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: DirectionalText(t, key: const ValueKey('inbox-digest-teaser'), style: muted),
            ),
        ],
        if (full != null && open) ...[const SizedBox(height: 10), KeyedSubtree(key: const ValueKey('inbox-full-context'), child: full!)],
        if (full != null)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(
              key: const ValueKey('inbox-full-toggle'),
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 6)),
              onPressed: () => state._toggleFullContext(item),
              child: Text(open ? 'Hide full context' : 'Show full context', style: const TextStyle(fontSize: 12)),
            ),
          ),
      ],
    );
  }
}

/// One item in the list: the head every card shares, what it waits on, and the
/// one-press controls where one press is the whole answer.
class _InboxCard extends StatelessWidget {
  const _InboxCard({super.key, required this.item, required this.state, required this.wide, required this.selected});
  final InboxItem item;
  final _QuestionsInboxScreenState state;
  final bool wide;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pal = BoardPalette.of(context);
    final it = item;
    final blocking = it.blocking;
    final border = selected
        ? BorderSide(color: theme.colorScheme.primary, width: 2)
        : BorderSide(color: blocking ? pal.you.withValues(alpha: 0.55) : theme.colorScheme.outlineVariant);
    final body = <Widget>[
      _InboxHead(item: it, state: state),
      ?_workLine(context),
      ..._kindLines(context),
      ..._controls(context),
    ];
    return Material(
      color: blocking ? Color.alphaBlend(pal.youBg, theme.colorScheme.surface) : theme.colorScheme.surfaceContainer,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppShape.medium), side: border),
      clipBehavior: Clip.antiAlias,
      child: MachineStripe(
        color: state._colorOf(it.server.baseUrl),
        child: InkWell(
          key: ValueKey('inbox-open-${it.key}'),
          onTap: () => state._open(it, wide),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 10, 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final (i, w) in body.indexed) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 6), child: w),
            ]),
          ),
        ),
      ),
    );
  }

  Widget? _workLine(BuildContext context) {
    final b = item.session?.brief;
    if (b == null) return null;
    if (b.items.isNotEmpty) return BriefItemRow(b.items.first);
    final h = b.headline;
    if (h == null) return null;
    return Text(h, maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall);
  }

  List<Widget> _kindLines(BuildContext context) {
    final it = item;
    final s = it.session;
    // With a summary ready, its first ask is ADDED under the row's own words, which
    // stay exactly as they were: they are the authority, the summary a reading of it.
    final d = s == null || !_QuestionsInboxScreenState._digestible(it) ? null : state._digestFor(s);
    final ask = d != null && d.isReady ? d.asking.firstOrNull : null;
    final ai = ask == null ? null : _aiLine(context, ask);
    switch (it.kind) {
      case InboxKind.question:
        final q = it.question;
        if (q == null || q.questions.isEmpty) return [_labelled(context, 'Question', 'reading it...')];
        final first = q.questions.first;
        final more = q.questions.length - 1;
        return [
          _Snippet(
            item: it,
            state: state,
            label: _questionLabel(first),
            text: first.question,
            whole: [
              for (final x in q.questions) (label: _questionLabel(x), text: x.question),
            ],
          ),
          if (more > 0 && !state._cardOpen.contains(it.key))
            Text('+$more more question${more == 1 ? '' : 's'}',
                key: ValueKey('inbox-more-${it.key}'), style: Theme.of(context).textTheme.bodySmall),
          ?ai,
        ];
      case InboxKind.permission:
        final tool = permissionToolCall(it.turn?.pendingTool, s!.brief?.now?.text);
        final what = tool == null ? null : toolCallText(tool);
        return [
          _labelled(context, 'Permission', state._permissionReason(s), maxLines: 2),
          if (what != null) _ToolCall(name: tool!.name, text: what, maxLines: 2),
          ?ai,
        ];
      case InboxKind.prose:
        final reply = it.turn!.prose;
        return [
          _Snippet(
              item: it, state: state, label: 'May be asking', text: askingScope(reply), whole: [(label: 'May be asking', text: askingScope(reply))]),
          ?ai,
        ];
      case InboxKind.reported:
        final waiting = s!.reason?.text ?? '';
        final asks = _reportedAsk(it);
        return [
          if (waiting.isNotEmpty) _labelled(context, 'Waiting', waiting),
          if (asks != null) _Snippet(item: it, state: state, label: 'Asks', text: asks, whole: [(label: 'Asks', text: asks)]),
          ?ai,
        ];
      case InboxKind.menu:
        return [_labelled(context, 'Stuck in a menu', 'a panel covers the composer')];
      case InboxKind.background:
        final a = it.agent!;
        return [
          _labelled(context, 'Agent', [a.name, a.cwdTail].whereType<String>().join(' - '), maxLines: 1),
          _labelled(context, 'Waiting', a.waitingFor ?? '', maxLines: 3),
        ];
      case InboxKind.waiting:
        return [_labelled(context, 'Needs you', 'open it to see what it is waiting on')];
    }
  }

  /// A row's line from its AI summary, under the row's own words: labelled as such,
  /// smaller and muted, two lines at most.
  Widget _aiLine(BuildContext context, String text) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: const EdgeInsetsDirectional.only(top: 2, end: 4),
        child: Icon(Icons.auto_awesome, size: 11, color: muted),
      ),
      Expanded(
          child: _labelled(context, kDigestLabel, text,
              maxLines: 2,
              key: ValueKey('inbox-digest-row-${item.key}'),
              style: theme.textTheme.bodySmall?.copyWith(fontSize: 12, color: muted))),
    ]);
  }

  /// A question's label on a card: its own header (the chip Claude gives it), so a
  /// card says what the question is about before the question itself.
  static String _questionLabel(PendingQuestionItem q) {
    final h = q.header.trim();
    return h.isEmpty ? 'Question' : 'Question - $h';
  }

  /// What a reported wait asks, in the agent's own words: the part of its last reply
  /// that decides whether it asks ([askingScope]); before that is read, or when the
  /// turn has no prose, the session's TL;DR (`brief.did`).
  static String? _reportedAsk(InboxItem it) {
    final prose = it.turn?.prose ?? '';
    if (prose.isNotEmpty) return askingScope(prose);
    final did = it.session?.brief?.did?.text.trim() ?? '';
    return did.isEmpty ? null : did;
  }

  List<Widget> _controls(BuildContext context) {
    final it = item;
    final s = it.session;
    final idk = it.key;
    switch (it.kind) {
      case InboxKind.question:
        final q = it.question;
        if (q == null || s == null) return const [];
        if (state._needs.isAnswering(s, q)) {
          return [Text('Answer sent - waiting for it to land...', style: Theme.of(context).textTheme.bodySmall)];
        }
        final blocked = state._needs.quickAnswerBlocked(s, q);
        final answer = OutlinedButton(
          key: ValueKey('inbox-answer-open-$idk'),
          style: _smallOutlined,
          onPressed: () => state._open(it, wide),
          child: const Text('Answer'),
        );
        if (blocked) {
          return [
            Text('An answer did not land and may be partly typed - open it to finish.',
                key: ValueKey('inbox-answer-blocked-$idk'), style: Theme.of(context).textTheme.bodySmall),
            answer,
          ];
        }
        return [
          Wrap(spacing: 6, runSpacing: 4, children: [
            if (quickAnswerable(q))
              for (final (i, o) in q.questions.first.options.indexed)
                OutlinedButton(
                  key: ValueKey('inbox-answer-$idk-$i'),
                  style: _smallOutlined,
                  onPressed: state._needs.isBusy(s) ? null : () => state._quickAnswer(it, q, i),
                  child: Text(o.label, textDirection: textDirectionFor(o.label)),
                ),
            answer,
          ]),
        ];
      case InboxKind.reported:
        // One reply box per session: the focused view holds it while this card is shown
        // beside it, so the card does not draw a second field on the same text.
        if (s == null || selected) return const [];
        return [
          ReplyBox(
            key: ValueKey('inbox-reply-$idk'),
            controller: state._needs.replyBox(s),
            name: s.name,
            ready: s.agentReady,
            busy: state._needs.isBusy(s),
            onSend: (t) => state._replyReported(s, t),
          ),
        ];
      default:
        return const [];
    }
  }
}

/// The head every card and focused view shares: the name, the machine, the age, and
/// the family marker when the session has relatives listed.
class _InboxHead extends StatelessWidget {
  const _InboxHead({required this.item, required this.state});
  final InboxItem item;
  final _QuestionsInboxScreenState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: BoardPalette.of(context).idle);
    final s = item.session;
    final tree = SessionTree(state._sessions);
    final name = s?.name ?? item.agent?.name ?? item.agent?.cwdTail ?? 'Background agent';
    return Row(children: [
      Expanded(
        child: Text(name,
            maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
      ),
      if (s != null && hasFamily(tree, s))
        Flexible(
          child: FamilyBadge(
            label: familySummary(tree, s),
            onTap: () => showFamilySheet(context, sessionId: s.id, onOpen: state._openSession),
          ),
        ),
      const SizedBox(width: 6),
      ServerBadge(name: item.server.name, color: state._colorOf(item.server.baseUrl)),
      if (item.since != null) ...[
        const SizedBox(width: 6),
        Text(relativeTime(item.since), style: muted),
      ],
    ]);
  }
}

/// Where reading happens: one item, whole, with what can be done about it.
class _FocusView extends StatelessWidget {
  const _FocusView({super.key, required this.item, required this.state, required this.gone});
  final InboxItem item;
  final _QuestionsInboxScreenState state;

  /// It stopped waiting; kept on screen under the banner for its typed words.
  final bool gone;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final it = item;
    final s = it.session;
    if (it.kind == InboxKind.question && s != null) {
      final q = it.question;
      if (q == null) return const Center(child: Text('Reading the question...'));
      final ctx = state._turns[sessionKey(s)];
      final lead = ctx?.stamp == 'q|${questionSignature(q)}' ? ctx?.turn : null;
      final leadText = lead?.leadUp?.trim();
      final leadLabel = lead?.leadUpLabel ?? kLeadUpLabel;
      final view = state._digestView(it);
      // The summary goes where the agent's words go, INSIDE the panel: that slot is
      // the one the panel shrinks first, so on a phone the options keep their room
      // (#94/#108). The question and its options are the panel's, untouched.
      final hasLead = leadText != null && leadText.isNotEmpty;
      final retry = view == DigestView.failed
          ? _DigestRetry(waits: state._digestRetryWaits(s), onRetry: () => state._retryDigest(s))
          : null;
      final body = switch (view) {
        DigestView.off || DigestView.plain => null,
        // With no words to show, the retry sits above the panel: a "Claude said"
        // heading over nothing but it would say something that is not there.
        DigestView.failed => !hasLead
            ? null
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
                leadUpMarkdown(theme, leadText),
                retry!,
              ]),
        DigestView.loading || DigestView.ready => _DigestSection(
            item: it,
            state: state,
            view: view,
            teaser: leadText,
            full: hasLead
                ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
                    _subLabel(context, leadLabel),
                    leadUpMarkdown(theme, leadText),
                  ])
                : null,
          ),
      };
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 0), child: _InboxHead(item: it, state: state)),
        if (s.brief?.items.isNotEmpty ?? false)
          Padding(padding: const EdgeInsets.fromLTRB(16, 6, 16, 0), child: BriefItemRow(s.brief!.items.first)),
        if (retry != null && !hasLead) Padding(padding: const EdgeInsets.fromLTRB(10, 4, 16, 0), child: retry),
        Expanded(
          child: Align(
            alignment: Alignment.topCenter,
            child: QuestionAnswerPanel(
              key: const ValueKey('inbox-question-panel'),
              question: q,
              contextText: lead?.leadUp,
              contextBody: body,
              // Only a ready summary reads from its head; its words opened under
              // it, a failed summary's words, or a teaser, open at their end (#108).
              contextAtTop: view == DigestView.ready && !state._fullContext.contains(it.key),
              contextLabel: view == DigestView.loading || view == DigestView.ready ? kDigestLabel : leadLabel,
              drafts: QuestionDraftStore.instance.of(s.server.baseUrl, s.id),
              draftKey: questionSignature(q),
              elsewhereLabel: 'Open session',
              onKey: null,
              // Takes focus as it mounts, so hardware Enter reaches it on a desktop.
              // An autofocus never moves focus that is already held, so a reply box
              // being typed into keeps it.
              autofocus: true,
              onDismiss: () => state._openSession(s),
              onSend: (frames) => unawaited(state._answer(it, q, frames)),
            ),
          ),
        ),
      ]);
    }
    final actions = _actions(context);
    return Container(
      margin: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppShape.large),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: LayoutBuilder(builder: (context, box) {
            final children = <Widget>[
              _InboxHead(item: it, state: state),
              if (s?.brief?.items.isNotEmpty ?? false) ...[for (final i in s!.brief!.items) BriefItemRow(i)],
              ..._body(context, box.maxHeight),
            ];
            return SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (final (i, w) in children.indexed) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 10), child: w),
              ]),
            );
          }),
        ),
        ...actions,
      ]),
    );
  }

  Widget _markdown(BuildContext context, String text) {
    final theme = Theme.of(context);
    return directionalBlock(
      text,
      (t) => MarkdownBody(
        data: t,
        selectable: true,
        fitContent: true,
        extensionSet: md.ExtensionSet.gitHubWeb,
        onTapLink: (_, href, _) => openChatLink(href),
        styleSheet: markdownStyle(
          theme,
          theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurface),
          theme.textTheme.bodySmall,
        ),
      ),
    );
  }

  Widget _tail(BuildContext context, Session s) {
    final lines = state._tails[sessionKey(s)];
    if (lines == null) return Text('Reading its screen...', style: Theme.of(context).textTheme.bodySmall);
    if (lines.isEmpty) return const SizedBox.shrink();
    return TerminalTailStrip(key: const ValueKey('inbox-tail'), lines: lines, onTap: () => state._openSession(s));
  }

  Widget _label(BuildContext context, String text) => Text(text,
      style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant));

  /// What the focused item says, for a view [viewport] tall.
  List<Widget> _body(BuildContext context, double viewport) {
    final it = item;
    final s = it.session;
    switch (it.kind) {
      case InboxKind.permission:
        // What led up to it is the agent's whole turn, not the notification's 200
        // characters; the attention record's text stays only as the fallback.
        // Only an UNAMBIGUOUS call is named ([permissionToolCall]): a wrong command on
        // an approval screen is worse than none, and the line above still says what
        // waits.
        final tool = permissionToolCall(it.turn?.pendingTool, s!.brief?.now?.text);
        final what = tool == null ? null : toolCallText(tool);
        final turnLead = it.turn?.leadUp;
        final lead = turnLead ?? state._attention[sessionKey(s)]?.info?.lastMessage?.trim() ?? '';
        final k = sessionKey(s);
        final open = state._expanded.contains(k);
        final full = lead.isEmpty
            ? const <Widget>[]
            : [
                _label(context, turnLead != null ? it.turn!.leadUpLabel : kLeadUpLabel),
                _ClampedLead(
                  open: open,
                  clamp: math.max(kLeadClamp, viewport * kLeadShare),
                  onToggle: () => state._update(() => open ? state._expanded.remove(k) : state._expanded.add(k)),
                  child: _markdown(context, lead),
                ),
              ];
        // "Wants to run" is the transcript's tool call, checked against the server's
        // line, and NEVER the summary's words: a wrong command on an approval screen
        // is worse than none.
        // What is being approved comes FIRST, right under the head: the summary is a
        // reading of it and goes below, so on a phone it never pushes the command
        // off the screen.
        return [
          _label(context, 'Permission'),
          DirectionalText(state._permissionReason(s), style: Theme.of(context).textTheme.bodyLarge),
          if (what != null) ...[
            _label(context, 'Wants to run'),
            _ToolCall(name: tool!.name, text: what),
          ],
          ..._summary(context, full, lead),
          if (!_folded) ...full,
          _label(context, 'Its screen'),
          _tail(context, s),
        ];
      case InboxKind.menu || InboxKind.waiting:
        return [
          Text(it.kind == InboxKind.menu
              ? 'A panel covers the composer. Esc closes it.'
              : 'It is waiting on you. Its screen shows what for.'),
          _tail(context, s!),
        ];
      case InboxKind.prose:
        final full = [
          _label(context, 'Its last reply'),
          KeyedSubtree(key: const ValueKey('inbox-last-reply'), child: _markdown(context, tldrFirst(it.turn!.prose))),
        ];
        return [..._summary(context, full, it.turn!.prose), if (!_folded) ...full];
      case InboxKind.reported:
        final waiting = s!.reason?.text ?? '';
        final turn = it.turn;
        final prose = turn?.prose ?? '';
        // The real reply, TL;DR first. When the turn has no prose, what led up to
        // it; the session's TL;DR only until the transcript has been read.
        final full = [
          if (prose.isNotEmpty) ...[
            _label(context, 'Its last reply'),
            KeyedSubtree(key: const ValueKey('inbox-last-reply'), child: _markdown(context, tldrFirst(prose))),
          ] else if (turn?.leadUp != null) ...[
            _label(context, 'Before it asked'),
            KeyedSubtree(key: const ValueKey('inbox-last-reply'), child: _markdown(context, turn!.leadUp!)),
          ] else if (s.brief?.did != null) ...[
            _label(context, 'Asks'),
            _markdown(context, s.brief!.did!.text),
          ],
        ];
        final teaser = prose.isNotEmpty ? prose : (turn?.leadUp ?? s.brief?.did?.text ?? '');
        return [
          ..._summary(context, full, teaser),
          if (waiting.isNotEmpty) ...[_label(context, 'Waiting for'), DirectionalText(waiting)],
          if (!_folded) ...full,
        ];
      case InboxKind.background:
        final a = it.agent!;
        return [
          _label(context, 'Background agent'),
          Text([a.name, a.cwdTail].whereType<String>().join(' - ')),
          _label(context, 'Waiting for'),
          DirectionalText(a.waitingFor ?? ''),
          if (s == null)
            Text('Answer it with `claude agents` on ${it.server.name}.',
                key: const ValueKey('inbox-agent-elsewhere'), style: Theme.of(context).textTheme.bodySmall),
        ];
      case InboxKind.question:
        return const [];
    }
  }

  /// Whether the agent's own words sit folded under the summary ([_DigestSection]),
  /// rather than in their usual place.
  bool get _folded {
    final v = state._digestView(item);
    return v == DigestView.loading || v == DigestView.ready;
  }

  /// The summary block at the top of the view: while it is written or once it is
  /// ready, with [full] (the agent's own words) folded inside it behind "Show full
  /// context"; when it failed, just the retry, the words staying where they always
  /// are. Nothing for a server that writes none, or a summary that is empty.
  List<Widget> _summary(BuildContext context, List<Widget> full, String teaser) {
    final s = item.session;
    final view = state._digestView(item);
    switch (view) {
      case DigestView.off || DigestView.plain:
        return const [];
      case DigestView.failed:
        return [_DigestRetry(waits: state._digestRetryWaits(s!), onRetry: () => state._retryDigest(s))];
      case DigestView.loading || DigestView.ready:
        return [
          _DigestSection(
            item: item,
            state: state,
            view: view,
            header: true,
            teaser: teaser,
            full: full.isEmpty
                ? null
                : Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
                    for (final (i, w) in full.indexed) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 10), child: w),
                  ]),
          ),
        ];
    }
  }

  List<Widget> _actions(BuildContext context) {
    final it = item;
    final s = it.session;
    final pad = const EdgeInsets.fromLTRB(16, 0, 16, 12);
    final openBtn = s == null
        ? null
        : OutlinedButton(
            key: const ValueKey('inbox-open-session'), onPressed: () => state._openSession(s), child: const Text('Open session'));
    Widget row(List<Widget?> buttons) => Padding(
          padding: pad,
          child: Wrap(spacing: 8, runSpacing: 6, alignment: WrapAlignment.end, children: buttons.whereType<Widget>().toList()),
        );
    switch (it.kind) {
      case InboxKind.prose || InboxKind.reported:
        final reported = it.kind == InboxKind.reported;
        return [
          Padding(
            padding: pad,
            child: ReplyBox(
              key: const ValueKey('inbox-focus-reply'),
              controller: state._needs.replyBox(s!),
              name: s.name,
              ready: s.agentReady && !gone,
              busy: state._needs.isBusy(s),
              multiline: true,
              onSend: (t) => reported ? state._replyReported(s, t) : state._replyProse(s, t),
            ),
          ),
          row([
            if (!reported)
              TextButton(
                  key: const ValueKey('inbox-not-question'), onPressed: () => state._notAQuestion(it), child: const Text('Not a question')),
            if (reported && state._repo.canClearWait(s))
              TextButton(
                  key: const ValueKey('inbox-not-waiting'), onPressed: () => state._notWaiting(s), child: const Text('Not waiting')),
            openBtn,
          ]),
        ];
      case InboxKind.menu:
        return [
          row([
            FilledButton(
              key: const ValueKey('inbox-esc'),
              onPressed: gone || state._needs.isBusy(s!) ? null : () => state._esc(s),
              child: const Text('Send Esc'),
            ),
            openBtn,
          ]),
        ];
      default:
        return [row([openBtn])];
    }
  }
}
