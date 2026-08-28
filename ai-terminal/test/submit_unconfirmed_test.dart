import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/widgets/submit_unconfirmed_banner.dart';

/// #179 — the compose bar's recovery when a submit never reached the agent.
///
/// The server watches every client submit and reports `submitUnconfirmed` when no
/// agent hook follows it inside the window: the TUI was sitting on something that
/// swallows keystrokes (`/usage`, an open slash menu, a crashed CLI back at bash) and
/// the prompt started no turn. Measured on claude 2.1.250, NONE of those states emits a
/// distinguishing byte, which is why this is reactive rather than predictive.
///
/// **The frame carries no text.** The worker only knows that a submit went
/// unconfirmed, never what it said, so recovery rests entirely on this client's own
/// copy — which is exactly why the rules below are worth pinning.
void main() {
  group('resolveSubmitUnconfirmedReaction (#179)', () {
    test('no event at all is not an event', () {
      // The repository re-emits `sessions` on every poll, so the common call by far is
      // one with nothing new in it. Reacting to those would raise the notice forever.
      expect(
        resolveSubmitUnconfirmedReaction(
          eventAt: null, lastHandledAt: null, pendingText: 'hi', composeIsEmpty: true,
        ).outcome,
        SubmitUnconfirmedOutcome.unchanged,
      );
    });

    test('the SAME event twice is handled once', () {
      expect(
        resolveSubmitUnconfirmedReaction(
          eventAt: 1000, lastHandledAt: 1000, pendingText: 'hi', composeIsEmpty: true,
        ).outcome,
        SubmitUnconfirmedOutcome.unchanged,
      );
    });

    test('a NEWER event after one already handled is acted on', () {
      final r = resolveSubmitUnconfirmedReaction(
        eventAt: 2000, lastHandledAt: 1000, pendingText: 'second try', composeIsEmpty: true,
      );
      expect(r.outcome, SubmitUnconfirmedOutcome.mine);
      expect(r.text, 'second try');
    });

    test('an event for a submit this client did not make is not ours', () {
      // The wire frame carries no client identity, so "was it me" can only be answered
      // from local state: a second device or window watching the same session has no
      // pending text and must stay silent rather than announce somebody else's loss.
      expect(
        resolveSubmitUnconfirmedReaction(
          eventAt: 1000, lastHandledAt: null, pendingText: null, composeIsEmpty: true,
        ).outcome,
        SubmitUnconfirmedOutcome.notMine,
      );
    });

    test('an EMPTY compose bar gets the text back', () {
      final r = resolveSubmitUnconfirmedReaction(
        eventAt: 1000, lastHandledAt: null, pendingText: 'fix the failing test', composeIsEmpty: true,
      );
      expect(r.outcome, SubmitUnconfirmedOutcome.mine);
      expect(r.restore, isTrue);
      expect(r.text, 'fix the failing test');
    });

    test('THE NON-DESTRUCTIVE RULE: a draft already being typed is never clobbered', () {
      // The one that must stay red if someone "simplifies" this into an unconditional
      // assignment. A late notice about the previous prompt must not overwrite the new
      // one the user is halfway through — but they still get TOLD, so `mine` (not
      // `notMine`) with `restore: false`.
      final r = resolveSubmitUnconfirmedReaction(
        eventAt: 1000, lastHandledAt: null, pendingText: 'the old prompt', composeIsEmpty: false,
      );
      expect(r.outcome, SubmitUnconfirmedOutcome.mine);
      expect(r.restore, isFalse);
      expect(r.text, 'the old prompt');
    });
  });

  group('notification frame parsing (#179)', () {
    test('a submitUnconfirmed frame is recognised and carries its timestamp', () {
      final n = NotifyEvent.fromJson({
        'type': 'submitUnconfirmed',
        'id': 'abc',
        'at': 1756300000000,
      });
      expect(n.submitUnconfirmed, isTrue);
      expect(n.submitUnconfirmedAt, 1756300000000);
    });

    test('an ordinary notification is NOT mistaken for one', () {
      // The frame shares the /ws/notify socket with every status push, so the type
      // check has to be exact or every idle notification would raise the banner.
      final n = NotifyEvent.fromJson({'type': 'idle', 'id': 'abc'});
      expect(n.submitUnconfirmed, isFalse);
      expect(n.submitUnconfirmedAt, isNull);
    });
  });

  group('SubmitUnconfirmedBanner', () {
    Future<void> pump(WidgetTester tester, {
      required bool restored,
      VoidCallback? onViewTerminal,
      VoidCallback? onDismiss,
    }) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SubmitUnconfirmedBanner(
            restored: restored,
            onDismiss: onDismiss ?? () {},
            onViewTerminal: onViewTerminal,
          ),
        ),
      ));
    }

    testWidgets('it never claims the text is back when it is not', (tester) async {
      // The wording is load-bearing: the un-restored case leaves the prompt in the
      // screen's memory, not in the field, and telling the user to look for it there
      // would send them hunting for something that is not on screen.
      await pump(tester, restored: true);
      final restoredText = tester.widget<Text>(find.byKey(const Key('submit-unconfirmed-detail'))).data!;
      expect(restoredText, contains('compose bar'));

      await pump(tester, restored: false);
      final notRestored = tester.widget<Text>(find.byKey(const Key('submit-unconfirmed-detail'))).data!;
      expect(notRestored, isNot(contains('compose bar')));
      expect(notRestored, contains('Check the terminal'));
    });

    testWidgets('it never names WHICH state the terminal is in', (tester) async {
      // Measured to be unknowable from here — every blocking state was found to emit
      // no distinguishing byte. Claiming "the agent is showing /usage" would be the
      // confidently-wrong failure this repo keeps paying for.
      await pump(tester, restored: true);
      final title = tester.widget<Text>(find.byKey(const Key('submit-unconfirmed-title'))).data!;
      final detail = tester.widget<Text>(find.byKey(const Key('submit-unconfirmed-detail'))).data!;
      for (final s in ['$title $detail'.toLowerCase()]) {
        expect(s.contains('/usage'), isFalse);
        expect(s.contains('slash menu'), isFalse);
        expect(s.contains('agent view'), isFalse);
      }
      // ...and it hedges rather than asserting a failure it cannot be certain of.
      expect(title.toLowerCase(), contains('may not'));
    });

    testWidgets('dismiss fires', (tester) async {
      var dismissed = 0;
      await pump(tester, restored: true, onDismiss: () => dismissed++);
      await tester.tap(find.byKey(const Key('submit-unconfirmed-dismiss')));
      await tester.pump();
      expect(dismissed, 1);
    });

    testWidgets('the View terminal action appears only when there is somewhere to go', (tester) async {
      // Offering it from the terminal lens would be a button that does nothing.
      await pump(tester, restored: true, onViewTerminal: null);
      expect(find.byKey(const Key('submit-unconfirmed-view-terminal')), findsNothing);

      var viewed = 0;
      await pump(tester, restored: true, onViewTerminal: () => viewed++);
      expect(find.byKey(const Key('submit-unconfirmed-view-terminal')), findsOneWidget);
      await tester.tap(find.byKey(const Key('submit-unconfirmed-view-terminal')));
      await tester.pump();
      expect(viewed, 1);
    });

    testWidgets('it takes a layout slot rather than covering the terminal', (tester) async {
      // #179 asks for a notice that is visible and non-blocking. An overlay could
      // swallow a tap meant for the terminal underneath it, so the banner is a plain
      // Column child — assert it renders inside normal flow with a finite height.
      await pump(tester, restored: true);
      final box = tester.getSize(find.byKey(const Key('submit-unconfirmed-banner')));
      expect(box.height, greaterThan(0));
      expect(box.height.isFinite, isTrue);
    });
  });
}
