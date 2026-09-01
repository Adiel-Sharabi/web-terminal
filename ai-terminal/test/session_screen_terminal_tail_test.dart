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
import 'package:ai_terminal/util/terminal_tail.dart';
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

  group('TerminalTailStrip.heightFor - the number the inset depends on', () {
    // ConversationView is inset by exactly this, so that the strip neither
    // hides the newest message (the list pins to maxScrollExtent, so covered
    // text is UNREACHABLE, not merely shifted) nor swallows the taps meant
    // for its 'New' pill and jump-to-bottom FAB - the strip is a later
    // sibling in the ancestor Stack, so it hit-tests first. A wrong number
    // here is a covered message or a visible gap, so it is pinned.
    test('an empty strip occupies nothing - the caller does not mount one', () {
      expect(TerminalTailStrip.heightFor(0), 0);
      expect(TerminalTailStrip.heightFor(-1), 0);
    });

    test('height grows with the line count, and clears the 12px controls', () {
      double? prev;
      for (var n = 1; n <= kTerminalTailLines; n++) {
        final h = TerminalTailStrip.heightFor(n);
        // Both the pill and the FAB sit at bottom:12 inside ConversationView.
        // An inset at or below that would leave them inside the strip's band.
        expect(h, greaterThan(12));
        if (prev != null) expect(h, greaterThan(prev));
        prev = h;
      }
    });

    test('the full four-line strip stays a PEEK, not a second terminal', () {
      // A phone viewport is ~600-800 logical px tall. If the strip ever grew
      // past a small fraction of that it would stop being a peek that earns a
      // tap and start being a competing pane.
      expect(TerminalTailStrip.heightFor(kTerminalTailLines), lessThan(120));
    });
  });

  group('heightFor is MEASURED against the real layout, not derived', () {
    // Review derived this number from the widget's constants and it was wrong at
    // EVERY line count (41.6 vs 44.0, 57.2 vs 58.0, 72.8 vs 74.0, 88.4 vs 90.0):
    // a paragraph rounds its line box up to whole pixels, and at one line the
    // 18px chevron is taller than the line. An under-report is not cosmetic -- it
    // is precisely the occlusion and tap-shadowing the inset exists to prevent,
    // just small enough to look fine. So the number is pinned to the LAYOUT.
    Future<double> render(WidgetTester tester, int n, {TextScaler? scaler}) async {
      final strip = TerminalTailStrip(
        lines: List.generate(n, (i) => 'row $i'),
        onTap: () {},
      );
      await tester.pumpWidget(MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(textScaler: scaler ?? TextScaler.noScaling),
          child: Scaffold(
            body: Align(alignment: Alignment.bottomCenter, child: strip),
          ),
        ),
      ));
      return tester.getSize(find.byType(TerminalTailStrip)).height;
    }

    for (var n = 1; n <= kTerminalTailLines; n++) {
      testWidgets('heightFor($n) equals what $n lines actually lay out to',
          (tester) async {
        expect(await render(tester, n), TerminalTailStrip.heightFor(n));
      });
    }

    testWidgets('the system text scale cannot move it -- measured at 1.3x',
        (tester) async {
      // Unpinned, the strip grew to 106px against an 88.4px inset at this
      // scale, putting the pill and FAB back inside its tap band for exactly
      // the users least able to absorb it. The strip pins TextScaler.noScaling
      // because terminal content does not follow the system scale and the
      // terminal lens it previews does not either.
      for (var n = 1; n <= kTerminalTailLines; n++) {
        expect(await render(tester, n, scaler: const TextScaler.linear(1.3)),
            TerminalTailStrip.heightFor(n),
            reason: 'line count $n moved under a 1.3x system text scale');
      }
    });
  });
}
