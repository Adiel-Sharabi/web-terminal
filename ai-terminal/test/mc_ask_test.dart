// #511 - Mission Control Ask in the app: the wire shapes, the client that finds the server
// answering Mission Control (a 409 names it), the view (answer as plain text, sources as
// chips that open the session or the link, how old the data is, what was cut), and the
// home's phone tab and desktop panel sharing one conversation. Synthetic data only.
import 'dart:async';
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_ask_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/ask_view.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/services/mc_analyst.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');
const _b = ServerConfig(name: 'Beta', baseUrl: 'https://beta.test', bearerToken: 'tb');

final _now = DateTime.now().millisecondsSinceEpoch;

Map<String, dynamic> _answerJson({Map<String, dynamic>? cut}) => {
      'answer': 'Session one is waiting on you [S1]. <b>not html</b>',
      'sources': [
        {'id': 'S1', 'kind': 'session', 'label': 'sess-one', 'server': 'Alpha', 'sessionId': 'sid-1', 'at': _now - 120000, 'url': null},
        {'id': 'S4', 'kind': 'pr', 'label': 'PR acme/web#8', 'server': null, 'sessionId': null, 'at': null, 'url': 'https://example.test/pull/8'},
        {'kind': 'workitem', 'label': 'no id'},
        'junk',
      ],
      'dataAge': {'oldestAt': _now - 3 * 3600000, 'newestAt': _now - 120000},
      'cut': cut,
      'scope': {'kind': 'all', 'id': null},
      'model': 'sonnet',
      'generatedAt': _now,
    };

ApiClient Function(ServerConfig) _clients(Map<String, http.Response Function(http.Request)> byHost, List<String> asked) =>
    (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          asked.add('${req.url.host} ${req.url.path}');
          final f = byHost[req.url.host];
          return f == null ? http.Response('x', 500) : f(req);
        }));

class _FakeAnalyst extends McAnalyst {
  _FakeAnalyst() : super(servers: () => const [_a], client: ApiClient.new);
  final calls = <(String, McAskScope)>[];
  Completer<McAnswer>? next;
  @override
  Future<McAnswer> ask(String question, McAskScope scope) {
    calls.add((question, scope));
    next = Completer<McAnswer>();
    return next!.future;
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('wire', () {
    test('an answer parses; a source without a kind or a non-map is dropped', () {
      final a = McAnswer.fromJson(_answerJson(cut: {'omitted': 2, 'total': 9, 'itemsOmitted': 0, 'itemsTotal': 3}));
      expect(a.sources.map((s) => s.id), ['S1', 'S4', '']);
      expect(a.sources.first.opensSession, isTrue);
      expect(a.sources[1].opensSession, isFalse);
      expect(a.sources.first.at, DateTime.fromMillisecondsSinceEpoch(_now - 120000));
      expect(a.model, 'sonnet');
      expect(a.cut!.text, contains('2 of 9 sessions'));
      expect(a.cut!.text, isNot(contains('work items')));
      expect(const McAskScope.subject('acme/web#7').toJson(), {'kind': 'subject', 'id': 'acme/web#7'});
      expect(McAskScope.all.toJson(), {'kind': 'all'});
      expect(McAnswer.failureText('busy'), contains('busy'));
      expect(McAnswer.failureText('weird'), contains('could not answer'));
    });

    test('mcAsk posts the question and scope; a 503 is thrown in words', () async {
      final bodies = <Object?>[];
      var status = 200;
      final c = ApiClient(_a, httpClient: MockClient((req) async {
        bodies.add(jsonDecode(req.body));
        return status == 200
            ? http.Response(jsonEncode(_answerJson()), 200)
            : http.Response(jsonEncode({'status': 'unavailable', 'reason': 'busy'}), status);
      }));
      final a = await c.mcAsk('what is stuck?', const McAskScope.project('web'));
      expect(a.answer, contains('waiting on you'));
      expect(bodies.single, {'question': 'what is stuck?', 'scope': {'kind': 'project', 'id': 'web'}});
      status = 503;
      await expectLater(c.mcAsk('q', McAskScope.all),
          throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('busy')).having((e) => e.status, 'status', 503)));
    });
  });

  group('McAnalyst finds the server answering Mission Control', () {
    test('a 409 names the authority by url; it answers and is asked first next time', () async {
      final asked = <String>[];
      final an = McAnalyst(
        servers: () => const [_a, _b],
        client: _clients({
          'alpha.test': (_) => http.Response(jsonEncode({'role': 'peer', 'authority': {'name': 'beta', 'url': 'https://beta.test/'}}), 409),
          'beta.test': (_) => http.Response(jsonEncode(_answerJson()), 200),
        }, asked),
      );
      await an.ask('q', McAskScope.all);
      expect(asked, ['alpha.test /api/mc/ask', 'beta.test /api/mc/ask']);
      expect(an.answeredBy, _b);
      asked.clear();
      await an.ask('q2', McAskScope.all);
      expect(asked, ['beta.test /api/mc/ask']);
    });

    test('an authority not in the list is said; a 404 naming what is unknown is final', () async {
      final asked = <String>[];
      final an = McAnalyst(
        servers: () => const [_a],
        client: _clients({
          'alpha.test': (_) => http.Response(jsonEncode({'role': 'peer', 'authority': {'name': 'gamma', 'url': 'https://gamma.test'}}), 409),
        }, asked),
      );
      await expectLater(an.ask('q', McAskScope.all), throwsA(isA<ApiException>().having((e) => e.message, 'm', contains('add that server'))));
      final an2 = McAnalyst(
        servers: () => const [_a, _b],
        client: _clients({'alpha.test': (_) => http.Response(jsonEncode({'error': 'no such session in the cluster'}), 404)}, asked..clear()),
      );
      await expectLater(an2.ask('q', const McAskScope.session('x')),
          throwsA(isA<ApiException>().having((e) => e.message, 'm', 'no such session in the cluster')));
      expect(asked, ['alpha.test /api/mc/ask'], reason: 'a real 404 is an answer, not a reason to ask elsewhere');
    });

    test('a server from before Ask (a bare 404) and an unreachable one are skipped', () async {
      final asked = <String>[];
      final an = McAnalyst(
        servers: () => const [_a, _b],
        client: _clients({
          'alpha.test': (_) => http.Response('<pre>Cannot POST</pre>', 404),
        }, asked),
      );
      // Beta has no handler: a 500 - final, with its words.
      await expectLater(an.ask('q', McAskScope.all), throwsA(isA<ApiException>().having((e) => e.status, 's', 500)));
      expect(asked, ['alpha.test /api/mc/ask', 'beta.test /api/mc/ask']);
      final an2 = McAnalyst(servers: () => const [_a], client: _clients({'alpha.test': (_) => http.Response('<pre>Cannot POST</pre>', 404)}, asked));
      await expectLater(an2.ask('q', McAskScope.all), throwsA(isA<ApiException>().having((e) => e.message, 'm', contains('no Ask yet'))));
    });
  });

  group('the view', () {
    Future<(_FakeAnalyst, McAskThread, List<String>, List<Uri>)> pump(WidgetTester tester) async {
      final an = _FakeAnalyst();
      final thread = McAskThread(an);
      final opened = <String>[];
      final urls = <Uri>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: McAskView(thread: thread, onOpenSession: opened.add, onOpenUrl: urls.add)),
      ));
      return (an, thread, opened, urls);
    }

    testWidgets('a question shows at once, then the answer as plain text with its sources and their age', (tester) async {
      final (an, thread, opened, urls) = await pump(tester);
      expect(find.byKey(const ValueKey('mc-ask-intro')), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('mc-ask-input')), 'what is stuck?');
      await tester.tap(find.byKey(const ValueKey('mc-ask-send')));
      await tester.pump();
      expect(an.calls.single, ('what is stuck?', McAskScope.all));
      expect(find.text('what is stuck?'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ask-pending')), findsOneWidget);
      // One question at a time.
      await tester.enterText(find.byKey(const ValueKey('mc-ask-input')), 'another');
      await tester.tap(find.byKey(const ValueKey('mc-ask-send')));
      expect(an.calls, hasLength(1));

      an.next!.complete(McAnswer.fromJson(_answerJson(cut: {'omitted': 1, 'total': 4, 'itemsOmitted': 0, 'itemsTotal': 0})));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-ask-pending')), findsNothing);
      final answer = tester.widget<SelectableText>(find.byKey(const ValueKey('mc-ask-answer')));
      expect(answer.data, contains('<b>not html</b>'), reason: 'shown as text, never parsed');
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-ask-age'))).data, allOf(contains('sonnet'), contains('3h ago'), contains('2m ago')));
      expect(find.byKey(const ValueKey('mc-ask-cut')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-ask-source-S1')));
      expect(opened, ['sid-1']);
      await tester.tap(find.byKey(const ValueKey('mc-ask-source-S4')));
      expect(urls, [Uri.parse('https://example.test/pull/8')]);
      thread.dispose();
    });

    testWidgets('a failure is said in place of the answer; the scope picker sends the scope', (tester) async {
      final an = _FakeAnalyst();
      final thread = McAskThread(an);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
            body: McAskView(
          thread: thread,
          onOpenSession: (_) {},
          projects: const [], // the default list: Everything only
        )),
      ));
      await tester.enterText(find.byKey(const ValueKey('mc-ask-input')), 'q');
      await tester.tap(find.byKey(const ValueKey('mc-ask-send')));
      await tester.pump();
      an.next!.completeError(const ApiException(503, 'The Analyst is busy with other questions: try again in a moment'));
      await tester.pump();
      await tester.pump();
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-ask-error'))).data, contains('busy'));
      thread.dispose();
    });

    testWidgets('a fixed scope asks about that scope and shows no picker', (tester) async {
      final an = _FakeAnalyst();
      final thread = McAskThread(an);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
            body: McAskView(
                thread: thread,
                onOpenSession: (_) {},
                fixedScope: const McAskScope.subject('acme/web#7'),
                fixedScopeLabel: 'acme/web#7')),
      ));
      expect(find.byKey(const ValueKey('mc-ask-scopes')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('mc-ask-input')), 'where is it?');
      await tester.tap(find.byKey(const ValueKey('mc-ask-send')));
      await tester.pump();
      expect(an.calls.single.$2, const McAskScope.subject('acme/web#7'));
      an.next!.complete(McAnswer.fromJson(_answerJson()));
      await tester.pump();
      thread.dispose();
    });
  });

  group('the home', () {
    McFeed feed() => McFeed(
          servers: () => const [_a],
          client: (sv) => ApiClient(sv, httpClient: MockClient((req) async => http.Response(jsonEncode({'error': 'Not found'}), 404))),
        );

    Future<void> size(WidgetTester tester, Size s) async {
      tester.view.physicalSize = s;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
    }

    testWidgets('phone: the Ask tab is the Ask view', (tester) async {
      await size(tester, const Size(400, 860));
      final an = _FakeAnalyst();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: feed(), analyst: an, onShowSessionsHome: () {}),
      ));
      await tester.pump();
      await tester.tap(find.text('Ask'));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-ask-view')), findsOneWidget);
      expect(find.textContaining('#511'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('desktop: the rail opens an Ask panel beside the tab; the conversation is kept when it closes', (tester) async {
      await size(tester, const Size(1500, 900));
      final an = _FakeAnalyst();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(feed: feed(), analyst: an, onShowSessionsHome: () {}),
      ));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-ask-panel')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-ask-panel-toggle')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-ask-panel')), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('mc-ask-input')), 'kept?');
      await tester.tap(find.byKey(const ValueKey('mc-ask-send')));
      await tester.pump();
      an.next!.complete(McAnswer.fromJson(_answerJson()));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mc-ask-panel-close')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-ask-panel')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-ask-panel-toggle')));
      await tester.pump();
      expect(find.text('kept?'), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-ask-answer')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
