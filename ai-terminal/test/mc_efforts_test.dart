// #561 - Mission Control's Running home: one card per effort (a lead session tree) in the order
// the server sends, the state, the supervisor's verdict, the machine chips, Answer on the cards
// that wait, the folded "Not running" work by line, the effort's page - and the older-server
// fallback (an authority without `/api/mc/efforts` keeps the Now screen). The server owns every
// rule, so the tests feed its answer and read what is on screen.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/screens/mission_control/running_view.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

Map<String, dynamic> _now() => jsonDecode(File('test/fixtures/mc_now.json').readAsStringSync()) as Map<String, dynamic>;

/// The first card of the Now fixture: the one the needs-you effort carries.
Map<String, dynamic> _card() => (_now()['answerNow'] as List).first as Map<String, dynamic>;

const int _t0 = 1767223080000;

Map<String, dynamic> _session(String id, int depth, {String? parent, String? status, bool closed = false, Map<String, dynamic>? wait, Map<String, dynamic>? verdict}) => {
      'server': 'Alpha',
      'id': id,
      'name': 'Session $id',
      'status': status ?? 'idle',
      'closed': closed,
      'closedAt': closed ? _t0 : null,
      'parentId': parent,
      'depth': depth,
      'wait': wait,
      'verdict': verdict,
    };

/// What the server sends: five efforts in its order (needs you, stuck, moving, waiting, partial),
/// three machines (one silent), two lines' worth of work nobody runs.
Map<String, dynamic> _efforts({bool complete = false}) => {
      'efforts': [
        {
          'id': 'e-ask',
          'name': 'Fix the login loop',
          'server': 'Alpha',
          'machines': ['Alpha', 'Beta'],
          'startedAt': _t0 - 3600000,
          'lastActivity': _t0,
          'state': 'needs-you',
          'doing': 'Waiting for the fix choice',
          'verdict': {'kind': 'legit', 'rule': 'R1', 'text': 'waiting on you: Which fix should ship?', 'at': _t0},
          'sessions': [
            _session('s-1', 0, wait: {'on': 'you', 'what': 'Which fix should ship?'}),
            _session('s-2', 1, parent: 's-1', status: 'working'),
            _session('s-x', 1, parent: 's-1', closed: true),
          ],
          'items': [
            {'key': 'acme/widgets#41', 'ref': '#41', 'title': 'Login loops after a token refresh', 'stage': 'fixing', 'station': null, 'waitsOn': 'you'},
            {'key': 'ado:25678', 'ref': 'ado:25678', 'title': 'Parked item', 'stage': 'in-review', 'station': 'Parked', 'waitsOn': null},
          ],
          'needsYou': [_card()],
          'partial': false,
          'missing': <String>[],
        },
        {
          'id': 'e-stuck',
          'name': 'Migrate the store',
          'server': 'Beta',
          'machines': ['Beta'],
          'lastActivity': _t0 - 600000,
          'state': 'stuck',
          'doing': 'Waiting for the review',
          'verdict': {'kind': 'suspect', 'rule': 'R1', 'text': 'its wait was answered; nobody told it', 'at': _t0},
          'sessions': [_session('s-5', 0, wait: {'on': 'external', 'what': 'the review'})],
          'items': <Map<String, dynamic>>[],
          'needsYou': <Map<String, dynamic>>[],
        },
        {
          'id': 'e-move',
          'name': 'Write the tests',
          'server': 'Alpha',
          'machines': ['Alpha'],
          'lastActivity': _t0 - 60000,
          'state': 'moving',
          'doing': 'Running the suite',
          'verdict': null,
          'sessions': [_session('s-6', 0, status: 'working')],
          'items': [
            for (var i = 1; i <= 6; i++) {'key': '#$i', 'ref': '#$i', 'title': 'Item $i', 'stage': 'planned'},
          ],
          'needsYou': <Map<String, dynamic>>[],
        },
        {
          'id': 'e-wait',
          'name': 'Hunt for bugs',
          'server': 'Alpha',
          'machines': ['Alpha'],
          'lastActivity': _t0 - 7200000,
          'state': 'waiting',
          'doing': null,
          'verdict': {'kind': 'unknown', 'rule': 'R1'},
          'sessions': [_session('s-7', 0, wait: {'on': 'external', 'what': 'CI'})],
          'items': <Map<String, dynamic>>[],
          'needsYou': <Map<String, dynamic>>[],
        },
        {
          'id': 'e-part',
          'name': 'A tree whose lead is elsewhere',
          'server': 'Alpha',
          'machines': ['Alpha'],
          'state': 'waiting',
          'verdict': null,
          'sessions': [_session('s-8', 0)],
          'items': <Map<String, dynamic>>[],
          'needsYou': <Map<String, dynamic>>[],
          'partial': true,
          'missing': ['Gamma'],
        },
      ],
      'idle': [
        {
          'line': {'id': 'l-auth', 'name': 'Auth', 'project': 'web-terminal', 'kind': 'rules'},
          'items': [
            {'key': 'ado:1', 'ref': 'ado:1', 'title': 'Ready one', 'stage': 'pr-open', 'station': 'Ready for test', 'cls': 'waits-test', 'updatedAt': _t0},
            {'key': '#7', 'ref': '#7', 'title': 'Never started', 'cls': 'not-started', 'updatedAt': _t0 - 1000},
          ],
        },
        {
          'line': null,
          'items': [
            {'key': '#9', 'ref': '#9', 'title': 'Done thing', 'stage': 'merged', 'cls': 'finished'},
          ],
        },
      ],
      'machines': [
        {'name': 'Alpha', 'live': 4, 'working': 2, 'slots': 10, 'ok': true},
        {'name': 'Beta', 'live': 2, 'working': 0, 'slots': null, 'ok': true},
        {'name': 'Gamma', 'live': 0, 'working': 0, 'slots': null, 'ok': false},
      ],
      'servers': [
        {'name': 'Alpha', 'ok': true},
        {'name': 'Beta', 'ok': true},
        {'name': 'Gamma', 'ok': complete},
      ],
      'complete': complete,
      'generatedAt': _t0,
    };

class _Server {
  int effortsStatus = 200;
  Object? effortsBody;
  int effortsCalls = 0;

  McFeed feed({Duration effortsRetry = kEffortsRetry}) => McFeed(
        effortsRetry: effortsRetry,
        servers: () => const [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          if (req.url.path == '/api/mc/efforts') {
            effortsCalls++;
            if (effortsStatus != 200) return http.Response(jsonEncode({'error': 'no'}), effortsStatus);
            return http.Response(jsonEncode(effortsBody ?? _efforts()), 200);
          }
          if (req.url.path == '/api/mc/now') return http.Response(jsonEncode(_now()), 200);
          return http.Response(jsonEncode({'error': 'Not found'}), 404);
        })),
      );
}

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

double _top(WidgetTester tester, String key) => tester.getTopLeft(find.byKey(ValueKey(key))).dy;

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
  });
  tearDown(() => SessionSelection.instance.reset());

  group('wire', () {
    test('every field is read: efforts, items, sessions, verdicts, idle groups, machines', () {
      final d = McEfforts.fromJson(_efforts());
      expect(d.efforts.map((e) => e.id), ['e-ask', 'e-stuck', 'e-move', 'e-wait', 'e-part']);
      final e = d.efforts.first;
      expect(e.state, 'needs-you');
      expect(e.machines, ['Alpha', 'Beta']);
      expect(e.verdict!.kind, 'legit');
      expect(e.verdict!.line, 'legit: waiting on you: Which fix should ship?');
      expect(e.needsYou.single.id, 'alpha|s-1|you:pick');
      expect(e.sessions.map((s) => s.depth), [0, 1, 1]);
      expect(e.sessions.last.closed, isTrue);
      expect(e.liveSessions.length, 2);
      expect(e.sessions.first.wait!.on, 'you');
      expect(e.items.last.stateLabel, 'Parked', reason: 'the station outranks the stage');
      expect(e.items.first.stateLabel, 'Fixing');
      expect(d.efforts[3].verdict!.line, 'unknown');
      expect(d.efforts[4].partial, isTrue);
      expect(d.efforts[4].missing, ['Gamma']);
      expect(d.idle.length, 2);
      expect(d.idle.first.line!.id, 'l-auth');
      expect(d.idle.last.line, isNull);
      expect(d.idleCount, 3);
      expect(d.machines.map((m) => m.label), ['Alpha 4/10', 'Beta 2', 'Gamma 0']);
      expect(d.machines.last.ok, isFalse);
      expect(d.complete, isFalse);
      expect(d.silent, ['Gamma']);
    });

    test('junk and absent fields are tolerated, never thrown', () {
      expect(McEfforts.fromJson(null).efforts, isEmpty);
      expect(McEfforts.fromJson('junk').efforts, isEmpty);
      final d = McEfforts.fromJson({
        'efforts': [
          7,
          {'name': 'no id'},
          {'id': 'a', 'state': 'brand-new', 'verdict': {'text': 'no kind'}, 'sessions': 'x', 'items': [3], 'needsYou': [null]},
          {'id': 'a'},
        ],
        'idle': [
          {'line': null, 'items': []},
          5,
        ],
        'machines': [
          {'name': 'M', 'live': -3, 'slots': 0},
          {'name': 'M'},
        ],
      });
      expect(d.efforts.length, 1, reason: 'no id is no effort; a repeated id is dropped');
      final e = d.efforts.single;
      expect(e.name, 'a');
      expect(e.state, 'brand-new', reason: 'a state this app does not know is kept as sent');
      expect(e.verdict, isNull, reason: 'a verdict with no kind says nothing');
      expect(e.sessions, isEmpty);
      expect(e.items, isEmpty);
      expect(e.needsYou, isEmpty);
      expect(d.idle, isEmpty, reason: 'a group with no items is nothing');
      expect(d.machines.single.live, 0);
      expect(d.machines.single.slots, isNull, reason: 'a limit that is not positive was not read');
      expect(d.complete, isTrue, reason: 'only the server saying so makes it incomplete');
    });
  });

  group('the Running home', () {
    late _Server server;
    late McFeed feed;
    late List<String> answered;
    late List<String> opened;
    late List<String> efforts;
    late List<String> lines;
    late List<(String, String?)> started;

    Future<void> pump(WidgetTester tester, {Size size = const Size(1000, 5000)}) async {
      await _size(tester, size);
      answered = [];
      opened = [];
      efforts = [];
      lines = [];
      started = [];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McRunningView(
            feed: feed,
            onAnswer: (c) => answered.add(c.id),
            onOpenSession: opened.add,
            onOpenEffort: (e) => efforts.add(e.id),
            onOpenLine: lines.add,
            onStartWork: (i, p) => started.add((i.key, p)),
            now: DateTime.fromMillisecondsSinceEpoch(_t0 + 60000),
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

    testWidgets('one card per effort, in the order the server sent', (tester) async {
      await pump(tester);
      expect(find.text('Running (5)'), findsOneWidget);
      final ys = [for (final id in ['e-ask', 'e-stuck', 'e-move', 'e-wait', 'e-part']) _top(tester, 'mc-effort-$id')];
      for (var i = 1; i < ys.length; i++) {
        expect(ys[i], greaterThan(ys[i - 1]), reason: "the server's order, never re-sorted");
      }
      expect(find.text('Fix the login loop'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('each effort says its state; its machines and sessions; what it is doing', (tester) async {
      await pump(tester);
      Finder of(String id, Finder f) => find.descendant(of: find.byKey(ValueKey('mc-effort-$id')), matching: f);
      expect(find.byKey(const ValueKey('mc-effort-state-e-ask')), findsOneWidget);
      expect(of('e-ask', find.text('Needs you')), findsOneWidget);
      expect(of('e-stuck', find.text('Stuck')), findsOneWidget);
      expect(of('e-move', find.text('Moving')), findsOneWidget);
      expect(of('e-wait', find.text('Waiting')), findsOneWidget);
      expect(of('e-ask', find.text('Alpha · Beta · 2 sessions')), findsOneWidget, reason: 'live sessions: the closed one is not counted');
      expect(of('e-ask', find.text('Waiting for the fix choice')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-effort-doing-e-wait')), findsNothing, reason: 'nothing to say, nothing shown');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the verdict line: legit, suspect, unknown (greyed) - and none when the server sent none', (tester) async {
      await pump(tester);
      Text verdict(String id) => tester.widget<Text>(find.byKey(ValueKey('mc-effort-verdict-$id')));
      expect(verdict('e-ask').data, 'legit: waiting on you: Which fix should ship?');
      expect(verdict('e-stuck').data, 'suspect: its wait was answered; nobody told it');
      expect(verdict('e-wait').data, 'unknown');
      expect(verdict('e-stuck').style?.color, AppColors.caution, reason: 'a suspect wait stands out');
      expect(verdict('e-wait').style?.color, AppColors.onSurfaceDisabled, reason: 'unknown is greyed');
      expect(find.byKey(const ValueKey('mc-effort-verdict-e-move')), findsNothing);
      expect(find.byKey(const ValueKey('mc-effort-verdict-e-part')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an item strip: the station for a tracker item, the stage else; more than four fold into +N', (tester) async {
      await pump(tester);
      expect(find.text('#41 · Fixing'), findsOneWidget);
      expect(find.text('ado:25678 · Parked'), findsOneWidget, reason: 'the station, not the generic stage');
      expect(find.text('#1 · Planned'), findsOneWidget);
      expect(find.text('#4 · Planned'), findsOneWidget);
      expect(find.text('#5 · Planned'), findsNothing);
      expect(find.text('+2'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a partial effort says its lead may be on the machine that did not answer', (tester) async {
      await pump(tester);
      expect(find.text('Its lead may be on Gamma, which did not answer.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-effort-partial-e-ask')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the header: a chip per machine, live out of slots; no limit read; greyed when silent', (tester) async {
      await pump(tester);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-machine-chip-Alpha')), matching: find.text('Alpha 4/10')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-machine-chip-Beta')), matching: find.text('Beta 2')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-machine-chip-Gamma')), matching: find.text('Gamma - no answer')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-running-incomplete')), findsOneWidget);
      expect(find.textContaining('Gamma did not answer'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a complete view has no incomplete note', (tester) async {
      server.effortsBody = _efforts(complete: true);
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-running-incomplete')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Answer on the card that waits for the person; a card no effort carries is never hidden', (tester) async {
      await pump(tester);
      final inEffort = find.descendant(
          of: find.byKey(const ValueKey('mc-effort-e-ask')), matching: find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick')));
      expect(inEffort, findsOneWidget, reason: 'the card sits with its effort');
      await tester.tap(find.descendant(of: inEffort, matching: find.byKey(const ValueKey('mc-card-answer'))));
      expect(answered, ['alpha|s-1|you:pick']);
      // The second card of Now (beta|s-9) is on no effort: shown above them, not dropped.
      expect(find.byKey(const ValueKey('mc-loose-title')), findsOneWidget);
      expect(find.text('Also waiting on you (1)'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-beta|s-9|you:look')), findsOneWidget);
      expect(_top(tester, 'mc-card-beta|s-9|you:look'), lessThan(_top(tester, 'mc-effort-e-ask')));
      expect(find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick')), findsOneWidget, reason: 'the carried card is shown once');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('My to-do stays a section above the efforts', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-todo-title')), findsOneWidget);
      expect(_top(tester, 'mc-todo-title'), lessThan(_top(tester, 'mc-running-title')));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an effort that owes the person an action says it is on My to-do (the card is not repeated under it)', (tester) async {
      final body = _efforts();
      (body['efforts'] as List)[2]['todoCount'] = 2; // e-move: two actions on My to-do
      server.effortsBody = body;
      await pump(tester);
      expect(find.text('2 things for you are on My to-do.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-effort-todo-e-move')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-effort-todo-e-ask')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('tapping an effort opens it', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-effort-name-e-stuck')));
      expect(efforts, ['e-stuck']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('nothing running says so', (tester) async {
      server.effortsBody = {'efforts': <Object>[], 'idle': <Object>[], 'machines': <Object>[], 'complete': true};
      await pump(tester);
      expect(find.text('Running (0)'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-running-empty')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-idle-toggle')), findsNothing, reason: 'no work, no fold');
      expect(find.byKey(const ValueKey('mc-machine-chips')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Not running is folded; opened it lists the work by line, in the server order', (tester) async {
      await pump(tester);
      expect(find.text('Not running (3)'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-idle-item-ado:1')), findsNothing, reason: 'folded');
      await tester.tap(find.byKey(const ValueKey('mc-idle-toggle')));
      await tester.pump();
      expect(find.text('Auth'), findsOneWidget);
      expect(find.text('On no line'), findsOneWidget);
      expect(_top(tester, 'mc-idle-item-ado:1'), lessThan(_top(tester, 'mc-idle-item-#7')));
      expect(_top(tester, 'mc-idle-item-#7'), lessThan(_top(tester, 'mc-idle-item-#9')), reason: "the group's, then the next group's");
      expect(find.descendant(of: find.byKey(const ValueKey('mc-idle-cls-ado:1')), matching: find.text('Waits for test')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-idle-cls-#7')), matching: find.text('Not started')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-idle-cls-#9')), matching: find.text('Finished')), findsOneWidget);
      expect(find.text('Ready for test'), findsOneWidget, reason: 'the station of a tracker item');
      await tester.tap(find.byKey(const ValueKey('mc-idle-toggle')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-idle-item-ado:1')), findsNothing, reason: 'folded again');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a line opens its page; Start work carries the item and its line\'s project', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-idle-toggle')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-idle-line-l-auth')));
      expect(lines, ['l-auth']);
      await tester.tap(find.byKey(const ValueKey('mc-idle-line-none')));
      expect(lines, ['l-auth'], reason: 'the no-line group opens nothing');
      await tester.tap(find.byKey(const ValueKey('mc-idle-start-#7')));
      await tester.tap(find.byKey(const ValueKey('mc-idle-start-#9')));
      expect(started, [('#7', 'web-terminal'), ('#9', null)]);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a session-local item (key@session) has no Start work: it names nothing the tracker knows', (tester) async {
      server.effortsBody = {
        'efforts': <Object>[],
        'idle': [
          {
            'line': null,
            'items': [
              {'key': '#7', 'ref': '#7', 'title': 'A tracker item', 'cls': 'stranded'},
              {'key': 'free text@s-9', 'ref': 'free text', 'title': 'A free-text ref', 'cls': 'stranded'},
            ],
          },
        ],
        'machines': <Object>[],
        'complete': true,
      };
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-idle-toggle')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-idle-item-free text@s-9')), findsOneWidget, reason: 'still listed');
      expect(find.byKey(const ValueKey('mc-idle-start-#7')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-idle-start-free text@s-9')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the effort page', () {
    late _Server server;
    late McFeed feed;
    late List<String> subjects;
    late List<String> opened;

    Future<void> pump(WidgetTester tester, String id) async {
      await _size(tester, const Size(1000, 4000));
      subjects = [];
      opened = [];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McEffortScreen(
          feed: feed,
          effortId: id,
          onAnswer: (_) {},
          onOpenSession: opened.add,
          onOpenSubject: subjects.add,
          now: DateTime.fromMillisecondsSinceEpoch(_t0 + 60000),
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

    testWidgets('its items open their pages; its sessions are drawn as the tree the server sent', (tester) async {
      await pump(tester, 'e-ask');
      expect(find.text('Items (2)'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-effort-item-ado:25678')));
      expect(subjects, ['ado:25678']);
      expect(find.text('Sessions (3)'), findsOneWidget);
      // The key sits on the padding that indents the card: the card's own left edge moves.
      double edge(String id) => tester.getTopLeft(find.descendant(of: find.byKey(ValueKey('mc-effort-session-$id')), matching: find.byType(Card))).dx;
      final lead = edge('s-1');
      final child = edge('s-2');
      expect(child, greaterThan(lead), reason: 'a child is indented under its lead');
      expect(find.text('Alpha · idle · waits on you: Which fix should ship?'), findsOneWidget);
      expect(find.text('Alpha · working'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-effort-session-s-2')));
      expect(opened, ['s-2']);
      await tester.tap(find.byKey(const ValueKey('mc-effort-session-s-x')));
      expect(opened, ['s-2'], reason: 'a closed session has nothing to open');
      expect(find.text('Alpha · closed'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the cards that wait for the person are on it, with Answer', (tester) async {
      await pump(tester, 'e-ask');
      expect(find.text('Waiting on you (1)'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an effort that is gone says so, never a blank page', (tester) async {
      await pump(tester, 'e-nobody');
      expect(find.byKey(const ValueKey('mc-effort-gone')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the feed asks an older server again', () {
    test('a 404 is left alone for a while, then asked again - however often it is polled meanwhile (an upgrade is picked up)', () async {
      final server = _Server()..effortsStatus = 404;
      final feed = server.feed(effortsRetry: const Duration(milliseconds: 400));
      addTearDown(feed.dispose);
      await feed.refresh();
      expect(feed.efforts, isNull);
      server.effortsStatus = 200; // the authority is upgraded
      // Polls arrive well inside the window; a skipped poll must not slide it on (it once did, forever).
      for (var i = 0; i < 30 && feed.efforts == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        await feed.refresh();
      }
      expect(feed.efforts, isNotNull, reason: 'asked again after the window, not never');
    });
  });

  group('the home picks the Running view, or the Now screen', () {
    late _Server server;
    late McFeed feed;

    Future<void> pump(WidgetTester tester) async {
      await _size(tester, const Size(1400, 2400));
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: feed, onShowSessionsHome: () {}),
      ));
      await feed.refresh();
      await tester.pump();
      await tester.pump();
    }

    setUp(() {
      server = _Server();
      feed = server.feed();
    });
    tearDown(() => feed.dispose());

    testWidgets('an authority that sends efforts: the Running view', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-running-list')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-now-list')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an older authority (404): the Now screen, unchanged, and not asked again every poll', (tester) async {
      server.effortsStatus = 404;
      await pump(tester);
      expect(feed.efforts, isNull);
      expect(find.byKey(const ValueKey('mc-now-list')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-running-list')), findsNothing);
      expect(find.text('Answer now (2)'), findsOneWidget);
      final before = server.effortsCalls;
      await feed.refresh();
      await feed.refresh();
      expect(server.effortsCalls, before, reason: 'a 404 is left alone for a while');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an answer with no efforts list is no efforts answer: the Now screen', (tester) async {
      server.effortsBody = _now();
      await pump(tester);
      expect(feed.efforts, isNull);
      expect(find.byKey(const ValueKey('mc-now-list')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a failed read keeps the last efforts on screen and says why they are old', (tester) async {
      await pump(tester);
      expect(feed.effortsMessage, isNull);
      server.effortsStatus = 500;
      await feed.refresh();
      await tester.pump();
      expect(feed.efforts, isNotNull, reason: 'older efforts that say they are old beat a blank screen');
      expect(feed.effortsMessage, startsWith('Efforts could not be read'));
      expect(find.byKey(const ValueKey('mc-running-list')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-stale')), findsOneWidget);
      server.effortsStatus = 200;
      await feed.refresh();
      await tester.pump();
      expect(feed.effortsMessage, isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an effort opens its page over the home; Back returns to the Running home', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-effort-name-e-stuck')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-effort-page')), findsOneWidget);
      expect(find.text('Migrate the store'), findsWidgets);
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-effort-page')), findsNothing);
      expect(find.byKey(const ValueKey('mc-running-list')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
