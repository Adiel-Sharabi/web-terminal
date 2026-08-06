/// The Chat lens — the centerpiece the owner wants over the raw terminal:
/// Claude's conversation rendered as a chat transcript instead of a VT100
/// screen.
///
/// User and agent turns must read apart at a glance, without reading the
/// text (#54) — via a COMBINATION of cues, never colour alone: a user turn
/// is the rarer, higher-signal landmark, so it pops — right-aligned, a
/// bounded bubble tinted with the app's own accent, fronted by a small "You"
/// tag. An agent turn is the calm, high-volume bulk, so it stays quiet —
/// left-aligned, near full width (so its code blocks and tool cards keep
/// real room instead of being squeezed into a narrow bubble), an
/// almost-transparent surface with only a thin left accent stripe in the
/// agent's OWN registry colour (`GET /api/agents` via `AgentCatalog` — never
/// hardcoded here), fronted by a small tag naming it. Fenced code blocks
/// render in their own tap-to-copy containers, tool calls as collapsed
/// chips, native text selection throughout (no markdown package — selection
/// is the whole point).
///
/// Data comes from `GET /api/sessions/:id/transcript`, backward-paginated
/// (newest-last per page; `before=<cursor>` walks further into history) via
/// `ApiClient.transcript()` / `TranscriptPage` / `TranscriptTurn` / `ToolUse`
/// (lib/api/api_client.dart, lib/api/models.dart).
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../api/agent_catalog.dart';
import '../api/api_client.dart';
import '../api/models.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/pulse_clock.dart';
import '../theme/status_colors.dart';
import '../util/terminal_links.dart';
import 'empty_state.dart';
import 'format_utils.dart';
import 'pulsing_dots.dart';
// #54: reuses the SAME hex->Color parser SessionCard's agent chip already
// uses for GET /api/agents' colour field — one parser, not a second copy
// that could drift from it.
import 'session_card.dart' show parseAgentColor;
import 'waiting_banner.dart';

/// Turns per page — matches the server's default.
const int _kPageSize = 50;

/// How close to an edge (in pixels) counts as "there" for pin-to-bottom and
/// load-older-on-scroll-to-top detection.
const double _kEdgeThreshold = 80;

/// Injectable transcript fetch signature — the default calls the real
/// (bridged) `ApiClient.transcript`; tests supply canned pages instead.
typedef TranscriptFetcher =
    Future<TranscriptPage> Function(
      String sessionId, {
      String? before,
      int? limit,
    });

/// Fetches one page of a subagent's transcript, already bound to a session — so a
/// nested subagent card can drill deeper with the same closure. Injectable for
/// tests; defaults to `ApiClient(session.server).subagent(session.id, …)`.
typedef SubagentFetcher =
    Future<SubagentPage> Function(
      String toolUseId, {
      String? before,
      int? limit,
    });

/// Every Task subagent in the transcript, in transcript order, de-duped by
/// tool_use id — the SSOT the pinned strip (#62) lists so a session's subagents
/// stay reachable however far the conversation has scrolled. Walks turns →
/// toolUses (there is no flat tool list); a tool is a subagent iff it carries a
/// [SubagentTrace] stub (`ToolUse.subagent != null`, server-stamped).
List<ToolUse> collectSubagents(List<TranscriptTurn> turns) {
  final out = <ToolUse>[];
  final seen = <String>{};
  for (final turn in turns) {
    for (final tool in turn.toolUses) {
      if (tool.subagent != null && seen.add(tool.id)) out.add(tool);
    }
  }
  return out;
}

/// #88 — whether a turn is MECHANICAL: the agent's step-by-step work rather than
/// anything it said. True only for an assistant turn that carries no prose at
/// all, just tool calls.
///
/// This rides the TYPED SHAPE (`text` empty + `toolUses` non-empty), never the
/// text itself. That matters twice over: string-sniffing for "looks like a tool
/// call" would misfire on an answer that merely discusses one, and because
/// `lib/transcript.js` and `lib/transcript-codex.js` emit the same turn type, one
/// rule covers Claude and Codex with no provider branch — the registry rule in
/// CLAUDE.md applied to rendering.
///
/// A turn with BOTH prose and tools stays conversational: it said something, and
/// its tool cards are already individually collapsed.
bool isMechanicalTurn(TranscriptTurn t) =>
    t.role == 'assistant' && t.text.trim().isEmpty && t.toolUses.isNotEmpty;

/// One row of the chat lens: either a single turn, or a run of consecutive
/// mechanical turns folded behind one marker (#88).
class TranscriptChunk {
  TranscriptChunk.turn(TranscriptTurn turn)
      : turns = <TranscriptTurn>[turn],
        mechanical = false;
  TranscriptChunk.mechanical(this.turns) : mechanical = true;

  /// The turns this row stands for — exactly one when [mechanical] is false.
  final List<TranscriptTurn> turns;

  /// Whether this row is a folded run of mechanical turns.
  final bool mechanical;

  /// Stable identity for this row, taken from its FIRST turn.
  ///
  /// Deliberately not derived from the whole run: on a live session the agent
  /// keeps appending tool turns, so a key covering every turn would change on
  /// each 4s poll and slam an expanded fold shut while the user was reading it.
  /// The first turn's tool-use id is immutable once the run exists.
  String get foldKey {
    final first = turns.first;
    if (first.toolUses.isNotEmpty) return first.toolUses.first.id;
    return first.ts ?? '${turns.length}';
  }

  /// Distinct tool names across the run, in first-use order — the marker's
  /// subtitle, so a fold says WHAT was done, not merely how much.
  List<String> get toolNames {
    final seen = <String>{};
    final out = <String>[];
    for (final t in turns) {
      for (final tool in t.toolUses) {
        if (seen.add(tool.name)) out.add(tool.name);
      }
    }
    return out;
  }
}

/// Folds each run of consecutive mechanical turns into one [TranscriptChunk],
/// leaving conversational turns as single chunks. PURE, so the folding rule is
/// unit-testable without pumping a widget.
///
/// Runs are folded even when only one turn long: the point is a transcript whose
/// rows are all either something said or one compact "did N things" marker, and
/// a lone tool turn is no more readable than a pair.
List<TranscriptChunk> groupTranscriptTurns(List<TranscriptTurn> turns) {
  final out = <TranscriptChunk>[];
  var run = <TranscriptTurn>[];
  void flush() {
    if (run.isEmpty) return;
    out.add(TranscriptChunk.mechanical(run));
    run = <TranscriptTurn>[];
  }

  for (final t in turns) {
    if (isMechanicalTurn(t)) {
      run.add(t);
    } else {
      flush();
      out.add(TranscriptChunk.turn(t));
    }
  }
  flush();
  return out;
}

class ConversationView extends StatefulWidget {
  const ConversationView({
    super.key,
    required this.session,
    this.onNoTranscript,
    this.fetchPage,
    this.fetchSubagent,
    this.submittedPrompts,
    this.onSubmitToSession,
    this.derivedCtxSink,
    this.selectionSink,
  });

  /// #83 — where to publish the lens's CURRENT selected text ('' when none).
  ///
  /// Lifted for the same reason as [derivedCtxSink]: only this widget can see
  /// the selection (the `SelectionArea` is its own), but only the screen above
  /// can own a keyboard shortcut that works while the compose field holds focus.
  /// Publishing the text — rather than exposing the region — keeps the copy path
  /// a plain clipboard write with nothing to keep in sync.
  final ValueNotifier<String>? selectionSink;

  /// Where to publish the transcript-derived ctx% (#74).
  ///
  /// The badges moved out of this widget and up into the session's meta bar, but
  /// only the chat lens can compute this estimate — it needs the turns. So the
  /// value is LIFTED rather than dropped: the bar reads it from here. Null in
  /// contexts that don't render a bar (tests, the subagent sheet).
  final ValueNotifier<int?>? derivedCtxSink;

  final Session session;

  /// Called once if the initial load 404s (no transcript for this session) —
  /// the caller (SessionScreen) falls back to the Terminal lens silently.
  final VoidCallback? onNoTranscript;

  /// Injectable for tests; defaults to `ApiClient(session.server).transcript`.
  final TranscriptFetcher? fetchPage;

  /// Injectable for tests; defaults to `ApiClient(session.server).subagent`.
  /// Drives the drill-in subagent panels on `Task` tool cards.
  final SubagentFetcher? fetchSubagent;

  /// Prompts the user just submitted in the compose bar (#31). Each is echoed
  /// immediately as a "Queued" bubble so the user sees their input registered
  /// even while Claude is still working, then reconciled away when the matching
  /// real transcript turn arrives.
  final Stream<String>? submittedPrompts;

  /// Submits an explicit prompt to the SESSION (the main agent's PTY) via the same
  /// path the compose bar uses. Lets the subagent drill-in sheet offer a "message
  /// session" input, mirroring what the terminal lens allows while a subagent runs —
  /// there is no channel to a specific subagent, so this reaches the session. Null in
  /// tests / contexts that don't wire it (the sheet then hides the input).
  final void Function(String)? onSubmitToSession;

  @override
  State<ConversationView> createState() => _ConversationViewState();
}

class _ConversationViewState extends State<ConversationView> {
  late final TranscriptFetcher _fetch = widget.fetchPage ?? _defaultFetch;

  final ScrollController _scrollController = ScrollController();
  List<TranscriptTurn> _turns = const [];

  /// #73 — the agent's task list, or null when it has none (no panel at all).
  /// Session state rather than page state: only the newest page reports it, and
  /// [_applyTaskList] is called on every fetch so it tracks even when the turns
  /// themselves did not change.
  List<AgentTask>? _taskList;
  String? _oldestCursor;
  bool _hasMoreOlder = false;
  bool _loadingInitial = true;
  bool _loadingOlder = false;
  String? _error;
  bool _pinnedToBottom = true;
  bool _showNewPill = false;
  Timer? _pollTimer;
  final List<Timer> _scrollTimers = <Timer>[];

  /// Optimistic user-prompt echoes not yet reflected in the transcript (#31).
  final List<_PendingEcho> _pendingEchoes = <_PendingEcho>[];
  StreamSubscription<String>? _promptSub;

  Future<TranscriptPage> _defaultFetch(
    String sessionId, {
    String? before,
    int? limit,
  }) {
    return ApiClient(
      widget.session.server,
    ).transcript(sessionId, before: before, limit: limit);
  }

  late final SubagentFetcher _subFetch = widget.fetchSubagent ??
      ((String toolUseId, {String? before, int? limit}) =>
          ApiClient(widget.session.server).subagent(
            widget.session.id,
            toolUseId,
            before: before,
            limit: limit,
          ));

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    _promptSub = widget.submittedPrompts?.listen(_addEcho);
    _loadInitial();
    _setPolling(_shouldLivePoll(widget.session));
  }

  /// Whether the chat should live-poll the transcript tail while it is open.
  ///
  /// This used to be `status == 'working'`, which is the RIGHT signal for Claude —
  /// its hooks drive it to 'working' during a turn and back to idle after. But Codex
  /// has no hooks here, so its status never leaves 'active': the poll timer never
  /// started, and the chat only advanced when the parent happened to rebuild this
  /// widget. Measured on Office: one week-long Codex conversation whose terminal (the
  /// live PTY) had moved on to bug-hunter QA work while the chat lens sat on an
  /// email draft from 37 minutes earlier — same conversation, same instant, because
  /// nothing was refreshing the tail. Polling while 'active' closes that gap.
  ///
  /// 'active' only ever belongs to an agent session here (a plain shell has no chat
  /// lens), so this cannot start a poll for something that has no transcript. The
  /// cost is one bounded last-page fetch every 4s while a chat is open, and
  /// _refreshLastPage short-circuits via _turnListEquals when nothing changed.
  ///
  /// It does NOT make the chat mirror the terminal turn-by-turn: Codex writes an
  /// assistant MESSAGE only when a turn completes, so a long tool-heavy turn still
  /// shows the previous message until it finishes — then the chat catches up within
  /// one poll instead of hanging until the next rebuild.
  static bool _shouldLivePoll(Session s) =>
      s.status == 'working' || s.status == 'active';

  @override
  void didUpdateWidget(covariant ConversationView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A different PTY session id — or the SAME PTY session re-pinned to a
    // different Claude conversation — means everything we hold is stale, so
    // reload from scratch. /clear (and a /compact that starts a fresh session)
    // mints a new Claude session id → a new .jsonl the server now serves; the
    // PTY id doesn't change, so comparing only it left the chat showing the
    // pre-clear transcript forever (#35). Comparing old vs new (not the current
    // value against a constant) means this fires only on an actual change —
    // covers null→id, id→different, and id→null — never on every rebuild.
    // `agent` moves when a session's provider is first detected (null → 'codex'),
    // which changes WHICH transcript the server will serve for the same PTY id.
    // `agentSessionId` is the AGENT-NEUTRAL form of the same signal, and it is what
    // makes this work for Codex at all. `claudeSessionId` is null for every Codex
    // session, so when the server moved to a DIFFERENT rollout — which it legitimately
    // does, because a Codex transcript is discovered ("newest for this cwd") and Codex
    // writes a new one every run — nothing here changed and the cached turns survived.
    // The result was a chat lens showing yesterday's conversation next to a live
    // terminal. Comparing old vs new (never against a constant) keeps this firing only
    // on a real change, including null->id for a server too old to send the field.
    if (oldWidget.session.id != widget.session.id ||
        oldWidget.session.claudeSessionId != widget.session.claudeSessionId ||
        oldWidget.session.agentSessionId != widget.session.agentSessionId ||
        oldWidget.session.agent != widget.session.agent) {
      _resetAndReload();
      return;
    }
    final wasPolling = _shouldLivePoll(oldWidget.session);
    final isPolling = _shouldLivePoll(widget.session);
    if (isPolling != wasPolling) _setPolling(isPolling);
    // Session is a plain value object created fresh on every repository
    // emission, so comparing a couple of fields (rather than the whole
    // object, which has no `==`) is the cheap, reliable "did anything
    // relevant change" signal — covers /ws/notify-triggered repo refreshes
    // without this view needing its own repository subscription.
    if (oldWidget.session.lastActivity != widget.session.lastActivity ||
        oldWidget.session.status != widget.session.status) {
      unawaited(_refreshLastPage());
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _promptSub?.cancel();
    for (final t in _scrollTimers) {
      t.cancel();
    }
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  /// Normalizes text for echo↔transcript matching (trim + collapse whitespace),
  /// tolerating the CR/LF and bracketed-paste reshaping the send path applies.
  static String _normEcho(String s) => s.trim().replaceAll(RegExp(r'\s+'), ' ');

  /// Adds an optimistic echo for a just-submitted prompt (#31), unless the
  /// transcript already shows it (a fast round-trip).
  void _addEcho(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    final norm = _normEcho(t);
    final already =
        _turns.any((x) => !x.isAssistant && _normEcho(x.text) == norm) ||
            _pendingEchoes.any((e) => _normEcho(e.text) == norm);
    if (already) return;
    setState(() => _pendingEchoes
        .add(_PendingEcho(t, DateTime.now().millisecondsSinceEpoch)));
    _scrollToBottom();
  }

  /// Drops echoes once their real turn lands (dedupe) or after a safety timeout
  /// (so an unmatched echo never becomes a permanent ghost). Called whenever
  /// `_turns` is refreshed.
  void _reconcileEchoes() {
    if (_pendingEchoes.isEmpty) return;
    final userTexts = <String>{
      for (final t in _turns)
        if (!t.isAssistant) _normEcho(t.text),
    };
    final now = DateTime.now().millisecondsSinceEpoch;
    _pendingEchoes.removeWhere(
      (e) => userTexts.contains(_normEcho(e.text)) || now - e.at > 90000,
    );
  }

  void _resetAndReload() {
    setState(() {
      _turns = const [];
      _oldestCursor = null;
      _hasMoreOlder = false;
      _error = null;
      _showNewPill = false;
      _pinnedToBottom = true;
    });
    _loadInitial();
    _setPolling(_shouldLivePoll(widget.session));
  }

  void _setPolling(bool enabled) {
    _pollTimer?.cancel();
    _pollTimer = enabled
        ? Timer.periodic(
            const Duration(seconds: 4),
            (_) => unawaited(_refreshLastPage()),
          )
        : null;
  }

  Future<void> _loadInitial() async {
    setState(() {
      _loadingInitial = true;
      _error = null;
    });
    try {
      final page = await _fetch(widget.session.id, limit: _kPageSize);
      if (!mounted) return;
      setState(() {
        _turns = page.messages;
        _taskList = page.taskList;
        _oldestCursor = page.cursor;
        _hasMoreOlder = page.hasMore;
        _loadingInitial = false;
        _reconcileEchoes();
      });
      _scrollToBottom(jump: true);
    } catch (e) {
      if (!mounted) return;
      if (e is ApiException && e.status == 404) {
        // The caller (SessionScreen) is expected to stop building this
        // widget in response — but don't leave it stuck showing an
        // indeterminate spinner forever on the off chance it doesn't.
        setState(() => _loadingInitial = false);
        widget.onNoTranscript?.call();
        return;
      }
      setState(() {
        _error = '$e';
        _loadingInitial = false;
      });
    }
  }

  Future<void> _loadOlder() async {
    if (_loadingOlder || !_hasMoreOlder) return;
    setState(() => _loadingOlder = true);
    try {
      final page = await _fetch(
        widget.session.id,
        before: _oldestCursor,
        limit: _kPageSize,
      );
      if (!mounted) return;
      final hadClients = _scrollController.hasClients;
      final oldExtent = hadClients
          ? _scrollController.position.maxScrollExtent
          : 0.0;
      // Reaching here NORMALLY means the user scrolled to the TOP to trigger
      // this fetch — never the bottom. But _onScroll's top/bottom edge
      // thresholds are two independent checks against the SAME pixel range,
      // so when the transcript is short enough to fit the viewport without
      // scrolling at all (oldExtent == 0 — nothing to scroll), they coincide:
      // the very first render (or a jump-to-bottom on load) can fire the
      // "at top" branch even though the reader never moved and is still
      // genuinely at the bottom. Only treat this as "the user left the
      // bottom" when there was actually something to scroll away from.
      final wasScrollable = hadClients && oldExtent > 0;
      setState(() {
        _turns = [...page.messages, ..._turns];
        _oldestCursor = page.cursor;
        _hasMoreOlder = page.hasMore;
        _loadingOlder = false;
        // Assert this directly rather than trusting _onScroll's own
        // re-derivation: prepending a large page shifts scroll metrics before
        // the anchor jump below has run, and a stray scroll notification in
        // that window can otherwise misread the transient position as "at the
        // bottom" and latch _pinnedToBottom true — which is exactly what let
        // the next status refresh's _scrollToBottom() yank the view away from
        // the history the user just paged into (#47). Gated on [wasScrollable]
        // so the short-transcript edge case above leaves this alone — the
        // reader really is still at the bottom and must stay auto-following.
        if (wasScrollable) _pinnedToBottom = false;
      });
      if (hadClients) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !_scrollController.hasClients) return;
          final newExtent = _scrollController.position.maxScrollExtent;
          _scrollController.jumpTo(
            _scrollController.position.pixels + (newExtent - oldExtent),
          );
          // The jump above only preserves the user's reading position — it
          // must never be (mis)read as "the user reached the bottom" either.
          // Any onScroll-driven re-pin from the jump's own notification is
          // synchronous and already happened by the time jumpTo returns, so
          // this reasserts the true state (#47) — but only when wasScrollable
          // decided un-pinning was warranted in the first place; otherwise
          // _pinnedToBottom is already correctly true and must stay that way.
          if (wasScrollable && _pinnedToBottom) {
            setState(() => _pinnedToBottom = false);
          }
        });
      }
    } catch (_) {
      // Best-effort — scrolling again naturally retries via the listener.
      if (mounted) setState(() => _loadingOlder = false);
    }
  }

  /// Refetches the last page and reconciles it into `_turns` — the simplest
  /// robust merge given turns have no ids. Skips the rebuild entirely when
  /// nothing changed.
  ///
  /// Two cases, keyed off the page's `hasMore`:
  ///  * `!hasMore` — this page IS the whole transcript (no older turns beyond
  ///    it), so it's authoritative: replace `_turns` wholesale. This is what
  ///    reflects a /clear or /compact that reset or shrank the transcript; an
  ///    append-only merge can only grow and would leave the stale pre-clear
  ///    prefix (and an empty fresh transcript) showing forever (#35). In normal
  ///    small-transcript streaming this already resolved to a full replace, so
  ///    it's no behaviour change there — only the shrink/reset case is fixed.
  ///  * `hasMore` — older turns remain that we're not refetching, so keep the
  ///    prefix we already hold and swap in just the refreshed trailing window
  ///    (the common "grows while working" fast path; the cheap tail-only
  ///    comparison avoids rebuilding a large held transcript every poll).
  Future<void> _refreshLastPage() async {
    final TranscriptPage page;
    try {
      page = await _fetch(widget.session.id, limit: _kPageSize);
    } catch (_) {
      return; // best-effort background refresh
    }
    if (!mounted) return;
    // #73 — BEFORE the turn-merge early-returns. A task's status can move without the
    // transcript's trailing window changing shape, and every one of the paths below
    // returns early when the turns compare equal; folding this in after them would make
    // the panel update only when the conversation happened to grow.
    _applyTaskList(page.taskList);
    final freshTail = page.messages;

    if (!page.hasMore) {
      if (_turnListEquals(_turns, freshTail)) return;
      _applyRefreshedTurns(freshTail);
      return;
    }

    if (freshTail.isEmpty) return;
    final existingTail = _turns.length >= freshTail.length
        ? _turns.sublist(_turns.length - freshTail.length)
        : _turns;
    if (_turnListEquals(existingTail, freshTail)) return;
    final keepCount = _turns.length > freshTail.length
        ? _turns.length - freshTail.length
        : 0;
    _applyRefreshedTurns([..._turns.sublist(0, keepCount), ...freshTail]);
  }

  /// Commits a refreshed task list, rebuilding only when something actually moved.
  /// [AgentTask] is a value type, so an unchanged list on the 4s poll costs one
  /// comparison and no rebuild — which is also what keeps the panel's expanded/collapsed
  /// state from being churned by polling.
  void _applyTaskList(List<AgentTask>? next) {
    final cur = _taskList;
    if (cur == null && next == null) return;
    if (cur != null && next != null && listEquals(cur, next)) return;
    setState(() => _taskList = next);
  }

  /// Commits a freshly-merged turn list from [_refreshLastPage] and follows the
  /// content: re-pin to the bottom when already there, else raise the "New"
  /// pill. Single owner of the apply+scroll step so both merge paths behave
  /// identically.
  void _applyRefreshedTurns(List<TranscriptTurn> turns) {
    setState(() {
      _turns = turns;
      _reconcileEchoes();
    });
    if (_pinnedToBottom) {
      _scrollToBottom();
    } else {
      setState(() => _showNewPill = true);
    }
  }

  /// `TranscriptTurn`/`ToolUse` have no `==` override, so the "did the tail
  /// actually change" check compares the fields that matter (role, text, ts,
  /// and each tool use's name/inputPreview) by hand.
  bool _turnListEquals(List<TranscriptTurn> a, List<TranscriptTurn> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      final ta = a[i];
      final tb = b[i];
      if (ta.role != tb.role || ta.text != tb.text || ta.ts != tb.ts) {
        return false;
      }
      if (ta.toolUses.length != tb.toolUses.length) return false;
      for (var j = 0; j < ta.toolUses.length; j++) {
        if (ta.toolUses[j].name != tb.toolUses[j].name ||
            ta.toolUses[j].inputPreview != tb.toolUses[j].inputPreview) {
          return false;
        }
      }
    }
    return true;
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final pos = _scrollController.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - _kEdgeThreshold;
    if (atBottom != _pinnedToBottom) {
      setState(() {
        _pinnedToBottom = atBottom;
        if (atBottom) _showNewPill = false;
      });
    }
    if (pos.pixels <= pos.minScrollExtent + _kEdgeThreshold &&
        _hasMoreOlder &&
        !_loadingOlder) {
      unawaited(_loadOlder());
    }
  }

  void _scrollToBottom({bool jump = false}) {
    if (jump) {
      // A ListView.builder only *estimates* maxScrollExtent until the tail
      // turns are actually laid out, so a single jump on open lands short and
      // leaves older messages showing. Jump now, again next frame, and twice
      // more after layout settles so we always end on the newest turn.
      void go() {
        if (!mounted || !_scrollController.hasClients) return;
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }

      WidgetsBinding.instance.addPostFrameCallback((_) {
        go();
        WidgetsBinding.instance.addPostFrameCallback((_) => go());
      });
      _scrollTimers.add(Timer(const Duration(milliseconds: 150), go));
      _scrollTimers.add(Timer(const Duration(milliseconds: 400), go));
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  void _jumpToNew() {
    setState(() => _showNewPill = false);
    _scrollToBottom();
  }

  /// Opens a subagent's live drill-in in a focused sheet (#62). Reuses the SAME
  /// paging path the inline card uses (`_subFetch` → `GET /subagent/:toolUseId`) —
  /// one fetch path, not a second. The subagent transcript is read-only (subagents run
  /// autonomously), but the sheet carries a "message session" input so you can type
  /// from here exactly as the terminal lens lets you — routed to the session via
  /// [onSubmitToSession], not a fictional per-subagent channel.
  void _openSubagentSheet(ToolUse tool) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetCtx) => _SubagentSheet(
        tool: tool,
        subFetch: _subFetch,
        onSubmit: widget.onSubmitToSession,
      ),
    );
  }

  /// Approximate context-window % from the newest assistant turn's token count,
  /// used only when the live status line hasn't posted a real ctx (e.g. an idle
  /// session). Shown with a `~` to signal it's an estimate.
  ///
  /// #71 — the denominator comes from the SERVER (`metrics.ctxWindow`), never
  /// from here. It used to be a hardcoded 200000, which is right for most
  /// sessions and wrong for every extended-context one: a 1M session at 45%
  /// computed 450000/200000 = 225%, clamped to 100, and sat pinned at `~100%`
  /// for most of its life. "How big is the context window" is a fact about the
  /// model, so the client is the wrong owner of it.
  ///
  /// Returns null when the server reported no window — no denominator means no
  /// estimate. Guessing one is precisely the bug this replaced.
  /// Push the derived ctx% to the meta bar. Deferred to after the frame: this is
  /// called from build(), and writing a ValueNotifier synchronously there would
  /// mutate a listener's state mid-build.
  void _publishDerivedCtx() {
    final sink = widget.derivedCtxSink;
    if (sink == null) return;
    final v = _deriveCtxFromTranscript();
    if (sink.value == v) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) sink.value = v;
    });
  }

  int? _deriveCtxFromTranscript() {
    final m = widget.session.metrics;
    if (m?.ctx != null) return null; // live value wins
    final window = m?.ctxWindow;
    if (window == null || window <= 0) return null;
    for (var i = _turns.length - 1; i >= 0; i--) {
      final t = _turns[i];
      if (t.isAssistant && t.ctxTokens != null) {
        return ((t.ctxTokens! / window) * 100).round().clamp(0, 100);
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (_loadingInitial) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Could not load the conversation.',
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: 4),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: _loadInitial,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }
    if (_turns.isEmpty && _pendingEchoes.isEmpty) {
      // The banner still belongs here: a session can be blocked before it has
      // produced any turn at all, and "No messages yet" would otherwise be the
      // whole story on a session that is actually waiting for the user.
      return Column(
        children: [
          if (widget.session.isWaitingOnUser)
            WaitingBanner(kind: widget.session.waitingFor!),
          const Expanded(
            child: EmptyState(
              icon: Icons.forum_outlined,
              title: 'No messages yet',
              subtitle: 'Claude\'s replies will appear here as a conversation',
            ),
          ),
        ],
      );
    }

    final working = widget.session.status == 'working';
    // #65: an overlay on top of status, exactly like apiError — never a
    // SessionStatus value. Takes priority over the plain "working" indicator
    // below when both apply, so a compaction mid-turn reads as what it is
    // rather than an ordinary slow turn.
    final compacting =
        SessionRepository.instance.compactingFor(widget.session.id)?.active ??
            false;
    final leadingLoader = _loadingOlder ? 1 : 0;
    // #88: rows are CHUNKS, not turns — a run of tool-only turns renders as one
    // fold. Recomputed per build (pure + cheap); the transcript is already fully
    // in memory, so there is nothing to cache and nothing to invalidate.
    final chunks = groupTranscriptTurns(_turns);
    final subagents = collectSubagents(_turns);
    // #74: the badges live in the session's meta bar now (so a terminal-lens
    // session gets them too); publish the estimate only this lens can compute.
    _publishDerivedCtx();
    return Column(
      children: [
        // #79: a session blocked on the user says so. Pinned ABOVE the transcript
        // rather than appended to it, because the defining symptom is that no new
        // turn arrives — an inline marker at the bottom would sit wherever the last
        // turn happens to be, and the user would have to scroll to find out that
        // nothing more is coming.
        if (widget.session.isWaitingOnUser)
          WaitingBanner(kind: widget.session.waitingFor!),
        // #62: the session's subagents pinned above the transcript so they stay
        // reachable no matter how far it scrolls. Hidden when there are none.
        if (subagents.isNotEmpty)
          _SubagentStrip(tools: subagents, onOpen: _openSubagentSheet),
        // #73: the agent's task list, pinned above the transcript for the same
        // reason as the two above — progress you have to scroll to find is
        // progress you don't have. Renders nothing at all when there is no list,
        // which is the common case (every plain-shell session, and every agent
        // turn that never made a plan).
        if (_taskList != null && _taskList!.isNotEmpty)
          _TaskListPanel(tasks: _taskList!),
        Expanded(
          child: Stack(
            children: [
        // #27: one SelectionArea over the whole list so a mouse drag selects
        // across lines AND across message bubbles (individual SelectableText /
        // MarkdownBody islands could only select within themselves). The inner
        // bubbles render plain, non-selectable Text/Markdown and let this
        // ancestor own the selection; taps (tool-chip expand, code copy) still
        // pass through. Auto-scrolls while dragging past an edge.
        SelectionArea(
          // #83: publish what is selected so the screen above can copy it. The
          // callback fires on every drag update, so this is also what makes
          // "is there a selection right now" answerable at all.
          onSelectionChanged: (content) =>
              widget.selectionSink?.value = content?.plainText ?? '',
          child: ListView.builder(
          controller: _scrollController,
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: chunks.length +
              leadingLoader +
              ((working || compacting) ? 1 : 0) +
              _pendingEchoes.length,
          itemBuilder: (context, index) {
            if (_loadingOlder && index == 0) {
              return const Padding(
                padding: EdgeInsets.all(12),
                child: Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              );
            }
            var i = index - leadingLoader;
            if (i < chunks.length) {
              final chunk = chunks[i];
              if (chunk.mechanical) {
                return _MechanicalFold(
                  key: ValueKey('fold-${chunk.foldKey}'),
                  chunk: chunk,
                  subFetch: _subFetch,
                  agentId: widget.session.agent,
                );
              }
              return _TurnBubble(
                turn: chunk.turns.single,
                subFetch: _subFetch,
                agentId: widget.session.agent,
              );
            }
            i -= chunks.length;
            // Trailing "Claude is working…" indicator while the agent is
            // mid-turn — superseded by "Compacting conversation…" (#65) when
            // both apply.
            if (working || compacting) {
              if (i == 0) {
                return compacting
                    ? const _CompactingIndicator()
                    : const _WorkingIndicator();
              }
              i -= 1;
            }
            // Optimistic echoes of prompts queued while Claude works (#31).
            return _PendingEchoBubble(text: _pendingEchoes[i].text);
          },
        ),
        ),
        if (_showNewPill)
          Positioned(
            bottom: 12,
            left: 0,
            right: 0,
            child: Center(
              child: Material(
                color: Theme.of(context).colorScheme.primary,
                borderRadius: BorderRadius.circular(AppShape.large),
                child: InkWell(
                  onTap: _jumpToNew,
                  borderRadius: BorderRadius.circular(AppShape.large),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 8,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.arrow_downward,
                          size: 14,
                          color: Theme.of(context).colorScheme.onPrimary,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          'New',
                          style: Theme.of(context).textTheme.labelLarge
                              ?.copyWith(
                                color: Theme.of(context).colorScheme.onPrimary,
                              ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        // Jump-to-bottom button whenever scrolled up (even with no new content),
        // so you can always get back to the latest turn.
        if (!_pinnedToBottom && !_showNewPill)
          Positioned(
            right: 12,
            bottom: 12,
            child: FloatingActionButton.small(
              heroTag: 'chat-jump-bottom',
              backgroundColor:
                  Theme.of(context).colorScheme.surfaceContainerHigh,
              foregroundColor: Theme.of(context).colorScheme.primary,
              onPressed: () => _scrollToBottom(),
              child: const Icon(Icons.keyboard_double_arrow_down),
            ),
          ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A slim header strip at the top of chat mode showing the folder plus, when
/// available, the live status-line metrics: context % and the 5h / 7d
/// rate-limit usage. Mirrors the Claude Code status line so you can gauge
/// context/limit pressure from the phone.
/// A left-aligned "Claude is working…" bubble with three pulsing dots, shown
/// while the session status is `working`.
class _WorkingIndicator extends StatelessWidget {
  const _WorkingIndicator();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 4, 48, 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainer,
          borderRadius: BorderRadius.circular(AppShape.medium),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Claude is working',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 8),
            PulsingDots(color: theme.colorScheme.primary),
          ],
        ),
      ),
    );
  }
}

/// A left-aligned "Compacting conversation…" bubble (#65), shown in place of
/// [_WorkingIndicator] while `SessionRepository.compactingFor` reports the
/// session is compacting its context — an overlay on top of status, exactly
/// like an api-error, never a `SessionStatus` value. Reuses the same
/// pulsing-dots animation as [_WorkingIndicator] but with a distinct accent
/// (tertiary, plus a small icon) so a compaction pause doesn't read as an
/// ordinary slow turn.
class _CompactingIndicator extends StatelessWidget {
  const _CompactingIndicator();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 4, 48, 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainer,
          borderRadius: BorderRadius.circular(AppShape.medium),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.compress_outlined,
              size: 14,
              color: theme.colorScheme.tertiary,
            ),
            const SizedBox(width: 6),
            Text(
              'Compacting conversation…',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 8),
            PulsingDots(color: theme.colorScheme.tertiary),
          ],
        ),
      ),
    );
  }
}

/// Markdown style for a chat bubble's prose. Fenced code blocks are split out
/// to [_CodeBlock] before markdown runs, so this mainly styles headings, bold,
/// italics, lists, links, inline code and blockquotes to match the bubble text.
MarkdownStyleSheet _markdownStyle(
  ThemeData theme,
  TextStyle? body,
  TextStyle? codeSpan,
) {
  final base = body ?? const TextStyle();
  final fs = base.fontSize ?? 14;
  return MarkdownStyleSheet.fromTheme(theme).copyWith(
    p: base,
    pPadding: EdgeInsets.zero,
    a: TextStyle(
      color: theme.colorScheme.primary,
      decoration: TextDecoration.underline,
    ),
    code: (codeSpan ?? base).copyWith(fontSize: fs - 1),
    h1: base.copyWith(fontSize: fs + 8, fontWeight: FontWeight.bold),
    h2: base.copyWith(fontSize: fs + 5, fontWeight: FontWeight.bold),
    h3: base.copyWith(fontSize: fs + 3, fontWeight: FontWeight.bold),
    h4: base.copyWith(fontSize: fs + 1, fontWeight: FontWeight.bold),
    h5: base.copyWith(fontWeight: FontWeight.bold),
    h6: base.copyWith(fontWeight: FontWeight.bold),
    strong: base.copyWith(fontWeight: FontWeight.bold),
    em: base.copyWith(fontStyle: FontStyle.italic),
    listBullet: base,
    blockquote: base.copyWith(color: theme.colorScheme.onSurfaceVariant),
    blockquoteDecoration: BoxDecoration(
      color: theme.colorScheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(4),
    ),
    codeblockDecoration: BoxDecoration(
      color: theme.colorScheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(6),
    ),
  );
}

/// An optimistic echo of a prompt the user submitted but that hasn't shown up
/// in the transcript yet (#31). [at] is epoch-ms, used only to age out an echo
/// that never matched a real turn.
class _PendingEcho {
  _PendingEcho(this.text, this.at);
  final String text;
  final int at;
}

/// Renders a queued/pending user prompt (#31): the same "pop" user-bubble
/// treatment as a real user turn (#54 — right-aligned, tinted with the app's
/// own accent), but with its text muted and a "Queued" clock tag, so the
/// state reads as provisional. Removed once the real transcript turn lands.
class _PendingEchoBubble extends StatelessWidget {
  const _PendingEchoBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.78,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(
            vertical: 4,
            horizontal: AppSpacing.screenPadding,
          ),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.primary.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(AppShape.large),
            border: Border.all(
              color: theme.colorScheme.primary.withValues(alpha: 0.25),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              _RoleTag(
                label: 'You',
                color: theme.colorScheme.primary.withValues(alpha: 0.6),
              ),
              const SizedBox(height: 6),
              Text(
                text,
                style: theme.textTheme.bodyLarge?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.schedule,
                      size: 12, color: theme.colorScheme.onSurfaceVariant),
                  const SizedBox(width: 4),
                  Text(
                    'Queued',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A parsed slash-command / skill invocation from a transcript turn (#32).
class CommandInvocation {
  const CommandInvocation({
    required this.name,
    required this.args,
    required this.body,
  });

  /// The command name without its leading slash (e.g. `task`).
  final String name;

  /// The user's arguments to the command (may be empty).
  final String args;

  /// The injected/expanded remainder (the full SKILL.md text) — hidden by
  /// default, shown only if the user expands it. Empty when there's nothing
  /// beyond the wrapper.
  final String body;
}

final RegExp _cmdNameRe =
    RegExp(r'<command-name>\s*/?\s*([^<]*?)\s*</command-name>');
final RegExp _cmdArgsRe = RegExp(r'<command-args>([\s\S]*?)</command-args>');
final RegExp _cmdWrapperRe =
    RegExp(r'<command-(name|message|args)>[\s\S]*?</command-\1>');

/// Detects a slash-command/skill invocation in a transcript turn (#32). Claude
/// Code injects the expanded skill as a user turn wrapped in
/// `<command-name>`/`<command-message>`/`<command-args>` plus the full SKILL.md
/// body; rendered verbatim it floods the chat. Returns the command name, args,
/// and the (collapsible) body, or null when the turn isn't a command. Pure, so
/// the parsing is unit-testable.
CommandInvocation? parseCommandInvocation(String text) {
  final nameM = _cmdNameRe.firstMatch(text);
  if (nameM == null) return null;
  final name = nameM.group(1)!.trim();
  if (name.isEmpty) return null;
  final args = (_cmdArgsRe.firstMatch(text)?.group(1) ?? '').trim();
  final body = text.replaceAll(_cmdWrapperRe, '').trim();
  return CommandInvocation(name: name, args: args, body: body);
}

/// How a `role:user` transcript turn was actually authored. Claude Code stores
/// several kinds of NON-human content as `role:user` turns, and the transcript
/// exposes no flag to tell them apart from a real prompt — only the content
/// signature does. Left as-is they render as the human ("You"), which is exactly
/// the bug: a teammate agent's report shows up in your own chat bubble.
enum UserTurnKind {
  /// A prompt the human actually typed. Renders as "You" (unchanged).
  human,

  /// A message from ANOTHER Claude session (multi-agent / workflow run), injected
  /// as `Another Claude session sent a message:\n<teammate-message …>`.
  teammate,

  /// Harness-injected, not typed by the human: a `<task-notification>`, Stop-hook
  /// feedback, or a post-compaction summary.
  system,
}

/// The classification of one `role:user` turn: its [kind], the [from] label
/// (the teammate's id, or a short system source), and the display [body] with
/// any injection wrapper stripped.
class UserTurnClass {
  const UserTurnClass(
      {required this.kind, required this.from, required this.body});

  /// human | teammate | system.
  final UserTurnKind kind;

  /// For [UserTurnKind.teammate], the sending agent's id (e.g. `J4b2`); for
  /// [UserTurnKind.system], a short source label (`Hook`, `Task update`,
  /// `Session continued`); '' for a human turn.
  final String from;

  /// The readable inner text with the injection wrapper removed. Equal to the
  /// input for a human turn (nothing to strip).
  final String body;
}

final RegExp _teammateIdRe = RegExp('teammate_id="([^"]*)"');
final RegExp _teammateTagRe = RegExp(r'</?teammate-message[^>]*>');
final RegExp _taskTagRe = RegExp(r'</?task-[a-z-]+>');
final RegExp _taskAgentRe = RegExp(r'Agent "([^"]+)"');

/// Inner text of the first `<tag>…</tag>` in [s], trimmed, or '' if absent.
/// Non-greedy so a C++ `<uint32_t>` inside the body can't swallow the close tag.
String _innerTag(String s, String tag) {
  final m = RegExp('<$tag>([\\s\\S]*?)</$tag>').firstMatch(s);
  return m == null ? '' : m.group(1)!.trim();
}

/// Classifies a `role:user` turn as a real human prompt vs an injected non-human
/// turn (another session's message, a task-notification, hook feedback, or a
/// compaction summary), and strips the injection wrapper for display. PURE, so
/// the signature detection is exhaustively unit-testable. A turn that matches no
/// signature is [UserTurnKind.human] with `body == text` — the unchanged "You".
UserTurnClass classifyUserTurn(String text) {
  final t = text.trimLeft();
  // Another Claude session's message (multi-agent / workflow). Both the prose
  // preamble and the raw `<teammate-message>` block are matched — the preamble
  // is dropped and the inner content kept.
  if (t.startsWith('Another Claude session sent a message') ||
      t.startsWith('<teammate-message')) {
    final id = _teammateIdRe.firstMatch(t)?.group(1)?.trim() ?? '';
    final body = t
        .replaceFirst('Another Claude session sent a message:', '')
        .replaceAll(_teammateTagRe, '')
        .trim();
    return UserTurnClass(kind: UserTurnKind.teammate, from: id, body: body);
  }
  // Harness task/agent notification injected as a user turn. Show ONLY the
  // agent's actual output (`<result>`), not the XML envelope (task-id,
  // tool-use-id, output-file, status, note, usage/token counts). Label it with
  // the agent's name from `<summary>` ("Agent \"X\" finished") when present.
  if (t.startsWith('<task-notification')) {
    final result = _innerTag(t, 'result');
    final summary = _innerTag(t, 'summary');
    final agent = _taskAgentRe.firstMatch(summary)?.group(1)?.trim() ?? '';
    // Fall back to the whole thing (tags stripped) only if there's no <result>.
    final body = result.isNotEmpty
        ? result
        : (summary.isNotEmpty
            ? summary
            : t.replaceAll(_taskTagRe, ' ').replaceAll(RegExp(r'\s+'), ' ').trim());
    return UserTurnClass(
        kind: UserTurnKind.system,
        from: agent.isNotEmpty ? agent : 'Task update',
        body: body);
  }
  // Stop-hook feedback fires on the user's behalf — not typed by them.
  if (t.startsWith('Stop hook feedback')) {
    final body = t.replaceFirst('Stop hook feedback:', '').trim();
    return UserTurnClass(kind: UserTurnKind.system, from: 'Hook', body: body);
  }
  // Post-compaction summary, re-injected as a user turn on continue.
  if (t.startsWith('This session is being continued')) {
    return UserTurnClass(
        kind: UserTurnKind.system, from: 'Session continued', body: t);
  }
  return UserTurnClass(kind: UserTurnKind.human, from: '', body: text);
}

/// Opens a tapped chat link in the system browser — http/https only
/// ([isLaunchableHttpUrl]); other schemes are ignored. Best-effort, never
/// throws into the widget tree. Public + [visibleForTesting] so the launch
/// path (and the "javascript: never launches" guard) can be asserted directly.
@visibleForTesting
Future<void> openChatLink(String? href) async {
  if (!isLaunchableHttpUrl(href)) return;
  try {
    await launchUrl(Uri.parse(href!), mode: LaunchMode.externalApplication);
  } catch (_) {
    // No handler / launch refused — never crash the chat.
  }
}

// NOTE (#83): there is deliberately no custom `a` element builder here.
//
// A MarkdownElementBuilder can only return a Widget, and a widget cannot live
// inside a paragraph. Measured on flutter_markdown 0.7.7+1, rendering
// `see [example](url) tail` through a builder produces FOUR RichTexts — the
// sentence shattered into "see " | "example" | " tail" as separate render
// objects — where the native path produces one:
//
//   builder   -> ["see "]["example"][" tail"]   (3 paragraphs + the role tag)
//   onTapLink -> ["see "]["example" <-Tap][" tail"]  all in ONE paragraph
//
// The ancestor SelectionArea (#27) walks a paragraph, so a shattered sentence
// is one it cannot drag across — that is the reported "nothing highlights".
// The builder also attached the tap recognizer to the WRONG fragment (" tail"),
// so tapping trailing prose opened the link.
//
// The mechanism, for anyone tempted to register a builder anyway: in
// flutter_markdown 0.7.7+1, `visitElementAfter` output goes into the BLOCK's
// children list (builder.dart:564-576) and `_mergeInlineChildren` skips any
// non-Text child (:891-897) — so the widget is laid out as a block-level child at
// its INTRINSIC width, which is what the deleted ConstrainedBox was compensating
// for. Worse, the `else if (tag == 'a') { _linkHandlers.removeLast(); }` at :611
// sits behind `if (builders.containsKey(tag))` at :564, so registering ANY 'a'
// builder makes that pop unreachable and the link handler stays on the stack for
// the NEXT span — which is exactly why the recognizer ended up on the trailing
// prose. Note that hazard is not specific to 'a'; it is how the else-if chain is
// built.
//
// Links are rendered by the library's own onTapLink path instead (see the
// MarkdownBody call below). If you are tempted to reintroduce a builder to add a
// per-link affordance, it will silently reintroduce this: any affordance must be
// reachable from a TextSpan recognizer or from the SelectionArea's context menu,
// never from a widget in the text flow.

class _TurnBubble extends StatelessWidget {
  const _TurnBubble({required this.turn, this.subFetch, this.agentId});

  final TranscriptTurn turn;

  /// Lets a `Task` tool card drill into its subagent's turns (null in contexts
  /// with no session binding, e.g. some tests — those fall back to flat cards).
  final SubagentFetcher? subFetch;

  /// The carrying session's `Session.agent` id, looked up in [AgentCatalog]
  /// (`GET /api/agents` — the server's `lib/agents.js` registry is the single
  /// source of truth for an agent's label + tint; #54 never hardcodes a
  /// Claude/Codex palette here). Null for a plain shell or a test with no
  /// session binding — the role tag then falls back to a neutral label/colour.
  final String? agentId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isAssistant = turn.isAssistant;
    // Classify a user turn: a real prompt ("You") vs an injected non-human turn
    // (another session's message, a task-notification, hook feedback, compaction
    // summary). null for an assistant turn.
    final uclass = isAssistant ? null : classifyUserTurn(turn.text);
    final fromHuman = uclass != null && uclass.kind == UserTurnKind.human;
    // "Incoming" (left, quiet) treatment for everything that isn't the human's
    // own turn — assistant AND injected non-human user turns.
    final incoming = !fromHuman;
    // #32: a slash-command/skill turn renders as a compact chip, not the whole
    // injected SKILL.md body. Only a human's own turn can be a slash command.
    final command = fromHuman ? parseCommandInvocation(turn.text) : null;
    // Injected turns display their stripped inner body; human/assistant use the
    // turn text verbatim.
    final displayText =
        (uclass != null && !fromHuman) ? uclass.body : turn.text;
    final segments = _splitCodeBlocks(displayText);
    // #54: user text is full-strength on BOTH sides now — the old "muted on
    // the right" treatment read as *lower* priority, exactly backwards: the
    // user's own turns are the rarer, higher-signal landmark, so they must
    // pop, not fade. The distinction is carried by alignment + the bubble
    // treatment below instead.
    final bodyStyle = theme.textTheme.bodyLarge;
    final codeSpanStyle = bodyStyle?.copyWith(
      fontFamily: 'monospace',
      // #83 — this alpha is load-bearing, not decoration. Flutter paints the
      // selection highlight into the paragraph FIRST and the text (including a
      // span's `backgroundColor`) on top, so an OPAQUE span background hides the
      // highlight underneath it completely. With the opaque colour this used to
      // be, dragging across a path in inline `code` selected it correctly — the
      // clipboard and SelectionArea both agreed — while showing no highlight at
      // all on the one span the user was aiming at, which reads as "selection is
      // broken" and was reported as exactly that.
      //
      // There is no value that keeps both a fully opaque tint and a visible
      // highlight: the span background is composited OVER the highlight, so
      // resting contrast and selection visibility trade directly against each
      // other. Selection wins, because an invisible selection is a bug and a
      // slightly softer code tint is not.
      backgroundColor:
          theme.colorScheme.surfaceContainerHigh.withValues(alpha: 0.5),
    );
    final mdStyle = _markdownStyle(theme, bodyStyle, codeSpanStyle);
    final epoch = _parseIsoToEpoch(turn.ts);

    // #54: an agent turn is tinted with ITS OWN registry colour so Claude vs
    // Codex still reads correctly; a user turn always uses the app's own
    // single accent, deliberately never the agent's tint, so the two can
    // never collide — though the real distinguishing cue is the alignment +
    // surface treatment below, never colour alone.
    final roleColor = isAssistant
        ? parseAgentColor(
            AgentCatalog.instance[agentId]?.color,
            theme.colorScheme.onSurfaceVariant,
          )
        : switch (uclass!.kind) {
            UserTurnKind.human => theme.colorScheme.primary,
            // A teammate agent gets its own distinct tint so it can never be
            // read as your own turn (or as the session's assistant).
            UserTurnKind.teammate => theme.colorScheme.tertiary,
            // Harness/system injections stay muted — present but low-signal.
            UserTurnKind.system => theme.colorScheme.onSurfaceVariant,
          };
    final roleLabel = isAssistant
        ? (AgentCatalog.instance[agentId]?.label ?? 'Assistant')
        : switch (uclass!.kind) {
            UserTurnKind.human => 'You',
            UserTurnKind.teammate =>
              uclass.from.isEmpty ? '◆ Teammate' : '◆ ${uclass.from}',
            UserTurnKind.system =>
              uclass.from.isEmpty ? 'System' : uclass.from,
          };

    // An incoming turn (agent or injected) runs near full width — it carries
    // code blocks and tool cards that must not be squeezed into a narrow bubble.
    // The human's own turn stays bounded, so its bubble reads as a landmark
    // rather than another full-width block in the flow.
    final maxWidth = incoming
        ? double.infinity
        : MediaQuery.sizeOf(context).width * 0.78;

    return Align(
      alignment: incoming ? Alignment.centerLeft : Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: Container(
          margin: const EdgeInsets.symmetric(
            vertical: 4,
            horizontal: AppSpacing.screenPadding,
          ),
          padding: const EdgeInsets.all(12),
          decoration: incoming
              ? BoxDecoration(
                  // Quiet: near-transparent surface, no full "bubble" — an
                  // incoming turn is the calm, high-volume bulk of the
                  // transcript, so it reads as document flow, not a chat
                  // pill, however many stack up in a row. Its left border takes
                  // the role tint (agent / teammate / muted system).
                  color:
                      theme.colorScheme.surfaceContainer.withValues(alpha: 0.35),
                  borderRadius: BorderRadius.circular(AppShape.medium),
                  border: Border(
                    left: BorderSide(
                      color: roleColor.withValues(alpha: 0.7),
                      width: 3,
                    ),
                  ),
                )
              : BoxDecoration(
                  // Pop: a real bubble tinted with the app's own accent — the
                  // landmark a long transcript gets scanned back to.
                  color: theme.colorScheme.primary.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(AppShape.large),
                  border: Border.all(
                    color: theme.colorScheme.primary.withValues(alpha: 0.4),
                  ),
                ),
          child: Column(
            crossAxisAlignment: incoming
                ? CrossAxisAlignment.start
                : CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              _RoleTag(label: roleLabel, color: roleColor),
              const SizedBox(height: 6),
              if (command != null)
                _CommandInvocationChip(command: command)
              else
                for (final seg in segments)
                  if (seg.kind == _SegmentKind.code)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: _CodeBlock(code: seg.content),
                    )
                  else if (seg.content.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: MarkdownBody(
                        data: seg.content,
                        // Selection is owned by the ancestor SelectionArea (#27);
                        // a self-selectable body would break cross-bubble drags.
                        selectable: false,
                        fitContent: true,
                        // gitHubWeb turns bare `https://…` into links.
                        //
                        // #83: links MUST stay real TextSpans in the paragraph.
                        // A custom `a` builder returned a widget, which splits
                        // the sentence into separate RichTexts (see the note by
                        // openChatLink) — so a drag across a sentence CONTAINING
                        // a link had no single paragraph to walk and produced no
                        // highlight at all. The widget's own GestureDetector
                        // compounded it: onLongPressStart holds the gesture arena
                        // for exactly the button-down a selection drag begins on.
                        //
                        // onTapLink is the native path: flutter_markdown emits a
                        // TextSpan carrying a TapGestureRecognizer, styled by
                        // styleSheet.a. A tap recognizer is defeated by movement,
                        // so a drag selects and a click still opens.
                        extensionSet: md.ExtensionSet.gitHubWeb,
                        onTapLink: (text, href, title) => openChatLink(href),
                        styleSheet: mdStyle,
                      ),
                    ),
              for (final tool in turn.toolUses)
                if (tool.subagent != null && subFetch != null)
                  _SubagentCard(tool: tool, subFetch: subFetch!)
                else
                  _ToolCard(tool: tool),
              if (epoch != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    relativeTime(epoch),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// #88 — a folded run of mechanical turns. Collapsed by default to one quiet
/// row ("6 steps · Read · Edit · Bash"); tapping expands it into the real turn
/// bubbles, so nothing is hidden, only folded.
///
/// The marker is deliberately unlike a turn bubble — no surface, no role tag,
/// muted text — because the whole point is that the eye skips it while scanning
/// for what was actually said. It names the tools rather than only counting, so
/// the fold can be judged without opening it.
class _MechanicalFold extends StatefulWidget {
  const _MechanicalFold({
    super.key,
    required this.chunk,
    required this.subFetch,
    required this.agentId,
  });

  final TranscriptChunk chunk;
  final SubagentFetcher? subFetch;
  final String? agentId;

  @override
  State<_MechanicalFold> createState() => _MechanicalFoldState();
}

class _MechanicalFoldState extends State<_MechanicalFold> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final turns = widget.chunk.turns;
    final steps = turns.fold<int>(0, (n, t) => n + t.toolUses.length);
    final names = widget.chunk.toolNames;
    final shown = names.take(3).join(' · ');
    final extra = names.length > 3 ? ' +${names.length - 3}' : '';
    final muted = theme.colorScheme.onSurfaceVariant;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.screenPadding,
            vertical: 2,
          ),
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(AppShape.small),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppShape.small),
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _expanded ? Icons.expand_more : Icons.chevron_right,
                      size: 16,
                      color: muted,
                    ),
                    const SizedBox(width: 4),
                    Icon(Icons.build_outlined, size: 14, color: muted),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        steps == 1 ? '1 step' : '$steps steps',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: muted,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    if (shown.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Flexible(
                        flex: 3,
                        child: Text(
                          '$shown$extra',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: muted.withValues(alpha: 0.8),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        if (_expanded)
          for (final t in turns)
            _TurnBubble(
              turn: t,
              subFetch: widget.subFetch,
              agentId: widget.agentId,
            ),
      ],
    );
  }
}

/// A small colour-dot + label fronting a turn (#54) — one of the combined
/// cues (alongside alignment and the surface treatment) that distinguishes a
/// user turn from an agent turn without relying on colour alone. [color] is
/// either the app's own accent (user) or the agent's OWN registry tint
/// (assistant, via [AgentCatalog] / `GET /api/agents`) — this widget itself
/// carries no agent knowledge, it only paints what it's given.
class _RoleTag extends StatelessWidget {
  const _RoleTag({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: theme.textTheme.labelSmall?.copyWith(
            color: color,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.2,
          ),
        ),
      ],
    );
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.code});

  final String code;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: code));
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppShape.small),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 28),
            // Plain Text — the ancestor SelectionArea (#27) makes it selectable
            // as part of a conversation-wide drag; the copy button still grabs
            // the whole block regardless of selection.
            child: Text(
              code,
              style: theme.textTheme.bodyMedium?.copyWith(
                fontFamily: 'monospace',
              ),
            ),
          ),
          Positioned(
            top: -4,
            right: -4,
            child: IconButton(
              onPressed: () => _copy(context),
              icon: const Icon(Icons.copy_all_outlined, size: 16),
              tooltip: 'Copy code',
              visualDensity: VisualDensity.compact,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

/// #32: a slash-command/skill invocation rendered compactly as `/name args`.
/// The injected skill body (if any) is collapsed behind a tap-to-expand.
class _CommandInvocationChip extends StatefulWidget {
  const _CommandInvocationChip({required this.command});

  final CommandInvocation command;

  @override
  State<_CommandInvocationChip> createState() => _CommandInvocationChipState();
}

class _CommandInvocationChipState extends State<_CommandInvocationChip> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = widget.command;
    final hasBody = c.body.isNotEmpty;
    final label = c.args.isEmpty ? '/${c.name}' : '/${c.name} ${c.args}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: theme.colorScheme.primaryContainer.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(AppShape.small),
          child: InkWell(
            borderRadius: BorderRadius.circular(AppShape.small),
            onTap: hasBody ? () => setState(() => _expanded = !_expanded) : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.terminal_rounded,
                      size: 15, color: theme.colorScheme.primary),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      label,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontFamily: 'monospace',
                        color: theme.colorScheme.onSurface,
                      ),
                    ),
                  ),
                  if (hasBody) ...[
                    const SizedBox(width: 4),
                    Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                        size: 16, color: theme.colorScheme.onSurfaceVariant),
                  ],
                ],
              ),
            ),
          ),
        ),
        if (_expanded && hasBody)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(AppShape.small),
                border: Border.all(color: theme.colorScheme.outlineVariant),
              ),
              child: Text(
                c.body,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// A one-line title + an expandable detail body for a tool-use card.
class ToolCardSummary {
  const ToolCardSummary({required this.title, required this.detail});

  /// Compact one-liner shown collapsed (e.g. `Bash — npm test`).
  final String title;

  /// Expandable body (command + output, prompt + report, a diff, …); '' when
  /// there's nothing more to show.
  final String detail;
}

String _firstLine(String s) {
  final i = s.indexOf('\n');
  return (i == -1 ? s : s.substring(0, i)).trim();
}

String _basename(String p) {
  final parts = p.split(RegExp(r'[\\/]')).where((x) => x.isNotEmpty).toList();
  return parts.isEmpty ? p : parts.last;
}

/// Builds a compact title + expandable detail for a tool card from its
/// structured input + captured result. Reflects what the terminal shows —
/// shells (Bash), subagents (Task), file ops (Read/Edit/Write), search, fetch.
/// Pure, so the mapping is unit-testable.
ToolCardSummary summarizeTool(ToolUse t) {
  final input = t.input;
  String s(String k) => (input[k] ?? '').toString();
  final name = t.name.isEmpty ? 'Tool' : t.name;
  final result = (t.result ?? '').trim();
  String join2(String a, String b) =>
      [if (a.isNotEmpty) a, if (b.isNotEmpty) b].join('\n\n');

  switch (t.name) {
    case 'Bash':
      final cmd = s('command');
      return ToolCardSummary(
        title: cmd.isEmpty ? 'Bash' : 'Bash — ${_firstLine(cmd)}',
        detail: join2(cmd.contains('\n') ? cmd : '', result),
      );
    case 'Task':
      final desc = s('description');
      final sub = s('subagent_type');
      return ToolCardSummary(
        title: 'Task'
            '${desc.isEmpty ? '' : ' — $desc'}'
            '${sub.isEmpty ? '' : ' ($sub)'}',
        detail: join2(s('prompt'), result),
      );
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      final fp = s('file_path');
      final title = fp.isEmpty ? name : '${t.name} — ${_basename(fp)}';
      String detail = result;
      if (t.name == 'Edit' &&
          (s('old_string').isNotEmpty || s('new_string').isNotEmpty)) {
        detail = join2('- ${s('old_string')}\n+ ${s('new_string')}', result);
      } else if (t.name == 'Write' && s('content').isNotEmpty) {
        detail = join2(s('content'), result);
      }
      return ToolCardSummary(title: title, detail: detail);
    case 'Grep':
    case 'Glob':
      final p = s('pattern');
      return ToolCardSummary(
          title: p.isEmpty ? name : '${t.name} — $p', detail: result);
    case 'WebFetch':
      final url = s('url');
      final u = Uri.tryParse(url);
      final host = (u != null && u.host.isNotEmpty) ? u.host : url;
      return ToolCardSummary(
          title: url.isEmpty ? name : 'Fetch — $host', detail: result);
    // Codex tool names (server-side provider registry): shell_command mirrors
    // Claude's Bash exactly, apply_patch shows the raw patch text, web_search
    // mirrors WebFetch's "action — subject" shape.
    case 'shell_command':
      final cmd = s('command');
      return ToolCardSummary(
        title: cmd.isEmpty ? 'Shell' : 'Shell — ${_firstLine(cmd)}',
        detail: join2(cmd.contains('\n') ? cmd : '', result),
      );
    case 'apply_patch':
      return ToolCardSummary(title: 'Patch', detail: join2(s('input'), result));
    case 'web_search':
      final query = s('query');
      return ToolCardSummary(
          title: query.isEmpty ? name : 'Search — $query', detail: result);
    default:
      final preview = t.inputPreview.trim();
      return ToolCardSummary(
          title: preview.isEmpty ? name : '$name — $preview', detail: result);
  }
}

/// A tool invocation rendered as a compact, expandable card that reflects the
/// terminal — the shell command + its output, a subagent's task + report, a
/// file edit's diff, etc. Collapsed by default to keep the chat scannable.
class _ToolCard extends StatefulWidget {
  const _ToolCard({required this.tool});

  final ToolUse tool;

  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  bool _expanded = false;

  static IconData _iconFor(String name) {
    switch (name) {
      case 'Bash':
      case 'shell_command':
        return Icons.terminal_rounded;
      case 'Task':
        return Icons.account_tree_outlined;
      case 'Read':
        return Icons.description_outlined;
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
      case 'apply_patch':
        return Icons.edit_outlined;
      case 'Grep':
      case 'Glob':
        return Icons.search;
      case 'WebFetch':
      case 'web_search':
        return Icons.public;
      default:
        return Icons.build_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = summarizeTool(widget.tool);
    final hasDetail = s.detail.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Material(
            color: theme.colorScheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppShape.small),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppShape.small),
              onTap:
                  hasDetail ? () => setState(() => _expanded = !_expanded) : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                child: Row(
                  children: [
                    Icon(_iconFor(widget.tool.name),
                        size: 14, color: theme.colorScheme.primary),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        s.title,
                        maxLines: _expanded ? null : 1,
                        overflow:
                            _expanded ? TextOverflow.clip : TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontFamily: 'monospace',
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    if (hasDetail)
                      Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                          size: 15, color: theme.colorScheme.onSurfaceVariant),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded && hasDetail)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.all(8),
              constraints: const BoxConstraints(maxHeight: 260),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainer,
                borderRadius: BorderRadius.circular(AppShape.small),
                border: Border.all(color: theme.colorScheme.outlineVariant),
              ),
              child: SingleChildScrollView(
                child: Text(
                  s.detail,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The pinned strip of a session's subagents at the top of chat mode (#62): one
/// chip per Task subagent so they stay reachable however far the transcript has
/// scrolled, mirroring the terminal lens's always-at-hand subagent panel. A live
/// dot reads running vs finished; tapping opens the drill-in sheet. The strip is
/// hidden entirely when the session has no subagents (its caller gates on that).
/// #73 — the agent's multi-step task list.
///
/// COLLAPSED BY DEFAULT, and that is the deliberate choice the issue asks for. A plan can
/// be twenty steps; rendered in full above every message it would push the conversation —
/// the thing the user came for — off the screen. So the header alone carries the two facts
/// that matter continuously ("how far along" and "what is it doing right now"), and the
/// full list is one tap away. It auto-expands for nothing: a panel that opened itself
/// whenever the plan changed would move the transcript under the user's eyes mid-read.
///
/// Deliberately NOT a fold of transcript turns like #88: the task list is not a message.
/// It has no position in the conversation — repeated updates describe one evolving object,
/// which is exactly why the issue insists on a single live panel instead of one chip per
/// call.
class _TaskListPanel extends StatefulWidget {
  const _TaskListPanel({required this.tasks});

  final List<AgentTask> tasks;

  @override
  State<_TaskListPanel> createState() => _TaskListPanelState();
}

class _TaskListPanelState extends State<_TaskListPanel> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tasks = widget.tasks;
    final done = tasks.where((t) => t.isCompleted).length;
    // The first in-progress task is what the agent is doing NOW. Falling back to the
    // first unfinished one keeps the header meaningful between steps, when the agent has
    // completed something but not yet marked the next one started.
    final current = tasks.firstWhere(
      (t) => t.isInProgress,
      orElse: () => tasks.firstWhere(
        (t) => !t.isCompleted,
        orElse: () => tasks.last,
      ),
    );
    final allDone = done == tasks.length;

    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          bottom: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Icon(
                    allDone ? Icons.checklist_rtl : Icons.checklist,
                    size: 18,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '$done/${tasks.length}',
                    style: theme.textTheme.labelMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      allDone ? 'All tasks complete' : current.displaySubject,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            // Bounded so a long plan scrolls inside the panel rather than
            // squeezing the transcript out of the screen.
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 220),
              child: ListView.builder(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 8),
                itemCount: tasks.length,
                itemBuilder: (_, i) => _TaskRow(task: tasks[i]),
              ),
            ),
        ],
      ),
    );
  }
}

/// One task row. Status is carried by BOTH an icon and the text style — colour alone
/// would be the only signal for a user who cannot distinguish it.
class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.task});

  final AgentTask task;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (IconData icon, Color color) = switch (task.status) {
      'completed' => (Icons.check_circle, theme.colorScheme.primary),
      'in_progress' => (Icons.play_circle_fill, theme.colorScheme.tertiary),
      _ => (Icons.radio_button_unchecked, theme.colorScheme.outline),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, size: 15, color: color),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              task.displaySubject,
              style: theme.textTheme.bodySmall?.copyWith(
                color: task.isCompleted
                    ? theme.colorScheme.onSurfaceVariant
                    : theme.colorScheme.onSurface,
                decoration:
                    task.isCompleted ? TextDecoration.lineThrough : null,
                fontWeight: task.isInProgress ? FontWeight.w600 : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SubagentStrip extends StatelessWidget {
  const _SubagentStrip({required this.tools, required this.onOpen});

  /// Task tool_uses, each with `subagent != null` (see [collectSubagents]).
  final List<ToolUse> tools;
  final void Function(ToolUse) onOpen;

  @override
  Widget build(BuildContext context) {
    if (tools.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Container(
      height: 42,
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          bottom: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        itemCount: tools.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (_, i) =>
            _SubagentChip(tool: tools[i], onTap: () => onOpen(tools[i])),
      ),
    );
  }
}

/// One subagent chip: its agent type (or description) and a live running/done dot.
/// Running reuses [_RunningDot] behind a RepaintBoundary so the pulse repaints only
/// the 7px dot, never the strip; finished shows a static muted dot.
class _SubagentChip extends StatelessWidget {
  const _SubagentChip({required this.tool, required this.onTap});

  final ToolUse tool;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sub = tool.subagent!;
    final type = sub.agentType.trim();
    final desc = sub.description.trim();
    final label = type.isNotEmpty ? type : (desc.isNotEmpty ? desc : 'subagent');
    return Material(
      color: theme.colorScheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(AppShape.large),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppShape.large),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.account_tree_outlined,
                  size: 13, color: theme.colorScheme.primary),
              const SizedBox(width: 5),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 130),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontFamily: 'monospace',
                    color: theme.colorScheme.onSurface,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              if (sub.running)
                const RepaintBoundary(child: _RunningDot())
              else
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.outline,
                    shape: BoxShape.circle,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The subagent drill-in shown in a focused bottom sheet (#62): the live, read-only
/// transcript (reusing [_SubagentCard]'s SAME fetch/poll path) plus a "message
/// session" input. Typing here submits to the SESSION — the main agent's PTY — via
/// [onSubmit], exactly as the terminal lens lets you type while a subagent runs;
/// there is no channel to a specific subagent, so the field is labelled for the
/// session and the transcript above stays read-only. Sending closes the sheet so the
/// prompt's "Queued" echo and the reply are visible back in the chat. The input is
/// hidden when [onSubmit] is null (e.g. no live connection / tests that skip it).
class _SubagentSheet extends StatefulWidget {
  const _SubagentSheet({
    required this.tool,
    required this.subFetch,
    this.onSubmit,
  });

  final ToolUse tool;
  final SubagentFetcher subFetch;
  final void Function(String)? onSubmit;

  @override
  State<_SubagentSheet> createState() => _SubagentSheetState();
}

class _SubagentSheetState extends State<_SubagentSheet> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final text = _controller.text;
    if (text.trim().isEmpty) return;
    widget.onSubmit?.call(text);
    Navigator.of(context).maybePop(); // back to the chat, where the echo + reply land
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final maxH = MediaQuery.of(context).size.height * 0.5;
    final canSend = widget.onSubmit != null;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 12,
          right: 12,
          bottom: MediaQuery.of(context).viewInsets.bottom + 12,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _SubagentCard(
              tool: widget.tool,
              subFetch: widget.subFetch,
              initiallyExpanded: true,
              expandedMaxHeight: maxH,
            ),
            const SizedBox(height: 8),
            Text(
              canSend
                  ? 'Read-only — subagents run on their own. A message here goes to '
                      'the session (the main agent), the same as typing in the terminal.'
                  : 'Read-only — subagents run on their own.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            if (canSend) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      decoration: InputDecoration(
                        hintText: 'Message session…',
                        isDense: true,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(AppShape.small),
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 10),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send, size: 18),
                    tooltip: 'Send to session',
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A `Task` tool_use rendered as a live, drill-in subagent panel — the chat-native
/// equivalent of the terminal's arrow-navigable subagent view. Collapsed it shows
/// the agent type + description and a pulsing dot while the subagent runs; tapping
/// to expand lazily fetches the subagent's OWN transcript and renders its nested
/// tool calls. A nested `Task` keeps its own panel, so drilling continues to any
/// depth via the same [subFetch]. While expanded AND running it re-polls every 4s
/// so you can watch the subagent work, exactly like the terminal panel.
class _SubagentCard extends StatefulWidget {
  const _SubagentCard({
    required this.tool,
    required this.subFetch,
    this.initiallyExpanded = false,
    this.expandedMaxHeight = 360,
  });

  final ToolUse tool;
  final SubagentFetcher subFetch;

  /// Start already drilled-in — used when hosted in the pinned-subagent sheet
  /// (#62) so it opens straight onto the transcript, no extra tap.
  final bool initiallyExpanded;

  /// Max height of the expanded drill body. The sheet passes a taller value so the
  /// transcript fills it; inline cards keep the compact default.
  final double expandedMaxHeight;

  @override
  State<_SubagentCard> createState() => _SubagentCardState();
}

class _SubagentCardState extends State<_SubagentCard> {
  bool _expanded = false;
  bool _loading = false;
  String? _error;
  SubagentPage? _page;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    if (widget.initiallyExpanded) {
      _expanded = true;
      // _load() calls setState — illegal during initState; defer a frame.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _page == null) _load();
      });
    }
  }

  SubagentTrace get _stub => widget.tool.subagent!;
  // Prefer the freshly-fetched running state; fall back to the transcript stub
  // until the first drill load lands.
  bool get _running => _page?.running ?? _stub.running;

  @override
  void didUpdateWidget(covariant _SubagentCard old) {
    super.didUpdateWidget(old);
    // The parent refetches the transcript (~4s while working); when this Task's
    // stub flips to done, stop watching.
    if (!_running) _stopPoll();
  }

  @override
  void dispose() {
    _stopPoll();
    super.dispose();
  }

  Future<void> _toggle() async {
    setState(() => _expanded = !_expanded);
    if (_expanded) {
      if (_page == null) await _load();
      _maybePoll();
    } else {
      _stopPoll();
    }
  }

  void _maybePoll() {
    if (_expanded && _running && _poll == null) {
      _poll = Timer.periodic(const Duration(seconds: 4), (_) => _load());
    }
  }

  void _stopPoll() {
    _poll?.cancel();
    _poll = null;
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.subFetch(widget.tool.id);
      if (!mounted) return;
      setState(() {
        _page = page;
        _loading = false;
      });
      if (_running) {
        _maybePoll();
      } else {
        _stopPoll();
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load subagent activity.';
        _loading = false;
      });
      _stopPoll();
    }
  }

  // "Task — description (type)" — built from the stub + the tool's own name, so
  // it's correct whatever the host calls the spawner (CLI `Task`, others `Agent`),
  // not tied to summarizeTool's Task-only case.
  String get _title {
    final label = widget.tool.name.isEmpty ? 'Subagent' : widget.tool.name;
    final desc = _stub.description.trim();
    final type = _stub.agentType.trim();
    return '$label'
        '${desc.isEmpty ? '' : ' — $desc'}'
        '${type.isEmpty ? '' : ' ($type)'}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Material(
            color: theme.colorScheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppShape.small),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppShape.small),
              onTap: _toggle,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                child: Row(
                  children: [
                    Icon(Icons.account_tree_outlined,
                        size: 14, color: theme.colorScheme.primary),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        _title,
                        maxLines: _expanded ? null : 1,
                        overflow:
                            _expanded ? TextOverflow.clip : TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontFamily: 'monospace',
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    if (_running) ...[
                      const SizedBox(width: 6),
                      const _RunningDot(),
                    ],
                    Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                        size: 15, color: theme.colorScheme.onSurfaceVariant),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.all(8),
              constraints: BoxConstraints(maxHeight: widget.expandedMaxHeight),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainer,
                borderRadius: BorderRadius.circular(AppShape.small),
                border: Border.all(color: theme.colorScheme.outlineVariant),
              ),
              child: _buildBody(theme),
            ),
        ],
      ),
    );
  }

  Widget _buildBody(ThemeData theme) {
    if (_error != null) {
      return Text(
        _error!,
        style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
      );
    }
    final page = _page;
    if (page == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(8),
          child: SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    if (page.messages.isEmpty) {
      return Text(
        _running ? 'Starting…' : 'No activity recorded.',
        style: theme.textTheme.bodySmall
            ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
      );
    }
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final m in page.messages) ..._nestedRows(theme, m),
        ],
      ),
    );
  }

  // One nested subagent turn as compact sub-transcript rows: its prose (if any)
  // followed by its tool cards. A nested Task keeps its own drill-in panel (same
  // [subFetch]); every other tool reuses the flat [_ToolCard].
  List<Widget> _nestedRows(ThemeData theme, TranscriptTurn m) {
    return [
      if (m.text.trim().isNotEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Text(
            m.text.trim(),
            style: theme.textTheme.bodySmall?.copyWith(
              color: m.isAssistant
                  ? theme.colorScheme.onSurface
                  : theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      for (final tool in m.toolUses)
        if (tool.subagent != null)
          _SubagentCard(tool: tool, subFetch: widget.subFetch)
        else
          _ToolCard(tool: tool),
    ];
  }
}

/// A small pulsing dot marking a subagent that is still running. Reuses [Pulse]
/// rather than a controller of its own — see [PulseClock] for why a hand-rolled
/// ticker here is expensive out of all proportion to a 7px dot.
class _RunningDot extends StatelessWidget {
  const _RunningDot();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Pulse(
      child: Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(
          color: theme.colorScheme.primary,
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

// --- text segmentation (no markdown package) --------------------------------

enum _SegmentKind { text, code }

class _Segment {
  const _Segment(this.kind, this.content);
  final _SegmentKind kind;
  final String content;
}

final RegExp _fencedCodeRe = RegExp(r'```([\s\S]*?)```');
final RegExp _langTagRe = RegExp(r'^[a-zA-Z0-9_+-]{1,20}$');

/// Splits turn text into alternating plain-text and fenced-code-block
/// segments. A leading language tag on a fenced block (` ```dart `) is
/// dropped from the rendered code.
List<_Segment> _splitCodeBlocks(String text) {
  final segments = <_Segment>[];
  var last = 0;
  for (final match in _fencedCodeRe.allMatches(text)) {
    if (match.start > last) {
      segments.add(
        _Segment(_SegmentKind.text, text.substring(last, match.start)),
      );
    }
    var code = match.group(1) ?? '';
    final firstNewline = code.indexOf('\n');
    if (firstNewline != -1 &&
        _langTagRe.hasMatch(code.substring(0, firstNewline).trim())) {
      code = code.substring(firstNewline + 1);
    }
    segments.add(_Segment(_SegmentKind.code, code));
    last = match.end;
  }
  if (last < text.length) {
    segments.add(_Segment(_SegmentKind.text, text.substring(last)));
  }
  if (segments.isEmpty) segments.add(_Segment(_SegmentKind.text, text));
  return segments;
}

int? _parseIsoToEpoch(String? ts) {
  if (ts == null || ts.isEmpty) return null;
  try {
    return DateTime.parse(ts).millisecondsSinceEpoch;
  } catch (_) {
    return null;
  }
}
