// #377 - a fold made before a hand-off: the device remembers `tree.<old id>`, the
// session now runs under a successor that `replaces` it. On a cold launch the successor
// comes up folded, and its toggle must be able to undo that - it once could not, because
// unfolding cleared only the successor's own key. At phone width (360dp), where the
// toggle line shares its row with the dots. One test per file: SessionRepository/
// ServerStore are singletons (see dashboard_favorites_handle_test).
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

Session _s(String id, String name, {String? parent, List<String> replaces = const []}) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: _home,
      parentId: parent,
      replaces: replaces,
    );

void main() {
  testWidgets('a successor folded under its old id unfolds from its own toggle, at phone width', (tester) async {
    tester.view.physicalSize = const Size(360, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _home.name, 'baseUrl': _home.baseUrl, 'bearerToken': _home.bearerToken},
      ]),
      '${kCollapsedKeyPrefix}tree.lead': true,
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('lead2', 'Lead, handed off', replaces: ['lead']),
        for (var i = 0; i < 10; i++) _s('w$i', 'Worker $i', parent: 'lead'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    final fold = find.byKey(const ValueKey('tree-fold-lead2'));
    expect(fold, findsOneWidget);
    expect(find.text('Worker 0'), findsNothing, reason: 'remembered fold, applied through replaces');
    expect(find.descendant(of: fold, matching: find.text('+2')), findsOneWidget, reason: '8 dots, then +2');
    expect(tester.takeException(), isNull, reason: 'the folded line fits at 360dp');

    await tester.tap(fold);
    await tester.pump();
    expect(find.text('Worker 0'), findsOneWidget, reason: 'one tap unfolds it');
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.containsKey('${kCollapsedKeyPrefix}tree.lead'), isFalse);
    expect(prefs.containsKey('${kCollapsedKeyPrefix}tree.lead2'), isFalse);

    await tester.tap(fold);
    await tester.pump();
    expect(find.text('Worker 0'), findsNothing, reason: 'and it folds again under its own id');
    expect(prefs.getBool('${kCollapsedKeyPrefix}tree.lead2'), isTrue);
    expect(tester.takeException(), isNull);
  });
}
