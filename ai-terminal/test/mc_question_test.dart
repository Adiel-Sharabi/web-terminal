// #510 - a question card's panel in the app: the wire shapes, the Analyst client finding
// Mission Control's server for the question routes, the panel (three levels, a follow-up
// answered under its option, suggestions sent only after a confirm, Compare), and the pick
// sender, which uses the existing answer path: an AskUserQuestion's `Other` row through
// buildAnswerFrames, refused for a side-by-side question. Synthetic data only.
import 'dart:async';
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_ask_models.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/question_panel.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/services/mc_pick_sender.dart';
import 'package:ai_terminal/services/needs_you_actions.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');
const _b = ServerConfig(name: 'Beta', baseUrl: 'https://beta.test', bearerToken: 'tb');
const _card = McCard(id: 'Alpha|s1|decision:5', kind: 'decision', server: 'Alpha', sessionId: 's1', sessionName: 'fixer', ref: 'acme/web#7', title: 'Fix login');

Map<String, dynamic> _ctxJson(String level, {bool canSuggest = true}) => {
      'level': level,
      'text': 'x',
      'sections': [
        {'title': 'The ask', 'body': 'Which fix?\n1. Patch\n2. Rewrite (recommended)'},
        {'title': 'Recommendation', 'body': 'Option 2: Rewrite'},
        if (level != 'ask') {'title': 'What the session did', 'body': 'Read the form code'},
        {'title': 'bad'},
      ],
      'sources': [
        {'id': 'S1', 'kind': 'session', 'label': 'fixer', 'sessionId': 's1'},
      ],
      'ask': {
        'kind': 'decision',
        'questions': [
          {'text': 'Which fix?'},
        ],
        'options': [
          {'index': 0, 'question': 0, 'label': 'Patch', 'detail': 'quick', 'recommended': false},
          {'index': 1, 'question': 0, 'label': 'Rewrite', 'detail': 'a day', 'recommended': true},
          {'label': 'no index'},
        ],
        'recommended': 1,
        'canSuggest': canSuggest,
      },
      'cardId': _card.id,
      'generatedAt': 1,
    };

class _FakeAnalyst extends McAnalyst {
  _FakeAnalyst({this.canSuggest = true}) : super(servers: () => const [_a], client: ApiClient.new);
  final bool canSuggest;
  final levels = <String>[];
  final followups = <(int?, String)>[];
  int suggests = 0;

  @override
  Future<McQuestionContext> questionContext(String cardId, String level) async {
    levels.add(level);
    return McQuestionContext.fromJson(_ctxJson(level, canSuggest: canSuggest));
  }

  @override
  Future<McAnswer> followup(String cardId, int? option, String question) async {
    followups.add((option, question));
    return McAnswer(answer: 'About ${option == null ? 'it' : 'option ${option + 1}'}: about a day.');
  }

  @override
  Future<McSuggestions> suggest(String cardId) async {
    suggests++;
    return McSuggestions(options: const [McSuggestion('Split it in two', 'two PRs'), McSuggestion('Ask the owner')], canSend: canSuggest);
  }
}

Widget _app(Widget child) => MaterialApp(theme: AppTheme.dark, home: child);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('wire', () {
    test('a context parses; a section or option without its fields is dropped', () {
      final c = McQuestionContext.fromJson(_ctxJson('context'));
      expect(c.level, 'context');
      expect(c.sections.map((s) => s.title), ['The ask', 'Recommendation', 'What the session did']);
      expect(c.ask.options.map((o) => o.label), ['Patch', 'Rewrite']);
      expect(c.ask.recommended, 1);
      expect(c.ask.canSuggest, isTrue);
      expect(c.sources.single.id, 'S1');
      final s = McSuggestions.fromJson({
        'options': [
          {'label': 'A', 'consequence': 'does A'},
          {'label': ' '},
          {'consequence': 'no label'},
          {'label': 'B'},
        ],
        'canSend': true,
      });
      expect(s.options.map((o) => o.label), ['A', 'B']);
      expect(s.options.first.consequence, 'does A');
      expect(s.canSend, isTrue);
    });

    test('the question routes go to the authority a 409 names, with the card id encoded', () async {
      final asked = <String>[];
      ApiClient client(ServerConfig sv) => ApiClient(sv, httpClient: MockClient((req) async {
            asked.add('${req.url.host} ${req.method} ${req.url.path}${req.url.query.isEmpty ? '' : '?${req.url.query}'}');
            if (req.url.host == 'alpha.test') {
              return http.Response(jsonEncode({'role': 'peer', 'authority': {'name': 'Beta', 'url': 'https://beta.test'}}), 409);
            }
            if (req.url.path.endsWith('/context')) return http.Response(jsonEncode(_ctxJson('everything')), 200);
            if (req.url.path.endsWith('/followup')) {
              expect(jsonDecode(req.body), {'option': 1, 'question': 'how long?'});
              return http.Response(jsonEncode({'answer': 'a day', 'sources': [], 'option': 1}), 200);
            }
            if (req.url.path.endsWith('/suggest')) return http.Response(jsonEncode({'status': 'failed', 'reason': 'timeout'}), 502);
            return http.Response('', 404);
          }));
      final an = McAnalyst(servers: () => const [_a, _b], client: client);
      final c = await an.questionContext(_card.id, 'everything');
      expect(c.level, 'everything');
      expect(asked.last, 'beta.test GET /api/mc/questions/Alpha%7Cs1%7Cdecision%3A5/context?level=everything');
      expect((await an.followup(_card.id, 1, 'how long?')).answer, 'a day');
      await expectLater(an.suggest(_card.id), throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('took too long'))));
    });
  });

  group('panel', () {
    testWidgets('three levels; a follow-up answered under its option; Compare; nothing sent without a confirm', (tester) async {
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final an = _FakeAnalyst();
      final sent = <String>[];
      await tester.pumpWidget(_app(McQuestionPanel(card: _card, analyst: an, onSend: (c, t) async {
        sent.add(t);
        return true;
      })));
      await tester.pumpAndSettle();
      expect(an.levels, ['ask']);
      expect(find.byKey(const ValueKey('mcq-section-The ask')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcq-section-What the session did')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('mcq-level-context')));
      await tester.pumpAndSettle();
      expect(an.levels, ['ask', 'context']);
      expect(find.byKey(const ValueKey('mcq-section-What the session did')), findsOneWidget);

      // Ask about option 2: the answer shows under it.
      await tester.tap(find.byKey(const ValueKey('mcq-followup-open-1')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('mcq-followup-field-1')), 'how long?');
      await tester.tap(find.byKey(const ValueKey('mcq-followup-send-1')));
      await tester.pumpAndSettle();
      expect(an.followups, [(1, 'how long?')]);
      expect(
          find.descendant(of: find.byKey(const ValueKey('mcq-option-1')), matching: find.text('About option 2: about a day.')),
          findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('mcq-compare')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mcq-compare-table')), findsOneWidget);
      expect(find.text('About option 2: about a day.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('mcq-suggest')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mcq-suggestion-0')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mcq-send-0')));
      await tester.pumpAndSettle();
      // The confirm is up; nothing went out yet.
      expect(sent, isEmpty);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(sent, isEmpty);
      await tester.tap(find.byKey(const ValueKey('mcq-send-0')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mcq-send-confirm')));
      await tester.pumpAndSettle();
      expect(sent, ['Split it in two']);
    });

    testWidgets('a question that takes only its own options offers no send', (tester) async {
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final an = _FakeAnalyst(canSuggest: false);
      await tester.pumpWidget(_app(McQuestionPanel(card: _card, analyst: an, onSend: (c, t) async => true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mcq-suggest')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('mcq-suggestion-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcq-send-0')), findsNothing);
      expect(find.byKey(const ValueKey('mcq-cannot-send')), findsOneWidget);
    });
  });

  group('pick sender', () {
    const server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
    final session = Session(
        id: 'q', name: 'Asker', cwd: '/w', status: 'waiting', claudeSessionId: null, lastActivity: null, notifyLevel: 'important', server: server);
    Map<String, dynamic> question({bool preview = false, bool multi = false}) => {
          'toolUseId': 't1',
          'questions': [
            {
              'header': 'H',
              'question': 'Pick a color',
              'multiSelect': multi,
              'hasPreview': preview,
              'options': [
                {'label': 'Red'},
                {'label': 'Blue'},
              ],
            },
          ],
        };
    late Map<String, dynamic>? pending;
    late List<String> posted;
    late List<String> said;

    ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
          if (req.url.path.endsWith('/answer')) {
            for (final f in (jsonDecode(req.body)['frames'] as List)) {
              posted.add(f['keys'] as String);
            }
            pending = null;
            return http.Response(jsonEncode({'ok': true, 'frames': posted.length, 'ms': 0}), 202);
          }
          if (req.url.path.endsWith('/pending-question')) {
            return http.Response(jsonEncode(pending == null ? {'pending': false} : {'pending': true, 'question': pending}), 200);
          }
          if (req.url.path == '/api/version') {
            return http.Response(jsonEncode({'version': '1.81.0', 'serverName': 'Home', 'capabilities': <String>[]}), 200);
          }
          if (req.url.path == '/api/sessions') return http.Response('[]', 200);
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
      final a = NeedsYouActions(
        repository: SessionRepository.forTest(store: store, clientFactory: client),
        client: client,
        input: (s, body) async {
          await body((keys) => posted.add('ws:$keys'));
          return true;
        },
        say: said.add,
        questionEvery: Duration.zero,
      );
      addTearDown(a.dispose);
      return McPickSender(actions: a, sessions: () => [session]);
    }

    setUp(() {
      posted = [];
      said = [];
    });

    const qCard = McCard(id: 'Home|q|question:1', kind: 'question', server: 'Home', sessionId: 'q');

    test('a compact question: the pick goes out as its Other answer, the frames buildAnswerFrames makes', () async {
      pending = question();
      final s = await sender();
      expect(await s.send(qCard, 'Green'), isTrue);
      final q = PendingQuestion.fromJson({'pending': true, 'question': question()})!;
      final want = buildAnswerFrames(q.questions, [<int>{}], otherText: ['Green']).map((f) => f.keys).toList();
      expect(posted.take(want.length).toList(), want);
      // The frames scripts/rig/verify-mc-question.js sends for its two-option question.
      expect(want, ['3', '[200~Green[201~', '']);
      expect(posted.join(), contains('Green'));
    });

    test('a side-by-side question, or a session the app does not know: refused, nothing written', () async {
      pending = question(preview: true);
      final s = await sender();
      expect(await s.send(qCard, 'Green'), isFalse);
      expect(posted, isEmpty);
      expect(said.single, contains('nothing was sent'));
      expect(await s.send(const McCard(id: 'x', kind: 'question', server: 'Home', sessionId: 'other'), 'Green'), isFalse);
      expect(posted, isEmpty);
    });
  });
}
