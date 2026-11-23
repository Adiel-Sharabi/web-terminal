// #492 - "Open to the inbox at launch": the setting's default per platform and its
// persistence, the settings switch, and what AdaptiveHome does with it at launch.
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/questions_inbox_screen.dart';
import 'package:ai_terminal/screens/settings_screen.dart';
import 'package:ai_terminal/services/launch_settings.dart';
import 'package:ai_terminal/services/notification_service.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_selection.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/util/open_inbox.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> _size(WidgetTester tester, Size s) async {
  tester.view.physicalSize = s;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _home({bool on = true, NotificationTap? tap}) => MaterialApp(
      theme: AppTheme.dark,
      home: AdaptiveHome(
        openInboxAtLaunch: () async => on,
        launchTap: () async => tap,
      ),
    );

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
    LaunchSettings.instance.reset();
  });
  tearDown(() {
    SessionSelection.instance.reset();
    LaunchSettings.instance.reset();
  });

  group('LaunchSettings', () {
    test('no stored choice: ON for a phone, OFF for desktop', () async {
      LaunchSettings.instance.phoneOverride = true;
      expect(await LaunchSettings.instance.restore(), isTrue);
      LaunchSettings.instance.phoneOverride = false;
      expect(await LaunchSettings.instance.restore(), isFalse);
    });

    test('a stored choice beats the platform default, and persists under launch.openInbox', () async {
      LaunchSettings.instance.phoneOverride = true;
      await LaunchSettings.instance.setEnabled(false);
      expect((await SharedPreferences.getInstance()).getBool('launch.openInbox'), isFalse);
      expect(await LaunchSettings.instance.restore(), isFalse, reason: 'a phone that chose OFF stays off');
      LaunchSettings.instance.phoneOverride = false;
      await LaunchSettings.instance.setEnabled(true);
      expect(await LaunchSettings.instance.restore(), isTrue, reason: 'a desktop that chose ON');
    });
  });

  group('the settings switch', () {
    testWidgets('shows the default, and flipping it persists', (tester) async {
      LaunchSettings.instance.phoneOverride = true;
      final store = ServerStore.forTest();
      await store.init();
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: SettingsScreen(store: store)));
      await tester.pump();
      await tester.pump();
      final tile = find.byKey(const ValueKey('settings-open-inbox'));
      expect(tester.widget<SwitchListTile>(tile).value, isTrue, reason: 'a phone defaults ON');
      await tester.tap(tile);
      await tester.pump();
      await tester.pump();
      expect(tester.widget<SwitchListTile>(tile).value, isFalse);
      expect((await SharedPreferences.getInstance()).getBool('launch.openInbox'), isFalse);
    });
  });

  group('AdaptiveHome at launch', () {
    testWidgets('narrow + on: the inbox is pushed once over the dashboard; Back returns', (tester) async {
      await _size(tester, const Size(420, 900));
      await tester.pumpWidget(_home());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(QuestionsInboxScreen), findsOneWidget);
      Navigator.of(tester.element(find.byType(QuestionsInboxScreen))).pop();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(QuestionsInboxScreen), findsNothing, reason: 'pushed once, never again');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('narrow + off: nothing is pushed', (tester) async {
      await _size(tester, const Size(420, 900));
      await tester.pumpWidget(_home(on: false));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(QuestionsInboxScreen), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('narrow + on, but a notification tap cold-started the app: no inbox push', (tester) async {
      await _size(tester, const Size(420, 900));
      await tester.pumpWidget(_home(tap: const NotificationTap('s1', 'approval')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(QuestionsInboxScreen), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('wide + on: the pane starts on the inbox', (tester) async {
      await _size(tester, const Size(1400, 900));
      await tester.pumpWidget(_home());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(SessionSelection.instance.inboxShown, isTrue);
      expect(find.byType(QuestionsInboxScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('wide + on, a session already selected: the selection stays', (tester) async {
      await _size(tester, const Size(1400, 900));
      SessionSelection.instance.select('already');
      await tester.pumpWidget(_home());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(SessionSelection.instance.selectedId, 'already');
      expect(SessionSelection.instance.inboxShown, isFalse);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('wide + off: the board stays', (tester) async {
      await _size(tester, const Size(1400, 900));
      await tester.pumpWidget(_home(on: false));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(SessionSelection.instance.boardShown, isTrue);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('openInbox, the one open-inbox path', () {
    Future<NavigatorState> mount(WidgetTester tester) async {
      await _size(tester, const Size(420, 900));
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const Scaffold(body: SizedBox())));
      return tester.state<NavigatorState>(find.byType(Navigator));
    }

    testWidgets('a phone pushes the inbox with the asked-for session', (tester) async {
      final nav = await mount(tester);
      openInbox(nav, focusSessionId: 'x');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.widget<QuestionsInboxScreen>(find.byType(QuestionsInboxScreen)).focusSessionId, 'x');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a split shows it in the pane, with the focus carried', (tester) async {
      final nav = await mount(tester);
      SessionSelection.instance.splitMounted = true;
      openInbox(nav, focusSessionId: 'x');
      expect(SessionSelection.instance.pane.value, const DetailPane.inboxFocus('x'));
      expect(SessionSelection.instance.inboxShown, isTrue);
      expect(find.byType(QuestionsInboxScreen), findsNothing, reason: 'nothing is pushed over a split');
    });

    testWidgets("the caller's own pane opener is used when there is no focus", (tester) async {
      final nav = await mount(tester);
      var shown = 0;
      openInbox(nav, showInPane: () => shown++);
      expect(shown, 1);
      expect(find.byType(QuestionsInboxScreen), findsNothing);
    });

    testWidgets('asking for another session while the inbox is showing changes the pane value', (tester) async {
      SessionSelection.instance.showInbox(focusSessionId: 'a');
      var notified = 0;
      SessionSelection.instance.pane.addListener(() => notified++);
      SessionSelection.instance.showInbox(focusSessionId: 'b');
      expect(notified, 1);
    });

    testWidgets('AdaptiveHome hands the pane focus to its inbox', (tester) async {
      await _size(tester, const Size(1400, 900));
      SessionSelection.instance.showInbox(focusSessionId: 'x');
      await tester.pumpWidget(_home(on: false));
      await tester.pump();
      expect(tester.widget<QuestionsInboxScreen>(find.byType(QuestionsInboxScreen)).focusSessionId, 'x');
      await tester.pumpWidget(const SizedBox());
    });
  });
}
