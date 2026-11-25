// #550 - Answer now holds still while the person works, and an answered card leaves at once.
//   * a card already on screen never moves because another card arrived: the new ones wait behind
//     an "N new" pill and join on the pill, a pull to refresh or coming back to Mission Control;
//   * a card the server drops goes, and the scroll stays anchored on the card in use;
//   * an answered card folds into a slim "Answered: <choice>" row at once, the row fades out, and
//     a card the server still lists after the grace comes back as "not taken";
//   * after an answer the feed asks again quickly (McFeed.hurry) instead of waiting for the poll.
// From SYNTHETIC rows over a faked server.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/answer_sheet.dart';
import 'package:ai_terminal/api/mc_ask_models.dart';
import 'package:ai_terminal/screens/mission_control/card_decision.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/services/mc_pick_sender.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

const _decision = {
  'question': 'Which database?',
  'context': 'The migration runs tonight.',
  'options': [
    {'label': 'sqlite', 'consequence': 'one file, no server'},
    {'label': 'postgres', 'consequence': 'a server to run'},
  ],
  'recommended': 0,
};

String _id(String n) => 'Home|s$n|ask:$n.abcd1234';

Map<String, dynamic> _ask(String n) => {
      'id': _id(n),
      'kind': 'ask',
      'blocking': false,
      'server': 'Home',
      'sessionId': 's$n',
      'sessionName': 'Lead $n',
      'ref': 'acme/web#$n',
      'title': 'Fix $n',
      'what': 'Which database for $n?',
      'why': {
        'blocks': 0,
        'blockedSessions': <dynamic>[],
        'subjects': <dynamic>[],
        'severity': null,
        'ageMin': 12,
        'text': 'the session is still working: this does not hold it up',
      },
      'rank': 2,
      'askedAt': 1000,
      'askId': 'abcd1234',
      'replyPrefix': 'Answer to "Which database for $n?" [ask:abcd1234]: ',
      'maybeAnswered': false,
      'decision': _decision,
      'hasQuestion': false,
    };

class _Server {
  /// The server's Answer-now list, in its order (asks), then [extra] (any other kind of card).
  List<String> cards = [];
  List<Map<String, dynamic>> extra = [];
  int nowCalls = 0;

  McFeed feed({Duration pollInterval = const Duration(seconds: 10)}) => McFeed(
        servers: () => const [_a],
        pollInterval: pollInterval,
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          nowCalls++;
          final fixture = jsonDecode(File('test/fixtures/mc_now.json').readAsStringSync()) as Map<String, dynamic>;
          return http.Response(jsonEncode({...fixture, 'answerNow': [for (final n in cards) _ask(n), ...extra]}), 200);
        })),
      );
}

class _FakeAnalyst extends McAnalyst {
  _FakeAnalyst() : super(servers: () => const [_a], client: ApiClient.new);
}

/// What the home sends an answer through: every send is a success, and is written down.
class _FakePicks implements McPickSender {
  final List<String> sends = [];
  final List<String> questions = [];

  @override
  Future<bool> send(McCard card, String text, {McQuestionAsk? shown}) async {
    sends.add(text);
    return true;
  }

  @override
  Future<PendingQuestion?> pendingQuestion(McCard card) async => PendingQuestion(toolUseId: 'tu-1', questions: [
        PendingQuestionItem(
          header: 'Color',
          question: 'Pick a color',
          multiSelect: false,
          hasPreview: false,
          options: const [QuestionOption(label: 'Red'), QuestionOption(label: 'Blue')],
        ),
      ]);

  @override
  Future<bool> answerQuestion(McCard card, PendingQuestion shown, List<AnswerFrame> frames) async {
    questions.add(card.id);
    return true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Past the Undo window and the toast's exit (the card's own `sent` state, and its row, start here).
Future<void> _pastUndo(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 500));
  await tester.pump(kMcUndoWindow + const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  Finder card(String n) => key('mc-card-${_id(n)}');
  Finder inCard(String n, String k) => find.descendant(of: card(n), matching: key(k));
  double top(WidgetTester tester, String n) => tester.getTopLeft(card(n)).dy;

  group('one card answered', () {
    late List<String> sent;
    late List<McCardUse> uses;

    Future<void> pumpCard(WidgetTester tester) async {
      sent = [];
      uses = [];
      tester.view.physicalSize = const Size(900, 1800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SingleChildScrollView(
            child: McAnswerCard(
              card: McCard.fromJson(_ask('1'))!,
              onAnswer: () {},
              onLater: (_) {},
              onTodo: () {},
              onUse: uses.add,
              onReply: (c, text) async {
                sent.add(text);
                return true;
              },
            ),
          ),
        ),
      ));
    }

    testWidgets('an answered card folds into a slim "Answered: <choice>" row at once', (tester) async {
      await pumpCard(tester);
      final before = tester.getSize(find.byType(McAnswerCard)).height;
      await tester.tap(key('mc-card-option-1'));
      await tester.pump();
      expect(key('mc-card-heading'), findsOneWidget, reason: 'inside the Undo window the card is whole');
      await _pastUndo(tester);
      expect(sent, ['postgres']);
      expect(find.textContaining('Answered: postgres'), findsOneWidget);
      expect(key('mc-card-heading'), findsNothing, reason: 'the card is folded away, not left full-size');
      expect(key('mc-card-option-0'), findsNothing);
      final row = tester.getSize(find.byType(McAnswerCard)).height;
      expect(row, lessThan(before / 3), reason: 'a slim row, not the card');
      expect(row, greaterThan(20));
      expect(uses, [McCardUse.inUse, McCardUse.answered]);
    });

    testWidgets('the row fades out and leaves no space; the list is told', (tester) async {
      await pumpCard(tester);
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      // the row stays for kMcAnsweredShow, then fades (its opacity goes to 0), then leaves
      var faded = false;
      for (var i = 0; i < 80 && !faded; i++) {
        await tester.pump(const Duration(milliseconds: 50));
        final fade = find.ancestor(of: key('mc-card-answered'), matching: find.byType(AnimatedOpacity));
        faded = fade.evaluate().isNotEmpty && tester.widget<AnimatedOpacity>(fade).opacity == 0;
      }
      expect(faded, isTrue, reason: 'the row fades out');
      expect(key('mc-card-answered'), findsOneWidget, reason: 'while it fades it still takes its place');
      await tester.pump(kMcAnsweredFade + const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(key('mc-card-answered'), findsNothing);
      expect(tester.getSize(find.byType(McAnswerCard)).height, 0);
      expect(uses, [McCardUse.inUse, McCardUse.answered, McCardUse.gone]);
    });

    testWidgets('a card the server still lists after the grace comes back as "not taken" and answers again', (tester) async {
      await pumpCard(tester);
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      await tester.pump(kMcAnsweredShow + kMcAnsweredFade + const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(key('mc-card-heading'), findsNothing, reason: 'folded, faded and out of the way meanwhile');
      await tester.pump(kMcSentGrace);
      await tester.pumpAndSettle();
      expect(key('mc-card-heading'), findsOneWidget, reason: 'it is back');
      expect(find.textContaining('Not taken'), findsOneWidget);
      expect(key('mc-card-answered'), findsNothing);
      expect(tester.widget<ActionChip>(key('mc-card-option-1')).onPressed, isNotNull, reason: 'it answers again');
      expect(uses, [McCardUse.inUse, McCardUse.answered, McCardUse.gone, McCardUse.idle]);
      await tester.tap(key('mc-card-option-1'));
      await tester.pump();
      await _pastUndo(tester);
      expect(sent, ['sqlite', 'postgres']);
    });

    testWidgets('a refused send folds nothing', (tester) async {
      await pumpCard(tester);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SingleChildScrollView(
            child: McAnswerCard(
              card: McCard.fromJson(_ask('1'))!,
              onAnswer: () {},
              onLater: (_) {},
              onTodo: () {},
              onUse: uses.add,
              onReply: (c, text) async => false,
            ),
          ),
        ),
      ));
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(key('mc-card-answered'), findsNothing);
      expect(key('mc-card-heading'), findsOneWidget);
      expect(uses.last, McCardUse.idle);
    });
  });

  group('the Now list holds still', () {
    late _Server server;
    late McFeed feed;
    late List<String> sent;

    Future<void> pump(WidgetTester tester, List<String> cards, {Size size = const Size(600, 700)}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      sent = [];
      server.cards = cards;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: McQuestionScope(
            analyst: _FakeAnalyst(),
            onSend: (c, t, s) async => true,
            onAnswer: (_) {},
            answerPort: McAnswerPort(
              pendingQuestion: (_) async => null,
              answerQuestion: (c, q, f) async => true,
              send: (c, text) async {
                sent.add(text);
                return true;
              },
              openSession: (_) {},
            ),
            child: McNowView(feed: feed, onAnswer: (_) {}, onOpenSession: (_) {}),
          ),
        ),
      ));
      await feed.refresh();
      await tester.pump();
    }

    /// The server's list changed; the app asks again (a poll).
    Future<void> poll(WidgetTester tester, List<String> cards) async {
      server.cards = cards;
      await feed.refresh();
      await tester.pump();
    }

    setUp(() {
      server = _Server();
      feed = server.feed(pollInterval: const Duration(hours: 1));
    });
    tearDown(() {
      feed.active = false;
      feed.dispose();
    });

    testWidgets('a card arriving does not move the card in use; it waits behind an "N new" pill', (tester) async {
      await pump(tester, ['1', '2', '3']);
      await tester.tap(inCard('2', 'mc-card-expand'));
      await tester.pumpAndSettle();
      final before = top(tester, '2');
      final firstBefore = top(tester, '1');
      expect(key('mc-new-pill'), findsNothing);

      await poll(tester, ['9', '1', '2', '3']);
      await tester.pumpAndSettle();

      expect(top(tester, '2'), before, reason: 'the card in use stays exactly where it was');
      expect(top(tester, '1'), firstBefore, reason: 'and so does every other card on screen');
      expect(card('9'), findsNothing, reason: 'the new card is held back');
      expect(find.descendant(of: key('mc-new-pill'), matching: find.text('1 new')), findsOneWidget);
      expect(find.text('Answer now (3)'), findsOneWidget, reason: 'the title counts what is shown');

      // a second one arrives: still the same cards, the pill counts both
      await poll(tester, ['8', '9', '1', '2', '3']);
      await tester.pumpAndSettle();
      expect(top(tester, '2'), before);
      expect(find.descendant(of: key('mc-new-pill'), matching: find.text('2 new')), findsOneWidget);

      // the pill shows them, in the server's order
      await tester.tap(key('mc-new-pill'));
      await tester.pumpAndSettle();
      expect(key('mc-new-pill'), findsNothing);
      expect(find.text('Answer now (5)'), findsOneWidget);
      expect(top(tester, '8'), lessThan(top(tester, '9')));
      expect(top(tester, '9'), lessThan(top(tester, '1')));
    });

    testWidgets('a card that changes rank keeps its slot; it moves only when the latest list is shown', (tester) async {
      await pump(tester, ['1', '2', '3']);
      await poll(tester, ['3', '2', '1']);
      expect(top(tester, '1'), lessThan(top(tester, '2')));
      expect(top(tester, '2'), lessThan(top(tester, '3')));
      expect(key('mc-new-pill'), findsNothing, reason: 'nothing arrived: there is nothing new to say');
      feed.showLatest();
      await tester.pumpAndSettle();
      expect(top(tester, '3'), lessThan(top(tester, '2')));
      expect(top(tester, '2'), lessThan(top(tester, '1')));
    });

    testWidgets('a pull to refresh shows the cards held back', (tester) async {
      await pump(tester, ['1', '2']);
      await poll(tester, ['9', '1', '2']);
      expect(card('9'), findsNothing);
      await tester.fling(key('mc-now-list'), const Offset(0, 400), 1000);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(card('9'), findsOneWidget);
      expect(key('mc-new-pill'), findsNothing);
    });

    testWidgets('coming back to Mission Control shows the cards held back', (tester) async {
      await pump(tester, ['1', '2']);
      await poll(tester, ['9', '1', '2']);
      expect(card('9'), findsNothing);
      feed.active = true; // Mission Control is the home on screen again: it asks, and shows the answer
      await tester.pump();
      await tester.pumpAndSettle();
      expect(card('9'), findsOneWidget);
      expect(key('mc-new-pill'), findsNothing);
      feed.active = false; // its poll timer must not outlive the test
    });

    testWidgets('nothing on screen to move: a new card shows at once, with no pill', (tester) async {
      await pump(tester, []);
      expect(key('mc-answer-now-empty'), findsOneWidget);
      await poll(tester, ['4']);
      expect(card('4'), findsOneWidget);
      expect(key('mc-new-pill'), findsNothing);
      expect(find.text('Answer now (1)'), findsOneWidget);
    });

    testWidgets('a card the server drops goes; the card in use stays where it was on the screen', (tester) async {
      await pump(tester, ['1', '2', '3', '4', '5', '6', '7']);
      // scrolled down, so the cards above the one in use can go without the list running out of room
      await tester.ensureVisible(inCard('5', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('5', 'mc-card-expand'));
      await tester.pumpAndSettle();
      final before = top(tester, '5');
      final scrolled = tester.state<ScrollableState>(find.byType(Scrollable).first).position.pixels;
      expect(scrolled, greaterThan(300), reason: 'the premise: the list is scrolled well down');

      await poll(tester, ['1', '3', '4', '5', '6', '7']); // the server dropped '2', above the card in use
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.pumpAndSettle();

      expect(card('2'), findsNothing, reason: 'a card the server dropped goes');
      expect((top(tester, '5') - before).abs(), lessThan(1), reason: 'the card in use did not move');
    });

    testWidgets('the card in use that the server drops is not the one held: the other open card stays put', (tester) async {
      await pump(tester, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
      await tester.ensureVisible(inCard('9', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('9', 'mc-card-expand')); // card 9 is open
      await tester.pumpAndSettle();
      await tester.ensureVisible(inCard('7', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('7', 'mc-card-expand')); // card 7, above it, is the one opened last
      await tester.pumpAndSettle();
      expect(tester.state<ScrollableState>(find.byType(Scrollable).first).position.pixels, greaterThan(500), reason: 'the premise: room to hold the card in place');
      final before = top(tester, '9');

      await poll(tester, ['1', '2', '3', '4', '5', '6', '8', '9', '10']); // the server dropped '7', the card in use
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.pumpAndSettle();

      expect(card('7'), findsNothing, reason: 'a card the server dropped goes');
      expect((top(tester, '9') - before).abs(), lessThan(1), reason: 'the other card in use did not move');
    });

    /// A mouse wheel over the list: [dy] > 0 scrolls down. It moves the offset without ever setting
    /// isScrollingNotifier, as on desktop.
    Future<void> wheel(WidgetTester tester, double dy) async {
      final pointer = TestPointer(1, PointerDeviceKind.mouse);
      await tester.sendEventToBinding(pointer.hover(tester.getCenter(key('mc-now-list'))));
      await tester.sendEventToBinding(pointer.scroll(Offset(0, dy)));
      await tester.pump(const Duration(milliseconds: 16));
    }

    ScrollPosition listPosition(WidgetTester tester) => tester.state<ScrollableState>(find.byType(Scrollable).first).position;

    testWidgets('a poll that changes nothing on screen leaves the mouse wheel alone', (tester) async {
      await pump(tester, ['1', '2', '3', '4', '5', '6', '7']);
      await tester.ensureVisible(inCard('5', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('5', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await poll(tester, ['1', '2', '3', '4', '5', '6', '7']);
      final before = listPosition(tester).pixels;
      expect(before, greaterThan(300), reason: 'the premise: scrolled well down, a card in use');
      for (var i = 0; i < 3; i++) {
        await wheel(tester, -60);
      }
      await tester.pumpAndSettle();
      expect(listPosition(tester).pixels, before - 180, reason: 'every notch moved the list: no anchor undid one');
    });

    testWidgets('the person scrolling wins over the anchor: after a card above went, the wheel moves the list and it stays moved', (tester) async {
      await pump(tester, ['1', '2', '3', '4', '5', '6', '7']);
      await tester.ensureVisible(inCard('5', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('5', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await poll(tester, ['1', '3', '4', '5', '6', '7']); // the anchor is working: '2' went, above the card in use
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      final held = top(tester, '5');
      await wheel(tester, -60);
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(top(tester, '5'), closeTo(held + 60, 1), reason: 'the notch stayed: the anchor did not pull the card back');
    });

    testWidgets('answering one card folds it without moving the other card the person has open', (tester) async {
      await pump(tester, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
      await tester.ensureVisible(inCard('7', 'mc-card-option-0'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('7', 'mc-card-option-0')); // card 7: an answer inside its Undo window
      await tester.pump();
      await tester.ensureVisible(inCard('8', 'mc-card-expand'));
      await tester.pump();
      await tester.tap(inCard('8', 'mc-card-expand')); // card 8, below it, is the one open
      await tester.pumpAndSettle();
      expect(listPosition(tester).pixels, greaterThan(400), reason: 'the premise: room to hold the card in place');
      final before = top(tester, '8');
      await _pastUndo(tester); // card 7 is sent, folds, fades and goes
      expect(sent, ['sqlite']);
      expect(inCard('7', 'mc-card-heading'), findsNothing);
      expect((top(tester, '8') - before).abs(), lessThan(1), reason: 'the card the person is on stayed; the folding one did not hold the scroll');
    });

    testWidgets('the card the person opened last holds the scroll, not the topmost card that is open', (tester) async {
      await pump(tester, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
      await tester.ensureVisible(inCard('6', 'mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('6', 'mc-card-expand')); // card 6 is open, above the others
      await tester.pumpAndSettle();
      await tester.ensureVisible(inCard('7', 'mc-card-option-0'));
      await tester.pumpAndSettle();
      await tester.tap(inCard('7', 'mc-card-option-0')); // card 7: an answer inside its Undo window
      await tester.pump();
      await tester.ensureVisible(inCard('8', 'mc-card-expand'));
      await tester.pump();
      await tester.tap(inCard('8', 'mc-card-expand')); // card 8 is the one opened last
      await tester.pumpAndSettle();
      expect(listPosition(tester).pixels, greaterThan(400), reason: 'the premise: room to hold the card in place');
      final before = top(tester, '8');
      await _pastUndo(tester); // card 7, between the two open cards, is sent and folds
      expect(sent, ['sqlite']);
      expect(inCard('7', 'mc-card-heading'), findsNothing);
      expect((top(tester, '8') - before).abs(), lessThan(1), reason: 'the card opened last held the scroll; the topmost open card (6) did not');
    });

    testWidgets('an answer that went out from elsewhere folds the card, a merge keeps it a row, and still listed it comes back', (tester) async {
      await pump(tester, ['1', '2', '3']);
      feed.answerWentOut(feed.now!.answerNow.firstWhere((c) => c.id == _id('2')), shown: 'sqlite'); // the answer sheet's route
      await tester.pump();
      await tester.pump(kMcCollapse + const Duration(milliseconds: 100));
      expect(find.textContaining('Answered: sqlite'), findsOneWidget);
      expect(inCard('2', 'mc-card-heading'), findsNothing, reason: 'folded at once, not left full-size');
      expect(find.text('Answer now (2)'), findsOneWidget);

      await poll(tester, ['9', '1', '2', '3']); // another card arrives; '2' is still listed
      await tester.tap(key('mc-new-pill'));
      await tester.pumpAndSettle();
      expect(card('9'), findsOneWidget);
      expect(inCard('2', 'mc-card-heading'), findsNothing, reason: 'the merge did not bring the card back whole');
      expect(find.textContaining('Answered: sqlite'), findsOneWidget);

      await tester.pump(kMcAnsweredShow + kMcAnsweredFade + const Duration(seconds: 1));
      await tester.pumpAndSettle();
      await tester.pump(kMcSentGrace);
      await tester.pumpAndSettle();
      expect(inCard('2', 'mc-card-heading'), findsOneWidget, reason: 'the server still lists it: not taken');
      expect(find.textContaining('Not taken'), findsOneWidget);
      expect(find.text('Answer now (4)'), findsOneWidget);
    });

    testWidgets('an answered card is not counted at once; its row outlives the server\'s drop and then leaves', (tester) async {
      await pump(tester, ['1', '2', '3']);
      expect(find.text('Answer now (3)'), findsOneWidget);
      await tester.tap(inCard('2', 'mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(sent, ['sqlite']);
      expect(find.text('Answer now (2)'), findsOneWidget, reason: 'it was answered: it does not count any more');
      expect(find.textContaining('Answered: sqlite'), findsOneWidget);

      await poll(tester, ['1', '3']); // the server dropped it
      expect(find.textContaining('Answered: sqlite'), findsOneWidget, reason: 'the row is not cut short');
      await tester.pump(kMcAnsweredShow + kMcAnsweredFade + const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(card('2'), findsNothing, reason: 'faded, and no longer listed: gone');
      expect(find.text('Answer now (2)'), findsOneWidget);
      expect(card('1'), findsOneWidget);
      expect(card('3'), findsOneWidget);
    });
  });

  group('Mission Control home: an answer folds its card wherever it was typed, and Now is read again', () {
    const wait = {
      'id': 'Alpha|s1|wait:7',
      'kind': 'wait',
      'server': 'Alpha',
      'sessionId': 's1',
      'sessionName': 'fixer',
      'ref': 'acme/web#7',
      'title': 'Federator',
      'what': 'Try the build and tell me',
    };
    const question = {
      'id': 'Alpha|s2|question:8',
      'kind': 'question',
      'server': 'Alpha',
      'sessionId': 's2',
      'sessionName': 'builder',
      'ref': 'acme/web#8',
      'title': 'Colors',
      'what': 'answer a question',
      'questions': [
        {'header': 'Color', 'text': 'Pick a color'},
      ],
    };

    late _Server server;
    late McFeed feed;
    late _FakePicks picks;

    Future<void> pumpHome(WidgetTester tester, {List<String> cards = const [], List<Map<String, dynamic>> extra = const []}) async {
      tester.view.physicalSize = const Size(1400, 1800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          {'name': _a.name, 'baseUrl': _a.baseUrl, 'bearerToken': _a.bearerToken},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      final repo = SessionRepository.forTest(
          store: store, clientFactory: (sv) => ApiClient(sv, httpClient: MockClient((_) async => http.Response('[]', 200))));
      server.cards = cards;
      server.extra = extra;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: feed, picks: picks, repository: repo, servers: () => const [_a], onShowSessionsHome: () {}),
      ));
      await tester.pumpAndSettle();
    }

    /// Leaves the home (it stops the feed's timers), as a test must before it ends.
    Future<void> leave(WidgetTester tester) => tester.pumpWidget(const SizedBox());

    setUp(() {
      server = _Server();
      feed = server.feed(pollInterval: const Duration(hours: 1));
      picks = _FakePicks();
    });
    tearDown(() => feed.dispose());

    testWidgets('an option tapped on a card: sent, folded, and Now is read again within seconds', (tester) async {
      await pumpHome(tester, cards: ['1', '2']);
      final base = server.nowCalls;
      await tester.tap(inCard('1', 'mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(picks.sends, ['sqlite']);
      expect(find.textContaining('Answered: sqlite'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(server.nowCalls - base, greaterThanOrEqualTo(2), reason: 'the poll is an hour away: only the quick re-reads explain these');
      await leave(tester);
    });

    testWidgets('a wait answered on the sheet folds its card at once and Now is read again', (tester) async {
      await pumpHome(tester, extra: [wait]);
      expect(find.text('Answer now (1)'), findsOneWidget);
      final base = server.nowCalls;
      await tester.tap(key('mc-card-answer'));
      await tester.pumpAndSettle();
      await tester.enterText(key('mc-answer-text'), 'built, works');
      await tester.tap(key('mc-answer-send'));
      await tester.pumpAndSettle();
      expect(picks.sends, ['built, works']);
      expect(key('mc-answer-sheet'), findsNothing);
      expect(find.textContaining('Answered: built, works'), findsOneWidget, reason: 'the card on Now folded, though the card itself was not the one answered');
      expect(find.text('Answer now (0)'), findsOneWidget);
      expect(server.nowCalls - base, greaterThanOrEqualTo(1));
      await leave(tester);
    });

    testWidgets('a question answered on its card: Now is read again within seconds', (tester) async {
      await pumpHome(tester, extra: [question]);
      final base = server.nowCalls;
      await tester.tap(key('mc-card-expand'));
      await tester.pumpAndSettle();
      await tester.tap(key('mc-card-qopt-1'));
      await tester.pump();
      await _pastUndo(tester);
      expect(picks.questions, ['Alpha|s2|question:8']);
      await tester.pump(const Duration(seconds: 3));
      expect(server.nowCalls - base, greaterThanOrEqualTo(2), reason: 'the poll is an hour away: only the quick re-reads explain these');
      await leave(tester);
    });
  });

  group('McFeed', () {
    testWidgets('seenEpoch changes with an answer asked for after a refresh(show: true), never with a plain poll', (tester) async {
      final server = _Server()..cards = ['1'];
      final feed = server.feed(pollInterval: const Duration(hours: 1));
      addTearDown(feed.dispose);
      await feed.refresh();
      final e0 = feed.seenEpoch;
      await feed.refresh();
      expect(feed.seenEpoch, e0, reason: 'a poll is not a request to see the latest');
      final pending = feed.refresh(show: true);
      expect(feed.seenEpoch, e0, reason: 'not before the answer arrives');
      await pending;
      expect(feed.seenEpoch, e0 + 1);
      feed.showLatest();
      expect(feed.seenEpoch, e0 + 2);
    });

    testWidgets('hurry asks again every couple of seconds for a while, then stops', (tester) async {
      final server = _Server()..cards = ['1'];
      final feed = server.feed(pollInterval: const Duration(hours: 1));
      addTearDown(() {
        feed.active = false;
        feed.dispose();
      });
      feed.active = true;
      await tester.pump();
      final base = server.nowCalls;
      feed.hurry();
      await tester.pump();
      await tester.pump(const Duration(seconds: 7));
      expect(server.nowCalls - base, greaterThanOrEqualTo(4), reason: 'now, then every 2 s');
      await tester.pump(const Duration(seconds: 30));
      final settled = server.nowCalls;
      await tester.pump(const Duration(seconds: 30));
      expect(server.nowCalls, settled, reason: 'the window is over: back to the poll alone');
      feed.active = false; // its poll timer must not outlive the test
    });

    testWidgets('answerWentOut records the answer per card, re-reads Now quickly, and forgets a card the server dropped', (tester) async {
      final server = _Server()..cards = ['1', '2'];
      final feed = server.feed(pollInterval: const Duration(hours: 1));
      addTearDown(() {
        feed.active = false;
        feed.dispose();
      });
      await feed.refresh();
      final c1 = feed.now!.answerNow.first;
      expect(feed.sentFor(c1.id), isNull);
      feed.active = true;
      await tester.pump();
      final base = server.nowCalls;
      var told = 0;
      feed.addListener(() => told++);
      feed.answerWentOut(c1, shown: 'sqlite');
      expect(told, 1, reason: 'the cards are told at once');
      final first = feed.sentFor(c1.id)!;
      expect(first.shown, 'sqlite');
      await tester.pump(const Duration(seconds: 5));
      expect(server.nowCalls - base, greaterThanOrEqualTo(2), reason: 'Now is read again within seconds, not at the next poll');
      feed.answerWentOut(c1);
      expect(feed.sentFor(c1.id)!.seq, greaterThan(first.seq), reason: 'a second answer is told from the first');
      expect(feed.sentFor(c1.id)!.shown, isNull);
      feed.active = false; // its timers must not outlive the test (and no re-read is in flight below)
      await tester.pump();
      server.cards = ['2']; // the server dropped it
      await feed.refresh();
      expect(feed.sentFor(c1.id), isNull);
    });

    testWidgets('a feed that is not active does not hurry', (tester) async {
      final server = _Server()..cards = ['1'];
      final feed = server.feed(pollInterval: const Duration(hours: 1));
      addTearDown(feed.dispose);
      feed.hurry();
      await tester.pump(const Duration(seconds: 10));
      expect(server.nowCalls, 0);
    });
  });
}
