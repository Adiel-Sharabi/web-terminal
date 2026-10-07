// #313 / #315 — the reason a non-working session is not working, and the machine's
// colour, on the session LIST. The server decides both; these pin that the client
// parses them defensively, draws the reason in place of the bare status word (and
// nothing when there is none), gives a background command an age, and marks a stale
// leftover shell as stale rather than as a live build.
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

Future<void> _pumpCard(WidgetTester tester, Session s) => tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(body: SessionCard(session: s, onTap: () {})),
    ));

void main() {
  group('parsing', () {
    test('reason: known kinds parse, an unknown kind is no reason at all', () {
      expect(_s({'reason': {'kind': 'you', 'text': 'reconnect the rig', 'source': 'reported'}}).reason!.text, 'reconnect the rig');
      expect(_s({'reason': {'kind': 'menu'}}).reason, isNull);
      expect(_s({'reason': 'you'}).reason, isNull);
      expect(_s({}).reason, isNull);
    });

    test('background: the oldest LIVE start, and stale only when every task is stale', () {
      final live = _s({'backgroundTasks': [
        {'id': 'a', 'description': 'build', 'startedAt': 2000},
        {'id': 'b', 'description': 'tests', 'startedAt': 1000},
        {'id': 'c', 'description': 'shell command', 'startedAt': 10, 'stale': true},
      ]});
      expect(live.backgroundSince, 1000);
      expect(live.backgroundStale, isFalse);
      final stale = _s({'backgroundTasks': [{'id': 'p', 'description': 'shell command', 'startedAt': 10, 'stale': true}]});
      expect(stale.backgroundStale, isTrue);
      expect(stale.backgroundSince, isNull);
    });

    test('serverColor: only #rrggbb survives; it converts to a Color', () {
      expect(ServerInfo.fromJson({'version': '1', 'serverColor': '#E27BF5'}).serverColor, '#E27BF5');
      expect(ServerInfo.fromJson({'version': '1', 'serverColor': 'red; background:url(x)'}).serverColor, isNull);
      expect(colorFromHex('#E27BF5'), const Color(0xFFE27BF5));
      expect(colorFromHex(null), isNull);
    });

    test('hidden rides the brief', () {
      expect(SessionBrief.fromJson({'hidden': true})!.hidden, isTrue);
      expect(SessionBrief.fromJson({})!.hidden, isFalse);
    });
  });

  group('reasonLabel', () {
    final now = DateTime.fromMillisecondsSinceEpoch(10 * 60 * 1000);
    test('each kind reads as the design says', () {
      expect(reasonLabel(const SessionReason(kind: 'you', text: 'say done 1')), 'You: say done 1');
      expect(reasonLabel(const SessionReason(kind: 'you')), 'Your move');
      expect(reasonLabel(const SessionReason(kind: 'self', text: 'CI checks', since: 0), now: now), 'CI checks · 10m');
      expect(reasonLabel(const SessionReason(kind: 'external', text: 'reviewer')), 'Blocked: reviewer');
      expect(reasonLabel(const SessionReason(kind: 'done', text: 'pushed')), 'Done');
      expect(hasReasonChip(const SessionReason(kind: 'working')), isFalse);
    });
  });

  group('SessionCard', () {
    testWidgets('a reason replaces the status word', (tester) async {
      await _pumpCard(tester, _s({'reason': {'kind': 'external', 'text': 'vendor', 'source': 'reported'}}));
      expect(find.text('Blocked: vendor'), findsOneWidget);
      expect(find.text('Idle'), findsNothing);
    });

    testWidgets('no reason renders exactly the status word, as before', (tester) async {
      await _pumpCard(tester, _s({}));
      expect(find.text('Idle'), findsOneWidget);
      expect(find.byType(ReasonChip), findsNothing);
    });

    testWidgets('a stale leftover shell is marked stale, not shown as running', (tester) async {
      await _pumpCard(tester, _s({'backgroundTasks': [{'id': 'p', 'description': 'shell command', 'startedAt': 10, 'stale': true}]}));
      expect(find.text('stale shell'), findsOneWidget);
      expect(find.textContaining('shell command'), findsNothing);
    });

    testWidgets('a live background command carries its age', (tester) async {
      final start = DateTime.now().millisecondsSinceEpoch - 12 * 60 * 1000;
      await _pumpCard(tester, _s({'backgroundTasks': [{'id': 'b', 'description': 'build', 'startedAt': start}]}));
      expect(find.textContaining('build · 12m'), findsOneWidget);
    });

    testWidgets('when the reason IS the background work, it shows once', (tester) async {
      await _pumpCard(tester, _s({
        'backgroundTasks': [{'id': 'b', 'description': 'build', 'startedAt': DateTime.now().millisecondsSinceEpoch}],
        'reason': {'kind': 'self', 'text': 'build', 'source': 'background'},
      }));
      expect(find.byType(ReasonChip), findsOneWidget);
      expect(find.byIcon(Icons.sync), findsNothing);
    });
  });
}
