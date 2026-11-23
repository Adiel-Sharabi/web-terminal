// #508 / #509 - Mission Control's Project and Subject screens against a faked cluster
// answering synthetic fixtures (the server routes are built in parallel):
//   * the wire parse tolerates junk; the client asks the contract's routes;
//   * the Project screen shows Now's own counts (so they match Now), area tabs with the
//     needs-you count in orange, the server's filters, runs grouped with their header,
//     and subject rows; tapping a row opens the Subject screen;
//   * the Subject screen draws the server's session tree (a repro child, a fix child and
//     a closed child all under their parent), the progress track with its evidence, the
//     same question card as Now, the work item, and Pause through each session's own
//     server, with every refusal shown.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/mission_control/mc_home.dart';
import 'package:ai_terminal/screens/mission_control/now_view.dart';
import 'package:ai_terminal/screens/mission_control/project_view.dart';
import 'package:ai_terminal/screens/mission_control/subject_screen.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _json(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync()) as Map<String, dynamic>;

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');
const _b = ServerConfig(name: 'Beta', baseUrl: 'http://beta.test:7681', bearerToken: 'tb');

/// The fixture's clock: 2026-01-01T00:00:00Z.
final _now = DateTime.fromMillisecondsSinceEpoch(1767225600000);

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Two servers: alpha is the Mission Control authority (it answers /api/mc/*); both type
/// gated prompts into their own sessions. [prompt] answers each session's prompt.
class _Cluster {
  final List<http.Request> requests = [];
  Map<String, (int, Object)> prompt = {
    's-1': (200, {'delivered': true}),
    's-2': (409, {'delivered': false, 'refused': 'draft'}),
    's-3': (409, {'delivered': false, 'refused': 'busy'}),
  };
  int subjectsStatus = 200;

  http.Response _answer(ServerConfig sv, http.Request req) {
    requests.add(req);
    final path = req.url.path;
    if (req.method == 'POST' && path.endsWith('/prompt')) {
      final id = Uri.decodeComponent(path.split('/')[3]);
      final (status, body) = prompt[id] ?? (404, {'error': 'session not found'});
      return http.Response(jsonEncode(body), status);
    }
    if (sv.name != 'Alpha') return http.Response(jsonEncode({'error': 'Not found'}), 404);
    if (path == '/api/mc/now') return http.Response(jsonEncode(_json('mc_now.json')), 200);
    if (path == '/api/mc/subjects') {
      if (subjectsStatus != 200) return http.Response(jsonEncode({'error': 'Not found'}), subjectsStatus);
      return http.Response(jsonEncode(_json('mc_subjects.json')), 200);
    }
    if (path.startsWith('/api/mc/subjects/')) return http.Response(jsonEncode(_json('mc_subject.json')), 200);
    if (req.method == 'POST') return http.Response(jsonEncode({'ok': true}), 200);
    return http.Response(jsonEncode({'error': 'Not found'}), 404);
  }

  McFeed feed() => McFeed(
        servers: () => const [_a, _b],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async => _answer(sv, req))),
      );

  List<http.Request> get prompts => [for (final r in requests) if (r.url.path.endsWith('/prompt')) r];
}

void main() {
  group('wire', () {
    test('subjects: the server order, runs, buckets when sent, junk dropped, the contract stage order', () {
      final d = McSubjects.fromJson(_json('mc_subjects.json'));
      expect(d.subjects.map((s) => s.key), ['acme/widgets#41', 'acme/widgets#42', 'acme/widgets#43']);
      expect(d.runs.map((r) => r.id), ['run-1']);
      expect(d.runs.single.children.map((c) => c.status), ['idle', 'working']);
      expect(d.servers.map((s) => '${s.name}:${s.ok}'), ['alpha:true', 'beta:false']);
      expect(d.stageOrder, kMcStageOrder);
      final s41 = d.subjects.first;
      expect(s41.buckets, ['active', 'needsYou']);
      expect(s41.meta?.severityLabel, 'severity:1');
      expect(s41.needsYou?.id, 'alpha|s-1|you:pick');
      expect(s41.machines, ['alpha', 'beta']);
      expect(d.subjects[1].buckets, isNull);
    });

    test('a filter is the server buckets when sent, else read from the subject fields', () {
      final d = McSubjects.fromJson(_json('mc_subjects.json'));
      final [s41, s42, s43] = d.subjects;
      // Buckets win, even where the fields would say otherwise.
      expect(s41.inFilter(McSubjectFilter.needsYou), isTrue);
      expect(s41.inFilter(McSubjectFilter.waitsOnOthers), isFalse);
      expect(const McSubject(key: 'k', waitsOn: 'you', buckets: ['active']).inFilter(McSubjectFilter.needsYou), isFalse);
      // No buckets: an external wait waits on others; a done wait is done, not active.
      expect(s42.inFilter(McSubjectFilter.waitsOnOthers), isTrue);
      expect(s42.inFilter(McSubjectFilter.active), isTrue);
      expect(s43.inFilter(McSubjectFilter.doneWeek), isTrue);
      expect(s43.inFilter(McSubjectFilter.active), isFalse);
    });

    test('a subject detail; a server stage order wins; junk reads as empty', () {
      final d = McSubjectDetail.fromJson(_json('mc_subject.json'));
      expect(d.subject?.sessions.map((s) => s.parentId), [null, 's-1', 's-1', 's-1', 's-99']);
      expect(d.subject?.stage.stepsFor('pr-open').single.detail, 'PR #77 opened');
      expect(d.subject?.meta?.prs.single.label, 'PR #77 open');
      expect(McSubjectDetail.fromJson({'stages': ['a', 'b']}).stageOrder, ['a', 'b']);
      final junk = McSubjectDetail.fromJson({'subject': 'nope', 'runs': 3});
      expect(junk.subject, isNull);
      expect(junk.runs, isEmpty);
      expect(McSubject.fromJson({'key': 'k', 'meta': 'x', 'stage': 1, 'sessions': {}})?.meta, isNull);
    });

    test('the client asks the contract routes: project and area as query, the key encoded', () async {
      final seen = <Uri>[];
      final c = ApiClient(_a, httpClient: MockClient((req) async {
        seen.add(req.url);
        return http.Response(jsonEncode({'subjects': [], 'subject': {'key': 'acme/widgets#41'}}), 200);
      }));
      await c.mcSubjects(project: 'web-terminal', area: 'companion');
      await c.mcSubjects(project: 'web-terminal');
      await c.mcSubject('acme/widgets#41');
      expect(seen[0].path, '/api/mc/subjects');
      expect(seen[0].queryParameters, {'project': 'web-terminal', 'area': 'companion'});
      expect(seen[1].queryParameters, {'project': 'web-terminal'});
      expect(seen[2].toString(), 'http://alpha.test:7681/api/mc/subjects/acme%2Fwidgets%2341');
    });

    test('the gated prompt: told, refused with its reason, a text refused, a missing route', () async {
      Future<McPromptResult> answer(int status, String body) =>
          ApiClient(_a, httpClient: MockClient((req) async {
            expect(req.url.path, '/api/sessions/s-1/prompt');
            expect(jsonDecode(req.body), {'text': 'hello'});
            return http.Response(body, status);
          })).promptSession('s-1', 'hello');
      expect((await answer(200, '{"delivered":true}')).text, 'told');
      final draft = await answer(409, '{"delivered":false,"refused":"draft"}');
      expect(draft.refused, 'draft');
      expect(draft.text, 'not told: someone has unsent text in its prompt box');
      expect((await answer(409, '{"delivered":false,"refused":"brand-new"}')).text, 'not told: brand-new');
      expect((await answer(400, '{"error":"text must be one line"}')).text, 'not told: text must be one line');
      expect((await answer(404, '<html>Cannot POST</html>')).text, 'not told: session not found');
    });

    test('the pause line is one line well under the gated prompt cap', () {
      final t = mcPauseText('x' * 500);
      expect(t.contains('\n'), isFalse);
      expect(utf8.encode(t).length, lessThan(400));
    });
  });

  group('tell', () {
    test('each session goes to its own server by url; a server not in the list says so', () async {
      final cluster = _Cluster();
      final feed = cluster.feed();
      addTearDown(feed.dispose);
      final out = await feed.tell(const [
        McSubjectSession(id: 's-1', server: 'alpha', serverUrl: 'http://alpha.test:7681'),
        McSubjectSession(id: 's-3', server: 'beta', serverUrl: 'http://BETA.test:7681/'),
        McSubjectSession(id: 's-6', server: 'gamma', serverUrl: 'http://gamma.test:7681'),
      ], 'pause');
      expect(cluster.prompts.map((r) => r.url.host), ['alpha.test', 'beta.test'],
          reason: 'the url decides the server (case and trailing slash aside); gamma is not asked');
      expect(out.map((r) => r.$2.text), [
        'told',
        'not told: another prompt is being typed into it right now',
        "not told: its server (gamma) is not in this app's list",
      ]);
    });
  });

  group('Project screen', () {
    late _Cluster cluster;
    late McFeed feed;
    late List<String> openedSubjects;

    Future<void> pump(WidgetTester tester) async {
      await _size(tester, const Size(1200, 2400));
      openedSubjects = [];
      await feed.refresh();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McProjectScreen(
          feed: feed,
          projectId: 'web-terminal',
          now: _now,
          onOpenSubject: (s, _) => openedSubjects.add(s.key),
        ),
      ));
      await tester.pump();
      await tester.pump();
    }

    setUp(() {
      cluster = _Cluster();
      feed = cluster.feed();
    });
    tearDown(() => feed.dispose());

    testWidgets("the header and the tabs carry Now's own counts", (tester) async {
      await pump(tester);
      final p = feed.now!.projects.firstWhere((p) => p.id == 'web-terminal');
      expect(find.byKey(const ValueKey('mc-project-name')), findsOneWidget);
      expect(find.text('acme/widgets'), findsOneWidget, reason: 'the tracker');
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-project-header-counts'))).data, mcCountsLine(p.counts));
      expect(mcCountsLine(p.counts), '1 need you · 1 waiting on others · 5 active · 2 done this week · 6 sessions');
      // Area tabs: All, Companion (with 1 needing you, in orange), Server.
      expect(find.descendant(of: find.byKey(const ValueKey('mc-area-tab-all')), matching: find.text('All 5')), findsOneWidget);
      final comp = find.byKey(const ValueKey('mc-area-tab-companion'));
      expect(find.descendant(of: comp, matching: find.text('Companion 3')), findsOneWidget);
      final badge = find.descendant(of: comp, matching: find.byKey(const ValueKey('mc-area-needs-you')));
      expect(tester.widget<Text>(badge).data, '1');
      expect(tester.widget<Text>(badge).style?.color, AppColors.caution);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-area-tab-server')), matching: find.byKey(const ValueKey('mc-area-needs-you'))),
          findsNothing);
      // Filters carry the server's counts, never a count of the rows.
      expect(find.text('Everything active 5'), findsOneWidget);
      expect(find.text('Needs you 1'), findsOneWidget);
      expect(find.text('Waits on others 1'), findsOneWidget);
      expect(find.text('Done this week 2'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('runs grouped with their header; rows say ref, title, kind, severity, step, machines, age', (tester) async {
      await pump(tester);
      final run = find.byKey(const ValueKey('mc-run-run-1'));
      expect(run, findsOneWidget);
      expect(find.descendant(of: run, matching: find.text('Bug hunt: login')), findsOneWidget);
      expect(tester.widget<Text>(find.descendant(of: run, matching: find.byKey(const ValueKey('mc-run-line')))).data,
          'started 2h ago · on alpha · orchestrator working · 2 subjects');
      expect(find.descendant(of: run, matching: find.text('Fix #41 · working')), findsOneWidget, reason: 'its children');
      final r41 = find.byKey(const ValueKey('mc-subject-row-acme/widgets#41'));
      final r42 = find.byKey(const ValueKey('mc-subject-row-acme/widgets#42'));
      expect(tester.getTopLeft(run).dy, lessThan(tester.getTopLeft(r41).dy));
      expect(tester.getTopLeft(r41).dy, lessThan(tester.getTopLeft(r42).dy));
      Finder in41(Finder f) => find.descendant(of: r41, matching: f);
      expect(in41(find.text('#41')), findsOneWidget);
      expect(in41(find.text('Login loops after a token refresh')), findsOneWidget);
      expect(in41(find.text('Bug · Companion · by reporter-a')), findsOneWidget);
      expect(in41(find.text('severity:1')), findsOneWidget);
      expect(in41(find.text('Fixing · waits on you: Which fix should ship?')), findsOneWidget);
      expect(in41(find.text('alpha')), findsOneWidget);
      expect(in41(find.text('beta')), findsOneWidget);
      expect(in41(find.text('2 d')), findsOneWidget, reason: 'opened two days before the clock');
      // The 8-step track, filled up to Fixing (the 4th).
      expect(in41(find.byKey(const ValueKey('mc-track-fixing-on'))), findsOneWidget);
      expect(in41(find.byKey(const ValueKey('mc-track-pr-open-off'))), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-subject-row-acme/widgets#42')),
          matching: find.text('Reproduced · waits on others: CI on the fix branch')), findsOneWidget);
      // The done subject is not "active"; a server that did not answer is named.
      expect(find.byKey(const ValueKey('mc-subject-row-acme/widgets#43')), findsNothing);
      expect(find.byKey(const ValueKey('mc-project-servers-down')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a filter shows its subjects; an area tab asks for that area; a row opens its subject', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('mc-filter-doneWeek')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-subject-row-acme/widgets#43')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-subject-row-acme/widgets#41')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-filter-needsYou')));
      await tester.pump();
      expect(find.byKey(const ValueKey('mc-subject-row-acme/widgets#41')), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-subject-row-acme/widgets#42')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-subject-acme/widgets#41')));
      expect(openedSubjects, ['acme/widgets#41']);
      await tester.tap(find.byKey(const ValueKey('mc-area-tab-companion')));
      await tester.pump();
      await tester.pump();
      final last = cluster.requests.lastWhere((r) => r.url.path == '/api/mc/subjects');
      expect(last.url.queryParameters, {'project': 'web-terminal', 'area': 'companion'});
      expect(find.text('Needs you 1'), findsOneWidget, reason: "the area's own count now");
      expect(find.text('Everything active 3'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a server without the subjects route says so', (tester) async {
      cluster.subjectsStatus = 404;
      await pump(tester);
      expect(find.byKey(const ValueKey('mc-project-unsupported')), findsOneWidget);
      expect(find.textContaining('no subject list yet'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Subject screen', () {
    late _Cluster cluster;
    late McFeed feed;
    late List<String> answered;
    late List<String> opened;
    late List<Uri> urls;

    Future<void> pump(WidgetTester tester) async {
      await _size(tester, const Size(1200, 3200));
      answered = [];
      opened = [];
      urls = [];
      await feed.refresh();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: McSubjectScreen(
          feed: feed,
          subjectKey: 'acme/widgets#41',
          now: _now,
          onAnswer: (c) => answered.add(c.id),
          onOpenSession: opened.add,
          openUrl: urls.add,
        ),
      ));
      await tester.pump();
      await tester.pump();
    }

    setUp(() {
      cluster = _Cluster();
      feed = cluster.feed();
    });
    tearDown(() => feed.dispose());

    testWidgets('a repro child, a fix child and a closed child all sit under their parent', (tester) async {
      await pump(tester);
      final parent = find.byKey(const ValueKey('mc-node-s-1'));
      expect(parent, findsOneWidget);
      for (final child in ['s-2', 's-3', 's-4']) {
        expect(find.descendant(of: parent, matching: find.byKey(ValueKey('mc-node-$child'))), findsOneWidget,
            reason: '$child is under its parent');
        expect(tester.getTopLeft(find.byKey(ValueKey('mc-session-$child'))).dx,
            greaterThan(tester.getTopLeft(find.byKey(const ValueKey('mc-session-s-1'))).dx),
            reason: '$child is indented');
      }
      expect(find.descendant(of: parent, matching: find.byKey(const ValueKey('mc-node-s-6'))), findsNothing,
          reason: 'a parent not on the subject: a root of its own');
      expect(find.byKey(const ValueKey('mc-node-s-6')), findsOneWidget);
      // Each row: machine, state, last report line, Open (not on the closed one).
      final s1 = find.byKey(const ValueKey('mc-session-s-1'));
      expect(find.descendant(of: s1, matching: find.text('alpha')), findsOneWidget);
      expect(find.descendant(of: s1, matching: find.text('working')), findsOneWidget);
      expect(find.descendant(of: s1, matching: find.text('in-progress · PR open · PR up, waiting on the choice · 26m ago')),
          findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-session-s-4')), matching: find.text('closed 3h ago')),
          findsOneWidget);
      expect(find.byKey(const ValueKey('mc-session-open-s-4')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mc-session-open-s-2')));
      expect(opened, ['s-2']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the progress track: each step reached, with its time and evidence', (tester) async {
      await pump(tester);
      Finder step(String s) => find.byKey(ValueKey('mc-step-$s'));
      expect(find.descendant(of: step('reproduced'), matching: find.text('4h ago · from report · fails on a 401 then refresh')),
          findsOneWidget);
      expect(find.descendant(of: step('pr-open'), matching: find.text('1h ago · from pr · PR #77 opened')), findsOneWidget);
      expect(find.descendant(of: step('pr-open'), matching: find.byIcon(Icons.radio_button_checked)), findsOneWidget,
          reason: 'the current step');
      expect(find.descendant(of: step('fixing'), matching: find.byIcon(Icons.check_circle)), findsOneWidget);
      expect(find.descendant(of: step('merged'), matching: find.byIcon(Icons.radio_button_unchecked)), findsOneWidget);
      expect(find.text('reported Fixing · evidence PR open'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the open question is the same card as Now; the work item from the tracker', (tester) async {
      await pump(tester);
      final card = find.byKey(const ValueKey('mc-card-alpha|s-1|you:pick'));
      expect(tester.widget(card), isA<McAnswerCard>());
      await tester.tap(find.descendant(of: card, matching: find.byKey(const ValueKey('mc-card-answer'))));
      expect(answered, ['alpha|s-1|you:pick']);
      final wi = find.byKey(const ValueKey('mc-work-item'));
      for (final t in ['Type: Bug', 'State: open', 'Severity: severity:1', 'Opened by: reporter-a, 2d ago', 'Area: Companion', 'Assigned to: dev-a']) {
        expect(find.descendant(of: wi, matching: find.text(t)), findsOneWidget, reason: t);
      }
      expect(find.descendant(of: wi, matching: find.text('Login loops after a token refresh')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mc-pr-77')));
      await tester.tap(find.byKey(const ValueKey('mc-subject-open-tracker')));
      expect(urls.map((u) => u.toString()), [
        'https://example.test/acme/widgets/pull/77',
        'https://example.test/acme/widgets/issues/41',
      ]);
      final ask = tester.widget<TextField>(find.byKey(const ValueKey('mc-subject-ask')));
      expect(ask.enabled, isFalse, reason: 'wired by #511');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Pause asks first, then tells every live session on its own server and shows each answer', (tester) async {
      await pump(tester);
      final pause = find.byKey(const ValueKey('mc-subject-pause'));
      expect(find.descendant(of: pause, matching: find.text('Pause this subject (4)')), findsOneWidget,
          reason: 'the closed session is not told');
      await tester.tap(pause);
      await tester.pumpAndSettle();
      expect(find.text('Pause this subject?'), findsOneWidget);
      expect(cluster.prompts, isEmpty, reason: 'nothing is sent before the confirm');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(cluster.prompts, isEmpty);
      await tester.tap(pause);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-pause-confirm')));
      await tester.pumpAndSettle();
      expect(cluster.prompts.map((r) => '${r.url.host} ${r.url.path}'), [
        'alpha.test /api/sessions/s-1/prompt',
        'alpha.test /api/sessions/s-2/prompt',
        'beta.test /api/sessions/s-3/prompt',
      ]);
      final sent = jsonDecode(cluster.prompts.first.body) as Map<String, dynamic>;
      expect(sent, {'text': mcPauseText('#41')});
      expect(find.text('Told 1 of 4'), findsOneWidget);
      expect(find.text('Orchestrator: told'), findsOneWidget);
      expect(find.text('Repro #41: not told: someone has unsent text in its prompt box'), findsOneWidget);
      expect(find.text('Fix #41: not told: another prompt is being typed into it right now'), findsOneWidget);
      expect(find.text("Docs check: not told: its server (gamma) is not in this app's list"), findsOneWidget);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Mission Control home', () {
    testWidgets('a project tapped on Now opens its page in the Projects tab; a row opens the subject', (tester) async {
      await _size(tester, const Size(1400, 2400));
      final cluster = _Cluster();
      final feed = cluster.feed();
      addTearDown(feed.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: MissionControlHome(
          feed: feed,
          onShowSessionsHome: () {},
          sessionsBoardBuilder: (open) => const Scaffold(body: Text('the sessions board')),
        ),
      ));
      await feed.refresh();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mc-project-web-terminal')));
      await tester.pumpAndSettle();
      expect(find.byType(McProjectScreen), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-rail')), findsOneWidget, reason: 'the side nav stays');
      await tester.tap(find.byKey(const ValueKey('mc-subject-acme/widgets#41')));
      await tester.pumpAndSettle();
      expect(find.byType(McSubjectScreen), findsOneWidget);
      expect(find.byKey(const ValueKey('mc-node-s-1')), findsOneWidget);
      // Back: the project, then the list.
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(McSubjectScreen), findsNothing);
      expect(find.byType(McProjectScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
