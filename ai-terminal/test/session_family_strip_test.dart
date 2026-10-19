// #380 - the strip under a session screen's title: its ancestors, each one a tap
// away (naming the machine where the chain crosses one), and the badge that opens
// the whole family, whose rows open sessions too. One test per file: the
// repository is a singleton whose init binds to the first test's zone.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/session_family.dart';

const _xps = ServerConfig(name: 'XPS', baseUrl: 'http://xps.example:7681', bearerToken: 't');
const _home = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');

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
  testWidgets('crumbs open ancestors; the badge opens the family; a row opens its session', (tester) async {
    tester.view.physicalSize = const Size(400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in [_xps, _home]) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('master', 'Master', _xps),
        _s('lead', 'Lead', _home, parent: 'master'),
        _s('worker', 'Worker', _home, parent: 'lead'),
        _s('sibling', 'Sibling', _home, parent: 'lead'),
        _s('alone', 'Alone', _home),
      ]),
    });
    await ServerStore.instance.init();
    await SessionRepository.instance.primeFromCache();

    final opened = <String>[];
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Column(children: [
          FamilyStrip(sessionId: 'worker', onOpen: (s) => opened.add(s.id)),
          FamilyStrip(sessionId: 'alone', onOpen: (s) => opened.add(s.id)),
        ]),
      ),
    ));
    await tester.pump();

    expect(find.byKey(const ValueKey('family-strip-worker')), findsOneWidget);
    expect(find.byKey(const ValueKey('family-strip-alone')), findsNothing, reason: 'no relatives, no strip');
    // The machine is named where the chain leaves this one, and only there.
    expect(find.text('Master · XPS'), findsOneWidget);
    expect(find.text('Lead'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('family-crumb-master')));
    await tester.tap(find.byKey(const ValueKey('family-crumb-lead')));
    expect(opened, ['master', 'lead']);

    await tester.tap(find.byKey(const ValueKey('family-badge-worker')));
    await tester.pumpAndSettle();
    expect(find.text('Family · 4 sessions on 2 machines'), findsOneWidget);
    // Its own row only closes the sheet; another row opens that session.
    await tester.tap(find.byKey(const ValueKey('family-row-worker')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('family-row-worker')), findsNothing);
    expect(opened, ['master', 'lead']);

    await tester.tap(find.byKey(const ValueKey('family-badge-worker')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('family-row-sibling')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('family-row-sibling')), findsNothing, reason: 'the sheet closes first');
    expect(opened, ['master', 'lead', 'sibling']);
  });
}
