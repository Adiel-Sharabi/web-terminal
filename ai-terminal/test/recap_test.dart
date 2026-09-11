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
import 'package:ai_terminal/widgets/format_utils.dart';
import 'package:ai_terminal/widgets/recap_sheet.dart';
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

  // --- #246: the recent-prompt trail ----------------------------------------
  // "That was not my last prompt. It's critical that this window will show my
  // and only my prompts so I don't lose connection with the session." The card
  // led with a prompt that was 13 hours and 598 turns old and read exactly like
  // a fresh one. The server now sends the newest few; this client has to carry
  // them, and it has to keep working against a server that sends none.
  group('SessionRecap prompts + scan', () {
    test('carries the trail newest-first, and the scan that produced it', () {
      final r = SessionRecap.fromJson(<String, dynamic>{
        'name': 'web-terminal',
        'prompt': {'text': 'the newest', 'at': '2026-09-08T04:41:06Z'},
        'prompts': [
          {'text': 'the newest', 'at': '2026-09-08T04:41:06Z'},
          {'text': 'the middle', 'at': '2026-09-07T15:21:14Z'},
          {'text': 'the oldest', 'at': '2026-09-07T10:00:00Z'},
        ],
        'scan': {'turns': 750, 'exhausted': true},
      });
      expect(r.prompts.map((p) => p.text), ['the newest', 'the middle', 'the oldest']);
      expect(r.prompts.first.text, r.prompt!.text);
      expect(r.scanTurns, 750);
      expect(r.scanExhausted, isTrue);
    });

    test('a server that sends no list yields [prompt], so the trail is empty', () {
      // The additive half, from this side: an older server must render exactly
      // as it did, and `prompts.first` must still be the headline.
      final r = SessionRecap.fromJson(<String, dynamic>{
        'name': 'x',
        'prompt': {'text': 'the only one', 'at': '2026-09-08T04:41:06Z'},
      });
      expect(r.prompts.map((p) => p.text), ['the only one']);
      expect(r.scanTurns, 0);
      expect(r.scanExhausted, isFalse);
    });

    test('no prompt and no list is an empty trail, never a null one', () {
      final r = SessionRecap.fromJson(<String, dynamic>{'name': 'x'});
      expect(r.prompts, isEmpty);
    });

    test('entries with no text are dropped rather than rendered blank', () {
      final r = SessionRecap.fromJson(<String, dynamic>{
        'name': 'x',
        'prompts': [
          {'text': 'kept', 'at': '2026-09-08T04:41:06Z'},
          {'text': ''},
          'nonsense',
        ],
      });
      expect(r.prompts.map((p) => p.text), ['kept']);
    });
  });

  group('RecapPromptTrail', () {
    String isoAgo(Duration d) =>
        DateTime.now().toUtc().subtract(d).toIso8601String();

    testWidgets('shows the OLDER prompts, with their ages, newest excluded',
        (tester) async {
      final recent = isoAgo(const Duration(minutes: 2));
      final stale = isoAgo(const Duration(hours: 13));
      await tester.pumpWidget(_wrap(RecapPromptTrail(prompts: [
        RecapEntry(text: 'the newest, shown in full above', at: recent),
        RecapEntry(text: 'the one before that', at: stale),
        RecapEntry(text: 'and the one before that', at: stale),
      ])));
      // The headline is rendered by the section above; repeating it here would
      // read as having asked the same thing twice.
      expect(find.text('the newest, shown in full above'), findsNothing);
      expect(find.text('the one before that'), findsOneWidget);
      expect(find.text('and the one before that'), findsOneWidget);
      // The whole point: a 13h-old send cannot read like a 2m-old one.
      expect(find.text('13h ago'), findsNWidgets(2));
      expect(find.text('2m ago'), findsNothing);
    });

    testWidgets('the absolute time is available on demand, at no layout cost',
        (tester) async {
      final at = isoAgo(const Duration(hours: 13));
      await tester.pumpWidget(_wrap(RecapPromptTrail(prompts: [
        RecapEntry(text: 'newest', at: at),
        RecapEntry(text: 'older', at: at),
      ])));
      final tip = tester.widget<Tooltip>(find.byType(Tooltip));
      expect(tip.message,
          absoluteTime(DateTime.parse(at).millisecondsSinceEpoch));
    });

    testWidgets('one prompt renders NOTHING — the common case is unchanged',
        (tester) async {
      await tester.pumpWidget(_wrap(RecapPromptTrail(prompts: [
        RecapEntry(text: 'only one', at: isoAgo(const Duration(minutes: 5))),
      ])));
      expect(find.byType(Tooltip), findsNothing);
      expect(find.text('only one'), findsNothing);
    });

    testWidgets('an empty list renders nothing', (tester) async {
      await tester.pumpWidget(_wrap(const RecapPromptTrail(prompts: [])));
      expect(find.byType(Tooltip), findsNothing);
    });

    testWidgets('a long older prompt stays ONE line', (tester) async {
      // Density is the constraint the whole layout is built around: two extra
      // rows, not two extra paragraphs.
      await tester.pumpWidget(_wrap(RecapPromptTrail(prompts: [
        RecapEntry(text: 'newest', at: isoAgo(const Duration(minutes: 1))),
        RecapEntry(
            text: 'a much longer sentence than any single line on a phone can '
                'possibly hold, going on and on well past the edge',
            at: isoAgo(const Duration(hours: 13))),
      ])));
      final row = tester.widget<Text>(find.textContaining('a much longer'));
      expect(row.maxLines, 1);
      expect(row.overflow, TextOverflow.ellipsis);
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
