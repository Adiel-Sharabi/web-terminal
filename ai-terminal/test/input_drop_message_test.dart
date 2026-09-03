import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/screens/session_screen.dart';

/// #208 — WHICH sentence a dropped write gets, which is the whole point of the issue.
///
/// `inputDropped` has three origins and used to carry only an `int`, so one sentence
/// covered all of them: *"Some input was too large to send (N bytes) and was dropped."*
/// For one of the three that is false — `_bufferInput`'s hard ceiling gives up a write
/// of perfectly LEGAL size because a sustained outage overflowed the buffer holding it,
/// and a 40-byte line reported as "too large" is the confidently-wrong wording #204
/// fixed on the cluster-proxy path with a `reason` on the wire.
///
/// WHY THIS FILE EXISTS SEPARATELY FROM `terminal_connection_test.dart`. That one pins
/// the STREAM: that each emit site names its own origin, verified by mutation (flip the
/// eviction to `tooLarge` and it goes red). This one pins the MAPPING. The exhaustive
/// `switch` makes *adding* an origin a compile error, which is a real gate — but it says
/// nothing about whether each origin is mapped to the right sentence. **Swap the two
/// arms and #208's defect returns exactly inverted, with the whole suite green.** That
/// is the one failure neither the type system nor the stream tests can see, so it is the
/// one this file is for.
///
/// Pure and top-level for the same reason [resolveSubmitUnconfirmedReaction] is (#179):
/// reaching it inside a State method would need a pumped widget, and a rule that costs a
/// widget to assert tends not to get asserted.
void main() {
  group('inputDropMessage (#208)', () {
    test('an eviction does NOT say "too large" — it was a legal size', () {
      final msg = inputDropMessage(
        (length: 40, reason: InputDropReason.bufferFull),
      );
      // The defect, stated directly. A 40-character line is not too large for
      // anything; it was given up because the outage overflowed the buffer.
      expect(msg, isNot(contains('too large')));
      expect(msg, contains('no room left'));
      expect(msg, contains('40'));
    });

    test('a cap refusal DOES say too large, and says what to do about it', () {
      final msg = inputDropMessage(
        (length: 262145, reason: InputDropReason.tooLarge),
      );
      expect(msg, contains('too large'));
      expect(msg, contains('262145'));
      // Actionable: this is the one origin the user can do something about.
      expect(msg, contains('smaller pieces'));
      // And NOT the other sentence — there was room the whole time.
      expect(msg, isNot(contains('no room left')));
    });

    test('the two sentences are different, which is the entire issue', () {
      // The assertion that goes red if the switch arms are ever swapped, and the
      // one that goes red if somebody "simplifies" the mapping back to one string.
      final evicted = inputDropMessage(
        (length: 40, reason: InputDropReason.bufferFull),
      );
      final refused = inputDropMessage(
        (length: 40, reason: InputDropReason.tooLarge),
      );
      expect(evicted, isNot(equals(refused)));
    });

    test('every reason has a sentence, and none of them is empty', () {
      // Guards the shape rather than the wording: an origin added later cannot
      // silently map to '' or to a placeholder. The exhaustive switch already makes
      // omitting a case a compile error; this covers filling it in badly.
      for (final r in InputDropReason.values) {
        final msg = inputDropMessage((length: 1, reason: r));
        expect(msg.trim(), isNotEmpty, reason: '$r has no sentence');
        expect(msg, contains('1'), reason: '$r does not report the length');
      }
    });
  });
}
