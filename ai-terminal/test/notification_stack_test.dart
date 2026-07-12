// Issue #45: opening a session from a notification must leave exactly one
// screen above the list — a single Back returns to the list, every time. The
// bug stacked 2–3 SessionScreens (repeat taps, and the cold-start + foreground
// double-fire for one notification), so Back had to be pressed 3×.
//
// resolveNotificationStack is the pure mirror of _openSession's
// Navigator.popUntil + dedup; these tests pin the invariant it must hold.
import 'package:ai_terminal/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const home = 'home'; // the session list — always the bottom route
  String route(String id) => sessionRouteName(id);

  group('resolveNotificationStack', () {
    test('cold start (only the list) opens one session on top', () {
      expect(
        resolveNotificationStack([home], route('a')),
        [home, route('a')],
      );
    });

    test('re-tapping the same notification does not stack a duplicate', () {
      var stack = resolveNotificationStack([home], route('a'));
      stack = resolveNotificationStack(stack, route('a'));
      stack = resolveNotificationStack(stack, route('a'));
      // Never more than one screen above the list, however many taps land.
      expect(stack, [home, route('a')]);
    });

    test('the cold-start + foreground double-fire opens one screen, not two', () {
      // Both paths call _openSession for the same notification; the second must
      // find the just-opened session and no-op.
      final first = resolveNotificationStack([home], route('a'));
      final second = resolveNotificationStack(first, route('a'));
      expect(second, [home, route('a')]);
    });

    test('tapping a notification while a DIFFERENT session is open replaces it', () {
      expect(
        resolveNotificationStack([home, route('a')], route('b')),
        [home, route('b')],
      );
    });

    test('collapses a deep stack (fork / manual pushes) down to the list', () {
      // Fork and dashboard-card pushes have no route name; a notification tap
      // pops them so Back returns to the list, not through each pushed screen.
      expect(
        resolveNotificationStack(
          [home, route('a'), 'fork', 'fork'],
          route('b'),
        ),
        [home, route('b')],
      );
    });

    test('keeps an already-open target (its live session screen is preserved)', () {
      // list → a → b, notification for a: pop b, stop on the live a — do not
      // rebuild it — leaving a on top.
      expect(
        resolveNotificationStack([home, route('a'), route('b')], route('a')),
        [home, route('a')],
      );
    });

    test('an empty stack still yields exactly the target', () {
      expect(resolveNotificationStack(const [], route('a')), [route('a')]);
    });
  });
}
