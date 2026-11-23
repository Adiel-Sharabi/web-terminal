// #498 - the dashboard's Questions badge and the inbox header give "need you" ONE definition
// (needYouOf): the rows' blocking items AND the supervisor's cards and escalations, read from
// the shared SupervisorFeed the inbox publishes to. Before, the badge said 2 while the header said 3.
// One test per file: SessionRepository/ServerStore are singletons whose init futures bind to
// the first test's FakeAsync zone (see dashboard_favorites_handle_test).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/supervisor_models.dart';
import 'package:ai_terminal/services/supervisor_lookup.dart';
import 'package:ai_terminal/util/supervisor_authority.dart';
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
  testWidgets('#498 the badge counts the same "need you" list as the inbox header: a supervisor card counts too', (tester) async {
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
    SupervisorFeed.instance.resetForTest();
    SupervisorFeed.instance.publish(SupervisorFind(SupervisorFindKind.found,
        server: _server,
        state: SupervisorState.fromJson({
          'role': 'authority',
          'enabled': true,
          'cards': [
            {'id': 'k1', 'sessionId': 'c', 'server': 'Home', 'text': 'Type continue', 'at': 5},
          ],
        }, receivedAt: DateTime.now())));
    addTearDown(SupervisorFeed.instance.resetForTest);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    final badge = tester.widget<Badge>(find.byKey(const ValueKey('questions-inbox-badge')));
    expect(badge.isLabelVisible, isTrue);
    expect((badge.label! as Text).data, '3', reason: 'two waiting rows and the supervisor card on the idle one');
  });
}
