// Widget tests for SettingsScreen (owner: "there is no server selection" —
// this screen is how he adds his real servers). Uses ServerStore.forTest()
// and an injected probe function so the test never touches the real
// singleton, SharedPreferences on disk, or the network — mirrors the
// injectable-clientBuilder pattern already used by new_session_sheet_test.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/settings_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/theme/app_theme.dart';

/// Builds a fresh, loaded, isolated store seeded with [servers] — an empty
/// list by default so the test never picks up the gitignored spike_config
/// seed.
Future<ServerStore> _store([List<ServerConfig> servers = const []]) async {
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]),
  });
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

Widget _wrap(Widget child) => MaterialApp(theme: AppTheme.dark, home: child);

void main() {
  testWidgets('shows an empty state with no servers configured', (
    tester,
  ) async {
    final store = await _store();
    await tester.pumpWidget(_wrap(SettingsScreen(store: store)));

    expect(find.textContaining('No servers configured'), findsOneWidget);
  });

  testWidgets('lists configured servers by name and base URL', (
    tester,
  ) async {
    final store = await _store([
      const ServerConfig(name: 'Home', baseUrl: 'http://100.1.1.1:7681', bearerToken: 't1'),
      const ServerConfig(name: 'Office', baseUrl: 'http://100.2.2.2:7681', bearerToken: 't2'),
    ]);
    await tester.pumpWidget(_wrap(SettingsScreen(store: store)));

    expect(find.text('Home'), findsOneWidget);
    expect(find.text('http://100.1.1.1:7681'), findsOneWidget);
    expect(find.text('Office'), findsOneWidget);
  });

  testWidgets('adding a server via the sheet persists it through the store', (
    tester,
  ) async {
    final store = await _store();
    await tester.pumpWidget(_wrap(SettingsScreen(store: store)));

    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'New Box');
    await tester.enterText(
      find.widgetWithText(TextField, 'Base URL'),
      'http://100.9.9.9:7681',
    );
    // #96: a NEW server now defaults to username+password, because a bearer
    // token is not something a user can obtain from the app. Pasting a token is
    // still supported — it just lives behind the toggle now.
    await tester.tap(find.text('Bearer token'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Bearer token'),
      'secret',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(store.servers, hasLength(1));
    expect(store.servers.single.name, 'New Box');
    expect(store.servers.single.baseUrl, 'http://100.9.9.9:7681');
    expect(find.text('New Box'), findsOneWidget);
  });

  // #96 — the point of the feature: a server can be added with the SAME
  // credentials used for the web UI, with no token in sight. The credential
  // fields are the DEFAULT for a new server.
  testWidgets('a new server offers username + password by default', (
    tester,
  ) async {
    final store = await _store();
    await tester.pumpWidget(_wrap(SettingsScreen(store: store)));

    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();

    // Credential fields visible, token field not.
    expect(find.widgetWithText(TextField, 'Username'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Password'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Bearer token'), findsNothing);
    // 'admin' is prefilled because it is the only user this server type has.
    expect(find.text('admin'), findsOneWidget);
    // And it says plainly what happens to the password.
    expect(find.textContaining('never stored'), findsOneWidget);

    // The toggle reveals the token field for anyone who does have one.
    await tester.tap(find.text('Bearer token'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'Bearer token'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Password'), findsNothing);
  });

  testWidgets('removing a server asks for confirmation then deletes it', (
    tester,
  ) async {
    final store = await _store([
      const ServerConfig(name: 'Home', baseUrl: 'http://100.1.1.1:7681', bearerToken: 't1'),
    ]);
    await tester.pumpWidget(_wrap(SettingsScreen(store: store)));

    await tester.tap(find.byIcon(Icons.delete_outline));
    await tester.pumpAndSettle();
    expect(find.text('Remove server?'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();

    expect(store.servers, isEmpty);
    expect(find.textContaining('No servers configured'), findsOneWidget);
  });

  testWidgets('Test button shows the probed server name and version', (
    tester,
  ) async {
    final store = await _store();
    await tester.pumpWidget(
      _wrap(
        SettingsScreen(
          store: store,
          probe: (config) async => const ServerInfo(
            version: '1.19.0',
            serverName: 'Shadow',
            capabilities: [],
          ),
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Base URL'),
      'http://100.9.9.9:7681',
    );
    await tester.tap(find.widgetWithText(OutlinedButton, 'Test'));
    await tester.pumpAndSettle();

    expect(find.text('Shadow (v1.19.0)'), findsOneWidget);
  });

  testWidgets('Test button surfaces a probe failure', (tester) async {
    final store = await _store();
    await tester.pumpWidget(
      _wrap(
        SettingsScreen(
          store: store,
          probe: (config) async =>
              throw const ApiException(0, 'Server unreachable'),
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Base URL'),
      'http://100.9.9.9:7681',
    );
    await tester.tap(find.widgetWithText(OutlinedButton, 'Test'));
    await tester.pumpAndSettle();

    expect(find.text('Server unreachable'), findsOneWidget);
  });

  group('Terminal text size (owner: "still need an option to change font '
      'size")', () {
    testWidgets('shows a discoverable slider defaulting to 10pt when unset', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      final store = await _store();
      await tester.pumpWidget(_wrap(SettingsScreen(store: store)));
      await tester.pumpAndSettle();

      expect(find.text('Terminal text size'), findsOneWidget);
      expect(find.text('10 pt'), findsOneWidget);
      expect(find.byType(Slider), findsOneWidget);
    });

    testWidgets('loads the persisted wt.termFontSize value on open', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues({
        kTermFontSizeKey: 16.0,
        ServerStore.storageKey: jsonEncode(const []),
      });
      final store = ServerStore.forTest();
      await store.init();
      await tester.pumpWidget(_wrap(SettingsScreen(store: store)));
      await tester.pumpAndSettle();

      expect(find.text('16 pt'), findsOneWidget);
    });

    testWidgets('moving the slider updates the readout and persists to the '
        'same wt.termFontSize key the session screen uses', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final store = await _store();
      await tester.pumpWidget(_wrap(SettingsScreen(store: store)));
      await tester.pumpAndSettle();

      final slider = tester.widget<Slider>(find.byType(Slider));
      slider.onChanged!(18);
      await tester.pumpAndSettle();

      expect(find.text('18 pt'), findsOneWidget);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getDouble(kTermFontSizeKey), 18);
    });
  });
}
