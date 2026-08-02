// #81 — the guard around `Terminal.write`, and the real fix behind it.
//
// TWO LAYERS, and they are not redundant:
//
//   1. The vendored xterm patch (third_party/xterm, `WEB-TERMINAL PATCH (#81)`)
//      fixes the CAUSE: Buffer.scrollUp/scrollDown/deleteLines aliased a line into
//      two slots, which detached it and later threw. Pinned in
//      xterm_codex_stream_test.dart.
//   2. `safeTerminalWrite` is defence-in-depth. It buys nothing for #81 any more —
//      the stream no longer throws — but a write that throws is fed straight from a
//      WebSocket listener, so an unknown future defect would again take down the
//      whole widget subtree rather than dropping one frame.
//
// So this file asserts the CURRENT truth: the real Codex stream is written cleanly,
// with zero drops, and the buffer it produces is fully selectable.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/util/terminal_write.dart';

File? _capture() {
  for (final p in <String>[
    Platform.environment['CODEX_CAPTURE'] ?? '',
    'test/fixtures/codex-pty-capture.bin',
  ]) {
    if (p.isEmpty) continue;
    final f = File(p);
    if (f.existsSync()) return f;
  }
  return null;
}

Terminal _sized() {
  final t = Terminal(maxLines: 5000);
  t.resize(120, 30); // what TerminalView does on layout
  return t;
}

void main() {
  setUp(resetTerminalWriteFailures);

  test('an ordinary write lands and is not counted as a failure', () {
    final t = _sized();
    expect(safeTerminalWrite(t, 'hello world\r\n'), isTrue);
    expect(terminalWriteFailures, 0);
    expect(t.buffer.lines[0].getText(), contains('hello world'));
  });

  test('the real Codex stream is written with ZERO dropped frames', () {
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    final t = _sized();

    // Chunked exactly as the WebSocket delivers it — the shipped path.
    var ok = 0;
    var dropped = 0;
    for (var i = 0; i < data.length; i += 512) {
      final chunk = data.substring(i, (i + 512).clamp(0, data.length));
      if (safeTerminalWrite(t, chunk)) {
        ok++;
      } else {
        dropped++;
      }
    }

    // Before the vendored patch this dropped frames from byte 4381 onwards.
    expect(dropped, 0, reason: 'the xterm patch must make every frame land');
    expect(ok, greaterThan(0));
    expect(terminalWriteFailures, 0);
  });

  test('the terminal keeps rendering new output after the whole stream', () {
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    final t = _sized();
    for (var i = 0; i < data.length; i += 512) {
      safeTerminalWrite(t, data.substring(i, (i + 512).clamp(0, data.length)));
    }

    expect(safeTerminalWrite(t, '\r\nAFTER-THE-STREAM marker line\r\n'), isTrue);
    // buffer.lines is an IndexAwareCircularBuffer, not a List — no map/indexWhere.
    final sb = StringBuffer();
    for (var i = 0; i < t.buffer.lines.length; i++) {
      sb.writeln(t.buffer.lines[i].getText());
    }
    expect(sb.toString(), contains('AFTER-THE-STREAM marker line'));
  });

  test('after the real Codex stream the buffer is INTACT and selectable', () {
    // #81 exactly as reported: "selection and copy dead during a Codex session".
    // This is the assertion that was pinned to the broken behaviour until the
    // vendored xterm patch landed.
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    final t = _sized();
    for (var i = 0; i < data.length; i += 512) {
      safeTerminalWrite(t, data.substring(i, (i + 512).clamp(0, data.length)));
    }
    safeTerminalWrite(t, '\r\nSELECT THIS LINE\r\n');

    var row = -1;
    for (var i = 0; i < t.buffer.lines.length; i++) {
      if (t.buffer.lines[i].getText().contains('SELECT THIS')) {
        row = i;
        break;
      }
    }
    expect(row, greaterThanOrEqualTo(0), reason: 'the line must have rendered');

    // A line can render while detached (the painter walks the array), and that is
    // precisely how "visible but unselectable" happened. So assert attachment across
    // the WHOLE buffer, not just the row under test.
    var detached = 0;
    for (var i = 0; i < t.buffer.lines.length; i++) {
      if (!t.buffer.lines[i].attached) detached++;
    }
    expect(detached, 0, reason: 'no line may be left detached by a scroll');

    final line = t.buffer.lines[row];
    final controller = TerminalController();
    controller.setSelection(line.createAnchor(0), line.createAnchor(16));
    expect(controller.selection, isNotNull,
        reason: 'selection is null whenever either anchor is detached (#81)');
  });

  test('a write that throws is dropped and counted, not propagated', () {
    // The guard's own contract, proven without depending on any xterm defect: a
    // Terminal whose write throws must yield false and bump the counter rather than
    // taking the caller down.
    final t = _ThrowingTerminal();
    expect(safeTerminalWrite(t, 'anything'), isFalse);
    expect(terminalWriteFailures, 1);
    expect(safeTerminalWrite(t, 'again'), isFalse);
    expect(terminalWriteFailures, 2);
  });
}

/// A Terminal whose `write` always throws, so the guard can be tested on its own
/// terms instead of relying on a library bug that is now fixed.
class _ThrowingTerminal extends Terminal {
  @override
  void write(String data) => throw StateError('synthetic write failure');
}
