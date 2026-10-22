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
// that need it: a question row's live question (throttled by [NeedsYouActions]), a prose
// candidate's recap once per (session, lastActivity), the focused item's lead-up,
// permission detail and terminal tail, and each server's background agents.

import 'dart:async';

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
import '../util/inbox_items.dart';
import '../util/needs_you.dart';
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
import '../widgets/question_overlay.dart' show AnswerFrame, kWideMinWidth, lastAssistantText;
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

  /// A prose candidate's recap, by [sessionKey], with the `lastActivity` it was read at.
  final Map<String, ({int? at, SessionRecap? recap})> _recaps = {};
  final Set<String> _recapsInFlight = {};

  /// A permission row's attention record, with the wait start it was read for.
  final Map<String, ({int? since, AttentionInfo? info})> _attention = {};

  /// A question's lead-up, by [sessionKey], for the question signature it was read for.
  final Map<String, ({String sig, String? text})> _context = {};

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

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  SessionInputRunner get _input => widget.sessionInput ?? runWithSessionInput;
  Color? _colorOf(String baseUrl) => colorFromHex(_repo.serverColor(baseUrl));

  @override
  void initState() {
    super.initState();
    _sessions = _repo.current;
    _needs.addListener(_onNeeds);
    _sub = _repo.sessions.listen((list) {
      if (_disposed) return;
      _update(() => _sessions = list);
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

  void _changed() => _update(() {});

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
    unawaited(_refreshRecaps());
    unawaited(_refreshAttention());
    unawaited(_refreshFocused());
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
    _context.removeWhere((k, _) => !live.contains(k));
    _expanded.removeWhere((k) => !live.contains(k));
  }

  /// A prose candidate's recap, once per (session, lastActivity): never on a poll.
  Future<void> _refreshRecaps() async {
    final candidates = _sessions.where(proseCandidate).toList();
    final live = {for (final s in candidates) sessionKey(s)};
    _recaps.removeWhere((k, _) => !live.contains(k));
    final due = candidates.where((s) {
      final k = sessionKey(s);
      final hit = _recaps[k];
      return !_recapsInFlight.contains(k) && (hit == null || hit.at != s.lastActivity);
    }).toList();
    if (due.isEmpty) return;
    for (final s in due) {
      _recapsInFlight.add(sessionKey(s));
    }
    await Future.wait(due.map((s) async {
      SessionRecap? recap;
      try {
        recap = await _client(s.server).recap(s.id);
      } catch (_) {/* no reply to read is no question to show; asked again on new activity */}
      _recapsInFlight.remove(sessionKey(s));
      if (_disposed) return;
      _recaps[sessionKey(s)] = (at: s.lastActivity, recap: recap);
    }));
    _changed();
  }

  /// A permission row's attention record, once per wait; the focused one is re-read.
  Future<void> _refreshAttention({String? force}) async {
    final rows = _sessions.where((s) => boardNeedsYou(s) && needKindOf(s) == NeedKind.permission).toList();
    final live = {for (final s in rows) sessionKey(s)};
    _attention.removeWhere((k, _) => !live.contains(k));
    final due = rows.where((s) {
      final k = sessionKey(s);
      final since = s.reason?.since ?? s.lastActivity;
      return k == force || _attention[k] == null || _attention[k]!.since != since;
    }).toList();
    if (due.isEmpty) return;
    for (final s in due) {
      final since = s.reason?.since ?? s.lastActivity;
      _attention[sessionKey(s)] = (since: since, info: _attention[sessionKey(s)]?.info);
    }
    await Future.wait(due.map((s) async {
      try {
        final info = await _client(s.server).attention(s.id);
        if (_disposed) return;
        _attention[sessionKey(s)] = (since: s.reason?.since ?? s.lastActivity, info: info);
      } catch (_) {/* the card falls back to the session's own words */}
    }));
    _changed();
  }

  /// What only the FOCUSED item needs: a question's lead-up (once per question), and
  /// the terminal tail of a permission, menu or plain wait ([force]: re-read it).
  Future<void> _refreshFocused({bool force = false}) async {
    if (_disposed) return;
    final it = _currentFocus();
    final s = it?.session;
    if (it == null || s == null) return;
    final k = sessionKey(s);
    switch (it.kind) {
      case InboxKind.question:
        final q = it.question;
        if (q == null) return;
        final sig = questionSignature(q);
        if (_context[k]?.sig == sig) return;
        _context[k] = (sig: sig, text: null);
        try {
          final page = await _client(s.server).transcript(s.id, limit: 12);
          if (_disposed) return;
          _context[k] = (sig: sig, text: lastAssistantText(page.messages));
          _changed();
        } catch (_) {
          // No lead-up panel for now; asked again on the next refresh, not cached.
          if (_context[k]?.sig == sig && _context[k]?.text == null) _context.remove(k);
        }
      case InboxKind.permission || InboxKind.menu || InboxKind.waiting:
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

  // ---- the items -----------------------------------------------------------------

  List<InboxItem> get _items => inboxItemsOf(
        _sessions,
        questions: {
          for (final s in _sessions)
            if (needKindOf(s) == NeedKind.question) sessionKey(s): _needs.questionFor(s),
        },
        recaps: {for (final e in _recaps.entries) e.key: e.value.recap},
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
    unawaited(_refreshFocused());
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
    final r = it.reply;
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

/// A labelled, clamped line: `<b>Label:</b> text`, in the direction of the text's
/// first paragraph (a clamped snippet is one block).
Widget _labelled(BuildContext context, String label, String text, {int maxLines = 3, Key? key}) {
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
    overflow: TextOverflow.ellipsis,
    textDirection: textDirectionFor(paragraphsOf(text).firstOrNull ?? ''),
    style: theme.textTheme.bodySmall?.copyWith(fontSize: 13),
  );
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
    switch (it.kind) {
      case InboxKind.question:
        final q = it.question;
        final text = (q == null || q.questions.isEmpty) ? 'reading it...' : q.questions.first.question;
        return [_labelled(context, 'Question', text, maxLines: 3)];
      case InboxKind.permission:
        return [_labelled(context, 'Permission', state._permissionReason(s!), maxLines: 2)];
      case InboxKind.prose:
        final paras = it.reply!.text.trim().split(RegExp(r'\n[ \t]*\n'));
        return [_labelled(context, 'May be asking', paras.last.trim(), maxLines: 4)];
      case InboxKind.reported:
        final waiting = s!.reason?.text ?? '';
        return [
          if (waiting.isNotEmpty) _labelled(context, 'Waiting', waiting),
          if (s.brief?.did != null) _labelled(context, 'Asks', s.brief!.did!.text, maxLines: 4),
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
      final ctx = state._context[sessionKey(s)];
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 0), child: _InboxHead(item: it, state: state)),
        if (s.brief?.items.isNotEmpty ?? false)
          Padding(padding: const EdgeInsets.fromLTRB(16, 6, 16, 0), child: BriefItemRow(s.brief!.items.first)),
        Expanded(
          child: Align(
            alignment: Alignment.topCenter,
            child: QuestionAnswerPanel(
              key: const ValueKey('inbox-question-panel'),
              question: q,
              contextText: ctx?.sig == questionSignature(q) ? ctx?.text : null,
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
    final children = <Widget>[
      _InboxHead(item: it, state: state),
      if (s?.brief?.items.isNotEmpty ?? false) ...[for (final i in s!.brief!.items) BriefItemRow(i)],
      ..._body(context),
    ];
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
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final (i, w) in children.indexed) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 10), child: w),
            ]),
          ),
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

  List<Widget> _body(BuildContext context) {
    final it = item;
    final s = it.session;
    switch (it.kind) {
      case InboxKind.permission:
        final info = state._attention[sessionKey(s!)]?.info;
        final last = info?.lastMessage?.trim() ?? '';
        final k = sessionKey(s);
        final open = state._expanded.contains(k);
        return [
          _label(context, 'Permission'),
          DirectionalText(state._permissionReason(s), style: Theme.of(context).textTheme.bodyLarge),
          if (last.isNotEmpty) ...[
            _label(context, 'Claude said'),
            DirectionalText(last, maxLines: open ? null : 6, overflow: open ? null : TextOverflow.ellipsis),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => state._update(() => open ? state._expanded.remove(k) : state._expanded.add(k)),
                child: Text(open ? 'Show less' : 'Show all'),
              ),
            ),
          ],
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
        return [_label(context, 'Its last reply'), _markdown(context, it.reply!.text)];
      case InboxKind.reported:
        final waiting = s!.reason?.text ?? '';
        return [
          if (waiting.isNotEmpty) ...[_label(context, 'Waiting for'), DirectionalText(waiting)],
          if (s.brief?.did != null) ...[_label(context, 'Asks'), _markdown(context, s.brief!.did!.text)],
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
