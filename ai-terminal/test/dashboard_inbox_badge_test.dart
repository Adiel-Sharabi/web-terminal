// #383 - the dashboard's Questions button counts what blocks on you, read from the rows the
// list already holds (inboxBadgeCount, the board's own rule), so the badge costs no request.
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
  testWidgets('the Questions button carries the blocking count from the rows already held, with no request', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('a', 'Asker', status: 'waiting'),
        _s('b', 'Perm', status: 'waiting'),
        _s('c', 'Idle', status: 'idle'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    final badge = tester.widget<Badge>(find.byKey(const ValueKey('questions-inbox-badge')));
    expect(badge.isLabelVisible, isTrue);
    expect((badge.label! as Text).data, '2');
  });
}
