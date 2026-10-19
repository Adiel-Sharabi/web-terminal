// #377 - the REAL session list folds a session's children away and brings them back,
// remembers the choice on the device, and while folded still shows each hidden child's
// status (a helper waiting on an answer must not vanish). One test per file:
// SessionRepository/ServerStore are singletons whose init futures bind to the first
// test's FakeAsync zone (see dashboard_favorites_handle_test).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/theme/status_colors.dart';
import 'package:ai_terminal/widgets/status_dot.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://home.example:7681', bearerToken: 't');

Session _s(String id, String name, {String? parent, String status = 'idle'}) => Session(
      id: id,
      name: name,
      cwd: '/home/x',
      status: status,
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: _home,
      parentId: parent,
    );

void main() {
  testWidgets('a parent folds its children away, keeps their status dots, and remembers it', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {'name': _home.name, 'baseUrl': _home.baseUrl, 'bearerToken': _home.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _s('boss', 'Orchestrator'),
        _s('w1', 'Worker one', parent: 'boss', status: 'waiting'),
        _s('w2', 'Worker two', parent: 'w1'),
        _s('other', 'Unrelated'),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    final fold = find.byKey(const ValueKey('tree-fold-boss'));
    expect(fold, findsOneWidget);
    expect(find.descendant(of: fold, matching: find.text('2 sub-sessions')), findsOneWidget);
    expect(find.byKey(const ValueKey('tree-fold-w1')), findsOneWidget, reason: 'a child that opened one folds too');
    expect(find.byKey(const ValueKey('tree-fold-other')), findsNothing, reason: 'no children, no toggle');
    expect(find.descendant(of: fold, matching: find.byType(StatusDot)), findsNothing, reason: 'shown rows carry their own');
    expect(find.text('Worker one'), findsOneWidget);
    // A screen reader can press it: the Semantics wrapper that names it must not
    // swallow the InkWell's tap.
    final handle = tester.ensureSemantics();
    expect(tester.getSemantics(find.bySemanticsLabel('Fold 2 sub-sessions')).getSemanticsData().hasAction(SemanticsAction.tap),
        isTrue);
    handle.dispose();

    await tester.tap(fold);
    await tester.pump();
    expect(find.text('Worker one'), findsNothing);
    expect(find.text('Worker two'), findsNothing);
    expect(find.text('Unrelated'), findsOneWidget);
    final dots = tester.widgetList<StatusDot>(find.descendant(of: fold, matching: find.byType(StatusDot)));
    expect([for (final d in dots) d.status], [SessionStatus.waiting, SessionStatus.idle],
        reason: 'one dot per hidden session, in order: the waiting helper still shows');
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('${kCollapsedKeyPrefix}tree.boss'), isTrue);

    await tester.tap(fold);
    await tester.pump();
    expect(find.text('Worker one'), findsOneWidget);
    expect(find.text('Worker two'), findsOneWidget);
    expect(prefs.containsKey('${kCollapsedKeyPrefix}tree.boss'), isFalse, reason: 'expanded is the default: no key');
    expect(tester.takeException(), isNull);
  });
}
