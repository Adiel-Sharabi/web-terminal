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
// scrollbackTailOffset moved here with the rest of the backward-walk rules
// (#167); kScrollbackReplayBytes stays a screen-level policy knob.
import 'package:ai_terminal/util/scrollback_window.dart';

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

  // Reported 2026-08-16: "I still can't scroll up in the terminal view."
  //
  // The replay asked for `limit: 5000` with no offset. `limit` is BYTES and
  // `offset` defaults to 0, so it fetched the OLDEST 5 KB — the start of the
  // session — and discarded the rest. Measured on live sessions: 5 KB of a
  // 1,950,432-byte scrollback is 99.7% thrown away, and because an agent TUI's
  // bytes are mostly escape sequences it came to ~45 NEWLINES. That is about one
  // desktop viewport, so there was nothing above the screen to scroll to.
  group('scrollbackTailOffset — replay the NEWEST slice', () {
    test('a long scrollback starts its replay near the end', () {
      // The real number from the report: ~1.95 MB of history.
      expect(scrollbackTailOffset(1950432, kScrollbackReplayBytes),
          1950432 - kScrollbackReplayBytes);
    });

    test('a scrollback shorter than the budget replays from the very start', () {
      expect(scrollbackTailOffset(1372, kScrollbackReplayBytes), 0);
      expect(scrollbackTailOffset(0, kScrollbackReplayBytes), 0);
    });

    test('never negative — an offset below zero would be rejected as a bad range', () {
      expect(scrollbackTailOffset(10, 500), 0);
    });

    test('the budget is far larger than the 5000 that caused this, and inside the server cap', () {
      expect(kScrollbackReplayBytes, greaterThan(5000 * 10));
      expect(kScrollbackReplayBytes, lessThanOrEqualTo(524288)); // SCROLLBACK_RANGE_MAX
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
