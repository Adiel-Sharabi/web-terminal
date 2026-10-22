// #383 - the questions inbox screen against a faked cluster: every write goes through
// the board's own writers (NeedsYouActions) and is refused with ZERO keys when the
// thing it answers has moved on; the words typed here belong to the session, so the
// session screen's overlay sees them; what is fetched, and what never is; and the two
// layouts plus the split view's third pane.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/screens/session_screen.dart' show buildComposeSubmission, questionSignature;
import 'package:ai_terminal/screens/work_board_screen.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 'tok');

/// A JSON reply in UTF-8: `http.Response(String)` encodes Latin-1 and cannot carry Hebrew.
http.Response _json(Object body) => http.Response.bytes(utf8.encode(jsonEncode(body)), 200,
    headers: {'content-type': 'application/json; charset=utf-8'});

Map<String, dynamic> _row(String id, String name,
        {String status = 'idle',
        String? waitingFor,
        Object? reason,
        int? lastActivity,
        String? claudeSessionId,
        Object? brief}) =>
    {
      'id': id,
      'name': name,
      'cwd': '/w',
      'status': status,
      'notifyLevel': 'important',
      'agent': 'claude',
      'waitingFor': waitingFor,
      'reason': reason,
      'lastActivity': lastActivity,
      'claudeSessionId': claudeSessionId,
      'brief': brief,
    };

Map<String, dynamic> _single(String question, {String id = 't1', List<String> options = const ['A', 'B']}) => {
      'toolUseId': id,
      'questions': [
        {
          'header': 'H',
          'question': question,
          'multiSelect': false,
          'options': [for (final o in options) {'label': o}],
        },
      ],
    };

Map<String, dynamic> _previewedMulti() => {
      'toolUseId': 'pm',
      'questions': [
        {
          'header': 'Colour',
          'question': 'Pick a color',
          'multiSelect': false,
          'hasPreview': true,
          'options': [
            {'label': 'Red', 'preview': 'r'},
            {'label': 'Green', 'preview': 'g'},
            {'label': 'Blue', 'preview': 'b'},
          ],
        },
        {
          'header': 'Fruits',
          'question': 'Pick fruits',
          'multiSelect': true,
          'options': [
            {'label': 'Apple'},
            {'label': 'Banana'},
            {'label': 'Cherry'},
          ],
        },
      ],
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, List<Map<String, dynamic>>> rows; // by base URL
  late Map<String, int> sessionsStatus; // by base URL
  late Map<String, Map<String, dynamic>> questions; // by session id
  late int questionStatus;
  late Map<String, Map<String, dynamic>> recaps; // by session id
  late Map<String, int> agentsStatus; // by base URL
  late Map<String, Object> agentsBody; // by base URL
  late List<String> paths; // '<server name> <method> <path>'
  late List<(String, String)> sent;
  late List<ServerConfig> servers;
  late bool answerTakes;

  Future<bool> fakeInput(Session s, Future<void> Function(void Function(String keys) send) body) async {
    await body((keys) {
      sent.add((s.id, keys));
      // The question clears once its confirming Enter lands, unless this session is deaf.
      if (keys == '\r' && answerTakes) questions.remove(s.id);
    });
    return true;
  }

  ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
        final p = req.url.path;
        paths.add('${s.name} ${req.method} $p');
        final id = RegExp(r'^/api/sessions/([^/]+)/').firstMatch(p)?.group(1);
        if (p.endsWith('/pending-question')) {
          if (questionStatus != 200) return http.Response('', questionStatus);
          final q = questions[id];
          return _json(q == null ? {'pending': false} : {'pending': true, 'question': q});
        }
        if (p.endsWith('/recap')) {
          final r = recaps[id];
          return r == null ? http.Response('', 404) : http.Response(jsonEncode(r), 200);
        }
        if (p.endsWith('/transcript')) {
          return http.Response(jsonEncode({'messages': [], 'cursor': null, 'hasMore': false}), 200);
        }
        if (p.endsWith('/attention')) {
          return http.Response(jsonEncode({'kind': 'approval', 'reason': 'Bash: rm -rf build', 'lastMessage': 'About to clean.'}), 200);
        }
        if (p.endsWith('/scrollback')) {
          const data = 'Do you want to run rm -rf build?\r\n1. Yes\r\n2. No\r\n';
          return http.Response(jsonEncode({'data': data, 'total': data.length, 'offset': 0, 'limit': data.length}), 200);
        }
        if (p.endsWith('/brief') && req.method == 'PATCH') {
          return http.Response(jsonEncode({'ok': true}), 200);
        }
        switch (p) {
          case '/api/version':
            return http.Response(
                jsonEncode({'version': '1.88.0', 'serverName': s.name, 'capabilities': ['session-brief', 'session-clear-wait']}),
                200);
          case '/api/sessions':
            final st = sessionsStatus[s.baseUrl] ?? 200;
            if (st != 200) return http.Response('', st);
            return http.Response(jsonEncode(rows[s.baseUrl] ?? const []), 200);
          case '/api/dashboard/background-agents':
            final st = agentsStatus[s.baseUrl] ?? 200;
            if (st != 200) return http.Response('', st);
            return http.Response(jsonEncode(agentsBody[s.baseUrl] ?? {'available': true, 'agents': []}), 200);
        }
        return http.Response('', 404);
      }));

  Future<SessionRepository> repo() async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in servers) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
    });
    final store = ServerStore.forTest();
    await store.init();
    return SessionRepository.forTest(store: store, clientFactory: client);
  }

  setUp(() {
    QuestionDraftStore.instance.resetForTest();
    SessionSelection.instance.reset();
    rows = {};
    sessionsStatus = {};
    questions = {};
    questionStatus = 200;
    recaps = {};
    agentsStatus = {};
    agentsBody = {};
    paths = [];
    sent = [];
    servers = [_home];
    answerTakes = true;
  });
  tearDown(SessionSelection.instance.reset);

  QuestionsInboxScreen screen(SessionRepository r, List<Session> opened, {Duration every = const Duration(hours: 1)}) =>
      QuestionsInboxScreen(
        repository: r,
        servers: () => servers,
        clientFactory: client,
        sessionInput: fakeInput,
        pollInterval: every,
        focusInterval: every,
        agentsInterval: every,
        onOpenSession: opened.add,
      );

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pump();
    }
  }

  Future<void> advance(WidgetTester tester, Duration total) async {
    for (var t = Duration.zero; t < total; t += const Duration(milliseconds: 100)) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<List<Session>> pump(WidgetTester tester, SessionRepository r,
      {double width = 1400, double height = 1000, Duration every = const Duration(hours: 1)}) async {
    final opened = <Session>[];
    tester.view.physicalSize = Size(width, height);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: screen(r, opened, every: every)));
    await tester.runAsync(() => r.refresh());
    await settle(tester);
    return opened;
  }

  Future<void> done(WidgetTester tester) async {
    final ctx = find.byType(Scaffold).evaluate().firstOrNull;
    if (ctx != null) ScaffoldMessenger.maybeOf(ctx)?.clearSnackBars();
    await tester.pumpWidget(const SizedBox());
  }

  Finder inPanel(Finder f) => find.descendant(of: find.byKey(const ValueKey('inbox-question-panel')), matching: f);

  group('answering a question in the inbox', () {
    testWidgets('8.4: a question replaced since it was shown: the panel\'s Send writes ZERO keys', (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      await pump(tester, await repo());
      expect(inPanel(find.text('Pick one')), findsOneWidget, reason: 'a wide pane focuses the oldest wait');
      await tester.tap(inPanel(find.text('A')));
      await tester.pump();
      questions = {'q': _single('Pick another', id: 't2')}; // answered elsewhere, and a new one asked
      await tester.tap(inPanel(find.text('Send answer')));
      await advance(tester, const Duration(seconds: 3));
      expect(sent, isEmpty, reason: 'an answer for the old question must not reach the new one');
      expect(find.text('"Asker" is asking something else now - nothing was sent'), findsOneWidget);
      await done(tester);
    });

    testWidgets('8.5: a previewed multi-question prompt writes exactly buildAnswerFrames, then says it landed',
        (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _previewedMulti()};
      final expected = buildAnswerFrames(PendingQuestion.fromJson({'pending': true, 'question': _previewedMulti()})!.questions, [
        {1},
        {0, 2},
      ]).map((f) => f.keys).toList();
      await pump(tester, await repo());
      expect(find.byKey(const ValueKey('inbox-answer-${'http://h:7681'}|q-0')), findsNothing,
          reason: 'several questions: no one-press buttons on the card');
      await tester.tap(inPanel(find.text('Green')));
      await tester.pump();
      await tester.tap(inPanel(find.text('Fruits')));
      await tester.pump();
      await tester.tap(inPanel(find.text('Apple')));
      await tester.pump();
      await tester.tap(inPanel(find.text('Cherry')));
      await tester.pump();
      await tester.tap(inPanel(find.text('Send answer')));
      await advance(tester, const Duration(seconds: 8));
      expect(sent, [for (final k in expected) ('q', k)], reason: 'the overlay\'s own frames, nothing re-derived');
      expect(find.text('Answered "Asker"'), findsOneWidget);
      await done(tester);
    });

    testWidgets('8.6: words typed here are on the session screen\'s card, and a not-landed answer flags it there',
        (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Which name?')};
      answerTakes = false; // the TUI never takes it: the question stays up
      await pump(tester, await repo());
      await tester.tap(inPanel(find.text('Other\u2026')));
      await tester.pump();
      await tester.enterText(inPanel(find.byType(TextField)), 'call it Atlas');
      await tester.pump();

      final q = PendingQuestion.fromJson({'pending': true, 'question': _single('Which name?')})!;
      final drafts = QuestionDraftStore.instance.of(_home.baseUrl, 'q');
      expect(drafts.key, questionSignature(q));
      expect(drafts.other, contains('call it Atlas'), reason: 'typed in the inbox, kept by the session');

      await tester.tap(inPanel(find.text('Send answer')));
      await advance(tester, const Duration(seconds: 12));
      expect(sent, isNotEmpty);
      expect(drafts.flaggedFor(questionSignature(q)), isTrue, reason: 'flagged at send, never seen to land');
      await done(tester);

      // The session screen's overlay, on the same session's drafts.
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(children: [
            QuestionOverlay(
              question: q,
              drafts: QuestionDraftStore.instance.of(_home.baseUrl, 'q'),
              draftKey: questionSignature(q),
              onSend: (_) {},
              onKey: (_) {},
              onDismiss: () {},
            ),
          ]),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.text('Send again anyway'), findsOneWidget);
      expect(find.text('call it Atlas'), findsWidgets);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('8.9: the focused question goes while words are typed: a banner shows them, the panel stays',
        (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Which name?')};
      await pump(tester, r);
      await tester.tap(inPanel(find.text('Other\u2026')));
      await tester.pump();
      await tester.enterText(inPanel(find.byType(TextField)), 'my long careful answer');
      await tester.pump();

      // Answered in the terminal: the row stops waiting.
      rows = {_home.baseUrl: [_row('q', 'Asker', lastActivity: 2)]};
      questions = {};
      await tester.runAsync(() => r.refresh());
      await settle(tester);

      expect(find.byKey(const ValueKey('inbox-gone-banner')), findsOneWidget);
      expect(tester.widget<SelectableText>(find.byKey(const ValueKey('inbox-gone-words'))).data, 'my long careful answer');
      expect(find.byKey(const ValueKey('inbox-question-panel')), findsOneWidget, reason: 'still mounted under the banner');
      expect(inPanel(find.byType(TextField)), findsOneWidget);
      expect(tester.widget<TextField>(inPanel(find.byType(TextField))).controller!.text, 'my long careful answer');
      // And the caret is still in the box: the person can go on typing.
      expect(tester.widget<EditableText>(inPanel(find.byType(EditableText))).focusNode.hasFocus, isTrue);
      await done(tester);
    });
  });

  group('#383 item 5: an answer that did not land refuses a one-press answer', () {
    Future<void> flag(String sid, Map<String, dynamic> question) async {
      final q = PendingQuestion.fromJson({'pending': true, 'question': question})!;
      final d = QuestionDraftStore.instance.of(_home.baseUrl, sid)..key = questionSignature(q);
      d.markSent(questionSignature(q), buildAnswerFrames(q.questions, [<int>{}], otherText: ['half typed']));
    }

    testWidgets('inbox: the card offers no buttons while flagged, and a press that races the flag writes nothing',
        (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      await pump(tester, await repo(), width: 600);
      final btn = find.byKey(const ValueKey('inbox-answer-http://h:7681|q-0'));
      expect(btn, findsOneWidget);
      await flag('q', _single('Pick one'));
      // Pressed before the card has redrawn: the shared gate refuses it.
      await tester.tap(btn);
      await advance(tester, const Duration(seconds: 3));
      expect(sent, isEmpty);
      expect(find.text('An answer to "Asker" did not land - open it to finish, nothing was sent'), findsOneWidget);
      expect(btn, findsNothing, reason: 'redrawn without its buttons');
      expect(find.byKey(const ValueKey('inbox-answer-blocked-http://h:7681|q')), findsOneWidget);
      await done(tester);
    });

    testWidgets('board: the same gate, with zero writes', (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      final r = await repo();
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: WorkBoardScreen(
          repository: r,
          servers: () => servers,
          clientFactory: client,
          sessionInput: fakeInput,
          pollInterval: const Duration(hours: 1),
          onOpenSession: (_) {},
        ),
      ));
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      final btn = find.byKey(const ValueKey('board-answer-http://h:7681-q-0'));
      expect(btn, findsOneWidget);
      await flag('q', _single('Pick one'));
      await tester.tap(btn);
      await advance(tester, const Duration(seconds: 3));
      expect(sent, isEmpty);
      expect(btn, findsNothing);
      expect(find.byKey(const ValueKey('board-answer-blocked-http://h:7681-q')), findsOneWidget);
      await done(tester);
    });
  });

  group('replies and Esc are re-read first (8.12)', () {
    testWidgets('a reply to a reported wait: sent while it still waits, refused (ZERO writes) once it does not',
        (tester) async {
      final r = await repo();
      final wait = {'kind': 'you', 'text': 'pick a title', 'source': 'reported', 'since': 1};
      rows = {_home.baseUrl: [_row('d', 'Docs', reason: wait, brief: {'v': 1, 'reporting': 'on', 'items': [], 'did': {'text': 'Which title?'}})]};
      await pump(tester, r);
      final box = find.descendant(of: find.byKey(const ValueKey('inbox-focus-reply')), matching: find.byType(TextField));
      final send = find.descendant(of: find.byKey(const ValueKey('inbox-focus-reply')), matching: find.text('Send'));
      await tester.enterText(box, 'Call it Atlas');
      await tester.tap(send);
      await settle(tester);
      expect(sent, [('d', buildComposeSubmission('Call it Atlas'))], reason: 'still waiting: the compose bar\'s own frame');

      sent.clear();
      rows = {_home.baseUrl: [_row('d', 'Docs', reason: null, brief: {'v': 1, 'reporting': 'on', 'items': []})]};
      // The card on screen is a poll old: it still shows the wait.
      await tester.enterText(box, 'too late');
      await tester.tap(send);
      await settle(tester);
      expect(sent, isEmpty);
      expect(find.text('"Docs" is no longer waiting on you - nothing was sent'), findsWidgets);
      await done(tester);
    });

    testWidgets('Esc to a menu: sent while the menu is up, refused (ZERO writes) once it is not', (tester) async {
      final r = await repo();
      final menu = {'kind': 'menu', 'text': '', 'source': 'status', 'since': 1};
      rows = {_home.baseUrl: [_row('e', 'Menu one', reason: menu)]};
      await pump(tester, r);
      await tester.tap(find.byKey(const ValueKey('inbox-esc')));
      await settle(tester);
      expect(sent, [('e', '\x1b')]);

      sent.clear();
      rows = {_home.baseUrl: [_row('e', 'Menu one')]};
      await tester.tap(find.byKey(const ValueKey('inbox-esc')));
      await settle(tester);
      expect(sent, isEmpty);
      expect(find.text('"Menu one" no longer shows a menu - Esc was not sent'), findsOneWidget);
      await done(tester);
    });
  });

  testWidgets('a permission says which tool waits (the board line), not the generic notification', (tester) async {
    rows = {
      _home.baseUrl: [
        _row('p', 'Cleanup', status: 'waiting', waitingFor: 'permission', lastActivity: 1, brief: {
          'v': 1,
          'reporting': 'on',
          'items': [],
          'now': {'text': 'Bash - rm -rf dist', 'at': 1},
        }),
      ],
    };
    await pump(tester, await repo());
    final card = find.byKey(const ValueKey('inbox-card-http://h:7681|p'));
    expect(find.descendant(of: card, matching: find.textContaining('Bash - rm -rf dist', findRichText: true)), findsOneWidget);
    expect(find.descendant(of: card, matching: find.textContaining('Bash: rm -rf build', findRichText: true)), findsNothing);
    await done(tester);
  });

  testWidgets('8.10: empty, with a server offline, says so rather than "nothing" alone', (tester) async {
    servers = [_home, _office];
    sessionsStatus = {_office.baseUrl: 500};
    final r = await repo();
    await pump(tester, r);
    await tester.runAsync(() => r.refresh()); // offline is confirmed on the second failed round
    await settle(tester);
    expect(find.text('Nothing is waiting for you.'), findsOneWidget);
    expect(find.text('Office is offline, so its questions can\'t be shown.'), findsOneWidget);
    await done(tester);
  });

  testWidgets('8.13: background agents - a 404 server is skipped for good; a waiting row is an item; Open when it maps',
      (tester) async {
    servers = [_home, _office];
    agentsStatus = {_home.baseUrl: 404};
    rows = {_office.baseUrl: [_row('pty', 'Notes', claudeSessionId: 'abc')]};
    agentsBody = {
      _office.baseUrl: {
        'available': true,
        'agents': [
          {'id': 'a1', 'sessionId': 'abc', 'name': 'lint-fix', 'cwdTail': 'repo', 'waitingFor': 'approve the plan', 'startedAt': 1},
          {'id': 'a2', 'sessionId': 'zzz', 'name': 'docs-bot', 'waitingFor': 'pick a file', 'startedAt': 2},
          {'id': 'a3', 'name': 'busy', 'startedAt': 3},
        ],
      },
    };
    final r = await repo();
    final opened = await pump(tester, r, width: 1400);
    await tester.tap(find.byKey(const ValueKey('inbox-refresh')));
    await settle(tester);
    expect(paths.where((p) => p == 'Home GET /api/dashboard/background-agents'), hasLength(1),
        reason: 'a 404 is remembered for the life of the screen');
    expect(paths.where((p) => p == 'Office GET /api/dashboard/background-agents'), hasLength(2));
    expect(find.byKey(const ValueKey('inbox-card-http://o:7681|agent|a1')), findsOneWidget);
    expect(find.byKey(const ValueKey('inbox-card-http://o:7681|agent|a2')), findsOneWidget);
    expect(find.byKey(const ValueKey('inbox-card-http://o:7681|agent|a3')), findsNothing, reason: 'not waiting');
    expect(find.byType(SnackBar), findsNothing, reason: 'a 404 is not an error');

    // The first (oldest) is focused: it runs Notes' conversation, so it opens Notes.
    await tester.tap(find.byKey(const ValueKey('inbox-open-session')));
    await tester.pump();
    expect(opened.single.id, 'pty');

    await tester.tap(find.byKey(const ValueKey('inbox-open-http://o:7681|agent|a2')));
    await settle(tester);
    expect(find.byKey(const ValueKey('inbox-open-session')), findsNothing);
    expect(find.byKey(const ValueKey('inbox-agent-elsewhere')), findsOneWidget);
    await done(tester);
  });

  testWidgets('8.14: pending-question only for question rows; a recap once per activity',
      (tester) async {
    final r = await repo();
    rows = {
      _home.baseUrl: [
        _row('p', 'Perm', status: 'waiting', waitingFor: 'permission', lastActivity: 1),
        _row('d', 'Reported', reason: {'kind': 'you', 'text': 'x', 'source': 'reported'}, lastActivity: 2),
        _row('c', 'Idle', lastActivity: 100),
      ],
    };
    recaps = {
      'c': {'name': 'Idle', 'cwd': '/w', 'status': 'idle', 'reply': {'text': 'Shall I go on?', 'at': 'x'}},
    };
    await pump(tester, r);
    await tester.runAsync(() => r.refresh());
    await settle(tester);
    expect(paths.where((p) => p.endsWith('/pending-question')), isEmpty, reason: 'no row is a question');
    expect(paths.where((p) => p.endsWith('/c/recap')), hasLength(1), reason: 'once per lastActivity, not per poll');
    expect(paths.where((p) => p.endsWith('/p/recap') || p.endsWith('/d/recap')), isEmpty);
    expect(find.byKey(const ValueKey('inbox-card-http://h:7681|c')), findsOneWidget, reason: 'it asks in prose');

    rows = {
      _home.baseUrl: [
        ...rows[_home.baseUrl]!.where((x) => x['id'] != 'c'),
        _row('c', 'Idle', lastActivity: 200),
      ],
    };
    await tester.runAsync(() => r.refresh());
    await settle(tester);
    expect(paths.where((p) => p.endsWith('/c/recap')), hasLength(2), reason: 'new activity, read again');
    await done(tester);
  });

  testWidgets('8.14: a closed inbox asks nothing more, on its timers or on a session update', (tester) async {
    final r = await repo();
    rows = {
      _home.baseUrl: [
        _row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1),
        _row('m', 'Menu', reason: {'kind': 'menu', 'text': '', 'source': 'status', 'since': 2}),
      ],
    };
    questions = {'q': _single('Pick one')};
    await pump(tester, r, every: const Duration(seconds: 1));
    // Positive control: while open, its timers read the focused item again.
    paths.clear();
    await advance(tester, const Duration(seconds: 3));
    await settle(tester);
    expect(paths.where((p) => !p.endsWith('/api/sessions') && !p.endsWith('/api/version')), isNotEmpty,
        reason: 'the control: open, it does ask');

    await tester.pumpWidget(const SizedBox());
    paths.clear();
    await tester.runAsync(() => r.refresh());
    await advance(tester, const Duration(seconds: 10));
    await settle(tester);
    expect(paths.where((p) => !p.endsWith('/api/sessions') && !p.endsWith('/api/version')), isEmpty,
        reason: 'a disposed inbox asks nothing');
  });

  group('layout (8.15)', () {
    testWidgets('wide: the list and the focused item side by side', (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      await pump(tester, await repo(), width: 1400);
      final list = tester.getRect(find.byKey(const ValueKey('inbox-list')));
      final pane = tester.getRect(find.byKey(const ValueKey('inbox-focus-pane')));
      expect(list.width, kInboxListWidth);
      expect(pane.left, greaterThan(list.right - 1));
      expect(find.byKey(const ValueKey('inbox-question-panel')), findsOneWidget);
      await done(tester);
    });

    testWidgets('narrow: the list only, and a tap pushes the focused view', (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      await pump(tester, await repo(), width: 420, height: 900);
      expect(find.byKey(const ValueKey('inbox-focus-pane')), findsNothing);
      expect(find.byKey(const ValueKey('inbox-question-panel')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('inbox-open-http://h:7681|q')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('inbox-question-panel')), findsOneWidget);
      expect(find.byType(BackButton), findsOneWidget);
      await done(tester);
    });

    testWidgets('split view: DetailPane.inbox shows the inbox beside the rail', (tester) async {
      final r = await repo();
      tester.view.physicalSize = const Size(1600, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: AdaptiveHome(
          boardBuilder: (open) => WorkBoardScreen(
              embedded: true,
              onOpenSession: open,
              repository: r,
              servers: () => servers,
              clientFactory: client,
              pollInterval: const Duration(hours: 1),
              onOpenInbox: SessionSelection.instance.showInbox),
          inboxBuilder: (open) => QuestionsInboxScreen(
              embedded: true,
              onOpenSession: open,
              repository: r,
              servers: () => servers,
              clientFactory: client,
              pollInterval: const Duration(hours: 1),
              focusInterval: const Duration(hours: 1),
              agentsInterval: const Duration(hours: 1)),
        ),
      ));
      await tester.pump();
      expect(find.byType(WorkBoardScreen), findsOneWidget);
      // The board's Needs-you column links to it.
      await tester.tap(find.byKey(const ValueKey('board-open-inbox')));
      await tester.pump();
      expect(SessionSelection.instance.pane.value, DetailPane.inbox);
      expect(find.byType(QuestionsInboxScreen), findsOneWidget);
      expect(find.byType(WorkBoardScreen), findsNothing);
      expect(find.byType(BackButton), findsNothing, reason: 'beside the list there is nothing to go back to');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  });

  testWidgets('RTL (#383 item 6): a Hebrew question and option read right to left; so does a Hebrew reply',
      (tester) async {
    final he = String.fromCharCodes([0x05D0, 0x05D9, 0x05D6, 0x05D4, 0x0020, 0x05E9, 0x05DD, 0x003F]);
    final opt = String.fromCharCodes([0x05DB, 0x05DF]);
    rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
    questions = {'q': _single(he, options: [opt, 'English'])};
    await pump(tester, await repo());
    Text text(String s) => tester.widget<Text>(inPanel(find.text(s)));
    expect(text(he).textDirection, TextDirection.rtl);
    expect(text(opt).textDirection, TextDirection.rtl);
    expect(text('English').textDirection, TextDirection.ltr);
    // The card: the line reads right to left, and its English label is an isolated
    // left-to-right run, so it shows as "Question:", never ":Question".
    final card = tester.widget<RichText>(find.descendant(
        of: find.byKey(const ValueKey('inbox-card-http://h:7681|q')),
        matching: find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains(he))));
    expect(card.textDirection, TextDirection.rtl);
    expect(card.text.toPlainText(), startsWith(String.fromCharCodes([0x2066, ...'Question:'.codeUnits, 0x2069])));
    await done(tester);

    rows = {_home.baseUrl: [_row('d', 'Docs', reason: {'kind': 'you', 'text': 'x', 'source': 'reported'})]};
    await pump(tester, await repo());
    final box = find.descendant(of: find.byKey(const ValueKey('inbox-focus-reply')), matching: find.byType(TextField));
    expect(tester.widget<TextField>(box).textDirection, TextDirection.ltr);
    await tester.enterText(box, opt);
    await tester.pump();
    expect(tester.widget<TextField>(box).textDirection, TextDirection.rtl);
    await done(tester);
  });
}
