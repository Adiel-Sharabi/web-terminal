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

  group('composeBarVisible — mobile/touch (compose is the only usable input)', () {
    // The reported bug: on touch, a Chat-AVAILABLE session in Terminal lens + raw
    // mode hid the compose bar, and the raw terminal line has no soft keyboard —
    // so there was NO way to type. On mobile the compose bar must ALWAYS show,
    // for every lens/raw/chat combination.
    test('always shown on mobile, every lens/raw/chat combo', () {
      for (final raw in [true, false]) {
        for (final lens in ['terminal', 'chat']) {
          for (final chat in [true, false]) {
            expect(
              composeBarVisible(
                rawMode: raw,
                activeLens: lens,
                chatAvailable: chat,
                isDesktop: false,
              ),
              isTrue,
              reason:
                  'mobile raw=$raw lens=$lens chat=$chat must show the compose bar',
            );
          }
        }
      }
    });

    // The exact stranding case the user hit: Chat available, Terminal lens, raw on.
    test('mobile: shown for a chat-available session in terminal + raw', () {
      expect(
        composeBarVisible(
          rawMode: true,
          activeLens: 'terminal',
          chatAvailable: true,
          isDesktop: false,
        ),
        isTrue,
      );
    });
  });

  group('composeBarVisible — desktop (raw = type into the terminal directly)', () {
    // Compose mode (not raw): the compose bar is the primary input, always shown.
    test('shown in compose mode on either lens', () {
      expect(
        composeBarVisible(
          rawMode: false,
          activeLens: 'terminal',
          chatAvailable: true,
          isDesktop: true,
        ),
        isTrue,
      );
      expect(
        composeBarVisible(
          rawMode: false,
          activeLens: 'chat',
          chatAvailable: true,
          isDesktop: true,
        ),
        isTrue,
      );
    });

    // Raw + Terminal + Chat available: the hardware keyboard drives the terminal
    // and Chat is one toggle away, so the compose bar is intentionally hidden.
    test('hidden in raw mode on the terminal lens when chat is available', () {
      expect(
        composeBarVisible(
          rawMode: true,
          activeLens: 'terminal',
          chatAvailable: true,
          isDesktop: true,
        ),
        isFalse,
      );
    });

    // Raw + Chat lens must STILL show the compose bar (issue #12).
    test('shown in raw mode when the chat lens is active', () {
      expect(
        composeBarVisible(
          rawMode: true,
          activeLens: 'chat',
          chatAvailable: true,
          isDesktop: true,
        ),
        isTrue,
      );
    });

    // #43 desktop guard: no Chat + Terminal + raw would leave no input and no Chat
    // to fall back to — the compose bar must stay visible.
    test('shown when chat is UNAVAILABLE even in raw mode on the terminal lens', () {
      expect(
        composeBarVisible(
          rawMode: true,
          activeLens: 'terminal',
          chatAvailable: false,
          isDesktop: true,
        ),
        isTrue,
      );
    });

    // The invariant: a no-chat session always has a compose bar (input) on desktop.
    test('#43: some usable input for a no-chat session in every state', () {
      for (final raw in [true, false]) {
        for (final lens in ['terminal', 'chat']) {
          expect(
            composeBarVisible(
              rawMode: raw,
              activeLens: lens,
              chatAvailable: false,
              isDesktop: true,
            ),
            isTrue,
            reason: 'raw=$raw lens=$lens chatAvailable=false must show input',
          );
        }
      }
    });
  });

  group('slashStartsLiveStream (#28: "/" must not strand desktop chat)', () {
    test('desktop: a "/"-line never goes live (stays a plain field char)', () {
      expect(slashStartsLiveStream(text: '/', isDesktop: true), isFalse);
      expect(slashStartsLiveStream(text: '/task', isDesktop: true), isFalse);
    });

    test('mobile: a "/"-line goes live (Claude slash menu)', () {
      expect(slashStartsLiveStream(text: '/', isDesktop: false), isTrue);
      expect(slashStartsLiveStream(text: '/task', isDesktop: false), isTrue);
    });

    test('a non-slash line never goes live, on any platform', () {
      expect(slashStartsLiveStream(text: 'hello', isDesktop: false), isFalse);
      expect(slashStartsLiveStream(text: 'a/b', isDesktop: false), isFalse);
      expect(slashStartsLiveStream(text: '', isDesktop: false), isFalse);
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
