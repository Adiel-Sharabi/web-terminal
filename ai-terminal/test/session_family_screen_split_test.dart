// #380 - the session screen itself carries the family strip, and in the wide
// split a crumb SELECTS the relative (SessionSelection is what the pane shows)
// rather than pushing a route over the layout. One test per file: the
// repository is a singleton whose init binds to the first test's zone.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';

// Numeric, dead-port servers: the screen attaches on mount, and a hostname would
// leave a DNS timer pending in the fake-async zone (see session_gone_exit_test).
const _home = ServerConfig(name: 'Home', baseUrl: 'http://127.0.0.1:1', bearerToken: 't');
const _xps = ServerConfig(name: 'XPS', baseUrl: 'http://127.0.0.2:1', bearerToken: 't');

Session _s(String id, ServerConfig server, {String? parent}) => Session(
      id: id,
      name: id,
      cwd: '/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 0,
      notifyLevel: 'important',
      server: server,
      parentId: parent,
      autoCommand: '',
    );

void main() {
  testWidgets('in the split pane a crumb selects the relative', (tester) async {
    SessionSelection.instance.reset();
    addTearDown(SessionSelection.instance.reset);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in [_home, _xps]) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('master', _xps),
        _s('lead', _home, parent: 'master'),
        _s('worker', _home, parent: 'lead'),
      ]),
    });
    await ServerStore.instance.init();
    await SessionRepository.instance.primeFromCache();
    SessionSelection.instance.select('worker');

    await tester.pumpWidget(MaterialApp(
      home: SessionScreen(sessionId: 'worker', initialSession: _s('worker', _home, parent: 'lead'), embedded: true),
    ));
    await tester.pump();

    expect(find.byKey(const ValueKey('family-strip-worker')), findsOneWidget);
    expect(find.text('master · XPS'), findsOneWidget, reason: 'the machine is named where the chain leaves this one');
    await tester.tap(find.byKey(const ValueKey('family-crumb-lead')));
    await tester.pump();
    expect(SessionSelection.instance.selectedId, 'lead');
    expect(find.byType(SessionScreen), findsOneWidget, reason: 'selected, not pushed over the split');

    await tester.pumpWidget(const SizedBox()); // dispose -> cancel timers
    await tester.pump();
  });
}
