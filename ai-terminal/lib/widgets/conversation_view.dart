/// The Chat lens — the centerpiece the owner wants over the raw terminal:
/// Claude's conversation rendered as a chat transcript instead of a VT100
/// screen. Assistant turns on the left, user turns muted on the right,
/// fenced code blocks in their own tap-to-copy containers, tool calls as
/// collapsed chips, native text selection throughout (no markdown package —
/// selection is the whole point).
///
/// Data comes from `GET /api/sessions/:id/transcript`, backward-paginated
/// (newest-last per page; `before=<cursor>` walks further into history) via
/// `ApiClient.transcript()` / `TranscriptPage` / `TranscriptTurn` / `ToolUse`
/// (lib/api/api_client.dart, lib/api/models.dart).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../theme/app_theme.dart';
import '../util/terminal_links.dart';
import 'empty_state.dart';
import 'format_utils.dart';

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

class ConversationView extends StatefulWidget {
  const ConversationView({
    super.key,
    required this.session,
    this.onNoTranscript,
    this.fetchPage,
    this.submittedPrompts,
  });

  final Session session;

  /// Called once if the initial load 404s (no transcript for this session) —
  /// the caller (SessionScreen) falls back to the Terminal lens silently.
  final VoidCallback? onNoTranscript;

  /// Injectable for tests; defaults to `ApiClient(session.server).transcript`.
  final TranscriptFetcher? fetchPage;

  /// Prompts the user just submitted in the compose bar (#31). Each is echoed
  /// immediately as a "Queued" bubble so the user sees their input registered
  /// even while Claude is still working, then reconciled away when the matching
  /// real transcript turn arrives.
  final Stream<String>? submittedPrompts;

  @override
  State<ConversationView> createState() => _ConversationViewState();
}

class _ConversationViewState extends State<ConversationView> {
  late final TranscriptFetcher _fetch = widget.fetchPage ?? _defaultFetch;

  final ScrollController _scrollController = ScrollController();
  List<TranscriptTurn> _turns = const [];
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

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    _promptSub = widget.submittedPrompts?.listen(_addEcho);
    _loadInitial();
    _setPolling(widget.session.status == 'working');
  }

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
    if (oldWidget.session.id != widget.session.id ||
        oldWidget.session.claudeSessionId != widget.session.claudeSessionId) {
      _resetAndReload();
      return;
    }
    final wasWorking = oldWidget.session.status == 'working';
    final isWorking = widget.session.status == 'working';
    if (isWorking != wasWorking) _setPolling(isWorking);
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
    _setPolling(widget.session.status == 'working');
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
      setState(() {
        _turns = [...page.messages, ..._turns];
        _oldestCursor = page.cursor;
        _hasMoreOlder = page.hasMore;
        _loadingOlder = false;
      });
      if (hadClients) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !_scrollController.hasClients) return;
          final newExtent = _scrollController.position.maxScrollExtent;
          _scrollController.jumpTo(
            _scrollController.position.pixels + (newExtent - oldExtent),
          );
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

  /// Approximate context-window % from the newest assistant turn's token count,
  /// used only when the live status line hasn't posted a real ctx (e.g. an idle
  /// session). Assumes a 200k window; shown with a `~` to signal it's an
  /// estimate. Returns null if the server didn't provide token usage.
  int? _deriveCtxFromTranscript() {
    if (widget.session.metrics?.ctx != null) return null; // live value wins
    for (var i = _turns.length - 1; i >= 0; i--) {
      final t = _turns[i];
      if (t.isAssistant && t.ctxTokens != null) {
        return ((t.ctxTokens! / 200000) * 100).round().clamp(0, 100);
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
      return const EmptyState(
        icon: Icons.forum_outlined,
        title: 'No messages yet',
        subtitle: 'Claude\'s replies will appear here as a conversation',
      );
    }

    final working = widget.session.status == 'working';
    final leadingLoader = _loadingOlder ? 1 : 0;
    return Column(
      children: [
        _MetricsHeader(
          session: widget.session,
          derivedCtx: _deriveCtxFromTranscript(),
        ),
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
          child: ListView.builder(
          controller: _scrollController,
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: _turns.length +
              leadingLoader +
              (working ? 1 : 0) +
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
            if (i < _turns.length) return _TurnBubble(turn: _turns[i]);
            i -= _turns.length;
            // Trailing "Claude is working…" indicator while the agent is mid-turn.
            if (working) {
              if (i == 0) return const _WorkingIndicator();
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
class _MetricsHeader extends StatelessWidget {
  const _MetricsHeader({required this.session, this.derivedCtx});

  final Session session;

  /// Approximate ctx% derived from the transcript when the live status line
  /// isn't posting; shown with a `~`. Null when a live ctx exists or none known.
  final int? derivedCtx;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final m = session.metrics;
    final folder = _folderName(session.cwd);

    final chips = <Widget>[];
    if (folder.isNotEmpty) {
      chips.add(_chip(theme, Icons.folder_outlined, folder,
          theme.colorScheme.onSurfaceVariant));
    }
    // Context fills fast and matters most — warn early (50%), danger at 70%.
    // Prefer the live status-line value; fall back to the transcript estimate.
    if (m?.ctx != null) {
      // Shared SSOT thresholds (warn 50 / danger 70) via ctxColor — same helper
      // the session list uses, so the two surfaces can never drift apart.
      chips.add(_chip(theme, Icons.data_usage, 'ctx ${m!.ctx}%',
          ctxColor(theme, m.ctx!)));
    } else if (derivedCtx != null) {
      chips.add(_chip(theme, Icons.data_usage, 'ctx ~$derivedCtx%',
          ctxColor(theme, derivedCtx!)));
    }
    if (m?.fiveH != null) {
      chips.add(_chip(theme, Icons.schedule, '5h ${m!.fiveH}%',
          _loadColor(theme, m.fiveH!, 60, 85)));
    }
    if (m?.sevenD != null) {
      chips.add(_chip(theme, Icons.calendar_today, '7d ${m!.sevenD}%',
          _loadColor(theme, m.sevenD!, 60, 85)));
    }
    if (chips.isEmpty) return const SizedBox.shrink();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(color: theme.dividerColor.withValues(alpha: 0.4)),
        ),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: chips),
      ),
    );
  }

  static String _folderName(String cwd) {
    if (cwd.isEmpty) return '';
    final parts = cwd.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty).toList();
    return parts.isEmpty ? cwd : parts.last;
  }

  // Green below [warn], amber to [danger], red at/above — quick pressure read.
  static Color _loadColor(ThemeData theme, int pct, int warn, int danger) {
    if (pct >= danger) return theme.colorScheme.error;
    if (pct >= warn) return const Color(0xFFE0A030);
    return theme.colorScheme.primary;
  }

  static Widget _chip(ThemeData theme, IconData icon, String label, Color color) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: color),
          const SizedBox(width: 4),
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: color,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

/// A left-aligned "Claude is working…" bubble with three pulsing dots, shown
/// while the session status is `working`.
class _WorkingIndicator extends StatefulWidget {
  const _WorkingIndicator();
  @override
  State<_WorkingIndicator> createState() => _WorkingIndicatorState();
}

class _WorkingIndicatorState extends State<_WorkingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

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
            AnimatedBuilder(
              animation: _c,
              builder: (context, _) {
                return Row(
                  mainAxisSize: MainAxisSize.min,
                  children: List.generate(3, (i) {
                    // Stagger each dot's pulse across the 0..1 cycle.
                    final t = (_c.value + i / 3) % 1.0;
                    final op = 0.3 + 0.7 * (1 - (2 * t - 1).abs());
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 2),
                      child: Opacity(
                        opacity: op,
                        child: Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            color: theme.colorScheme.primary,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                    );
                  }),
                );
              },
            ),
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

/// Renders a queued/pending user prompt (#31): styled like a user bubble but
/// muted, with a "Queued" clock tag, so the user sees their input registered
/// while Claude is still working. Removed once the real transcript turn lands.
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
          maxWidth: MediaQuery.sizeOf(context).width * 0.82,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(
            vertical: 4,
            horizontal: AppSpacing.screenPadding,
          ),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHigh.withValues(alpha: 0.35),
            borderRadius: BorderRadius.circular(AppShape.medium),
            border: Border.all(
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
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

class _TurnBubble extends StatelessWidget {
  const _TurnBubble({required this.turn});

  final TranscriptTurn turn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isAssistant = turn.isAssistant;
    // #32: a slash-command/skill turn renders as a compact chip, not the whole
    // injected SKILL.md body.
    final command = isAssistant ? null : parseCommandInvocation(turn.text);
    final segments = _splitCodeBlocks(turn.text);
    final bodyStyle = isAssistant
        ? theme.textTheme.bodyLarge
        : theme.textTheme.bodyLarge?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          );
    final codeSpanStyle = bodyStyle?.copyWith(
      fontFamily: 'monospace',
      backgroundColor: theme.colorScheme.surfaceContainerHigh,
    );
    final epoch = _parseIsoToEpoch(turn.ts);

    return Align(
      alignment: isAssistant ? Alignment.centerLeft : Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.82,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(
            vertical: 4,
            horizontal: AppSpacing.screenPadding,
          ),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: isAssistant
                ? theme.colorScheme.surfaceContainer
                : theme.colorScheme.surfaceContainerHigh.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(AppShape.medium),
          ),
          child: Column(
            crossAxisAlignment: isAssistant
                ? CrossAxisAlignment.start
                : CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
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
                        // Chat-side of the clickable-URL work: gitHubWeb turns
                        // bare `https://…` into links (flutter_markdown doesn't
                        // autolink by default), and onTapLink opens them in the
                        // system browser — http/https only (isLaunchableHttpUrl).
                        extensionSet: md.ExtensionSet.gitHubWeb,
                        onTapLink: (text, href, title) => openChatLink(href),
                        styleSheet:
                            _markdownStyle(theme, bodyStyle, codeSpanStyle),
                      ),
                    ),
              for (final tool in turn.toolUses) _ToolCard(tool: tool),
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
        return Icons.terminal_rounded;
      case 'Task':
        return Icons.account_tree_outlined;
      case 'Read':
        return Icons.description_outlined;
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
        return Icons.edit_outlined;
      case 'Grep':
      case 'Glob':
        return Icons.search;
      case 'WebFetch':
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
