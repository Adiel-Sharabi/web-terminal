// #567 - Mission Control's work board (step 1, read-only): the wire, the feed (an older authority, a failed
// read, another server's board never kept), the five columns side by side and as swipeable pages, the card
// (source, project, state, age in its column, the wait badge), the candidates per source with their state,
// and what a tap opens. The server owns every rule, so the tests feed its answer and read what is on screen.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/board_view.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/services/mc_board_feed.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');
const _b = ServerConfig(name: 'Beta', baseUrl: 'http://beta.test:7681', bearerToken: 'tb');

const int _t0 = 1767223080000;

Map<String, dynamic> _board() => jsonDecode(File('test/fixtures/mc_board.json').readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> _now() => jsonDecode(File('test/fixtures/mc_now.json').readAsStringSync()) as Map<String, dynamic>;

/// What the authority answers: Now (so Mission Control knows its server), and the board.
class _Server {
  int boardStatus = 200;
  Object? boardBody;
  final List<Uri> boardCalls = [];
  List<ServerConfig> servers = const [_a];

  ApiClient client(ServerConfig sv) => ApiClient(sv, httpClient: MockClient((req) async {
        if (req.url.path == '/api/mc/board') {
          boardCalls.add(req.url);
          if (boardStatus != 200) return http.Response(jsonEncode({'error': 'no'}), boardStatus);
          return http.Response(jsonEncode(boardBody ?? _board()), 200);
        }
        if (req.url.path == '/api/mc/now') return http.Response(jsonEncode(_now()), 200);
        return http.Response(jsonEncode({'error': 'Not found'}), 404);
      }));

  McFeed feed() => McFeed(servers: () => servers, client: client);
}

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

double _left(WidgetTester tester, String key) => tester.getTopLeft(find.byKey(ValueKey(key))).dx;

String _textOf(WidgetTester tester, String key) => tester.widget<Text>(find.byKey(ValueKey(key))).data!;

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
  });
  tearDown(() => SessionSelection.instance.reset());

  group('wire', () {
    test('every field is read: columns, cards, badges, sessions, candidate sources with their state', () {
      final b = McBoard.fromJson(_board());
      expect(b.columns.map((c) => c.id), ['in-progress', 'pr-review', 'committed-merged', 'ready-for-test']);
      expect(b.columns.map((c) => c.title), ['In progress', 'PR / in review', 'Committed / merged', 'Ready for test']);
      expect(b.workCount, 5);
      final c = b.columns.first.cards.first;
      expect(c.key, 'ado:9201');
      expect(c.refLabel, '#9201');
      expect(c.sourceKind, 'ado');
      expect(c.sourceName, 'Contoso');
      expect(c.project, 'Widgets');
      expect(c.stateLabel, 'In Progress', reason: 'the station outranks the stage');
      expect(c.since, DateTime.fromMillisecondsSinceEpoch(1767050280000));
      expect(c.live, isTrue);
      expect(c.badge.kind, 'you');
      expect(c.badge.label, 'on you');
      expect(c.badge.text, 'waiting on you: Which fix should ship?');
      expect(c.sessions.single.id, 's-9201');
      expect(c.line!.id, 'l-dec');
      final gh = b.columns.first.cards[1];
      expect(gh.stateLabel, 'Fixing');
      expect(gh.badge.rule, 'R1');
      expect(gh.sessions.map((s) => s.id), ['s-42a', 's-42b']);
      expect(b.columns.first.cards.last.since, isNull, reason: 'an unknown age is null, never a guess');
      expect(b.columns.first.cards.last.badge.isNone, isTrue);
      final cs = b.candidates;
      expect(cs.map((s) => s.id), ['github:acme/own', 'ado:contoso', 'bug-hunter']);
      expect(cs[0].own, isTrue);
      expect(cs[0].cards.single.priority, 1);
      expect(cs[1].state, 'stale');
      expect(cs[1].why, 'Azure DevOps answered HTTP 503');
      expect(cs[1].project, 'Widgets');
      expect(cs[1].more, isTrue);
      expect(cs[1].hidden, 2);
      expect(cs[1].cards.single.type, 'Bug');
      expect(cs[1].cards.single.severity, 3);
      expect(cs[2].dispatcher, isTrue);
      expect(cs[2].state, 'not-wired');
      expect(cs[2].heading, 'Bug hunter queue');
      expect(b.candidateCount, 2);
      expect(b.complete, isFalse);
      expect(b.refreshedAt, DateTime.fromMillisecondsSinceEpoch(1767222780000));
    });

    test('junk and absent fields are tolerated, never thrown', () {
      expect(McBoard.fromJson(null).columns, isEmpty);
      expect(McBoard.fromJson('junk').candidates, isEmpty);
      final b = McBoard.fromJson({
        'columns': [
          7,
          {'cards': []},
          {'id': 'brand-new', 'count': -4, 'cards': [3, {'title': 'no key'}, {'key': 'k1', 'badge': 'x', 'sessions': 'y', 'since': 'soon'}, {'key': 'k1'}]},
          {'id': 'brand-new'},
        ],
        'candidates': [
          {'source': {}},
          {'source': {'id': 's1'}, 'state': 5, 'cards': 'z'},
        ],
      });
      expect(b.columns.length, 1, reason: 'no id is no column; a repeated id is dropped');
      expect(b.columns.single.title, 'brand-new', reason: 'a column this app does not know is shown as sent');
      expect(b.columns.single.count, 0);
      final k = b.columns.single.cards.single;
      expect(k.key, 'k1', reason: 'no key is no card; a repeated key is dropped');
      expect(k.badge.kind, 'none');
      expect(k.sessions, isEmpty);
      expect(k.since, isNull);
      final s = b.candidates.single;
      expect(s.id, 's1');
      expect(s.state, 'ok');
      expect(s.cards, isEmpty);
      expect(s.kind, 'other');
      expect(b.complete, isTrue, reason: 'only the server saying so makes it incomplete');
      expect(const McBadge(kind: 'brand-new').label, 'brand-new', reason: 'a badge kind this app does not know is shown as sent');
    });
  });

  group('the feed', () {
    late _Server server;
    late McFeed mc;
    late McBoardFeed board;

    Future<void> boot({Duration retry = kBoardRetry}) async {
      server = _Server();
      mc = server.feed();
      await mc.refresh();
      board = McBoardFeed(feed: mc, client: server.client, retryAfter: retry);
    }

    tearDown(() {
      board.dispose();
      mc.dispose();
    });

    test('reads the board from the server that answered Now; ?refresh=1 only when asked for', () async {
      await boot();
      expect(board.status, McBoardStatus.loading);
      await board.refresh();
      expect(board.status, McBoardStatus.ready);
      expect(board.board!.workCount, 5);
      expect(board.message, isNull);
      expect(server.boardCalls.single.query, '', reason: 'a poll never asks the server to read the trackers again');
      await board.refresh(candidates: true);
      expect(server.boardCalls.last.queryParameters, {'refresh': '1'});
    });

    test('Mission Control has not found its server: nothing is asked', () async {
      server = _Server()..servers = const [];
      mc = server.feed();
      await mc.refresh();
      board = McBoardFeed(feed: mc, client: server.client);
      await board.refresh();
      expect(server.boardCalls, isEmpty);
      expect(board.status, McBoardStatus.loading);
    });

    test('an older authority (404): unsupported, left alone for a while however often polled; the button still asks', () async {
      await boot();
      server.boardStatus = 404;
      await board.refresh();
      expect(board.status, McBoardStatus.unsupported);
      expect(board.board, isNull);
      expect(server.boardCalls.length, 1);
      await board.refresh();
      await board.refresh();
      expect(server.boardCalls.length, 1, reason: 'a 404 is not asked again every poll');
      server.boardStatus = 200;
      await board.refresh(force: true);
      expect(server.boardCalls.length, 2, reason: 'Refresh always asks');
      expect(board.status, McBoardStatus.ready, reason: 'a server upgraded since is picked up');
    });

    test('a 404 is asked again once its window has passed', () async {
      await boot(retry: const Duration(milliseconds: 1));
      server.boardStatus = 404;
      await board.refresh();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      server.boardStatus = 200;
      await board.refresh();
      expect(board.status, McBoardStatus.ready);
    });

    test('a failed read keeps the last board and says why it is old; one never read says it failed', () async {
      await boot();
      server.boardStatus = 500;
      await board.refresh();
      expect(board.status, McBoardStatus.failed);
      expect(board.message, isNotEmpty);
      server.boardStatus = 200;
      await board.refresh();
      expect(board.status, McBoardStatus.ready);
      server.boardStatus = 500;
      await board.refresh();
      expect(board.status, McBoardStatus.ready, reason: 'an old board beats a blank screen');
      expect(board.board, isNotNull);
      expect(board.message, startsWith('The board could not be read'));
      server.boardStatus = 200;
      await board.refresh();
      expect(board.message, isNull);
    });

    test('an answer with no columns list is no board', () async {
      await boot();
      server.boardBody = _now();
      await board.refresh();
      expect(board.board, isNull);
      expect(board.status, McBoardStatus.failed);
    });

    test('a 404 is held against THAT server: a different authority is asked at once', () async {
      await boot();
      server.boardStatus = 404;
      await board.refresh();
      expect(board.status, McBoardStatus.unsupported);
      expect(server.boardCalls.length, 1);
      server.servers = const [_b];
      server.boardStatus = 200;
      await mc.refresh();
      await board.refresh();
      expect(server.boardCalls.length, 2, reason: 'the window belongs to the server that answered 404');
      expect(board.status, McBoardStatus.ready);
    });

    test('a second read asked for while one is out keeps its force', () async {
      await boot();
      server.boardStatus = 404;
      final first = board.refresh(force: true);
      final second = board.refresh(force: true);
      await Future.wait([first, second]);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(server.boardCalls.length, 2, reason: 'the queued Refresh still asks a server that said 404 lately');
    });

    test("Mission Control's feed notifying asks a board that is not there only once per poll interval", () async {
      server = _Server()..servers = const [];
      mc = server.feed();
      await mc.refresh();
      board = McBoardFeed(feed: mc, client: server.client, pollInterval: const Duration(minutes: 10));
      board.active = true;
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(server.boardCalls, isEmpty, reason: 'no server found yet: nothing to ask');
      server.servers = const [_a];
      server.boardStatus = 500;
      await mc.refresh();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(server.boardCalls.length, 1, reason: 'the server was found: asked at once');
      expect(board.status, McBoardStatus.failed);
      for (var i = 0; i < 4; i++) {
        await mc.refresh();
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(server.boardCalls.length, 1, reason: 'a failing board is not asked at every notify of the feed');
    });

    test('another server\'s board is never kept under this one\'s', () async {
      await boot();
      await board.refresh();
      expect(board.board, isNotNull);
      server.servers = const [_b];
      await mc.refresh();
      expect(mc.servedBy!.name, 'Beta');
      server.boardStatus = 500;
      await board.refresh();
      expect(board.board, isNull);
      expect(board.status, McBoardStatus.failed);
    });
  });

  group('the board', () {
    late _Server server;
    late McFeed mc;
    late McBoardFeed board;
    late List<String> sessions;
    late List<String> subjects;
    late List<Uri> urls;

    Future<void> pump(WidgetTester tester, {Size size = const Size(1500, 1200)}) async {
      await _size(tester, size);
      sessions = [];
      subjects = [];
      urls = [];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McBoardView(
            feed: board,
            onOpenSession: sessions.add,
            onOpenSubject: subjects.add,
            onOpenUrl: urls.add,
            now: DateTime.fromMillisecondsSinceEpoch(_t0 + 60000),
          ),
        ),
      ));
      for (var i = 0; i < 6; i++) {
        await tester.pump();
      }
    }

    setUp(() async {
      server = _Server();
      mc = server.feed();
      await mc.refresh();
      board = McBoardFeed(feed: mc, client: server.client);
    });
    tearDown(() {
      board.dispose();
      mc.dispose();
    });

    testWidgets('desktop: five columns side by side, in the server\'s order, with their counts', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-board-wide')), findsOneWidget);
      final ids = ['candidates', 'in-progress', 'pr-review', 'committed-merged', 'ready-for-test'];
      final xs = [for (final id in ids) _left(tester, 'mc-board-title-$id')];
      for (var i = 1; i < xs.length; i++) {
        expect(xs[i], greaterThan(xs[i - 1]), reason: 'left to right: Candidates, In progress, PR / in review, Committed / merged, Ready for test');
      }
      expect(_textOf(tester, 'mc-board-title-candidates'), 'Candidates');
      expect(_textOf(tester, 'mc-board-title-pr-review'), 'PR / in review');
      expect([for (final id in ids) _textOf(tester, 'mc-board-count-$id')], ['2', '3', '1', '0', '1']);
      expect(find.text('Nothing here.'), findsOneWidget, reason: 'the empty column says so');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a card: ref and title, source, project, state, the age in its column, the wait badge and who is on it', (tester) async {
      await pump(tester);
      Finder in_(String key, String child) => find.descendant(of: find.byKey(ValueKey('mc-board-card-$key')), matching: find.byKey(ValueKey(child)));
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-card-ado:9201')), matching: find.text('#9201')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-card-title-ado:9201'), 'Decoder drops the first frame');
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-source-chip-ado:9201')), matching: find.text('Contoso · ADO')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-project-ado:9201')), matching: find.text('Widgets')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-state-ado:9201')), matching: find.text('In Progress')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-age-ado:9201')), matching: find.text('2 d in column')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-badge-ado:9201')), matching: find.text('on you')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-badge-text-ado:9201'), 'waiting on you: Which fix should ship?');
      expect(_textOf(tester, 'mc-board-sessions-ado:9201'), 'Fix decoder');
      // A GitHub item: its repo, the stage; two sessions are counted.
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-source-chip-acme/widgets#42')), matching: find.text('acme/widgets')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-state-acme/widgets#42')), matching: find.text('Fixing')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-age-acme/widgets#42')), matching: find.text('1 d in column')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-sessions-acme/widgets#42'), '2 sessions');
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-age-acme/widgets#50')), matching: find.text('6 h in column')), findsOneWidget);
      // Nobody on it, no known age: it says so and shows no age chip, no badge.
      expect(in_('ado:9202', 'mc-board-nosession-ado:9202'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-board-age-ado:9202')), findsNothing, reason: 'an unknown age is not shown');
      expect(find.byKey(const ValueKey('mc-board-badge-ado:9202')), findsNothing);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-age-ado:9100')), matching: find.text('5 d in column')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-state-ado:9100')), matching: find.text('Ready for test')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the wait badge: on you, suspect, valid wait - each its own words and colour; none shows no badge (the supervisor\'s verdict, never worked out here)', (tester) async {
      await pump(tester);
      Text label(String key) => tester.widget<Text>(find.descendant(of: find.byKey(ValueKey('mc-board-badge-$key')), matching: find.byType(Text)));
      expect(label('ado:9201').data, 'on you');
      expect(label('ado:9201').style?.color, AppColors.error);
      expect(label('acme/widgets#42').data, 'suspect wait');
      expect(label('acme/widgets#42').style?.color, AppColors.caution);
      expect(label('acme/widgets#50').data, 'valid wait');
      expect(label('acme/widgets#50').style?.color, AppColors.onSurfaceVariant);
      expect(_textOf(tester, 'mc-board-badge-text-acme/widgets#42'), 'its wait was answered; nobody told it');
      expect(find.byKey(const ValueKey('mc-board-badge-text-acme/widgets#50')), findsNothing, reason: 'a valid wait needs no attention: its words are the tooltip');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('candidates per source: what was read, an old list, a source not wired yet - each with its reason', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-board-source-github:acme/own')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-board-source-state-github:acme/own')), findsNothing, reason: 'a good read has no state tag');
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-card-acme/own#1')), matching: find.text('Add a dark mode')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-age-acme/own#1')), matching: find.text('3 d old')), findsOneWidget, reason: 'a candidate is as old as it was filed');
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-state-acme/own#1')), matching: find.text('open')), findsOneWidget);
      // ADO: the old list, the tracker's words, and what was left out.
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-source-state-ado:contoso')), matching: find.text('old list')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-source-why-ado:contoso'), 'Azure DevOps answered HTTP 503');
      expect(find.text('More in the tracker. 2 already on the board.'), findsOneWidget);
      // The bug hunter: not wired yet, and why (never a guess).
      expect(_textOf(tester, 'mc-board-source-bug-hunter'), 'Bug hunter queue');
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-source-state-bug-hunter')), matching: find.text('not wired yet')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-source-why-bug-hunter'), startsWith('Bug hunter: its queue is not readable from this server'));
      // A candidate has no live-session line.
      expect(find.byKey(const ValueKey('mc-board-nosession-acme/own#1')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a source that is loading, one that could not be read, and one with nothing new', (tester) async {
      server.boardBody = {
        'columns': <dynamic>[],
        'candidates': [
          {'source': {'id': 'g:l', 'kind': 'github', 'name': 'acme/loading'}, 'state': 'loading', 'cards': []},
          {'source': {'id': 'g:e', 'kind': 'github', 'name': 'acme/broken'}, 'state': 'error', 'why': 'GitHub answered HTTP 500', 'cards': []},
          {'source': {'id': 'g:n', 'kind': 'github', 'name': 'acme/quiet'}, 'state': 'ok', 'hidden': 3, 'cards': []},
          {'source': {'id': 'g:z', 'kind': 'github', 'name': 'acme/zero'}, 'state': 'ok', 'cards': []},
        ],
        'complete': true,
      };
      await pump(tester);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-source-state-g:l')), matching: find.text('reading…')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-board-source-state-g:e')), matching: find.text('could not read')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-source-why-g:e'), 'GitHub answered HTTP 500');
      expect(find.text('No new candidates (3 already on the board).'), findsOneWidget);
      expect(find.text('No candidates.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-board-incomplete')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the lines above the columns: when candidates were read, a machine that did not answer, why the board is old', (tester) async {
      await pump(tester);
      expect(_textOf(tester, 'mc-board-read'), 'Candidates read 6m ago');
      expect(find.byKey(const ValueKey('mc-board-incomplete')), findsOneWidget, reason: 'the fixture says a machine did not answer');
      expect(find.byKey(const ValueKey('mc-board-note')), findsNothing);
      server.boardStatus = 500;
      await board.refresh();
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-board-note')), findsOneWidget);
      expect(_textOf(tester, 'mc-board-note'), startsWith('The board could not be read'));
      expect(find.byKey(const ValueKey('mc-board-col-in-progress')), findsOneWidget, reason: 'the old board stays');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a card with a live session opens it; one with none opens the item\'s page', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-board-card-ado:9201')));
      await tester.tap(find.byKey(const ValueKey('mc-board-card-acme/widgets#42')));
      expect(sessions, ['s-9201', 's-42a'], reason: 'the first live session of the card');
      expect(subjects, isEmpty);
      await tester.tap(find.byKey(const ValueKey('mc-board-card-ado:9202')));
      await tester.tap(find.byKey(const ValueKey('mc-board-card-ado:9100')));
      expect(subjects, ['ado:9202', 'ado:9100']);
      expect(sessions.length, 2);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a candidate opens a sheet with what the tracker says and its link; it starts nothing', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-board-card-ado:9301')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-candidate-sheet')), findsOneWidget);
      expect(_textOf(tester, 'mc-candidate-title'), 'Approved bug 9301');
      expect(find.descendant(of: find.byKey(const ValueKey('mc-candidate-sheet')), matching: find.text('Bug')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-candidate-sheet')), matching: find.text('priority 2')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-candidate-sheet')), matching: find.text('severity 3')), findsOneWidget);
      expect(find.textContaining('Starting it from the board comes next'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-candidate-open')));
      expect(urls.single.toString(), 'https://dev.azure.com/fakeorg/Contoso/_workitems/edit/9301');
      expect(sessions, isEmpty);
      expect(subjects, isEmpty);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-candidate-sheet')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the sheet opens only an http(s) link, and none when the tracker gave none', (tester) async {
      Future<void> show(String? url) async {
        await tester.pumpWidget(MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(body: McCandidateSheet(card: McBoardCard(key: 'k', title: 'T', url: url), onOpenUrl: urls.add)),
        ));
      }

      urls = [];
      await show('javascript:alert(1)');
      expect(find.byKey(const ValueKey('mc-candidate-open')), findsNothing);
      await show('file:///c:/secrets.txt');
      expect(find.byKey(const ValueKey('mc-candidate-open')), findsNothing);
      await show(null);
      expect(find.byKey(const ValueKey('mc-candidate-open')), findsNothing);
      await show('https://github.com/acme/own/issues/1');
      expect(find.byKey(const ValueKey('mc-candidate-open')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('phone: one swipeable page per column, with its count; a swipe moves to the next', (tester) async {
      await pump(tester, size: const Size(400, 900));
      expect(find.byKey(const ValueKey('mc-board-narrow')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-board-wide')), findsNothing);
      for (final t in ['Candidates 2', 'In progress 3', 'PR / in review 1', 'Committed / merged 0', 'Ready for test 1']) {
        expect(find.text(t), findsOneWidget);
      }
      expect(find.byKey(const ValueKey('mc-board-card-acme/own#1')), findsOneWidget, reason: 'Candidates is the first page');
      expect(find.byKey(const ValueKey('mc-board-card-ado:9201')), findsNothing);
      await tester.drag(find.byKey(const ValueKey('mc-board-col-candidates')), const Offset(-380, 0));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-board-card-ado:9201')), findsOneWidget, reason: 'swiped to In progress');
      expect(find.byKey(const ValueKey('mc-board-card-acme/own#1')), findsNothing);
      await tester.ensureVisible(find.byKey(const ValueKey('mc-board-tab-ready-for-test')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-board-tab-ready-for-test')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-board-card-ado:9100')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('an authority with no board says so; a failed first read says why', (tester) async {
      server.boardStatus = 404;
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-board-unsupported')), findsOneWidget);
      expect(find.textContaining('has no board yet'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-board-wide')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      board.dispose();
      server.boardStatus = 500;
      board = McBoardFeed(feed: mc, client: server.client);
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-board-failed')), findsOneWidget);
      expect(find.textContaining('The board could not be read'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the board polls while it is on screen and stops when it is gone', (tester) async {
      board.dispose();
      board = McBoardFeed(feed: mc, client: server.client, pollInterval: const Duration(seconds: 30));
      await pump(tester);
      expect(board.active, isTrue);
      final n = server.boardCalls.length;
      await tester.pump(const Duration(seconds: 31));
      await tester.pump();
      expect(server.boardCalls.length, greaterThan(n), reason: 'polled again');
      await tester.pumpWidget(const SizedBox());
      expect(board.active, isFalse);
      final m = server.boardCalls.length;
      await tester.pump(const Duration(seconds: 61));
      expect(server.boardCalls.length, m, reason: 'a board nobody sees is not polled');
    });
  });

  group('the Mission Control home', () {
    late _Server server;
    late McFeed mc;

    Future<void> pump(WidgetTester tester, Size size) async {
      await _size(tester, size);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(
          feed: mc,
          clientFactory: server.client,
          onShowSessionsHome: () {},
          sessionsBoardBuilder: (open) => const Scaffold(body: Text('the sessions board')),
        ),
      ));
      await tester.pump();
      await tester.pump();
    }

    setUp(() {
      server = _Server();
      mc = server.feed();
    });
    tearDown(() => mc.dispose());

    testWidgets('desktop: Board is in the side nav; it shows the board, and Refresh reads the trackers again', (tester) async {
      await pump(tester, const Size(2000, 1000));
      expect(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text('Board')), findsOneWidget);
      expect(server.boardCalls, isEmpty, reason: 'the board is not read until its tab is open');
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text('Board')));
      for (var i = 0; i < 6; i++) {
        await tester.pump();
      }
      expect(find.byKey(const ValueKey('mc-board-wide')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-board-card-ado:9201')), findsOneWidget);
      final n = server.boardCalls.length;
      await tester.tap(find.byKey(const ValueKey('mc-board-refresh')));
      for (var i = 0; i < 6; i++) {
        await tester.pump();
      }
      expect(server.boardCalls.length, greaterThan(n));
      expect(server.boardCalls.last.queryParameters, {'refresh': '1'});
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text('Machines')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-board-wide')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a card with no session opens the item page over the home; Back returns to the Board, not to Now', (tester) async {
      await pump(tester, const Size(2000, 1000));
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text('Board')));
      for (var i = 0; i < 6; i++) {
        await tester.pump();
      }
      await tester.tap(find.byKey(const ValueKey('mc-board-card-ado:9202')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-board-wide')), findsNothing, reason: 'the item page is over the board');
      expect(find.byType(BackButton), findsWidgets);
      await tester.tap(find.byType(BackButton).first);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-board-wide')), findsOneWidget, reason: 'Back returns to where the item was opened from');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Mission Control hidden (the sessions home on screen): the board is not on screen and not polled', (tester) async {
      await _size(tester, const Size(2000, 1000));
      final active = ValueNotifier<bool>(true);
      addTearDown(active.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: mc, active: active, clientFactory: server.client, onShowSessionsHome: () {}),
      ));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('mc-rail')), matching: find.text('Board')));
      for (var i = 0; i < 6; i++) {
        await tester.pump();
      }
      expect(find.byKey(const ValueKey('mc-board-wide')), findsOneWidget);
      active.value = false;
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-board-wide')), findsNothing);
      final n = server.boardCalls.length;
      await tester.pump(const Duration(seconds: 61));
      expect(server.boardCalls.length, n, reason: 'a hidden Mission Control does not poll the board');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('phone: Board is in the bottom bar beside Now, Ask and Machines', (tester) async {
      await pump(tester, const Size(400, 860));
      for (final l in ['Now', 'Board', 'Ask', 'Machines']) {
        expect(find.descendant(of: find.byKey(const ValueKey('mc-bottom-bar')), matching: find.text(l)), findsOneWidget);
      }
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('mc-bottom-bar')), matching: find.text('Board')));
      for (var i = 0; i < 6; i++) {
        await tester.pump();
      }
      expect(find.byKey(const ValueKey('mc-board-narrow')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
