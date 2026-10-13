// #347 - coming back to the session list must not put the cursor back in the title
// filter. A route remembers its focused field and Flutter refocuses it when the route
// above pops; on a phone a tap elsewhere never unfocuses a TextField, so the filter was
// refocused, and the keyboard opened, on every return. One test per file:
// SessionRepository/ServerStore are singletons (see dashboard_favorites_handle_test).
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

Session _s(String id, String name) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: _server,
      autoCommand: '',
    );

void main() {
  testWidgets('returning from a pushed screen does not refocus the title filter', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _server.name, 'baseUrl': _server.baseUrl, 'bearerToken': _server.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([_s('a', 'GP10 version')]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    final filter = find.byKey(const ValueKey('session-title-filter'));
    await tester.enterText(filter, 'GP10');
    await tester.pump();
    bool filterFocused() =>
        tester.widget<EditableText>(find.descendant(of: filter, matching: find.byType(EditableText)))
            .focusNode
            .hasFocus;
    expect(filterFocused(), isTrue, reason: 'precondition: typing focused the filter');

    // Leave the list the way a phone does (a full-screen route), then come back.
    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byType(DashboardScreen, skipOffstage: false))).pop();
    await tester.pumpAndSettle();

    expect(filterFocused(), isFalse, reason: 'the pop must not hand focus back to the filter');
    expect(tester.testTextInput.isVisible, isFalse, reason: 'no keyboard on return');
    expect(find.text('GP10 version'), findsOneWidget, reason: 'the filter text itself is kept');
  });
}
