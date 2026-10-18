// #374 (phone width) - the REAL session list draws a session another session opened under its parent,
// indented, and a helper whose parent is on ANOTHER server says where it came from. One
// test per file: SessionRepository/ServerStore are singletons whose init futures bind to
// the first test's FakeAsync zone (see dashboard_favorites_handle_test). The rows come
// from the cold-launch cache, which is also what pins that the cache keeps the link.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');

Session _s(String id, String name, {ServerConfig server = _home, String? parent}) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: server,
      parentId: parent,
    );

void main() {
  testWidgets('on a 360dp phone a helper keeps the card width: no indent, an arrow marks it, nothing overflows',
      (tester) async {
    tester.view.physicalSize = const Size(360, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _home.name, 'baseUrl': _home.baseUrl, 'bearerToken': _home.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('boss', 'Orchestrator'),
        _s('kid', 'Helper build with a long name', parent: 'boss'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    final boss = tester.getRect(find.byKey(const ValueKey('main-boss')));
    final kid = tester.getRect(find.byKey(const ValueKey('main-kid')));
    expect(kid.top, greaterThan(boss.top));
    expect(kid.width, boss.width, reason: 'the indent gives way to the card on a phone');
    expect(find.byIcon(Icons.subdirectory_arrow_right), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
