// #443 — web-terminal checked in on an idle session whose self-wait nothing could keep,
// and the session list shows that it did and what came back. The server decides the
// state (lib/check-in.js); these pin that the client parses it defensively, names every
// state, and draws it beside the reason chip only when there is one.
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/reason_chip.dart';
import 'package:ai_terminal/widgets/session_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

Session _s(Map<String, dynamic> extra) => Session.fromJson(_server, {
      'id': 's1',
      'name': 'my session',
      'cwd': '/w',
      'status': 'idle',
      'notifyLevel': 'important',
      ...extra,
    });

final _at = DateTime(2026, 11, 9, 14, 2).millisecondsSinceEpoch;

void main() {
  group('parsing', () {
    test('known states parse; anything else is no check-in at all', () {
      final c = _s({'checkIn': {'sentAt': _at, 'idleMin': 95, 'state': 'done', 'answeredAt': _at + 1}}).checkIn!;
      expect(c.state, 'done');
      expect(c.idleMin, 95);
      expect(c.sentAt, _at);
      expect(_s({'checkIn': {'sentAt': _at, 'state': 'pondering'}}).checkIn, isNull);
      expect(_s({'checkIn': {'state': 'done'}}).checkIn, isNull);
      expect(_s({'checkIn': 'done'}).checkIn, isNull);
      expect(_s({'checkIn': null}).checkIn, isNull);
      expect(_s({}).checkIn, isNull, reason: 'an older server sends none');
    });
  });

  group('label', () {
    test('every state the server sends has its words', () {
      String l(String state) => checkInLabel(SessionCheckIn(sentAt: _at, state: state));
      expect(l('sent'), 'Checked in 14:02');
      expect(l('lost'), 'Checked in 14:02 · not delivered');
      expect(l('answering'), 'Checked in 14:02 · answering');
      expect(l('interrupted'), 'Checked in 14:02 · interrupted');
      expect(l('done'), 'Checked in 14:02 → done');
      expect(l('you'), 'Checked in 14:02 → needs you');
      expect(l('external'), 'Checked in 14:02 → blocked on others');
      expect(l('resumed'), 'Checked in 14:02 → resumed');
      expect(l('stuck'), 'Checked in 14:02 → still nothing running');
      expect(checkInLabel(null), '');
      for (final s in SessionCheckIn.states) {
        expect(l(s), startsWith('Checked in 14:02'), reason: s);
      }
    });
  });

  group('session card', () {
    Future<void> pump(WidgetTester tester, Session s) => tester.pumpWidget(MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(body: SessionCard(session: s, onTap: () {})),
        ));

    testWidgets('drawn beside the reason chip, with what came back', (tester) async {
      await pump(tester, _s({
        'reason': {'kind': 'done', 'source': 'reported'},
        'checkIn': {'sentAt': _at, 'idleMin': 95, 'state': 'done'},
      }));
      expect(find.byKey(const ValueKey('reason-done')), findsOneWidget);
      expect(find.byKey(const ValueKey('check-in-done')), findsOneWidget);
      expect(find.text('Checked in 14:02 → done'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shown while it answers too: a working row has no reason chip, but the marker stays', (tester) async {
      await pump(tester, _s({
        'status': 'working',
        'reason': {'kind': 'working', 'source': 'status'},
        'checkIn': {'sentAt': _at, 'idleMin': 95, 'state': 'answering'},
      }));
      expect(find.byKey(const ValueKey('reason-working')), findsNothing);
      expect(find.byKey(const ValueKey('check-in-answering')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('no check-in, no marker; and it never overflows a narrow row', (tester) async {
      await pump(tester, _s({'reason': {'kind': 'self', 'text': 'watch CI', 'source': 'reported'}}));
      expect(find.byKey(const ValueKey('check-in-stuck')), findsNothing);
      expect(find.textContaining('Checked in'), findsNothing);
      tester.view.physicalSize = const Size(320 * 3, 800 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await pump(tester, _s({
        'reason': {'kind': 'self', 'text': 'watch the very long CI run name here', 'source': 'reported'},
        'checkIn': {'sentAt': _at, 'idleMin': 95, 'state': 'stuck'},
      }));
      expect(find.byKey(const ValueKey('check-in-stuck')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
