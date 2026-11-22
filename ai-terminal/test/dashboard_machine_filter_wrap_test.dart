// #487 - the dashboard's machine filter row must show every machine at phone width,
// wrapping into at most two rows, never scrolling sideways. With seven machines the old
// horizontal ListView pushed half the chips off the S25's screen.
//
// Measured with the REAL Roboto (the font Android draws the chips in), loaded from the
// Flutter SDK: the test font draws every glyph 1 em wide, which would make any
// width assertion meaningless. A missing font file fails the test, never skips it.
// One test per file: SessionRepository/ServerStore are singletons
// (see dashboard_favorites_handle_test).
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';

// Seven machines shaped like the real cluster (names made up): one with a long
// mDNS-style host name.
const _names = [
  'Home',
  'Office-Tests',
  'Office',
  'XPS',
  'host-MacBook-Air-xx-Abcde.local',
  'Help',
  'WorkstationNew',
];

final _servers = [
  for (final n in _names)
    ServerConfig(name: n, baseUrl: 'http://${n.toLowerCase().replaceAll('.', '-')}.example:7681', bearerToken: 't'),
];

// Galaxy S25: 1080 x 2340 px at 450 dpi = 384 x 832 dp.
const _s25Physical = Size(1080, 2340);
const _s25Dpr = 450 / 160;

// The label cap the two-row S25 layout was measured with. Pinned here, not read from
// DashboardMachineFilter.maxLabelWidth: a test reading the constant it checks passes
// whatever the constant becomes.
const double _labelCap = 120;

Session _s(String id, ServerConfig server) => Session(
      id: id,
      name: 'session on ${server.name}',
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: 1000,
      notifyLevel: 'important',
      server: server,
      autoCommand: '',
    );

List<String> _sessionTexts(WidgetTester tester) => [
      for (final w in tester.widgetList<Text>(find.byType(Text, skipOffstage: false)))
        if ((w.data ?? '').contains('session on') || (w.data ?? '').contains('No ')) w.data!,
    ];

Future<void> _loadRoboto() async {
  // flutter_tester lives in <flutter>/bin/cache/artifacts/engine/<platform>/.
  final cache = File(Platform.resolvedExecutable).parent.parent.parent.parent;
  final dir = Directory('${cache.path}/artifacts/material_fonts');
  final loader = FontLoader('Roboto');
  var added = 0;
  for (final f in ['Roboto-Regular.ttf', 'Roboto-Medium.ttf']) {
    final file = File('${dir.path}/$f');
    if (!file.existsSync()) {
      fail('setup: ${file.path} not found - cannot measure real chip widths');
    }
    final bytes = file.readAsBytesSync();
    loader.addFont(Future.value(ByteData.sublistView(bytes)));
    added++;
  }
  expect(added, 2);
  await loader.load();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // Loading a font posts a "system fonts changed" message whose relayout frame
  // callback arrives asynchronously. Inside the test body it could land after the
  // last pump, which fails the test ("an animation is still running", seen on the
  // Linux CI runner only). Loaded here, the test's first pump consumes it.
  setUpAll(_loadRoboto);

  testWidgets('seven machines wrap into at most two rows at S25 width, no sideways scroll',
      (tester) async {
    tester.view.physicalSize = _s25Physical;
    tester.view.devicePixelRatio = _s25Dpr;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in _servers) {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        for (var i = 0; i < _servers.length; i++) _s('s$i', _servers[i]),
      ]),
    });
    await ServerStore.instance.init();
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()));
    await tester.pump();
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    final width = tester.view.physicalSize.width / tester.view.devicePixelRatio;
    expect(width, closeTo(384, 0.5), reason: 'setup: the S25 logical width');

    final filter = find.byType(DashboardMachineFilter);
    expect(filter, findsOneWidget, reason: 'setup: more than one server shows the filter');
    expect(
      find.descendant(of: filter, matching: find.byType(Scrollable)),
      findsNothing,
      reason: 'the machine row must not scroll sideways (#487)',
    );

    final labels = ['All', ..._names];
    final chips = [for (final l in labels) find.byKey(ValueKey('machine-filter-chip-$l'))];

    void expectAllVisibleInTwoRows(String when) {
      final tops = <double>{};
      for (var i = 0; i < chips.length; i++) {
        expect(chips[i], findsOneWidget, reason: 'chip ${labels[i]} exists ($when)');
        final r = tester.getRect(chips[i]);
        expect(r.left, greaterThanOrEqualTo(0), reason: '${labels[i]} starts on screen ($when)');
        expect(r.right, lessThanOrEqualTo(width), reason: '${labels[i]} ends on screen ($when)');
        tops.add(r.top.roundToDouble());
        final text = tester.getRect(find.descendant(of: chips[i], matching: find.byType(Text)).first);
        expect(text.width, lessThanOrEqualTo(_labelCap),
            reason: 'a long machine name is capped, not drawn at full width ($when)');
      }
      expect(tops.length, lessThanOrEqualTo(2),
          reason: 'all ${chips.length} chips fit in at most two rows ($when); row tops: $tops');
    }

    expectAllVisibleInTwoRows('nothing selected but All');

    // Selecting a chip still filters as before, and never reflows the row onto a
    // third line (a selected chip must not grow).
    for (var i = 1; i < labels.length; i++) {
      await tester.tap(chips[i]);
      await tester.pump();
      expect(tester.widget<ChoiceChip>(chips[i]).selected, isTrue);
      expectAllVisibleInTwoRows('${labels[i]} selected');
      expect(find.text('session on ${labels[i]}'), findsOneWidget,
          reason: 'selecting ${labels[i]} shows its session; on screen: ${_sessionTexts(tester)}');
      for (final other in _names.where((n) => n != labels[i])) {
        expect(find.text('session on $other'), findsNothing,
            reason: 'selecting ${labels[i]} hides $other\'s session');
      }
    }

    await tester.tap(chips[0]);
    await tester.pump();
    expect(tester.widget<ChoiceChip>(chips[0]).selected, isTrue);
    // Seven cards are taller than the screen: scroll each into view (an unbuilt card
    // is not a filtered-out one).
    for (final n in _names) {
      await tester.dragUntilVisible(
          find.text('session on $n'), find.byType(CustomScrollView), const Offset(0, -120));
      expect(find.text('session on $n'), findsOneWidget, reason: 'All shows every machine again');
    }
  });
}
