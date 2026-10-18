// #374 - a helper session is drawn indented under its parent, which narrows its card,
// and phones are narrow to begin with. The status row holds the recap, bell and star
// buttons, the context %, and the time, all fixed-width, so the status word is what
// gives way: measured before the fix, this row overflowed at 372dp and below.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/widgets/session_card.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/util/session_tree.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');

Session _card(String status, {SessionReason? reason}) => Session(
      id: 'x',
      name: 'A long helper session name that keeps going',
      cwd: '/home/x',
      status: status,
      claudeSessionId: null,
      lastActivity: DateTime.now().millisecondsSinceEpoch - 13 * 3600 * 1000,
      notifyLevel: 'important',
      server: _home,
      metrics: const SessionMetrics(ctx: 85),
      reason: reason,
    );

Future<void> _pumpCard(WidgetTester tester, double w, Session s) async {
  tester.view.physicalSize = Size(w, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.dark,
    home: Scaffold(
      body: ListView(children: [
        SessionCard(
          session: s,
          isFavorite: true,
          onTap: () {},
          onToggleFavorite: () {},
          onBellTap: () {},
          onRecapTap: () {},
          onMoreTap: () {},
          dragHandle: const SizedBox(width: 10),
        ),
      ]),
    ),
  ));
}

void main() {
  // The REASON chip is the other thing that can sit where the status word does
  // (#313). It cannot shrink below its icon and padding, so it needs the width the
  // session list keeps for a card (SessionTreeRow.minCardRow), not less: these are
  // the widths a row actually gets there, indented or not.
  // minCardRow is in the list so the constant stays bound to this measurement: lower it
  // below what the card needs and this goes red.
  for (final w in [360.0, SessionTreeRow.minCardRow, 412.0, 800.0]) {
    testWidgets('a card with a reason chip fits at ${w}dp', (tester) async {
      await _pumpCard(tester, w,
          _card('idle', reason: const SessionReason(kind: 'external', text: 'waiting on the vendor licence', source: 'reported')));
      expect(tester.takeException(), isNull);
    });
  }

  for (final w in [340.0, 352.0, 364.0, 384.0, 412.0]) {
    for (final st in ['working', 'idle', 'waiting']) {
      testWidgets('a fully loaded card fits at ${w}dp ($st)', (tester) async {
        tester.view.physicalSize = Size(w, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final s = Session(
          id: 'x',
          name: 'A long helper session name that keeps going',
          cwd: '/home/x',
          status: st,
          claudeSessionId: null,
          lastActivity: DateTime.now().millisecondsSinceEpoch - 13 * 3600 * 1000,
          notifyLevel: 'important',
          server: _home,
          metrics: const SessionMetrics(ctx: 85),
        );
        await tester.pumpWidget(MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: ListView(children: [
              SessionCard(
                session: s,
                isFavorite: true,
                onTap: () {},
                onToggleFavorite: () {},
                onBellTap: () {},
                onRecapTap: () {},
                onMoreTap: () {},
                dragHandle: const SizedBox(width: 10),
              ),
            ]),
          ),
        ));
        expect(tester.takeException(), isNull);
      });
    }
  }
}
