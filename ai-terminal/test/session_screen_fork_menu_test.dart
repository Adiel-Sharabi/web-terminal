// Unit test for canForkFromMenu — the app-bar overflow menu's "Fork session"
// enable/disable rule (owner: "cant see fork"). Pulled out as a pure
// function, mirroring buildForkAutoCommand, so the rule is testable without
// pumping the whole SessionScreen (which needs a live ApiClient/
// SessionRepository/notification stack — out of scope for a unit test).
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

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

  group('pendingQuestionChipVisible (#79: dismissed question still needs a mark)', () {
    // The gap: an AskUserQuestion leaves the session idle/GREEN (a pending
    // question emits no output and no hooks, so it stale-corrects to idle after
    // 5 min while the answer is still owed) — so status colour cannot carry the
    // signal. The overlay is the indication WHILE it is up, but it is
    // dismissible, and once dismissed nothing on screen shows the question is
    // still pending. The chip fills exactly that hole: pending AND overlay
    // dismissed. It is the complement of questionOverlayVisible — the two are
    // mutually exclusive and together cover "a question is pending".
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

    test('no pending question -> no chip', () {
      expect(pendingQuestionChipVisible(null, null), isFalse);
      expect(pendingQuestionChipVisible(null, 'somekey'), isFalse);
    });

    test('pending and NOT dismissed -> no chip (the overlay is the indication)', () {
      expect(pendingQuestionChipVisible(q('one'), null), isFalse);
    });

    test('pending and dismissed -> chip shows (the #79 gap)', () {
      final key = questionSignature(q('one'));
      expect(pendingQuestionChipVisible(q('one'), key), isTrue);
    });

    test('chip and overlay are mutually exclusive for the same state', () {
      // Whatever the state, exactly one of {overlay, chip} is shown when a
      // question is pending, and neither when none is.
      final key = questionSignature(q('one'));
      for (final (pending, dismissed) in [
        (null, null),
        (q('one'), null), // fresh -> overlay
        (q('one'), key), // dismissed -> chip
      ]) {
        final overlay = questionOverlayVisible(pending, dismissed);
        final chip = pendingQuestionChipVisible(pending, dismissed);
        expect(overlay && chip, isFalse, reason: 'never both at once');
        if (pending != null) {
          expect(overlay || chip, isTrue, reason: 'a pending question is always shown somewhere');
        }
      }
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

  // #46: a typed Enter in the desktop Terminal lens parked (only the key-strip
  // Enter icon submitted). Root cause is xterm-4.0.0's IME path: it submits Enter
  // only via onAction(done) but its connection uses TextInputAction.newline, so a
  // desktop hardware Enter (performAction(newline)) is dropped. Desktop must take
  // raw hardware keys so Enter routes through keyInput(enter) → '\r'; mobile keeps
  // the IME path for its soft keyboard.
  group('terminalHardwareKeyboardOnly (#46 desktop Enter submits)', () {
    test('live terminal on desktop → hardware-only (Enter submits, not parks)', () {
      expect(
        terminalHardwareKeyboardOnly(live: true, desktop: true),
        isTrue,
      );
    });

    test('live terminal on mobile → IME path (soft keyboard needs it)', () {
      expect(
        terminalHardwareKeyboardOnly(live: true, desktop: false),
        isFalse,
      );
    });

    test('offstage terminal (chat lens) is hardware-only on both', () {
      // Not live → readOnly anyway; the flag just must not open an IME.
      expect(terminalHardwareKeyboardOnly(live: false, desktop: true), isTrue);
      expect(terminalHardwareKeyboardOnly(live: false, desktop: false), isTrue);
    });
  });

  group('terminalIsActiveTarget (#50: Tab/arrows drive Claude TUI)', () {
    test('Terminal lens → terminal is the active target', () {
      expect(
        terminalIsActiveTarget(lensLive: true, questionUp: false),
        isTrue,
      );
    });

    test('question overlay up (any lens) → terminal is the active target', () {
      expect(
        terminalIsActiveTarget(lensLive: false, questionUp: true),
        isTrue,
      );
    });

    test('both lens live AND a question up → still the active target', () {
      expect(
        terminalIsActiveTarget(lensLive: true, questionUp: true),
        isTrue,
      );
    });

    test('chat lens, no question → NOT the active target (compose edits keys)', () {
      expect(
        terminalIsActiveTarget(lensLive: false, questionUp: false),
        isFalse,
      );
    });
  });

  group('terminalContextMenuActions (#49: right-click menu contents)', () {
    test('with a selection → Copy, Paste, Select All', () {
      expect(
        terminalContextMenuActions(hasSelection: true),
        [
          TerminalMenuAction.copy,
          TerminalMenuAction.paste,
          TerminalMenuAction.selectAll,
        ],
      );
    });

    test('no selection → Paste + Select All only (nothing to copy)', () {
      expect(
        terminalContextMenuActions(hasSelection: false),
        [TerminalMenuAction.paste, TerminalMenuAction.selectAll],
      );
    });
  });

  group('selectAllOnTerminal (#49: Select All grabs the whole buffer)', () {
    test('selection covers the written text', () {
      final terminal = Terminal(maxLines: 200);
      terminal.write('hello world');
      final controller = TerminalController();

      // Nothing selected yet.
      expect(controller.selection, isNull);

      selectAllOnTerminal(terminal, controller);

      final sel = controller.selection;
      expect(sel, isNotNull);
      expect(terminal.buffer.getText(sel).contains('hello world'), isTrue);
    });

    test('spans multiple lines of scrollback', () {
      final terminal = Terminal(maxLines: 200);
      terminal.write('line-one\r\nline-two\r\nline-three');
      final controller = TerminalController();

      selectAllOnTerminal(terminal, controller);

      final text = terminal.buffer.getText(controller.selection);
      expect(text.contains('line-one'), isTrue);
      expect(text.contains('line-three'), isTrue);
    });
  });

  // A soft keyboard commits Enter as literal "\n" text, so xterm's _onInsert
  // falls through to terminal.textInput('\n') and a raw LF hit the PTY. Claude's
  // TUI inserts a prompt newline on LF and submits only on CR, so a typed prompt
  // sat there until the toolbar's Enter (which sends '\r') was tapped.
  group('terminalOutputToPty (soft-keyboard Enter submits)', () {
    test('a lone LF becomes the submit CR', () {
      expect(terminalOutputToPty('\n'), '\r');
    });

    test('ordinary characters pass through untouched', () {
      expect(terminalOutputToPty('a'), 'a');
      expect(terminalOutputToPty('hello'), 'hello');
      expect(terminalOutputToPty('\r'), '\r');
    });

    test('control bytes and escape sequences pass through untouched', () {
      expect(terminalOutputToPty('\x1b[A'), '\x1b[A'); // arrow up
      expect(terminalOutputToPty('\x03'), '\x03'); // Ctrl+C
      expect(terminalOutputToPty('\x1b'), '\x1b'); // Esc
    });

    test('a bracketed paste keeps its interior newlines verbatim', () {
      // _pasteFromClipboard routes Terminal.paste through this same callback:
      // those newlines are paste CONTENT, not a submit. Rewriting them would
      // submit each line separately.
      const paste = '\x1b[200~line one\nline two\x1b[201~';
      expect(terminalOutputToPty(paste), paste);
    });

    test('multi-character input containing LF is not rewritten', () {
      expect(terminalOutputToPty('ab\ncd'), 'ab\ncd');
      expect(terminalOutputToPty('\n\n'), '\n\n');
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

    // The desktop compose field displays multiple lines, and Windows inserts a
    // newline on the submitting Enter before the send fires — so a single-line
    // prompt arrives as "hello\n". Stripping the TRAILING newline keeps it a
    // plain `text\r` (which submits) instead of a bracketed paste (whose CR
    // Claude absorbs, parking the prompt unsent).
    test('a trailing newline is stripped: single-line prompt stays plain text\\r',
        () {
      expect(buildComposeSubmission('hello\n'), 'hello\r');
      expect(buildComposeSubmission('hello\r\n'), 'hello\r');
      // Not a bracketed paste — no ESC[200~.
      expect(buildComposeSubmission('hello\n').contains('\x1b[200~'), isFalse);
    });

    test('only the TRAILING newline is stripped; interior newlines still paste',
        () {
      expect(buildComposeSubmission('line1\nline2\n'),
          '\x1b[200~line1\rline2\x1b[201~\r');
    });

    test('a whitespace-only trailing-newline buffer -> a bare submit CR', () {
      expect(buildComposeSubmission('\n'), '\r');
    });
  });

  group('composeLiveProjection (#55 §1: a live "/" line must never submit itself)', () {
    // A '/'-prefixed buffer streams to the PTY as you type so the agent's slash menu
    // narrows. That TUI prompt is ONE line, so the only byte a newline could be mirrored
    // as is '\r' — the SUBMIT key. Streaming it fired the command, which is why Enter
    // submitted a '/'-line on mobile (and Ctrl+Enter submitted one on desktop) while both
    // merely inserted a newline in any other buffer: the lens-dependent Enter §1 forbids.
    test('newlines are dropped — the projection can never contain a submit CR', () {
      expect(composeLiveProjection('/help\n'), '/help');
      expect(composeLiveProjection('/help\nmore'), '/helpmore');
      expect(composeLiveProjection('/a\n\n\nb'), '/ab');
    });

    test('a newline NEVER becomes a CR', () {
      expect(composeLiveProjection('/help\n').contains('\r'), isFalse);
      expect(composeLiveProjection('/x\ny\nz').contains('\r'), isFalse);
    });

    test('a buffer with no newline is passed through untouched', () {
      expect(composeLiveProjection('/help'), '/help');
      expect(composeLiveProjection(''), '');
    });
  });

}
