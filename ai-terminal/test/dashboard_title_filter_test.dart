// #327 - the REAL session list narrows by title as you type, and while it does it is a
// flat list of matches (no Favorites group, no server groups), so nothing reorderable is
// on screen. One test per file: SessionRepository/ServerStore are singletons whose init
// futures bind to the first test's FakeAsync zone (see dashboard_favorites_handle_test).
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

Session _s(String id, String name, {bool favorite = false}) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: _server,
      autoCommand: '',
      favorite: favorite,
      favoriteRank: favorite ? 0 : null,
    );

void main() {
  testWidgets('typing in the title filter narrows the list; clearing it restores the groups', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('a', 'Speed up downloads', favorite: true),
        _s('b', 'GP10 version'),
        _s('c', 'bug Hunter'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();
    expect(find.text('FAVORITES'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('session-title-filter')), 'VERSION');
    await tester.pump();
    expect(find.text('GP10 version'), findsOneWidget);
    expect(find.text('Speed up downloads'), findsNothing);
    expect(find.text('bug Hunter'), findsNothing);
    expect(find.text('FAVORITES'), findsNothing, reason: 'matches are one flat, unreorderable list');

    await tester.enterText(find.byKey(const ValueKey('session-title-filter')), 'zzz');
    await tester.pump();
    expect(find.text('No session matches'), findsOneWidget);

    await tester.tap(find.byTooltip('Clear filter'));
    await tester.pump();
    expect(find.text('FAVORITES'), findsOneWidget);
    expect(find.text('bug Hunter'), findsOneWidget);
  });
}
