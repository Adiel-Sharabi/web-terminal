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

  // #301 / #302 — the native half (Dictation.kt) has no Kotlin test harness in
  // this project, so the rules that keep the mic from stranding on "error 11"
  // are pinned against its SOURCE. Each of these was a real failure on the S25:
  // a recognizer reused across sessions stayed bound to a service that was no
  // longer the default; a disconnect was not retried; a refused mic was retried
  // as a formatting failure until it read as error 11; and a retry bound that
  // reset only on heard words could end a long dictation with silent pauses.
  group('Dictation.kt keeps the mic from stranding (#301, #302)', () {
    // Normalised: a Windows checkout (core.autocrlf) has CRLF endings, and the
    // method-body cut below looks for LF-delimited closing braces.
    final kt = File(
      'android/app/src/main/kotlin/net/hilashnet/ai_terminal/Dictation.kt',
    ).readAsStringSync().replaceAll('\r\n', '\n');

    String body(String signature) {
      final at = kt.indexOf(signature);
      expect(at, greaterThanOrEqualTo(0), reason: 'missing: $signature');
      return kt.substring(at, kt.indexOf('\n    }\n', at));
    }

    test('every dictation starts from a fresh recognizer', () {
      final start = body('fun start(lang: String, sessionId: Int)');
      expect(start, contains('recognizer?.destroy()'));
      expect(start, contains('recognizer = null'));
    });

    test('a disconnected service is retried with a rebuilt recognizer', () {
      // The `when` arm that leads to retryOrFail must list SERVER_DISCONNECTED.
      final arm = RegExp(r'SpeechRecognizer\.ERROR_RECOGNIZER_BUSY,([^>]*)-> retryOrFail\(error\)')
          .firstMatch(kt);
      expect(arm, isNotNull, reason: 'the retry arm of onError is missing');
      expect(arm!.group(1), contains('ERROR_SERVER_DISCONNECTED'));
      expect(body('private fun retryOrFail(error: Int)'),
          contains('relisten(delayMs = 300L * failures, recreate = true)'));
    });

    test('a refused microphone is final and reported, never retried', () {
      expect(kt, contains('SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail(error)'));
    });

    test('the retry bound resets whenever a session actually opens', () {
      final at = kt.indexOf('override fun onReadyForSpeech(params: Bundle?)');
      expect(at, greaterThanOrEqualTo(0));
      final ready = kt.substring(at, kt.indexOf('override fun onBeginningOfSpeech', at));
      expect(ready, contains('failures = 0'));
    });
  });
}
