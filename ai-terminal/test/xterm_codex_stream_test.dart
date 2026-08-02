// #81 — does a REAL Codex byte stream break the terminal widget's buffer?
//
// The real-input probe showed the symptom the issue reports: with a captured codex
// PTY stream written into a Terminal, `Terminal.write` threw
// "Null check operator used on a null value" and every subsequent drag produced a
// null selection — i.e. selection and copy dead, exactly as reported.
//
// The stack was Buffer.index() -> CircularBuffer.insert() -> _moveChild() ->
// IndexedItem._move(), which dereferences `_owner!` on a line the buffer has already
// detached. In a release build the guarding `assert(attached)` is compiled out, so
// what would be an assertion failure in debug becomes a hard null-check throw in
// production — and it takes the widget tree with it.
//
// These tests decide whether that is a genuine defect or an artifact of writing into
// a terminal that had not been sized yet. That distinction is the whole finding: one
// is a shipping bug, the other is a broken probe.
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

void main() {
  // The minimal trigger, independent of any capture file. Codex sets a DECSTBM
  // scroll region (ESC[1;7r etc — 12 of them in the capture); Claude's TUI sets
  // none, which is exactly why #81 is Codex-specific. Inside a margin,
  // Buffer.index() takes the `lines.insert(absoluteMarginBottom + 1, …)` branch,
  // and CircularBuffer.insert then moves a line the buffer has already detached.
  // A DECSTBM scroll region on its own does NOT reproduce it — checked, and that
  // hypothesis was wrong. So bisect the real capture for the shortest prefix that
  // throws, and print what sits at the boundary. Guessing at the sequence twice is
  // how a wrong root cause gets written down as fact.
  test('BISECT: the shortest prefix of the real stream that breaks the buffer', () {
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

    if (!throwsAt(data.length)) {
      // ignore: avoid_print
      print('BISECT   -> the full stream no longer throws');
      return;
    }
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
    // ignore: avoid_print
    print('BISECT   -> first throws after ${hi} bytes of ${data.length}');
    // ignore: avoid_print
    print('BISECT   context: ${ctx.replaceAll("\x1b", "<ESC>").replaceAll("\r", "<CR>").replaceAll("\n", "<LF>")}');
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
    // Recorded, not asserted either way: this is the configuration the probe hit.
    // ignore: avoid_print
    print('UNSIZED  -> ${thrown ?? "no throw"}  lines=${t.buffer.lines.length}');
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
    // ignore: avoid_print
    print('SIZED    -> ${thrown ?? "no throw"}  lines=${t.buffer.lines.length}');
    // PINS A KNOWN UPSTREAM DEFECT, deliberately asserting the BROKEN behaviour.
    // xterm 4.0.0 is the latest release, so there is nothing to upgrade to; asserting
    // isNull here would leave a permanently red suite and block every later commit.
    // When this starts FAILING, the bug is fixed (or our workaround landed) — flip it
    // to isNull and delete this note.
    expect(thrown, isNotNull,
        reason: 'known: a real Codex stream breaks xterm 4.0.0 (#81)');
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
      // The companion never writes one big blob — bytes arrive as PTY frames. If
      // only the blob form throws, the shipped app is not affected and #81 is
      // something else.
      for (var i = 0; i < data.length; i += 512) {
        t.write(data.substring(i, (i + 512).clamp(0, data.length)));
      }
    } catch (e) {
      thrown = e;
    }
    // ignore: avoid_print
    print('CHUNKED  -> ${thrown ?? "no throw"}  lines=${t.buffer.lines.length}');
    // Same pin as above, and this is the one that matters: chunked delivery is
    // exactly how the companion feeds the widget, so the shipped app hits this.
    expect(thrown, isNotNull,
        reason: 'known: chunked real-Codex delivery breaks xterm 4.0.0 (#81)');
  });
}
