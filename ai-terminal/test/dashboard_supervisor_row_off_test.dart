// #475 - the other half of the dashboard's rule: with the supervisor off (no Supervisor entry), the
// dispatcher's row is an ordinary session in the list, so the owner can always reach and close it.
// One test per file: SessionRepository/ServerStore are singletons (see dashboard_favorites_handle_test).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
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
  testWidgets('#475 with no Supervisor entry (the supervisor is off) the dispatcher is a row: never in no list', (tester) async {
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
    // The authority answered with the supervisor switched off: there is no entry.
    SupervisorFeed.instance.publish(const SupervisorFind(SupervisorFindKind.off, message: 'off'));
    addTearDown(SupervisorFeed.instance.resetForTest);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    expect(find.text('Dictation work'), findsOneWidget, reason: 'the list shows the ordinary rows');
    expect(find.text('Idle one'), findsOneWidget);
    expect(find.text('web-terminal supervisor'), findsOneWidget, reason: 'nothing else reaches it, so the list does');
  });
}
