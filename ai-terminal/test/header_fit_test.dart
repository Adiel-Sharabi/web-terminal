// #74 — the session header's width budget.
//
// The bug: AppBar lays `actions` out at their intrinsic width first and gives the
// title the leftover, so a phone-width header rendered the session name as
// "● Lo…". The title was the only flexible child, so it absorbed every other
// control's shortfall — and each control added over time made it worse in
// silence.
//
// What is tested here is not today's pixel arithmetic but the INVARIANT the issue
// actually asks for: the title keeps a floor, controls fold in a declared order,
// and adding another control can only fold things EARLIER — never re-truncate the
// title. That is why the rule is a pure function rather than layout leftovers.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';

// Widths standing in for real devices (logical px, portrait).
const double kPhone = 360; // S25 portrait — the reported failure
const double kPhoneNarrow = 320; // small/older phone
const double kLandscape = 800;
const double kDesktop = 1400;

HeaderFit fitAt(double width, {bool speak = true, bool detach = false}) =>
    headerFit(
      width: width,
      lens: true,
      speak: speak,
      detach: detach,
      serverChip: true,
    );

// Mirrors the production budget: what the title is left with for a given fit.
double titleSpace(double width, HeaderFit f) =>
    width -
    56 - // leading
    18 - // status dot + gap
    48 - // overflow (never folded)
    (f.lens ? 96 : 0) -
    (f.speak ? 48 : 0) -
    (f.detach ? 48 : 0) -
    (f.serverChip ? 88 : 0);

void main() {
  group('the reported failure', () {
    test('on a phone the title clears its floor', () {
      final f = fitAt(kPhone);
      expect(titleSpace(kPhone, f), greaterThanOrEqualTo(kHeaderTitleFloor));
    });

    test('the server chip is what folds first on a phone', () {
      // It is the widest element and the least essential — the name also shows
      // in the sidebar, and it is still reachable in the overflow menu.
      final f = fitAt(kPhone);
      expect(f.serverChip, isFalse);
      expect(f.lens, isTrue, reason: 'lens switching must survive phone width');
      expect(f.speak, isTrue, reason: 'read-aloud must survive phone width');
    });

    test('without the fix the title would have been unusable', () {
      // Everything inline is what shipped before #74; this documents the size of
      // the bug rather than asserting on the fix.
      const all = HeaderFit(lens: true, speak: true, detach: true, serverChip: true);
      expect(titleSpace(kPhone, all), lessThan(20));
    });
  });

  group('fold order is declared, not emergent', () {
    test('a narrower phone folds the next control down, keeping the lens', () {
      final f = fitAt(kPhoneNarrow);
      expect(f.serverChip, isFalse);
      expect(titleSpace(kPhoneNarrow, f), greaterThanOrEqualTo(kHeaderTitleFloor));
      expect(f.lens, isTrue, reason: 'the lens toggle folds last of all');
    });

    test('the lens toggle is the last thing to go', () {
      // Absurdly narrow: everything else must already have folded before the
      // lens does, because it is the only one-tap path between views.
      final f = fitAt(200);
      expect(f.serverChip, isFalse);
      expect(f.speak, isFalse);
    });
  });

  group('wider screens get MORE title, never a fixed cap', () {
    test('landscape and desktop keep every control inline', () {
      for (final w in [kLandscape, kDesktop]) {
        final f = fitAt(w, detach: true);
        expect(f.serverChip, isTrue, reason: 'width $w');
        expect(f.lens, isTrue, reason: 'width $w');
        expect(f.speak, isTrue, reason: 'width $w');
        expect(f.detach, isTrue, reason: 'width $w');
      }
    });

    test('title space grows with the screen', () {
      expect(
        titleSpace(kDesktop, fitAt(kDesktop, detach: true)),
        greaterThan(titleSpace(kLandscape, fitAt(kLandscape, detach: true))),
      );
    });
  });

  group('the invariant: a future control cannot re-truncate the title', () {
    test('the floor holds at every width from tiny to desktop', () {
      // The one property that must never regress. A control added later shifts
      // where folding starts; it can never push the title below the floor,
      // because folding continues until the floor is met.
      for (double w = 240; w <= 1600; w += 20) {
        final f = fitAt(w, detach: true);
        final space = titleSpace(w, f);
        final everythingFolded = !f.lens && !f.speak && !f.detach && !f.serverChip;
        expect(
          space >= kHeaderTitleFloor || everythingFolded,
          isTrue,
          reason: 'width $w left the title ${space}px with controls still inline',
        );
      }
    });

    test('adding a control can only fold things earlier, never shrink the title', () {
      // `detach` stands in for "one more control added later".
      for (double w = 320; w <= 1600; w += 40) {
        final without = fitAt(w, detach: false);
        final with_ = fitAt(w, detach: true);
        expect(
          titleSpace(w, with_),
          greaterThanOrEqualTo(
            titleSpace(w, without) >= kHeaderTitleFloor ? kHeaderTitleFloor : 0,
          ),
          reason: 'width $w',
        );
      }
    });
  });
}
