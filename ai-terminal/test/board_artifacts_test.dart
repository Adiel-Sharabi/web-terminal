// #329 - the claude.ai artifacts a session published, on its dashboard card. Pins the
// wire parsing (only a claude.ai link is ever kept), that a card, a compact row and a
// closed session all show them, that a tap opens the ARTIFACT and not the session, and
// that the dashboard's text filter finds a session by what it published.
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/work_board_screen.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

class _RecordingLauncher extends UrlLauncherPlatform with MockPlatformInterfaceMixin {
  final List<String> launched = <String>[];

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> canLaunch(String url) async => true;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    launched.add(url);
    return true;
  }
}

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');
const _url = 'https://claude.ai/artifact/VyNWRcRV5M7GVnLmdjCQYG';

Session _session(SessionBrief brief) => Session(
      id: 's1',
      name: 'Speed up downloads',
      cwd: '/w',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: null,
      notifyLevel: 'important',
      server: _server,
      brief: brief,
    );

final _brief = SessionBrief.fromJson({
  'v': 1,
  'reporting': 'on',
  'items': [],
  'artifacts': [
    {'url': _url, 'title': 'CI streamline plan', 'at': 5000},
    {'url': 'javascript:alert(1)', 'title': 'evil'},
    {'url': 'https://evil.example/artifact/abcdef1', 'title': 'elsewhere'},
  ],
})!;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _RecordingLauncher launcher;
  setUp(() => UrlLauncherPlatform.instance = launcher = _RecordingLauncher());

  test('only a claude.ai link is kept from the wire; an old server sends none', () {
    expect(_brief.artifacts.map((a) => a.url), [_url]);
    expect(_brief.artifacts.single.title, 'CI streamline plan');
    expect(_brief.artifacts.single.at, 5000);
    expect(SessionBrief.fromJson({'v': 1, 'items': []})!.artifacts, isEmpty);
    final closed = ClosedSession.fromJson(_server, {
      'id': 'c',
      'artifacts': [
        {'url': _url, 'title': ''},
      ],
    })!;
    expect(closed.artifacts.single.title, 'Artifact');
  });

  test('the text filter finds a session by an artifact title', () {
    expect(boardMatches(_session(_brief), 'streamline', const {}), isTrue);
    expect(boardMatches(_session(_brief), 'evil', const {}), isFalse);
  });

  testWidgets('a card shows the artifact; a tap opens IT, never the session', (tester) async {
    var opened = 0;
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: SingleChildScrollView(
          child: BoardCard(session: _session(_brief), actions: BoardActions(onOpen: () => opened++)),
        ),
      ),
    ));
    expect(find.text('CI streamline plan'), findsOneWidget);
    expect(find.text('evil'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('board-artifact-$_url')));
    await tester.pump();
    expect(launcher.launched, [_url]);
    expect(opened, 0);
  });

  testWidgets('a compact row shows it too: a done session is where an overview is worth finding', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(body: BoardRow(session: _session(_brief), actions: BoardActions(onOpen: () {}))),
    ));
    expect(find.byKey(const ValueKey('board-artifact-$_url')), findsOneWidget);
  });
}
