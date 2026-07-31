// #79: a session blocked on the user says so in the CHAT lens, which previously
// rendered nothing at all for `waiting`.
//
// Why that mattered: for `waiting`, silence is the DEFINING condition — the session
// is blocked and emits no further turn until it is answered — so "no new turns" is
// exactly what a stuck session looks like, and it was indistinguishable from one that
// simply went quiet. The status dot said one thing and the chat lens said nothing.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/waiting_banner.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Map<String, dynamic> _json({String status = 'waiting', Object? waitingFor}) => {
  'id': 'sess-1',
  'name': 'proj',
  'cwd': r'C:\dev\proj',
  'status': status,
  'lastActivity': 1,
  'notifyLevel': 'important',
  if (waitingFor != null) 'waitingFor': waitingFor,
};

Future<void> _pump(WidgetTester tester, String kind) => tester.pumpWidget(
  MaterialApp(
    theme: AppTheme.dark,
    home: Scaffold(body: WaitingBanner(kind: kind)),
  ),
);

void main() {
  group('Session.waitingFor is taken from the server, never re-derived', () {
    test('a captured question', () {
      final s = Session.fromJson(_server(), _json(waitingFor: 'question'));
      expect(s.waitingFor, 'question');
      expect(s.isWaitingOnUser, isTrue);
    });

    test('a permission request — the Codex approval case too', () {
      final s = Session.fromJson(_server(), _json(waitingFor: 'permission'));
      expect(s.waitingFor, 'permission');
      expect(s.isWaitingOnUser, isTrue);
    });

    test('an OLDER server sends nothing — the lens stays silent, it does not guess', () {
      // The status alone says `waiting`, and it would be tempting to infer from it.
      // Doing so would put a second answer in the client for a fact the server owns,
      // and would show a banner naming a kind nobody established.
      final s = Session.fromJson(_server(), _json());
      expect(s.waitingFor, isNull);
      expect(s.isWaitingOnUser, isFalse);
    });

    test('an unknown future kind degrades to "not waiting", not an empty banner', () {
      final s = Session.fromJson(_server(), _json(waitingFor: 'teleporting'));
      expect(s.waitingFor, isNull);
      expect(s.isWaitingOnUser, isFalse);
    });

    test('a session that is not blocked is never waiting', () {
      final s = Session.fromJson(_server(), _json(status: 'working'));
      expect(s.isWaitingOnUser, isFalse);
    });
  });

  group('WaitingBanner', () {
    testWidgets('a question names the answer that is owed', (tester) async {
      await _pump(tester, 'question');
      expect(find.text('Waiting for your answer'), findsOneWidget);
      expect(find.byIcon(Icons.help_outline), findsOneWidget);
    });

    testWidgets('a permission request says so, and says WHERE to answer it', (
      tester,
    ) async {
      await _pump(tester, 'permission');
      expect(find.text('Waiting for your permission'), findsOneWidget);
      expect(find.byIcon(Icons.lock_outline), findsOneWidget);
      // The banner deliberately offers no control of its own, so it must not be a
      // dead end — a permission prompt lives in the agent's TUI.
      expect(
        find.textContaining('Terminal lens'),
        findsOneWidget,
        reason: 'a banner with nowhere to go leaves the user stuck',
      );
    });

    testWidgets('the two kinds do not render the same text', (tester) async {
      await _pump(tester, 'question');
      final q = tester.widget<Text>(find.byKey(const Key('waiting-banner-title'))).data;
      await _pump(tester, 'permission');
      final p = tester.widget<Text>(find.byKey(const Key('waiting-banner-title'))).data;
      expect(q, isNot(p));
    });

    testWidgets('it is announced to screen readers', (tester) async {
      // The whole point is that nothing else changes on screen when a session
      // blocks — no new turn arrives — so a silent visual-only change is exactly
      // the failure mode being fixed, one layer down.
      await _pump(tester, 'question');
      final s = tester.getSemantics(find.byType(WaitingBanner).first);
      expect(s.label, contains('Waiting for your answer'));
    });
  });
}
