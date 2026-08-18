// #130 — the lens flipped back to Chat mid-typing while a '/' command streamed live.
//
// `_activeLens` had four independent writers. The one that ran on EVERY session
// update (poll / `/ws/notify` frame) derived the lens from availability + the
// persisted choice alone, so it wrote the two transient Terminal overrides — a
// live '/' line and raw mode — straight back out a few seconds after they were
// set. `resolveActiveLens` makes those overrides INPUTS to a single resolver, so
// the per-update recomputation returns the same answer as the override that set
// it and there is nothing left to clobber.
//
// These are red against the old rule, which is reproduced exactly by
// `_oldRule` below — every case marked OLD RULE fails there.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';

/// The pre-#130 recomputation, verbatim from `_recomputeActiveLens`. Present so
/// the regression cases can be shown red rather than asserted to be.
String _oldRule({required bool chatAvailable, required String? persistedLens}) =>
    chatAvailable ? (persistedLens ?? 'chat') : 'terminal';

void main() {
  group('resolveActiveLens — a live "/" line pins Terminal', () {
    // THE REPORTED BUG. This is the state a poll lands in: the user typed '/'
    // in Chat seconds ago and is still typing. The old rule answered 'chat'
    // here, which is the mid-keystroke flip back.
    test('OLD RULE: a session update mid-command does not move the lens', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'chat',
          liveSlashPin: true,
          rawModePin: false,
        ),
        'terminal',
      );
      // Proof the case is a genuine regression guard, not a tautology.
      expect(
        _oldRule(chatAvailable: true, persistedLens: 'chat'),
        'chat',
        reason: 'the old rule flipped back to Chat — this is the bug',
      );
    });

    test('holds through repeated updates — the answer is stable, not one-shot', () {
      for (var poll = 0; poll < 5; poll++) {
        expect(
          resolveActiveLens(
            chatAvailable: true,
            persistedLens: 'chat',
            liveSlashPin: true,
            rawModePin: false,
          ),
          'terminal',
        );
      }
    });

    test('pin released on send → back to the lens the user came from', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'chat',
          liveSlashPin: false,
          rawModePin: false,
        ),
        'chat',
      );
    });

    // A '/' line begun while already in Terminal must not hop anywhere on send.
    test('started from Terminal → still Terminal once the pin drops', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'terminal',
          liveSlashPin: true,
          rawModePin: false,
        ),
        'terminal',
      );
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'terminal',
          liveSlashPin: false,
          rawModePin: false,
        ),
        'terminal',
      );
    });
  });

  group('resolveActiveLens — raw mode carried the identical defect', () {
    test('OLD RULE: enabling raw mode survives the next session update', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'chat',
          liveSlashPin: false,
          rawModePin: true,
        ),
        'terminal',
      );
      expect(
        _oldRule(chatAvailable: true, persistedLens: 'chat'),
        'chat',
        reason: 'raw typing was put back out of sight by the next poll',
      );
    });

    test('both pins up at once is still Terminal', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'chat',
          liveSlashPin: true,
          rawModePin: true,
        ),
        'terminal',
      );
    });
  });

  group('resolveActiveLens — preserved behaviour', () {
    // The pin is cleared by an explicit toggle rather than read off _rawMode, so
    // "tap Chat while raw mode is on" keeps working. A hard pin on the raw-mode
    // FLAG would stand the user in Terminal for the life of the session.
    test('an explicit choice wins once the pins are cleared', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'chat',
          liveSlashPin: false,
          rawModePin: false,
        ),
        'chat',
      );
    });

    test('Chat unavailable → Terminal, pins or no pins', () {
      for (final pin in [true, false]) {
        expect(
          resolveActiveLens(
            chatAvailable: false,
            persistedLens: 'chat',
            liveSlashPin: pin,
            rawModePin: pin,
          ),
          'terminal',
        );
      }
    });

    test('Chat is the default when nothing was ever chosen', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: null,
          liveSlashPin: false,
          rawModePin: false,
        ),
        'chat',
      );
    });

    test('a past Terminal choice is honoured', () {
      expect(
        resolveActiveLens(
          chatAvailable: true,
          persistedLens: 'terminal',
          liveSlashPin: false,
          rawModePin: false,
        ),
        'terminal',
      );
    });
  });
}
