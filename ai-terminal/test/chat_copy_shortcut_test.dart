// #83 — Ctrl+C copies the CHAT lens's selection.
//
// The bug this pins is NOT "selection is broken". Selection was proven working on
// the real Windows build: driving the shipped rendering stack with real SendInput
// mouse events (scripts/rig/probe-drive-selection.ps1) produced a visible
// highlight spanning message bubbles. What did NOT work was copying it — the only
// copy shortcut in the app was wired to `TerminalView.onKeyEvent`, which never
// sees a key while the compose field holds focus, which on desktop it normally
// does in the chat lens.
//
// Ctrl+C is overloaded, so the predicate has to be narrow: in the TERMINAL lens
// the key must still reach the PTY as SIGINT (#11/#52), and a selection inside
// the compose field must still copy that field.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';

void main() {
  group('chatCopyShortcutTriggered', () {
    test('copies when the chat lens has a selection', () {
      expect(
        chatCopyShortcutTriggered(
          chatLens: true,
          ctrlOrCmdPressed: true,
          hasChatSelection: true,
          composeHasSelection: false,
        ),
        isTrue,
      );
    });

    test('does NOT fire in the terminal lens — Ctrl+C there is SIGINT', () {
      expect(
        chatCopyShortcutTriggered(
          chatLens: false,
          ctrlOrCmdPressed: true,
          hasChatSelection: true,
          composeHasSelection: false,
        ),
        isFalse,
      );
    });

    test('falls through when nothing is selected in the chat', () {
      expect(
        chatCopyShortcutTriggered(
          chatLens: true,
          ctrlOrCmdPressed: true,
          hasChatSelection: false,
          composeHasSelection: false,
        ),
        isFalse,
      );
    });

    test('yields to the compose field when IT owns a selection', () {
      expect(
        chatCopyShortcutTriggered(
          chatLens: true,
          ctrlOrCmdPressed: true,
          hasChatSelection: true,
          composeHasSelection: true,
        ),
        isFalse,
      );
    });

    test('needs the modifier — a bare C is typing', () {
      expect(
        chatCopyShortcutTriggered(
          chatLens: true,
          ctrlOrCmdPressed: false,
          hasChatSelection: true,
          composeHasSelection: false,
        ),
        isFalse,
      );
    });
  });
}
