// #374 - the REAL session list draws a session another session opened under its parent,
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
const _office = ServerConfig(name: 'Office', baseUrl: 'http://office.example:7681', bearerToken: 't');

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
  testWidgets('a helper sits indented under its parent; one on another server names its parent and machine',
      (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in [_home, _office]) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('kid', 'Helper build', parent: 'boss'),
        _s('other', 'Unrelated'),
        _s('boss', 'Orchestrator'),
        _s('far', 'Remote helper', server: _office, parent: 'boss'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    final boss = tester.getTopLeft(find.text('Orchestrator'));
    final kid = tester.getTopLeft(find.text('Helper build'));
    final other = tester.getTopLeft(find.text('Unrelated'));
    // Listed kid, other, boss: the top-level rows keep their order and the helper,
    // listed FIRST, moves down under its parent.
    expect(other.dy, lessThan(boss.dy), reason: 'top-level rows keep their order');
    expect(kid.dy, greaterThan(boss.dy), reason: 'the helper follows its parent');
    expect(kid.dx, greaterThan(boss.dx), reason: 'and indented');
    expect(other.dx, boss.dx);
    expect(find.byKey(const ValueKey('tree-kid')), findsOneWidget);

    // On Office it is a top-level row (its parent is not in that group), and its
    // card's family line (#380) names the parent and its machine.
    expect(
      find.descendant(of: find.byKey(const ValueKey('family-badge-far')), matching: find.text('↑ Orchestrator · Home')),
      findsOneWidget,
    );
    expect(tester.getTopLeft(find.text('Remote helper')).dx, boss.dx);
    expect(tester.takeException(), isNull);
  });
}
