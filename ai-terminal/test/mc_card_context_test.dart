// #571 - a Mission Control card tapped opens its FULL context: the session's own last reply in full
// (markdown, links as text spans), every work item it names with its station or stage, the
// decision with each option's consequence and the recommended one, and Answer / Open session on the
// card's own paths. From SYNTHETIC rows; the sheet reads through a port, the reader through a mock
// HTTP client.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/answer_sheet.dart';
import 'package:ai_terminal/screens/mission_control/card_context_sheet.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/services/mc_card_context.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _server = ServerConfig(name: 'Office', baseUrl: 'http://office.test:7681', bearerToken: 'tok');

const _decision = {
  'question': 'Close #20606 now, or keep it for the follow-up?',
  'context': 'Four pushback drafts are ready.\nThe fix shipped on Monday.',
  'options': [
    {'label': 'Close it', 'consequence': 'the customer is told it is fixed'},
    {'label': 'Keep it open', 'consequence': 'one more round of testing'},
  ],
  'recommended': 0,
};

Map<String, dynamic> _cardJson({String kind = 'decision', Map<String, dynamic>? decision = _decision, String what = 'Waiting on a close-out'}) => {
      'id': 'Office|s1|$kind:5',
      'kind': kind,
      'server': 'Office',
      'sessionId': 's1',
      'sessionName': 'bh orchestrator',
      'project': 'am8',
      'ref': 'ado:22946',
      'title': 'Pushback drafts',
      'what': what,
      'why': {'blocks': 2, 'blockedSessions': <dynamic>[], 'subjects': <dynamic>[], 'severity': 2, 'ageMin': 12, 'text': 'blocks 2 sessions'},
      'rank': 1,
      'askedAt': 1000,
      'decision': decision,
      'hasQuestion': false,
    };

McCard _card({String kind = 'decision', Map<String, dynamic>? decision = _decision, String what = 'Waiting on a close-out'}) =>
    McCard.fromJson(_cardJson(kind: kind, decision: decision, what: what))!;

const _reply = 'I need **your answer** on #22946, see [the notes](https://example.test/notes) for more.\n\n- one\n- two';

Session _session({List<BriefItem> items = const []}) => Session(
      id: 's1',
      name: 'bh orchestrator',
      cwd: '/w',
      status: 'waiting',
      claudeSessionId: null,
      lastActivity: null,
      notifyLevel: 'important',
      server: _server,
      brief: SessionBrief(items: items),
    );

Map<String, dynamic> _subjectJson(String key, {String? station, String? current, String? title}) => {
      'subject': {
        'key': key,
        'ref': key,
        'title': title,
        'stage': {'current': current, 'reported': null, 'evidence': null, 'station': station, 'history': <dynamic>[]},
        'sessions': <dynamic>[],
      },
      'runs': <dynamic>[],
    };

class _Port {
  final answered = <String>[];
  final opened = <String>[];
  final subjects = <String>[];
  McContextReply reply = const McContextReply(text: _reply, whole: true);
  List<McContextItem> items = const [
    McContextItem(key: 'ado:22946', ref: 'ado:22946', title: 'Pushback drafts', state: 'in-progress', station: 'Parked'),
    McContextItem(key: 'acme/web#7', ref: 'acme/web#7', title: 'Fix login', state: 'committed', stage: 'pr-open'),
  ];

  McCardContextPort get port => McCardContextPort(
        reply: (_) async => reply,
        items: (_) async => items,
        openSubject: subjects.add,
        answer: (c) => answered.add(c.id),
        openSession: (c) => opened.add(c.id),
      );
}

Future<void> _open(WidgetTester tester, McCard card, _Port p, {Size size = const Size(600, 1600)}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.dark,
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: TextButton(
            key: const ValueKey('opener'),
            onPressed: () => McCardContextSheet.open(context, card: card, port: p.port),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.byKey(const ValueKey('opener')));
  await tester.pumpAndSettle();
}

void main() {
  group('the sheet', () {
    testWidgets('shows the decision: question, context, every option with its consequence, the recommended one starred', (tester) async {
      await _open(tester, _card(), _Port());
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-question')), findsOneWidget);
      expect(find.text('Close #20606 now, or keep it for the follow-up?'), findsOneWidget);
      expect(find.textContaining('Four pushback drafts are ready.'), findsOneWidget);
      expect(find.text('Close it'), findsOneWidget);
      expect(find.text('the customer is told it is fixed'), findsOneWidget);
      expect(find.text('Keep it open'), findsOneWidget);
      expect(find.text('one more round of testing'), findsOneWidget);
      // The agent's recommendation, marked; the other option is not.
      expect(find.byKey(const ValueKey('mc-card-opt-star-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-card-opt-star-1')), findsNothing);
      // The options only explain here: Answer is the sheet's, on the card's own path.
      expect(find.byKey(const ValueKey('mc-card-reply-field')), findsNothing);
    });

    testWidgets("shows the session's last reply in full, rendered, with a link that is a text span (#83)", (tester) async {
      final p = _Port()..reply = McContextReply(text: '${'long sentence ' * 60}\n\n$_reply', whole: true, at: DateTime.now().subtract(const Duration(hours: 2)));
      await _open(tester, _card(), p);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('mc-ctx-reply')), 300, scrollable: find.byType(Scrollable).first);
      // Markdown rendered: the bold marks are gone, the list is a list.
      expect(find.textContaining('**', findRichText: true), findsNothing);
      expect(find.textContaining('I need your answer on #22946, see the notes for more.', findRichText: true), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-reply-age')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-reply-short')), findsNothing);
      // The whole paragraph is ONE RichText and the link a recognizer inside it - never a widget in the flow.
      final para = tester.widgetList<RichText>(find.byType(RichText)).where((r) => r.text.toPlainText().contains('see the notes for more'));
      expect(para, hasLength(1));
      var recognizers = 0;
      para.single.text.visitChildren((span) {
        if (span is TextSpan && span.recognizer is TapGestureRecognizer) recognizers++;
        return true;
      });
      expect(recognizers, 1);
    });

    testWidgets('names every item with its ADO station or GitHub stage and the state the session reported; a tap opens the item', (tester) async {
      final p = _Port();
      await _open(tester, _card(), p);
      expect(find.byKey(const ValueKey('mc-ctx-items')), findsOneWidget);
      // (The card's own heading is the first item's too: look inside the row.)
      expect(find.descendant(of: find.byKey(const ValueKey('mc-ctx-item-0')), matching: find.text('ado:22946  Pushback drafts')), findsOneWidget);
      // An ADO item shows its STATION (#569), a GitHub item its stage.
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-ctx-item-where-0'))).data, 'Station: Parked');
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-ctx-item-where-1'))).data, 'Stage: PR open');
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-ctx-item-state-0'))).data, 'reported: in-progress');
      await tester.tap(find.byKey(const ValueKey('mc-ctx-item-1')));
      await tester.pumpAndSettle();
      expect(p.subjects, ['acme/web#7']);
      // The sheet is closed: the item's page opens over what was under it.
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);
    });

    testWidgets('an item with no page to open shows and does nothing on a tap', (tester) async {
      final p = _Port()
        ..items = const [McContextItem(key: null, ref: '#13', title: 'Bare item', state: 'planning')];
      await _open(tester, _card(), p);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-ctx-item-0')), matching: find.text('#13  Bare item')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-ctx-item-0')));
      await tester.pumpAndSettle();
      expect(p.subjects, isEmpty);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
    });

    testWidgets('Answer and Open session close the sheet and take the card own paths', (tester) async {
      final p = _Port();
      await _open(tester, _card(), p);
      await tester.tap(find.byKey(const ValueKey('mc-ctx-answer')));
      await tester.pumpAndSettle();
      expect(p.answered, ['Office|s1|decision:5']);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('opener')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-ctx-open')));
      await tester.pumpAndSettle();
      expect(p.opened, ['Office|s1|decision:5']);
      expect(p.answered, hasLength(1));
    });

    testWidgets('a question card shows its questions in full; a wait shows its own words', (tester) async {
      final q = McCard.fromJson({
        ..._cardJson(kind: 'question', decision: null, what: 'answer a question'),
        'questions': [
          {'header': 'Storage', 'text': 'Which database should the migration use, and should it run tonight?'},
          {'text': 'Keep the old table?'},
        ],
      })!;
      await _open(tester, q, _Port());
      expect(find.text('Storage'), findsOneWidget);
      expect(find.text('Which database should the migration use, and should it run tonight?'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-q-1')), findsOneWidget);
      // The wait's generic words ("answer a question") say nothing: not printed.
      expect(find.text('answer a question'), findsNothing);
    });

    testWidgets('a wait with no decision shows what it asks and the reply that explains it', (tester) async {
      await _open(tester, _card(kind: 'wait', decision: null, what: 'Needs your OK on four pushback drafts and a yes or no on closing #20606'), _Port());
      expect(find.byKey(const ValueKey('mc-ctx-what')), findsOneWidget);
      expect(find.textContaining('four pushback drafts and a yes or no'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-question')), findsNothing);
    });

    testWidgets('an action card has no Answer (it is Done from its card) but can open its session', (tester) async {
      final a = McCard.fromJson({
        ..._cardJson(kind: 'action', decision: null, what: 'Plug in the tablet'),
        'action': {'steps': ['Plug it in', 'Open the app'], 'where': 'the office'},
      })!;
      await _open(tester, a, _Port());
      expect(find.byKey(const ValueKey('mc-ctx-answer')), findsNothing);
      expect(find.byKey(const ValueKey('mc-ctx-open')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-step-1')), findsOneWidget);
      expect(find.text('Where: the office'), findsOneWidget);
    });

    testWidgets('DEGRADES: no reply yet, an unreadable one, the short form, no items - each a line, never an error', (tester) async {
      final p = _Port()
        ..reply = const McContextReply()
        ..items = const [];
      await _open(tester, _card(), p);
      expect(find.byKey(const ValueKey('mc-ctx-reply-none')), findsOneWidget);
      expect(find.text('It has not written a reply yet.'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-items-none')), findsOneWidget);
      // The question and the answer are still there.
      expect(find.byKey(const ValueKey('mc-ctx-question')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-answer')), findsOneWidget);
    });

    testWidgets('DEGRADES: a read that failed says why; a short reply says it is short', (tester) async {
      final p = _Port()..reply = const McContextReply(problem: 'Its reply could not be read: HTTP 502');
      await _open(tester, _card(), p);
      expect(find.byKey(const ValueKey('mc-ctx-reply-problem')), findsOneWidget);
      expect(find.text('Its reply could not be read: HTTP 502'), findsOneWidget);
    });

    testWidgets('the short form of a reply is labelled as such (a server that cannot send the whole text)', (tester) async {
      final p = _Port()..reply = const McContextReply(text: 'Only the reminder.', whole: false);
      await _open(tester, _card(), p);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('mc-ctx-reply-short')), 300, scrollable: find.byType(Scrollable).first);
      expect(find.byKey(const ValueKey('mc-ctx-reply-short')), findsOneWidget);
    });

    testWidgets('a reader that throws is an empty section, never a sheet that does not open', (tester) async {
      tester.view.physicalSize = const Size(600, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final port = McCardContextPort(
        reply: (_) async => throw StateError('boom'),
        items: (_) async => throw StateError('boom'),
        openSubject: (_) {},
        answer: (_) {},
        openSession: (_) {},
      );
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: McCardContextSheet(card: _card(), port: port)));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-ctx-reply-problem')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-items-none')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a phone gets it full screen, a desktop a dialog', (tester) async {
      await _open(tester, _card(), _Port(), size: const Size(600, 1600));
      expect(find.byType(Dialog), findsNothing);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-ctx-close')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);

      await _open(tester, _card(), _Port(), size: const Size(1300, 1000));
      expect(find.byType(Dialog), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
    });
  });

  group('the reader', () {
    final seen = <Uri>[];
    var recapBody = <String, dynamic>{};
    var recapStatus = 200;
    final subjectsBody = <String, Map<String, dynamic>?>{};

    ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
          seen.add(req.url);
          if (req.url.path.endsWith('/recap')) return http.Response(jsonEncode(recapBody), recapStatus);
          return http.Response('{}', 404);
        }));

    McCardContextReader reader({List<Session>? sessions}) => McCardContextReader(
          sessions: () => sessions ?? [_session()],
          client: client,
          subject: (key) async {
            final b = subjectsBody[key];
            if (b == null) throw const ApiException(404, 'no such subject');
            return McSubjectDetail.fromJson(b);
          },
        );

    setUp(() {
      seen.clear();
      recapStatus = 200;
      recapBody = {
        'name': 'bh orchestrator',
        'cwd': '/w',
        'status': 'waiting',
        'reply': {'text': 'the TL;DR', 'at': '2026-11-26T10:00:00.000Z', 'isSummary': true, 'full': '## Long\n\nthe whole thing'},
      };
      subjectsBody.clear();
    });

    test('reads the reply IN FULL: asks the recap for it and shows the whole text, not the TL;DR', () async {
      final r = await reader().reply(_card());
      expect(seen.single.path, '/api/sessions/s1/recap');
      expect(seen.single.queryParameters['full'], '1');
      expect(r.text, '## Long\n\nthe whole thing');
      expect(r.whole, isTrue);
      expect(r.at, isNotNull);
    });

    test('an older server sends no whole text: the short form, labelled, never nothing', () async {
      (recapBody['reply'] as Map).remove('full');
      final r = await reader().reply(_card());
      expect(r.text, 'the TL;DR');
      expect(r.whole, isFalse);
    });

    test('no reply yet is no problem; a session this app does not list, and a failed read, say why', () async {
      recapBody = {'name': 'x', 'cwd': '/w', 'status': 'idle', 'reply': null};
      final none = await reader().reply(_card());
      expect(none.text, isNull);
      expect(none.problem, isNull);

      final unknown = await reader(sessions: const []).reply(_card());
      expect(unknown.text, isNull);
      expect(unknown.problem, contains("not in this app's list"));

      recapStatus = 500;
      recapBody = {'error': 'boom'};
      final failed = await reader().reply(_card());
      expect(failed.text, isNull);
      expect(failed.problem, contains('could not be read'));
    });

    test('items: every item the session names, an ADO item by its station and a GitHub item by its stage', () async {
      subjectsBody['ado:22946'] = _subjectJson('ado:22946', station: 'Parked', current: 'in-review');
      subjectsBody['acme/web#7'] = _subjectJson('acme/web#7', current: 'pr-open', title: 'Fix login');
      final s = _session(items: const [
        BriefItem(ref: 'ado:22946', key: 'ado:22946', title: 'Pushback drafts', state: 'in-progress'),
        BriefItem(ref: 'acme/web#7', key: 'acme/web#7', title: '', state: 'committed'),
      ]);
      final items = await reader(sessions: [s]).items(_card());
      expect(items.map((i) => i.ref), ['ado:22946', 'acme/web#7']);
      expect(items[0].where, 'Station: Parked');
      expect(items[0].state, 'in-progress');
      expect(items[1].where, 'Stage: PR open');
      // A title the session left blank comes from the server's subject.
      expect(items[1].title, 'Fix login');
    });

    test('an item whose page cannot be read still shows, without where it stands', () async {
      final s = _session(items: const [BriefItem(ref: 'ado:9', key: 'ado:9', title: 'Lonely', state: 'planning')]);
      final card = McCard.fromJson({..._cardJson(), 'ref': 'ado:9', 'title': 'Lonely'})!;
      final items = await reader(sessions: [s]).items(card);
      expect(items.single.title, 'Lonely');
      expect(items.single.where, isNull);
      expect(items.single.key, 'ado:9');
    });

    test("the card's own item is asked about and opened by the SERVER's subject key, not the brief's bare key", () async {
      // A folder with no GitHub origin reports `#12`; the server's subject for it is `#12@s1`.
      subjectsBody['#12@s1'] = _subjectJson('#12@s1', current: 'fixing');
      final s = _session(items: const [BriefItem(ref: '#12', key: '#12', title: 'Own item', state: 'in-progress', note: 'half done')]);
      final card = McCard.fromJson({..._cardJson(), 'ref': '#12', 'subjectKey': '#12@s1'})!;
      final items = await reader(sessions: [s]).items(card);
      expect(items, hasLength(1));
      expect(items.single.key, '#12@s1');
      expect(items.single.where, 'Stage: Fixing');
      // Everything the session reported about it is kept.
      expect(items.single.title, 'Own item');
      expect(items.single.note, 'half done');
      expect(items.single.state, 'in-progress');
    });

    test('another item the feed does not know opens nothing: it shows, with no page to open', () async {
      subjectsBody['#12@s1'] = _subjectJson('#12@s1');
      final s = _session(items: const [
        BriefItem(ref: '#12', key: '#12', title: 'Own item'),
        BriefItem(ref: '#13', key: '#13', title: 'Other bare item'),
      ]);
      final card = McCard.fromJson({..._cardJson(), 'ref': '#12', 'subjectKey': '#12@s1'})!;
      final items = await reader(sessions: [s]).items(card);
      expect(items.map((i) => i.ref), ['#12', '#13']);
      expect(items[0].key, '#12@s1');
      expect(items[1].key, isNull, reason: '`#13` is not a subject key: a page opened by it would say the item is gone');
      expect(items[1].title, 'Other bare item');
    });

    test("the card's own item comes first when the session does not list it; none when nothing is named", () async {
      final card = McCard.fromJson({..._cardJson(), 'subjectKey': 'ado:22946'})!;
      final items = await reader(sessions: [_session()]).items(card);
      expect(items.single.ref, 'ado:22946');
      expect(items.single.title, 'Pushback drafts');
      final none = await reader(sessions: [_session()]).items(McCard.fromJson({..._cardJson(), 'ref': null, 'title': null})!);
      expect(none, isEmpty);
    });
  });

  group('tapping a card', () {
    final port = _Port();

    Future<void> pumpCard(WidgetTester tester, Widget card, {bool withPort = true}) async {
      tester.view.physicalSize = const Size(600, 1800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McQuestionScope(
          analyst: McAnalyst(servers: () => const [], client: ApiClient.new),
          onSend: (c, t, s) async => true,
          onAnswer: (_) {},
          answerPort: McAnswerPort(
            pendingQuestion: (_) async => null,
            answerQuestion: (_, _, _) async => true,
            send: (_, _) async => true,
            openSession: (_) {},
          ),
          contextPort: withPort ? port.port : null,
          child: Scaffold(body: SingleChildScrollView(child: card)),
        ),
      ));
    }

    testWidgets('an answer card opens the sheet; its chevron still unfolds it in place and opens no sheet', (tester) async {
      var answered = 0;
      await pumpCard(
        tester,
        McAnswerCard(card: _card(), onAnswer: () => answered++, onLater: (_) {}, onTodo: () {}),
      );
      await tester.tap(find.byKey(const ValueKey('mc-card-expand')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-card-detail')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('mc-card-heading')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
      expect(answered, 0);
    });

    testWidgets('a card with no context port behaves as before: a tap unfolds an expandable card', (tester) async {
      await pumpCard(
        tester,
        McAnswerCard(card: _card(), onAnswer: () {}, onLater: (_) {}, onTodo: () {}),
        withPort: false,
      );
      await tester.tap(find.byKey(const ValueKey('mc-card-heading')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);
      expect(find.byKey(const ValueKey('mc-card-detail')), findsOneWidget);
    });

    testWidgets('a wait card, which has nothing to unfold, opens the sheet too', (tester) async {
      await pumpCard(
        tester,
        McAnswerCard(card: _card(kind: 'wait', decision: null), onAnswer: () {}, onLater: (_) {}, onTodo: () {}),
      );
      await tester.tap(find.byKey(const ValueKey('mc-card-heading')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
    });

    testWidgets('the card buttons still act on their own: Open session does not open the sheet', (tester) async {
      var opened = 0;
      await pumpCard(
        tester,
        McAnswerCard(card: _card(), onAnswer: () {}, onLater: (_) {}, onTodo: () {}, onOpenSession: () => opened++),
      );
      await tester.tap(find.byKey(const ValueKey('mc-card-open')));
      await tester.pumpAndSettle();
      expect(opened, 1);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);
    });

    testWidgets('a to-do (action) card opens the sheet on a tap; Done is still its own button', (tester) async {
      var done = 0;
      final a = McCard.fromJson({
        ..._cardJson(kind: 'action', decision: null, what: 'Plug in the tablet'),
        'action': {'steps': ['Plug it in'], 'where': 'the office'},
      })!;
      await pumpCard(tester, McActionCard(card: a, onDone: () => done++, onLater: (_) {}));
      await tester.tap(find.byKey(const ValueKey('mc-action-done')));
      await tester.pumpAndSettle();
      expect(done, 1);
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-action-what')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mc-ctx-sheet')), findsOneWidget);
    });
  });
}
