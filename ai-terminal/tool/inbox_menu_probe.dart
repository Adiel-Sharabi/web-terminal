// INBOX MENU PROBE - a real-platform harness for the questions inbox's card menu (#445).
//
// Why this exists: CLAUDE.md - a widget test cannot prove input. `tester.tap(buttons:
// kSecondaryButton)` injects a pointer event straight into Flutter's gesture arena; it
// never passes through the Windows embedder, which is what turns a WM_RBUTTONDOWN into
// a secondary-button pointer, nor through a real field that owns its own right-click.
//
// This hosts the REAL QuestionsInboxScreen (the shipped widgets, repository and API
// client) against a fake cluster served in-process - it never contacts a server and
// never touches the installed companion's preferences - and logs, one line each:
//
//   RUN pid=<pid>                      - first line of THIS run (the log starts empty)
//   READY dpr=<d>                      - first frame drawn
//   DPR <d>                            - the pixel ratio, again whenever it changes
//   PTR <phase> <x>,<y> buttons=<b>    - every pointer event that reached the app
//   PUSH <route type> / POP            - a route opened or closed (the card's menu is one)
//   POS {"key": [x, y, w, h], ...}     - where the cards, menu items and fields are now
//   HTTP <method> <path> <body>        - every write the screen made
//   INPUT <session> <keys>             - anything typed into a session (must stay empty)
//
// The PTR lines are not decoration: without them "no menu" is ambiguous between "the
// app refused" and "the driver never delivered the click".
//
// Build:  scripts/build-probe-windows.sh tool/inbox_menu_probe.dart
// Drive:  scripts/rig/probe-drive-inbox-menu.ps1
// Log:    inbox-menu-probe.log next to the exe. It exits when inbox-menu-probe.quit
//         appears there, or after five minutes.

// A probe is a test harness that happens to run on the real platform: it builds the
// repository and preferences the way the widget tests do.
// ignore_for_file: invalid_use_of_visible_for_testing_member

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';

const ServerConfig kProbeServer = ServerConfig(
  name: 'Probe',
  baseUrl: 'http://probe.invalid:7681',
  bearerToken: 'probe',
);

final String _dir = File(Platform.resolvedExecutable).parent.path;
final File _logFile = File('$_dir${Platform.pathSeparator}inbox-menu-probe.log');

/// One line, written synchronously: an IOSink drops a line written while an earlier
/// flush is still pending, and a lost POS or HTTP line reads as a wrong verdict.
void log(String line) =>
    _logFile.writeAsStringSync('$line\n', mode: FileMode.append, flush: true);

/// What the fake server keeps for each session's `brief.inboxDismissed`.
final Map<String, List<String>> _kept = {};

Map<String, dynamic> _row(
  String id,
  String name, {
  String status = 'idle',
  String? waitingFor,
  Object? reason,
}) => {
  'id': id,
  'name': name,
  'cwd': '/probe',
  'status': status,
  'notifyLevel': 'important',
  'agent': 'claude',
  'waitingFor': waitingFor,
  'reason': reason,
  'lastActivity': 5,
  'brief': {
    'v': 1,
    'reporting': 'on',
    'items': [],
    'inboxDismissed': _kept[id] ?? const <String>[],
  },
};

List<Map<String, dynamic>> _rows() => [
  _row('c', 'prose-ask'),
  _row(
    'd',
    'reported-wait',
    reason: {
      'kind': 'you',
      'text': 'power-cycle the rig',
      'source': 'reported',
      'since': 1,
    },
  ),
  _row('q', 'blocking-question', status: 'waiting', waitingFor: 'question'),
];

List<Map<String, dynamic>> _reply(String text) => [
  {
    'role': 'user',
    'text': 'go on',
    'typedText': 'go on',
    'userKind': 'human',
    'toolUses': [],
  },
  {
    'role': 'assistant',
    'text': text,
    'toolUses': [],
    'ts': 'probe-$text'.length.toString(),
  },
];

http.Response _json(Object body) => http.Response.bytes(
  utf8.encode(jsonEncode(body)),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

ApiClient _client(ServerConfig s) => ApiClient(
  s,
  httpClient: MockClient((req) async {
    final p = req.url.path;
    final id = RegExp(r'^/api/sessions/([^/]+)/').firstMatch(p)?.group(1);
    if (req.method != 'GET') log('HTTP ${req.method} $p ${req.body}');
    if (p.endsWith('/brief') && req.method == 'PATCH') {
      final op = (jsonDecode(req.body) as Map)['inboxDismiss'];
      if (op is Map && id != null) {
        final sig = (op['add'] ?? op['remove']) as String;
        _kept[id] = [
          if (op['add'] != null) sig,
          ...(_kept[id] ?? const <String>[]).where((x) => x != sig),
        ];
      }
      return _json({'ok': true});
    }
    if (p.endsWith('/pending-question')) {
      return _json(
        id == 'q'
            ? {
                'pending': true,
                'question': {
                  'toolUseId': 'probe-q',
                  'questions': [
                    {
                      'header': 'Deploy',
                      'question': 'Deploy to production now?',
                      'multiSelect': false,
                      'options': [
                        {'label': 'Yes'},
                        {'label': 'No'},
                      ],
                    },
                  ],
                },
              }
            : {'pending': false},
      );
    }
    if (p.endsWith('/transcript')) {
      final t = switch (id) {
        'c' => _reply('Done.\n\nShould I push it?'),
        'd' => _reply('The rig needs a power-cycle. Tell me when it is back.'),
        _ => null,
      };
      return t == null
          ? http.Response('', 404)
          : _json({'messages': t, 'cursor': null, 'hasMore': false});
    }
    if (p.endsWith('/attention')) {
      return _json({'kind': 'question', 'reason': '', 'lastMessage': ''});
    }
    if (p.endsWith('/scrollback')) {
      return _json({'data': '', 'total': 0, 'offset': 0, 'limit': 0});
    }
    switch (p) {
      case '/api/version':
        return _json({
          'version': 'probe',
          'serverName': 'Probe',
          'capabilities': [
            'session-brief',
            'session-clear-wait',
            'inbox-dismiss',
          ],
        });
      case '/api/sessions':
        return _json(_rows());
      case '/api/dashboard/background-agents':
        return _json({'available': true, 'agents': []});
    }
    return http.Response('', 404);
  }),
);

class _RouteLog extends NavigatorObserver {
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    log('PUSH ${route.runtimeType}');
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    log('POP ${route.runtimeType}');
    // What the route returned: a menu item's value, or null for a click outside it.
    route.popped.then((v) => log('POPPED ${route.runtimeType} -> $v'));
  }
}

/// The rectangles of everything the driver aims at, in logical pixels of the view.
Map<String, List<double>> _positions() {
  final out = <String, List<double>>{};
  void visit(Element e) {
    final k = e.widget.key;
    if (k is ValueKey<String> &&
        (k.value.startsWith('inbox-card-') ||
            k.value.startsWith('inbox-menu-') ||
            k.value.startsWith('inbox-reply-') ||
            k.value == 'inbox-dismissed-toggle' ||
            k.value == 'inbox-undo')) {
      final ro = e.renderObject;
      if (ro is RenderBox && ro.attached && ro.hasSize) {
        final o = ro.localToGlobal(Offset.zero);
        out[k.value] = [
          o.dx,
          o.dy,
          ro.size.width,
          ro.size.height,
        ].map((v) => v.roundToDouble()).toList();
      }
    }
    e.visitChildren(visit);
  }

  WidgetsBinding.instance.rootElement?.visitChildren(visit);
  return out;
}

Future<void> main() async {
  // A fresh log and no stale quit file: a run must never read a previous run's lines.
  // The RUN line names this process, so a driver reads only what follows it.
  _logFile.writeAsStringSync('', flush: true);
  final quit = File('$_dir${Platform.pathSeparator}inbox-menu-probe.quit');
  if (quit.existsSync()) quit.deleteSync();
  log('RUN pid=$pid');
  WidgetsFlutterBinding.ensureInitialized();
  // In-memory preferences: the probe must never read or write the installed companion's.
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: jsonEncode([
      {
        'name': kProbeServer.name,
        'baseUrl': kProbeServer.baseUrl,
        'bearerToken': kProbeServer.bearerToken,
      },
    ]),
  });
  final store = ServerStore.forTest();
  await store.init();
  final repo = SessionRepository.forTest(store: store, clientFactory: _client);

  runApp(
    MaterialApp(
      theme: AppTheme.dark,
      navigatorObservers: [_RouteLog()],
      // Above the Navigator, so a click on a popup route (the card's menu) is logged too.
      builder: (context, child) => Listener(
        onPointerDown: (e) => log(
          'PTR down ${e.position.dx.round()},${e.position.dy.round()} buttons=${e.buttons}',
        ),
        onPointerUp: (e) =>
            log('PTR up ${e.position.dx.round()},${e.position.dy.round()}'),
        child: child,
      ),
      home: QuestionsInboxScreen(
        repository: repo,
        servers: () => const [kProbeServer],
        clientFactory: _client,
        sessionInput: (s, body) async {
          await body((keys) => log('INPUT ${s.id} ${jsonEncode(keys)}'));
          return true;
        },
        onOpenSession: (s) => log('OPEN ${s.id}'),
      ),
    ),
  );

  WidgetsBinding.instance.addPostFrameCallback((_) {
    final view = WidgetsBinding.instance.platformDispatcher.views.first;
    log('READY dpr=${view.devicePixelRatio}');
  });
  var last = '';
  double? lastDpr;
  final started = DateTime.now();
  Timer.periodic(const Duration(milliseconds: 250), (t) {
    // The ratio can change when the window moves to another monitor: say so every time,
    // so a driver that converts these logical positions can check it still holds.
    final dpr = WidgetsBinding.instance.platformDispatcher.views.first.devicePixelRatio;
    if (dpr != lastDpr) {
      lastDpr = dpr;
      log('DPR $dpr');
    }
    final now = jsonEncode(_positions());
    if (now != last) {
      last = now;
      log('POS $now');
    }
    if (quit.existsSync() ||
        DateTime.now().difference(started) > const Duration(minutes: 5)) {
      t.cancel();
      log('EXIT');
      exit(0);
    }
  });
}
