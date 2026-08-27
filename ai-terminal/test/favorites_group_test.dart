// Widget tests for FavoritesGroup: derives membership + order straight off
// each Session's own favorite/favoriteRank fields (#60 — no separate `order`
// list), silently dropping nothing (there IS nothing to drop: a session not
// in the incoming list simply isn't rendered), and the empty (no favorites)
// case. Deliberately independent of any service singleton — the widget takes
// its inputs as plain constructor params.
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/favorites_group.dart';
import 'package:ai_terminal/widgets/session_card.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session(
  String id, {
  String name = '',
  bool favorite = false,
  int? favoriteRank,
}) => Session(
  id: id,
  name: name.isEmpty ? id : name,
  cwd: '/home/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
  favorite: favorite,
  favoriteRank: favoriteRank,
);

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('renders favorites sorted by favoriteRank via cardBuilder', (
    tester,
  ) async {
    final built = <String>[];
    final sessions = [
      _session('a', favorite: true, favoriteRank: 1),
      _session('b', favorite: false),
      _session('c', favorite: true, favoriteRank: 0),
    ];

    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: sessions,
          cardBuilder: (context, s, _) {
            built.add(s.id);
            return Text(s.id);
          },
          collapsed: false,
          onToggleCollapsed: () {},
          onReorder: (_, _, _) {},
        ),
      ),
    );

    // 'c' (rank 0) before 'a' (rank 1); 'b' isn't favorited, so it's dropped.
    expect(built, ['c', 'a']);
    expect(find.text('FAVORITES'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('a session with no favoriteRank sorts as rank 0', (
    tester,
  ) async {
    final built = <String>[];
    final sessions = [
      _session('a', favorite: true, favoriteRank: 2),
      _session('b', favorite: true), // no rank -> treated as 0
    ];

    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: sessions,
          cardBuilder: (context, s, _) {
            built.add(s.id);
            return Text(s.id);
          },
          collapsed: false,
          onToggleCollapsed: () {},
          onReorder: (_, _, _) {},
        ),
      ),
    );

    expect(built, ['b', 'a']);
  });

  testWidgets('renders nothing when there are no favorites', (tester) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: [_session('a')],
          cardBuilder: (context, s, _) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () {},
          onReorder: (_, _, _) {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsNothing);
  });

  testWidgets('renders nothing given an empty session list', (tester) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: const [],
          cardBuilder: (context, s, _) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () {},
          onReorder: (_, _, _) {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsNothing);
  });

  testWidgets('tapping the header calls onToggleCollapsed', (tester) async {
    var toggled = false;
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: [_session('a', favorite: true, favoriteRank: 0)],
          cardBuilder: (context, s, _) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () => toggled = true,
          onReorder: (_, _, _) {},
        ),
      ),
    );

    await tester.tap(find.text('FAVORITES'));
    expect(toggled, isTrue);
  });

  testWidgets('collapsed hides the cards but keeps the header and count', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: [
            _session('a', favorite: true, favoriteRank: 0),
            _session('b', favorite: true, favoriteRank: 1),
          ],
          cardBuilder: (context, s, _) => Text(s.id),
          collapsed: true,
          onToggleCollapsed: () {},
          onReorder: (_, _, _) {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(find.text('a'), findsNothing);
    expect(find.text('b'), findsNothing);
    expect(find.byIcon(Icons.chevron_right), findsOneWidget);
    expect(find.byIcon(Icons.expand_more), findsNothing);
  });

  // #124 gave the group a reorder; #169 fixed HOW a pinned row is grabbed on
  // touch, which #124 got wrong in a way its own assertions could not see.
  //
  // **Read this before weakening anything below.** #124's touch test asserted
  // `find.byType(ReorderableDelayedDragStartListener), findsNWidgets(3)` — that
  // the long-press drag wrapper was IN THE TREE. It was, on every device, and
  // the feature still never worked once: `SessionCard` binds the actions sheet
  // to an `InkWell.onLongPress`, so pressing a pinned row armed two recognizers
  // on the same pointer with the same `kLongPressTimeout` and no movement
  // requirement, and the card's — deeper, therefore first into the gesture
  // arena and first to start its timer — accepted first and rejected the drag
  // every time. A wrapper being present says nothing about it WINNING.
  //
  // The mechanism is fully reproducible here, contrary to the fear in #169 that
  // synthetic pointers would not be enough: the arena and its timers are pure
  // Dart, and `FakeAsync` fires same-deadline timers in creation order, which
  // is hit-test order. What #124's test lacked was not real input — it was a
  // card that competes.
  //
  // So these build the REAL [SessionCard] with the REAL
  // [buildReorderDragHandle], and assert on OUTCOMES (which callback fired),
  // never on which widgets exist. A stand-in card that merely mirrors today's
  // structure cannot fail when that structure is wrong — which is how the first
  // cut of #169 read green here while the phone still read #124.
  group('#124/#169 — grabbing a pinned row', () {
    List<Session> three() => [
      _session('a', favorite: true, favoriteRank: 10),
      _session('b', favorite: true, favoriteRank: 20),
      _session('c', favorite: true, favoriteRank: 30),
    ];

    /// The shipped row, wired exactly as `dashboard_screen._buildCard` wires it:
    /// the actions sheet on `SessionCard.onLongPress`, and the app's one drag
    /// handle from [buildReorderDragHandle] whenever the group hands it an index.
    Widget card(Session s, int? reorderIndex, List<String> longPressed) =>
        Builder(
          builder: (context) => SessionCard(
            session: s,
            isFavorite: true,
            onTap: () {},
            onLongPress: () => longPressed.add(s.id),
            onMoreTap: () {},
            dragHandle: buildReorderDragHandle(context, reorderIndex),
          ),
        );

    Future<void> pump(
      WidgetTester tester, {
      required List<String> longPressed,
      void Function(List<Session>, int, int)? onReorder,
      List<Session>? sessions,
    }) => tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: sessions ?? three(),
          cardBuilder: (context, s, reorderIndex) =>
              card(s, reorderIndex, longPressed),
          collapsed: false,
          onToggleCollapsed: () {},
          onReorder: onReorder ?? (_, _, _) {},
        ),
      ),
    );

    Finder handleOf(String id) => find.descendant(
      of: find.byKey(ValueKey('fav-reorder-$id')),
      matching: find.byIcon(Icons.drag_handle),
    );

    testWidgets('touch: holding a pinned ROW opens its sheet — holding its '
        'HANDLE drags it (#169)', (tester) async {
      // try/finally, not addTearDown: the framework verifies the foundation debug
      // vars are unset at the END OF THE TEST BODY, before tearDowns run.
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        final longPressed = <String>[];
        int? from, to;
        List<Session>? got;
        await pump(
          tester,
          longPressed: longPressed,
          onReorder: (ordered, o, n) {
            got = ordered;
            from = o;
            to = n;
          },
        );

        // Half one — the sheet. #169 refuses to trade it away for the drag.
        final onRow = await tester.startGesture(
          tester.getCenter(find.text('c')),
        );
        await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
        await onRow.moveBy(const Offset(0, -120));
        await tester.pump();
        await onRow.up();
        await tester.pumpAndSettle();

        expect(longPressed, ['c'], reason: 'a pinned row keeps its actions sheet');
        expect(from, isNull, reason: 'the row BODY is not a grab target on touch');

        // Half two — the acceptance criterion of #169, and the one the first cut
        // failed: press the handle, HOLD past the long-press deadline (which is
        // the idiom #124 taught, and what anyone does when a drag seems not to
        // take), and only then move. An immediate drag recognizer has no deadline
        // of its own, so this must still drag — provided nothing else is armed on
        // the handle's own pixels.
        longPressed.clear();
        final onHandle = await tester.startGesture(
          tester.getCenter(handleOf('c')),
        );
        await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
        await onHandle.moveBy(const Offset(0, -20));
        await tester.pump();
        await onHandle.moveBy(const Offset(0, -140));
        await tester.pump();
        await onHandle.up();
        await tester.pumpAndSettle();

        expect(
          longPressed,
          isEmpty,
          reason: 'holding the HANDLE must not open the sheet — that is the '
              'reported symptom relocated onto the new affordance',
        );
        expect(from, 2, reason: 'hold-then-drag must move the row');
        expect(to, lessThan(2));
        expect(got!.map((s) => s.id).toList(), ['a', 'b', 'c']);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('touch: dragging the row handle straight away reorders the '
        'group (#169)', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        final longPressed = <String>[];
        List<Session>? got;
        int? from, to;
        await pump(
          tester,
          longPressed: longPressed,
          onReorder: (ordered, o, n) {
            got = ordered;
            from = o;
            to = n;
          },
        );

        expect(
          handleOf('c'),
          findsOneWidget,
          reason: 'a touch row is handed its index so it renders the handle',
        );

        final drag = await tester.startGesture(tester.getCenter(handleOf('c')));
        await drag.moveBy(const Offset(0, -20));
        await tester.pump();
        await drag.moveBy(const Offset(0, -140));
        await tester.pump();
        await drag.up();
        await tester.pumpAndSettle();

        expect(from, isNotNull, reason: 'the drag must reach onReorder');
        expect(
          got!.map((s) => s.id).toList(),
          ['a', 'b', 'c'],
          reason: 'the callback receives the group in the order shown',
        );
        expect(from, 2);
        expect(to, lessThan(2));
        expect(longPressed, isEmpty, reason: 'a drag is not a long-press');
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('touch: a lone favorite gets no handle — there is nowhere to '
        'drag it', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        final longPressed = <String>[];
        await pump(
          tester,
          longPressed: longPressed,
          sessions: [_session('a', favorite: true, favoriteRank: 10)],
        );

        // A handle here costs a pinned name ~18% of its width for a control that
        // could never reorder anything.
        expect(find.byIcon(Icons.drag_handle), findsNothing);

        // ...and the row it cannot reorder still opens its sheet.
        await tester.longPress(find.text('a'));
        await tester.pumpAndSettle();
        expect(longPressed, ['a']);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('GUARD (structural): nothing arms a second long-press deadline '
        'on a touch row', (tester) async {
      // Explicitly a structural guard, not a behavioural assertion — it is the
      // shape of #124's own test, which is exactly why it is not trusted alone.
      // The tests above are what prove the gesture; this one only refuses the
      // wrapper a future edit might reach for.
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        await pump(tester, longPressed: <String>[]);
        expect(find.byType(ReorderableDelayedDragStartListener), findsNothing);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('a pointer device drags the row directly', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        await pump(tester, longPressed: <String>[]);
        expect(find.byType(ReorderableDragStartListener), findsNWidgets(3));
        // No handle icon: the whole row is the target, so the layout is unchanged.
        // #169 left the pointer path exactly as #124 shipped it — a mouse starts
        // a drag by moving, so it never contends with the card's long-press.
        expect(find.byIcon(Icons.drag_handle), findsNothing);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('a completed drag reports the move in DISPLAY order', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        List<Session>? got;
        int? from, to;
        await pump(
          tester,
          longPressed: <String>[],
          onReorder: (ordered, o, n) {
            got = ordered;
            from = o;
            to = n;
          },
        );

        final drag = await tester.startGesture(tester.getCenter(find.text('c')));
        await drag.moveBy(const Offset(0, -20));
        await tester.pump();
        await drag.moveBy(const Offset(0, -140));
        await tester.pump();
        await drag.up();
        await tester.pumpAndSettle();

        expect(from, isNotNull, reason: 'the drag must reach onReorder');
        expect(
          got!.map((s) => s.id).toList(),
          ['a', 'b', 'c'],
          reason: 'the callback receives the group in the order shown',
        );
        expect(from, 2);
        expect(to, lessThan(2));
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('a pointer device that holds still gets the actions sheet', (
      tester,
    ) async {
      // The other half of "both gestures survive", on the platform that keeps
      // whole-row dragging: hold without moving and the card's long-press wins,
      // which on a mouse is the right answer — a drag there means movement.
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        final longPressed = <String>[];
        var reordered = false;
        await pump(
          tester,
          longPressed: longPressed,
          onReorder: (_, _, _) => reordered = true,
        );

        await tester.longPress(find.text('c'));
        await tester.pumpAndSettle();

        expect(longPressed, ['c']);
        expect(reordered, isFalse);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });
}
