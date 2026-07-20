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
import '../services/speech_service.dart';
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

/// Whether [session] runs an AI agent that keeps a transcript, and so can have a
/// Chat lens at all. Pure, for the same reason as [canForkFromMenu].
///
/// `agent` is the server's answer — `null` means a plain shell, which has no
/// conversation to show. `claudeSessionId` is the pre-`agent` fallback so a session
/// served by an OLDER server still gets its Chat lens.
///
/// Gating on `claudeSessionId` alone hid Chat for every Codex session: only Claude
/// records a conversation id, yet the transcript is fetched by `session.id` and never
/// needs one.
bool sessionKeepsTranscript(Session? session) =>
    session != null &&
    (session.agent != null || session.claudeSessionId != null);

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

/// Whether the terminal view takes input directly — keys straight to the PTY and
/// a tap raises the keyboard — which is true exactly when the Terminal lens is
/// showing, on every platform. This mirrors the web client, whose xterm view is
/// never read-only and forwards every key to the socket (`app.html` term.onData
/// → sendInput → ws.send); only Alt+V / Ctrl+V / Ctrl+C are skimmed off.
///
/// Deliberately NOT tied to `_rawMode`: that flag defaulted OFF on phones, which
/// left the terminal `readOnly` there, so tapping it did nothing and Claude's TUI
/// selector could not be answered by typing. `_rawMode` now only decides whether
/// the terminal AUTO-grabs the keyboard. Gating on the lens also keeps the
/// offstage terminal from taking keys while Chat is showing. Pure + testable so
/// the "terminal lens is always live" invariant has one enforceable home.
bool terminalAcceptsInput(String activeLens) => activeLens == 'terminal';

/// True on desktop platforms (a real hardware keyboard). One definition so the
/// raw-mode default, the '/' live-stream gate (#28), and image-paste routing
/// all read the same rule.
bool isDesktopPlatform() =>
    !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

/// Whether the live terminal should take raw hardware key events only (no IME
/// text-input connection). True unless the terminal is [live] on a non-[desktop]
/// (mobile) platform, which needs the IME path for its soft keyboard.
///
/// #46: xterm-4.0.0's IME path submits Enter only via `onAction(done)`, but its
/// text connection is configured `TextInputAction.newline`. On a desktop
/// hardware keyboard, Enter fires `performAction(newline)` — which xterm drops —
/// and the raw KeyEvent is swallowed by the connection, so it never reaches
/// `keyInput(TerminalKey.enter)`: the typed prompt parked until the key-strip
/// Enter (a lone `\r`) was tapped. Desktop has no soft keyboard, so hardware-only
/// routes Enter as a KeyEvent → `keyInput(enter)` → `\r` and it submits (tap
/// still focuses the view). Mobile keeps the IME path: a soft keyboard commits
/// Enter as inserted `'\n'` text, which [terminalOutputToPty] maps to `\r`.
bool terminalHardwareKeyboardOnly({
  required bool live,
  required bool desktop,
}) => !live || desktop;

/// Whether the terminal/PTY is the active input target — the state in which
/// hardware Tab and arrows should drive Claude's TUI (its `/status` tabs, menus,
/// and the multi-question phase) instead of moving focus between the app's
/// on-screen buttons. True in the Terminal lens ([lensLive]), and whenever the
/// interactive-question overlay is up ([questionUp] — Claude's question TUI is
/// live in the terminal beneath it). #50: the compose bar (the always-present
/// input that normally holds focus) forwards Tab/arrows to the PTY when this is
/// true, mirroring the web client where every key reaches the socket. Pure so
/// the rule has one enforceable, testable home.
bool terminalIsActiveTarget({
  required bool lensLive,
  required bool questionUp,
}) => lensLive || questionUp;

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
}) => activeLens == 'chat' || composeFocused;

/// The exact bytes that submit a composed prompt to the PTY, INCLUDING the
/// trailing submit CR, as ONE atomic frame — matching the web client
/// (`app.html` composeSend). Single-line → `text\r`. Multi-line → bracketed
/// paste (`ESC[200~ … ESC[201~`) with interior newlines as CR and any existing
/// paste markers stripped (so user content can't close the wrapper early), then
/// the submit `\r` AFTER the close marker.
///
/// Sending the body and its `\r` together — not as a delayed second write — is
/// the #44 fix: the old split (`_submitToPty` wrote the body, then `\r` 90ms
/// later) could lose the `\r` when `_connection` was nulled on background or
/// replaced by a reconnect in that gap, leaving the text on the shared PTY input
/// line unsent (it then "vanished" from chat when the optimistic echo timed out).
///
/// A TRAILING newline is stripped first: the desktop compose field displays
/// multiple lines, and on Windows a maxLines>1 TextField inserts a newline on the
/// submitting Enter before the send fires, so a plain "hello" prompt reaches here
/// as "hello\n". Without stripping it, that single-line prompt goes out as a
/// bracketed paste whose submit CR Claude's TUI absorbs — the text parks in the
/// input line unsent. Interior newlines (a genuine multi-line prompt) are kept.
/// Pure so the payload is exhaustively testable.
String buildComposeSubmission(String val) {
  val = val.replaceFirst(RegExp(r'[\r\n]+$'), '');
  if (val.contains('\n')) {
    final safe = val
        .replaceAll(RegExp('\x1b\\[2(?:00|01)~'), '')
        .replaceAll(RegExp(r'\r?\n'), '\r');
    return '\x1b[200~$safe\x1b[201~\r';
  }
  return '$val\r';
}

/// What a live '/'-line mirrors into the agent's TUI prompt (#55 §1).
///
/// A '/'-prefixed buffer streams to the PTY as you type so the agent's own slash menu
/// narrows. That prompt is ONE line, and the byte a newline would have to become there is
/// `\r` — the SUBMIT key. Mirroring it would fire the command, which is precisely what made
/// Enter submit a '/'-line on mobile (and Ctrl+Enter submit one on desktop) while both only
/// insert a newline in every other buffer. So newlines are dropped from the projection: the
/// menu still narrows, and nothing submits until Send (or a desktop Enter) says so.
/// Pure so it is testable on its own.
String composeLiveProjection(String val) => val.replaceAll('\n', '');

/// One chunk of the terminal's `onOutput`, translated to the bytes the PTY
/// should receive.
///
/// A soft keyboard commits Enter as literal text, not a key event: xterm's
/// `_onInsert` calls `charToTerminalKey('\n'.trim())`, i.e. `charToTerminalKey('')`,
/// which is null (length != 1), so it falls back to `terminal.textInput('\n')`
/// and a raw LF reaches the PTY. Claude's TUI inserts a newline in the prompt on
/// LF and submits only on CR, so the typed prompt just sat there until the
/// toolbar's Enter (`onKey('\r')`) was tapped. A hardware Enter never had this
/// problem — it routes through `keyInput(TerminalKey.enter)`, whose keytab entry
/// is `Enter-NewLine: "\r"` — and neither does the web client, whose xterm.js
/// `onData` yields `\r`.
///
/// Only a LONE LF is rewritten. `_pasteFromClipboard` routes `Terminal.paste`
/// through this same callback, where interior newlines are paste content and
/// must survive verbatim. Sticky Ctrl+J is intercepted before this runs.
String terminalOutputToPty(String data) => data == '\n' ? '\r' : data;

/// A terminal context-menu action (#49). Right-click on the terminal offers
/// these clipboard actions, matching the web client's long-press menu.
enum TerminalMenuAction { copy, paste, selectAll }

/// The context-menu actions to show for the terminal, given whether text is
/// currently selected. Copy needs a selection to act on; Paste and Select All
/// are always available (Paste's own no-op-on-empty-clipboard is handled by the
/// handler). Pure so the menu's contents are testable without a live terminal.
List<TerminalMenuAction> terminalContextMenuActions({
  required bool hasSelection,
}) => <TerminalMenuAction>[
  if (hasSelection) TerminalMenuAction.copy,
  TerminalMenuAction.paste,
  TerminalMenuAction.selectAll,
];

/// Selects the terminal's entire buffer (#49 — "Select All"), so the existing
/// copy path then yields the whole scrollback. Anchors span (0,0) → the last
/// cell of the last line; [TerminalController.setSelection] takes ownership of
/// the anchors. Factored out so the anchor math is unit-testable against a real
/// [Terminal] without any Flutter widgets.
void selectAllOnTerminal(Terminal terminal, TerminalController controller) {
  final buffer = terminal.buffer;
  final base = buffer.createAnchor(0, 0);
  final extent = buffer.createAnchor(terminal.viewWidth - 1, buffer.height - 1);
  controller.setSelection(base, extent);
}

/// Copies [controller]'s current selection out of [terminal] to the system
/// clipboard and clears it. The ONE clipboard-writing implementation for the
/// terminal (#49 menu Copy, the on-selection toolbar, and #52's Ctrl+C /
/// Ctrl+Shift+C shortcut all call this — no second `Clipboard.setData` path).
/// Returns the copied text, or `null` when nothing was selected (a no-op).
/// Takes the terminal + controller directly (no BuildContext) so it is
/// exercisable in a widget test against a real [Terminal]/[TerminalController].
String? copyTerminalSelection(Terminal terminal, TerminalController controller) {
  final selection = controller.selection;
  if (selection == null) return null;
  final text = terminal.buffer.getText(selection);
  Clipboard.setData(ClipboardData(text: text));
  controller.clearSelection();
  return text;
}

/// Whether a Ctrl+C (Cmd+C on macOS) key press on the terminal should copy the
/// selection instead of falling through to the terminal's normal handling of
/// that key — which sends SIGINT (`\x03`, #11) when nothing intercepts it.
///
/// Mirrors the web client's model (`app.html`: `(e.ctrlKey||e.metaKey) && isC
/// && term.hasSelection()`) — the Windows Terminal resolution of the same
/// physical key doing two jobs: **Ctrl+C copies when there IS a selection,
/// else it falls through to SIGINT.** Ctrl+Shift+C is an explicit, unambiguous
/// copy that never interrupts, selection or not — for the times a selection
/// exists but the plain combo feels ambiguous.
///
/// Desktop hardware-keyboard only (touch has #49's long-press menu instead).
/// Pure/testable without any widget — [desktop] and the modifier states are
/// passed in rather than read from `HardwareKeyboard`/`Platform` here.
bool terminalCopyShortcutTriggered({
  required bool desktop,
  required bool ctrlOrCmdPressed,
  required bool shiftPressed,
  required bool hasSelection,
}) {
  if (!desktop || !ctrlOrCmdPressed) return false;
  return shiftPressed || hasSelection;
}

/// A staged compose-bar image attachment (#29): the thumbnail [bytes] shown in
/// the removable chip, and the server [path] delivered to Claude on submit.
class _ComposeAttachment {
  const _ComposeAttachment({required this.bytes, required this.path});
  final Uint8List bytes;
  final String path;

  /// The PTY payload for this image — the path wrapped in bracketed paste, as
  /// the upload API returns it, so Claude reads it as a pasted file path.
  String get reference => '\x1b[200~$path\x1b[201~';
}

/// Whether the interactive-question overlay (#19) should be visible. A question
/// shows unless it's the one the user already dealt with — [dismissedId] is set
/// both when they dismiss to answer in-terminal AND right after they answer via
/// the overlay. That second case matters: a just-answered question stays
/// "pending" server-side for seconds until Claude consumes the answer (writes a
/// tool_result), so the 4s poll keeps returning it; without this suppression the
/// overlay flashes back until Claude starts working. A genuinely NEW question
/// (different toolUseId) clears the dismissal upstream (_pollPendingQuestion) and
/// shows normally. Pure + one home so render and answer paths can't drift.
bool questionOverlayVisible(PendingQuestion? pending, String? dismissedKey) =>
    pending != null && questionSignature(pending) != dismissedKey;

/// A STABLE identity for a pending question, derived from its CONTENT (headers,
/// question text, multiSelect, option labels) instead of the volatile
/// `toolUseId`.
///
/// The server reports a synthetic `hook-<session>-<seq>` id while the question is
/// LIVE (captured from the PreToolUse hook), but the real `toolu_…` id once it
/// falls back to scanning the transcript — and that `seq` changes on every hook
/// event. Keying "already answered / dismissed" on the id therefore made the SAME
/// question look brand-new: the dismissal was cleared, the overlay re-appeared,
/// and the user answered a SECOND time. Claude had already closed the selector by
/// then, so that second frame set was typed as literal text onto the prompt line
/// — needing a manual Enter/clear. Content is stable across both id forms.
/// Pure so the identity rule is enforceable.
String questionSignature(PendingQuestion? q) {
  if (q == null) return '';
  final b = StringBuffer();
  for (final item in q.questions) {
    b
      ..write(item.header)
      ..write('\u0001')
      ..write(item.question)
      ..write('\u0001')
      ..write(item.multiSelect ? '1' : '0')
      ..write('\u0001');
    for (final o in item.options) {
      b
        ..write(o.label)
        ..write('\u0002');
    }
    b.write('\u0003');
  }
  return b.toString();
}

/// After verifying a submitted answer, whether the overlay must be re-shown: the
/// same prompt is [stillPending] (the answer never landed after every retry) AND
/// it's still the one we optimistically dismissed ([dismissedKey] == the answered
/// signature — the user hasn't since dismissed or moved to another prompt).
/// Prevents a dropped answer from leaving a hidden, silently-stuck question
/// (#19 follow-up). Pure so the recovery rule is enforceable.
bool shouldResurfaceAfterAnswer({
  required bool stillPending,
  required String answeredKey,
  required String? dismissedKey,
}) => stillPending && dismissedKey == answeredKey;

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
  bool _speaking = false; // #70: an utterance is playing (drives the stop icon)
  String? _apiErrorReason;

  // --- Interactive question overlay (#19) ----------------------------------
  PendingQuestion? _pendingQuestion;
  // Signature (see questionSignature) of a question the user already dealt with —
  // dismissed to answer in-terminal, or just answered via the overlay. Keyed on
  // CONTENT, not toolUseId: the server's id flips between a synthetic
  // `hook-<id>-<seq>` (live) and the real `toolu_…` (transcript), which used to
  // read as a brand-new question and re-show the overlay.
  String? _dismissedQuestionKey;
  String?
  _questionContext; // Claude's preceding message, shown above the question
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
  // Image attachments staged in the compose bar (#29): pasted/added images shown
  // as removable thumbnail chips; their file paths are sent to the PTY on submit
  // (as pasted paths), not typed into the field as raw text.
  final List<_ComposeAttachment> _attachments = <_ComposeAttachment>[];
  // Whether the terminal AUTO-GRABS the keyboard (raw-first) rather than leaving
  // focus on the compose bar. It no longer gates typing: in the terminal lens the
  // view is always live, so a tap focuses it and keys flow to the PTY (web
  // parity). Defaults to `isDesktop` (see _loadPersisted), persisted per session.
  bool _rawMode = false;
  bool _composeLive = false; // true while a '/'-prefixed line is streaming live
  String _composeLiveSent =
      ''; // chars already streamed to the terminal for the live line
  String? _lensBeforeLive; // lens to restore to once a live '/' command is sent
  bool _liveTabbed =
      false; // Tab completed the live line — the terminal owns extra chars now
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
    // The sessions stream is broadcast (no replay), so this screen — often opened
    // from a notification tap — would otherwise receive nothing until the next
    // emission (up to the 30s poll), flashing "session not found" for a session
    // already in the repo (backing out re-emits and reveals it). Seed from the
    // current snapshot AFTER the first frame, so _onSessionsUpdate runs exactly
    // like a normal stream emission (view built, event loop ready — never a
    // synchronous attach mid-initState). Guarded so it no-ops if the live stream
    // already delivered the session.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _session == null) {
        _onSessionsUpdate(SessionRepository.instance.current);
      }
    });
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
    final fontSize = prefs.getDouble(
      'wt.termFontSize',
    ); // global, not per-session
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
    _questionPoll = Timer.periodic(
      const Duration(seconds: 4),
      (_) => _pollPendingQuestion(),
    );
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
    // Once a genuinely *different* question arrives, forget any prior dismissal.
    // Compared by CONTENT: the same question re-reported under a new toolUseId
    // (synthetic hook id → real transcript id, or a re-fired PreToolUse) must not
    // clear the dismissal and re-show the overlay.
    if (q != null && questionSignature(q) != _dismissedQuestionKey) {
      _dismissedQuestionKey = null;
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
    final answeredKey = questionSignature(_pendingQuestion);
    // Mark this question dealt-with so the next 4s poll can't flash the overlay
    // back: it stays pending server-side until Claude consumes the answer (writes
    // a tool_result), which lags the keystrokes by seconds. A genuinely new
    // question clears the dismissal in _pollPendingQuestion and shows.
    setState(() {
      _pendingQuestion = null;
      _dismissedQuestionKey = answeredKey;
    });
    for (var i = 0; i < frames.length; i++) {
      if (!mounted) return;
      _connection?.sendInput(frames[i].keys);
      if (i < frames.length - 1) {
        await Future<void>.delayed(Duration(milliseconds: frames[i].delayMs));
      }
    }
    if (mounted) _scrollToBottom();
    // Verify the answer actually landed — and un-strand it if it didn't. We just
    // dismissed the overlay optimistically, so a dropped answer would otherwise
    // sit hidden-but-pending forever (the user only learns Claude never moved).
    if (answeredKey.isNotEmpty) {
      await _verifyAnswerLanded(
        answeredKey,
        resendEnter: answerNeedsConfirm(frames),
      );
    }
  }

  /// How long to wait for the server to stop reporting the answered question
  /// before concluding the answer never landed. The server's LIVE question stash
  /// is cleared only by a later hook event (PostToolUse / Stop / the next
  /// PreToolUse) — never by the answer keystrokes themselves — so its latency is
  /// unbounded relative to us. The old budget (3 × 900ms ≈ 2.7s) routinely expired
  /// while the answer was in fact landing, which resurfaced the overlay, invited a
  /// SECOND answer, and typed that frame set as literal text into the prompt line
  /// of an already-closed selector. A longer budget makes the false "never landed"
  /// verdict rare; a genuinely dropped answer still recovers, just later.
  static const int _answerVerifyAttempts = 8; // × 900ms ≈ 7.2s

  /// Confirms the just-answered prompt cleared, and recovers if it didn't.
  ///
  /// Polls up to [_answerVerifyAttempts]× (~900ms apart), stopping the instant the
  /// prompt clears (or a genuinely different one replaces it — compared by
  /// CONTENT, see [questionSignature]) — the answer landed.
  ///
  /// When [resendEnter] (the answer ended in a confirming Enter, which cluster-
  /// path bunching can coalesce away — same failure family as #19) a lone Enter is
  /// re-sent ONCE, on the first round that still shows the prompt, arriving in its
  /// own stdin read. It is not repeated: if the selector has in fact closed, every
  /// extra `\r` submits whatever sits on Claude's prompt line. Answers that
  /// auto-submit on their last digit pass `resendEnter: false`, so no stray
  /// keystroke is sent at all.
  ///
  /// If the prompt is STILL pending after every retry, the answer never took —
  /// so we clear the optimistic dismissal and re-show the overlay. Without this
  /// the user is silently stranded: overlay gone, question unanswered, Claude
  /// waiting, and (pre-#19-dismissal) not even a re-bump to signal it.
  Future<void> _verifyAnswerLanded(
    String answeredKey, {
    required bool resendEnter,
  }) async {
    final api = _api;
    if (api == null) return;
    PendingQuestion? stillPending;
    var resentEnter = false;
    for (var attempt = 0; attempt < _answerVerifyAttempts; attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 900));
      if (!mounted) return;
      final PendingQuestion? q;
      try {
        q = await api.pendingQuestion(widget.sessionId);
      } catch (_) {
        return; // best-effort — don't spam Enters when polling is failing
      }
      if (!mounted) return;
      // Cleared, or a genuinely different prompt took its place → answer landed.
      if (q == null || questionSignature(q) != answeredKey) return;
      stillPending = q;
      if (resendEnter && !resentEnter) {
        resentEnter = true;
        _connection?.sendInput('\r'); // dropped confirm → resend exactly once
      }
    }
    // Exhausted retries with the same prompt up → surface it again so the user
    // can retry, instead of a silently stuck, hidden question.
    if (mounted &&
        shouldResurfaceAfterAnswer(
          stillPending: stillPending != null,
          answeredKey: answeredKey,
          dismissedKey: _dismissedQuestionKey,
        )) {
      setState(() {
        _dismissedQuestionKey = null;
        _pendingQuestion = stillPending;
      });
    }
  }

  /// Whether the Chat lens is available for THIS session: the server advertises
  /// the transcript capability, the session runs a transcript-keeping agent
  /// ([sessionKeepsTranscript] — Claude Code, Codex, or any provider a newer server
  /// adds), and its transcript hasn't 404'd. SINGLE source of truth — drives the lens
  /// default (_recomputeActiveLens), the app-bar toggle's visibility, and the #43
  /// compose-bar guarantee (when Chat is unavailable the compose bar must never be
  /// hidden, or a raw-mode session is stranded with no usable input).
  bool get _chatAvailable =>
      _serverHasTranscript == true &&
      sessionKeepsTranscript(_session) &&
      !_transcriptUnavailableForSession;

  /// Chat is the default lens when eligible (agent session + capability +
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

  // --- #70: read the agent's last answer aloud ------------------------------
  // The SERVER decides what is worth saying (GET /api/sessions/:id/speech strips
  // code blocks, tables, URLs and tool plumbing). This method only fetches that
  // utterance and hands it to the device's TTS — it must never substitute raw
  // transcript text, which is exactly what the filter exists to prevent.
  Future<void> _toggleSpeak(Session session) async {
    if (_speaking) {
      await SpeechService.stop();
      if (mounted) setState(() => _speaking = false);
      return;
    }
    String text;
    try {
      text = await ApiClient(session.server).speech(session.id);
    } on ApiException catch (e) {
      if (!mounted) return;
      // 404 is the ordinary "this session has no transcript" (a plain shell), or
      // a server older than 1.42.0 — not worth alarming language.
      _speakSnack(e.status == 404
          ? 'No transcript for this session'
          : 'Could not read the answer');
      return;
    } catch (_) {
      if (mounted) _speakSnack('Could not read the answer');
      return;
    }
    if (!mounted) return;
    if (text.isEmpty) {
      // Normal outcome: the last turns were tool calls or pure code.
      _speakSnack('Nothing to read aloud yet');
      return;
    }
    final ok = await SpeechService.speak(text);
    if (!mounted) return;
    if (!ok) {
      _speakSnack('Speech is not available on this device');
      return;
    }
    setState(() => _speaking = true);
    _pollSpeaking();
  }

  // Android's TextToSpeech gives no completion callback over this channel, so
  // the stop icon is driven by polling `isSpeaking`. Cheap (a ~700-char
  // utterance is under a minute) and it self-terminates.
  void _pollSpeaking() {
    Future.delayed(const Duration(milliseconds: 700), () async {
      if (!mounted || !_speaking) return;
      if (await SpeechService.speaking()) {
        _pollSpeaking();
      } else if (mounted) {
        setState(() => _speaking = false);
      }
    });
  }

  void _speakSnack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      duration: const Duration(seconds: 2),
    ));
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

    // #59 — state our size IN THE HANDSHAKE. A PTY has ONE size, shared by every
    // viewer, so a connection that never states its own inherits whatever the last
    // viewer set: attaching a phone to a session a desktop is watching rendered
    // desktop-width output, torn, until some unrelated relayout (focusing the compose
    // field → the soft keyboard → a new body height) happened to fire onResize and
    // negotiate the size by accident. The view already knows its size here — the
    // layout that set _lastCols ran while we awaited the scrollback above — so hand
    // it to the connection instead of waiting to be asked.
    final connection = api.openTerminal(
      session.id,
      cols: _lastCols > 0 ? _lastCols : null,
      rows: _lastRows > 0 ? _lastRows : null,
    );
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
          WidgetsBinding.instance.addPostFrameCallback(
            (_) => _scrollToBottom(),
          );
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
    _connection?.sendInput(terminalOutputToPty(data));
  }

  void _onSelectionChanged() {
    // Only the toolbar's visibility depends on this — a plain rebuild is
    // enough, no other state to sync.
    if (mounted) setState(() {});
  }

  /// Copies the current selection to the clipboard (owner priority: fix
  /// broken copy/paste) — invoked by the on-selection toolbar, #49's
  /// right-click/long-press menu, and #52's Ctrl+C / Ctrl+Shift+C shortcut.
  /// The actual clipboard write is [copyTerminalSelection] (the SSOT all
  /// three share); this just adds the "Copied" snackbar on top.
  void _copySelection() {
    final text = copyTerminalSelection(_terminal, _terminalController);
    if (text == null) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)),
    );
  }

  /// The terminal's Ctrl+C / Ctrl+Shift+C handler (#52), wired as
  /// [TerminalView.onKeyEvent] — which `terminal_view.dart` calls BEFORE its
  /// own default shortcuts (Ctrl+Shift+C copy) and before `Terminal.keyInput`
  /// (bare Ctrl+C → SIGINT). Returning [KeyEventResult.handled] here pre-empts
  /// both, so copying never also leaks a `c` or `\x03` to the PTY; returning
  /// `ignored` for a bare Ctrl+C with no selection lets both run normally, so
  /// `\x03` still reaches the PTY exactly as before (#11 must not regress).
  KeyEventResult _handleTerminalCopyShortcut(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyC) {
      return KeyEventResult.ignored;
    }
    final hw = HardwareKeyboard.instance;
    final triggered = terminalCopyShortcutTriggered(
      desktop: isDesktopPlatform(),
      ctrlOrCmdPressed:
          Platform.isMacOS ? hw.isMetaPressed : hw.isControlPressed,
      shiftPressed: hw.isShiftPressed,
      hasSelection: _terminalController.selection != null,
    );
    if (!triggered) return KeyEventResult.ignored;
    _copySelection();
    return KeyEventResult.handled;
  }

  /// Pastes clipboard text into the terminal PTY (#49 context-menu Paste).
  /// Always targets the terminal (unlike [_pasteFromClipboard], which routes to
  /// the compose field outside raw mode) — the user explicitly asked the
  /// terminal to paste. Goes through [Terminal.paste] → `onOutput` →
  /// [terminalOutputToPty], so bracketed-paste markers and the LF→CR carve-out
  /// apply exactly as the toolbar Paste does.
  Future<void> _pasteIntoTerminal() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    _terminal.paste(text);
    _scrollToBottom();
  }

  /// Selects the whole terminal buffer (#49 "Select All"), then rebuilds so the
  /// selection toolbar reflects it.
  void _selectAllTerminal() {
    selectAllOnTerminal(_terminal, _terminalController);
    if (mounted) setState(() {});
  }

  /// Shows the terminal right-click context menu (#49) at [globalPos] with the
  /// clipboard actions valid for the current selection state, then runs the
  /// chosen action. Desktop-only in practice: it is wired to a secondary
  /// (right-button) tap, which touch devices never emit, so touch keeps xterm's
  /// own long-press selection + the on-selection Copy toolbar unchanged.
  Future<void> _showTerminalContextMenu(Offset globalPos) async {
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (overlay == null) return;
    final actions = terminalContextMenuActions(
      hasSelection: _terminalController.selection != null,
    );
    final selected = await showMenu<TerminalMenuAction>(
      context: context,
      position: RelativeRect.fromRect(
        globalPos & const Size(40, 40),
        Offset.zero & overlay.size,
      ),
      items: [
        for (final a in actions)
          PopupMenuItem<TerminalMenuAction>(
            value: a,
            child: Row(
              children: [
                Icon(_terminalMenuIcon(a), size: 18),
                const SizedBox(width: 10),
                Text(_terminalMenuLabel(a)),
              ],
            ),
          ),
      ],
    );
    if (selected == null) return;
    switch (selected) {
      case TerminalMenuAction.copy:
        _copySelection();
      case TerminalMenuAction.paste:
        await _pasteIntoTerminal();
      case TerminalMenuAction.selectAll:
        _selectAllTerminal();
    }
  }

  static IconData _terminalMenuIcon(TerminalMenuAction a) => switch (a) {
    TerminalMenuAction.copy => Icons.copy,
    TerminalMenuAction.paste => Icons.paste,
    TerminalMenuAction.selectAll => Icons.select_all,
  };

  static String _terminalMenuLabel(TerminalMenuAction a) => switch (a) {
    TerminalMenuAction.copy => 'Copy',
    TerminalMenuAction.paste => 'Paste',
    TerminalMenuAction.selectAll => 'Select All',
  };

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
          _ctrlSticky
              ? String.fromCharCode(ch.codeUnitAt(0) & 0x1f)
              : '\x1b$ch',
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
        _liveTabbed = false;
        if (_activeLens != 'terminal') {
          _lensBeforeLive = _activeLens;
          _activeLens = 'terminal';
        }
      }
      if (_composeLive) {
        _streamComposeLive(text);
        // Deleted the whole typed line before sending — leave live mode and hop
        // back. Suppressed once Tab has completed the command: the terminal then
        // holds chars the field never had, and Backspace-on-empty (onBackspace)
        // forwards raw DELs to clear them, so the empty field is NOT the end.
        if (text.isEmpty && !_liveTabbed) {
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
  ///
  /// It streams [composeLiveProjection] of the buffer, not the buffer: the agent's TUI
  /// prompt this mirrors is ONE line, and a newline streamed as `\r` would SUBMIT it. That
  /// is what made Enter fire a '/'-line on mobile (and Ctrl+Enter fire one on desktop)
  /// while both merely insert a newline everywhere else — the lens-dependent Enter that
  /// #55 §1 forbids. `_composeLiveSent` holds the same projection, so the diff stays honest.
  void _streamComposeLive(String val) {
    val = composeLiveProjection(val);
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
    final suffix = val.substring(i);
    _composeLiveSent = val;
    final out = backspaces + suffix;
    if (out.isNotEmpty) {
      _connection?.sendInput(out);
      _scrollToBottom();
    }
  }

  /// Sends the composed buffer as ONE atomic PTY frame (body + submit `\r`
  /// together — see [buildComposeSubmission], the #44 fix). Any staged image
  /// attachments (#29) are pasted first, so Claude has the file paths buffered
  /// before the prompt + submit land. A live '/' line just needs a commit `'\r'`
  /// (its body already streamed char-by-char). An empty buffer with no
  /// attachments still sends a bare `'\r'` — e.g. to dismiss a prompt.
  ///
  /// Guards on a live connection first: if there's no PTY to submit to, the
  /// buffer is kept (not cleared into the void) so the user's text survives to
  /// retry — mirroring the web client's `if (WS not open) return`.
  void _sendCompose() {
    final conn = _connection;
    if (conn == null) return; // no PTY — keep the buffer, don't clear (#44)
    final val = _composeController.text;
    if (_composeLive) {
      conn.sendInput('\r');
      _pushComposeHistory(val);
      _clearComposeInput();
      _scrollToBottom();
      return;
    }
    // Nothing to send (no text, no images) → a bare submit Enter.
    if (val.isEmpty && _attachments.isEmpty) {
      conn.sendInput('\r');
      _scrollToBottom();
      return;
    }
    // #29: paste each staged image's path (bracketed-paste) before the prompt.
    for (final a in _attachments) {
      conn.sendInput(a.reference);
    }
    // Optimistic Chat echo (#31): show the prompt immediately, before Claude's
    // transcript reflects it. Reconciled/deduped in ConversationView. Skipped for
    // an image-only send (empty text) — the echo path ignores empty strings.
    if (val.isNotEmpty) _submittedPrompts.add(val);
    conn.sendInput(buildComposeSubmission(val));
    _pushComposeHistory(val);
    _clearComposeInput();
    _scrollToBottom();
  }

  /// Submit an explicit prompt to the SESSION — the main agent's PTY — via the same
  /// path the compose bar uses (`buildComposeSubmission` → one frame, plus the #31
  /// optimistic echo). The chat subagent sheet calls this so you can type from the
  /// subagent view exactly as the terminal lens lets you while a subagent runs: there
  /// is no channel to a specific subagent, so this reaches the session and the main
  /// agent, like any prompt.
  void sendSessionPrompt(String text) {
    final conn = _connection;
    if (conn == null) return; // no PTY — nothing to submit to
    final val = text.replaceFirst(RegExp(r'[\r\n]+$'), '');
    if (val.trim().isEmpty) return;
    _submittedPrompts.add(val); // optimistic "Queued" echo (#31)
    conn.sendInput(buildComposeSubmission(val));
    _pushComposeHistory(val);
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
    _liveTabbed = false;
    _historyActive = false;
    _composeController.clear();
    // #29: drop any staged image chips too (they were just sent). setState so the
    // chip strip disappears — the controller listener only rebuilds the field.
    if (_attachments.isNotEmpty) {
      _attachments.clear();
      if (mounted) setState(() {});
    }
    _restoreLensAfterLive();
    unawaited(_saveDraft());
  }

  /// Esc from the compose bar sends ESC to the terminal (interrupt / close a
  /// menu). While a live '/' line is up, it also cancels the line client-side —
  /// clearing the field and hopping back to the lens we came from — so the user
  /// can always bail out of the slash menu cleanly (incl. after a Tab completion
  /// left the field and terminal out of length-sync).
  void _composeEscape() {
    _sendRawToTerminal('\x1b');
    if (_composeLive) _clearComposeInput();
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
  /// The SINGLE owner of the Alt+V image-paste shortcut (#51). Registered on
  /// [HardwareKeyboard], it fires for the key regardless of which widget has
  /// focus, so it covers both the terminal and a focused compose field —
  /// ComposeBar deliberately does not also bind Alt+V (two handlers = two
  /// chips). [_pasteClipboardImage] then routes the image to the compose field
  /// or the terminal via [pasteImageIntoCompose].
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

  /// Stages an image as a compose-bar attachment chip (#29): [bytes] is the
  /// thumbnail preview, [path] the server file path delivered to Claude on send.
  void _addComposeAttachment(Uint8List bytes, String path) {
    if (!mounted) return;
    setState(
      () => _attachments.add(_ComposeAttachment(bytes: bytes, path: path)),
    );
    // Make sure the compose bar has focus so the new chip + send are right there.
    _composeFocusNode.requestFocus();
  }

  void _removeComposeAttachment(int index) {
    if (index < 0 || index >= _attachments.length) return;
    setState(() => _attachments.removeAt(index));
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
    // #68: the gallery can attach MANY images in one pick (pickMultiImage); the
    // camera stays a single capture. Each is uploaded + staged independently.
    List<XFile> files;
    try {
      if (source == ImageSource.gallery) {
        files = await ImagePicker().pickMultiImage(imageQuality: 90);
      } else {
        final one =
            await ImagePicker().pickImage(source: source, imageQuality: 90);
        files = one == null ? const <XFile>[] : <XFile>[one];
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not open picker: $e')));
      }
      return;
    }
    if (files.isEmpty) return;
    // Decide the destination ONCE, before the loop: the first
    // _addComposeAttachment steals compose focus, which would otherwise flip
    // pasteImageIntoCompose mid-loop and split a multi-pick across the compose
    // bar and the raw PTY. All images from one pick go to the same place.
    final toCompose = pasteImageIntoCompose(
      activeLens: _activeLens,
      composeFocused: _composeFocusNode.hasFocus,
    );
    var failures = 0;
    for (final file in files) {
      try {
        final bytes = await file.readAsBytes();
        final mime = file.mimeType ?? _mimeFromName(file.name);
        final reference = await ApiClient(
          session.server,
        ).uploadClipboardImage(session.id, bytes, mime: mime);
        // #29: composing in chat → stage as a removable thumbnail chip like
        // Alt+V, not a raw PTY paste. Otherwise (raw terminal) send to the PTY.
        if (toCompose) {
          _addComposeAttachment(
            bytes,
            reference.replaceAll(RegExp('\x1b\\[2(?:00|01)~'), ''),
          );
        } else {
          _connection?.sendInput(reference);
        }
      } catch (_) {
        failures++;
      }
    }
    if (!toCompose && mounted) _scrollToBottom();
    if (failures > 0 && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('$failures of ${files.length} image(s) failed to upload'),
        ),
      );
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
          const SnackBar(
            content: Text('Clipboard image is not a readable image'),
          ),
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
        // #29: composing in chat — stage the image as a removable thumbnail chip
        // (NOT the raw path text). The bare path (bracketed-paste wrapper
        // stripped) is kept for delivery; on send it's pasted to the PTY so
        // Claude reads the file. png.bytes drives the thumbnail preview.
        final path = reference.replaceAll(RegExp('\x1b\\[2(?:00|01)~'), '');
        _addComposeAttachment(png.bytes, path);
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
      return (
        bytes: Uint8List.fromList(img.encodePng(decoded)),
        mime: 'image/png',
      );
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
    // #70: leaving the screen must not leave a voice talking.
    if (_speaking) SpeechService.stop();
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
                    Icon(
                      Icons.search_off,
                      size: 48,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'That session is no longer active.',
                      style: theme.textTheme.bodyLarge,
                    ),
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

    // #74: decide what the header can afford BEFORE building it, so the title
    // keeps its floor instead of absorbing everyone else's shortfall.
    final fit = headerFit(
      width: MediaQuery.of(context).size.width,
      lens: _chatAvailable,
      speak: SpeechService.supported,
      detach: DetachWindow.supported && !widget.standalone,
      serverChip: true,
    );

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
          if (_chatAvailable && fit.lens)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _LensToggle(value: _activeLens, onChanged: _setLens),
            ),
          // #70: read the agent's last answer aloud. Android-only — the desktop
          // build has no TTS handler, so the control is absent rather than
          // present-but-broken.
          if (SpeechService.supported && fit.speak)
            IconButton(
              icon: Icon(_speaking ? Icons.stop_circle_outlined : Icons.volume_up),
              tooltip: _speaking ? 'Stop reading' : 'Read the last answer aloud',
              onPressed: () => _toggleSpeak(session),
            ),
          if (DetachWindow.supported && !widget.standalone && fit.detach)
            IconButton(
              icon: const Icon(Icons.open_in_new),
              tooltip: 'Open in new window',
              onPressed: () => DetachWindow.open(session.server, session.id),
            ),
          if (fit.serverChip)
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
              // #74: the folded-away header controls, driven from the menu.
              if (value == 'lens') {
                _setLens(_activeLens == 'chat' ? 'terminal' : 'chat');
                return;
              }
              if (value == 'speak') {
                _toggleSpeak(session);
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
              // #74: anything the width budget folded away lives here, so a
              // narrow screen loses the CHROME, never the capability.
              if (!fit.serverChip)
                PopupMenuItem(
                  enabled: false,
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.dns_outlined),
                    title: Text(session.server.name),
                    subtitle: const Text('Server'),
                  ),
                ),
              if (_chatAvailable && !fit.lens)
                PopupMenuItem(
                  value: 'lens',
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      _activeLens == 'chat' ? Icons.terminal : Icons.forum_outlined,
                    ),
                    title: Text(
                      _activeLens == 'chat' ? 'Terminal view' : 'Chat view',
                    ),
                  ),
                ),
              if (SpeechService.supported && !fit.speak)
                PopupMenuItem(
                  value: 'speak',
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      _speaking ? Icons.stop_circle_outlined : Icons.volume_up,
                    ),
                    title: Text(
                      _speaking ? 'Stop reading' : 'Read the last answer aloud',
                    ),
                  ),
                ),
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
                      // #49: right-click (desktop) opens a Copy/Paste/Select All
                      // context menu. Secondary-tap only, so it never fires on
                      // touch — xterm keeps its long-press selection there.
                      GestureDetector(
                        onSecondaryTapDown: (d) =>
                            _showTerminalContextMenu(d.globalPosition),
                        child: ColoredBox(
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
                            // The TERMINAL LENS is a live terminal — exactly like
                            // the web client, whose xterm view is never read-only
                            // and forwards every key straight to the PTY
                            // (app.html: term.onData -> sendInput -> ws.send).
                            // Tapping it focuses + raises the keyboard, and typing
                            // (digits, arrows, Enter, Esc) goes to the PTY, so
                            // Claude's TUI menus / question selector can be driven
                            // natively. Previously BOTH flags were bolted to
                            // `_rawMode`, which defaults OFF on phones — so the
                            // terminal was read-only there and a tap did nothing.
                            // Gated on the lens (not `_rawMode`) so the offstage
                            // terminal can never take keys while Chat is showing.
                            // `_rawMode` now only decides whether the terminal
                            // GRABS the keyboard automatically (see _setRawMode /
                            // _setLens); it no longer gates input at all.
                            // Desktop takes raw hardware keys (no IME), so a
                            // typed Enter submits instead of parking (#46); mobile
                            // keeps the IME path for its soft keyboard.
                            hardwareKeyboardOnly: terminalHardwareKeyboardOnly(
                              live: terminalAcceptsInput(_activeLens),
                              desktop: isDesktopPlatform(),
                            ),
                            readOnly: !terminalAcceptsInput(_activeLens),
                            // #26: tap a printed http/https URL to open it in the
                            // system browser (additive — focus/keyboard still run
                            // via the view's own tap-down handler).
                            onTapUp: _onTerminalTapUp,
                            // #52: Ctrl+C copies the selection (else falls through
                            // to the terminal's own SIGINT handling); Ctrl+Shift+C
                            // always copies. Runs before xterm's own shortcuts/key
                            // input — see `_handleTerminalCopyShortcut`.
                            onKeyEvent: _handleTerminalCopyShortcut,
                          ),
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
                    onSubmitToSession: sendSessionPrompt,
                  ),
                // Native overlay for Claude's interactive question (#19), above
                // whichever lens is showing. The key strip below stays usable as
                // a manual fallback.
                if (questionOverlayVisible(
                  _pendingQuestion,
                  _dismissedQuestionKey,
                ))
                  QuestionOverlay(
                    question: _pendingQuestion!,
                    contextText: _questionContext,
                    onSend: _answerQuestion,
                    onKey: _sendRawToTerminal,
                    onDismiss: () => setState(
                      () => _dismissedQuestionKey = questionSignature(
                        _pendingQuestion,
                      ),
                    ),
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
              // #50: when the terminal is the active input target (Terminal lens
              // or a live question overlay), hardware Tab + arrows go straight to
              // the PTY so Claude's TUI (`/status` tabs, menus, questions) is
              // driveable, instead of traversing the app's on-screen buttons.
              terminalActive: terminalIsActiveTarget(
                lensLive: terminalAcceptsInput(_activeLens),
                questionUp: questionOverlayVisible(
                  _pendingQuestion,
                  _dismissedQuestionKey,
                ),
              ),
              // Alt+V image paste is owned solely by `_globalKeyHandler` (#51):
              // it's a HardwareKeyboard handler that fires regardless of focus,
              // so ComposeBar must NOT also bind Alt+V or one paste adds two
              // chips. Routing (compose vs terminal) is decided in
              // `_pasteClipboardImage` via `pasteImageIntoCompose`.
              // #29: staged image thumbnails (bytes) + remove (✕) callback.
              attachments: [for (final a in _attachments) a.bytes],
              onRemoveAttachment: _removeComposeAttachment,
              // Hardware Esc reaches the terminal; hardware arrows (while the
              // compose field is empty) go through the same routing as the
              // on-screen keys — ↑/↓ walk send-history, ←/→ move the caret.
              onEscape: _composeEscape,
              onArrow: _handleKeyStripKeyPress,
              // Tab autocompletes the highlighted slash command — only while a
              // live '/' line is streaming (ComposeBar gates it on isLive). Mark
              // the line Tab-completed so deleting to an empty field doesn't end
              // live mode while the terminal still holds the completed remainder.
              onTab: () {
                _sendRawToTerminal('\t');
                _liveTabbed = true;
              },
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

/// Which header controls stay inline at a given width (#74).
class HeaderFit {
const HeaderFit({
  required this.lens,
  required this.speak,
  required this.detach,
  required this.serverChip,
});

final bool lens;
final bool speak;
final bool detach;
final bool serverChip;

/// True when any control was folded away and the overflow menu must carry it.
bool get anyFolded => !lens || !speak || !detach || !serverChip;
}

/// The title's guaranteed width, in logical pixels — roughly 11-12 characters at
/// the app-bar text style. Below this a session name stops being an identifier.
const double kHeaderTitleFloor = 88;

// Measured intrinsic widths of the header's fixed parts. Approximations on
// purpose: this is a BUDGET, not a layout pass — it decides what to show, and
// Flutter still does the real measuring.
const double _hLeading = 56; // back button
const double _hDot = 18; // status dot + its gap
const double _hOverflow = 48; // the ⋮ menu — never folded, it is the escape hatch
const double _hLens = 96; // segmented Chat|Terminal toggle
const double _hSpeak = 48;
const double _hDetach = 48;
const double _hServerChip = 88; // pill + its 8dp margin

/// The header's width budget (#74) — an EXPLICIT priority rule instead of
/// leftover space.
///
/// `AppBar` lays `actions` out at their intrinsic width FIRST and hands the title
/// whatever remains. Every control ever added therefore stole from the title in
/// silence, until a session name on a phone rendered as `● Lo…` — two characters.
/// The title was the only flexible child, so it absorbed the entire shortfall.
///
/// This inverts the relationship: the title is RESERVED [kHeaderTitleFloor], and
/// controls fold into the overflow menu in a fixed order until it fits. The order
/// is least-essential-first: the server name is context that also shows in the
/// sidebar; the lens toggle folds last because switching lens has no other
/// one-tap path.
///
/// The property that matters is not today's arithmetic but the invariant: adding
/// a control later can only make things fold EARLIER — it can never re-truncate
/// the title. PURE, so that invariant is unit-testable without pumping a screen.
HeaderFit headerFit({
required double width,
required bool lens,
required bool speak,
required bool detach,
required bool serverChip,
}) {
var cLens = lens, cSpeak = speak, cDetach = detach, cChip = serverChip;
double titleSpace() =>
    width -
    _hLeading -
    _hDot -
    _hOverflow -
    (cLens ? _hLens : 0) -
    (cSpeak ? _hSpeak : 0) -
    (cDetach ? _hDetach : 0) -
    (cChip ? _hServerChip : 0);

if (titleSpace() < kHeaderTitleFloor && cChip) cChip = false;
if (titleSpace() < kHeaderTitleFloor && cDetach) cDetach = false;
if (titleSpace() < kHeaderTitleFloor && cSpeak) cSpeak = false;
if (titleSpace() < kHeaderTitleFloor && cLens) cLens = false;

return HeaderFit(
  lens: cLens,
  speak: cSpeak,
  detach: cDetach,
  serverChip: cChip,
);
}

