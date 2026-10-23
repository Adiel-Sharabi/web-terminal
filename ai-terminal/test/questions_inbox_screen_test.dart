// #383 - the questions inbox screen against a faked cluster: every write goes through
// the board's own writers (NeedsYouActions) and is refused with ZERO keys when the
// thing it answers has moved on; the words typed here belong to the session, so the
// session screen's overlay sees them; what is fetched, and what never is; and the two
// layouts plus the split view's third pane.
import 'dart:async';
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
import 'package:ai_terminal/widgets/question_answer_panel.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
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

/// A transcript whose current turn is [text], after a prompt the person typed.
List<Map<String, dynamic>> _reply(String text, {String at = 'x'}) => [
      {'role': 'user', 'text': 'go on', 'typedText': 'go on', 'userKind': 'human', 'toolUses': []},
      {'role': 'assistant', 'text': text, 'toolUses': [], 'ts': at},
    ];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, List<Map<String, dynamic>>> rows; // by base URL
  late Map<String, int> sessionsStatus; // by base URL
  late Map<String, Map<String, dynamic>> questions; // by session id
  late int questionStatus;
  late Map<String, List<Map<String, dynamic>>> transcripts; // turns by session id
  late Map<String, int> agentsStatus; // by base URL
  late Map<String, Object> agentsBody; // by base URL
  late List<String> paths; // '<server name> <method> <path>'
  late List<(String, String)> sent;
  late List<ServerConfig> servers;
  late bool answerTakes;
  late int failPolls; // pending-question polls still to fail with a 500
  late bool failPollAfterKeys; // the first key sent arms one failing poll
  Completer<void>? sessionsGate; // holds the NEXT /api/sessions until completed
  late List<Completer<void>> transcriptHolds; // each holds the next transcript read, in order

  Future<bool> fakeInput(Session s, Future<void> Function(void Function(String keys) send) body) async {
    await body((keys) {
      sent.add((s.id, keys));
      if (failPollAfterKeys) {
        failPollAfterKeys = false;
        failPolls = 1;
      }
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
          if (failPolls > 0) {
            failPolls--;
            return http.Response('', 500);
          }
          final q = questions[id];
          return _json(q == null ? {'pending': false} : {'pending': true, 'question': q});
        }
        if (p.endsWith('/transcript')) {
          final t = transcripts[id]; // what the transcript held when it was asked
          if (transcriptHolds.isNotEmpty) await transcriptHolds.removeAt(0).future;
          return t == null
              ? http.Response('', 404)
              : http.Response(jsonEncode({'messages': t, 'cursor': null, 'hasMore': false}), 200);
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
            final gate = sessionsGate;
            if (gate != null) {
              sessionsGate = null;
              await gate.future;
            }
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
    transcripts = {};
    agentsStatus = {};
    agentsBody = {};
    paths = [];
    sent = [];
    servers = [_home];
    answerTakes = true;
    failPolls = 0;
    failPollAfterKeys = false;
    sessionsGate = null;
    transcriptHolds = [];
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

  testWidgets('8.14: pending-question only for question rows; a turn once per activity',
      (tester) async {
    final r = await repo();
    rows = {
      _home.baseUrl: [
        _row('p', 'Perm', status: 'waiting', waitingFor: 'permission', lastActivity: 1),
        _row('d', 'Reported', reason: {'kind': 'you', 'text': 'x', 'source': 'reported'}, lastActivity: 2),
        _row('c', 'Idle', lastActivity: 100),
      ],
    };
    transcripts = {'c': _reply('Shall I go on?')};
    await pump(tester, r);
    await tester.runAsync(() => r.refresh());
    await settle(tester);
    expect(paths.where((p) => p.endsWith('/pending-question')), isEmpty, reason: 'no row is a question');
    expect(paths.where((p) => p.endsWith('/c/transcript')), hasLength(1), reason: 'once per lastActivity, not per poll');
    expect(paths.where((p) => p.endsWith('/d/transcript')), hasLength(1), reason: 'a reported wait: its last reply, once');
    expect(paths.where((p) => p.endsWith('/p/transcript')), hasLength(1), reason: 'a permission: once per wait');
    expect(paths.where((p) => p.endsWith('/recap')), isEmpty, reason: 'the transcript replaced the recap');
    expect(find.byKey(const ValueKey('inbox-card-http://h:7681|c')), findsOneWidget, reason: 'it asks in prose');

    rows = {
      _home.baseUrl: [
        ...rows[_home.baseUrl]!.where((x) => x['id'] != 'c'),
        _row('c', 'Idle', lastActivity: 200),
      ],
    };
    await tester.runAsync(() => r.refresh());
    await settle(tester);
    expect(paths.where((p) => p.endsWith('/c/transcript')), hasLength(2), reason: 'new activity, read again');
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
    // left-to-right run, so it shows as "Question - H:", never ":Question". H is the
    // question's own header.
    final card = tester.widget<RichText>(find.descendant(
        of: find.byKey(const ValueKey('inbox-card-http://h:7681|q')),
        matching: find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains(he))));
    expect(card.textDirection, TextDirection.rtl);
    expect(card.text.toPlainText(), startsWith(String.fromCharCodes([0x2066, ...'Question - H:'.codeUnits, 0x2069])));
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

  group('review round N: nothing is written on a stale or doubtful reading', () {
    final reported = {'kind': 'you', 'text': 'pick a title', 'source': 'reported', 'since': 1};
    Map<String, dynamic> docs({String status = 'idle', String? waitingFor, Object? reason}) =>
        _row('d', 'Docs', status: status, waitingFor: waitingFor, reason: reason, brief: {
          'v': 1,
          'reporting': 'on',
          'items': [],
          'did': {'text': 'Which title?'},
        });
    Finder replyField() => find.descendant(of: find.byKey(const ValueKey('inbox-focus-reply')), matching: find.byType(TextField));
    Finder replySend() => find.descendant(of: find.byKey(const ValueKey('inbox-focus-reply')), matching: find.text('Send'));

    for (final selector in ['permission', 'question']) {
      testWidgets('F1: a reported wait that has become a $selector selector gets ZERO writes', (tester) async {
        final r = await repo();
        rows = {_home.baseUrl: [docs(reason: reported)]};
        await pump(tester, r);
        // Server side only: the card on screen is a poll old and still shows the wait.
        // The server says `kind: you` for a waiting row too, so the kind alone passes.
        rows = {
          _home.baseUrl: [
            docs(status: 'waiting', waitingFor: selector, reason: {
              'kind': 'you',
              'text': selector == 'question' ? 'answer a question' : 'approve a tool',
              'source': 'status',
            }),
          ],
        };
        await tester.enterText(replyField(), 'Call it Atlas');
        await tester.tap(replySend());
        await settle(tester);
        await settle(tester);
        expect(sent, isEmpty, reason: 'a reply\'s text and CR in a selector would answer it');
        expect(find.text('"Docs" is no longer waiting on you - nothing was sent'), findsOneWidget);
        await done(tester);
      });
    }

    testWidgets('F1: a "you" the server keeps while a helper runs (status working) still takes the reply',
        (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [docs(reason: reported)]};
      await pump(tester, r);
      rows = {_home.baseUrl: [docs(status: 'working', reason: reported)]};
      await tester.enterText(replyField(), 'Call it Atlas');
      await tester.tap(replySend());
      await settle(tester);
      await settle(tester);
      expect(sent, [('d', buildComposeSubmission('Call it Atlas'))], reason: 'a prompt typed mid-turn is queued (#249)');
      await done(tester);
    });

    testWidgets('F2: a re-read whose server did not answer refuses, though its stale row still says "you"',
        (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [docs(reason: reported)]};
      await pump(tester, r);
      sessionsStatus = {_home.baseUrl: 500}; // the repository falls back to the last-known row
      await tester.enterText(replyField(), 'Call it Atlas');
      await tester.tap(replySend());
      await settle(tester);
      await settle(tester);
      expect(sent, isEmpty);
      expect(find.text('Could not check "Docs" - nothing was sent'), findsOneWidget);
      await done(tester);
    });

    testWidgets('F3: two presses during a slow re-read write exactly once', (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [docs(reason: reported)]};
      await pump(tester, r);
      final gate = Completer<void>();
      sessionsGate = gate; // the first press's re-read hangs on a slow peer
      await tester.enterText(replyField(), 'Call it Atlas');
      await tester.tap(replySend());
      await tester.pump();
      await tester.tap(replySend(), warnIfMissed: false);
      await tester.pump();
      gate.complete();
      await settle(tester);
      await settle(tester);
      expect(sent, [('d', buildComposeSubmission('Call it Atlas'))]);
      await done(tester);
    });

    testWidgets('F5: a verify poll that throws is not "Answered", and the buttons come back once it is seen still up',
        (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      answerTakes = false; // still asked afterwards
      failPollAfterKeys = true; // the verify's poll fails: whether it took is unknown
      await pump(tester, await repo());
      final btn = find.byKey(const ValueKey('inbox-answer-http://h:7681|q-0'));
      await tester.tap(btn);
      await advance(tester, const Duration(seconds: 12));
      await settle(tester);
      expect(sent, isNotEmpty, reason: 'the keys did go out');
      expect(find.text('Answered "Asker"'), findsNothing, reason: 'a failed poll observed nothing');
      expect(find.text('Answer sent - waiting for it to land...'), findsNothing,
          reason: 'a later read saw it still asked: not "landing" for good');
      expect(btn, findsOneWidget, reason: 'back to the not-landed state: its buttons');
      await done(tester);
    });

    testWidgets('F7: the focused question becomes a prose item while words are typed: the banner keeps them',
        (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Which name?')};
      await pump(tester, r);
      await tester.tap(inPanel(find.text('Other\u2026')));
      await tester.pump();
      await tester.enterText(inPanel(find.byType(TextField)), 'my long careful answer');
      await tester.pump();

      // Answered in the terminal, and the agent's reply now asks in prose: the SAME
      // session is still an item, of another kind.
      rows = {_home.baseUrl: [_row('q', 'Asker', lastActivity: 2)]};
      questions = {};
      transcripts = {'q': _reply('Shall I call it Atlas?')};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-card-http://h:7681|q')), findsOneWidget, reason: 'now a prose item');
      expect(find.byKey(const ValueKey('inbox-gone-banner')), findsOneWidget);
      expect(tester.widget<SelectableText>(find.byKey(const ValueKey('inbox-gone-words'))).data, 'my long careful answer');

      await tester.tap(find.byKey(const ValueKey('inbox-gone-next')));
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-gone-banner')), findsNothing);
      expect(find.byKey(const ValueKey('inbox-focus-reply')), findsOneWidget, reason: 'on to what it waits on now');
      await done(tester);
    });
  });

  group('the agent\'s real, whole words (#383 brief R)', () {
    Map<String, dynamic> say(String text) => {'role': 'assistant', 'text': text, 'toolUses': [], 'ts': 't-$text'.hashCode.toString()};
    Map<String, dynamic> tool(String name, {Map<String, dynamic> input = const {}, String? result}) => {
          'role': 'assistant',
          'text': '',
          'toolUses': [
            {'name': name, 'inputPreview': '', 'id': 'tu-$name', 'input': input, 'result': ?result},
          ],
        };
    Map<String, dynamic> typed(String text) =>
        {'role': 'user', 'text': text, 'typedText': text, 'userKind': 'human', 'toolUses': []};
    String filler(int n) => List.generate(n, (i) => 'Step $i of the analysis went fine.').join(' ');
    String plain(WidgetTester t, Finder f) => t.widgetList<RichText>(find.descendant(of: f, matching: find.byType(RichText)))
        .map((w) => w.text.toPlainText())
        .join('\n');

    testWidgets('a question\'s lead-up in the inbox is the WHOLE turn, joined', (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      transcripts = {
        'q': [
          say('OLD_TURN'),
          typed('fix the login'),
          say('What I found:'),
          tool('Bash', result: 'ok'),
          say('- the cookie expires\n- the token is stale'),
          tool('AskUserQuestion'),
        ],
      };
      await pump(tester, await repo());
      await settle(tester);
      final panel = tester.widget<QuestionAnswerPanel>(find.byKey(const ValueKey('inbox-question-panel')));
      expect(panel.contextText, 'What I found:\n\n- the cookie expires\n- the token is stale');
      await done(tester);
    });

    testWidgets('a card shows the question sentence, its header and "+N more", and opens in place', (tester) async {
      final long = '${filler(8)} Which store should the session cache use?';
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {
        'q': {
          'toolUseId': 't1',
          'questions': [
            {'header': 'Store', 'question': long, 'multiSelect': false, 'options': [{'label': 'Redis'}, {'label': 'SQLite'}]},
            {'header': 'TTL', 'question': 'How long should entries live?', 'multiSelect': false, 'options': [{'label': '1h'}]},
          ],
        },
      };
      await pump(tester, await repo(), width: 420, height: 1200);
      const key = 'http://h:7681|q';
      final card = find.byKey(const ValueKey('inbox-card-$key'));
      final snippet = plain(tester, find.byKey(const ValueKey('inbox-snippet-$key')));
      expect(snippet, contains('Question - Store:'));
      expect(snippet, contains('Which store should the session cache use?'), reason: 'the sentence that asks');
      expect(snippet, isNot(contains('Step 0 ')), reason: 'not the head of the text');
      expect(find.descendant(of: card, matching: find.text('+1 more question')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('inbox-expand-$key')));
      await tester.pumpAndSettle();
      final whole = plain(tester, find.byKey(const ValueKey('inbox-whole-$key')));
      expect(whole, contains(long), reason: 'the full question, in place');
      expect(whole, contains('Question - TTL:'));
      expect(whole, contains('How long should entries live?'));
      expect(find.byKey(const ValueKey('inbox-more-$key')), findsNothing, reason: 'none is left out once it is open');
      expect(find.byKey(const ValueKey('inbox-question-panel')), findsNothing, reason: 'expanding does not open it');
      await done(tester);
    });

    testWidgets('prose (c): found from the full reply, and the focused view shows it whole, TL;DR first', (tester) async {
      final tldr = '${filler(9)} Should I post the draft to the issue?';
      expect(tldr.indexOf('?'), greaterThan(280), reason: 'past where the recap cut it');
      rows = {_home.baseUrl: [_row('c', 'Idle', lastActivity: 5)]};
      transcripts = {
        'c': [typed('draft it'), say('BODY_PARAGRAPH with the analysis.'), tool('Read', result: 'ok'), say('## TL;DR\n$tldr')],
      };
      await pump(tester, await repo());
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-card-http://h:7681|c')), findsOneWidget, reason: 'it asks');
      final md = tester.widget<MarkdownBody>(
          find.descendant(of: find.byKey(const ValueKey('inbox-last-reply')), matching: find.byType(MarkdownBody)));
      expect(md.data, startsWith('## TL;DR\n\n$tldr'));
      expect(md.data, contains('BODY_PARAGRAPH with the analysis.'));
      await done(tester);
    });

    testWidgets('reported (d): the card asks in the agent\'s words, the focused view shows the real reply', (tester) async {
      rows = {
        _home.baseUrl: [
          _row('d', 'Docs', reason: {'kind': 'you', 'text': 'pick a title', 'source': 'reported', 'since': 1}, brief: {
            'v': 1,
            'reporting': 'on',
            'items': [],
            'did': {'text': 'speech form of the tldr'},
          }),
        ],
      };
      transcripts = {
        'd': [typed('write it'), say('${filler(10)}\n\nI drafted it above. Tell me which title to use.\n\n## TL;DR\nDrafted.')],
      };
      await pump(tester, await repo());
      await settle(tester);
      const key = 'http://h:7681|d';
      expect(plain(tester, find.byKey(const ValueKey('inbox-snippet-$key'))), contains('Tell me which title to use.'));
      final md = tester.widget<MarkdownBody>(
          find.descendant(of: find.byKey(const ValueKey('inbox-last-reply')), matching: find.byType(MarkdownBody)));
      expect(md.data, startsWith('## TL;DR\n\nDrafted.'));
      expect(md.data, contains('Step 9 of the analysis'));
      expect(find.textContaining('speech form', findRichText: true), findsNothing, reason: 'not brief.did');
      await done(tester);
    });

    testWidgets('permission (b): the command being approved, from the transcript, and the whole lead-up', (tester) async {
      const cmd = 'rm -rf build && git clean -fdx';
      rows = {_home.baseUrl: [_row('p', 'Cleanup', status: 'waiting', waitingFor: 'permission', lastActivity: 1)]};
      transcripts = {
        'p': [typed('clean up'), say('The build folder is stale.'), tool('Read', result: 'ok'), say('Removing it now.'), tool('Bash', input: {'command': cmd})],
      };
      await pump(tester, await repo());
      await settle(tester);
      expect(tester.widget<SelectableText>(find.byKey(const ValueKey('inbox-tool-call'))).data, cmd);
      final lead = tester.widget<MarkdownBody>(
          find.descendant(of: find.byKey(const ValueKey('inbox-lead')), matching: find.byType(MarkdownBody)));
      expect(lead.data, 'The build folder is stale.\n\nRemoving it now.');
      expect(find.byKey(const ValueKey('inbox-lead-toggle')), findsNothing, reason: 'two short lines fit: nothing to show');
      expect(find.textContaining('About to clean.', findRichText: true), findsNothing, reason: 'not the attention 200 chars');
      final card = find.byKey(const ValueKey('inbox-card-http://h:7681|p'));
      expect(find.descendant(of: card, matching: find.text(cmd)), findsOneWidget);
      await done(tester);
    });

    testWidgets('permission (b): a lead-up taller than its clamp offers Show all, and opens in place', (tester) async {
      rows = {_home.baseUrl: [_row('p', 'Cleanup', status: 'waiting', waitingFor: 'permission', lastActivity: 1)]};
      transcripts = {
        'p': [typed('clean up'), say(List.generate(60, (i) => 'Paragraph $i of the plan.').join('\n\n')), tool('Bash', input: {'command': 'ls'})],
      };
      await pump(tester, await repo());
      await settle(tester);
      final toggle = find.byKey(const ValueKey('inbox-lead-toggle'));
      expect(toggle, findsOneWidget, reason: 'sixty paragraphs overflow the clamp');
      final lead = tester.getRect(find.byKey(const ValueKey('inbox-lead')));
      // report-T finding 5: the clamp is a share of the view, not a fixed 160.
      expect(lead.height, greaterThan(kLeadClamp * 2), reason: 'a 1000px window gives the lead-up the room it has');
      // Clamped, it shows the END (next to the tool call); the head is what Show all adds.
      final last = tester.getRect(find.textContaining('Paragraph 59 of the plan.', findRichText: true));
      expect(last.bottom, lessThanOrEqualTo(lead.bottom + 0.5));
      expect(last.top, greaterThanOrEqualTo(lead.top - 0.5));
      expect(tester.getRect(find.textContaining('Paragraph 0 of the plan.', findRichText: true)).bottom,
          lessThanOrEqualTo(lead.top + 0.5),
          reason: 'the head is above the clamp');
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byKey(const ValueKey('inbox-lead'))).height, greaterThan(kLeadClamp));
      expect(find.descendant(of: toggle, matching: find.text('Show less')), findsOneWidget);
      await done(tester);
    });
  });
  group('review findings on the full text (report-T)', () {
    Map<String, dynamic> say(String text) => {'role': 'assistant', 'text': text, 'toolUses': [], 'ts': 't-$text'.hashCode.toString()};
    Map<String, dynamic> call(String cmd, {String? result, String name = 'Bash'}) => {
          'role': 'assistant',
          'text': '',
          'toolUses': [
            {'name': name, 'inputPreview': '', 'id': 'tu-$cmd', 'input': {'command': cmd, 'description': cmd}, 'result': ?result},
          ],
        };
    Map<String, dynamic> typed(String text) =>
        {'role': 'user', 'text': text, 'typedText': text, 'userKind': 'human', 'toolUses': []};
    Map<String, dynamic> brief(String now, int at) => {
          'v': 1,
          'reporting': 'on',
          'items': [],
          'now': {'text': now, 'at': at},
        };
    Map<String, dynamic> perm(String id, {required int act, int? nowAt, String now = 'Bash \u00b7 step'}) =>
        _row(id, 'Perm $id', status: 'waiting', waitingFor: 'permission', lastActivity: act, brief: nowAt == null ? null : brief(now, nowAt));
    Finder cmd(String c) => find.textContaining(c, findRichText: true);
    int reads(String suffix) => paths.where((p) => p.endsWith(suffix)).length;
    String? shown(WidgetTester tester) {
      final f = find.byKey(const ValueKey('inbox-tool-call'));
      return f.evaluate().isEmpty ? null : tester.widget<SelectableText>(f).data;
    }

    testWidgets('F1: parallel calls, or a subagent asking, name NO command; the line above stays', (tester) async {
      rows = {
        _home.baseUrl: [
          perm('a', act: 1),
          perm('b', act: 2, nowAt: 2, now: 'Subagent: Bash \u00b7 push'),
          perm('c', act: 3, nowAt: 3),
        ],
      };
      transcripts = {
        'a': [typed('clean'), say('Two at once.'), call('CMD_PARALLEL_1'), call('CMD_PARALLEL_2')],
        'b': [typed('review'), call('CMD_SUBAGENT_CALL')],
        'c': [typed('push'), say('Pushing.'), call('CMD_GOOD')],
      };
      await pump(tester, await repo());
      await settle(tester);
      expect(cmd('CMD_PARALLEL'), findsNothing, reason: 'which of the two asks is not on disk');
      expect(cmd('CMD_SUBAGENT_CALL'), findsNothing, reason: 'the server says a subagent is asking');
      expect(cmd('CMD_GOOD'), findsOneWidget, reason: 'the control: one call, and the server agrees');
      expect(find.descendant(of: find.byKey(const ValueKey('inbox-card-http://h:7681|b')), matching: cmd('Subagent: Bash')),
          findsOneWidget,
          reason: 'what waits is still said');
      await done(tester);
    });

    testWidgets("F2: permission B never shows A's command while B's read is out", (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [perm('p', act: 10, nowAt: 10)]};
      transcripts = {'p': [typed('go'), say('Step one.'), call('CMD_A')]};
      await pump(tester, r);
      await settle(tester);
      expect(shown(tester), 'CMD_A');

      final hold = Completer<void>();
      transcriptHolds = [hold];
      rows = {_home.baseUrl: [perm('p', act: 20, nowAt: 20)]};
      transcripts = {'p': [typed('go'), say('Step one.'), call('CMD_A', result: 'ok'), say('Step two.'), call('CMD_B')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(cmd('CMD_A'), findsNothing, reason: "A's command under B's wait is the wrong one");
      hold.complete();
      await settle(tester);
      expect(shown(tester), 'CMD_B');
      await done(tester);
    });

    testWidgets('F2: two reads that land out of order leave the NEWER one', (tester) async {
      final r = await repo();
      final holdA = Completer<void>();
      transcriptHolds = [holdA];
      rows = {_home.baseUrl: [perm('p', act: 10, nowAt: 10)]};
      transcripts = {'p': [typed('go'), call('CMD_A')]};
      await pump(tester, r);
      await settle(tester);

      rows = {_home.baseUrl: [perm('p', act: 20, nowAt: 20)]};
      transcripts = {'p': [typed('go'), call('CMD_A', result: 'ok'), call('CMD_B')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(shown(tester), 'CMD_B');

      holdA.complete(); // A's read, asked first, lands last
      await settle(tester);
      expect(cmd('CMD_A'), findsNothing);
      expect(shown(tester), 'CMD_B');
      await done(tester);
    });

    testWidgets('F3: terminal output (a new lastActivity) during the SAME wait re-reads nothing', (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [perm('a', act: 1, nowAt: 5), perm('b', act: 1)]};
      transcripts = {'a': [typed('go'), call('CMD_A')], 'b': [typed('go'), call('CMD_B')]};
      await pump(tester, r);
      await settle(tester);
      expect([reads('/a/transcript'), reads('/b/transcript')], [1, 1]);
      expect([reads('/a/attention'), reads('/b/attention')], [1, 1]);

      for (final act in [2, 3, 4]) {
        // The prompt repaints: the worker bumps lastActivity on every PTY chunk.
        rows = {_home.baseUrl: [perm('a', act: act, nowAt: 5), perm('b', act: act)]};
        await tester.runAsync(() => r.refresh());
        await settle(tester);
      }
      expect([reads('/a/transcript'), reads('/b/transcript')], [1, 1], reason: 'one wait, one read');
      expect([reads('/a/attention'), reads('/b/attention')], [1, 1]);
      expect(cmd('CMD_A'), findsWidgets, reason: 'and the command stays on screen throughout');

      // A NEW wait is read: a new call (a new PreToolUse), or a wait that ended and came back.
      rows = {_home.baseUrl: [perm('a', act: 9, nowAt: 9), _row('b', 'Perm b', status: 'working', lastActivity: 9)]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      rows = {_home.baseUrl: [perm('a', act: 10, nowAt: 9), perm('b', act: 10)]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect([reads('/a/transcript'), reads('/b/transcript')], [2, 2]);
      await done(tester);
    });

    testWidgets('F4: a /cost after "Should I push it?" keeps the ask in the inbox', (tester) async {
      rows = {_home.baseUrl: [_row('c', 'Idle', lastActivity: 5)]};
      transcripts = {
        'c': [
          typed('push the fix'),
          say('Tests pass. Should I push it?'),
          {'role': 'user', 'text': '<command-name>/cost</command-name>', 'typedText': '/cost', 'userKind': 'command', 'toolUses': []},
          {'role': 'user', 'text': '<local-command-stdout>Total: 1</local-command-stdout>', 'typedText': '', 'userKind': 'system', 'toolUses': []},
        ],
      };
      await pump(tester, await repo());
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-card-http://h:7681|c')), findsOneWidget);
      await done(tester);
    });

    testWidgets('F5: a question in a narrow pane gives its lead-up the room the options leave, opened at the end',
        (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')};
      transcripts = {
        'q': [typed('go'), say(List.generate(40, (i) => 'Lead line $i of the reasoning.').join('\n\n')), call('x', name: 'AskUserQuestion')],
      };
      // 1200 wide: the focus pane is under the two-column threshold, the stacked shape.
      await pump(tester, await repo(), width: 1200, height: 800);
      await settle(tester);
      final lastLine = find.textContaining('Lead line 39 ', findRichText: true);
      final box = tester.getRect(find.ancestor(of: lastLine, matching: find.byType(SingleChildScrollView)).first);
      // The old budget charged the question its 260px ceiling and the options their
      // floor: at this size the lead-up got nothing and started collapsed.
      expect(box.height, greaterThan(300));
      expect(tester.getRect(inPanel(find.text('B'))).bottom, lessThan(800), reason: 'every option still on screen');
      final last = tester.getRect(lastLine);
      expect(last.bottom, lessThanOrEqualTo(box.bottom + 0.5), reason: 'opens at the end, next to the question');
      expect(last.top, greaterThanOrEqualTo(box.top - 0.5));
      expect(tester.getRect(find.textContaining('Lead line 0 ', findRichText: true)).bottom, lessThanOrEqualTo(box.top + 0.5),
          reason: 'the head is a scroll up');
      await done(tester);
    });
  });
}
