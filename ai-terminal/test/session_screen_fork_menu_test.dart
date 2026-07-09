// Unit test for canForkFromMenu — the app-bar overflow menu's "Fork session"
// enable/disable rule (owner: "cant see fork"). Pulled out as a pure
// function, mirroring buildForkAutoCommand, so the rule is testable without
// pumping the whole SessionScreen (which needs a live ApiClient/
// SessionRepository/notification stack — out of scope for a unit test).
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({required String? claudeSessionId}) => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: r'C:\dev\my-project',
  status: 'idle',
  claudeSessionId: claudeSessionId,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

void main() {
  group('canForkFromMenu', () {
    test('true for a Claude session', () {
      expect(canForkFromMenu(_session(claudeSessionId: 'claude-abc')), isTrue);
    });

    test('false for a plain shell session', () {
      expect(canForkFromMenu(_session(claudeSessionId: null)), isFalse);
    });
  });

  group('composeBarVisible', () {
    // #43: the compose bar is ALWAYS shown — it's the one input path that works in
    // every state (touch/desktop, chat/no-chat, raw/not, connected or not). Every
    // prior rule that hid it in raw mode stranded some real session with no usable
    // input. Raw mode now only decides whether the TERMINAL also takes direct keys.
    test('always shown — the guaranteed PTY input', () {
      expect(composeBarVisible(), isTrue);
    });
  });

  group('slashStartsLiveStream (Claude slash menu on every platform)', () {
    // Now enabled on desktop too (was suppressed for #28's stranding, which the
    // always-visible compose bar fixed) — a '/'-prefixed line streams to Claude's
    // real menu, on any platform.
    test('a "/"-prefixed line goes live', () {
      expect(slashStartsLiveStream('/'), isTrue);
      expect(slashStartsLiveStream('/compact'), isTrue);
      expect(slashStartsLiveStream('/clear'), isTrue);
    });

    test('a non-slash line never goes live', () {
      expect(slashStartsLiveStream('hello'), isFalse);
      expect(slashStartsLiveStream('a/b'), isFalse);
      expect(slashStartsLiveStream(''), isFalse);
    });
  });

  group('questionOverlayVisible (#19: answered question must not re-flash)', () {
    PendingQuestion q(String id) =>
        PendingQuestion(toolUseId: id, questions: const []);

    test('a fresh pending question shows', () {
      expect(questionOverlayVisible(q('t1'), null), isTrue);
    });

    test('no pending question -> hidden', () {
      expect(questionOverlayVisible(null, null), isFalse);
      expect(questionOverlayVisible(null, 't1'), isFalse);
    });

    test('the just-answered question stays hidden while it lingers pending', () {
      // _answerQuestion sets _dismissedQuestionId = the answered id; the poll
      // keeps returning that same question for seconds until Claude consumes it.
      expect(questionOverlayVisible(q('t1'), 't1'), isFalse);
    });

    test('a genuinely new question (different id) shows again', () {
      expect(questionOverlayVisible(q('t2'), 't1'), isTrue);
    });
  });

  group('shouldResurfaceAfterAnswer (#19: dropped answer must not stay hidden)', () {
    test('still pending + still our dismissal -> re-show', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: true, answeredToolUseId: 't1', dismissedId: 't1'),
        isTrue,
      );
    });

    test('answer landed (not pending) -> stay hidden', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: false, answeredToolUseId: 't1', dismissedId: 't1'),
        isFalse,
      );
    });

    test('a different prompt was dismissed since -> do not clobber it', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: true, answeredToolUseId: 't1', dismissedId: 't2'),
        isFalse,
      );
    });

    test('user cleared the dismissal -> do not resurface', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: true, answeredToolUseId: 't1', dismissedId: null),
        isFalse,
      );
    });
  });

  group('pasteImageIntoCompose (#29: Alt+V lands where you type)', () {
    test('chat lens -> compose (terminal is offstage there)', () {
      expect(
        pasteImageIntoCompose(activeLens: 'chat', composeFocused: false),
        isTrue,
      );
    });

    test('terminal lens with the compose field focused -> compose', () {
      expect(
        pasteImageIntoCompose(activeLens: 'terminal', composeFocused: true),
        isTrue,
      );
    });

    test('terminal lens, terminal focused (raw typing) -> PTY, unchanged', () {
      expect(
        pasteImageIntoCompose(activeLens: 'terminal', composeFocused: false),
        isFalse,
      );
    });
  });
}
