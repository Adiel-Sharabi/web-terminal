// #380 - a run spread over three machines is cut into three groups by the session
// list, so every card that has relatives ANYWHERE carries a family line naming its
// parent and counting what it opened, and the line opens the whole family. One test
// per file: SessionRepository/ServerStore are singletons whose init futures bind to
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

const _xps = ServerConfig(name: 'XPS', baseUrl: 'http://xps.example:7681', bearerToken: 't');
const _home = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://office.example:7681', bearerToken: 't');

Session _s(String id, String name, ServerConfig server, {String? parent}) => Session(
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
  testWidgets('every related card carries a badge, and it opens the family across machines', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in [_xps, _home, _office]) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('master', 'Master', _xps),
        _s('lead-h', 'Lead home', _home, parent: 'master'),
        _s('w1', 'Worker one', _home, parent: 'lead-h'),
        _s('w2', 'Worker two', _home, parent: 'lead-h'),
        _s('lead-o', 'Lead office', _office, parent: 'master'),
        _s('w3', 'Worker three', _office, parent: 'lead-o'),
        _s('other', 'Unrelated', _home),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    String badge(String id) {
      final f = find.descendant(of: find.byKey(ValueKey('family-badge-$id')), matching: find.byType(Text));
      return tester.widget<Text>(f).data!;
    }

    // The master's machine group holds nothing else, so only this line says it has a run.
    expect(badge('master'), '↓ 5 sub-sessions');
    // The parent is named, with its machine when that is another one.
    expect(badge('lead-h'), '↑ Master · XPS   ↓ 2 sub-sessions');
    expect(badge('w3'), '↑ Lead office');
    expect(badge('w1'), '↑ Lead home', reason: 'one line per related card, even under its parent');
    expect(find.byKey(const ValueKey('family-badge-other')), findsNothing, reason: 'no relatives, no badge');

    await tester.tap(find.byKey(const ValueKey('family-badge-lead-h')));
    await tester.pumpAndSettle();
    expect(find.text('Family · 6 sessions on 3 machines'), findsOneWidget);
    for (final id in ['master', 'lead-h', 'w1', 'w2', 'lead-o', 'w3']) {
      expect(find.byKey(ValueKey('family-row-$id')), findsOneWidget, reason: '$id is in the family');
    }
    expect(find.byKey(const ValueKey('family-row-other')), findsNothing);
    expect(
      find.descendant(of: find.byKey(const ValueKey('family-row-lead-h')), matching: find.text('here')),
      findsOneWidget,
      reason: 'the session the sheet was opened from is marked',
    );
    // Top of the tree first, whichever member opened it.
    final tops = [
      for (final id in ['master', 'lead-h', 'w3']) tester.getTopLeft(find.byKey(ValueKey('family-row-$id'))).dy,
    ];
    expect(tops[0], lessThan(tops[1]));
    expect(tops[0], lessThan(tops[2]));
  });
}
