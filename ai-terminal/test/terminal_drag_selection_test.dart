// #81 — "selection and copy dead during a Codex session".
//
// The issue's lead hypothesis was that Codex turns on mouse reporting
// (ESC[?1000h / ?1002h / ?1006h), so the terminal forwards drags to the application
// instead of selecting locally. That hypothesis is WRONG, and these tests pin both
// halves of the refutation so it cannot be re-adopted by the next reader.
//
// Half 1 — MEASURED. A real codex-cli PTY (0.144.x, captured with the update nag
// dismissed so the TUI had genuinely rendered its composer) sets exactly:
//     ?1004h  focus reporting      ?9001h  win32 input mode
//     ?2004h  bracketed paste      ?2026l  synchronized output off
// and NO mouse reporting and NO alternate screen buffer. `CODEX_DEC_MODES` below is
// that capture. Note ?1004 is focus tracking, not mouse tracking — mistaking one for
// the other is what made the hypothesis look plausible.
//
// Half 2 — STRUCTURAL, and the more durable of the two. In xterm 4.0.0 the mouse drag
// path does not consult `mouseMode` at all: `TerminalController`'s default
// `pointerInputs` is `{PointerInput.tap}` (drag is absent), and the gesture handler's
// `onDragStart`/`onDragUpdate` call `renderTerminal.selectCharacters(...)`
// unconditionally. Only TAPS are ever forwarded to the application. So even an agent
// that DID enable mouse reporting would still select on drag — which is why the last
// test deliberately turns mouse reporting on and still demands a selection. That test
// is the one that matters on a future xterm upgrade: if it ever goes red, drag
// selection has become mouse-mode dependent and #81's hypothesis becomes live for the
// first time.
//
// These run against the SAME widget nesting the terminal lens uses in
// session_screen.dart — Offstage > Stack > GestureDetector(secondary tap) > ColoredBox
// > TerminalView with a scrollController — because that nesting, not xterm's mouse
// handling, is where a drag could plausibly be swallowed by the gesture arena.

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// The DEC private modes a real Codex TUI sets, verbatim from the PTY capture.
const codexDecModes = '\x1b[?1004h\x1b[?9001h\x1b[?2004h\x1b[?2026l';

/// What the issue ASSUMED Codex sets. Kept so the "even then" case is explicit.
const mouseReportingModes = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

void main() {
  /// Mounts the terminal lens exactly as session_screen.dart nests it.
  Future<void> pumpTerminal(
    WidgetTester tester,
    Terminal terminal,
    TerminalController controller,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              Expanded(
                child: Stack(
                  children: [
                    Offstage(
                      offstage: false,
                      child: Stack(
                        children: [
                          // #49's right-click menu wrapper. A competing recognizer
                          // in the arena is precisely the kind of thing that could
                          // eat a primary-button drag, so it must be present.
                          GestureDetector(
                            onSecondaryTapDown: (_) {},
                            child: ColoredBox(
                              color: const Color(0xFF000000),
                              child: TerminalView(
                                terminal,
                                controller: controller,
                                scrollController: ScrollController(),
                                textStyle: const TerminalStyle(
                                  fontSize: 12,
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
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Drags with a MOUSE (xterm's pan recognizer is mouse-only by construction:
  /// `supportedDevices: {PointerDeviceKind.mouse}`, so a default synthetic touch
  /// drag would prove nothing and would look exactly like a failure).
  Future<void> mouseDrag(WidgetTester tester, Offset from, Offset to) async {
    final gesture = await tester.startGesture(from, kind: PointerDeviceKind.mouse);
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.moveTo(to);
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.up();
    await tester.pumpAndSettle();
  }

  Future<Terminal> seeded(String extraModes) async {
    final terminal = Terminal(maxLines: 5000);
    if (extraModes.isNotEmpty) terminal.write(extraModes);
    for (var i = 0; i < 10; i++) {
      terminal.write('line $i with selectable words here\r\n');
    }
    return terminal;
  }

  testWidgets('CONTROL: a mouse drag selects text in a plain terminal', (tester) async {
    final terminal = await seeded('');
    final controller = TerminalController();
    await pumpTerminal(tester, terminal, controller);

    expect(controller.selection, isNull, reason: 'nothing selected before the drag');

    final box = tester.getRect(find.byType(TerminalView));
    await mouseDrag(
      tester,
      box.topLeft + const Offset(10, 10),
      box.topLeft + const Offset(160, 42),
    );

    expect(controller.selection, isNotNull,
        reason: 'a mouse drag over the terminal must produce a selection');
  });

  testWidgets(
      'a terminal carrying the DEC modes a real Codex TUI sets still selects on drag',
      (tester) async {
    // The measured refutation, as a gate. If Codex ever starts emitting something
    // that does kill selection, this goes red and names the culprit.
    final terminal = await seeded(codexDecModes);
    final controller = TerminalController();
    await pumpTerminal(tester, terminal, controller);

    final box = tester.getRect(find.byType(TerminalView));
    await mouseDrag(
      tester,
      box.topLeft + const Offset(10, 10),
      box.topLeft + const Offset(160, 42),
    );

    expect(controller.selection, isNotNull,
        reason: 'Codex sets ?1004/?9001/?2004 only — none of which touch selection');
  });

  testWidgets('Codex sets neither mouse reporting nor the alternate buffer',
      (tester) async {
    // Pins what the capture showed, in terms of the terminal's own observable state,
    // so the claim survives without re-running a PTY probe.
    final terminal = Terminal(maxLines: 5000);
    terminal.write(codexDecModes);

    expect(terminal.mouseMode, MouseMode.none,
        reason: 'no ?1000/?1002/?1003 in the capture');
    expect(terminal.isUsingAltBuffer, isFalse,
        reason: 'no ?1049/?47/?1047 in the capture — Codex renders in the main buffer');
  });

  testWidgets(
      'EVEN WITH mouse reporting on, a drag still selects (xterm drag ignores mouseMode)',
      (tester) async {
    // The hypothesis' own premise, granted in full — and it still does not produce
    // the reported symptom. This is the test to watch on an xterm upgrade.
    final terminal = await seeded(mouseReportingModes);
    final controller = TerminalController();
    await pumpTerminal(tester, terminal, controller);

    expect(terminal.mouseMode, isNot(MouseMode.none),
        reason: 'precondition: the terminal really is in a mouse-reporting mode');

    final box = tester.getRect(find.byType(TerminalView));
    await mouseDrag(
      tester,
      box.topLeft + const Offset(10, 10),
      box.topLeft + const Offset(160, 42),
    );

    expect(controller.selection, isNotNull,
        reason: 'drag selection is unconditional in xterm 4.0.0; only taps are '
            'forwarded to the application');
  });
}
