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
    // Identity is the question's CONTENT (questionSignature), not its toolUseId.
    PendingQuestion q(String prompt, {String id = 'toolu_x'}) => PendingQuestion(
          toolUseId: id,
          questions: [
            PendingQuestionItem(
              header: 'H',
              question: prompt,
              multiSelect: false,
              options: const [QuestionOption(label: 'Yes', description: '')],
            ),
          ],
        );

    test('a fresh pending question shows', () {
      expect(questionOverlayVisible(q('one'), null), isTrue);
    });

    test('no pending question -> hidden', () {
      expect(questionOverlayVisible(null, null), isFalse);
      expect(questionOverlayVisible(null, 'somekey'), isFalse);
    });

    test('the just-answered question stays hidden while it lingers pending', () {
      // _answerQuestion sets _dismissedQuestionKey = the answered signature; the
      // poll keeps returning that same question for seconds until Claude consumes
      // it — even under a DIFFERENT toolUseId (hook-… → toolu_…).
      final key = questionSignature(q('one', id: 'hook-s-1'));
      expect(questionOverlayVisible(q('one', id: 'hook-s-1'), key), isFalse);
      expect(questionOverlayVisible(q('one', id: 'toolu_01ABC'), key), isFalse);
    });

    test('a genuinely new question (different content) shows again', () {
      final key = questionSignature(q('one'));
      expect(questionOverlayVisible(q('two'), key), isTrue);
    });
  });

  group('shouldResurfaceAfterAnswer (#19: dropped answer must not stay hidden)', () {
    test('still pending + still our dismissal -> re-show', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: true, answeredKey: 'k1', dismissedKey: 'k1'),
        isTrue,
      );
    });

    test('answer landed (not pending) -> stay hidden', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: false, answeredKey: 'k1', dismissedKey: 'k1'),
        isFalse,
      );
    });

    test('a different prompt was dismissed since -> do not clobber it', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: true, answeredKey: 'k1', dismissedKey: 'k2'),
        isFalse,
      );
    });

    test('user cleared the dismissal -> do not resurface', () {
      expect(
        shouldResurfaceAfterAnswer(
            stillPending: true, answeredKey: 'k1', dismissedKey: null),
        isFalse,
      );
    });
  });

  // The dismissal/answered identity must key on question CONTENT, not toolUseId:
  // the server reports a synthetic `hook-<id>-<seq>` while the question is live
  // and the real `toolu_…` once it falls back to the transcript. Keying on the id
  // made the SAME question look new → dismissal cleared → overlay re-shown → the
  // user answered twice → the second frame set was typed as literal text into a
  // selector Claude had already closed.
  group('questionSignature (stable identity across toolUseId churn)', () {
    PendingQuestion q(String toolUseId, {String label = 'Yes'}) => PendingQuestion(
          toolUseId: toolUseId,
          questions: [
            PendingQuestionItem(
              header: 'Ship',
              question: 'Deploy now?',
              multiSelect: false,
              options: [
                QuestionOption(label: label, description: 'do it'),
                const QuestionOption(label: 'No', description: 'wait'),
              ],
            ),
          ],
        );

    test('same content under a synthetic hook id and the real toolu id matches', () {
      expect(questionSignature(q('hook-sess-7')), questionSignature(q('toolu_01ABC')));
    });

    test('a re-fired PreToolUse (new seq) is still the same question', () {
      expect(questionSignature(q('hook-sess-7')), questionSignature(q('hook-sess-9')));
    });

    test('genuinely different content -> different signature', () {
      expect(
        questionSignature(q('hook-sess-7')),
        isNot(questionSignature(q('hook-sess-7', label: 'Absolutely'))),
      );
    });

    test('null question -> empty signature (never equals a real one)', () {
      expect(questionSignature(null), '');
      expect(questionSignature(null), isNot(questionSignature(q('t'))));
    });

    test('overlay visibility keys on the signature, not the id', () {
      final key = questionSignature(q('hook-sess-7'));
      // Same question re-reported under the real transcript id stays dismissed.
      expect(questionOverlayVisible(q('toolu_01ABC'), key), isFalse);
      // A different question shows.
      expect(questionOverlayVisible(q('toolu_01ABC', label: 'Maybe'), key), isTrue);
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

  // The terminal lens is a LIVE terminal (web parity): keys go straight to the
  // PTY and a tap raises the keyboard. Previously this was bolted to `_rawMode`,
  // which defaults OFF on phones — so the terminal was readOnly there, a tap did
  // nothing, and Claude's TUI selector couldn't be answered by typing.
  group('terminalAcceptsInput (terminal lens is always live)', () {
    test('terminal lens takes direct input on every platform', () {
      expect(terminalAcceptsInput('terminal'), isTrue);
    });

    test('chat lens does not — the offstage terminal never steals keys', () {
      expect(terminalAcceptsInput('chat'), isFalse);
    });

    test('it does not depend on raw mode (no rawMode parameter at all)', () {
      // Regression guard: input must not be gated on _rawMode again. If someone
      // reintroduces that coupling this predicate would need a second argument.
      expect(terminalAcceptsInput('terminal'), isTrue);
      expect(terminalAcceptsInput('terminal'), isTrue);
    });
  });

  group('buildComposeSubmission (#44: atomic submit — body + CR in one frame)', () {
    test('single-line: text + trailing CR, in one string', () {
      expect(buildComposeSubmission('hello world'), 'hello world\r');
    });

    test('the payload ALWAYS ends in the submit CR (never split off)', () {
      // The #44 property: the submit \r is part of the same payload, so it can
      // never be lost to a nulled/replaced connection between two writes.
      expect(buildComposeSubmission('a').endsWith('\r'), isTrue);
      expect(buildComposeSubmission('a\nb').endsWith('\r'), isTrue);
      expect(buildComposeSubmission('').endsWith('\r'), isTrue);
    });

    test('multi-line: bracketed paste with CR after the close marker', () {
      // Interior newline -> CR; wrapper + submit CR after ESC[201~.
      expect(buildComposeSubmission('line1\nline2'),
          '\x1b[200~line1\rline2\x1b[201~\r');
    });

    test('CRLF newlines normalize to CR inside the paste', () {
      expect(buildComposeSubmission('a\r\nb'),
          '\x1b[200~a\rb\x1b[201~\r');
    });

    test('strips existing bracketed-paste markers so user text cannot close the wrapper', () {
      // A pasted-in ESC[201~ must not prematurely end our bracketed paste.
      final out = buildComposeSubmission('x\x1b[201~y\nz');
      expect(out, '\x1b[200~xy\rz\x1b[201~\r');
      // exactly one open + one close marker (the ones we added)
      expect('\x1b[200~'.allMatches(out).length, 1);
      expect('\x1b[201~'.allMatches(out).length, 1);
    });

    test('empty buffer -> a bare submit CR', () {
      expect(buildComposeSubmission(''), '\r');
    });
  });
}
