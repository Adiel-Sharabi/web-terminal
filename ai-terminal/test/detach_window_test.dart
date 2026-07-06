// Unit tests for DetachWindow.parseArgs (issue #14): a `--session <baseUrl>
// <id>` launch opens a detached single-session window; anything else is a
// normal launch (null). Pure, so no process/window is spawned here.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/services/detach_window_service.dart';

void main() {
  group('DetachWindow.parseArgs', () {
    test('parses --session baseUrl id', () {
      final t = DetachWindow.parseArgs(['--session', 'http://home:7681', 'sess-1']);
      expect(t, isNotNull);
      expect(t!.baseUrl, 'http://home:7681');
      expect(t.sessionId, 'sess-1');
    });

    test('normal launch (no flag) is null', () {
      expect(DetachWindow.parseArgs(const []), isNull);
      expect(DetachWindow.parseArgs(['--other', 'x']), isNull);
    });

    test('missing operands is null (not a crash)', () {
      expect(DetachWindow.parseArgs(['--session']), isNull);
      expect(DetachWindow.parseArgs(['--session', 'http://x']), isNull);
    });

    test('empty operands are rejected', () {
      expect(DetachWindow.parseArgs(['--session', '', 'id']), isNull);
      expect(DetachWindow.parseArgs(['--session', 'http://x', '']), isNull);
    });

    test('the flag can sit after other args', () {
      final t = DetachWindow.parseArgs(['--verbose', '--session', 'http://x', 'y']);
      expect(t, DetachedTarget(baseUrl: 'http://x', sessionId: 'y'));
    });
  });
}
