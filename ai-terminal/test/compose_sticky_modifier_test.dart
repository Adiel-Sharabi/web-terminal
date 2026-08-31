// #193 — sticky Ctrl/Alt (the key strip's on-screen modifier toggle) discarded
// a multi-character insertion into the compose field instead of the single
// keystroke it was built for.
//
// `_onComposeChanged` is private to `_SessionScreenState` and a full
// `SessionScreen` needs a live ApiClient/SessionRepository/notification stack
// (see `session_screen_copy_shortcut_test.dart`'s note on why that's out of
// scope for a unit test) — so this exercises the pure decision it delegates
// to, `resolveStickyModifierInput`, exactly the way `resolveSubmitUnconfirmedReaction`
// is tested on its own in `session_repository_submit_unconfirmed_test.dart`.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';

void main() {
  group('resolveStickyModifierInput (#193)', () {
    test('a single typed character while Ctrl is armed is consumed as ^X', () {
      final r = resolveStickyModifierInput(
        prevText: 'hello',
        text: 'hellox',
        ctrlSticky: true,
      );
      expect(r.consumed, isTrue);
      expect(r.controlByte, String.fromCharCode('x'.codeUnitAt(0) & 0x1f));
      expect(r.restoredText, 'hello');
      expect(r.restoredOffset, 5);
    });

    test('a single typed character while Alt is armed is consumed as ESC+ch', () {
      final r = resolveStickyModifierInput(
        prevText: '',
        text: 'v',
        ctrlSticky: false,
      );
      expect(r.consumed, isTrue);
      expect(r.controlByte, '\x1bv');
    });

    // The actual bug: a 20-character paste landing while sticky is armed used to
    // read only its first character as a control code and throw the other 19
    // away with the field restored to what it was before the paste — no error,
    // no sign anything was lost. It must now pass through untouched instead.
    test('a multi-character paste passes through untouched, nothing dropped',
        () {
      final r = resolveStickyModifierInput(
        prevText: '',
        text: 'a' * 20,
        ctrlSticky: true,
      );
      expect(r.consumed, isFalse,
          reason: 'a paste is not a single keystroke — sticky must not eat it');
      expect(r.controlByte, isNull);
      expect(r.restoredText, isNull,
          reason: 'nothing restored: the caller leaves the paste exactly as-is');
    });

    test('the key strip Paste button reaches the same field via setValue, '
        'so a 2-character insertion is already "multi" and passes through', () {
      // _pasteIntoCompose sets controller.value directly, firing the same
      // listener as typed input — even a short two-character clipboard paste
      // must not be misread as one keystroke.
      final r = resolveStickyModifierInput(
        prevText: 'x',
        text: 'xab',
        ctrlSticky: true,
      );
      expect(r.consumed, isFalse);
    });

    // A DELIBERATE decision, pinned so nobody "fixes" it later: a one-character
    // paste is indistinguishable from a real keypress (both are a length-1
    // insertion, and TextEditingValue carries nothing that says which happened),
    // so it is consumed as a control byte exactly like typing would be. Getting
    // the rare one-char-paste-while-sticky case wrong is the accepted cost of
    // getting the common real-paste case right.
    test('a ONE-character paste is consumed too — indistinguishable from typing',
        () {
      final r = resolveStickyModifierInput(
        prevText: 'x',
        text: 'xy', // could be typed 'y', or a clipboard paste of "y" — same delta
        ctrlSticky: true,
      );
      expect(r.consumed, isTrue);
      expect(r.controlByte, String.fromCharCode('y'.codeUnitAt(0) & 0x1f));
    });
  });
}
