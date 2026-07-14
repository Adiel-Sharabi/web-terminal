// Widget tests for the terminal's Ctrl+C / Ctrl+Shift+C copy shortcut (#52).
//
// Decision (matches the web client, `app.html`): Ctrl+C copies when there IS a
// terminal selection (the Windows Terminal model), else it falls through to the
// terminal's normal Ctrl+C handling, which sends SIGINT (`\x03`, #11) — the one
// physical key resolves by selection state, so an interrupt still works with
// nothing selected. Ctrl+Shift+C is an explicit, unambiguous always-copy.
//
// These exercise the REAL `xterm` TerminalView plus the two SSOT functions
// `session_screen.dart` exports for this — `terminalCopyShortcutTriggered`
// (the pure decision) and `copyTerminalSelection` (the ONE clipboard-writing
// path, also used by #49's context-menu Copy and the on-selection toolbar) —
// wired into `onKeyEvent` exactly as `_SessionScreenState._handleTerminalCopyShortcut`
// wires them in `session_screen.dart`. `_handleTerminalCopyShortcut` itself is
// private to that State (can't be called from here); a full `SessionScreen`
// needs a live ApiClient/SessionRepository/notification stack, which
// `session_screen_fork_menu_test.dart` already notes is "out of scope for a
// unit test" — so this pumps just the terminal, the same minimal-harness
// approach.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/screens/session_screen.dart';

/// Mirrors `_SessionScreenState._handleTerminalCopyShortcut` (session_screen.dart):
/// same two SSOT calls (`terminalCopyShortcutTriggered` + `copyTerminalSelection`),
/// same `KeyEventResult` contract. Only the private "Copied" snackbar is left out
/// — that needs a BuildContext/ScaffoldMessenger and isn't part of what's under
/// test (whether the clipboard write happens and whether SIGINT is suppressed).
KeyEventResult _copyShortcutHandler(
  FocusNode node,
  KeyEvent event,
  Terminal terminal,
  TerminalController controller,
) {
  if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyC) {
    return KeyEventResult.ignored;
  }
  final hw = HardwareKeyboard.instance;
  final triggered = terminalCopyShortcutTriggered(
    desktop: isDesktopPlatform(),
    ctrlOrCmdPressed: hw.isControlPressed,
    shiftPressed: hw.isShiftPressed,
    hasSelection: controller.selection != null,
  );
  if (!triggered) return KeyEventResult.ignored;
  copyTerminalSelection(terminal, controller);
  return KeyEventResult.handled;
}

void main() {
  late List<String> clipboardWrites;
  late List<String> ptyOutput;
  late Terminal terminal;
  late TerminalController controller;
  late FocusNode focusNode;

  setUp(() {
    clipboardWrites = <String>[];
    ptyOutput = <String>[];
    terminal = Terminal(maxLines: 200);
    terminal.onOutput = ptyOutput.add;
    controller = TerminalController();
    focusNode = FocusNode();
  });

  Future<void> pumpTerminal(WidgetTester tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboardWrites.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalView(
            terminal,
            controller: controller,
            focusNode: focusNode,
            autofocus: false,
            // Desktop-live wiring, matching how SessionScreen configures the
            // Terminal lens on desktop (terminalHardwareKeyboardOnly(live:
            // true, desktop: true) => true): hardware keys only, no IME.
            hardwareKeyboardOnly: true,
            onKeyEvent: (node, event) =>
                _copyShortcutHandler(node, event, terminal, controller),
          ),
        ),
      ),
    );
    focusNode.requestFocus();
    await tester.pump();
  }

  Future<void> pressCtrlC(WidgetTester tester, {bool shift = false}) async {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    // Clipboard.setData resolves over the (mocked) platform channel
    // asynchronously — settle so the write lands before assertions run.
    await tester.pumpAndSettle();
  }

  group('#52 terminal Ctrl+C / Ctrl+Shift+C copy shortcut', () {
    testWidgets(
      'Ctrl+C WITH a selection copies to the clipboard and does NOT send SIGINT',
      (tester) async {
        terminal.write('hello world');
        // Select AFTER the widget is laid out: TerminalView's auto-resize on
        // first layout can reflow the buffer, so anchors created beforehand
        // could point at stale positions.
        await pumpTerminal(tester);
        selectAllOnTerminal(terminal, controller);
        await tester.pump();
        expect(controller.selection, isNotNull);

        await pressCtrlC(tester);

        expect(clipboardWrites, hasLength(1));
        expect(clipboardWrites.single, contains('hello world'));
        expect(
          ptyOutput.contains('\x03'),
          isFalse,
          reason: 'a selection must be copied, never interrupt the PTY',
        );
        expect(
          controller.selection,
          isNull,
          reason: 'copy clears the selection, like the menu/toolbar Copy',
        );
      },
    );

    testWidgets(
      'Ctrl+C with NO selection still sends SIGINT (\\x03) — #11 must not regress',
      (tester) async {
        await pumpTerminal(tester);
        expect(controller.selection, isNull);

        await pressCtrlC(tester);

        expect(clipboardWrites, isEmpty);
        expect(ptyOutput, contains('\x03'));
      },
    );

    testWidgets(
      'Ctrl+Shift+C is an explicit always-copy — same clipboard result as the menu Copy',
      (tester) async {
        terminal.write('explicit copy');
        await pumpTerminal(tester);
        selectAllOnTerminal(terminal, controller);
        await tester.pump();

        await pressCtrlC(tester, shift: true);

        expect(clipboardWrites, hasLength(1));
        expect(clipboardWrites.single, contains('explicit copy'));
        expect(ptyOutput, isEmpty);
      },
    );

    testWidgets(
      'Ctrl+Shift+C with nothing selected is a silent no-op (nothing to copy)',
      (tester) async {
        await pumpTerminal(tester);
        expect(controller.selection, isNull);

        await pressCtrlC(tester, shift: true);

        expect(clipboardWrites, isEmpty);
        expect(
          ptyOutput.contains('\x03'),
          isFalse,
          reason: 'Ctrl+Shift+C is explicit copy, never interrupt',
        );
      },
    );
  });
}
