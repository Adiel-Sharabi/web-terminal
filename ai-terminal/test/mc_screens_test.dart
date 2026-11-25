// #507 - Mission Control's screens against a faked server answering the synthetic
// fixture: the Now screen shows what the server says (cards, to-dos, moving, projects
// with areas and a stage bar) and its buttons post the contract calls; the home has a
// side nav on desktop and a bottom bar on a phone; the shell runs both homes, opens the
// one the setting names, and keeps each one's state across a switch.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/screens/home_shell.dart';
import 'package:ai_terminal/screens/mission_control/machines_view.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart' show QuestionsInboxScreen;
import 'package:ai_terminal/screens/settings_screen.dart';
import 'package:ai_terminal/screens/work_board_screen.dart';
import 'package:ai_terminal/services/launch_settings.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void _noOpen(Session _) {}

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

Map<String, dynamic> _fixture() =>
    jsonDecode(File('test/fixtures/mc_now.json').readAsStringSync()) as Map<String, dynamic>;

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

class _Server {
  int nowStatus = 200;
  final List<http.Request> posts = [];

  /// Fields laid over the fixture's answer (#522: `actions`).
  Map<String, dynamic> extra = const {};

  /// The Done answer's `done` (#522).
  Map<String, dynamic> done = const {'delivered': true};

  McFeed feed() => McFeed(
        servers: () => const [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          if (req.method == 'POST') {
            posts.add(req);
            if (req.url.path == '/api/mc/todo') {
              return http.Response(jsonEncode({'todo': {'id': 't9'}, 'parked': {'delivered': true}}), 200);
            }
            if (req.url.path == '/api/mc/actions/done') {
              return http.Response(jsonEncode({'cardId': 'x', 'done': done}), 200);
            }
            return http.Response(jsonEncode({'ok': true}), 200);
          }
          if (nowStatus != 200) return http.Response(jsonEncode({'error': 'Not found'}), nowStatus);
          return http.Response(jsonEncode({..._fixture(), ...extra}), 200);
        })),
      );
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
  });
  tearDown(() => SessionSelection.instance.reset());

  group('Now', () {
    late _Server server;
    late McFeed feed;
    late List<String> answered;
    late List<String> opened;

    Future<void> pump(WidgetTester tester, {Size size = const Size(1400, 1600)}) async {
      await _size(tester, size);
      answered = [];
      opened = [];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McNowView(
            feed: feed,
            onAnswer: (c) => answered.add(c.id),
            onOpenSession: opened.add,
          ),
        ),
      ));
      await feed.refresh();
      await tester.pump();
    }

    setUp(() {
      server = _Server();
      feed = server.feed();
    });
    tearDown(() => feed.dispose());

    testWidgets('shows the cards in the server order, with project, ref + title, why, age and options', (tester) async {
      await pump(tester);
      expect(find.text('Answer now (2)'), findsOneWidget);
      final first = find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick'));
      final second = find.byKey(const ValueKey('mc-card-beta|s-9|you:look'));
      expect(first, findsOneWidget);
      expect(second, findsOneWidget);
      expect(tester.getTopLeft(first).dy, lessThan(tester.getTopLeft(second).dy), reason: "the server's order");
      Finder inFirst(Finder f) => find.descendant(of: first, matching: f);
      expect(inFirst(find.text('Web Terminal')), findsOneWidget);
      // #533: the session line names the model the session's command runs; a card with none says nothing.
      expect(inFirst(find.text('Fix the login loop · alpha · sonnet')), findsOneWidget);
      expect(find.descendant(of: second, matching: find.text('Tidy the readme · beta')), findsOneWidget);
      expect(inFirst(find.text('#41  Login loops after a token refresh')), findsOneWidget);
      expect(inFirst(find.text('blocks 3 sessions - waiting: Child: write the test, Child: check the docs')), findsOneWidget);
      expect(inFirst(find.text('42 min')), findsOneWidget);
      expect(inFirst(find.text('severity 1')), findsOneWidget);
      expect(inFirst(find.text('Retry once')), findsOneWidget);
      expect(inFirst(find.text('Refresh first')), findsOneWidget);
      expect(inFirst(find.byKey(const ValueKey('mc-card-answer'))), findsOneWidget);
      expect(find.descendant(of: second, matching: find.byKey(const ValueKey('mc-card-open'))), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Answer opens the question; Open session opens the session', (tester) async {
      await pump(tester);
      await tester.tap(find.descendant(
          of: find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick')), matching: find.byKey(const ValueKey('mc-card-answer'))));
      await tester.tap(find.descendant(
          of: find.byKey(const ValueKey('mc-card-beta|s-9|you:look')), matching: find.byKey(const ValueKey('mc-card-answer'))));
      await tester.tap(find.descendant(
          of: find.byKey(const ValueKey('mc-card-beta|s-9|you:look')), matching: find.byKey(const ValueKey('mc-card-open'))));
      expect(answered, ['alpha|s-1|you:pick', 'beta|s-9|you:look'], reason: 'a reported wait is answered in the inbox too');
      expect(opened, ['s-9']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('To my to-do and Later post the contract calls for that card', (tester) async {
      await pump(tester);
      final card = find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick'));
      await tester.tap(find.descendant(of: card, matching: find.byKey(const ValueKey('mc-card-todo'))));
      await tester.pump();
      await tester.pump();
      expect(find.text('On your to-do list; the session was told to carry on'), findsOneWidget);
      await tester.tap(find.descendant(of: card, matching: find.byKey(const ValueKey('mc-card-later'))));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-later-4')));
      await tester.pumpAndSettle();
      expect(server.posts.map((r) => r.url.path), ['/api/mc/todo', '/api/mc/later']);
      expect(jsonDecode(server.posts[0].body), {'cardId': 'alpha|s-1|you:pick'});
      expect(jsonDecode(server.posts[1].body), {'cardId': 'alpha|s-1|you:pick', 'hours': 4});
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('More context (#510): offered only under a question scope, and opens the question panel', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-card-context')), findsNothing, reason: 'no scope: nothing to open');
      await tester.pumpWidget(const SizedBox());
      await _size(tester, const Size(1400, 1600));
      final opened = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McQuestionScope(
          analyst: McAnalyst(servers: () => const [], client: ApiClient.new),
          onSend: (c, t, shown) async => false,
          onAnswer: (c) => opened.add(c.id),
          child: Scaffold(body: McNowView(feed: feed, onAnswer: (c) {}, onOpenSession: (_) {})),
        ),
      ));
      await feed.refresh();
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-card-context')).first);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mcq-levels')), findsOneWidget);
      // No server to read it from: the panel says so instead of a blank.
      expect(find.byKey(const ValueKey('mcq-context-error')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('My to-do: open ones listed, done ones folded; Done and Back post the action', (tester) async {
      await pump(tester);
      expect(find.text('My to-do (1)'), findsOneWidget);
      expect(find.text('Try it on the tablet'), findsOneWidget);
      expect(find.text('Flash the board'), findsNothing, reason: 'done: folded');
      await tester.tap(find.byKey(const ValueKey('mc-todo-done-toggle')));
      await tester.pump();
      expect(find.text('Flash the board'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-todo-done-t-1')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-todo-back-t-1')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-todo-reopen-t-2')));
      await tester.pump();
      expect(server.posts.map((r) => '${r.url.path} ${r.body}'), [
        '/api/mc/todo/t-1 {"action":"done"}',
        '/api/mc/todo/t-1 {"action":"back"}',
        '/api/mc/todo/t-2 {"action":"reopen"}',
      ]);
      await tester.pumpWidget(const SizedBox());
    });

    // #522 - a session waiting for the person to DO something: on My to-do with its steps
    // and where, ranked first, never in Answer now and never phrased as a question.
    const action = {
      'id': 'alpha|s-3|action:1',
      'kind': 'action',
      'server': 'alpha',
      'sessionId': 's-3',
      'sessionName': 'TacticalMap release',
      'project': 'web-terminal',
      'what': 'try on-duty on 0.2.51',
      'action': {
        'steps': ['Install 0.2.51', 'Start a shift', 'Check the map follows you'],
        'where': 'phone'
      },
      'why': {'blocks': 2, 'text': 'blocks 2 sessions and 1 work item'},
      'rank': 1,
      'hasQuestion': false,
      'done': null,
    };

    testWidgets('#522 an action is on My to-do with its steps and where, never in Answer now', (tester) async {
      server.extra = {
        'actions': [action]
      };
      await pump(tester);
      expect(find.text('Answer now (2)'), findsOneWidget, reason: 'the action is not a question');
      expect(find.text('My to-do (2)'), findsOneWidget, reason: 'one action, one open to-do');
      final card = find.byKey(const ValueKey('mc-action-alpha|s-3|action:1'));
      expect(card, findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-alpha|s-3|action:1')), findsNothing);
      Finder inCard(Finder f) => find.descendant(of: card, matching: f);
      expect(inCard(find.text('try on-duty on 0.2.51')), findsOneWidget);
      expect(inCard(find.text('TacticalMap release · alpha')), findsOneWidget, reason: 'no model on the wire: none on the line');
      expect(inCard(find.text('phone')), findsOneWidget);
      expect(inCard(find.text('Install 0.2.51')), findsOneWidget);
      expect(inCard(find.text('3.')), findsOneWidget);
      expect(inCard(find.text('Check the map follows you')), findsOneWidget);
      expect(inCard(find.text('Done unblocks: 2 sessions and 1 work item')), findsOneWidget);
      expect(inCard(find.text('Web Terminal')), findsOneWidget);
      // Never phrased or answered as a question.
      expect(inCard(find.byKey(const ValueKey('mc-card-answer'))), findsNothing);
      expect(inCard(find.textContaining('?')), findsNothing);
      expect(inCard(find.textContaining('nswer')), findsNothing);
      // Ranked above the parked to-dos.
      expect(tester.getTopLeft(card).dy, lessThan(tester.getTopLeft(find.text('Try it on the tablet')).dy));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#522 Done tells the session through the server; Not now hides it for the hours picked', (tester) async {
      server.extra = {
        'actions': [action]
      };
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-action-done')));
      await tester.pump();
      await tester.pump();
      expect(find.text('Done - the session was told to carry on'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-action-later')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('In 2 hours'));
      await tester.pumpAndSettle();
      expect(server.posts.map((r) => '${r.url.path} ${r.body}'), [
        '/api/mc/actions/done {"cardId":"alpha|s-3|action:1"}',
        '/api/mc/later {"cardId":"alpha|s-3|action:1","hours":2}',
      ]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('#522 a Done that was refused says why on the card and in the snack bar', (tester) async {
      server.extra = {
        'actions': [
          {
            ...action,
            'done': {'state': 'refused', 'refused': 'draft', 'reason': 'it has unsent text in its prompt box'}
          }
        ]
      };
      server.done = {'delivered': false, 'refused': 'draft', 'reason': 'it has unsent text in its prompt box'};
      await pump(tester);
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-action-not-told'))).data,
          'Its session was not told: it has unsent text in its prompt box');
      await tester.tap(find.byKey(const ValueKey('mc-action-done')));
      await tester.pump();
      await tester.pump();
      expect(find.text('Not told yet: it has unsent text in its prompt box. Press Done again when it can be told'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('#522 a Done that may have reached its session stays shown, says so, and offers no Done', (tester) async {
      server.extra = {
        'answerNow': <Object>[],
        'actions': [
          {
            ...action,
            'done': {'state': 'uncertain'}
          }
        ]
      };
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-action-alpha|s-3|action:1')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-action-maybe-told')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-action-done')), findsNothing);
      expect(find.byKey(const ValueKey('mc-action-not-told')), findsNothing);
      // Answer now is empty, but something waits to be DONE: it never says nothing is stuck.
      expect(find.text('No question waits on you.'), findsOneWidget);
      expect(find.text('Nothing is stuck on you.'), findsNothing);
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('a to-do whose session was not told says why, and Tell asks the server again (#506)', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-todo-park-t-1')), findsOneWidget);
      expect(find.text('Its session was not told: it has unsent text in its prompt box'), findsOneWidget);
      // The done one says nothing about its message and offers no Tell.
      expect(find.byKey(const ValueKey('mc-todo-tell-t-2')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-todo-tell-t-1')));
      await tester.pump();
      expect(server.posts.map((r) => '${r.url.path} ${r.body}'), ['/api/mc/todo/t-1 {"action":"park"}']);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('moving counts, and project cards with area labels and a stage bar in the server order', (tester) async {
      await pump(tester);
      expect(find.text('4 working · 2 idle · 6 in all'), findsOneWidget);
      final web = find.byKey(const ValueKey('mc-project-web-terminal'));
      expect(find.descendant(of: web, matching: find.text('acme/widgets')), findsOneWidget);
      expect(find.descendant(of: web, matching: find.text('Companion · 3 · 1 need you')), findsOneWidget);
      expect(find.descendant(of: web, matching: find.text('Server · 2')), findsOneWidget);
      final bar = find.descendant(of: web, matching: find.byKey(const ValueKey('mc-stage-bar')));
      expect(bar, findsOneWidget);
      final segs = ['triage', 'fixing', 'pr-open']
          .map((s) => tester.getTopLeft(find.byKey(ValueKey('mc-stage-$s'))).dx)
          .toList();
      expect(segs, orderedEquals([...segs]..sort()), reason: 'left to right in the order sent');
      expect(find.byKey(const ValueKey('mc-stage-merged')), findsNothing, reason: 'an empty stage takes no room');
      expect(tester.getSize(find.byKey(const ValueKey('mc-stage-fixing'))).width,
          closeTo(2 * tester.getSize(find.byKey(const ValueKey('mc-stage-triage'))).width, 1));
      expect(find.descendant(of: web, matching: find.text('PR open 1')), findsOneWidget);
      final other = find.byKey(const ValueKey('mc-project-other'));
      expect(find.descendant(of: other, matching: find.byKey(const ValueKey('mc-stage-bar'))), findsNothing,
          reason: 'no stages sent: no bar');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a server without Mission Control: says so, never crashes', (tester) async {
      server.nowStatus = 404;
      await pump(tester, size: const Size(420, 900));
      expect(find.byKey(const ValueKey('mc-state-unsupported')), findsOneWidget);
      expect(find.text('No Mission Control yet'), findsOneWidget);
      expect(find.textContaining('This server has no Mission Control yet'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('phone width: one column, nothing overflows', (tester) async {
      await pump(tester, size: const Size(360, 2400));
      expect(find.text('Answer now (2)'), findsOneWidget);
      expect(tester.getTopLeft(find.text('Moving on its own')).dy,
          greaterThan(tester.getTopLeft(find.text('My to-do (1)')).dy));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('MissionControlHome', () {
    late McFeed feed;
    setUp(() => feed = _Server().feed());

    Future<int> pump(WidgetTester tester, Size size) async {
      await _size(tester, size);
      var toSessions = 0;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(
          feed: feed,
          onShowSessionsHome: () => toSessions++,
          sessionsBoardBuilder: (open) => const Scaffold(body: Text('the sessions board')),
        ),
      ));
      await tester.pump();
      await tester.pump();
      return toSessions;
    }

    testWidgets('desktop: a side nav of Now, Lines, Sessions, Machines, Usage', (tester) async {
      await pump(tester, const Size(1400, 900));
      expect(find.byKey(const ValueKey('mc-rail')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-bottom-bar')), findsNothing);
      for (final l in ['Now', 'Lines', 'Sessions', 'Machines', 'Usage']) {
        expect(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text(l)), findsOneWidget);
      }
      expect(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text('Ask')), findsNothing);
      await tester.tap(find.text('Sessions'));
      await tester.pump();
      expect(find.text('the sessions board'), findsOneWidget);
      await tester.tap(find.text('Lines'));
      await tester.pump();
      expect(find.textContaining('#508'), findsNothing, reason: 'the placeholder is gone: #508 fills the tab');
      expect(find.byKey(const ValueKey('mc-project-web-terminal')), findsOneWidget, reason: "the projects, as Now's answer has them (a server with no lines)");
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('#531 Answer opens the answer sheet inside Mission Control, never the questions inbox', (tester) async {
      await pump(tester, const Size(1400, 1000));
      await tester.tap(find.byKey(const ValueKey('mc-card-answer')).first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsOneWidget);
      expect(find.byType(QuestionsInboxScreen), findsNothing);
      // The decision card's own options, to answer from here.
      expect(find.byKey(const ValueKey('mc-answer-option-1')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('phone: a bottom bar of Now, Lines, Ask, Machines, Usage; Ask is the Ask view (#511)', (tester) async {
      await pump(tester, const Size(400, 860));
      expect(find.byKey(const ValueKey('mc-bottom-bar')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-rail')), findsNothing);
      for (final l in ['Now', 'Lines', 'Ask', 'Machines', 'Usage']) {
        expect(find.descendant(of: find.byKey(const ValueKey('mc-bottom-bar')), matching: find.text(l)), findsOneWidget);
      }
      await tester.tap(find.text('Ask'));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-ask-view')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the swap button goes back to the sessions home', (tester) async {
      await _size(tester, const Size(400, 860));
      var toSessions = 0;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: feed, onShowSessionsHome: () => toSessions++),
      ));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-to-sessions-home')));
      expect(toSessions, 1);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('hidden, it drops the tabs that poll on their own (Machines, Sessions)', (tester) async {
      await _size(tester, const Size(1400, 900));
      final active = ValueNotifier<bool>(true);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(
          feed: feed,
          onShowSessionsHome: () {},
          active: active,
          sessionsBoardBuilder: (open) => const Scaffold(body: Text('the sessions board')),
        ),
      ));
      await tester.tap(find.text('Sessions'));
      await tester.pump();
      expect(find.text('the sessions board'), findsOneWidget);
      active.value = false;
      await tester.pump();
      expect(find.text('the sessions board'), findsNothing);
      active.value = true;
      await tester.pump();
      expect(find.text('the sessions board'), findsOneWidget, reason: 'back on the tab it was on');
      expect(find.byKey(const ValueKey('mc-rail-to-sessions-home')), findsOneWidget,
          reason: 'the way back is on the rail, so the Sessions tab has it too');
      active.value = false;
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('it polls only while it is the home on screen', (tester) async {
      await _size(tester, const Size(400, 860));
      final active = ValueNotifier<bool>(false);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: feed, onShowSessionsHome: () {}, active: active),
      ));
      expect(feed.active, isFalse);
      active.value = true;
      expect(feed.active, isTrue);
      active.value = false;
      expect(feed.active, isFalse);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('HomeShell', () {
    Widget shell(AppHome launch, {ValueNotifier<bool>? mcActive}) => MaterialApp(
          theme: AppTheme.dark,
          home: HomeShell(
            launchHome: () async => launch,
            sessionsHomeBuilder: ({required bool launchInbox, required bool visible, required VoidCallback onOpenMissionControl}) {
              _launchInboxSeen?.add(launchInbox);
              _visibleSeen.add(visible);
              return _CounterHome(label: 'sessions', onSwitch: onOpenMissionControl);
            },
            missionControlBuilder: ({required VoidCallback onShowSessionsHome, required ValueListenable<bool> active}) {
              if (mcActive != null) active.addListener(() => mcActive.value = active.value);
              return _CounterHome(label: 'mc', onSwitch: onShowSessionsHome);
            },
          ),
        );

    testWidgets('opens the home the setting names; the default is the sessions home', (tester) async {
      SharedPreferences.setMockInitialValues({});
      expect(await LaunchSettings.instance.restoreHome(), AppHome.sessions);
      _launchInboxSeen = [];
      await tester.pumpWidget(shell(AppHome.sessions));
      await tester.pump();
      expect(find.text('sessions 0'), findsOneWidget);
      expect(find.text('mc 0'), findsNothing, reason: 'not built until shown');
      expect(_launchInboxSeen, [true], reason: 'the inbox-at-launch runs when the sessions home opened the app');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('launching on Mission Control: the sessions home, built later, runs no launch inbox', (tester) async {
      _launchInboxSeen = [];
      await tester.pumpWidget(shell(AppHome.missionControl));
      await tester.pump();
      expect(find.text('mc 0'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('switch-mc')));
      await tester.pump();
      expect(find.text('sessions 0'), findsOneWidget);
      expect(_launchInboxSeen, [false]);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('switching keeps each home\'s state', (tester) async {
      _launchInboxSeen = null;
      await tester.pumpWidget(shell(AppHome.sessions));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('bump-sessions')));
      await tester.tap(find.byKey(const ValueKey('bump-sessions')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('switch-sessions')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('bump-mc')));
      await tester.pump();
      expect(find.text('mc 1'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('switch-mc')));
      await tester.pump();
      expect(find.text('sessions 2'), findsOneWidget, reason: 'the same State, not a new one');
      await tester.tap(find.byKey(const ValueKey('switch-sessions')));
      await tester.pump();
      expect(find.text('mc 1'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Mission Control is told when it is on screen', (tester) async {
      final mcActive = ValueNotifier<bool>(false);
      await tester.pumpWidget(shell(AppHome.missionControl, mcActive: mcActive));
      await tester.pump();
      // The listener was added after the first show: read the shell's own answer.
      final state = tester.state<HomeShellState>(find.byType(HomeShell));
      expect(state.shown, AppHome.missionControl);
      await tester.tap(find.byKey(const ValueKey('switch-mc')));
      await tester.pump();
      expect(mcActive.value, isFalse);
      await tester.tap(find.byKey(const ValueKey('switch-sessions')));
      await tester.pump();
      expect(mcActive.value, isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a session or the inbox asked for from outside brings the sessions home forward', (tester) async {
      await tester.pumpWidget(shell(AppHome.missionControl));
      await tester.pump();
      SessionSelection.instance.showBoard();
      await tester.pump();
      expect(tester.state<HomeShellState>(find.byType(HomeShell)).shown, AppHome.missionControl,
          reason: 'the board is the pane at rest: nothing asked for');
      SessionSelection.instance.select('s-1');
      await tester.pump();
      expect(tester.state<HomeShellState>(find.byType(HomeShell)).shown, AppHome.sessions);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an ask for what the hidden pane ALREADY shows still brings the sessions home forward', (tester) async {
      await tester.pumpWidget(shell(AppHome.sessions));
      await tester.pump();
      SessionSelection.instance.select('s-1');
      SessionSelection.instance.showInbox(focusSessionId: 's-2');
      await tester.tap(find.byKey(const ValueKey('switch-sessions')));
      await tester.pump();
      final shell0 = tester.state<HomeShellState>(find.byType(HomeShell));
      expect(shell0.shown, AppHome.missionControl);
      // A notification tap for the session the pane already holds: the same value again.
      SessionSelection.instance.showInbox(focusSessionId: 's-2');
      await tester.pump();
      expect(shell0.shown, AppHome.sessions);
      await tester.tap(find.byKey(const ValueKey('switch-sessions')));
      await tester.pump();
      SessionSelection.instance.showInbox(focusSessionId: 's-2');
      await tester.pump();
      expect(shell0.shown, AppHome.sessions);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the sessions home is told when it is hidden', (tester) async {
      _visibleSeen.clear();
      await tester.pumpWidget(shell(AppHome.sessions));
      await tester.pump();
      expect(_visibleSeen.last, isTrue);
      await tester.tap(find.byKey(const ValueKey('switch-sessions')));
      await tester.pump();
      expect(_visibleSeen.last, isFalse);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('hidden, the real sessions home keeps its rail but empties its detail pane', (tester) async {
      await _size(tester, const Size(1400, 900));
      Widget home(bool showPane) => MaterialApp(
            theme: AppTheme.dark,
            home: AdaptiveHome(
              showPane: showPane,
              boardBuilder: (open) => const WorkBoardScreen(onOpenSession: _noOpen, pollInterval: Duration(hours: 1)),
            ),
          );
      await tester.pumpWidget(home(true));
      await tester.pump();
      expect(find.byType(WorkBoardScreen), findsOneWidget);
      await tester.pumpWidget(home(false));
      await tester.pump();
      expect(find.byType(WorkBoardScreen), findsNothing, reason: 'no board poll behind Mission Control');
      expect(find.byType(DashboardScreen), findsOneWidget, reason: 'the rail and its state stay');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the real sessions home offers the way into Mission Control', (tester) async {
      await _size(tester, const Size(420, 900));
      var opened = 0;
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: AdaptiveHome(onOpenMissionControl: () => opened++)));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('open-mission-control')));
      expect(opened, 1);
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome()));
      await tester.pump();
      expect(find.byKey(const ValueKey('open-mission-control')), findsNothing, reason: 'no shell, no entry');
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Machines', () {
    testWidgets('one machine card per configured server, cluster peers included', (tester) async {
      await _size(tester, const Size(420, 1600));
      const b = ServerConfig(name: 'Beta', baseUrl: 'http://beta.test:7681', bearerToken: 'tb', origin: ServerOrigin.cluster);
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          for (final sv in const [_a, b]) {'name': sv.name, 'baseUrl': sv.baseUrl, 'bearerToken': sv.bearerToken},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      final repo = SessionRepository.forTest(
          store: store, clientFactory: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response('{}', 404))));
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McMachinesView(
            servers: () => const [_a, b],
            client: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response('{}', 404))),
            repository: repo,
            onOpenSession: (_) {},
          ),
        ),
      ));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-machine-http://alpha.test:7681')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-machine-http://beta.test:7681')), findsOneWidget);
      expect(find.text('Alpha'), findsOneWidget);
      expect(find.text('Beta'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Home on launch setting', () {
    test('persists under launch.home; anything unknown is the sessions home', () async {
      await LaunchSettings.instance.setHome(AppHome.missionControl);
      expect((await SharedPreferences.getInstance()).getString('launch.home'), 'mission-control');
      expect(await LaunchSettings.instance.restoreHome(), AppHome.missionControl);
      SharedPreferences.setMockInitialValues({'launch.home': 'something-newer'});
      expect(await LaunchSettings.instance.restoreHome(), AppHome.sessions);
    });

    testWidgets('the settings choice shows the default and persists a change, and fits a phone', (tester) async {
      // 412 px: at 360 the test font already overflows the font-size row above it (not this one).
      await _size(tester, const Size(412, 2400));
      final store = ServerStore.forTest();
      await store.init();
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: SettingsScreen(store: store)));
      await tester.pump();
      await tester.pump();
      final seg = find.byKey(const ValueKey('settings-launch-home'));
      expect(tester.widget<SegmentedButton<AppHome>>(seg).selected, {AppHome.sessions});
      expect(tester.getRect(seg).right, lessThanOrEqualTo(412), reason: 'under the title, inside the screen');
      expect(tester.getSize(find.text('Home on launch')).width, greaterThan(100), reason: 'the title is not a sliver');
      await tester.tap(find.descendant(of: seg, matching: find.text('Mission Control')));
      await tester.pump();
      await tester.pump();
      expect(tester.widget<SegmentedButton<AppHome>>(seg).selected, {AppHome.missionControl});
      expect((await SharedPreferences.getInstance()).getString('launch.home'), 'mission-control');
    });
  });
}

/// What the shell handed each sessions home it built: whether it runs the launch inbox.
List<bool>? _launchInboxSeen;

/// Whether the sessions home was told it is on screen, at each build.
final List<bool> _visibleSeen = [];

/// What the shell's homes are replaced by: a counter (state that must survive a switch)
/// and the switch it was handed.
class _CounterHome extends StatefulWidget {
  const _CounterHome({required this.label, required this.onSwitch});
  final String label;
  final VoidCallback onSwitch;

  @override
  State<_CounterHome> createState() => _CounterHomeState();
}

class _CounterHomeState extends State<_CounterHome> {
  int _n = 0;

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Column(children: [
          Text('${widget.label} $_n'),
          TextButton(key: ValueKey('bump-${widget.label}'), onPressed: () => setState(() => _n++), child: const Text('bump')),
          TextButton(key: ValueKey('switch-${widget.label}'), onPressed: widget.onSwitch, child: const Text('switch')),
        ]),
      );
}
