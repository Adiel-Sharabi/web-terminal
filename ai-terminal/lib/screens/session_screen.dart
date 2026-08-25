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

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart' show XFile, openFiles;
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
import '../services/command_policy.dart';
import '../services/desktop_alert_service.dart';
import '../services/detach_window_service.dart';
import '../services/notification_service.dart';
import '../services/session_repository.dart';
import '../services/speech_service.dart';
import '../theme/app_theme.dart';
import '../util/terminal_write.dart';
import '../theme/status_colors.dart';
import '../util/terminal_links.dart';
import '../widgets/attach_source_sheet.dart';
import '../widgets/compose_bar.dart';
import '../widgets/conversation_view.dart';
import '../widgets/disconnect_hairline.dart';
import '../widgets/format_utils.dart';
import '../widgets/question_overlay.dart';
import '../widgets/session_meta_bar.dart';
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

/// How much scrollback to replay into the terminal on attach, in UTF-16 code
/// units — the unit `GET /api/sessions/:id/scrollback` slices in.
///
/// Sized against the terminal's own 5000-line buffer and the server's 512 KB
/// range cap. Live sessions measure ~110 bytes per line once an agent TUI's
/// escape sequences are counted, so this is roughly 2 400 lines: a real history
/// to scroll through, and still well inside both limits.
const int kScrollbackReplayBytes = 262144;

/// How much older scrollback each background deepening step pulls in (#127).
/// One step, one request, one prepend — small enough that parsing it never
/// blocks the frame for long, large enough that a deep history arrives quickly.
const int kScrollbackDeepenBytes = 262144;

/// Pause between deepening steps, so this stays background work and never
/// competes with live output for the main isolate.
const Duration kScrollbackDeepenGap = Duration(milliseconds: 900);

/// Ceiling on the terminal's line buffer once deepened. Memory is not the
/// binding constraint here (latency is), but unbounded is not a design.
const int kScrollbackMaxLines = 100000;

/// Where the newest [budget] code units of a [total]-length scrollback begin.
///
/// The endpoint pages FORWARD from `offset`, so fetching the tail means asking
/// for `total - budget`. Omitting the offset asks for the oldest bytes instead,
/// which is the whole defect this exists to prevent. Pure, so the arithmetic is
/// pinned without a live session.
int scrollbackTailOffset(int total, int budget) {
  final start = total - budget;
  return start > 0 ? start : 0;
}

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

/// Whether a transcript 404 means this session has NO transcript — or merely none
/// YET. Pure, for the same reason as [sessionKeepsTranscript].
///
/// A brand-new agent session 404s until its first turn writes a conversation, so
/// treating that first miss as final disqualifies the Chat lens for the whole life of
/// the screen — the same "no chat options on a new session" the create-response fix
/// addresses, arrived at one step later (#119).
///
/// Once the server has published a conversation id ([Session.agentSessionId]) the
/// conversation demonstrably exists on disk, so a 404 is a real resolution failure —
/// #117's agent-left-its-spawn-cwd — and falling back to Terminal is right: an empty
/// Chat lens over a live session is the worse of the two wrong answers.
bool noTranscriptIsFinal(Session? session) =>
    !sessionKeepsTranscript(session) || session!.agentSessionId != null;

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

/// The single answer to "which lens should be showing right now" (#130).
///
/// `_activeLens` used to have FOUR independent writers: the user's persisted
/// choice, a recomputation derived from availability, and two transient
/// overrides that pinned Terminal — a live '/' line (whose menu renders in the
/// terminal) and raw mode (direct terminal typing). The recomputation ran on
/// EVERY session update — every poll and every `/ws/notify` frame — and knew
/// nothing about the overrides, so it wrote them straight back out. Start a '/'
/// command in Chat and a few seconds later a routine refresh yanked the view
/// back to Chat mid-keystroke, which is exactly the reported cadence.
///
/// Same family as #111: a decision taken at T undone by a callback at T+Δ that
/// never learned about it. The fix is NOT another guard bolted onto the
/// recomputation — it is making the overrides INPUTS to one resolver instead of
/// competing writes, so there is nothing left to clobber and no write ordering
/// to get wrong.
///
/// Precedence, highest first:
///  1. Chat unavailable → Terminal. There is no other lens to show.
///  2. Either pin → Terminal.
///  3. The user's explicit past choice, else Chat.
///
/// Restoring is a CONSEQUENCE, not a step: when a pin clears, the resolver
/// simply stops answering Terminal and lands on the same lens the old
/// `_lensBeforeLive` snapshot held — without the staleness a snapshot carries.
/// That is why the snapshot field is gone rather than merely guarded.
///
/// The pins are deliberately separate from the state that raised them: an
/// explicit lens toggle CLEARS them (the user has spoken) while `_rawMode`
/// itself stays on, which is what keeps "tap Chat while raw mode is on" working
/// — a hard pin on `_rawMode` would strand the user in Terminal for the life of
/// the session. Pure so the rule has one enforceable, testable home.
String resolveActiveLens({
  required bool chatAvailable,
  required String? persistedLens,
  required bool liveSlashPin,
  required bool rawModePin,
}) {
  if (!chatAvailable) return 'terminal';
  if (liveSlashPin || rawModePin) return 'terminal';
  return persistedLens ?? 'chat';
}

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
/// [forcePaste] wraps a SINGLE-line body in bracketed paste too. Staged
/// attachments (#29/#90) need it: one lone file path has no interior newline,
/// but it must still arrive as a paste — that is what makes Claude treat it as
/// an attached file rather than as typed prose.
/// The inner content of a bracketed paste: paste markers removed so nothing in
/// the body can close the wrapper early, and newlines carried as CR.
///
/// **The strip LOOPS until stable, and that is not belt-and-braces.** One pass
/// is defeated by a body that spells a marker across another one: given
/// `a ESC[2 ESC[200~ 01~ b`, deleting the inner `ESC[200~` leaves `ESC[2` and
/// `01~` adjacent — reconstituting `ESC[201~`, which closes the wrapper early.
/// Everything after it is then typed at the prompt rather than pasted, and a
/// bare CR in that remainder SUBMITS. Same shape as a naive `../` strip being no
/// defence against `....//`.
String _pasteInner(String body) {
  final marker = RegExp('\x1b\\[2(?:00|01)~');
  var safe = body;
  String prev;
  do {
    prev = safe;
    safe = safe.replaceAll(marker, '');
  } while (safe != prev);
  return safe.replaceAll(RegExp(r'\r?\n'), '\r');
}

String buildComposeSubmission(String val, {bool forcePaste = false}) {
  val = val.replaceFirst(RegExp(r'[\r\n]+$'), '');
  if (forcePaste || val.contains('\n')) {
    return '\x1b[200~${_pasteInner(val)}\x1b[201~\r';
  }
  return '$val\r';
}

/// Several file paths delivered to the RAW terminal as ONE bracketed paste, and
/// deliberately with **no** submit CR (#90).
///
/// Two things make this its own function rather than a loop of per-file frames.
/// One frame, because consecutive pastes land in a single PTY read and the agent
/// TUI folds them — a multi-select pick used to deliver only its FIRST image for
/// exactly the reason a multi-file drop did. And no trailing CR, because this
/// destination is the user's own prompt line: they type behind the paths and
/// press Enter themselves, so submitting here would send a half-written message.
String buildPastedPaths(List<String> paths) {
  if (paths.isEmpty) return '';
  return '\x1b[200~${_pasteInner(paths.join('\n'))}\x1b[201~';
}

/// The exact bytes a compose submit puts on the wire, given the staged
/// attachment [paths] and the typed [text] (#90).
///
/// This is the SSOT for "how do an attachment and a prompt share a submit", and
/// it is a named function rather than three lines inside `_sendCompose` because
/// the bug it fixes was invisible to a test of [buildComposeSubmission] alone:
/// the old code sent one bracketed-paste frame PER attachment and then the
/// prompt, and both defects that produced live only in that composition.
///
/// Measured against a real Claude TUI with `scripts/rig/probe-paste-file.js`:
///   * consecutive bracketed pastes arrive in ONE PTY read and the TUI folds
///     them, so with two dropped files only the FIRST path survived ("Only one
///     of the two reached me in the message" — Claude, on the repro);
///   * nothing separated a paste from what followed, so the prompt fused onto
///     the last path: `…1785762257992-report.pdfName both files I attached.` — a
///     path naming no file, glued to a mangled prompt.
///
/// One paste with newline separators fixes both, keeps the single-frame
/// guarantee (#44), and needs no client-side timing — the worker still owns the
/// submit CR.
String buildAttachmentSubmission(List<String> paths, String text) {
  final parts = <String>[
    ...paths,
    if (text.isNotEmpty) text,
  ];
  return buildComposeSubmission(parts.join('\n'), forcePaste: paths.isNotEmpty);
}

/// The exact bytes that commit a LIVE '/'-line carrying staged attachments (#110).
///
/// A '/'-line is the one submit whose text is ALREADY in the agent's prompt — it
/// streamed char by char as the user typed, so the menu could narrow. That is why
/// its commit is normally a bare `'\r'`, and it is exactly why attachments went
/// missing: the commit path returned at that `'\r'` and never reached the paste
/// that [buildAttachmentSubmission] does for every other submit, so the command
/// started a turn on its own and the images were cleared unsent.
///
/// So this sends the paths and NOT the text — re-sending the text would type the
/// command twice. Shape follows the measured #90 rule: ONE bracketed paste,
/// newline-separated, or a multi-file attach delivers only its first path. The
/// leading empty element puts a newline before the first path so it cannot fuse
/// onto the command text — the same fusion #90 measured when a prompt ran into a
/// path (`…report.pdfName both files I attached.`).
///
/// One frame including the CR, like every other compose submit (#44): the WORKER
/// owns the submit timing and splits that trailing CR off (#55), which is what
/// makes it land as Enter rather than as paste content.
String buildLiveAttachmentSubmission(List<String> paths) {
  if (paths.isEmpty) return '\r';
  return buildComposeSubmission(['', ...paths].join('\n'), forcePaste: true);
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

/// #90 — whether a dropped file should be staged with an image thumbnail rather
/// than a named file chip.
///
/// Decided from the EXTENSION, not by decoding: this only chooses how the chip is
/// DRAWN, and a wrong guess costs a generic glyph, never a failed send — the file
/// is uploaded and its path delivered either way. Decoding every drop to find out
/// would make dropping a 2 GB archive expensive for a cosmetic answer.
///
/// Pure/testable, and deliberately separate from `_mimeFromName`, which answers a
/// different question (it assumes the input IS an image and only picks which
/// type), so it can never be used to decide this.
bool droppedFileIsImage(String name) {
  final lower = name.toLowerCase();
  for (final ext in const ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/// What to tell the user after an attach batch (#90/#166), or null when every
/// file landed and there is nothing to say.
///
/// One line rather than a snackbar per category: two stacked snackbars mean the
/// first is unreadable, and a batch can fail both ways at once (a picked video
/// over the limit next to a file the upload lost).
///
/// A reroute is named first and is NOT a failure: the files are on the server,
/// they are simply waiting in the compose bar instead of in the prompt line.
///
/// Size is named separately from failure on purpose. "Could not attach
/// holiday.mp4" sends someone hunting for a fault; "holiday.mp4 is larger than
/// the 50 MB limit" tells them what to do instead.
String? attachBatchMessage({
  required int total,
  required List<String> failures,
  required List<String> tooLarge,
  int rerouted = 0,
}) {
  final limitMb = ApiClient.uploadLimitBytes ~/ (1024 * 1024);
  final parts = <String>[
    if (rerouted == 1)
      'Reconnecting — 1 file staged in the compose bar'
    else if (rerouted > 1)
      'Reconnecting — $rerouted files staged in the compose bar',
    if (failures.length == 1)
      'Could not attach ${failures.first}'
    else if (failures.length > 1)
      'Could not attach ${failures.length} of $total files',
    if (tooLarge.length == 1)
      '${tooLarge.first} is larger than the $limitMb MB limit'
    else if (tooLarge.length > 1)
      '${tooLarge.length} files are larger than the $limitMb MB limit',
  ];
  return parts.isEmpty ? null : parts.join(' — ');
}

/// Adds [staged] to the attachments already persisted in [storedRaw], returning
/// the JSON to write back.
///
/// Existing entries keep their order and their names; an entry whose path is
/// already stored is not added twice (a re-entered screen may have restored it
/// already). Pure, so the arbitration a disposed screen depends on is testable
/// without a screen.
String mergeStagedAttachments(
  String? storedRaw,
  List<Map<String, String>> staged,
) {
  final out = <Map<String, String>>[...decodeStagedAttachments(storedRaw)];
  final seen = {for (final e in out) e['path']};
  for (final e in staged) {
    if (e['path'] == null || e['path']!.isEmpty) continue;
    if (seen.add(e['path'])) out.add(e);
  }
  return jsonEncode(out);
}

/// One file on its way to becoming an attachment, whichever gesture produced it
/// — a desktop drop (#90) or a mobile Files pick (#166).
///
/// It exists so those two gestures share ONE staging path ([_attachFiles]): the
/// upload, the thumbnail-vs-named-chip choice, the single-paste delivery and the
/// failure report are decided in one place, and a picked file is
/// indistinguishable from a dropped one everywhere downstream. Adding a third
/// gesture means adding a factory here, not another copy of that sequence.
///
/// [read] is a callback rather than the bytes themselves so the two gestures can
/// each keep their own way of producing them. It buys no memory on Android,
/// and the comment here used to claim it did: `file_selector_android` returns
/// `XFile.fromData(file.bytes, …)`, so the ENTIRE pick is already resident
/// before this class ever sees it, and `read()` is a re-read of memory. A
/// desktop drop is the lazy one.
class AttachCandidate {
  const AttachCandidate({
    required this.name,
    required this.read,
    required this.length,
  });

  /// A file from the OS document picker (#166). Deliberately reads BYTES and
  /// never touches `XFile.path`: on Android the pick is a `content://` URI with
  /// no filesystem path at all, and even a real one would name a file the agent
  /// cannot open when the session runs on another machine.
  factory AttachCandidate.fromXFile(XFile file) => AttachCandidate(
        name: file.name,
        read: file.readAsBytes,
        length: file.length,
      );

  /// A file dropped onto the session body (#90).
  factory AttachCandidate.fromDropItem(DropItem item) => AttachCandidate(
        name: item.name,
        read: item.readAsBytes,
        length: item.length,
      );

  /// The file's own name — what the chip shows, and what decides whether it is
  /// drawn as a thumbnail (see [droppedFileIsImage]).
  final String name;

  /// Reads the file's contents, on demand.
  final Future<Uint8List> Function() read;

  /// The file's size WITHOUT reading it — a stat on the drop path, a value the
  /// picker already knows on Android. Separate from [read] precisely so the
  /// size limit can be applied to a 10 GB file that must never be read.
  final Future<int> Function() length;
}

/// #83 — whether Ctrl+C (Cmd+C on macOS) should copy the CHAT lens's selection.
///
/// The chat lens had no copy path at all: `_handleTerminalCopyShortcut` is wired
/// to `TerminalView.onKeyEvent`, so it only ever sees keys while the TERMINAL has
/// focus. In the chat lens the compose field normally holds focus on desktop, so
/// a perfectly good selection could be dragged and then not copied — measured on
/// the real Windows build, where a mid-drag capture showed the highlight while
/// Ctrl+C left the clipboard untouched.
///
/// Narrow on purpose, because Ctrl+C is overloaded:
///  * only in the chat lens — in the terminal lens the key must still reach the
///    PTY as SIGINT (#11/#52), and stealing it would break interrupting;
///  * only with a chat selection — otherwise the key falls through unchanged;
///  * never while the compose field owns a real selection, so copying the text
///    you just highlighted in your own prompt keeps working.
///
/// Pure/testable: every input is passed in rather than read from
/// `HardwareKeyboard`/`Platform` here.
bool chatCopyShortcutTriggered({
  required bool chatLens,
  required bool ctrlOrCmdPressed,
  required bool hasChatSelection,
  required bool composeHasSelection,
}) {
  if (!chatLens || !ctrlOrCmdPressed) return false;
  return hasChatSelection && !composeHasSelection;
}

/// Rebuilds the staged attachments persisted across a session switch (#113),
/// as `{path, name}` pairs — the caller turns them into chips.
///
/// Thumbnail-less by construction: only the SERVER path is stored (see
/// `_saveAttachments`), because the path is what actually gets delivered and the
/// bytes are a preview the server already owns.
///
/// A blank name falls back to the path's basename. That matters rather than
/// being tidy-up: a clipboard paste is staged with NO name at all (only dropped
/// files carry one), so without this every restored paste would be an unlabelled
/// chip — visible, but naming nothing.
///
/// Anything unusable is dropped rather than restored as a broken chip: a chip
/// with no path would be sent to the agent as an empty reference. Pure, so the
/// round-trip and every malformed shape are unit-testable.
List<Map<String, String>> decodeStagedAttachments(String? raw) {
  if (raw == null || raw.isEmpty) return const [];
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! List) return const [];
    final out = <Map<String, String>>[];
    for (final e in decoded) {
      if (e is! Map) continue;
      final path = (e['path'] ?? '').toString();
      if (path.isEmpty) continue;
      var name = (e['name'] ?? '').toString();
      if (name.isEmpty) name = path.split(RegExp(r'[\\/]')).last;
      out.add({'path': path, 'name': name});
    }
    return out;
  } catch (_) {
    return const []; // corrupt cache — the draft restore treats this the same way
  }
}

/// A staged compose-bar image attachment (#29): the thumbnail [bytes] shown in
/// the removable chip, and the server [path] delivered to Claude on submit.
class _ComposeAttachment {
  const _ComposeAttachment({required this.path, this.bytes, this.name = ''});

  /// Thumbnail bytes for an image; null for a dropped non-image (#90), which
  /// shows a named chip instead.
  final Uint8List? bytes;

  /// Display name for a non-image attachment (the dropped file's basename).
  final String name;

  /// The server-side path delivered to the agent on submit. Wrapping it for the
  /// PTY is NOT this class's job: every staged path and the prompt share ONE
  /// bracketed paste built by [buildComposeSubmission] (#90), so a per-attachment
  /// `reference` getter would be a second place that knows the escape sequence —
  /// and it was exactly one paste per attachment that lost the files.
  final String path;
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

/// #79 — a pending question whose overlay has been DISMISSED, so nothing else on
/// screen shows it. This is the complement of [questionOverlayVisible]: exactly
/// one of the two is true while a question is pending, neither when none is.
///
/// Why a status colour cannot do this job: an AskUserQuestion leaves the session
/// `working`, emits no output and no hooks while it waits, and so stale-corrects
/// to `idle` (GREEN) after 5 minutes with the answer still owed — the same
/// stale-correction family fixed for `waiting`. A green session that is in fact
/// blocked on the user is exactly what "looks like it just went quiet" is. So the
/// signal must come from the pending question itself, not the dot.
bool pendingQuestionChipVisible(PendingQuestion? pending, String? dismissedKey) =>
    pending != null && !questionOverlayVisible(pending, dismissedKey);

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
  /// #74: ctx% derived from the transcript by the chat lens, lifted up so the
  /// meta bar can show it in either lens. Notifier, not setState, so publishing
  /// it never rebuilds the whole screen.
  final ValueNotifier<int?> _derivedCtx = ValueNotifier<int?>(null);

  /// #83 — the chat lens's current selected text ('' when nothing is selected),
  /// published upward by [ConversationView] so Ctrl+C can copy it from here.
  final ValueNotifier<String> _chatSelection = ValueNotifier<String>('');

  /// #90 — a file drag is hovering the session; drives the "Drop to attach"
  /// overlay so the gesture has a target the user can see before releasing.
  bool _dragOver = false;
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

  // #127 — the background scrollback deepening. `_sbEarliest` is the byte offset
  // where the currently-loaded window starts; 0 means the very beginning of the
  // buffer has been reached and there is nothing older to fetch.
  int _sbEarliest = 0;
  bool _sbExhausted = false;
  bool _deepening = false;
  Timer? _deepenTimer;

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
  // The two transient pins that hold the Terminal lens (#130). Inputs to
  // resolveActiveLens — never written to _activeLens directly, or a later
  // recomputation clobbers them. Kept separate from _composeLive/_rawMode
  // because an explicit lens toggle clears the pin while the state itself
  // stays on.
  bool _lensPinLiveSlash = false;
  // #131 — the live '/' line as last streamed, so the policy can be asked what
  // THIS command will leave behind. Kept in a field because _clearComposeInput
  // empties the controller before the pin decision is made.
  String _liveCommandText = '';
  bool _lensPinRawMode = false;
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
    _loadCommandPolicy();
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
    final staged = decodeStagedAttachments(
      prefs.getString('wt_attach_${widget.sessionId}'),
    );
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
    // #113 — the chips come back with the draft. Restored only when nothing is
    // staged already: a paste can land between this async prefs read and here,
    // and clobbering it would lose the newer attachment to restore an older one.
    if (staged.isNotEmpty && _attachments.isEmpty) {
      _attachments.addAll([
        for (final s in staged)
          _ComposeAttachment(path: s['path']!, name: s['name']!),
      ]);
    }
    setState(() => _rawMode = rawMode);
    if (_rawMode) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _terminalViewKey.currentState?.requestKeyboard();
      });
    }
    _recomputeActiveLens();
  }

  /// Loads the per-command lens policy once per app run (#131). Best-effort and
  /// deliberately un-awaited: the client's own fallback table already covers the
  /// built-ins, so a slow or old server delays nothing and breaks nothing.
  void _loadCommandPolicy() {
    final session = _session;
    if (session == null) return;
    unawaited(
      CommandPolicy.instance.ensureLoaded(ApiClient(session.server)),
    );
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
  /// #79 — re-open a dismissed-but-still-pending question. Clearing the dismissal
  /// key makes questionOverlayVisible true again (the question is unchanged), so
  /// the native overlay comes back. Invoked from the "A question is waiting" chip.
  void _reopenQuestion() {
    if (_pendingQuestion == null) return;
    setState(() => _dismissedQuestionKey = null);
  }

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
  /// The ONE place `_activeLens` is written (#130). Every state change that can
  /// affect the lens — availability, an explicit choice, a pin going up or down
  /// — mutates its own input and then calls this. Safe to call at any time,
  /// including from the per-update path, because the pins are inputs now.
  void _recomputeActiveLens() {
    final desired = resolveActiveLens(
      chatAvailable: _chatAvailable,
      persistedLens: _persistedLens,
      liveSlashPin: _lensPinLiveSlash,
      rawModePin: _lensPinRawMode,
    );
    if (desired != _activeLens && mounted) {
      setState(() => _activeLens = desired);
    }
  }

  Future<void> _setLens(String value) async {
    if (value == _activeLens) return;
    setState(() {
      _persistedLens = value;
      // An explicit choice outranks both pins: the user is looking at the app
      // and asked for this lens. Clearing them (rather than letting the resolver
      // lose to a pin) is what keeps "tap Chat while raw mode is on" working.
      _lensPinLiveSlash = false;
      _lensPinRawMode = false;
    });
    // Through the resolver like every other lens change, so _recomputeActiveLens
    // stays the ONLY writer of _activeLens. With the pins cleared and the choice
    // persisted it answers `value` — the toggle is only offered when Chat is
    // available, which is the one input that could disagree.
    _recomputeActiveLens();
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
    // "Not yet" is not "never" — leave a young agent session on Chat with its empty
    // state, which its own refresh fills in as soon as the first turn lands.
    if (!noTranscriptIsFinal(_session)) return;
    setState(() => _transcriptUnavailableForSession = true);
    // Chat just became unavailable, which the resolver reads via _chatAvailable
    // — no direct write, so this cannot fight the per-update recomputation.
    _recomputeActiveLens();
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

    // A reconnect replays from scratch, so any deepening still queued against
    // the OLD window would prepend history that no longer lines up with it.
    _deepenTimer?.cancel();
    _terminal.buffer.clear();
    _terminal.buffer.setCursor(0, 0);
    try {
      // Ask for the NEWEST slice, not the first 5000 bytes.
      //
      // `limit` is BYTES and `offset` defaults to 0, so `limit: 5000` fetched the
      // OLDEST 5 KB — the very start of the session — and threw the rest away.
      // Measured against live sessions: 5 KB of a 1,950,432-byte scrollback is
      // 99.7% discarded, and because an agent TUI's bytes are mostly escape
      // sequences it amounted to ~45 NEWLINES. That is about one desktop
      // viewport, so `maxScrollExtent` was ~0 and the terminal could not be
      // scrolled up AT ALL (reported 2026-08-16). One cheap probe for `total`,
      // then the tail.
      final head = await api.scrollback(session.id, limit: 1);
      if (!mounted) return;
      final replayFrom = scrollbackTailOffset(head.total, kScrollbackReplayBytes);
      final chunk = await api.scrollback(
        session.id,
        offset: replayFrom,
        limit: kScrollbackReplayBytes,
      );
      if (!mounted) return;
      // #127 — remember where the loaded window starts, so the background
      // deepening below knows what "older" means.
      _sbEarliest = chunk.offset;
      _sbExhausted = chunk.offset <= 0;
      if (chunk.data.isNotEmpty) {
        // #81: guarded — xterm 4.0.0 throws on a real Codex stream, and an
        // unguarded throw here kills the lens outright (blank terminal).
        safeTerminalWrite(_terminal, chunk.data);
        // Land on the newest line, not the top of the replayed scrollback.
        _jumpToBottomSoon();
      }
    } catch (_) {
      // best effort — live output still arrives once the socket connects
    }
    if (!mounted) return;
    // #127 — from here the history deepens on its own, behind the live view.
    _scheduleDeepen();

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
    // #81: guarded. This is the LIVE path and the one that actually broke — a throw
    // inside a stream listener takes the widget subtree down, so a single bad frame
    // blanked the terminal for the rest of the session.
    _outputSub =
        connection.output.listen((data) => safeTerminalWrite(_terminal, data));
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
      // #147 — do not ENTER live mode while the agent is still booting.
      //
      // The first cut of this gated `_streamComposeLive` instead, and that
      // reintroduced the exact loss #147 exists to prevent: live mode was still
      // entered, nothing was ever streamed to the PTY, and `_sendCompose`'s live
      // branch assumes the body already went — so pressing Send delivered a bare
      // CR and the command silently vanished. Caught in re-review of PR #150.
      //
      // Refusing entry keeps the text a NORMAL draft: submit stays blocked until
      // ready, and then Send delivers the whole line through
      // buildComposeSubmission. The only thing lost is the live slash MENU
      // during boot, and the next keystroke after ready re-enters live mode.
      if (!_composeLive &&
          (_session?.agentReady ?? true) &&
          slashStartsLiveStream(text)) {
        _composeLive = true;
        _composeLiveSent = '';
        _liveTabbed = false;
        _lensPinLiveSlash = true;
        _liveCommandText = text;
        _recomputeActiveLens();
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
    // #147 — this path writes bytes AS YOU TYPE, so a `/co` typed in the first
    // seconds would land on bash's command line and the worker would then type
    // `claude --resume ...` onto that same line, running `/coclaude --resume ...`
    // and starting no agent at all. It is guarded at the ONE place live mode is
    // entered (see onChanged), not here: a second gate in a second place is how
    // the two come to disagree, and gating here alone was measured to lose the
    // whole command on Send.
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
    _liveCommandText = val; // #131 — '/st' becomes '/status' as it is typed
    final out = backspaces + suffix;
    if (out.isNotEmpty) {
      _connection?.sendInput(out);
      _scrollToBottom();
    }
  }

  /// Sends the composed buffer as ONE atomic PTY frame (body + submit `\r`
  /// together — see [buildComposeSubmission], the #44 fix). Any staged
  /// attachments (#29/#90) share that single frame: every path and then the
  /// prompt, one per line, inside ONE bracketed paste — see
  /// [buildAttachmentSubmission] for why a paste per attachment lost files.
  /// A live '/' line just needs a commit `'\r'`
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
      // #110 — the text is already in the prompt, but any staged attachments are
      // NOT: they only ever travelled in the paste this branch used to skip.
      if (val.isNotEmpty) _submittedPrompts.add(val);
      conn.sendInput(buildLiveAttachmentSubmission(
        [for (final a in _attachments) a.path],
      ));
      _pushComposeHistory(val);
      // #131 — sent, so a TUI-only command keeps the Terminal lens it needs.
      _clearComposeInput(sent: true);
      _scrollToBottom();
      return;
    }
    // Nothing to send (no text, no images) → a bare submit Enter.
    if (val.isEmpty && _attachments.isEmpty) {
      conn.sendInput('\r');
      _scrollToBottom();
      return;
    }
    // Optimistic Chat echo (#31): show the prompt immediately, before Claude's
    // transcript reflects it. Reconciled/deduped in ConversationView. Skipped for
    // an image-only send (empty text) — the echo path ignores empty strings.
    if (val.isNotEmpty) _submittedPrompts.add(val);
    // #29/#90: every staged path AND the prompt travel in ONE bracketed paste.
    // The byte rule lives in buildAttachmentSubmission — see its doc for the two
    // measured defects that one-frame-per-attachment produced.
    conn.sendInput(buildAttachmentSubmission(
      [for (final a in _attachments) a.path],
      val,
    ));
    _pushComposeHistory(val);
    _clearComposeInput();
    // #131 — an ordinary prompt means the user is done reading whatever TUI
    // output held them in the terminal, and its reply belongs in Chat.
    _releaseCommandPin();
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

  void _clearComposeInput({bool sent = false}) {
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
    _restoreLensAfterLive(sent: sent);
    unawaited(_saveDraft());
    // Must follow the clear above, unconditionally: if the persisted copy
    // outlived the send, the next visit would re-stage images the agent has
    // already been given and quietly attach them twice (#113).
    unawaited(_saveAttachments());
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

  /// After a live '/' command ends (sent, deleted to empty, or Esc), drop the
  /// pin — so running /compact from Chat returns to Chat, not the terminal the
  /// menu rendered in. No-op for lines that never went live: the pin was never
  /// raised, and the resolver was already answering the un-pinned lens.
  ///
  /// #130: this used to restore a `_lensBeforeLive` SNAPSHOT taken when the line
  /// went live. Dropping the pin and recomputing is the same answer without the
  /// staleness — if the user toggled lenses during the command, the snapshot
  /// would have overwritten their newer choice with the older one.
  /// #131 — [sent] distinguishes a command that RAN from one that was cancelled,
  /// and only a command that ran can have a result worth staying for.
  ///
  /// A command whose entire result is TUI paint (`/status`, `/usage` — measured:
  /// their transcript record is a `local_command` line reading "Settings dialog
  /// dismissed", and nothing else) has nothing waiting in Chat, so hopping back
  /// would land the user on an invocation with no answer. That is the reported
  /// bug, and it is why the pin outlives the send for those. It is dropped by the
  /// next ordinary prompt or an explicit lens toggle — both of which mean "I am
  /// done reading this".
  ///
  /// Cancelling (delete-to-empty, Esc) always unpins: nothing ran, so there is
  /// nothing to read.
  void _restoreLensAfterLive({bool sent = false}) {
    if (!_lensPinLiveSlash) return;
    if (sent && CommandPolicy.instance.pinsTerminal(_liveCommandText)) return;
    _lensPinLiveSlash = false;
    _liveCommandText = '';
    _recomputeActiveLens();
  }

  /// Tab has completed the command IN THE TERMINAL, so the terminal takes the
  /// line from here (#131).
  ///
  /// THE DIVERGENCE THIS ENDS. The live '/' stream is one-way — compose bar to
  /// terminal — so anything the TUI does to its own line is invisible to the
  /// field. Tab is the case that makes that unavoidable: Claude completes `/co`
  /// to `/compact` in the terminal while the field still holds `/co`. The old
  /// code knew ("the terminal then holds chars the field never had") and worked
  /// AROUND it, forwarding raw DELs on backspace and suppressing the
  /// delete-to-empty exit. Those workarounds exist because two inputs were
  /// showing two different lines.
  ///
  /// Handing the line over removes the second line instead of managing it. The
  /// client stops tracking a buffer it can no longer predict — so nothing can go
  /// stale — and the user types the rest where the true text already is. That is
  /// the acceptance bullet: after Tab, what you see in the input you are typing
  /// into IS what will be submitted.
  ///
  /// DESKTOP ONLY, and that is not a style choice. The terminal is only a usable
  /// typing surface where there is a hardware keyboard: on touch, xterm has no
  /// IME/soft-keyboard path, which is exactly why the compose bar exists and why
  /// #43 makes "there is always a usable input" an invariant. Handing the line to
  /// an unusable surface would strand a phone mid-command. Mobile therefore keeps
  /// the one-way mirroring and its workarounds. #55 draws this same line: the
  /// LAYOUT question is answered by available size, but the INPUT-SURFACE
  /// question is genuinely a platform one.
  ///
  /// The lens pin deliberately survives — the command is still being typed, in
  /// the terminal, and the user must stay there to finish it.
  void _handOverLineToTerminal() {
    if (!isDesktopPlatform() || !_composeLive) return;
    setState(() {
      _composeLive = false;
      _composeLiveSent = '';
      _liveTabbed = false;
    });
    _settingComposeProgrammatically = true;
    _composeController.clear();
    _composeFocusNode.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _terminalViewKey.currentState?.requestKeyboard();
    });
    unawaited(_saveDraft());
  }

  /// The user submitted an ordinary prompt, so whatever TUI output they were kept
  /// in the terminal to read (#131) has been read. Releases a pin that outlived
  /// its command; a no-op otherwise.
  void _releaseCommandPin() {
    if (!_lensPinLiveSlash) return;
    _lensPinLiveSlash = false;
    _liveCommandText = '';
    _recomputeActiveLens();
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
  /// [cell] carries an absolute buffer-line index; the line is rebuilt here,
  /// one character per CELL, so the tapped column maps to the right character.
  /// `getText()` cannot serve this even after #151 — it emits nothing for the
  /// second half of a wide glyph and stops at the last written column, both of
  /// which shift every index after them. A tap that ends a drag-selection is
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
    // #83: Ctrl+C copies the chat lens's selection. It lives HERE, with Alt+V,
    // rather than on a focus-scoped handler precisely because the compose field
    // normally holds focus in the chat lens — a focus-scoped shortcut is the
    // reason there was no copy path in the first place.
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.keyC &&
        chatCopyShortcutTriggered(
          chatLens: _activeLens == 'chat',
          ctrlOrCmdPressed: HardwareKeyboard.instance.isControlPressed ||
              HardwareKeyboard.instance.isMetaPressed,
          hasChatSelection: _chatSelection.value.isNotEmpty,
          composeHasSelection: !_composeController.selection.isCollapsed,
        )) {
      Clipboard.setData(ClipboardData(text: _chatSelection.value));
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
    unawaited(_saveAttachments()); // #113
    // Make sure the compose bar has focus so the new chip + send are right there.
    _composeFocusNode.requestFocus();
  }

  /// #90 — stage every dropped file as a compose attachment.
  ///
  /// A drop always stages, never types: the gesture lands on the session body,
  /// not on the agent's prompt line, so there is no destination to choose.
  Future<void> _attachDroppedFiles(List<DropItem> files) => _attachFiles(
        [for (final f in files) AttachCandidate.fromDropItem(f)],
        toCompose: true,
      );

  /// Uploads a batch of files and stages them — the ONE path a dropped file
  /// (#90) and a picked file (#166) both take.
  ///
  /// Each file's BYTES are uploaded and the SERVER's path is what gets staged;
  /// the originating device's own path is never sent, because for a remote
  /// cluster session it names a file the agent cannot open — and would silently
  /// name the wrong file if a same-named one existed there. On submit every
  /// staged path and the prompt share ONE bracketed paste (see
  /// [buildAttachmentSubmission]), so there is no second submit path to keep in
  /// step (#51/#87) — and no run of consecutive pastes for the TUI to fold,
  /// which is what used to swallow all but the first dropped file.
  ///
  /// [toCompose] is the caller's decision, and it is made ONCE before anything
  /// is uploaded: the first staged chip steals compose focus, so re-reading the
  /// destination per file would split a single multi-file batch between the
  /// compose bar and the raw PTY — the same trap the image pick already hoists
  /// out of its loop.
  Future<void> _attachFiles(
    List<AttachCandidate> files, {
    required bool toCompose,
  }) async {
    final session = _session;
    if (session == null || files.isEmpty) return;
    final failures = <String>[];
    final tooLarge = <String>[];
    // Name AND path: the socket can vanish after the uploads succeed, and what
    // happens next has to name exactly the files it happened to — not the whole
    // batch, which would re-blame an already-counted failure and speak for one
    // that was refused on size and never attempted.
    final raw = <({String name, String path})>[];
    final stagedNow = <_ComposeAttachment>[];
    var rerouted = 0;
    for (final file in files) {
      try {
        // The SIZE first, from a stat rather than from the bytes. Reading first
        // and measuring after cannot guard the case that matters most: a 10 GB
        // ISO dropped on the desktop dies inside `read()` long before any check.
        // (On Android there is nothing left to save by then either way —
        // `file_selector_android` has already materialised the whole pick.)
        if (await file.length() > ApiClient.uploadLimitBytes) {
          // Named apart from a failure because "could not attach holiday.mp4"
          // sends someone hunting for a fault that is really a limit — and on a
          // phone the alternative is minutes of mobile data spent to earn a 413.
          tooLarge.add(file.name);
          continue;
        }
        final bytes = await file.read();
        if (bytes.isEmpty) {
          // A folder drop reads as empty rather than failing, and a pick can
          // name a genuinely empty file (a just-rotated log). Either way the
          // server rejects an empty body with 400, so report it here rather
          // than staging a chip that would deliver nothing.
          failures.add(file.name);
          continue;
        }
        final path = await ApiClient(
          session.server,
        ).uploadDroppedFile(bytes, filename: file.name);
        if (toCompose) {
          final staged = _ComposeAttachment(
            path: path,
            // Thumbnail only for an image; everything else gets a named chip.
            bytes: droppedFileIsImage(file.name) ? bytes : null,
            name: file.name,
          );
          // Unmounting mid-batch must not cost the files already uploaded, so
          // this neither returns nor skips: it stages either way and only the
          // repaint is conditional. `_saveAttachments` below needs no widget
          // (SharedPreferences keyed on the session id), so a batch that
          // finishes after the screen is gone still comes back with it (#113).
          stagedNow.add(staged);
          if (mounted) {
            setState(() => _attachments.add(staged));
          } else {
            _attachments.add(staged);
          }
        } else {
          raw.add((name: file.name, path: path));
        }
      } catch (_) {
        failures.add(file.name);
      }
    }
    if (toCompose) {
      // #113 — once, after the whole batch. MERGED when the screen is already
      // gone: re-entering the session mounts a new State that has restored its
      // own list, and a plain write from this dead one would overwrite it —
      // resurrecting chips removed over there, or dropping ones staged there.
      // Merging adds exactly the files this batch uploaded and arbitrates
      // nothing else.
      unawaited(mounted ? _saveAttachments() : _persistStagedAfterDispose(stagedNow));
      // Focus the compose bar once, after the loop — the chips and Send are there.
      if (mounted) _composeFocusNode.requestFocus();
    } else if (raw.isNotEmpty) {
      final connection = _connection;
      if (connection != null) {
        // ONE frame for the whole batch, not one per file: consecutive pastes
        // land in a single PTY read and the TUI folds them, so a multi-file pick
        // would deliver only its first path (#90). No submit CR — this is the
        // user's own prompt line and they press Enter themselves. Sent even if
        // the screen is gone: the bytes were asked for and the PTY still wants
        // them; only the UI needs a live widget.
        connection.sendInput(buildPastedPaths([for (final r in raw) r.path]));
        if (mounted) _scrollToBottom();
      } else {
        // NOT a failure, and reporting one would be a lie — every byte is on the
        // server. This branch fires ROUTINELY on the gesture #166 adds: the SAF
        // picker takes the activity to `AppLifecycleState.paused`, which closes
        // the socket, and the reattach on resume fetches scrollback over HTTP
        // before the socket is back, so a quick pick outruns it. Stage the
        // finished paths instead, where they sit one tap from being sent.
        //
        // Named chips even for an image: those bytes went out of scope with the
        // loop iteration that uploaded them, and holding a whole batch of
        // full-size photos in memory to draw a thumbnail on a reconnect path is
        // the wrong trade — the same decode cost the chip's cacheWidth avoids.
        for (final r in raw) {
          _attachments.add(_ComposeAttachment(path: r.path, name: r.name));
        }
        rerouted = raw.length;
        unawaited(mounted
            ? _saveAttachments()
            : _persistStagedAfterDispose([
                for (final r in raw)
                  _ComposeAttachment(path: r.path, name: r.name),
              ]));
        if (mounted) {
          setState(() {});
          _composeFocusNode.requestFocus();
        }
      }
    }
    if (!mounted) return;
    final message = attachBatchMessage(
      total: files.length,
      failures: failures,
      tooLarge: tooLarge,
      rerouted: rerouted,
    );
    if (message != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  /// #90 — wraps the session body so a file dropped anywhere on it attaches.
  ///
  /// Desktop only: drag-and-drop has no phone equivalent, and `DropTarget` would
  /// simply never fire there. The whole body is the target rather than the compose
  /// bar alone — on a tall window the bar is a thin strip at the bottom, and
  /// "aim at the 40px strip" is a worse gesture than the one it replaces.
  Widget _withFileDrop(Widget child) {
    if (!isDesktopPlatform()) return child;
    return DropTarget(
      onDragEntered: (_) => setState(() => _dragOver = true),
      onDragExited: (_) => setState(() => _dragOver = false),
      onDragDone: (detail) {
        setState(() => _dragOver = false);
        unawaited(_attachDroppedFiles(detail.files));
      },
      child: Stack(
        children: [
          child,
          if (_dragOver)
            Positioned.fill(
              child: IgnorePointer(
                child: Container(
                  color: AppColors.background.withValues(alpha: 0.72),
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 22,
                        vertical: 18,
                      ),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.surfaceContainerHigh,
                        borderRadius: BorderRadius.circular(AppShape.large),
                        border: Border.all(
                          color: Theme.of(context).colorScheme.primary,
                          width: 2,
                        ),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.file_download_outlined,
                            size: 30,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Drop to attach',
                            key: const Key('drop-to-attach'),
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  void _removeComposeAttachment(int index) {
    if (index < 0 || index >= _attachments.length) return;
    setState(() => _attachments.removeAt(index));
    unawaited(_saveAttachments()); // #113 — a removed chip must stay removed
  }

  Future<AttachSource?> _chooseAttachSource() {
    return showModalBottomSheet<AttachSource>(
      context: context,
      showDragHandle: true,
      builder: (context) => AttachSourceSheet(
        sources: attachSourcesFor(desktop: isDesktopPlatform()),
      ),
    );
  }

  /// The attach button: pick a source, then take that source's route (#166).
  ///
  /// Camera and Gallery go to `image_picker` and the image upload; Files goes to
  /// the OS document picker and the SAME staging a desktop drop uses. The fork
  /// is here and nowhere else, so neither route can grow its own idea of what an
  /// attachment is.
  Future<void> _pickAndAttach() async {
    // Before the sheet, not after the picker: with no session there is nowhere
    // to put an attachment, and letting someone browse their files first and
    // then dropping the whole pick in silence is the worse of the two.
    if (_session == null) return;
    final source = await _chooseAttachSource();
    if (source == null || !mounted) return;
    if (source == AttachSource.files) return _pickAndAttachFiles();
    await _pickAndSendImage(
      source == AttachSource.camera ? ImageSource.camera : ImageSource.gallery,
    );
  }

  /// #166 — the Files source: the OS document picker, staged exactly like a
  /// dropped file.
  ///
  /// No file type is filtered: the point of the issue is the PDF, the log and
  /// the archive that `image_picker` cannot see. The picked bytes are what
  /// travels — never the picked path — because Android hands back a `content://`
  /// URI rather than a filesystem path, and even a real path would name a file
  /// the agent cannot open when the session lives on another machine.
  Future<void> _pickAndAttachFiles() async {
    List<XFile> picked;
    try {
      picked = await openFiles();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not open picker: $e')),
        );
      }
      return;
    }
    if (picked.isEmpty || !mounted) return;
    await _attachFiles(
      [for (final f in picked) AttachCandidate.fromXFile(f)],
      // Decided ONCE, before the first upload — see [_attachFiles].
      toCompose: pasteImageIntoCompose(
        activeLens: _activeLens,
        composeFocused: _composeFocusNode.hasFocus,
      ),
    );
  }

  /// Picks an image and uploads it via `ApiClient.uploadClipboardImage`, which
  /// returns the exact (already bracketed-paste-wrapped) string the server
  /// expects fed straight into the PTY — sent directly, bypassing
  /// [Terminal.paste] to avoid double-wrapping it.
  Future<void> _pickAndSendImage(ImageSource source) async {
    final session = _session;
    if (session == null) return;
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
    final rawPaths = <String>[];
    for (final file in files) {
      try {
        final bytes = await file.readAsBytes();
        final mime = file.mimeType ?? _mimeFromName(file.name);
        final reference = await ApiClient(
          session.server,
        ).uploadClipboardImage(session.id, bytes, mime: mime);
        final path = reference.replaceAll(RegExp('\x1b\\[2(?:00|01)~'), '');
        // #29: composing in chat → stage as a removable thumbnail chip like
        // Alt+V, not a raw PTY paste. Otherwise (raw terminal) collect the path
        // and deliver the whole pick as ONE paste below.
        if (toCompose) {
          _addComposeAttachment(bytes, path);
        } else {
          rawPaths.add(path);
        }
      } catch (_) {
        failures++;
      }
    }
    // #90: one frame for the whole pick, NOT one per file. Sending a paste per
    // image here was the same defect the compose path had — consecutive pastes
    // arrive in one PTY read and the TUI folds them, so a multi-select pick
    // delivered only its FIRST image. No submit CR: this is the user's own
    // prompt line and they press Enter themselves.
    if (rawPaths.isNotEmpty) {
      _connection?.sendInput(buildPastedPaths(rawPaths));
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

  /// Queues the next background deepening step (#127).
  void _scheduleDeepen() {
    _deepenTimer?.cancel();
    if (_sbExhausted || !mounted) return;
    _deepenTimer = Timer(kScrollbackDeepenGap, _deepenOnce);
  }

  /// Pulls the PREVIOUS slice of scrollback and prepends it to the live buffer.
  ///
  /// The point of doing it this way — rather than fetching on scroll-to-top and
  /// rebuilding — is that nothing already on screen is re-parsed or re-rendered,
  /// so there is no flicker, no loading affordance and nothing to wait for. The
  /// reader is not moved: prepending only adds height ABOVE the viewport, so the
  /// correction is exactly the growth in `maxScrollExtent`, which needs no line
  /// height and no guesswork.
  ///
  /// The older text is parsed in a SCRATCH terminal at the same column width
  /// (different width would re-wrap it), and that scratch is then dropped on the
  /// floor: `prependAll` re-owns the lines, and a line reachable from two buffers
  /// is #81's defect exactly.
  Future<void> _deepenOnce() async {
    final session = _session;
    final api = _api;
    if (!mounted || _deepening || _sbExhausted || session == null || api == null) {
      return;
    }
    if (_sbEarliest <= 0) {
      _sbExhausted = true;
      return;
    }
    if (_terminal.buffer.lines.length >= kScrollbackMaxLines) {
      _sbExhausted = true;
      return;
    }
    _deepening = true;
    try {
      final start = scrollbackTailOffset(_sbEarliest, kScrollbackDeepenBytes);
      final chunk = await api.scrollback(
        session.id,
        offset: start,
        limit: _sbEarliest - start,
      );
      if (!mounted) return;
      _sbEarliest = chunk.offset;
      if (chunk.offset <= 0) _sbExhausted = true;
      if (chunk.data.isEmpty) return;

      final scratch = Terminal(maxLines: kScrollbackMaxLines);
      scratch.resize(_lastCols > 0 ? _lastCols : 80, _lastRows > 1 ? _lastRows : 24);
      safeTerminalWrite(scratch, chunk.data);

      final harvested = <BufferLine>[];
      for (var i = 0; i < scratch.buffer.lines.length; i++) {
        harvested.add(scratch.buffer.lines[i]);
      }
      // The scratch terminal's own viewport contributes trailing blanks; they
      // would show up as a gap between the older text and what is already here.
      while (harvested.isNotEmpty &&
          harvested.last.getText().trim().isEmpty) {
        harvested.removeLast();
      }
      if (harvested.isEmpty) return;

      final hadClients = _scrollController.hasClients;
      final beforeExtent =
          hadClients ? _scrollController.position.maxScrollExtent : 0.0;
      final beforePixels = hadClients ? _scrollController.position.pixels : 0.0;

      _terminal.buffer.lines.prependAll(harvested);
      _terminal.notifyListeners(); // raw buffer surgery does not notify on its own

      if (hadClients) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !_scrollController.hasClients) return;
          final grew =
              _scrollController.position.maxScrollExtent - beforeExtent;
          if (grew <= 0) return;
          _scrollController.jumpTo((beforePixels + grew)
              .clamp(0.0, _scrollController.position.maxScrollExtent));
        });
      }
    } catch (_) {
      // Best effort: a failed step just means the history stays as deep as it
      // already is. Stop rather than hammer a server that is refusing.
      _sbExhausted = true;
    } finally {
      _deepening = false;
      _scheduleDeepen();
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
      // while the Chat lens is showing. Pin Terminal so the user can see it.
      // A pin, not a write to _activeLens (#130): the write was undone by the
      // next poll's recomputation, which put raw typing back out of sight.
      // Not persisted as a lens preference, and an explicit toggle clears it.
      _lensPinRawMode = value;
    });
    _recomputeActiveLens();
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

  /// Persists the STAGED ATTACHMENTS beside the draft text (#113).
  ///
  /// The draft survived a session switch and the chips did not, which is the
  /// worst of the two states: the prompt comes back looking complete while the
  /// images it refers to are silently gone.
  ///
  /// Only `path` and `name` are stored — never [_ComposeAttachment.bytes]. The
  /// bytes are a THUMBNAIL; the upload already happened and the server owns the
  /// file (#90 uploads precisely so a local and a peer session behave alike), so
  /// the path is the thing that must survive. Writing image bytes into
  /// SharedPreferences would duplicate what the server already holds and put
  /// megabytes into a store meant for settings.
  ///
  /// The cost is honest and bounded: a restored image has no thumbnail and shows
  /// as a NAMED chip — the same rendering a dropped non-image already uses (#90),
  /// so no new widget state exists for it. Nothing can be re-fetched instead: no
  /// endpoint serves `clipboard-images/` or `dropped-files/` back, and adding one
  /// would mean a server release and a new file-serving surface for a thumbnail.
  /// Persists [staged] when this screen is already disposed, by MERGING into
  /// whatever is stored now rather than overwriting it.
  ///
  /// The disposed State's own `_attachments` is not the truth any more: the user
  /// may have re-entered the session, and that new screen has restored and
  /// possibly edited the same key. Only the paths this batch actually uploaded
  /// are added, so nothing removed over there comes back.
  Future<void> _persistStagedAfterDispose(
    List<_ComposeAttachment> staged,
  ) async {
    if (staged.isEmpty) return;
    final prefs = await SharedPreferences.getInstance();
    final key = 'wt_attach_${widget.sessionId}';
    final merged = mergeStagedAttachments(
      prefs.getString(key),
      [for (final a in staged) {'path': a.path, 'name': a.name}],
    );
    await prefs.setString(key, merged);
  }

  Future<void> _saveAttachments() async {
    final prefs = await SharedPreferences.getInstance();
    final key = 'wt_attach_${widget.sessionId}';
    if (_attachments.isEmpty) {
      await prefs.remove(key);
      return;
    }
    await prefs.setString(
      key,
      jsonEncode([
        for (final a in _attachments) {'path': a.path, 'name': a.name},
      ]),
    );
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
    _derivedCtx.dispose();
    _chatSelection.dispose();
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
    _deepenTimer?.cancel();
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

    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: !widget.embedded && !widget.standalone,
        // #74: the app bar carries the session's IDENTITY and nothing else. Every
        // session-level control moved to the meta bar below, because `actions`
        // are laid out at their intrinsic width first and the title takes the
        // leftover — so any control here silently steals from the name. The
        // title is Expanded, not Flexible-inside-a-min-Row, so it claims the
        // whole bar rather than only what a shrink-wrapped Row asked for.
        titleSpacing: 0,
        title: Row(
          children: [
            const SizedBox(width: 4),
            StatusDot(status: status),
            const SizedBox(width: 8),
            Expanded(child: Text(displayName, overflow: TextOverflow.ellipsis)),
          ],
        ),
        actions: [
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
      // #90: the whole session body is a file drop target on desktop.
      //
      // #108 — the question overlay wraps the WHOLE body, not the lens.
      //
      // It used to be a child of the lens `Stack` below, so its Positioned.fill
      // filled only the lens: the meta bar above and the compose bar + key strip
      // below (~104px of permanent chrome) were outside its box the entire time
      // a question was up. Measured on a 412x915 phone at the real mount, that
      // left a 206px option viewport showing exactly ONE row with the second cut
      // through its description — the reported screenshot.
      //
      // Covering that chrome is not a side effect, it is the point: while a
      // question is up neither the compose bar nor the key strip is the way to
      // answer it — this card is — and dismissing restores both. The one thing
      // genuinely lost is the strip's tappable Esc, which now sits in the card's
      // own fallback row (see _footer).
      body: _withFileDrop(Stack(children: [
        Column(
        children: [
          // #74: the session's meta bar — cwd + usage badges on the flexible
          // side, session controls on the right. These controls used to sit in
          // the app bar, where they crowded the title out of existence; here the
          // thing that yields is the cwd, which can shrink harmlessly. It also
          // renders in BOTH lenses, so a terminal session finally shows its cwd
          // and ctx% (it never did while these lived inside the chat lens).
          ValueListenableBuilder<int?>(
            valueListenable: _derivedCtx,
            builder: (context, derived, _) => SessionMetaBar(
              session: session,
              derivedCtx: derived,
              controls: [
                if (_chatAvailable)
                  _LensToggle(value: _activeLens, onChanged: _setLens),
                // #70: read the agent's last answer aloud. Android-only — the
                // desktop build has no TTS handler, so the control is absent
                // rather than present-but-broken.
                if (SpeechService.supported)
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 36, minHeight: 32),
                    padding: EdgeInsets.zero,
                    icon: Icon(
                      _speaking ? Icons.stop_circle_outlined : Icons.volume_up,
                      size: 20,
                    ),
                    tooltip: _speaking
                        ? 'Stop reading'
                        : 'Read the last answer aloud',
                    onPressed: () => _toggleSpeak(session),
                  ),
                if (DetachWindow.supported && !widget.standalone)
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 36, minHeight: 32),
                    padding: EdgeInsets.zero,
                    icon: const Icon(Icons.open_in_new, size: 20),
                    tooltip: 'Open in new window',
                    onPressed: () =>
                        DetachWindow.open(session.server, session.id),
                  ),
                MetaServerBadge(name: session.server.name),
              ],
            ),
          ),
          // No modal — a thin static hairline (debounced ~3s so a blip that
          // self-heals never flashes anything; static because a disconnect is
          // unbounded and an animation here never stops — see
          // [DisconnectHairline]), optionally with a muted
          // "updated Ns ago" note. A separate, precise "Opened elsewhere"
          // notice (below) fires only when the server actually said so
          // (`connection.sessionTaken`), never from prolonged failure alone.
          if (_showDisconnectBanner) ...[
            const DisconnectHairline(),
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
          // #79: a question is pending but its overlay was dismissed. Without
          // this the session can sit idle/green with an unanswered question and
          // the chat lens shows nothing — the reported "looks like it went
          // quiet". Shown in both lenses (the question is pending regardless of
          // which one is up); tapping re-opens the native overlay. Driven off
          // the pending question, never the status colour — see
          // pendingQuestionChipVisible.
          if (pendingQuestionChipVisible(_pendingQuestion, _dismissedQuestionKey))
            _AttentionBanner(
              color: StatusColor.waiting,
              icon: Icons.help_outline,
              text: 'A question is waiting — tap to answer',
              onTap: _reopenQuestion,
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
                    // #74: only this lens can derive ctx% from the transcript;
                    // the meta bar renders it for both lenses.
                    derivedCtxSink: _derivedCtx,
                    // #83: lets Ctrl+C above copy what is selected here.
                    selectionSink: _chatSelection,
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
              // #147 — a session whose agent is still booting accepts typing but
              // refuses to SEND: the PTY is still at the shell, so a submit now
              // is handed to bash and the prompt is lost with no error. Read
              // straight off the server-published field; `?? true` covers the
              // moment before the session object has loaded, where refusing
              // would be a bar that never sends on a session that is fine.
              agentReady: _session?.agentReady ?? true,
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
              attachments: [
                for (final a in _attachments)
                  ComposeAttachment(name: a.name, bytes: a.bytes),
              ],
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
                _handOverLineToTerminal();
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
              onImage: _pickAndAttach,
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
        // Native overlay for Claude's interactive question (#19), above the
        // whole body — see the note on `body:` for why it is mounted here and
        // not inside the lens Stack.
        if (questionOverlayVisible(_pendingQuestion, _dismissedQuestionKey))
          QuestionOverlay(
            question: _pendingQuestion!,
            contextText: _questionContext,
            onSend: _answerQuestion,
            onKey: _sendRawToTerminal,
            onDismiss: () => setState(
              () => _dismissedQuestionKey = questionSignature(_pendingQuestion),
            ),
          ),
      ])),
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

