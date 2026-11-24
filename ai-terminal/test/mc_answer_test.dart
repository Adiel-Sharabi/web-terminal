// #531 - a question card in Mission Control shows its questions, is answered in place and
// can be asked about in one tap: the wire (`questions` on a card), the card face (header and
// text of each question, "+N more", never "answer a question"), "Ask about this" opening the
// panel with its box ready, and the answer sheet - an AskUserQuestion answered through the
// frames buildAnswerFrames makes, a decision's option, a wait's reply, a permission sent to
// its own screen. Every effect goes through [McAnswerPort], so a refused send keeps the sheet.
// Synthetic data only.
import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_ask_models.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/answer_sheet.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');

Map<String, dynamic> _cardJson({List<Map<String, dynamic>>? questions, String kind = 'question', String? what = 'answer a question'}) => {
      'id': 'Alpha|s1|$kind:7',
      'kind': kind,
      'server': 'Alpha',
      'sessionId': 's1',
      'sessionName': 'fixer',
      'ref': 'acme/web#7',
      'title': 'Federator',
      'what': what,
      'questions': ?questions,
    };

final _fourQuestions = [
  {'header': 'Scope', 'text': 'Should Federator also cover the closed strip?'},
  {'header': 'Cache', 'text': 'How long may a peer answer be reused?'},
  {'header': null, 'text': 'Which peers first?'},
  {'header': 'Name', 'text': 'What do we call the merged view?'},
];

PendingQuestionItem _item({String question = 'Pick a color', String header = 'Color', bool multi = false, bool preview = false}) =>
    PendingQuestionItem(
        header: header,
        question: question,
        multiSelect: multi,
        hasPreview: preview,
        options: const [QuestionOption(label: 'Red'), QuestionOption(label: 'Blue')]);

PendingQuestion _pq(List<PendingQuestionItem> items) => PendingQuestion(toolUseId: 'tu-1', questions: items);

class _FakeAnalyst extends McAnalyst {
  _FakeAnalyst() : super(servers: () => const [_a], client: ApiClient.new);
  @override
  Future<McQuestionContext> questionContext(String cardId, String level) async => McQuestionContext.fromJson({
        'level': level,
        'text': 'x',
        'sections': [
          {'title': 'The ask', 'body': 'Which?'},
        ],
        'sources': [],
        'ask': {
          'kind': 'question',
          'questions': [
            {'text': 'Which?'},
          ],
          'options': [
            {'index': 0, 'question': 0, 'label': 'Red', 'recommended': false},
          ],
          'canSuggest': false,
        },
        'cardId': cardId,
        'generatedAt': 1,
      });
}

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(412 * 3, 915 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

void main() {
  group('wire', () {
    test('a card carries its questions; one with no text is dropped, none sent is empty', () {
      final c = McCard.fromJson(_cardJson(questions: [
        ..._fourQuestions,
        {'header': 'x', 'text': '  '},
        {'header': 'y'},
      ]))!;
      expect(c.questions.map((q) => q.text), [
        'Should Federator also cover the closed strip?',
        'How long may a peer answer be reused?',
        'Which peers first?',
        'What do we call the merged view?',
      ]);
      expect(c.questions.map((q) => q.header), ['Scope', 'Cache', null, 'Name']);
      expect(McCard.fromJson(_cardJson())!.questions, isEmpty);
      expect(McCard.fromJson({..._cardJson(), 'questions': 'junk'})!.questions, isEmpty);
    });
  });

  group('the card face', () {
    Future<void> pump(WidgetTester tester, McCard card, {McQuestionScope Function(Widget child)? scope}) async {
      await _phone(tester);
      Widget body = Scaffold(
          body: SingleChildScrollView(
              child: McAnswerCard(card: card, onAnswer: () {}, onLater: (_) {}, onTodo: () {}, onOpenSession: () {})));
      if (scope != null) body = scope(body);
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: body));
    }

    testWidgets('a question card shows the first questions with their headers and "+N more", not its generic words', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      expect(find.text('Scope'), findsOneWidget);
      expect(find.text('Should Federator also cover the closed strip?'), findsOneWidget);
      expect(find.text('Cache'), findsOneWidget);
      expect(find.text('How long may a peer answer be reused?'), findsOneWidget);
      expect(find.text('Which peers first?'), findsNothing, reason: 'two questions on the face, the rest counted');
      expect(find.byKey(const ValueKey('mc-card-q-more')), findsOneWidget);
      expect(find.text('+2 more'), findsOneWidget);
      expect(find.text('answer a question'), findsNothing);
      expect(find.byKey(const ValueKey('mc-card-what')), findsNothing);
    });

    testWidgets('one question: no "+N more"; a question with no header shows its text alone', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson(questions: [_fourQuestions[2]]))!);
      expect(find.text('Which peers first?'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-q-more')), findsNothing);
    });

    testWidgets('a question that could not be read says so; it never shows "answer a question"', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson())!);
      expect(find.text('answer a question'), findsNothing);
      expect(find.byKey(const ValueKey('mc-card-q-unread')), findsOneWidget);
    });

    testWidgets('a wait keeps its own words', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson(kind: 'wait', what: 'try the build'))!);
      expect(find.text('try the build'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-q-unread')), findsNothing);
    });

    testWidgets('Ask about this: one tap opens the question panel with the box for the whole question ready', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!,
          scope: (child) => McQuestionScope(analyst: _FakeAnalyst(), onSend: (c, t, s) async => false, onAnswer: (_) {}, child: child));
      await tester.tap(find.byKey(const ValueKey('mc-card-ask')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mcq-levels')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcq-followup-field-all')), findsOneWidget);
      final field = tester.widget<TextField>(find.byKey(const ValueKey('mcq-followup-field-all')));
      expect(field.autofocus, isTrue);
    });

    testWidgets('Ask about this is offered only where the Analyst is (no scope: no button)', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      expect(find.byKey(const ValueKey('mc-card-ask')), findsNothing);
    });

    testWidgets('the panel opened from More context has no box open until asked for', (tester) async {
      await pump(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!,
          scope: (child) => McQuestionScope(analyst: _FakeAnalyst(), onSend: (c, t, s) async => false, onAnswer: (_) {}, child: child));
      await tester.tap(find.byKey(const ValueKey('mc-card-context')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mcq-followup-field-all')), findsNothing);
      expect(find.byKey(const ValueKey('mcq-followup-open-all')), findsOneWidget);
    });
  });

  group('the answer sheet', () {
    late List<(McCard, PendingQuestion, List<AnswerFrame>)> frames;
    late List<(McCard, String)> sends;
    late List<String> opened;
    late List<String> asked;
    var sendResult = true;
    PendingQuestion? pending;
    Object? pendingError;

    McAnswerPort port() => McAnswerPort(
          pendingQuestion: (card) async {
            if (pendingError != null) throw pendingError!;
            return pending;
          },
          answerQuestion: (card, shown, f) async {
            frames.add((card, shown, f));
            return sendResult;
          },
          send: (card, text) async {
            sends.add((card, text));
            return sendResult;
          },
          openSession: (card) => opened.add(card.id),
          askAbout: (card) => asked.add(card.id),
        );

    Future<void> open(WidgetTester tester, McCard card) async {
      await _phone(tester);
      await tester.pumpWidget(MaterialApp(
          theme: AppTheme.dark,
          home: Builder(
              builder: (context) => Scaffold(
                  body: Center(
                      child: TextButton(
                          key: const ValueKey('open-sheet'),
                          onPressed: () => McAnswerSheet.open(context, card: card, port: port()),
                          child: const Text('open')))))));
      await tester.tap(find.byKey(const ValueKey('open-sheet')));
      await tester.pumpAndSettle();
    }

    setUp(() {
      frames = [];
      sends = [];
      opened = [];
      asked = [];
      sendResult = true;
      pending = null;
      pendingError = null;
    });

    testWidgets('an AskUserQuestion is answered with the frames buildAnswerFrames makes, then the sheet closes', (tester) async {
      pending = _pq([_item(), _item(question: 'How big?', header: 'Size', multi: true)]);
      await open(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsOneWidget);
      // Both questions are in front of the person: the tabs are the question panel's own.
      expect(find.text('Color'), findsWidgets);
      await tester.tap(find.text('Blue'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Size'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Red'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send answer'));
      await tester.pumpAndSettle();
      expect(frames, hasLength(1));
      final want = buildAnswerFrames(pending!.questions, [
        {1},
        {0},
      ]);
      expect(frames.single.$3.map((f) => f.keys), want.map((f) => f.keys));
      expect(frames.single.$2.toolUseId, 'tu-1', reason: 'the question the person saw, for the pre-write re-check');
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsNothing, reason: 'sent: the sheet is done');
    });

    testWidgets('a refused answer keeps the sheet open: nothing is lost, and Open session is one tap away', (tester) async {
      pending = _pq([_item()]);
      sendResult = false;
      await open(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      await tester.tap(find.text('Blue'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send answer'));
      await tester.pumpAndSettle();
      expect(frames, hasLength(1));
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsOneWidget);
      await tester.tap(find.text('Open session'));
      await tester.pumpAndSettle();
      expect(opened, ['Alpha|s1|question:7']);
    });

    testWidgets('a question that is no longer on its screen says so and sends nothing', (tester) async {
      pending = null;
      await open(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      expect(find.byKey(const ValueKey('mc-answer-gone')), findsOneWidget);
      expect(find.text('Send answer'), findsNothing);
      expect(frames, isEmpty);
    });

    testWidgets('a question that cannot be read says why and offers the session', (tester) async {
      pendingError = const ApiException(0, 'timed out');
      await open(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      expect(find.byKey(const ValueKey('mc-answer-error')), findsOneWidget);
      expect(find.textContaining('timed out'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-answer-open-session')));
      await tester.pumpAndSettle();
      expect(opened, hasLength(1));
    });

    testWidgets('a decision: its options as they are; one tap sends that label, the reply is the sender\'s', (tester) async {
      final card = McCard.fromJson({
        ..._cardJson(kind: 'decision', what: 'Which fix?'),
        'decision': {
          'question': 'Which fix?',
          'context': 'Two ways.',
          'options': [
            {'label': 'Patch the form', 'consequence': 'quick'},
            {'label': 'Rewrite auth', 'consequence': 'a day'},
          ],
          'recommended': 1,
        },
      })!;
      await open(tester, card);
      expect(find.text('Which fix?'), findsWidgets);
      expect(find.text('Two ways.'), findsOneWidget);
      expect(find.text('quick'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-answer-option-1')));
      await tester.pumpAndSettle();
      expect(sends.map((s) => s.$2), ['Rewrite auth']);
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsNothing);
    });

    testWidgets('a decision also takes the person\'s own words', (tester) async {
      final card = McCard.fromJson({
        ..._cardJson(kind: 'decision', what: 'Which fix?'),
        'decision': {
          'question': 'Which fix?',
          'options': [
            {'label': 'Patch the form'},
            {'label': 'Rewrite auth'},
          ],
        },
      })!;
      await open(tester, card);
      await tester.enterText(find.byKey(const ValueKey('mc-answer-text')), 'Patch it, then rewrite next week');
      await tester.tap(find.byKey(const ValueKey('mc-answer-send')));
      await tester.pumpAndSettle();
      expect(sends.map((s) => s.$2), ['Patch it, then rewrite next week']);
    });

    testWidgets('a wait: its words and a reply box; nothing is sent while it is empty', (tester) async {
      await open(tester, McCard.fromJson(_cardJson(kind: 'wait', what: 'Try the build and tell me'))!);
      expect(find.text('Try the build and tell me'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-answer-send')));
      await tester.pumpAndSettle();
      expect(sends, isEmpty);
      await tester.enterText(find.byKey(const ValueKey('mc-answer-text')), 'built, works');
      await tester.tap(find.byKey(const ValueKey('mc-answer-send')));
      await tester.pumpAndSettle();
      expect(sends.map((s) => s.$2), ['built, works']);
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsNothing);
    });

    testWidgets('a refused reply keeps the words in the box', (tester) async {
      sendResult = false;
      await open(tester, McCard.fromJson(_cardJson(kind: 'wait', what: 'Try the build'))!);
      await tester.enterText(find.byKey(const ValueKey('mc-answer-text')), 'built, works');
      await tester.tap(find.byKey(const ValueKey('mc-answer-send')));
      await tester.pumpAndSettle();
      expect(sends, hasLength(1));
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsOneWidget);
      expect(find.text('built, works'), findsOneWidget);
    });

    testWidgets('a permission is answered on its own screen: only Open session', (tester) async {
      await open(tester, McCard.fromJson(_cardJson(kind: 'permission', what: 'approve a tool'))!);
      expect(find.byKey(const ValueKey('mc-answer-text')), findsNothing);
      expect(find.byKey(const ValueKey('mc-answer-permission')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-answer-open-session')));
      await tester.pumpAndSettle();
      expect(opened, hasLength(1));
      expect(sends, isEmpty);
    });

    testWidgets('Ask about this is on the sheet too: the question is not answered to be understood', (tester) async {
      pending = _pq([_item()]);
      await open(tester, McCard.fromJson(_cardJson(questions: _fourQuestions))!);
      await tester.tap(find.byKey(const ValueKey('mc-answer-ask')));
      await tester.pumpAndSettle();
      expect(asked, ['Alpha|s1|question:7']);
      expect(find.byKey(const ValueKey('mc-answer-sheet')), findsOneWidget, reason: 'asking does not answer');
      expect(frames, isEmpty);
    });
  });
}
