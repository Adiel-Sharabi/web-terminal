// #526 - asks: the decisions a session holds for the owner without stopping for them, and the
// question its last reply may have put that it never reported. The card is the server's
// (`kind: 'ask'` / `'possible-ask'`, `blocking: false`); the companion shows it as one that holds
// nobody up, and answers it by a reply typed from the card (the questions inbox lists only what a
// session waits on): behind the card's own prefix for an ask, so the answer names its decision.
// From SYNTHETIC rows.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_ask_models.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/ask_reply_dialog.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/services/mc_pick_sender.dart';
import 'package:ai_terminal/services/needs_you_actions.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _decision = {
  'question': 'Which database?',
  'context': 'The migration runs tonight.',
  'options': [
    {'label': 'sqlite', 'consequence': 'one file'},
    {'label': 'postgres'},
  ],
  'recommended': 0,
};

const _prefix = 'Answer to "Which database?" [ask:abcd1234]: ';

Map<String, dynamic> _askJson({bool maybeAnswered = false, String? replyPrefix = _prefix, String? askId = 'abcd1234', bool? blocking = false}) => {
      'id': 'Home|q|ask:1000.abcd1234',
      'kind': 'ask',
      'blocking': ?blocking,
      'server': 'Home',
      'sessionId': 'q',
      'sessionName': 'Lead',
      'ref': 'acme/web#7',
      'title': 'Fix login',
      'what': 'Which database?',
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
      'askId': askId,
      'replyPrefix': replyPrefix,
      'maybeAnswered': maybeAnswered,
      'decision': _decision,
      'hasQuestion': false,
    };

Map<String, dynamic> _possibleJson() => {
      'id': 'Home|q|possible:2000',
      'kind': 'possible-ask',
      'blocking': false,
      'server': 'Home',
      'sessionId': 'q',
      'sessionName': 'Lead',
      'what': 'Three earlier questions still need your answer.',
      'why': {
        'blocks': 0,
        'blockedSessions': <dynamic>[],
        'subjects': <dynamic>[],
        'severity': null,
        'ageMin': 3,
        'text': 'its last reply may ask you something it did not report',
      },
      'rank': 3,
      'askedAt': 2000,
      'askId': null,
      'replyPrefix': null,
      'maybeAnswered': false,
      'decision': null,
      'hasQuestion': false,
    };

Map<String, dynamic> _briefAsk({String id = 'abcd1234', String question = 'Which database?', bool maybeAnswered = false}) => {
      'id': id,
      'question': question,
      'context': 'The migration runs tonight.',
      'options': [
        {'label': 'sqlite'},
        {'label': 'postgres'},
      ],
      'at': 1000,
      'maybeAnswered': maybeAnswered,
    };

void main() {
  group('the ask card model', () {
    test('an ask is not blocking; every other card (and an older server\'s) is', () {
      final ask = McCard.fromJson(_askJson())!;
      expect((ask.kind, ask.blocking, ask.isAsk, ask.usesReplyDialog), ('ask', false, true, true));
      expect((ask.askId, ask.replyPrefix, ask.maybeAnswered), ('abcd1234', _prefix, false));
      expect(ask.decision?.options.map((o) => o.label), ['sqlite', 'postgres']);
      expect(ask.decision?.context, 'The migration runs tonight.');
      final old = McCard.fromJson(_askJson(blocking: null)..['kind'] = 'wait')!;
      expect((old.blocking, old.isAsk, old.usesReplyDialog), (true, false, false));
      expect(const McCard(id: 'x').blocking, isTrue);
      final possible = McCard.fromJson(_possibleJson())!;
      expect((possible.isPossibleAsk, possible.usesReplyDialog, possible.blocking, possible.decision), (true, true, false, null));
    });

    test('a session\'s brief carries its decisions whole, and the question its last reply may have put', () {
      final b = SessionBrief.fromJson({
        'asks': [
          _briefAsk(),
          _briefAsk(id: 'beef0001', question: 'Rename the flag?', maybeAnswered: true),
          {'id': 'nodecision', 'question': 'only words'},
          {'question': 'no id', 'options': _briefAsk()['options']},
          'junk',
        ],
        'possibleAsk': {'text': ' Should it skip the check? ', 'at': 9},
      })!;
      expect(b.asks.map((a) => (a.id, a.question, a.maybeAnswered)), [('abcd1234', 'Which database?', false), ('beef0001', 'Rename the flag?', true)]);
      expect(b.asks.first.decision.context, 'The migration runs tonight.');
      expect(b.asks.first.at, 1000);
      expect((b.possibleAsk?.text, b.possibleAsk?.at), ('Should it skip the check?', 9));
      final none = SessionBrief.fromJson({})!;
      expect(none.asks, isEmpty, reason: 'an older server sends none');
      expect(none.possibleAsk, isNull);
    });
  });

  group('the card on Now', () {
    Future<void> pump(WidgetTester tester, McCard c, {List<String>? answered}) async {
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SingleChildScrollView(
            child: McAnswerCard(card: c, onAnswer: () => answered?.add(c.id), onLater: (_) {}, onTodo: () {}),
          ),
        ),
      ));
    }

    testWidgets('says it is an ask and that the session is still working; Answer is offered', (tester) async {
      final answered = <String>[];
      await pump(tester, McCard.fromJson(_askJson())!, answered: answered);
      expect(find.text('ask'), findsOneWidget);
      expect(find.text('the session is still working: this does not hold it up'), findsOneWidget);
      expect(find.text('Which database?'), findsOneWidget, reason: '#541: the question is on the face once');
      expect(find.text('sqlite'), findsOneWidget, reason: 'its decision options show as on any decision card');
      expect(find.byKey(const ValueKey('mc-card-maybe-answered')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-card-answer')));
      expect(answered, ['Home|q|ask:1000.abcd1234']);
    });

    testWidgets('an ask a typed prompt may have answered says so, and its words are dimmed', (tester) async {
      await pump(tester, McCard.fromJson(_askJson(maybeAnswered: true))!);
      expect(find.byKey(const ValueKey('mc-card-maybe-answered')), findsOneWidget);
      final what = tester.widget<Text>(find.byKey(const ValueKey('mc-card-what')));
      expect(what.style?.color, AppColors.onSurfaceVariant);
    });

    testWidgets('a possible unreported question is named as one and quotes the sentence', (tester) async {
      await pump(tester, McCard.fromJson(_possibleJson())!);
      expect(find.text('possible unreported question'), findsOneWidget);
      expect(find.text('Three earlier questions still need your answer.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-answer')), findsOneWidget);
    });
  });

  group('the reply dialog', () {
    Future<List<String>> open(WidgetTester tester, McCard c, {bool result = true}) async {
      final sent = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              key: const ValueKey('open'),
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => McAskReplyDialog(
                  card: c,
                  onSend: (card, text) async {
                    sent.add(text);
                    return result;
                  },
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      return sent;
    }

    testWidgets('shows the decision with its context; Send is off until there are words; it sends them and closes', (tester) async {
      final sent = await open(tester, McCard.fromJson(_askJson())!);
      expect(find.byKey(const ValueKey('mc-ask-reply-question')), findsOneWidget);
      expect(find.text('The migration runs tonight.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ask-reply-maybe')), findsNothing);
      expect(tester.widget<FilledButton>(find.byKey(const ValueKey('mc-ask-reply-send'))).onPressed, isNull);
      await tester.enterText(find.byKey(const ValueKey('mc-ask-reply-field')), '  use sqlite ');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-ask-reply-send')));
      await tester.pumpAndSettle();
      expect(sent, ['use sqlite']);
      expect(find.byKey(const ValueKey('mc-ask-reply-field')), findsNothing, reason: 'sent: closed');
    });

    testWidgets('a refused send keeps the dialog and the words; a decision\'s option fills the box', (tester) async {
      final sent = await open(tester, McCard.fromJson(_askJson())!, result: false);
      await tester.tap(find.byKey(const ValueKey('mc-ask-reply-option-1')));
      await tester.pump();
      expect(tester.widget<TextField>(find.byKey(const ValueKey('mc-ask-reply-field'))).controller!.text, 'postgres');
      await tester.tap(find.byKey(const ValueKey('mc-ask-reply-send')));
      await tester.pumpAndSettle();
      expect(sent, ['postgres']);
      expect(find.byKey(const ValueKey('mc-ask-reply-field')), findsOneWidget);
    });

    testWidgets('says when a typed prompt may have answered it, and when it is only a guess from a reply', (tester) async {
      await open(tester, McCard.fromJson(_askJson(maybeAnswered: true))!);
      expect(find.byKey(const ValueKey('mc-ask-reply-maybe')), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await open(tester, McCard.fromJson(_possibleJson())!);
      expect(find.byKey(const ValueKey('mc-ask-reply-possible')), findsOneWidget);
      expect(find.text('Three earlier questions still need your answer.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ask-reply-option-0')), findsNothing);
    });
  });

  group('the reply, through the existing path', () {
    const server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
    late List<String> typed;
    late List<String> said;
    // The brief the server's row for the session carries now.
    late List<Map<String, dynamic>> asksNow;
    Map<String, dynamic>? possibleNow;

    ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
          if (req.url.path == '/api/version') {
            return http.Response(jsonEncode({'version': '1.81.0', 'serverName': 'Home', 'capabilities': <String>[]}), 200);
          }
          if (req.url.path == '/api/sessions') {
            return http.Response(
                jsonEncode([
                  {
                    'id': 'q',
                    'name': 'Lead',
                    'cwd': '/w',
                    'status': 'working',
                    'brief': {'asks': asksNow, 'possibleAsk': ?possibleNow},
                  },
                ]),
                200);
          }
          return http.Response('', 404);
        }));

    Future<McPickSender> sender() async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          {'name': server.name, 'baseUrl': server.baseUrl, 'bearerToken': server.bearerToken},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      final repo = SessionRepository.forTest(store: store, clientFactory: client);
      final a = NeedsYouActions(
        repository: repo,
        client: client,
        input: (s, body) async {
          await body((keys) => typed.add(keys));
          return true;
        },
        say: said.add,
        questionEvery: Duration.zero,
      );
      addTearDown(a.dispose);
      await repo.refreshServer(server.baseUrl);
      return McPickSender(
        actions: a,
        sessions: () => repo.current,
        currentAsk: (c) async => McQuestionAsk(kind: c.kind, questions: [c.what ?? ''], canSuggest: true),
      );
    }

    setUp(() {
      typed = [];
      said = [];
      asksNow = [_briefAsk()];
      possibleNow = null;
    });

    test('an answer is typed into the session behind the card\'s own prefix, which names its decision; an option too', () async {
      final s = await sender();
      final card = McCard.fromJson(_askJson())!;
      expect(await s.send(card, 'use sqlite'), isTrue, reason: said.join('|'));
      expect(typed, ['${_prefix}use sqlite\r']);
      typed.clear();
      expect(await s.send(card, 'postgres'), isTrue, reason: said.join('|'));
      expect(typed, ['${_prefix}postgres\r']);
      typed.clear();
      // Behind the prefix it is words, whatever they start with.
      expect(await s.send(card, '/clear the old table'), isTrue, reason: said.join('|'));
      expect(typed, ['$_prefix/clear the old table\r']);
      expect(said, isEmpty);
    });

    test('refused, nothing typed: the session no longer holds that decision, or the server named none', () async {
      final s = await sender();
      final card = McCard.fromJson(_askJson())!;
      asksNow = [_briefAsk(id: 'beef0001', question: 'Something else?')];
      expect(await s.send(card, 'use sqlite'), isFalse);
      asksNow = [];
      expect(await s.send(card, 'use sqlite'), isFalse);
      asksNow = [_briefAsk()];
      expect(await s.send(McCard.fromJson(_askJson(replyPrefix: null))!, 'use sqlite'), isFalse);
      expect(await s.send(McCard.fromJson(_askJson(askId: null))!, 'use sqlite'), isFalse);
      expect(typed, isEmpty);
      expect(said, hasLength(4));
      expect(said.first, contains('no longer asks that'));
      expect(said.skip(2), everyElement(contains('does not name the decision')));
    });

    test('a possible unreported question is answered in the person\'s own words, while the reply still ends on it', () async {
      final s = await sender();
      final card = McCard.fromJson(_possibleJson())!;
      possibleNow = {'text': 'Three earlier questions still need your answer.', 'at': 2000};
      expect(await s.send(card, 'the flag name, the order, the owner'), isTrue, reason: said.join('|'));
      expect(typed, ['the flag name, the order, the owner\r']);
      typed.clear();
      possibleNow = {'text': 'A different sentence.', 'at': 3000};
      expect(await s.send(card, 'x'), isFalse);
      possibleNow = null;
      expect(await s.send(card, 'x'), isFalse);
      possibleNow = {'text': 'Three earlier questions still need your answer.', 'at': 2000};
      expect(await s.send(card, '/clear'), isFalse);
      expect(typed, isEmpty);
      expect(said, hasLength(3));
      expect(said.first, contains('no longer asks that'));
      expect(said.last, contains('run as a command'));
    });
  });
}
