// The launch path for chat links (openChatLink): confirms a real http/https tap
// reaches url_launcher, and — the security-critical part — that javascript:/
// file:/data:/mailto: and junk NEVER launch. The isLaunchableHttpUrl gate is
// unit-tested separately; this exercises the actual launch call end-to-end via
// a mock platform.
import 'package:ai_terminal/widgets/conversation_view.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

class _RecordingLauncher extends UrlLauncherPlatform
    with MockPlatformInterfaceMixin {
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _RecordingLauncher mock;

  setUp(() {
    mock = _RecordingLauncher();
    UrlLauncherPlatform.instance = mock;
  });

  test('openChatLink launches http/https URLs', () async {
    await openChatLink('https://example.com/a?b=c');
    await openChatLink('http://example.com');
    expect(mock.launched, ['https://example.com/a?b=c', 'http://example.com']);
  });

  test('openChatLink never launches unsafe schemes / hostless / empty / null',
      () async {
    for (final bad in <String?>[
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'mailto:a@b.com',
      'ftp://example.com',
      'https://', // no host
      'not a url',
      '',
      null,
    ]) {
      await openChatLink(bad);
    }
    expect(mock.launched, isEmpty);
  });
}
