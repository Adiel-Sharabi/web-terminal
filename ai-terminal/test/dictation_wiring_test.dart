// #291 — two wiring rules in session_screen.dart that no unit test of the
// service can see, pinned against the SOURCE (as tests/app-input-path.spec.js
// does for app.html's input funnel). A full SessionScreen needs a live
// ApiClient/SessionRepository stack, which the other session_screen tests
// already note is out of scope for a unit test.
//
// 1. Every programmatic focus of the compose field goes through _focusCompose,
//    which refuses while the mic listens. A bare requestFocus anywhere else
//    ends dictation and raises the keyboard it exists to keep closed — and a new
//    one added next year would leave every behavioural test green.
// 2. _onComposeChanged recognises dictated text BEFORE the typed-keystroke
//    handling, so an armed sticky Ctrl cannot turn a dictated word into a
//    control byte, and a dictated "slash …" cannot enter live mode.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final src = File('lib/screens/session_screen.dart').readAsStringSync();

  test('the compose field is focused only through _focusCompose', () {
    final bare = RegExp(r'_composeFocusNode\.requestFocus\(\)').allMatches(src);
    expect(bare.length, 1,
        reason: 'exactly one bare requestFocus: the one inside _focusCompose');
    final helper = RegExp(
      r'void _focusCompose\(\) \{\s*if \(_dictation\?\.isListeningTo\(_composeController\) \?\? false\) return;\s*_composeFocusNode\.requestFocus\(\);',
    );
    expect(helper.hasMatch(src), isTrue,
        reason: '_focusCompose must refuse while dictating, then focus');
  });

  test('dictated text is classified before sticky modifiers and live mode', () {
    final start = src.indexOf('void _onComposeChanged()');
    expect(start, greaterThan(0));
    final body = src.substring(start, src.indexOf('void _streamComposeLive', start));
    final dictation = body.indexOf('isListeningTo(_composeController)');
    final sticky = body.indexOf('resolveStickyModifierInput');
    final live = body.indexOf('slashStartsLiveStream');
    expect(dictation, greaterThan(0), reason: 'the dictation branch must exist');
    expect(dictation, lessThan(sticky));
    expect(dictation, lessThan(live));
  });
}
