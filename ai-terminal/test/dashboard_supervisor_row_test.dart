// #475 - the session list never lists the Supervisor's dispatcher (`role: "supervisor"`): it is
// the fleet's supervisor, not one of its sessions, and the Supervisor entry opens it. The rows
// come through `listedSessions`; dropping that call would show it as an ordinary session row.
// One test per file: SessionRepository/ServerStore are singletons whose init futures bind to
// the first test's FakeAsync zone (see dashboard_favorites_handle_test).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/supervisor_models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/supervisor_lookup.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/util/supervisor_authority.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');

Session _s(String id, String name, {String status = 'idle', String? role}) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: status,
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: _server,
      autoCommand: '',
      role: role,
    );

void main() {
  testWidgets('#475 the dispatcher row is not a row of the session list', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('a', 'Dictation work', status: 'working'),
        _s('sup', 'web-terminal supervisor', status: 'working', role: 'supervisor'),
        _s('b', 'Idle one'),
      ]),
    });
    await ServerStore.instance.init();
    SupervisorFeed.instance.resetForTest();
    // The Supervisor entry exists for the dispatcher: the authority answered with its id.
    SupervisorFeed.instance.publish(SupervisorFind(SupervisorFindKind.found,
        server: _server,
        state: SupervisorState.fromJson({
          'role': 'authority',
          'enabled': true,
          'dispatcher': {'enabled': true, 'id': 'sup', 'status': 'working', 'state': 'working'},
        }, receivedAt: DateTime.now())));
    addTearDown(SupervisorFeed.instance.resetForTest);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    expect(find.text('Dictation work'), findsOneWidget, reason: 'the list shows the ordinary rows');
    expect(find.text('Idle one'), findsOneWidget);
    expect(find.textContaining('web-terminal supervisor'), findsNothing, reason: 'the Supervisor entry stands for it, so it is not a row');
  });
}
