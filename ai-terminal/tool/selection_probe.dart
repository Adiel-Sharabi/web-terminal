// SELECTION PROBE — a real-platform harness for chat-lens mouse selection (#83).
//
// Why this exists: issue #83 ruled out eight hypotheses, every one of them with a
// WIDGET TEST — and every one of them passed. That is precisely the condition
// CLAUDE.md warns about for the input contract: synthetic pointer events are
// injected straight into Flutter's gesture arena and never traverse the real
// Windows pointer path, so the test is green while the shipped app is broken.
//
// This hosts the REAL rendering stack the chat lens uses (SelectionArea over a
// ListView of MarkdownBody(selectable: false), the exact ExtensionSet and flags
// from conversation_view.dart) and records, to a log file, what actually happens
// when a REAL OS mouse drag arrives:
//
//   MODE   <variant>                  — which tree is mounted
//   PTR    <phase> <x>,<y> <kind>     — every pointer event that reached the app
//   SEL    <escaped selected text>    — every selection change (null => cleared)
//
// The PTR lines are not decoration: without them "no selection" is ambiguous
// between "the app refused to select" and "the driver never delivered a click",
// and the whole run would prove nothing.
//
//   SELPROBE_MODE=markdown flutter run -t tool/selection_probe.dart -d windows
//
// Build:  scripts/build-selection-probe-windows.sh
// Drive:  scripts/rig/probe-drive-selection.ps1
// Log:    %TEMP%\selection-probe.log  (path also shown on screen)

import 'dart:io';

import 'package:flutter/material.dart';
// SelectedContent lives in rendering/, and material.dart does not re-export it.
import 'package:flutter/rendering.dart' show SelectedContent;
import 'package:markdown/markdown.dart' as md;
import 'package:flutter_markdown/flutter_markdown.dart';

import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart'
    show chatCopyShortcutTriggered;
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/conversation_view.dart';

/// The exact markdown from the #83 report, pulled from the real transcript. Bold
/// + inline code containing a Windows path — NOT a link (the issue proves the
/// parser emits no `<a>` for it), which is why it should be selectable.
const String kReportedMarkdown =
    '**`C:\\Users\\yourname\\Downloads\\query-plan.sql`** — open in '
    'Notepad++ now.';

const List<String> kFillerLines = <String>[
  'The first paragraph of an agent answer, plain prose that should select.',
  'A second line so a drag can cross a line boundary within one bubble.',
  kReportedMarkdown,
  'A trailing paragraph after the reported inline-code span.',
];

/// Mode `code`: nothing BUT the reported span, so any drag through the
/// transcript area is guaranteed to cross inline code. The mixed list above let
/// a drag skim past it and "select" ordinary prose instead — which would have
/// cleared the reported case without ever testing it.
const List<String> kCodeOnlyLines = <String>[
  kReportedMarkdown,
  kReportedMarkdown,
  kReportedMarkdown,
  kReportedMarkdown,
  kReportedMarkdown,
  kReportedMarkdown,
];

void main() => runApp(const _ProbeApp());

String esc(String s) =>
    s.replaceAll('\r', '<CR>').replaceAll('\n', '<LF>').replaceAll('\t', '<TAB>');

class _ProbeApp extends StatelessWidget {
  const _ProbeApp();
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'selection probe',
        theme: AppTheme.dark,
        debugShowCheckedModeBanner: false,
        home: const _Probe(),
      );
}

class _Probe extends StatefulWidget {
  const _Probe();
  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  late final File _log;
  final List<String> _lines = <String>[];
  String _selected = '';
  int _ptrCount = 0;

  /// `text` (baseline Text), `markdown` (the chat lens's real MarkdownBody), or
  /// `bubble` (markdown inside the same Card/constraints a turn bubble uses).
  late final String _mode =
      (Platform.environment['SELPROBE_MODE'] ?? 'markdown').trim();

  @override
  void initState() {
    super.initState();
    final dir = Platform.environment['TEMP'] ?? Directory.systemTemp.path;
    _log = File('$dir${Platform.pathSeparator}selection-probe.log');
    try {
      _log.writeAsStringSync('');
    } catch (_) {}
    _write('MODE   $_mode');
    if (_mode == 'terminal') _initTerminal();
    HardwareKeyboard.instance.addHandler(_copyKeyHandler);
    _selection.addListener(() => _write(
        'SINK   ${_selection.value.isEmpty ? '<empty>' : esc(_selection.value)}'));
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_copyKeyHandler);
    _selection.dispose();
    super.dispose();
  }

  void _write(String line) {
    try {
      _log.writeAsStringSync('$line\n', mode: FileMode.append);
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _lines.add(line);
      if (_lines.length > 24) _lines.removeAt(0);
    });
  }

  int _churn = 0;

  /// Mirrors SessionScreen's `_chatSelection`.
  final ValueNotifier<String> _selection = ValueNotifier<String>('');

  /// Mirrors SessionScreen's `_globalKeyHandler` Ctrl+C branch, calling the REAL
  /// `chatCopyShortcutTriggered` so the shipped rule is what gets exercised.
  bool _copyKeyHandler(KeyEvent event) {
    if (event is! KeyDownEvent) return false;
    // Log every key down: "nothing copied" is otherwise ambiguous between the
    // keystroke never arriving and the rule declining it.
    _write('KEY    ${event.logicalKey.keyLabel} '
        'ctrl=${HardwareKeyboard.instance.isControlPressed} '
        'sel=${_selection.value.length}');
    if (event.logicalKey != LogicalKeyboardKey.keyC) return false;
    if (!chatCopyShortcutTriggered(
      chatLens: true,
      ctrlOrCmdPressed: HardwareKeyboard.instance.isControlPressed ||
          HardwareKeyboard.instance.isMetaPressed,
      hasChatSelection: _selection.value.isNotEmpty,
      composeHasSelection: false,
    )) {
      return false;
    }
    Clipboard.setData(ClipboardData(text: _selection.value));
    _write('COPY   ${esc(_selection.value)}');
    return true;
  }

  /// Modes that mount their own SelectionArea (the real widget, or m3 which
  /// deliberately replicates the real nesting) must not be wrapped in a second.
  /// `terminal` is excluded for a different reason: xterm owns selection through
  /// its own TerminalController, and a SelectionArea above it would compete for
  /// the drag and make the result meaningless.
  bool get _ownsSelection =>
      _mode != 'real' && _mode != 'churn' && _mode != 'm3' && _mode != 'terminal';

  // ---- #81: the TERMINAL lens, fed a REAL Codex byte stream ----------------
  //
  // The issue is that a Codex session's terminal cannot be selected. A widget test
  // already shows a drag through this nesting selects, and a PTY capture already
  // shows Codex sets no mouse reporting and no alternate buffer — but both use
  // synthetic pointers. This mode closes the last gap: the real Windows build, the
  // real xterm widget, real bytes captured off a real codex TUI, and a real OS
  // drag driven by SendInput.
  Terminal? _term;
  TerminalController? _termCtl;

  void _initTerminal() {
    final t = Terminal(maxLines: 5000);
    final c = TerminalController();
    // Bytes captured off a real `codex` PTY (probe-dec-modes.js). Falls back to
    // synthetic lines so the probe still runs if the capture is missing — the
    // MODE line records which, because a fallback run proves much less.
    final capture = Platform.environment['SELPROBE_CAPTURE'] ?? '';
    var loaded = false;
    String payload = '';
    if (capture.isNotEmpty) {
      try {
        payload = String.fromCharCodes(File(capture).readAsBytesSync());
        loaded = true;
      } catch (_) {
        loaded = false;
      }
    }
    if (!loaded) {
      payload = List.generate(
        20,
        (i) => 'codex line $i — selectable text for the drag probe\r\n',
      ).join();
    }
    // FED AFTER THE FIRST FRAME, and that is not a style choice. Writing into a
    // Terminal whose TerminalView has not been laid out yet CRASHES xterm 4.0.0:
    // Buffer.index() -> CircularBuffer.insert -> _moveChild -> IndexedItem._move,
    // which dereferences `_owner!` on a line the buffer has already detached. The
    // guarding assert is compiled out of a release build, so it surfaces as
    // "Null check operator used on a null value" and takes the whole widget tree
    // with it — a grey window, which looks exactly like "the terminal renders
    // nothing" if you are not reading stdout.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      try {
        t.write(payload);
        _write('TERM   fed ${payload.length}B after layout — '
            'capture=${loaded ? "real codex PTY" : "synthetic"} '
            'mouseMode=${t.mouseMode} alt=${t.isUsingAltBuffer}');
      } catch (e) {
        _write('TERM   WRITE THREW: $e');
      }
    });
    // The readback. Without it "no selection" cannot be told from "the driver
    // never delivered a click" — the same ambiguity that made me report #83
    // reproduced twice when it was not.
    c.addListener(() {
      final sel = c.selection;
      if (sel == null) {
        _write('SEL    (null)');
      } else {
        _write('SEL    ${esc(t.buffer.getText(sel))}');
      }
    });
    _term = t;
    _termCtl = c;
  }

  /// Mirrors session_screen.dart's terminal-lens nesting exactly.
  Widget _terminalLens() => Stack(
        children: [
          Offstage(
            offstage: false,
            child: Stack(
              children: [
                GestureDetector(
                  onSecondaryTapDown: (_) {},
                  child: ColoredBox(
                    color: const Color(0xFF000000),
                    child: TerminalView(
                      _term!,
                      controller: _termCtl!,
                      scrollController: ScrollController(),
                      theme: TerminalThemes.defaultTheme,
                      textStyle: const TerminalStyle(
                        fontSize: 13,
                        fontFamily: 'monospace',
                      ),
                      autofocus: false,
                      readOnly: false,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      );

  /// A stand-in for `_TurnBubble`'s wrapper chain (it is private to
  /// conversation_view.dart): Align > ConstrainedBox > Container > Column, with
  /// the same role tag above the markdown.
  Widget _fakeBubble(String line) => Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: double.infinity),
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 16),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white10,
              borderRadius: BorderRadius.circular(12),
              border: const Border(
                left: BorderSide(color: Colors.tealAccent, width: 3),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('Assistant', style: TextStyle(fontSize: 11)),
                const SizedBox(height: 6),
                _markdown(line),
              ],
            ),
          ),
        ),
      );

  static const Session _cannedSession = Session(
    id: 'probe-session',
    name: 'probe',
    cwd: r'C:\dev\web-terminal',
    status: 'idle',
    claudeSessionId: null,
    lastActivity: null,
    notifyLevel: 'important',
    server: ServerConfig(
      name: 'probe',
      baseUrl: 'http://127.0.0.1:1',
      bearerToken: '',
    ),
    agent: 'claude',
  );

  static final List<TranscriptTurn> _cannedTurns = <TranscriptTurn>[
    for (final line in kCodeOnlyLines)
      TranscriptTurn(role: 'assistant', text: line, toolUses: const [], ts: null),
  ];

  void _onSelection(SelectedContent? content) {
    final text = content?.plainText ?? '';
    _selected = text;
    _write('SEL    ${text.isEmpty ? '<empty>' : esc(text)}');
  }

  Widget _body() {
    switch (_mode) {
      case 'terminal':
        return _terminalLens();
      case 'text':
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final line in kFillerLines)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text(line, style: const TextStyle(fontSize: 15)),
              ),
          ],
        );
      case 'bubble':
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final line in kFillerLines)
              Align(
                alignment: Alignment.centerLeft,
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  padding: const EdgeInsets.all(10),
                  constraints: const BoxConstraints(maxWidth: 620),
                  decoration: BoxDecoration(
                    color: Colors.white10,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: _markdown(line),
                ),
              ),
          ],
        );
      // The REAL widget the app ships, fed canned turns. Its SelectionArea is
      // internal, so there is no onSelectionChanged to hook -- readback here is
      // the driver's Ctrl+C + clipboard read (which also exercises the copy path
      // #83 says is missing).
      case 'real':
        return ConversationView(
          session: _cannedSession,
          // #83: the production wiring — the lens publishes its selection and the
          // screen above owns the shortcut. Reproduced here (with the REAL
          // predicate, see _copyKeyHandler) because a widget test cannot prove a
          // clipboard write triggered by a genuine OS keystroke.
          selectionSink: _selection,
          fetchPage: (String id, {String? before, int? limit}) async =>
              TranscriptPage(
            messages: _cannedTurns,
            cursor: null,
            hasMore: false,
          ),
        );
      // The real widget PLUS the thing a widget test never does: a live session
      // whose transcript keeps changing, so the 4s poll commits new turns and
      // animates the list to the bottom WHILE the drag is in flight.
      case 'churn':
        return ConversationView(
          session: _cannedSession,
          fetchPage: (String id, {String? before, int? limit}) async {
            _churn++;
            return TranscriptPage(
              messages: [
                ..._cannedTurns,
                for (var i = 0; i < _churn; i++)
                  TranscriptTurn(
                    role: 'assistant',
                    text: 'Streaming follow-up turn #$i arriving mid-drag.',
                    toolUses: const [],
                    ts: null,
                  ),
              ],
              cursor: null,
              hasMore: false,
            );
          },
        );
      // --- bisection ladder between `code` (selects) and `real` (does not) ---
      // m1: the only change is ListView -> ListView.builder.
      case 'm1':
        return ListView.builder(
          padding: const EdgeInsets.all(16),
          itemCount: kCodeOnlyLines.length,
          itemBuilder: (_, i) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: _markdown(kCodeOnlyLines[i]),
          ),
        );
      // m2: m1 plus _TurnBubble's wrapper chain (Align > ConstrainedBox >
      // Container > Column), which is the next layer the real widget adds.
      case 'm2':
        return ListView.builder(
          padding: const EdgeInsets.all(16),
          itemCount: kCodeOnlyLines.length,
          itemBuilder: (_, i) => _fakeBubble(kCodeOnlyLines[i]),
        );
      // m3: m2 in the real widget's exact nesting -- Column > Expanded > Stack >
      // SelectionArea > ListView.builder. The SelectionArea sits INSIDE the Stack
      // here (not wrapping the whole body), because that ordering is precisely
      // what is being tested; hence m3 owns its own region.
      case 'm3':
        return Column(
          children: [
            Expanded(
              child: Stack(
                children: [
                  SelectionArea(
                    onSelectionChanged: _onSelection,
                    child: ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: kCodeOnlyLines.length,
                      itemBuilder: (_, i) => _fakeBubble(kCodeOnlyLines[i]),
                    ),
                  ),
                ],
              ),
            ),
          ],
        );
      case 'code':
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final line in kCodeOnlyLines)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: _markdown(line),
              ),
          ],
        );
      default:
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final line in kFillerLines)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: _markdown(line),
              ),
          ],
        );
    }
  }

  /// Byte-for-byte the chat lens's configuration (conversation_view.dart:1475).
  Widget _markdown(String data) => MarkdownBody(
        data: data,
        selectable: false,
        fitContent: true,
        extensionSet: md.ExtensionSet.gitHubWeb,
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          Container(
            width: double.infinity,
            color: Colors.blueGrey.shade900,
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('SELECTION PROBE — mode=$_mode  pointers=$_ptrCount',
                    style: const TextStyle(
                        fontWeight: FontWeight.bold, fontSize: 14)),
                Text('log: ${_log.path}',
                    style: const TextStyle(fontSize: 11, color: Colors.white70)),
                Text(
                  'selected: ${_selected.isEmpty ? "(nothing)" : esc(_selected)}',
                  maxLines: 2,
                  style: const TextStyle(fontSize: 12, color: Colors.amber),
                ),
              ],
            ),
          ),
          Expanded(
            // Raw pointer tap — proves the OS delivered the event at all, and is
            // deliberately OUTSIDE the SelectionArea so it can never compete with
            // the selection gesture (Listener does not join the arena).
            child: Listener(
              behavior: HitTestBehavior.translucent,
              onPointerDown: (e) {
                _ptrCount++;
                _write('PTR    down ${e.position.dx.toStringAsFixed(0)},'
                    '${e.position.dy.toStringAsFixed(0)} ${e.kind.name}'
                    ' buttons=${e.buttons}');
              },
              onPointerUp: (e) => _write('PTR    up   '
                  '${e.position.dx.toStringAsFixed(0)},'
                  '${e.position.dy.toStringAsFixed(0)} ${e.kind.name}'),
              // `real`/`churn` mount ConversationView, which owns its OWN
              // SelectionArea. Wrapping it in a second one would nest selection
              // regions and change the exact thing under test, so those modes get
              // the widget bare and are read back via Ctrl+C instead.
              child: _ownsSelection
                  ? SelectionArea(
                      onSelectionChanged: _onSelection,
                      child: _body(),
                    )
                  : _body(),
            ),
          ),
          Container(
            height: 190,
            width: double.infinity,
            color: Colors.black,
            padding: const EdgeInsets.all(8),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final l in _lines)
                    Text(l,
                        style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 11,
                            color: Colors.greenAccent)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
