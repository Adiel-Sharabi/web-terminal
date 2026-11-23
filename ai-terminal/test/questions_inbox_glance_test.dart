// #492 Phase A - the inbox as the ONE "Needs you" surface, arranged for a glance: the
// header's counts as filters, groups under project headers, Claude's recommendation in
// one press (through the one answer path), the supervisor's cards, "new since you last
// looked", work items that wait on the owner, and the answer panel's number keys.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/services/inbox_seen_store.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_answer_panel.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status,
    headers: {'content-type': 'application/json; charset=utf-8'});

Map<String, dynamic> _item(String ref, String state) =>
    {'ref': ref, 'key': 'o/r$ref', 'title': 'Work $ref', 'state': state};

Map<String, dynamic> _row(String id, String name,
        {String status = 'idle', String? waitingFor, int? lastActivity, String cwd = '/w/alpha', List<Map<String, dynamic>>? items, String? now}) =>
    {
      'id': id,
      'name': name,
      'cwd': cwd,
      'status': status,
      'notifyLevel': 'important',
      'agent': 'claude',
      'waitingFor': waitingFor,
      'lastActivity': lastActivity,
      if (items != null || now != null)
        'brief': {
          'v': 1,
          'reporting': 'on',
          'items': items ?? [],
          if (now != null) 'now': {'text': now, 'at': 1},
        },
    };

Map<String, dynamic> _question(List<String> options, {String id = 't1', bool multi = false}) => {
      'toolUseId': id,
      'questions': [
        {
          'header': 'H',
          'question': 'Which one?',
          'multiSelect': multi,
          'options': [for (final o in options) {'label': o}],
        },
      ],
    };

/// An in-memory [InboxSeenStore].
class _FakeSeen implements InboxSeenStore {
  _FakeSeen(this.stored);
  Map<String, String>? stored;
  final List<Map<String, String>> saves = [];
  @override
  Future<Map<String, String>?> load() async => stored;
  @override
  Future<void> save(Map<String, String> seen) async {
    saves.add(Map.of(seen));
    stored = Map.of(seen);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<Map<String, dynamic>> rows;
  late Map<String, Map<String, dynamic>> questions;
  late Map<String, dynamic>? supervisor; // /api/supervisor/state body, null = 404
  late List<(String, String)> posts; // path, body
  late int cardStatus;
  late List<(String, String)> sent;

  Future<bool> fakeInput(Session s, Future<void> Function(void Function(String keys) send) body) async {
    await body((keys) {
      sent.add((s.id, keys));
      if (keys == '\r') questions.remove(s.id);
    });
    return true;
  }

  ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
        final p = req.url.path;
        final id = RegExp(r'^/api/sessions/([^/]+)/').firstMatch(p)?.group(1);
        if (p.endsWith('/pending-question')) {
          final q = questions[id];
          return _json(q == null ? {'pending': false} : {'pending': true, 'question': q});
        }
        if (p.startsWith('/api/supervisor/cards/')) {
          posts.add((p, req.body));
          return cardStatus == 200 ? _json({'ok': true}) : _json({'refused': 'the session moved on'}, cardStatus);
        }
        switch (p) {
          case '/api/version':
            return _json({'version': '1.88.0', 'serverName': s.name, 'capabilities': ['session-brief']});
          case '/api/sessions':
            return _json(rows);
          case '/api/supervisor/state':
            return supervisor == null ? http.Response('', 404) : _json(supervisor!);
          case '/api/dashboard/background-agents':
            return _json({'available': true, 'agents': []});
        }
        return http.Response('', 404);
      }));

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
    questions = {};
    supervisor = null;
    posts = [];
    cardStatus = 200;
    sent = [];
  });
  tearDown(SessionSelection.instance.reset);

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pump();
    }
  }

  Future<void> pump(WidgetTester tester, SessionRepository r, {double width = 1400, InboxSeenStore? seen}) async {
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
        seenStore: seen ?? _FakeSeen(null),
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

  String key(String id) => '${_home.baseUrl}|$id';
  Finder k(String s) => find.byKey(ValueKey(s));

  testWidgets('a: the glance header counts, and a filter hides the other sections', (tester) async {
    rows = [
      _row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1),
      _row('w1', 'Worker one', status: 'working', now: 'Editing', items: [_item('#1', 'blocked')]),
      _row('w2', 'Worker two', status: 'working', items: [_item('#2', 'ready-for-test'), _item('#3', 'ready-for-test')]),
    ];
    questions = {'q': _question(['A', 'B'])};
    await pump(tester, await repo());
    String count(String f) => tester.widget<Text>(find.descendant(of: k('inbox-glance-$f'), matching: find.byType(Text)).first).data!;
    expect([count('needsYou'), count('running'), count('blocked'), count('toTest')], ['1', '2', '1', '2']);
    expect(find.text('need you'), findsOneWidget);
    expect(k('inbox-blocking'), findsOneWidget);
    expect(k('inbox-workitems'), findsOneWidget);

    await tester.tap(k('inbox-glance-toTest'));
    await tester.pump();
    expect(k('inbox-blocking'), findsNothing, reason: 'the filter shows only what its count counts');
    expect(k('inbox-work-item|o/r#2'), findsOneWidget);
    expect(k('inbox-work-item|o/r#3'), findsOneWidget);
    expect(k('inbox-work-item|o/r#1'), findsNothing, reason: 'blocked is not "to test"');

    await tester.tap(k('inbox-glance-toTest'));
    await tester.pump();
    expect(k('inbox-blocking'), findsOneWidget, reason: 'tapping the active filter returns to all');

    await tester.tap(k('inbox-glance-running'));
    await tester.pump();
    expect(find.text('Editing'), findsOneWidget);
    expect(k('inbox-blocking'), findsNothing);
    await done(tester);
  });

  testWidgets('b: waiting items render in groups under their project header, in order', (tester) async {
    rows = [
      _row('a1', 'A one', status: 'waiting', waitingFor: 'question', lastActivity: 1, cwd: '/w/alpha'),
      _row('b1', 'B one', status: 'waiting', waitingFor: 'question', lastActivity: 2, cwd: '/w/beta'),
      _row('a2', 'A two', status: 'waiting', waitingFor: 'question', lastActivity: 3, cwd: '/w/alpha'),
    ];
    questions = {for (final id in ['a1', 'b1', 'a2']) id: _question(['A', 'B'], id: id)};
    await pump(tester, await repo(), width: 500);
    expect(k('inbox-group-alpha'), findsOneWidget);
    expect(k('inbox-group-beta'), findsOneWidget);
    expect(find.text('2 waiting'), findsOneWidget);
    double y(String s) => tester.getTopLeft(k(s)).dy;
    expect(y('inbox-group-alpha') < y('inbox-card-${key('a1')}'), isTrue);
    expect(y('inbox-card-${key('a1')}') < y('inbox-card-${key('a2')}'), isTrue, reason: 'the alpha group holds both');
    expect(y('inbox-card-${key('a2')}') < y('inbox-group-beta'), isTrue, reason: 'beta comes after the whole alpha group');
    expect(y('inbox-group-beta') < y('inbox-card-${key('b1')}'), isTrue);
    await done(tester);
  });

  group('c: the recommended option in one press', () {
    testWidgets('a marked option is a filled button that sends buildAnswerFrames for it', (tester) async {
      rows = [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)];
      questions = {'q': _question(['Alpha', 'Beta (Recommended)'])};
      final expected = buildAnswerFrames(PendingQuestion.fromJson({'pending': true, 'question': questions['q']})!.questions, [
        {1},
      ]).map((f) => f.keys).toList();
      await pump(tester, await repo());
      final btn = k('inbox-recommended-${key('q')}');
      expect(btn, findsOneWidget);
      expect(find.descendant(of: btn, matching: find.text('Beta')), findsOneWidget, reason: 'the mark is not in the label');
      expect(k('inbox-answer-${key('q')}-1'), findsNothing, reason: 'no duplicate outlined button');
      expect(find.descendant(of: k('inbox-answer-${key('q')}-0'), matching: find.text('Alpha')), findsOneWidget);
      await tester.tap(btn);
      await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 4)));
      await tester.pump(const Duration(seconds: 4));
      expect(sent, [for (final f in expected) ('q', f)], reason: 'the one answer path, nothing re-derived');
      await done(tester);
    });

    testWidgets('a question with no mark has no such button', (tester) async {
      rows = [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)];
      questions = {'q': _question(['Alpha', 'Beta'])};
      await pump(tester, await repo());
      expect(k('inbox-answer-${key('q')}-0'), findsOneWidget);
      expect(k('inbox-recommended-${key('q')}'), findsNothing);
      await done(tester);
    });
  });

  testWidgets('d: a supervisor card renders, and Approve posts the decision to the authority', (tester) async {
    rows = [_row('s1', 'Stuck session', status: 'idle', lastActivity: 5)];
    final now = DateTime.now().millisecondsSinceEpoch;
    supervisor = {
      'role': 'authority',
      'enabled': true,
      'now': now,
      'at': now,
      'cards': [
        {'id': 'c1', 'sessionId': 's1', 'server': 'Home', 'name': 'Stuck session', 'text': 'Type continue', 'why': 'idle for 20 minutes', 'at': now - 1000},
      ],
    };
    await pump(tester, await repo(), width: 500);
    expect(find.text('Type continue'), findsOneWidget);
    expect(find.text('idle for 20 minutes'), findsOneWidget);
    await tester.tap(k('inbox-card-approve-c1'));
    await settle(tester);
    expect(posts, [('/api/supervisor/cards/c1', jsonEncode({'decision': 'approve'}))]);
    expect(find.text('Approved'), findsOneWidget);
    await done(tester);
  });

  group('e: new since you last looked', () {
    Future<void> two(WidgetTester tester, InboxSeenStore store) async {
      rows = [
        _row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1),
        _row('r', 'Later', status: 'waiting', waitingFor: 'question', lastActivity: 2),
      ];
      questions = {'q': _question(['A', 'B'], id: 'tq'), 'r': _question(['A', 'B'], id: 'tr')};
      await pump(tester, await repo(), width: 500, seen: store);
    }

    testWidgets('an item the baseline lacks, or holds with another signature, is marked; a matching one is not',
        (tester) async {
      await two(tester, _FakeSeen({key('q'): 'question|1', key('gone'): 'question|9'}));
      expect(k('inbox-new-${key('r')}'), findsOneWidget);
      expect(k('inbox-new-${key('q')}'), findsNothing);
      expect(find.text('new'), findsOneWidget);
      await done(tester);
      await two(tester, _FakeSeen({key('q'): 'question|0', key('r'): 'question|2'}));
      expect(k('inbox-new-${key('q')}'), findsOneWidget, reason: 'same key, new signature: a new ask');
      expect(k('inbox-new-${key('r')}'), findsNothing);
      await done(tester);
    });

    testWidgets('the first ever look marks nothing, and leaving saves what was listed', (tester) async {
      final store = _FakeSeen(null);
      await two(tester, store);
      expect(find.byType(Text).evaluate().where((e) => (e.widget as Text).data == 'new'), isEmpty);
      await done(tester);
      expect(store.saves, isNotEmpty);
      expect(store.stored!.keys, containsAll([key('q'), key('r')]));
    });
  });

  testWidgets('g: work items waiting on the owner are listed, blocked then ready to test', (tester) async {
    rows = [
      _row('w1', 'Worker one', items: [_item('#1', 'blocked')]),
      _row('w2', 'Worker two', items: [_item('#2', 'ready-for-test'), _item('#9', 'in-progress')]),
    ];
    await pump(tester, await repo(), width: 500);
    expect(k('inbox-workitems'), findsOneWidget);
    expect(k('inbox-work-item|o/r#1'), findsOneWidget);
    expect(k('inbox-work-item|o/r#2'), findsOneWidget);
    expect(k('inbox-work-item|o/r#9'), findsNothing, reason: 'in progress waits on nobody');
    expect(tester.getTopLeft(k('inbox-work-item|o/r#1')).dy < tester.getTopLeft(k('inbox-work-item|o/r#2')).dy, isTrue);
    expect(k('inbox-item-open-item|o/r#1'), findsOneWidget);
    await done(tester);
  });

  group('f: number keys in the answer panel', () {
    PendingQuestion pq({bool multi = false}) => PendingQuestion.fromJson({
          'pending': true,
          'question': _question(['Red', 'Green (Recommended)', 'Blue'], multi: multi),
        })!;

    Future<void> mount(WidgetTester tester, Widget panel) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      tester.view.physicalSize = const Size(1000, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: Scaffold(body: panel)));
      await tester.pumpAndSettle();
    }

    // The platform override must be gone before the test ends (a foundation invariant).
    Future<void> leave(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      debugDefaultTargetPlatformOverride = null;
    }

    testWidgets('a digit picks that option, the mark shows as a chip, and a focused text field keeps its digits',
        (tester) async {
      List<AnswerFrame>? out;
      await mount(tester, QuestionAnswerPanel(question: pq(), autofocus: true, onSend: (f) => out = f, onDismiss: () {}));
      expect(find.text('Green'), findsOneWidget);
      expect(find.text('Green (Recommended)'), findsNothing);
      expect(find.text('Recommended'), findsOneWidget);
      expect(k('option-digit-2'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.digit3);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(out!.map((f) => f.keys), buildAnswerFrames(pq().questions, [
        {2},
      ]).map((f) => f.keys));

      // With the Other field focused, a digit is text and picks nothing.
      out = null;
      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(TextField));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.digit1);
      await tester.pump();
      final red = find.ancestor(of: find.text('Red'), matching: find.byType(InkWell)).first;
      expect(find.descendant(of: red, matching: find.byIcon(Icons.radio_button_unchecked)), findsOneWidget,
          reason: 'option 1 was not picked: the digit went to the field');
      await leave(tester);
    });

    testWidgets('on a multi-select a digit toggles', (tester) async {
      List<AnswerFrame>? out;
      await mount(tester, QuestionAnswerPanel(question: pq(multi: true), autofocus: true, onSend: (f) => out = f, onDismiss: () {}));
      await tester.sendKeyEvent(LogicalKeyboardKey.digit1);
      await tester.sendKeyEvent(LogicalKeyboardKey.numpad3);
      await tester.sendKeyEvent(LogicalKeyboardKey.digit1);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(out!.map((f) => f.keys), buildAnswerFrames(pq(multi: true).questions, [
        {2},
      ]).map((f) => f.keys));
      await leave(tester);
    });
  });
}
