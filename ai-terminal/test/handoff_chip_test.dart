// #340 - the hand-off chips. The labels are pure functions of what the server sent, so
// the words are pinned here without a widget; the board's own behaviour (where the
// button sits, what the confirm does, which column a run draws in) is in
// work_board_test.dart.
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/format_utils.dart';
import 'package:ai_terminal/widgets/handoff_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('formatTokensShort', () {
    test('thousands as k, millions as M, small counts as they are, unknown as a dash', () {
      expect(formatTokensShort(612000), '612k');
      expect(formatTokensShort(500000), '500k');
      expect(formatTokensShort(1200000), '1.2M');
      expect(formatTokensShort(1000000), '1M');
      expect(formatTokensShort(850), '850');
      expect(formatTokensShort(999600), '1M', reason: 'never "1000k"');
      expect(formatTokensShort(null), '—');
      expect(formatTokensShort(-1), '—');
    });
  });

  group('handoffFailureText', () {
    test('every failure code the server sends has plain words', () {
      expect(handoffFailureText('no-brief'), 'It never wrote its brief');
      expect(handoffFailureText('no-slot'), 'No free session slot on this server');
      expect(handoffFailureText('no-launch-command'), 'Could not work out how to start the new session');
      expect(handoffFailureText('successor-not-ready'), 'The new session never became ready');
      expect(handoffFailureText('successor-not-up'), 'The new session did not start in time');
      expect(handoffFailureText('successor-gone'), 'The new session was closed');
    });

    test('a code it has not met is shown as sent, and a missing one says so', () {
      expect(handoffFailureText('disk-on-fire'), 'disk-on-fire');
      expect(handoffFailureText(null), 'it did not say why');
      expect(handoffFailureText(''), 'it did not say why');
    });
  });

  group('handoffRunLabel', () {
    final now = DateTime.fromMillisecondsSinceEpoch(10 * 60 * 1000);
    HandoffRun run(String state, {String? reason, String? keptBecause, String? name, int? startedAt}) =>
        HandoffRun(state: state, reason: reason, keptBecause: keptBecause, successorName: name, startedAt: startedAt);

    test('each state in flight says what it is doing, and for how long', () {
      expect(handoffRunLabel(run('wrapping', startedAt: 6 * 60 * 1000), now: now), 'Handing off: writing its brief… · 4m');
      expect(handoffRunLabel(run('spawning', startedAt: 9 * 60 * 1000 + 30 * 1000), now: now),
          'Handing off: starting the new session… · 30s');
      expect(handoffRunLabel(run('verifying', startedAt: 9 * 60 * 1000), now: now),
          'Handing off: checking the new session came up… · 1m');
      expect(handoffRunLabel(run('verifying', name: 'proj 2', startedAt: 9 * 60 * 1000), now: now),
          'Handing off: checking "proj 2" came up… · 1m');
      expect(handoffRunLabel(run('closing'), now: now), 'Handing off: closing this one when its turn ends…', reason: 'no start time, no age');
      // #340 review: the two new reasons a successful successor can still leave it kept.
      expect(handoffRunLabel(HandoffRun.fromJson({'state': 'kept', 'reason': 'in-use'})!), 'Handed off, but this session was kept: it started a new turn');
      expect(handoffRunLabel(HandoffRun.fromJson({'state': 'kept', 'reason': 'still-busy'})!), 'Handed off, but this session was kept: it was still busy');
      expect(handoffFailureText('successor-create-failed'), 'The new session could not be created');
    });

    test('kept shows the agent\'s own words verbatim; failed shows the plain reason', () {
      expect(handoffRunLabel(run('kept', reason: 'unsaved-work', keptBecause: 'two files are not committed')),
          'Handed off, but this session was kept: two files are not committed');
      expect(handoffRunLabel(run('kept', reason: 'unsaved-work')), 'Handed off, but this session was kept: it has unsaved work');
      expect(handoffRunLabel(run('kept')), 'Handed off, but this session was kept');
      expect(handoffRunLabel(run('failed', reason: 'no-slot')), 'Hand-off did not finish: No free session slot on this server');
      expect(handoffRunLabel(run('failed')), 'Hand-off did not finish: it did not say why');
    });
  });

  group('chips', () {
    Future<void> show(WidgetTester tester, Widget child, {double width = 400}) async {
      tester.view.physicalSize = Size(width, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: Scaffold(body: Center(child: child))));
    }

    testWidgets('the run chip is keyed by its state, so a test (and a screen reader) can tell them apart', (tester) async {
      await show(tester, const HandoffRunChip(run: HandoffRun(state: 'failed', reason: 'no-brief')));
      expect(find.byKey(const ValueKey('handoff-failed')), findsOneWidget);
      expect(find.text('Hand-off did not finish: It never wrote its brief'), findsOneWidget);
    });

    testWidgets('a run in flight is still: no animation, so it never keeps the window repainting', (tester) async {
      await show(tester, const HandoffRunChip(run: HandoffRun(state: 'wrapping')));
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('a kept reason that is a whole sentence wraps instead of overflowing', (tester) async {
      await show(
          tester,
          const HandoffRunChip(
              run: HandoffRun(
                  state: 'kept',
                  reason: 'unsaved-work',
                  keptBecause: 'the working tree has uncommitted changes in nine files and a half-written migration')),
          width: 240);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the context chip names the size, or says "Long session" when the server did not', (tester) async {
      await show(tester, const HandoffCtxChip(tokens: 612000));
      expect(find.text('612k ctx'), findsOneWidget);
      await show(tester, const HandoffCtxChip(tokens: null));
      expect(find.text('Long session'), findsOneWidget);
    });
  });
}
