// Unit tests for buildForkAutoCommand — the fork action's auto-command
// construction, mirroring the web's fork logic exactly (see app.html's
// `sb-fork` handler: 'claude --resume <id> --fork-session', carrying over
// --dangerously-skip-permissions when the source session used it).
//
// NOTE: depends on `Session.autoCommand`, a field app-core is adding to the
// Session model alongside this feature — this file will not compile until
// that field lands (see the APP-UI handoff report for details).
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/widgets/session_action_sheet.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({required String claudeSessionId, String autoCommand = ''}) =>
    Session(
      id: 'sess-1',
      name: 'my-project',
      cwd: r'C:\dev\my-project',
      status: 'idle',
      claudeSessionId: claudeSessionId,
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      server: _server(),
      autoCommand: autoCommand,
    );

void main() {
  group('buildForkAutoCommand', () {
    test('builds a plain --resume --fork-session command', () {
      final session = _session(claudeSessionId: 'claude-abc123');
      expect(
        buildForkAutoCommand(session),
        'claude --resume claude-abc123 --fork-session',
      );
    });

    test('carries over --dangerously-skip-permissions from the source', () {
      final session = _session(
        claudeSessionId: 'claude-abc123',
        autoCommand: 'claude --dangerously-skip-permissions',
      );
      expect(
        buildForkAutoCommand(session),
        'claude --resume claude-abc123 --fork-session'
        ' --dangerously-skip-permissions',
      );
    });

    test('does not add the flag when the source did not use it', () {
      final session = _session(
        claudeSessionId: 'claude-abc123',
        autoCommand: 'claude --resume some-other-id',
      );
      expect(
        buildForkAutoCommand(session),
        'claude --resume claude-abc123 --fork-session',
      );
    });
  });
}
