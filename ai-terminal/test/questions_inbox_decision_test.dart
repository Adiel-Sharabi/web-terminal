// #492 Phase B - an agent's decision card in the Questions inbox: the brief's
// `wait.decision` parses tolerantly, a reported wait that carries one renders as a
// card (question, context, options with consequences, the server's recommended one
// filled), and a pick replies `Decision: <label>` through the one reported-reply path.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/screens/session_screen.dart' show buildComposeSubmission;
import 'package:ai_terminal/services/inbox_seen_store.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status,
    headers: {'content-type': 'application/json; charset=utf-8'});

Map<String, dynamic> _decision({int? recommended = 1, List<Object?>? options}) => {
      'question': 'Which cache size?',
      'context': 'First paragraph of context.\nSecond paragraph of context.',
      'options': options ??
          [
            {'label': 'Small (64 MB)', 'consequence': 'Evicts often.'},
            {'label': 'Large (512 MB)', 'consequence': 'Uses more disk.'},
            {'label': 'Ask me later'},
          ],
      'recommended': ?recommended,
    };

Map<String, dynamic> _row(String id, String name, {Map<String, dynamic>? decision, bool wait = true}) => {
      'id': id,
      'name': name,
      'cwd': '/w/alpha',
      'status': 'idle',
      'notifyLevel': 'important',
      'agent': 'claude',
      'lastActivity': 5,
      if (wait) 'reason': {'kind': 'you', 'text': 'pick the cache size', 'source': 'reported', 'since': 1},
      'brief': {
        'v': 1,
        'reporting': 'on',
        'items': [],
        'did': {'text': 'Which cache size?'},
        if (wait) 'wait': {'on': 'you', 'what': 'pick the cache size', 'at': 1, 'decision': ?decision},
      },
    };

class _FakeSeen implements InboxSeenStore {
  @override
  Future<Map<String, String>?> load() async => null;
  @override
  Future<void> save(Map<String, String> seen) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('BriefDecision parsing', () {
    SessionBrief? brief(Object? decision, {String on = 'you'}) => SessionBrief.fromJson({
          'wait': {'on': on, 'what': 'x', 'at': 1, 'decision': decision},
        });

    test('a full decision parses; recommended is the server index', () {
      final d = brief(_decision())!.decision!;
      expect(d.question, 'Which cache size?');
      expect(d.context, contains('Second paragraph'));
      expect(d.options.map((o) => o.label), ['Small (64 MB)', 'Large (512 MB)', 'Ask me later']);
      expect(d.options[0].consequence, 'Evicts often.');
      expect(d.options[2].consequence, isNull);
      expect(d.recommended, 1);
    });
    test('absent wait, absent decision, or a wait that is not on you: null', () {
      expect(SessionBrief.fromJson({'items': []})!.decision, isNull);
      expect(SessionBrief.fromJson({
        'wait': {'on': 'you', 'what': 'x'}
      })!.decision, isNull);
      expect(brief(_decision(), on: 'self')!.decision, isNull);
    });
    test('junk is dropped, never thrown', () {
      for (final bad in <Object?>[
        'text',
        5,
        [],
        {'question': 3, 'options': []},
        {'question': 'q'},
        {'question': '  ', 'options': []},
        {'question': 'q', 'options': 'x'},
        {
          'question': 'q',
          'options': [
            {'label': 'only one'}
          ]
        },
        {
          'question': 'q',
          'options': [
            {'label': 'a'},
            7,
            {'label': ''}
          ]
        },
      ]) {
        expect(brief(bad)!.decision, isNull, reason: '$bad');
      }
    });
    test('recommended out of range or not an int: null', () {
      for (final r in <Object?>[-1, 3, 9, '1', 1.5, null]) {
        final d = brief({..._decision(recommended: null), 'recommended': r})!.decision!;
        expect(d.recommended, isNull, reason: '$r');
      }
    });
    test('a dropped junk option keeps no (shifted) recommendation', () {
      final d = brief(_decision(recommended: 1, options: [
        {'label': 'A'},
        4,
        {'label': 'B'},
        {'label': 'C'},
      ]))!.decision!;
      expect(d.options.map((o) => o.label), ['A', 'B', 'C']);
      expect(d.recommended, isNull);
    });
  });

  late List<Map<String, dynamic>> rows;
  late List<(String, String)> sent;

  ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
        final p = req.url.path;
        if (p.endsWith('/pending-question')) return _json({'pending': false});
        switch (p) {
          case '/api/version':
            return _json({'version': '1.115.0', 'serverName': s.name, 'capabilities': ['session-brief']});
          case '/api/sessions':
            return _json(rows);
          case '/api/dashboard/background-agents':
            return _json({'available': true, 'agents': []});
        }
        return http.Response('', 404);
      }));

  Future<bool> fakeInput(Session s, Future<void> Function(void Function(String keys) send) body) async {
    await body((keys) => sent.add((s.id, keys)));
    return true;
  }

  Future<SessionRepository> repo() async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _home.name, 'baseUrl': _home.baseUrl, 'bearerToken': _home.bearerToken},
      ]),
    });
    final store = ServerStore.forTest();
    await store.init();
    return SessionRepository.forTest(store: store, clientFactory: client);
  }

  setUp(() {
    QuestionDraftStore.instance.resetForTest();
    SessionSelection.instance.reset();
    rows = [];
    sent = [];
  });
  tearDown(SessionSelection.instance.reset);

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pump();
    }
  }

  Future<void> pump(WidgetTester tester, SessionRepository r, {double width = 1400}) async {
    tester.view.physicalSize = Size(width, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: QuestionsInboxScreen(
        repository: r,
        servers: () => [_home],
        clientFactory: client,
        sessionInput: fakeInput,
        seenStore: _FakeSeen(),
        pollInterval: const Duration(hours: 1),
        focusInterval: const Duration(hours: 1),
        agentsInterval: const Duration(hours: 1),
        onOpenSession: (_) {},
      ),
    ));
    await tester.runAsync(() => r.refresh());
    await settle(tester);
  }

  Future<void> done(WidgetTester tester) async {
    final ctx = find.byType(Scaffold).evaluate().firstOrNull;
    if (ctx != null) ScaffoldMessenger.maybeOf(ctx)?.clearSnackBars();
    await tester.pumpWidget(const SizedBox());
  }

  Finder k(String s) => find.byKey(ValueKey(s));

  testWidgets('a decision renders question, context, every option with its consequence; the recommended one is filled',
      (tester) async {
    rows = [_row('d', 'Cache', decision: _decision())];
    await pump(tester, await repo());
    expect(find.text('Which cache size?'), findsWidgets);
    expect(find.text('First paragraph of context.'), findsWidgets);
    expect(find.text('Second paragraph of context.'), findsOneWidget,
        reason: 'the list card clamps to one paragraph; the focused view shows both');
    for (final t in ['Small (64 MB)', 'Large (512 MB)', 'Ask me later', 'Evicts often.', 'Uses more disk.']) {
      expect(find.text(t), findsWidgets, reason: t);
    }
    expect(tester.widget(k('inbox-focus-decision-1')), isA<FilledButton>());
    expect(tester.widget(k('inbox-focus-decision-0')), isA<OutlinedButton>());
    expect(tester.widget(k('inbox-focus-decision-2')), isA<OutlinedButton>());
    expect(find.descendant(of: k('inbox-focus-decision-1'), matching: find.text('Recommended')), findsOneWidget);
    expect(find.text('Recommended'), findsNWidgets(2), reason: 'one chip on the card, one in the focused view');
    expect(k('inbox-focus-reply'), findsOneWidget, reason: 'the free-text reply stays under the options');
    await done(tester);
  });

  testWidgets('no recommended index: nothing is filled or marked', (tester) async {
    rows = [_row('d', 'Cache', decision: _decision(recommended: null))];
    await pump(tester, await repo());
    expect(find.text('Large (512 MB)'), findsWidgets);
    expect(find.text('Recommended'), findsNothing);
    for (var i = 0; i < 3; i++) {
      expect(tester.widget(k('inbox-focus-decision-$i')), isA<OutlinedButton>());
    }
    await done(tester);
  });

  testWidgets('without a decision the old reply UI is unchanged', (tester) async {
    rows = [_row('d', 'Cache')];
    await pump(tester, await repo());
    expect(k('inbox-focus-decision-0'), findsNothing);
    expect(find.text('Recommended'), findsNothing);
    expect(k('inbox-focus-reply'), findsOneWidget);
    expect(find.textContaining('pick the cache size'), findsWidgets, reason: 'the plain Waiting line');
    await done(tester);
  });

  testWidgets('tapping an option replies exactly "Decision: <label>" through the reported reply path', (tester) async {
    rows = [_row('d', 'Cache', decision: _decision())];
    await pump(tester, await repo());
    await tester.tap(k('inbox-focus-decision-0'));
    await settle(tester);
    expect(sent, [('d', buildComposeSubmission('Decision: Small (64 MB)'))]);
    await done(tester);
  });

  testWidgets('a pick on a card that has moved on writes nothing (the reply guard)', (tester) async {
    rows = [_row('d', 'Cache', decision: _decision())];
    await pump(tester, await repo());
    rows = [_row('d', 'Cache', wait: false)];
    await tester.tap(k('inbox-focus-decision-1'));
    await settle(tester);
    expect(sent, isEmpty);
    await done(tester);
  });

  testWidgets('a pick on a card whose session now puts ANOTHER decision writes nothing (gate review #492)', (tester) async {
    rows = [_row('d', 'Cache', decision: _decision())];
    await pump(tester, await repo());
    // Still a "you" wait, so the plain reply guard alone would pass - but another ask.
    rows = [_row('d', 'Cache', decision: {..._decision(), 'question': 'Delete the old branch?'})];
    await tester.tap(k('inbox-focus-decision-0'));
    await settle(tester);
    expect(sent, isEmpty);
    await done(tester);
  });

  testWidgets('control: the same decision re-reported still takes the pick', (tester) async {
    rows = [_row('d', 'Cache', decision: _decision())];
    await pump(tester, await repo());
    rows = [_row('d', 'Cache', decision: _decision())];
    await tester.tap(k('inbox-focus-decision-0'));
    await settle(tester);
    expect(sent, [('d', buildComposeSubmission('Decision: Small (64 MB)'))]);
    await done(tester);
  });

  test('sameAsk: same question and labels; another question or label is another ask', () {
    BriefDecision d(Map<String, dynamic> m) => BriefDecision.fromJson(m)!;
    final a = d(_decision());
    expect(a.sameAsk(d(_decision(recommended: 0))), isTrue, reason: 'a new recommendation is the same ask');
    expect(a.sameAsk(d({..._decision(), 'question': 'Other?'})), isFalse);
    expect(a.sameAsk(d({..._decision(), 'context': 'Another situation.'})), isFalse, reason: 'a generic question, a new ask');
    expect(a.sameAsk(d(_decision(options: [{'label': 'Small (64 MB)'}, {'label': 'Huge'}]))), isFalse);
    expect(a.sameAsk(null), isFalse);
  });

  testWidgets('phone width: the card lays out with no overflow', (tester) async {
    rows = [_row('d', 'Cache', decision: _decision())];
    await pump(tester, await repo(), width: 400);
    expect(tester.takeException(), isNull);
    expect(find.text('Which cache size?'), findsWidgets);
    await done(tester);
  });
}
