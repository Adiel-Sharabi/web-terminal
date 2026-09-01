// #194 Part 1 -- terminalTailGateOpen (the chat lens's terminal-tail strip
// gate) and TerminalTailStrip's own rendering/tap behaviour.
//
// terminalTailGateOpen lives in its own file, mirroring session_lens_resolve_
// test.dart / session_screen_chat_lens_test.dart: a dedicated file per pure
// rule extracted from SessionScreen, rather than mounting the whole screen
// (which needs a live ApiClient/SessionRepository/notification stack -- out
// of scope here, same reasoning session_screen_fork_menu_test.dart states for
// canForkFromMenu).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/widgets/terminal_tail_strip.dart';

void main() {
  group('terminalTailGateOpen (#194 Part 1)', () {
    test('working -> gate CLOSED', () {
      expect(terminalTailGateOpen('working'), isFalse);
    });

    test("active -> gate OPEN -- #190's exact case: no hook has fired yet", () {
      // A brand-new session parked on Claude's folder-trust selector reports
      // 'active', not 'working'. ConversationView._shouldLivePoll counts
      // 'active' as busy (right for ITS job -- Codex has no other signal);
      // this gate must not borrow that rule, or the one session that most
      // needs the strip would never get it.
      expect(terminalTailGateOpen('active'), isTrue);
    });

    test(
      'waiting -> gate OPEN -- unlike echoTimeoutRuns, which treats waiting as busy',
      () {
        expect(terminalTailGateOpen('waiting'), isTrue);
      },
    );

    test('idle / api_error -> gate OPEN', () {
      expect(terminalTailGateOpen('idle'), isTrue);
      expect(terminalTailGateOpen('api_error'), isTrue);
    });

    test('null status -> gate OPEN ("working" is the only closed case)', () {
      expect(terminalTailGateOpen(null), isTrue);
    });
  });

  group('TerminalTailStrip', () {
    testWidgets('renders the given lines as real, readable text', (
      tester,
    ) async {
      var tapped = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalTailStrip(
              lines: const [
                'Quick safety check: Is this...',
                'No, exit',
                'Yes, I trust this folder',
              ],
              onTap: () => tapped = true,
            ),
          ),
        ),
      );

      // Not merely "the widget exists" -- assert the ACTUAL content reached
      // the screen, so a build that silently drops `lines` (or renders a
      // placeholder) would fail here.
      expect(find.text('Quick safety check: Is this...'), findsOneWidget);
      expect(find.text('No, exit'), findsOneWidget);
      expect(find.text('Yes, I trust this folder'), findsOneWidget);

      await tester.tap(find.byKey(const Key('terminal-tail-strip')));
      expect(
        tapped,
        isTrue,
        reason: 'tapping the strip must route to the terminal lens',
      );
    });

    testWidgets('a different set of lines renders different text', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalTailStrip(
              lines: const ['\$ npm run build', 'Build succeeded'],
              onTap: () {},
            ),
          ),
        ),
      );

      expect(find.text('\$ npm run build'), findsOneWidget);
      expect(find.text('Build succeeded'), findsOneWidget);
      expect(find.text('No, exit'), findsNothing);
    });
  });
}
