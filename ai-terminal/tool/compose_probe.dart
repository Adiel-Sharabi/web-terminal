// COMPOSE PROBE — a real-platform harness for the compose Enter model.
//
// Why this exists: widget tests (and integration_test) inject SYNTHETIC key events
// straight into Flutter's shortcut system. They never touch the real Windows/Android
// text input — which is the thing that was actually swallowing Enter and inserting
// newlines. Every one of those tests passed while the real app was broken.
//
// This hosts the REAL ComposeBar (same widget the app ships) and records, to a log
// file, exactly what it does when a REAL OS keystroke arrives:
//   FIELD  <escaped controller text>     — after every change (catches a stray \n)
//   SEND   <escaped submit payload>      — buildComposeSubmission(text), the bytes
//                                          that would actually hit the PTY
// Drive it with real keys (Windows: SendKeys; Android: `adb shell input`) and read
// the log — no guessing about what the platform did.
//
//   flutter run -t tool/compose_probe.dart -d windows
//   flutter run -t tool/compose_probe.dart -d emulator-5554
//
// Log: %TEMP%\compose-probe.log (Windows) / app documents dir (Android), and the
// path is printed on screen.

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:ai_terminal/screens/session_screen.dart' show buildComposeSubmission;
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';

void main() => runApp(const _ProbeApp());

/// Make control characters visible: `\r`, `\n`, ESC.
String esc(String s) => s
    .replaceAll('\x1b', '<ESC>')
    .replaceAll('\r', '<CR>')
    .replaceAll('\n', '<LF>');

class _ProbeApp extends StatelessWidget {
  const _ProbeApp();
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'compose probe',
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
  final _controller = TextEditingController();
  final _focus = FocusNode();
  final _lines = <String>[];
  late final File _log;

  @override
  void initState() {
    super.initState();
    final dir = Platform.isWindows
        ? (Platform.environment['TEMP'] ?? Directory.systemTemp.path)
        : '/data/local/tmp';
    _log = File('$dir${Platform.pathSeparator}compose-probe.log');
    try {
      _log.writeAsStringSync(''); // truncate on each run
    } catch (_) {}
    _emit('READY platform=${defaultTargetPlatform.name} log=${_log.path}');
    _controller.addListener(() => _emit('FIELD "${esc(_controller.text)}"'));
    // Ground truth: what does the ENGINE actually deliver? A shortcut that "should"
    // match may simply never see the modifier it expects.
    HardwareKeyboard.instance.addHandler(_logKey);
    // Focus the field so OS keystrokes land in it without a click.
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  /// Never consumes anything — pure observation of the raw key stream.
  bool _logKey(KeyEvent e) {
    if (e is KeyDownEvent) {
      final k = HardwareKeyboard.instance;
      // NB: logicalKey.debugName is null in a release build — use keyLabel/keyId.
      final label = e.logicalKey.keyLabel.isEmpty
          ? '0x${e.logicalKey.keyId.toRadixString(16)}'
          : e.logicalKey.keyLabel;
      _emit('KEY   $label'
          ' ctrl=${k.isControlPressed}'
          ' shift=${k.isShiftPressed}'
          ' alt=${k.isAltPressed}'
          ' char=${e.character == null ? "null" : '"${esc(e.character!)}"'}');
    }
    return false;
  }

  void _emit(String line) {
    // ignore: avoid_print
    print('[probe] $line');
    try {
      _log.writeAsStringSync('$line\n', mode: FileMode.append, flush: true);
    } catch (_) {}
    if (mounted) setState(() => _lines.insert(0, line));
  }

  void _onSend() {
    // Exactly what SessionScreen sends to the PTY for this buffer.
    _emit('SEND  "${esc(buildComposeSubmission(_controller.text))}"');
    _controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('compose probe — ${defaultTargetPlatform.name}')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: SelectableText(
              'log: ${_log.path}',
              style: const TextStyle(fontSize: 11),
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: ListView.builder(
              reverse: true,
              itemCount: _lines.length,
              itemBuilder: (_, i) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                child: Text(
                  _lines[i],
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                ),
              ),
            ),
          ),
          const Divider(height: 1),
          // The REAL widget under test.
          ComposeBar(
            controller: _controller,
            focusNode: _focus,
            onSend: _onSend,
            isLive: false,
          ),
        ],
      ),
    );
  }
}
