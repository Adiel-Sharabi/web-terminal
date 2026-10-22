// #383 - the writers behind a "needs you" card, extracted from the sessions board so
// the questions inbox can share them. The board's own behaviour is pinned end to end
// by work_board_test.dart (including the pre-write refusals, through the screen); this
// file pins the pure re-check rule, the writer on its own, and that the session screen
// takes its drafts from the shared store instead of owning a copy.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart' show questionSignature;
import 'package:ai_terminal/services/needs_you_actions.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

Map<String, dynamic> _qJson(String question) => {
      'toolUseId': 't1',
      'questions': [
        {
          'header': 'H',
          'question': question,
          'multiSelect': false,
          'options': [
            {'label': 'A'},
            {'label': 'B'},
          ],
        },
      ],
    };

PendingQuestion _pq(String question) => PendingQuestion.fromJson({'pending': true, 'question': _qJson(question)})!;

Session _session() => Session(
      id: 'q',
      name: 'Asker',
      cwd: '/w',
      status: 'waiting',
      claudeSessionId: null,
      lastActivity: null,
      notifyLevel: 'important',
      server: _server,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('preWriteVerdict', () {
    final shown = _pq('Pick one');
    final sig = questionSignature(shown);

    test('the same question (by content, whatever its id) -> proceed', () {
      final reReported = PendingQuestion(toolUseId: 'hook-q-7', questions: shown.questions);
      expect(preWriteVerdict(sig, reReported, false), PreWriteVerdict.proceed);
    });

    test('nothing pending -> gone', () {
      expect(preWriteVerdict(sig, null, false), PreWriteVerdict.gone);
    });

    test('a different question -> changed', () {
      expect(preWriteVerdict(sig, _pq('Pick another'), false), PreWriteVerdict.changed);
    });

    test('a failed poll -> refused, whatever it last returned', () {
      expect(preWriteVerdict(sig, shown, true), PreWriteVerdict.refused);
      expect(preWriteVerdict(sig, null, true), PreWriteVerdict.refused);
    });
  });

  group('NeedsYouActions.answer', () {
    late Map<String, dynamic>? pending;
    late int status;
    late List<String> written;
    late List<String> said;

    ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
          if (req.url.path.endsWith('/pending-question')) {
            if (status != 200) return http.Response('', status);
            return http.Response(jsonEncode(pending == null ? {'pending': false} : {'pending': true, 'question': pending}), 200);
          }
          if (req.url.path == '/api/version') {
            return http.Response(jsonEncode({'version': '1.81.0', 'serverName': 'Home', 'capabilities': <String>[]}), 200);
          }
          if (req.url.path == '/api/sessions') return http.Response('[]', 200);
          return http.Response('', 404);
        }));

    Future<NeedsYouActions> actions() async {
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      final a = NeedsYouActions(
        repository: SessionRepository.forTest(store: store, clientFactory: client),
        client: client,
        input: (s, body) async {
          await body((keys) {
            written.add(keys);
            if (keys == '\r') pending = null; // the question clears once it is committed
          });
          return true;
        },
        say: said.add,
        questionEvery: Duration.zero,
      );
      addTearDown(a.dispose);
      return a;
    }

    setUp(() {
      pending = _qJson('Pick one');
      status = 200;
      written = [];
      said = [];
      QuestionDraftStore.instance.resetForTest();
    });

    test('a refused re-check writes ZERO keys and flags nothing', () async {
      final a = await actions();
      final s = _session();
      final shown = _pq('Pick one');
      final drafts = QuestionDraftStore.instance.of(_server.baseUrl, s.id)..key = questionSignature(shown);
      final frames = buildAnswerFrames(shown.questions, [<int>{}], otherText: ['words']);
      status = 503;
      expect(await a.answer(s, shown, frames), PreWriteVerdict.refused);
      expect(written, isEmpty);
      expect(drafts.notLanded, isFalse, reason: 'nothing went out, so nothing may be partly typed');
      expect(a.isBusy(s), isFalse);
      expect(a.isAnswering(s, shown), isFalse, reason: 'the buttons come back');
      expect(said.single, contains('nothing was sent'));
    });

    test('a proceeding answer writes the frames and flags its words in the SHARED drafts', () async {
      final a = await actions();
      final s = _session();
      final shown = _pq('Pick one');
      final sig = questionSignature(shown);
      final drafts = QuestionDraftStore.instance.of(_server.baseUrl, s.id)..key = sig;
      // The session never takes it: the question stays up, so the flag must stay up.
      final frames = buildAnswerFrames(shown.questions, [<int>{}], otherText: ['a long answer']);
      final deaf = NeedsYouActions(
        repository: a.repository,
        client: client,
        input: (s, body) async {
          await body(written.add);
          return true;
        },
        say: said.add,
      );
      addTearDown(deaf.dispose);
      await deaf.answer(s, shown, frames);
      expect(written.take(frames.length), frames.map((f) => f.keys));
      expect(QuestionDraftStore.instance.of(_server.baseUrl, s.id).flaggedFor(sig), isTrue,
          reason: 'the session screen reads the same drafts: no blind replay there either');
      expect(drafts.words, ['a long answer']);
    }, timeout: const Timeout(Duration(seconds: 30)));

    test('F4: a question answered elsewhere while the socket attaches gets ZERO keys', () async {
      final a = await actions();
      final s = _session();
      final shown = _pq('Pick one');
      final drafts = QuestionDraftStore.instance.of(_server.baseUrl, s.id)..key = questionSignature(shown);
      final slow = NeedsYouActions(
        repository: a.repository,
        client: client,
        input: (s, body) async {
          // The attach takes its time (seconds, on a slow link); meanwhile the
          // question is answered in the terminal and another is asked. A check made
          // at the press has long since come back by then.
          await Future<void>.delayed(const Duration(milliseconds: 200));
          pending = _qJson('Pick another');
          await body(written.add);
          return true;
        },
        say: said.add,
      );
      addTearDown(slow.dispose);
      final frames = buildAnswerFrames(shown.questions, [<int>{}], otherText: ['words']);
      expect(await slow.answer(s, shown, frames), PreWriteVerdict.changed);
      expect(written, isEmpty, reason: 'the re-check runs on the attached socket, right before the first key');
      expect(drafts.notLanded, isFalse, reason: 'flagged only as a first key goes out');
      expect(said.single, contains('asking something else now'));
    });

    test('F6: a poll that sees the question gone drops its not-landed flag, so the same question later is not blocked',
        () async {
      final a = await actions();
      final s = _session();
      final shown = _pq('Pick one');
      final sig = questionSignature(shown);
      final drafts = QuestionDraftStore.instance.of(_server.baseUrl, s.id)..key = sig;
      drafts.markSent(sig, buildAnswerFrames(shown.questions, [<int>{}], otherText: ['half typed']));
      expect(a.quickAnswerBlocked(s, shown), isTrue);

      status = 503; // a failed poll is no observation: the flag stays
      await a.refreshQuestions([s]);
      expect(drafts.flaggedFor(sig), isTrue);

      status = 200;
      pending = null; // answered in the terminal
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await a.refreshQuestions([s]);
      pending = _qJson('Pick one'); // the very same question, asked again
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await a.refreshQuestions([s]);
      expect(a.questionFor(s), isNotNull);
      expect(drafts.flaggedFor(sig), isFalse);
      expect(a.quickAnswerBlocked(s, shown), isFalse);
    });

    test('a read-only look at a session never creates drafts for it', () async {
      final a = await actions();
      final s = _session();
      expect(a.quickAnswerBlocked(s, _pq('Pick one')), isFalse);
      expect(QuestionDraftStore.instance.peek(_server.baseUrl, s.id), isNull);
    });

    test('quickAnswer refuses, with ZERO keys, a question one press cannot answer', () async {
      final a = await actions();
      final multi = PendingQuestion.fromJson({
        'pending': true,
        'question': {
          'toolUseId': 'm',
          'questions': [
            {
              'header': 'H',
              'question': 'Which ones?',
              'multiSelect': true,
              'options': [
                {'label': 'A'},
                {'label': 'B'},
              ],
            },
          ],
        },
      })!;
      expect(await a.quickAnswer(_session(), multi, 0), PreWriteVerdict.refused);
      expect(written, isEmpty);
      expect(said.single, contains('nothing was sent'));
    });
  });

  test('the session screen looks its drafts up in the store, and owns none of its own', () {
    final src = File('lib/screens/session_screen.dart').readAsStringSync();
    expect(src, contains('QuestionDraftStore.instance.of('));
    expect(RegExp(r'QuestionDrafts\(\)').hasMatch(src), isFalse,
        reason: 'a per-screen QuestionDrafts would hide the inbox\'s flag from the session screen');
  });
}
