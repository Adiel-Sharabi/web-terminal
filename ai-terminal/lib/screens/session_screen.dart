/// Session screen — the native web-UI replacement (owner pivot): a real
/// terminal over WebSocket using `xterm`, plus the attention/reconnect
/// affordances from spec §2/§3 adapted to a single always-visible terminal
/// rather than a modal sheet.
///
/// INPUT MODEL (owner feedback: typing directly into the xterm view is
/// unusable — no IME/autocomplete/swipe): compose-first, mirroring
/// `composeMode` in `C:\dev\web-terminal-shadow\app.html`. A real `TextField`
/// (see [ComposeBar]) is the primary input; the terminal itself becomes a
/// read-only view (no on-screen keyboard on tap) unless the user flips to
/// "raw mode" for direct terminal typing (vim, TUIs, Claude's arrow menus).
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'package:pasteboard/pasteboard.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:xterm/xterm.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/desktop_alert_service.dart';
import '../services/detach_window_service.dart';
import '../services/notification_service.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import '../util/terminal_links.dart';
import '../widgets/compose_bar.dart';
import '../widgets/conversation_view.dart';
import '../widgets/format_utils.dart';
import '../widgets/question_overlay.dart';
import '../widgets/server_badge.dart';
import '../widgets/session_action_sheet.dart';
import '../widgets/status_dot.dart';
import '../widgets/terminal_key_strip.dart';

/// Max send-history entries kept per session (matches the web compose bar).
const int _kMaxHistory = 50;

/// Whether the app-bar overflow menu's "Fork session" item should be enabled
/// for [session] — only Claude sessions (a `claudeSessionId`) can be forked.
/// Pulled out as a pure function so the enable/disable rule is testable
/// without pumping the whole screen.
bool canForkFromMenu(Session session) => session.claudeSessionId != null;

/// The compose (text input) bar is ALWAYS shown. It sends straight to the PTY in
/// the Terminal lens and to Claude in the Chat lens, so it is the one input path
/// that works in every state — touch (where typing into the xterm view has no
/// IME/soft-keyboard) and desktop alike, with or without Chat, connected or not.
///
/// Earlier versions hid it in raw mode so the user could type directly into the
/// terminal, gated on lens/chat/platform. Every such rule left some real session
/// stranded with no usable input (compose gone AND the terminal line
/// read-only/unfocused) — reported repeatedly (#43). Raw mode now controls ONLY
/// whether the TERMINAL additionally accepts direct keystrokes
/// (readOnly/hardwareKeyboardOnly on the TerminalView), never whether an input
/// exists at all. Kept as a named predicate so the "always an input" invariant
/// has one enforceable home.
bool composeBarVisible() => true;

/// True on desktop platforms (a real hardware keyboard). One definition so the
/// raw-mode default, the '/' live-stream gate (#28), and image-paste routing
/// all read the same rule.
bool isDesktopPlatform() =>
    !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

/// Whether a compose buffer that just became '/'-prefixed should switch to the
/// live slash-stream (mirroring Claude's own slash menu, which renders + narrows
/// in the terminal as you type). Enabled on EVERY platform: it's the real menu
/// (SSOT — no hardcoded command list), same as the web app and mobile. It was
/// once suppressed on desktop because flipping to the Terminal lens hid the
/// compose bar and stranded the user (#28); the compose bar is now always shown,
/// so that reason is gone and desktop gets the same live autocomplete — the caller
/// records the prior lens and restores it once the command is sent. Pure so the
/// gate is testable.
bool slashStartsLiveStream(String text) => text.startsWith('/');

/// Where an Alt+V clipboard-image paste should land: the chat compose field
/// (when the Chat lens is active — the terminal is offstage there — or the
/// compose field holds focus), else straight to the terminal PTY (raw typing).
/// Makes Alt+V work while composing in chat (#29) with no regression to the
/// terminal path. Pure so the routing is testable.
bool pasteImageIntoCompose({
  required String activeLens,
  required bool composeFocused,
}) =>
    activeLens == 'chat' || composeFocused;

class SessionScreen extends StatefulWidget {
  const SessionScreen({
    super.key,
    required this.sessionId,
    this.initialSession,
    this.embedded = false,
    this.standalone = false,
  });

  final String sessionId;

  /// Pre-fetched session, when navigated to from a list that already had it
  /// (avoids a loading flash). `null` when arriving from a notification tap /
  /// deep link that only carries the id — the session is then resolved from
  /// [SessionRepository.sessions] once it emits.
  final Session? initialSession;

  /// True when shown inline as the detail pane of the wide-screen split view
  /// (not pushed as its own route). Suppresses the AppBar back button.
  final bool embedded;

  /// True when this is a detached, single-session window (issue #14) — the app
  /// root, launched via `--session`. Hides the back button and the "open in new
  /// window" action (it's already its own window).
  final bool standalone;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen>
    with WidgetsBindingObserver {
  Session? _session;
  ApiClient? _api;
  TerminalConnection? _connection;
  StreamSubscription<String>? _outputSub;
  StreamSubscription<bool>? _connectedSub;
  StreamSubscription<void>? _reconnectedSub;
  StreamSubscription<List<Session>>? _repoSub;
  Timer? _notFoundTimer;
  Timer? _draftDebounce;
  Timer? _disconnectDebounce;
  final List<Timer> _scrollTimers = <Timer>[];
  bool _showDisconnectBanner = false; // debounced ~3s after connected==false
  bool _showRetakeNotice = false; // connection.sessionTaken — taken elsewhere
  DateTime? _lastConnectedAt;
  bool _ctrlSticky = false;
  bool _altSticky = false;
  int _lastCols = 0, _lastRows = 0; // last size the view reported (for re-send)
  double _termFontSize = 10; // adjustable terminal font (persisted globally)
  bool _notFound = false;
  String? _apiErrorReason;

  // --- Interactive question overlay (#19) ----------------------------------
  PendingQuestion? _pendingQuestion;
  String? _dismissedQuestionId; // a question the user chose to answer in-terminal
  String? _questionContext; // Claude's preceding message, shown above the question
  Timer? _questionPoll;

  // --- Chat/Terminal lens ---------------------------------------------------
  String _activeLens = 'terminal'; // 'chat' | 'terminal'
  String? _persistedLens; // the user's explicit past choice, if any
  bool? _serverHasTranscript; // null = capability not yet checked
  bool _transcriptUnavailableForSession =
      false; // this session 404s despite the capability

  final ScrollController _scrollController = ScrollController();
  late final Terminal _terminal = Terminal(maxLines: 5000);
  late final TerminalController _terminalController = TerminalController();
  final GlobalKey<TerminalViewState> _terminalViewKey =
      GlobalKey<TerminalViewState>();

  // --- Compose-first input state ------------------------------------------
  final TextEditingController _composeController = TextEditingController();
  final FocusNode _composeFocusNode = FocusNode();
  // Broadcasts prompts the user submits so the Chat lens can echo them
  // immediately (#31). Broadcast because ConversationView subscribes only while
  // the Chat lens is mounted.
  final StreamController<String> _submittedPrompts =
      StreamController<String>.broadcast();
  bool _rawMode =
      false; // false = compose-first (default); true = direct terminal typing
  bool _composeLive = false; // true while a '/'-prefixed line is streaming live
  String _composeLiveSent =
      ''; // chars already streamed to the terminal for the live line
  String? _lensBeforeLive; // lens to restore to once a live '/' command is sent
  bool _historyActive =
      false; // true while walking send-history (further ↑/↓ keep walking)
  int _historyIndex = 0;
  final List<String> _sendHistory = [];
  String _lastComposeText = '';
  bool _settingComposeProgrammatically = false;

  @override
  void initState() {
    super.initState();
    _session = widget.initialSession;
    WidgetsBinding.instance.addObserver(this);
    _terminal.onOutput = _handleTerminalOutput;
    _terminal.onResize = (w, h, pw, ph) {
      _lastCols = w;
      _lastRows = h;
      _connection?.resize(w, h);
    };
    _terminalController.addListener(_onSelectionChanged);
    _composeController.addListener(_onComposeChanged);
    // Alt+V pastes a clipboard image in BOTH modes. A global handler is the
    // only way to catch it in raw mode, where the terminal (not the compose
    // bar) owns the keyboard.
    HardwareKeyboard.instance.addHandler(_globalKeyHandler);
    _repoSub = SessionRepository.instance.sessions.listen(_onSessionsUpdate);
    // Tell the desktop alert path we're showing this session so it won't toast
    // an event for the session already on screen (issue #16).
    if (DesktopAlertService.supported) {
      DesktopAlertService.instance.markVisible(widget.sessionId);
    }
    if (_session == null) {
      // Arrived from a notification/deep link with only an id — give the
      // repository a few seconds to resolve it before admitting defeat.
      _notFoundTimer = Timer(const Duration(seconds: 8), () {
        if (mounted && _session == null) setState(() => _notFound = true);
      });
    }
    _attach();
    _loadPersisted();
    _checkTranscriptCapability();
    // Poll for Claude's interactive question unconditionally (#19/#20): the
    // endpoint returns null/404 on a server that doesn't support it, so this
    // can't be defeated by opening the session before the server was upgraded.
    _startQuestionPolling();
  }

  Future<void> _loadPersisted() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    final draft = prefs.getString('wt_draft_${widget.sessionId}');
    // Desktop has a real keyboard, so default to raw/terminal mode — Esc,
    // arrows, Ctrl and command history are handled natively by the terminal
    // (Claude's TUI). Mobile defaults to compose-first. A per-session toggle
    // overrides either way.
    final isDesktop = isDesktopPlatform();
    final rawMode =
        prefs.getBool('wt_rawmode_${widget.sessionId}') ?? isDesktop;
    final historyJson = prefs.getString('wt_history_${widget.sessionId}');
    final lens = prefs.getString('wt_lens_${widget.sessionId}');
    final fontSize = prefs.getDouble('wt.termFontSize'); // global, not per-session
    if (fontSize != null && fontSize >= 6 && fontSize <= 24) {
      _termFontSize = fontSize;
    }
    if (lens == 'chat' || lens == 'terminal') _persistedLens = lens;
    if (historyJson != null) {
      try {
        final decoded = jsonDecode(historyJson);
        if (decoded is List) {
          _sendHistory
            ..clear()
            ..addAll(decoded.map((e) => e.toString()));
        }
      } catch (_) {
        // corrupt cache — ignore
      }
    }
    if (draft != null && draft.isNotEmpty) {
      _settingComposeProgrammatically = true;
      _composeController.value = TextEditingValue(
        text: draft,
        selection: TextSelection.collapsed(offset: draft.length),
      );
    }
    setState(() => _rawMode = rawMode);
    if (_rawMode) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _terminalViewKey.currentState?.requestKeyboard();
      });
    }
    _recomputeActiveLens();
  }

  /// Checks once whether this session's server advertises the `transcript`
  /// capability, driving whether the Chat lens (and its app-bar toggle) is
  /// offered at all.
  Future<void> _checkTranscriptCapability() async {
    final session = _session;
    if (session == null) return;
    try {
      final info = await ApiClient(session.server).version();
      if (!mounted) return;
      setState(() => _serverHasTranscript = info.has('transcript'));
    } catch (_) {
      if (mounted) setState(() => _serverHasTranscript = false);
    }
    _recomputeActiveLens();
  }

  /// Polls for Claude's pending interactive question (#19) every 4s while the
  /// screen is open + foreground, so the native overlay appears as soon as
  /// Claude asks. Cheap (a 256KB transcript-tail read server-side); a server
  /// without the endpoint returns null/404, so polling is safe everywhere.
  void _startQuestionPolling() {
    _questionPoll?.cancel();
    _questionPoll =
        Timer.periodic(const Duration(seconds: 4), (_) => _pollPendingQuestion());
    _pollPendingQuestion();
  }

  Future<void> _pollPendingQuestion() async {
    final api = _api;
    if (api == null) return;
    PendingQuestion? q;
    try {
      q = await api.pendingQuestion(widget.sessionId);
    } catch (_) {
      return; // best-effort; keep whatever's on screen
    }
    if (!mounted) return;
    // Once a *different* question arrives, forget any prior dismissal.
    if (q != null && q.toolUseId != _dismissedQuestionId) {
      _dismissedQuestionId = null;
    }
    if (q?.toolUseId != _pendingQuestion?.toolUseId) {
      setState(() {
        _pendingQuestion = q;
        _questionContext = null; // refilled below for a genuinely new question
      });
      // Pull Claude's lead-up message so the overlay can show the whole answer,
      // not just the question's tail.
      if (q != null) unawaited(_loadQuestionContext());
    }
  }

  /// Fetches the transcript tail and stashes Claude's most recent message as
  /// the pending question's context (shown above the question in the overlay).
  Future<void> _loadQuestionContext() async {
    final api = _api;
    if (api == null) return;
    try {
      final page = await api.transcript(widget.sessionId, limit: 12);
      final text = lastAssistantText(page.messages);
      if (mounted) setState(() => _questionContext = text);
    } catch (_) {
      // Best-effort — the overlay just omits the context panel.
    }
  }

  /// Replays the answer into Claude's TUI as ABSOLUTE row digits (see
  /// [buildAnswerFrames]). Arrows were unreliable: arrow+Enter frames coalesce
  /// into one PTY read and the TUI's batched update confirms the stale top row.
  /// Each frame carries its own settle delay so transition frames land in
  /// separate reads. Hides the overlay optimistically; the next poll confirms.
  Future<void> _answerQuestion(List<AnswerFrame> frames) async {
    final toolUseId = _pendingQuestion?.toolUseId;
    setState(() => _pendingQuestion = null);
    for (var i = 0; i < frames.length; i++) {
      if (!mounted) return;
      _connection?.sendInput(frames[i].keys);
      if (i < frames.length - 1) {
        await Future<void>.delayed(Duration(milliseconds: frames[i].delayMs));
      }
    }
    if (mounted) _scrollToBottom();
    // Answers ending in a confirming Enter (multi-select / multi-question) rely
    // on that Enter arriving in its own stdin read. Over the cluster path,
    // network bunching can coalesce it with the preceding digit so Claude's
    // batched update drops it (same failure family as #19) — the option is left
    // marked but unsubmitted. Verify the prompt actually cleared; if the same
    // one is still pending, the Enter was lost — re-send a lone one.
    if (toolUseId != null && answerNeedsConfirm(frames)) {
      await _confirmAnswerLanded(toolUseId);
    }
  }

  /// Re-sends a lone confirming Enter if the just-answered prompt is still
  /// pending — i.e. the Enter that [buildAnswerFrames] appended was coalesced
  /// away in transit. Polls up to 3× (~900ms apart) and stops the instant the
  /// prompt clears (or a different one replaces it), so a confirm that DID land
  /// never triggers a stray keystroke. A re-sent Enter arrives seconds later, on
  /// its own, guaranteeing a separate stdin read.
  Future<void> _confirmAnswerLanded(String toolUseId) async {
    final api = _api;
    if (api == null) return;
    for (var attempt = 0; attempt < 3; attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 900));
      if (!mounted) return;
      final PendingQuestion? q;
      try {
        q = await api.pendingQuestion(widget.sessionId);
      } catch (_) {
        return; // best-effort — don't spam Enters when polling is failing
      }
      if (!mounted) return;
      // Cleared, or a different prompt took its place → the answer landed.
      if (q == null || q.toolUseId != toolUseId) return;
      // Same prompt still up → the confirm was dropped; send it again alone.
      _connection?.sendInput('\r');
    }
  }

  /// Whether the Chat lens is available for THIS session: the server advertises
  /// the transcript capability, it's a Claude session, and its transcript hasn't
  /// 404'd. SINGLE source of truth — drives the lens default
  /// (_recomputeActiveLens), the app-bar toggle's visibility, and the #43
  /// compose-bar guarantee (when Chat is unavailable the compose bar must never be
  /// hidden, or a raw-mode session is stranded with no usable input).
  bool get _chatAvailable =>
      _serverHasTranscript == true &&
      _session?.claudeSessionId != null &&
      !_transcriptUnavailableForSession;

  /// Chat is the default lens when eligible (Claude session + capability +
  /// hasn't already 404d) and no explicit past choice says otherwise;
  /// Terminal-only (toggle hidden) when not eligible at all.
  void _recomputeActiveLens() {
    final eligible = _chatAvailable;
    final desired = eligible ? (_persistedLens ?? 'chat') : 'terminal';
    if (desired != _activeLens && mounted) {
      setState(() => _activeLens = desired);
    }
  }

  Future<void> _setLens(String value) async {
    if (value == _activeLens) return;
    setState(() {
      _activeLens = value;
      _persistedLens = value;
    });
    // The Chat lens's only input is the compose bar (the terminal is offstage),
    // so put the caret there ready to type — even in raw mode. Returning to the
    // Terminal lens while raw hands the physical keyboard back to the terminal.
    if (value == 'chat') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _composeFocusNode.requestFocus();
      });
    } else if (value == 'terminal' && _rawMode) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _terminalViewKey.currentState?.requestKeyboard();
      });
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('wt_lens_${widget.sessionId}', value);
  }

  /// The Chat lens's own initial load 404d — this specific session has no
  /// transcript despite the server advertising the capability (e.g. a plain
  /// shell, or a Claude session from before the hook that stashes the
  /// transcript path existed). Fall back to Terminal silently.
  void _handleNoTranscript() {
    if (!mounted) return;
    setState(() {
      _transcriptUnavailableForSession = true;
      _activeLens = 'terminal';
    });
  }

  void _onSessionsUpdate(List<Session> sessions) {
    Session? match;
    for (final s in sessions) {
      if (s.id == widget.sessionId) {
        match = s;
        break;
      }
    }
    if (match == null) {
      if (_session != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Session no longer active.')),
        );
        Navigator.of(context).maybePop();
      }
      return;
    }
    final previousStatus = _session?.status;
    final firstLoad = _session == null;
    _notFoundTimer?.cancel();
    setState(() {
      _session = match;
      _notFound = false;
    });
    if (firstLoad) {
      _attach();
      _checkTranscriptCapability();
      // Opening a session dismisses any pending OS notification for it on THIS
      // device immediately (#2) — cheap, local, covers every kind incl. an
      // 'idle'/finished push whose status isn't waiting/api_error.
      NotificationService.cancelForSession(match.id);
      // #24: when it actually needs attention, also clear it on every OTHER
      // device (server flips attention + fans out an FCM 'clear'). Gated so a
      // plain open isn't a needless round-trip.
      if (match.status == 'waiting' || match.status == 'api_error') {
        SessionRepository.instance.dismissAttention(match);
      }
    }
    if (match.status == 'api_error' && previousStatus != 'api_error') {
      _loadAttentionReason();
    } else if (match.status != 'api_error') {
      _apiErrorReason = null;
    }
    _recomputeActiveLens();
  }

  Future<void> _loadAttentionReason() async {
    final session = _session;
    if (session == null) return;
    try {
      final info = await ApiClient(session.server).attention(session.id);
      if (mounted) setState(() => _apiErrorReason = info.reason);
    } catch (_) {
      // best effort — the banner just falls back to a generic message
    }
  }

  /// (Re)loads scrollback and opens a fresh terminal connection. Called on
  /// first attach and every time the app resumes from the background — the
  /// server owns replay, this just re-syncs the view (spec: "reopening
  /// resumes seamlessly").
  Future<void> _attach() async {
    final session = _session;
    if (session == null) return;
    final api = _api ?? ApiClient(session.server);
    _api = api;

    _terminal.buffer.clear();
    _terminal.buffer.setCursor(0, 0);
    try {
      final chunk = await api.scrollback(session.id, limit: 5000);
      if (!mounted) return;
      if (chunk.data.isNotEmpty) {
        _terminal.write(chunk.data);
        // Land on the newest line, not the top of the replayed scrollback.
        _jumpToBottomSoon();
      }
    } catch (_) {
      // best effort — live output still arrives once the socket connects
    }
    if (!mounted) return;

    await _outputSub?.cancel();
    await _connectedSub?.cancel();
    await _reconnectedSub?.cancel();
    _connection?.close();
    _disconnectDebounce?.cancel();

    final connection = api.openTerminal(session.id);
    _connection = connection;
    // Declared once — the connection remembers and replays this (and resize)
    // itself on every reconnect; no need to re-call it reactively.
    connection.setMode('active');
    _outputSub = connection.output.listen(_terminal.write);
    // Fires on every successful RE-connect, before the server's scrollback
    // replay reaches `output` — clear here or history duplicates.
    _reconnectedSub = connection.reconnected.listen((_) {
      _terminal.buffer.clear();
      _terminal.buffer.setCursor(0, 0);
    });
    _connectedSub = connection.connected.listen(_onConnectedChanged);
  }

  /// `connected` only emits `false` after a failed reconnect *attempt* (brief
  /// blips never flicker it), so the debounce here shows nothing for the
  /// first ~3s (covers the common case of a handful of quick retries
  /// succeeding). `sessionTaken` is precise (server said so, synchronously
  /// set before this `false` is emitted) — no need to guess from how long
  /// the failure has lasted, so a merely-bad network never gets mislabeled
  /// "opened elsewhere"; it just keeps showing the hairline + last-updated
  /// time for as long as it takes to recover.
  void _onConnectedChanged(bool isConnected) {
    if (!mounted) return;
    _disconnectDebounce?.cancel();
    if (isConnected) {
      setState(() {
        _showDisconnectBanner = false;
        _showRetakeNotice = false;
        _lastConnectedAt = DateTime.now();
      });
      // Always land on the newest line once connected — independent of the
      // size-jiggle below, which is skipped until the view has reported a size.
      _jumpToBottomSoon();
      // Force Claude to repaint its current frame now that the socket is up —
      // otherwise the replayed (desktop-width) scrollback sits mangled on
      // screen until the keyboard opens and changes the row count. Sending the
      // SAME size is a no-op (no SIGWINCH), so we "jiggle": one row shorter,
      // then back. That guarantees a SIGWINCH → Claude repaints its box clean
      // at phone width (the wide history just scrolls up), the same effect
      // typing used to trigger.
      if (_lastCols > 0 && _lastRows > 1) {
        final cols = _lastCols, rows = _lastRows;
        _connection?.resize(cols, rows - 1);
        Future.delayed(const Duration(milliseconds: 120), () {
          _connection?.resize(cols, rows);
          // Show the newest output straight away — no need to open the
          // keyboard first to see the current frame.
          WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
        });
      }
      return;
    }
    if (_connection?.sessionTaken ?? false) {
      setState(() => _showRetakeNotice = true);
      return;
    }
    _disconnectDebounce = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _showDisconnectBanner = true);
    });
  }

  /// A live slider to set the terminal font size (6–24). Applied instantly as
  /// you drag (smaller = more columns = less wrapping); persisted globally so
  /// every session and future launch keeps it. A resize follows because the
  /// column count changes with the font.
  void _showFontSizeDialog() {
    showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => AlertDialog(
          title: const Text('Terminal text size'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${_termFontSize.round()} pt',
                style: Theme.of(ctx).textTheme.titleLarge,
              ),
              Slider(
                min: 6,
                max: 24,
                divisions: 18,
                value: _termFontSize,
                label: '${_termFontSize.round()}',
                onChanged: (v) {
                  setSheet(() {});
                  setState(() => _termFontSize = v);
                },
              ),
              const Text(
                'Smaller fits more columns — less line wrapping of wide output.',
                style: TextStyle(fontSize: 12),
                textAlign: TextAlign.center,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () async {
                final prefs = await SharedPreferences.getInstance();
                await prefs.setDouble('wt.termFontSize', _termFontSize);
                if (ctx.mounted) Navigator.of(ctx).pop();
              },
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }

  /// "Retake" action for the "Opened elsewhere" notice: exactly `close()` +
  /// `openTerminal()` again, via the same `_attach()` path used everywhere
  /// else a fresh connection is needed.
  void _retake() {
    setState(() {
      _showDisconnectBanner = false;
      _showRetakeNotice = false;
    });
    _attach();
  }

  /// The terminal's own `onOutput` — fires for direct keystrokes in raw mode
  /// and for anything routed through [Terminal.paste] (compose send/paste).
  void _handleTerminalOutput(String data) {
    if (_ctrlSticky && data.length == 1) {
      final code = data.codeUnitAt(0) & 0x1f;
      _connection?.sendInput(String.fromCharCode(code));
      setState(() => _ctrlSticky = false);
      return;
    }
    if (_altSticky && data.length == 1) {
      // Alt/Meta = ESC prefix before the character.
      _connection?.sendInput('\x1b$data');
      setState(() => _altSticky = false);
      return;
    }
    _connection?.sendInput(data);
  }

  void _onSelectionChanged() {
    // Only the toolbar's visibility depends on this — a plain rebuild is
    // enough, no other state to sync.
    if (mounted) setState(() {});
  }

  /// Copies the current long-press selection to the clipboard (owner
  /// priority: fix broken copy/paste). Mirrors xterm's own
  /// `CopySelectionTextIntent` handler, invoked directly since there's no
  /// hardware keyboard shortcut on a phone to trigger it.
  void _copySelection() {
    final selection = _terminalController.selection;
    if (selection == null) return;
    final text = _terminal.buffer.getText(selection);
    Clipboard.setData(ClipboardData(text: text));
    _terminalController.clearSelection();
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)),
    );
  }

  /// Forks [session] straight from the app-bar overflow menu, without going
  /// through the full actions sheet — mirrors `_SessionActionsSheet._fork`
  /// (same auto-command, same "(fork)" name suffix) so both entry points
  /// behave identically. Only called when `session.claudeSessionId != null`
  /// (the menu item is disabled otherwise).
  Future<void> _forkFromMenu(Session session) async {
    final api = _api ?? ApiClient(session.server);
    try {
      final forked = await api.createSession(
        name: '${session.name} (fork)',
        cwd: session.cwd,
        autoCommand: buildForkAutoCommand(session),
      );
      unawaited(SessionRepository.instance.refresh());
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) =>
              SessionScreen(sessionId: forked.id, initialSession: forked),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Fork failed: $e')));
      }
    }
  }

  // --- Compose bar: text changes, live '/' streaming, history -------------

  /// Reacts to every change of [_composeController] — but a pure caret/
  /// selection move (no text change) is a no-op here, matching the web
  /// compose bar where only its `input` DOM event (not `setSelectionRange`)
  /// drives history-walk-reset and live-mode detection.
  void _onComposeChanged() {
    final text = _composeController.text;
    if (text == _lastComposeText) return;
    final prevComposeText = _lastComposeText;
    _lastComposeText = text;

    if (_settingComposeProgrammatically) {
      // Programmatic sets (history recall, draft restore, clear-on-send)
      // never reset history-walking or (re-)trigger live streaming — mirrors
      // the web bar, where only a real DOM `input` event does either.
      _settingComposeProgrammatically = false;
    } else {
      // Sticky Ctrl applies to the NEXT typed character no matter where it's
      // typed: with the compose field focused the char never reaches the PTY
      // via onOutput, so intercept it here — send the control code, restore
      // the field, disarm. (Ctrl+C while composing must interrupt Claude.)
      if ((_ctrlSticky || _altSticky) && text.length > prevComposeText.length) {
        var i = 0;
        while (i < prevComposeText.length &&
            text.codeUnitAt(i) == prevComposeText.codeUnitAt(i)) {
          i++;
        }
        final ch = text[i];
        _connection?.sendInput(
          _ctrlSticky ? String.fromCharCode(ch.codeUnitAt(0) & 0x1f) : '\x1b$ch',
        );
        _settingComposeProgrammatically = true;
        _composeController.value = TextEditingValue(
          text: prevComposeText,
          selection: TextSelection.collapsed(offset: i),
        );
        _lastComposeText = prevComposeText;
        setState(() {
          _ctrlSticky = false;
          _altSticky = false;
        });
        return;
      }
      _historyActive = false;
      // A buffer starting with '/' goes live (every platform): stream it to the
      // terminal so Claude's own slash-command menu renders and narrows as you
      // type. The menu lives in the terminal, so switch there to show it —
      // remembering the prior lens so we can hop back once the command is sent.
      if (!_composeLive && slashStartsLiveStream(text)) {
        _composeLive = true;
        _composeLiveSent = '';
        if (_activeLens != 'terminal') {
          _lensBeforeLive = _activeLens;
          _activeLens = 'terminal';
        }
      }
      if (_composeLive) {
        _streamComposeLive(text);
        if (text.isEmpty) {
          // Deleted the whole line before sending — leave live mode and hop
          // back to wherever we came from.
          _composeLive = false;
          _composeLiveSent = '';
          _restoreLensAfterLive();
        }
      }
    }

    _draftDebounce?.cancel();
    _draftDebounce = Timer(const Duration(milliseconds: 400), _saveDraft);
    if (mounted) setState(() {});
  }

  /// Streams the prefix-diff between what's already been sent for the live
  /// line and the field's current value: backspaces erase removed chars,
  /// then the new suffix follows. Self-correcting against IME re-sends.
  void _streamComposeLive(String val) {
    var i = 0;
    final n = _composeLiveSent.length < val.length
        ? _composeLiveSent.length
        : val.length;
    while (i < n && _composeLiveSent[i] == val[i]) {
      i++;
    }
    final backspaceCount = _composeLiveSent.length - i;
    final backspaces = backspaceCount > 0
        ? String.fromCharCodes(List.filled(backspaceCount, 0x7f))
        : '';
    final suffix = val.substring(i).replaceAll('\n', '\r');
    _composeLiveSent = val;
    final out = backspaces + suffix;
    if (out.isNotEmpty) {
      _connection?.sendInput(out);
      _scrollToBottom();
    }
  }

  /// Sends [body] to the PTY, then the submit Enter as a SEPARATE frame after a
  /// short gap. Claude Code treats text and a trailing CR arriving in one burst
  /// as a *paste* (the CR becomes a newline in the message, not a submit) — so
  /// the message would land in the input box but not send until you pressed
  /// Enter again. A discrete, slightly-delayed CR is read as a real submit
  /// keystroke.
  void _submitToPty(String body) {
    _connection?.sendInput(body);
    Future.delayed(const Duration(milliseconds: 90), () {
      _connection?.sendInput('\r');
    });
  }

  /// Sends the composed buffer. Single-line → raw `text + '\r'`. Multi-line →
  /// bracketed-paste (via [Terminal.paste]) so Claude/readline treat it as
  /// one atomic block, then a trailing `'\r'`. A live '/' line just needs a
  /// commit `'\r'` (its body already streamed char-by-char). An empty buffer
  /// still sends a bare `'\r'` — e.g. to dismiss a prompt.
  void _sendCompose() {
    final val = _composeController.text;
    if (_composeLive) {
      _connection?.sendInput('\r');
      _pushComposeHistory(val);
      _clearComposeInput();
      _scrollToBottom();
      return;
    }
    if (val.isEmpty) {
      _connection?.sendInput('\r');
      _scrollToBottom();
      return;
    }
    // Optimistic Chat echo (#31): show the prompt immediately, before Claude's
    // transcript reflects it. Reconciled/deduped in ConversationView.
    _submittedPrompts.add(val);
    if (val.contains('\n')) {
      // Multi-line: bracketed paste so Claude/readline treat it as one atomic
      // block. Strip any bracketed-paste markers already in the buffer (so user
      // content can't close our wrapper early) and convert interior newlines to
      // CR. The submit Enter is sent SEPARATELY below.
      final safe = val
          .replaceAll(RegExp('\x1b\\[2(?:00|01)~'), '')
          .replaceAll(RegExp(r'\r?\n'), '\r');
      _submitToPty('\x1b[200~$safe\x1b[201~');
    } else {
      _submitToPty(val);
    }
    _pushComposeHistory(val);
    _clearComposeInput();
    _scrollToBottom();
  }

  void _pushComposeHistory(String text) {
    final trimmed = text.replaceFirst(RegExp(r'[\r\n]+$'), '');
    if (trimmed.isEmpty) return;
    if (_sendHistory.isEmpty || _sendHistory.last != trimmed) {
      _sendHistory.add(trimmed);
    }
    if (_sendHistory.length > _kMaxHistory) {
      _sendHistory.removeRange(0, _sendHistory.length - _kMaxHistory);
    }
    _historyActive = false;
    unawaited(_persistHistory());
  }

  void _clearComposeInput() {
    _settingComposeProgrammatically = true;
    _composeLive = false;
    _composeLiveSent = '';
    _historyActive = false;
    _composeController.clear();
    _restoreLensAfterLive();
    unawaited(_saveDraft());
  }

  /// After a live '/' command ends (sent or deleted), hop back to the lens the
  /// user was on when they started typing it — so running /compact from Chat
  /// returns to Chat, not the terminal the menu rendered in. No-op for lines
  /// that never went live (a normal chat send leaves _lensBeforeLive null).
  void _restoreLensAfterLive() {
    if (_lensBeforeLive != null) {
      _activeLens = _lensBeforeLive!;
      _lensBeforeLive = null;
    }
  }

  /// Walks send history: first press (from empty, or continuing a walk)
  /// recalls the most recent entry, further presses step further back/
  /// forward. `dir` is -1 for older (↑), +1 for newer (↓).
  void _historyNav(int dir) {
    if (_sendHistory.isEmpty) return;
    if (!_historyActive) {
      _historyIndex = _sendHistory.length;
      _historyActive = true;
    }
    _historyIndex = (_historyIndex + dir).clamp(0, _sendHistory.length);
    final text = _historyIndex >= _sendHistory.length
        ? ''
        : _sendHistory[_historyIndex];
    _setComposeText(text);
  }

  void _setComposeText(String text) {
    _settingComposeProgrammatically = true;
    _composeController.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  void _moveComposeCaret(int dir) {
    final text = _composeController.text;
    final current = _composeController.selection.start;
    final base = current < 0 ? text.length : current;
    final pos = (base + dir).clamp(0, text.length);
    _composeController.selection = TextSelection.collapsed(offset: pos);
  }

  // --- Key strip ------------------------------------------------------------

  /// In compose mode (not raw, not live, compose field focused): ↑/↓ walk
  /// send-history when the field is empty (or already mid-walk) — otherwise,
  /// and for every other key, the sequence goes straight to the terminal as
  /// before. ←/→ always move the compose caret in that same state (never sent
  /// to the terminal — there'd be nothing visible for them to navigate while
  /// composing). Composing a live '/' line exempts all of this: arrows pass
  /// straight through so they can navigate Claude's live slash menu.
  void _handleKeyStripKeyPress(String sequence) {
    final composeActive =
        composeBarVisible() && _composeFocusNode.hasFocus && !_composeLive;
    if (composeActive) {
      if (sequence == '\x1b[A' || sequence == '\x1b[B') {
        final dir = sequence == '\x1b[A' ? -1 : 1;
        if (_composeController.text.isEmpty || _historyActive) {
          _historyNav(dir);
          return;
        }
      } else if (sequence == '\x1b[D' || sequence == '\x1b[C') {
        _moveComposeCaret(sequence == '\x1b[D' ? -1 : 1);
        return;
      }
    }
    _sendRawToTerminal(sequence);
  }

  void _sendRawToTerminal(String sequence) {
    _handleTerminalOutput(sequence);
    _scrollToBottom();
  }

  /// #26: opens a printed http/https URL when its cell is tapped. The tapped
  /// [cell] carries an absolute buffer-line index; the line is rebuilt column-
  /// aligned (empty cells → spaces, since `getText()` drops them) so the tapped
  /// column maps to the right character. A tap that ends a drag-selection is
  /// ignored, and only http/https ever launches (see [urlAtColumn]).
  Future<void> _onTerminalTapUp(TapUpDetails details, CellOffset cell) async {
    if (_terminalController.selection != null) return;
    final lines = _terminal.buffer.lines;
    final y = cell.y;
    if (y < 0 || y >= lines.length) return;
    final width = _terminal.viewWidth;
    final line = lines[y];
    final sb = StringBuffer();
    for (var i = 0; i < width; i++) {
      final cp = line.getCodePoint(i);
      sb.writeCharCode(cp == 0 ? 0x20 : cp);
    }
    final url = urlAtColumn(sb.toString(), cell.x);
    if (url == null) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // No handler / launch refused — best-effort, never crash the terminal.
    }
  }

  /// App-wide hardware-key hook (only Alt+V, to paste a clipboard image). Runs
  /// before focus dispatch, so it works while the terminal owns the keyboard in
  /// raw mode. Returns true to consume the key.
  bool _globalKeyHandler(KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.keyV &&
        HardwareKeyboard.instance.isAltPressed) {
      _pasteClipboardImage();
      return true;
    }
    return false;
  }

  /// Pastes clipboard text into the compose field in compose mode, or
  /// straight into the terminal (via [Terminal.paste], so bracketed-paste
  /// markers apply when the remote program wants them) in raw mode.
  Future<void> _pasteFromClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    if (_rawMode) {
      _terminal.paste(text);
      _scrollToBottom();
    } else {
      _pasteIntoCompose(text);
    }
  }

  void _pasteIntoCompose(String text) {
    final controller = _composeController;
    final selection = controller.selection;
    final currentText = controller.text;
    final start = selection.isValid ? selection.start : currentText.length;
    final end = selection.isValid ? selection.end : currentText.length;
    final newText = currentText.replaceRange(start, end, text);
    controller.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
  }

  Future<ImageSource?> _chooseImageSource() {
    return showModalBottomSheet<ImageSource>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Camera'),
              onTap: () => Navigator.pop(context, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Gallery'),
              onTap: () => Navigator.pop(context, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
  }

  /// Picks an image and uploads it via `ApiClient.uploadClipboardImage`, which
  /// returns the exact (already bracketed-paste-wrapped) string the server
  /// expects fed straight into the PTY — sent directly, bypassing
  /// [Terminal.paste] to avoid double-wrapping it.
  Future<void> _pickAndSendImage() async {
    final session = _session;
    if (session == null) return;
    final source = await _chooseImageSource();
    if (source == null || !mounted) return;
    XFile? file;
    try {
      file = await ImagePicker().pickImage(source: source, imageQuality: 90);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not open picker: $e')));
      }
      return;
    }
    if (file == null) return;
    try {
      final bytes = await file.readAsBytes();
      final mime = file.mimeType ?? _mimeFromName(file.name);
      final reference = await ApiClient(
        session.server,
      ).uploadClipboardImage(session.id, bytes, mime: mime);
      _connection?.sendInput(reference);
      _scrollToBottom();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Image upload failed: $e')));
      }
    }
  }

  /// Pastes an image straight from the OS clipboard (Alt+V, or the image
  /// button on desktop) and uploads it — no file picker. Falls back with a
  /// hint when the clipboard holds no image.
  Future<void> _pasteClipboardImage() async {
    final session = _session;
    if (session == null) return;
    Uint8List? bytes;
    try {
      bytes = await Pasteboard.image;
    } catch (_) {
      bytes = null;
    }
    if (bytes == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No image in the clipboard')),
        );
      }
      return;
    }
    // Windows hands us the clipboard image as BMP/DIB, not PNG — the server
    // (and Claude) reject a .png that is really BMP bytes. Normalize anything
    // that isn't already PNG/JPEG to PNG before uploading.
    final png = _toPng(bytes);
    if (png == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Clipboard image is not a readable image')),
        );
      }
      return;
    }
    try {
      final reference = await ApiClient(
        session.server,
      ).uploadClipboardImage(session.id, png.bytes, mime: png.mime);
      if (pasteImageIntoCompose(
        activeLens: _activeLens,
        composeFocused: _composeFocusNode.hasFocus,
      )) {
        // #29: composing in chat — insert the plain image path (strip the PTY
        // bracketed-paste wrapper) into the compose field so it's visible and
        // sent with the message; Claude reads the file from the path.
        _pasteIntoCompose(
          reference.replaceAll(RegExp('\x1b\\[2(?:00|01)~'), ''),
        );
      } else {
        _connection?.sendInput(reference);
        _scrollToBottom();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Image upload failed: $e')));
      }
    }
  }

  /// Normalizes raw clipboard image bytes to something the server + Claude
  /// accept. PNG/JPEG pass through untouched; anything else (Windows BMP/DIB)
  /// is decoded and re-encoded as PNG. Returns null if it isn't a decodable
  /// image at all.
  static ({Uint8List bytes, String mime})? _toPng(Uint8List input) {
    if (input.length >= 4 &&
        input[0] == 0x89 &&
        input[1] == 0x50 &&
        input[2] == 0x4E &&
        input[3] == 0x47) {
      return (bytes: input, mime: 'image/png');
    }
    if (input.length >= 3 &&
        input[0] == 0xFF &&
        input[1] == 0xD8 &&
        input[2] == 0xFF) {
      return (bytes: input, mime: 'image/jpeg');
    }
    try {
      final decoded = img.decodeImage(input);
      if (decoded == null) return null;
      return (bytes: Uint8List.fromList(img.encodePng(decoded)), mime: 'image/png');
    } catch (_) {
      return null;
    }
  }

  static String _mimeFromName(String name) {
    final lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
    return 'image/jpeg';
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  }

  /// Jump straight to the newest line, retried across the next frames + a
  /// moment. On open/reconnect the scrollback height isn't final until the
  /// view lays out (and the controller may not be attached yet), so a single
  /// jump can land short of — or before — the real bottom. Used for the
  /// no-animation "show me the latest" cases (open, reconnect).
  void _jumpToBottomSoon() {
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
  }

  // --- Raw-mode toggle + persistence ---------------------------------------

  Future<void> _setRawMode(bool value) async {
    setState(() {
      _rawMode = value;
      // Raw mode is direct terminal typing — meaningless (and invisible)
      // while the Chat lens is showing. Switch so the user can see it. This
      // is a transient override, not persisted as a lens preference.
      if (value) _activeLens = 'terminal';
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('wt_rawmode_${widget.sessionId}', value);
    if (value) {
      _composeFocusNode.unfocus();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _terminalViewKey.currentState?.requestKeyboard();
      });
    } else {
      _terminalViewKey.currentState?.closeKeyboard();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _composeFocusNode.requestFocus();
      });
    }
  }

  Future<void> _saveDraft() async {
    final prefs = await SharedPreferences.getInstance();
    final text = _composeController.text;
    if (text.isEmpty) {
      await prefs.remove('wt_draft_${widget.sessionId}');
    } else {
      await prefs.setString('wt_draft_${widget.sessionId}', text);
    }
  }

  Future<void> _persistHistory() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      'wt_history_${widget.sessionId}',
      jsonEncode(_sendHistory),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        SessionRepository.instance.refresh();
        _attach();
        _startQuestionPolling();
        if (_rawMode) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _terminalViewKey.currentState?.requestKeyboard();
          });
        }
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _outputSub?.cancel();
        _connectedSub?.cancel();
        _reconnectedSub?.cancel();
        _connection?.close();
        _connection = null;
        _disconnectDebounce?.cancel();
        _questionPoll?.cancel();
        // A deliberate close, not a failure — don't show disconnect/retake UI
        // while backgrounded; resuming re-attaches from scratch.
        if (mounted) {
          setState(() {
            _showDisconnectBanner = false;
            _showRetakeNotice = false;
          });
        }
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (DesktopAlertService.supported) {
      DesktopAlertService.instance.markHidden(widget.sessionId);
    }
    HardwareKeyboard.instance.removeHandler(_globalKeyHandler);
    _notFoundTimer?.cancel();
    _draftDebounce?.cancel();
    _disconnectDebounce?.cancel();
    _questionPoll?.cancel();
    _submittedPrompts.close();
    for (final t in _scrollTimers) {
      t.cancel();
    }
    _repoSub?.cancel();
    _outputSub?.cancel();
    _connectedSub?.cancel();
    _reconnectedSub?.cancel();
    _connection?.close();
    _terminalController.removeListener(_onSelectionChanged);
    _terminalController.dispose();
    _composeController.removeListener(_onComposeChanged);
    _composeController.dispose();
    _composeFocusNode.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = _session;
    final theme = Theme.of(context);

    if (session == null) {
      return Scaffold(
        appBar: AppBar(
          automaticallyImplyLeading: !widget.embedded && !widget.standalone,
          title: const Text('Session'),
        ),
        body: Center(
          child: _notFound
              ? Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.search_off,
                        size: 48, color: theme.colorScheme.onSurfaceVariant),
                    const SizedBox(height: 12),
                    Text('That session is no longer active.',
                        style: theme.textTheme.bodyLarge),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                      child: const Text('Back to sessions'),
                    ),
                  ],
                )
              : const CircularProgressIndicator(),
        ),
      );
    }

    final status = sessionStatusFromString(session.status);
    final displayName = session.name.isEmpty
        ? 'Session ${session.shortId}'
        : session.name;

    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: !widget.embedded && !widget.standalone,
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            StatusDot(status: status),
            const SizedBox(width: 8),
            Flexible(child: Text(displayName, overflow: TextOverflow.ellipsis)),
          ],
        ),
        actions: [
          if (_chatAvailable)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _LensToggle(value: _activeLens, onChanged: _setLens),
            ),
          if (DetachWindow.supported && !widget.standalone)
            IconButton(
              icon: const Icon(Icons.open_in_new),
              tooltip: 'Open in new window',
              onPressed: () => DetachWindow.open(session.server, session.id),
            ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Center(child: ServerBadge(name: session.server.name)),
          ),
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'fork') {
                _forkFromMenu(session);
                return;
              }
              if (value == 'fontsize') {
                _showFontSizeDialog();
                return;
              }
              showSessionActionsSheet(
                context,
                session,
                onChanged: SessionRepository.instance.refresh,
                onForked: (forked) => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => SessionScreen(
                      sessionId: forked.id,
                      initialSession: forked,
                    ),
                  ),
                ),
              );
            },
            itemBuilder: (context) => [
              PopupMenuItem(
                value: 'fork',
                enabled: canForkFromMenu(session),
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.call_split),
                  title: const Text('Fork session'),
                  subtitle: canForkFromMenu(session)
                      ? null
                      : const Text('Only Claude sessions can be forked'),
                ),
              ),
              const PopupMenuItem(
                value: 'fontsize',
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.format_size),
                  title: Text('Terminal text size'),
                ),
              ),
              const PopupMenuItem(value: 'rename', child: Text('Rename')),
              const PopupMenuItem(value: 'kill', child: Text('Kill')),
              const PopupMenuItem(value: 'notify', child: Text('Notify level')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          // No modal — a thin animated hairline (debounced ~3s so a blip that
          // self-heals never flashes anything), optionally with a muted
          // "updated Ns ago" note. A separate, precise "Opened elsewhere"
          // notice (below) fires only when the server actually said so
          // (`connection.sessionTaken`), never from prolonged failure alone.
          if (_showDisconnectBanner) ...[
            const _DisconnectHairline(),
            if (_lastConnectedAt != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text(
                  'Updated ${relativeTime(_lastConnectedAt!.millisecondsSinceEpoch)}',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
          if (_showRetakeNotice)
            Container(
              width: double.infinity,
              color: theme.colorScheme.surfaceContainerHigh,
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.screenPadding,
                vertical: 8,
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.link_off,
                    size: 16,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Opened elsewhere',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  TextButton(onPressed: _retake, child: const Text('Retake')),
                ],
              ),
            ),
          if (status == SessionStatus.waiting)
            _AttentionBanner(
              color: StatusColor.waiting,
              icon: Icons.priority_high,
              text: 'Claude needs your approval — respond below',
              onTap: _scrollToBottom,
            ),
          if (status == SessionStatus.apiError)
            _AttentionBanner(
              color: theme.colorScheme.error,
              icon: Icons.warning_amber_rounded,
              text: (_apiErrorReason?.isNotEmpty ?? false)
                  ? _apiErrorReason!
                  : 'API error — Claude stopped responding',
              onTap: _scrollToBottom,
            ),
          Expanded(
            child: Stack(
              children: [
                // Always mounted (never torn down) so the underlying
                // connection/scroll/focus state is never disturbed by
                // switching lenses — only visually hidden while Chat is
                // showing. Terminal lens = existing xterm view, unchanged.
                Offstage(
                  offstage: _activeLens != 'terminal',
                  child: Stack(
                    children: [
                      ColoredBox(
                        color: AppColors.background,
                        child: TerminalView(
                          key: _terminalViewKey,
                          _terminal,
                          controller: _terminalController,
                          scrollController: _scrollController,
                          theme: AppTheme.terminal,
                          // Small monospace so a phone fits ~75+ columns —
                          // near Claude's TUI width, avoiding catastrophic
                          // line-wrap of wide output. The view auto-derives
                          // cols from this and resizes the PTY via onResize.
                          textStyle: TerminalStyle(
                            fontSize: _termFontSize,
                            fontFamily: 'monospace',
                          ),
                          autofocus: false,
                          // View-only in compose mode: no on-screen keyboard
                          // on tap (`hardwareKeyboardOnly`), no input reaches
                          // the PTY from the terminal itself (`readOnly`) —
                          // all typing goes through the compose bar instead.
                          // Scrolling/selection/copy are unaffected by either
                          // flag. Raw mode flips both off for direct terminal
                          // typing (vim, TUIs, Claude's arrow-key menus).
                          hardwareKeyboardOnly: !_rawMode,
                          readOnly: !_rawMode,
                          // #26: tap a printed http/https URL to open it in the
                          // system browser (additive — focus/keyboard still run
                          // via the view's own tap-down handler).
                          onTapUp: _onTerminalTapUp,
                        ),
                      ),
                      // Floats above the terminal instead of taking a Column
                      // slot so starting/ending a selection never resizes
                      // (and thus never re-scrolls) the terminal underneath.
                      if (_terminalController.selection != null)
                        Positioned(
                          top: 8,
                          left: 0,
                          right: 0,
                          child: Center(
                            child: _SelectionToolbar(
                              onCopy: _copySelection,
                              onCancel: _terminalController.clearSelection,
                            ),
                          ),
                        ),
                      // Jump-to-bottom: scroll the terminal to the newest line.
                      Positioned(
                        right: 12,
                        bottom: 12,
                        child: FloatingActionButton.small(
                          heroTag: 'term-jump-bottom',
                          backgroundColor:
                              theme.colorScheme.surfaceContainerHigh,
                          foregroundColor: theme.colorScheme.primary,
                          onPressed: _scrollToBottom,
                          child: const Icon(Icons.keyboard_double_arrow_down),
                        ),
                      ),
                    ],
                  ),
                ),
                if (_activeLens == 'chat')
                  ConversationView(
                    session: session,
                    onNoTranscript: _handleNoTranscript,
                    submittedPrompts: _submittedPrompts.stream,
                  ),
                // Native overlay for Claude's interactive question (#19), above
                // whichever lens is showing. The key strip below stays usable as
                // a manual fallback.
                if (_pendingQuestion != null &&
                    _pendingQuestion!.toolUseId != _dismissedQuestionId)
                  QuestionOverlay(
                    question: _pendingQuestion!,
                    contextText: _questionContext,
                    onSend: _answerQuestion,
                    onKey: _sendRawToTerminal,
                    onDismiss: () => setState(() =>
                        _dismissedQuestionId = _pendingQuestion?.toolUseId),
                  ),
              ],
            ),
          ),
          if (composeBarVisible())
            ComposeBar(
              controller: _composeController,
              focusNode: _composeFocusNode,
              onSend: _sendCompose,
              isLive: _composeLive,
              onPasteImage: _pasteClipboardImage,
              // Hardware Esc reaches the terminal; hardware arrows (while the
              // compose field is empty) go through the same routing as the
              // on-screen keys — ↑/↓ walk send-history, ←/→ move the caret.
              onEscape: () => _sendRawToTerminal('\x1b'),
              onArrow: _handleKeyStripKeyPress,
              // Tab autocompletes the highlighted slash command — only while a
              // live '/' line is streaming (ComposeBar gates it on isLive).
              onTab: () => _sendRawToTerminal('\t'),
              // Backspace on an already-empty field during a live line clears
              // the leftover of a Tab-completed command (which the field never
              // tracked) straight from Claude's input line.
              onBackspace: () => _sendRawToTerminal('\x7f'),
            ),
          // No viewInsets padding here: Scaffold's resizeToAvoidBottomInset
          // already shrinks the body for the keyboard — padding again doubles
          // the offset and crushes the terminal into a sliver. SafeArea only
          // guards the gesture bar when the keyboard is closed.
          SafeArea(
            top: false,
            child: TerminalKeyStrip(
              // #34: the on-screen key strip is a *terminal* control — its keys
              // (Esc, Tab, and the arrows) go straight to the PTY, matching the
              // web client's arrow buttons, so Claude's native arrow-driven TUI
              // (subagent switcher, menus) is navigable from the app. Only the
              // compose field's own hardware arrows stay compose-aware (caret /
              // history) via ComposeBar.onArrow below — that's the one place a
              // typed arrow is meant to edit text.
              onKey: _sendRawToTerminal,
              ctrlActive: _ctrlSticky,
              onToggleCtrl: () => setState(() => _ctrlSticky = !_ctrlSticky),
              altActive: _altSticky,
              onToggleAlt: () => setState(() => _altSticky = !_altSticky),
              onPaste: _pasteFromClipboard,
              onImage: _pickAndSendImage,
              rawMode: _rawMode,
              onToggleRawMode: () => _setRawMode(!_rawMode),
              // #30/#11: hide the raw-keyboard toggle on desktop — there it
              // stranded the user (raw ON → Terminal lens, compose hidden) and
              // the on-screen keyboard is redundant with a physical one. Desktop
              // input follows the lens toggle instead.
              showRawToggle: !isDesktopPlatform(),
            ),
          ),
        ],
      ),
    );
  }
}

/// Small floating pill shown while the user has an active long-press
/// selection: Copy + a cancel (×) affordance.
/// Compact app-bar Chat/Terminal segmented toggle — icon-only to fit next to
/// the server badge and menu on a phone-width app bar.
class _LensToggle extends StatelessWidget {
  const _LensToggle({required this.value, required this.onChanged});

  final String value; // 'chat' | 'terminal'
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    Widget segment(String v, IconData icon, String tooltip) {
      final selected = value == v;
      return Tooltip(
        message: tooltip,
        child: InkWell(
          onTap: () => onChanged(v),
          borderRadius: BorderRadius.circular(AppShape.small),
          child: Container(
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: selected
                  ? theme.colorScheme.primaryContainer
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(AppShape.small),
            ),
            child: Icon(
              icon,
              size: 18,
              color: selected
                  ? theme.colorScheme.onPrimaryContainer
                  : theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(AppShape.small),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          segment('chat', Icons.forum_outlined, 'Chat'),
          segment('terminal', Icons.terminal, 'Terminal'),
        ],
      ),
    );
  }
}

class _SelectionToolbar extends StatelessWidget {
  const _SelectionToolbar({required this.onCopy, required this.onCancel});

  final VoidCallback onCopy;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surfaceContainerHigh,
      elevation: 4,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppShape.large),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton.icon(
              onPressed: onCopy,
              icon: const Icon(Icons.copy, size: 16),
              label: const Text('Copy'),
            ),
            IconButton(
              onPressed: onCancel,
              icon: const Icon(Icons.close, size: 18),
              tooltip: 'Cancel selection',
              visualDensity: VisualDensity.compact,
            ),
          ],
        ),
      ),
    );
  }
}

/// Thin (3dp) indeterminate hairline shown under the app bar while
/// disconnected (debounced — see `_showDisconnectBanner`). Replaces the old
/// modal "Reconnecting…" banner per the accepted v2 design: quiet, not
/// blocking, and never shown for a blip that self-heals within ~3s.
class _DisconnectHairline extends StatelessWidget {
  const _DisconnectHairline();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      height: 3,
      child: LinearProgressIndicator(
        minHeight: 3,
        backgroundColor: Colors.transparent,
        valueColor: AlwaysStoppedAnimation(
          theme.colorScheme.error.withValues(alpha: 0.7),
        ),
      ),
    );
  }
}

class _AttentionBanner extends StatelessWidget {
  const _AttentionBanner({
    required this.color,
    required this.icon,
    required this.text,
    this.onTap,
  });

  final Color color;
  final IconData icon;
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        color: color.withValues(alpha: 0.12),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.screenPadding,
          vertical: 8,
        ),
        child: Row(
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                text,
                style: theme.textTheme.bodySmall?.copyWith(color: color),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
