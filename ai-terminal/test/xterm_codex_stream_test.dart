// #81 — a REAL Codex byte stream must not corrupt the terminal widget's buffer.
//
// THE ROOT CAUSE, measured rather than guessed (two earlier hypotheses were wrong):
//
// xterm 4.0.0's `Buffer.scrollUp`, `Buffer.scrollDown` and `Buffer.deleteLines`
// shift a line with `lines[to] = lines[from]`. That does not MOVE the line — it
// leaves the very same object referenced by both slots. `_adoptChild` then
// unconditionally detaches whatever occupied the destination, so the next
// iteration of the loop detaches the line the previous iteration just moved.
//
// Instrumenting the vendored copy showed the cascade exactly, on a buffer that was
// nowhere near full (`len=30 arr=5000`):
//
//     WT-DUP adopt index=29 cyc=29 already at slot=28 ...
//     WT-DUP adopt index=28 cyc=28 already at slot=27 ...   (down to slot 0)
//
// The wreckage has two faces, which is why one bug produced two symptoms:
//   * the lines are still IN `_array`, so the painter still draws them — but they
//     are detached, and `TerminalController.selection` is null the moment either
//     anchor is detached. That is "text visible, nothing selects".
//   * a later `_moveChild` calls `_move` on one of those detached lines, which
//     dereferences `_owner!`. In debug that is the `assert(attached)` at
//     circular_buffer.dart:312; in a RELEASE build the assert is compiled out and
//     it is a hard null-check throw out of `Terminal.write`, called from a stream
//     listener — which kills the widget subtree and blanks the terminal.
//
// It is Codex-specific because the three broken methods are only reached inside a
// DECSTBM vertical margin, and Codex sets 12 scroll regions on startup where
// Claude's TUI sets none.
//
// `Buffer.insertLines`, immediately above `deleteLines`, already avoids the alias by
// going through `lines.swap` — so this is an upstream oversight, not a design.
//
// xterm 4.0.0 is the LATEST published release, so the fix lives in the vendored copy
// at ai-terminal/third_party/xterm (see `dependency_overrides` in pubspec.yaml),
// marked `WEB-TERMINAL PATCH (#81)`.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// The capture produced by scripts' probe-dec-modes.js off a real `codex` TUI.
/// Skipped rather than failed when absent — a missing fixture must not look like a
/// passing test, but nor should it break the suite on a machine that has no capture.
File? _capture() {
  for (final p in <String>[
    Platform.environment['CODEX_CAPTURE'] ?? '',
    // Checked in, because a regression test whose fixture is missing SKIPS — and a
    // skipped test reads exactly like a passing one.
    'test/fixtures/codex-pty-capture.bin',
  ]) {
    if (p.isEmpty) continue;
    final f = File(p);
    if (f.existsSync()) return f;
  }
  return null;
}

/// Counts lines that are still in the buffer's backing array but detached from it —
/// the exact corruption #81 is about. Zero is the invariant.
int _detachedLines(Terminal t) {
  var detached = 0;
  for (var i = 0; i < t.buffer.lines.length; i++) {
    if (!t.buffer.lines[i].attached) detached++;
  }
  return detached;
}

void main() {
  test('BISECT: no prefix of the real stream breaks the buffer', () {
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture available');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    bool throwsAt(int n) {
      final t = Terminal(maxLines: 5000);
      t.resize(120, 30);
      try {
        t.write(data.substring(0, n));
        return false;
      } catch (_) {
        return true;
      }
    }

    // Before the patch this bisected to a first throw at byte 4381 of 13047. Kept as
    // a bisect rather than a single assertion so that a REGRESSION reports where it
    // starts, not merely that it happened.
    if (!throwsAt(data.length)) return;
    var lo = 0, hi = data.length;
    while (lo + 1 < hi) {
      final mid = (lo + hi) ~/ 2;
      if (throwsAt(mid)) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    final ctx = data.substring((hi - 90).clamp(0, hi), hi);
    fail('the stream throws again after $hi bytes of ${data.length}; context: '
        '${ctx.replaceAll("\x1b", "<ESC>").replaceAll("\r", "<CR>").replaceAll("\n", "<LF>")}');
  });

  test('a real Codex stream written to an UNSIZED terminal', () {
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture available');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    final t = Terminal(maxLines: 5000);
    Object? thrown;
    try {
      t.write(data);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, isNull, reason: 'an unsized terminal must survive too');
    expect(_detachedLines(t), 0);
  });

  test('a real Codex stream written to a SIZED terminal (the app configuration)', () {
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture available');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    final t = Terminal(maxLines: 5000);
    // What TerminalView does on layout, and what the PTY was actually sized to.
    t.resize(120, 30);
    Object? thrown;
    try {
      t.write(data);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, isNull, reason: 'a real Codex stream must not break xterm (#81)');
    // The load-bearing assertion. Not throwing is not enough — the buffer has to be
    // INTACT, because a detached-but-rendered line is what killed selection.
    expect(_detachedLines(t), 0,
        reason: 'every line must stay attached to the circular buffer');
  });

  test('the same stream arriving in small CHUNKS, as the WebSocket delivers it', () {
    final f = _capture();
    if (f == null) {
      markTestSkipped('no codex capture available');
      return;
    }
    final data = String.fromCharCodes(f.readAsBytesSync());
    final t = Terminal(maxLines: 5000);
    t.resize(120, 30);
    Object? thrown;
    try {
      // The companion never writes one big blob — bytes arrive as PTY frames. This
      // is exactly how the shipped app feeds the widget, so it is the case that
      // matters most.
      for (var i = 0; i < data.length; i += 512) {
        t.write(data.substring(i, (i + 512).clamp(0, data.length)));
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown, isNull,
        reason: 'chunked real-Codex delivery must not break xterm (#81)');
    expect(_detachedLines(t), 0);
  });

  // The unit-level statement of the defect, independent of any capture: a scroll
  // inside a DECSTBM margin must move lines, not alias them. This is the test that
  // fails if someone re-vendors xterm and drops the patch.
  test('scrolling inside a DECSTBM margin leaves every line attached', () {
    final t = Terminal(maxLines: 5000);
    t.resize(80, 24);
    t.write('\x1b[1;10r'); // scroll region, rows 1..10 — what Codex sets
    for (var i = 0; i < 200; i++) {
      t.write('line $i\r\n');
    }
    expect(_detachedLines(t), 0,
        reason: 'Buffer.scrollUp/scrollDown must MOVE lines, never alias them');
  });

  test('a line scrolled inside a margin can still anchor a selection', () {
    // #81 as the user experiences it: drag over the terminal, get nothing.
    final t = Terminal(maxLines: 5000);
    t.resize(80, 24);
    t.write('\x1b[1;10r');
    for (var i = 0; i < 50; i++) {
      t.write('line $i\r\n');
    }
    t.write('SELECT THIS LINE\r\n');

    var row = -1;
    for (var i = 0; i < t.buffer.lines.length; i++) {
      if (t.buffer.lines[i].getText().contains('SELECT THIS')) {
        row = i;
        break;
      }
    }
    expect(row, greaterThanOrEqualTo(0), reason: 'the line must have rendered');

    final line = t.buffer.lines[row];
    expect(line.attached, isTrue);
    final controller = TerminalController();
    controller.setSelection(line.createAnchor(0), line.createAnchor(16));
    expect(controller.selection, isNotNull,
        reason: 'a selection is null whenever either anchor is detached');
  });
}
