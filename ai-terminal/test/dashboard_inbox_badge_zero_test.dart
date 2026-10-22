// #383 - with nothing waiting, the dashboard's Questions button carries no count.
// One test per file: SessionRepository/ServerStore are singletons whose init futures bind to
// the first test's FakeAsync zone (see dashboard_favorites_handle_test).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');

Session _s(String id, String name, {required String status}) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: status,
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: _server,
      autoCommand: '',
    );

void main() {
  testWidgets('nothing waits: the Questions button shows no count', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('c', 'Idle', status: 'idle'),
        _s('w', 'Busy', status: 'working'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    final badge = tester.widget<Badge>(find.byKey(const ValueKey('questions-inbox-badge')));
    expect(badge.isLabelVisible, isFalse);
    expect(find.byKey(const ValueKey('open-questions-inbox')), findsOneWidget, reason: 'the button stays; only the count hides');
  });
}
