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
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/favorites_group.dart';

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
          cardBuilder: (context, s) {
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
          cardBuilder: (context, s) {
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
          cardBuilder: (context, s) => Text(s.id),
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
          cardBuilder: (context, s) => Text(s.id),
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
          cardBuilder: (context, s) => Text(s.id),
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
          cardBuilder: (context, s) => Text(s.id),
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

  // #124 — the group is reorderable. Before this the rows rendered with no grab
  // gesture at all, so a drag simply did nothing.
  group('#124 — dragging a pinned row', () {
    List<Session> three() => [
      _session('a', favorite: true, favoriteRank: 10),
      _session('b', favorite: true, favoriteRank: 20),
      _session('c', favorite: true, favoriteRank: 30),
    ];

    Future<void> pump(WidgetTester tester, void Function(List<Session>, int, int) onReorder) =>
        tester.pumpWidget(
          _wrap(
            FavoritesGroup(
              sessions: three(),
              cardBuilder: (context, s) => SizedBox(height: 48, child: Text(s.id)),
              collapsed: false,
              onToggleCollapsed: () {},
              onReorder: onReorder,
            ),
          ),
        );

    testWidgets('touch gets LONG-PRESS to grab, not an always-on handle', (tester) async {
      // try/finally, not addTearDown: the framework verifies the foundation debug
      // vars are unset at the END OF THE TEST BODY, before tearDowns run.
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        await pump(tester, (_, _, _) {});
        // A compact pinned row must not be draggable on first touch, or scrolling
        // the dashboard would drag rows by accident.
        expect(find.byType(ReorderableDelayedDragStartListener), findsNWidgets(3));
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('a pointer device drags the row directly', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        await pump(tester, (_, _, _) {});
        expect(find.byType(ReorderableDragStartListener), findsNWidgets(3));
        // No handle icon: the whole row is the target, so the layout is unchanged.
        expect(find.byIcon(Icons.drag_handle), findsNothing);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('a completed drag reports the move in DISPLAY order', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        List<Session>? got;
        int? from, to;
        await pump(tester, (ordered, o, n) {
          got = ordered;
          from = o;
          to = n;
        });

        final drag = await tester.startGesture(tester.getCenter(find.text('c')));
        await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
        await drag.moveBy(const Offset(0, -120));
        await tester.pump();
        await drag.up();
        await tester.pumpAndSettle();

        expect(from, isNotNull, reason: 'the drag must reach onReorder');
        expect(got!.map((s) => s.id).toList(), ['a', 'b', 'c'],
            reason: 'the callback receives the group in the order shown');
        expect(from, 2);
        expect(to, lessThan(2));
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });
}
