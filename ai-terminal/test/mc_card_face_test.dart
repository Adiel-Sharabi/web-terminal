// #548 / #547 - what a Mission Control card says on its face: the first line of a decision's context
// under the question (the whole text opens with the card), and a wait the person may have answered
// in ANOTHER session - tagged with that session's name and offered "Tell it", which posts the
// server's route. The server decides who counts and what is sent; the companion only shows it.
// From SYNTHETIC rows.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/card_decision.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

const _context = 'A rule is on a pushed branch, unmerged. A test VM is held for QA.\nThe second line is for the opened card.';

Map<String, dynamic> _card({Map<String, dynamic>? answeredIn, String? context = _context, bool maybeAnswered = false}) => {
      'id': 'alpha|s-1|decision:100',
      'kind': 'decision',
      'server': 'alpha',
      'sessionId': 's-1',
      'sessionName': 'parent-orch',
      'project': 'support',
      'subjectKey': 'ado:7001',
      'ref': 'ado:7001',
      'title': 'Split upgrade not migrated',
      'what': 'rule branch + test VM: land/defer',
      'why': {'blocks': 1, 'blockedSessions': <dynamic>[], 'subjects': ['ado:7001'], 'severity': null, 'ageMin': 12, 'text': 'blocks this session and 1 work item'},
      'rank': 1,
      'askedAt': 100,
      'decision': {
        'question': 'How should the two leftovers be finished?',
        if (context != null) 'context': context,
        'options': [
          {'label': 'Defer both'},
          {'label': 'Land the rule'},
        ],
      },
      'hasQuestion': false,
      'maybeAnswered': maybeAnswered || answeredIn != null,
      'answeredIn': ?answeredIn,
    };

const _answeredIn = {'server': 'alpha', 'sessionId': 's-2', 'name': 'WI 7001 audit port', 'at': 200};

class _Server {
  final List<http.Request> posts = [];
  Map<String, dynamic> tell = const {'delivered': true};
  List<Map<String, dynamic>> cards = [];

  McFeed feed() => McFeed(
        servers: () => const [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          if (req.method == 'POST') {
            posts.add(req);
            if (req.url.path == '/api/mc/tell') return http.Response(jsonEncode({'cardId': 'x', 'tell': tell}), 200);
            return http.Response(jsonEncode({'ok': true}), 200);
          }
          return http.Response(jsonEncode({'generatedAt': 1, 'answerNow': cards, 'todo': <dynamic>[], 'moving': {'working': 0, 'idle': 0, 'total': 0}, 'projects': <dynamic>[]}), 200);
        })),
      );
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('mcContextLine: the first line a card shows', () {
    test('the first non-empty line, trimmed; nothing when there is none', () {
      expect(mcContextLine(_context), 'A rule is on a pushed branch, unmerged. A test VM is held for QA.');
      expect(mcContextLine('\n  \n  second  \nthird'), 'second');
      expect(mcContextLine('   '), isNull);
      expect(mcContextLine(''), isNull);
      expect(mcContextLine(null), isNull);
    });
  });

  group('the card on Now', () {
    Future<void> pump(WidgetTester tester, McCard c, {VoidCallback? onTell}) async {
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SingleChildScrollView(
            child: McAnswerCard(card: c, onAnswer: () {}, onLater: (_) {}, onTodo: () {}, onTell: onTell),
          ),
        ),
      ));
    }

    testWidgets('#548 the face shows the first line of the context under the question; opened, the whole context replaces it', (tester) async {
      await pump(tester, McCard.fromJson(_card())!);
      expect(find.text('ado:7001  Split upgrade not migrated'), findsOneWidget);
      expect(find.text('How should the two leftovers be finished?'), findsOneWidget);
      final line = find.byKey(const ValueKey('mc-card-context-line'));
      expect(tester.widget<Text>(line).data, 'A rule is on a pushed branch, unmerged. A test VM is held for QA.');
      expect(find.byKey(const ValueKey('mc-card-decision-context')), findsNothing, reason: 'the whole text is for the opened card');
      await tester.tap(find.byKey(const ValueKey('mc-card-expand')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-card-context-line')), findsNothing, reason: 'not printed twice');
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-card-decision-context'))).data, _context);
    });

    testWidgets('#548 a decision with no context shows no line', (tester) async {
      await pump(tester, McCard.fromJson(_card(context: null))!);
      expect(find.byKey(const ValueKey('mc-card-context-line')), findsNothing);
      expect(find.text('How should the two leftovers be finished?'), findsOneWidget);
    });

    testWidgets('#547 a wait answered in another session names it in the tag and offers Tell it', (tester) async {
      var told = 0;
      await pump(tester, McCard.fromJson(_card(answeredIn: _answeredIn))!, onTell: () => told++);
      final tag = find.byKey(const ValueKey('mc-card-maybe-answered'));
      expect(tag, findsOneWidget);
      expect(find.text('may be answered in "WI 7001 audit port"'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-card-tell')));
      expect(told, 1);
    });

    testWidgets('#547 a card nothing was typed elsewhere for has no tag and no Tell it, even when the screen can send one', (tester) async {
      await pump(tester, McCard.fromJson(_card())!);
      expect(find.byKey(const ValueKey('mc-card-maybe-answered')), findsNothing);
      expect(find.byKey(const ValueKey('mc-card-tell')), findsNothing);
    });

    test('#547 the card parses answeredIn; a server without it sends none', () {
      final c = McCard.fromJson(_card(answeredIn: _answeredIn))!;
      expect(c.maybeAnswered, isTrue);
      expect((c.answeredIn?.sessionId, c.answeredIn?.name, c.answeredIn?.server), ('s-2', 'WI 7001 audit port', 'alpha'));
      expect(c.answeredIn?.at, DateTime.fromMillisecondsSinceEpoch(200));
      expect(McCard.fromJson(_card())!.answeredIn, isNull);
      expect(McCard.fromJson({..._card(), 'answeredIn': {'name': 'no id'}})!.answeredIn, isNull);
      expect(McCard.fromJson({..._card(), 'answeredIn': 'junk'})!.answeredIn, isNull);
    });
  });

  group('Tell it from the Now screen', () {
    late _Server server;
    late McFeed feed;

    Future<void> pump(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1400, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: McNowView(feed: feed, onAnswer: (_) {}, onOpenSession: (_) {})),
      ));
      await feed.refresh();
      await tester.pump();
    }

    setUp(() {
      server = _Server()..cards = [_card(answeredIn: _answeredIn)];
      feed = server.feed();
    });
    tearDown(() => feed.dispose());

    testWidgets('one tap posts the card id to the server and says the session was told', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-card-tell')));
      await tester.pump();
      await tester.pump();
      expect(server.posts.map((r) => '${r.url.path} ${r.body}'), ['/api/mc/tell {"cardId":"alpha|s-1|decision:100"}']);
      expect(find.text('The session was told it was answered in "WI 7001 audit port"'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('a refusal is said in the server\'s words, with what to do', (tester) async {
      server.tell = {'delivered': false, 'refused': 'draft', 'reason': 'it has unsent text in its prompt box'};
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-card-tell')));
      await tester.pump();
      await tester.pump();
      expect(find.text('Not told yet: it has unsent text in its prompt box. Press Tell it again when it can be told'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
