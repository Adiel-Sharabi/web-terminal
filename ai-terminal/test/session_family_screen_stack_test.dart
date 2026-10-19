// #380 - on a phone, jumping between relatives from the session screen keeps ONE
// session screen above the list: a covered SessionScreen stays mounted with its
// own live socket and polls, so pushing on every jump piled up copies (the shape
// #45 fixed for notification taps, which now share openSessionOnStack). One test
// per file: the repository is a singleton whose init binds to the first test's zone.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://127.0.0.1:1', bearerToken: 't');

Session _s(String id, {String? parent}) => Session(
      id: id,
      name: id,
      cwd: '/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 0,
      notifyLevel: 'important',
      server: _home,
      parentId: parent,
      autoCommand: '',
    );

void main() {
  testWidgets('crumbs and sheet rows never stack a second session screen', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _home.name, 'baseUrl': _home.baseUrl, 'bearerToken': _home.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('master'),
        _s('lead', parent: 'master'),
        _s('worker', parent: 'lead'),
      ]),
    });
    await ServerStore.instance.init();
    await SessionRepository.instance.primeFromCache();

    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(navigatorKey: nav, home: const Scaffold(body: Text('the list'))));
    openSessionOnStack(nav.currentState!, 'worker', initialSession: _s('worker', parent: 'lead'));
    await tester.pumpAndSettle();

    final screens = find.byType(SessionScreen, skipOffstage: false);
    String shown() => tester.widget<SessionScreen>(find.byType(SessionScreen)).sessionId;
    expect(shown(), 'worker');

    // Up to the lead, up to the master, then back down to the worker from the sheet.
    await tester.tap(find.byKey(const ValueKey('family-crumb-lead')));
    await tester.pumpAndSettle();
    expect(shown(), 'lead');
    expect(screens, findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('family-crumb-master')));
    await tester.pumpAndSettle();
    expect(shown(), 'master');
    expect(screens, findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('family-badge-master')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('family-row-worker')));
    await tester.pumpAndSettle();
    expect(shown(), 'worker');
    expect(screens, findsOneWidget, reason: 'never a second live copy above the list');

    // And one Back returns to the list.
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(find.text('the list'), findsOneWidget);
    expect(screens, findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });
}
