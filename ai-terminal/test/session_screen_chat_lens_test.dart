// sessionKeepsTranscript — the rule that decides whether a session can have a Chat
// lens at all. Pulled out as a pure function (like canForkFromMenu) so the rule is
// testable without pumping the whole SessionScreen.
//
// Regression: Chat used to be gated on `claudeSessionId != null`, which hid the lens
// for every Codex session — only Claude records a conversation id, yet the transcript
// is fetched by `session.id` and never needs one.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({
  String? claudeSessionId,
  String? agent,
  String? agentSessionId,
}) => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: r'C:\dev\my-project',
  status: 'idle',
  claudeSessionId: claudeSessionId,
  agent: agent,
  agentSessionId: agentSessionId,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

void main() {
  group('sessionKeepsTranscript', () {
    test('true for a codex session, which has no claudeSessionId', () {
      expect(sessionKeepsTranscript(_session(agent: 'codex')), isTrue);
    });

    test('true for a claude session identified by agent', () {
      expect(sessionKeepsTranscript(_session(agent: 'claude')), isTrue);
    });

    test('true for a claude session from an OLDER server that sends no agent', () {
      expect(
        sessionKeepsTranscript(_session(claudeSessionId: 'claude-abc')),
        isTrue,
      );
    });

    test('true for any future agent the app has never heard of', () {
      expect(sessionKeepsTranscript(_session(agent: 'some-future-agent')), isTrue);
    });

    test('false for a plain shell — no agent, no conversation id', () {
      expect(sessionKeepsTranscript(_session()), isFalse);
    });

    test('false for a null session', () {
      expect(sessionKeepsTranscript(null), isFalse);
    });
  });

  // #119: a brand-new agent session 404s its transcript until the first turn writes
  // one. Treating that as final hid the Chat toggle for the life of the screen — the
  // reported "no chat options until I switch away and come back", reached one step
  // after the create response started reporting the agent correctly.
  group('noTranscriptIsFinal', () {
    test('false for an agent session that has no conversation id YET', () {
      expect(noTranscriptIsFinal(_session(agent: 'claude')), isFalse);
      expect(noTranscriptIsFinal(_session(agent: 'codex')), isFalse);
    });

    test('true once the server has published a conversation id', () {
      // The conversation demonstrably exists, so a 404 is a real resolution
      // failure (#117) — an empty Chat lens over a live session is worse than
      // falling back to Terminal.
      expect(
        noTranscriptIsFinal(_session(agent: 'claude', agentSessionId: 'conv-1')),
        isTrue,
      );
    });

    test('true for a plain shell — it never had one to wait for', () {
      expect(noTranscriptIsFinal(_session()), isTrue);
      expect(noTranscriptIsFinal(null), isTrue);
    });
  });

  group('fork stays Claude-only', () {
    // Forking replays `claude --resume <id>`, so it genuinely needs a Claude id —
    // widening the Chat gate must not widen this one.
    test('a codex session cannot be forked', () {
      expect(canForkFromMenu(_session(agent: 'codex')), isFalse);
    });

    test('a claude session can be forked', () {
      expect(canForkFromMenu(_session(claudeSessionId: 'abc', agent: 'claude')), isTrue);
    });
  });
}
