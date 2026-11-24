// #541 item 4 - a pending AskUserQuestion on a Mission Control card is answered in place when it
// is SIMPLE: exactly one question, single-select, no preview, at least two options. Expanding the
// card reads the question on its session's screen (the answer port's pendingQuestion); a tap on
// an option answers with the frames buildAnswerFrames makes (the one copy of the key rules, the
// panel's own) after the same Undo window as an ask. Anything else - several questions,
// multi-select, a preview - shows no inline options and "Answer" keeps opening the sheet.
// Every effect goes through [McAnswerPort], so the card types nothing itself. Synthetic data only.
import 'dart:async';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/answer_sheet.dart';
import 'package:ai_terminal/screens/mission_control/card_decision.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

Map<String, dynamic> _questionCard() => {
      'id': 'Alpha|s1|question:7',
      'kind': 'question',
      'server': 'Alpha',
      'sessionId': 's1',
      'sessionName': 'fixer',
      'ref': 'acme/web#7',
      'title': 'Federator',
      'what': 'answer a question',
      'questions': [
        {'header': 'Color', 'text': 'Pick a color'},
      ],
    };

PendingQuestionItem _item({String question = 'Pick a color', bool multi = false, bool preview = false, int options = 3}) => PendingQuestionItem(
      header: 'Color',
      question: question,
      multiSelect: multi,
      hasPreview: preview,
      options: [
        for (var i = 0; i < options; i++) QuestionOption(label: ['Red', 'Blue', 'Green'][i], description: ['warm', 'cool', 'natural'][i]),
      ],
    );

PendingQuestion _pq(List<PendingQuestionItem> items) => PendingQuestion(toolUseId: 'tu-1', questions: items);

class _FakeAnalyst extends McAnalyst {
  _FakeAnalyst() : super(servers: () => const [_a], client: ApiClient.new);
}

/// Past the Undo window and the toast's exit.
Future<void> _pastUndo(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 500));
  await tester.pump(kMcUndoWindow + const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

void main() {
  late int reads;
  late List<(PendingQuestion, List<AnswerFrame>)> answered;
  late bool answerOk;
  late Future<PendingQuestion?> Function() read;
  late int sheetOpened;

  setUp(() {
    reads = 0;
    answered = [];
    answerOk = true;
    sheetOpened = 0;
    read = () async => _pq([_item()]);
  });

  McAnswerPort port() => McAnswerPort(
        pendingQuestion: (card) {
          reads++;
          return read();
        },
        answerQuestion: (card, shown, frames) async {
          answered.add((shown, frames));
          return answerOk;
        },
        send: (card, text) async => true,
        openSession: (card) {},
      );

  Future<void> pump(WidgetTester tester, {bool withPort = true}) async {
    tester.view.physicalSize = const Size(412 * 3, 915 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    final card = McCard.fromJson(_questionCard())!;
    final body = Scaffold(
      body: SingleChildScrollView(
        child: McAnswerCard(card: card, onAnswer: () => sheetOpened++, onLater: (_) {}, onTodo: () {}, onOpenSession: () {}),
      ),
    );
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: withPort
          ? McQuestionScope(
              analyst: _FakeAnalyst(),
              onSend: (c, t, s) async => false,
              onAnswer: (c) {},
              answerPort: port(),
              child: body,
            )
          : body,
    ));
  }

  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> expand(WidgetTester tester) async {
    await tester.tap(key('mc-card-expand'));
    await tester.pumpAndSettle();
  }

  group('a simple question is answered on the card', () {
    testWidgets('expanding reads the question; a tap answers with the panel\'s own frames after the Undo window', (tester) async {
      await pump(tester);
      expect(reads, 0, reason: 'the folded face reads nothing');
      await expand(tester);
      expect(reads, 1);
      expect(key('mc-card-qopt-0'), findsOneWidget);
      expect(find.text('Red'), findsOneWidget);
      expect(find.text('cool'), findsOneWidget, reason: 'each option says what it means');
      expect(find.text('Pick a color'), findsOneWidget, reason: 'the question is on the face once');
      await tester.tap(key('mc-card-qopt-1'));
      await tester.pump();
      expect(find.text('Undo'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      expect(answered, isEmpty, reason: 'nothing is typed inside the window');
      await _pastUndo(tester);
      expect(answered, hasLength(1));
      final (shown, frames) = answered.single;
      expect(shown.toolUseId, 'tu-1', reason: 'the answer names the question the person saw');
      final want = buildAnswerFrames(shown.questions, [
        {1}
      ]);
      expect([for (final f in frames) (f.keys, f.delayMs, f.text, f.other, f.chat)], [for (final f in want) (f.keys, f.delayMs, f.text, f.other, f.chat)]);
      expect(key('mc-card-sent'), findsOneWidget);
    });

    testWidgets('Undo types nothing, and an option answers again afterwards', (tester) async {
      await pump(tester);
      await expand(tester);
      await tester.tap(key('mc-card-qopt-0'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.text('Undo'));
      await _pastUndo(tester);
      expect(answered, isEmpty);
      expect(key('mc-card-sent'), findsNothing);
      await tester.tap(key('mc-card-qopt-2'));
      await tester.pump();
      await _pastUndo(tester);
      expect(answered, hasLength(1));
      expect(answered.single.$2.map((f) => f.keys), buildAnswerFrames(answered.single.$1.questions, [
        {2}
      ]).map((f) => f.keys));
    });

    testWidgets('a refused answer leaves the options in place and says nothing was sent', (tester) async {
      answerOk = false;
      await pump(tester);
      await expand(tester);
      await tester.tap(key('mc-card-qopt-0'));
      await tester.pump();
      await _pastUndo(tester);
      expect(answered, hasLength(1));
      expect(key('mc-card-sent'), findsNothing, reason: 'it did not go, so it is not said to');
      expect(key('mc-card-qopt-0'), findsOneWidget);
    });

    testWidgets('folding and expanding again reads the question again (it may have changed)', (tester) async {
      await pump(tester);
      await expand(tester);
      await expand(tester);
      expect(key('mc-card-qopt-0'), findsNothing);
      await expand(tester);
      expect(reads, 2);
      expect(key('mc-card-qopt-0'), findsOneWidget);
    });
  });

  group('anything else keeps the sheet', () {
    Future<void> expectNoInline(WidgetTester tester, PendingQuestion q) async {
      read = () async => q;
      await pump(tester);
      await expand(tester);
      expect(reads, 1);
      expect(key('mc-card-qopt-0'), findsNothing);
      expect(key('mc-card-q-sheet'), findsOneWidget, reason: 'it says why, and where to answer');
      await tester.tap(key('mc-card-answer'));
      await tester.pump();
      expect(sheetOpened, 1, reason: '"Answer" still opens the sheet');
      expect(answered, isEmpty);
    }

    testWidgets('several questions', (tester) async {
      await expectNoInline(tester, _pq([_item(), _item(question: 'Pick a size')]));
    });

    testWidgets('a multi-select question', (tester) async {
      await expectNoInline(tester, _pq([_item(multi: true)]));
    });

    testWidgets('a question with a preview (side by side)', (tester) async {
      await expectNoInline(tester, _pq([_item(preview: true)]));
    });

    testWidgets('a question with fewer than two options', (tester) async {
      await expectNoInline(tester, _pq([_item(options: 1)]));
    });

    test('the rule is one function', () {
      expect(mcSimpleQuestion(_pq([_item()])), isTrue);
      expect(mcSimpleQuestion(_pq([_item(multi: true)])), isFalse);
      expect(mcSimpleQuestion(_pq([_item(preview: true)])), isFalse);
      expect(mcSimpleQuestion(_pq([_item(), _item()])), isFalse);
      expect(mcSimpleQuestion(_pq([_item(options: 1)])), isFalse);
    });
  });

  group('what the card says when the question cannot be shown', () {
    testWidgets('a read that fails says so and keeps Answer', (tester) async {
      read = () => Future<PendingQuestion?>.error(const ApiException(0, 'That session is not in this app\'s list'));
      await pump(tester);
      await expand(tester);
      expect(find.textContaining('not in this app'), findsOneWidget);
      expect(key('mc-card-q-error'), findsOneWidget);
      expect(key('mc-card-qopt-0'), findsNothing);
      expect(key('mc-card-answer'), findsOneWidget);
    });

    testWidgets('a question no longer on its screen says so', (tester) async {
      read = () async => null;
      await pump(tester);
      await expand(tester);
      expect(key('mc-card-q-gone'), findsOneWidget);
      expect(key('mc-card-qopt-0'), findsNothing);
    });

    testWidgets('while it is read, the card says it is reading', (tester) async {
      final done = Completer<PendingQuestion?>();
      read = () => done.future;
      await pump(tester);
      await tester.tap(key('mc-card-expand'));
      await tester.pump();
      expect(key('mc-card-q-loading'), findsOneWidget);
      done.complete(_pq([_item()]));
      await tester.pumpAndSettle();
      expect(key('mc-card-qopt-0'), findsOneWidget);
    });

    testWidgets('with no answer port (a screen outside Mission Control\'s home) a question card cannot expand', (tester) async {
      await pump(tester, withPort: false);
      expect(key('mc-card-expand'), findsNothing);
      expect(reads, 0);
    });
  });
}
