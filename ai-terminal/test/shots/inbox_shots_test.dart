// #492 - renders the real Questions inbox against a FAKE cluster (made-up sessions, no
// server contacted) at desktop and phone sizes, with real fonts, and writes PNGs for the
// PR. Skipped unless env WT_SHOTS_DIR names the folder the PNGs go to:
// `WT_SHOTS_DIR=<dir> flutter test test/shots/inbox_shots_test.dart`. Fake data only.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/services/inbox_seen_store.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 'tok');

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status,
    headers: {'content-type': 'application/json; charset=utf-8'});

final _now = DateTime.now().millisecondsSinceEpoch;

Map<String, dynamic> _row(String id, String name, String cwd,
        {String status = 'idle',
        String? waitingFor,
        int ago = 60,
        List<Map<String, dynamic>> items = const [],
        Map<String, dynamic>? reason,
        String? now}) =>
    {
      'id': id,
      'name': name,
      'cwd': cwd,
      'status': status,
      'notifyLevel': 'important',
      'agent': 'claude',
      'waitingFor': waitingFor,
      'lastActivity': _now - ago * 1000,
      'reason': reason,
      'brief': {
        'v': 1,
        'reporting': 'on',
        'items': items,
        if (now != null) 'now': {'text': now, 'at': _now},
      },
    };

Map<String, dynamic> _it(String ref, String key, String title, String state) =>
    {'ref': ref, 'key': key, 'title': title, 'state': state};

class _Seen implements InboxSeenStore {
  Map<String, String>? stored = {};
  @override
  Future<Map<String, String>?> load() async => stored;
  @override
  Future<void> save(Map<String, String> seen) async {}
}

Future<void> _fonts() async {
  final cache = File(Platform.resolvedExecutable).parent.parent.parent.parent;
  final dir = '${cache.path}/artifacts/material_fonts';
  final roboto = FontLoader('Roboto');
  for (final f in ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Bold.ttf']) {
    roboto.addFont(Future.value(ByteData.sublistView(File('$dir/$f').readAsBytesSync())));
  }
  await roboto.load();
  // A style with no family falls to the test engine's default font (boxes), and the
  // ref chips ask for 'monospace': give both real faces so the picture reads.
  for (final fam in ['FlutterTest', 'Ahem']) {
    final l = FontLoader(fam);
    l.addFont(Future.value(ByteData.sublistView(File('$dir/Roboto-Medium.ttf').readAsBytesSync())));
    await l.load();
  }
  final consolas = File('C:/Windows/Fonts/consola.ttf');
  if (consolas.existsSync()) {
    final mono = FontLoader('monospace');
    mono.addFont(Future.value(ByteData.sublistView(consolas.readAsBytesSync())));
    await mono.load();
  }
  final icons = FontLoader('MaterialIcons');
  icons.addFont(Future.value(ByteData.sublistView(File('$dir/MaterialIcons-Regular.otf').readAsBytesSync())));
  await icons.load();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_fonts);
  final out = Platform.environment['WT_SHOTS_DIR'];

  final home = [
    _row('a1', 'Retry the upload queue', r'C:\dev\photo-sync', status: 'waiting', waitingFor: 'question', ago: 540, items: [
      _it('#41', 'acme/photo-sync#41', 'Uploads stall on a flaky network', 'in-progress'),
    ]),
    _row('a2', 'Thumbnail cache', r'C:\dev\photo-sync',
        ago: 300,
        reason: {'kind': 'you', 'text': 'pick the cache size before I tune eviction', 'since': _now - 300000, 'source': 'reported'},
        items: [_it('#44', 'acme/photo-sync#44', 'Thumbnails rebuilt on every launch', 'in-progress')]),
    _row('b1', 'Release notes 2.4', r'C:\dev\garden-app', status: 'waiting', waitingFor: 'question', ago: 120, items: [
      _it('#9', 'acme/garden-app#9', 'Write the 2.4 release notes', 'in-progress'),
    ]),
  ];
  final office = [
    _row('c1', 'Night build', r'C:\dev\garden-app', status: 'working', now: 'Running the integration tests', items: [
      _it('#12', 'acme/garden-app#12', 'Watering schedule sync', 'ready-for-test'),
      _it('#7', 'acme/garden-app#7', 'Login on old Android', 'blocked'),
    ]),
    _row('c2', 'Map tiles', r'C:\dev\photo-sync', status: 'working', now: 'Rebasing on master', items: [
      _it('#38', 'acme/photo-sync#38', 'Offline map tiles', 'ready-for-test'),
    ]),
  ];
  final questions = {
    'a1': {
      'toolUseId': 't-a1',
      'questions': [
        {
          'header': 'Retries',
          'question': 'How should the upload queue retry after a network drop?',
          'multiSelect': false,
          'options': [
            {'label': 'Back off exponentially, up to 5 minutes (Recommended)', 'description': 'Gentle on the server; a long outage still recovers.'},
            {'label': 'Retry every 30 seconds', 'description': 'Simple, but hammers the server during an outage.'},
            {'label': 'Wait for the person to press Retry', 'description': 'Nothing automatic.'},
          ],
        },
      ],
    },
    'b1': {
      'toolUseId': 't-b1',
      'questions': [
        {
          'header': 'Tone',
          'question': 'Which tone for the release notes?',
          'multiSelect': false,
          'options': [
            {'label': 'Short and plain (Recommended)'},
            {'label': 'Friendly, with emoji'},
          ],
        },
        {
          'header': 'Order',
          'question': 'Lead with fixes or features?',
          'multiSelect': false,
          'options': [
            {'label': 'Features first (Recommended)'},
            {'label': 'Fixes first'},
          ],
        },
      ],
    },
  };
  final supervisor = {
    'role': 'authority',
    'enabled': true,
    'now': _now,
    'cards': [
      {
        'id': 'k1',
        'cls': 'wake',
        'sessionId': 'c2',
        'server': 'Office',
        'name': 'Map tiles',
        'text': 'Wake: the CI run for PR 58 went green',
        'why': 'wake is in recommend mode',
        'at': _now - 200000,
      },
    ],
    'cases': [],
  };

  ApiClient client(ServerConfig s) => ApiClient(s, httpClient: MockClient((req) async {
        final p = req.url.path;
        final id = RegExp(r'^/api/sessions/([^/]+)/').firstMatch(p)?.group(1);
        if (p.endsWith('/pending-question')) {
          final q = questions[id];
          return _json(q == null ? {'pending': false} : {'pending': true, 'question': q});
        }
        switch (p) {
          case '/api/version':
            return _json({'version': '1.114.0', 'serverName': s.name, 'capabilities': ['session-brief']});
          case '/api/sessions':
            return _json(s.baseUrl == _home.baseUrl ? home : office);
          case '/api/supervisor/state':
            return _json(s.baseUrl == _office.baseUrl
                ? supervisor
                : {
                    'role': 'peer',
                    'authority': {'name': 'Office'},
                  });
          case '/api/dashboard/background-agents':
            return _json({'available': true, 'agents': []});
        }
        return http.Response('', 404);
      }));

  Future<void> shot(WidgetTester tester, String name, Size size, double dpr) async {
    QuestionDraftStore.instance.resetForTest();
    SessionSelection.instance.reset();
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in [_home, _office]) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
    });
    final store = ServerStore.forTest();
    await store.init();
    final repo = SessionRepository.forTest(store: store, clientFactory: client);
    tester.view.physicalSize = size * dpr;
    tester.view.devicePixelRatio = dpr;
    addTearDown(tester.view.reset);
    final boundary = GlobalKey();
    await tester.pumpWidget(RepaintBoundary(
      key: boundary,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark,
        home: QuestionsInboxScreen(
          repository: repo,
          servers: () => [_home, _office],
          clientFactory: client,
          sessionInput: (s, body) async => true,
          seenStore: _Seen(),
          pollInterval: const Duration(hours: 1),
          focusInterval: const Duration(hours: 1),
          agentsInterval: const Duration(hours: 1),
          onOpenSession: (_) {},
        ),
      ),
    ));
    await tester.runAsync(() => repo.refresh());
    for (var i = 0; i < 8; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
      await tester.pump();
    }
    final ro = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final bytes = await tester.runAsync(() async {
      final img = await ro.toImage(pixelRatio: dpr);
      final data = await img.toByteData(format: ui.ImageByteFormat.png);
      return data!.buffer.asUint8List();
    });
    File('$out/$name.png').writeAsBytesSync(bytes!);
    await tester.pumpWidget(const SizedBox());
  }

  final skip = out == null ? 'screenshots only: set WT_SHOTS_DIR' : null;
  testWidgets('desktop', (t) => shot(t, 'inbox-desktop', const Size(1400, 900), 1), skip: skip != null);
  testWidgets('phone', (t) => shot(t, 'inbox-phone', const Size(412, 915), 2.625), skip: skip != null);
}
