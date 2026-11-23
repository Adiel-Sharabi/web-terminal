// #492 - the wiring of a notification tap in main.dart: an owner-wait push pops whatever a
// session pushed earlier and opens the ONE inbox with that session's item focused; every
// other kind opens its session and leaves the stack alone.
import 'package:ai_terminal/main.dart' show handleNotificationTap;
import 'package:ai_terminal/services/notification_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<NavigatorState> mount(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('root'))));
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    for (final n in ['one', 'two']) {
      nav.push(MaterialPageRoute<void>(builder: (_) => Scaffold(body: Text(n))));
      await tester.pumpAndSettle();
    }
    return nav;
  }

  testWidgets('an owner-wait tap pops to the first route, then opens the inbox focused on the session', (tester) async {
    final nav = await mount(tester);
    final calls = <String>[];
    var canPopWhenOpened = true;
    handleNotificationTap(
      nav,
      const NotificationTap('s1', 'owner-wait'),
      openSession: (id) => calls.add('session $id'),
      inbox: (n, {focusSessionId}) {
        canPopWhenOpened = n.canPop();
        calls.add('inbox $focusSessionId');
      },
    );
    await tester.pumpAndSettle();
    expect(calls, ['inbox s1'], reason: 'the session is not opened by the tap itself');
    expect(canPopWhenOpened, isFalse, reason: 'everything above the first route was popped first');
    expect(find.text('root'), findsOneWidget);
    expect(find.text('two'), findsNothing);
  });

  testWidgets('any other kind opens its session and leaves the stack alone', (tester) async {
    final nav = await mount(tester);
    final calls = <String>[];
    handleNotificationTap(
      nav,
      const NotificationTap('s2', 'approval'),
      openSession: (id) => calls.add('session $id'),
      inbox: (n, {focusSessionId}) => calls.add('inbox'),
    );
    await tester.pumpAndSettle();
    expect(calls, ['session s2']);
    expect(find.text('two'), findsOneWidget);
  });
}
