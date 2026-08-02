// The session recap on the companion: the wire shape and the card's icon.
//
// The RULES (which user turn was actually typed, what to condense, which task is
// current) are the server's and are tested in tests/recap.spec.js. What matters
// here is that this client carries the answer faithfully and degrades the way the
// endpoint promises: a session with no transcript still yields a usable card
// rather than an error or an empty one.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/session_card.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session() => Session(
      id: 'abc12345',
      name: 'my-project',
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      server: _server(),
      autoCommand: '',
    );

Widget _wrap(Widget child) => MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(body: child),
    );

void main() {
  group('SessionRecap.fromJson', () {
    test('carries the full card', () {
      final r = SessionRecap.fromJson(<String, dynamic>{
        'name': 'web-terminal',
        'cwd': 'C:\\dev\\web-terminal',
        'status': 'working',
        'agent': 'codex',
        'lastActivity': 1735000000000,
        'waitingFor': 'permission',
        'prompt': {'text': 'why is the terminal blank?', 'at': '2026-08-02T10:00:00Z'},
        'reply': {'text': 'The scroll aliased its lines.', 'at': '2026-08-02T10:05:00Z', 'isSummary': true},
        'since': {'turns': 3, 'tools': ['Edit ×2', 'Bash']},
        'tasks': {'done': 1, 'total': 3, 'current': 'Wire the endpoint', 'currentIsActive': true},
      });
      expect(r.name, 'web-terminal');
      expect(r.agent, 'codex');
      expect(r.waitingFor, 'permission');
      expect(r.prompt!.text, 'why is the terminal blank?');
      expect(r.reply!.isSummary, isTrue);
      expect(r.sinceTurns, 3);
      expect(r.tools, ['Edit ×2', 'Bash']);
      expect(r.tasks!.done, 1);
      expect(r.tasks!.current, 'Wire the endpoint');
      expect(r.tasks!.currentIsActive, isTrue);
    });

    test('a session with no transcript still yields a usable card', () {
      // The degrade contract. name/cwd/status alone are enough to orient you, so
      // this must NOT be treated as a failure by the client.
      final r = SessionRecap.fromJson(<String, dynamic>{
        'name': 'plain-shell',
        'cwd': '/home/x',
        'status': 'idle',
        'agent': null,
        'prompt': null,
        'reply': null,
        'since': {'turns': 0, 'tools': []},
        'tasks': null,
      });
      expect(r.name, 'plain-shell');
      expect(r.prompt, isNull);
      expect(r.reply, isNull);
      expect(r.sinceTurns, 0);
      expect(r.tools, isEmpty);
      expect(r.tasks, isNull);
    });

    test('a malformed or absent `since` never throws', () {
      final r = SessionRecap.fromJson(<String, dynamic>{'name': 'x'});
      expect(r.sinceTurns, 0);
      expect(r.tools, isEmpty);
    });
  });

  group('RecapEntry.fromJson', () {
    test('an empty text is null, so the section is omitted rather than blank', () {
      expect(RecapEntry.fromJson({'text': ''}), isNull);
      expect(RecapEntry.fromJson(null), isNull);
      expect(RecapEntry.fromJson('nonsense'), isNull);
    });

    test('isSummary defaults to false', () {
      expect(RecapEntry.fromJson({'text': 'hi'})!.isSummary, isFalse);
    });
  });

  group('RecapTasks.fromJson', () {
    test('an empty list is null so no progress bar renders', () {
      expect(RecapTasks.fromJson({'done': 0, 'total': 0}), isNull);
      expect(RecapTasks.fromJson(null), isNull);
    });
  });

  group('SessionCard recap icon', () {
    testWidgets('is offered when a handler is given', (tester) async {
      var taps = 0;
      await tester.pumpWidget(_wrap(SessionCard(
        session: _session(),
        onRecapTap: () => taps++,
      )));
      final icon = find.byIcon(Icons.chat_outlined);
      expect(icon, findsOneWidget);
      await tester.tap(icon);
      await tester.pump();
      expect(taps, 1);
    });

    testWidgets('tapping it does NOT also open the session', (tester) async {
      // The behaviour that makes the feature worth having: peek without leaving.
      var opened = 0;
      var recaps = 0;
      await tester.pumpWidget(_wrap(SessionCard(
        session: _session(),
        onTap: () => opened++,
        onRecapTap: () => recaps++,
      )));
      await tester.tap(find.byIcon(Icons.chat_outlined));
      await tester.pump();
      expect(recaps, 1);
      expect(opened, 0, reason: 'a recap must never navigate away');
    });

    testWidgets('is hidden when no handler is given', (tester) async {
      await tester.pumpWidget(_wrap(SessionCard(session: _session())));
      expect(find.byIcon(Icons.chat_outlined), findsNothing);
    });
  });
}
