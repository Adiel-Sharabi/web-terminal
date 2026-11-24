// #541 - an ask / decision card is answered where it is: an option chip answers at once through
// the existing reply path after a short Undo window, the card expands in place (context, every
// option with its consequence, a one-line reply, Send), and its question is printed once.
// The card sends nothing itself: [McAnswerCard.onReply] is the home's reply path (the same one
// the reply dialog used, [McPickSender.send]). From SYNTHETIC rows.
import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/screens/mission_control/card_decision.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _decision = {
  'question': 'Which database?',
  'context': 'The migration runs tonight.',
  'options': [
    {'label': 'sqlite', 'consequence': 'one file, no server'},
    {'label': 'postgres', 'consequence': 'a server to run'},
  ],
  'recommended': 0,
};

Map<String, dynamic> _askJson() => {
      'id': 'Home|q|ask:1000.abcd1234',
      'kind': 'ask',
      'blocking': false,
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
      'askId': 'abcd1234',
      'replyPrefix': 'Answer to "Which database?" [ask:abcd1234]: ',
      'maybeAnswered': false,
      'decision': _decision,
      'hasQuestion': false,
    };

/// A reported wait that carries a decision: its own line says something else than the question.
Map<String, dynamic> _decisionJson({String what = 'Waiting on a storage choice'}) => {
      ..._askJson(),
      'id': 'Home|q|decision:5',
      'kind': 'decision',
      'blocking': true,
      'what': what,
      'askId': null,
      'replyPrefix': null,
    };

Map<String, dynamic> _possibleJson() => {
      ..._askJson(),
      'id': 'Home|q|possible:2000',
      'kind': 'possible-ask',
      'what': 'Should it skip the check, or run it once more first?',
      'askId': null,
      'replyPrefix': null,
      'decision': null,
    };

/// Past the Undo window and the toast's exit.
Future<void> _pastUndo(WidgetTester tester) async {
  // The toast's timer starts when its entry animation has finished, then its exit has to run.
  await tester.pump(const Duration(milliseconds: 500));
  await tester.pump(kMcUndoWindow + const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

void main() {
  late List<(String, String)> sent;
  late bool result;

  setUp(() {
    sent = [];
    result = true;
  });

  Future<void> pump(WidgetTester tester, Map<String, dynamic> json, {bool withReply = true}) async {
    tester.view.physicalSize = const Size(900, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final card = McCard.fromJson(json)!;
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: SingleChildScrollView(
          child: McAnswerCard(
            card: card,
            onAnswer: () {},
            onLater: (_) {},
            onTodo: () {},
            onReply: withReply
                ? (c, text) async {
                    sent.add((c.id, text));
                    return result;
                  }
                : null,
          ),
        ),
      ),
    ));
  }

  Finder key(String k) => find.byKey(ValueKey(k));

  group('an option chip on the face answers', () {
    testWidgets('a tap sends exactly that option\'s text, once the Undo window has run out', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-option-1'));
      await tester.pump();
      expect(find.text('Undo'), findsOneWidget, reason: 'the person can still take it back');
      await tester.pump(const Duration(seconds: 2));
      expect(sent, isEmpty, reason: 'nothing is sent inside the window');
      await _pastUndo(tester);
      expect(sent, [('Home|q|ask:1000.abcd1234', 'postgres')]);
      expect(key('mc-card-sent'), findsOneWidget);
    });

    testWidgets('Undo sends nothing, and the chips answer again afterwards', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500)); // the toast has come up
      await tester.tap(find.text('Undo'));
      await _pastUndo(tester);
      expect(sent, isEmpty);
      expect(key('mc-card-sent'), findsNothing);
      await tester.tap(key('mc-card-option-1'));
      await tester.pump();
      await _pastUndo(tester);
      expect(sent.map((s) => s.$2), ['postgres'], reason: 'the undone pick left nothing behind');
    });

    testWidgets('a second chip inside the window changes nothing: one pick, one send', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await tester.tap(key('mc-card-option-1'), warnIfMissed: false);
      await tester.pump();
      await _pastUndo(tester);
      expect(sent.map((s) => s.$2), ['sqlite']);
    });

    testWidgets('a refused send leaves the card as it was and answers again', (tester) async {
      result = false; // the sender said why through its own toast; nothing was typed
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(sent.map((s) => s.$2), ['sqlite']);
      expect(key('mc-card-sent'), findsNothing, reason: 'it did not go, so it is not said to');
      await tester.tap(key('mc-card-option-1'));
      await tester.pump();
      await _pastUndo(tester);
      expect(sent.map((s) => s.$2), ['sqlite', 'postgres']);
    });

    testWidgets('leaving the card inside the window does not lose the pick', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const Scaffold(body: SizedBox())));
      await _pastUndo(tester);
      expect(sent.map((s) => s.$2), ['sqlite']);
    });

    testWidgets('with no reply path the chips stay as they were: plain, no Undo, nothing sent', (tester) async {
      await pump(tester, _askJson(), withReply: false);
      await tester.tap(key('mc-card-option-0'), warnIfMissed: false);
      await tester.pump();
      expect(find.text('Undo'), findsNothing);
      expect(find.byType(ActionChip), findsNothing);
      expect(find.text('sqlite'), findsOneWidget);
    });

    testWidgets('a decision card\'s chips answer too', (tester) async {
      await pump(tester, _decisionJson());
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(sent, [('Home|q|decision:5', 'sqlite')]);
    });
  });

  group('the card expands in place', () {
    testWidgets('a tap on the card shows the context and every option with its consequence; a second tap folds it', (tester) async {
      await pump(tester, _askJson());
      expect(key('mc-card-detail'), findsNothing);
      expect(find.text('The migration runs tonight.'), findsNothing, reason: 'folded: the face stays short');
      await tester.tap(key('mc-card-heading'));
      await tester.pump();
      expect(key('mc-card-detail'), findsOneWidget);
      expect(find.text('The migration runs tonight.'), findsOneWidget);
      expect(find.text('one file, no server'), findsOneWidget);
      expect(find.text('a server to run'), findsOneWidget);
      expect(key('mc-card-opt-star-0'), findsOneWidget, reason: 'the recommended one is marked');
      expect(key('mc-card-opt-star-1'), findsNothing);
      expect(key('mc-card-reply-field'), findsOneWidget);
      expect(key('mc-card-reply-send'), findsOneWidget);
      await tester.tap(key('mc-card-heading'));
      await tester.pump();
      expect(key('mc-card-detail'), findsNothing);
      expect(find.text('one file, no server'), findsNothing);
    });

    testWidgets('the chevron does the same', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      expect(key('mc-card-detail'), findsOneWidget);
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      expect(key('mc-card-detail'), findsNothing);
    });

    testWidgets('an option row in the expanded card answers like its chip', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      await tester.tap(key('mc-card-opt-1'));
      await tester.pump();
      expect(sent, isEmpty);
      await _pastUndo(tester);
      expect(sent.map((s) => s.$2), ['postgres']);
    });

    testWidgets('Send is off until there are words; the words go at once, without the Undo window', (tester) async {
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      expect(tester.widget<FilledButton>(key('mc-card-reply-send')).onPressed, isNull);
      await tester.enterText(key('mc-card-reply-field'), '  neither - keep the file  ');
      await tester.pump();
      await tester.tap(key('mc-card-reply-send'));
      await tester.pump();
      expect(sent, [('Home|q|ask:1000.abcd1234', 'neither - keep the file')]);
      expect(find.text('Undo'), findsNothing);
    });

    testWidgets('a refused typed reply keeps what was typed', (tester) async {
      result = false;
      await pump(tester, _askJson());
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      await tester.enterText(key('mc-card-reply-field'), 'keep the file');
      await tester.pump();
      await tester.tap(key('mc-card-reply-send'));
      await tester.pump();
      expect(tester.widget<TextField>(key('mc-card-reply-field')).controller?.text, 'keep the file');
      expect(key('mc-card-sent'), findsNothing);
    });

    testWidgets('with no reply path it still explains itself, and offers no box', (tester) async {
      await pump(tester, _askJson(), withReply: false);
      await tester.tap(key('mc-card-heading'));
      await tester.pump();
      expect(find.text('The migration runs tonight.'), findsOneWidget);
      expect(find.text('one file, no server'), findsOneWidget);
      expect(key('mc-card-reply-field'), findsNothing);
    });

    testWidgets('a possible unreported question expands to its whole sentence and a reply box', (tester) async {
      await pump(tester, _possibleJson());
      expect(find.byType(ActionChip), findsNothing, reason: 'it has no options');
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      await tester.enterText(key('mc-card-reply-field'), 'run it once more');
      await tester.pump();
      await tester.tap(key('mc-card-reply-send'));
      await tester.pump();
      expect(sent, [('Home|q|possible:2000', 'run it once more')]);
    });
  });

  group('the question is on the face once', () {
    testWidgets('an ask: its line is its question; folded and expanded', (tester) async {
      await pump(tester, _askJson());
      expect(find.text('Which database?'), findsOneWidget);
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      expect(find.text('Which database?'), findsOneWidget);
    });

    testWidgets('a decision whose wait line already says the question is not printed twice', (tester) async {
      await pump(tester, _decisionJson(what: 'Decide: which database? (the migration runs tonight)'));
      expect(find.textContaining('which database?', findRichText: true), findsOneWidget);
      expect(find.text('Which database?'), findsNothing);
    });

    testWidgets('a decision whose wait line says something else keeps both', (tester) async {
      await pump(tester, _decisionJson());
      expect(find.text('Waiting on a storage choice'), findsOneWidget);
      expect(find.text('Which database?'), findsOneWidget);
    });

    test('the rule: the same words, or one inside the other, are one question', () {
      expect(mcSameQuestion('Which database?', 'which  database?'), isTrue);
      expect(mcSameQuestion('Decide: which database? now', 'Which database?'), isTrue);
      expect(mcSameQuestion('Which database?', 'Which cache?'), isFalse);
      expect(mcSameQuestion('', 'Which database?'), isFalse);
    });
  });

  // The server says which item a card is about, or none (lib/mc-needs.js subjectFor). With none the
  // card shows the question itself, never a title borrowed from another item, and the session's
  // name stands beneath.
  group('a card about no item', () {
    Map<String, dynamic> noItem(Map<String, dynamic> j) => {...j, 'ref': null, 'title': null, 'subjectKey': null, 'project': null};

    testWidgets('the question is the heading, printed once, with the session beneath', (tester) async {
      await pump(tester, noItem(_askJson()));
      expect(tester.widget<Text>(key('mc-card-heading')).data, 'Which database?');
      expect(key('mc-card-what'), findsNothing, reason: 'the heading already says it');
      expect(find.text('Which database?'), findsOneWidget);
      expect(find.text('Lead · Home'), findsOneWidget);
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      expect(find.text('Which database?'), findsOneWidget, reason: 'expanded, still once');
      expect(key('mc-card-what'), findsNothing);
    });

    testWidgets('a wait with no item says what it waits on as its heading, once', (tester) async {
      await pump(tester, noItem({..._decisionJson(what: 'Ship the cap change?'), 'decision': null, 'kind': 'wait'}));
      expect(tester.widget<Text>(key('mc-card-heading')).data, 'Ship the cap change?');
      expect(find.text('Ship the cap change?'), findsOneWidget);
    });

    testWidgets('a decision with no item keeps its own question when the wait line says something else', (tester) async {
      await pump(tester, noItem(_decisionJson()));
      expect(tester.widget<Text>(key('mc-card-heading')).data, 'Waiting on a storage choice');
      expect(find.text('Which database?'), findsOneWidget);
    });

    testWidgets('a card about an item still shows that item as its heading and the question beneath it', (tester) async {
      await pump(tester, _askJson());
      expect(tester.widget<Text>(key('mc-card-heading')).data, 'acme/web#7  Fix login');
      expect(tester.widget<Text>(key('mc-card-what')).data, 'Which database?');
    });

    testWidgets('a card with no item and no words falls back to the session\'s name', (tester) async {
      await pump(tester, {...noItem(_askJson()), 'what': null, 'decision': null});
      expect(tester.widget<Text>(key('mc-card-heading')).data, 'Lead');
    });
  });

  group('inside Mission Control\'s scope', () {
    testWidgets('a card with no reply of its own answers through the scope\'s', (tester) async {
      final viaScope = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McQuestionScope(
          analyst: McAnalyst(servers: () => const [], client: ApiClient.new),
          onSend: (c, t, shown) async => false,
          onAnswer: (c) {},
          onReply: (c, text) async {
            viaScope.add(text);
            return true;
          },
          child: Scaffold(
            body: SingleChildScrollView(
              child: McAnswerCard(card: McCard.fromJson(_askJson())!, onAnswer: () {}, onLater: (_) {}, onTodo: () {}),
            ),
          ),
        ),
      ));
      await tester.tap(key('mc-card-option-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(viaScope, ['sqlite']);
    });
  });
}
